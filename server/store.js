// ============================================================
// 파일 기반 저장소 + 크리덴셜 AES-256-GCM 암호화
// server/data/ 아래에 JSON 파일로 영속화한다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// CONDUIT_DATA_DIR 로 바꿀 수 있다 (테스트가 임시 폴더를 쓰도록 — 실제 데이터를 건드리지 않게)
export const DATA_DIR = process.env.CONDUIT_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const file = (name) => path.join(DATA_DIR, name);

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    // 파일은 있는데 못 읽는다 = 손상. 조용히 빈 값으로 덮어쓰지 말고 백업해 두고 크게 알린다.
    try {
      const backup = file(`${name}.corrupt-${Date.now()}`);
      fs.renameSync(file(name), backup);
      console.error(`[store] ${name} 이 손상돼 ${path.basename(backup)} 으로 옮겼습니다: ${e.message}`);
    } catch { /* 백업 실패는 무시 */ }
    return fallback;
  }
}
// 임시 파일에 쓰고 이름을 바꾼다 — 쓰는 도중 꺼져도 반쪽 파일이 남지 않는다
function writeJSON(name, data) {
  const target = file(name);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

// 코드 노드 등에서 server/data 아래 JSON 을 읽을 때 사용.
// 경로를 이 파일 기준으로 잡으므로 프로세스 CWD 와 무관하게 동작한다.
export function readData(name, fallback = null) {
  return readJSON(name, fallback);
}

/* ---------- 암호화 키 (최초 1회 생성) ---------- */
function loadKey() {
  const keyPath = file('.enckey');
  try {
    return Buffer.from(fs.readFileSync(keyPath, 'utf8'), 'hex');
  } catch {
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString('hex'));
    return key;
  }
}
const KEY = loadKey();

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}
export function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export const uid = (prefix = 'id') => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/* ---------- 워크플로 ---------- */
export const Workflows = {
  all: () => readJSON('workflows.json', []),
  get: (id) => Workflows.all().find((w) => w.id === id),
  // 부분 업데이트 지원: 넘긴 필드만 갱신, 생략한 필드는 기존 값 유지
  save(wf) {
    const list = Workflows.all();
    const now = new Date().toISOString();
    const id = wf.id || uid('wf');
    const existing = list.find((w) => w.id === id);
    const rec = {
      id,
      name: wf.name ?? existing?.name ?? '이름 없는 워크플로',
      nodes: wf.nodes ?? existing?.nodes ?? [],
      edges: wf.edges ?? existing?.edges ?? [],
      active: wf.active ?? existing?.active ?? false,
      // 누가 만들었나 (specs/007) — 없으면 PC 주인 것
      ...((wf.ownerId ?? existing?.ownerId) ? { ownerId: wf.ownerId ?? existing.ownerId } : {}),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    const next = existing ? list.map((w) => (w.id === id ? rec : w)) : [...list, rec];
    writeJSON('workflows.json', next);
    return rec;
  },
  remove(id) {
    writeJSON('workflows.json', Workflows.all().filter((w) => w.id !== id));
  },
};

/* ---------- 실행 기록 ----------
   전체 상한만 두면 매분 도는 워크플로 하나가 슬롯을 독식해서
   다른 워크플로 기록이 하루도 못 버티고 밀려난다.
   그래서 워크플로별 상한을 함께 둔다. (env 로 조정 가능) */
const EXEC_MAX_TOTAL = Number(process.env.EXEC_MAX_TOTAL) || 200;
const EXEC_MAX_PER_WORKFLOW = Number(process.env.EXEC_MAX_PER_WORKFLOW) || 30;

export const Executions = {
  all: () => readJSON('executions.json', []),
  add(exec) {
    const rec = { id: uid('ex'), at: new Date().toISOString(), ...exec };
    const seen = new Map();
    const kept = [];
    for (const e of [rec, ...Executions.all()]) {   // 최신순으로 훑는다
      const key = e.workflowId || '?';
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > EXEC_MAX_PER_WORKFLOW) continue;      // 워크플로별 상한 초과 → 버림
      kept.push(e);
      if (kept.length >= EXEC_MAX_TOTAL) break;     // 전체 상한
    }
    writeJSON('executions.json', kept);
    return rec;
  },
  forWorkflow: (wfId) => Executions.all().filter((e) => e.workflowId === wfId),
};

