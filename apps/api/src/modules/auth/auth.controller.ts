import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuthService, type SignedIn } from './auth.service.js';
import { ACCESS_COOKIE, Public, REFRESH_COOKIE, requireIdentity } from './auth.guard.js';

const requestSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/, 'A code is six digits.'),
});
const switchSchema = z.object({ councilId: z.string().uuid() });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('code')
  async requestCode(@Req() req: FastifyRequest, @Body() body: unknown) {
    const { email } = requestSchema.parse(body);
    await this.auth.requestCode(email, { ip: clientIp(req) });
    // Always the same answer. Anything else enumerates the council's officers.
    return { sent: true };
  }

  @Public()
  @Post('verify')
  async verify(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const { email, code } = verifySchema.parse(body);
    const signedIn = await this.auth.verifyCode(email, code, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    setSessionCookies(reply, signedIn);
    return publicShape(signedIn);
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const token = cookie(req, REFRESH_COOKIE);
    if (!token) {
      // Not an error worth logging: an anonymous visitor's browser tries this once.
      return { signedIn: false };
    }
    const rotated = await this.auth.refresh(token, {
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] ?? null,
    });
    setSessionCookies(reply, rotated);
    return publicShape(rotated);
  }

  @Get('me')
  async me(@Req() req: FastifyRequest) {
    const identity = requireIdentity(req);
    return {
      user: { id: identity.userId, email: identity.email, name: identity.name },
      council: { councilId: identity.councilId, role: identity.role },
    };
  }

  @Post('council')
  async switchCouncil(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const identity = requireIdentity(req);
    const { councilId } = switchSchema.parse(body);
    const result = await this.auth.switchCouncil(identity.userId, identity.sessionId, councilId);
    // The refresh token is untouched: switching council re-mints the access token, it
    // does not open a new session.
    reply.setCookie(ACCESS_COOKIE, result.accessToken, accessCookieOptions(result.expiresIn));
    return { council: result.council };
  }

  @Public()
  @Post('signout')
  async signOut(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.signOut(cookie(req, REFRESH_COOKIE));
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
    return { signedOut: true };
  }
}

function publicShape(s: SignedIn) {
  // The tokens themselves stay in HttpOnly cookies. Returning them in the body as well
  // would put them within reach of any script on the page, which is the thing HttpOnly
  // exists to prevent.
  return { user: s.user, council: s.council, memberships: s.memberships, signedIn: true };
}

function clientIp(req: FastifyRequest): string | null {
  return req.ip ?? null;
}

function cookie(req: FastifyRequest, name: string): string | undefined {
  return (req as FastifyRequest & { cookies?: Record<string, string> }).cookies?.[name];
}

function accessCookieOptions(expiresIn: number) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: the officer following a link from the digest email should land
    // signed in. Lax still blocks the cross-site POSTs that matter.
    sameSite: 'lax' as const,
    path: '/',
    maxAge: expiresIn,
  };
}

function setSessionCookies(reply: FastifyReply, signedIn: SignedIn): void {
  reply.setCookie(ACCESS_COOKIE, signedIn.accessToken, accessCookieOptions(signedIn.expiresIn));
  reply.setCookie(REFRESH_COOKIE, signedIn.refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    // Scoped to the auth routes: the refresh token is not sent on every ordinary request,
    // so the surface where it could leak is one endpoint rather than all of them.
    path: '/v1/auth',
    maxAge: 30 * 24 * 60 * 60,
  });
}
