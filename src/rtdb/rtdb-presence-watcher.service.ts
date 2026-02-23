/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as admin from 'firebase-admin';

type DetachFn = () => void;

/**
 * RtdbPresenceWatcherService — versión incremental (sin once('value') en hot path)
 *
 * ARQUITECTURA ANTERIOR (O(N) por heartbeat):
 *   child_* → ref.once('value')  ← RTDB read completo por cada heartbeat
 *           → onPresenceChange()
 *
 * ARQUITECTURA NUEVA (O(1) por heartbeat):
 *   child_added/changed → actualiza Map en memoria → scheduleFlush (debounce 2 s)
 *   child_removed       → borra entrada en Map     → scheduleFlush (debounce 2 s)
 *   flush               → construye presenceData desde Map (SIN leer RTDB)
 *                       → llama onPresenceChange() UNA vez por ventana
 *
 * El único once('value') ocurre en watch() al activar el watcher (seed inicial),
 * NO en la ruta caliente de cada heartbeat.
 */
@Injectable()
export class RtdbPresenceWatcherService implements OnModuleDestroy {
  private readonly log = new Logger(RtdbPresenceWatcherService.name);

  // eventId → detach function para limpiar listeners de Firebase
  private listeners = new Map<string, DetachFn>();

  // Inyección manual para evitar dependencia circular con EventsModule
  private viewingMetricsService: any;

  // ── In-memory presence mirror ───────────────────────────────────────────
  // eventId → (uid → { ts, on })
  // Actualizado directamente por child_* events — nunca lee RTDB en hot path.
  private presenceCache = new Map<
    string,
    Map<string, { ts: number; on: boolean }>
  >();

  // ── Per-event debounce timers ───────────────────────────────────────────
  // Colapsa ráfagas de child_* en una sola llamada a onPresenceChange().
  private flushTimers = new Map<string, NodeJS.Timeout>();

  /** Ventana de debounce: acumula cambios de presencia antes de procesar */
  private readonly FLUSH_DEBOUNCE_MS = 2_000;

  /**
   * Tiempo máximo de espera antes de forzar un flush aunque sigan llegando eventos.
   * Evita starvation cuando 1500+ usuarios llegan en burst: sin este límite, cada
   * child_added resetea el timer y el flush puede tardar 10-15 s en disparar.
   */
  private readonly FLUSH_MAX_WAIT_MS = 5_000;

  /** TTL de presencia activa: mismo valor que el frontend usa para heartbeat × 2 */
  private readonly PRESENCE_TTL_MS = 30_000; // 30 s

  // ── Diagnóstico ─────────────────────────────────────────────────────────
  // Cuántas veces se ha ejecutado el flush por eventId.
  // Útil para estimar "escrituras a RTDB ≈ flushCount × 2 (setNowCount + publishMetrics)".
  private flushCount = new Map<string, number>();

  // Timestamp en que se programó el primer scheduleFlush para cada eventId.
  // Usado para implementar el maxWait: si el debounce lleva más de FLUSH_MAX_WAIT_MS
  // esperando, se fuerza el flush aunque sigan llegando eventos.
  private flushFirstScheduled = new Map<string, number>();

  // ────────────────────────────────────────────────────────────────────────

  private presenceRef(eventId: string) {
    return admin.database().ref(`/presence/${eventId}`);
  }

  /** Inyección manual para evitar dependencia circular */
  setViewingMetricsService(service: any) {
    this.viewingMetricsService = service;
  }

  // ── Cache helpers ────────────────────────────────────────────────────────

  private getCacheForEvent(
    eventId: string,
  ): Map<string, { ts: number; on: boolean }> {
    if (!this.presenceCache.has(eventId)) {
      this.presenceCache.set(eventId, new Map());
    }
    return this.presenceCache.get(eventId)!;
  }

  /**
   * Aplica un cambio de presencia al Map en memoria.
   * @param data  null indica eliminación (child_removed)
   */
  private updatePresenceCache(eventId: string, uid: string, data: any): void {
    const cache = this.getCacheForEvent(eventId);
    if (data === null) {
      cache.delete(uid);
      return;
    }
    const on: boolean = data?.on ?? false;
    const ts: number = data?.ts ?? Date.now();
    cache.set(uid, { ts, on });
  }

  // ── Flush (debounced) ────────────────────────────────────────────────────

