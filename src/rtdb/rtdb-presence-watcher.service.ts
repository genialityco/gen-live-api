/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as admin from 'firebase-admin';

type DetachFn = () => void;

@Injectable()
export class RtdbPresenceWatcherService implements OnModuleDestroy {
  private readonly log = new Logger(RtdbPresenceWatcherService.name);
  private listeners = new Map<string, DetachFn>(); // eventId -> detach
  private viewingMetricsService: any; // Lazy-loaded para evitar circular dependency

  // Throttling: evitar procesar demasiado frecuentemente
  private lastProcessed = new Map<string, number>(); // eventId -> timestamp
  private readonly PROCESS_THROTTLE_MS = 3000; // Procesar máximo cada 3 segundos
  private pendingProcessing = new Map<string, NodeJS.Timeout>(); // eventId -> timeout

  private presenceRef(eventId: string) {
    return admin.database().ref(`/presence/${eventId}`);
  }

  private nowCountRef(eventId: string) {
    return admin.database().ref(`/events/${eventId}/nowCount`);
  }

  /**
   * Inyección manual para evitar dependencia circular
   */
  setViewingMetricsService(service: any) {
    this.viewingMetricsService = service;
  }

  /**
   * Activa watcher para un eventId (idempotente)
   */
  async watch(eventId: string) {
    if (this.listeners.has(eventId)) {
      this.log.debug(`Watcher already active for ${eventId}`);
      return;
    }

    const ref = this.presenceRef(eventId);

    // Función para procesar y emitir cambios de presencia con timeout
    const processPresence = async () => {
      try {
        // Agregar timeout de 5 segundos a operaciones RTDB
        const snapPromise = ref.once('value');
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('RTDB timeout')), 5000),
        );
        const snap = (await Promise.race([
          snapPromise,
          timeoutPromise,
        ])) as admin.database.DataSnapshot;
        const val = snap.val() ?? {};
        const count = typeof val === 'object' ? Object.keys(val).length : 0;

        // Método legacy: actualizar nowCount directamente
        await this.nowCountRef(eventId).set(count);

