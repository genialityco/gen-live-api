/* eslint-disable @typescript-eslint/no-base-to-string */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Poll,
  PollDocument,
  PollStatus,
  QuestionType,
} from './schemas/poll.schema';
import {
  CreatePollDto,
  UpdatePollDto,
  SubmitPollResponseDto,
} from './dtos/poll.dto';
import { RtdbService } from '../rtdb/rtdb.service';
import { Event, EventDocument } from './schemas/event.schema';
import { UserAccount } from '../users/schemas/user-account.schema';
import { OrgAttendee } from '../organizations/schemas/org-attendee.schema';

@Injectable()
export class PollService {
  constructor(
    @InjectModel(Poll.name) private pollModel: Model<PollDocument>,
    @InjectModel(Event.name) private eventModel: Model<EventDocument>,
    @InjectModel(UserAccount.name)
    private userAccountModel: Model<UserAccount>,
    @InjectModel(OrgAttendee.name)
    private orgAttendeeModel: Model<OrgAttendee>,
    private rtdbService: RtdbService,
  ) {}

  /**
   * Crear una nueva encuesta
   */
  async create(
    eventSlugOrId: string,
    createPollDto: CreatePollDto,
    userId: string,
  ): Promise<Poll> {
    const eventId = await this.resolveEventId(eventSlugOrId);

    // Generar IDs únicos para preguntas y opciones
    const questionsWithIds = createPollDto.questions.map((q) => ({
      ...q,
      id: new Types.ObjectId().toString(),
      options: q.options.map((opt) => ({
        ...opt,
        id: new Types.ObjectId().toString(),
        votes: 0,
      })),
      required: q.required ?? true,
    }));

    const poll = new this.pollModel({
      ...createPollDto,
      eventId,
      questions: questionsWithIds,
      createdBy: userId,
      status: PollStatus.DRAFT,
      showStatistics: createPollDto.showStatistics ?? false,
    });

    const saved = await poll.save();

    // Sincronizar con RTDB
    await this.syncToRTDB(String(eventId), saved);

    return saved;
  }

  /**
   * Resolver eventId desde slug o ID
   */
  private async resolveEventId(eventSlugOrId: string): Promise<Types.ObjectId> {
    // Si es un ObjectId válido, usarlo directamente
    if (Types.ObjectId.isValid(eventSlugOrId) && eventSlugOrId.length === 24) {
      return new Types.ObjectId(eventSlugOrId);
    }

    // Si no, buscar por slug
    const event = await this.eventModel.findOne({ slug: eventSlugOrId }).exec();
    if (!event) {
      throw new NotFoundException('Evento no encontrado');
    }
    return event._id;
  }

  /**
   * Obtener todas las encuestas de un evento
   */
  async findByEvent(eventSlugOrId: string): Promise<Poll[]> {
    const eventId = await this.resolveEventId(eventSlugOrId);
    return this.pollModel.find({ eventId }).sort({ createdAt: -1 }).exec();
  }

  /**
   * Obtener una encuesta por ID
   */
  async findOne(pollId: string): Promise<PollDocument> {
    const poll = await this.pollModel.findById(pollId).exec();
    if (!poll) {
      throw new NotFoundException('Encuesta no encontrada');
    }
    return poll;
  }

  /**
   * Actualizar una encuesta (solo en draft)
   */
  async update(
    pollId: string,
    updatePollDto: UpdatePollDto,
    userId: string,
  ): Promise<Poll> {
    const poll = await this.findOne(pollId);

    if (poll.createdBy !== userId) {
      throw new ForbiddenException(
        'No tienes permiso para editar esta encuesta',
      );
    }

    if (poll.status !== PollStatus.DRAFT) {
      throw new BadRequestException(
        'Solo se pueden editar encuestas en estado borrador',
      );
    }

    // Si se actualizan las preguntas, generar IDs
    let questionsWithIds = poll.questions;
    if (updatePollDto.questions) {
      questionsWithIds = updatePollDto.questions.map((q) => ({
        ...q,
        id: new Types.ObjectId().toString(),
        options: q.options.map((opt) => ({
          ...opt,
          id: new Types.ObjectId().toString(),
          votes: 0,
        })),
        required: q.required ?? true,
      }));
    }

    Object.assign(poll, {
      ...updatePollDto,
      questions: questionsWithIds,
    });

    const updated = await poll.save();
    await this.syncToRTDB(String(poll.eventId), updated);

    return updated;
  }

