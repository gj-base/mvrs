import type { Request } from 'express';

export function getClientSourceIp(req: Request): string {
  const h = (name: string) => String(req.headers[name] ?? '').trim();
  const cf = h('cf-connecting-ip');
  if (cf) return cf;
  const fly = h('fly-client-ip');
  if (fly) return fly;
  const tc = h('true-client-ip');
  if (tc) return tc;
  const xr = h('x-real-ip');
  if (xr) return xr;
  const xff = h('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress?.replace(/^::ffff:/, '') ?? '';
}
