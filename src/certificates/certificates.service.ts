/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

interface ProvisionInput {
  orgName: string;
  eventTitle: string;
  startsAt?: Date;
  endsAt?: Date;
}

interface ProvisionResult {
  certOrganizationId?: string;
  certEventId?: string;
  error?: string;
}

interface SyncAttendeeInput {
  certEventId: string;
  certOrganizationId: string;
  email: string;
  name?: string;
}

interface SyncAttendeeResult {
  certificateAttendeeId: string;
  certificateMemberId: string;
}

// Cliente HTTP hacia el backend externo de certificados (backend-gen,
// D:\gen.iality\Proyectos\backend-gen). Ningún otro módulo debe hablar
// directamente con esa API — todo pasa por aquí para mantener un solo punto
// de contrato/mapeo de errores.
@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);
  private readonly apiUrl =
    process.env.CERTIFICATES_API_URL || 'https://achoapi.geniality.com.co';
  private readonly frontendUrl =
    process.env.CERTIFICATES_FRONTEND_URL ||
    'https://gen-certificados.netlify.app';

  // Claves que usamos en member.properties al sincronizar un attendee (ver
  // syncAttendee). Deben coincidir exactamente con las que se declaran acá
  // como propertiesDefinition de la Organization — es lo que el editor de
  // certificados (certificate-app) lista para poder insertar como atributo
  // en el diseño, y lo que usa para resolver el valor al generar el PDF.
  private readonly requiredProperties = [
    { name: 'fullName', label: 'Nombre del asistente' },
    { name: 'email', label: 'Correo electrónico' },
  ];

  private buildPropertiesDefinition() {
    return this.requiredProperties.map((p) => ({
      name: p.name,
      label: p.label,
      type: 'text',
      required: false,
      show: true,
    }));
  }

  // Crea Organization y Event en gen-certificados si aún no existen. Las dos
  // llamadas se intentan por separado: si la Organization se crea pero el
  // Event falla, igual se retorna el certOrganizationId obtenido (para que el
  // caller lo persista y el próximo intento no cree una Organization
  // duplicada/huérfana).
  async ensureProvisioned(
    input: ProvisionInput,
    existing?: { certOrganizationId?: string; certEventId?: string },
  ): Promise<ProvisionResult> {
    let certOrganizationId = existing?.certOrganizationId;
    let certEventId = existing?.certEventId;

    if (certOrganizationId && certEventId) {
      return { certOrganizationId, certEventId };
    }

    if (!certOrganizationId) {
      try {
        const orgRes = await axios.post(`${this.apiUrl}/organizations`, {
          name: input.orgName,
          propertiesDefinition: this.buildPropertiesDefinition(),
        });
        certOrganizationId = orgRes.data?.data?._id;
        if (!certOrganizationId) {
          throw new Error('Respuesta sin organization._id');
        }
      } catch (error: any) {
        this.logDetailedError('ensureProvisioned (organization)', error);
        return { error: this.describeError(error) };
      }
    } else {
      // La organización ya existía (de un intento anterior). Puede haberse
      // creado antes de que empezáramos a mandar propertiesDefinition —
      // nos aseguramos de que fullName/email queden disponibles para el
      // editor de certificados, sin pisar atributos que un admin haya
      // agregado a mano allá.
      await this.ensureOrganizationProperties(certOrganizationId);
    }

    if (!certEventId) {
      try {
        const eventRes = await axios.post(`${this.apiUrl}/events`, {
          name: input.eventTitle,
          organizationId: certOrganizationId,
          startDate: input.startsAt || new Date(),
          endDate: input.endsAt || new Date(),
        });
        certEventId = eventRes.data?.data?._id;
        if (!certEventId) {
          throw new Error('Respuesta sin event._id');
        }
      } catch (error: any) {
        this.logDetailedError('ensureProvisioned (event)', error);
        return { certOrganizationId, error: this.describeError(error) };
      }
    }

    return { certOrganizationId, certEventId };
  }

  // Backfill idempotente: agrega a propertiesDefinition las claves que nos
  // faltan (fullName/email) sin tocar las que la organización ya tenga
  // (evita pisar atributos configurados a mano en el editor de
  // certificados). No bloquea el flujo si falla — el attendee igual se
  // sincroniza, solo faltaría exponer el atributo en el editor.
  private async ensureOrganizationProperties(certOrganizationId: string) {
    try {
      const orgRes = await axios.get(
        `${this.apiUrl}/organizations/${certOrganizationId}`,
      );
      const current: any[] = orgRes.data?.data?.propertiesDefinition || [];
      const missing = this.requiredProperties.filter(
        (p) => !current.some((c) => c?.name === p.name),
      );
      if (missing.length === 0) return;

      const updated = [
        ...current,
        ...missing.map((p) => ({
          name: p.name,
          label: p.label,
          type: 'text',
          required: false,
          show: true,
        })),
      ];

      await axios.put(`${this.apiUrl}/organizations/${certOrganizationId}`, {
        propertiesDefinition: updated,
      });
    } catch (error: any) {
      this.logDetailedError('ensureOrganizationProperties', error);
    }
  }

  async syncAttendee(
    input: SyncAttendeeInput,
  ): Promise<SyncAttendeeResult | null> {
    try {
      const res = await axios.post(`${this.apiUrl}/users/attendees`, [
        {
          user: { email: input.email },
          attendee: { eventId: input.certEventId },
          member: {
            organizationId: input.certOrganizationId,
            properties: { fullName: input.name, email: input.email },
          },
        },
      ]);

      const item = res.data?.data?.[0];
      const certificateAttendeeId = item?.attendee?._id;
      const certificateMemberId = item?.member?._id || item?.attendee?.memberId;

      if (!certificateAttendeeId || !certificateMemberId) {
        throw new Error('Respuesta sin attendee._id / member._id');
      }

      return { certificateAttendeeId, certificateMemberId };
    } catch (error: any) {
      this.logDetailedError('syncAttendee', error);
      return null;
    }
  }

  // Loguea el error completo de axios (status + body de respuesta), no solo
  // error.message — que para errores de validación suele ser el genérico
  // "Request failed with status code 400" y no dice qué campo falló.
  private logDetailedError(context: string, error: any) {
    const status = error?.response?.status;
    const body = error?.response?.data;
    const detail = body
      ? JSON.stringify(body)
      : error?.message || String(error);
    this.logger.error(
      `${context} failed (status ${status ?? 'n/a'}): ${detail}`,
    );
  }

  private describeError(error: any): string {
    const status = error?.response?.status;
    const message: string =
      error?.response?.data?.message || error?.message || 'Error desconocido';
    return status ? `[${status}] ${message}` : message;
  }

  buildCertificateUrl(
    certificateAttendeeId: string,
    certificateMemberId: string,
  ) {
    return `${this.frontendUrl}/certificate/${certificateAttendeeId}/${certificateMemberId}`;
  }
}
