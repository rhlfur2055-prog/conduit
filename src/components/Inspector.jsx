import { useState } from 'react';
import { NODE_TYPES } from '../engine/nodeTypes.js';
import { profileFor } from '../engine/retry.js';
import { Icon } from '../ui/icons.jsx';

function pickOutput(output) {
  if (!output) return undefined;
  return output.main ?? output.true ?? output.false ?? Object.values(output).find((x) => x !== undefined);
}

// 노드 선택 시 우측에서 열리는 파라미터 + 데이터(NDV) 패널
export default function Inspector({ node, onChange, onDelete, onClose }) {
  const [tab, setTab] = useState('params');
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
          {def.title}
        </span>
        <button className="insp-close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </div>

      <div className="insp-tabs">
        <button className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}>설정</button>
        <button className={tab === 'input' ? 'on' : ''} onClick={() => setTab('input')}>입력</button>
        <button className={tab === 'output' ? 'on' : ''} onClick={() => setTab('output')}>출력</button>
      </div>

      <div className="insp-body">
        {tab === 'params' && (
          <>
            {def.backend && (
              <div className="insp-banner">
                <Icon name="bolt" size={14} />이 노드의 실제 연동은 백엔드 서버가 필요해요. 지금은 시뮬레이션 결과를 냅니다.
              </div>
            )}
            {def.fields.map((f) => (
              <div className="fld" key={f.key}>
                <label>{f.label}</label>
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
            {def.fields.length === 0 && <div className="insp-note">설정할 항목이 없는 노드예요.</div>}
            <div className="insp-hint">💡 값에 <code>{'{{ $json.필드 }}'}</code> 를 쓰면 이전 노드 데이터를 참조해요.</div>

            <div className="insp-sub-head">배치 처리</div>
            <div className="fld">
              <label>배치 크기 (0=순차 · N=한 번에 N개 병렬)</label>
              <select value={params._batchSize ?? ''} onChange={(e) => update('_batchSize', e.target.value)}>
                <option value="">순차 (기본)</option>
                {[2, 5, 10, 20, 50].map((v) => (<option key={v} value={v}>{v}개씩 병렬</option>))}
              </select>
            </div>
            <div className="fld">
              <label>배치 간 지연 (ms · rate limit 대응)</label>
              <select value={params._batchDelayMs ?? ''} onChange={(e) => update('_batchDelayMs', e.target.value)}>
                <option value="">없음</option>
                {[200, 350, 500, 1000, 1500].map((v) => (<option key={v} value={v}>{v}ms</option>))}
              </select>
            </div>

            <div className="insp-sub-head">안정성</div>
            <div className="fld">
              <label>재시도 횟수 (비우면 노드 기본값: {profile.maxRetries}회)</label>
              <select value={params._retries ?? ''} onChange={(e) => update('_retries', e.target.value)}>
                <option value="">기본값 ({profile.maxRetries}회)</option>
                {[0, 1, 2, 3, 5, 8].map((v) => (<option key={v} value={v}>{v}회</option>))}
              </select>
            </div>
            <label className="insp-check">
              <input
                type="checkbox"
                checked={params._continueOnFail === true || params._continueOnFail === 'true'}
                onChange={(e) => update('_continueOnFail', e.target.checked)}
              />
              실패해도 계속 진행 (Continue On Fail)
            </label>
            <div className="insp-hint">
              일시 오류(429·5xx·네트워크)만 재시도하고, 영구 오류(400·401·404)는 즉시 실패합니다.
              실패 항목은 DLQ에 격리돼요.
            </div>
          </>
        )}

        {tab === 'input' && (
          <DataView data={inputData} empty="아직 입력 데이터가 없어요. 워크플로를 실행해 보세요." />
        )}
        {tab === 'output' && (() => {
          // 에이전트 노드: 첫 아이템에 toolCalls 가 있으면 타임라인 뷰
          const first = Array.isArray(outputData) ? outputData[0] : outputData;
          return first && Array.isArray(first.toolCalls)
            ? <AgentTimeline result={first} />
            : <DataView data={outputData} empty="아직 출력 데이터가 없어요. 워크플로를 실행해 보세요." />;
        })()}
      </div>

      <div className="insp-foot">
        <button className="btn-ghost danger" onClick={() => onDelete(node.id)}>
          <Icon name="trash" size={15} />노드 삭제
        </button>
      </div>
    </div>
  );
}

function DataView({ data, empty }) {
  if (data === undefined) return <div className="insp-note">{empty}</div>;

  // 아이템 배열이면 n8n 처럼 아이템 단위로 보여준다
  if (Array.isArray(data)) {
    return (
      <div>
        <div className="ndv-count">{data.length} item{data.length !== 1 ? 's' : ''}</div>
        {data.slice(0, 30).map((item, i) => (
          <div className="ndv-item" key={i}>
            <div className="ndv-item-head">아이템 {i + 1}</div>
            <pre className="insp-out">{JSON.stringify(item, null, 2)}</pre>
          </div>
        ))}
        {data.length > 30 && <div className="insp-note">… 외 {data.length - 30}건</div>}
      </div>
    );
  }
  return <pre className="insp-out">{JSON.stringify(data, null, 2)}</pre>;
}

const TOOL_META = {
  run_code: { c: '#9c5f7d', label: '코드 실행' },
  http_get: { c: '#5f7fa3', label: 'HTTP GET' },
  http_auth: { c: '#5f7fa3', label: 'HTTP 인증' },
  youtube_search: { c: '#ff0000', label: 'YouTube 검색' },
  naver_search: { c: '#03c75a', label: 'Naver 검색' },
  slack_post: { c: '#611f69', label: 'Slack 전송' },
  notion_create: { c: '#111111', label: 'Notion 생성' },
  run_workflow: { c: '#cc785c', label: '서브워크플로 실행' },
  mcp_list_tools: { c: '#7c5cbf', label: 'MCP 도구 목록' },
  mcp_call: { c: '#7c5cbf', label: 'MCP 도구 호출' },
};

function AgentTimeline({ result }) {
  const calls = result.toolCalls || [];
  return (
    <div className="tl">
      {calls.length === 0 && (
        <div className="insp-note">이번 실행에서 도구 호출이 없었어요. (모델이 바로 답했거나 시뮬레이션 모드)</div>
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
                    {meta.label}
                    <span className="tl-tool-name">{c.tool}</span>
                  </div>
                  {c.input !== undefined && (
                    <div className="tl-io">
                      <span className="tl-io-k">입력</span>
                      <code>{typeof c.input === 'object' ? JSON.stringify(c.input) : String(c.input)}</code>
                    </div>
                  )}
                  <div className="tl-io">
                    <span className="tl-io-k">결과</span>
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
          <div className="tl-final-label">최종 답변</div>
          <div className="tl-final-text">{result.agentResult}</div>
        </div>
      )}

      <details className="tl-raw">
        <summary>원본 데이터 (JSON)</summary>
        <pre className="insp-out">{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
