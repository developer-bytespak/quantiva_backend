import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.users.findMany();
  }

  async findOne(id: string) {
    return this.prisma.users.findUnique({
      where: { user_id: id },
    });
  }

  async findByEmail(email: string) {
    return this.prisma.users.findUnique({
      where: { email },
    });
  }

  async create(data: {
    email: string;
    username: string;
    password_hash?: string;
    email_verified?: boolean;
    kyc_status?: string;
  }) {
    return this.prisma.users.create({
      data,
    });
  }

  async update(id: string, data: {
    email?: string;
    username?: string;
    password_hash?: string;
    email_verified?: boolean;
    kyc_status?: string;
  }) {
    return this.prisma.users.update({
      where: { user_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.users.delete({
      where: { user_id: id },
    });
  }
}

