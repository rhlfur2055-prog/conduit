import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

const TRIGGER_LABEL = { manual: '수동', webhook: '웹훅', schedule: '스케줄', error: '에러', replay: '재실행', mcp: 'MCP', approval: '승인 재개', agent: '비서' };
const STATUS_LABEL = { success: '성공', error: '오류', waiting: '승인 대기' };
const NODE_STATUS = { done: '완료', skip: '건너뜀', error: '오류', failedContinue: '일부 실패', waiting: '승인 대기', running: '실행 중', retrying: '재시도 중' };
const DECISION = { approve: '✅ 승인', reject: '❌ 거절', expired: '⌛ 만료' };

function relTime(iso) {
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '방금';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
const fmtMs = (ms) => (ms === null || ms === undefined ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

/* ---------- 추적: 실행 하나를 끝까지 ---------- */
function Trace({ trace, onJump }) {
  if (!trace) return null;
  const { nodes = [], approvals = [], resumedFrom, children = [], deadLetters = [] } = trace;
  return (
    <div className="trace">
      {resumedFrom && (
        <div className="trace-row" style={{ gridTemplateColumns: '1fr' }}>
          <span>
            ↩ 승인 <b>{DECISION[resumedFrom.decision] || resumedFrom.decision}</b>{resumedFrom.by ? ` · ${resumedFrom.by}` : ''} 뒤의 재개 실행
            {resumedFrom.gate === 'auto' ? ' (자동 게이트)' : ''} —{' '}
            {resumedFrom.executionId
              ? <button className="trace-link" onClick={() => onJump(resumedFrom.executionId)}>원래 실행 보기</button>
              : <span>원래 실행 기록 없음</span>}
          </span>
        </div>
      )}

      <div className="trace-h">노드 {nodes.length}개</div>
      {nodes.map((n) => (
        <div key={n.id}>
          <div className="trace-row">
            <span className={`exec-dot ${n.status === 'done' ? 'success' : n.status === 'error' ? 'error' : n.status === 'waiting' ? 'waiting' : ''}`} />
            <span className="t-name" title={n.id}>{n.title}<small>{NODE_STATUS[n.status] || n.status}</small></span>
            <span className="trace-tags">
              {n.injected && <span className="trace-tag inj" title="seed 로 주입 — 다시 실행하지 않음">주입</span>}
              {n.attempts > 1 && <span className="trace-tag" title="재시도 포함 시도 횟수">시도 {n.attempts}</span>}
              {n.failedItems > 0 && <span className="trace-tag err">실패 {n.failedItems}건 격리</span>}
              {n.status === 'waiting' && <span className="trace-tag wait">{n.wait?.[0]?.gate === 'auto' ? '자동 게이트' : '승인 노드'}</span>}
              {n.status === 'error' && <span className="trace-tag err">오류</span>}
            </span>
            <span className="t-num">
              {n.inCount !== null && n.outCount !== null ? `${n.inCount}→${n.outCount}` : n.outCount !== null ? `→${n.outCount}` : ''}
              {n.ms !== null ? `  ${fmtMs(n.ms)}` : ''}
            </span>
          </div>
          {n.error && <div className="trace-err">{n.error}</div>}
        </div>
      ))}

      {approvals.length > 0 && <div className="trace-h">승인 {approvals.length}건</div>}
      {approvals.map((a) => (
        <div key={a.id} className="trace-row" style={{ gridTemplateColumns: '8px minmax(0,1fr) auto' }}>
          <span className={`exec-dot ${a.status === 'approved' ? 'success' : a.status === 'pending' ? 'waiting' : a.status === 'failed' ? 'error' : ''}`} />
          <span className="t-name" title={a.id}>
            {a.gate === 'auto' ? '자동 게이트' : '승인 노드'} · {a.title}
            <small>
              {a.status === 'pending' ? `대기 중 · ${when(a.createdAt)}`
                : a.status === 'preparing' ? '준비 중'
                : a.status === 'failed' ? `실패 · ${a.error || ''}`
                : `${DECISION[a.decision] || a.status}${a.by ? ` · ${a.by}` : ''} · ${when(a.decidedAt)}`}
            </small>
          </span>
          <span className="trace-tags">
            {a.resumeStatus === 'resuming' && <span className="trace-tag wait">재개 중</span>}
            {a.resumeStatus === 'error' && <span className="trace-tag err" title={a.resumeError || ''}>재개 실패</span>}
            {a.resumedExecutionId && <button className="trace-link" onClick={() => onJump(a.resumedExecutionId)}>재개 실행 보기</button>}
          </span>
        </div>
      ))}

      {deadLetters.length > 0 && <div className="trace-h">격리된 실패 {deadLetters.length}건 (DLQ)</div>}
      {deadLetters.map((d) => (
        <div key={d.id} className="trace-row" style={{ gridTemplateColumns: '8px minmax(0,1fr) auto' }}>
          <span className="exec-dot error" />
          <span className="t-name" title={d.id}>{d.node_id}{d.item_key ? ` #${d.item_key}` : ''}<small>{d.error_code} · {d.error_msg}</small></span>
          <span className="trace-tags"><span className="trace-tag">{d.replay_status === 'pending' ? '재실행 가능' : d.replay_status}</span></span>
        </div>
      ))}
      {children.length > 0 && !approvals.length && null}
    </div>
  );
}

const Q_STATUS = { verified: '검증됨', refuted: '반박됨', unanswerable: '기록에 없음' };
const REFUTE = { fabricated: '인용 위조', paraphrased: '의역', unsupported_value: '인용에 없는 값', no_evidence: '근거 없음', instruction_quote: '숨은 지시 인용', too_short: '인용이 너무 짧음', status_contradiction: '인용한 줄의 상태와 반대' };

/** "왜 이 행동이 일어났나" — 운영 기록을 벡터로 찾아 소크라테스식으로 묻고, 답마다 기록 줄을 인용한다 (server/why.js)
 *  뼈대는 DB 외래 키를 따른 규칙 답, 모델 답은 검증을 통과한 것만 따로 덧붙는다. */
function QA({ x, lineText }) {
  return (
    <div className={`why-q ${x.status}`}>
      <div className="why-q-head"><span className={`trace-tag ${x.status === 'verified' ? 'inj' : x.status === 'refuted' ? 'err' : 'wait'}`}>{Q_STATUS[x.status] || x.status}</span> {x.q}</div>
      <div className="why-a">{x.a}{x.status === 'refuted' && <small> — {REFUTE[x.reason] || x.reason}{x.unsupported ? `: ${x.unsupported.join(', ')}` : ''}</small>}</div>
      {(x.evidence || []).map((e, i) => (
        <div key={i} className="why-ev" title={e.ref || ''}><b>{e.line}</b> {lineText(e.line) || e.quote}</div>
      ))}
    </div>
  );
}

function Why({ executionId, onJump }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { setRes(null); setErr(''); setOpen(false); }, [executionId]);

  const ask = async () => {
    setBusy(true); setErr('');
    try { setRes(await api.why(q.trim() ? { question: q.trim() } : { executionId })); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const lineText = (id) => res?.lines?.find((l) => l.id === id)?.text;
  const m = res?.model;

  return (
    <div className="why">
      <div className="why-ask">
        <input className="why-input" placeholder="왜 이렇게 됐나? (비우면 이 실행 · 예: 김민수 고객 답장은 왜 나갔어?)" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') ask(); }} />
        <button className="why-btn" disabled={busy} onClick={ask}>{busy ? '찾는 중…' : '왜?'}</button>
      </div>
      {err && <div className="trace-err">{err}</div>}
      {res && !res.found && <div className="insp-note">{res.answer}</div>}
      {res?.found && (
        <div className="why-body">
          <div className="why-meta">
            검색 {res.search?.mode}{res.index?.embedded ? ` · 벡터 ${res.index.model} · 색인 ${res.index.total}건` : ' · 글자 겹침'}
            {res.focus && res.focus !== executionId && <> · 초점 <button className="trace-link" onClick={() => onJump(res.focus)}>{res.focus}</button></>}
          </div>
          <ul className="why-sentences">{res.sentences.map((s, i) => <li key={i}>{s}</li>)}</ul>
          {m && (
            <div className="why-meta">
              모델 {m.model} — 검증 {m.verified} · 반박 {m.refuted}{m.unanswerable ? ` · 기록에 없음 ${m.unanswerable}` : ''}
              {m.sentences?.length > 0 && <ul className="why-sentences model">{m.sentences.map((s, i) => <li key={i}>{s}</li>)}</ul>}
            </div>
          )}
          <button className="trace-link" onClick={() => setOpen((v) => !v)}>{open ? '문답 접기' : `스스로 던진 질문 ${res.questions.length}개와 근거 보기`}</button>
          {open && (
            <div className="why-qs">
              {res.questions.map((x) => <QA key={x.id} x={x} lineText={lineText} />)}
              {m?.questions?.length > 0 && <div className="trace-h">모델이 던진 질문 {m.questions.length}개 — 반박된 답은 버렸습니다</div>}
              {m?.questions?.map((x) => <QA key={x.id} x={x} lineText={lineText} />)}
            </div>
          )}
          {res.alternatives?.length > 0 && (
            <div className="why-meta">다른 후보: {res.alternatives.map((h) => (
              <button key={h.ref} className="trace-link" onClick={() => h.executionId && onJump(h.executionId)}>{h.sourceId}</button>
            ))}</div>
          )}
          {res.note && <div className="insp-note">{res.note}</div>}
        </div>
      )}
    </div>
  );
}

export default function ExecutionsModal({ open, onClose }) {
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [trace, setTrace] = useState(null);
  const [loading, setLoading] = useState(false);

  const refresh = () => {
    setLoading(true);
    api.listExecutions()
      .then((rows) => {
        setList(rows);
        setSelected((cur) => rows.find((r) => r.id === cur?.id) || rows[0] || null);
      })
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (open) refresh(); }, [open]);

  // 선택이 바뀌면 추적을 가져온다 (실패해도 로그는 보인다)
  useEffect(() => {
    let alive = true;
    setTrace(null);
    if (selected?.id) api.getTrace(selected.id).then((t) => { if (alive) setTrace(t); }).catch(() => {});
    return () => { alive = false; };
  }, [selected?.id]);

  // 승인 ↔ 재개 실행 사이를 오간다 — 목록에 없으면(오래된 기록) 새로 읽는다
  const jump = (id) => {
    const hit = list.find((r) => r.id === id);
    if (hit) return setSelected(hit);
    api.listExecutions().then((rows) => { setList(rows); const h = rows.find((r) => r.id === id); if (h) setSelected(h); }).catch(() => {});
  };

  if (!open) return null;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="insp-title">
            <span className="insp-icon" style={{ '--c': '#5f7fa3' }}><Icon name="list" size={15} /></span>
            실행 기록
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="insp-close" onClick={refresh} title="새로고침"><Icon name="flow" size={15} /></button>
            <button className="insp-close" onClick={onClose}><Icon name="close" size={16} /></button>
          </div>
        </div>

        <div className="exec-panes">
          <div className="exec-list">
            {list.length === 0 && <div className="insp-note" style={{ padding: 16 }}>{loading ? '불러오는 중…' : '실행 기록이 없어요. 워크플로를 실행해 보세요.'}</div>}
            {list.map((ex) => (
              <button
                key={ex.id}
                className={`exec-row ${selected?.id === ex.id ? 'on' : ''}`}
                onClick={() => setSelected(ex)}
              >
                <span className={`exec-dot ${ex.status}`} />
                <span className="exec-meta">
                  <span className="exec-name">{ex.workflowName || '(임시)'}</span>
                  <span className="exec-sub">
                    <span className="exec-trigger">{TRIGGER_LABEL[ex.trigger] || ex.trigger}</span>
                    · {relTime(ex.at)}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="exec-detail">
            {!selected && <div className="insp-note">실행을 선택하세요.</div>}
            {selected && (
              <>
                <div className="exec-detail-head">
                  <span className={`exec-badge ${selected.status}`}>{STATUS_LABEL[selected.status] || selected.status}</span>
                  <span className="exec-detail-name">{selected.workflowName}</span>
                  <span className="exec-detail-time">
                    {new Date(selected.at).toLocaleString()}
                    {selected.durationMs !== null && selected.durationMs !== undefined ? ` · ${fmtMs(selected.durationMs)}` : ''}
                    {' · '}<span title={selected.id}>{selected.id}</span>
                  </span>
                </div>
                <Why executionId={selected.id} onJump={jump} />
                <Trace trace={trace} onJump={jump} />
                <div className="exec-logs">
                  {(selected.logs || []).map((l, i) => (
                    <div key={i} className={`logline ${l.kind || ''}`}>{l.msg}</div>
                  ))}
                  {(!selected.logs || selected.logs.length === 0) && <div className="insp-note">로그가 없어요.</div>}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
