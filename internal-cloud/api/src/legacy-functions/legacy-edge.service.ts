import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { PgService } from '../pg/pg.service';
import { AuthService } from '../auth/auth.service';
import { timingSafeEqualUtf8 } from './timing-safe.util';
import { checkAdminSourceIp } from './admin-ip.util';
import { checkBookingSubmitBlockedBySourceIp } from './booking-ip.util';
import { decryptPiiField } from './pii.util';
import { SubmitReservationService } from './submit-reservation.service';
import * as nodemailer from 'nodemailer';

@Injectable()
export class LegacyEdgeService {
  constructor(
    private readonly pg: PgService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    private readonly submitReservation: SubmitReservationService,
  ) {}

  async dispatch(name: string, req: Request, res: Response, rawBody: unknown) {
    switch (name) {
      case 'verify-admin-password':
        return this.verifyAdminPassword(req, res, rawBody);
      case 'check-booking-submit-allowed':
        return this.checkBookingSubmitAllowed(req, res);
      case 'submit-reservation':
        return this.submitReservationHandler(req, res, rawBody);
      case 'admin-manage-public-settings':
        return this.adminManagePublicSettings(req, res, rawBody);
      case 'admin-list-user-signups':
        return this.adminListUserSignups(req, res, rawBody);
      case 'decrypt-reservation-pii':
        return this.decryptReservationPii(req, res, rawBody);
      case 'send-reservation-status-email':
        return this.sendReservationStatusEmail(req, res, rawBody);
      default:
        return res.status(404).json({ error: 'Unknown function' });
    }
  }

  private adminSecret(req: Request, body: Record<string, unknown>): string {
    const fromBody = body.admin_secret != null ? String(body.admin_secret) : '';
    if (fromBody !== '') return fromBody;
    return String(req.headers['x-admin-secret'] ?? '');
  }

  private async verifyAdminPassword(req: Request, res: Response, rawBody: unknown) {
    const ip = checkAdminSourceIp(req, this.config.get<string>('ADMIN_ALLOWED_SOURCE_IPS') ?? '');
    if (!ip.ok) {
      return res.status(403).json({ ok: false, error: ip.message });
    }
    const expected = this.config.get<string>('ADMIN_NOTIFY_SECRET') ?? '';
    if (!expected) {
      return res.status(503).json({ error: 'ADMIN_NOTIFY_SECRET is not configured' });
    }
    const body = (rawBody || {}) as { password?: string };
    const password = body.password != null ? String(body.password) : '';
    if (!timingSafeEqualUtf8(expected, password)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    return res.json({ ok: true });
  }

  private async checkBookingSubmitAllowed(req: Request, res: Response) {
    const authHeader = String(req.headers.authorization ?? '');
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
    }
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    const user = this.auth.verifyAccessToken(jwt);
    if (!user?.sub) {
      return res.status(401).json({ ok: false, error: '로그인이 필요합니다.' });
    }
    const bookingIp = checkBookingSubmitBlockedBySourceIp(
      req,
      this.config.get<string>('BOOKING_BLOCKED_SOURCE_IPS') ?? '',
    );
    if (!bookingIp.ok) {
      return res.status(200).json({ ok: false, error: bookingIp.message });
    }
    return res.status(200).json({ ok: true });
  }

  private async submitReservationHandler(req: Request, res: Response, rawBody: unknown) {
    const out = await this.submitReservation.handle(req, this.pg.pool, (rawBody || {}) as never);
    return res.status(out.status).json(out.body);
  }

