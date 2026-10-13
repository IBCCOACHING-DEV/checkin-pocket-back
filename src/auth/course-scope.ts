/**
 * Escopo de turmas de um operador — espelha `CoursePolicy::Scope` do Checkin
 * Pai (app/policies/course_policy.rb):
 *
 *  - admin e manager enxergam TODAS as turmas;
 *  - staff e user com `course_type = full` enxergam todas;
 *  - staff e user com `course_type = event` / `formation` enxergam só as
 *    turmas cujo `event_type` seja igual ao seu `course_type`.
 */
export type CourseEventType = 'event' | 'formation';

export interface CourseScope {
  /** null = sem restrição (enxerga qualquer tipo de turma). */
  eventType: CourseEventType | null;
}

/** Enum `status` do Checkin Pai: manager=0, admin=1, staff=2, user=3. */
const OPERATOR_STATUS_MANAGER = 0;
const OPERATOR_STATUS_ADMIN = 1;

/** Enum `course_type` do Checkin Pai: full=0, formation=1, event=2. */
const COURSE_TYPE_FORMATION = 1;
const COURSE_TYPE_EVENT = 2;

export const UNRESTRICTED_COURSE_SCOPE: CourseScope = { eventType: null };

export function resolveCourseScope(operator: { status: number; courseType: number }): CourseScope {
  if (operator.status === OPERATOR_STATUS_ADMIN || operator.status === OPERATOR_STATUS_MANAGER) {
    return UNRESTRICTED_COURSE_SCOPE;
  }
  if (operator.courseType === COURSE_TYPE_EVENT) {
    return { eventType: 'event' };
  }
  if (operator.courseType === COURSE_TYPE_FORMATION) {
    return { eventType: 'formation' };
  }
  return UNRESTRICTED_COURSE_SCOPE;
}

/**
 * Uma turma é permitida se o escopo for irrestrito ou se o tipo da turma for
 * IGUAL ao do escopo. Tipo desconhecido (nulo) é negado para operador
 * restrito — o padrão seguro; o próximo download da turma preenche o tipo.
 */
export function isCourseAllowed(
  scope: CourseScope | undefined,
  courseEventType: string | null | undefined,
): boolean {
  if (!scope || scope.eventType === null) {
    return true;
  }
  return courseEventType === scope.eventType;
}

/** Filtro Prisma para o campo `courseEventType` do Student local. */
export function studentScopeWhere(scope: CourseScope | undefined): { courseEventType?: string } {
  return scope && scope.eventType ? { courseEventType: scope.eventType } : {};
}