  /**
   * Programa un flush para eventId con debounce + maxWait.
   *
   * Comportamiento:
   * - Cada llamada reinicia el timer de FLUSH_DEBOUNCE_MS (trailing debounce clásico).
   * - Si el debounce lleva más de FLUSH_MAX_WAIT_MS esperando sin disparar (p.ej. burst
   *   de 1500 child_added consecutivos), se fuerza el flush de inmediato para evitar
   *   que las métricas tarden 10-15 s en aparecer al inicio del evento.
   */
  private scheduleFlush(eventId: string): void {
    const now = Date.now();

    // Registrar cuándo se programó por primera vez en esta ráfaga
    if (!this.flushFirstScheduled.has(eventId)) {
      this.flushFirstScheduled.set(eventId, now);
    }

    const firstScheduled = this.flushFirstScheduled.get(eventId)!;

    // Si ya pasó el maxWait → forzar flush inmediato sin esperar más
    if (now - firstScheduled >= this.FLUSH_MAX_WAIT_MS) {
      const existing = this.flushTimers.get(eventId);
      if (existing) clearTimeout(existing);
      this.flushTimers.delete(eventId);
      this.flushFirstScheduled.delete(eventId);

      this.log.debug(
        `[MaxWait] Forced flush for ${eventId} after ${now - firstScheduled}ms`,
      );
      this.runFlush(eventId).catch((e: Error) =>
        this.log.error(`Forced flush error for ${eventId}: ${e.message}`),
      );
      return;
    }

    // Debounce normal: cancelar timer anterior y programar uno nuevo
    const existing = this.flushTimers.get(eventId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.flushTimers.delete(eventId);
      this.flushFirstScheduled.delete(eventId);
      this.runFlush(eventId).catch((e: Error) =>
        this.log.error(`Flush error for ${eventId}: ${e.message}`),
      );
    }, this.FLUSH_DEBOUNCE_MS);

