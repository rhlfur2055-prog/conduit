import { useCallback, useRef, useState, useEffect, useMemo } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { NODE_TYPES } from './engine/nodeTypes.ts';
import { runFlow } from './engine/executor.ts';
import { FlowActions } from './flowActions.js';
import { api, authFetch, getApiKey, setApiKey } from './api.js';
import { Icon } from './ui/icons.jsx';
import FlowNode from './components/FlowNode.jsx';
import Sidebar from './components/Sidebar.jsx';
import NodePanel from './components/NodePanel.jsx';
import Inspector from './components/Inspector.jsx';
import LogPanel from './components/LogPanel.jsx';
import CredentialsModal from './components/CredentialsModal.jsx';
import ExecutionsModal from './components/ExecutionsModal.jsx';
import DlqModal from './components/DlqModal.jsx';
import EasyStart from './components/EasyStart.jsx';

const nodeTypes = { flowNode: FlowNode };
const STORAGE_KEY = 'conduit:v1';
const USER_EMAIL = import.meta.env.VITE_USER_EMAIL || '';

let idSeq = 1;
const genId = () => `n${idSeq++}_${Date.now().toString(36).slice(-4)}`;

function makeNode(kind, position, presetParams) {
  return {
    id: genId(),
    type: 'flowNode',
    position,
    data: { kind, params: { ...NODE_TYPES[kind].defaults, ...(presetParams || {}) }, status: null, result: undefined },
  };
}

function sampleFlow() {
  const trigger = makeNode('manualTrigger', { x: 0, y: 40 });
  const cond = makeNode('ifNode', { x: 240, y: 40 });
  const code = makeNode('code', { x: 480, y: -40 });
  const out1 = makeNode('output', { x: 720, y: -40 });
  const out2 = makeNode('output', { x: 480, y: 150 });
  const edge = (s, sh, t, th) => ({
    id: `e_${s}_${t}`,
    source: s,
    sourceHandle: sh,
    target: t,
    targetHandle: th,
    markerEnd: { type: MarkerType.ArrowClosed },
  });
  return {
    nodes: [trigger, cond, code, out1, out2],
    edges: [
      edge(trigger.id, 'main', cond.id, 'main'),
      edge(cond.id, 'true', code.id, 'main'),
      edge(code.id, 'main', out1.id, 'main'),
      edge(cond.id, 'false', out2.id, 'main'),
    ],
  };
}

function bumpSeq(nodes) {
  const maxId = nodes.reduce((m, n) => {
    const num = parseInt(String(n.id).replace(/^n/, ''), 10);
    return Number.isFinite(num) ? Math.max(m, num) : m;
  }, 0);
  idSeq = Math.max(idSeq, maxId + 1);
}

function loadInitial() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d.nodes?.length) {
        const nodes = d.nodes.map((n, i) => ({
          ...n,
          type: n.type || 'flowNode',
          position: n.position && Number.isFinite(n.position.x) ? n.position : { x: 80 + (i % 4) * 200, y: 80 + Math.floor(i / 4) * 150 },
          data: { ...n.data, status: null, result: undefined },
        }));
        bumpSeq(nodes);
        const edges = (d.edges || []).map((e, i) => ({ ...e, id: e.id || `e_${e.source}_${e.target}_${i}` }));
        return { nodes, edges, currentId: d.currentId || null, wfName: d.wfName || '현재 워크플로' };
      }
    }
  } catch {
    /* fall through to sample */
  }
  return { ...sampleFlow(), currentId: null, wfName: '현재 워크플로' };
}

