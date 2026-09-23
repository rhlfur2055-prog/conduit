// ============================================================
// 상황별 청킹 (specs/001-verified-memory · FR-001 FR-002)
//
//   detectKind() 로 글 종류를 판별하고 종류마다 다른 방식으로 자른다.
//     screen   : OCR 좌표가 있는 줄 → 세로로 가까운 줄끼리 (버튼·폼 묶음)
//     code     : 최상위 함수·클래스 단위
//     markdown : 제목 단위, 조각 앞에 제목 경로("안내 > 연체")를 붙인다
//     table    : 행 단위, "머리글: 값" 으로 풀어 쓴다 (행만 떼어도 뜻이 남도록)
//     dialogue : 발화 단위, 같은 사람이 이어 말하면 합친다
//     short    : 통째로 한 조각
//     prose    : 시맨틱 청킹 — 인접 문장 임베딩 거리가 크게 벌어지는 곳에서 자른다
//
//   모든 조각은 { kind, text, lines } 이다. lines 는 입력이 줄 단위(units)일 때 원래 줄 번호.
//   임베더가 없으면 prose 는 문단·길이로 자른다. 같은 입력은 항상 같은 조각이 나온다 (SC-001).
// ============================================================

const DEFAULTS = { maxChars: 800, minSentences: 2, percentile: 0.9, shortChars: 120 };

/** 한국어·영문 문장 분리 — 마침표·물음표·느낌표 뒤 공백, 그리고 줄바꿈. 3.5 · v1.2 는 자르지 않는다 */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=[.?!。])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

const lineList = ({ text, units }) => (units?.length ? units.map((u) => String(u.text ?? '')) : String(text ?? '').split(/\r?\n/)).filter((l) => l.trim());