/* ---------- 멱등성: 처리완료 마커 ----------
   claim() 이 false 를 주면 이미 처리했거나 처리중 → 실행을 건너뛴다. */
const LOCK_TTL_MS = 5 * 60 * 1000;

export const ProcessedEvents = {
  all: () => readJSON('processed.json', []),
  find: (key) => ProcessedEvents.all().find((e) => e.idempotency_key === key),

  /** @returns {{claimed:boolean, reason?:string}} */
  claim(key, { source = 'unknown', eventType = '' } = {}) {
    const list = ProcessedEvents.all();
    const now = Date.now();
    const rec = list.find((e) => e.idempotency_key === key);

    if (rec) {
      if (rec.status === 'done') return { claimed: false, reason: 'already_done' };
      if (rec.status === 'pending' && new Date(rec.locked_until).getTime() > now) {
        return { claimed: false, reason: 'in_progress' };
      }
    }
    const next = {
      idempotency_key: key,
      source,
      event_type: eventType,
      status: 'pending',
      first_seen_at: rec?.first_seen_at || new Date(now).toISOString(),
      completed_at: null,
      attempts: (rec?.attempts || 0) + 1,
      locked_until: new Date(now + LOCK_TTL_MS).toISOString(),
      result_ref: null,
    };
    writeJSON('processed.json', [...list.filter((e) => e.idempotency_key !== key), next].slice(-2000));
    return { claimed: true };
  },

  complete(key, resultRef = null) {
    const list = ProcessedEvents.all();
    const rec = list.find((e) => e.idempotency_key === key);
    if (!rec) return;
    rec.status = 'done';
    rec.completed_at = new Date().toISOString();
    rec.result_ref = resultRef;
    writeJSON('processed.json', list);
  },

  fail(key) {
    const list = ProcessedEvents.all();
    const rec = list.find((e) => e.idempotency_key === key);
    if (!rec) return;
    rec.status = 'failed';
    rec.locked_until = new Date(0).toISOString(); // 즉시 재시도 가능
    writeJSON('processed.json', list);
  },
};

/* ---------- DLQ: 실패 항목 격리 큐 ---------- */
export const DLQ = {
  all: () => readJSON('dlq.json', []),
  add(entry) {
    const rec = {
      id: uid('dlq'),
      workflow_id: entry.workflowId ?? null,
      workflow_name: entry.workflowName ?? null,
      node_id: entry.nodeId ?? null,
      node_kind: entry.nodeKind ?? null,
      item_key: entry.itemKey ?? null,
      payload: entry.payload ?? null,
      error_code: entry.errorCode ?? 'UNKNOWN',
      error_msg: String(entry.errorMsg ?? '').slice(0, 800),
      attempts: entry.attempts ?? 1,
      failed_at: new Date().toISOString(),
      replay_status: 'pending',
    };
    writeJSON('dlq.json', [rec, ...DLQ.all()].slice(0, 500));
    return rec;
  },
  setStatus(id, replay_status) {
    const list = DLQ.all();
    const rec = list.find((r) => r.id === id);
    if (rec) { rec.replay_status = replay_status; writeJSON('dlq.json', list); }
    return rec;
  },
  remove(id) { writeJSON('dlq.json', DLQ.all().filter((r) => r.id !== id)); },
};

/* ---------- 사람 승인 대기 ----------
   워크플로가 승인 노드에서 멈출 때의 스냅샷(그때까지의 노드 출력 + 노드/엣지)과 결정을 보관한다.
   서버가 재시작돼도 파일에 남으므로, 버튼을 늦게 눌러도 이어서 실행할 수 있다. */
const APPROVALS_MAX = Number(process.env.APPROVALS_MAX) || 500;

