// ============================================================
// 화면 언어 — 한국어 / English
//
//   저장 키는 쉬운 시작 화면이 쓰던 'conduit.lang' 을 그대로 쓴다. 어느 화면에서 바꿔도 전체가 같이 바뀐다.
//   엔진(src/engine)은 서버와 브라우저가 같이 쓰므로 건드리지 않는다. 노드 이름과 실행 로그는
//   화면에 그릴 때 이 모듈이 영어로 바꾼다 (translateLog). 모르는 문장은 그대로 둔다.
// ============================================================
import { useSyncExternalStore } from 'react';
import { NODE_TYPES } from './engine/nodeTypes.ts';
import { FIELD_EN } from './i18n.fields.js';

export { FIELD_EN };

const KEY = 'conduit.lang';
const norm = (l) => (l === 'en' ? 'en' : 'ko');
const read = () => { try { return norm(localStorage.getItem(KEY)); } catch { return 'ko'; } };

let current = read();
const listeners = new Set();
const emit = () => listeners.forEach((f) => f());
const TITLES = { ko: 'Conduit — 자동화 워크플로 빌더', en: 'Conduit — workflow automation builder' };
const applyDocLang = () => {
  try { document.documentElement.lang = current; document.title = TITLES[current]; } catch { /* 테스트(브라우저 밖) */ }
};
applyDocLang();

export const getLang = () => current;
export function setLang(l) {
  const next = norm(l);
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, next); } catch { /* 저장 못 해도 이번 화면은 바뀐다 */ }
  applyDocLang();
  emit();
}
function subscribe(f) {
  listeners.add(f);
  // 다른 탭에서 바꾼 것도 따라간다
  const onStorage = (e) => { if (e.key === KEY) { current = read(); applyDocLang(); emit(); } };
  try { window.addEventListener('storage', onStorage); } catch { /* 테스트 */ }
  return () => { listeners.delete(f); try { window.removeEventListener('storage', onStorage); } catch { /* 테스트 */ } };
}
/** 지금 언어 — 바뀌면 다시 그린다 */
export const useLang = () => useSyncExternalStore(subscribe, getLang, getLang);

