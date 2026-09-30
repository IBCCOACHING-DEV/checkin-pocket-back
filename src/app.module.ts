import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { AuthModule } from './auth/auth.module';
import { PrintModule } from './print/print.module';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { MessagingModule } from './messaging/messaging.module';
import { StudentsModule } from './students/students.module';
import { LocalPrintModule } from './local-print/local-print.module';
import { OutboxModule } from './outbox/outbox.module';
import { CheckinModule } from './checkin/checkin.module';
import { AuthSyncModule } from './auth-sync/auth-sync.module';
import { PaiSyncModule } from './pai-sync/pai-sync.module';
import { TicketTransferModule } from './ticket-transfer/ticket-transfer.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      load: [configuration],
      isGlobal: true,
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      exclude: ['/api/(.*)'],
      serveStaticOptions: {
        fallthrough: true,
      },
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    MessagingModule,
    AuthModule,
    PrintModule,
    StudentsModule,
    LocalPrintModule,
    OutboxModule,
    CheckinModule,
    AuthSyncModule,
    PaiSyncModule,
    TicketTransferModule,
  ],
})
export class AppModule {}