  /**
   * Cambiar el estado de una encuesta (publicar/despublicar)
   */
  async updateStatus(
    pollId: string,
    status: PollStatus,
    userId: string,
  ): Promise<Poll> {
    const poll = await this.findOne(pollId);

    if (poll.createdBy !== userId) {
      throw new ForbiddenException(
        'No tienes permiso para modificar esta encuesta',
      );
    }

    // Validar transiciones de estado
    if (status === PollStatus.PUBLISHED) {
      if (poll.questions.length === 0) {
        throw new BadRequestException(
          'No se puede publicar una encuesta sin preguntas',
        );
      }
      poll.publishedAt = new Date();

      // Despublicar otras encuestas del mismo evento si hay alguna publicada
      await this.pollModel.updateMany(
        {
          eventId: poll.eventId,
          _id: { $ne: poll._id },
          status: PollStatus.PUBLISHED,
        },
        {
          $set: { status: PollStatus.CLOSED, closedAt: new Date() },
        },
      );
    } else if (status === PollStatus.CLOSED) {
      poll.closedAt = new Date();
    }

    poll.status = status;
    const updated = await poll.save();

    // Sincronizar con RTDB
    await this.syncToRTDB(String(poll.eventId), updated);

    // Si se despublica, notificar a RTDB para ocultar drawer
    if (status === PollStatus.CLOSED || status === PollStatus.DRAFT) {
      try {
        await this.rtdbService.update(
          `events/${String(poll.eventId)}/activePoll`,
          null,
        );
      } catch (error: unknown) {
        console.error(
          'Error updating RTDB:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return updated;
  }

  /**
   * Mostrar/ocultar estadísticas en tiempo real
   */
  async toggleStatistics(
    pollId: string,
    showStatistics: boolean,
    userId: string,
  ): Promise<Poll> {
    const poll = await this.findOne(pollId);

    if (poll.createdBy !== userId) {
      throw new ForbiddenException(
        'No tienes permiso para modificar esta encuesta',
      );
    }

    poll.showStatistics = showStatistics;
    const updated = await poll.save();

    await this.syncToRTDB(String(poll.eventId), updated);

    return updated;
  }

  /**
   * Obtener orgAttendeeId desde Firebase UID
   */
  private async getOrgAttendeeIdFromFirebaseUid(
    firebaseUid: string,
  ): Promise<string | null> {
    try {
      // Buscar UserAccount por Firebase UID
      const userAccount = await this.userAccountModel
        .findOne({ firebaseUid })
        .lean();

      if (!userAccount) {
        return null;
      }

      // Buscar OrgAttendee asociado al UserAccount
      const orgAttendee = await this.orgAttendeeModel
        .findOne({ userAccountId: userAccount._id })
        .lean();

      return orgAttendee ? String(orgAttendee._id) : null;
    } catch (error) {
      console.error('Error getting orgAttendeeId:', error);
      return null;
    }
  }

  /**
   * Verificar si un usuario ya respondió una encuesta
   * Busca por orgAttendeeId (persistente)
   */
  async checkIfUserResponded(
    pollId: string,
    userId: string,
    orgAttendeeId?: string,
  ): Promise<boolean> {
    const poll = await this.findOne(pollId);

    console.log('[PollService] checkIfUserResponded - pollId:', pollId);
    console.log('[PollService] checkIfUserResponded - userId:', userId);
    console.log('[PollService] checkIfUserResponded - orgAttendeeId param:', orgAttendeeId);

    // Si no se proporciona orgAttendeeId, intentar obtenerlo del firebaseUid
    const attendeeId =
      orgAttendeeId || (await this.getOrgAttendeeIdFromFirebaseUid(userId));

    console.log('[PollService] checkIfUserResponded - attendeeId final:', attendeeId);
    console.log('[PollService] checkIfUserResponded - poll.responses:', poll.responses.map(r => r.orgAttendeeId));

    // Si no hay orgAttendeeId, no puede verificar (usuario no registrado)
    if (!attendeeId) {
      console.log('[PollService] checkIfUserResponded - No attendeeId, returning false');
      return false;
    }

    // Buscar respuesta SOLO por orgAttendeeId
    const hasResponded = poll.responses.some((r) => r.orgAttendeeId === attendeeId);
    console.log('[PollService] checkIfUserResponded - hasResponded:', hasResponded);
    return hasResponded;
  }

  /**
   * Enviar respuesta a una encuesta
   */
  async submitResponse(
    pollId: string,
    userId: string,
    submitDto: SubmitPollResponseDto,
  ): Promise<Poll> {
    const poll = await this.findOne(pollId);

    if (poll.status !== PollStatus.PUBLISHED) {
      throw new BadRequestException(
        'Esta encuesta no está disponible para responder',
      );
    }

    // Verificar si el usuario ya respondió
    const hasResponded = await this.checkIfUserResponded(
      pollId,
      userId,
      submitDto.orgAttendeeId,
    );
    if (hasResponded) {
      throw new BadRequestException('Ya has respondido esta encuesta');
    }

    // Validar respuestas
    for (const answer of submitDto.answers) {
      const question = poll.questions.find((q) => q.id === answer.questionId);
      if (!question) {
        throw new BadRequestException(
          `Pregunta ${answer.questionId} no encontrada`,
        );
      }

      // Validar tipo de pregunta
      if (
        question.type === QuestionType.SINGLE_CHOICE &&
        answer.selectedOptions.length > 1
      ) {
        throw new BadRequestException(
          `La pregunta "${question.text}" solo permite una opción`,
        );
      }

      // Validar que las opciones existen
      for (const optionId of answer.selectedOptions) {
        const optionExists = question.options.some(
          (opt) => opt.id === optionId,
        );
        if (!optionExists) {
          throw new BadRequestException(
            `Opción ${optionId} no encontrada en la pregunta "${question.text}"`,
          );
        }
      }
    }

    // Verificar que todas las preguntas requeridas fueron respondidas
    const requiredQuestions = poll.questions.filter((q) => q.required);
    for (const question of requiredQuestions) {
      const answered = submitDto.answers.some(
        (a) => a.questionId === question.id,
      );
      if (!answered) {
        throw new BadRequestException(
          `La pregunta "${question.text}" es obligatoria`,
        );
      }
    }

    // Usar orgAttendeeId del DTO o intentar obtenerlo del firebaseUid
    const orgAttendeeId =
      submitDto.orgAttendeeId ||
      (await this.getOrgAttendeeIdFromFirebaseUid(userId));

    console.log('[PollService] submitResponse - userId:', userId);
    console.log('[PollService] submitResponse - submitDto.orgAttendeeId:', submitDto.orgAttendeeId);
    console.log('[PollService] submitResponse - orgAttendeeId final:', orgAttendeeId);

    // Validar que exista orgAttendeeId
    if (!orgAttendeeId) {
      throw new BadRequestException(
        'No se puede enviar respuesta sin estar registrado en el evento',
      );
    }

    // Registrar respuestas (sin userId)
    const responses = submitDto.answers.map((answer) => ({
      orgAttendeeId,
      questionId: answer.questionId,
      selectedOptions: answer.selectedOptions,
      respondedAt: new Date(),
    }));

    poll.responses.push(...responses);

    // Actualizar contadores de votos
    for (const answer of submitDto.answers) {
      const question = poll.questions.find((q) => q.id === answer.questionId);
      if (question) {
        for (const optionId of answer.selectedOptions) {
          const option = question.options.find((opt) => opt.id === optionId);
          if (option) {
            option.votes += 1;
          }
        }
      }
    }

    // Incrementar total de respuestas únicas
    poll.totalResponses += 1;

    const updated = await poll.save();

    // Sincronizar estadísticas en tiempo real
    await this.syncToRTDB(String(poll.eventId), updated);

    return updated;
  }

  /**
   * Obtener estadísticas de una encuesta
   */
  async getStatistics(pollId: string) {
    const poll = await this.findOne(pollId);

    const statistics = {
      pollId: poll._id,
      title: poll.title,
      totalResponses: poll.totalResponses,
      status: poll.status,
      showStatistics: poll.showStatistics,
      questions: poll.questions.map((question) => {
        const totalVotes = question.options.reduce(
          (sum, opt) => sum + opt.votes,
          0,
        );

        return {
          id: question.id,
          text: question.text,
          type: question.type,
          totalVotes,
          options: question.options.map((option) => ({
            id: option.id,
            text: option.text,
            votes: option.votes,
            percentage:
              totalVotes > 0
                ? parseFloat(((option.votes / totalVotes) * 100).toFixed(2))
                : 0,
          })),
        };
      }),
    };

    return statistics;
  }

  /**
   * Obtener la encuesta activa de un evento
   */
  async getActivePoll(eventSlugOrId: string): Promise<Poll | null> {
    const eventId = await this.resolveEventId(eventSlugOrId);
    return this.pollModel
      .findOne({
        eventId,
        status: PollStatus.PUBLISHED,
      })
      .exec();
  }

  /**
   * Eliminar una encuesta
   */
  async delete(pollId: string, userId: string): Promise<void> {
    const poll = await this.findOne(pollId);

    if (poll.createdBy !== userId) {
      throw new ForbiddenException(
        'No tienes permiso para eliminar esta encuesta',
      );
    }

    if (poll.status === PollStatus.PUBLISHED) {
      throw new BadRequestException(
        'No se puede eliminar una encuesta publicada',
      );
    }

    await this.pollModel.findByIdAndDelete(pollId).exec();

    // Limpiar de RTDB
    await this.rtdbService.delete(
      `events/${String(poll.eventId)}/polls/${pollId}`,
    );
  }

  /**
   * Sincronizar encuesta con Firebase RTDB
   */
  private async syncToRTDB(eventId: string, poll: PollDocument): Promise<void> {
    const pollId = String(poll._id);
    const pollData: Record<string, any> = {
      id: pollId,
      title: poll.title,
      status: poll.status,
      showStatistics: poll.showStatistics,
      totalResponses: poll.totalResponses,
      questions: poll.questions.map((q) => ({
        id: q.id,
        text: q.text,
        type: q.type,
        required: q.required,
        options: q.options.map((opt) => ({
          id: opt.id,
          text: opt.text,
          votes: opt.votes,
        })),
      })),
    };

    // Solo incluir campos opcionales si tienen valor
    if (poll.description) {
      pollData.description = poll.description;
    }
    if (poll.publishedAt) {
      pollData.publishedAt = poll.publishedAt.toISOString();
    }

    // Guardar encuesta específica
    await this.rtdbService.update(
      `events/${eventId}/polls/${pollId}`,
      pollData,
    );

    // Si está publicada, marcarla como activa
    if (poll.status === PollStatus.PUBLISHED) {
      await this.rtdbService.update(`events/${eventId}/activePoll`, pollData);
    }
  }
}
