// 쉬운 시작 — 노드를 몰라도 버튼 몇 번으로 "사진을 보내면 읽고 답해 주는 비서" 를 켠다 (specs/005 · 006 · 007)
// 전문 용어는 쓰지 않는다: 하트비트 → 자동 확인, 워크플로 → (보이지 않게)
// 한국어 / English — 화면 언어는 PC 주인 설정에 저장한다 (비서 답도 같은 언어로)
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

const U = {
  ko: {
    head: '쉬운 시작 — 사진을 보내면 읽고 답해 주는 비서',
    tabs: [['start', '시작하기'], ['gallery', '골라서 쓰기'], ['chat', '말로 시키기'], ['people', '사람']],
    modeHelp: {
      both: '휴대폰으로 보낸 사진을 읽고, 결과를 휴대폰으로 답해요',
      inbound: '휴대폰으로 보낸 사진을 읽고 기억만 해요 (답장 없음)',
      outbound: '휴대폰에서 보낸 건 받지 않고, PC 결과·승인 요청만 휴대폰으로 보내요',
      off: '텔레그램으로 아무것도 주고받지 않아요',
    },
    modes: { both: '둘 다 (휴대폰 ↔ PC)', inbound: '받기만 (휴대폰 → PC)', outbound: '보내기만 (PC → 휴대폰)', off: '끄기' },
    every: [[0, '끄기'], [1, '1분마다'], [5, '5분마다'], [15, '15분마다'], [60, '1시간마다']],
    notify: [['errors', '실패만'], ['all', '모두'], ['off', '끄기']],
    examples: ['매일 8시 30분에 약 먹으라고 알려줘', '평일 아침 8시에 브리핑 보내줘', '전에 읽은 결제일 뭐였지?', '템플릿 보여줘'],
    galleryHelp: '고르고 빈칸만 채우면 바로 켜져요. 결과는 텔레그램(보내기 모드)으로 와요.',
    noFields: '채울 것이 없어요.', turnOn: '켜기', turningOn: '켜는 중…', turnedOn: '✅ 켰어요',
    chatHello: '무엇을 도와드릴까요? 아래 예시를 눌러 봐도 돼요.', chatPh: '예: "매일 8시 30분에 약 먹으라고 알려줘"', send: '보내기',
    chatNote: '텔레그램에서 봇에게 같은 말을 보내도 돼요. 새 자동화는 [만들기] 를 눌러야 켜져요.',
    now: '방금', minAgo: '분 전', hourAgo: '시간 전', done: '완료', todo: '할 일', loading: '불러오는 중…',
    s1: '준비하기', s1p: '버튼을 누르면 읽기에 필요한 것들(받은편지함 폴더 · 읽는 순서 · 목표)을 알아서 만들어요.', s1btn: '시작 준비', s1busy: '준비 중…', s1inbox: '받은편지함 폴더:', s1inbox2: '— 여기에 사진을 넣어도 읽어요.',
    s2: '두뇌 고르기 — 내 PC 모델(키 불필요) 또는 Claude', s2ok: 'Claude 키가 들어 있어요. 다른 키로 바꾸려면 아래에 새 키를 넣으세요.',
    s2now: '지금 쓰는 두뇌:', s2none: '없음 (글자는 읽지만 이해·요약은 건너뛰어요)', s2local: '내 PC 모델', s2localSub: '키 없음 · 내 컴퓨터 밖으로 아무것도 안 나가요',
    s2localOn: '✅ Ollama 켜짐 ·', s2localOff: 'Ollama 가 꺼져 있거나 설치되지 않았어요', s2noModel: '모델 없음 — ollama pull gemma3:4b',
    s2claudeSub: '더 똑똑하고 도구 호출(에이전트)까지 · 키 필요', s2ok2: '✅ 키 있음', s2needKey: '아래에서 키를 넣으면 고를 수 있어요',
    s2install: '키 없이 쓰려면', s2install2: '에서 설치한 뒤 터미널에서', s2keyTitle: 'Claude 키 넣기 (선택)',
    s2p1: '→ API Keys → Create Key 로 받은', s2p2: '키를 붙여 넣으세요. 키가 없으면 글자는 읽지만 이해·요약은 건너뛰어요.',
    connect: '연결', checking: '확인 중…', connected: '✅ 연결됐어요',
    s3: '휴대폰 연결 — 텔레그램', s3a: '휴대폰 텔레그램에서 @BotFather 를 찾아 /newbot 을 보내고 봇 이름을 정하세요.', s3b: 'BotFather 가 준 토큰(예: 123456789:AA…)을 아래에 붙여 넣으세요.',
    botToken: '봇 토큰', s3bot: '봇', s3bot2: '에 연결됐어요. 휴대폰에서 이 봇에게 /start 를 보내면 아래에 나타나요.',
    asks: '이 연결을 요청했어요', allow: '허용', allowMe: '내 휴대폰으로 허용', chat: '연결된 채팅', unlink: '연결 끊기', waiting: '기다리는 중… (/start 를 보내면 5초 안에 뜹니다)',
    s4: '주고받는 방식 고르기', s4note: '휴대폰에서 /mode 를 보내도 바꿀 수 있어요 (PC 주인만).',
    s5: '자동 확인', s5p: '받은편지함 폴더를 얼마나 자주 확인할까요? (휴대폰으로 보낸 사진은 기다리지 않고 바로 읽어요)', s5env: '.env 설정으로 도는 중:',
    checkNow: '지금 확인하기', started: '건을 읽기 시작했어요', nothingNew: '새로 온 게 없어요', idle: '대기',
    ocrPaddle: '글자 읽기: 고정밀(Paddle) 켜짐', ocrBasic: '글자 읽기: 기본(tesseract) — 고정밀 서버 꺼짐', notifyTo: '자동화 결과를 휴대폰으로:',
    recent: '최근 활동', waitApprove: '— 승인을 기다려요', approve: '승인', reject: '거절', asks2: '🤔 비서가 물어봐요:', go: '진행', skip: '하지 않기',
    noReading: '아직 읽은 게 없어요. 휴대폰으로 사진을 보내거나 받은편지함 폴더에 넣어 보세요.', verifiedAns: '확인된 답', skippedUnd: '이해 단계는 건너뛰었어요 — Claude 를 연결하면 요약해 드려요.', notInDoc: '❓ 문서에 없던 것:',
    peopleHelp: '텔레그램 채팅 하나가 한 사람이에요. 사람마다 기억·자동화·알림이 따로예요. 처음 연결되면 휴대폰에서 언어·이름·일어나는 시각·관심사를 물어봐요.',
    owner: 'PC 주인', member: '사람', name: '이름', lang: '언어', wake: '일어나는 시각', interests: '관심사 (쉼표)', save: '저장', saved: '✅ 저장했어요', setupWait: '처음 연결 질문 중',
    noChat: '(휴대폰 없음)',
  },
  en: {
    head: 'Easy start — an assistant that reads what you send and replies',
    tabs: [['start', 'Get started'], ['gallery', 'Pick & use'], ['chat', 'Just say it'], ['people', 'People']],
    modeHelp: {
      both: 'Reads photos you send from your phone and replies there',
      inbound: 'Reads and remembers what you send (no replies)',
      outbound: 'Doesn\'t take anything from the phone; only sends PC results and approvals to it',
      off: 'Nothing goes over Telegram',
    },
    modes: { both: 'Both (phone ↔ PC)', inbound: 'Receive only (phone → PC)', outbound: 'Send only (PC → phone)', off: 'Off' },
    every: [[0, 'Off'], [1, 'Every min'], [5, 'Every 5 min'], [15, 'Every 15 min'], [60, 'Hourly']],
    notify: [['errors', 'Failures only'], ['all', 'Everything'], ['off', 'Off']],
    examples: ['remind me to take my medicine every day at 8:30', 'send me a morning brief on weekdays at 8', 'what was the payment date I read earlier?', 'show templates'],
    galleryHelp: 'Pick one and fill in the blanks — it turns on right away. Results arrive on Telegram (send mode).',
    noFields: 'Nothing to fill in.', turnOn: 'Turn on', turningOn: 'Turning on…', turnedOn: '✅ Turned on',
    chatHello: 'How can I help? Tap an example below.', chatPh: 'e.g. "remind me to take my medicine every day at 8:30"', send: 'Send',
    chatNote: 'You can say the same thing to the bot on Telegram. New automations only turn on after you press [Create].',
    now: 'just now', minAgo: ' min ago', hourAgo: ' h ago', done: 'Done', todo: 'To do', loading: 'Loading…',
    s1: 'Get ready', s1p: 'One click creates what reading needs (an inbox folder, the reading flow, a goal).', s1btn: 'Get started', s1busy: 'Preparing…', s1inbox: 'Inbox folder:', s1inbox2: '— photos dropped here are read too.',
    s2: 'Pick a brain — a model on your PC (no key) or Claude', s2ok: 'A Claude key is stored. Paste a new key below to replace it.',
    s2now: 'Current brain:', s2none: 'none (letters are read, understanding and summaries are skipped)', s2local: 'Model on my PC', s2localSub: 'No key · nothing leaves your computer',
    s2localOn: '✅ Ollama running ·', s2localOff: 'Ollama is off or not installed', s2noModel: 'no model — ollama pull gemma3:4b',
    s2claudeSub: 'Smarter, and tool calling (agent) · needs a key', s2ok2: '✅ key stored', s2needKey: 'Paste a key below to enable',
    s2install: 'To go key-free, install from', s2install2: 'then run', s2keyTitle: 'Add a Claude key (optional)',
    s2p1: '→ API Keys → Create Key, then paste the', s2p2: 'key. Without a key it still reads the letters but skips understanding and summaries.',
    connect: 'Connect', checking: 'Checking…', connected: '✅ Connected',
    s3: 'Connect your phone — Telegram', s3a: 'In Telegram, find @BotFather, send /newbot and name your bot.', s3b: 'Paste the token BotFather gives you (e.g. 123456789:AA…) below.',
    botToken: 'Bot token', s3bot: 'Connected to bot', s3bot2: '. Send /start to it from a phone and it shows up below.',
    asks: 'wants to connect', allow: 'Allow', allowMe: 'Allow as my phone', chat: 'Connected chat', unlink: 'Disconnect', waiting: 'Waiting… (send /start and it appears within 5 s)',
    s4: 'Choose how things flow', s4note: 'You can also send /mode from the phone (PC owner only).',
    s5: 'Auto-check', s5p: 'How often should it check the inbox folder? (photos from the phone are read right away)', s5env: 'Running from .env:',
    checkNow: 'Check now', started: ' item(s) started reading', nothingNew: 'Nothing new', idle: 'idle',
    ocrPaddle: 'Text reading: high-accuracy (Paddle) on', ocrBasic: 'Text reading: basic (tesseract) — high-accuracy server off', notifyTo: 'Automation results to phone:',
    recent: 'Recent activity', waitApprove: '— waiting for approval', approve: 'Approve', reject: 'Reject', asks2: '🤔 The assistant asks:', go: 'Go ahead', skip: 'Don\'t',
    noReading: 'Nothing read yet. Send a photo from your phone or drop one in the inbox folder.', verifiedAns: 'verified', skippedUnd: 'Understanding was skipped — connect Claude to get summaries.', notInDoc: '❓ Not in the document:',
    peopleHelp: 'Each Telegram chat is one person, with their own memory, automations and notifications. On first contact the bot asks for language, name, wake-up time and interests.',
    owner: 'PC owner', member: 'Person', name: 'Name', lang: 'Language', wake: 'Wake-up time', interests: 'Interests (comma-separated)', save: 'Save', saved: '✅ Saved', setupWait: 'answering first-time questions',
    noChat: '(no phone)',
  },
};
const loadLang = () => { try { return localStorage.getItem('conduit.lang') === 'en' ? 'en' : 'ko'; } catch { return 'ko'; } };

