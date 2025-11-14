import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ViewingSession } from './schemas/viewing-session.schema';
import { EventMetrics } from './schemas/event-metrics.schema';
import { EventUser } from './schemas/event-user.schema';
import { Event, EventDocument } from './schemas/event.schema';
import { RtdbService } from '../rtdb/rtdb.service';

/**
 * ViewingMetricsService v2 - Basado en Firebase RTDB Presence
 *
 * ARQUITECTURA:
 * 1. Frontend escribe en /presence/{eventId}/{firebaseUID} con timestamp
 * 2. rtdb-presence-watcher detecta cambios y llama a este servicio
 * 3. Este servicio obtiene datos de EventUser y actualiza ViewingSessions
 * 4. Calcula concurrentes consolidando por EventUser (no por UID)
 */
@Injectable()
export class ViewingMetricsService {
  private readonly logger = new Logger(ViewingMetricsService.name);
  private readonly PRESENCE_TIMEOUT_SECONDS = 60; // Timeout para considerar desconectado

  constructor(
    @InjectModel(ViewingSession.name)
    private viewingSessionModel: Model<ViewingSession>,
    @InjectModel(EventMetrics.name)
    private eventMetricsModel: Model<EventMetrics>,
    @InjectModel(EventUser.name)
    private eventUserModel: Model<EventUser>,
    @InjectModel(Event.name)
    private eventModel: Model<EventDocument>,
    private rtdbService: RtdbService,
  ) {}

  /**
   * Llamado por rtdb-presence-watcher cuando detecta cambios de presencia
   *
   * @param eventId - ID del evento
   * @param presenceData - Mapa de firebaseUID → { on: boolean, ts: timestamp }
   */
  async onPresenceChange(
    eventId: string,
    presenceData: Record<string, { on: boolean; ts: number }>,
  ) {
    this.logger.debug(`Presence change for event ${eventId}`, {
      totalUIDs: Object.keys(presenceData).length,
    });

    const event = await this.eventModel.findById(eventId).lean();
    if (!event) {
      this.logger.warn(`Event ${eventId} not found`);
      return;
    }

    const isLive = event.status === 'live';
    const now = new Date();

    // Procesar cada UID presente
    for (const [firebaseUID, data] of Object.entries(presenceData)) {
      if (!data.on) continue; // Solo procesar usuarios "online"

      // Buscar EventUser asociado a este UID + evento
      const eventUser = await this.eventUserModel
        .findOne({ eventId, firebaseUID })
        .lean();

      if (!eventUser) {
        this.logger.warn(
          `No EventUser found for UID ${firebaseUID} on event ${eventId}`,
        );
        continue;
      }

      // Buscar sesión activa o crear nueva
      let session = await this.viewingSessionModel.findOne({
        eventId,
        eventUserId: eventUser._id,
        firebaseUID,
        endedAt: null,
      });

      if (!session) {
        // Crear nueva sesión
        session = new this.viewingSessionModel({
          eventId,
          eventUserId: eventUser._id,
          firebaseUID,
          startedAt: now,
          lastHeartbeat: now,
          totalWatchTimeSeconds: 0,
          liveWatchTimeSeconds: 0,
          wasLiveDuringSession: isLive,
        });
        this.logger.log(
          `Created viewing session for EventUser ${eventUser._id}`,
        );
      } else {
        // Actualizar sesión existente
        const timeSinceLastHeartbeat = Math.floor(
          (now.getTime() - session.lastHeartbeat.getTime()) / 1000,
        );

        // Solo sumar tiempo si el heartbeat es "razonable" (< 120s)
        // Evita saltos grandes si el usuario estuvo offline mucho tiempo
        if (timeSinceLastHeartbeat <= 120) {
          session.totalWatchTimeSeconds += timeSinceLastHeartbeat;

          if (isLive) {
            session.liveWatchTimeSeconds += timeSinceLastHeartbeat;
            session.wasLiveDuringSession = true;
          }
        }

        session.lastHeartbeat = now;
      }

      await session.save();
    }

    // Actualizar concurrentes con los UIDs activos en RTDB
    const activeUIDs = Object.entries(presenceData)
      .filter(([, data]) => data.on)
      .map(([uid]) => uid);

    await this.updateConcurrentViewers(eventId, activeUIDs);
  }

