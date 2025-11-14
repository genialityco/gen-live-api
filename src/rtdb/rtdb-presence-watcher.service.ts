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

    // Función para procesar y emitir cambios de presencia
    const processPresence = async () => {
      const snap = await ref.once('value');
      const val = snap.val() ?? {};
      const count = typeof val === 'object' ? Object.keys(val).length : 0;

      // Método legacy: actualizar nowCount directamente
      await this.nowCountRef(eventId).set(count);

      // Nuevo método: Enviar datos a ViewingMetricsService si está disponible
      if (this.viewingMetricsService) {
        try {
          const presenceData: Record<string, { on: boolean; ts: number }> = {};
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
    };

    // Listeners individuales para cambios inmediatos
    const onChildAdded = () => processPresence();
    const onChildRemoved = () => processPresence();
    const onChildChanged = () => processPresence();

    ref.on('child_added', onChildAdded);
    ref.on('child_removed', onChildRemoved);
    ref.on('child_changed', onChildChanged);

    // Procesamiento inicial
    await processPresence();

    // Guardar función de cleanup
    this.listeners.set(eventId, () => {
      ref.off('child_added', onChildAdded);
      ref.off('child_removed', onChildRemoved);
      ref.off('child_changed', onChildChanged);
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
    const snap = await this.presenceRef(eventId).once('value');
    const val = snap.val() ?? {};
    const count = typeof val === 'object' ? Object.keys(val).length : 0;
    await this.nowCountRef(eventId).set(count);
    return { eventId, nowCount: count };
  }

  /**
   * Limpiar nodos de presencia antiguos (más de 2 minutos sin actualizar)
   */
  async cleanStalePresence(eventId: string) {
    const snap = await this.presenceRef(eventId).once('value');
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
  }
}
