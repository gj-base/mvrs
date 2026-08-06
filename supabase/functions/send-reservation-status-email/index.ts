import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const PII_PREFIX = "enc:v1:";
const PBKDF2_SALT = new Uint8Array([
  0x72, 0x65, 0x73, 0x76, 0x2d, 0x70, 0x69, 0x69,
  0x2d, 0x6b, 0x65, 0x70, 0x63, 0x6f, 0x2d, 0x31,
]);
const PBKDF2_ITERS = 210000;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getPiiKey(secret: string): Promise<CryptoKey> {
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
    ["decrypt"],
  );
}

function str(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

/** 동일 상태(승인/반려)에 대한 중복 메일만 차단. 승인 후 반려 등 상태 변경 시 재발송 허용 */
function isStatusMailAlreadySent(
  row: {
    status_notification_sent?: boolean | null;
    status_notified_for?: string | null;
  },
  st: string,
): boolean {
  const notifiedFor = str(row.status_notified_for);
  if (notifiedFor && notifiedFor === st) return true;
  if (!notifiedFor && row.status_notification_sent === true && st === "승인") {
    return true;
  }
  return false;
}

function resolveVehicleCountFromRow(row: {
  vehicle_count?: number | string | null;
  material_info?: string | null;
}): 1 | 2 {
  const v = row.vehicle_count;
  if (v === 2 || v === "2") return 2;
  if (v === 1 || v === "1") return 1;
  const m = str(row.material_info).match(/\[차량대수:([12])대\]/);
  if (m) return parseInt(m[1]!, 10) === 2 ? 2 : 1;
  return 1;
}

function stripLegacyVehicleCountFromMaterialInfo(text: unknown): string {
  const s = str(text).replace(/^\[차량대수:[12]대\]\s*/, "");
  return s || "-";
}

function utf8ToBase64(b: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < b.length; i++) binary += String.fromCharCode(b[i]!);
  return btoa(binary);
}

/**
 * RFC 2047 encoded-word(s), B encoding.
 * base64 문자열을 고정 길이로 자르면 UTF-8 시퀀스가 끊겨 제목 중간이 깨지므로,
 * 문자(코드 포인트) 단위로 앞에서부터 붙여 각 덩어리가 `maxB64Payload` 이하가 되게 나눕니다.
 */
function rfc2047B64Words(utf8Text: string, maxB64Payload = 60): string {
  const chars = [...utf8Text];
  const words: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let best = start;
    for (let e = start + 1; e <= chars.length; e++) {
      const slice = chars.slice(start, e).join("");
      const b64 = utf8ToBase64(new TextEncoder().encode(slice));
      if (b64.length <= maxB64Payload) best = e;
      else break;
    }
    if (best === start) best = start + 1;
    const piece = chars.slice(start, best).join("");
    words.push(`=?UTF-8?B?${utf8ToBase64(new TextEncoder().encode(piece))}?=`);
    start = best;
  }
  return words.join(" ");
}