  /**
   * Calcular espectadores concurrentes desde datos de presencia RTDB
   * Recibe los UIDs activos directamente desde Firebase y consolida por EventUser
   */
  async updateConcurrentViewers(
    eventId: string,
    activeFirebaseUIDs: string[] = [],
  ) {
    let uniqueEventUsers: Set<string>;

    // IMPORTANTE: Si activeFirebaseUIDs es un array (incluso vacío),
    // significa que tenemos datos de RTDB y debemos confiar en ellos.
    // Solo usar ViewingSessions si activeFirebaseUIDs es undefined/null

    if (activeFirebaseUIDs.length > 0) {
      // Hay usuarios activos en RTDB
      this.logger.debug(
        `📊 Counting from RTDB: ${activeFirebaseUIDs.length} active UIDs`,
      );

      const eventUsers = await this.eventUserModel
        .find({
          eventId,
          firebaseUID: { $in: activeFirebaseUIDs },
        })
        .lean();

      uniqueEventUsers = new Set(eventUsers.map((eu) => eu._id.toString()));
    } else {
      // Array vacío = No hay usuarios activos en RTDB
      // Esto es correcto, no buscar en ViewingSessions
      this.logger.debug('📊 No active UIDs from RTDB - concurrent count: 0');
      uniqueEventUsers = new Set();
    }

    const currentConcurrent = uniqueEventUsers.size;

    // Actualizar o crear métricas
    let metrics = await this.eventMetricsModel.findOne({ eventId });

    if (!metrics) {
      metrics = new this.eventMetricsModel({
        eventId,
        currentConcurrentViewers: currentConcurrent,
        peakConcurrentViewers: currentConcurrent,
        totalUniqueViewers: 0,
        lastUpdate: new Date(),
      });
    } else {
      metrics.currentConcurrentViewers = currentConcurrent;
      metrics.lastUpdate = new Date();

      // Actualizar pico si es necesario
      if (currentConcurrent > metrics.peakConcurrentViewers) {
        metrics.peakConcurrentViewers = currentConcurrent;
        this.logger.log(
          `🔥 New peak concurrent viewers for event ${eventId}: ${currentConcurrent}`,
        );
      }
    }

    await metrics.save();

    // Actualizar nowCount en RTDB para el frontend (legacy)
    await this.rtdbService.setNowCount(eventId, currentConcurrent);

    // Publicar métricas simplificadas en tiempo real
    this.logger.log({
      totalUniqueViewers: metrics.totalUniqueViewers,
      peakConcurrentViewers: metrics.peakConcurrentViewers,
      currentConcurrent: currentConcurrent,
    });

    await this.rtdbService.publishMetrics(eventId, {
      currentConcurrentViewers: currentConcurrent,
      peakConcurrentViewers: metrics.peakConcurrentViewers,
      totalUniqueViewers: metrics.totalUniqueViewers,
    });

    this.logger.debug(`✅ Metrics published to RTDB for event ${eventId}`);

    return {
      currentConcurrent,
      uniqueEventUsers: uniqueEventUsers.size,
    };
  }

  /**
   * Cerrar sesión cuando un usuario se desconecta
   */
  async endSession(eventId: string, firebaseUID: string) {
    const now = new Date();

    const session = await this.viewingSessionModel.findOne({
      eventId,
      firebaseUID,
      endedAt: null,
    });

    if (session) {
      session.endedAt = now;

      // Calcular tiempo final si no se había calculado
      const timeSinceLast = Math.floor(
        (now.getTime() - session.lastHeartbeat.getTime()) / 1000,
      );

      if (timeSinceLast <= 120) {
        session.totalWatchTimeSeconds += timeSinceLast;

        const event = await this.eventModel.findById(eventId).lean();
        if (event?.status === 'live') {
          session.liveWatchTimeSeconds += timeSinceLast;
        }
      }

      await session.save();
      this.logger.log(`Ended viewing session for UID ${firebaseUID}`);

      // Recalcular concurrentes
      await this.updateConcurrentViewers(eventId);
    }
  }