/* ---------- 골라서 쓰기 — 템플릿 카드 ---------- */
function Gallery({ onDone, lang }) {
  const u = U[lang];
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  const [vals, setVals] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOpen(null); api.listTemplates(lang).then(setList).catch((e) => setMsg(`⚠️ ${e.message}`)); }, [lang]);
  const pick = (t) => {
    setOpen(open?.id === t.id ? null : t);
    setVals(Object.fromEntries(t.fields.map((f) => [f.key, f.default ?? ''])));
    setMsg('');
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createTemplate(open.id, vals, lang);
      setMsg(`${u.turnedOn}: ${r.name}${r.when ? ` — ${r.when}` : ''}`);
      setOpen(null);
      onDone?.();
    } catch (e) {
      setMsg(`⚠️ ${e.message.replace(/ \(\d+\).*$/, '')}`);
    } finally { setBusy(false); }
  };
  return (
    <div className="easy-gallery">
      <p className="easy-sub">{u.galleryHelp}</p>
      <div className="easy-cards">
        {list.map((t) => (
          <button key={t.id} className={`easy-card ${open?.id === t.id ? 'on' : ''}`} onClick={() => pick(t)}>
            <span className="easy-card-icon">{t.icon}</span>
            <span className="easy-card-title">{t.title}</span>
            <span className="easy-card-desc">{t.desc}</span>
          </button>
        ))}
      </div>
      {open && (
        <section className="easy-step">
          <div className="easy-step-head"><span className="easy-step-title">{open.icon} {open.title}</span></div>
          <div className="easy-form">
            {open.fields.length === 0 && <p className="easy-sub">{u.noFields}</p>}
            {open.fields.map((f) => (
              <label key={f.key} className="easy-field">
                <span>{f.label}</span>
                {f.type === 'select' ? (
                  <select className="easy-input" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                    {f.options.map((o, i) => <option key={o} value={o}>{f.optionLabels?.[i] ?? o}</option>)}
                  </select>
                ) : (
                  <input className="easy-input" type={f.type === 'time' ? 'time' : 'text'} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                )}
              </label>
            ))}
            <button className="easy-btn" disabled={busy} onClick={create}>{busy ? u.turningOn : u.turnOn}</button>
          </div>
        </section>
      )}
      {msg && <p className="easy-msg">{msg}</p>}
    </div>
  );
}

