import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

const TRIGGER_LABEL = { manual: '수동', webhook: '웹훅', schedule: '스케줄', error: '에러', replay: '재실행', mcp: 'MCP' };

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

export default function ExecutionsModal({ open, onClose }) {
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
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
                  <span className={`exec-badge ${selected.status}`}>
                    {selected.status === 'success' ? '성공' : '오류'}
                  </span>
                  <span className="exec-detail-name">{selected.workflowName}</span>
                  <span className="exec-detail-time">{new Date(selected.at).toLocaleString()}</span>
                </div>
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
