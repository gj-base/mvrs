/** KST 기준 예약 신청·수정 / 취소 마감 (방문일 전날 16:00 / 14:00) — _shared/booking_deadline.ts 와 동일 */

export type UserDeadlineAction = 'submit_or_update' | 'cancel';

export function kstYmd(d = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

export function currentKstMinutes(d = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const h = parseInt(parts.find((p) => p.type === 'hour')!.value, 10);
  const mi = parseInt(parts.find((p) => p.type === 'minute')!.value, 10);
  return h * 60 + mi;
}

export function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  const kstMidnightUtc = Date.UTC(y, m - 1, d - 1, 15, 0, 0);
  const target = kstMidnightUtc + delta * 24 * 60 * 60 * 1000;
  return kstYmd(new Date(target));
}

export function isUserActionAllowed(
  reservationDateYmd: string,
  kind: UserDeadlineAction,
  now = new Date(),
): boolean {
  const visit = reservationDateYmd.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(visit)) return false;

  const today = kstYmd(now);
  const deadlineDay = addDaysYmd(visit, -1);

  if (kind === 'cancel') {
    if (today >= visit) return false;
    if (today < deadlineDay) return true;
    if (today > deadlineDay) return false;
    return currentKstMinutes(now) <= 14 * 60;
  }

  if (today < deadlineDay) return true;
  if (today > deadlineDay) return false;
  return currentKstMinutes(now) <= 16 * 60;
}

export function deadlineErrorMessage(kind: UserDeadlineAction): string {
  if (kind === 'cancel') {
    return '예약 취소는 방문일 전날 14:00까지 가능합니다. (당일 취소 불가)';
  }
  return '예약 신청·수정은 방문일 전날 16:00까지 가능합니다.';
}

export function isApprovedStatus(status: unknown): boolean {
  const s = String(status ?? '').trim();
  return s === '승인' || s === '대기';
}
