import { Module } from '@nestjs/common';
import { PaiSyncController } from './pai-sync.controller';
import { PaiSyncService } from './pai-sync.service';
import { StudentsModule } from '../students/students.module';

/**
 * Sincronização sob demanda de Courses/Students a partir do banco do
 * Checkin Pai (ver PaiSyncService) — alimenta a tela "Baixar turma" do
 * front-end.
 */
@Module({
  imports: [StudentsModule],
  controllers: [PaiSyncController],
  providers: [PaiSyncService],
  // Usado pelo AuthController: o "Sincronizar agora" do login também baixa as turmas ativas.
  exports: [PaiSyncService],
})
export class PaiSyncModule {}
