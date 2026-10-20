import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CourseScope, isCourseAllowed } from '../auth/course-scope';
import { RemotePaiPrismaService } from '../database/remote-prisma.service';
import { StudentsService } from '../students/students.service';
import { StudentReplicaDto } from '../students/dto/upsert-students.dto';
import { PaiCourseSummary } from './interfaces/pai-course.interface';
import { ActiveCoursesSyncSummary, CourseSyncResult } from './interfaces/course-sync-result.interface';

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

  /**
   * Lista as turmas ativas. Com `scope` restrito (operador staff/user com
   * `course_type` event ou formation), só as turmas do mesmo `event_type` —
   * mesma regra da CoursePolicy::Scope do Checkin Pai.
   */
  async listActiveCourses(scope?: CourseScope): Promise<PaiCourseSummary[]> {
    const courses = await this.queryPai(() =>
      this.remotePrisma.client.course.findMany({
        where: { status: true, ...(scope?.eventType ? { eventType: scope.eventType } : {}) },
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

  async syncCourse(courseId: number, scope?: CourseScope): Promise<CourseSyncResult> {
    const course = await this.queryPai(() =>
      this.remotePrisma.client.course.findUnique({ where: { id: courseId } }),
    );

    if (!course) {
      throw new NotFoundException(`Course ${courseId} não encontrado no Checkin Pai.`);
    }

    if (!isCourseAllowed(scope, course.eventType)) {
      throw new ForbiddenException('Esta turma está fora do seu perfil de acesso.');
    }

    const students = await this.queryPai(() =>
      this.remotePrisma.client.student.findMany({ where: { courseId } }),
    );

    const courseName = course.name ?? `Turma #${course.id}`;
    const courseCity = await this.remotePrisma.findEventCity(course.onlineReference);
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
      replica.courseEventType = course.eventType ?? undefined;
      replica.courseCity = courseCity ?? undefined;
      replica.labelPrinted = student.tagPrinter === true;
      replicas.push(replica);
    }

    // Mesmo com a lista vazia: se a turma foi esvaziada no Pai, a réplica
    // local também precisa ser esvaziada (senão sobram alunos "fantasma").
    const { synced, removed } = await this.studentsService.replaceCourse(courseId, replicas);

    this.logger.log(
      `Turma "${courseName}" (id=${courseId}) sincronizada: ${synced} aluno(s), ${removed} removido(s), ${skipped} ignorado(s) (sem nome/token).`,
    );

    return {
      courseId,
      courseName,
      totalStudents: students.length,
      synced,
      removed,
      skipped,
    };
  }

  /**
   * Baixa/atualiza TODAS as turmas ativas do Checkin Pai (não só as que a
   * estação já conhecia) — usado pelo "Sincronizar agora" da tela de login,
   * para que a estação já saia dali pronta para credenciar.
   *
   * Nunca lança: o login não pode falhar nem travar por causa da rede. Se o
   * Pai estiver inalcançável, o motivo volta em `error`; se uma turma
   * falhar, as demais continuam (falha isolada por turma, como em
   * `syncAllKnownCourses`).
   */
  async syncActiveCourses(): Promise<ActiveCoursesSyncSummary> {
    let activeCourses: PaiCourseSummary[];
    try {
      activeCourses = await this.listActiveCourses();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { total: 0, synced: 0, failed: 0, error: message };
    }

    let synced = 0;
    let failed = 0;
    for (const course of activeCourses) {
      try {
        await this.syncCourse(course.id);
        synced += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Falha ao baixar turma ativa ${course.id} (${course.name}): ${message}`);
      }
    }

    this.logger.log(
      `Turmas ativas baixadas: ${synced}/${activeCourses.length} (${failed} falha(s)).`,
    );
    return { total: activeCourses.length, synced, failed, error: null };
  }

  /**
   * Re-sincroniza as turmas que esta estação já baixou. Para operador
   * restrito, só as que estão no escopo dele — conferido no Pai (e não na
   * réplica), porque o tipo de turmas baixadas antes deste recurso ainda é
   * desconhecido localmente.
   */
  async syncAllKnownCourses(scope?: CourseScope): Promise<CourseSyncResult[]> {
    let localCourses = await this.studentsService.listSyncedCourses();
    if (localCourses.length === 0) {
      return [];
    }

    const reachable = await this.remotePrisma.ping();
    if (!reachable) {
      throw new ServiceUnavailableException(
        'Não foi possível conectar ao banco do Checkin Pai agora. As turmas já baixadas continuam disponíveis normalmente.',
      );
    }

    if (scope?.eventType) {
      const knownIds = localCourses.map((course) => course.courseId);
      const allowed = await this.queryPai(() =>
        this.remotePrisma.client.course.findMany({
          where: { id: { in: knownIds }, eventType: scope.eventType as string },
          select: { id: true },
        }),
      );
      const allowedIds = new Set(allowed.map((course) => course.id));
      localCourses = localCourses.filter((course) => allowedIds.has(course.courseId));
    }

    const results: CourseSyncResult[] = [];
    for (const course of localCourses) {
      try {
        results.push(await this.syncCourse(course.courseId, scope));
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
