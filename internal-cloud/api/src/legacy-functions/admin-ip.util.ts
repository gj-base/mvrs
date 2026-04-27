import type { Request } from 'express';
import { getClientSourceIp } from '../common/http-ip.util';

const DEFAULT_ALLOWED_IPS = ['168.78.248.161'];

function parseAllowedList(raw: string): string[] | 'skip' {
  const t = raw.trim();
  if (t === '*' || t.toLowerCase() === 'off') return 'skip';
  if (!t) return DEFAULT_ALLOWED_IPS;
  const list = t.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_ALLOWED_IPS;
}

export function checkAdminSourceIp(req: Request, envRaw: string): { ok: true } | { ok: false; message: string } {
  const mode = parseAllowedList(envRaw);
  if (mode === 'skip') return { ok: true };
  const ip = getClientSourceIp(req);
  if (!ip) {
    return { ok: false, message: '클라이언트 IP를 확인할 수 없어 요청을 거절했습니다.' };
  }
  if (!mode.includes(ip)) {
    return { ok: false, message: '허용되지 않은 접속 IP입니다.' };
  }
  return { ok: true };
}
