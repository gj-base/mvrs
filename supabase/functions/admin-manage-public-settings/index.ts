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

function positiveBigint(v: unknown): number | null {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function normalizeBusinessRegistrationNo(v: unknown): string {
  return str(v).replace(/[^0-9]/g, "");
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

  const action = str(body.action);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!serviceKey || !supabaseUrl) {
    return json(503, { ok: false, error: "Server misconfigured" });
  }

  const sb = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    if (action === "company_create") {
      const name = str(body.name).slice(0, 200);
      const businessRegistrationNo = normalizeBusinessRegistrationNo(body.business_registration_no);
      const representativeName = str(body.representative_name).slice(0, 100) || null;
      const address = str(body.address).slice(0, 500) || null;
      const rawBranchIds = Array.isArray(body.branch_ids) ? body.branch_ids : [];
      const branchIds = Array.from(new Set(rawBranchIds.map(positiveBigint).filter((id): id is number => id !== null)));
      if (!name) {
        return json(400, { ok: false, error: "업체명을 입력해 주세요." });
      }
      if (businessRegistrationNo.length !== 10) {
        return json(400, { ok: false, error: "사업자번호는 숫자 10자리여야 합니다." });
      }
      if (!branchIds.length || branchIds.length !== rawBranchIds.length || branchIds.length > 100) {
        return json(400, { ok: false, error: "활성 지사를 한 곳 이상 올바르게 선택해 주세요." });
      }

      const [{ data: branches, error: branchesErr }, { data: allCompanies, error: companiesErr }] =
        await Promise.all([
          sb.from("branches").select("id,name,is_active").in("id", branchIds),
          sb.from("companies").select("id,branch_id,name,business_registration_no,is_active").limit(5000),
        ]);
      if (branchesErr) throw branchesErr;
      if (companiesErr) throw companiesErr;

      const activeBranchIds = new Set(
        (branches ?? []).filter((branch) => branch.is_active !== false).map((branch) => Number(branch.id)),
      );
      if (branchIds.some((branchId) => !activeBranchIds.has(branchId))) {
        return json(400, { ok: false, error: "선택한 지사 중 사용할 수 없는 지사가 있습니다." });
      }

      const existingBrnRow = (allCompanies ?? []).find((row) =>
        normalizeBusinessRegistrationNo(row.business_registration_no) === businessRegistrationNo
      );
      if (existingBrnRow) {
        return json(409, {
          ok: false,
          error: `이미 등록된 사업자번호입니다. 기존 업체 “${str(existingBrnRow.name)}”에서 지사를 추가해 주세요.`,
          existing_company_id: existingBrnRow.id,
        });
      }
      const duplicateNameRow = (allCompanies ?? []).find((row) =>
        branchIds.includes(Number(row.branch_id)) && str(row.name) === name
      );
      if (duplicateNameRow) {
        return json(409, { ok: false, error: "선택한 지사에 같은 업체명이 이미 등록되어 있습니다." });
      }

      const now = new Date().toISOString();
      const formattedBrn = `${businessRegistrationNo.slice(0, 3)}-${businessRegistrationNo.slice(3, 5)}-${businessRegistrationNo.slice(5)}`;
      const rows = branchIds.map((branchId) => ({
        branch_id: branchId,
        name,
        business_registration_no: formattedBrn,
        representative_name: representativeName,
        address,
        sort_order: 0,
        is_active: true,
        updated_at: now,
      }));
      const { data: inserted, error: insertErr } = await sb
        .from("companies")
        .insert(rows)
        .select("id,branch_id,name,business_registration_no,is_active");
      if (insertErr) {
        if (insertErr.code === "23505") {
          return json(409, { ok: false, error: "같은 업체가 이미 등록되어 있습니다. 목록을 새로고침해 주세요." });
        }
        throw insertErr;
      }
      return json(200, { ok: true, companies: inserted ?? [] });
    }

    if (action === "company_branch_add") {
      const sourceCompanyId = positiveBigint(body.source_company_id);
      const branchId = positiveBigint(body.branch_id);
      if (!sourceCompanyId || !branchId) {
        return json(400, { ok: false, error: "source_company_id와 branch_id가 필요합니다." });
      }

      const [{ data: source, error: sourceErr }, { data: branch, error: branchErr }] =
        await Promise.all([
          sb
            .from("companies")
            .select("id,branch_id,name,business_registration_no,representative_name,address,is_active,sort_order")
            .eq("id", sourceCompanyId)
            .maybeSingle(),
          sb.from("branches").select("id,name,is_active").eq("id", branchId).maybeSingle(),
        ]);
      if (sourceErr) throw sourceErr;
      if (branchErr) throw branchErr;
      if (!source) return json(404, { ok: false, error: "기준 업체를 찾을 수 없습니다." });
      if (!branch || branch.is_active === false) {
        return json(400, { ok: false, error: "활성 지사를 선택해 주세요." });
      }

      const { data: allCompanies, error: companiesErr } = await sb
        .from("companies")
        .select("id,branch_id,name,business_registration_no,representative_name,address,is_active,sort_order")
        .limit(5000);
      if (companiesErr) throw companiesErr;

      const sourceBrn = normalizeBusinessRegistrationNo(source.business_registration_no);
      const groupRows = (allCompanies ?? []).filter((row) => {
        if (sourceBrn.length === 10) {
          return normalizeBusinessRegistrationNo(row.business_registration_no) === sourceBrn;
        }
        return Number(row.id) === sourceCompanyId;
      });
      const targetRows = groupRows.filter((row) => Number(row.branch_id) === branchId);
      if (targetRows.some((row) => row.is_active !== false)) {
        return json(409, { ok: false, error: "이미 활성화된 지사입니다." });
      }

      const groupCompanyIds = groupRows.map((row) => Number(row.id)).filter(Number.isSafeInteger);
      const { data: memberships, error: membershipsErr } = groupCompanyIds.length
        ? await sb
          .from("user_company_memberships")
          .select("user_id,company_id")
          .in("company_id", groupCompanyIds)
        : { data: [], error: null };
      if (membershipsErr) throw membershipsErr;
      const memberUserIds = Array.from(
        new Set((memberships ?? []).map((row) => str(row.user_id)).filter(Boolean)),
      );
      if (memberUserIds.length > 1) {
        return json(409, {
          ok: false,
          error: "동일 사업자번호에 서로 다른 회원이 연결되어 있어 자동 처리할 수 없습니다.",
        });
      }

      const now = new Date().toISOString();
      const inactiveTarget = targetRows.find((row) => row.is_active === false) ?? null;
      let targetCompany: { id: number; branch_id: number; name: string; is_active: boolean } | null = null;
      let created = false;
      if (inactiveTarget) {
        const { data: activated, error: activateErr } = await sb
          .from("companies")
          .update({
            is_active: true,
            business_registration_no: source.business_registration_no,
            representative_name: source.representative_name,
            address: source.address,
            updated_at: now,
          })
          .eq("id", inactiveTarget.id)
          .eq("is_active", false)
          .select("id,branch_id,name,is_active")
          .single();
        if (activateErr) throw activateErr;
        targetCompany = activated;
      } else {
        const { data: inserted, error: insertErr } = await sb
          .from("companies")
          .insert({
            branch_id: branchId,
            name: source.name,
            business_registration_no: source.business_registration_no,
            representative_name: source.representative_name,
            address: source.address,
            sort_order: source.sort_order ?? 0,
            is_active: true,
            updated_at: now,
          })
          .select("id,branch_id,name,is_active")
          .single();
        if (insertErr) {
          if (insertErr.code === "23505") {
            return json(409, { ok: false, error: "선택한 지사에 같은 업체명이 이미 존재합니다." });
          }
          throw insertErr;
        }
        targetCompany = inserted;
        created = true;
      }

      if (memberUserIds.length === 1 && targetCompany) {
        const { error: memberInsertErr } = await sb
          .from("user_company_memberships")
          .upsert(
            { user_id: memberUserIds[0], company_id: targetCompany.id },
            { onConflict: "user_id,company_id", ignoreDuplicates: true },
          );
        if (memberInsertErr) {
          if (created) {
            await sb.from("companies").delete().eq("id", targetCompany.id);
          } else {
            await sb
              .from("companies")
              .update({ is_active: false, updated_at: new Date().toISOString() })
              .eq("id", targetCompany.id);
          }
          throw memberInsertErr;
        }
      }

      return json(200, {
        ok: true,
        action: created ? "created" : "reactivated",
        company: targetCompany,
        membership_linked: memberUserIds.length === 1,
      });
    }

    if (action === "company_branch_remove") {
      const companyId = positiveBigint(body.company_id);
      if (!companyId) {
        return json(400, { ok: false, error: "company_id가 필요합니다." });
      }
      const { data: company, error: companyErr } = await sb
        .from("companies")
        .select("id,branch_id,name,is_active")
        .eq("id", companyId)
        .maybeSingle();
      if (companyErr) throw companyErr;
      if (!company) return json(404, { ok: false, error: "업체 지사 행을 찾을 수 없습니다." });
      if (company.is_active === false) {
        return json(409, { ok: false, error: "이미 비활성화된 지사입니다." });
      }

      const now = new Date().toISOString();
      const { data: disabled, error: disableErr } = await sb
        .from("companies")
        .update({ is_active: false, updated_at: now })
        .eq("id", companyId)
        .eq("is_active", true)
        .select("id,branch_id,name,is_active")
        .single();
      if (disableErr) throw disableErr;

      const { error: membershipDeleteErr } = await sb
        .from("user_company_memberships")
        .delete()
        .eq("company_id", companyId);
      if (membershipDeleteErr) {
        await sb
          .from("companies")
          .update({ is_active: true, updated_at: new Date().toISOString() })
          .eq("id", companyId);
        throw membershipDeleteErr;
      }

      return json(200, { ok: true, company: disabled });
    }

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
