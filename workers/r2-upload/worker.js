/**
 * Cloudflare Workers — R2 업로드 프록시
 * 배포: 이 폴더에서 `wrangler deploy` (wrangler.toml의 bucket_name·R2_PUBLIC_BASE_URL 수정 후)
 *
 * 환경 변수:
 * - R2_PUBLIC_BASE_URL: R2 공개 접근 URL 접두어 (끝에 / 없이). R2 대시보드 > 버킷 > Settings > Public access / Custom domain
 * - UPLOAD_SECRET (선택, wrangler secret): 설정 시 요청 헤더 X-Upload-Secret 와 일치해야 업로드 허용
 */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Upload-Secret',
    'Access-Control-Max-Age': '86400'
  };
}

export default {
  async fetch(request, env) {
    const h = corsHeaders();

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: h });
    }

    const secret = env.UPLOAD_SECRET;
    if (secret && request.headers.get('X-Upload-Secret') !== secret) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...h, 'Content-Type': 'application/json' }
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), {
        status: 405,
        headers: { ...h, 'Content-Type': 'application/json' }
      });
    }

    const base = (env.R2_PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
    if (!base) {
      return new Response(JSON.stringify({ error: 'R2_PUBLIC_BASE_URL is not set' }), {
        status: 500,
        headers: { ...h, 'Content-Type': 'application/json' }
      });
    }

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid form data' }), {
        status: 400,
        headers: { ...h, 'Content-Type': 'application/json' }
      });
    }

    const file = form.get('file');
    const keyRaw = form.get('key');
    if (!file || typeof keyRaw !== 'string' || !keyRaw.trim()) {
      return new Response(JSON.stringify({ error: 'Missing file or key' }), {
        status: 400,
        headers: { ...h, 'Content-Type': 'application/json' }
      });
    }

    const keySafe = keyRaw.trim().replace(/^\/+/, '').replace(/\.\./g, '');
    if (!keySafe) {
      return new Response(JSON.stringify({ error: 'Invalid key' }), {
        status: 400,
        headers: { ...h, 'Content-Type': 'application/json' }
      });
    }

    const buf = await file.arrayBuffer();
    await env.BUCKET.put(keySafe, buf, {
      httpMetadata: { contentType: file.type || 'application/octet-stream' }
    });

    const pathEncoded = keySafe.split('/').map(function (seg) { return encodeURIComponent(seg); }).join('/');
    const url = base + '/' + pathEncoded;
    return new Response(JSON.stringify({ url }), {
      status: 200,
      headers: { ...h, 'Content-Type': 'application/json' }
    });
  }
};
