import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KycStatus } from '@prisma/client';
import { UpdatePersonalInfoDto } from './dto/update-personal-info.dto';

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
    kyc_status?: KycStatus;
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
    kyc_status?: KycStatus;
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

  async getCurrentUserProfile(userId: string) {
    return this.prisma.users.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        phone_number: true,
        dob: true,
        nationality: true,
        gender: true,
        kyc_status: true,
      },
    });
  }

  async updatePersonalInfo(userId: string, data: UpdatePersonalInfoDto) {
    // Convert dob string to Date object
    const dobDate = data.dob ? new Date(data.dob) : null;

    return this.prisma.users.update({
      where: { user_id: userId },
      data: {
        full_name: data.fullName,
        dob: dobDate,
        nationality: data.nationality,
        gender: data.gender,
        phone_number: data.phoneNumber,
      },
      select: {
        user_id: true,
        email: true,
        username: true,
        full_name: true,
        dob: true,
        nationality: true,
        gender: true,
        phone_number: true,
        created_at: true,
        updated_at: true,
      },
    });
  }
}

