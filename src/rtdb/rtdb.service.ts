import { Injectable } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class RtdbService {
  ref(path: string): admin.database.Reference {
    return admin.database().ref(path);
  }
  async setStatus(
    eventId: string,
    status: 'upcoming' | 'live' | 'ended' | 'replay',
  ) {
    await this.ref(`/events/${eventId}/status`).set(status);
  }
  async setNowCount(eventId: string, n: number) {
    await this.ref(`/events/${eventId}/nowCount`).set(n);
  }
  async announce(eventId: string, message: any) {
    const key = this.ref(`/announcements/${eventId}`).push().key;
    await this.ref(`/announcements/${eventId}/${key}`).set({
      ...message,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });
  }

  /**
   * Publicar métricas simplificadas en RTDB para visualización en tiempo real
   * Solo 3 valores: concurrentes actuales, pico máximo, total de únicos
   */
  async publishMetrics(
    eventId: string,
    metrics: {
      currentConcurrentViewers: number;
      peakConcurrentViewers: number;
      totalUniqueViewers: number;
    },
  ) {
    await this.ref(`/metrics/${eventId}`).set({
      currentConcurrentViewers: metrics.currentConcurrentViewers,
      peakConcurrentViewers: metrics.peakConcurrentViewers,
      totalUniqueViewers: metrics.totalUniqueViewers,
      lastUpdate: admin.database.ServerValue.TIMESTAMP,
    });
  }

  /**
   * Actualizar datos en una ruta específica de RTDB
   */
  async update(path: string, data: any) {
    await this.ref(path).set(data);
  }

  /**
   * Modo emergencia (fallback ante Mongo lento/caído): cachea en RTDB los datos
   * mínimos que EventAttendGcore necesita para renderizar transmisión + chat
   * sin tocar Mongo. Se escribe cada vez que cambian status/stream/playback en
   * Mongo, independientemente de si el modo está activo o no, para que el
   * cache ya esté listo cuando el admin lo active desde "Control del evento".
   * Clave por orgSlug/eventSlug (no eventId) porque el frontend los tiene
   * directo en la URL, sin necesidad de resolverlos vía Mongo.
   */
  async mirrorEventEmergencyData(
    orgSlug: string,
    eventSlug: string,
    data: {
      eventId: string;
      title: string;
      status: string;
      playbackHlsUrl: string | null;
      streamUrl: string | null;
      streamProvider: string | null;
      orgBranding?: any;
      eventBranding?: any;
    },
  ) {
    await this.ref(`/eventEmergency/${orgSlug}/${eventSlug}/data`).set({
      ...data,
      updatedAt: admin.database.ServerValue.TIMESTAMP,
    });
  }

  /**
   * Toggle manual del modo emergencia (desde EventAdminControl). Ruta separada
   * de /data para que refrescar el cache nunca pise el estado del switch.
   */
  async setEventEmergencyActive(
    orgSlug: string,
    eventSlug: string,
    active: boolean,
  ) {
    await this.ref(`/eventEmergency/${orgSlug}/${eventSlug}/active`).set(
      active,
    );
  }

  /**
   * Eliminar datos de una ruta específica de RTDB
   */
  async delete(path: string) {
    await this.ref(path).remove();
  }
}
