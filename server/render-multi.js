// ============================================================
// 올인원 다국어 쇼츠 공장
//   포맷 하나 + 언어 목록 → 언어별 MP4 + 언어별 유튜브 메타데이터를 한 번에 생산.
//   시각 자극(도트 원판, 튕기는 공)은 언어와 무관하므로 문구·내레이션만 갈아끼운다.
//   같은 seed/공 배치를 쓰므로 언어판끼리 화면이 완전히 동일하다 (정답도 동일).
// ============================================================
import { LOCALES, ytMeta } from './i18n.js';
import { renderColorVision } from './render-colorvision.js';
import { renderAttentionTest } from './render-attention.js';
import { renderTroxler } from './render-troxler.js';
import { renderDigitRatio } from './render-digit.js';

const FORMATS = {
  colorVision: { run: renderColorVision, label: '색각(숨은 숫자)' },
  attention: { run: renderAttentionTest, label: '집중력(공+고양이)' },
  troxler: { run: renderTroxler, label: '트록슬러 사라짐(해외용)' },
  digitRatio: { run: renderDigitRatio, label: '2D:4D 손가락 길이비' },
};

/**
 * 언어별 쇼츠 일괄 생산.
 * @param {object} opts
 * @param {'colorVision'|'attention'} opts.format
 * @param {string[]} [opts.locales]  기본 ['ko','en'] — 지원: ko/en/ja/es
 * @param {boolean} [opts.continueOnError] 한 언어가 실패해도 나머지 진행 (기본 true)
 * @param {object} [opts....] 포맷별 옵션(plates, balls, catAt, playSec 등)이 그대로 전달됨
 * @returns {Promise<{ok:boolean, format:string, count:number, results:Array}>}
 */
export async function renderMultiLang({ format, locales, continueOnError = true, ...opts } = {}) {
  const def = FORMATS[format];
  if (!def) {
    return { ok: false, error: `알 수 없는 포맷: ${format} (지원: ${Object.keys(FORMATS).join(', ')})` };
  }

  const langs = (Array.isArray(locales) && locales.length ? locales : ['ko', 'en'])
    .map((l) => String(l).trim().toLowerCase())
    .filter((l) => LOCALES.includes(l));
  if (!langs.length) {
    return { ok: false, error: `유효한 언어가 없습니다 (지원: ${LOCALES.join(', ')})` };
  }

  const results = [];
  // 순차 실행 — Remotion 렌더는 CPU를 다 쓰므로 병렬로 돌리면 서로 느려진다
  for (const locale of langs) {
    const meta = ytMeta(format, locale);
    try {
      const r = await def.run({ ...opts, locale });
      if (r?.ok) {
        results.push({
          locale, ok: true,
          file: r.file, thumbnail: r.thumbnail,
          durationSec: r.durationSec, sizeMB: r.sizeMB,
          ...(r.answer != null ? { answer: r.answer } : {}),
          upload: { title: meta.title, description: meta.desc, tags: meta.tags, defaultLanguage: locale },
        });
      } else {
        results.push({ locale, ok: false, error: r?.error || r?.note || '렌더 실패' });
        if (!continueOnError) break;
      }
    } catch (e) {
      results.push({ locale, ok: false, error: e.message });
      if (!continueOnError) break;
    }
  }

  const done = results.filter((r) => r.ok);
  return {
    ok: done.length > 0,
    format, formatLabel: def.label,
    requested: langs.length,
    count: done.length,
    failed: results.length - done.length,
    files: done.map((r) => r.file),
    results,
  };
}
