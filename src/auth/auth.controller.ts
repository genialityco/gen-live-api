/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Get,
  Post,
  Req,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { FirebaseAuthGuard } from '../common/guards/firebase-auth.guard';
import { UsersService } from '../users/users.service';

@Controller('auth')
@UseGuards(FirebaseAuthGuard)
export class AuthController {
  constructor(private users: UsersService) {}

  @Post('bootstrap')
  async bootstrap(@Req() req: any) {
    const { uid, email, name, firebase } = req.user || {};
    if (firebase?.sign_in_provider === 'anonymous') {
      throw new ForbiddenException('Anonymous tokens are not allowed here');
    }
    const user = await this.users.findOrCreateByFirebaseUid(uid, email, name);
    return { ok: true, user };
  }

  @Get('me')
  me(@Req() req: any) {
    const { uid, email, name, firebase } = req.user || {};
    return { uid, email, name, provider: firebase?.sign_in_provider ?? null };
  }
}
