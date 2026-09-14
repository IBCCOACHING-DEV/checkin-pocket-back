import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { RemotePaiPrismaService } from '../database/remote-prisma.service';
import { StudentsService } from '../students/students.service';
import { StudentReplicaDto } from '../students/dto/upsert-students.dto';
import { PaiCourseSummary } from './interfaces/pai-course.interface';
import { CourseSyncResult } from './interfaces/course-sync-result.interface';

/**
 * Sincronização SOB DEMANDA de Courses/Students a partir do banco do
 * Checkin Pai (leitura direta — ver RemotePaiPrismaService).
 *
 * Requisito do usuário: o Pocket NUNCA copia a base inteira do Pai. Ele
 * lista os Courses ativos (mesmo critério do próprio Checkin Pai, ver
 * CheckinsController#index: `Course.where(status: true)`) e só baixa os
 * Students de UM Course quando o operador clicar em "sincronizar" na tela
 * "Baixar turma".
 */
@Injectable()
export class PaiSyncService {
  private readonly logger = new Logger(PaiSyncService.name);

  constructor(
    private readonly remotePrisma: RemotePaiPrismaService,
    private readonly studentsService: StudentsService,
  ) {}

  async listActiveCourses(): Promise<PaiCourseSummary[]> {
    const courses = await this.queryPai(() =>
      this.remotePrisma.client.course.findMany({
        where: { status: true },
        orderBy: [{ eventDate: 'asc' }, { name: 'asc' }],
        include: { _count: { select: { students: true } } },
      }),
    );

    return courses.map((course) => ({
      id: course.id,
      name: course.name ?? `Turma #${course.id}`,
      eventDate: course.eventDate,
      eventHour: course.eventHour,
      eventDateEnd: course.eventDateEnd,
      eventType: course.eventType,
      eventPlace: course.eventPlace,
      studentsCount: course._count.students,
    }));
  }

  async syncCourse(courseId: number): Promise<CourseSyncResult> {
    const course = await this.queryPai(() =>
      this.remotePrisma.client.course.findUnique({ where: { id: courseId } }),
    );

    if (!course) {
      throw new NotFoundException(`Course ${courseId} não encontrado no Checkin Pai.`);
    }

    const students = await this.queryPai(() =>
      this.remotePrisma.client.student.findMany({ where: { courseId } }),
    );

    const courseName = course.name ?? `Turma #${course.id}`;
    const replicas: StudentReplicaDto[] = [];
    let skipped = 0;

    for (const student of students) {
      if (!student.name || !student.token) {
        // Sem nome ou sem token não dá para localizar o aluno pelo QR Code
        // no check-in — não faz sentido replicar localmente.
        skipped += 1;
        continue;
      }

      const replica = new StudentReplicaDto();
      replica.id = student.id;
      replica.courseId = courseId;
      replica.courseName = courseName;
      replica.name = student.name;
      replica.token = student.token;
      replica.email = student.email ?? undefined;
      replica.document = student.document ?? undefined;
      replica.ibcCustomerId = student.ibcCustomerId ?? undefined;
      replica.courseEventDate = course.eventDate ?? undefined;
      replica.courseEventDateEnd = course.eventDateEnd ?? undefined;
      replicas.push(replica);
    }

    const synced = replicas.length > 0 ? await this.studentsService.upsertMany(replicas) : 0;

    this.logger.log(
      `Turma "${courseName}" (id=${courseId}) sincronizada: ${synced} aluno(s), ${skipped} ignorado(s) (sem nome/token).`,
    );

    return {
      courseId,
      courseName,
      totalStudents: students.length,
      synced,
      skipped,
    };
  }
  async syncAllKnownCourses(): Promise<CourseSyncResult[]> {
    const localCourses = await this.studentsService.listSyncedCourses();
    if (localCourses.length === 0) {
      return [];
    }

    const reachable = await this.remotePrisma.ping();
    if (!reachable) {
      throw new ServiceUnavailableException(
        'Não foi possível conectar ao banco do Checkin Pai agora. As turmas já baixadas continuam disponíveis normalmente.',
      );
    }

    const results: CourseSyncResult[] = [];
    for (const course of localCourses) {
      try {
        results.push(await this.syncCourse(course.courseId));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Falha ao re-sincronizar turma ${course.courseId} (${course.courseName}): ${message}`,
        );
      }
    }

    return results;
  }
  private async queryPai<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Falha ao consultar o banco do Checkin Pai: ${message}`);
      throw new ServiceUnavailableException(
        'Não foi possível conectar ao banco do Checkin Pai agora. Verifique a rede — os dados já baixados nesta estação continuam disponíveis normalmente.',
      );
    }
  }
}
