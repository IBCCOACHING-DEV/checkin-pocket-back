import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { OutboxModule } from '../outbox/outbox.module';
import { StudentRegistrationController } from './student-registration.controller';
import { StudentRegistrationService } from './student-registration.service';
import { StudentCreateSyncConsumer } from './student-create-sync.consumer';

@Module({
  imports: [StudentsModule, OutboxModule],
  controllers: [StudentRegistrationController],
  providers: [StudentRegistrationService, StudentCreateSyncConsumer],
})
export class StudentRegistrationModule {}
