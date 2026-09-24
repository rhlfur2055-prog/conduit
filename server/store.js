// ============================================================
// 저장소 — 설정은 JSON 파일(server/data/*.json), 운영 기록은 SQLite(server/data/conduit.db) + 크리덴셜 AES-256-GCM 암호화
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, transaction, bind, parseJson, migrateLegacyJson } from './db.js';

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

/* ============================================================
   운영 기록 — SQLite (server/db.js)
   실행 기록 · 멱등 키 · DLQ · 승인 대기는 "두 번 와도 한 번", "죽어도 그대로" 가 약속이라
   유니크 제약과 트랜잭션이 있는 곳에 둔다. API 모양은 JSON 시절과 같다.
   ============================================================ */
export const db = openDb(DATA_DIR);
export function closeDb() { try { db.close(); } catch { /* 이미 닫힘 */ } }

/* ---------- 실행 기록 ----------
   전체 상한만 두면 매분 도는 워크플로 하나가 슬롯을 독식해서
   다른 워크플로 기록이 하루도 못 버티고 밀려난다.
   그래서 워크플로별 상한을 함께 둔다. (env 로 조정 가능) */
const EXEC_MAX_TOTAL = Number(process.env.EXEC_MAX_TOTAL) || 200;
const EXEC_MAX_PER_WORKFLOW = Number(process.env.EXEC_MAX_PER_WORKFLOW) || 30;