async function decryptPiiField(
  stored: string | null,
  secret: string,
): Promise<string | null> {
  if (stored == null || stored === "") return stored;
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
  const key = await getPiiKey(secret);
  try {
    const buf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ct,
    );
    return new TextDecoder().decode(buf);
  } catch {
    return s;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function readSmtpResponse(conn: Deno.TlsConn): Promise<string[]> {
  const buf = new Uint8Array(4096);
  let queue = "";
  const lines: string[] = [];
  while (true) {
    while (true) {
      const p = queue.indexOf("\r\n");
      if (p === -1) break;
      const line = queue.slice(0, p);
      queue = queue.slice(p + 2);
      lines.push(line);
      if (line.length >= 4 && line[3] === " ") return lines;
    }
    const n = await conn.read(buf);
    if (n === null) throw new Error("SMTP connection closed");
    if (n === 0) continue;
    queue += dec.decode(buf.subarray(0, n));
  }
}

async function smtpWriteLine(conn: Deno.TlsConn, line: string) {
  await conn.write(enc.encode(line + "\r\n"));
}

function extractEmail(addr: string): string {
  const m = addr.match(/<([^>\s]+)>/);
  if (m) return m[1]!.trim();
  return addr.trim();
}

/** From: 헤더(한글 표시명은 RFC 2047). SMTP MAIL FROM은 Gmail 계정만 허용되는 경우가 많음 */
function buildFromForSmtp(
  mailFromEnv: string,
  gmailAccount: string,
): { fromHeader: string; envelopeFrom: string } {
  const envelopeFrom = extractEmail(gmailAccount);
  let display = "예약시스템";
  let headerEmail = envelopeFrom;
  const raw = mailFromEnv.trim();
  if (raw.includes("<")) {
    const m = raw.match(/^(.+)<([^>]+)>\s*$/);
    if (m) {
      display = m[1]!.trim().replace(/^"|"$/g, "");
      headerEmail = m[2]!.trim();
    }
  } else if (raw.includes("@")) {
    headerEmail = extractEmail(raw);
  }
  const asciiOnly = /^[\x00-\x7f]+$/.test(display);
  const fromHeader = asciiOnly
    ? `"${display.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${headerEmail}>`
    : `${rfc2047B64Words(display)} <${headerEmail}>`;
  return { fromHeader, envelopeFrom };
}

/** DATA 구간: 줄 단위 CRLF + dot-stuffing, UTF-8 본문 */
function encode8bitBody(text: string): Uint8Array {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const chunks: Uint8Array[] = [];
  for (const line of normalized.split("\n")) {
    const out = line.startsWith(".") ? "." + line : line;
    chunks.push(enc.encode(out + "\r\n"));
  }
  const total = chunks.reduce((s, u) => s + u.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Gmail SMTP: 단일 text/plain, charset=UTF-8, 8bit (라이브러리 없이 직접 MIME)
 */
async function sendGmailPlainText(opts: {
  gmailUser: string;
  gmailPass: string;
  fromHeader: string;
  envelopeFrom: string;
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const conn = await Deno.connectTls({
    hostname: "smtp.gmail.com",
    port: 465,
  });
  try {
    let lines = await readSmtpResponse(conn);
    if (!lines[0]?.startsWith("220")) {
      throw new Error("SMTP: " + lines.join(" | "));
    }

    await smtpWriteLine(conn, "EHLO supabase-edge");
    lines = await readSmtpResponse(conn);
    const joined = lines.join("\n");
    if (!joined.includes("250")) throw new Error("EHLO failed: " + joined);

    await smtpWriteLine(conn, "AUTH LOGIN");
    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("334"))) throw new Error("AUTH LOGIN rejected");

    await smtpWriteLine(conn, btoa(opts.gmailUser));
    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("334"))) throw new Error("AUTH user rejected");

    await smtpWriteLine(conn, btoa(opts.gmailPass));
    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("235"))) throw new Error("AUTH password rejected");

    await smtpWriteLine(conn, `MAIL FROM:<${opts.envelopeFrom}>`);
    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("250"))) throw new Error("MAIL FROM failed: " + lines.join(" "));

    const toAddr = extractEmail(opts.to);
    await smtpWriteLine(conn, `RCPT TO:<${toAddr}>`);
    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("250"))) throw new Error("RCPT TO failed: " + lines.join(" "));

    await smtpWriteLine(conn, "DATA");
    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("354"))) throw new Error("DATA not accepted: " + lines.join(" "));

    const subjHdr = rfc2047B64Words(opts.subject);
    const headerBlock =
      `From: ${opts.fromHeader}\r\n` +
      `To: ${opts.to}\r\n` +
      `Subject: ${subjHdr}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/plain; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: 8bit\r\n`;

    await conn.write(enc.encode(headerBlock + "\r\n"));
    await conn.write(encode8bitBody(opts.body));
    await conn.write(enc.encode("\r\n.\r\n"));

    lines = await readSmtpResponse(conn);
    if (!lines.some((l) => l.startsWith("250"))) {
      throw new Error("Message rejected: " + lines.join(" "));
    }

    await smtpWriteLine(conn, "QUIT");
    await readSmtpResponse(conn);
  } finally {
    try {
      conn.close();
    } catch {
      /* ignore */
    }
  }
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-secret",
};

