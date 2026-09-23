// ============================================================
// 말로 시키기 — 개인 비서 (specs/006-personal-assistant)
//
//   1) 규칙으로 먼저 알아듣는다 (키 없이 · 결정론 · 테스트 가능)
//   2) 규칙으로 모르면 LLM 이 "정해진 동작" 중 하나로 옮긴다 — 코드가 검증한다
//   3) 자동화를 새로 만들거나 밖으로 내보내는 워크플로를 실행하는 것은 [만들기]/[실행] 확인을 거친다
//   4) 기억 질문은 LLM 이 답을 쓰지 않는다 — 기억 조각 원문을 출처와 함께 그대로 보여 준다
// ============================================================
import { Workflows, PendingActions, Executions } from './store.js';
import { callLLM } from './llm.js';
import { parseJson } from './vision.js';
import { TEMPLATES, validateParams, createFromTemplate, cronOf, cronToKorean, listTemplates } from './templates.js';
import { hasSideEffects } from './heartbeat.js';
import { recall } from './memory/memory.js';
import { execute as runtimeExecute } from './runtime.js';

const TRIGGERS = new Set(['webhookTrigger', 'manualTrigger', 'scheduleTrigger']);
export const HELP = [
  '이렇게 말해 보세요:',
  '• "매일 8시 30분에 약 먹으라고 알려줘"',
  '• "평일 아침 8시에 브리핑 보내줘"',
  '• "https://… 바뀌면 알려줘"',
  '• "전에 읽은 결제일 뭐였지?"',
  '• "템플릿 보여줘" · "내 자동화 목록" · "요즘 뭐 했어?"',
  '• "주문 처리 자동화 돌려줘"',
  '• 사진이나 긴 글을 보내면 읽고 답해요',
].join('\n');

/* ---------- 1) 규칙 ---------- */

/** "오후 3시 반" → "15:30". 오전·오후가 없으면 1~6시는 오후, 7~11시는 오전으로 본다 (확인 단계에서 사람이 본다) */
export function parseTime(text) {
  const m = /(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반)|\s*(\d{1,2})\s*분)?/.exec(text);
  if (!m) {
    const hm = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(text);
    return hm ? `${hm[1].padStart(2, '0')}:${hm[2]}` : null;
  }
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

/** 규칙으로 알아듣기 — 모르면 null */
export function parseCommand(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
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
    return { action: 'template', template: 'morning-brief', params: { time: parseTime(t) || '08:00', days: /평일/.test(t) ? '평일' : /주말/.test(t) ? '주말' : '매일' } };
  }
  if (/(사진|글).*(보내면|오면).*(읽|답)/.test(t)) return { action: 'template', template: 'read-and-reply', params: {} };
  const time = parseTime(t);
  if (time && /(알려|알림|말해|깨워)/.test(t)) {
    return { action: 'template', template: 'reminder', params: { time, days: parseDays(t), message: reminderMessage(t) } };
  }
  if (/(전에|아까|지난번|저번|기억)/.test(t) && /(뭐|언제|얼마|어디|누구|몇|찾아|알려|였지|였더라|더라|\?)/.test(t)) return { action: 'recall', query: t };
  if (/(뭐였지|였더라|이었지)\??$/.test(t)) return { action: 'recall', query: t };
  if (/템플릿|골라\s*쓰|어떤\s*(자동화|비서)|뭐가\s*있/.test(t)) return { action: 'templates' };
  if (/(내|제)?\s*(자동화|워크플로)\s*(목록|리스트|뭐|보여)|자동화\s*뭐\s*있/.test(t)) return { action: 'list' };
  if (/(요즘|오늘|최근|이번\s*주).*(뭐\s*했|했어|했니|어땠|현황|상태)|^(상태|현황)$/.test(t)) return { action: 'status' };
  const run = /^(.+?)\s*(자동화|워크플로)?\s*(을|를)?\s*(돌려|실행해|실행시켜|실행)\s*(줘|주세요)?[.!]*$/.exec(t);
  if (run) return { action: 'run', workflow: run[1].trim() };
  return null;
}

