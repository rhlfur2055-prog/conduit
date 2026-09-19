import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

const STATUS_LABEL = { pending: '대기', replayed: '재실행됨', dropped: '중단' };

function relTime(iso) {
  try {
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return '방금';
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

// 실패 격리 큐(DLQ) 화면 — 조회 · 재실행 · 삭제
export default function DlqModal({ open, onClose }) {
  const [list, setList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(null); // 재실행 중인 id
  const [notice, setNotice] = useState('');

  const refresh = () =>
    api.listDlq()
      .then((rows) => {
        setList(rows);
        setSelected((cur) => rows.find((r) => r.id === cur?.id) || rows[0] || null);
      })
      .catch(() => setList([]));

  useEffect(() => { if (open) { setNotice(''); refresh(); } }, [open]);

  if (!open) return null;

  const replay = async (rec) => {
    setBusy(rec.id);
    setNotice('');
    try {
      const r = await api.replayDlq(rec.id);
      setNotice(r.error ? `재실행 실패: ${r.error}` : `재실행 완료 — 실행 기록에 추가됨 (${r.execution?.status || 'ok'})`);
    } catch (e) {
      setNotice('재실행 실패: ' + e.message);
    }
    setBusy(null);
    refresh();
  };

  const remove = async (rec) => {
    await api.deleteDlq(rec.id);
    refresh();
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="insp-title">
            <span className="insp-icon" style={{ '--c': '#c0563f' }}><Icon name="close" size={15} /></span>
            실패 격리 큐 (DLQ)
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="insp-close" onClick={refresh} title="새로고침"><Icon name="flow" size={15} /></button>
            <button className="insp-close" onClick={onClose}><Icon name="close" size={16} /></button>
          </div>
        </div>

        {notice && <div className="dlq-notice">{notice}</div>}

        <div className="exec-panes">
          <div className="exec-list">
            {list.length === 0 && (
              <div className="insp-note" style={{ padding: 16 }}>
                격리된 실패 항목이 없어요. 👍
              </div>
            )}
            {list.map((rec) => (
              <button
                key={rec.id}
                className={`exec-row ${selected?.id === rec.id ? 'on' : ''}`}
                onClick={() => setSelected(rec)}
              >
                <span className={`exec-dot ${rec.replay_status === 'replayed' ? 'success' : 'error'}`} />
                <span className="exec-meta">
                  <span className="exec-name">{rec.node_kind || 'unknown'} · {rec.workflow_name || '(임시)'}</span>
                  <span className="exec-sub">
                    <span className="exec-trigger">{STATUS_LABEL[rec.replay_status] || rec.replay_status}</span>
                    · {relTime(rec.failed_at)}
                  </span>
                </span>
              </button>
            ))}
          </div>

          <div className="exec-detail">
            {!selected && <div className="insp-note" style={{ padding: 16 }}>항목을 선택하세요.</div>}
            {selected && (
              <>
                <div className="exec-detail-head">
                  <span className="exec-badge error">{selected.error_code}</span>
                  <span className="exec-detail-name">{selected.error_msg}</span>
                  <span className="exec-detail-time">{selected.attempts}회 시도</span>
                </div>

                <div className="dlq-body">
                  <div className="fld">
                    <label>격리된 페이로드</label>
                    <pre className="insp-out">{JSON.stringify(selected.payload, null, 2)}</pre>
                  </div>
                </div>

                <div className="dlq-actions">
                  <button
                    className="cred-save"
                    style={{ width: 'auto', padding: '9px 18px' }}
                    disabled={busy === selected.id || !selected.workflow_id}
                    title={selected.workflow_id ? '이 페이로드로 워크플로를 다시 실행' : '저장된 워크플로가 아니어서 재실행 불가'}
                    onClick={() => replay(selected)}
                  >
                    {busy === selected.id ? '재실행 중…' : '↻ 재실행'}
                  </button>
                  <button className="btn-ghost danger" style={{ width: 'auto' }} onClick={() => remove(selected)}>
                    <Icon name="trash" size={14} />삭제
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
