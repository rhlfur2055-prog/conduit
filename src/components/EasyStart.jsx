// 쉬운 시작 — 노드를 몰라도 버튼 몇 번으로 "사진을 보내면 읽고 답해 주는 비서" 를 켠다 (specs/005)
// 전문 용어는 쓰지 않는다: 하트비트 → 자동 확인, 워크플로 → (보이지 않게)
import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

const MODE_HELP = {
  both: '휴대폰으로 보낸 사진을 읽고, 결과를 휴대폰으로 답해요',
  inbound: '휴대폰으로 보낸 사진을 읽고 기억만 해요 (답장 없음)',
  outbound: '휴대폰에서 보낸 건 받지 않고, PC 결과·승인 요청만 휴대폰으로 보내요',
  off: '텔레그램으로 아무것도 주고받지 않아요',
};
const EVERY = [[0, '끄기'], [1, '1분마다'], [5, '5분마다'], [15, '15분마다'], [60, '1시간마다']];
const NOTIFY = [['errors', '실패만'], ['all', '모두'], ['off', '끄기']];
const TABS = [['start', '시작하기'], ['gallery', '골라서 쓰기'], ['chat', '말로 시키기']];
const EXAMPLES = ['매일 8시 30분에 약 먹으라고 알려줘', '평일 아침 8시에 브리핑 보내줘', '전에 읽은 결제일 뭐였지?', '템플릿 보여줘'];

/* ---------- 골라서 쓰기 — 템플릿 카드 ---------- */
function Gallery({ onDone }) {
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  const [vals, setVals] = useState({});
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.listTemplates().then(setList).catch((e) => setMsg(`⚠️ ${e.message}`)); }, []);
  const pick = (t) => {
    setOpen(open?.id === t.id ? null : t);
    setVals(Object.fromEntries(t.fields.map((f) => [f.key, f.default ?? ''])));
    setMsg('');
  };
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.createTemplate(open.id, vals);
      setMsg(`✅ 켰어요: ${r.name}${r.when ? ` — ${r.when}` : ''}`);
      setOpen(null);
      onDone?.();
    } catch (e) {
      setMsg(`⚠️ ${e.message.replace(/ \(\d+\).*$/, '')}`);
    } finally { setBusy(false); }
  };
  return (
    <div className="easy-gallery">
      <p className="easy-sub">고르고 빈칸만 채우면 바로 켜져요. 결과는 텔레그램(보내기 모드)으로 와요.</p>
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
            {open.fields.length === 0 && <p className="easy-sub">채울 것이 없어요.</p>}
            {open.fields.map((f) => (
              <label key={f.key} className="easy-field">
                <span>{f.label}</span>
                {f.type === 'select' ? (
                  <select className="easy-input" value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}>
                    {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input className="easy-input" type={f.type === 'time' ? 'time' : 'text'} value={vals[f.key]} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />
                )}
              </label>
            ))}
            <button className="easy-btn" disabled={busy} onClick={create}>{busy ? '켜는 중…' : '켜기'}</button>
          </div>
        </section>
      )}
      {msg && <p className="easy-msg">{msg}</p>}
    </div>
  );
}

/* ---------- 말로 시키기 — 채팅 ---------- */
function Chat() {
  const [log, setLog] = useState([{ who: 'bot', text: '무엇을 도와드릴까요? 아래 예시를 눌러 봐도 돼요.' }]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const say = async (t) => {
    const q = String(t ?? text).trim();
    if (!q) return;
    setText('');
    setLog((l) => [...l, { who: 'me', text: q }]);
    setBusy(true);
    try {
      const r = await api.assistant(q);
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
        {EXAMPLES.map((x) => <button key={x} className="easy-pill" onClick={() => say(x)}>{x}</button>)}
      </div>
      <div className="easy-row">
        <input className="easy-input" placeholder='예: "매일 8시 30분에 약 먹으라고 알려줘"' value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) say(); }} />
        <button className="easy-btn" disabled={busy || !text.trim()} onClick={() => say()}>보내기</button>
      </div>
      <p className="easy-sub">텔레그램에서 봇에게 같은 말을 보내도 돼요. 새 자동화는 [만들기] 를 눌러야 켜져요.</p>
    </div>
  );
}

function relTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return new Date(iso).toLocaleString();
}

