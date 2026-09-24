// ============================================================
// 비서 템플릿 — 골라서 쓰기 (specs/006-personal-assistant · 007-people-and-languages)
//   템플릿마다 채울 값(fields)과 만들 워크플로(build)를 정한다. 값은 코드가 검증한 뒤에만 워크플로를 만든다.
//   만든 워크플로는 바로 켜지고(active) 예약이 등록된다. 결과는 텔레그램(보내기 모드)으로 온다.
//   사람마다 따로: 만든 사람(ownerId)을 워크플로에 남기고, 알림은 **그 사람의 채팅으로만** 보낸다.
//   문구·이름은 그 사람 언어(ko/en)로. 선택값(매일·평일…)은 안에서는 한국어 값 그대로 쓴다.
// ============================================================
import crypto from 'node:crypto';
import { Workflows, ChangeState, Memory, People } from './store.js';
import { registerSchedules } from './runtime.js';
import { quickstart } from './quickstart.js';
import { normLang, optionLabel } from './lang.js';

const DAYS = { 매일: '*', 평일: '1-5', 주말: '0,6', 월요일: '1', 금요일: '5' };
const EVERY = { '10분마다': '*/10 * * * *', '1시간마다': '0 * * * *', '매일 아침 9시': '0 9 * * *' };

