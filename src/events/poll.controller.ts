/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import { PollService } from './poll.service';
import {
  CreatePollDto,
  UpdatePollDto,
  UpdatePollStatusDto,
  SubmitPollResponseDto,
  ToggleStatisticsDto,
} from './dtos/poll.dto';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';

@Controller('events/:eventId/polls')
export class PollController {
  constructor(private readonly pollService: PollService) {}

  /**
   * Crear una nueva encuesta (Admin)
   * POST /events/:eventId/polls
   */
  @Post()
  @UseGuards(FirebaseAuthGuard)
  async create(
    @Param('eventId') eventId: string,
    @Body() createPollDto: CreatePollDto,
    @Request() req,
  ) {
    const userId = req.user.uid;
    return this.pollService.create(eventId, createPollDto, userId);
  }

  /**
   * Obtener todas las encuestas de un evento (Admin)
   * GET /events/:eventId/polls
   */
  @Get()
  @UseGuards(FirebaseAuthGuard)
  async findAll(@Param('eventId') eventId: string) {
    return this.pollService.findByEvent(eventId);
  }

  /**
   * Obtener encuesta activa (Público - para usuarios en attend)
   * GET /events/:eventId/polls/active
   */
  @Get('active')
  async getActivePoll(@Param('eventId') eventId: string) {
    return this.pollService.getActivePoll(eventId);
  }

  /**
   * Obtener una encuesta específica
   * GET /events/:eventId/polls/:pollId
   */
  @Get(':pollId')
  @UseGuards(FirebaseAuthGuard)
  async findOne(@Param('pollId') pollId: string) {
    return this.pollService.findOne(pollId);
  }

  /**
   * Actualizar una encuesta (solo en draft)
   * PUT /events/:eventId/polls/:pollId
   */
  @Put(':pollId')
  @UseGuards(FirebaseAuthGuard)
  async update(
    @Param('pollId') pollId: string,
    @Body() updatePollDto: UpdatePollDto,
    @Request() req,
  ) {
    const userId = req.user.uid;
    return this.pollService.update(pollId, updatePollDto, userId);
  }

  /**
   * Cambiar estado de una encuesta (publicar/despublicar)
   * PUT /events/:eventId/polls/:pollId/status
   */
  @Put(':pollId/status')
  @UseGuards(FirebaseAuthGuard)
  async updateStatus(
    @Param('pollId') pollId: string,
    @Body() updateStatusDto: UpdatePollStatusDto,
    @Request() req,
  ) {
    const userId = req.user.uid;
    return this.pollService.updateStatus(
      pollId,
      updateStatusDto.status,
      userId,
    );
  }

  /**
   * Mostrar/ocultar estadísticas en tiempo real
   * PUT /events/:eventId/polls/:pollId/statistics
   */
  @Put(':pollId/statistics')
  @UseGuards(FirebaseAuthGuard)
  async toggleStatistics(
    @Param('pollId') pollId: string,
    @Body() toggleStatsDto: ToggleStatisticsDto,
    @Request() req,
  ) {
    const userId = req.user.uid;
    return this.pollService.toggleStatistics(
      pollId,
      toggleStatsDto.showStatistics,
      userId,
    );
  }

  /**
   * Obtener estadísticas de una encuesta
   * GET /events/:eventId/polls/:pollId/statistics
   */
  @Get(':pollId/statistics')
  @UseGuards(FirebaseAuthGuard)
  async getStatistics(@Param('pollId') pollId: string) {
    return this.pollService.getStatistics(pollId);
  }

  /**
   * Verificar si el usuario ya respondió una encuesta
   * GET /events/:eventId/polls/:pollId/response/check
   */
  @Get(':pollId/response/check')
  @UseGuards(FirebaseAuthGuard)
  async checkResponse(
    @Param('pollId') pollId: string,
    @Query('orgAttendeeId') orgAttendeeId: string | undefined,
    @Request() req,
  ) {
    const userId = req.user.uid;
    const hasResponded = await this.pollService.checkIfUserResponded(
      pollId,
      userId,
      orgAttendeeId,
    );
    return { hasResponded };
  }

  /**
   * Responder una encuesta (Usuarios en attend - con auth anónimo)
   * POST /events/:eventId/polls/:pollId/response
   */
  @Post(':pollId/response')
  @UseGuards(FirebaseAuthGuard)
  async submitResponse(
    @Param('pollId') pollId: string,
    @Body() submitDto: SubmitPollResponseDto,
    @Request() req,
  ) {
    const userId = req.user.uid;
    console.log('[PollController] submitResponse - userId:', userId);
    console.log('[PollController] submitResponse - submitDto:', JSON.stringify(submitDto));
    return this.pollService.submitResponse(pollId, userId, submitDto);
  }

  /**
   * Eliminar una encuesta
   * DELETE /events/:eventId/polls/:pollId
   */
  @Delete(':pollId')
  @UseGuards(FirebaseAuthGuard)
  async delete(@Param('pollId') pollId: string, @Request() req) {
    const userId = req.user.uid;
    await this.pollService.delete(pollId, userId);
    return { message: 'Encuesta eliminada correctamente' };
  }
}
