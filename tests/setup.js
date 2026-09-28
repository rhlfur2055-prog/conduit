// 모든 테스트 공통
//   - 개발자 PC 에 Ollama 가 켜져 있어도 테스트가 실제 모델을 부르지 않게 한다
//   - 테스트 파일이 따로 정하지 않으면 데이터 폴더를 임시 폴더로 잡는다 — 실제 server/data 를 절대 건드리지 않는다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONDUIT_LLM_AUTODETECT = 'off';
if (!process.env.CONDUIT_DATA_DIR) process.env.CONDUIT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-test-'));
