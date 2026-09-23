// ============================================================
// 비서 템플릿 — 골라서 쓰기 (specs/006-personal-assistant)
//   템플릿마다 채울 값(fields)과 만들 워크플로(build)를 정한다. 값은 코드가 검증한 뒤에만 워크플로를 만든다.
//   만든 워크플로는 바로 켜지고(active) 예약이 등록된다. 결과는 텔레그램(보내기 모드)으로 온다.
// ============================================================
import crypto from 'node:crypto';
import { Workflows, ChangeState, Memory } from './store.js';
import { registerSchedules } from './runtime.js';
import { quickstart } from './quickstart.js';

const DAYS = { 매일: '*', 평일: '1-5', 주말: '0,6', 월요일: '1', 금요일: '5' };
const EVERY = { '10분마다': '*/10 * * * *', '1시간마다': '0 * * * *', '매일 아침 9시': '0 9 * * *' };

export function cronOf({ time = '09:00', days = '매일' } = {}) {
  const [h, m] = String(time).split(':').map(Number);
  return `${m} ${h} * * ${DAYS[days] ?? '*'}`;
}
/** 크론식을 사람 말로 */
export function cronToKorean(expr) {
  const [m, h, , , dow] = String(expr).split(' ');
  if (/^\*\/\d+$/.test(m)) return `${m.slice(2)}분마다`;
  if (m === '0' && h === '*') return '1시간마다';
  const day = Object.entries(DAYS).find(([, v]) => v === dow)?.[0] ?? '매일';
  const hh = Number(h);
  return `${day} ${hh < 12 ? '오전' : '오후'} ${hh % 12 || 12}시${Number(m) ? ` ${Number(m)}분` : ''}`;
}

const n = (id, kind, params, x) => ({ id, type: 'flow', position: { x, y: 160 }, data: { kind, params } });
const e = (source, target, sourceHandle = 'main') => ({ id: `e_${source}_${target}`, source, target, sourceHandle, targetHandle: 'main' });
const schedule = (cron) => n('when', 'scheduleTrigger', { interval: '직접 지정', cron }, 60);

export const TEMPLATES = [
  {
    id: 'read-and-reply', icon: '📖', title: '사진·글 읽고 답하기',
    desc: '휴대폰으로 보낸 사진이나 글을 읽고, 원문으로 확인된 내용만 요약해서 답해요. 전에 읽은 것과도 이어 줘요.',
    fields: [],
    special: 'quickstart',
  },
  {
    id: 'reminder', icon: '⏰', title: '할 일 알림',
    desc: '정한 시각에 휴대폰으로 알려 줘요. (예: 매일 8시 30분 약 먹기)',
    fields: [
      { key: 'time', label: '시각', type: 'time', default: '08:30' },
      { key: 'days', label: '요일', type: 'select', options: ['매일', '평일', '주말', '월요일', '금요일'], default: '매일' },
      { key: 'message', label: '알림 문구', type: 'text', default: '약 먹을 시간이에요 💊' },
    ],
    name: (p) => `할 일 알림 — ${cronToKorean(cronOf(p))} "${p.message}"`,
    build: (p) => ({
      nodes: [schedule(cronOf(p)), n('send', 'telegram', { chatId: '', text: `⏰ ${p.message}` }, 320)],
      edges: [e('when', 'send')],
    }),
  },
  {
    id: 'morning-brief', icon: '☀️', title: '아침 브리핑',
    desc: '정한 시각에 오늘의 인기 검색어 3개와 관련 기사 제목을 휴대폰으로 보내 줘요. 기사 제목을 그대로 옮겨서 지어낸 내용이 없어요.',
    fields: [
      { key: 'time', label: '시각', type: 'time', default: '08:00' },
      { key: 'days', label: '요일', type: 'select', options: ['매일', '평일', '주말'], default: '평일' },
    ],
    name: (p) => `아침 브리핑 — ${cronToKorean(cronOf(p))}`,
    build: (p) => ({
      nodes: [
        schedule(cronOf(p)),
        n('topics', 'hotTopics', { region: 'KR', limit: '3', minTraffic: '0', koreanOnly: 'true', skipDays: '0' }, 280),
        n('all', 'aggregate', { operation: 'toArray', field: '', target: 'items' }, 500),
        n('text', 'listText', { field: 'items', header: '☀️ 오늘의 인기 검색어', line: '• {topic} — {headlines.0.title} ({headlines.0.source})', target: 'text' }, 720),
        n('send', 'telegram', { chatId: '', text: '{{ $json.text }}' }, 940),
      ],
      edges: [e('when', 'topics'), e('topics', 'all'), e('all', 'text'), e('text', 'send')],
    }),
  },
  {
    id: 'page-watch', icon: '🔔', title: '웹페이지 바뀌면 알림',
    desc: '지켜볼 주소를 넣으면 정해진 간격으로 확인해서, 내용이 바뀌었을 때만 알려 줘요.',
    fields: [
      { key: 'url', label: '주소 (https://…)', type: 'text', default: 'https://' },
      { key: 'every', label: '확인 간격', type: 'select', options: Object.keys(EVERY), default: '1시간마다' },
    ],
    name: (p) => `페이지 감시 — ${p.url} (${p.every})`,
    build: (p) => ({
      nodes: [
        schedule(EVERY[p.every]),
        n('get', 'httpRequest', { method: 'GET', url: p.url, body: '' }, 280),
        n('diff', 'changeDetect', { key: `page:${p.url}`, field: 'data' }, 500),
        n('send', 'telegram', { chatId: '', text: `🔔 페이지가 바뀌었어요\n${p.url}` }, 720),
      ],
      edges: [e('when', 'get'), e('get', 'diff'), e('diff', 'send', 'changed')],
    }),
  },
  {
    id: 'memory-digest', icon: '🗂️', title: '이번 주 읽은 것 정리',
    desc: '일주일 동안 읽은 문서에서 원문으로 확인된 사실만 모아서 보내 줘요.',
    fields: [
      { key: 'time', label: '시각', type: 'time', default: '18:00' },
      { key: 'days', label: '요일', type: 'select', options: ['금요일', '월요일', '매일'], default: '금요일' },
    ],
    name: (p) => `읽은 것 정리 — ${cronToKorean(cronOf(p))}`,
    build: (p) => ({
      nodes: [schedule(cronOf(p)), n('facts', 'memoryDigest', { days: p.days === '매일' ? '1' : '7', target: 'text' }, 300), n('send', 'telegram', { chatId: '', text: '{{ $json.text }}' }, 540)],
      edges: [e('when', 'facts'), e('facts', 'send')],
    }),
  },
];

