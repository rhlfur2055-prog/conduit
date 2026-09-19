import { NODE_TYPES, PALETTE_GROUPS } from '../engine/nodeTypes.js';

// 왼쪽 노드 팔레트. 클릭 또는 캔버스로 드래그하여 노드 추가.
export default function Palette({ onAdd }) {
  return (
    <aside className="ff-palette">
      <div className="ff-brand">
        Flow<span>Forge</span>
      </div>
      <p className="ff-brand-sub">나만의 자동화 빌더</p>

      {PALETTE_GROUPS.map((group) => (
        <div key={group.name}>
          <h3>{group.name}</h3>
          {group.items.map((kind) => {
            const def = NODE_TYPES[kind];
            return (
              <div
                key={kind}
                className="ff-pal-item"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/flowforge', kind);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onAdd(kind)}
                title="클릭하거나 캔버스로 드래그"
              >
                <span className="ff-dot" style={{ background: def.color }} />
                {def.title}
              </div>
            );
          })}
        </div>
      ))}

      <p className="ff-hint">
        💡 노드를 캔버스로 끌어놓고, 오른쪽 점을 다른 노드의 왼쪽 점으로 이어보세요.
      </p>
    </aside>
  );
}