/* ---------- 화면 문구 ---------- */
const S = {
  ko: {
    // 사이드바
    'nav.easy': '쉬운 시작', 'nav.workflows': '워크플로', 'nav.executions': '실행 기록', 'nav.dlq': '실패 큐 (DLQ)',
    'nav.credentials': '자격 증명', 'nav.settings': '설정', 'sb.new': '새 워크플로', 'sb.saved': '저장된 워크플로',
    'sb.empty': '아직 없어요. 상단 저장을 눌러보세요.', 'sb.active': '활성', 'sb.delete': '삭제', 'sb.plan': 'Free 플랜',
    'lang.toggle': 'English',
    // 상단 바
    'tb.name': '워크플로 이름', 'tb.saved': '저장됨', 'tb.unsaved': '미저장',
    'tb.serverUp': '서버 연결됨', 'tb.serverDown': '서버 꺼짐', 'tb.serverUpTitle': '백엔드 연결됨', 'tb.serverDownTitle': '백엔드 꺼짐',
    'tb.save': '저장', 'tb.saveTitle': '서버에 저장', 'tb.backendOff': '백엔드가 꺼져 있어요',
    'tb.load': '불러오기', 'tb.export': '내보내기', 'tb.runServer': '서버 실행', 'tb.runServerTitle': '백엔드에서 실행 (AI 노드 실제 호출)',
    'tb.activeTitle': '활성화 시 웹훅/스케줄이 즉시 등록됩니다', 'tb.active': '활성', 'tb.inactive': '비활성',
    'canvas.addNode': '노드 추가', 'canvas.run': '워크플로 실행', 'canvas.running': '실행 중…',
    'wf.current': '현재 워크플로', 'wf.new': '새 워크플로', 'wf.unnamed': '이름 없는 워크플로',
    // 로그·확인창
    'log.title': '실행 로그',
    'log.serverRunning': '서버에서 실행 중… (실시간 스트리밍)',
    'log.checkKey': '— 사이드바 "설정"에서 API 키를 확인하세요.',
    'log.serverFail': '서버 실행 실패: ', 'log.saveFail': '저장 실패: ', 'log.cannotActivate': '백엔드가 꺼져 있어 활성화할 수 없어요.',
    'log.activated': '워크플로 활성화됨.', 'log.webhook': '웹훅 수신 등록: POST /webhook', 'log.schedule': '스케줄 등록: ',
    'log.noTriggers': '웹훅/스케줄 트리거 노드가 없어 자동 실행 등록은 없어요.',
    'log.deactivated': '워크플로 비활성화됨 — 크론/웹훅 등록 해제.', 'log.toggleFail': '상태 변경 실패: ',
    'log.loadFail': '불러오기 실패: ', 'log.deleteFail': '삭제 실패: ',
    'confirm.new': '새 워크플로를 시작할까요? (저장하지 않은 변경은 사라져요)', 'confirm.delete': '"{name}" 워크플로를 삭제할까요?',
    'alert.badFile': '올바른 워크플로 파일이 아니에요.',
    'prompt.apiKey': '서버 API 키 — 서버의 CONDUIT_API_KEY 와 같은 값을 넣으세요.\n비워 두고 확인하면 저장된 키를 지웁니다.',
    // 노드
    'node.run': '실행', 'node.duplicate': '복제', 'node.delete': '삭제',
    'node.failedContinue': '실패했지만 계속 진행', 'node.retrying': '재시도 중', 'node.waiting': '사람 승인 대기 중',
    'node.items': '{n}건',
    // 노드 추가 패널
    'np.title': '노드 추가', 'np.search': '노드 검색…', 'np.server': '서버', 'np.mcpLoading': 'MCP 도구 불러오는 중…',
    'np.mcpTool': 'MCP 도구', 'np.empty': '검색 결과가 없어요.',
    // 설정 패널
    'insp.params': '설정', 'insp.input': '입력', 'insp.output': '출력',
    'insp.backend': '이 노드의 실제 연동은 백엔드 서버가 필요해요. 지금은 시뮬레이션 결과를 냅니다.',
    'insp.noFields': '설정할 항목이 없는 노드예요.', 'insp.hintPre': '💡 값에 ', 'insp.hintPost': ' 를 쓰면 이전 노드 데이터를 참조해요.',
    'insp.hintField': '필드',
    'insp.batch': '배치 처리', 'insp.batchSize': '배치 크기 (0=순차 · N=한 번에 N개 병렬)', 'insp.sequential': '순차 (기본)',
    'insp.parallel': '{n}개씩 병렬', 'insp.batchDelay': '배치 간 지연 (ms · rate limit 대응)', 'insp.none': '없음',
    'insp.reliability': '안정성', 'insp.retries': '재시도 횟수 (비우면 노드 기본값: {n}회)', 'insp.retriesDefault': '기본값 ({n}회)',
    'insp.times': '{n}회', 'insp.continueOnFail': '실패해도 계속 진행 (Continue On Fail)',
    'insp.retryNote': '일시 오류(429·5xx·네트워크)만 재시도하고, 영구 오류(400·401·404)는 즉시 실패합니다. 실패 항목은 DLQ에 격리돼요.',
    'insp.noInput': '아직 입력 데이터가 없어요. 워크플로를 실행해 보세요.', 'insp.noOutput': '아직 출력 데이터가 없어요. 워크플로를 실행해 보세요.',
    'insp.deleteNode': '노드 삭제', 'insp.item': '아이템 {n}', 'insp.more': '… 외 {n}건',
    'insp.noTools': '이번 실행에서 도구 호출이 없었어요. (모델이 바로 답했거나 시뮬레이션 모드)',
    'insp.toolIn': '입력', 'insp.toolOut': '결과', 'insp.final': '최종 답변', 'insp.raw': '원본 데이터 (JSON)',
  },
  en: {
    'nav.easy': 'Easy start', 'nav.workflows': 'Workflows', 'nav.executions': 'Executions', 'nav.dlq': 'Dead letters (DLQ)',
    'nav.credentials': 'Credentials', 'nav.settings': 'Settings', 'sb.new': 'New workflow', 'sb.saved': 'Saved workflows',
    'sb.empty': 'Nothing yet. Press Save at the top.', 'sb.active': 'Active', 'sb.delete': 'Delete', 'sb.plan': 'Free plan',
    'lang.toggle': '한국어',
    'tb.name': 'Workflow name', 'tb.saved': 'Saved', 'tb.unsaved': 'Unsaved',
    'tb.serverUp': 'Server connected', 'tb.serverDown': 'Server off', 'tb.serverUpTitle': 'Backend connected', 'tb.serverDownTitle': 'Backend is off',
    'tb.save': 'Save', 'tb.saveTitle': 'Save to the server', 'tb.backendOff': 'The backend is off',
    'tb.load': 'Import', 'tb.export': 'Export', 'tb.runServer': 'Run on server', 'tb.runServerTitle': 'Run on the backend (AI nodes call the real model)',
    'tb.activeTitle': 'When active, webhooks and schedules are registered right away', 'tb.active': 'Active', 'tb.inactive': 'Inactive',
    'canvas.addNode': 'Add node', 'canvas.run': 'Run workflow', 'canvas.running': 'Running…',
    'wf.current': 'Current workflow', 'wf.new': 'New workflow', 'wf.unnamed': 'Untitled workflow',
    'log.title': 'Run log',
    'log.serverRunning': 'Running on the server… (live stream)',
    'log.checkKey': '— check the API key under Settings in the sidebar.',
    'log.serverFail': 'Server run failed: ', 'log.saveFail': 'Save failed: ', 'log.cannotActivate': 'The backend is off, so the workflow cannot be activated.',
    'log.activated': 'Workflow activated.', 'log.webhook': 'Webhook registered: POST /webhook', 'log.schedule': 'Schedule registered: ',
    'log.noTriggers': 'No webhook or schedule trigger, so nothing runs automatically.',
    'log.deactivated': 'Workflow deactivated — cron and webhooks unregistered.', 'log.toggleFail': 'Could not change state: ',
    'log.loadFail': 'Import failed: ', 'log.deleteFail': 'Delete failed: ',
    'confirm.new': 'Start a new workflow? Unsaved changes will be lost.', 'confirm.delete': 'Delete the workflow "{name}"?',
    'alert.badFile': 'This is not a valid workflow file.',
    'prompt.apiKey': 'Server API key — enter the same value as CONDUIT_API_KEY on the server.\nLeave it empty and confirm to clear the saved key.',
    'node.run': 'Run', 'node.duplicate': 'Duplicate', 'node.delete': 'Delete',
    'node.failedContinue': 'Failed but continued', 'node.retrying': 'Retrying', 'node.waiting': 'Waiting for human approval',
    'node.items': '{n} item{s}',
    'np.title': 'Add node', 'np.search': 'Search nodes…', 'np.server': 'Server', 'np.mcpLoading': 'Loading MCP tools…',
    'np.mcpTool': 'MCP tool', 'np.empty': 'No matching nodes.',
    'insp.params': 'Parameters', 'insp.input': 'Input', 'insp.output': 'Output',
    'insp.backend': 'This node needs the backend server for the real integration. For now it returns simulated results.',
    'insp.noFields': 'This node has nothing to configure.', 'insp.hintPre': '💡 Use ', 'insp.hintPost': ' in a value to reference data from the previous node.',
    'insp.hintField': 'field',
    'insp.batch': 'Batching', 'insp.batchSize': 'Batch size (0 = one by one · N = N in parallel)', 'insp.sequential': 'One by one (default)',
    'insp.parallel': '{n} in parallel', 'insp.batchDelay': 'Delay between batches (ms · for rate limits)', 'insp.none': 'None',
    'insp.reliability': 'Reliability', 'insp.retries': 'Retries (empty = node default: {n})', 'insp.retriesDefault': 'Default ({n})',
    'insp.times': '{n}', 'insp.continueOnFail': 'Continue on fail',
    'insp.retryNote': 'Only transient errors (429, 5xx, network) are retried. Permanent errors (400, 401, 404) fail at once. Failed items go to the DLQ.',
    'insp.noInput': 'No input data yet. Run the workflow.', 'insp.noOutput': 'No output data yet. Run the workflow.',
    'insp.deleteNode': 'Delete node', 'insp.item': 'Item {n}', 'insp.more': '… {n} more',
    'insp.noTools': 'No tool calls in this run (the model answered directly, or simulation mode).',
    'insp.toolIn': 'Input', 'insp.toolOut': 'Result', 'insp.final': 'Final answer', 'insp.raw': 'Raw data (JSON)',
  },
};

