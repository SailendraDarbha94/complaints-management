import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
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

  app.enableCors({
    origin: process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });
  app.setGlobalPrefix('v1');

  if (!isProduction()) {
    // Said out loud, every boot, so nobody discovers it in production by surprise.
    log.warn(
      'Development identity headers are ENABLED (x-dev-council-id, x-dev-user-id). ' +
        'They are refused when NODE_ENV=production.',
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
