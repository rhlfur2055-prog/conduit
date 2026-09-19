import { Icon } from '../ui/icons.jsx';

// 실행 후 좌하단에 나타나는 로그 도크
export default function LogPanel({ lines, onClose }) {
  if (!lines.length) return null;
  return (
    <div className="logdock">
      <div className="logdock-head">
        <span>실행 로그</span>
        <button onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="logdock-body">
        {lines.map((l, i) => (
          <div key={i} className={`logline ${l.kind || ''}`}>
            {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}
