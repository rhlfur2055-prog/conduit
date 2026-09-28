import { useState } from 'react';
import { NODE_TYPES } from '../engine/nodeTypes.ts';
import { profileFor } from '../engine/retry.ts';
import { Icon } from '../ui/icons.jsx';
import { useLang, tr, nodeTitle, fieldLabel } from '../i18n.js';

function pickOutput(output) {
  if (!output) return undefined;
  return output.main ?? output.true ?? output.false ?? Object.values(output).find((x) => x !== undefined);
}

// 노드 선택 시 우측에서 열리는 파라미터 + 데이터(NDV) 패널
export default function Inspector({ node, onChange, onDelete, onClose }) {
  const [tab, setTab] = useState('params');
  const lang = useLang();
  const t = (k, v) => tr(lang, k, v);
  if (!node) return null;

  const def = NODE_TYPES[node.data.kind];
  const params = node.data.params;
  const result = node.data.result;
  const profile = profileFor(node.data.kind);
  const update = (key, value) => onChange(node.id, { ...params, [key]: value });

  const inputData = result?.input;
  const outputData = result?.error ? { error: result.error } : pickOutput(result?.output);

  return (
    <div className="insp">
      <div className="insp-head">
        <span className="insp-title">
          <span className="insp-icon" style={{ '--c': def.color }}>
            <Icon name={def.icon} size={16} />
          </span>
          {nodeTitle(node.data.kind, lang)}
        </span>
        <button className="insp-close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="insp-tabs">
        <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}>{t('insp.params')}</button>
        <button className={tab === 'input' ? 'on' : ''} onClick={() => setTab('input')}>{t('insp.input')}</button>
        <button className={tab === 'output' ? 'on' : ''} onClick={() => setTab('output')}>{t('insp.output')}</button>
      </div>

      <div className="insp-body">
        {tab === 'params' && (
          <>
            {def.backend && (
              <div className="insp-banner">
                <Icon name="bolt" size={14} />{t('insp.backend')}
              </div>
            )}
            {def.fields.map((f) => (
              <div className="fld" key={f.key}>
                <label>{fieldLabel(node.data.kind, f, lang)}</label>
                {f.type === 'textarea' && (
                  <textarea value={params[f.key] ?? ''} onChange={(e) => update(f.key, e.target.value)} spellCheck={false} />
                )}
                {f.type === 'select' && (
                  <select value={params[f.key] ?? ''} onChange={(e) => update(f.key, e.target.value)}>
                    {f.options.map((o) => (<option key={o}>{o}</option>))}
                  </select>
                )}
                {f.type === 'text' && (
                  <input value={params[f.key] ?? ''} onChange={(e) => update(f.key, e.target.value)} />
                )}
              </div>
            ))}
            {def.fields.length === 0 && <div className="insp-note">{t('insp.noFields')}</div>}
            <div className="insp-hint">{t('insp.hintPre')}<code>{`{{ $json.${t('insp.hintField')} }}`}</code>{t('insp.hintPost')}</div>

            <div className="insp-sub-head">{t('insp.batch')}</div>
            <div className="fld">
              <label>{t('insp.batchSize')}</label>
              <select value={params._batchSize ?? ''} onChange={(e) => update('_batchSize', e.target.value)}>
                <option value="">{t('insp.sequential')}</option>
                {[2, 5, 10, 20, 50].map((v) => (<option key={v} value={v}>{t('insp.parallel', { n: v })}</option>))}
              </select>
            </div>
            <div className="fld">
              <label>{t('insp.batchDelay')}</label>
              <select value={params._batchDelayMs ?? ''} onChange={(e) => update('_batchDelayMs', e.target.value)}>
                <option value="">{t('insp.none')}</option>
                {[200, 350, 500, 1000, 1500].map((v) => (<option key={v} value={v}>{v}ms</option>))}
              </select>
            </div>

            <div className="insp-sub-head">{t('insp.reliability')}</div>
            <div className="fld">
              <label>{t('insp.retries', { n: profile.maxRetries })}</label>
              <select value={params._retries ?? ''} onChange={(e) => update('_retries', e.target.value)}>
                <option value="">{t('insp.retriesDefault', { n: profile.maxRetries })}</option>
                {[0, 1, 2, 3, 5, 8].map((v) => (<option key={v} value={v}>{t('insp.times', { n: v })}</option>))}
              </select>
            </div>
            <label className="insp-check">
              <input
                type="checkbox"
                checked={params._continueOnFail === true || params._continueOnFail === 'true'}
                onChange={(e) => update('_continueOnFail', e.target.checked)}
              />
              {t('insp.continueOnFail')}
            </label>
            <div className="insp-hint">{t('insp.retryNote')}</div>
          </>
        )}

        {tab === 'input' && (
          <DataView data={inputData} empty={t('insp.noInput')} />
        )}
        {tab === 'output' && (() => {
          // 에이전트 노드: 첫 아이템에 toolCalls 가 있으면 타임라인 뷰
          const first = Array.isArray(outputData) ? outputData[0] : outputData;
          return first && Array.isArray(first.toolCalls)
            ? <AgentTimeline result={first} />
            : <DataView data={outputData} empty={t('insp.noOutput')} />;
        })()}
      </div>

      <div className="insp-foot">
        <button className="btn-ghost danger" onClick={() => onDelete(node.id)}>
          <Icon name="trash" size={15} />{t('insp.deleteNode')}
        </button>
      </div>
    </div>
  );
}

