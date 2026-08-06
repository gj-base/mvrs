import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { PgService } from '../pg/pg.service';

export type JwtUser = { sub: string; email?: string; role?: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly pg: PgService,
    private readonly config: ConfigService,
  ) {}

  private jwtSecret(): string {
    const s = this.config.get<string>('JWT_SECRET');
    if (!s) {
      throw new Error('JWT_SECRET is required');
    }
    return s;
  }

  private authInstanceId(): string {
    return (
      this.config.get<string>('AUTH_INSTANCE_ID') ??
      '00000000-0000-0000-0000-000000000000'
    );
  }

  verifyAccessToken(token: string): JwtUser | null {
    try {
      return jwt.verify(token, this.jwtSecret()) as JwtUser;
    } catch {
      return null;
    }
  }

  issueToken(userId: string, email: string): string {
    return jwt.sign(
      {
        sub: userId,
        email,
        role: 'authenticated',
        aud: 'authenticated',
      },
      this.jwtSecret(),
      { expiresIn: '7d' },
    );
  }

  async getIsMaster(userId: string): Promise<boolean> {
    const r = await this.pg.pool.query<{ is_master: boolean }>(
      `select coalesce(is_master, false) as is_master
       from public.user_profiles where id = $1::uuid limit 1`,
      [userId],
    );
    return r.rows[0]?.is_master === true;
  }

  /** 로그인 성공 시 auth.users.last_sign_in_at 갱신 (관리자 페이지 최근 로그인 표시용) */
  private async touchLastSignIn(userId: string): Promise<void> {
    await this.pg.pool.query(
      `update auth.users
       set last_sign_in_at = now(),
           updated_at = now()
       where id = $1::uuid`,
      [userId],
    );
  }

  async signIn(email: string, password: string) {
    const em = email.trim().toLowerCase();
    if (!em || !password) {
      throw new UnauthorizedException('이메일과 비밀번호를 입력해 주세요.');
    }
    const r = await this.pg.pool.query<{ id: string; email: string; encrypted_password: string }>(
      `select id, email, encrypted_password from auth.users where lower(email) = lower($1) limit 1`,
      [em],
    );
    const row = r.rows[0];
    if (!row?.encrypted_password) {
      throw new UnauthorizedException('Invalid login credentials');
    }
    const ok = await bcrypt.compare(password, row.encrypted_password);
    if (!ok) {
      throw new UnauthorizedException('Invalid login credentials');
    }
    await this.touchLastSignIn(row.id);
    const access_token = this.issueToken(row.id, row.email);
    const is_master = await this.getIsMaster(row.id);
    return {
      access_token,
      user: { id: row.id, email: row.email, is_master },
    };
  }

  async signUp(email: string, password: string, meta: Record<string, unknown>) {
    const em = email.trim().toLowerCase();
    if (!em || !password) {
      throw new BadRequestException('이메일과 비밀번호가 필요합니다.');
    }
    if (password.length < 8) {
      throw new BadRequestException('비밀번호는 8자 이상이어야 합니다.');
    }
    const exists = await this.pg.pool.query(`select 1 from auth.users where lower(email) = lower($1) limit 1`, [em]);
    if (exists.rowCount) {
      throw new BadRequestException('이미 등록된 이메일입니다.');
    }
    const hash = await bcrypt.hash(password, 10);
    const rawUser = {
      ...meta,
    };
    const client = await this.pg.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query<{ id: string; email: string }>(
        `insert into auth.users (
          instance_id, aud, role, email, encrypted_password,
          email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
          created_at, updated_at
        ) values (
          $1::uuid, 'authenticated', 'authenticated', $2, $3,
          now(), '{"provider":"email","providers":["email"]}'::jsonb, $4::jsonb,
          now(), now()
        )
        returning id, email`,
        [this.authInstanceId(), em, hash, JSON.stringify(rawUser)],
      );
      const row = ins.rows[0];
      if (!row) {
        throw new BadRequestException('가입 처리에 실패했습니다.');
      }
      await client.query('COMMIT');
      const autoConfirm = this.config.get<string>('AUTH_EMAIL_AUTO_CONFIRM') !== 'false';
      if (autoConfirm) {
        await this.touchLastSignIn(row.id);
        const access_token = this.issueToken(row.id, row.email);
        return { access_token, user: { id: row.id, email: row.email } };
      }
      return { user: { id: row.id, email: row.email } };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new BadRequestException(msg);
    } finally {
      client.release();
    }
  }
}
