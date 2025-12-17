import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
  }

  app.enableCors({
    origin: (origin, callback) => {
      // Allow non-browser requests (no origin)
      if (!origin) return callback(null, true);
      // If origin exactly matches an allowed origin, allow it
      if (allowedOrigins.has(origin)) return callback(null, true);
      // As a last resort, if NODE_ENV is not production allow (useful for unknown preview URLs)
      if (process.env.NODE_ENV !== 'production') return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
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
  await app.listen(port, '0.0.0.0');
  console.log(`Application is running on: http://0.0.0.0:${port}`);
}

bootstrap();
