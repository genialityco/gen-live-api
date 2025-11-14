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
}
