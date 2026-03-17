import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
import { INestApplication } from '@nestjs/common';

/**
 * Custom Socket.IO adapter that ensures all WebSocket gateways share a single
 * engine.io server instance. Without this, NestJS creates a separate Socket.IO
 * Server (and therefore a separate engine.io listener) per gateway, causing
 * "server.handleUpgrade() was called more than once with the same socket" crashes
 * when multiple gateways are registered on the same HTTP server.
 */
export class CustomIoAdapter extends IoAdapter {
  private sharedServer: Server | null = null;

  constructor(app: INestApplication) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    if (this.sharedServer) {
      return this.sharedServer;
    }
    this.sharedServer = super.createIOServer(port, options) as Server;
    return this.sharedServer;
  }

  getIO(): Server {
    if (!this.sharedServer) {
      throw new Error('CustomIoAdapter: IO server not yet initialized. Call createIOServer first.');
    }
    return this.sharedServer;
  }
}
