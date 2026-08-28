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
  certOrganizationId: string;
  certEventId: string;
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

  async ensureProvisioned(
    input: ProvisionInput,
    existing?: { certOrganizationId?: string; certEventId?: string },
  ): Promise<ProvisionResult | null> {
    if (existing?.certOrganizationId && existing?.certEventId) {
      return {
        certOrganizationId: existing.certOrganizationId,
        certEventId: existing.certEventId,
      };
    }

    try {
      let certOrganizationId = existing?.certOrganizationId;
      if (!certOrganizationId) {
        const orgRes = await axios.post(`${this.apiUrl}/organizations`, {
          name: input.orgName,
        });
        certOrganizationId = orgRes.data?.data?._id;
      }

      let certEventId = existing?.certEventId;
      if (!certEventId) {
        const eventRes = await axios.post(`${this.apiUrl}/events`, {
          name: input.eventTitle,
          organization: certOrganizationId,
          startDate: input.startsAt || new Date(),
          endDate: input.endsAt || new Date(),
        });
        certEventId = eventRes.data?.data?._id;
      }

      if (!certOrganizationId || !certEventId) {
        throw new Error('Respuesta de provisioning sin ids esperados');
      }

      return { certOrganizationId, certEventId };
    } catch (error: any) {
      this.logger.error(`ensureProvisioned failed: ${error?.message || error}`);
      return null;
    }
  }

  async syncAttendee(
    input: SyncAttendeeInput,
  ): Promise<SyncAttendeeResult | null> {
    try {
      const res = await axios.post(
        `${this.apiUrl}/users/attendees/addOrCreateAttendee`,
        [
          {
            user: { email: input.email },
            attendee: { eventId: input.certEventId },
            member: {
              organizationId: input.certOrganizationId,
              properties: { fullName: input.name, email: input.email },
            },
          },
        ],
      );

      const item = res.data?.data?.[0];
      const certificateAttendeeId = item?.attendee?._id;
      const certificateMemberId = item?.member?._id || item?.attendee?.memberId;

      if (!certificateAttendeeId || !certificateMemberId) {
        throw new Error('Respuesta sin attendee._id / member._id');
      }

      return { certificateAttendeeId, certificateMemberId };
    } catch (error: any) {
      this.logger.error(`syncAttendee failed: ${error?.message || error}`);
      return null;
    }
  }

  buildCertificateUrl(
    certificateAttendeeId: string,
    certificateMemberId: string,
  ) {
    return `${this.frontendUrl}/certificate/${certificateAttendeeId}/${certificateMemberId}`;
  }
}
