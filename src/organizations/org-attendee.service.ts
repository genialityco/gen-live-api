/* eslint-disable @typescript-eslint/no-redundant-type-constituents */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OrgAttendee } from './schemas/org-attendee.schema';

@Injectable()
export class OrgAttendeeService {
  constructor(
    @InjectModel(OrgAttendee.name)
    private readonly orgAttendeeModel: Model<OrgAttendee>,
  ) {}

  /**
   * Registro avanzado:
   * - Siempre trabaja con registrationData (formData completo)
   * - Si viene attendeeId → actualiza ese registro (validando organización)
   * - Si no viene attendeeId → upsert por (organizationId + email)
   */
  async registerAdvanced(
    organizationId: string,
    payload: {
      attendeeId?: string;
      email: string;
      name?: string;
      phone?: string;
      formData: Record<string, any>;
      firebaseUID?: string;
      metadata?: Record<string, any>;
    },
  ) {
    const { attendeeId, email, name, phone, formData, metadata } = payload;

    if (!email) {
      throw new BadRequestException('Email is required');
    }

    let attendee: any | null = null;

    // 1) Si viene attendeeId → usarlo como fuente de verdad
    if (attendeeId) {
      attendee = await this.orgAttendeeModel.findById(attendeeId).lean();

      if (!attendee) {
        throw new NotFoundException('Attendee not found');
      }

      if (attendee.organizationId.toString() !== organizationId.toString()) {
        throw new BadRequestException(
          'Attendee does not belong to this organization',
        );
      }
    } else {
      // 2) Si no hay attendeeId → buscar por email + org
      attendee = await this.orgAttendeeModel
        .findOne({ organizationId, email })
        .lean();
    }

    if (attendee) {
      // UPDATE: merge de registrationData existente con el nuevo
      const newRegistrationData = {
        ...(attendee.registrationData || {}),
        ...(formData || {}),
      };

      const updatePayload: any = {
        registrationData: newRegistrationData,
        updatedAt: new Date(),
      };

      if (name) updatePayload.name = name;
      if (email) updatePayload.email = email;
      if (phone) updatePayload.phone = phone;
      if (metadata)
        updatePayload.metadata = { ...(attendee.metadata || {}), ...metadata };

      const updated = await this.orgAttendeeModel
        .findByIdAndUpdate(attendee._id, updatePayload, { new: true })
        .lean();

      if (!updated) {
        throw new NotFoundException('Failed to update attendee');
      }

      return updated;
    }

    // 3) CREATE: no había attendee previo
    try {
      const newAttendee = new this.orgAttendeeModel({
        organizationId,
        name: name || formData?.name || '',
        email,
        phone,
        registrationData: formData || {},
        metadata: metadata || {},
        isActive: true,
        registeredAt: new Date(),
        createdAt: new Date(),
      });

      const saved = await newAttendee.save();
      return saved.toObject();
    } catch (error: any) {
      if (error.code === 11000) {
        throw new BadRequestException(
          'Email already registered in this organization',
        );
      }
      throw new BadRequestException(
        'Error creating OrgAttendee: ' + (error.message || 'Unknown error'),
      );
    }
  }

  async findByEmailAndOrg(email: string, organizationId: string): Promise<any> {
    return await this.orgAttendeeModel
      .findOne({ email, organizationId })
      .lean();
  }

  /**
   * Busca un OrgAttendee usando campos identificadores del formulario
   * @param organizationId ID de la organización
   * @param identifierFields Objeto con los campos identificadores y sus valores
   * @example findByIdentifiers('org123', { email: 'user@example.com', dni: '12345678' })
   */
  async findByIdentifiers(
    organizationId: string,
    identifierFields: Record<string, any>,
  ): Promise<any> {
    // Construir query dinámico buscando en registrationData
    const query: any = { organizationId };

    // Para cada campo identificador, buscar en registrationData
    Object.entries(identifierFields).forEach(([fieldName, value]) => {
      query[`registrationData.${fieldName}`] = value;
    });

    console.log('🔍 Searching OrgAttendee with identifiers:', query);

    const attendee = await this.orgAttendeeModel.findOne(query).lean();

    if (attendee) {
      console.log('✅ OrgAttendee found:', attendee._id);
    } else {
      console.log('❌ OrgAttendee not found');
    }

    return attendee;
  }

