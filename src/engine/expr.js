// ============================================================
// 표현식 엔진 — n8n 스타일 {{ $json.field }} 를 해석한다.
//   $json  : 현재 아이템(입력 객체)
//   $now   : 실행 시각(ISO 문자열)
//   $items : 입력 아이템 배열
//   $index : 아이템 인덱스
// ============================================================

export function evalExpr(code, ctx) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('$json', '$now', '$items', '$index', `"use strict"; return (${code});`);
    return fn(ctx.$json ?? {}, ctx.$now, ctx.$items ?? [], ctx.$index ?? 0);
  } catch {
    return undefined;
  }
}

// 문자열 하나를 해석: 전체가 {{ }} 면 원래 타입 반환, 아니면 문자열 보간
export function resolveString(str, ctx) {
  if (typeof str !== 'string' || !str.includes('{{')) return str;
  const whole = str.match(/^\s*\{\{([\s\S]+)\}\}\s*$/);
  // "{{ a }} {{ b }}" 도 위 패턴에 걸리므로, 안쪽에 다른 {{ 가 없을 때만 단일 표현식으로 본다
  if (whole && !whole[1].includes('{{')) return evalExpr(whole[1].trim(), ctx);
  return str.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
    const v = evalExpr(e.trim(), ctx);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// params 의 모든 문자열 필드에 표현식 해석 적용
export function resolveParams(params, ctx) {
  const out = { ...params };
  for (const k in out) {
    if (typeof out[k] === 'string') out[k] = resolveString(out[k], ctx);
  }
  return out;
}

// 표현식에 문자열이 하나라도 있는지 (UI 표시에 활용 가능)
export function hasExpression(params) {
  return Object.values(params || {}).some((v) => typeof v === 'string' && v.includes('{{'));
}
