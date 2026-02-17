import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { PreBuiltSignalsCronjobService } from './modules/strategies/services/pre-built-signals-cronjob.service';
import { json, urlencoded } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase body size limit to 10MB for file uploads (default is 100kb)
  // This applies to JSON and URL-encoded bodies. For multipart/form-data (file uploads),
  // the size limit is controlled by multer configuration in individual controllers.
  // The `verify` callback preserves the raw body buffer on the request object
  // so that webhook signature verification can use the exact bytes sent by the caller.
  app.use(json({
    limit: '10mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  // Enable gzip/brotli compression for all responses (typically 60-80% size reduction)
  app.use(compression({
    threshold: 1024,  // Only compress responses > 1KB
    level: 6,         // Balanced compression level (1=fastest, 9=best)
    filter: (req, res) => {
      // Don't compress SSE or WebSocket upgrade responses
      if (req.headers['accept'] === 'text/event-stream') return false;
      return compression.filter(req, res);
    },
  }));

  // Enable CORS. Support multiple frontend origins via FRONTEND_URLS (comma-separated)
  // Example: FRONTEND_URLS=https://quantiva-hq.vercel.app,https://preview-app.vercel.app
  const envFrontend = process.env.FRONTEND_URL;
  const envFrontendList = process.env.FRONTEND_URLS;
  const allowedOrigins = new Set<string>();
  if (envFrontend) allowedOrigins.add(envFrontend.replace(/\/$/, ''));
  if (envFrontendList) {
    envFrontendList.split(',').map(s => s.trim()).filter(Boolean).forEach(u => allowedOrigins.add(u.replace(/\/$/, '')));
  }
  // Always allow localhost during development
  if (process.env.NODE_ENV !== 'production') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://localhost:3001');
    allowedOrigins.add('http://127.0.0.1:3001');
  }
  // Allow localhost even in production when testing against Render backend.
  // Set ALLOW_LOCALHOST_ORIGIN=true on Render env if needed.
  if (process.env.ALLOW_LOCALHOST_ORIGIN === 'true') {
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://localhost:3001');
    allowedOrigins.add('http://127.0.0.1:3001');
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser requests (no origin)
      if (!origin) return callback(null, true);
      // If origin exactly matches an allowed origin, allow it
      if (allowedOrigins.has(origin)) return callback(null, true);
      // Allow Vercel preview/deploy domains (they vary per preview deployment).
      // This accepts any origin that ends with .vercel.app (e.g. preview deploys).
      try {
        const lower = String(origin).toLowerCase();
        if (lower.endsWith('.vercel.app')) return callback(null, true);
      } catch (err) {
        // ignore and continue to deny
      }
      // As a last resort, if NODE_ENV is not production allow (useful for unknown preview URLs)
      if (process.env.NODE_ENV !== 'production') return callback(null, true);
      // Do not throw an error here (that causes a 500 for preflight). Instead, deny CORS
      // by returning false and log the rejected origin so you can add it to FRONTEND_URLS.
      console.warn(`CORS: rejecting origin ${origin}`);
      return callback(null, false);
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Cookie parser middleware
  app.use(cookieParser());

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT || 3000;
  const server = await app.listen(port, '0.0.0.0');

  // Increase server timeout for long-running preview requests (5 minutes)
  // Preview can take 2-3 minutes with 20 assets, so we set timeout to 5 minutes
  const httpServer = app.getHttpServer();
  httpServer.timeout = 300000; // 5 minutes in milliseconds
  
  console.log(`Application is running on: http://0.0.0.0:${port}`);

  // Trigger an initial run of the pre-built signals generation on startup
  // This seeds the DB with initial signals so the cronjob has data thereafter.
  // Run non-blocking and catch errors so startup isn't prevented.
  try {
    const logger = new Logger('PreBuiltSignalsStartup');
    const cronService = app.get(PreBuiltSignalsCronjobService);
    if (cronService) {
      const connectionId = '7de89ad0-42c5-4491-906e-32dc59500945';
      cronService.triggerManualGeneration({ connectionId })
        .then(() => logger.log(`Initial pre-built signals generation completed (connection ${connectionId})`))
        .catch((err) => logger.error('Initial pre-built generation failed', err.stack || err));
    } else {
      logger.warn('PreBuiltSignalsCronjobService not available on startup');
    }
  } catch (err: any) {
    // Don't prevent the app from starting if this fails
    console.warn('Failed to trigger initial pre-built signals generation:', err?.message || err);
  }
}

bootstrap();