  async createOrUpdate(
    organizationId: string,
    orgAttendeeData: {
      name: string;
      email: string;
      phone?: string;
    },
  ): Promise<any> {
    const existingAttendee = await this.findByEmailAndOrg(
      orgAttendeeData.email,
      organizationId,
    );

    if (existingAttendee) {
      const updated = await this.orgAttendeeModel
        .findByIdAndUpdate(
          existingAttendee._id,
          {
            ...orgAttendeeData,
          },
          { new: true },
        )
        .lean();

      if (!updated) {
        throw new NotFoundException('Failed to update attendee');
      }
      return updated;
    }

    try {
      const newAttendee = new this.orgAttendeeModel({
        organizationId,
        ...orgAttendeeData,
        createdAt: new Date(),
      });

      const saved = await newAttendee.save();
      return saved.toObject();
    } catch (error: any) {
      if (error.code === 11000) {
        throw new BadRequestException(
          'Email already registered in this organization',
        );
      }
      throw new BadRequestException(
        'Error creating OrgAttendee: ' + (error.message || 'Unknown error'),
      );
    }
  }

  async findByOrganization(organizationId: string): Promise<any[]> {
    return await this.orgAttendeeModel
      .find({ organizationId })
      .sort({ createdAt: -1 })
      .lean();
  }

  async search(organizationId: string, query?: string): Promise<any[]> {
    const filter: any = { organizationId };
    if (query) {
      filter.$or = [
        { name: { $regex: query, $options: 'i' } },
        { email: { $regex: query, $options: 'i' } },
      ];
    }
    return await this.orgAttendeeModel
      .find(filter)
      .sort({ createdAt: -1 })
      .lean();
  }

  async getById(id: string): Promise<any> {
    const attendee = await this.orgAttendeeModel.findById(id).lean();
    if (!attendee) {
      throw new NotFoundException('Attendee not found');
    }
    return attendee;
  }

  async updateAttendee(
    id: string,
    updateData: Partial<OrgAttendee>,
  ): Promise<any> {
    const attendee = await this.orgAttendeeModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .lean();
    if (!attendee) {
      throw new NotFoundException('Attendee not found');
    }
    return attendee;
  }

  async getOrganizationStats(organizationId: string) {
    const [totalAttendees, recentRegistrations] = await Promise.all([
      this.orgAttendeeModel.countDocuments({ organizationId }),
      // Contamos registros recientes (últimos 30 días)
      this.orgAttendeeModel.countDocuments({
        organizationId,
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
    ]);

    return {
      totalAttendees,
      recentRegistrations, // Registros nuevos en los últimos 30 días
    };
  }

  async bulkImport(
    organizationId: string,
    rows: {
      identifierValues: Record<string, any>;
      registrationData: Record<string, any>;
      name?: string;
      email?: string;
      phone?: string;
    }[],
  ) {
    let created = 0;
    let updated = 0;
    const errors: { rowIndex: number; error: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      try {
        let attendee: any | null = null;

        // 1) Intentar por identificadores del registrationForm
        if (
          row.identifierValues &&
          Object.keys(row.identifierValues).length > 0
        ) {
          attendee = await this.findByIdentifiers(
            organizationId,
            row.identifierValues,
          );
        }

        // 2) Fallback: buscar por email si no se encontró y hay email
        if (!attendee && row.email) {
          attendee = await this.findByEmailAndOrg(row.email, organizationId);
        }

        if (attendee) {
          // UPDATE: merge de registrationData
          const newRegistrationData = {
            ...(attendee.registrationData || {}),
            ...(row.registrationData || {}),
          };

          const updatePayload: any = {
            registrationData: newRegistrationData,
          };

          if (row.name) updatePayload.name = row.name;
          if (row.email) updatePayload.email = row.email;
          if (row.phone) updatePayload.phone = row.phone;

          await this.orgAttendeeModel
            .findByIdAndUpdate(attendee._id, updatePayload, { new: true })
            .lean();

          updated++;
        } else {
          // CREATE
          const newAttendee = new this.orgAttendeeModel({
            organizationId,
            name: row.name || row.registrationData?.name || '',
            email: row.email || row.registrationData?.email || '',
            phone: row.phone,
            registrationData: row.registrationData || {},
            registeredAt: new Date(),
          });

          await newAttendee.save();
          created++;
        }
      } catch (e: any) {
        errors.push({
          rowIndex: i,
          error: e?.message || 'Unknown error',
        });
      }
    }

    return {
      created,
      updated,
      errors,
    };
  }
}
