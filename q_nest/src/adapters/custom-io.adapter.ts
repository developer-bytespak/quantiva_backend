import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, ServerOptions } from 'socket.io';
import { INestApplication } from '@nestjs/common';

/**
 * Custom Socket.IO adapter that ensures all WebSocket gateways share a single
 * engine.io server instance. Without this, NestJS creates a separate Socket.IO
 * Server (and therefore a separate engine.io listener) per gateway, causing
 * "server.handleUpgrade() was called more than once with the same socket" crashes
 * when multiple gateways are registered on the same HTTP server.
 *
 * CORS is configured centrally here so all gateways/namespaces share the same
 * allowed-origins list, regardless of initialisation order.
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

    // Build allowed origins from env, same logic as main.ts HTTP CORS
    const allowedOrigins: string[] = [
      'http://localhost:3001',
      'http://localhost:3000',
      'http://127.0.0.1:3001',
    ];
    const envFrontend = process.env.FRONTEND_URL;
    const envFrontendList = process.env.FRONTEND_URLS;
    if (envFrontend) allowedOrigins.push(envFrontend.replace(/\/$/, ''));
    if (envFrontendList) {
      envFrontendList.split(',').map(s => s.trim()).filter(Boolean).forEach(u => allowedOrigins.push(u.replace(/\/$/, '')));
    }

    const merged: ServerOptions = {
      ...options,
      cors: {
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
          // Allow non-browser requests (no origin header)
          if (!origin) return callback(null, true);
          if (allowedOrigins.includes(origin)) return callback(null, true);
          // Allow Vercel preview/deploy domains for this project
          try {
            const lower = String(origin).toLowerCase();
            if (/^https:\/\/quantiva[\w-]*\.vercel\.app$/.test(lower)) return callback(null, true);
          } catch (_) { /* ignore */ }
          // Non-production fallback
          if (process.env.NODE_ENV !== 'production') return callback(null, true);
          console.warn(`Socket.IO CORS: rejecting origin ${origin}`);
          return callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'POST'],
      },
    } as ServerOptions;

    this.sharedServer = super.createIOServer(port, merged) as Server;
    return this.sharedServer;
  }

  getIO(): Server {
    if (!this.sharedServer) {
      throw new Error('CustomIoAdapter: IO server not yet initialized. Call createIOServer first.');
    }
    return this.sharedServer;
  }
}
