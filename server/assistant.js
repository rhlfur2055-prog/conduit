// ============================================================
// 말로 시키기 — 개인 비서 (specs/006-personal-assistant · 007-people-and-languages)
//
//   1) 규칙으로 먼저 알아듣는다 (키 없이 · 결정론 · 테스트 가능) — 한국어 · 영어
//   2) 규칙으로 모르면 LLM 이 "정해진 동작" 중 하나로 옮긴다 — 코드가 검증한다
//   3) 자동화를 새로 만들거나 밖으로 내보내는 워크플로를 실행하는 것은 [만들기]/[실행] 확인을 거친다
//   4) 기억 질문은 LLM 이 답을 쓰지 않는다 — 기억 조각 원문을 출처와 함께 그대로 보여 준다
//   5) 사람마다 따로 — 기억 · 자동화 목록 · 실행 기록 · 확인 버튼은 그 사람 것만 (PC 주인은 목록·기록을 전부 본다)
// ============================================================
import { Workflows, PendingActions, Executions, People } from './store.js';
import { callLLM } from './llm.js';
import { parseJson } from './vision.js';
import { TEMPLATES, validateParams, createFromTemplate, cronOf, describeCron, listTemplates, personContext } from './templates.js';
import { hasSideEffects } from './heartbeat.js';
import { recall } from './memory/memory.js';
import { execute as runtimeExecute } from './runtime.js';
import { t, normLang } from './lang.js';

const TRIGGERS = new Set(['webhookTrigger', 'manualTrigger', 'scheduleTrigger']);
export const HELP = t('ko', 'help');
const HANGUL = /[가-힣]/;

/* ---------- 1) 규칙 — 한국어 ---------- */

/** "오후 3시 반" → "15:30". 오전·오후가 없으면 1~6시는 오후, 7~11시는 오전으로 본다 (확인 단계에서 사람이 본다) */
export function parseTime(text) {
  const m = /(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반)|\s*(\d{1,2})\s*분)?/.exec(text);
  if (!m) return parseTimeEn(text);
  let h = Number(m[2]);
  const min = m[3] ? 30 : Number(m[4] || 0);
  const mer = m[1];
  if (h > 23 || min > 59) return null;
  if ((mer === '오후' || mer === '저녁' || mer === '밤') && h < 12) h += 12;
  else if ((mer === '오전' || mer === '아침' || mer === '새벽') && h === 12) h = 0;
  else if (!mer && h >= 1 && h <= 6) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}
const parseDays = (t) => (/평일/.test(t) ? '평일' : /주말/.test(t) ? '주말' : /월요일/.test(t) ? '월요일' : /금요일/.test(t) ? '금요일' : '매일');