function Editor() {
  // 최초 1회만 계산 (lazy initializer) — 렌더마다 localStorage 를 다시 읽지 않는다
  const [initial] = useState(loadInitial);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [active, setActive] = useState(false);
  const [serverUp, setServerUp] = useState(false);
  const [credOpen, setCredOpen] = useState(false);
  const [execOpen, setExecOpen] = useState(false);
  const [easyOpen, setEasyOpen] = useState(false);
  // 처음 쓰는 사람: 준비가 안 돼 있으면 쉬운 시작을 먼저 띄운다 (한 번만)
  useEffect(() => {
    api.agentStatus().then((s) => { if (!s?.quickstart?.ready) setEasyOpen(true); }).catch(() => {});
  }, []);
  const [dlqOpen, setDlqOpen] = useState(false);
  const [currentId, setCurrentId] = useState(initial.currentId);
  const [wfName, setWfName] = useState(initial.wfName);
  const [wfList, setWfList] = useState([]);
  const wrapper = useRef(null);

  const refreshWorkflows = useCallback(() => {
    api.listWorkflows().then(setWfList).catch(() => setWfList([]));
  }, []);
  useEffect(() => { if (serverUp) refreshWorkflows(); }, [serverUp, refreshWorkflows]);

  // 서버가 CONDUIT_API_KEY 로 보호될 때 쓸 키 입력 (이 브라우저에만 저장)
  const openSettings = useCallback(() => {
    const next = window.prompt(
      '서버 API 키 — 서버의 CONDUIT_API_KEY 와 같은 값을 넣으세요.\n비워 두고 확인하면 저장된 키를 지웁니다.',
      getApiKey(),
    );
    if (next === null) return;
    setApiKey(next.trim());
    if (serverUp) refreshWorkflows();
  }, [serverUp, refreshWorkflows]);

  // 백엔드 상태 폴링
  useEffect(() => {
    let alive = true;
    const check = () => api.health().then(() => alive && setServerUp(true)).catch(() => alive && setServerUp(false));
    check();
    const t = setInterval(check, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const { screenToFlowPosition } = useReactFlow();

  const selected = nodes.find((n) => n.selected) || null;

  // 자동 저장
  useEffect(() => {
    const t = setTimeout(() => {
      const clean = nodes.map((n) => ({
        ...n,
        selected: false,
        data: { kind: n.data.kind, params: n.data.params },
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: clean, edges, currentId, wfName }));
    }, 1500);
    return () => clearTimeout(t);
  }, [nodes, edges, currentId, wfName]);

  const onConnect = useCallback(
    (conn) => {
      setEdges((eds) => {
        const filtered = eds.filter(
          (e) =>
            !(e.target === conn.target && (e.targetHandle || 'main') === (conn.targetHandle || 'main'))
        );
        return addEdge({ ...conn, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
      });
    },
    [setEdges]
  );

  const centerPos = useCallback(() => {
    const el = wrapper.current;
    const w = el?.clientWidth || 800;
    const h = el?.clientHeight || 500;
    const rect = el?.getBoundingClientRect();
    return screenToFlowPosition({
      x: (rect?.left || 0) + w / 2 + (Math.random() * 60 - 30),
      y: (rect?.top || 0) + h / 2 + (Math.random() * 60 - 30),
    });
  }, [screenToFlowPosition]);

  const addNode = useCallback(
    (kind, presetParams, position) => {
      setNodes((nds) => nds.concat(makeNode(kind, position || centerPos(), presetParams)));
      setPanelOpen(false);
    },
    [centerPos, setNodes]
  );

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData('application/flowforge');
      if (!kind || !NODE_TYPES[kind]) return;
      addNode(kind, undefined, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [screenToFlowPosition, addNode]
  );
  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const updateParams = useCallback(
    (id, params) => setNodes((nds) => nds.map((n) => (n.id === id ? { ...n, data: { ...n.data, params } } : n))),
    [setNodes]
  );

  const deleteNode = useCallback(
    (id) => {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
    },
    [setNodes, setEdges]
  );

  const duplicateNode = useCallback(
    (id) => {
      setNodes((nds) => {
        const src = nds.find((n) => n.id === id);
        if (!src) return nds;
        const clone = makeNode(src.data.kind, { x: src.position.x + 40, y: src.position.y + 40 });
        clone.data.params = { ...src.data.params };
        return nds.map((n) => ({ ...n, selected: false })).concat({ ...clone, selected: true });
      });
    },
    [setNodes]
  );

  const setNodeStatus = useCallback(
    (id, status, result) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id
            ? {
                ...n,
                data: {
                  ...n.data,
                  status,
                  // 실행 중이 아니면 진행 카운터 제거
                  ...(status !== 'running' && status !== 'retrying' ? { progress: undefined } : {}),
                  ...(result !== undefined ? { result } : {}),
                },
              }
            : n
        )
      );
    },
    [setNodes]
  );

  const run = useCallback(async () => {
    setRunning(true);
    setLog([]);
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: null, result: undefined } })));
    const snapshotNodes = nodes.map((n) => ({ id: n.id, data: { kind: n.data.kind, params: n.data.params } }));
    await runFlow(snapshotNodes, edges, {
      onStatus: (id, status, result) => setNodeStatus(id, status, result),
      onLog: (line) => setLog((prev) => [...prev, line]),
    });
    setRunning(false);
  }, [nodes, edges, setNodes, setNodeStatus]);

  // 에이전트 스텝을 실시간으로 노드 타임라인에 누적
  const appendLiveStep = useCallback((id, step) => {
    setNodes((nds) => nds.map((n) => {
      if (n.id !== id) return n;
      // 아이템 배열 모델: main[0] 에 toolCalls 를 누적
      const prevArr = n.data.result?.output?.main;
      const first = (Array.isArray(prevArr) ? prevArr[0] : prevArr) || {};
      const nextFirst = { ...first, toolCalls: [...(first.toolCalls || []), step] };
      const main = Array.isArray(prevArr) && prevArr.length > 1 ? [nextFirst, ...prevArr.slice(1)] : [nextFirst];
      return { ...n, data: { ...n.data, status: 'running', result: { ...(n.data.result || {}), output: { ...(n.data.result?.output || {}), main } } } };
    }));
  }, [setNodes]);

  // 백엔드 스트리밍 실행 (SSE) — 노드 상태·로그·에이전트 스텝이 실시간으로 흐른다
  const runOnServer = useCallback(async () => {
    setRunning(true);
    setLog([{ kind: 'info', msg: '서버에서 실행 중… (실시간 스트리밍)' }]);
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, status: null, result: undefined } })));

    const handle = (evt) => {
      if (evt.type === 'log') setLog((l) => [...l, { kind: evt.kind, msg: evt.msg }]);
      else if (evt.type === 'status') {
        const payload = evt.status === 'done' || evt.status === 'error' ? { output: evt.output, input: evt.input, error: evt.error } : undefined;
        setNodeStatus(evt.id, evt.status, payload);
      } else if (evt.type === 'agentStep') appendLiveStep(evt.id, evt.step);
      else if (evt.type === 'progress') {
        setNodes((nds) => nds.map((n) =>
          n.id === evt.id ? { ...n, data: { ...n.data, progress: { done: evt.done, total: evt.total } } } : n
        ));
      }
    };

    try {
      const snapshot = {
        nodes: nodes.map((n) => ({ id: n.id, data: { kind: n.data.kind, params: n.data.params } })),
        edges,
      };
      const res = await authFetch('/api/run/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(`${res.status} ${err.error || ''} — 사이드바 "설정"에서 API 키를 확인하세요.`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          try { handle(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
        }
      }
    } catch (e) {
      setLog((l) => [...l, { kind: 'err', msg: '서버 실행 실패: ' + e.message }]);
    }
    setRunning(false);
  }, [nodes, edges, setNodes, setNodeStatus, appendLiveStep]);

  const actions = useMemo(
    () => ({ run, remove: deleteNode, duplicate: duplicateNode }),
    [run, deleteNode, duplicateNode]
  );

  const closeInspector = () => setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));

  const newFlow = () => {
    if (!confirm('새 워크플로를 시작할까요? (저장하지 않은 변경은 사라져요)')) return;
    setNodes([]);
    setEdges([]);
    setLog([]);
    setCurrentId(null);
    setWfName('새 워크플로');
    setActive(false);
  };

  // 지정한 active 값으로 서버에 저장 (백엔드가 저장 시 크론/웹훅을 등록·해제한다)
  const persist = useCallback(async (activeValue) => {
    const clean = nodes.map((n) => ({ ...n, selected: false, data: { kind: n.data.kind, params: n.data.params } }));
    const saved = await api.saveWorkflow({ id: currentId, name: wfName || '이름 없는 워크플로', nodes: clean, edges, active: activeValue });
    setCurrentId(saved.id);
    setWfName(saved.name);
    refreshWorkflows();
    return saved;
  }, [nodes, edges, currentId, wfName, refreshWorkflows]);

  const saveToServer = useCallback(async () => {
    try { await persist(active); }
    catch (e) { setLog([{ kind: 'err', msg: '저장 실패: ' + e.message }]); }
  }, [persist, active]);

  // 활성 토글 → 즉시 저장하며 크론/웹훅 등록·해제
  const toggleActive = useCallback(async () => {
    if (!serverUp) { setLog([{ kind: 'err', msg: '백엔드가 꺼져 있어 활성화할 수 없어요.' }]); return; }
    const next = !active;
    setActive(next);
    try {
      await persist(next);
      const hooks = nodes.filter((n) => n.data.kind === 'webhookTrigger').map((n) => n.data.params.path);
      const schedules = nodes.filter((n) => n.data.kind === 'scheduleTrigger').map((n) => n.data.params.interval);
      if (next) {
        const msgs = [{ kind: 'info', msg: '워크플로 활성화됨.' }];
        hooks.forEach((h) => msgs.push({ kind: 'ok', msg: `웹훅 수신 등록: POST /webhook${h}` }));
        schedules.forEach((s) => msgs.push({ kind: 'ok', msg: `스케줄 등록: ${s}` }));
        if (!hooks.length && !schedules.length) msgs.push({ kind: 'skip', msg: '웹훅/스케줄 트리거 노드가 없어 자동 실행 등록은 없어요.' });
        setLog(msgs);
      } else {
        setLog([{ kind: 'info', msg: '워크플로 비활성화됨 — 크론/웹훅 등록 해제.' }]);
      }
    } catch (e) {
      setActive(!next);
      setLog([{ kind: 'err', msg: '상태 변경 실패: ' + e.message }]);
    }
  }, [active, serverUp, persist, nodes]);

  const selectWorkflow = useCallback(async (id) => {
    try {
      const wf = await api.getWorkflow(id);
      const loaded = (wf.nodes || []).map((n, i) => ({
        ...n,
        type: n.type || 'flowNode',
        position: n.position && Number.isFinite(n.position.x) ? n.position : { x: 80 + (i % 4) * 200, y: 80 + Math.floor(i / 4) * 150 },
        selected: false,
        data: { ...n.data, status: null, result: undefined },
      }));
      bumpSeq(loaded);
      setNodes(loaded);
      setEdges((wf.edges || []).map((e, i) => ({ ...e, id: e.id || `e_${e.source}_${e.target}_${i}` })));
      setCurrentId(wf.id);
      setWfName(wf.name);
      setActive(!!wf.active);
      setLog([]);
    } catch (e) {
      setLog([{ kind: 'err', msg: '불러오기 실패: ' + e.message }]);
    }
  }, [setNodes, setEdges]);

  const deleteWorkflowById = useCallback(async (id, name) => {
    if (!confirm(`"${name}" 워크플로를 삭제할까요?`)) return;
    try {
      await api.deleteWorkflow(id);
    } catch (e) {
      setLog([{ kind: 'err', msg: '삭제 실패: ' + e.message }]);
      return;
    }
    if (id === currentId) { setCurrentId(null); }
    refreshWorkflows();
  }, [currentId, refreshWorkflows]);

  const exportFlow = () => {
    const clean = nodes.map((n) => ({ ...n, selected: false, data: { kind: n.data.kind, params: n.data.params } }));
    const blob = new Blob([JSON.stringify({ nodes: clean, edges }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'workflow.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fileInput = useRef(null);
  const importFlow = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        setNodes((d.nodes || []).map((n, i) => ({
          ...n,
          type: n.type || 'flowNode',
          position: n.position && Number.isFinite(n.position.x) ? n.position : { x: 80 + (i % 4) * 200, y: 80 + Math.floor(i / 4) * 150 },
          data: { ...n.data, status: null, result: undefined },
        })));
        setEdges((d.edges || []).map((e, i) => ({ ...e, id: e.id || `e_${e.source}_${e.target}_${i}` })));
        setLog([]);
      } catch {
        alert('올바른 워크플로 파일이 아니에요.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <FlowActions.Provider value={actions}>
      <div className="app">
        <Sidebar
          email={USER_EMAIL}
          onNew={newFlow}
          onOpenCredentials={() => setCredOpen(true)}
          onOpenExecutions={() => setExecOpen(true)}
          onOpenEasy={() => setEasyOpen(true)}
          onOpenDlq={() => setDlqOpen(true)}
          onOpenSettings={openSettings}
          workflows={wfList}
          currentId={currentId}
          onSelectWorkflow={selectWorkflow}
          onDeleteWorkflow={deleteWorkflowById}
        />

        <main className="main">
          <header className="topbar">
            <div className="tb-left">
              <input
                className="tb-name-input"
                value={wfName}
                onChange={(e) => setWfName(e.target.value)}
                spellCheck={false}
                title="워크플로 이름"
              />
              <span className="tb-saved">
                <span className="tb-dot" style={{ background: currentId ? 'var(--ok)' : 'var(--ink-3)' }} />
                {currentId ? '저장됨' : '미저장'}
              </span>
            </div>

            <div className="tb-right">
              <span className={`tb-server ${serverUp ? 'up' : ''}`} title={serverUp ? '백엔드 연결됨' : '백엔드 꺼짐'}>
                <span className="tb-server-dot" />{serverUp ? '서버 연결됨' : '서버 꺼짐'}
              </span>
              <button className="btn-ghost" onClick={saveToServer} disabled={!serverUp} title={serverUp ? '서버에 저장' : '백엔드가 꺼져 있어요'}>
                <Icon name="check" size={14} />저장
              </button>
              <button className="btn-ghost" onClick={() => fileInput.current?.click()}>불러오기</button>
              <input ref={fileInput} type="file" accept=".json" hidden onChange={importFlow} />
              <button className="btn-ghost" onClick={exportFlow}>내보내기</button>
              <button className="btn-ghost" onClick={runOnServer} disabled={!serverUp || running} title={serverUp ? '백엔드에서 실행 (AI 노드 실제 호출)' : '백엔드가 꺼져 있어요'}>
                <Icon name="bolt" size={14} />서버 실행
              </button>

              <button
                className={`tb-active ${active ? 'on' : ''}`}
                onClick={toggleActive}
                disabled={!serverUp}
                title={serverUp ? '활성화 시 웹훅/스케줄이 즉시 등록됩니다' : '백엔드가 꺼져 있어요'}
              >
                <span className="tb-active-knob" />
                <span className="tb-active-label">{active ? '활성' : '비활성'}</span>
              </button>
            </div>
          </header>

          <div className="canvas-area" ref={wrapper} onDrop={onDrop} onDragOver={onDragOver}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ markerEnd: { type: MarkerType.ArrowClosed } }}
              minZoom={0.3}
            >
              <Background color="#d9d2c4" gap={22} size={1.6} />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => NODE_TYPES[n.data.kind]?.color || '#b9b2a4'}
                maskColor="rgba(244,241,234,0.72)"
              />
            </ReactFlow>

            {/* 노드 추가 FAB */}
            <button className="add-fab" title="노드 추가" onClick={() => { closeInspector(); setPanelOpen(true); }}>
              <Icon name="plus" size={22} stroke={2.2} />
            </button>

            {/* 하단 중앙 실행 버튼 */}
            <button className="test-btn" onClick={run} disabled={running}>
              {running ? <span className="spin" /> : <Icon name="play" size={15} />}
              {running ? '실행 중…' : '워크플로 실행'}
            </button>

            <NodePanel open={panelOpen} onClose={() => setPanelOpen(false)} onAdd={addNode} />
            {!panelOpen && (
              <Inspector node={selected} onChange={updateParams} onDelete={deleteNode} onClose={closeInspector} />
            )}
            <LogPanel lines={log} onClose={() => setLog([])} />
          </div>
        </main>

        <CredentialsModal open={credOpen} onClose={() => setCredOpen(false)} />
        <ExecutionsModal open={execOpen} onClose={() => setExecOpen(false)} />
        <EasyStart open={easyOpen} onClose={() => setEasyOpen(false)} />
        <DlqModal open={dlqOpen} onClose={() => setDlqOpen(false)} />
      </div>
    </FlowActions.Provider>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
