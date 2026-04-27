/**
 * 내부 클라우드(Apache 정적 + Nest /api) 전용 설정
 * — 외부망 Supabase용 루트 config.js와 별도입니다.
 */

/** Nest API 경로 (Apache에서 ProxyPass /api -> Nest 권장) */
var MVRS_API_BASE = '/api';

if (typeof window !== 'undefined') {
  window.MVRS_API_BASE = MVRS_API_BASE;
}

/**
 * Cloudflare R2 업로드 Worker (내부망에서도 동일 URL을 쓸 경우 유지)
 */
var R2_UPLOAD_WORKER_URL = '';
var R2_UPLOAD_SECRET = '';
if (typeof window !== 'undefined') {
  window.R2_UPLOAD_WORKER_URL = R2_UPLOAD_WORKER_URL;
  window.R2_UPLOAD_SECRET = R2_UPLOAD_SECRET;
}