const execRow = (r) => r && ({
  id: r.id, at: r.at, workflowId: r.workflow_id, workflowName: r.workflow_name, trigger: r.trigger, status: r.status,
  logs: parseJson(r.logs, []), statuses: parseJson(r.statuses, {}),
});
const execInsert = (rec) => db.prepare(
  `INSERT OR REPLACE INTO executions (id, workflow_id, workflow_name, trigger, status, at, logs, statuses) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(rec.id, bind.text(rec.workflowId), bind.text(rec.workflowName), bind.text(rec.trigger), bind.text(rec.status ?? 'unknown'), rec.at, bind.json(rec.logs ?? []), bind.json(rec.statuses ?? {}));

export const Executions = {
  all: () => db.prepare(`SELECT * FROM executions ORDER BY at DESC, rowid DESC`).all().map(execRow),
  add(exec) {
    const rec = { id: uid('ex'), at: new Date().toISOString(), ...exec };
    transaction(db, () => {
      execInsert(rec);
      // 워크플로별 상한 → 전체 상한. 최신순으로 번호를 매겨 넘치는 것만 지운다.
      db.prepare(`DELETE FROM executions WHERE id IN (
        SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY COALESCE(workflow_id, '?') ORDER BY at DESC, rowid DESC) AS rn FROM executions) WHERE rn > ?)`).run(EXEC_MAX_PER_WORKFLOW);
      db.prepare(`DELETE FROM executions WHERE id IN (
        SELECT id FROM (SELECT id, row_number() OVER (ORDER BY at DESC, rowid DESC) AS rn FROM executions) WHERE rn > ?)`).run(EXEC_MAX_TOTAL);
    });
    return rec;
  },
  forWorkflow: (wfId) => db.prepare(`SELECT * FROM executions WHERE workflow_id = ? ORDER BY at DESC, rowid DESC`).all(wfId).map(execRow),
};

/* ---------- 멱등성: 처리완료 마커 ----------
   claim() 이 false 를 주면 이미 처리했거나 처리중 → 실행을 건너뛴다.
   "누가 먼저 잡았나" 는 유니크 키에 대한 UPSERT 한 문장이 정한다 — 읽고 나서 쓰는 사이가 없다. */
const LOCK_TTL_MS = 5 * 60 * 1000;
const PROCESSED_MAX = 2000;

export const ProcessedEvents = {
  all: () => db.prepare(`SELECT * FROM processed_events ORDER BY first_seen_at ASC, rowid ASC`).all(),
  find: (key) => db.prepare(`SELECT * FROM processed_events WHERE idempotency_key = ?`).get(key) ?? undefined,

  /** @returns {{claimed:boolean, reason?:string}} */
  claim(key, { source = 'unknown', eventType = '' } = {}) {
    const now = new Date();
    const nowISO = now.toISOString();
    const lockedUntil = new Date(now.getTime() + LOCK_TTL_MS).toISOString();
    return transaction(db, () => {
      // 새 키면 INSERT. 있는 키면: done 이 아니고, (pending 이 아니거나 잠금이 풀렸을 때만) 다시 잡는다.
      const r = db.prepare(`
        INSERT INTO processed_events (idempotency_key, source, event_type, status, first_seen_at, completed_at, attempts, locked_until, result_ref)
        VALUES (?, ?, ?, 'pending', ?, NULL, 1, ?, NULL)
        ON CONFLICT (idempotency_key) DO UPDATE SET
          status = 'pending', attempts = attempts + 1, locked_until = excluded.locked_until,
          source = excluded.source, event_type = excluded.event_type, completed_at = NULL
        WHERE processed_events.status != 'done'
          AND (processed_events.status != 'pending' OR processed_events.locked_until <= ?)`,
      ).run(key, source, eventType, nowISO, lockedUntil, nowISO);
      if (r.changes === 1) {
        db.prepare(`DELETE FROM processed_events WHERE rowid NOT IN (SELECT rowid FROM processed_events ORDER BY first_seen_at DESC, rowid DESC LIMIT ?)`).run(PROCESSED_MAX);
        return { claimed: true };
      }
      const rec = ProcessedEvents.find(key);
      return { claimed: false, reason: rec?.status === 'done' ? 'already_done' : 'in_progress' };
    });
  },

  complete(key, resultRef = null) {
    db.prepare(`UPDATE processed_events SET status = 'done', completed_at = ?, result_ref = ? WHERE idempotency_key = ?`)
      .run(new Date().toISOString(), bind.text(resultRef), key);
  },

  fail(key) {
    // 즉시 재시도 가능
    db.prepare(`UPDATE processed_events SET status = 'failed', locked_until = ? WHERE idempotency_key = ?`).run(new Date(0).toISOString(), key);
  },
};

/* ---------- DLQ: 실패 항목 격리 큐 ---------- */
const DLQ_MAX = 500;
const dlqRow = (r) => r && ({ ...r, payload: parseJson(r.payload, null) });

export const DLQ = {
  all: () => db.prepare(`SELECT * FROM dlq ORDER BY failed_at DESC, rowid DESC`).all().map(dlqRow),
  add(entry) {
    const rec = {
      id: uid('dlq'),
      workflow_id: entry.workflowId ?? null,
      workflow_name: entry.workflowName ?? null,
      node_id: entry.nodeId ?? null,
      node_kind: entry.nodeKind ?? null,
      item_key: entry.itemKey ?? null,
      payload: entry.payload ?? null,
      error_code: String(entry.errorCode ?? 'UNKNOWN'),
      error_msg: String(entry.errorMsg ?? '').slice(0, 800),
      attempts: entry.attempts ?? 1,
      failed_at: new Date().toISOString(),
      replay_status: 'pending',
    };
    transaction(db, () => {
      db.prepare(`INSERT INTO dlq (id, workflow_id, workflow_name, node_id, node_kind, item_key, payload, error_code, error_msg, attempts, failed_at, replay_status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rec.id, bind.text(rec.workflow_id), bind.text(rec.workflow_name), bind.text(rec.node_id), bind.text(rec.node_kind), bind.text(rec.item_key),
          bind.json(rec.payload), rec.error_code, rec.error_msg, bind.int(rec.attempts), rec.failed_at, rec.replay_status);
      db.prepare(`DELETE FROM dlq WHERE rowid NOT IN (SELECT rowid FROM dlq ORDER BY failed_at DESC, rowid DESC LIMIT ?)`).run(DLQ_MAX);
    });
    return rec;
  },
  setStatus(id, replay_status) {
    db.prepare(`UPDATE dlq SET replay_status = ? WHERE id = ?`).run(replay_status, id);
    return dlqRow(db.prepare(`SELECT * FROM dlq WHERE id = ?`).get(id)) ?? undefined;
  },
  remove(id) { db.prepare(`DELETE FROM dlq WHERE id = ?`).run(id); },
};