/** 값 검증 — 형식이 맞지 않으면 만들지 않는다 */
export function validateParams(tpl, params = {}) {
  const out = {};
  const errors = [];
  for (const f of tpl.fields) {
    const v = String(params[f.key] ?? f.default ?? '').trim();
    if (f.type === 'time' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) errors.push(`${f.label}: 00:00 ~ 23:59 형식이어야 해요`);
    else if (f.type === 'select' && !f.options.includes(v)) errors.push(`${f.label}: ${f.options.join(' · ')} 중 하나여야 해요`);
    else if (f.key === 'url' && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v)) errors.push('주소는 http:// 또는 https:// 로 시작해야 해요');
    else if (f.key === 'message' && (!v || v.length > 200)) errors.push('알림 문구는 1~200자여야 해요');
    out[f.key] = v;
  }
  return { ok: !errors.length, params: out, errors };
}

export const listTemplates = () => TEMPLATES.map(({ id, icon, title, desc, fields }) => ({ id, icon, title, desc, fields }));

/** 템플릿으로 자동화 만들기 → 켜고 예약 등록 */
export function createFromTemplate(id, params = {}, { registrar = registerSchedules } = {}) {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return { ok: false, errors: [`없는 템플릿: ${id}`] };
  if (tpl.special === 'quickstart') return { ok: true, ...quickstart(), name: tpl.title };
  const v = validateParams(tpl, params);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { nodes, edges } = tpl.build(v.params);
  const wf = Workflows.save({ name: tpl.name(v.params), active: true, nodes, edges });
  registrar(wf);
  const cron = nodes.find((x) => x.data.kind === 'scheduleTrigger')?.data.params.cron;
  return { ok: true, workflowId: wf.id, name: wf.name, when: cron ? cronToKorean(cron) : null, cron };
}

/* ---------- 브리지: 변경 감지 · 기억 모아 보기 ---------- */
export function changeDetect({ key, value }) {
  const hash = crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
  const prev = ChangeState.get(String(key));
  ChangeState.set(String(key), hash);
  if (!prev) return { changed: false, first: true };
  return { changed: prev.hash !== hash, first: false, since: prev.at };
}

export function memoryDigest({ days = 7, now = Date.now() } = {}) {
  const from = now - days * 86400000;
  const facts = Memory.all().filter((m) => m.type === 'fact' && Date.parse(m.createdAt || m.source?.readAt || 0) >= from);
  const byDoc = new Map();
  for (const f of facts) {
    const k = f.source?.title || f.docId || '(제목 없음)';
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k).push(f);
  }
  const lines = [`🗂️ 최근 ${days}일 동안 읽은 것 (원문으로 확인된 사실만)`];
  for (const [title, list] of byDoc) {
    lines.push('', `📄 ${title}`);
    for (const f of list.slice(0, 5)) lines.push(`• ${[].concat(f.quote || [])[0] || f.text}`);
  }
  if (!facts.length) lines.push('', '이번 기간에 새로 읽은 게 없어요.');
  return { text: lines.join('\n'), facts: facts.length, docs: byDoc.size };
}
