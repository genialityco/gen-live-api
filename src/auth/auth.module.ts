import { Global, Module, forwardRef } from '@nestjs/common';
import { FirebaseAdminProvider } from './firebase-admin.provider';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';

@Global()
@Module({
  imports: [forwardRef(() => UsersModule)],
  controllers: [AuthController],
  providers: [FirebaseAdminProvider],
  exports: [FirebaseAdminProvider],
})
export class AuthModule {}
