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
