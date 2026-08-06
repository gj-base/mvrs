import type { ConfigService } from '@nestjs/config';
import type { Pool } from 'pg';
import * as nodemailer from 'nodemailer';
import { decryptPiiField } from './pii.util';

function str(v: unknown): string {
  if (v == null) return '';
  return String(v).trim();
}

/** 동일 상태(승인/반려) 중복 메일만 차단. 승인 후 반려 등 상태 변경 시 재발송 허용 */
export function isStatusMailAlreadySent(row: Record<string, unknown>, st: string): boolean {
  const notifiedFor = str(row.status_notified_for);
  if (notifiedFor && notifiedFor === st) return true;
  if (!notifiedFor && row.status_notification_sent === true && st === '승인') {
    return true;
  }
  return false;
}

export async function sendReservationStatusEmailInternal(
  pool: Pool,
  config: ConfigService,
  reservationId: string,
  notifyForStatus: '승인' | '반려',
): Promise<{ ok: true } | { ok: false; skipped?: boolean; reason?: string; error?: string }> {
  const piiSecret = config.get<string>('PII_ENCRYPTION_SECRET') ?? '';
  const gmailUser = config.get<string>('GMAIL_SMTP_USER') ?? '';
  const gmailPass = config.get<string>('GMAIL_SMTP_APP_PASSWORD') ?? '';
  const mailFromRaw = (config.get<string>('MAIL_FROM') ?? gmailUser).trim();
  if (!piiSecret || piiSecret.length < 16) {
    return { ok: false, error: 'PII_ENCRYPTION_SECRET is not configured' };
  }
  if (!gmailUser || !gmailPass) {
    return { ok: false, error: 'GMAIL_SMTP 미설정' };
  }

  const r = await pool.query(
    `select r.id, r.status, r.status_notification_sent, r.status_notified_for, r.visitor_email, r.company_name,
            r.reservation_date, r.reservation_time, r.car_number_1, r.car_number_2, r.material_info, r.vehicle_count,
            json_build_object('name', b.name) as branches
     from public.reservations r
     left join public.branches b on b.id = r.branch_id
     where r.id = $1::bigint`,
    [reservationId],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return { ok: false, error: 'Reservation not found' };
  }

  const st = String(row.status ?? '').trim();
  if (st !== notifyForStatus) {
    return { ok: false, skipped: true, reason: 'status mismatch' };
  }
  if (isStatusMailAlreadySent(row, st)) {
    return { ok: false, skipped: true, reason: 'already sent for ' + st };
  }

  const emailPlain = await decryptPiiField(row.visitor_email as string | null, piiSecret);
  const to = emailPlain && String(emailPlain).includes('@') ? String(emailPlain).trim() : null;
  if (!to) {
    return { ok: false, error: 'No valid visitor email on record' };
  }

  const dateStr = row.reservation_date ? String(row.reservation_date).slice(0, 10) : '-';
  const timeStr = row.reservation_time ? String(row.reservation_time).trim().slice(0, 5) : '-';
  const branchRow = row.branches as { name?: string } | null | undefined;
  const branchName = String(branchRow?.name ?? '').trim() || '-';
  const companyName = String(row.company_name ?? '').trim() || '-';
  const salutation = companyName !== '-' ? companyName : '귀하';
  const cars =
    [String(row.car_number_1 ?? ''), String(row.car_number_2 ?? '')].filter(Boolean).join(' / ') || '-';
  const vehicleCountN = row.vehicle_count === 2 || row.vehicle_count === '2' ? 2 : 1;
  const vehicleCountLabel = vehicleCountN === 2 ? '2대' : '1대';
  const material =
    String(row.material_info ?? '')
      .replace(/^\[차량대수:[12]대\]\s*/, '')
      .trim() || '-';

  const subject =
    notifyForStatus === '승인'
      ? `[자재센터] 불용자재 환입 예약이 승인되었습니다`
      : `[자재센터] 불용자재 환입 예약이 반려되었습니다`;

  const textBody =
    `${salutation} 담당자님, 안녕하세요.\n\n` +
    `신청하신 불용자재 환입 차량 예약이 ${notifyForStatus} 처리되었습니다.\n\n` +
    `■ 예약 정보\n` +
    `- 지사: ${branchName}\n` +
    `- 업체명: ${companyName}\n` +
    `- 예약일: ${dateStr}\n` +
    `- 방문 시간: ${timeStr}\n` +
    `- 차량 대수: ${vehicleCountLabel}\n` +
    `- 차량번호: ${cars}\n` +
    `- 환입 자재 내역: ${material}\n` +
    `- 담당자 연락처: 062-260-5133, 5145\n\n` +
    `문의 사항은 담당 부서로 연락해 주시기 바랍니다.`;

  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailUser, pass: gmailPass },
  });

  try {
    await transport.sendMail({
      from: mailFromRaw || gmailUser,
      to,
      subject,
      text: textBody,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: 'SMTP send failed: ' + msg.slice(0, 500) };
  }

  await pool.query(
    `update public.reservations set status_notification_sent = true, status_notified_for = $2 where id = $1::bigint`,
    [reservationId, notifyForStatus],
  );
  return { ok: true };
}