/** "약 먹으라고" → "약 먹기" 처럼 알림 문구를 다듬는다 */
export function reminderMessage(text) {
  let s = text
    .replace(/(매일|평일|주말|월요일마다|금요일마다|월요일|금요일|매주|아침마다|저녁마다)/g, ' ')
    .replace(/(오전|오후|아침|저녁|밤|새벽)?\s*\d{1,2}\s*시(\s*반|\s*\d{1,2}\s*분)?(에|마다)?/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(에)?/g, ' ')
    .replace(/(좀\s*)?(알려\s*줘|알려\s*주세요|알림\s*줘|알려|알림|말해\s*줘|깨워\s*줘)[.!~ ]*$/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (/하라고$/.test(s)) s = `${s.slice(0, -2)}기`;
  else if (/으라고$/.test(s)) s = `${s.slice(0, -3)}기`;
  else if (/라고$/.test(s)) s = `${s.slice(0, -2)}기`;
  else if (/다고$/.test(s)) s = s.slice(0, -1);
  return s.slice(0, 200) || '알림';
}

function parseKo(t, ctx) {
  if (/^(\/?help|도움말?|뭐\s*할\s*수\s*있|할\s*수\s*있는\s*(거|것|일)|사용법)/.test(t)) return { action: 'help' };
  const url = /(https?:\/\/[^\s]+)/.exec(t)?.[1];
  if (url && /(바뀌|변하|변경|업데이트|감시|지켜)/.test(t)) {
    return { action: 'template', template: 'page-watch', params: { url, every: /10\s*분/.test(t) ? '10분마다' : /(매일|하루)/.test(t) ? '매일 아침 9시' : '1시간마다' } };
  }
  if (/(읽은\s*(것|거|문서)).*(정리|모아|요약)/.test(t)) {
    return { action: 'template', template: 'memory-digest', params: { time: parseTime(t) || '18:00', days: /매일/.test(t) ? '매일' : /월요일/.test(t) ? '월요일' : '금요일' } };
  }
  // "보내·알려" 가 있을 때만 — "핫이슈 쇼츠 실행해줘" 같은 실행 요청을 브리핑으로 오인하지 않게
  if (/(브리핑|인기\s*검색어|핫이슈)/.test(t) && /(보내|알려)/.test(t)) {
    return { action: 'template', template: 'morning-brief', params: { time: parseTime(t) || ctx.wake || '08:00', days: /평일/.test(t) ? '평일' : /주말/.test(t) ? '주말' : '매일' } };
  }
  if (/(사진|글).*(보내면|오면).*(읽|답)/.test(t)) return { action: 'template', template: 'read-and-reply', params: {} };
  const isRecall = (/(전에|아까|지난번|저번|기억)/.test(t) && /(뭐|언제|얼마|어디|누구|몇|찾아|알려|였지|였더라|더라|\?)/.test(t)) || /(뭐였지|였더라|이었지)\??$/.test(t);
  const time = parseTime(t);
  if (time && /(알려|알림|말해|깨워)/.test(t) && !isRecall) {
    return { action: 'template', template: 'reminder', params: { time, days: parseDays(t), message: reminderMessage(t) } };
  }
  // 시각 없이 "매일 약 먹으라고 알려줘" — 그 사람이 일어나는 시각으로 제안한다 (확인 단계에서 본다)
  if (!time && /(매일|평일|주말|월요일|금요일|아침마다)/.test(t) && /(라고|하라고|으라고)\s*(알려|알림|말해|깨워)/.test(t) && !isRecall) {
    return { action: 'template', template: 'reminder', params: { time: ctx.wake || '08:00', days: parseDays(t), message: reminderMessage(t) }, defaultedTime: true };
  }
  if (isRecall) return { action: 'recall', query: t };
  if (/템플릿|골라\s*쓰|어떤\s*(자동화|비서)|뭐가\s*있/.test(t)) return { action: 'templates' };
  if (/(내|제)?\s*(자동화|워크플로)\s*(목록|리스트|뭐|보여)|자동화\s*뭐\s*있/.test(t)) return { action: 'list' };
  if (/(요즘|오늘|최근|이번\s*주).*(뭐\s*했|했어|했니|어땠|현황|상태)|^(상태|현황)$/.test(t)) return { action: 'status' };
  const run = /^(.+?)\s*(자동화|워크플로)?\s*(을|를)?\s*(돌려|실행해|실행시켜|실행)\s*(줘|주세요)?[.!]*$/.exec(t);
  if (run) return { action: 'run', workflow: run[1].trim() };
  return null;
}

/* ---------- 1) 규칙 — 영어 ---------- */

/** "8:30 pm" · "7am" · "at 7" · "noon" → "HH:MM". 오전·오후가 없으면 1~6시는 오후로 본다 (한국어와 같게) */
export function parseTimeEn(text) {
  const s = String(text || '');
  if (/\bnoon\b/i.test(s)) return '12:00';
  if (/\bmidnight\b/i.test(s)) return '00:00';
  let m = /\b(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    const pm = /^p/i.test(m[3]);
    if (pm && h < 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m[2] || '00'}`;
  }
  m = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(s);
  if (m) {
    let h = Number(m[1]);
    if (/\b(evening|tonight|afternoon)\b/i.test(s) && h < 12) h += 12;
    return `${String(h).padStart(2, '0')}:${m[2]}`;
  }
  m = /\bat\s+(\d{1,2})(?:\s*o'?clock)?\b(?!\s*(?:%|min|minutes|:))/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    if (h > 23) return null;
    if (/\b(evening|tonight|afternoon)\b/i.test(s) && h < 12) h += 12;
    else if (!/\bmorning\b/i.test(s) && h >= 1 && h <= 6) h += 12;
    return `${String(h).padStart(2, '0')}:00`;
  }
  return null;
}
const parseDaysEn = (t) => (/week\s*days?/i.test(t) ? '평일' : /week\s*ends?/i.test(t) ? '주말' : /mondays?/i.test(t) ? '월요일' : /fridays?/i.test(t) ? '금요일' : '매일');

/** "remind me to take my medicine every day at 8:30" → "take my medicine" */
export function reminderMessageEn(text) {
  const s = String(text || '')
    .replace(/^\s*(please\s+)?(can you\s+)?(remind|tell|alert|notify|ping|wake)\s+me(\s+up)?\s*(to|that|about|of)?\s*/i, ' ')
    .replace(/\b(every\s*day|everyday|daily|every\s+(weekday|weekend|monday|friday|morning|evening)s?|on\s+(weekdays|weekends|mondays?|fridays?)|in\s+the\s+(morning|evening|afternoon)|tonight)\b/gi, ' ')
    .replace(/\b(at\s+)?(\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|noon|midnight)(?=\W|$)/gi, ' ')
    .replace(/\bat\s+\d{1,2}(\s*o'?clock)?\b/gi, ' ')
    .replace(/\bplease\b/gi, ' ')
    .replace(/[.!?]+$/, ' ')
    .replace(/\s+/g, ' ').trim();
  return s.slice(0, 200) || 'Reminder';
}

function parseEn(t, ctx) {
  if (/^(\/?help|what can you do|how (do|does) (i|this|it) (use|work)|commands?\??$)/i.test(t)) return { action: 'help' };
  const url = /(https?:\/\/[^\s]+)/.exec(t)?.[1];
  if (url && /\b(change[sd]?|update[sd]?|watch|monitor|keep an eye)\b/i.test(t)) {
    return { action: 'template', template: 'page-watch', params: { url, every: /10\s*min/i.test(t) ? '10분마다' : /\b(daily|every\s*day|once a day)\b/i.test(t) ? '매일 아침 9시' : '1시간마다' } };
  }
  if (/\b(digest|summar\w*|recap|round[- ]?up)\b/i.test(t) && /\b(read|memory|remembered)\b/i.test(t)) {
    return { action: 'template', template: 'memory-digest', params: { time: parseTimeEn(t) || '18:00', days: /\b(daily|every\s*day)\b/i.test(t) ? '매일' : /monday/i.test(t) ? '월요일' : '금요일' } };
  }
  if (/\b(brief(ing)?|trending|trends|hot topics)\b/i.test(t) && /\b(send|give|tell|get)\b/i.test(t)) {
    return { action: 'template', template: 'morning-brief', params: { time: parseTimeEn(t) || ctx.wake || '08:00', days: /week\s*days?/i.test(t) ? '평일' : /week\s*ends?/i.test(t) ? '주말' : '매일' } };
  }
  if (/\b(photos?|pictures?|texts?)\b.*\b(send|forward)\b.*\b(read|reply|answer)\b/i.test(t)) return { action: 'template', template: 'read-and-reply', params: {} };
  const isRecall = /\b(earlier|before|previously|last time|the other day|i read|i saw|did i read|remember)\b/i.test(t) && /\b(what|when|how much|where|who|which|find)\b|\?/i.test(t);
  if (/^\s*(please\s+)?(can you\s+)?(remind|alert|notify|ping|wake)\s+me\b/i.test(t) && !isRecall) {
    const time = parseTimeEn(t);
    return { action: 'template', template: 'reminder', params: { time: time || ctx.wake || '08:00', days: parseDaysEn(t), message: reminderMessageEn(t) }, ...(time ? {} : { defaultedTime: true }) };
  }
  if (isRecall) return { action: 'recall', query: t };
  if (/\btemplates?\b|what (assistants|automations) (can|could) i|what can i (pick|choose)/i.test(t)) return { action: 'templates' };
  if (/\b(list|show)\b.*\b(automations?|workflows?)\b|^\s*my (automations?|workflows?)\s*\??$/i.test(t)) return { action: 'list' };
  if (/\bwhat (did|have) you (do|done|been doing)\b|\b(status|lately|recently|recent runs)\b/i.test(t)) return { action: 'status' };
  const run = /^\s*(please\s+)?(run|start|execute|trigger)\s+(the\s+|my\s+)?(.+?)(\s+(automation|workflow))?\s*(now|please)?[.!]*$/i.exec(t);
  if (run) return { action: 'run', workflow: run[4].trim() };
  return null;
}

/** 규칙으로 알아듣기 — 모르면 null. 한글이 있으면 한국어 규칙, 없으면 영어 규칙 */
export function parseCommand(raw, ctx = {}) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^\/?help$/i.test(t)) return { action: 'help' };
  return HANGUL.test(t) ? parseKo(t, ctx) : parseEn(t, ctx);
}

/** 기억 질문에서 말버릇("전에 읽은 … 뭐였지?")을 빼고 찾을 말만 남긴다 — 검색이 군말에 흐려지지 않게 */
export function recallQuery(text) {
  const raw = String(text || '');
  if (!HANGUL.test(raw)) {
    const q = raw
      .replace(/\b(what|when|where|who|which|how much|how many|was|were|is|are|did|do|does|the|a|an|i|me|my|you|that|this|read|saw|seen|earlier|before|previously|last time|the other day|remember|tell|find|in|from|about|again|please|can|could)\b/gi, ' ')
      .replace(/[?!.~,]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return q || raw.trim();
  }
  const q = raw
    .replace(/(전에|아까|지난번|저번|예전에|기억\s*해\s*둔|기억해둔|기억(나|해|하니|에서)?|읽었던|읽은|봤던|본|적어\s*둔|저장한)/g, ' ')
    // 질문 끝말만 지운다 — "얼마였지" "언제였더라" "뭐였어" (단어 끝 글자를 조사로 오인해 자르지 않는다)
    .replace(/(뭐|언제|얼마|어디|누구|몇\s*(?:시|일|개))?\s*(이었|였)(지|더라|어|니)?(?=\s|[?？!.~]|$)/g, ' ')
    .replace(/(알려\s*줘|찾아\s*줘|말해\s*줘)|(^|\s)(뭐|언제|얼마|어디|누구)(?=\s|[?？!.~]|$)/g, ' ')
    .replace(/[?？!.~]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return q || raw.trim();
}

/* ---------- 사람마다 따로 ---------- */

const isOwner = (ownerId) => ownerId === 'owner' || People.get(ownerId)?.role === 'owner';
/** 그 사람이 볼 수 있는 자동화 — PC 주인은 전부, 다른 사람은 자기가 만든 것만 */
export const visibleWorkflows = (ownerId = 'owner') => (isOwner(ownerId) ? Workflows.all() : Workflows.all().filter((w) => w.ownerId === ownerId));

/* ---------- 2) LLM (규칙으로 모를 때) ---------- */

const ASSISTANT_SYSTEM = (ownerId) => `너는 개인 비서다. 사용자의 말(한국어 또는 영어)을 아래 동작 중 하나로 옮긴다. 직접 답을 지어내지 마라.
동작:
- template: 자동화를 새로 만든다. template 은 ${TEMPLATES.map((x) => x.id).join(' · ')} 중 하나, params 는 그 템플릿의 칸 (선택값은 아래 한국어 값 그대로)
${TEMPLATES.filter((x) => x.fields.length).map((x) => `  · ${x.id}: ${x.fields.map((f) => `${f.key}(${f.type === 'select' ? f.options.join('/') : f.type})`).join(', ')}`).join('\n')}
- run: 이미 있는 자동화를 실행한다. workflow 는 아래 목록의 이름 그대로
- recall: 전에 읽은 것을 찾는다. query 에 찾을 말
- templates · list · status · help
- unknown: 위로 옮길 수 없다
자동화 목록: ${visibleWorkflows(ownerId).map((w) => `"${w.name}"`).join(', ') || '(없음)'}
JSON 하나만: {"action":"template","template":"reminder","params":{"time":"08:30","days":"매일","message":"약 먹기"}}`;

/* ---------- 실행 ---------- */

const findWorkflow = (name, ownerId) => {
  const q = String(name || '').replace(/\s+/g, '').toLowerCase();
  if (!q) return null;
  const all = visibleWorkflows(ownerId);
  return all.find((w) => w.id === name) || all.find((w) => w.name.replace(/\s+/g, '').toLowerCase() === q)
    || all.find((w) => w.name.replace(/\s+/g, '').toLowerCase().includes(q)) || null;
};
const triggerSeed = (wf, input, ownerId) => {
  const tr = (wf.nodes || []).find((x) => TRIGGERS.has(x.data?.kind));
  return tr ? { [tr.id]: { main: { ...input, _assistant: true, ownerId } } } : {};
};
const confirmButtons = (id, L, yesKey = 'btnCreate') => [{ label: t(L, yesKey), value: `as:${id}:yes` }, { label: t(L, 'btnCancel'), value: `as:${id}:no` }];

function describeTemplate(tpl, params, L) {
  const en = L === 'en';
  const when = tpl.fields.some((f) => f.key === 'time') ? describeCron(cronOf(params), L) : '';
  if (tpl.id === 'reminder') return en ? `${when}: "⏰ ${params.message}" reminder` : `${when}에 "⏰ ${params.message}" 알림`;
  if (tpl.id === 'morning-brief') return en ? `${when}: trending-search brief` : `${when}에 인기 검색어 브리핑`;
  if (tpl.id === 'memory-digest') return en ? `${when}: digest of what you read` : `${when}에 읽은 것 정리`;
  if (tpl.id === 'page-watch') return en ? `check ${params.url} ${params.every === '10분마다' ? 'every 10 min' : params.every === '1시간마다' ? 'hourly' : 'daily'} and ping on change` : `${params.url} 을 ${params.every} 확인해서 바뀌면 알림`;
  return typeof tpl.title === 'object' ? tpl.title[L] || tpl.title.ko : tpl.title;
}
const mark = (status) => (status === 'success' ? '✅' : status === 'error' ? '⚠️' : '⏸');

async function act(cmd, { exec, channel, ownerId, chatId, L, ctx }) {
  switch (cmd.action) {
    case 'help': return { reply: t(L, 'help') };
    case 'templates': return { reply: [t(L, 'templatesHead'), ...listTemplates(L, ownerId).map((x) => `${x.icon} ${x.title} — ${x.desc}`)].join('\n') };
    case 'list': {
      const wfs = visibleWorkflows(ownerId);
      return { reply: wfs.length ? [t(L, 'listHead'), ...wfs.map((w) => `${w.active ? '🟢' : '⚪'} ${w.name}`)].join('\n') : t(L, 'listEmpty') };
    }
    case 'status': {
      const mine = isOwner(ownerId) ? null : new Set(visibleWorkflows(ownerId).map((w) => w.id));
      const recent = Executions.all().filter((x) => !mine || mine.has(x.workflowId)).slice(0, 5);
      return { reply: recent.length ? [t(L, 'statusHead'), ...recent.map((x) => `${mark(x.status)} ${x.workflowName} · ${String(x.at).slice(5, 16).replace('T', ' ')}`)].join('\n') : t(L, 'statusEmpty') };
    }
    case 'recall': {
      // 그 사람 기억만 — 다른 사람이 읽은 것은 후보에도 오르지 않는다
      const r = await recall({ query: recallQuery(cmd.query), k: 3, ownerId });
      if (!r.results.length) return { reply: t(L, 'recallNone') };
      return {
        reply: [t(L, 'recallHead'), ...r.results.map((m) => `• ${[].concat(m.quote || [])[0] || m.text.split('\n')[0]}\n  — ${m.source?.title || m.docId}, ${String(m.source?.readAt || '').slice(0, 10)}`)].join('\n'),
      };
    }
    case 'template': {
      const tpl = TEMPLATES.find((x) => x.id === cmd.template);
      if (!tpl) return { reply: `${t(L, 'noTemplate')} ${t(L, 'help')}` };
      const v = validateParams(tpl, cmd.params || {}, { ...ctx, lang: L });
      if (!v.ok) return { reply: t(L, 'cantCreate', { errors: v.errors.join(' · ') }) };
      const p = PendingActions.add({ kind: 'assistant', op: 'template', template: tpl.id, params: v.params, channel, ownerId, chatId: chatId ? String(chatId) : null, lang: L });
      return { reply: t(L, 'askCreate', { icon: tpl.icon, what: describeTemplate(tpl, v.params, L) }), buttons: confirmButtons(p.id, L), pendingId: p.id };
    }
    case 'run': {
      const wf = findWorkflow(cmd.workflow, ownerId);
      if (!wf) return { reply: t(L, 'wfNotFound', { name: cmd.workflow }) };
      if (hasSideEffects(wf)) {
        const p = PendingActions.add({ kind: 'assistant', op: 'run', workflowId: wf.id, channel, ownerId, chatId: chatId ? String(chatId) : null, lang: L, reason: '밖으로 내보내는 동작이 있는 자동화' });
        return { reply: t(L, 'askRunSide', { name: wf.name }), buttons: confirmButtons(p.id, L, 'btnRun'), pendingId: p.id };
      }
      const res = await exec(wf, { seed: triggerSeed(wf, {}, ownerId), trigger: 'assistant' });
      return { reply: t(L, 'ran', { mark: mark(res.execution.status), name: wf.name, status: res.execution.status }), executionId: res.execution.id };
    }
    default: return { reply: t(L, 'unknown', { help: t(L, 'help') }) };
  }
}

/**
 * @param {{ text:string, channel?:'telegram'|'web', ownerId?:string, chatId?:string, lang?:'ko'|'en', _deps? }} p
 *   ownerId — 누가 말했나 (텔레그램은 채팅으로 코드가 찾는다, 화면은 PC 주인). lang — 없으면 그 사람 설정
 * @returns {Promise<{ reply:string, buttons?:{label,value}[], pendingId?:string, understood:'rule'|'llm'|'none', action:string, lang:string }>}
 */
export async function handleAssistant({ text, channel = 'web', ownerId = 'owner', chatId = null, lang, _deps = {} } = {}) {
  const exec = _deps.execute || runtimeExecute;
  const llm = _deps.llm || callLLM;
  const ctx = personContext(ownerId);
  const L = normLang(lang || ctx.lang);
  let cmd = parseCommand(text, ctx);
  let understood = cmd ? 'rule' : 'none';
  if (!cmd) {
    const r = await llm({ system: ASSISTANT_SYSTEM(ownerId), prompt: String(text).slice(0, 1000), maxTokens: 512 });
    if (!r.simulated && !r.error) {
      const j = parseJson(r.text);
      const allowed = ['template', 'run', 'recall', 'templates', 'list', 'status', 'help'];
      if (j && allowed.includes(j.action)) {
        // LLM 이 준 값도 규칙과 똑같이 검증된다 (template 은 validateParams, run 은 그 사람이 볼 수 있는 것 중 findWorkflow)
        cmd = { action: j.action, template: j.template, params: j.params, workflow: j.workflow, query: j.query || text };
        understood = 'llm';
      }
    }
  }
  const out = await act(cmd || { action: 'unknown' }, { exec, channel, ownerId, chatId, L, ctx });
  return { ...out, understood, action: cmd?.action || 'unknown', lang: L };
}

/** 확인 버튼 — 만들기 · 실행 · 취소. 요청한 사람만 누를 수 있다 */
export async function confirmAssistant(id, yes, { ownerId = 'owner', _deps = {} } = {}) {
  const exec = _deps.execute || runtimeExecute;
  const p = PendingActions.get(id);
  const L = normLang(p?.lang || personContext(ownerId).lang);
  if (!p || p.kind !== 'assistant') return { ok: false, reply: t(L, 'noRequest') };
  // 거부 안내는 누른 사람 언어로
  if ((p.ownerId || 'owner') !== ownerId) return { ok: false, denied: true, reply: t(personContext(ownerId).lang, 'notYours') };
  if (p.status !== 'pending') return { ok: true, already: true, reply: t(L, 'already') };
  if (!yes) { PendingActions.update(id, { status: 'rejected', decidedAt: new Date().toISOString() }); return { ok: true, reply: t(L, 'cancelled') }; }
  PendingActions.update(id, { status: 'approved', decidedAt: new Date().toISOString() });
  if (p.op === 'template') {
    const r = createFromTemplate(p.template, p.params, { ownerId: p.ownerId || 'owner', ...(_deps.registrar ? { registrar: _deps.registrar } : {}) });
    if (!r.ok) return { ok: false, reply: t(L, 'cantMake', { errors: r.errors.join(' · ') }) };
    PendingActions.update(id, { workflowId: r.workflowId });
    return { ok: true, workflowId: r.workflowId, reply: t(L, 'made', { name: r.name, when: r.when ? t(L, 'madeWhen', { when: r.when }) : '' }) };
  }
  if (p.op === 'run') {
    const wf = Workflows.get(p.workflowId);
    if (!wf) return { ok: false, reply: t(L, 'wfGone') };
    const res = await exec(wf, { seed: triggerSeed(wf, {}, p.ownerId || 'owner'), trigger: 'assistant' });
    return { ok: true, executionId: res.execution.id, reply: t(L, 'ran', { mark: mark(res.execution.status), name: wf.name, status: res.execution.status }) };
  }
  return { ok: false, reply: t(L, 'noRequest') };
}