/** HTTP 헤더는 ISO-8859-1 제약으로 비밀번호(한글 등) 전달이 깨질 수 있어, 본문 `admin_secret`을 우선합니다. */
function timingSafeEqualUtf8(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: {
    reservation_id?: string;
    admin_secret?: string;
    /** 클라이언트가 방금 반영한 승인/반려(읽기 지연·공백 대비) */
    notify_for_status?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const adminNotify = Deno.env.get("ADMIN_NOTIFY_SECRET") ?? "";
  const fromBody =
    body.admin_secret != null ? String(body.admin_secret) : "";
  const clientSecret =
    fromBody !== ""
      ? fromBody
      : (req.headers.get("x-admin-secret") ?? "");
  if (!adminNotify || !timingSafeEqualUtf8(adminNotify, clientSecret)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const piiSecret = Deno.env.get("PII_ENCRYPTION_SECRET") ?? "";
  const gmailUser = Deno.env.get("GMAIL_SMTP_USER") ?? "";
  const gmailPass = Deno.env.get("GMAIL_SMTP_APP_PASSWORD") ?? "";
  const mailFromRaw = (Deno.env.get("MAIL_FROM") ?? gmailUser).trim();

  if (!piiSecret || piiSecret.length < 16) {
    return new Response(
      JSON.stringify({ error: "PII_ENCRYPTION_SECRET is not configured" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (!gmailUser || !gmailPass) {
    return new Response(
      JSON.stringify({
        error:
          "GMAIL_SMTP_USER 또는 GMAIL_SMTP_APP_PASSWORD 미설정 (Function Secrets)",
      }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const reservationId = body.reservation_id?.trim();
  if (!reservationId) {
    return new Response(JSON.stringify({ error: "reservation_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(supabaseUrl, serviceKey);
  const notifyWant = str(body.notify_for_status);
  const wantRetry =
    notifyWant === "승인" || notifyWant === "반려" ? 12 : 1;
  type ResRow = {
    id: string;
    status: string | null;
    status_notification_sent: boolean | null;
    status_notified_for: string | null;
    visitor_email: string | null;
    company_name: string | null;
    reservation_date: string | null;
    reservation_time: string | null;
    car_number_1: string | null;
    car_number_2: string | null;
    material_info: string | null;
    vehicle_count?: number | string | null;
    branches: { name?: string } | null;
  };
  let row: ResRow | null = null;
  let lastRawStatus = "";
  for (let attempt = 0; attempt < wantRetry; attempt++) {
    const { data: fetched, error: selErr } = await sb
      .from("reservations")
      .select(
        "id, status, status_notification_sent, status_notified_for, visitor_email, company_name, reservation_date, reservation_time, car_number_1, car_number_2, material_info, vehicle_count, branches(name)",
      )
      .eq("id", reservationId)
      .maybeSingle();

    if (selErr) {
      return new Response(JSON.stringify({ error: selErr.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!fetched) {
      return new Response(JSON.stringify({ error: "Reservation not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const statusNorm = str(fetched.status);
    lastRawStatus = statusNorm || String(fetched.status ?? "");
    if (statusNorm === "승인" || statusNorm === "반려") {
      row = { ...fetched, status: statusNorm } as ResRow;
      break;
    }
    if (attempt + 1 < wantRetry) {
      await new Promise((r) => setTimeout(r, 250));
    } else {
      row = fetched as ResRow;
    }
  }

  if (!row) {
    return new Response(JSON.stringify({ error: "Reservation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const st = str(row.status);
  if (st !== "승인" && st !== "반려") {
    return new Response(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason: "status not 승인/반려",
        db_status: lastRawStatus || st || null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (isStatusMailAlreadySent(row, st)) {
    return new Response(
      JSON.stringify({ ok: true, skipped: true, reason: "already sent for " + st }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const emailPlain = await decryptPiiField(row.visitor_email, piiSecret);
  const to = emailPlain && String(emailPlain).includes("@")
    ? String(emailPlain).trim()
    : null;
  if (!to) {
    return new Response(
      JSON.stringify({ error: "No valid visitor email on record" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const dateStr = row.reservation_date
    ? String(row.reservation_date).slice(0, 10)
    : "-";
  const timeStr = row.reservation_time
    ? String(row.reservation_time).trim().slice(0, 5)
    : "-";

  const branchRow = row.branches as { name?: string } | null | undefined;
  const branchName = str(branchRow?.name) || "-";
  const companyName = str(row.company_name) || "-";
  const salutation = companyName !== "-" ? companyName : "귀하";
  const cars = [str(row.car_number_1), str(row.car_number_2)].filter(Boolean)
    .join(" / ") || "-";
  const vehicleCountN = resolveVehicleCountFromRow(row);
  const vehicleCountLabel = vehicleCountN === 2 ? "2대" : "1대";
  const material = stripLegacyVehicleCountFromMaterialInfo(row.material_info);

  const subject =
    row.status === "승인"
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

  const { fromHeader, envelopeFrom } = buildFromForSmtp(mailFromRaw, gmailUser);

  try {
    await sendGmailPlainText({
      gmailUser,
      gmailPass,
      fromHeader,
      envelopeFrom,
      to,
      subject,
      body: textBody,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(
      JSON.stringify({ error: "SMTP send failed", detail: msg.slice(0, 500) }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const { error: upErr } = await sb
    .from("reservations")
    .update({ status_notification_sent: true, status_notified_for: st })
    .eq("id", reservationId);

  if (upErr) {
    return new Response(
      JSON.stringify({
        error: "Mail sent but DB update failed: " + upErr.message,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