/* ---------- 말로 시키기 — 채팅 ---------- */
function Chat({ lang }) {
  const u = U[lang];
  const [log, setLog] = useState([{ who: 'bot', text: u.chatHello }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setLog((l) => (l.length === 1 ? [{ who: 'bot', text: U[lang].chatHello }] : l)); }, [lang]);
  const say = async (t) => {
    const q = String(t ?? text).trim();
    if (!q) return;
    setText('');
    setLog((l) => [...l, { who: 'me', text: q }]);
    setBusy(true);
    try {
      const r = await api.assistant(q, lang);
      setLog((l) => [...l, { who: 'bot', text: r.reply, buttons: r.buttons, pendingId: r.pendingId }]);
    } catch (e) {
      setLog((l) => [...l, { who: 'bot', text: `⚠️ ${e.message}` }]);
    } finally { setBusy(false); }
  };
  const confirm = async (i, value) => {
    const [, id, yn] = value.split(':');
    const r = await api.assistantConfirm(id, yn === 'yes').catch((e) => ({ reply: `⚠️ ${e.message}` }));
    setLog((l) => l.map((m, k) => (k === i ? { ...m, buttons: null } : m)).concat({ who: 'bot', text: r.reply }));
  };
  return (
    <div className="easy-chat">
      <div className="easy-chat-log">
        {log.map((m, i) => (
          <div key={i} className={`easy-bubble ${m.who}`}>
            <div className="easy-bubble-text">{m.text}</div>
            {m.buttons && (
              <div className="easy-row" style={{ marginTop: 6 }}>
                {m.buttons.map((b) => <button key={b.value} className={b.value.endsWith(':yes') ? 'easy-btn small' : 'btn-ghost'} onClick={() => confirm(i, b.value)}>{b.label}</button>)}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="easy-bubble bot"><div className="easy-bubble-text">…</div></div>}
      </div>
      <div className="easy-row">
        {u.examples.map((x) => <button key={x} className="easy-pill" onClick={() => say(x)}>{x}</button>)}
      </div>
      <div className="easy-row">
        <input className="easy-input" placeholder={u.chatPh} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) say(); }} />
        <button className="easy-btn" disabled={busy || !text.trim()} onClick={() => say()}>{u.send}</button>
      </div>
      <p className="easy-sub">{u.chatNote}</p>
    </div>
  );
}

/* ---------- 사람 — 사람마다 따로 ---------- */
function PersonRow({ p, lang, onSaved }) {
  const u = U[lang];
  const [v, setV] = useState({ name: p.name || '', lang: p.lang || 'ko', wake: p.wake || '', interests: (p.interests || []).join(', ') });
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      await api.savePerson(p.id, { ...v, wake: v.wake || null });
      setMsg(u.saved);
      onSaved?.();
    } catch (e) { setMsg(`⚠️ ${e.message.replace(/ \(\d+\).*$/, '')}`); }
  };
  return (
    <section className="easy-step">
      <div className="easy-step-head">
        <span className="easy-step-title">{p.role === 'owner' ? '🖥️' : '📱'} {p.name || p.id}</span>
        <span className={`easy-chip ${p.role === 'owner' ? 'ok' : ''}`}>{p.role === 'owner' ? u.owner : u.member}</span>
        <span className="easy-sub">{p.chatId ? <code>{p.chatId}</code> : u.noChat}{p.onboarding && !['done', null].includes(p.onboarding) ? ` · ${u.setupWait}` : ''}</span>
      </div>
      <div className="easy-form">
        <label className="easy-field"><span>{u.name}</span><input className="easy-input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} /></label>
        <label className="easy-field"><span>{u.lang}</span>
          <select className="easy-input" value={v.lang} onChange={(e) => setV({ ...v, lang: e.target.value })}><option value="ko">한국어</option><option value="en">English</option></select>
        </label>
        <label className="easy-field"><span>{u.wake}</span><input className="easy-input" type="time" value={v.wake} onChange={(e) => setV({ ...v, wake: e.target.value })} /></label>
        <label className="easy-field"><span>{u.interests}</span><input className="easy-input" value={v.interests} onChange={(e) => setV({ ...v, interests: e.target.value })} /></label>
        <div className="easy-row"><button className="easy-btn small" onClick={save}>{u.save}</button>{msg && <span className="easy-msg">{msg}</span>}</div>
      </div>
    </section>
  );
}
function People({ lang }) {
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api.people().then(setList).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  return (
    <div>
      <p className="easy-sub">{U[lang].peopleHelp}</p>
      {err && <div className="easy-warn">{err}</div>}
      {!list && !err && <div className="insp-note">{U[lang].loading}</div>}
      {list?.map((p) => <PersonRow key={`${p.id}:${p.lang}:${p.onboarding}`} p={p} lang={lang} onSaved={load} />)}
    </div>
  );
}

