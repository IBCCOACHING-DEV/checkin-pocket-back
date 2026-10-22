import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
// import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe, Logger } from '@nestjs/common';

// Rede de segurança: uma Promise rejeitada sem tratamento em algum fluxo de
// fundo (RabbitMQ, workers) não pode encerrar o backend no meio do
// credenciamento — o padrão do Node (>=15) é derrubar o processo.
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  new Logger('Process').error(`Promise rejeitada sem tratamento: ${message}`);
});

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // const configService = app.get(ConfigService);

  const swaggerConfig = new DocumentBuilder()
    .setTitle('IBCPrinter API')
    .setDescription('API documentation for IBCPrinter application')
    .setVersion('1.0')
    .addServer('v1', 'Version 1')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  logger.log(`🚀 IBCPrinter rodando em: http://localhost:${port}`);
  logger.log(`📚 Documentação Swagger: http://localhost:${port}/api/docs`);
}
bootstrap();
