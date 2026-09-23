// 테스트용 가짜 임베더 — 글자 2-gram 을 256칸에 해시해 정규화한 벡터.
// 진짜 모델과 달리 결정론적이고 네트워크가 필요 없다. 글자를 많이 공유하는 문장끼리 가깝다.
const DIM = 256;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % DIM;
}

export function fakeVector(text) {
  const t = String(text).replace(/^(query|passage):\s*/, '').replace(/\s+/g, '');
  const v = new Array(DIM).fill(0);
  for (let i = 0; i < t.length - 1; i++) v[hash(t.slice(i, i + 2))] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

/** embedder 인터페이스와 같다: (texts, mode) → number[][] */
export async function fakeEmbed(texts) {
  return texts.map(fakeVector);
}
