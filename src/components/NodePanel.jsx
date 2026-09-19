import { useMemo, useRef, useEffect, useState } from 'react';
import { NODE_TYPES, PALETTE_GROUPS } from '../engine/nodeTypes.js';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';

// 우측에서 슬라이드되는 노드 추가 패널 (n8n 의 노드 검색 패널과 유사)
// 연결된 MCP 서버의 도구들도 자동으로 그룹에 표시된다.
export default function NodePanel({ open, onClose, onAdd }) {
  const [q, setQ] = useState('');
  const [mcpServers, setMcpServers] = useState([]); // [{server, tools:[{name,description}], error?}]
  const [mcpLoading, setMcpLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setTimeout(() => inputRef.current?.focus(), 60);
      setMcpLoading(true);
      api.listMcpTools()
        .then((rows) => setMcpServers(Array.isArray(rows) ? rows : []))
        .catch(() => setMcpServers([]))
        .finally(() => setMcpLoading(false));
    }
  }, [open]);

  const query = q.trim().toLowerCase();

  const groups = useMemo(() => {
    return PALETTE_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((k) => !query || NODE_TYPES[k].title.toLowerCase().includes(query)),
    })).filter((g) => g.items.length);
  }, [query]);

  const mcpGroups = useMemo(() => {
    return mcpServers
      .map((s) => ({
        ...s,
        tools: (s.tools || []).filter(
          (t) => !query || t.name.toLowerCase().includes(query) || (t.description || '').toLowerCase().includes(query)
        ),
      }))
      .filter((s) => s.tools.length || s.error);
  }, [mcpServers, query]);

  if (!open) return null;

  return (
    <>
      <div className="np-scrim" onClick={onClose} />
      <div className="np">
        <div className="np-head">
          <span>노드 추가</span>
          <button className="np-close" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="np-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="노드 검색…"
          />
        </div>

        <div className="np-list">
          {groups.map((g) => (
            <div key={g.name} className="np-group">
              <div className="np-group-title">{g.name}</div>
              {g.items.map((k) => {
                const def = NODE_TYPES[k];
                return (
                  <button key={k} className="np-item" onClick={() => onAdd(k)}>
                    <span className="np-item-icon" style={{ '--c': def.color }}>
                      <Icon name={def.icon} size={17} />
                    </span>
                    <span className="np-item-text">
                      <span className="np-item-title">
                        {def.title}
                        {def.backend && <span className="np-tag">서버</span>}
                      </span>
                      <span className="np-item-desc">{def.summary(def.defaults)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* 연결된 MCP 서버의 도구들 (자동 노드화) */}
          {mcpLoading && <div className="np-group-title">MCP 도구 불러오는 중…</div>}
          {mcpGroups.map((s) => (
            <div key={s.server} className="np-group">
              <div className="np-group-title">MCP · {s.server}</div>
              {s.error && <div className="np-empty" style={{ padding: '6px 10px', textAlign: 'left' }}>{s.error}</div>}
              {s.tools.map((t) => (
                <button
                  key={t.name}
                  className="np-item"
                  onClick={() => onAdd('mcpTool', { credential: s.server, tool: t.name, args: '{\n}' })}
                  title={t.description}
                >
                  <span className="np-item-icon" style={{ '--c': '#7c5cbf' }}>
                    <Icon name="bolt" size={17} />
                  </span>
                  <span className="np-item-text">
                    <span className="np-item-title">
                      {t.name}
                      <span className="np-tag">MCP</span>
                    </span>
                    <span className="np-item-desc">{t.description || 'MCP 도구'}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}

          {!groups.length && !mcpGroups.length && <div className="np-empty">검색 결과가 없어요.</div>}
        </div>
      </div>
    </>
  );
}
