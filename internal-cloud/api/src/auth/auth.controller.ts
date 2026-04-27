import { Body, Controller, Get, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('sign-in')
  async signIn(@Body() body: { email?: string; password?: string }) {
    return this.auth.signIn(body.email ?? '', body.password ?? '');
  }

  @Post('sign-up')
  async signUp(
    @Body()
    body: {
      email?: string;
      password?: string;
      data?: Record<string, unknown>;
    },
  ) {
    return this.auth.signUp(body.email ?? '', body.password ?? '', body.data ?? {});
  }

  @Get('session')
  async session(@Headers('authorization') authz?: string) {
    const tok = authz?.replace(/^Bearer\s+/i, '').trim();
    if (!tok) {
      throw new UnauthorizedException();
    }
    const user = this.auth.verifyAccessToken(tok);
    if (!user) {
      throw new UnauthorizedException();
    }
    return { user };
  }
}
