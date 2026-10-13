import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { LocalPrismaService } from '../../database/local-prisma.service';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: LocalPrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET,
    });
  }

  /**
   * Recarrega o operador do cache local a cada requisição para que mudanças de
   * perfil no Checkin Pai (papel / tipo de turma), já sincronizadas para esta
   * estação, valham imediatamente — sem esperar o JWT (até 24h) expirar.
   */
  async validate(payload: { sub: number; eventId?: string; username?: string }) {
    const operator = await this.prisma.operator.findUnique({ where: { id: payload.sub } });
    if (!operator) {
      throw new UnauthorizedException('Operador não encontrado nesta estação. Faça login novamente.');
    }

    return {
      userId: operator.id,
      eventId: payload.eventId,
      username: operator.email,
      status: operator.status,
      courseType: operator.courseType,
    };
  }
}
