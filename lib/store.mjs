import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Fault, need } from "./errors.mjs";
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export const now = () => new Date().toISOString();
export function atomic(path, data) {
  const temp = path + "." + randomUUID() + ".tmp";
  writeFileSync(temp, data, { mode: 0o600 });
  renameSync(temp, path);
}
export class Store {
  constructor(root) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.marker = join(this.root, "ledger.initialized");
    const path = join(this.root, "ledger.sqlite");
    need(!(existsSync(this.marker) && !existsSync(path)), "LEDGER_MISSING");
    try {
      this.db = new DatabaseSync(path);
      this.db.exec(
        "PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON; PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;",
      );
      need(
        this.db.prepare("PRAGMA integrity_check").get().integrity_check ===
          "ok",
        "LEDGER_CORRUPT",
      );
      const v = this.db.prepare("PRAGMA user_version").get().user_version;
      need(v <= 1, "SCHEMA_TOO_NEW");
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS control(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,status TEXT NOT NULL,pid INTEGER NOT NULL,started TEXT NOT NULL,finished TEXT,requests INTEGER DEFAULT 0,candidates INTEGER DEFAULT 0,asr_seconds REAL DEFAULT 0,error TEXT);
        CREATE TABLE IF NOT EXISTS cache(key TEXT PRIMARY KEY,created INTEGER NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS readings(id TEXT PRIMARY KEY,bvid TEXT NOT NULL,page INTEGER NOT NULL,content_hash TEXT NOT NULL,created TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(bvid,page,content_hash));
        CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,reading_id TEXT NOT NULL REFERENCES readings(id),created TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,created TEXT NOT NULL,body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,changed TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,revision));
        PRAGMA user_version=1;`);
      if (!existsSync(this.marker)) atomic(this.marker, "schema=1\n");
      if (process.platform !== "win32") chmodSync(path, 0o600);
    } catch (e) {
      this.db?.close();
      throw e instanceof Fault ? e : new Fault("LEDGER_UNAVAILABLE");
    }
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  getControl(key) {
    const r = this.db.prepare("SELECT value FROM control WHERE key=?").get(key);
    return r ? JSON.parse(r.value) : null;
  }
  setControl(key, value) {
    this.db
      .prepare("INSERT OR REPLACE INTO control VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  pause(reason) {
    this.setControl("pause", { reason, at: now() });
  }
  // Called only by the trusted local CLI. No model tool can clear pause.
  resume() {
    this.setControl("pause", null);
  }
  start() {
    return this.tx(() => {
      need(!this.getControl("pause"), "PERSISTENT_PAUSE");
      for (const task of this.db
        .prepare("SELECT * FROM tasks WHERE status='running'")
        .all()) {
        let alive = true;
        try {
          process.kill(task.pid, 0);
        } catch (e) {
          alive = e.code !== "ESRCH";
        }
        need(!alive, "TASK_BUSY");
        this.db
          .prepare(
            "UPDATE tasks SET status='interrupted',finished=?,error='PROCESS_EXIT' WHERE id=?",
          )
          .run(now(), task.id);
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO tasks(id,status,pid,started) VALUES(?,'running',?,?)",
        )
        .run(id, process.pid, now());
      return id;
    });
  }
  usage(id, req, candidates, asr) {
    this.db
      .prepare(
        "UPDATE tasks SET requests=?,candidates=?,asr_seconds=? WHERE id=?",
      )
      .run(req, candidates, asr, id);
  }
  finish(id, status, error = null) {
    this.db
      .prepare("UPDATE tasks SET status=?,finished=?,error=? WHERE id=?")
      .run(status, now(), error, id);
  }
  cancel(id) {
    need(
      !!this.db
        .prepare("SELECT id FROM tasks WHERE id=? AND status='running'")
        .get(id),
      "TASK_NOT_RUNNING",
    );
    this.setControl("cancel:" + id, true);
  }
  cacheGet(key, ttl) {
    const r = this.db.prepare("SELECT * FROM cache WHERE key=?").get(key);
    return r && Date.now() - r.created < ttl ? JSON.parse(r.body) : null;
  }
  cachePut(key, body) {
    this.db
      .prepare("INSERT OR REPLACE INTO cache VALUES(?,?,?)")
      .run(key, Date.now(), JSON.stringify(body));
  }
  saveReading(body) {
    const hash = digest({
      route: body.route,
      cid: body.cid,
      segments: body.segments,
      coverage: body.coverage,
    });
    const old = this.db
      .prepare(
        "SELECT id FROM readings WHERE bvid=? AND page=? AND content_hash=?",
      )
      .get(body.bvid, body.page, hash);
    if (old) return { ...body, id: old.id, deduplicated: true };
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO readings VALUES(?,?,?,?,?,?)")
      .run(id, body.bvid, body.page, hash, now(), JSON.stringify(body));
    return { ...body, id, deduplicated: false };
  }
  reading(id) {
    const r = this.db.prepare("SELECT * FROM readings WHERE id=?").get(id);
    need(r, "READING_NOT_FOUND");
    return { ...JSON.parse(r.body), id: r.id };
  }
  // Attempts sit outside the content hash, so the reading keeps its ID.
  setReadingAttempts(id, attempts) {
    this.db
      .prepare(
        "UPDATE readings SET body=json_set(body,'$.attempts',json(?)) WHERE id=?",
      )
      .run(JSON.stringify(attempts), id);
  }
  localTranscript(reading) {
    for (const row of this.db
      .prepare(
        "SELECT id,body FROM readings WHERE bvid=? AND page=? ORDER BY created DESC,rowid DESC",
      )
      .iterate(reading.bvid, reading.page)) {
      const candidate = JSON.parse(row.body);
      if (
        candidate.route === "A3" &&
        String(candidate.cid) === String(reading.cid) &&
        candidate.duration === reading.duration &&
        Array.isArray(candidate.segments) &&
        candidate.segments.length > 0
      )
        return { ...candidate, id: row.id };
    }
    return null;
  }
  readings() {
    return this.db
      .prepare(
        "SELECT id,bvid,page,created FROM readings ORDER BY created DESC LIMIT 100",
      )
      .all();
  }
  hasTextReading(bvid, page = 1) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM readings WHERE bvid=? AND page=? AND json_array_length(body,'$.segments')>0 LIMIT 1",
      )
      .get(bvid, page);
  }
  note(readingId, body, created = now()) {
    this.reading(readingId);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO notes VALUES(?,?,?,?)")
      .run(id, readingId, created, JSON.stringify(body));
    return id;
  }
  inbox() {
    return this.db
      .prepare("SELECT * FROM notes ORDER BY created DESC,id DESC")
      .all()
      .map((r) => ({ ...r, body: JSON.parse(r.body) }));
  }
  memory(action, id, body) {
    return this.tx(() => {
      if (action === "list")
        return this.db
          .prepare("SELECT * FROM memory ORDER BY created DESC LIMIT 100")
          .all()
          .map((r) => ({ ...r, body: JSON.parse(r.body) }));
      need(/^[a-zA-Z0-9_-]{1,80}$/.test(id), "INVALID_MEMORY_ID");
      if (action === "delete") {
        this.db.prepare("DELETE FROM revisions WHERE id=?").run(id);
        this.db.prepare("DELETE FROM memory WHERE id=?").run(id);
        return { id, deleted: true };
      }
      const old = this.db.prepare("SELECT * FROM memory WHERE id=?").get(id);
      const revision = (old?.revision || 0) + 1;
      this.db
        .prepare("INSERT OR REPLACE INTO memory VALUES(?,?,?,?)")
        .run(id, revision, now(), JSON.stringify(body));
      this.db
        .prepare("INSERT INTO revisions VALUES(?,?,?,?)")
        .run(id, revision, now(), JSON.stringify(body));
      return { id, revision };
    });
  }
  status() {
    return {
      pause: this.getControl("pause"),
      tasks: this.db
        .prepare("SELECT * FROM tasks ORDER BY started DESC LIMIT 15")
        .all(),
      readings: this.readings(),
      scheduled: false,
      platformWriteTools: [],
    };
  }
  close() {
    this.db.close();
  }
}