/* ---------- 사람 승인 대기 ----------
   워크플로가 승인 노드에서 멈출 때의 스냅샷(그때까지의 노드 출력 + 노드/엣지)과 결정을 보관한다.
   서버가 재시작돼도 남으므로, 버튼을 늦게 눌러도 이어서 실행할 수 있다.
   결정은 claimDecision() 한 문장(UPDATE … WHERE status='pending')이 정한다 — 두 번 눌러도, 두 프로세스가 눌러도 한 번. */
const APPROVALS_MAX = Number(process.env.APPROVALS_MAX) || 500;

// 기록 필드(camelCase) ↔ 열(snake_case). 여기 없는 필드로 update() 하면 오류 — 조용히 버려지는 것보다 낫다.
const AP_COLS = {
  id: ['id', 'text'], status: ['status', 'text'], channel: ['channel', 'text'], chatId: ['chat_id', 'text'],
  title: ['title', 'text'], text: ['text', 'text'], item: ['item', 'json'],
  nodeId: ['node_id', 'text'], workflowId: ['workflow_id', 'text'], workflowName: ['workflow_name', 'text'], trigger: ['trigger', 'text'],
  flow: ['flow', 'json'], snapshot: ['snapshot', 'json'],
  createdAt: ['created_at', 'text'], remindAt: ['remind_at', 'text'], expireAt: ['expire_at', 'text'], reminded: ['reminded', 'bool'],
  messageId: ['message_id', 'int'], error: ['error', 'text'],
  decision: ['decision', 'text'], editedText: ['edited_text', 'text'], by: ['decided_by', 'text'], decidedAt: ['decided_at', 'text'],
  resumeStatus: ['resume_status', 'text'], resumeError: ['resume_error', 'text'],
  resumeStartedAt: ['resume_started_at', 'text'], resumeEndedAt: ['resume_ended_at', 'text'], resumedExecutionId: ['resumed_execution_id', 'text'],
};
const AP_FIELDS = Object.keys(AP_COLS);
const apRow = (r) => {
  if (!r) return null;
  const out = {};
  for (const [field, [col, kind]] of Object.entries(AP_COLS)) {
    const v = r[col];
    out[field] = kind === 'json' ? (v == null ? undefined : parseJson(v, undefined)) : kind === 'bool' ? !!v : v ?? null;   // JSON 열이 NULL 이면 undefined (버린 flow/snapshot)
  }
  return out;
};
const apBind = (field, v) => {
  const [, kind] = AP_COLS[field];
  return kind === 'json' ? bind.json(v) : kind === 'bool' ? bind.bool(v) : kind === 'int' ? bind.int(v) : bind.text(v);
};
const apInsert = (rec) => db.prepare(
  `INSERT INTO approvals (${AP_FIELDS.map((f) => AP_COLS[f][0]).join(', ')}) VALUES (${AP_FIELDS.map(() => '?').join(', ')})`,
).run(...AP_FIELDS.map((f) => apBind(f, rec[f])));

