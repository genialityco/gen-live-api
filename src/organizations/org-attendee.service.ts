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
}
