import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { checkAdminSourceIp } from "../_shared/admin_source_ip.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-secret, x-supabase-api-version, prefer",
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
  }

  const ipCheck = checkAdminSourceIp(req);
  if (!ipCheck.ok) {
    return json(403, { ok: false, error: ipCheck.message });
  }

  const adminNotify = Deno.env.get("ADMIN_NOTIFY_SECRET") ?? "";
  if (!adminNotify) {
    return json(503, { ok: false, error: "ADMIN_NOTIFY_SECRET 미설정" });
  }

  let body: { admin_secret?: string; user_id?: string };
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

  const userId = body.user_id != null ? String(body.user_id).trim() : "";
  if (!userId || !UUID_RE.test(userId)) {
    return json(400, { ok: false, error: "유효한 user_id(UUID)가 필요합니다." });
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!serviceKey || !supabaseUrl) {
    return json(503, { ok: false, error: "Server misconfigured" });
  }

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: profRow, error: profErr } = await sb
      .from("user_profiles")
      .select("id, is_master")
      .eq("id", userId)
      .maybeSingle();
    if (profErr) throw profErr;

    if (profRow?.is_master === true) {
      return json(403, {
        ok: false,
        error: "마스터 계정은 삭제할 수 없습니다.",
      });
    }

    const { error: memErr } = await sb
      .from("user_company_memberships")
      .delete()
      .eq("user_id", userId);
    if (memErr) throw memErr;

    if (profRow) {
      const { error: profileDelErr } = await sb
        .from("user_profiles")
        .delete()
        .eq("id", userId);
      if (profileDelErr) throw profileDelErr;
    }

    const { error: authDelErr } = await sb.auth.admin.deleteUser(userId);
    if (authDelErr) {
      if (!profRow) {
        throw authDelErr;
      }
      const msg = authDelErr.message ?? String(authDelErr);
      if (!/not found|user not found/i.test(msg)) {
        throw authDelErr;
      }
    }

    return json(200, { ok: true, user_id: userId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg });
  }
});
