// src/mail/mail.controller.ts
import { Controller, Get, Query } from '@nestjs/common';
import { MailService } from './mail.service';

@Controller('mail')
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Get('test')
  async sendTest(@Query('to') to: string) {
    await this.mailService.sendTemplateEmail({
      to,
      subject: 'Test Gen-Live',
      templateName: 'welcome',
      fromName: 'Gen-Live Team',
      context: {
        name: 'Tester',
        email: to,
        verifyUrl: 'https://gen-live.com/demo',
      },
    });

    return { ok: true };
  }
}
