import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { PgService } from '../pg/pg.service';
import type { JwtUser } from '../auth/auth.service';

export type DbFilter = { type: 'eq' | 'neq' | 'in'; col: string; val: unknown };
export type DbOrder = { col: string; asc: boolean };

export interface DbQueryPayload {
  table: string;
  op: 'select' | 'update' | 'delete';
  columns?: string;
  filters?: DbFilter[];
  orders?: DbOrder[];
  limit?: number | null;
  patch?: Record<string, unknown>;
  single?: 'single' | 'maybe' | null;
}

const TABLES = new Set([
  'branches',
  'companies',
  'user_profiles',
  'user_company_memberships',
  'global_blocked_dates',
  'branch_allowed_weekdays',
  'branch_blocked_dates',
  'reservations',
  'site_popups',
]);

function assertIdent(s: string, label: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
    throw new BadRequestException(`invalid ${label}`);
  }
}

@Injectable()
export class DbQueryService {
  constructor(private readonly pg: PgService) {}

  requiresAuth(body: DbQueryPayload): boolean {
    return body.table === 'user_profiles' || body.table === 'user_company_memberships';
  }

  private enforceRowUser(
    user: JwtUser | null,
    table: string,
    filters: DbFilter[] | undefined,
  ) {
    if (!user?.sub) {
      throw new ForbiddenException();
    }
    const uid = user.sub;
    if (table === 'user_profiles') {
      const f = filters?.find((x) => x.type === 'eq' && x.col === 'id');
      if (!f || String(f.val) !== uid) {
        throw new ForbiddenException();
      }
    }
  }

  private normalizeFilters(
    table: string,
    filters: DbFilter[] | undefined,
    user: JwtUser | null,
  ): DbFilter[] {
    const f = [...(filters || [])];
    if (table === 'user_company_memberships' && user?.sub) {
      const uid = user.sub;
      const has = f.find((x) => x.type === 'eq' && x.col === 'user_id');
      if (!has) {
        f.push({ type: 'eq', col: 'user_id', val: uid });
      } else if (String(has.val) !== uid) {
        throw new ForbiddenException();
      }
    }
    return f;
  }

  async execute(body: DbQueryPayload, user: JwtUser | null) {
    const table = body.table;
    if (!TABLES.has(table)) {
      throw new BadRequestException('unsupported table');
    }
    if (this.requiresAuth(body)) {
      if (!user?.sub) {
        throw new ForbiddenException();
      }
      this.enforceRowUser(user, table, body.filters);
    }

    if (body.op === 'update') {
      return this.runUpdate(table, body, user);
    }
    if (body.op === 'delete') {
      throw new BadRequestException('delete not supported');
    }
    const merged = { ...body, filters: this.normalizeFilters(table, body.filters, user) };
    return this.runSelect(table, merged, user);
  }

  private async runUpdate(table: string, body: DbQueryPayload, _user: JwtUser | null) {
    if (table !== 'reservations') {
      throw new BadRequestException('update only for reservations');
    }
    const patch = body.patch || {};
    const keys = Object.keys(patch);
    if (keys.length !== 1 || keys[0] !== 'status') {
      throw new BadRequestException('only status update supported');
    }
    const vals: unknown[] = [];
    let p = 1;
    const whereParts: string[] = [];
    for (const f of body.filters || []) {
      assertIdent(f.col, 'filter col');
      if (f.type === 'eq') {
        whereParts.push(`"${f.col}" = $${p++}`);
        vals.push(f.val);
      } else {
        throw new BadRequestException('update filters: only eq');
      }
    }
    if (!whereParts.length) {
      throw new BadRequestException('update requires filters');
    }
    const status = String(patch.status ?? '');
    vals.push(status);
    const sql = `update public.reservations set status = $${p} where ${whereParts.join(' and ')} returning id, status`;
    const r = await this.pg.pool.query(sql, vals);
    let data: unknown = r.rows;
    if (body.single === 'single' || body.single === 'maybe') {
      data = r.rows[0] ?? null;
    }
    return { data };
  }

