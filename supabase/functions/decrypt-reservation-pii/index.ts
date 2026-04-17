import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-secret, x-supabase-api-version, prefer",
};

const PII_PREFIX = "enc:v1:";
const PBKDF2_SALT = new Uint8Array([
  0x72, 0x65, 0x73, 0x76, 0x2d, 0x70, 0x69, 0x69,
  0x2d, 0x6b, 0x65, 0x70, 0x63, 0x6f, 0x2d, 0x31,
]);
const PBKDF2_ITERS = 210000;

const MAX_ITEMS = 800;

function timingSafeEqualUtf8(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

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

async function decryptPiiField(
  stored: string | null | undefined,
  secret: string,
): Promise<string | null | undefined> {
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

type Item = { contact?: unknown; visitor_email?: unknown };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const adminNotify = Deno.env.get("ADMIN_NOTIFY_SECRET") ?? "";
  const piiSecret = Deno.env.get("PII_ENCRYPTION_SECRET") ?? "";
  if (!adminNotify) {
    return json(503, { ok: false, error: "ADMIN_NOTIFY_SECRET 미설정" });
  }
  if (!piiSecret || piiSecret.length < 16) {
    return json(503, { ok: false, error: "PII_ENCRYPTION_SECRET 미설정" });
  }

  let body: { admin_secret?: string; items?: Item[] };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  const fromBody = body.admin_secret != null ? String(body.admin_secret) : "";
  const clientSecret = fromBody !== ""
    ? fromBody
    : (req.headers.get("x-admin-secret") ?? "");
  if (!timingSafeEqualUtf8(adminNotify, clientSecret)) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  const items = body.items;
  if (!Array.isArray(items)) {
    return json(400, { ok: false, error: "items 배열이 필요합니다." });
  }
  if (items.length > MAX_ITEMS) {
    return json(400, {
      ok: false,
      error: `한 번에 최대 ${MAX_ITEMS}건까지 복호화할 수 있습니다.`,
    });
  }

  const out: Array<{ contact: string | null; visitor_email: string | null }> =
    [];
  for (const it of items) {
    const c = await decryptPiiField(it.contact as string | null, piiSecret);
    const ve = it.visitor_email != null
      ? await decryptPiiField(it.visitor_email as string | null, piiSecret)
      : null;
    out.push({
      contact: c == null ? null : String(c),
      visitor_email: ve == null ? null : String(ve),
    });
  }

  return json(200, { ok: true, items: out });
});
