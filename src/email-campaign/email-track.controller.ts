import { Controller, Get, Param, Req, Res, HttpCode } from '@nestjs/common';
import type { Request, Response } from 'express';
import { EmailTrackService } from './email-track.service';

@Controller('track')
export class EmailTrackController {
  constructor(private readonly trackService: EmailTrackService) {}

  @Get('click/:token')
  async handleClick(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      '';
    const userAgent = req.headers['user-agent'] || '';

    const redirectUrl = await this.trackService.recordClick(
      token,
      ip,
      userAgent,
    );

    if (!redirectUrl) {
      res.status(302).redirect('/');
      return;
    }

    res.status(302).redirect(redirectUrl);
  }

  @Get('arrive/:token')
  @HttpCode(204)
  async handleArrival(@Param('token') token: string): Promise<void> {
    await this.trackService.recordArrival(token);
  }
}
