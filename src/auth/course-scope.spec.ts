import { isCourseAllowed, resolveCourseScope, studentScopeWhere } from './course-scope';

// status do Pai: manager=0, admin=1, staff=2, user=3 — course_type: full=0, formation=1, event=2
describe('resolveCourseScope (espelha CoursePolicy::Scope do Checkin Pai)', () => {
  it.each([
    ['manager', 0],
    ['admin', 1],
  ])('%s enxerga tudo, mesmo com course_type restrito', (_name, status) => {
    expect(resolveCourseScope({ status, courseType: 2 })).toEqual({ eventType: null });
    expect(resolveCourseScope({ status, courseType: 1 })).toEqual({ eventType: null });
  });

  it.each([
    ['staff', 2],
    ['user', 3],
  ])('%s com course_type full enxerga tudo', (_name, status) => {
    expect(resolveCourseScope({ status, courseType: 0 })).toEqual({ eventType: null });
  });

  it.each([
    ['staff', 2],
    ['user', 3],
  ])('%s com course_type event enxerga só eventos', (_name, status) => {
    expect(resolveCourseScope({ status, courseType: 2 })).toEqual({ eventType: 'event' });
  });

  it.each([
    ['staff', 2],
    ['user', 3],
  ])('%s com course_type formation enxerga só formações', (_name, status) => {
    expect(resolveCourseScope({ status, courseType: 1 })).toEqual({ eventType: 'formation' });
  });
});

describe('isCourseAllowed', () => {
  it('sem escopo ou escopo irrestrito permite qualquer tipo, inclusive desconhecido', () => {
    expect(isCourseAllowed(undefined, 'formation')).toBe(true);
    expect(isCourseAllowed({ eventType: null }, 'event')).toBe(true);
    expect(isCourseAllowed({ eventType: null }, null)).toBe(true);
  });

  it('escopo de eventos permite só eventos', () => {
    expect(isCourseAllowed({ eventType: 'event' }, 'event')).toBe(true);
    expect(isCourseAllowed({ eventType: 'event' }, 'formation')).toBe(false);
  });

  it('tipo desconhecido é negado para operador restrito (padrão seguro)', () => {
    expect(isCourseAllowed({ eventType: 'event' }, null)).toBe(false);
    expect(isCourseAllowed({ eventType: 'event' }, undefined)).toBe(false);
  });
});

describe('studentScopeWhere', () => {
  it('só filtra quando há restrição', () => {
    expect(studentScopeWhere(undefined)).toEqual({});
    expect(studentScopeWhere({ eventType: null })).toEqual({});
    expect(studentScopeWhere({ eventType: 'event' })).toEqual({ courseEventType: 'event' });
  });
});