function relTime(iso, u) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return u.now;
  if (s < 3600) return `${Math.floor(s / 60)}${u.minAgo}`;
  if (s < 86400) return `${Math.floor(s / 3600)}${u.hourAgo}`;
  return new Date(iso).toLocaleString();
}

function Step({ n, done, title, children, u }) {
  return (
    <section className={`easy-step ${done ? 'done' : ''}`}>
      <div className="easy-step-head">
        <span className="easy-num">{done ? <Icon name="check" size={13} /> : n}</span>
        <span className="easy-step-title">{title}</span>
        <span className={`easy-chip ${done ? 'ok' : ''}`}>{done ? u.done : u.todo}</span>
      </div>
      <div className="easy-step-body">{children}</div>
    </section>
  );
}

export default function EasyStart({ open, onClose }) {
  const [st, setSt] = useState(null);
  const [act, setAct] = useState(null);
  const [claudeKey, setClaudeKey] = useState('');
  const [tgToken, setTgToken] = useState('');
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState({});
  const [tab, setTab] = useState('start');
  const [lang, setLangState] = useState(loadLang);
  const u = U[lang];

  // 화면 언어 = PC 주인 설정 (비서 답·템플릿 이름도 같은 언어로)
  const setLang = (l) => {
    setLangState(l);
    try { localStorage.setItem('conduit.lang', l); } catch { /* 저장 못 해도 이번 화면은 바뀐다 */ }
    api.savePerson('owner', { lang: l }).catch(() => {});
  };

  const refresh = useCallback(() => {
    api.agentStatus().then(setSt).catch((e) => setMsg((m) => ({ ...m, top: e.message })));
    api.agentActivity().then(setAct).catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    refresh();
    const t = setInterval(refresh, 5000);             // 휴대폰에서 /start 를 보내면 [허용] 이 바로 뜨도록
    return () => clearInterval(t);
  }, [open, refresh]);

  if (!open) return null;

  const run = async (key, fn, okText) => {
    setBusy(key);
    setMsg((m) => ({ ...m, [key]: '' }));
    try {
      const r = await fn();
      setMsg((m) => ({ ...m, [key]: okText ? okText(r) : '' }));
      refresh();
      return r;
    } catch (e) {
      setMsg((m) => ({ ...m, [key]: `⚠️ ${e.message.replace(/ \(\d+\).*$/, '')}` }));
      return null;
    } finally {
      setBusy('');
    }
  };

  const ready = st?.quickstart?.ready;
  const tg = st?.telegram;
  const llm = st?.llm || { provider: 'none', model: null, claude: { connected: false }, local: { reachable: false, models: [] } };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal easy" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="insp-title">
            <span className="insp-icon" style={{ '--c': '#cc785c' }}><Icon name="spark" size={15} /></span>
            {u.head}
          </span>
          <span className="easy-row" style={{ marginLeft: 'auto', marginRight: 8 }}>
            {[['ko', '한국어'], ['en', 'English']].map(([k, label]) => (
              <button key={k} className={`easy-pill ${lang === k ? 'on' : ''}`} onClick={() => setLang(k)}>{label}</button>
            ))}
          </span>
          <button className="insp-close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="modal-body easy-body">
          <div className="easy-tabs">
            {u.tabs.map(([k, label]) => <button key={k} className={`easy-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          {tab === 'gallery' && <Gallery onDone={refresh} lang={lang} />}
          {tab === 'chat' && <Chat lang={lang} />}
          {tab === 'people' && <People lang={lang} />}
          {tab === 'start' && msg.top && <div className="easy-warn">{msg.top}</div>}
          {tab === 'start' && !st && !msg.top && <div className="insp-note">{u.loading}</div>}

          {tab === 'start' && st && (
            <>
              <Step n={1} done={ready} title={u.s1} u={u}>
                <p>{u.s1p}</p>
                {!ready && (
                  <button className="easy-btn" disabled={busy === 'qs'} onClick={() => run('qs', api.agentQuickstart)}>
                    {busy === 'qs' ? u.s1busy : u.s1btn}
                  </button>
                )}
                {ready && <p className="easy-sub">{u.s1inbox} <code>{st.quickstart.inbox}</code> {u.s1inbox2}</p>}
              </Step>

              <Step n={2} done={llm.provider !== 'none'} title={u.s2} u={u}>
                <p className="easy-sub">{u.s2now} <b>{llm.provider === 'local' ? `${u.s2local} (${llm.model || '?'})` : llm.provider === 'anthropic' ? `Claude (${llm.model})` : u.s2none}</b></p>
                <div className="easy-modes">
                  <button className={`easy-mode ${llm.provider === 'local' ? 'on' : ''}`} disabled={busy === 'lm'} onClick={() => run('lm', () => api.agentLlmSet({ provider: 'local' }), () => u.connected)}>
                    <b>{u.s2local}</b><br /><small>{u.s2localSub}</small><br />
                    {llm.local.reachable ? <small className="easy-ok">{u.s2localOn} {llm.local.models.length ? llm.local.models.slice(0, 3).join(', ') : u.s2noModel}</small> : <small>{u.s2localOff}</small>}
                  </button>
                  <button className={`easy-mode ${llm.provider === 'anthropic' ? 'on' : ''}`} disabled={busy === 'lm' || !llm.claude.connected} onClick={() => run('lm', () => api.agentLlmSet({ provider: 'anthropic' }), () => u.connected)}>
                    <b>Claude</b><br /><small>{u.s2claudeSub}</small><br />
                    <small>{llm.claude.connected ? u.s2ok2 : u.s2needKey}</small>
                  </button>
                </div>
                {msg.lm && <p className="easy-msg">{msg.lm}</p>}
                {!llm.local.reachable && (
                  <p className="easy-sub">{u.s2install} <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com</a> {u.s2install2} <code>ollama pull gemma3:4b</code></p>
                )}
                <details className="easy-details">
                  <summary>{llm.claude.connected ? u.s2ok : u.s2keyTitle}</summary>
                  <p>
                    <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a> {u.s2p1}
                    {' '}<code>sk-ant-…</code> {u.s2p2}
                  </p>
                  <div className="easy-row">
                    <input className="easy-input" type="password" placeholder="sk-ant-…" value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} />
                    <button className="easy-btn" disabled={!claudeKey || busy === 'ck'} onClick={async () => {
                      const r = await run('ck', () => api.agentClaudeKey(claudeKey), (x) => `${u.connected} (${x.masked})`);
                      if (r) setClaudeKey('');
                    }}>{busy === 'ck' ? u.checking : u.connect}</button>
                  </div>
                  {msg.ck && <p className="easy-msg">{msg.ck}</p>}
                </details>
              </Step>

              <Step n={3} done={tg.connected && tg.chats.length > 0} title={u.s3} u={u}>
                {!tg.connected ? (
                  <>
                    <ol className="easy-ol">
                      <li>{u.s3a}</li>
                      <li>{u.s3b}</li>
                    </ol>
                    <div className="easy-row">
                      <input className="easy-input" type="password" placeholder={u.botToken} value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
                      <button className="easy-btn" disabled={!tgToken || busy === 'tt'} onClick={async () => {
                        const r = await run('tt', () => api.agentTelegramToken(tgToken), (x) => `${u.connected}: @${x.bot.username}`);
                        if (r) setTgToken('');
                      }}>{busy === 'tt' ? u.checking : u.connect}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>{u.s3bot} <b>@{tg.bot || '…'}</b>{u.s3bot2}</p>
                    {tg.pendingChats.length > 0 && (
                      <div className="easy-list">
                        {tg.pendingChats.map((c) => (
                          <div key={c.chatId} className="easy-item">
                            <span>📱 <b>{c.name}</b>{c.username ? ` (@${c.username})` : ''} {u.asks}</span>
                            <span className="easy-row">
                              <button className="easy-btn small" onClick={() => run('al', () => api.agentTelegramAllow(c.chatId))}>{u.allow}</button>
                              {tg.chats.length > 0 && <button className="btn-ghost" onClick={() => run('al', () => api.agentTelegramAllow(c.chatId, true))}>{u.allowMe}</button>}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {tg.chats.length > 0 && (
                      <div className="easy-list">
                        {tg.chats.map((id) => (
                          <div key={id} className="easy-item ok">
                            <span>✅ {u.chat} <code>{id}</code></span>
                            <button className="btn-ghost" onClick={() => run('rm', () => api.agentTelegramRemove(id))}>{u.unlink}</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {!tg.pendingChats.length && !tg.chats.length && <p className="easy-sub">{u.waiting}</p>}
                  </>
                )}
                {msg.tt && <p className="easy-msg">{msg.tt}</p>}
              </Step>

              <Step n={4} done={tg.mode !== 'off'} title={u.s4} u={u}>
                <div className="easy-modes">
                  {Object.keys(tg.modes).map((k) => (
                    <button key={k} className={`easy-mode ${tg.mode === k ? 'on' : ''}`} onClick={() => run('md', () => api.agentTelegramSet({ mode: k }))}>
                      <span className="easy-mode-title">{u.modes[k]}</span>
                      <span className="easy-mode-help">{u.modeHelp[k]}</span>
                    </button>
                  ))}
                </div>
                <p className="easy-sub">{u.s4note}</p>
              </Step>

              <Step n={5} done={st.heartbeat.everyMin > 0 || !!st.heartbeat.env} title={u.s5} u={u}>
                <p>{u.s5p}</p>
                {st.heartbeat.env ? (
                  <p className="easy-sub">{u.s5env} <code>{st.heartbeat.env}</code></p>
                ) : (
                  <div className="easy-row">
                    {u.every.map(([v, label]) => (
                      <button key={v} className={`easy-pill ${st.heartbeat.everyMin === v ? 'on' : ''}`} onClick={() => run('hb', () => api.agentHeartbeatEvery(v))}>{label}</button>
                    ))}
                  </div>
                )}
                <div className="easy-row" style={{ marginTop: 8 }}>
                  <button className="btn-ghost" disabled={!ready || busy === 'now'} onClick={() => run('now', api.runHeartbeat, (h) => {
                    const ran = (h.results || []).filter((r) => r.execution).length;
                    return ran ? `✅ ${ran}${u.started}` : `${u.nothingNew} (${(h.results || []).map((r) => r.reason).filter(Boolean)[0] || h.note || u.idle})`;
                  })}>{busy === 'now' ? u.checking : u.checkNow}</button>
                  <span className="easy-sub">{st.ocr.paddle ? u.ocrPaddle : u.ocrBasic}</span>
                </div>
                {msg.now && <p className="easy-msg">{msg.now}</p>}
                <div className="easy-row" style={{ marginTop: 8 }}>
                  <span className="easy-sub">{u.notifyTo}</span>
                  {u.notify.map(([v, label]) => (
                    <button key={v} className={`easy-pill ${(st.notify || 'errors') === v ? 'on' : ''}`} onClick={() => run('nt', () => api.agentNotify(v))}>{label}</button>
                  ))}
                </div>
              </Step>

              <section className="easy-activity">
                <div className="easy-step-head"><span className="easy-step-title">{u.recent}</span></div>
                {act?.approvals?.length > 0 && act.approvals.map((a) => (
                  <div key={a.id} className="easy-item warn">
                    <span>⏸ <b>{a.title}</b> {u.waitApprove}</span>
                    <span className="easy-row">
                      <button className="easy-btn small" onClick={() => run('ap', () => api.decideApproval(a.id, 'approve'))}>{u.approve}</button>
                      <button className="btn-ghost" onClick={() => run('ap', () => api.decideApproval(a.id, 'reject'))}>{u.reject}</button>
                    </span>
                  </div>
                ))}
                {act?.pendingActions?.length > 0 && act.pendingActions.map((p) => (
                  <div key={p.id} className="easy-item warn">
                    <span>{u.asks2} {p.reason}</span>
                    <span className="easy-row">
                      <button className="easy-btn small" onClick={() => run('pa', () => api.decidePending(p.id, true))}>{u.go}</button>
                      <button className="btn-ghost" onClick={() => run('pa', () => api.decidePending(p.id, false))}>{u.skip}</button>
                    </span>
                  </div>
                ))}
                {!act?.readings?.length && <p className="insp-note">{u.noReading}</p>}
                {act?.readings?.map((r) => (
                  <div key={r.executionId} className="easy-reading">
                    <div className="easy-reading-head">
                      <b>{r.title}</b>
                      <span className="easy-sub">{r.from} · {relTime(r.at, u)}{r.stats ? ` · ${u.verifiedAns} ${r.stats.verified}/${r.stats.questions}` : ''}</span>
                    </div>
                    {r.simulated ? <p className="easy-sub">{u.skippedUnd}</p> : (
                      <ul>{r.sentences.map((s, i) => <li key={i}>{s}</li>)}</ul>
                    )}
                    {r.unanswered.length > 0 && <p className="easy-sub">{u.notInDoc} {r.unanswered.join(' · ')}</p>}
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
