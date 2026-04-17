import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { checkBookingSubmitBlockedBySourceIp } from "../_shared/booking_submit_block_ip.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version, prefer",
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** 예약 업로드 전: 동일 출발 IP 기준으로 최종 제출 가능 여부만 반환합니다. */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" });
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

  return json(200, { ok: true });
});