export const Approvals = {
  all: () => readJSON('approvals.json', []),
  get: (id) => Approvals.all().find((a) => a.id === id) || null,
  pending: () => Approvals.all().filter((a) => a.status === 'pending'),
  add(rec) {
    const full = { id: uid('ap'), status: 'pending', createdAt: new Date().toISOString(), reminded: false, ...rec };
    // 상한을 넘으면 끝난 것부터 버린다 — 대기 중인 건은 밀려나지 않는다
    const all = [full, ...Approvals.all()];
    const isOpen = (a) => a.status === 'pending' || a.status === 'preparing';
    const open = all.filter(isOpen);
    const closed = all.filter((a) => !isOpen(a)).slice(0, Math.max(0, APPROVALS_MAX - open.length));
    writeJSON('approvals.json', all.filter((a) => isOpen(a) || closed.includes(a)));
    return full;
  },
  update(id, patch) {
    const list = Approvals.all();
    const rec = list.find((a) => a.id === id);
    if (!rec) return null;
    Object.assign(rec, patch);
    writeJSON('approvals.json', list);
    return rec;
  },
};

/* ---------- 사람 (specs/007) — 텔레그램 채팅 하나 = 한 사람, PC 화면 = owner ---------- */
export const People = {
  all: () => readJSON('people.json', []),
  get: (id) => People.all().find((p) => p.id === id) || null,
  byChat: (chatId) => (chatId === undefined || chatId === null ? null : People.all().find((p) => p.chatId === String(chatId)) || null),
  save(p) {
    const list = People.all();
    const id = p.id || (p.chatId ? `p_${p.chatId}` : uid('p'));
    const prev = list.find((x) => x.id === id);
    const rec = {
      id, role: id === 'owner' ? 'owner' : 'member', lang: 'ko', name: '', wake: null, interests: [], chatId: null, onboarding: null,
      ...prev, ...p, id, updatedAt: new Date().toISOString(), createdAt: prev?.createdAt || new Date().toISOString(),
    };
    if (rec.chatId !== null && rec.chatId !== undefined) rec.chatId = String(rec.chatId);
    writeJSON('people.json', prev ? list.map((x) => (x.id === id ? rec : x)) : [...list, rec]);
    return rec;
  },
  /** PC 주인 — 없으면 만든다 */
  owner: () => People.get('owner') || People.save({ id: 'owner', role: 'owner', lang: 'ko', name: '' }),
};

/* ---------- 변경 감지 (changeDetect 노드) — 키별 지난 값의 해시 ---------- */
export const ChangeState = {
  all: () => readJSON('change-state.json', {}),
  get: (key) => ChangeState.all()[key] || null,
  set(key, hash) { const m = ChangeState.all(); m[key] = { hash, at: new Date().toISOString() }; writeJSON('change-state.json', m); },
};

/* ---------- 설정 (화면에서 바꾸는 값 — 비밀값은 여기 두지 않고 Credentials 에 암호화) ---------- */
export const Settings = {
  all: () => readJSON('settings.json', {}),
  get: (section) => Settings.all()[section] || {},
  set(section, patch) {
    const all = Settings.all();
    all[section] = { ...(all[section] || {}), ...patch };
    writeJSON('settings.json', all);
    return all[section];
  },
};

/* ---------- 목표 · 하트비트 (specs/004-goals-heartbeat) ----------
   목표는 사람이 정한다. 하트비트 기록은 다음 하트비트의 "최근 결정" 으로 들어간다. */
const HEARTBEATS_MAX = 200;

