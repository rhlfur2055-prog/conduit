import { Icon } from '../ui/icons.jsx';
import { useLang, setLang, tr, displayWfName } from '../i18n.js';

const NAV = [
  { key: 'easy', label: 'nav.easy', icon: 'spark' },
  { key: 'workflows', label: 'nav.workflows', icon: 'flow', active: true },
  { key: 'executions', label: 'nav.executions', icon: 'list' },
  { key: 'dlq', label: 'nav.dlq', icon: 'close' },
  { key: 'credentials', label: 'nav.credentials', icon: 'key' },
  { key: 'settings', label: 'nav.settings', icon: 'sliders' },
];

export default function Sidebar({
  email, onNew, onOpenCredentials, onOpenExecutions, onOpenDlq, onOpenSettings, onOpenEasy,
  workflows = [], currentId, onSelectWorkflow, onDeleteWorkflow,
}) {
  const lang = useLang();
  const t = (k, v) => tr(lang, k, v);
  const handle = (email || 'user@flowforge').split('@')[0];
  const initial = handle.charAt(0).toUpperCase();
  const handlers = { easy: onOpenEasy, credentials: onOpenCredentials, executions: onOpenExecutions, dlq: onOpenDlq, settings: onOpenSettings };

  return (
    <aside className="sb">
      <div className="sb-brand">
        <span className="sb-mark">
          <Icon name="spark" size={16} stroke={2} />
        </span>
        <span className="sb-word">Conduit</span>
      </div>

      <button className="sb-new" onClick={onNew}>
        <Icon name="plus" size={16} />{t('sb.new')}
      </button>

      <nav className="sb-nav">
        {NAV.map((n) => (
          <a key={n.key} className={`sb-nav-item ${n.active ? 'active' : ''}`} onClick={handlers[n.key]}>
            <Icon name={n.icon} size={17} />
            {t(n.label)}
          </a>
        ))}
      </nav>

      <div className="sb-section">{t('sb.saved')}</div>
      <div className="sb-recent">
        {workflows.length === 0 && <div className="sb-empty">{t('sb.empty')}</div>}
        {workflows.map((w) => (
          <div
            key={w.id}
            className={`sb-recent-item ${w.id === currentId ? 'active' : ''}`}
            onClick={() => onSelectWorkflow?.(w.id)}
          >
            <span className="sb-recent-dot" />
            <span className="sb-recent-name">{displayWfName(w.name, lang)}</span>
            {w.active && <span className="sb-recent-badge" title={t('sb.active')}>●</span>}
            <button
              className="sb-recent-del"
              title={t('sb.delete')}
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
          <span className="sb-user-plan">{t('sb.plan')}</span>
        </div>
        {/* 화면 언어 — 쉬운 시작 화면과 같은 설정을 쓴다 */}
        <button
          className="sb-lang"
          onClick={() => setLang(lang === 'en' ? 'ko' : 'en')}
          title={lang === 'en' ? '한국어로 보기' : 'Switch to English'}
          aria-label={lang === 'en' ? '한국어로 보기' : 'Switch to English'}
        >
          {t('lang.toggle')}
        </button>
      </div>
    </aside>
  );
}
