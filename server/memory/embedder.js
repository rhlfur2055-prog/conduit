// ============================================================
// 로컬 임베더 (specs/001-verified-memory · FR-003)
//   multilingual-e5-small (q8, 384차원) — 키·네트워크 없이 동작, 최초 1회만 모델을 내려받는다 (~120MB).
//   e5 는 입력 앞에 "query: " / "passage: " 를 붙여야 제 성능이 나온다 — 부르는 쪽이 붙인다.
//   모델을 못 불러오면 null 을 돌려주고, 기억 검색은 글자 겹침만으로 떨어진다 (FR-010).
//   CONDUIT_EMBED=off 면 아예 켜지 않는다 (테스트·저사양).
// ============================================================
import path from 'node:path';
import { DATA_DIR } from '../store.js';

export const EMBED_MODEL = process.env.CONDUIT_EMBED_MODEL || 'Xenova/multilingual-e5-small';
const BATCH = 32;

let loading = null;
let lastError = null;

export const embedderError = () => lastError;

/** @returns {Promise<((texts:string[]) => Promise<number[][]>) | null>} */
export async function getEmbedder() {
  if (process.env.CONDUIT_EMBED === 'off') { lastError = 'CONDUIT_EMBED=off'; return null; }
  if (!loading) {
    loading = (async () => {
      try {
        const { pipeline, env } = await import('@huggingface/transformers');
        env.cacheDir = path.join(DATA_DIR, 'models');
        const fe = await pipeline('feature-extraction', EMBED_MODEL, { dtype: 'q8' });
        return async (texts) => {
          const out = [];
          for (let i = 0; i < texts.length; i += BATCH) {
            const t = await fe(texts.slice(i, i + BATCH), { pooling: 'mean', normalize: true });
            out.push(...t.tolist());
          }
          return out;
        };
      } catch (e) {
        lastError = e.message;
        loading = null;          // 다음 호출에서 다시 시도한다 (네트워크가 돌아왔을 수 있다)
        return null;
      }
    })();
  }
  return loading;
}
