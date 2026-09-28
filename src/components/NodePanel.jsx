import { useMemo, useRef, useEffect, useState } from 'react';
import { NODE_TYPES, PALETTE_GROUPS } from '../engine/nodeTypes.ts';
import { api } from '../api.js';
import { Icon } from '../ui/icons.jsx';
import { useLang, tr, nodeTitle, nodeDesc, categoryLabel } from '../i18n.js';

// 우측에서 슬라이드되는 노드 추가 패널 (n8n 의 노드 검색 패널과 유사)
// 연결된 MCP 서버의 도구들도 자동으로 그룹에 표시된다.
export default function NodePanel({ open, onClose, onAdd }) {
  const [q, setQ] = useState('');
  const [mcpServers, setMcpServers] = useState([]); // [{server, tools:[{name,description}], error?}]
  const [mcpLoading, setMcpLoading] = useState(false);
  const inputRef = useRef(null);
  const lang = useLang();
  const t = (k, v) => tr(lang, k, v);

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
      // 한국어 이름·영어 이름 둘 다로 찾는다 (영어 화면에서 한국어로 쳐도 나온다)
      items: g.items.filter((k) => !query || [NODE_TYPES[k].title, nodeTitle(k, 'en')].some((x) => x.toLowerCase().includes(query))),
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
          <span>{t('np.title')}</span>
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
            placeholder={t('np.search')}
          />
        </div>

        <div className="np-list">
          {groups.map((g) => (
            <div key={g.name} className="np-group">
              <div className="np-group-title">{categoryLabel(g.name, lang)}</div>
              {g.items.map((k) => {
                const def = NODE_TYPES[k];
                return (
                  <button key={k} className="np-item" onClick={() => onAdd(k)}>
                    <span className="np-item-icon" style={{ '--c': def.color }}>
                      <Icon name={def.icon} size={17} />
                    </span>
                    <span className="np-item-text">
                      <span className="np-item-title">
                        {nodeTitle(k, lang)}
                        {def.backend && <span className="np-tag">{t('np.server')}</span>}
                      </span>
                      <span className="np-item-desc">{nodeDesc(k, lang)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {/* 연결된 MCP 서버의 도구들 (자동 노드화) */}
          {mcpLoading && <div className="np-group-title">{t('np.mcpLoading')}</div>}
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
                    <span className="np-item-desc">{t.description || tr(lang, 'np.mcpTool')}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}

          {!groups.length && !mcpGroups.length && <div className="np-empty">{t('np.empty')}</div>}
        </div>
      </div>
    </>
  );
}
