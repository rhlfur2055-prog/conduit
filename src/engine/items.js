// ============================================================
// 아이템(배열) 데이터 모델 — n8n 식 데이터 흐름의 기본 단위
//
//   노드 포트의 값 = 아이템 배열 (items[])
//   아이템 하나 = 평범한 객체
//
// 하위호환: 기존 노드가 단일 객체를 반환하면 [객체] 로 감싼다.
// ============================================================

/** 어떤 값이든 아이템 배열로 정규화. undefined/null → [] */
export function toItems(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 배열이 비면 undefined (= 이 경로로 데이터가 흐르지 않음) */
export function emptyToUndefined(items) {
  return Array.isArray(items) && items.length === 0 ? undefined : items;
}

/** 첫 아이템 (단일 값이 필요한 UI/요약용) */
export function firstItem(value) {
  const items = toItems(value);
  return items.length ? items[0] : undefined;
}

/** 아이템 개수 */
export function countItems(value) {
  return toItems(value).length;
}

/** 배열을 size 단위 청크로 자른다. size<=0 이면 통짜 하나. */
export function chunk(arr, size) {
  if (!size || size <= 0) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** "a.b.c" 경로로 중첩 값 읽기 */
export function getPath(obj, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** 정렬/중복제거 비교용 안정적 키 — 중첩 객체까지 키를 정렬해 직렬화 */
export function stableKey(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(sortKeysDeep(value)); } catch { return String(value); }
  }
  return String(value);
}

// JSON.stringify 의 배열 replacer 는 모든 깊이에 같은 키 목록을 적용해
// 중첩 객체의 다른 키를 버린다 — 그래서 직접 정렬한 사본을 만든다.
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeysDeep(value[k]);
    return out;
  }
  return value;
}
