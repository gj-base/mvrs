import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  deadlineErrorMessage,
  isApprovedStatus,
  isUserActionAllowed,
} from "../_shared/booking_deadline.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version, prefer",
};

const PII_PREFIX = "enc:v1:";
const PBKDF2_SALT = new Uint8Array([
  0x72, 0x65, 0x73, 0x76, 0x2d, 0x70, 0x69, 0x69,
  0x2d, 0x6b, 0x65, 0x70, 0x63, 0x6f, 0x2d, 0x31,
]);
const PBKDF2_ITERS = 210000;

const SLOT_WINDOWS = [
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
  "13:00", "13:30", "14:00", "14:30", "15:00", "15:30",
] as const;
const BOOKABLE_SLOTS: string[] = SLOT_WINDOWS.filter((s) =>
  s < "12:00" || s >= "13:00"
) as unknown as string[];
const LUNCH_START_MIN = 12 * 60;
const LUNCH_END_MIN = 13 * 60;
const DAY_END_MIN = 16 * 60;
const SUMMER_BLACKOUT_START_MIN = 13 * 60;
const SUMMER_BLACKOUT_END_MIN = 14 * 60;
const TEMP_SLOT_BLACKOUT_START_YMD = "2026-08-03";
const TEMP_SLOT_BLACKOUT_END_YMD = "2026-09-03";
const TEMP_BLOCKED_SLOT_MINS = [11 * 60 + 30, 15 * 60 + 30];
const TEMP_SLOT_BLACKOUT_ERROR =
  "2026년 8월 3일~9월 3일 기간에는 11:30·15:30 예약이 불가합니다. 다른 시간을 선택해 주세요.";

type Action = "list" | "get" | "update" | "delete";

type SubmitBody = {
  reservation_id?: number | string;
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
  doc_url_1?: string | null;
  doc_url_2?: string | null;
};

type ReqBody = SubmitBody & { action?: string };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

async function getPiiKey(
  secret: string,
  usages: ("encrypt" | "decrypt")[],
): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: PBKDF2_SALT,
      iterations: PBKDF2_ITERS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

async function deriveContactIv(plaintext: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest(
    "SHA-256",
    enc.encode("v1|contact|" + plaintext),
  );
  return new Uint8Array(buf, 0, 12);
}

async function encryptPayload(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: string,
): Promise<string> {
  const enc = new TextEncoder();
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext),
  );
  const ct = new Uint8Array(ctBuf);
  const combined = new Uint8Array(12 + ct.length);
  combined.set(iv, 0);
  combined.set(ct, 12);
  return PII_PREFIX + bytesToBase64(combined);
}

async function encryptPiiContact(secret: string, plaintext: string): Promise<string> {
  const key = await getPiiKey(secret, ["encrypt"]);
  const iv = await deriveContactIv(plaintext);
  return encryptPayload(key, iv, plaintext);
}

