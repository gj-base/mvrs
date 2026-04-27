import { Controller, Headers, Param, Post, UnauthorizedException, Body } from '@nestjs/common';
import { RpcService } from './rpc.service';
import { AuthService } from '../auth/auth.service';

@Controller('rpc')
export class RpcController {
  constructor(
    private readonly rpc: RpcService,
    private readonly auth: AuthService,
  ) {}

  @Post(':fn')
  async call(
    @Param('fn') fn: string,
    @Body() body: Record<string, unknown>,
    @Headers('authorization') authz?: string,
  ) {
    const tok = authz?.replace(/^Bearer\s+/i, '').trim();
    const user = tok ? this.auth.verifyAccessToken(tok) : null;
    if (fn === 'get_my_company_names_for_header' && !user?.sub) {
      throw new UnauthorizedException();
    }
    return this.rpc.call(fn, body, user);
  }
}
