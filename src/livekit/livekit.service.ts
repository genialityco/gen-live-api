// src/livekit/livekit.service.ts
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import {
  AccessToken,
  RoomServiceClient,
  CreateOptions,
} from 'livekit-server-sdk';

@Injectable()
export class LivekitService {
  private roomClient: RoomServiceClient;
  private readonly apiKey: string;
  private readonly apiSecret: string;

  constructor() {
    this.apiKey = process.env.LIVEKIT_API_KEY ?? '';
    this.apiSecret = process.env.LIVEKIT_API_SECRET ?? '';
    const host = process.env.LIVEKIT_HOST ?? 'https://cloud.livekit.io';

    if (!this.apiKey || !this.apiSecret) {
      throw new Error('LIVEKIT_API_KEY o LIVEKIT_API_SECRET no configurados');
    }

    this.roomClient = new RoomServiceClient(host, this.apiKey, this.apiSecret);
  }

  /**
   * Usa el eventSlug como nombre de sala, o un prefijo tipo "event_<id>"
   */
  private buildRoomName(eventSlug: string): string {
    return `event_${eventSlug}`;
  }

  /**
   * Crea la sala en LiveKit si no existe (idempotente).
   */
  async ensureRoomForEvent(eventSlug: string) {
    const roomName = this.buildRoomName(eventSlug);

    try {
      const rooms = await this.roomClient.listRooms([roomName]);
      if (rooms && rooms.length > 0) {
        return rooms[0]; // ya existe
      }

      const options: CreateOptions = {
        name: roomName,
        maxParticipants: 20, // por ahora
        // timeout: 3600, // opcional
        metadata: JSON.stringify({ eventSlug }),
      };

      const created = await this.roomClient.createRoom(options);
      return created;
    } catch (err) {
      console.error('Error en ensureRoomForEvent:', err);
      throw new InternalServerErrorException('No se pudo asegurar la sala');
    }
  }

  /**
   * Genera un token para host/speaker/viewer
   */
  async createToken(params: {
    eventSlug: string;
    role: 'host' | 'speaker' | 'viewer';
    identity?: string; // id de usuario en tu sistema
    name?: string; // displayName
  }): Promise<string> {
    const { eventSlug, role, identity, name } = params;
    const roomName = this.buildRoomName(eventSlug);

    const userIdentity =
      identity || `${role}-${Math.floor(Math.random() * 100000)}`;

    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: userIdentity,
      name, // LiveKit puede mostrarlo
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canSubscribe: true,
      canPublish: role === 'host' || role === 'speaker',
    });

    try {
      const token = await at.toJwt();
      return token;
    } catch (err) {
      console.error('Error generando token LiveKit:', err);
      throw new InternalServerErrorException('No se pudo generar token');
    }
  }
}
