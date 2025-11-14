import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { UserAccount } from './schemas/user-account.schema';
import {
  CreateUserAccountDto,
  UpdateUserAccountDto,
} from './dto/user-account.dto';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(UserAccount.name) private model: Model<UserAccount>,
  ) {}

  async findOrCreateByFirebaseUid(
    uid: string,
    email?: string,
    displayName?: string,
  ): Promise<UserAccount> {
    let u = await this.model.findOne({ firebaseUid: uid }).lean();

    if (!u) {
      u = await this.model.create({
        firebaseUid: uid,
        email,
        displayName,
        lastActiveAt: new Date(),
      });
    } else {
      const changed =
        (email && email !== u.email) ||
        (displayName && displayName !== u.displayName);

      if (changed) {
        const updated = await this.model.findOneAndUpdate(
          { firebaseUid: uid },
          {
            email: email ?? u.email,
            displayName: displayName ?? u.displayName,
            lastActiveAt: new Date(),
          },
          { new: true },
        );
        if (updated) {
          u = updated;
        }
      }
    }

    return u;
  }

  async createOrUpdate(
    createUserAccountDto: CreateUserAccountDto,
  ): Promise<UserAccount> {
    const existingUser = await this.model.findOne({
      firebaseUid: createUserAccountDto.firebaseUid,
    });

    if (existingUser) {
      if (createUserAccountDto.email) {
        existingUser.email = createUserAccountDto.email;
      }
      if (createUserAccountDto.displayName) {
        existingUser.displayName =
          createUserAccountDto.displayName ?? existingUser.displayName;
      }
      existingUser.lastActiveAt = new Date();
      return await existingUser.save();
    }

    return await this.model.create({
      ...createUserAccountDto,
      lastActiveAt: new Date(),
    });
  }

  async findByFirebaseUid(firebaseUid: string): Promise<UserAccount> {
    const userAccount = await this.model.findOne({ firebaseUid }).lean();

    if (!userAccount) {
      throw new NotFoundException(
        'UserAccount with Firebase UID ' + firebaseUid + ' not found',
      );
    }

    return userAccount;
  }

  async findById(id: string): Promise<UserAccount> {
    const userAccount = await this.model.findById(id).lean();

    if (!userAccount) {
      throw new NotFoundException('UserAccount with ID ' + id + ' not found');
    }

    return userAccount;
  }

  async updateById(
    id: string,
    updateUserAccountDto: UpdateUserAccountDto,
  ): Promise<UserAccount> {
    const userAccount = await this.model
      .findByIdAndUpdate(
        id,
        {
          ...updateUserAccountDto,
          lastActiveAt: new Date(),
        },
        { new: true },
      )
      .lean();

    if (!userAccount) {
      throw new NotFoundException('UserAccount with ID ' + id + ' not found');
    }

    return userAccount;
  }

  async updateLastActiveAt(firebaseUid: string): Promise<void> {
    await this.model.updateOne({ firebaseUid }, { lastActiveAt: new Date() });
  }

  async findAllPaginated(
    offset = 0,
    limit = 10,
  ): Promise<{
    users: UserAccount[];
    total: number;
    offset: number;
  }> {
    const [users, total] = await Promise.all([
      this.model
        .find()
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      this.model.countDocuments(),
    ]);

    return {
      users,
      total,
      offset,
    };
  }
}
