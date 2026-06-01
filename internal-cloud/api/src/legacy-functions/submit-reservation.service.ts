import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { AuthService } from '../auth/auth.service';
import { encryptPiiContact, encryptPiiEmail } from './pii.util';
import { checkBookingSubmitBlockedBySourceIp } from './booking-ip.util';

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
  const plus7 = kstMidnightUtc + 7 * 24 * 60 * 60 * 1000;
  return kstYmd(new Date(plus7));
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

function isYmdSummerAfternoonBlackoutSeason(ymd: string): boolean {
  if (!ymd || ymd.length < 10) return false;
  const mo = parseInt(ymd.slice(5, 7), 10);
  const da = parseInt(ymd.slice(8, 10), 10);
  if (mo === 7) return da >= 1;
  if (mo === 8) return da <= 31;
  return false;
}

function slotStartToMinutes(slot: string): number | null {
  const p = str(slot).split(':');
  if (p.length < 2) return null;
  const h = parseInt(p[0]!, 10);
  const m = parseInt(p[1]!, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
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
  for (let i = 0; i < SLOT_WINDOWS.length; i++) {
    const w = SLOT_WINDOWS[i]!;
    const wm = slotStartToMinutes(w);
    if (wm == null) continue;
    const wEnd = wm + 30;
    if (sm < wEnd && end > wm) keys.push(w);
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
  const keys = windowsOverlappingBooking(startSlot, durationMins);
  for (const s of keys) {
    if (occupancy[s] === undefined) return false;
    if (occupancy[s]! > 0) return false;
  }
  return true;
}

type SubmitBody = {
  reservation_date?: string;
  reservation_time?: string;
  company_name?: string;
  branch_id?: number | string;
  company_id?: number | string;
  contact?: string;
  visitor_email?: string | null;
  car_number_1?: string;
  car_number_2?: string | null;
  material_info?: string;
  vehicle_count?: number | string;
  person_info?: string;
  vehicle_tonnage?: number | string | null;
  vehicle_tonnage_2?: number | string | null;
  reservation_duration_minutes?: number | string;
  duration_mode?: string;
  recommended_duration_minutes?: number | string;
  recommended_reasons?: unknown;
  doc_url_1?: string;
  doc_url_2?: string | null;
};

@Injectable()
export class SubmitReservationService {
  constructor(
    private readonly config: ConfigService,
    private readonly auth: AuthService,
  ) {}

  async handle(req: Request, pool: Pool, body: SubmitBody) {
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

    const bookingIp = checkBookingSubmitBlockedBySourceIp(
      req,
      this.config.get<string>('BOOKING_BLOCKED_SOURCE_IPS') ?? '',
    );
    if (!bookingIp.ok) {
      return { status: 200 as const, body: { ok: false, error: bookingIp.message } };
    }

    const contact = str(body.contact);
    if (!contact) {
      return { status: 200 as const, body: { ok: false, error: '연락처를 입력해 주세요.' } };
    }

    const companyName = str(body.company_name);
    const branchId = typeof body.branch_id === 'number' ? body.branch_id : parseInt(str(body.branch_id), 10);
    const companyId = typeof body.company_id === 'number' ? body.company_id : parseInt(str(body.company_id), 10);
    if (!companyName || !Number.isFinite(branchId) || !Number.isFinite(companyId)) {
      return { status: 200 as const, body: { ok: false, error: '관할 지사와 소속 업체를 선택해 주세요.' } };
    }

    const isMaster = await this.auth.getIsMaster(user.sub);
    const coValid = await pool.query(
      `select 1 from public.companies
       where id = $1::bigint and branch_id = $2::bigint and coalesce(is_active, true)
       limit 1`,
      [companyId, branchId],
    );
    if (!coValid.rowCount) {
      return {
        status: 200 as const,
        body: { ok: false, error: '선택한 업체·지사 조합이 올바르지 않습니다.' },
      };
    }
    if (!isMaster) {
      const mem = await pool.query(
        `select 1 from public.user_company_memberships m
         inner join public.companies c on c.id = m.company_id
         where m.user_id = $1::uuid and m.company_id = $2::bigint and c.branch_id = $3::bigint
         limit 1`,
        [user.sub, companyId, branchId],
      );
      if (!mem.rowCount) {
        return { status: 200 as const, body: { ok: false, error: '선택한 업체·지사에 대한 예약 권한이 없습니다.' } };
      }
    }

    const date = str(body.reservation_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { status: 200 as const, body: { ok: false, error: '예약일이 올바르지 않습니다.' } };
    }

    const todayKst = kstYmd();
    const maxYmd = kstMaxBookYmdInclusive(todayKst);
    if (date < todayKst || date > maxYmd) {
      return {
        status: 200 as const,
        body: {
          ok: false,
          error:
            '예약은 오늘부터 7일 후까지(오늘 포함)만 가능합니다. 달력에서 선택 가능한 날짜를 다시 확인해 주세요.',
        },
      };
    }

    const dup1 = await pool.query(
      `select id from public.reservations where reservation_date = $1::date and company_id = $2::bigint and status <> $3 limit 1`,
      [date, companyId, '반려'],
    );
    if (dup1.rowCount) {
      return {
        status: 200 as const,
        body: { ok: false, error: '이미 해당 날짜에 동일 업체 예약 신청 내역이 존재합니다. (1일 1회 제한)' },
      };
    }

    const timeSlot = str(body.reservation_time).substring(0, 5);
    if (!timeSlot) {
      return { status: 200 as const, body: { ok: false, error: '예약 시간을 선택해 주세요.' } };
    }

    const car1 = str(body.car_number_1);
    const car2 = str(body.car_number_2);
    const materialInfo = str(body.material_info);
    const personInfo = str(body.person_info);
    if (!car1 || !materialInfo || !personInfo) {
      return { status: 200 as const, body: { ok: false, error: '필수 입력 항목을 확인해 주세요.' } };
    }

    const vcRaw = body.vehicle_count;
    const vehicleCount = vcRaw === 2 || vcRaw === '2' ? 2 : 1;
    if (vehicleCount === 2 && !car2) {
      return {
        status: 200 as const,
        body: { ok: false, error: '차량 대수를 2대로 선택하신 경우 차량번호 2도 입력해 주세요.' },
      };
    }

    const effDurRaw = body.reservation_duration_minutes;
    const effDur = effDurRaw === 60 || effDurRaw === '60' ? 60 : 30;

    let visitorEmailPlain = body.visitor_email != null ? str(body.visitor_email) : '';
    if (visitorEmailPlain === '') visitorEmailPlain = '';

    let vehicleTonnage: number | null = null;
    if (body.vehicle_tonnage != null && str(body.vehicle_tonnage) !== '') {
      const n = parseFloat(str(body.vehicle_tonnage));
      if (!Number.isNaN(n) && n > 0) vehicleTonnage = n;
    }
    let vehicleTonnage2: number | null = null;
    if (body.vehicle_tonnage_2 != null && str(body.vehicle_tonnage_2) !== '') {
      const n2 = parseFloat(str(body.vehicle_tonnage_2));
      if (!Number.isNaN(n2) && n2 > 0) vehicleTonnage2 = n2;
    }
    if (vehicleTonnage == null) {
      return {
        status: 200 as const,
        body: { ok: false, error: '차량 중량(톤)을 0보다 큰 값으로 입력해 주세요.' },
      };
    }
    if (vehicleCount === 2) {
      if (vehicleTonnage2 == null) {
        return {
          status: 200 as const,
          body: {
            ok: false,
            error: '차량 대수를 2대로 선택하신 경우 차량 중량 2도 0보다 큰 값으로 입력해 주세요.',
          },
        };
      }
    } else {
      vehicleTonnage2 = null;
    }

    const recMinRaw = body.recommended_duration_minutes;
    const recMinutes = recMinRaw === 60 || recMinRaw === '60' ? 60 : 30;
    const durationMode = str(body.duration_mode) === 'manual' ? 'manual' : 'auto';
    let recommendedReasons: string[] = [];
    const rr = body.recommended_reasons;
    if (Array.isArray(rr)) {
      recommendedReasons = rr.map((x) => str(x)).filter(Boolean);
    }

    const slotR = await pool.query(
      `select reservation_time, car_number_1, car_number_2, reservation_duration_minutes, person_info
       from public.reservations where reservation_date = $1::date and status <> $2`,
      [date, '반려'],
    );
    const occSubmit = buildOccupancyFromRows(slotR.rows);
    if (overlapsSummerAfternoonBlackout(timeSlot, effDur, date)) {
      return {
        status: 200 as const,
        body: {
          ok: false,
          error:
            '하절기(7월 1일~8월 31일)에는 13:00~14:00 구간과 겹치는 예약이 불가합니다. 다른 시간을 선택해 주세요.',
        },
      };
    }
    if (!slotRangeFits(occSubmit, timeSlot, effDur, date)) {
      return {
        status: 200 as const,
        body: {
          ok: false,
          error: '선택한 시간은 이미 예약이 있어 신청할 수 없습니다. 소요시간을 조정해주세요. (60분 예약 불가)',
        },
      };
    }

    if (date === todayKst) {
      const nowHm = currentKstHHMM();
      if (timeSlot <= nowHm) {
        return {
          status: 200 as const,
          body: { ok: false, error: '오늘 날짜는 현재 시각 이후 시간만 선택할 수 있습니다.' },
        };
      }
    }

    const doc1 = body.doc_url_1 != null && str(body.doc_url_1) !== '' ? str(body.doc_url_1) : null;
    const doc2 = body.doc_url_2 != null && str(body.doc_url_2) !== '' ? str(body.doc_url_2) : null;

    let contactEnc: string;
    let visitorEmailEnc: string | null;
    try {
      contactEnc = await encryptPiiContact(piiSecret, contact);
      visitorEmailEnc = await encryptPiiEmail(piiSecret, visitorEmailPlain);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 200 as const, body: { ok: false, error: '개인정보 암호화 처리 오류: ' + msg } };
    }

    const dup2 = await pool.query(
      `select id from public.reservations where reservation_date = $1::date and company_id = $2::bigint and status <> $3 limit 1`,
      [date, companyId, '반려'],
    );
    if (dup2.rowCount) {
      return {
        status: 200 as const,
        body: { ok: false, error: '이미 해당 날짜에 동일 업체 예약 신청 내역이 존재합니다. (1일 1회 제한)' },
      };
    }

    try {
      await pool.query(
        `insert into public.reservations (
          reservation_date, reservation_time, company_name, branch_id, company_id,
          visitor_email, car_number_1, car_number_2, material_info, vehicle_count, contact, person_info,
          vehicle_tonnage, vehicle_tonnage_2, reservation_duration_minutes, duration_mode, recommended_duration_minutes,
          recommended_reasons, doc_url_1, doc_url_2, doc_url_3, status
        ) values (
          $1::date, $2, $3, $4::bigint, $5::bigint,
          $6, $7, $8, $9, $10, $11, CAST($12 AS jsonb),
          $13, $14, $15, $16, $17,
          CAST($18 AS jsonb), $19, $20, null, $21
        )`,
        [
          date,
          timeSlot,
          companyName,
          branchId,
          companyId,
          visitorEmailEnc,
          car1,
          car2 || null,
          materialInfo,
          vehicleCount,
          contactEnc,
          (() => {
            try {
              return JSON.stringify(JSON.parse(personInfo));
            } catch {
              return JSON.stringify({ text: personInfo });
            }
          })(),
          vehicleTonnage,
          vehicleTonnage2,
          effDur,
          durationMode,
          recMinutes,
          JSON.stringify(recommendedReasons),
          doc1,
          doc2,
          '대기',
        ],
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { status: 200 as const, body: { ok: false, error: '신청 오류: ' + msg } };
    }

    return { status: 200 as const, body: { ok: true } };
  }
}