async function encryptPiiEmail(
  secret: string,
  plaintext: string,
): Promise<string | null> {
  const p = plaintext.trim();
  if (!p) return null;
  const key = await getPiiKey(secret, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return encryptPayload(key, iv, p);
}

async function decryptPiiField(
  stored: string | null | undefined,
  secret: string,
): Promise<string | null> {
  if (stored == null || stored === "") return null;
  const s = String(stored);
  if (!s.startsWith(PII_PREFIX)) return s;
  let combined: Uint8Array;
  try {
    combined = base64ToBytes(s.slice(PII_PREFIX.length));
  } catch {
    return s;
  }
  if (combined.length < 12 + 16) return s;
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const key = await getPiiKey(secret, ["decrypt"]);
  try {
    const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return new TextDecoder().decode(buf);
  } catch {
    return s;
  }
}

function kstYmd(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${day}`;
}

function kstMaxBookYmdInclusive(todayYmd: string): string {
  const [y, m, d] = todayYmd.split("-").map((x) => parseInt(x, 10));
  const kstMidnightUtc = Date.UTC(y, m - 1, d - 1, 15, 0, 0);
  const plus7 = kstMidnightUtc + 7 * 24 * 60 * 60 * 1000;
  return kstYmd(new Date(plus7));
}

function currentKstHHMM(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const h = parts.find((p) => p.type === "hour")!.value.padStart(2, "0");
  const mi = parts.find((p) => p.type === "minute")!.value.padStart(2, "0");
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
  const p = str(slot).split(":");
  if (p.length < 2) return null;
  const h = parseInt(p[0]!, 10);
  const m = parseInt(p[1]!, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function overlapsSummerAfternoonBlackout(
  startSlot: string,
  durationMins: number,
  ymd: string,
): boolean {
  if (!ymd || !isYmdSummerAfternoonBlackoutSeason(ymd)) return false;
  const sm = slotStartToMinutes(startSlot);
  if (sm == null) return false;
  const end = sm + durationMins;
  return sm < SUMMER_BLACKOUT_END_MIN && end > SUMMER_BLACKOUT_START_MIN;
}

function isYmdInTempSlotBlackoutPeriod(ymd: string): boolean {
  return ymd >= TEMP_SLOT_BLACKOUT_START_YMD && ymd <= TEMP_SLOT_BLACKOUT_END_YMD;
}

function overlapsTempSlotBlackout(
  startSlot: string,
  durationMins: number,
  ymd: string,
): boolean {
  if (!ymd || !isYmdInTempSlotBlackoutPeriod(ymd)) return false;
  const sm = slotStartToMinutes(startSlot);
  if (sm == null) return false;
  const end = sm + durationMins;
  for (const bs of TEMP_BLOCKED_SLOT_MINS) {
    const be = bs + 30;
    if (sm < be && end > bs) return true;
  }
  return false;
}

function windowsOverlappingBooking(
  startSlot: string,
  durationMins: number,
): string[] {
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
  if (p && typeof p === "object" && !Array.isArray(p)) {
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
  if (overlapsSummerAfternoonBlackout(startSlot, durationMins, reservationYmd)) {
    return false;
  }
  if (overlapsTempSlotBlackout(startSlot, durationMins, reservationYmd)) {
    return false;
  }
  const keys = windowsOverlappingBooking(startSlot, durationMins);
  for (const s of keys) {
    if (occupancy[s] === undefined) return false;
    if (occupancy[s]! > 0) return false;
  }
  return true;
}

function parseReservationId(v: unknown): number | null {
  const n = typeof v === "number" ? v : parseInt(str(v), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const LIST_PAGE_SIZE_DEFAULT = 10;
const LIST_PAGE_SIZE_MAX = 50;

function parseListPage(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(str(v), 10);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function parseListPageSize(v: unknown): number {
  const n = typeof v === "number" ? v : parseInt(str(v), 10);
  if (!Number.isFinite(n) || n < 1) return LIST_PAGE_SIZE_DEFAULT;
  return Math.min(Math.floor(n), LIST_PAGE_SIZE_MAX);
}

function mapListRow(r: Record<string, unknown>) {
  const b = r.branches as { name?: string } | null;
  const c = r.companies as { name?: string } | null;
  const visitYmd = String(r.reservation_date ?? "").slice(0, 10);
  const st = r.status;
  const approved = isApprovedStatus(st) && String(st).trim() !== "반려";
  return {
    id: r.id,
    created_at: r.created_at,
    reservation_date: r.reservation_date,
    reservation_time: r.reservation_time,
    company_name: r.company_name,
    branch_id: r.branch_id,
    company_id: r.company_id,
    status: st,
    reservation_duration_minutes: r.reservation_duration_minutes,
    material_info: r.material_info,
    car_number_1: r.car_number_1,
    branch_name: b?.name ?? null,
    company_label: c?.name ?? r.company_name,
    can_edit: approved && isUserActionAllowed(visitYmd, "submit_or_update"),
    can_cancel: approved && isUserActionAllowed(visitYmd, "cancel"),
  };
}

/** 신규 접수(submit-reservation)와 동일하게 실방문자 이름만 jsonb 문자열로 저장 */
function normalizePersonInfoForDb(personInfo: string): string {
  const s = str(personInfo).trim();
  if (!s) return s;
  try {
    const parsed: unknown = JSON.parse(s);
    if (typeof parsed === "string") return parsed.trim();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (o.text != null) return String(o.text).trim();
    }
  } catch {
    /* 일반 텍스트 */
  }
  return s;
}

function personInfoToDisplay(pi: unknown): string {
  if (pi == null) return "";
  if (typeof pi === "string") {
    const s = pi.trim();
    if (s.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const o = parsed as Record<string, unknown>;
          if (o.text != null) return String(o.text);
        }
      } catch {
        /* 그대로 표시 */
      }
    }
    return pi;
  }
  if (typeof pi === "object" && !Array.isArray(pi)) {
    const o = pi as Record<string, unknown>;
    if (o.text != null) return String(o.text);
  }
  return typeof pi === "object" ? JSON.stringify(pi) : String(pi);
}

async function getMembershipCompanyIds(
  sbAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<number[]> {
  const { data, error } = await sbAdmin
    .from("user_company_memberships")
    .select("company_id")
    .eq("user_id", userId);
  if (error) throw new Error("멤버십 조회 오류: " + error.message);
  const ids: number[] = [];
  for (const row of data || []) {
    const cid = Number((row as { company_id?: unknown }).company_id);
    if (Number.isFinite(cid)) ids.push(cid);
  }
  return ids;
}

async function assertCanAccessReservation(
  sbAdmin: ReturnType<typeof createClient>,
  userId: string,
  companyId: number,
  branchId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data: profRow, error: profErr } = await sbAdmin
    .from("user_profiles")
    .select("is_master")
    .eq("id", userId)
    .maybeSingle();
  if (profErr) {
    return { ok: false, error: "계정 확인 오류: " + profErr.message };
  }
  if (profRow?.is_master === true) {
    const { data: coRow, error: coErr } = await sbAdmin
      .from("companies")
      .select("id")
      .eq("id", companyId)
      .eq("branch_id", branchId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    if (coErr) return { ok: false, error: "업체 확인 오류: " + coErr.message };
    if (!coRow) {
      return { ok: false, error: "선택한 업체·지사 조합이 올바르지 않습니다." };
    }
    return { ok: true };
  }

  const { data: memRows, error: memErr } = await sbAdmin
    .from("user_company_memberships")
    .select("company_id, companies!inner(branch_id)")
    .eq("user_id", userId)
    .eq("company_id", companyId)
    .limit(1);
  if (memErr) {
    return { ok: false, error: "예약 권한 확인 오류: " + memErr.message };
  }
  const mem = memRows?.[0] as { companies?: { branch_id?: number } } | undefined;
  const memBranchId = mem?.companies?.branch_id;
  if (!mem || Number(memBranchId) !== branchId) {
    return { ok: false, error: "이 예약에 대한 권한이 없습니다." };
  }
  return { ok: true };
}

async function validateSubmitFields(
  sbAdmin: ReturnType<typeof createClient>,
  body: SubmitBody,
  piiSecret: string,
  excludeReservationId: number | null,
): Promise<
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const contact = str(body.contact);
  if (!contact) {
    return { ok: false, error: "연락처를 입력해 주세요." };
  }

  const companyName = str(body.company_name);
  const branchId = typeof body.branch_id === "number"
    ? body.branch_id
    : parseInt(str(body.branch_id), 10);
  const companyId = typeof body.company_id === "number"
    ? body.company_id
    : parseInt(str(body.company_id), 10);
  if (!companyName || !Number.isFinite(branchId) || !Number.isFinite(companyId)) {
    return { ok: false, error: "관할 지사와 소속 업체를 선택해 주세요." };
  }

  const { data: coRow, error: coErr } = await sbAdmin
    .from("companies")
    .select("id")
    .eq("id", companyId)
    .eq("branch_id", branchId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (coErr) {
    return { ok: false, error: "업체 확인 오류: " + coErr.message };
  }
  if (!coRow) {
    return { ok: false, error: "선택한 업체·지사 조합이 올바르지 않습니다." };
  }

  const date = str(body.reservation_date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: "예약일이 올바르지 않습니다." };
  }

  const todayKst = kstYmd();
  const maxYmd = kstMaxBookYmdInclusive(todayKst);
  if (date > maxYmd) {
    return {
      ok: false,
      error:
        "예약은 오늘부터 7일 후까지(오늘 포함)만 가능합니다. 달력에서 선택 가능한 날짜를 다시 확인해 주세요.",
    };
  }
  if (!isUserActionAllowed(date, "submit_or_update")) {
    return { ok: false, error: deadlineErrorMessage("submit_or_update") };
  }

  let dupQ = sbAdmin
    .from("reservations")
    .select("id")
    .eq("reservation_date", date)
    .eq("company_id", companyId)
    .neq("status", "반려");
  if (excludeReservationId != null) {
    dupQ = dupQ.neq("id", excludeReservationId);
  }
  const { data: dupRows, error: dupErr } = await dupQ.limit(1);
  if (dupErr) {
    return { ok: false, error: "예약 중복 확인 오류: " + dupErr.message };
  }
  if (dupRows && dupRows.length > 0) {
    return {
      ok: false,
      error:
        "이미 해당 날짜에 동일 업체 예약 신청 내역이 존재합니다. (1일 1회 제한)",
    };
  }

  const timeSlot = str(body.reservation_time).substring(0, 5);
  if (!timeSlot) {
    return { ok: false, error: "예약 시간을 선택해 주세요." };
  }

  const car1 = str(body.car_number_1);
  const car2 = str(body.car_number_2);
  const materialInfo = str(body.material_info);
  const personInfo = str(body.person_info);
  if (!car1 || !materialInfo || !personInfo) {
    return { ok: false, error: "필수 입력 항목을 확인해 주세요." };
  }

  const vcRaw = body.vehicle_count;
  const vehicleCount = vcRaw === 2 || vcRaw === "2" ? 2 : 1;
  if (vehicleCount === 2 && !car2) {
    return {
      ok: false,
      error: "차량 대수를 2대로 선택하신 경우 차량번호 2도 입력해 주세요.",
    };
  }

  const effDurRaw = body.reservation_duration_minutes;
  const effDur = effDurRaw === 60 || effDurRaw === "60" ? 60 : 30;

  let visitorEmailPlain = body.visitor_email != null ? str(body.visitor_email) : "";

  let vehicleTonnage: number | null = null;
  if (body.vehicle_tonnage != null && str(body.vehicle_tonnage) !== "") {
    const n = parseFloat(str(body.vehicle_tonnage));
    if (!Number.isNaN(n) && n > 0) vehicleTonnage = n;
  }
  let vehicleTonnage2: number | null = null;
  if (body.vehicle_tonnage_2 != null && str(body.vehicle_tonnage_2) !== "") {
    const n2 = parseFloat(str(body.vehicle_tonnage_2));
    if (!Number.isNaN(n2) && n2 > 0) vehicleTonnage2 = n2;
  }
  if (vehicleTonnage == null) {
    return {
      ok: false,
      error: "차량 중량(톤)을 0보다 큰 값으로 입력해 주세요.",
    };
  }
  if (vehicleCount === 2) {
    if (vehicleTonnage2 == null) {
      return {
        ok: false,
        error:
          "차량 대수를 2대로 선택하신 경우 차량 중량 2도 0보다 큰 값으로 입력해 주세요.",
      };
    }
  } else {
    vehicleTonnage2 = null;
  }

  const recMinRaw = body.recommended_duration_minutes;
  const recMinutes = recMinRaw === 60 || recMinRaw === "60" ? 60 : 30;
  const durationMode = str(body.duration_mode) === "manual" ? "manual" : "auto";
  let recommendedReasons: string[] = [];
  const rr = body.recommended_reasons;
  if (Array.isArray(rr)) {
    recommendedReasons = rr.map((x) => str(x)).filter(Boolean);
  }

  let slotQ = sbAdmin
    .from("reservations")
    .select(
      "id, reservation_time, reservation_duration_minutes, person_info",
    )
    .eq("reservation_date", date)
    .neq("status", "반려");
  const { data: slotRows, error: slotErr } = await slotQ;
  if (slotErr) {
    return { ok: false, error: "예약 시간 확인 오류: " + slotErr.message };
  }

  const filtered = (slotRows || []).filter((r) => {
    const id = Number((r as { id?: unknown }).id);
    return excludeReservationId == null || id !== excludeReservationId;
  });

  const occ = buildOccupancyFromRows(filtered);
  if (overlapsSummerAfternoonBlackout(timeSlot, effDur, date)) {
    return {
      ok: false,
      error:
        "하절기(7월 1일~8월 31일)에는 13:00~14:00 구간과 겹치는 예약이 불가합니다. 다른 시간을 선택해 주세요.",
    };
  }
  if (overlapsTempSlotBlackout(timeSlot, effDur, date)) {
    return { ok: false, error: TEMP_SLOT_BLACKOUT_ERROR };
  }
  if (!slotRangeFits(occ, timeSlot, effDur, date)) {
    return {
      ok: false,
      error:
        "선택한 시간은 이미 예약이 있어 신청할 수 없습니다. 소요시간을 조정해주세요. (60분 예약 불가)",
    };
  }

  if (date === todayKst) {
    const nowHm = currentKstHHMM();
    if (timeSlot <= nowHm) {
      return {
        ok: false,
        error: "오늘 날짜는 현재 시각 이후 시간만 선택할 수 있습니다.",
      };
    }
  }

  const doc1 = body.doc_url_1 != null && str(body.doc_url_1) !== ""
    ? str(body.doc_url_1)
    : null;
  const doc2 = body.doc_url_2 != null && str(body.doc_url_2) !== ""
    ? str(body.doc_url_2)
    : null;

  let contactEnc: string;
  let visitorEmailEnc: string | null;
  try {
    contactEnc = await encryptPiiContact(piiSecret, contact);
    visitorEmailEnc = await encryptPiiEmail(piiSecret, visitorEmailPlain);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "개인정보 암호화 처리 오류: " + msg };
  }

  return {
    ok: true,
    row: {
      reservation_date: date,
      reservation_time: timeSlot,
      company_name: companyName,
      branch_id: branchId,
      company_id: companyId,
      visitor_email: visitorEmailEnc,
      car_number_1: car1,
      car_number_2: car2 || null,
      material_info: materialInfo,
      vehicle_count: vehicleCount,
      contact: contactEnc,
      person_info: normalizePersonInfoForDb(personInfo),
      vehicle_tonnage: vehicleTonnage,
      vehicle_tonnage_2: vehicleTonnage2,
      reservation_duration_minutes: effDur,
      duration_mode: durationMode,
      recommended_duration_minutes: recMinutes,
      recommended_reasons: recommendedReasons,
      doc_url_1: doc1,
      doc_url_2: doc2,
    },
  };
}

async function rowToClient(
  raw: Record<string, unknown>,
  piiSecret: string,
  branchesName?: string | null,
  companiesName?: string | null,
) {
  const contact = await decryptPiiField(
    raw.contact as string | null,
    piiSecret,
  );
  const visitorEmail = await decryptPiiField(
    raw.visitor_email as string | null,
    piiSecret,
  );
  return {
    ...raw,
    contact: contact ?? "",
    visitor_email: visitorEmail ?? "",
    person_info: personInfoToDisplay(raw.person_info),
    branches: branchesName != null ? { name: branchesName } : null,
    companies: companiesName != null ? { name: companiesName } : null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const piiSecret = Deno.env.get("PII_ENCRYPTION_SECRET") ?? "";
  if (!piiSecret || piiSecret.length < 16) {
    return json(503, {
      ok: false,
      error: "PII_ENCRYPTION_SECRET 미설정 (Edge Function Secrets)",
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceKey) {
    return json(503, { ok: false, error: "Server misconfigured" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { ok: false, error: "로그인이 필요합니다." });
  }

  let body: ReqBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  const action = str(body.action) as Action;
  if (!["list", "get", "update", "delete"].includes(action)) {
    return json(400, { ok: false, error: "action은 list, get, update, delete 중 하나여야 합니다." });
  }

  const sb = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
  if (userErr || !userData.user) {
    return json(401, { ok: false, error: "로그인이 필요합니다." });
  }
  const userId = userData.user.id;

  const sbAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let companyIds: number[];
  try {
    companyIds = await getMembershipCompanyIds(sbAdmin, userId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(200, { ok: false, error: msg });
  }
  if (!companyIds.length) {
    if (action === "list") {
      const page = parseListPage(body.page);
      const pageSize = parseListPageSize(body.page_size);
      return json(200, {
        ok: true,
        items: [],
        total: 0,
        page,
        page_size: pageSize,
        total_pages: 0,
      });
    }
    return json(200, {
      ok: false,
      error: "소속 업체 정보가 없습니다. 관리자에게 문의해 주세요.",
    });
  }

  if (action === "list") {
    const page = parseListPage(body.page);
    const pageSize = parseListPageSize(body.page_size);
    const { count, error: countErr } = await sbAdmin
      .from("reservations")
      .select("id", { count: "exact", head: true })
      .in("company_id", companyIds);
    if (countErr) {
      return json(200, { ok: false, error: "목록 건수 조회 오류: " + countErr.message });
    }
    const total = count ?? 0;
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 0;
    const safePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
    const from = (safePage - 1) * pageSize;
    const to = from + pageSize - 1;

    const { data: rows, error } = await sbAdmin
      .from("reservations")
      .select(
        "id, created_at, reservation_date, reservation_time, company_name, branch_id, company_id, status, reservation_duration_minutes, material_info, car_number_1, branches(name), companies(name)",
      )
      .in("company_id", companyIds)
      .order("reservation_date", { ascending: false })
      .order("reservation_time", { ascending: false })
      .range(from, to);
    if (error) {
      return json(200, { ok: false, error: "목록 조회 오류: " + error.message });
    }
    const items = (rows || []).map((r) => mapListRow(r as Record<string, unknown>));
    return json(200, {
      ok: true,
      items,
      total,
      page: safePage,
      page_size: pageSize,
      total_pages: totalPages,
    });
  }

  const resId = parseReservationId(body.reservation_id);
  if (!resId) {
    return json(400, { ok: false, error: "유효한 reservation_id가 필요합니다." });
  }

  const { data: existing, error: exErr } = await sbAdmin
    .from("reservations")
    .select("*")
    .eq("id", resId)
    .maybeSingle();
  if (exErr) {
    return json(200, { ok: false, error: "예약 조회 오류: " + exErr.message });
  }
  if (!existing) {
    return json(200, { ok: false, error: "예약을 찾을 수 없습니다." });
  }

  const ex = existing as Record<string, unknown>;
  const exCompanyId = Number(ex.company_id);
  if (!companyIds.includes(exCompanyId)) {
    return json(200, { ok: false, error: "이 예약에 대한 권한이 없습니다." });
  }

  const exBranchId = Number(ex.branch_id);

  if (action === "get") {
    const { data: bRow } = await sbAdmin
      .from("branches")
      .select("name")
      .eq("id", exBranchId)
      .maybeSingle();
    const { data: cRow } = await sbAdmin
      .from("companies")
      .select("name")
      .eq("id", exCompanyId)
      .maybeSingle();
    const row = await rowToClient(
      ex,
      piiSecret,
      (bRow as { name?: string } | null)?.name ?? null,
      (cRow as { name?: string } | null)?.name ?? ex.company_name as string,
    );
    return json(200, {
      ok: true,
      row,
      status: str(ex.status) || "승인",
      can_edit: isApprovedStatus(ex.status) &&
        isUserActionAllowed(String(ex.reservation_date).slice(0, 10), "submit_or_update"),
      can_cancel: isApprovedStatus(ex.status) &&
        isUserActionAllowed(String(ex.reservation_date).slice(0, 10), "cancel"),
    });
  }

  if (action === "delete") {
    const visitYmd = String(ex.reservation_date).slice(0, 10);
    if (!isApprovedStatus(ex.status)) {
      return json(200, {
        ok: false,
        error: "확정(승인)된 예약만 신청 취소(삭제)할 수 있습니다.",
      });
    }
    if (!isUserActionAllowed(visitYmd, "cancel")) {
      return json(200, { ok: false, error: deadlineErrorMessage("cancel") });
    }
    const access = await assertCanAccessReservation(
      sbAdmin,
      userId,
      exCompanyId,
      exBranchId,
    );
    if (!access.ok) {
      return json(200, { ok: false, error: access.error });
    }
    const { error: delErr } = await sbAdmin
      .from("reservations")
      .delete()
      .eq("id", resId)
      .in("status", ["승인", "대기"]);
    if (delErr) {
      return json(200, { ok: false, error: "삭제 오류: " + delErr.message });
    }
    return json(200, { ok: true });
  }

  if (action === "update") {
    const visitYmd = String(ex.reservation_date).slice(0, 10);
    if (!isApprovedStatus(ex.status)) {
      return json(200, {
        ok: false,
        error: "확정(승인)된 예약만 수정할 수 있습니다.",
      });
    }
    if (!isUserActionAllowed(visitYmd, "submit_or_update")) {
      return json(200, { ok: false, error: deadlineErrorMessage("submit_or_update") });
    }
    const access = await assertCanAccessReservation(
      sbAdmin,
      userId,
      typeof body.company_id === "number"
        ? body.company_id
        : parseInt(str(body.company_id), 10) || exCompanyId,
      typeof body.branch_id === "number"
        ? body.branch_id
        : parseInt(str(body.branch_id), 10) || exBranchId,
    );
    if (!access.ok) {
      return json(200, { ok: false, error: access.error });
    }

    const validated = await validateSubmitFields(
      sbAdmin,
      body,
      piiSecret,
      resId,
    );
    if (!validated.ok) {
      return json(200, { ok: false, error: validated.error });
    }

    const patch = validated.row;
    const { error: updErr } = await sbAdmin
      .from("reservations")
      .update(patch)
      .eq("id", resId)
      .in("status", ["승인", "대기"]);
    if (updErr) {
      return json(200, { ok: false, error: "수정 오류: " + updErr.message });
    }
    return json(200, { ok: true });
  }

  return json(400, { ok: false, error: "Unknown action" });
});
