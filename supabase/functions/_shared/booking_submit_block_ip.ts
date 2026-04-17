/**
 * 예약 최종 제출(submit-reservation) 출발 IP 차단.
 * - Secret `BOOKING_BLOCKED_SOURCE_IPS` 미설정·빈 값: 사내 출구 IP `168.78.248.161` 차단(기본)
 * - `OFF`(대소문자 무관): 차단 비활성
 * - 그 외: 차단할 공인 IP를 쉼표로 구분 (예: 203.0.113.10,198.51.100.2)
 * - `getClientSourceIp`는 Supabase Edge 앞단(Cloudflare 등)에서 넘어오는 헤더 기준
 */

import { getClientSourceIp } from "./admin_source_ip.ts";

const DEFAULT_BLOCKED_IPS = ["168.78.248.161"];

export type BookingSubmitIpCheckResult =
  | { ok: true }
  | { ok: false; message: string };

function parseBlockedList(): string[] | "off" {
  const raw = (Deno.env.get("BOOKING_BLOCKED_SOURCE_IPS") ?? "").trim();
  if (raw.toLowerCase() === "off") return "off";
  if (!raw) return [...DEFAULT_BLOCKED_IPS];
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_BLOCKED_IPS];
}

export function checkBookingSubmitBlockedBySourceIp(
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
