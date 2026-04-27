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

type MembershipRow = {
  user_id: string;
  created_at: string | null;
  companies: {
    id: number;
    name: string | null;
    business_registration_no: string | null;
    branch_id: number | null;
    branches: { id: number; name: string | null } | null;
  } | null;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  contact_email: string | null;
  company_address: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type SignupItem = {
  user_id: string;
  email: string | null;
  email_confirmed_at: string | null;
  auth_created_at: string | null;
  last_sign_in_at: string | null;
  full_name: string;
  phone: string;
  contact_email: string;
  company_address: string;
  profile_updated_at: string | null;
  brn: string | null;
  company_names: string[];
  branch_names: string[];
};

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

  let body: { admin_secret?: string; limit?: number };
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

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!serviceKey || !supabaseUrl) {
    return json(503, { ok: false, error: "Server misconfigured" });
  }

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const limitRaw = Number(body.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), 2000)
    : 1000;

  try {
    // 1) user_profiles
    const { data: profileRows, error: profileErr } = await sb
      .from("user_profiles")
      .select(
        "id, full_name, phone, contact_email, company_address, created_at, updated_at",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (profileErr) throw profileErr;
    const profiles: ProfileRow[] = (profileRows ?? []) as ProfileRow[];
    const userIds = profiles.map((p) => p.id);

    if (userIds.length === 0) {
      return json(200, { ok: true, items: [] });
    }

    // 2) 멤버십 + 업체/지사
    const { data: memRows, error: memErr } = await sb
      .from("user_company_memberships")
      .select(
        "user_id, created_at, companies(id, name, business_registration_no, branch_id, branches(id, name))",
      )
      .in("user_id", userIds);
    if (memErr) throw memErr;
    const memberships: MembershipRow[] = (memRows ?? []) as unknown as MembershipRow[];

    const memByUser = new Map<string, MembershipRow[]>();
    for (const m of memberships) {
      if (!m.user_id) continue;
      const arr = memByUser.get(m.user_id) ?? [];
      arr.push(m);
      memByUser.set(m.user_id, arr);
    }

    // 3) auth.users: 이메일/확인일 등
    const authByUser = new Map<
      string,
      {
        email: string | null;
        email_confirmed_at: string | null;
        auth_created_at: string | null;
        last_sign_in_at: string | null;
      }
    >();
    let page = 1;
    const perPage = 1000;
    while (true) {
      const { data: au, error: auErr } = await sb.auth.admin.listUsers({
        page,
        perPage,
      });
      if (auErr) throw auErr;
      const users = au?.users ?? [];
      for (const u of users) {
        if (!u?.id) continue;
        authByUser.set(u.id, {
          email: u.email ?? null,
          email_confirmed_at: (u as unknown as { email_confirmed_at?: string | null }).email_confirmed_at ?? null,
          auth_created_at: (u as unknown as { created_at?: string | null }).created_at ?? null,
          last_sign_in_at: (u as unknown as { last_sign_in_at?: string | null }).last_sign_in_at ?? null,
        });
      }
      if (users.length < perPage) break;
      page += 1;
      if (page > 20) break; // 안전 가드 (최대 2만 명)
    }

    // 4) 응답 조립
    const items: SignupItem[] = profiles.map((p) => {
      const mems = memByUser.get(p.id) ?? [];
      const brnSet = new Set<string>();
      const coSet = new Set<string>();
      const brSet = new Set<string>();
      for (const m of mems) {
        const c = m.companies;
        if (!c) continue;
        if (c.business_registration_no) {
          brnSet.add(String(c.business_registration_no));
        }
        if (c.name) coSet.add(String(c.name));
        if (c.branches && c.branches.name) brSet.add(String(c.branches.name));
      }
      const a = authByUser.get(p.id) ?? {
        email: null,
        email_confirmed_at: null,
        auth_created_at: null,
        last_sign_in_at: null,
      };
      return {
        user_id: p.id,
        email: a.email,
        email_confirmed_at: a.email_confirmed_at,
        auth_created_at: a.auth_created_at,
        last_sign_in_at: a.last_sign_in_at,
        full_name: p.full_name ?? "",
        phone: p.phone ?? "",
        contact_email: p.contact_email ?? "",
        company_address: p.company_address ?? "",
        profile_updated_at: p.updated_at ?? null,
        brn: brnSet.size ? Array.from(brnSet).join(", ") : null,
        company_names: Array.from(coSet),
        branch_names: Array.from(brSet),
      };
    });

    return json(200, { ok: true, items });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { ok: false, error: msg });
  }
});
