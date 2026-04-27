import { BadRequestException, Injectable } from '@nestjs/common';
import { PgService } from '../pg/pg.service';
import type { JwtUser } from '../auth/auth.service';

const ALLOW = new Set([
  'lookup_companies_by_brn',
  'signup_brn_is_available',
  'get_my_company_names_for_header',
]);

@Injectable()
export class RpcService {
  constructor(private readonly pg: PgService) {}

  async call(fn: string, body: Record<string, unknown>, user: JwtUser | null) {
    if (!ALLOW.has(fn)) {
      throw new BadRequestException('unsupported rpc');
    }
    if (fn === 'lookup_companies_by_brn') {
      const brn = String(body.p_brn ?? '');
      const r = await this.pg.pool.query(
        `select * from public.lookup_companies_by_brn($1)`,
        [brn],
      );
      return { data: r.rows };
    }
    if (fn === 'signup_brn_is_available') {
      const brn = String(body.p_brn ?? '');
      const r = await this.pg.pool.query(
        `select public.signup_brn_is_available($1) as v`,
        [brn],
      );
      return { data: r.rows[0]?.v ?? null };
    }
    if (fn === 'get_my_company_names_for_header') {
      const r = await this.pg.pool.query(
        `
        select coalesce(array_agg(t.n order by t.n), '{}'::text[]) as v
        from (
          select distinct trim(c.name) as n
          from public.user_company_memberships m
          inner join public.companies c on c.id = m.company_id
          where m.user_id = $1::uuid
            and coalesce(c.is_active, true)
            and trim(coalesce(c.name, '')) <> ''
        ) t
        `,
        [user!.sub],
      );
      return { data: r.rows[0]?.v ?? [] };
    }
    throw new BadRequestException();
  }
}