const CODE_LINE = /^\s*((export\s+)?(async\s+)?(function|class)\b|def\s|import\s|return\b|if\s*\(|for\s*\(|const\s+\w+\s*=)|[{};]\s*$/;
const MD_HEADING = /^(#{1,6})\s+(.*)$/;
const SPEAKER = /^([^\s:：]{1,15})\s?[:：]\s*(.+)$/;

function tableDelimiter(lines) {
  if (lines.length < 3) return null;
  for (const d of ['\t', '|', ',']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    if (counts[0] >= 1 && counts.every((c) => c === counts[0])) return d;
  }
  return null;
}

/** FR-001 — 글 종류 판별 */
export function detectKind({ text, units } = {}) {
  if (units?.some((u) => u.box)) return 'screen';
  const lines = lineList({ text, units });
  const all = lines.join('\n');
  if (lines.length >= 3 && lines.filter((l) => CODE_LINE.test(l)).length / lines.length >= 0.5) return 'code';
  if (lines.some((l) => MD_HEADING.test(l.trim()))) return 'markdown';
  if (tableDelimiter(lines)) return 'table';
  if (lines.length >= 2 && lines.filter((l) => SPEAKER.test(l.trim())).length / lines.length >= 0.6) return 'dialogue';
  if (all.length < DEFAULTS.shortChars) return 'short';
  return 'prose';
}

/* ---------- 도우미 ---------- */

const toUnits = ({ text, units }) => (units?.length
  ? units.map((u) => ({ id: u.id ?? null, text: String(u.text ?? '').trim(), box: u.box })).filter((u) => u.text)
  : String(text ?? '').split(/\r?\n/).map((t) => ({ id: null, text: t.trim() })).filter((u) => u.text));

const ids = (us) => us.map((u) => u.id).filter(Boolean);
const make = (kind, text, us = []) => ({ kind, text: text.trim(), lines: ids(us) });

function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 문장 목록을 최대 길이 안에서 이어 붙인다. 한 문장이 너무 길면 글자 수로 자른다 */
function packByLength(items, maxChars, sep = ' ') {
  const out = [];
  let cur = [];
  let len = 0;
  const flush = () => { if (cur.length) out.push(cur); cur = []; len = 0; };
  for (const it of items) {
    if (it.text.length > maxChars) {
      flush();
      for (let i = 0; i < it.text.length; i += maxChars) out.push([{ ...it, text: it.text.slice(i, i + maxChars) }]);
      continue;
    }
    if (len && len + sep.length + it.text.length > maxChars) flush();
    cur.push(it);
    len += (len ? sep.length : 0) + it.text.length;
  }
  flush();
  return out;
}

/* ---------- 종류별 ---------- */

function chunkMarkdown(us, o) {
  const out = [];
  const path = [];
  let body = [];
  let head = [];
  const flush = () => {
    const members = [...head, ...body];
    if (!body.length && !head.length) return;
    const title = path.filter(Boolean).join(' > ');
    const text = [title, ...body.map((u) => u.text)].filter(Boolean).join('\n');
    if (text.length <= o.maxChars) out.push(make('markdown', text, members));
    else for (const g of packByLength(body, o.maxChars - title.length - 1, '\n')) out.push(make('markdown', [title, ...g.map((u) => u.text)].filter(Boolean).join('\n'), g));
    body = []; head = [];
  };
  for (const u of us) {
    const m = u.text.match(MD_HEADING);
    if (m) {
      flush();
      const level = m[1].length;
      path.length = level - 1;
      path[level - 1] = m[2].trim();
      head = [u];
    } else body.push(u);
  }
  flush();
  return out;
}

function chunkTable(us) {
  const d = tableDelimiter(us.map((u) => u.text));
  const cells = (t) => t.split(d).map((c) => c.trim()).filter((c, i, a) => !(d === '|' && (i === 0 || i === a.length - 1) && c === ''));
  const header = cells(us[0].text);
  return us.slice(1)
    .filter((u) => !/^[\s|:-]+$/.test(u.text))            // 마크다운 표의 구분선
    .map((u) => make('table', cells(u.text).map((v, i) => `${header[i] ?? `열${i + 1}`}: ${v}`).join(' · '), [u]));
}

function chunkDialogue(us) {
  const turns = [];
  for (const u of us) {
    const m = u.text.match(SPEAKER);
    const last = turns[turns.length - 1];
    if (m && last?.speaker === m[1]) { last.parts.push(m[2]); last.us.push(u); }
    else if (m) turns.push({ speaker: m[1], parts: [m[2]], us: [u] });
    else if (last) { last.parts.push(u.text); last.us.push(u); }
    else turns.push({ speaker: '', parts: [u.text], us: [u] });
  }
  return turns.map((t) => make('dialogue', `${t.speaker ? `${t.speaker}: ` : ''}${t.parts.join(' ')}`, t.us));
}

const CODE_START = /^(export\s+)?(default\s+)?(async\s+)?(function|class)\b|^def\s|^class\s|^(export\s+)?const\s+\w+\s*=\s*(async\s*)?(\(|function)/;

function chunkCode(text, us) {
  // 코드는 빈 줄·들여쓰기가 뜻을 가지므로 원래 줄을 그대로 쓴다
  const raw = us?.length ? us.map((u) => u.text) : String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let cur = [];
  for (const line of raw) {
    if (CODE_START.test(line) && cur.some((l) => l.trim())) { blocks.push(cur); cur = []; }
    cur.push(line);
  }
  blocks.push(cur);
  return blocks.map((b) => b.join('\n').trim()).filter(Boolean).map((t) => make('code', t));
}

function chunkScreen(us) {
  const withBox = us.filter((u) => u.box);
  const hs = withBox.map((u) => u.box.h).sort((a, b) => a - b);
  const median = hs[Math.floor(hs.length / 2)] || 16;
  const sorted = [...withBox].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  const groups = [];
  for (const u of sorted) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    if (prev && u.box.y - (prev.box.y + prev.box.h) <= 1.5 * median) g.push(u);
    else groups.push([u]);
  }
  return groups.map((g) => make('screen', g.map((u) => u.text).join('\n'), g));
}

async function chunkProse({ text, units }, embed, o) {
  // 줄 단위 입력(socraticRead)은 줄을, 텍스트는 문장을 단위로 쓴다
  const items = units?.length
    ? toUnits({ units })
    : splitSentences(text).map((t) => ({ id: null, text: t }));
  if (!items.length) return [];

  let groups;
  if (typeof embed === 'function' && items.length > 2) {
    const vecs = await embed(items.map((s) => `passage: ${s.text}`), 'passage');
    const dist = items.slice(1).map((_, i) => 1 - cosine(vecs[i], vecs[i + 1]));
    const sorted = [...dist].sort((a, b) => a - b);
    const cut = sorted[Math.floor(o.percentile * (sorted.length - 1))];
    groups = [[items[0]]];
    dist.forEach((d, i) => {
      if (d > cut) groups.push([]);
      groups[groups.length - 1].push(items[i + 1]);
    });
    // 너무 짧은 조각은 앞 조각에 붙인다 (맨 앞이면 뒤 조각과 합친다)
    const merged = [];
    for (const g of groups) {
      if (merged.length && g.length < o.minSentences) merged[merged.length - 1].push(...g);
      else merged.push(g);
    }
    if (merged.length > 1 && merged[0].length < o.minSentences) merged.splice(0, 2, [...merged[0], ...merged[1]]);
    groups = merged;
  } else if (!units?.length && /\n\s*\n/.test(String(text))) {
    groups = String(text).split(/\n\s*\n/).map((p) => splitSentences(p).map((t) => ({ id: null, text: t }))).filter((g) => g.length);
  } else {
    groups = [items];
  }
  return groups.flatMap((g) => packByLength(g, o.maxChars)).map((g) => make('prose', g.map((s) => s.text).join(' '), g));
}

/**
 * 종류를 판별해(또는 kind 로 지정) 자른다.
 * @param {{ text?:string, units?:{id,text,box?}[], kind?:string, embed?:(texts:string[], mode:string)=>Promise<number[][]>, opts?:object }} p
 */
export async function chunk({ text, units, kind, embed, opts = {} } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const k = kind || detectKind({ text, units });
  const us = toUnits({ text, units });
  const whole = us.map((u) => u.text).join('\n');
  if (!us.length) return [];
  switch (k) {
    case 'short': return [make('short', units?.length ? whole : String(text).trim(), us)];
    case 'markdown': return chunkMarkdown(us, o);
    case 'table': return chunkTable(us);
    case 'dialogue': return chunkDialogue(us);
    case 'code': return chunkCode(text, units);
    case 'screen': return chunkScreen(us);
    default: return chunkProse({ text, units }, embed, o);
  }
}