/** 기본 워크플로 이름은 한국어로 저장되고 화면에서만 바꿔 보인다 */
const DEFAULT_NAMES = { '현재 워크플로': 'wf.current', '새 워크플로': 'wf.new', '이름 없는 워크플로': 'wf.unnamed' };
export const displayWfName = (name, lang) => (DEFAULT_NAMES[name] ? tr(lang, DEFAULT_NAMES[name]) : name);

/** 화면 문구 — {name} 자리를 채운다. 영어 사전에 없으면 한국어로 */
export function tr(lang, key, vars = {}) {
  const s = S[lang]?.[key] ?? S.ko[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}
export const hasKey = (key) => key in S.ko && key in S.en;
export const STRING_KEYS = () => ({ ko: Object.keys(S.ko), en: Object.keys(S.en) });

/* ---------- 노드 이름 · 설명 · 분류 ---------- */
// [영어 이름, 노드 추가 패널에 보이는 한 줄 설명]
export const NODE_EN = {
  manualTrigger: ['Manual trigger', 'Emits data when you run it by hand'],
  scheduleTrigger: ['Schedule trigger', 'Runs on a fixed interval or a cron expression'],
  webhookTrigger: ['Webhook trigger', 'Starts when an HTTP request arrives'],
  errorTrigger: ['Error trigger', 'Runs when another workflow fails'],
  httpRequest: ['HTTP request', 'Calls any URL'],
  setFields: ['Set fields', 'Adds or overwrites fields'],
  code: ['Code (JS)', 'Runs your JavaScript on each item'],
  dateTime: ['Date & time', 'Formats and shifts dates'],
  listText: ['List to text', 'Joins a list into readable text'],
  memoryDigest: ['Memory digest (verified facts)', 'Collects facts that passed quote verification'],
  changeDetect: ['Change detection', 'Continues only when something changed since last time'],
  hash: ['Hash', 'Hashes a value'],
  renameKey: ['Rename keys', 'Renames fields'],
  delay: ['Wait', 'Pauses before the next node'],
  ifNode: ['IF', 'Splits items into true and false'],
  switchNode: ['Switch', 'Routes items to one of several outputs'],
  filter: ['Filter', 'Keeps only items that match'],
  merge: ['Merge', 'Combines two inputs'],
  splitOut: ['Split out', 'Turns an array into separate items'],
  aggregate: ['Aggregate', 'Combines items into one'],
  limit: ['Limit', 'Keeps the first N items'],
  sortItems: ['Sort', 'Sorts items by a field'],
  removeDuplicates: ['Remove duplicates', 'Drops repeated items'],
  ocr: ['OCR (image → text)', 'Reads text from an image'],
  plateRecognize: ['License plate recognition', 'YOLO11 + PaddleOCR'],
  screenUnderstand: ['Screen understanding', 'Explains what a screenshot shows'],
  socraticRead: ['Socratic reading (verified)', 'Asks itself questions and checks every quote'],
  stopError: ['Stop & error', 'Stops the run with an error'],
  memoryRecall: ['Memory recall (verified)', 'Finds what you read before, with the source'],
  approvalRequest: ['Human approval', 'Pauses until a person approves, edits or rejects'],
  slack: ['Slack message', 'Posts to a Slack channel'],
  telegram: ['Telegram message', 'Sends a Telegram message'],
  gmail: ['Send Gmail', 'Sends an email'],
  notion: ['Create Notion page', 'Adds a page to a Notion database'],
  youtube: ['YouTube search', 'Searches YouTube videos'],
  naver: ['Naver search', 'Searches Naver'],
  hotTopics: ['Trending topics (Google Trends)', 'Fetches trending searches and headlines'],
  mcpTool: ['MCP tool call', 'Calls a tool on an MCP server'],
  httpAuth: ['HTTP request (auth)', 'Calls an API with stored credentials'],
  ai: ['AI · Claude', 'Asks a model with your prompt'],
  aiExtract: ['AI extraction', 'Pulls structured fields out of text'],
  aiAgent: ['AI agent (tools)', 'Lets a model call tools step by step'],
  loopRefine: ['Loop refinement', 'Drafts, critiques and improves in rounds'],
  output: ['Output', 'Shows the final result'],
  noOp: ['No-op', 'Passes items through unchanged'],
};
export const CATEGORY_EN = {
  트리거: 'Triggers', AI: 'AI', 동작: 'Actions', 배열: 'Arrays', '흐름 제어': 'Flow control', 연동: 'Integrations', 출력: 'Output',
};

export function nodeTitle(kind, lang) {
  const def = NODE_TYPES[kind];
  if (lang === 'en' && NODE_EN[kind]) return NODE_EN[kind][0];
  return def?.title ?? kind;
}
export function nodeDesc(kind, lang) {
  const def = NODE_TYPES[kind];
  if (lang === 'en' && NODE_EN[kind]) return NODE_EN[kind][1];
  try { return def?.summary?.(def.defaults) ?? ''; } catch { return ''; }
}
export const categoryLabel = (cat, lang) => (lang === 'en' ? CATEGORY_EN[cat] ?? cat : cat);
/** 설정 패널 입력칸 이름 */
export const fieldLabel = (kind, field, lang) => (lang === 'en' ? FIELD_EN[`${kind}.${field.key}`] ?? field.label : field.label);

/* ---------- 실행 로그 — 엔진이 만든 한국어 문장을 영어로 ---------- */
// 긴 이름부터 바꾼다 ("HTTP 요청 (인증)" 이 "HTTP 요청" 보다 먼저)
const TITLE_PAIRS = Object.entries(NODE_EN)
  .map(([k, [en]]) => [NODE_TYPES[k]?.title, en])
  .filter(([ko, en]) => ko && ko !== en)
  .sort((a, b) => b[0].length - a[0].length);

const LOG_RULES = [
  [/^워크플로 실행 시작…$/, 'Workflow run started…'],
  [/^실행 완료\.$/, 'Run finished.'],
  [/^순환 연결이 있어 실행할 수 없어요\.$/, 'The flow has a cycle, so it cannot run.'],
  [/(\d+)건 입력 → (\d+)건 출력/, '$1 in → $2 out'],
  [/\(실패 (\d+)건 격리\)/, '($1 failed, isolated)'],
  [/ — (\d+)건 주입/, ' — $1 injected'],
  [/ — 건너뜀 \(승인 대기 중\)/, ' — skipped (waiting for approval)'],
  [/ — 건너뜀 \(입력 없음\)/, ' — skipped (no input)'],
  [/ — 자동 게이트에서 거절됨/, ' — rejected at the auto gate'],
  [/ — 자동 게이트에서 만료됨/, ' — expired at the auto gate'],
  [/ · 보내지 않음/, ' · not sent'],
  [/ — 자동 승인 게이트: (.+) 의 출력이 밖으로 나가기 전에 사람이 봅니다 \((.+)\)$/, ' — auto approval gate: a person reviews the output of $1 before it leaves ($2)'],
  [/\(시뮬레이션\)/, '(simulated)'],
  [/AI 출력이 밖으로 나가는 경로에는 승인이 필요합니다/, 'AI output needs approval before it leaves'],
  [/승인 채널이 없습니다/, 'no approval channel'],
  [/ — 승인 채널을 연결하거나 CONDUIT_AI_GATE=off/, ' — connect an approval channel or set CONDUIT_AI_GATE=off'],
  [/이 서버에서는 코드 실행이 꺼져 있습니다 \(CONDUIT_ALLOW_CODE\)/, 'Code execution is turned off on this server (CONDUIT_ALLOW_CODE)'],
  [/ 재시도 (\d+)\/(\d+) \((\d+)ms 후\)/, ' retry $1/$2 (in $3ms)'],
  [/ — 사람 승인 대기 \(/, ' — waiting for human approval ('],
  [/ 차단: /, ' blocked: '],
  [/ 오류: /, ' error: '],
];

/** 엔진 로그 한 줄을 영어로. 아는 문장 틀만 바꾸고, 데이터 미리보기(· 뒤 JSON)는 건드리지 않는다. */
export function translateLog(msg, lang) {
  if (lang !== 'en' || typeof msg !== 'string') return msg;
  // 데이터 미리보기는 사용자 데이터라 그대로 — 첫 " · {" 또는 " · [" 앞까지만 번역한다
  const cut = msg.search(/ · [{[]/);
  let head = cut === -1 ? msg : msg.slice(0, cut);
  const tail = cut === -1 ? '' : msg.slice(cut);
  // 문장 틀을 먼저 바꾼다 — 노드 이름 "출력"·"사람 승인 대기" 가 "5건 출력"·"— 사람 승인 대기 (" 안의 같은 낱말을 먼저 먹지 않게
  for (const [re, to] of LOG_RULES) head = head.replace(re, to);
  for (const [ko, en] of TITLE_PAIRS) head = head.split(ko).join(en);
  return head + tail;
}
