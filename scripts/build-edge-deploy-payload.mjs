#!/usr/bin/env node
/**
 * Edge Function 배포 페이로드 생성 (MCP deploy_edge_function / 수동 배포용)
 * Usage: node scripts/build-edge-deploy-payload.mjs submit-reservation
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function readUtf8(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

const specs = {
  'submit-reservation': {
    name: 'submit-reservation',
    entrypoint_path: 'index.ts',
    verify_jwt: false,
    files: [
      { name: 'index.ts', path: 'supabase/functions/submit-reservation/index.ts' },
      { name: '../_shared/booking_deadline.ts', path: 'supabase/functions/_shared/booking_deadline.ts' },
    ],
  },
  'my-reservations': {
    name: 'my-reservations',
    entrypoint_path: 'supabase/functions/my-reservations/index.ts',
    verify_jwt: false,
    files: [
      { name: 'supabase/functions/my-reservations/index.ts', path: 'supabase/functions/my-reservations/index.ts' },
      { name: 'supabase/functions/_shared/booking_deadline.ts', path: 'supabase/functions/_shared/booking_deadline.ts' },
    ],
  },
  'check-booking-submit-allowed': {
    name: 'check-booking-submit-allowed',
    entrypoint_path: 'index.ts',
    verify_jwt: false,
    files: [
      { name: 'index.ts', path: 'supabase/functions/check-booking-submit-allowed/index.ts' },
      { name: '../_shared/booking_submit_block_ip.ts', path: 'supabase/functions/_shared/booking_submit_block_ip.ts' },
      { name: '../_shared/admin_source_ip.ts', path: 'supabase/functions/_shared/admin_source_ip.ts' },
    ],
  },
};

const fn = process.argv[2];
if (!fn || !specs[fn]) {
  console.error('Usage: node scripts/build-edge-deploy-payload.mjs <submit-reservation|my-reservations|check-booking-submit-allowed>');
  process.exit(1);
}

const spec = specs[fn];
const payload = {
  name: spec.name,
  entrypoint_path: spec.entrypoint_path,
  verify_jwt: spec.verify_jwt,
  files: spec.files.map(({ name, path: p }) => ({ name, content: readUtf8(p) })),
};

const out = path.join(root, `.deploy-mcp-${fn}.json`);
fs.writeFileSync(out, JSON.stringify(payload), 'utf8');
console.log(out);
