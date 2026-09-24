// ============================================================
// SQLite 연결 — 운영 기록(승인 대기 · 멱등 키 · DLQ · 실행 기록)의 저장소.
//
//   왜 SQLite 인가: 이 네 가지는 "동시에 두 번 오면 한 번만", "죽었다 살아나도 그대로" 가 약속이어야 하는 기록이다.
//   JSON 파일로는 그 약속을 코드가 조심해서 지키는 것이고, SQLite 로는 유니크 제약과 트랜잭션이 지킨다.
//   Node 에 내장된 node:sqlite 를 쓰므로 네이티브 의존성이 없다 (Node ≥ 22.13).
//
//   설정(워크플로 · 크리덴셜 · 사람 · 목표 …)은 작고 사람이 열어 보는 값이라 JSON 파일에 그대로 둔다.
//   기존 JSON 기록(approvals.json 등)은 처음 열 때 한 번 옮기고 파일 이름을 바꿔 둔다.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DB_FILE = 'conduit.db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS approvals (
  id                   TEXT PRIMARY KEY,
  status               TEXT NOT NULL CHECK (status IN ('preparing','pending','approved','rejected','expired','failed')),
  channel              TEXT NOT NULL,
  chat_id              TEXT,
  title                TEXT,
  text                 TEXT,
  item                 TEXT,            -- JSON
  node_id              TEXT,
  workflow_id          TEXT,
  workflow_name        TEXT,
  trigger              TEXT,
  flow                 TEXT,            -- JSON { nodes, edges } · 재개가 끝나면 NULL
  snapshot             TEXT,            -- JSON { nodeId: outputs } · 재개가 끝나면 NULL
  created_at           TEXT NOT NULL,
  remind_at            TEXT,
  expire_at            TEXT,
  reminded             INTEGER NOT NULL DEFAULT 0,
  message_id           INTEGER,
  error                TEXT,
  decision             TEXT CHECK (decision IN ('approve','reject','expired') OR decision IS NULL),
  edited_text          TEXT,
  decided_by           TEXT,
  decided_at           TEXT,
  resume_status        TEXT CHECK (resume_status IN ('resuming','done','error') OR resume_status IS NULL),
  resume_error         TEXT,
  resume_started_at    TEXT,
  resume_ended_at      TEXT,
  resumed_execution_id TEXT
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status, created_at DESC);

CREATE TABLE IF NOT EXISTS processed_events (
  idempotency_key TEXT PRIMARY KEY,   -- "같은 요청은 한 번만" 을 유니크 제약이 지킨다
  source          TEXT,
  event_type      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  first_seen_at   TEXT NOT NULL,
  completed_at    TEXT,
  attempts        INTEGER NOT NULL DEFAULT 1,
  locked_until    TEXT,
  result_ref      TEXT
);

CREATE TABLE IF NOT EXISTS dlq (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT,
  workflow_name TEXT,
  node_id       TEXT,
  node_kind     TEXT,
  item_key      TEXT,
  payload       TEXT,               -- JSON
  error_code    TEXT NOT NULL,
  error_msg     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 1,
  failed_at     TEXT NOT NULL,
  replay_status TEXT NOT NULL CHECK (replay_status IN ('pending','replayed','dropped'))
);
CREATE INDEX IF NOT EXISTS dlq_failed_at ON dlq (failed_at DESC);

CREATE TABLE IF NOT EXISTS executions (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT,
  workflow_name TEXT,
  trigger       TEXT,
  status        TEXT NOT NULL,
  at            TEXT NOT NULL,
  logs          TEXT,               -- JSON
  statuses      TEXT                -- JSON
);
CREATE INDEX IF NOT EXISTS executions_wf ON executions (workflow_id, at DESC);
`;

/** 데이터 폴더의 conduit.db 를 연다(없으면 만든다). 스키마는 멱등하게 만들고, 기존 JSON 기록이 있으면 옮긴다. */
export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, DB_FILE));
  // WAL: 읽기가 쓰기를 막지 않는다. synchronous=NORMAL: 프로세스가 죽어도 커밋된 트랜잭션은 남는다 (정전은 예외).
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** BEGIN IMMEDIATE … COMMIT. 안에서 던지면 ROLLBACK 하고 다시 던진다. */
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** node:sqlite 는 undefined · boolean · 객체를 바인딩하지 못한다 — NULL · 0/1 · JSON 문자열로 바꾼다 */
export const bind = {
  text: (v) => (v === undefined || v === null ? null : String(v)),
  int: (v) => (v === undefined || v === null ? null : Number(v)),
  bool: (v) => (v ? 1 : 0),
  json: (v) => (v === undefined || v === null ? null : JSON.stringify(v)),
};
export const parseJson = (s, fallback = null) => {
  if (s === null || s === undefined) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

/**
 * 기존 JSON 파일 기록을 SQLite 로 옮긴다. 파일마다 한 번만: 옮긴 뒤 *.migrated-<시각> 으로 이름을 바꾼다.
 * @param {DatabaseSync} db
 * @param {string} dataDir
 * @param {Record<string, (rows: any[]) => void>} importers  파일 이름 → 행 배열을 넣는 함수
 */
export function migrateLegacyJson(db, dataDir, importers) {
  const moved = [];
  for (const [name, importRows] of Object.entries(importers)) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    let rows;
    try { rows = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      console.warn(`[db] ${name} 을 읽지 못해 옮기지 않습니다: ${e.message}`);
      continue;
    }
    if (!Array.isArray(rows)) continue;
    transaction(db, () => importRows(rows));
    const backup = `${file}.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(file, backup);
    moved.push(`${name}(${rows.length}건)`);
  }
  if (moved.length) console.log(`[db] JSON 기록을 SQLite 로 옮김: ${moved.join(' · ')}`);
  return moved;
}