  /**
   * Calcular métricas totales del evento
   * Solo cuenta usuarios únicos que estuvieron durante el live (wasLiveDuringSession = true)
   */
  async calculateEventMetrics(eventId: string) {
    let metrics = await this.eventMetricsModel.findOne({ eventId });

    if (!metrics) {
      metrics = new this.eventMetricsModel({
        eventId,
        currentConcurrentViewers: 0,
        peakConcurrentViewers: 0,
        totalUniqueViewers: 0,
        lastUpdate: new Date(),
      });
    }

    // Obtener todas las sesiones que estuvieron durante el live
    const liveSessions = await this.viewingSessionModel
      .find({
        eventId,
        wasLiveDuringSession: true, // Solo contar quien estuvo durante el live
      })
      .lean();

    // Consolidar por EventUser (un usuario puede tener múltiples sesiones/dispositivos)
    const uniqueEventUsers = new Set(
      liveSessions.map((s) => s.eventUserId.toString()),
    );

    // Total de usuarios únicos que estuvieron en algún momento del live
    metrics.totalUniqueViewers = uniqueEventUsers.size;
    metrics.lastUpdate = new Date();

    await metrics.save();

    this.logger.log(`Calculated metrics for event ${eventId}`, {
      totalUniqueViewers: metrics.totalUniqueViewers,
      peakConcurrentViewers: metrics.peakConcurrentViewers,
      currentConcurrent: metrics.currentConcurrentViewers,
    });

    // Publicar métricas simplificadas a RTDB
    await this.rtdbService.publishMetrics(eventId, {
      currentConcurrentViewers: metrics.currentConcurrentViewers,
      peakConcurrentViewers: metrics.peakConcurrentViewers,
      totalUniqueViewers: metrics.totalUniqueViewers,
    });

    return metrics;
  }

  /**
   * Obtener métricas actuales
   */
  async getEventMetrics(eventId: string) {
    let metrics = await this.eventMetricsModel.findOne({ eventId });

    if (!metrics) {
      // Crear métricas vacías si no existen
      metrics = await this.eventMetricsModel.create({
        eventId,
        currentConcurrentViewers: 0,
        peakConcurrentViewers: 0,
        totalUniqueViewers: 0,
        lastUpdate: new Date(),
      });

      // Inicializar también en RTDB
      await this.rtdbService.publishMetrics(eventId, {
        currentConcurrentViewers: 0,
        peakConcurrentViewers: 0,
        totalUniqueViewers: 0,
      });
    }

    return metrics;
  }

  /**
   * Limpiar sesiones obsoletas (sin heartbeat > 2 horas)
   */
  async cleanupStaleSessions() {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 horas

    const staleSessions = await this.viewingSessionModel.find({
      endedAt: null,
      lastHeartbeat: { $lt: cutoff },
    });

    for (const session of staleSessions) {
      session.endedAt = session.lastHeartbeat; // Marcar como terminada en el último heartbeat
      await session.save();
    }

    this.logger.log(`Cleaned up ${staleSessions.length} stale sessions`);

    return { cleaned: staleSessions.length };
  }

  /**
   * Obtener estadísticas de visualización de un usuario específico
   */
  async getUserViewingStats(eventId: string, eventUserId: string) {
    const sessions = await this.viewingSessionModel
      .find({
        eventId,
        eventUserId: new Types.ObjectId(eventUserId),
      })
      .lean();

    if (sessions.length === 0) {
      return null;
    }

    const totalWatchTime = sessions.reduce(
      (sum, s) => sum + s.totalWatchTimeSeconds,
      0,
    );
    const liveWatchTime = sessions.reduce(
      (sum, s) => sum + s.liveWatchTimeSeconds,
      0,
    );
    const wasLive = sessions.some((s) => s.wasLiveDuringSession);

    return {
      eventUserId,
      totalSessions: sessions.length,
      totalWatchTimeSeconds: totalWatchTime,
      liveWatchTimeSeconds: liveWatchTime,
      wasLiveDuringSession: wasLive,
      sessions: sessions.map((s) => ({
        firebaseUID: s.firebaseUID,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        totalWatchTimeSeconds: s.totalWatchTimeSeconds,
        liveWatchTimeSeconds: s.liveWatchTimeSeconds,
      })),
    };
  }
}