export const Approvals = {
  all: () => db.prepare(`SELECT * FROM approvals ORDER BY created_at DESC, rowid DESC`).all().map(apRow),
  get: (id) => apRow(db.prepare(`SELECT * FROM approvals WHERE id = ?`).get(id)),
  pending: () => db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC, rowid DESC`).all().map(apRow),
  add(rec) {
    const full = { id: uid('ap'), status: 'pending', createdAt: new Date().toISOString(), reminded: false, ...rec };
    for (const k of Object.keys(full)) if (!AP_COLS[k]) throw new Error(`approvals: 모르는 필드 ${k}`);
    transaction(db, () => {
      apInsert(full);
      // 상한을 넘으면 끝난 것부터 버린다 — 대기 중인 건은 밀려나지 않는다
      const open = db.prepare(`SELECT COUNT(*) AS n FROM approvals WHERE status IN ('pending', 'preparing')`).get().n;
      db.prepare(`DELETE FROM approvals WHERE status NOT IN ('pending', 'preparing') AND id NOT IN (
        SELECT id FROM approvals WHERE status NOT IN ('pending', 'preparing') ORDER BY created_at DESC, rowid DESC LIMIT ?)`).run(Math.max(0, APPROVALS_MAX - open));
    });
    return Approvals.get(full.id);
  },
  update(id, patch) {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    for (const k of keys) if (!AP_COLS[k]) throw new Error(`approvals: 모르는 필드 ${k}`);
    if (keys.length) {
      const r = db.prepare(`UPDATE approvals SET ${keys.map((k) => `${AP_COLS[k][0]} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => apBind(k, patch[k])), id);
      if (r.changes === 0) return null;
    }
    return Approvals.get(id);
  },
  /**
   * 결정을 원자적으로 잡는다: pending 인 동안만 한 번 성공한다. 같은 문장에서 resume_status 를 'resuming' 으로 바꿔
   * "결정됨" 과 "재개 시작" 사이에 서버가 죽어도 기동 정리가 잡아낸다.
   * @returns {boolean} 이 호출이 결정을 잡았는지
   */
  claimDecision(id, { status, decision, editedText, by, decidedAt }) {
    const r = db.prepare(`UPDATE approvals
      SET status = ?, decision = ?, edited_text = ?, decided_by = ?, decided_at = ?, resume_status = 'resuming', resume_started_at = ?, resume_error = NULL
      WHERE id = ? AND status = 'pending'`)
      .run(status, decision, bind.text(editedText), bind.text(by), decidedAt, decidedAt, id);
    return r.changes === 1;
  },
  /** 실패한 재개를 다시 잡는다: 결정된 건이고 지금 재개 중이 아닐 때만 한 번 성공한다. */
  claimResume(id) {
    const r = db.prepare(`UPDATE approvals SET resume_status = 'resuming', resume_started_at = ?, resume_error = NULL
      WHERE id = ? AND status IN ('approved', 'rejected', 'expired') AND (resume_status IS NULL OR resume_status = 'error')`)
      .run(new Date().toISOString(), id);
    return r.changes === 1;
  },
  /** 테스트용 — 전부 지운다 */
  clearAll() { db.exec(`DELETE FROM approvals`); },
};

/* ---------- 기존 JSON 기록 → SQLite (처음 한 번) ---------- */
migrateLegacyJson(db, DATA_DIR, {
  'executions.json': (rows) => rows.forEach((r) => r?.id && execInsert(r)),
  'processed.json': (rows) => rows.forEach((r) => r?.idempotency_key && db.prepare(
    `INSERT OR REPLACE INTO processed_events (idempotency_key, source, event_type, status, first_seen_at, completed_at, attempts, locked_until, result_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.idempotency_key, bind.text(r.source), bind.text(r.event_type), ['pending', 'done', 'failed'].includes(r.status) ? r.status : 'failed',
    r.first_seen_at || new Date(0).toISOString(), bind.text(r.completed_at), bind.int(r.attempts ?? 1), bind.text(r.locked_until), bind.text(r.result_ref))),
  'dlq.json': (rows) => rows.forEach((r) => r?.id && db.prepare(
    `INSERT OR REPLACE INTO dlq (id, workflow_id, workflow_name, node_id, node_kind, item_key, payload, error_code, error_msg, attempts, failed_at, replay_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(r.id, bind.text(r.workflow_id), bind.text(r.workflow_name), bind.text(r.node_id), bind.text(r.node_kind), bind.text(r.item_key), bind.json(r.payload),
    String(r.error_code ?? 'UNKNOWN'), String(r.error_msg ?? ''), bind.int(r.attempts ?? 1), r.failed_at || new Date(0).toISOString(),
    ['pending', 'replayed', 'dropped'].includes(r.replay_status) ? r.replay_status : 'pending')),
  'approvals.json': (rows) => rows.forEach((r) => {
    if (!r?.id) return;
    const rec = {};
    for (const f of AP_FIELDS) rec[f] = r[f] ?? (f === 'reminded' ? false : null);
    if (!['preparing', 'pending', 'approved', 'rejected', 'expired', 'failed'].includes(rec.status)) rec.status = 'failed';
    if (!rec.channel) rec.channel = 'telegram';
    if (!rec.createdAt) rec.createdAt = new Date(0).toISOString();
    db.prepare(`DELETE FROM approvals WHERE id = ?`).run(rec.id);
    apInsert(rec);
  }),
});

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
