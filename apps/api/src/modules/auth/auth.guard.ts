import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { TokenService } from './token.service.js';
import type { RequestIdentity } from '../../context/council-context.js';

/**
 * The guard. Every route is authenticated unless it opts out with @Public().
 *
 * Defaulting to closed matters more than usual here: an endpoint added in six months and
 * forgotten about should be unreachable, not open. On a legal register the cost of
 * forgetting is not a bug report, it is a disclosure.
 */

export const IS_PUBLIC = 'ksdc:public';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ACCESS_COOKIE = 'ksdc_at';
export const REFRESH_COOKIE = 'ksdc_rt';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: RequestIdentity;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Not signed in.');

    try {
      const claims = await this.tokens.verifyAccessToken(token);
      req.identity = {
        councilId: claims.councilId,
        userId: claims.sub,
        role: claims.role,
        sessionId: claims.sid,
        email: claims.email,
        name: claims.name,
      };
      return true;
    } catch {
      // Never distinguish expired from forged from malformed. The client's answer is the
      // same in all three cases: refresh, then sign in.
      throw new UnauthorizedException('Session expired.');
    }
  }
}

/**
 * The cookie is the browser's path; the Authorization header is for the mobile app and
 * for curl. Both carry the same token.
 */
export function extractToken(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim() || null;

  const cookies = (req as FastifyRequest & { cookies?: Record<string, string> }).cookies;
  return cookies?.[ACCESS_COOKIE] ?? null;
}

export function requireIdentity(req: FastifyRequest): RequestIdentity {
  if (!req.identity) throw new UnauthorizedException('Not signed in.');
  return req.identity;
}
