const PII_PREFIX = 'enc:v1:';
const PBKDF2_SALT = new Uint8Array([
  0x72, 0x65, 0x73, 0x76, 0x2d, 0x70, 0x69, 0x69, 0x2d, 0x6b, 0x65, 0x70, 0x63, 0x6f, 0x2d, 0x31,
]);
const PBKDF2_ITERS = 210000;

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** TS 5.5+ lib.dom: SubtleCrypto는 BufferSource(ArrayBuffer 전용)를 요구 — 복사 후 단언 */
function asBufferSource(data: Uint8Array): BufferSource {
  const out = new Uint8Array(data.byteLength);
  out.set(data);
  return out as BufferSource;
}

async function getPiiKey(secret: string, usages: ('encrypt' | 'decrypt')[]): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: PBKDF2_SALT, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

async function deriveContactIv(plaintext: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode('v1|contact|' + plaintext));
  return new Uint8Array(buf, 0, 12);
}

async function encryptPayload(key: CryptoKey, iv: Uint8Array, plaintext: string): Promise<string> {
  const enc = new TextEncoder();
  const ivBytes = new Uint8Array(iv.length);
  ivBytes.set(iv);
  const pt = Uint8Array.from(enc.encode(plaintext));
  const ctBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asBufferSource(ivBytes) },
    key,
    asBufferSource(pt),
  );
  const ct = new Uint8Array(ctBuf);
  const combined = new Uint8Array(12 + ct.length);
  combined.set(ivBytes, 0);
  combined.set(ct, 12);
  return PII_PREFIX + bytesToBase64(combined);
}

export async function encryptPiiContact(secret: string, plaintext: string): Promise<string> {
  const key = await getPiiKey(secret, ['encrypt']);
  const iv = await deriveContactIv(plaintext);
  return encryptPayload(key, iv, plaintext);
}

export async function encryptPiiEmail(secret: string, plaintext: string): Promise<string | null> {
  const p = plaintext.trim();
  if (!p) return null;
  const key = await getPiiKey(secret, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return encryptPayload(key, iv, p);
}

export async function decryptPiiField(stored: string | null | undefined, secret: string): Promise<string | null> {
  if (stored == null || stored === '') return stored ?? null;
  const s = String(stored);
  if (!s.startsWith(PII_PREFIX)) return s;
  let combined: Uint8Array;
  try {
    combined = base64ToBytes(s.slice(PII_PREFIX.length));
  } catch {
    return s;
  }
  if (combined.length < 12 + 16) return s;
  const ivBytes = new Uint8Array(combined.slice(0, 12));
  const ctBytes = new Uint8Array(combined.slice(12));
  const key = await getPiiKey(secret, ['decrypt']);
  try {
    const buf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: asBufferSource(ivBytes) },
      key,
      asBufferSource(ctBytes),
    );
    return new TextDecoder().decode(buf);
  } catch {
    return s;
  }
}
