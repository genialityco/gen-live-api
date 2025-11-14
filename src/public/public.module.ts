import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [EventsModule],
  controllers: [PublicController],
})
export class PublicModule {}
