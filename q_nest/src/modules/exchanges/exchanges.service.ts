import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ExchangesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.exchanges.findMany();
  }

  async findOne(id: string) {
    return this.prisma.exchanges.findUnique({
      where: { exchange_id: id },
      include: { connections: true },
    });
  }

  async create(data: {
    name: string;
    type: string;
    supports_oauth?: boolean;
  }) {
    return this.prisma.exchanges.create({
      data,
    });
  }

  async update(id: string, data: {
    name?: string;
    type?: string;
    supports_oauth?: boolean;
  }) {
    return this.prisma.exchanges.update({
      where: { exchange_id: id },
      data,
    });
  }

  async delete(id: string) {
    return this.prisma.exchanges.delete({
      where: { exchange_id: id },
    });
  }

  async getUserConnections(userId: string) {
    return this.prisma.user_exchange_connections.findMany({
      where: { user_id: userId },
      include: { exchange: true },
    });
  }

  async createConnection(data: {
    user_id: string;
    exchange_id: string;
    auth_type: string;
    api_key_encrypted?: string;
    api_secret_encrypted?: string;
    oauth_access_token?: string;
    oauth_refresh_token?: string;
    permissions?: any;
    status?: string;
  }) {
    return this.prisma.user_exchange_connections.create({
      data,
      include: { exchange: true },
    });
  }

  async updateConnection(id: string, data: {
    auth_type?: string;
    api_key_encrypted?: string;
    api_secret_encrypted?: string;
    oauth_access_token?: string;
    oauth_refresh_token?: string;
    permissions?: any;
    status?: string;
  }) {
    return this.prisma.user_exchange_connections.update({
      where: { connection_id: id },
      data,
    });
  }

  async deleteConnection(id: string) {
    return this.prisma.user_exchange_connections.delete({
      where: { connection_id: id },
    });
  }
}

