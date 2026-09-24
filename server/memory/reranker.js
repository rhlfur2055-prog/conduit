// ============================================================
// 리랭커 (cross-encoder) — 질의와 조각을 "같이" 읽고 관련도를 점수로 낸다.
//
//   임베딩은 질의와 조각을 따로 벡터로 만들어 비교해서 "관련 있다/없다" 판정이 약하다.
//   실측(evals/memory-recall.json): e5-small · e5-base 모두 관련/무관 코사인 분포가 겹쳐 최선 조합도 관련 79~83% / 무관 83~92%.
//   bge-reranker-v2-m3 는 같은 데이터에서 관련 24/24 를 1등으로 올리고, 무관 질의 최고점(-7.0)이 관련 질의 대부분보다 낮다.
//
//   모델 ~570MB (최초 1회 다운로드). 못 불러오면 null — 기억 검색은 임베딩 문턱으로 떨어진다.
//   CONDUIT_RERANK=off 면 켜지 않는다.
// ============================================================
import path from 'node:path';
import { DATA_DIR } from '../store.js';

export const RERANK_MODEL = process.env.CONDUIT_RERANK_MODEL || 'onnx-community/bge-reranker-v2-m3-ONNX';
const BATCH = 16;

let loading = null;
let lastError = null;
export const rerankerError = () => lastError;

/** @returns {Promise<((query:string, texts:string[]) => Promise<number[]>) | null>} 점수는 로짓 (클수록 관련) */
export async function getReranker() {
  if (process.env.CONDUIT_RERANK === 'off') { lastError = 'CONDUIT_RERANK=off'; return null; }
  if (!loading) {
    loading = (async () => {
      try {
        const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@huggingface/transformers');
        env.cacheDir = path.join(DATA_DIR, 'models');
        const tok = await AutoTokenizer.from_pretrained(RERANK_MODEL);
        const model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: 'q8' });
        return async (query, texts) => {
          const out = [];
          for (let i = 0; i < texts.length; i += BATCH) {
            const part = texts.slice(i, i + BATCH);
            const inputs = tok(part.map(() => query), { text_pair: part, padding: true, truncation: true, max_length: 512 });
            const { logits } = await model(inputs);
            out.push(...Array.from(logits.data));
          }
          return out;
        };
      } catch (e) {
        lastError = e.message;
        loading = null;
        return null;
      }
    })();
  }
  return loading;
}