        // Nuevo método: Enviar datos a ViewingMetricsService si está disponible
        if (this.viewingMetricsService) {
          try {
            const presenceData: Record<string, { on: boolean; ts: number }> =
              {};
            const now = Date.now();
            const TIMEOUT_MS = 30 * 1000; // 30 segundos (2x heartbeat para tolerancia)

            // Convertir estructura RTDB a formato esperado por el servicio
            // IMPORTANTE: Solo incluir usuarios con on:true y timestamp reciente
            if (typeof val === 'object' && val !== null) {
              for (const [uid, data] of Object.entries(val)) {
                if (typeof data === 'object' && data !== null) {
                  const on = (data as any).on ?? false;
                  const ts = (data as any).ts ?? 0;

                  // Solo incluir si está explícitamente "on" Y el timestamp es reciente
                  if (on && now - ts < TIMEOUT_MS) {
                    presenceData[uid] = {
                      on: true,
                      ts: ts,
                    };
                  }
                }
              }
            }

            await this.viewingMetricsService.onPresenceChange(
              eventId,
              presenceData,
            );
          } catch (error) {
            this.log.error(
              `Error processing presence change: ${(error as Error).message}`,
            );
          }
        }
      } catch (error) {
        this.log.error(
          `Error in processPresence for ${eventId}: ${(error as Error).message}`,
        );
      }
    };

    // Función throttled para procesar presencia (evita sobrecarga)
    const throttledProcess = () => {
      const now = Date.now();
      const lastProc = this.lastProcessed.get(eventId) || 0;

      // Si ya procesamos recientemente, programar para después
      if (now - lastProc < this.PROCESS_THROTTLE_MS) {
        // Cancelar procesamiento pendiente anterior
        const pending = this.pendingProcessing.get(eventId);
        if (pending) {
          clearTimeout(pending);
        }

        // Programar nuevo procesamiento
        const timeout = setTimeout(
          () => {
            this.lastProcessed.set(eventId, Date.now());
            processPresence().catch((e) =>
              this.log.error(`Throttled process error: ${e.message}`),
            );
          },
          this.PROCESS_THROTTLE_MS - (now - lastProc),
        );

        this.pendingProcessing.set(eventId, timeout);
      } else {
        // Procesar inmediatamente
        this.lastProcessed.set(eventId, now);
        processPresence().catch((e) =>
          this.log.error(`Process error: ${e.message}`),
        );
      }
    };

    // Listeners individuales con throttling
    const onChildAdded = () => throttledProcess();
    const onChildRemoved = () => throttledProcess();
    const onChildChanged = () => throttledProcess();

    // Asegurar que no hay listeners previos antes de agregar nuevos
    ref.off();

    ref.on('child_added', onChildAdded);
    ref.on('child_removed', onChildRemoved);
    ref.on('child_changed', onChildChanged);

    // Procesamiento inicial
    await processPresence();

    // Guardar función de cleanup mejorada
    this.listeners.set(eventId, () => {
      try {
        ref.off('child_added', onChildAdded);
        ref.off('child_removed', onChildRemoved);
        ref.off('child_changed', onChildChanged);
        this.log.debug(`Listeners cleaned for ${eventId}`);
      } catch (error) {
        this.log.error(
          `Error cleaning listeners for ${eventId}: ${(error as Error).message}`,
        );
      }
    });

    // Limpiar nodos antiguos antes de empezar
    this.cleanStalePresence(eventId).catch((e) =>
      this.log.error(`Error cleaning stale presence: ${e.message}`),
    );

    this.log.log(
      `Presence watcher ON for ${eventId} (usando listeners individuales)`,
    );
  }

  /**
   * Desactiva watcher si existe
   */
  unwatch(eventId: string) {
    const detach = this.listeners.get(eventId);
    if (detach) {
      detach();
      this.listeners.delete(eventId);

      // Limpiar throttling data
      this.lastProcessed.delete(eventId);
      const pending = this.pendingProcessing.get(eventId);
      if (pending) {
        clearTimeout(pending);
        this.pendingProcessing.delete(eventId);
      }
      this.log.log(`Presence watcher OFF for ${eventId}`);
    }
  }

  /**
   * Limpieza al cerrar el proceso Nest
   */
  onModuleDestroy() {
    for (const [eventId, detach] of this.listeners.entries()) {
      try {
        detach();
      } catch {
        /* empty */
      }
      this.log.log(`Presence watcher OFF (shutdown) for ${eventId}`);
    }
    this.listeners.clear();
  }

  /**
   * Recalcular bajo demanda (endpoint opcional)
   */
  async recalcNow(eventId: string) {
    try {
      const snapPromise = this.presenceRef(eventId).once('value');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RTDB timeout')), 5000),
      );
      const snap = (await Promise.race([
        snapPromise,
        timeoutPromise,
      ])) as admin.database.DataSnapshot;
      const val = snap.val() ?? {};
      const count = typeof val === 'object' ? Object.keys(val).length : 0;
      await this.nowCountRef(eventId).set(count);
      return { eventId, nowCount: count };
    } catch (error) {
      this.log.error(
        `Error in recalcNow for ${eventId}: ${(error as Error).message}`,
      );
      return { eventId, nowCount: 0, error: (error as Error).message };
    }
  }

  /**
   * Limpiar nodos de presencia antiguos (más de 2 minutos sin actualizar)
   */
  async cleanStalePresence(eventId: string) {
    try {
      const snapPromise = this.presenceRef(eventId).once('value');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RTDB timeout')), 5000),
      );
      const snap = (await Promise.race([
        snapPromise,
        timeoutPromise,
      ])) as admin.database.DataSnapshot;
      const val = snap.val() ?? {};

      if (typeof val !== 'object' || val === null) {
        return { cleaned: 0 };
      }

      const now = Date.now();
      const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutos
      let cleaned = 0;

      for (const [uid, data] of Object.entries(val)) {
        if (typeof data === 'object' && data !== null) {
          const ts = (data as any).ts ?? 0;

          // Eliminar si el timestamp es muy antiguo
          if (now - ts > STALE_TIMEOUT_MS) {
            await this.presenceRef(eventId).child(uid).remove();
            cleaned++;
            this.log.debug(
              `Cleaned stale presence node for UID ${uid} in event ${eventId}`,
            );
          }
        }
      }

      this.log.log(
        `Cleaned ${cleaned} stale presence nodes for event ${eventId}`,
      );
      return { cleaned };
    } catch (error) {
      this.log.error(
        `Error in cleanStalePresence for ${eventId}: ${(error as Error).message}`,
      );
      return { cleaned: 0, error: (error as Error).message };
    }
  }
}
