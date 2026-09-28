// ============================================================
// 표현식 엔진 — n8n 스타일 {{ $json.field }} 를 해석한다.
//   $json  : 현재 아이템(입력 객체)
//   $now   : 실행 시각(ISO 문자열)
//   $items : 입력 아이템 배열
//   $index : 아이템 인덱스
// ============================================================

import type { ExprContext, NodeParams } from './types.ts';

// ---- 안전 모드: 데이터 경로 읽기만 허용 (서버에서 코드 실행이 꺼져 있을 때) ----
//   허용: $json.a.b · $json["주문 번호"] · $items[0].x · $items.length · $index · $now
//   불가: 연산·함수 호출·전역 접근 등 경로가 아닌 모든 것 → 예외(재시도하지 않는 400)
const ROOTS: Record<string, (c: ExprContext) => unknown> = {
  json: (c) => c.$json ?? {},
  items: (c) => c.$items ?? [],
  index: (c) => c.$index ?? 0,
  now: (c) => c.$now,
};
const SEGMENT = /^(?:\.([\p{L}_$][\p{L}\p{N}_$]*)|\[(\d+)\]|\[(["'])(.*?)\3\])/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function blocked(src: string): Error & { status: number } {
  const err = new Error(`코드 실행이 꺼져 있어 표현식에는 데이터 경로만 쓸 수 있습니다: {{ ${src} }}`) as Error & { status: number };
  err.status = 400;
  return err;
}

function readKey(value: unknown, key: string): unknown {
  if (value == null) return undefined;
  const own = Object.prototype.hasOwnProperty.call(Object(value), key);
  if (own) return (value as Record<string, unknown>)[key];
  if (key === 'length' && (Array.isArray(value) || typeof value === 'string')) return value.length;
  return undefined; // 프로토타입 메서드 등은 읽지 않는다
}

export function evalPath(code: string, ctx: ExprContext): unknown {
  const src = String(code).trim();
  const root = src.match(/^\$(json|items|index|now)/);
  if (!root) throw blocked(src);
  let value = ROOTS[root[1]](ctx);
  let rest = src.slice(root[0].length);
  while (rest.length) {
    const m = rest.match(SEGMENT);
    if (!m) throw blocked(src);
    const key = m[1] ?? m[2] ?? m[4];
    if (FORBIDDEN_KEYS.has(key)) throw blocked(src);
    value = readKey(value, key);
    rest = rest.slice(m[0].length);
  }
  return value;
}

export function evalExpr(code: string, ctx: ExprContext): unknown {
  if (ctx.safeExpressions) return evalPath(code, ctx);
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('$json', '$now', '$items', '$index', `"use strict"; return (${code});`);
    return fn(ctx.$json ?? {}, ctx.$now, ctx.$items ?? [], ctx.$index ?? 0);
  } catch {
    return undefined;
  }
}

// 문자열 하나를 해석: 전체가 {{ }} 면 원래 타입 반환, 아니면 문자열 보간
export function resolveString(str: unknown, ctx: ExprContext): unknown {
  if (typeof str !== 'string' || !str.includes('{{')) return str;
  const whole = str.match(/^\s*\{\{([\s\S]+)\}\}\s*$/);
  // "{{ a }} {{ b }}" 도 위 패턴에 걸리므로, 안쪽에 다른 {{ 가 없을 때만 단일 표현식으로 본다
  if (whole && !whole[1].includes('{{')) return evalExpr(whole[1].trim(), ctx);
  return str.replace(/\{\{([\s\S]+?)\}\}/g, (_, e: string) => {
    const v = evalExpr(e.trim(), ctx);
    return v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// params 의 모든 문자열 필드에 표현식 해석 적용
export function resolveParams(params: NodeParams | undefined, ctx: ExprContext): NodeParams {
  const out: NodeParams = { ...params };
  for (const k in out) {
    if (typeof out[k] === 'string') out[k] = resolveString(out[k], ctx);
  }
  return out;
}

// 표현식에 문자열이 하나라도 있는지 (UI 표시에 활용 가능)
export function hasExpression(params: NodeParams | undefined): boolean {
  return Object.values(params || {}).some((v) => typeof v === 'string' && v.includes('{{'));
}
