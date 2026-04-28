import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

/** 대시보드 단일 파일 배포 시 `_shared` 미포함으로 인한 번들 오류 방지 (로직은 _shared/booking_submit_block_ip.ts 와 동일) */
function getClientSourceIp(req: Request): string {
  const h = (name: string) => (req.headers.get(name) ?? "").trim();
  const cf = h("cf-connecting-ip");
  if (cf) return cf;
  const fly = h("fly-client-ip");
  if (fly) return fly;
  const tc = h("true-client-ip");
  if (tc) return tc;
  const xr = h("x-real-ip");
  if (xr) return xr;
  const xff = h("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "";
}

type BookingSubmitIpCheckResult =
  | { ok: true }
  | { ok: false; message: string };

function parseBlockedList(): string[] | "off" {
  const raw = (Deno.env.get("BOOKING_BLOCKED_SOURCE_IPS") ?? "").trim();
  if (raw.toLowerCase() === "off") return "off";
  if (!raw) return "off";
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : "off";
}

function checkBookingSubmitBlockedBySourceIp(
  req: Request,
): BookingSubmitIpCheckResult {
  const mode = parseBlockedList();
  if (mode === "off" || mode.length === 0) return { ok: true };

  const ip = getClientSourceIp(req);
  if (!ip) return { ok: true };

  if (mode.includes(ip)) {
    return {
      ok: false,
      message:
        "사내 인터넷망에서는 예약 신청을 완료할 수 없습니다. 외부망에서 다시 시도해주세요.",
    };
  }
  return { ok: true };
}

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

/** KST 기준 YYYY-MM-DD */
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

/** KST 달력 기준 ymd + 7일 (클라이언트 reservationYmdMaxInclusiveFromTodayStr 와 동일) */
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
  if (!BOOKABLE_SLOTS.includes(startSlot)) {
    return false;
  }
  const sm = slotStartToMinutes(startSlot);
  if (sm == null) return false;
  const end = sm + durationMins;
  if (end > DAY_END_MIN) return false;
  if (sm < LUNCH_END_MIN && end > LUNCH_START_MIN) return false;
  if (overlapsSummerAfternoonBlackout(startSlot, durationMins, reservationYmd)) {
    return false;
  }
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
  if (!supabaseUrl || !anonKey) {
    return json(503, { ok: false, error: "Server misconfigured" });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return json(401, { ok: false, error: "로그인이 필요합니다." });
  }

  let body: SubmitBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  const sb = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data: userData, error: userErr } = await sb.auth.getUser(jwt);
  if (userErr || !userData.user) {
    return json(401, { ok: false, error: "로그인이 필요합니다." });
  }

  const bookingIp = checkBookingSubmitBlockedBySourceIp(req);
  if (!bookingIp.ok) {
    return json(200, { ok: false, error: bookingIp.message });
  }

  const contact = str(body.contact);
  if (!contact) {
    return json(200, { ok: false, error: "연락처를 입력해 주세요." });
  }

  const companyName = str(body.company_name);
  const branchId = typeof body.branch_id === "number"
    ? body.branch_id
    : parseInt(str(body.branch_id), 10);
  const companyId = typeof body.company_id === "number"
    ? body.company_id
    : parseInt(str(body.company_id), 10);
  if (!companyName || !Number.isFinite(branchId) || !Number.isFinite(companyId)) {
    return json(200, {
      ok: false,
      error: "관할 지사와 소속 업체를 선택해 주세요.",
    });
  }

  const date = str(body.reservation_date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json(200, { ok: false, error: "예약일이 올바르지 않습니다." });
  }

  const todayKst = kstYmd();
  const maxYmd = kstMaxBookYmdInclusive(todayKst);
  if (date < todayKst || date > maxYmd) {
    return json(200, {
      ok: false,
      error:
        "예약은 오늘부터 7일 후까지(오늘 포함)만 가능합니다. 달력에서 선택 가능한 날짜를 다시 확인해 주세요.",
    });
  }

  const { data: dupCompany, error: dupErr } = await sb
    .from("reservations")
    .select("id")
    .eq("reservation_date", date)
    .eq("company_id", companyId)
    .neq("status", "반려")
    .limit(1);
  if (dupErr) {
    return json(200, { ok: false, error: "예약 중복 확인 오류: " + dupErr.message });
  }
  if (dupCompany && dupCompany.length > 0) {
    return json(200, {
      ok: false,
      error:
        "이미 해당 날짜에 동일 업체 예약 신청 내역이 존재합니다. (1일 1회 제한)",
    });
  }

  const timeSlot = str(body.reservation_time).substring(0, 5);
  if (!timeSlot) {
    return json(200, { ok: false, error: "예약 시간을 선택해 주세요." });
  }

  const car1 = str(body.car_number_1);
  const car2 = str(body.car_number_2);
  const materialInfo = str(body.material_info);
  const personInfo = str(body.person_info);
  if (!car1 || !materialInfo || !personInfo) {
    return json(200, { ok: false, error: "필수 입력 항목을 확인해 주세요." });
  }

  const vcRaw = body.vehicle_count;
  const vehicleCount = vcRaw === 2 || vcRaw === "2" ? 2 : 1;
  if (vehicleCount === 2 && !car2) {
    return json(200, {
      ok: false,
      error: "차량 대수를 2대로 선택하신 경우 차량번호 2도 입력해 주세요.",
    });
  }

  const effDurRaw = body.reservation_duration_minutes;
  const effDur = effDurRaw === 60 || effDurRaw === "60" ? 60 : 30;

  let visitorEmailPlain = body.visitor_email != null ? str(body.visitor_email) : "";
  if (visitorEmailPlain === "") visitorEmailPlain = "";

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
    return json(200, {
      ok: false,
      error: "차량 중량(톤)을 0보다 큰 값으로 입력해 주세요.",
    });
  }
  if (vehicleCount === 2) {
    if (vehicleTonnage2 == null) {
      return json(200, {
        ok: false,
        error: "차량 대수를 2대로 선택하신 경우 차량 중량 2도 0보다 큰 값으로 입력해 주세요.",
      });
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

  const { data: slotCheckRows, error: slotCheckErr } = await sb
    .from("reservations")
    .select(
      "reservation_time, car_number_1, car_number_2, reservation_duration_minutes, person_info",
    )
    .eq("reservation_date", date)
    .neq("status", "반려");
  if (slotCheckErr) {
    return json(200, {
      ok: false,
      error: "예약 시간 확인 오류: " + slotCheckErr.message,
    });
  }

  const occSubmit = buildOccupancyFromRows(slotCheckRows || []);
  if (overlapsSummerAfternoonBlackout(timeSlot, effDur, date)) {
    return json(200, {
      ok: false,
      error:
        "하절기(7월 1일~8월 31일)에는 13:00~14:00 구간과 겹치는 예약이 불가합니다. 다른 시간을 선택해 주세요.",
    });
  }
  if (!slotRangeFits(occSubmit, timeSlot, effDur, date)) {
    return json(200, {
      ok: false,
      error:
        "선택한 시간은 이미 예약이 있어 신청할 수 없습니다. 소요시간을 조정해주세요. (60분 예약 불가)",
    });
  }

  if (date === todayKst) {
    const nowHm = currentKstHHMM();
    if (timeSlot <= nowHm) {
      return json(200, {
        ok: false,
        error: "오늘 날짜는 현재 시각 이후 시간만 선택할 수 있습니다.",
      });
    }
  }

  const doc1 =
    body.doc_url_1 != null && str(body.doc_url_1) !== "" ? str(body.doc_url_1) : null;
  const doc2 =
    body.doc_url_2 != null && str(body.doc_url_2) !== "" ? str(body.doc_url_2) : null;

  let contactEnc: string;
  let visitorEmailEnc: string | null;
  try {
    contactEnc = await encryptPiiContact(piiSecret, contact);
    visitorEmailEnc = await encryptPiiEmail(piiSecret, visitorEmailPlain);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(200, { ok: false, error: "개인정보 암호화 처리 오류: " + msg });
  }

  const { data: dupBeforeInsert, error: dupInsErr } = await sb
    .from("reservations")
    .select("id")
    .eq("reservation_date", date)
    .eq("company_id", companyId)
    .neq("status", "반려")
    .limit(1);
  if (dupInsErr) {
    return json(200, { ok: false, error: "예약 중복 확인 오류: " + dupInsErr.message });
  }
  if (dupBeforeInsert && dupBeforeInsert.length > 0) {
    return json(200, {
      ok: false,
      error:
        "이미 해당 날짜에 동일 업체 예약 신청 내역이 존재합니다. (1일 1회 제한)",
    });
  }

  const insertRow = {
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
    person_info: personInfo,
    vehicle_tonnage: vehicleTonnage,
    vehicle_tonnage_2: vehicleTonnage2,
    reservation_duration_minutes: effDur,
    duration_mode: durationMode,
    recommended_duration_minutes: recMinutes,
    recommended_reasons: recommendedReasons,
    doc_url_1: doc1,
    doc_url_2: doc2,
    doc_url_3: null,
    status: "대기",
  };

  const { error: insertErr } = await sb.from("reservations").insert(insertRow);
  if (insertErr) {
    return json(200, {
      ok: false,
      error: "신청 오류: " + insertErr.message,
    });
  }

  return json(200, { ok: true });
});
