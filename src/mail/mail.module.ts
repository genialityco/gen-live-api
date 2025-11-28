// src/mail/mail.module.ts
import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { MailController } from './mail.controller';

@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
  controllers: [MailController],
})
export class MailModule {}