  private async adminManagePublicSettings(req: Request, res: Response, rawBody: unknown) {
    const ip = checkAdminSourceIp(req, this.config.get<string>('ADMIN_ALLOWED_SOURCE_IPS') ?? '');
    if (!ip.ok) {
      return res.status(403).json({ ok: false, error: ip.message });
    }
    const body = (rawBody || {}) as Record<string, unknown>;
    const adminNotify = this.config.get<string>('ADMIN_NOTIFY_SECRET') ?? '';
    const secret = this.adminSecret(req, body);
    if (!adminNotify || !timingSafeEqualUtf8(adminNotify, secret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const action = String(body.action ?? '').trim();
    try {
      if (action === 'blocked_add') {
        const blockedDate = String(body.blocked_date ?? '').slice(0, 10);
        const reasonRaw = body.reason != null ? String(body.reason) : '';
        const reason = reasonRaw.trim().slice(0, 500) || null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(blockedDate)) {
          return res.status(400).json({ ok: false, error: 'blocked_date 형식이 올바르지 않습니다.' });
        }
        try {
          const ins = await this.pg.pool.query(
            `insert into public.global_blocked_dates (blocked_date, reason) values ($1::date, $2)
             returning id, blocked_date, reason`,
            [blockedDate, reason],
          );
          return res.status(200).json({ ok: true, row: ins.rows[0] });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('duplicate') || msg.includes('23505')) {
            return res.status(409).json({ ok: false, error: '이미 등록된 날짜입니다.' });
          }
          throw e;
        }
      }
      if (action === 'blocked_delete') {
        const id = String(body.id ?? '');
        if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });
        const scope = String(body.blocked_scope ?? '') === 'branch' ? 'branch' : 'global';
        const table = scope === 'branch' ? 'branch_blocked_dates' : 'global_blocked_dates';
        await this.pg.pool.query(`delete from public.${table} where id = $1::bigint`, [id]);
        return res.json({ ok: true });
      }
      if (action === 'popup_save') {
        const isEnabled = body.is_enabled === true || body.is_enabled === 'true';
        const title = String(body.title ?? '').slice(0, 200);
        const popupBody = String(body.body ?? '').slice(0, 8000);
        const now = new Date().toISOString();
        const idRaw = body.id;
        const hasId =
          idRaw != null &&
          idRaw !== '' &&
          !Number.isNaN(Number(idRaw)) &&
          Number.isFinite(Number(idRaw));
        if (hasId) {
          const id = Number(idRaw);
          await this.pg.pool.query(
            `update public.site_popups set is_enabled = $1, title = $2, "body" = $3, updated_at = $4::timestamptz where id = $5::bigint`,
            [isEnabled, title, popupBody, now, id],
          );
          return res.json({ ok: true, id });
        }
        const maxRows = await this.pg.pool.query(
          `select sort_order from public.site_popups order by sort_order desc nulls last limit 1`,
        );
        const nextSort =
          maxRows.rows[0] && maxRows.rows[0].sort_order != null ? Number(maxRows.rows[0].sort_order) + 1 : 0;
        const ins = await this.pg.pool.query(
          `insert into public.site_popups (is_enabled, title, "body", sort_order, updated_at)
           values ($1, $2, $3, $4, $5::timestamptz) returning id`,
          [isEnabled, title, popupBody, nextSort, now],
        );
        return res.json({ ok: true, id: ins.rows[0]?.id });
      }
      if (action === 'popup_delete') {
        const id = String(body.id ?? '');
        if (!id) return res.status(400).json({ ok: false, error: 'id가 필요합니다.' });
        await this.pg.pool.query(`delete from public.site_popups where id = $1::bigint`, [id]);
        return res.json({ ok: true });
      }
      if (action === 'popup_reorder') {
        const ids = body.ids;
        if (!Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ ok: false, error: 'ids 배열이 필요합니다.' });
        }
        const now = new Date().toISOString();
        for (let i = 0; i < ids.length; i++) {
          const id = Number(ids[i]);
          if (!Number.isFinite(id)) continue;
          await this.pg.pool.query(
            `update public.site_popups set sort_order = $1, updated_at = $2::timestamptz where id = $3::bigint`,
            [i, now, id],
          );
        }
        return res.json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'Unknown action' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ ok: false, error: msg });
    }
  }

  private async adminListUserSignups(req: Request, res: Response, rawBody: unknown) {
    const ip = checkAdminSourceIp(req, this.config.get<string>('ADMIN_ALLOWED_SOURCE_IPS') ?? '');
    if (!ip.ok) {
      return res.status(403).json({ ok: false, error: ip.message });
    }
    const body = (rawBody || {}) as { admin_secret?: string; limit?: number };
    const adminNotify = this.config.get<string>('ADMIN_NOTIFY_SECRET') ?? '';
    const secret = this.adminSecret(req, body as Record<string, unknown>);
    if (!adminNotify || !timingSafeEqualUtf8(adminNotify, secret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const limRaw = Number(body.limit);
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? Math.min(Math.floor(limRaw), 2000) : 1000;

    const prof = await this.pg.pool.query(
      `select id, full_name, phone, contact_email, company_address, created_at, updated_at
       from public.user_profiles order by created_at desc limit $1`,
      [limit],
    );
    const profiles = prof.rows;
    const userIds = profiles.map((p: { id: string }) => p.id);
    if (!userIds.length) {
      return res.json({ ok: true, items: [] });
    }

    const mem = await this.pg.pool.query(
      `select m.user_id, m.created_at, c.id as cid, c.name as cname, c.business_registration_no as brn, c.branch_id, b.name as bname
       from public.user_company_memberships m
       left join public.companies c on c.id = m.company_id
       left join public.branches b on b.id = c.branch_id
       where m.user_id = any($1::uuid[])`,
      [userIds],
    );

    const authUsers = await this.pg.pool.query(
      `select id, email, email_confirmed_at, created_at, last_sign_in_at from auth.users where id = any($1::uuid[])`,
      [userIds],
    );
    const authByUser = new Map<string, Record<string, unknown>>();
    for (const u of authUsers.rows) {
      authByUser.set(String(u.id), u);
    }

    const memByUser = new Map<string, typeof mem.rows>();
    for (const row of mem.rows) {
      const uid = String(row.user_id);
      const arr = memByUser.get(uid) ?? [];
      arr.push(row);
      memByUser.set(uid, arr);
    }

    const items = profiles.map((p: Record<string, unknown>) => {
      const uid = String(p.id);
      const mems = memByUser.get(uid) ?? [];
      const brnSet = new Set<string>();
      const coSet = new Set<string>();
      const brSet = new Set<string>();
      for (const m of mems) {
        if (m.brn) brnSet.add(String(m.brn));
        if (m.cname) coSet.add(String(m.cname));
        if (m.bname) brSet.add(String(m.bname));
      }
      const a = authByUser.get(uid) ?? {};
      return {
        user_id: uid,
        email: (a.email as string) ?? null,
        email_confirmed_at: (a.email_confirmed_at as string) ?? null,
        auth_created_at: (a.created_at as string) ?? null,
        last_sign_in_at: (a.last_sign_in_at as string) ?? null,
        full_name: String(p.full_name ?? ''),
        phone: String(p.phone ?? ''),
        contact_email: String(p.contact_email ?? ''),
        company_address: String(p.company_address ?? ''),
        profile_updated_at: (p.updated_at as string) ?? null,
        brn: brnSet.size ? Array.from(brnSet).join(', ') : null,
        company_names: Array.from(coSet),
        branch_names: Array.from(brSet),
      };
    });

    return res.json({ ok: true, items });
  }

  private async decryptReservationPii(req: Request, res: Response, rawBody: unknown) {
    const ip = checkAdminSourceIp(req, this.config.get<string>('ADMIN_ALLOWED_SOURCE_IPS') ?? '');
    if (!ip.ok) {
      return res.status(403).json({ ok: false, error: ip.message });
    }
    const adminNotify = this.config.get<string>('ADMIN_NOTIFY_SECRET') ?? '';
    const piiSecret = this.config.get<string>('PII_ENCRYPTION_SECRET') ?? '';
    const body = (rawBody || {}) as { admin_secret?: string; items?: unknown[] };
    const secret = this.adminSecret(req, body as Record<string, unknown>);
    if (!adminNotify || !timingSafeEqualUtf8(adminNotify, secret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!piiSecret || piiSecret.length < 16) {
      return res.status(503).json({ ok: false, error: 'PII_ENCRYPTION_SECRET 미설정' });
    }
    const items = body.items;
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: 'items 배열이 필요합니다.' });
    }
    if (items.length > 800) {
      return res.status(400).json({ ok: false, error: '한 번에 최대 800건까지 복호화할 수 있습니다.' });
    }
    const out: Array<{ contact: string | null; visitor_email: string | null }> = [];
    for (const it of items) {
      const row = it as { contact?: unknown; visitor_email?: unknown };
      const c = await decryptPiiField(row.contact as string | null, piiSecret);
      const ve =
        row.visitor_email != null
          ? await decryptPiiField(row.visitor_email as string | null, piiSecret)
          : null;
      out.push({
        contact: c == null ? null : String(c),
        visitor_email: ve == null ? null : String(ve),
      });
    }
    return res.json({ ok: true, items: out });
  }

  private async sendReservationStatusEmail(req: Request, res: Response, rawBody: unknown) {
    const ip = checkAdminSourceIp(req, this.config.get<string>('ADMIN_ALLOWED_SOURCE_IPS') ?? '');
    if (!ip.ok) {
      return res.status(403).json({ error: ip.message });
    }
    const body = (rawBody || {}) as {
      reservation_id?: string;
      admin_secret?: string;
      notify_for_status?: string;
    };
    const adminNotify = this.config.get<string>('ADMIN_NOTIFY_SECRET') ?? '';
    const secret = this.adminSecret(req, body as Record<string, unknown>);
    if (!adminNotify || !timingSafeEqualUtf8(adminNotify, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const piiSecret = this.config.get<string>('PII_ENCRYPTION_SECRET') ?? '';
    const gmailUser = this.config.get<string>('GMAIL_SMTP_USER') ?? '';
    const gmailPass = this.config.get<string>('GMAIL_SMTP_APP_PASSWORD') ?? '';
    const mailFromRaw = (this.config.get<string>('MAIL_FROM') ?? gmailUser).trim();
    if (!piiSecret || piiSecret.length < 16) {
      return res.status(500).json({ error: 'PII_ENCRYPTION_SECRET is not configured' });
    }
    if (!gmailUser || !gmailPass) {
      return res.status(503).json({ error: 'GMAIL_SMTP_USER 또는 GMAIL_SMTP_APP_PASSWORD 미설정' });
    }
    const reservationId = String(body.reservation_id ?? '').trim();
    if (!reservationId) {
      return res.status(400).json({ error: 'reservation_id required' });
    }

    const notifyWant = String(body.notify_for_status ?? '').trim();
    const wantRetry = notifyWant === '승인' || notifyWant === '반려' ? 12 : 1;
    type ResRow = Record<string, unknown> & { branches?: { name?: string } | null };
    let row: ResRow | null = null;
    let lastRawStatus = '';
    for (let attempt = 0; attempt < wantRetry; attempt++) {
      const r = await this.pg.pool.query(
        `select r.id, r.status, r.status_notification_sent, r.visitor_email, r.company_name,
                r.reservation_date, r.reservation_time, r.car_number_1, r.car_number_2, r.material_info, r.vehicle_count,
                json_build_object('name', b.name) as branches
         from public.reservations r
         left join public.branches b on b.id = r.branch_id
         where r.id = $1::bigint`,
        [reservationId],
      );
      const fetched = r.rows[0] as ResRow | undefined;
      if (!fetched) {
        return res.status(404).json({ error: 'Reservation not found' });
      }
      const statusNorm = String(fetched.status ?? '').trim();
      lastRawStatus = statusNorm || String(fetched.status ?? '');
      if (statusNorm === '승인' || statusNorm === '반려') {
        row = { ...fetched, status: statusNorm } as ResRow;
        break;
      }
      if (attempt + 1 < wantRetry) {
        await new Promise((r2) => setTimeout(r2, 250));
      } else {
        row = fetched;
      }
    }
    if (!row) {
      return res.status(404).json({ error: 'Reservation not found' });
    }
    const st = String(row.status ?? '').trim();
    if (st !== '승인' && st !== '반려') {
      return res.json({
        ok: true,
        skipped: true,
        reason: 'status not 승인/반려',
        db_status: lastRawStatus || st || null,
      });
    }
    if (row.status_notification_sent === true) {
      return res.json({ ok: true, skipped: true, reason: 'already sent' });
    }

    const emailPlain = await decryptPiiField(row.visitor_email as string | null, piiSecret);
    const to = emailPlain && String(emailPlain).includes('@') ? String(emailPlain).trim() : null;
    if (!to) {
      return res.status(400).json({ error: 'No valid visitor email on record' });
    }

    const dateStr = row.reservation_date ? String(row.reservation_date).slice(0, 10) : '-';
    const timeStr = row.reservation_time ? String(row.reservation_time).trim().slice(0, 5) : '-';
    const branchRow = row.branches as { name?: string } | null | undefined;
    const branchName = String(branchRow?.name ?? '').trim() || '-';
    const companyName = String(row.company_name ?? '').trim() || '-';
    const salutation = companyName !== '-' ? companyName : '귀하';
    const cars = [String(row.car_number_1 ?? ''), String(row.car_number_2 ?? '')].filter(Boolean).join(' / ') || '-';
    const vehicleCountN = row.vehicle_count === 2 || row.vehicle_count === '2' ? 2 : 1;
    const vehicleCountLabel = vehicleCountN === 2 ? '2대' : '1대';
    const material = String(row.material_info ?? '')
      .replace(/^\[차량대수:[12]대\]\s*/, '')
      .trim() || '-';

    const subject =
      row.status === '승인'
        ? `[자재센터] 불용자재 환입 예약이 승인되었습니다`
        : `[자재센터] 불용자재 환입 예약이 반려되었습니다`;

    const textBody =
      `${salutation} 담당자님, 안녕하세요.\n\n` +
      `신청하신 불용자재 환입 차량 예약이 ${row.status} 처리되었습니다.\n\n` +
      `■ 예약 정보\n` +
      `- 지사: ${branchName}\n` +
      `- 업체명: ${companyName}\n` +
      `- 예약일: ${dateStr}\n` +
      `- 방문 시간: ${timeStr}\n` +
      `- 차량 대수: ${vehicleCountLabel}\n` +
      `- 차량번호: ${cars}\n` +
      `- 환입 자재 내역: ${material}\n` +
      `- 담당자 연락처: 062-260-5133, 5145\n\n` +
      `문의 사항은 담당 부서로 연락해 주시기 바랍니다.`;

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
    });
    try {
      await transport.sendMail({
        from: mailFromRaw || gmailUser,
        to,
        subject,
        text: textBody,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return res.status(502).json({ error: 'SMTP send failed', detail: msg.slice(0, 500) });
    }

    await this.pg.pool.query(
      `update public.reservations set status_notification_sent = true where id = $1::bigint`,
      [reservationId],
    );
    return res.json({ ok: true });
  }
}
