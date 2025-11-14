import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { RtdbModule } from './rtdb/rtdb.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { EventsModule } from './events/events.module';
import { PublicModule } from './public/public.module';
import { PeopleModule } from './people/people.module';
import { RegistrationsModule } from './registrations/registrations.module';
import { AttendanceModule } from './attendance/attendance.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(process.env.MONGO_URI!),
    ThrottlerModule.forRoot([{ ttl: 60, limit: 60 }]),
    AuthModule,
    RtdbModule,
    PeopleModule,
    RegistrationsModule,
    AttendanceModule,
    OrganizationsModule,
    EventsModule,
    PublicModule,
    UsersModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