export function cronOf({ time = '09:00', days = '매일' } = {}) {
  const [h, m] = String(time).split(':').map(Number);
  return `${m} ${h} * * ${DAYS[days] ?? '*'}`;
}
/** 크론식을 사람 말로 (한국어 · 영어) */
export function describeCron(expr, lang = 'ko') {
  const en = normLang(lang) === 'en';
  const [m, h, , , dow] = String(expr).split(' ');
  if (/^\*\/\d+$/.test(m)) return en ? `every ${m.slice(2)} min` : `${m.slice(2)}분마다`;
  if (m === '0' && h === '*') return en ? 'every hour' : '1시간마다';
  const day = Object.entries(DAYS).find(([, v]) => v === dow)?.[0] ?? '매일';
  const hh = Number(h);
  if (en) return `${optionLabel(day, 'en').toLowerCase()} at ${hh % 12 || 12}:${String(Number(m)).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  return `${day} ${hh < 12 ? '오전' : '오후'} ${hh % 12 || 12}시${Number(m) ? ` ${Number(m)}분` : ''}`;
}
export const cronToKorean = (expr) => describeCron(expr, 'ko');

const n = (id, kind, params, x) => ({ id, type: 'flow', position: { x, y: 160 }, data: { kind, params } });
const e = (source, target, sourceHandle = 'main') => ({ id: `e_${source}_${target}`, source, target, sourceHandle, targetHandle: 'main' });
const schedule = (cron) => n('when', 'scheduleTrigger', { interval: '직접 지정', cron }, 60);
// 보낼 곳은 코드가 정한다 — 만든 사람의 채팅. 사람을 모르면 비워 두어 기본 채팅(PC 주인)으로
const send = (ctx, text, x) => n('send', 'telegram', { chatId: ctx.chatId || '', text }, x);

export const TEMPLATES = [
  {
    id: 'read-and-reply', icon: '📖',
    title: { ko: '사진·글 읽고 답하기', en: 'Read & reply' },
    desc: {
      ko: '휴대폰으로 보낸 사진이나 글을 읽고, 원문으로 확인된 내용만 요약해서 답해요. 전에 읽은 것과도 이어 줘요.',
      en: 'Send a photo or text from your phone; it reads it and replies only with what it could verify against the source.',
    },
    fields: [],
    special: 'quickstart',
  },
  {
    id: 'reminder', icon: '⏰',
    title: { ko: '할 일 알림', en: 'Reminder' },
    desc: { ko: '정한 시각에 휴대폰으로 알려 줘요. (예: 매일 8시 30분 약 먹기)', en: 'Pings your phone at the time you choose (e.g. every day 8:30 — take medicine).' },
    fields: [
      { key: 'time', label: { ko: '시각', en: 'Time' }, type: 'time', default: '08:30', personal: 'wake' },
      { key: 'days', label: { ko: '요일', en: 'Days' }, type: 'select', options: ['매일', '평일', '주말', '월요일', '금요일'], default: '매일' },
      { key: 'message', label: { ko: '알림 문구', en: 'Message' }, type: 'text', default: { ko: '약 먹을 시간이에요 💊', en: 'Time for your medicine 💊' } },
    ],
    name: (p, L) => (L === 'en' ? `Reminder — ${describeCron(cronOf(p), 'en')} "${p.message}"` : `할 일 알림 — ${cronToKorean(cronOf(p))} "${p.message}"`),
    build: (p, ctx) => ({ nodes: [schedule(cronOf(p)), send(ctx, `⏰ ${p.message}`, 320)], edges: [e('when', 'send')] }),
  },
  {
    id: 'morning-brief', icon: '☀️',
    title: { ko: '아침 브리핑', en: 'Morning brief' },
    desc: {
      ko: '정한 시각에 오늘의 인기 검색어와 관련 기사 제목을 휴대폰으로 보내 줘요. 관심사가 있으면 그것부터. 기사 제목을 그대로 옮겨서 지어낸 내용이 없어요.',
      en: 'Today\'s trending searches with a headline each, filtered by your interests first. Headlines are copied verbatim — nothing is made up.',
    },
    fields: [
      { key: 'time', label: { ko: '시각', en: 'Time' }, type: 'time', default: '08:00', personal: 'wake' },
      { key: 'days', label: { ko: '요일', en: 'Days' }, type: 'select', options: ['매일', '평일', '주말'], default: '평일' },
    ],
    name: (p, L) => (L === 'en' ? `Morning brief — ${describeCron(cronOf(p), 'en')}` : `아침 브리핑 — ${cronToKorean(cronOf(p))}`),
    build: (p, ctx) => {
      const interests = (ctx.interests || []).join(',');
      const en = ctx.lang === 'en';
      return {
        nodes: [
          schedule(cronOf(p)),
          // 관심사가 있으면 넉넉히 받아서 거른다
          n('topics', 'hotTopics', { region: en ? 'US' : 'KR', limit: interests ? '5' : '3', minTraffic: '0', koreanOnly: en ? 'false' : 'true', skipDays: '0' }, 280),
          n('all', 'aggregate', { operation: 'toArray', field: '', target: 'items' }, 500),
          n('text', 'listText', {
            field: 'items', header: en ? '☀️ Trending today' : '☀️ 오늘의 인기 검색어', line: '• {topic} — {headlines.0.title} ({headlines.0.source})', target: 'text',
            prefer: interests, max: '3', noMatch: interests ? (en ? `(nothing about ${interests} today — showing the top ones)` : `(오늘은 ${interests} 관련이 없어 상위 검색어를 보여 드려요)`) : '',
          }, 720),
          send(ctx, '{{ $json.text }}', 940),
        ],
        edges: [e('when', 'topics'), e('topics', 'all'), e('all', 'text'), e('text', 'send')],
      };
    },
  },
  {
    id: 'page-watch', icon: '🔔',
    title: { ko: '웹페이지 바뀌면 알림', en: 'Page watch' },
    desc: { ko: '지켜볼 주소를 넣으면 정해진 간격으로 확인해서, 내용이 바뀌었을 때만 알려 줘요.', en: 'Checks a page on a schedule and pings you only when its content changes.' },
    fields: [
      { key: 'url', label: { ko: '주소 (https://…)', en: 'URL (https://…)' }, type: 'text', default: 'https://' },
      { key: 'every', label: { ko: '확인 간격', en: 'Check every' }, type: 'select', options: Object.keys(EVERY), default: '1시간마다' },
    ],
    name: (p, L) => (L === 'en' ? `Page watch — ${p.url} (${optionLabel(p.every, 'en')})` : `페이지 감시 — ${p.url} (${p.every})`),
    build: (p, ctx) => ({
      nodes: [
        schedule(EVERY[p.every]),
        n('get', 'httpRequest', { method: 'GET', url: p.url, body: '' }, 280),
        // 감시 기록도 사람마다 따로 — 같은 주소를 두 사람이 지켜봐도 서로의 "처음 본 값" 을 건드리지 않는다
        n('diff', 'changeDetect', { key: `page:${ctx.ownerId && ctx.ownerId !== 'owner' ? `${ctx.ownerId}:` : ''}${p.url}`, field: 'data' }, 500),
        send(ctx, ctx.lang === 'en' ? `🔔 The page changed\n${p.url}` : `🔔 페이지가 바뀌었어요\n${p.url}`, 720),
      ],
      edges: [e('when', 'get'), e('get', 'diff'), e('diff', 'send', 'changed')],
    }),
  },
  {
    id: 'memory-digest', icon: '🗂️',
    title: { ko: '이번 주 읽은 것 정리', en: 'Weekly digest' },
    desc: { ko: '일주일 동안 읽은 문서에서 원문으로 확인된 사실만 모아서 보내 줘요.', en: 'Facts you read this week — only the ones that passed quote verification.' },
    fields: [
      { key: 'time', label: { ko: '시각', en: 'Time' }, type: 'time', default: '18:00' },
      { key: 'days', label: { ko: '요일', en: 'Days' }, type: 'select', options: ['금요일', '월요일', '매일'], default: '금요일' },
    ],
    name: (p, L) => (L === 'en' ? `Weekly digest — ${describeCron(cronOf(p), 'en')}` : `읽은 것 정리 — ${cronToKorean(cronOf(p))}`),
    build: (p, ctx) => ({
      nodes: [
        schedule(cronOf(p)),
        // 그 사람의 기억만 모은다
        n('facts', 'memoryDigest', { days: p.days === '매일' ? '1' : '7', target: 'text', owner: ctx.ownerId || 'owner', lang: ctx.lang }, 300),
        send(ctx, '{{ $json.text }}', 540),
      ],
      edges: [e('when', 'facts'), e('facts', 'send')],
    }),
  },
];

const pick = (v, L) => (v && typeof v === 'object' ? v[L] ?? v.ko : v);

/** 누구를 위한 것인가 — 사람 ID 로 채팅·언어·일어나는 시각·관심사를 찾는다 (없으면 PC 주인) */
export function personContext(ownerId = 'owner') {
  const p = (ownerId === 'owner' ? People.get('owner') : People.get(ownerId)) || { id: ownerId, lang: 'ko' };
  return { ownerId: p.id || ownerId, chatId: p.chatId || '', lang: normLang(p.lang), wake: p.wake || null, interests: p.interests || [], name: p.name || '' };
}

/** 그 사람에게 맞춘 기본값 — 일어나는 시각이 있으면 아침 시각 칸의 기본값으로 */
function defaultOf(f, ctx) {
  if (f.personal === 'wake' && ctx?.wake) return ctx.wake;
  return pick(f.default, ctx?.lang || 'ko');
}

/** 값 검증 — 형식이 맞지 않으면 만들지 않는다 */
export function validateParams(tpl, params = {}, ctx = null) {
  const L = ctx?.lang || 'ko';
  const en = L === 'en';
  const out = {};
  const errors = [];
  for (const f of tpl.fields) {
    const v = String(params[f.key] ?? defaultOf(f, ctx) ?? '').trim();
    const label = pick(f.label, L);
    if (f.type === 'time' && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) errors.push(en ? `${label}: must be 00:00–23:59` : `${label}: 00:00 ~ 23:59 형식이어야 해요`);
    else if (f.type === 'select' && !f.options.includes(v)) errors.push(en ? `${label}: one of ${f.options.map((o) => optionLabel(o, 'en')).join(' · ')}` : `${label}: ${f.options.join(' · ')} 중 하나여야 해요`);
    else if (f.key === 'url' && !/^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v)) errors.push(en ? 'The URL must start with http:// or https://' : '주소는 http:// 또는 https:// 로 시작해야 해요');
    else if (f.key === 'message' && (!v || v.length > 200)) errors.push(en ? 'The message must be 1–200 characters' : '알림 문구는 1~200자여야 해요');
    out[f.key] = v;
  }
  return { ok: !errors.length, params: out, errors };
}

/** 화면·비서에 보여 줄 목록 — 그 사람 언어로, 그 사람 기본값으로 */
export const listTemplates = (lang = 'ko', ownerId = 'owner') => {
  const L = normLang(lang);
  const ctx = { ...personContext(ownerId), lang: L };
  return TEMPLATES.map(({ id, icon, title, desc, fields }) => ({
    id, icon, title: pick(title, L), desc: pick(desc, L),
    fields: fields.map((f) => ({
      key: f.key, type: f.type, label: pick(f.label, L), default: defaultOf(f, ctx),
      ...(f.options ? { options: f.options, optionLabels: f.options.map((o) => optionLabel(o, L)) } : {}),
    })),
  }));
};
export const templateTitle = (tpl, lang) => pick(tpl.title, normLang(lang));

/** 템플릿으로 자동화 만들기 → 켜고 예약 등록. ownerId 의 채팅으로 보내고, 그 사람 것으로 남긴다 */
export function createFromTemplate(id, params = {}, { registrar = registerSchedules, ownerId = 'owner' } = {}) {
  const ctx = personContext(ownerId);
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) return { ok: false, errors: [ctx.lang === 'en' ? `No such template: ${id}` : `없는 템플릿: ${id}`] };
  if (tpl.special === 'quickstart') return { ok: true, ...quickstart(), name: pick(tpl.title, ctx.lang) };
  const v = validateParams(tpl, params, ctx);
  if (!v.ok) return { ok: false, errors: v.errors };
  const { nodes, edges } = tpl.build(v.params, ctx);
  const wf = Workflows.save({ name: tpl.name(v.params, ctx.lang), active: true, nodes, edges, ownerId: ctx.ownerId });
  registrar(wf);
  const cron = nodes.find((x) => x.data.kind === 'scheduleTrigger')?.data.params.cron;
  return { ok: true, workflowId: wf.id, name: wf.name, when: cron ? describeCron(cron, ctx.lang) : null, cron };
}

/* ---------- 브리지: 변경 감지 · 기억 모아 보기 ---------- */
export function changeDetect({ key, value }) {
  const hash = crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');
  const prev = ChangeState.get(String(key));
  ChangeState.set(String(key), hash);
  if (!prev) return { changed: false, first: true };
  return { changed: prev.hash !== hash, first: false, since: prev.at };
}

export function memoryDigest({ days = 7, now = Date.now(), ownerId = 'owner', lang = 'ko' } = {}) {
  const en = normLang(lang) === 'en';
  const from = now - days * 86400000;
  const facts = Memory.all().filter((m) => m.type === 'fact' && (m.ownerId || 'owner') === ownerId && Date.parse(m.createdAt || m.source?.readAt || 0) >= from);
  const byDoc = new Map();
  for (const f of facts) {
    const k = f.source?.title || f.docId || (en ? '(untitled)' : '(제목 없음)');
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k).push(f);
  }
  const lines = [en ? `🗂️ What you read in the last ${days} day(s) (verified facts only)` : `🗂️ 최근 ${days}일 동안 읽은 것 (원문으로 확인된 사실만)`];
  for (const [title, list] of byDoc) {
    lines.push('', `📄 ${title}`);
    for (const f of list.slice(0, 5)) lines.push(`• ${[].concat(f.quote || [])[0] || f.text}`);
  }
  if (!facts.length) lines.push('', en ? 'Nothing new this period.' : '이번 기간에 새로 읽은 게 없어요.');
  return { text: lines.join('\n'), facts: facts.length, docs: byDoc.size };
}