/** 기억 질문에서 말버릇("전에 읽은 … 뭐였지?")을 빼고 찾을 말만 남긴다 — 검색이 군말에 흐려지지 않게 */
export function recallQuery(text) {
  const q = String(text || '')
    .replace(/(전에|아까|지난번|저번|예전에|기억\s*해\s*둔|기억해둔|기억(나|해|하니|에서)?|읽었던|읽은|봤던|본|적어\s*둔|저장한)/g, ' ')
    // 질문 끝말만 지운다 — "얼마였지" "언제였더라" "뭐였어" (단어 끝 글자를 조사로 오인해 자르지 않는다)
    .replace(/(뭐|언제|얼마|어디|누구|몇\s*(?:시|일|개))?\s*(이었|였)(지|더라|어|니)?(?=\s|[?？!.~]|$)/g, ' ')
    .replace(/(알려\s*줘|찾아\s*줘|말해\s*줘)|(^|\s)(뭐|언제|얼마|어디|누구)(?=\s|[?？!.~]|$)/g, ' ')
    .replace(/[?？!.~]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  return q || String(text || '').trim();
}

/* ---------- 2) LLM (규칙으로 모를 때) ---------- */

const ASSISTANT_SYSTEM = () => `너는 개인 비서다. 사용자의 말을 아래 동작 중 하나로 옮긴다. 직접 답을 지어내지 마라.
동작:
- template: 자동화를 새로 만든다. template 은 ${TEMPLATES.map((x) => x.id).join(' · ')} 중 하나, params 는 그 템플릿의 칸
${TEMPLATES.filter((x) => x.fields.length).map((x) => `  · ${x.id}: ${x.fields.map((f) => `${f.key}(${f.type === 'select' ? f.options.join('/') : f.type})`).join(', ')}`).join('\n')}
- run: 이미 있는 자동화를 실행한다. workflow 는 아래 목록의 이름 그대로
- recall: 전에 읽은 것을 찾는다. query 에 찾을 말
- templates · list · status · help
- unknown: 위로 옮길 수 없다
자동화 목록: ${Workflows.all().map((w) => `"${w.name}"`).join(', ') || '(없음)'}
JSON 하나만: {"action":"template","template":"reminder","params":{"time":"08:30","days":"매일","message":"약 먹기"}}`;

/* ---------- 실행 ---------- */

const findWorkflow = (name) => {
  const q = String(name || '').replace(/\s+/g, '').toLowerCase();
  if (!q) return null;
  const all = Workflows.all();
  return all.find((w) => w.id === name) || all.find((w) => w.name.replace(/\s+/g, '').toLowerCase() === q)
    || all.find((w) => w.name.replace(/\s+/g, '').toLowerCase().includes(q)) || null;
};
const triggerSeed = (wf, input) => {
  const t = (wf.nodes || []).find((x) => TRIGGERS.has(x.data?.kind));
  return t ? { [t.id]: { main: { ...input, _assistant: true } } } : {};
};
const confirmButtons = (id, yes = '만들기') => [{ label: `✅ ${yes}`, value: `as:${id}:yes` }, { label: '취소', value: `as:${id}:no` }];

function describeTemplate(tpl, params) {
  if (tpl.id === 'reminder') return `${cronToKorean(cronOf(params))}에 "⏰ ${params.message}" 알림`;
  if (tpl.id === 'morning-brief') return `${cronToKorean(cronOf(params))}에 인기 검색어 브리핑`;
  if (tpl.id === 'memory-digest') return `${cronToKorean(cronOf(params))}에 읽은 것 정리`;
  if (tpl.id === 'page-watch') return `${params.url} 을 ${params.every} 확인해서 바뀌면 알림`;
  return tpl.title;
}

async function act(cmd, { exec, channel }) {
  switch (cmd.action) {
    case 'help': return { reply: HELP };
    case 'templates': return { reply: ['골라서 쓸 수 있는 비서:', ...listTemplates().map((x) => `${x.icon} ${x.title} — ${x.desc}`)].join('\n') };
    case 'list': {
      const wfs = Workflows.all();
      return { reply: wfs.length ? ['내 자동화:', ...wfs.map((w) => `${w.active ? '🟢' : '⚪'} ${w.name}`)].join('\n') : '아직 자동화가 없어요. "템플릿 보여줘" 라고 해 보세요.' };
    }
    case 'status': {
      const recent = Executions.all().slice(0, 5);
      return { reply: recent.length ? ['최근 실행:', ...recent.map((x) => `${x.status === 'success' ? '✅' : x.status === 'error' ? '⚠️' : '⏸'} ${x.workflowName} · ${String(x.at).slice(5, 16).replace('T', ' ')}`)].join('\n') : '아직 실행한 게 없어요.' };
    }
    case 'recall': {
      const r = await recall({ query: recallQuery(cmd.query), k: 3 });
      if (!r.results.length) return { reply: '기억에서 찾지 못했어요. (읽은 적이 없거나, 관련이 확실하지 않아서 억지로 붙이지 않았어요)' };
      return {
        reply: ['기억에서 찾았어요 (원문 그대로):', ...r.results.map((m) => `• ${[].concat(m.quote || [])[0] || m.text.split('\n')[0]}\n  — ${m.source?.title || m.docId}, ${String(m.source?.readAt || '').slice(0, 10)}`)].join('\n'),
      };
    }
    case 'template': {
      const tpl = TEMPLATES.find((x) => x.id === cmd.template);
      if (!tpl) return { reply: `그런 비서 템플릿은 없어요. ${HELP}` };
      const v = validateParams(tpl, cmd.params || {});
      if (!v.ok) return { reply: `이렇게는 만들 수 없어요: ${v.errors.join(' · ')}` };
      const p = PendingActions.add({ kind: 'assistant', op: 'template', template: tpl.id, params: v.params, channel });
      return { reply: `${tpl.icon} ${describeTemplate(tpl, v.params)} — 만들까요?`, buttons: confirmButtons(p.id), pendingId: p.id };
    }
    case 'run': {
      const wf = findWorkflow(cmd.workflow);
      if (!wf) return { reply: `"${cmd.workflow}" 자동화를 찾지 못했어요. "내 자동화 목록" 이라고 하면 이름을 볼 수 있어요.` };
      if (hasSideEffects(wf)) {
        const p = PendingActions.add({ kind: 'assistant', op: 'run', workflowId: wf.id, channel, reason: '밖으로 내보내는 동작이 있는 자동화' });
        return { reply: `"${wf.name}" 은 밖으로 내보내는 동작(메시지·업로드 등)이 있어요. 실행할까요?`, buttons: confirmButtons(p.id, '실행'), pendingId: p.id };
      }
      const res = await exec(wf, { seed: triggerSeed(wf, {}), trigger: 'assistant' });
      return { reply: `${res.execution.status === 'success' ? '✅' : res.execution.status === 'error' ? '⚠️' : '⏸'} "${wf.name}" 실행 — ${res.execution.status}`, executionId: res.execution.id };
    }
    default: return { reply: `잘 모르겠어요. ${HELP}` };
  }
}

/**
 * @param {{ text:string, channel?:'telegram'|'web', _deps? }} p
 * @returns {Promise<{ reply:string, buttons?:{label,value}[], pendingId?:string, understood:'rule'|'llm'|'none', action:string }>}
 */
export async function handleAssistant({ text, channel = 'web', _deps = {} } = {}) {
  const exec = _deps.execute || runtimeExecute;
  const llm = _deps.llm || callLLM;
  let cmd = parseCommand(text);
  let understood = cmd ? 'rule' : 'none';
  if (!cmd) {
    const r = await llm({ system: ASSISTANT_SYSTEM(), prompt: String(text).slice(0, 1000), maxTokens: 512 });
    if (!r.simulated && !r.error) {
      const j = parseJson(r.text);
      const allowed = ['template', 'run', 'recall', 'templates', 'list', 'status', 'help'];
      if (j && allowed.includes(j.action)) {
        // LLM 이 준 값도 규칙과 똑같이 검증된다 (template 은 validateParams, run 은 findWorkflow)
        cmd = { action: j.action, template: j.template, params: j.params, workflow: j.workflow, query: j.query || text };
        understood = 'llm';
      }
    }
  }
  const out = await act(cmd || { action: 'unknown' }, { exec, channel });
  return { ...out, understood, action: cmd?.action || 'unknown' };
}

/** 확인 버튼 — 만들기 · 실행 · 취소 */
export async function confirmAssistant(id, yes, { _deps = {} } = {}) {
  const exec = _deps.execute || runtimeExecute;
  const p = PendingActions.get(id);
  if (!p || p.kind !== 'assistant') return { ok: false, reply: '없는 요청이에요.' };
  if (p.status !== 'pending') return { ok: true, already: true, reply: '이미 처리했어요.' };
  if (!yes) { PendingActions.update(id, { status: 'rejected', decidedAt: new Date().toISOString() }); return { ok: true, reply: '취소했어요.' }; }
  PendingActions.update(id, { status: 'approved', decidedAt: new Date().toISOString() });
  if (p.op === 'template') {
    const r = createFromTemplate(p.template, p.params, _deps.registrar ? { registrar: _deps.registrar } : undefined);
    if (!r.ok) return { ok: false, reply: `만들지 못했어요: ${r.errors.join(' · ')}` };
    PendingActions.update(id, { workflowId: r.workflowId });
    return { ok: true, workflowId: r.workflowId, reply: `✅ 만들었어요: ${r.name}${r.when ? `\n${r.when}에 알려 드릴게요.` : ''}` };
  }
  if (p.op === 'run') {
    const wf = Workflows.get(p.workflowId);
    if (!wf) return { ok: false, reply: '자동화가 없어졌어요.' };
    const res = await exec(wf, { seed: triggerSeed(wf, {}), trigger: 'assistant' });
    return { ok: true, executionId: res.execution.id, reply: `"${wf.name}" 실행 — ${res.execution.status}` };
  }
  return { ok: false, reply: '알 수 없는 요청이에요.' };
}