export const Goals = {
  all: () => readJSON('goals.json', []),
  get: (id) => Goals.all().find((g) => g.id === id) || null,
  save(g) {
    const list = Goals.all();
    const id = g.id || uid('g');
    const prev = list.find((x) => x.id === id);
    const rec = {
      id,
      text: String(g.text ?? prev?.text ?? '').slice(0, 500),
      workflows: Array.isArray(g.workflows) ? g.workflows.map(String) : (prev?.workflows ?? []),
      inbox: g.inbox ?? prev?.inbox ?? null,
      cadenceMin: Number(g.cadenceMin ?? prev?.cadenceMin ?? 0) || 0,
      requireApproval: !!(g.requireApproval ?? prev?.requireApproval ?? false),
      active: g.active ?? prev?.active ?? true,
      createdAt: prev?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeJSON('goals.json', prev ? list.map((x) => (x.id === id ? rec : x)) : [...list, rec]);
    return rec;
  },
  remove(id) { writeJSON('goals.json', Goals.all().filter((g) => g.id !== id)); },
};

export const Heartbeats = {
  all: () => readJSON('heartbeats.json', []),
  add(rec) {
    const full = { id: uid('hb'), at: new Date().toISOString(), ...rec };
    writeJSON('heartbeats.json', [full, ...Heartbeats.all()].slice(0, HEARTBEATS_MAX));
    return full;
  },
};

/** 받은편지함에서 이미 다룬 파일 (경로·크기·수정시각으로 구분 — 같은 이름으로 새 파일이 오면 다시 본다) */
export const InboxSeen = {
  all: () => readJSON('inbox-seen.json', {}),
  has: (key) => key in InboxSeen.all(),
  mark(key, info) { const m = InboxSeen.all(); m[key] = { at: new Date().toISOString(), ...info }; writeJSON('inbox-seen.json', m); },
};

/** 사람 승인을 기다리는 하트비트 제안 */
export const PendingActions = {
  all: () => readJSON('pending-actions.json', []),
  get: (id) => PendingActions.all().find((p) => p.id === id) || null,
  add(rec) {
    const full = { id: uid('pa'), status: 'pending', createdAt: new Date().toISOString(), ...rec };
    writeJSON('pending-actions.json', [full, ...PendingActions.all()].slice(0, 200));
    return full;
  },
  update(id, patch) {
    const list = PendingActions.all();
    const rec = list.find((p) => p.id === id);
    if (!rec) return null;
    Object.assign(rec, patch);
    writeJSON('pending-actions.json', list);
    return rec;
  },
};

/* ---------- 장기 기억 (검증된 읽기 기억 · specs/001-verified-memory) ----------
   원문 조각(source)과 검증된 사실(fact)만 들어온다. key(정규화 텍스트)가 같으면 다시 넣지 않는다. */
export const Memory = {
  all: () => readJSON('memory.json', []),
  add(entries) {
    const list = Memory.all();
    const keys = new Set(list.map((m) => m.key));
    const added = [];
    for (const e of entries) {
      if (!e?.key || keys.has(e.key)) continue;
      const rec = { id: uid('m'), createdAt: new Date().toISOString(), ...e };
      keys.add(e.key);
      list.push(rec);
      added.push(rec);
    }
    if (added.length) writeJSON('memory.json', list);
    return added;
  },
  reset() { writeJSON('memory.json', []); },
};

/* ---------- 읽기 기억 (socraticRead 가 실수에서 배운 것) ----------
   모델 가중치는 바꿀 수 없으니, 확인된 실수를 모아 다음 읽기의 프롬프트에 넣는다.
   - confusions : OCR 이 잘못 읽고 대조 단계에서 바로잡힌 글자 쌍 ("라→나": 횟수)
   - mistakes   : 검증기에 걸린 인용 실수 종류별 횟수 (paraphrased · wrong_line · fabricated)
   - examples   : 최근 실수 사례 (프롬프트에 그대로 보여 준다) */
const READING_EXAMPLES_MAX = 20;

export const ReadingMemory = {
  get: () => readJSON('reading-memory.json', { confusions: {}, mistakes: {}, examples: [], runs: 0 }),
  record({ confusions = [], mistakes = [] } = {}) {
    const m = ReadingMemory.get();
    for (const c of confusions) {
      const key = `${c.from}→${c.to}`;
      m.confusions[key] = (m.confusions[key] || 0) + 1;
    }
    for (const x of mistakes) {
      m.mistakes[x.kind] = (m.mistakes[x.kind] || 0) + 1;
      m.examples = [{ kind: x.kind, quote: x.quote, line: x.line, at: new Date().toISOString() }, ...m.examples]
        .slice(0, READING_EXAMPLES_MAX);
    }
    m.runs = (m.runs || 0) + 1;
    writeJSON('reading-memory.json', m);
    return m;
  },
  reset() { writeJSON('reading-memory.json', { confusions: {}, mistakes: {}, examples: [], runs: 0 }); },
};

/* ---------- 크리덴셜 (data 는 암호화 저장) ---------- */
export const Credentials = {
  all: () => readJSON('credentials.json', []),
  listMasked: () =>
    Credentials.all().map(({ id, name, type, createdAt }) => ({ id, name, type, createdAt })),
  save(cred) {
    const list = Credentials.all();
    const rec = {
      id: cred.id || uid('cred'),
      name: cred.name || '이름 없음',
      type: cred.type || 'generic',
      data: encrypt(JSON.stringify(cred.data || {})),
      createdAt: new Date().toISOString(),
    };
    writeJSON('credentials.json', [...list.filter((c) => c.id !== rec.id), rec]);
    return { id: rec.id, name: rec.name, type: rec.type };
  },
  reveal(id) {
    const c = Credentials.all().find((x) => x.id === id);
    if (!c) return null;
    return JSON.parse(decrypt(c.data));
  },
  remove(id) {
    writeJSON('credentials.json', Credentials.all().filter((c) => c.id !== id));
  },
};

/* ---------- 검증 댓글 큐 ----------
   업로드 노드가 여기에 항목을 넣으면, 검증 댓글 봇(wf_dc1b041e)이
   공개시각 +3분 ~ +26시간 창에 논문 출처 댓글을 자동 게시한다.
   템플릿은 verified-comment-templates.json (영상 종류별 논문 본문). */
export const VerifiedComments = {
  templates: () => readJSON('verified-comment-templates.json', {}),
  queue: () => readJSON('verified-comments.json', []),
  add({ videoId, at, template, text }) {
    if (!videoId) return { ok: false, error: 'videoId 없음 — 업로드가 실패했을 수 있습니다' };
    const tpl = VerifiedComments.templates();
    const body = text || tpl[template];
    if (!body) {
      return { ok: false, error: `템플릿 '${template}' 없음 (가능: ${Object.keys(tpl).join(', ')})` };
    }
    const list = VerifiedComments.queue();
    if (list.some((i) => i.videoId === videoId)) {
      return { ok: true, skipped: 'already-queued', videoId };
    }
    list.push({ videoId, at: at || new Date().toISOString(), text: body });
    writeJSON('verified-comments.json', list);
    return { ok: true, videoId, template: template || 'inline', queued: list.length };
  },
};

/* ---------- 발행된 글 기록 ----------
   내부 링크(“함께 보면 좋은 글”)를 걸려면 이전 글의 URL 이 있어야 한다.
   기존에는 Blogger 응답의 url 을 어디에도 남기지 않아 링크할 대상이 없었다. */
export const PublishedPosts = {
  all: () => readJSON('published-posts.json', []),
  add({ url, title, keyword, labels, network, postId }) {
    if (!url || !title) return null;
    const list = PublishedPosts.all();
    if (list.some((p) => p.url === url)) return null;           // 재발행 중복 방지
    const rec = {
      postId: postId || null,
      url,
      title,
      keyword: keyword || '',
      labels: Array.isArray(labels) ? labels : [],
      network: network || '',
      at: new Date().toISOString(),
    };
    writeJSON('published-posts.json', [rec, ...list].slice(0, 300));
    return rec;
  },
  /** 같은 키워드/라벨을 공유하는 최근 글 (자기 자신 제외) */
  related({ keyword = '', labels = [], excludeTitle = '', limit = 3 } = {}) {
    const tags = new Set([keyword, ...labels].filter(Boolean));
    const scored = PublishedPosts.all()
      .filter((p) => p.title !== excludeTitle)
      .map((p) => {
        // 같은 태그가 keyword 와 labels 에 중복돼도 한 번만 센다
        const overlap = new Set([p.keyword, ...(p.labels || [])].filter((t) => t && tags.has(t))).size;
        // 주제가 정확히 같은 글을 최우선으로 (라벨 몇 개 겹친 글보다 훨씬 관련성이 높다)
        const exact = p.keyword && p.keyword === keyword ? 10 : 0;
        return { p, score: exact + overlap };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.p.at.localeCompare(a.p.at));
    // 관련 글이 부족하면 최신 글로 채운다 (내부 링크는 없는 것보다 있는 편이 낫다)
    const out = scored.map((x) => x.p);
    if (out.length < limit) {
      for (const p of PublishedPosts.all()) {
        if (out.length >= limit) break;
        if (p.title !== excludeTitle && !out.includes(p)) out.push(p);
      }
    }
    return out.slice(0, limit);
  },
};
