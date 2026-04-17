import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { checkAdminSourceIp } from "../_shared/admin_source_ip.ts";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version, prefer",
};

/** Edge 런타임에 따라 `crypto.subtle.timingSafeEqual`이 없어 500이 나는 경우가 있어 XOR 루프 사용 */
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

  const ipCheck = checkAdminSourceIp(req);
  if (!ipCheck.ok) {
    return new Response(JSON.stringify({ ok: false, error: ipCheck.message }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const expected = Deno.env.get("ADMIN_NOTIFY_SECRET") ?? "";
  if (!expected) {
    return new Response(
      JSON.stringify({
        error: "ADMIN_NOTIFY_SECRET is not configured (Function Secrets)",
      }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  let body: { password?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const password = body.password != null ? String(body.password) : "";
  if (!timingSafeEqualUtf8(expected, password)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
