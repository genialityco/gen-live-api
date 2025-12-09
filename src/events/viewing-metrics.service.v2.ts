/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-base-to-string */
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

  // Cache de UIDs que no tienen EventUser (para evitar queries repetidas y warnings)
  private unknownUIDs = new Map<
    string,
    { eventId: string; lastWarned: number }
  >();
  private readonly UNKNOWN_UID_WARNING_COOLDOWN = 5 * 60 * 1000; // 5 minutos entre warnings
  private readonly UNKNOWN_UID_CACHE_TTL = 30 * 60 * 1000; // 30 minutos de caché

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
  ) {
    // Limpiar caché de UIDs desconocidos cada 15 minutos
    setInterval(() => this.cleanUnknownUIDsCache(), 15 * 60 * 1000);
  }

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
    const event = await this.eventModel.findById(eventId).lean();
    if (!event) {
      this.logger.warn(`Event ${eventId} not found`);
      return;
    }

    const isLive = event.status === 'live';
    const now = new Date();
    const nowTimestamp = now.getTime();

    // Filtrar UIDs activos
    const initialActiveUIDs = Object.entries(presenceData)
      .filter(([, data]) => data.on)
      .map(([uid]) => uid);

    if (initialActiveUIDs.length === 0) return;

    // Filtrar UIDs que sabemos que no tienen EventUser (caché)
    const uidsToCheck = initialActiveUIDs.filter((uid) => {
      const cached = this.unknownUIDs.get(`${eventId}:${uid}`);
      if (!cached) return true;

      // Si el caché ha expirado, volver a verificar
      if (nowTimestamp - cached.lastWarned > this.UNKNOWN_UID_CACHE_TTL) {
        this.unknownUIDs.delete(`${eventId}:${uid}`);
        return true;
      }
      return false;
    });

    if (uidsToCheck.length === 0) {
      // Todos los UIDs están en caché como desconocidos
      return;
    }

    // Batch query: buscar todos los EventUsers de una vez
    const eventUsers = await this.eventUserModel
      .find(
        { eventId, firebaseUID: { $in: uidsToCheck } },
        { _id: 1, firebaseUID: 1 },
      )
      .lean()
      .exec();

    // Crear mapa de UID → EventUser para acceso rápido
    const eventUserMap = new Map(eventUsers.map((eu) => [eu.firebaseUID, eu]));

    // Identificar UIDs sin EventUser y agregarlos al caché
    const unknownUIDs = uidsToCheck.filter((uid) => !eventUserMap.has(uid));
    for (const uid of unknownUIDs) {
      const cacheKey = `${eventId}:${uid}`;
      const cached = this.unknownUIDs.get(cacheKey);

      // Solo logear warning si no está en caché o si ha pasado el cooldown
      if (
        !cached ||
        nowTimestamp - cached.lastWarned > this.UNKNOWN_UID_WARNING_COOLDOWN
      ) {
        this.logger.warn(
          `No EventUser found for UID ${uid} on event ${eventId} (usuario no registrado o anónimo)`,
        );
        this.unknownUIDs.set(cacheKey, { eventId, lastWarned: nowTimestamp });
      }
    }

    // Alerta si hay demasiados usuarios sin registro (posible problema)
    const totalUIDs = uidsToCheck.length;
    const registeredCount = totalUIDs - unknownUIDs.length;
    if (unknownUIDs.length > 0 && totalUIDs > 10) {
      const unknownPercentage = (unknownUIDs.length / totalUIDs) * 100;
      if (unknownPercentage > 30) {
        this.logger.error(
          `⚠️ ALERT: ${unknownUIDs.length}/${totalUIDs} (${unknownPercentage.toFixed(1)}%) unknown UIDs in event ${eventId}. Possible registration issue!`,
        );
      }
    }

    // Procesar solo usuarios registrados - OPTIMIZADO CON BATCH OPERATIONS
    const registeredUIDs = Object.entries(presenceData)
      .filter(([uid, data]) => data.on && eventUserMap.has(uid))
      .map(([uid]) => uid);

    if (registeredUIDs.length === 0) {
      // No hay usuarios registrados para procesar
      await this.updateConcurrentViewers(eventId, []);
      return;
    }

    // Batch query: obtener todas las sesiones activas de una vez
    const activeSessions = await this.viewingSessionModel
      .find({
        eventId,
        firebaseUID: { $in: registeredUIDs },
        endedAt: null,
      })
      .exec();

    // Crear mapa de UID → Session para acceso rápido
    const sessionMap = new Map(activeSessions.map((s) => [s.firebaseUID, s]));

    // Preparar operaciones bulk
    const bulkOps: any[] = [];
    const newSessions: Partial<ViewingSession>[] = [];

    for (const uid of registeredUIDs) {
      const eventUser = eventUserMap.get(uid);
      if (!eventUser) continue;

      const existingSession = sessionMap.get(uid);

      if (!existingSession) {
        // Crear nueva sesión (insertamos después)
        newSessions.push({
          eventId,
          eventUserId: new Types.ObjectId(eventUser._id.toString()),
          firebaseUID: uid,
          startedAt: now,
          lastHeartbeat: now,
          totalWatchTimeSeconds: 0,
          liveWatchTimeSeconds: 0,
          wasLiveDuringSession: isLive,
        });
      } else {
        // Actualizar sesión existente con bulk operation
        const timeSinceLastHeartbeat = Math.floor(
          (now.getTime() - existingSession.lastHeartbeat.getTime()) / 1000,
        );

        // Solo actualizar si el heartbeat es razonable
        if (timeSinceLastHeartbeat <= 120) {
          const updates: any = {
            lastHeartbeat: now,
            $inc: {
              totalWatchTimeSeconds: timeSinceLastHeartbeat,
            },
          };

          if (isLive) {
            updates.$inc.liveWatchTimeSeconds = timeSinceLastHeartbeat;
            updates.wasLiveDuringSession = true;
          }

          bulkOps.push({
            updateOne: {
              filter: { _id: existingSession._id },
              update: updates,
            },
          });
        } else {
          // Solo actualizar timestamp si el heartbeat es muy antiguo
          bulkOps.push({
            updateOne: {
              filter: { _id: existingSession._id },
              update: { lastHeartbeat: now },
            },
          });
        }
      }
    }

    // Ejecutar operaciones en batch
    try {
      // Insertar nuevas sesiones si hay
      if (newSessions.length > 0) {
        await this.viewingSessionModel.insertMany(newSessions, {
          ordered: false,
        });
      }

      // Ejecutar actualizaciones bulk si hay
      if (bulkOps.length > 0) {
        await this.viewingSessionModel.bulkWrite(bulkOps, { ordered: false });
      }
    } catch (error) {
      this.logger.error(
        `Error in batch session updates: ${(error as Error).message}`,
      );
    }

    // Actualizar concurrentes con los UIDs activos en RTDB
    const activeUIDsForUpdate = Object.entries(presenceData)
      .filter(([, data]) => data.on)
      .map(([uid]) => uid);

    await this.updateConcurrentViewers(eventId, activeUIDsForUpdate);
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

      const eventUsers = await this.eventUserModel
        .find(
          {
            eventId,
            firebaseUID: { $in: activeFirebaseUIDs },
          },
          { _id: 1 }, // Solo proyectar el campo necesario
        )
        .lean()
        .exec();

      uniqueEventUsers = new Set(eventUsers.map((eu) => eu._id.toString()));
    } else {
      // Array vacío = No hay usuarios activos en RTDB
      // Esto es correcto, no buscar en ViewingSessions
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
      }
    }

    await metrics.save();

    // Actualizar nowCount en RTDB para el frontend (legacy)
    await this.rtdbService.setNowCount(eventId, currentConcurrent);

    // Publicar métricas simplificadas en tiempo real
    await this.rtdbService.publishMetrics(eventId, {
      currentConcurrentViewers: currentConcurrent,
      peakConcurrentViewers: metrics.peakConcurrentViewers,
      totalUniqueViewers: metrics.totalUniqueViewers,
    });

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
    // Solo proyectar el campo necesario para reducir memoria
    const liveSessions = await this.viewingSessionModel
      .find(
        {
          eventId,
          wasLiveDuringSession: true, // Solo contar quien estuvo durante el live
        },
        { eventUserId: 1 }, // Solo necesitamos el eventUserId
      )
      .lean()
      .exec();

    // Consolidar por EventUser (un usuario puede tener múltiples sesiones/dispositivos)
    const uniqueEventUsers = new Set(
      liveSessions.map((s) => s.eventUserId.toString()),
    );

    // Total de usuarios únicos que estuvieron en algún momento del live
    metrics.totalUniqueViewers = uniqueEventUsers.size;
    metrics.lastUpdate = new Date();

    await metrics.save();

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

  /**
   * Contar sesiones abiertas (para diagnóstico)
   */
  async countOpenSessions(): Promise<number> {
    return await this.viewingSessionModel
      .countDocuments({ endedAt: null })
      .exec();
  }

  /**
   * Contar sesiones obsoletas (sin heartbeat > 2 horas, para diagnóstico)
   */
  async countStaleSessions(): Promise<number> {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 horas
    return await this.viewingSessionModel
      .countDocuments({
        endedAt: null,
        lastHeartbeat: { $lt: cutoff },
      })
      .exec();
  }

  /**
   * Limpiar caché de UIDs desconocidos (ejecutado periódicamente)
   */
  private cleanUnknownUIDsCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.unknownUIDs.entries()) {
      if (now - value.lastWarned > this.UNKNOWN_UID_CACHE_TTL) {
        this.unknownUIDs.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned ${cleaned} unknown UID cache entries`);
    }
  }

  /**
   * Obtener estadísticas de UIDs desconocidos (para diagnóstico)
   */
  getUnknownUIDsStats() {
    const statsByEvent = new Map<string, number>();

    for (const [, value] of this.unknownUIDs.entries()) {
      const count = statsByEvent.get(value.eventId) || 0;
      statsByEvent.set(value.eventId, count + 1);
    }

    return {
      total: this.unknownUIDs.size,
      byEvent: Object.fromEntries(statsByEvent),
    };
  }
}