function DataView({ data, empty }) {
  const lang = useLang();
  if (data === undefined) return <div className="insp-note">{empty}</div>;

  // 아이템 배열이면 n8n 처럼 아이템 단위로 보여준다
  if (Array.isArray(data)) {
    return (
      <div>
        <div className="ndv-count">{tr(lang, 'node.items', { n: data.length, s: data.length !== 1 ? 's' : '' })}</div>
        {data.slice(0, 30).map((item, i) => (
          <div className="ndv-item" key={i}>
            <div className="ndv-item-head">{tr(lang, 'insp.item', { n: i + 1 })}</div>
            <pre className="insp-out">{JSON.stringify(item, null, 2)}</pre>
          </div>
        ))}
        {data.length > 30 && <div className="insp-note">{tr(lang, 'insp.more', { n: data.length - 30 })}</div>}
      </div>
    );
  }
  return <pre className="insp-out">{JSON.stringify(data, null, 2)}</pre>;
}

const TOOL_META = {
  run_code: { c: '#9c5f7d', label: '코드 실행', en: 'Run code' },
  http_get: { c: '#5f7fa3', label: 'HTTP GET', en: 'HTTP GET' },
  http_auth: { c: '#5f7fa3', label: 'HTTP 인증', en: 'HTTP (auth)' },
  youtube_search: { c: '#ff0000', label: 'YouTube 검색', en: 'YouTube search' },
  naver_search: { c: '#03c75a', label: 'Naver 검색', en: 'Naver search' },
  slack_post: { c: '#611f69', label: 'Slack 전송', en: 'Slack post' },
  notion_create: { c: '#111111', label: 'Notion 생성', en: 'Notion create' },
  run_workflow: { c: '#cc785c', label: '서브워크플로 실행', en: 'Run sub-workflow' },
  mcp_list_tools: { c: '#7c5cbf', label: 'MCP 도구 목록', en: 'MCP tool list' },
  mcp_call: { c: '#7c5cbf', label: 'MCP 도구 호출', en: 'MCP tool call' },
};

function AgentTimeline({ result }) {
  const lang = useLang();
  const calls = result.toolCalls || [];
  return (
    <div className="tl">
      {calls.length === 0 && (
        <div className="insp-note">{tr(lang, 'insp.noTools')}</div>
      )}

      {calls.length > 0 && (
        <div className="tl-track">
          {calls.map((c, i) => {
            const meta = TOOL_META[c.tool] || { c: '#8b8579', label: c.tool };
            return (
              <div className="tl-item" key={i}>
                <span className="tl-dot" style={{ '--c': meta.c }}>{c.step}</span>
                <div className="tl-card">
                  <div className="tl-tool">
                    <span className="tl-tool-chip" style={{ background: meta.c }} />
                    {lang === 'en' && meta.en ? meta.en : meta.label}
                    <span className="tl-tool-name">{c.tool}</span>
                  </div>
                  {c.input !== undefined && (
                    <div className="tl-io">
                      <span className="tl-io-k">{tr(lang, 'insp.toolIn')}</span>
                      <code>{typeof c.input === 'object' ? JSON.stringify(c.input) : String(c.input)}</code>
                    </div>
                  )}
                  <div className="tl-io">
                    <span className="tl-io-k">{tr(lang, 'insp.toolOut')}</span>
                    <code className="tl-out">{String(c.output ?? '')}</code>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {result.agentResult && (
        <div className="tl-final">
          <div className="tl-final-label">{tr(lang, 'insp.final')}</div>
          <div className="tl-final-text">{result.agentResult}</div>
        </div>
      )}

      <details className="tl-raw">
        <summary>{tr(lang, 'insp.raw')}</summary>
        <pre className="insp-out">{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
