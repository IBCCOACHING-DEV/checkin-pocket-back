import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { OutboxModule } from '../outbox/outbox.module';
import { TicketTransferController } from './ticket-transfer.controller';
import { TicketTransferService } from './ticket-transfer.service';
import { TicketTransferSyncConsumer } from './ticket-transfer-sync.consumer';

@Module({
  imports: [StudentsModule, OutboxModule],
  controllers: [TicketTransferController],
  providers: [TicketTransferService, TicketTransferSyncConsumer],
})
export class TicketTransferModule {}
