import { memo, useContext } from 'react';
import { Handle, Position } from '@xyflow/react';
import { NODE_TYPES, itemCount } from '../engine/nodeTypes.ts';
import { FlowActions } from '../flowActions.js';
import { Icon } from '../ui/icons.jsx';
import { useLang, tr, nodeTitle } from '../i18n.js';

// 노드 박스 높이(핸들 수직 중심 계산에 사용)
const BOX_H = 62;

function FlowNode({ id, data, selected }) {
  const def = NODE_TYPES[data.kind];
  const actions = useContext(FlowActions);
  const lang = useLang();
  if (!def) return null;
  const t = (k, v) => tr(lang, k, v);

  const isTrigger = def.inputs.length === 0;
  const count = data.status === 'done' ? itemCount(data.result?.output) : null;

  return (
    <div className="nd-wrap">
      {/* 호버 툴바 */}
      <div className="nd-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button title={t('node.run')} onClick={() => actions.run()}>
          <Icon name="play" size={13} />
        </button>
        <button title={t('node.duplicate')} onClick={() => actions.duplicate(id)}>
          <Icon name="copy" size={13} />
        </button>
        <button title={t('node.delete')} onClick={() => actions.remove(id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>

      <div
        className={`nd-box ${isTrigger ? 'trigger' : ''} ${selected ? 'sel' : ''} ${data.status || ''}`}
        style={{ '--c': def.color }}
      >
        <span className="nd-icon">
          <Icon name={def.icon} size={22} />
        </span>

        {/* 입력 핸들 */}
        {def.inputs.map((port, i) => (
          <Handle
            key={'in-' + port}
            id={port}
            type="target"
            position={Position.Left}
            style={{ top: handleTop(def.inputs.length, i) }}
          />
        ))}

        {/* 출력 핸들 */}
        {def.outputs.map((port, i) => (
          <Handle
            key={'out-' + port}
            id={port}
            type="source"
            position={Position.Right}
            style={{ top: handleTop(def.outputs.length, i) }}
          />
        ))}

        {/* 실행 상태 뱃지 */}
        {data.status === 'done' && (
          <span className="nd-badge ok">
            <Icon name="check" size={12} stroke={2.4} />
          </span>
        )}
        {data.status === 'error' && <span className="nd-badge err">!</span>}
        {data.status === 'failedContinue' && <span className="nd-badge warn" title={t('node.failedContinue')}>!</span>}
        {data.status === 'retrying' && <span className="nd-badge warn" title={t('node.retrying')}>↻</span>}
        {data.status === 'waiting' && <span className="nd-badge warn" title={t('node.waiting')}>⏸</span>}
        {data.status === 'running' && <span className="nd-badge run" />}
      </div>

      {/* 출력 포트 라벨 (IF 등 다중 출력) */}
      {def.outputs.length > 1 &&
        def.outputs.map((port, i) => (
          <span key={'lbl-' + port} className="nd-port-label" style={{ top: handleTop(def.outputs.length, i) - 8 }}>
            {port}
          </span>
        ))}

      {/* 노드 이름 (박스 아래) */}
      <div className="nd-name">{nodeTitle(data.kind, lang)}</div>
      {/* 실행 중 라이브 진행 카운터, 완료 후엔 아이템 수 */}
      {data.progress && (data.status === 'running' || data.status === 'retrying') ? (
        <div className="nd-count live">{data.progress.done}/{data.progress.total}</div>
      ) : (
        count > 0 && <div className="nd-count">{t('node.items', { n: count, s: count > 1 ? 's' : '' })}</div>
      )}
    </div>
  );
}

function handleTop(total, index) {
  if (total <= 1) return BOX_H / 2;
  const gap = 20;
  const start = BOX_H / 2 - (gap * (total - 1)) / 2;
  return start + index * gap;
}

export default memo(FlowNode);
