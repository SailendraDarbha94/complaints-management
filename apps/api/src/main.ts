import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { Logger } from '@nestjs/common';
import { initDb } from '@ksdc/db';
import { AppModule } from './app.module.js';
import { isProduction } from './context/council-context.js';

async function bootstrap(): Promise<void> {
  const log = new Logger('bootstrap');

  initDb({ ssl: isProduction() });

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true, genReqId: () => crypto.randomUUID() }),
  );

  // Session tokens live in HttpOnly cookies, so the browser never exposes them to script.
  await app.register(fastifyCookie as never);

  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    // The browser must be allowed to send the session cookie.
    credentials: true,
  });
  app.setGlobalPrefix('v1');
  // No global ValidationPipe: request bodies are validated with Zod schemas in the
  // controllers, which keeps the shape and its rules in one place and avoids pulling in
  // class-validator's decorator machinery for four endpoints.

  if (isProduction()) {
    for (const required of ['JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'DATABASE_URL']) {
      if (!process.env[required]) throw new Error(`${required} must be set in production`);
    }
    if (process.env.MAIL_TRANSPORT !== 'smtp') {
      // Otherwise sign-in codes go to a log file and nobody can get in.
      throw new Error('MAIL_TRANSPORT must be "smtp" in production');
    }
  } else {
    log.warn(
      'Development mode: sign-in codes are written to the log and var/mail/outbox.log ' +
        'instead of being emailed.',
    );
  }

  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ port, host: '0.0.0.0' });
  log.log(`API listening on ${port}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
