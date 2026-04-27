import type { Request } from 'express';
import { getClientSourceIp } from '../common/http-ip.util';

/**
 * 내부 클라우드: 기본은 차단 없음(사내망·인터넷망 모두 예약 가능).
 * 특정 출구 IP만 막고 싶을 때만 BOOKING_BLOCKED_SOURCE_IPS 에 쉼표 구분으로 설정.
 * OFF / 빈 값 / * → 차단 비활성
 */
function parseBlockedList(raw: string): 'off' | string[] {
  const t = raw.trim();
  if (!t || t.toLowerCase() === 'off' || t === '*') {
    return 'off';
  }
  const list = t.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : 'off';
}

export function checkBookingSubmitBlockedBySourceIp(
  req: Request,
  envRaw: string,
): { ok: true } | { ok: false; message: string } {
  const mode = parseBlockedList(envRaw);
  if (mode === 'off') {
    return { ok: true };
  }
  const ip = getClientSourceIp(req);
  if (!ip) {
    return { ok: true };
  }
  if (mode.includes(ip)) {
    return {
      ok: false,
      message: '설정된 정책에 따라 이 접속 IP에서는 예약 신청을 완료할 수 없습니다.',
    };
  }
  return { ok: true };
}
