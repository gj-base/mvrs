import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { checkAdminSourceIp } from "../_shared/admin_source_ip.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-secret, x-supabase-api-version, prefer",
};

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function deleteUserAccount(
  sb: ReturnType<typeof createClient>,
  userId: string,
) {
  const { data: profRow, error: profErr } = await sb
    .from("user_profiles")
    .select("id, is_master")
    .eq("id", userId)
    .maybeSingle();
  if (profErr) throw profErr;

  if (profRow?.is_master === true) {
    return { status: 403, body: { ok: false, error: "마스터 계정은 삭제할 수 없습니다." } };
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

  return { status: 200, body: { ok: true, user_id: userId } };
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "Invalid JSON" });
  }

  const adminNotify = Deno.env.get("ADMIN_NOTIFY_SECRET") ?? "";
  const fromBody =
    body.admin_secret != null ? String(body.admin_secret) : "";
  const clientSecret =
    fromBody !== ""
      ? fromBody
      : (req.headers.get("x-admin-secret") ?? "");
  if (!adminNotify || !timingSafeEqualUtf8(adminNotify, clientSecret)) {
    return json(401, { ok: false, error: "Unauthorized" });
  }

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!serviceKey || !supabaseUrl) {
    return json(503, { ok: false, error: "Server misconfigured" });
  }

  const action = str(body.action);
  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "blocked_add") {
      const blockedDate = str(body.blocked_date).slice(0, 10);
      const reasonRaw = body.reason != null ? String(body.reason) : "";
      const reason = reasonRaw.trim().slice(0, 500) || null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(blockedDate)) {
        return json(400, { ok: false, error: "blocked_date 형식이 올바르지 않습니다." });
      }
      const { data: ins, error: insErr } = await sb
        .from("global_blocked_dates")
        .insert({ blocked_date: blockedDate, reason })
        .select("id, blocked_date, reason")
        .single();
      if (insErr) {
        if (String(insErr.message || "").includes("duplicate") || insErr.code === "23505") {
          return json(409, { ok: false, error: "이미 등록된 날짜입니다." });
        }
        throw insErr;
      }
      return json(200, { ok: true, row: ins });
    }

    if (action === "blocked_delete") {
      const id = str(body.id);
      if (!id) {
        return json(400, { ok: false, error: "id가 필요합니다." });
      }
      const scope = str(body.blocked_scope) === "branch" ? "branch" : "global";
      const table = scope === "branch" ? "branch_blocked_dates" : "global_blocked_dates";
      const { error: delErr } = await sb.from(table).delete().eq("id", id);
      if (delErr) throw delErr;
      return json(200, { ok: true });
    }

    if (action === "popup_save") {
      const isEnabled = body.is_enabled === true || body.is_enabled === "true";
      const title = str(body.title).slice(0, 200);
      const popupBody = str(body.body).slice(0, 8000);
      const now = new Date().toISOString();
      const idRaw = body.id;
      const hasId =
        idRaw != null &&
        idRaw !== "" &&
        !Number.isNaN(Number(idRaw)) &&
        Number.isFinite(Number(idRaw));
      if (hasId) {
        const id = Number(idRaw);
        const { error: upErr } = await sb
          .from("site_popups")
          .update({
            is_enabled: isEnabled,
            title,
            body: popupBody,
            updated_at: now,
          })
          .eq("id", id);
        if (upErr) throw upErr;
        return json(200, { ok: true, id });
      }
      const { data: maxRows, error: maxErr } = await sb
        .from("site_popups")
        .select("sort_order")
        .order("sort_order", { ascending: false })
        .limit(1);
      if (maxErr) throw maxErr;
      const nextSort =
        maxRows && maxRows[0] && maxRows[0].sort_order != null
          ? Number(maxRows[0].sort_order) + 1
          : 0;
      const { data: ins, error: insErr } = await sb
        .from("site_popups")
        .insert({
          is_enabled: isEnabled,
          title,
          body: popupBody,
          sort_order: nextSort,
          updated_at: now,
        })
        .select("id")
        .single();
      if (insErr) throw insErr;
      return json(200, { ok: true, id: ins?.id });
    }

    if (action === "popup_delete") {
      const id = str(body.id);
      if (!id) {
        return json(400, { ok: false, error: "id가 필요합니다." });
      }
      const { error: delErr } = await sb.from("site_popups").delete().eq("id", id);
      if (delErr) throw delErr;
      return json(200, { ok: true });
    }

    if (action === "popup_reorder") {
      const ids = body.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        return json(400, { ok: false, error: "ids 배열이 필요합니다." });
      }
      const now = new Date().toISOString();
      for (let i = 0; i < ids.length; i++) {
        const id = Number(ids[i]);
        if (!Number.isFinite(id)) continue;
        const { error: ordErr } = await sb
          .from("site_popups")
          .update({ sort_order: i, updated_at: now })
          .eq("id", id);
        if (ordErr) throw ordErr;
      }
      return json(200, { ok: true });
    }

    if (action === "delete_user") {
      const userId = str(body.user_id);
      if (!userId || !UUID_RE.test(userId)) {
        return json(400, { ok: false, error: "유효한 user_id(UUID)가 필요합니다." });
      }
      const result = await deleteUserAccount(sb, userId);
      return json(result.status, result.body);
    }

    return json(400, { ok: false, error: "Unknown action" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg });
  }
});