function Step({ n, done, title, children }) {
  return (
    <section className={`easy-step ${done ? 'done' : ''}`}>
      <div className="easy-step-head">
        <span className="easy-num">{done ? <Icon name="check" size={13} /> : n}</span>
        <span className="easy-step-title">{title}</span>
        <span className={`easy-chip ${done ? 'ok' : ''}`}>{done ? '완료' : '할 일'}</span>
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

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal easy" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="insp-title">
            <span className="insp-icon" style={{ '--c': '#cc785c' }}><Icon name="spark" size={15} /></span>
            쉬운 시작 — 사진을 보내면 읽고 답해 주는 비서
          </span>
          <button className="insp-close" onClick={onClose}><Icon name="close" size={16} /></button>
        </div>

        <div className="modal-body easy-body">
          <div className="easy-tabs">
            {TABS.map(([k, label]) => <button key={k} className={`easy-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>)}
          </div>
          {tab === 'gallery' && <Gallery onDone={refresh} />}
          {tab === 'chat' && <Chat />}
          {tab === 'start' && msg.top && <div className="easy-warn">{msg.top}</div>}
          {tab === 'start' && !st && !msg.top && <div className="insp-note">불러오는 중…</div>}

          {tab === 'start' && st && (
            <>
              <Step n={1} done={ready} title="준비하기">
                <p>버튼을 누르면 읽기에 필요한 것들(받은편지함 폴더 · 읽는 순서 · 목표)을 알아서 만들어요.</p>
                {!ready && (
                  <button className="easy-btn" disabled={busy === 'qs'} onClick={() => run('qs', api.agentQuickstart)}>
                    {busy === 'qs' ? '준비 중…' : '시작 준비'}
                  </button>
                )}
                {ready && <p className="easy-sub">받은편지함 폴더: <code>{st.quickstart.inbox}</code> — 여기에 사진을 넣어도 읽어요.</p>}
              </Step>

              <Step n={2} done={st.claude.connected} title="Claude 연결 — 글을 이해하는 두뇌">
                {st.claude.connected ? (
                  <p>연결됐어요. 다른 키로 바꾸려면 아래에 새 키를 넣으세요.</p>
                ) : (
                  <p>
                    <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com</a> → API Keys → Create Key 로 받은
                    {' '}<code>sk-ant-…</code> 키를 붙여 넣으세요. 키가 없으면 글자는 읽지만 이해·요약은 건너뛰어요.
                  </p>
                )}
                <div className="easy-row">
                  <input className="easy-input" type="password" placeholder="sk-ant-…" value={claudeKey} onChange={(e) => setClaudeKey(e.target.value)} />
                  <button className="easy-btn" disabled={!claudeKey || busy === 'ck'} onClick={async () => {
                    const r = await run('ck', () => api.agentClaudeKey(claudeKey), (x) => `✅ 연결됐어요 (${x.masked})`);
                    if (r) setClaudeKey('');
                  }}>{busy === 'ck' ? '확인 중…' : '연결'}</button>
                </div>
                {msg.ck && <p className="easy-msg">{msg.ck}</p>}
              </Step>

              <Step n={3} done={tg.connected && tg.chats.length > 0} title="휴대폰 연결 — 텔레그램">
                {!tg.connected ? (
                  <>
                    <ol className="easy-ol">
                      <li>휴대폰 텔레그램에서 <b>@BotFather</b> 를 찾아 <code>/newbot</code> 을 보내고 봇 이름을 정하세요.</li>
                      <li>BotFather 가 준 <b>토큰</b>(예: <code>123456789:AA…</code>)을 아래에 붙여 넣으세요.</li>
                    </ol>
                    <div className="easy-row">
                      <input className="easy-input" type="password" placeholder="봇 토큰" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
                      <button className="easy-btn" disabled={!tgToken || busy === 'tt'} onClick={async () => {
                        const r = await run('tt', () => api.agentTelegramToken(tgToken), (x) => `✅ @${x.bot.username} 에 연결됐어요`);
                        if (r) setTgToken('');
                      }}>{busy === 'tt' ? '확인 중…' : '연결'}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p>봇 <b>@{tg.bot || '(이름 확인 중)'}</b> 에 연결됐어요. 휴대폰에서 이 봇에게 <code>/start</code> 를 보내면 아래에 나타나요.</p>
                    {tg.pendingChats.length > 0 && (
                      <div className="easy-list">
                        {tg.pendingChats.map((c) => (
                          <div key={c.chatId} className="easy-item">
                            <span>📱 <b>{c.name}</b>{c.username ? ` (@${c.username})` : ''} 이 연결을 요청했어요</span>
                            <button className="easy-btn small" onClick={() => run('al', () => api.agentTelegramAllow(c.chatId))}>허용</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {tg.chats.length > 0 && (
                      <div className="easy-list">
                        {tg.chats.map((id) => (
                          <div key={id} className="easy-item ok">
                            <span>✅ 연결된 채팅 <code>{id}</code></span>
                            <button className="btn-ghost" onClick={() => run('rm', () => api.agentTelegramRemove(id))}>연결 끊기</button>
                          </div>
                        ))}
                      </div>
                    )}
                    {!tg.pendingChats.length && !tg.chats.length && <p className="easy-sub">기다리는 중… (/start 를 보내면 5초 안에 뜹니다)</p>}
                  </>
                )}
                {msg.tt && <p className="easy-msg">{msg.tt}</p>}
              </Step>

              <Step n={4} done={tg.mode !== 'off'} title="주고받는 방식 고르기">
                <div className="easy-modes">
                  {Object.entries(tg.modes).map(([k, label]) => (
                    <button key={k} className={`easy-mode ${tg.mode === k ? 'on' : ''}`} onClick={() => run('md', () => api.agentTelegramSet({ mode: k }))}>
                      <span className="easy-mode-title">{label}</span>
                      <span className="easy-mode-help">{MODE_HELP[k]}</span>
                    </button>
                  ))}
                </div>
                <p className="easy-sub">휴대폰에서 <code>/mode</code> 를 보내도 바꿀 수 있어요.</p>
              </Step>

              <Step n={5} done={st.heartbeat.everyMin > 0 || !!st.heartbeat.env} title="자동 확인">
                <p>받은편지함 폴더를 얼마나 자주 확인할까요? (휴대폰으로 보낸 사진은 기다리지 않고 바로 읽어요)</p>
                {st.heartbeat.env ? (
                  <p className="easy-sub">.env 설정으로 도는 중: <code>{st.heartbeat.env}</code></p>
                ) : (
                  <div className="easy-row">
                    {EVERY.map(([v, label]) => (
                      <button key={v} className={`easy-pill ${st.heartbeat.everyMin === v ? 'on' : ''}`} onClick={() => run('hb', () => api.agentHeartbeatEvery(v))}>{label}</button>
                    ))}
                  </div>
                )}
                <div className="easy-row" style={{ marginTop: 8 }}>
                  <button className="btn-ghost" disabled={!ready || busy === 'now'} onClick={() => run('now', api.runHeartbeat, (h) => {
                    const ran = (h.results || []).filter((r) => r.execution).length;
                    return ran ? `✅ ${ran}건을 읽기 시작했어요` : `새로 온 게 없어요 (${(h.results || []).map((r) => r.reason).filter(Boolean)[0] || h.note || '대기'})`;
                  })}>{busy === 'now' ? '확인 중…' : '지금 확인하기'}</button>
                  <span className="easy-sub">글자 읽기: {st.ocr.paddle ? '고정밀(Paddle) 켜짐' : '기본(tesseract) — 고정밀 서버 꺼짐'}</span>
                </div>
                {msg.now && <p className="easy-msg">{msg.now}</p>}
                <div className="easy-row" style={{ marginTop: 8 }}>
                  <span className="easy-sub">자동화 결과를 휴대폰으로:</span>
                  {NOTIFY.map(([v, label]) => (
                    <button key={v} className={`easy-pill ${(st.notify || 'errors') === v ? 'on' : ''}`} onClick={() => run('nt', () => api.agentNotify(v))}>{label}</button>
                  ))}
                </div>
              </Step>

              <section className="easy-activity">
                <div className="easy-step-head"><span className="easy-step-title">최근 활동</span></div>
                {act?.approvals?.length > 0 && act.approvals.map((a) => (
                  <div key={a.id} className="easy-item warn">
                    <span>⏸ <b>{a.title}</b> — 승인을 기다려요</span>
                    <span className="easy-row">
                      <button className="easy-btn small" onClick={() => run('ap', () => api.decideApproval(a.id, 'approve'))}>승인</button>
                      <button className="btn-ghost" onClick={() => run('ap', () => api.decideApproval(a.id, 'reject'))}>거절</button>
                    </span>
                  </div>
                ))}
                {act?.pendingActions?.length > 0 && act.pendingActions.map((p) => (
                  <div key={p.id} className="easy-item warn">
                    <span>🤔 비서가 물어봐요: {p.reason}</span>
                    <span className="easy-row">
                      <button className="easy-btn small" onClick={() => run('pa', () => api.decidePending(p.id, true))}>진행</button>
                      <button className="btn-ghost" onClick={() => run('pa', () => api.decidePending(p.id, false))}>하지 않기</button>
                    </span>
                  </div>
                ))}
                {!act?.readings?.length && <p className="insp-note">아직 읽은 게 없어요. 휴대폰으로 사진을 보내거나 받은편지함 폴더에 넣어 보세요.</p>}
                {act?.readings?.map((r) => (
                  <div key={r.executionId} className="easy-reading">
                    <div className="easy-reading-head">
                      <b>{r.title}</b>
                      <span className="easy-sub">{r.from} · {relTime(r.at)}{r.stats ? ` · 확인된 답 ${r.stats.verified}/${r.stats.questions}` : ''}</span>
                    </div>
                    {r.simulated ? <p className="easy-sub">이해 단계는 건너뛰었어요 — Claude 를 연결하면 요약해 드려요.</p> : (
                      <ul>{r.sentences.map((s, i) => <li key={i}>{s}</li>)}</ul>
                    )}
                    {r.unanswered.length > 0 && <p className="easy-sub">❓ 문서에 없던 것: {r.unanswered.join(' · ')}</p>}
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
