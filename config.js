/**
 * Supabase 연동 설정
 * - Supabase 대시보드 > Project Settings > API 에서 URL과 anon key 확인
 */
const SUPABASE_URL = 'https://fiszfkvghlhclfzoybsj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZpc3pma3ZnaGxoY2xmem95YnNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3NjIzMDIsImV4cCI6MjA4ODMzODMwMn0.CFOOvoPJgzefRRs8C6T8df74gaiU1t6ziwU5YQb8puc';

/**
 * Cloudflare R2 업로드 (Worker 프록시)
 * - 파일 업로드는 Worker가 처리하고, 프론트는 Worker URL로 multipart 전송합니다.
 *
 * [선택 설정]
 * - R2_UPLOAD_SECRET: Worker에서 X-Upload-Secret 검증을 켠 경우 동일한 문자열
 */
const R2_UPLOAD_WORKER_URL = 'https://reservation-r2-upload.hh44683990.workers.dev';
const R2_UPLOAD_SECRET = '';
if (typeof window !== 'undefined') {
  window.R2_UPLOAD_WORKER_URL = R2_UPLOAD_WORKER_URL;
  window.R2_UPLOAD_SECRET = R2_UPLOAD_SECRET;
}

/**
 * 관리자 암호: GitHub Pages 등 정적 사이트에 두지 않습니다.
 * Supabase Secrets `ADMIN_NOTIFY_SECRET`에만 설정하고, `verify-admin-password`·`send-reservation-status-email`이 검증합니다.
 *
 * 관리자 Edge Function 출발 IP (선택):
 * - `ADMIN_ALLOWED_SOURCE_IPS`: 쉼표 구분 (미설정 시 168.78.248.161 만 허용)
 * - 로컬에서 IP 제한 끄기: Secret 값을 `*` 또는 `OFF`
 */

/**
 * 예약 최종 제출 IP 차단: Edge Function `submit-reservation` Secret `BOOKING_BLOCKED_SOURCE_IPS`
 * - 미설정·빈 값·OFF → 차단 없음(사내망·외부망 모두 예약 가능)
 * - 그 외 → 쉼표 구분 공인 IP 목록에 해당하는 출구에서만 예약 완료 거절
 *
 * 예약 연락처·이메일 암호화: 클라이언트에 키를 두지 않습니다.
 * Edge Functions `submit-reservation`, `decrypt-reservation-pii`, `send-reservation-status-email` Secrets:
 * - PII_ENCRYPTION_SECRET (16자 이상, 동일 값)
 *
 * 승인/반려 안내 메일: `send-reservation-status-email` 배포 후 Secrets에 추가:
 * - ADMIN_NOTIFY_SECRET  → 관리자 로그인·메일 발송용 (verify-admin-password / x-admin-secret 과 동일 값)
 * - GMAIL_SMTP_USER      → Gmail 주소
 * - GMAIL_SMTP_APP_PASSWORD → Google 계정 앱 비밀번호
 * - MAIL_FROM (선택)     → 발신 표시, 예: "자재센터 예약 <you@gmail.com>" (미설정 시 GMAIL_SMTP_USER)
 *
 * DB: supabase_migration_status_notification_sent.sql 을 SQL Editor에서 실행 (컬럼 status_notification_sent)
 */
