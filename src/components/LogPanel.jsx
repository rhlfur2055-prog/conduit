import { Icon } from '../ui/icons.jsx';
import { useLang, tr, translateLog } from '../i18n.js';

// 실행 후 좌하단에 나타나는 로그 도크
export default function LogPanel({ lines, onClose }) {
  const lang = useLang();
  if (!lines.length) return null;
  return (
    <div className="logdock">
      <div className="logdock-head">
        <span>{tr(lang, 'log.title')}</span>
        <button onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="logdock-body">
        {lines.map((l, i) => (
          <div key={i} className={`logline ${l.kind || ''}`}>
            {translateLog(l.msg, lang)}
          </div>
        ))}
      </div>
    </div>
  );
}