  private async runSelect(table: string, body: DbQueryPayload, _user: JwtUser | null) {
    const filters = body.filters || [];
    const orders = body.orders || [];
    const limit = body.limit != null ? Number(body.limit) : null;
    const sel = (body.columns || '*').trim();

    const special = this.trySpecialSelect(table, sel, filters, orders, limit, body.single);
    if (special) {
      const r = await this.pg.pool.query(special.sql, special.params);
      return this.shapeResult(r.rows, body.single);
    }

    for (const f of filters) {
      assertIdent(f.col, 'filter col');
    }
    for (const o of orders) {
      assertIdent(o.col, 'order col');
    }
    if (sel !== '*' && !/^[a-zA-Z0-9_,\s]+$/.test(sel)) {
      throw new BadRequestException('invalid select');
    }

    const vals: unknown[] = [];
    let p = 1;
    const where: string[] = [];
    for (const f of filters) {
      if (f.type === 'eq') {
        where.push(`"${f.col}" = $${p++}`);
        vals.push(f.val);
      } else if (f.type === 'neq') {
        where.push(`"${f.col}" <> $${p++}`);
        vals.push(f.val);
      } else if (f.type === 'in') {
        const arr = Array.isArray(f.val) ? f.val : [];
        if (!arr.length) {
          where.push('false');
        } else {
          where.push(`"${f.col}" = any($${p++}::bigint[])`);
          vals.push(arr.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
        }
      }
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const ordParts = orders.map((o) => `"${o.col}" ${o.asc ? 'asc' : 'desc'}`);
    const ordSql = ordParts.length ? `order by ${ordParts.join(', ')}` : '';
    const limSql = limit != null && Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : '';
    const sql = `select ${sel} from public."${table}" ${whereSql} ${ordSql} ${limSql}`.trim();
    const r = await this.pg.pool.query(sql, vals);
    return this.shapeResult(r.rows, body.single);
  }

  private shapeResult(rows: unknown[], single: string | null | undefined) {
    if (single === 'maybe') {
      return { data: rows[0] ?? null };
    }
    if (single === 'single') {
      if (rows.length > 1) {
        throw new BadRequestException('multiple rows');
      }
      return { data: rows[0] ?? null };
    }
    return { data: rows };
  }

  private trySpecialSelect(
    table: string,
    sel: string,
    filters: DbFilter[],
    orders: DbOrder[],
    limit: number | null,
    single: string | null | undefined,
  ): { sql: string; params: unknown[] } | null {
    const norm = sel.replace(/\s/g, '');

    if (
      table === 'reservations' &&
      norm.includes('branches(name)') &&
      norm.includes('companies(name)')
    ) {
      return this.sqlReservationsCalendar(filters, orders, limit);
    }
    if (table === 'companies' && norm.includes('branches(name)')) {
      return this.sqlCompaniesRegistry(filters, orders, limit);
    }
    if (table === 'user_company_memberships' && norm === 'companies(name)') {
      return this.sqlMembershipCompanyName(filters, orders, limit);
    }
    if (
      table === 'user_company_memberships' &&
      norm.includes('company_id,companies(id,name,branch_id,sort_order)')
    ) {
      return this.sqlMembershipCompaniesFull(filters, orders, limit);
    }
    if (table === 'branch_blocked_dates' && norm.includes('branches(name)')) {
      return this.sqlBranchBlockedWithBranch(filters, orders, limit);
    }
    return null;
  }

  private buildWhere(
    alias: string,
    filters: DbFilter[],
    startParam: number,
  ): { sql: string; params: unknown[]; next: number } {
    const vals: unknown[] = [];
    let p = startParam;
    const parts: string[] = [];
    for (const f of filters) {
      assertIdent(f.col, 'filter col');
      const col = `${alias}."${f.col}"`;
      if (f.type === 'eq') {
        parts.push(`${col} = $${p++}`);
        vals.push(f.val);
      } else if (f.type === 'neq') {
        parts.push(`${col} <> $${p++}`);
        vals.push(f.val);
      } else if (f.type === 'in') {
        const arr = Array.isArray(f.val) ? f.val : [];
        if (!arr.length) {
          parts.push('false');
        } else {
          parts.push(`${col} = any($${p++}::bigint[])`);
          vals.push(arr.map((x) => Number(x)).filter((n) => Number.isFinite(n)));
        }
      }
    }
    const sql = parts.length ? `where ${parts.join(' and ')}` : '';
    return { sql, params: vals, next: p };
  }

  private orderSql(alias: string, orders: DbOrder[]) {
    if (!orders.length) {
      return '';
    }
    const bits = orders.map((o) => {
      assertIdent(o.col, 'order');
      return `${alias}."${o.col}" ${o.asc ? 'asc' : 'desc'}`;
    });
    return `order by ${bits.join(', ')}`;
  }

  private sqlReservationsCalendar(filters: DbFilter[], orders: DbOrder[], limit: number | null) {
    const w = this.buildWhere('r', filters, 1);
    const ord = this.orderSql('r', orders);
    const lim =
      limit != null && Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : '';
    const sql = `
      select r.id, r.reservation_date, r.reservation_time, r.company_name, r.branch_id, r.company_id,
        r.car_number_1, r.car_number_2, r.material_info, r.vehicle_count, r.contact, r.visitor_email,
        r.person_info, r.vehicle_tonnage, r.vehicle_tonnage_2, r.reservation_duration_minutes, r.duration_mode,
        r.doc_url_1, r.doc_url_2, r.doc_url_3, r.status, r.status_notification_sent,
        json_build_object('name', b.name) as branches,
        json_build_object('name', c.name) as companies
      from public.reservations r
      left join public.branches b on b.id = r.branch_id
      left join public.companies c on c.id = r.company_id
      ${w.sql}
      ${ord}
      ${lim}
    `.trim();
    return { sql, params: w.params };
  }

  private sqlCompaniesRegistry(filters: DbFilter[], orders: DbOrder[], limit: number | null) {
    const w = this.buildWhere('c', filters, 1);
    const ord =
      orders.length > 0
        ? this.orderSql('c', orders)
        : 'order by c.branch_id asc, c.sort_order asc, c.name asc';
    const lim =
      limit != null && Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : 'limit 5000';
    const sql = `
      select c.id, c.branch_id, c.name, c.business_registration_no, c.representative_name, c.address,
        c.is_active, c.sort_order,
        json_build_object('name', b.name) as branches
      from public.companies c
      left join public.branches b on b.id = c.branch_id
      ${w.sql}
      ${ord}
      ${lim}
    `.trim();
    return { sql, params: w.params };
  }

  private sqlMembershipCompanyName(filters: DbFilter[], orders: DbOrder[], limit: number | null) {
    const w = this.buildWhere('m', filters, 1);
    const ord = this.orderSql('m', orders);
    const lim =
      limit != null && Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : '';
    const sql = `
      select m.user_id, json_build_object('name', c.name) as companies
      from public.user_company_memberships m
      inner join public.companies c on c.id = m.company_id
      ${w.sql}
      ${ord}
      ${lim}
    `.trim();
    return { sql, params: w.params };
  }

  private sqlMembershipCompaniesFull(filters: DbFilter[], orders: DbOrder[], limit: number | null) {
    const w = this.buildWhere('m', filters, 1);
    const ord = this.orderSql('m', orders);
    const lim =
      limit != null && Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : '';
    const sql = `
      select m.company_id,
        json_build_object(
          'id', c.id,
          'name', c.name,
          'branch_id', c.branch_id,
          'sort_order', c.sort_order
        ) as companies
      from public.user_company_memberships m
      inner join public.companies c on c.id = m.company_id
      ${w.sql}
      ${ord}
      ${lim}
    `.trim();
    return { sql, params: w.params };
  }

  private sqlBranchBlockedWithBranch(filters: DbFilter[], orders: DbOrder[], limit: number | null) {
    const w = this.buildWhere('d', filters, 1);
    const ord = orders.length ? this.orderSql('d', orders) : 'order by d.blocked_date asc';
    const lim =
      limit != null && Number.isFinite(limit) ? `limit ${Math.floor(limit)}` : '';
    const sql = `
      select d.id, d.branch_id, d.blocked_date, d.reason,
        json_build_object('name', b.name) as branches
      from public.branch_blocked_dates d
      inner join public.branches b on b.id = d.branch_id
      ${w.sql}
      ${ord}
      ${lim}
    `.trim();
    return { sql, params: w.params };
  }
}
