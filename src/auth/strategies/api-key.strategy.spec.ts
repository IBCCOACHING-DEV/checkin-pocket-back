import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyStrategy } from './api-key.strategy';

describe('ApiKeyStrategy', () => {
  beforeAll(() => {
    process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
  });

  const build = (operator: unknown) =>
    new ApiKeyStrategy({ operator: { findUnique: jest.fn(async () => operator) } } as never);

  it('usa status e course_type ATUAIS do cache de operadores, não os do JWT', async () => {
    const strategy = build({ id: 5, email: 'eventos@ibccoaching.com.br', status: 2, courseType: 2 });

    const user = await strategy.validate({ sub: 5, username: 'antigo@x.com' });

    expect(user).toEqual(expect.objectContaining({ userId: 5, username: 'eventos@ibccoaching.com.br', status: 2, courseType: 2 }));
  });

  it('recusa token de operador que não existe mais no cache desta estação', async () => {
    await expect(build(null).validate({ sub: 99 })).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
