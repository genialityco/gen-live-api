/* eslint-disable @typescript-eslint/no-floating-promises */
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    cors: { origin: true, credentials: true },
  });

  // Aumentar límite de payload para formularios grandes
  app.use(express.json({ limit: '150mb' }));
  app.use(express.urlencoded({ limit: '150mb', extended: true }));
  // SNS envía notificaciones con Content-Type: text/plain aunque el body sea JSON
  app.use(express.text({ type: 'text/plain', limit: '1mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT || 8080);
}
bootstrap();
