import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { DbQueryService, DbQueryPayload } from './db-query.service';
import { AuthService } from '../auth/auth.service';

@Controller('db')
export class DbQueryController {
  constructor(
    private readonly db: DbQueryService,
    private readonly auth: AuthService,
  ) {}

  @Post('query')
  async query(
    @Headers('authorization') authz: string | undefined,
    @Body() body: DbQueryPayload,
  ) {
    const tok = authz?.replace(/^Bearer\s+/i, '').trim();
    const user = tok ? this.auth.verifyAccessToken(tok) : null;
    if (this.db.requiresAuth(body) && !user?.sub) {
      throw new UnauthorizedException('로그인이 필요합니다.');
    }
    return this.db.execute(body, user);
  }
}
