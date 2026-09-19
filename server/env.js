// ============================================================
// .env 자동 로드 — 프로젝트 루트(.env) 우선, 없으면 server/.env
// index.js 가 가장 먼저 import 한다. ESM 은 import 순서대로 모듈을 평가하므로,
// 이 파일을 맨 앞에 두면 뒤에 오는 모듈(store.js 등)이 로드될 때 환경변수가 이미 채워져 있다.
// ============================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const p of [path.join(here, '..', '.env'), path.join(here, '.env')]) {
  try {
    process.loadEnvFile(p);
    console.log('[env] 로드됨:', p);
    break;
  } catch { /* 파일 없으면 다음 후보 */ }
}
