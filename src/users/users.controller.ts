import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { UsersService } from './users.service';
import {
  CreateUserAccountDto,
  UpdateUserAccountDto,
} from './dto/user-account.dto';

@Controller('user-accounts')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() createUserAccountDto: CreateUserAccountDto) {
    return await this.usersService.createOrUpdate(createUserAccountDto);
  }

  @Get('by-firebase-uid/:firebaseUid')
  async findByFirebaseUid(@Param('firebaseUid') firebaseUid: string) {
    return await this.usersService.findByFirebaseUid(firebaseUid);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return await this.usersService.findById(id);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateUserAccountDto: UpdateUserAccountDto,
  ) {
    return await this.usersService.updateById(id, updateUserAccountDto);
  }

  @Get()
  async findAll(
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return await this.usersService.findAllPaginated(offset, limit);
  }

  @Post('update-activity/:firebaseUid')
  @HttpCode(HttpStatus.OK)
  async updateLastActive(@Param('firebaseUid') firebaseUid: string) {
    await this.usersService.updateLastActiveAt(firebaseUid);
    return { success: true };
  }
}
