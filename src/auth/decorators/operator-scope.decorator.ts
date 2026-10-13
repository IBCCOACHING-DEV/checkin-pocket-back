import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { CourseScope, resolveCourseScope, UNRESTRICTED_COURSE_SCOPE } from '../course-scope';

/**
 * Injeta o `CourseScope` do operador autenticado (ver ApiKeyStrategy, que
 * carrega status/courseType ATUAIS do cache local de operadores a cada
 * requisição — não os do JWT, que pode ter até 24h).
 */
export const OperatorScope = createParamDecorator((_data: unknown, context: ExecutionContext): CourseScope => {
  const request = context.switchToHttp().getRequest<{ user?: { status?: number; courseType?: number } }>();
  const user = request.user;
  if (!user || typeof user.status !== 'number' || typeof user.courseType !== 'number') {
    // Rota sem guard (ex.: testes): sem operador não há o que restringir.
    return UNRESTRICTED_COURSE_SCOPE;
  }
  return resolveCourseScope({ status: user.status, courseType: user.courseType });
});
