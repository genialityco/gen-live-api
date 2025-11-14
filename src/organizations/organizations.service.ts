import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Organization,
  OrganizationDocument,
} from './schemas/organization.schema';
import { OrgAttendee } from './schemas/org-attendee.schema';
import { CreateOrgAttendeeDto } from './dtos/create-org-attendee.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectModel(Organization.name) private model: Model<OrganizationDocument>,
    @InjectModel(OrgAttendee.name) private attendeeModel: Model<OrgAttendee>,
  ) {}

  async create(
    ownerUid: string,
    dto: {
      name: string;
      domainSlug: string;
      description?: string;
      branding?: any;
    },
  ) {
    // opcional: normalizar slug
    const domainSlug = dto.domainSlug.trim().toLowerCase();
    return this.model.create({ ...dto, domainSlug, ownerUid });
  }

  async listByOwnerUid(ownerUid: string) {
    return this.model.find({ ownerUid }).sort({ createdAt: -1 }).lean();
  }

  async findById(id: string) {
    return this.model.findById(id).lean();
  }

  async findBySlug(domainSlug: string) {
    return this.model.findOne({ domainSlug }).lean();
  }

  async listPublic() {
    // Retorna todas las organizaciones públicas (sin datos sensibles)
    return this.model
      .find({})
      .select('name domainSlug description createdAt')
      .sort({ createdAt: -1 })
      .lean();
  }

  // =============== GESTIÓN DE ASISTENTES ===============

  async createAttendee(orgId: string, dto: CreateOrgAttendeeDto) {
    return this.attendeeModel.create({
      ...dto,
      organizationId: orgId,
      registeredAt: new Date(),
    });
  }

  async getAttendeesByOrg(orgId: string) {
    return this.attendeeModel
      .find({ organizationId: orgId })
      .sort({ createdAt: -1 })
      .lean();
  }

  async findAttendeeByEmail(orgId: string, email: string) {
    return this.attendeeModel.findOne({ organizationId: orgId, email }).lean();
  }

  // DEPRECATED: No actualizar lastSeenAt para asistencia en vivo
  // La asistencia se trackea en ViewingSession
  // async updateAttendeeActivity(orgId: string, email: string, eventId?: string) {
  //   const update: Record<string, any> = {};
  //   if (eventId) {
  //     update['$addToSet'] = { eventIds: eventId };
  //   }
  //   return this.attendeeModel.findOneAndUpdate(
  //     { organizationId: orgId, email },
  //     update,
  //     { new: true },
  //   );
  // }

  async getAttendeeStats(orgId: string) {
    const total = await this.attendeeModel.countDocuments({
      organizationId: orgId,
    });
    const thisMonth = await this.attendeeModel.countDocuments({
      organizationId: orgId,
      createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    });

    return { total, thisMonth };
  }

  async getAttendeesByEvent(orgId: string, eventId: string) {
    return this.attendeeModel
      .find({
        organizationId: orgId,
        eventIds: { $in: [eventId] },
      })
      .sort({ registeredAt: -1 })
      .lean();
  }

  async getEventAttendanceStats(orgId: string, eventId: string) {
    const total = await this.attendeeModel.countDocuments({
      organizationId: orgId,
      eventIds: { $in: [eventId] },
    });

    return { total };
  }

  async updateOrgAttendee(attendeeId: string, updateData: any) {
    return this.attendeeModel
      .findByIdAndUpdate(attendeeId, updateData, { new: true })
      .lean();
  }

  // =============== BRANDING ===============

  async updateBranding(orgId: string, branding: any) {
    return this.model
      .findByIdAndUpdate(
        orgId,
        { branding },
        { new: true, runValidators: true },
      )
      .lean();
  }

  // =============== FORMULARIO DE REGISTRO ===============

  async updateRegistrationForm(orgId: string, registrationForm: any) {
    return this.model
      .findByIdAndUpdate(
        orgId,
        { registrationForm },
        { new: true, runValidators: true },
      )
      .lean();
  }

  // =============== ACTUALIZAR ORGANIZACIÓN ===============

  async updateOrganization(
    orgId: string,
    updateData: { name?: string; description?: string },
  ) {
    return this.model
      .findByIdAndUpdate(orgId, updateData, { new: true, runValidators: true })
      .lean();
  }
}
