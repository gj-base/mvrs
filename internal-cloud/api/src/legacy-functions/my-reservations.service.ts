import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { AuthService } from '../auth/auth.service';
import { decryptPiiField, encryptPiiContact, encryptPiiEmail } from './pii.util';

const SLOT_WINDOWS = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
] as const;
const BOOKABLE_SLOTS = SLOT_WINDOWS.filter((s) => s < '12:00' || s >= '13:00') as unknown as string[];
const LUNCH_START_MIN = 12 * 60;
const LUNCH_END_MIN = 13 * 60;
const DAY_END_MIN = 16 * 60;
const SUMMER_BLACKOUT_START_MIN = 13 * 60;
const SUMMER_BLACKOUT_END_MIN = 14 * 60;

function str(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

const LIST_PAGE_SIZE_DEFAULT = 10;
const LIST_PAGE_SIZE_MAX = 50;

function parseListPage(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(str(v), 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseListPageSize(v: unknown): number {
  const n = typeof v === 'number' ? v : parseInt(str(v), 10);
  if (!Number.isFinite(n) || n < 1) return LIST_PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(n), LIST_PAGE_SIZE_MAX);
}

function kstYmd(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

function kstMaxBookYmdInclusive(todayYmd: string): string {
  const [y, m, d] = todayYmd.split('-').map((x) => parseInt(x, 10));
  const kstMidnightUtc = Date.UTC(y, m - 1, d - 1, 15, 0, 0);
  return kstYmd(new Date(kstMidnightUtc + 7 * 24 * 60 * 60 * 1000));
}

function currentKstHHMM(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === 'hour')!.value.padStart(2, '0');
  const mi = parts.find((p) => p.type === 'minute')!.value.padStart(2, '0');
  return `${h}:${mi}`;
}

function slotStartToMinutes(slot: string): number | null {
  const p = str(slot).split(':');
  if (p.length < 2) return null;
  const h = parseInt(p[0]!, 10);
  const m = parseInt(p[1]!, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function isYmdSummerAfternoonBlackoutSeason(ymd: string): boolean {
  if (!ymd || ymd.length < 10) return false;
  const mo = parseInt(ymd.slice(5, 7), 10);
  const da = parseInt(ymd.slice(8, 10), 10);
  if (mo === 7) return da >= 1;
  if (mo === 8) return da <= 31;
  return false;
}

function overlapsSummerAfternoonBlackout(startSlot: string, durationMins: number, ymd: string): boolean {
  if (!ymd || !isYmdSummerAfternoonBlackoutSeason(ymd)) return false;
  const sm = slotStartToMinutes(startSlot);
  if (sm == null) return false;
  const end = sm + durationMins;
  return sm < SUMMER_BLACKOUT_END_MIN && end > SUMMER_BLACKOUT_START_MIN;
}

function windowsOverlappingBooking(startSlot: string, durationMins: number): string[] {
  const sm = slotStartToMinutes(startSlot);
  if (sm == null) return [];
  const end = sm + durationMins;
  const keys: string[] = [];
  for (const w of SLOT_WINDOWS) {
    const wm = slotStartToMinutes(w);
    if (wm == null) continue;
    if (sm < wm + 30 && end > wm) keys.push(w);
  }
  return keys;
}

function getReservationDurationFromRow(row: {
  reservation_duration_minutes?: unknown;
  person_info?: unknown;
}): number {
  if (Number(row.reservation_duration_minutes) === 60) return 60;
  const p = row.person_info;
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    const o = p as Record<string, unknown>;
    if (Number(o.reservation_duration_minutes) === 60) return 60;
  }
  return 30;
}

function buildOccupancyFromRows(
  rows: Array<{
    reservation_time?: unknown;
    reservation_duration_minutes?: unknown;
    person_info?: unknown;
  }>,
): Record<string, number> {
  const occupancy: Record<string, number> = {};
  SLOT_WINDOWS.forEach((s) => {
    occupancy[s] = 0;
  });
  for (const row of rows || []) {
    const t = str(row.reservation_time).substring(0, 5);
    const dur = getReservationDurationFromRow(row);
    for (const w of windowsOverlappingBooking(t, dur)) {
      if (occupancy[w] !== undefined) occupancy[w] = 1;
    }
  }
  return occupancy;
}

function slotRangeFits(
  occupancy: Record<string, number>,
  startSlot: string,
  durationMins: number,
  reservationYmd: string,
): boolean {
  if (!BOOKABLE_SLOTS.includes(startSlot)) return false;
  const sm = slotStartToMinutes(startSlot);
  if (sm == null) return false;
  const end = sm + durationMins;
  if (end > DAY_END_MIN) return false;
  if (sm < LUNCH_END_MIN && end > LUNCH_START_MIN) return false;
  if (overlapsSummerAfternoonBlackout(startSlot, durationMins, reservationYmd)) return false;
  for (const s of windowsOverlappingBooking(startSlot, durationMins)) {
    if (occupancy[s] === undefined || occupancy[s]! > 0) return false;
  }
  return true;
}

type Body = Record<string, unknown>;

@Injectable()
export class MyReservationsService {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  async handle(req: Request, pool: Pool, body: Body) {
    const piiSecret = this.config.get<string>('PII_ENCRYPTION_SECRET') ?? '';
    if (!piiSecret || piiSecret.length < 16) {
      return { status: 503 as const, body: { ok: false, error: 'PII_ENCRYPTION_SECRET 미설정' } };
    }

    const authHeader = String(req.headers.authorization ?? '');
    if (!authHeader.startsWith('Bearer ')) {
      return { status: 401 as const, body: { ok: false, error: '로그인이 필요합니다.' } };
    }
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
    const user = this.auth.verifyAccessToken(jwt);
    if (!user?.sub) {
      return { status: 401 as const, body: { ok: false, error: '로그인이 필요합니다.' } };
    }

    const action = str(body.action);
    if (!['list', 'get', 'update', 'delete'].includes(action)) {
      return { status: 400 as const, body: { ok: false, error: 'action은 list, get, update, delete 중 하나여야 합니다.' } };
    }

    const memR = await pool.query<{ company_id: string }>(
      `select company_id from public.user_company_memberships where user_id = $1::uuid`,
      [user.sub],
    );
    const companyIds = memR.rows.map((r) => Number(r.company_id)).filter((n) => Number.isFinite(n));
    if (!companyIds.length) {
      if (action === 'list') {
        const page = parseListPage(body.page);
        const pageSize = parseListPageSize(body.page_size);
        return {
          status: 200 as const,
          body: { ok: true, items: [], total: 0, page, page_size: pageSize, total_pages: 0 },
        };
      }
      return {
        status: 200 as const,
        body: { ok: false, error: '소속 업체 정보가 없습니다. 관리자에게 문의해 주세요.' },
      };
    }

    if (action === 'list') {
      const page = parseListPage(body.page);
      const pageSize = parseListPageSize(body.page_size);
      const countR = await pool.query<{ cnt: string }>(
        `select count(*)::text as cnt from public.reservations where company_id = any($1::bigint[])`,
        [companyIds],
      );
      const total = parseInt(countR.rows[0]?.cnt ?? '0', 10) || 0;
      const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
      const safePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
      const offset = (safePage - 1) * pageSize;
      const r = await pool.query(
        `select r.id, r.created_at, r.reservation_date, r.reservation_time, r.company_name,
          r.branch_id, r.company_id, r.status, r.reservation_duration_minutes, r.material_info,
          r.car_number_1, b.name as branch_name, c.name as company_label
         from public.reservations r
         left join public.branches b on b.id = r.branch_id
         left join public.companies c on c.id = r.company_id
         where r.company_id = any($1::bigint[])
         order by r.reservation_date desc, r.reservation_time desc
         limit $2 offset $3`,
        [companyIds, pageSize, offset],
      );
      return {
        status: 200 as const,
        body: {
          ok: true,
          items: r.rows,
          total,
          page: safePage,
          page_size: pageSize,
          total_pages: totalPages,
        },
      };
    }

    const resId = parseInt(str(body.reservation_id), 10);
    if (!Number.isFinite(resId) || resId <= 0) {
      return { status: 400 as const, body: { ok: false, error: '유효한 reservation_id가 필요합니다.' } };
    }

    const exR = await pool.query(`select * from public.reservations where id = $1::bigint`, [resId]);
    const ex = exR.rows[0] as Record<string, unknown> | undefined;
    if (!ex) {
      return { status: 200 as const, body: { ok: false, error: '예약을 찾을 수 없습니다.' } };
    }
    const exCompanyId = Number(ex.company_id);
    if (!companyIds.includes(exCompanyId)) {
      return { status: 200 as const, body: { ok: false, error: '이 예약에 대한 권한이 없습니다.' } };
    }

    if (action === 'get') {
      const row = await this.rowToClient(pool, ex, piiSecret);
      return { status: 200 as const, body: { ok: true, row, status: str(ex.status) || '대기' } };
    }

    if (action === 'delete') {
      if (str(ex.status) !== '대기') {
        return {
          status: 200 as const,
          body: { ok: false, error: '승인 대기 상태의 예약만 신청 취소(삭제)할 수 있습니다.' },
        };
      }
      const access = await this.assertAccess(pool, user.sub, exCompanyId, Number(ex.branch_id));
      if (!access.ok) return { status: 200 as const, body: { ok: false, error: access.error } };
      await pool.query(
        `delete from public.reservations where id = $1::bigint and status = $2`,
        [resId, '대기'],
      );
      return { status: 200 as const, body: { ok: true } };
    }

    if (action === 'update') {
      if (str(ex.status) !== '대기') {
        return { status: 200 as const, body: { ok: false, error: '승인 대기 상태의 예약만 수정할 수 있습니다.' } };
      }
      const branchId =
        typeof body.branch_id === 'number'
          ? body.branch_id
          : parseInt(str(body.branch_id), 10) || Number(ex.branch_id);
      const companyId =
        typeof body.company_id === 'number'
          ? body.company_id
          : parseInt(str(body.company_id), 10) || exCompanyId;
      const access = await this.assertAccess(pool, user.sub, companyId, branchId);
      if (!access.ok) return { status: 200 as const, body: { ok: false, error: access.error } };

      const validated = await this.validateUpdate(pool, body, piiSecret, resId);
      if (!validated.ok) return { status: 200 as const, body: { ok: false, error: validated.error } };

      const p = validated.params;
      await pool.query(
        `update public.reservations set
          reservation_date = $1::date, reservation_time = $2, company_name = $3, branch_id = $4::bigint,
          company_id = $5::bigint, visitor_email = $6, car_number_1 = $7, car_number_2 = $8,
          material_info = $9, vehicle_count = $10, contact = $11, person_info = CAST($12 AS jsonb),
          vehicle_tonnage = $13, vehicle_tonnage_2 = $14, reservation_duration_minutes = $15,
          duration_mode = $16, recommended_duration_minutes = $17, recommended_reasons = CAST($18 AS jsonb),
          doc_url_1 = $19, doc_url_2 = $20
         where id = $21::bigint and status = $22`,
        [
          p.date,
          p.timeSlot,
          p.companyName,
          p.branchId,
          p.companyId,
          p.visitorEmailEnc,
          p.car1,
          p.car2,
          p.materialInfo,
          p.vehicleCount,
          p.contactEnc,
          p.personInfoJson,
          p.vehicleTonnage,
          p.vehicleTonnage2,
          p.effDur,
          p.durationMode,
          p.recMinutes,
          JSON.stringify(p.recommendedReasons),
          p.doc1,
          p.doc2,
          resId,
          '대기',
        ],
      );
      return { status: 200 as const, body: { ok: true } };
    }

    return { status: 400 as const, body: { ok: false, error: 'Unknown action' } };
  }

  private async assertAccess(
    pool: Pool,
    userId: string,
    companyId: number,
    branchId: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const isMaster = await this.auth.getIsMaster(userId);
    if (isMaster) {
      const co = await pool.query(
        `select 1 from public.companies where id = $1::bigint and branch_id = $2::bigint and coalesce(is_active, true) limit 1`,
        [companyId, branchId],
      );
      if (!co.rowCount) {
        return { ok: false, error: '선택한 업체·지사 조합이 올바르지 않습니다.' };
      }
      return { ok: true };
    }
    const mem = await pool.query(
      `select 1 from public.user_company_memberships m
       inner join public.companies c on c.id = m.company_id
       where m.user_id = $1::uuid and m.company_id = $2::bigint and c.branch_id = $3::bigint limit 1`,
      [userId, companyId, branchId],
    );
    if (!mem.rowCount) return { ok: false, error: '이 예약에 대한 권한이 없습니다.' };
    return { ok: true };
  }

  private normalizePersonInfoForDb(personInfo: string): string {
    const s = str(personInfo).trim();
    if (!s) return s;
    try {
      const parsed: unknown = JSON.parse(s);
      if (typeof parsed === 'string') return parsed.trim();
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (o.text != null) return String(o.text).trim();
      }
    } catch {
      /* plain text */
    }
    return s;
  }

  private personInfoToDisplay(pi: unknown): string {
    if (pi == null) return '';
    if (typeof pi === 'string') {
      const trimmed = pi.trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed: unknown = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const o = parsed as Record<string, unknown>;
            if (o.text != null) return String(o.text);
          }
        } catch {
          /* keep as-is */
        }
      }
      return pi;
    }
    if (typeof pi === 'object' && !Array.isArray(pi)) {
      const o = pi as Record<string, unknown>;
      if (o.text != null) return String(o.text);
    }
    return typeof pi === 'object' ? JSON.stringify(pi) : String(pi);
  }

  private async rowToClient(pool: Pool, raw: Record<string, unknown>, piiSecret: string) {
    const branchId = Number(raw.branch_id);
    const companyId = Number(raw.company_id);
    const bR = await pool.query(`select name from public.branches where id = $1`, [branchId]);
    const cR = await pool.query(`select name from public.companies where id = $1`, [companyId]);
    const contact = await decryptPiiField(String(raw.contact ?? ''), piiSecret);
    const visitorEmail = await decryptPiiField(
      raw.visitor_email != null ? String(raw.visitor_email) : '',
      piiSecret,
    );
    return {
      ...raw,
      contact: contact ?? '',
      visitor_email: visitorEmail ?? '',
      person_info: this.personInfoToDisplay(raw.person_info),
      branches: { name: bR.rows[0]?.name ?? null },
      companies: { name: cR.rows[0]?.name ?? raw.company_name },
    };
  }

  private async validateUpdate(
    pool: Pool,
    body: Body,
    piiSecret: string,
    excludeId: number,
  ): Promise<{ ok: true; params: Record<string, unknown> } | { ok: false; error: string }> {
    const contact = str(body.contact);
    if (!contact) return { ok: false, error: '연락처를 입력해 주세요.' };

    const companyName = str(body.company_name);
    const branchId = typeof body.branch_id === 'number' ? body.branch_id : parseInt(str(body.branch_id), 10);
    const companyId = typeof body.company_id === 'number' ? body.company_id : parseInt(str(body.company_id), 10);
    if (!companyName || !Number.isFinite(branchId) || !Number.isFinite(companyId)) {
      return { ok: false, error: '관할 지사와 소속 업체를 선택해 주세요.' };
    }

    const date = str(body.reservation_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: '예약일이 올바르지 않습니다.' };
    }
    const todayKst = kstYmd();
    const maxYmd = kstMaxBookYmdInclusive(todayKst);
    if (date < todayKst || date > maxYmd) {
      return {
        ok: false,
        error:
          '예약은 오늘부터 7일 후까지(오늘 포함)만 가능합니다. 달력에서 선택 가능한 날짜를 다시 확인해 주세요.',
      };
    }

    const dup = await pool.query(
      `select id from public.reservations
       where reservation_date = $1::date and company_id = $2::bigint and status <> $3 and id <> $4::bigint limit 1`,
      [date, companyId, '반려', excludeId],
    );
    if (dup.rowCount) {
      return {
        ok: false,
        error: '이미 해당 날짜에 동일 업체 예약 신청 내역이 존재합니다. (1일 1회 제한)',
      };
    }

    const timeSlot = str(body.reservation_time).substring(0, 5);
    if (!timeSlot) return { ok: false, error: '예약 시간을 선택해 주세요.' };

    const car1 = str(body.car_number_1);
    const car2 = str(body.car_number_2);
    const materialInfo = str(body.material_info);
    const personInfo = str(body.person_info);
    if (!car1 || !materialInfo || !personInfo) {
      return { ok: false, error: '필수 입력 항목을 확인해 주세요.' };
    }

    const vehicleCount = body.vehicle_count === 2 || body.vehicle_count === '2' ? 2 : 1;
    if (vehicleCount === 2 && !car2) {
      return { ok: false, error: '차량 대수를 2대로 선택하신 경우 차량번호 2도 입력해 주세요.' };
    }

    const effDur = body.reservation_duration_minutes === 60 || body.reservation_duration_minutes === '60' ? 60 : 30;

    let vehicleTonnage: number | null = null;
    if (body.vehicle_tonnage != null && str(body.vehicle_tonnage) !== '') {
      const n = parseFloat(str(body.vehicle_tonnage));
      if (!Number.isNaN(n) && n > 0) vehicleTonnage = n;
    }
    let vehicleTonnage2: number | null = null;
    if (vehicleCount === 2 && body.vehicle_tonnage_2 != null && str(body.vehicle_tonnage_2) !== '') {
      const n2 = parseFloat(str(body.vehicle_tonnage_2));
      if (!Number.isNaN(n2) && n2 > 0) vehicleTonnage2 = n2;
    }
    if (vehicleTonnage == null) {
      return { ok: false, error: '차량 중량(톤)을 0보다 큰 값으로 입력해 주세요.' };
    }
    if (vehicleCount === 2 && vehicleTonnage2 == null) {
      return {
        ok: false,
        error: '차량 대수를 2대로 선택하신 경우 차량 중량 2도 0보다 큰 값으로 입력해 주세요.',
      };
    }

    const slotR = await pool.query(
      `select id, reservation_time, reservation_duration_minutes, person_info
       from public.reservations where reservation_date = $1::date and status <> $2`,
      [date, '반려'],
    );
    const filtered = slotR.rows.filter((r) => Number(r.id) !== excludeId);
    const occ = buildOccupancyFromRows(filtered);
    if (overlapsSummerAfternoonBlackout(timeSlot, effDur, date)) {
      return {
        ok: false,
        error:
          '하절기(7월 1일~8월 31일)에는 13:00~14:00 구간과 겹치는 예약이 불가합니다. 다른 시간을 선택해 주세요.',
      };
    }
    if (!slotRangeFits(occ, timeSlot, effDur, date)) {
      return {
        ok: false,
        error: '선택한 시간은 이미 예약이 있어 신청할 수 없습니다. 소요시간을 조정해주세요. (60분 예약 불가)',
      };
    }
    if (date === todayKst && timeSlot <= currentKstHHMM()) {
      return { ok: false, error: '오늘 날짜는 현재 시각 이후 시간만 선택할 수 있습니다.' };
    }

    const personInfoJson = this.normalizePersonInfoForDb(personInfo);

    const contactEnc = await encryptPiiContact(piiSecret, contact);
    const visitorEmailEnc = await encryptPiiEmail(
      piiSecret,
      body.visitor_email != null ? str(body.visitor_email) : '',
    );

    return {
      ok: true,
      params: {
        date,
        timeSlot,
        companyName,
        branchId,
        companyId,
        visitorEmailEnc,
        car1,
        car2: car2 || null,
        materialInfo,
        vehicleCount,
        contactEnc,
        personInfoJson,
        vehicleTonnage,
        vehicleTonnage2: vehicleCount === 2 ? vehicleTonnage2 : null,
        effDur,
        durationMode: str(body.duration_mode) === 'manual' ? 'manual' : 'auto',
        recMinutes: body.recommended_duration_minutes === 60 || body.recommended_duration_minutes === '60' ? 60 : 30,
        recommendedReasons: Array.isArray(body.recommended_reasons)
          ? (body.recommended_reasons as unknown[]).map((x) => str(x)).filter(Boolean)
          : [],
        doc1: body.doc_url_1 != null && str(body.doc_url_1) !== '' ? str(body.doc_url_1) : null,
        doc2: body.doc_url_2 != null && str(body.doc_url_2) !== '' ? str(body.doc_url_2) : null,
      },
    };
  }
}