    this.flushTimers.set(eventId, timer);
  }

  /**
   * Ejecuta el flush: construye presenceData desde el Map en memoria (sin RTDB)
   * y llama a onPresenceChange() UNA sola vez.
   */
  private async runFlush(eventId: string): Promise<void> {
    if (!this.viewingMetricsService) return;

    const cache = this.presenceCache.get(eventId);
    if (!cache) return;

    const now = Date.now();

    // Construir presenceData filtrando por TTL — SIN lectura a RTDB
    const presenceData: Record<string, { on: boolean; ts: number }> = {};
    for (const [uid, entry] of cache.entries()) {
      if (entry.on && now - entry.ts < this.PRESENCE_TTL_MS) {
        presenceData[uid] = { on: true, ts: entry.ts };
      }
    }

    // Telemetría de flush (cuántas veces por evento)
    const n = (this.flushCount.get(eventId) ?? 0) + 1;
    this.flushCount.set(eventId, n);
    this.log.debug(
      `[Flush #${n}] event=${eventId} active=${Object.keys(presenceData).length} cached=${cache.size}`,
    );

    // Una sola llamada a onPresenceChange por ventana de debounce.
    // Las escrituras RTDB (setNowCount + publishMetrics) ocurren dentro de este método.
    await this.viewingMetricsService.onPresenceChange(eventId, presenceData);
  }

  // ── API pública ──────────────────────────────────────────────────────────

  /**
   * Activa watcher para un eventId (idempotente).
   *
   * Firebase child_added dispara para TODOS los hijos existentes al registrar
   * el listener, por lo que el cache se puebla automáticamente sin necesidad
   * de un once('value') extra. La ráfaga inicial queda colapsada por el debounce.
   */
  watch(eventId: string): void {
    if (this.listeners.has(eventId)) {
      this.log.debug(`Watcher already active for ${eventId}`);
      return;
    }

    const ref = this.presenceRef(eventId);

    // Empezar con cache limpio para este evento
    this.presenceCache.set(eventId, new Map());

    // ── Handlers incrementales ───────────────────────────────────────────
    // Cada handler actualiza solo la entrada del uid afectado → O(1) por evento.
    // El debounce colapsa ráfagas en un único flush.

    const onChildAdded = (snap: admin.database.DataSnapshot) => {
      this.updatePresenceCache(eventId, snap.key!, snap.val());
      this.scheduleFlush(eventId);
    };

    const onChildChanged = (snap: admin.database.DataSnapshot) => {
      this.updatePresenceCache(eventId, snap.key!, snap.val());
      this.scheduleFlush(eventId);
    };

    const onChildRemoved = (snap: admin.database.DataSnapshot) => {
      // null → eliminar del cache
      this.updatePresenceCache(eventId, snap.key!, null);
      this.scheduleFlush(eventId);
    };

    // Eliminar listeners anteriores (safety) y registrar los nuevos
    ref.off();
    ref.on('child_added', onChildAdded);
    ref.on('child_changed', onChildChanged);
    ref.on('child_removed', onChildRemoved);

    this.listeners.set(eventId, () => {
      try {
        ref.off('child_added', onChildAdded);
        ref.off('child_changed', onChildChanged);
        ref.off('child_removed', onChildRemoved);
        this.log.debug(`Listeners cleaned for ${eventId}`);
      } catch (e) {
        this.log.error(
          `Error cleaning listeners for ${eventId}: ${(e as Error).message}`,
        );
      }
    });

    this.log.log(
      `Presence watcher ON for ${eventId} ` +
        `(incremental, debounce=${this.FLUSH_DEBOUNCE_MS}ms, TTL=${this.PRESENCE_TTL_MS}ms)`,
    );

    // Limpiar nodos stale de RTDB de forma asíncrona (no bloquea el hot path)
    this.cleanStalePresence(eventId).catch(() => {});
  }

  /** Desactiva watcher y libera todos los recursos asociados */
  unwatch(eventId: string): void {
    const detach = this.listeners.get(eventId);
    if (detach) {
      detach();
      this.listeners.delete(eventId);

      // Cancelar flush pendiente
      const timer = this.flushTimers.get(eventId);
      if (timer) {
        clearTimeout(timer);
        this.flushTimers.delete(eventId);
      }

      // Liberar cache en memoria
      this.presenceCache.delete(eventId);
      this.flushCount.delete(eventId);
      this.flushFirstScheduled.delete(eventId);

      this.log.log(`Presence watcher OFF for ${eventId}`);
    }
  }

  /** Limpieza al cerrar el proceso NestJS */
  onModuleDestroy(): void {
    for (const [eventId, detach] of this.listeners.entries()) {
      try {
        detach();
      } catch {
        /* empty */
      }
      const timer = this.flushTimers.get(eventId);
      if (timer) clearTimeout(timer);
      this.log.log(`Presence watcher OFF (shutdown) for ${eventId}`);
    }
    this.listeners.clear();
    this.presenceCache.clear();
    this.flushTimers.clear();
    this.flushFirstScheduled.clear();
  }

  /**
   * Recalcular bajo demanda — OK usar once('value') aquí, es on-demand.
   * (endpoint opcional de diagnóstico/admin)
   */
  async recalcNow(eventId: string) {
    try {
      const snap = await Promise.race([
        this.presenceRef(eventId).once('value'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('RTDB timeout')), 5000),
        ),
      ]);
      const val = snap.val() ?? {};
      const count = typeof val === 'object' ? Object.keys(val).length : 0;
      await admin.database().ref(`/events/${eventId}/nowCount`).set(count);

      // Sincronizar cache con el estado real de RTDB
      if (this.presenceCache.has(eventId)) {
        const cache = this.presenceCache.get(eventId)!;
        cache.clear();
        if (typeof val === 'object' && val !== null) {
          for (const [uid, data] of Object.entries(val)) {
            const on: boolean = (data as any)?.on ?? false;
            const ts: number = (data as any)?.ts ?? Date.now();
            cache.set(uid, { ts, on });
          }
        }
        this.log.debug(
          `recalcNow: resync cache for ${eventId} (${cache.size} entries)`,
        );
      }

      return { eventId, nowCount: count };
    } catch (error) {
      this.log.error(
        `Error in recalcNow for ${eventId}: ${(error as Error).message}`,
      );
      return { eventId, nowCount: 0, error: (error as Error).message };
    }
  }

  /**
   * Limpiar nodos de presencia antiguos en RTDB (on-demand, no hot path).
   * También sincroniza el cache en memoria.
   */
  async cleanStalePresence(eventId: string) {
    try {
      const snap = await Promise.race([
        this.presenceRef(eventId).once('value'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('RTDB timeout')), 5000),
        ),
      ]);
      const val = snap.val() ?? {};

      if (typeof val !== 'object' || val === null) {
        return { cleaned: 0 };
      }

      const now = Date.now();
      const STALE_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutos
      let cleaned = 0;
      const cache = this.presenceCache.get(eventId);

      for (const [uid, data] of Object.entries(val)) {
        const ts = (data as any)?.ts ?? 0;
        if (now - ts > STALE_TIMEOUT_MS) {
          await this.presenceRef(eventId).child(uid).remove();
          cache?.delete(uid); // Sincronizar cache
          cleaned++;
          this.log.debug(
            `Cleaned stale presence for UID ${uid} in event ${eventId}`,
          );
        }
      }

      this.log.log(
        `Cleaned ${cleaned} stale presence nodes for event ${eventId}`,
      );
      return { cleaned };
    } catch (error) {
      this.log.error(
        `Error in cleanStalePresence: ${(error as Error).message}`,
      );
      return { cleaned: 0, error: (error as Error).message };
    }
  }

  /**
   * Estadísticas de flush por evento (endpoint de diagnóstico).
   *
   * Permite validar:
   *   - cuántas veces por minuto corre el flush por eventId
   *   - cuántas escrituras RTDB ≈ flushCount × 2 (setNowCount + publishMetrics)
   *   - cuántos UIDs están en cache por evento
   */
  getFlushStats() {
    const now = Date.now();
    return {
      flushCounts: Object.fromEntries(this.flushCount),
      activeWatchers: this.listeners.size,
      cachedEvents: [...this.presenceCache.keys()].map((eventId) => ({
        eventId,
        cachedUIDs: this.presenceCache.get(eventId)?.size ?? 0,
        pendingFlushWaitMs: this.flushFirstScheduled.has(eventId)
          ? now - this.flushFirstScheduled.get(eventId)!
          : null,
      })),
      debounceMs: this.FLUSH_DEBOUNCE_MS,
      maxWaitMs: this.FLUSH_MAX_WAIT_MS,
      presenceTtlMs: this.PRESENCE_TTL_MS,
    };
  }
}
