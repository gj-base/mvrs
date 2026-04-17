/**
 * 관리자용 Edge Function 출발 IP 제한.
 * - Secret `ADMIN_ALLOWED_SOURCE_IPS`: 쉼표 구분 목록 (예: 168.78.248.161,203.0.113.1)
 * - 미설정 시 기본 허용: 168.78.248.161
 * - 로컬/스테이징에서 끄려면 값을 `*` 또는 `OFF`(대소문자 무관)로 설정
 */

const DEFAULT_ALLOWED_IPS = ["168.78.248.161"];

export function getClientSourceIp(req: Request): string {
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

function parseAllowedList(): string[] | "skip" {
  const raw = (Deno.env.get("ADMIN_ALLOWED_SOURCE_IPS") ?? "").trim();
  if (raw === "*" || raw.toLowerCase() === "off") return "skip";
  if (!raw) return DEFAULT_ALLOWED_IPS;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_IPS;
}

export type AdminIpCheckResult =
  | { ok: true }
  | { ok: false; message: string };

export function checkAdminSourceIp(req: Request): AdminIpCheckResult {
  const mode = parseAllowedList();
  if (mode === "skip") return { ok: true };

  const ip = getClientSourceIp(req);
  if (!ip) {
    return {
      ok: false,
      message: "클라이언트 IP를 확인할 수 없어 요청을 거절했습니다.",
    };
  }
  if (!mode.includes(ip)) {
    return {
      ok: false,
      message: "허용되지 않은 접속 IP입니다.",
    };
  }
  return { ok: true };
}
