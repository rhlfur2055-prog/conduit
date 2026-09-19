import { Icon } from '../ui/icons.jsx';

const NAV = [
  { key: 'workflows', label: '워크플로', icon: 'flow', active: true },
  { key: 'executions', label: '실행 기록', icon: 'list' },
  { key: 'dlq', label: '실패 큐 (DLQ)', icon: 'close' },
  { key: 'credentials', label: '자격 증명', icon: 'key' },
  { key: 'settings', label: '설정', icon: 'sliders' },
];

export default function Sidebar({
  email, onNew, onOpenCredentials, onOpenExecutions, onOpenDlq, onOpenSettings,
  workflows = [], currentId, onSelectWorkflow, onDeleteWorkflow,
}) {
  const handle = (email || 'user@flowforge').split('@')[0];
  const initial = handle.charAt(0).toUpperCase();
  const handlers = { credentials: onOpenCredentials, executions: onOpenExecutions, dlq: onOpenDlq, settings: onOpenSettings };

  return (
    <aside className="sb">
      <div className="sb-brand">
        <span className="sb-mark">
          <Icon name="spark" size={16} stroke={2} />
        </span>
        <span className="sb-word">Conduit</span>
      </div>

      <button className="sb-new" onClick={onNew}>
        <Icon name="plus" size={16} />새 워크플로
      </button>

      <nav className="sb-nav">
        {NAV.map((n) => (
          <a key={n.key} className={`sb-nav-item ${n.active ? 'active' : ''}`} onClick={handlers[n.key]}>
            <Icon name={n.icon} size={17} />
            {n.label}
          </a>
        ))}
      </nav>

      <div className="sb-section">저장된 워크플로</div>
      <div className="sb-recent">
        {workflows.length === 0 && <div className="sb-empty">아직 없어요. 상단 저장을 눌러보세요.</div>}
        {workflows.map((w) => (
          <div
            key={w.id}
            className={`sb-recent-item ${w.id === currentId ? 'active' : ''}`}
            onClick={() => onSelectWorkflow?.(w.id)}
          >
            <span className="sb-recent-dot" />
            <span className="sb-recent-name">{w.name}</span>
            {w.active && <span className="sb-recent-badge" title="활성">●</span>}
            <button
              className="sb-recent-del"
              title="삭제"
              onClick={(e) => { e.stopPropagation(); onDeleteWorkflow?.(w.id, w.name); }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="sb-user">
        <span className="sb-avatar">{initial}</span>
        <div className="sb-user-meta">
          <span className="sb-user-name">{handle}</span>
          <span className="sb-user-plan">Free 플랜</span>
        </div>
      </div>
    </aside>
  );
}
