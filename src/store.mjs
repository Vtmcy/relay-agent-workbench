import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, thread_id TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
      prompt TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS active_run ON runs(session_id) WHERE status = 'running';
    CREATE INDEX IF NOT EXISTS session_runs ON runs(session_id, created_at);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
      session_id TEXT NOT NULL REFERENCES sessions(id), kind TEXT NOT NULL, text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_events ON events(session_id, id);
    UPDATE runs SET status = 'interrupted', detail = '服务在任务完成前停止，已保留工作区。', finished_at = unixepoch() * 1000
      WHERE status = 'running';
  `);
  const session = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  const touch = (id) => db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id);

  return {
    session, touch,
    create(title) {
      const id = randomUUID();
      db.prepare('INSERT INTO sessions VALUES (?, ?, NULL, ?)').run(id, title, Date.now());
      return session(id);
    },
    list() {
      return db.prepare(`SELECT id, title, updated_at,
        (SELECT status FROM runs WHERE session_id = sessions.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS status
        FROM sessions ORDER BY updated_at DESC, rowid DESC`).all();
    },
    runs(id) {
      return db.prepare('SELECT * FROM runs WHERE session_id = ? ORDER BY created_at, rowid').all(id);
    },
    events(id, after) {
      return db.prepare('SELECT id, run_id, kind, text FROM events WHERE session_id = ? AND id > ? ORDER BY id LIMIT 200').all(id, after);
    },
    begin(existing, prompt) {
      const run = { id: randomUUID(), session_id: existing.id, prompt, status: 'running', created_at: Date.now() };
      const title = existing.title === '新会话' ? Array.from(prompt.replace(/\s+/g, ' ')).slice(0, 28).join('') : existing.title;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("INSERT INTO runs VALUES (?, ?, ?, 'running', NULL, ?, NULL)").run(run.id, existing.id, prompt, run.created_at);
        db.prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, run.created_at, existing.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return run;
    },
    addEvent(run, kind, text) {
      db.prepare('INSERT INTO events (run_id, session_id, kind, text) VALUES (?, ?, ?, ?)').run(run.id, run.session_id, kind, text);
    },
    setThread(id, threadId) {
      db.prepare('UPDATE sessions SET thread_id = ? WHERE id = ?').run(threadId, id);
    },
    finish(run, status, detail = null) {
      db.prepare("UPDATE runs SET status = ?, detail = ?, finished_at = ? WHERE id = ? AND status = 'running'")
        .run(status, detail, Date.now(), run.id);
      touch(run.session_id);
    },
  };
}
