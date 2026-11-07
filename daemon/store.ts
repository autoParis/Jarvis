import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Item = {
  id: number; source: string; external_id: string; kind: string; dispatch_id: string | null;
  subject: string; body: string; options: string | null; status: string; answer: string | null;
  created_at: string; updated_at?: string | null; pushes: number; pushed_at: string | null;
  /** JSON with source-specific details (for Gmail: sender, thread, headers to reply to, the drafted reply). */
  meta: string | null;
  /** 'jarvis' when the brain closed this ask by steering the worker on its own. Empty means the owner's answer. */
  answered_by?: string | null;
};

export type Approval = {
  id: number; action: string; args: string; say: string; status: string; after_turn: number;
  decided_by: string | null; owner_text: string | null; result: string | null; created_at: string; decided_at?: string | null;
  /** JSON { approves, restsOn }: the card's If you approve and It rests on lines, from the proposer. Null on older rows. */
  card?: string | null;
};

/** One thing the owner asked Jarvis for: a worker it started for him. Shown in the Requests sidebar (requests.ts). */
export type Request = {
  id: number; dispatch_id: string; approval_id: number | null; action: string; title: string;
  /** the owner's message that led to the proposal, or the side chat's first message. */
  words: string | null;
  worktree: string | null; session: string | null; pr: string | null; pr_url: string | null;
  status: string; status_at: string; hidden_at: string | null; removed_at: string | null; created_at: string;
};

/** A timed note for the owner (reminders.ts). Times are UTC 'YYYY-MM-DD HH:MM:SS'. `told_at` is the last time the check told the brain. */
export type Reminder = {
  id: number; text: string; due_at: string; created_at: string; status: 'open' | 'fired' | 'done';
  fired_at: string | null; told_at: string | null; done_at: string | null;
};

/** One thought on the Today list (today.ts). `words` is what the owner said and no route changes it. `questions`, `assumptions` and `story` are JSON. */
export type TodayRow = {
  id: number; words: string; title: string | null; kind: string | null; go: number; status: string; status_at: string;
  reading: string | null; questions: string | null; assumptions: string | null; reason: string | null;
  result: string | null; not_proven: string | null; link: string | null; link_label: string | null; note: string | null;
  repo: string | null; spec: string | null; story: string | null; phase: string | null; brief: string | null; draft_report: string | null;
  dispatch: string | null; worktree: string | null; line: string | null;
  issue_url: string | null; issue_state: string | null;
  owed: string | null; told_at: string | null; tries: number;
  created_at: string; released_at: string | null;
};

/**
 * A support reply the owner approved, waiting for its fix to reach production (replies.ts). `text` never changes.
 * `tell` is the sentence still owed to the owner. `problem` is why the last check could not read the state.
 */
export type SupportReply = {
  id: number; reference: string; dealership: string; dealership_id: string; text: string; repo: string; pr: number;
  status: 'waiting' | 'held' | 'sending' | 'sent' | 'failed' | 'unknown' | 'dropped';
  hold_kind: string | null; problem: string | null; note: string | null; outcome: string | null; tell: string | null;
  release_pr: number | null; live_sha: string | null; manual_ok: number;
  created_at: string; status_at: string; attempted_at: string | null; finished_at: string | null;
};

/** A message from the owner the brain has not answered yet. */
export type OwnerTurn = { id: number; text: string; created_at: string };

/** A background Claude Code session jarvisd started (native.ts owns the meaning of each column). Times are ISO strings. */
export type NativeWorkerRow = {
  id: string; session_id: string | null; name: string; cwd: string; approval_id: number | null;
  state: string; waiting_for: string | null; report: string | null; report_at: string | null; outcome: string | null;
  transcript: string | null; created_at: string; updated_at: string;
  /** 'background' (claude --bg) or 'interactive' (a detached pseudo-terminal session, which has the Artifact tool). */
  kind: string; /** The interactive session's process group, for stopping it. */ pgid: number | null;
  /** Interactive sessions, added 2026-11-07: the folder the start ran in (`cwd` becomes the session's real folder, a worktree
   * when it took one), the flags a resume replays, how often it was resumed, and the named pipe jarvisd types into. */
  repo: string | null; model: string | null; permission_mode: string | null;
  resumes: number; last_resume_at: string | null; in_fifo: string | null;
};

/** The native_workers columns a caller may leave out: they default to a background session with nothing to replay. */
type NativeOptional = 'kind' | 'pgid' | 'repo' | 'model' | 'permission_mode' | 'resumes' | 'last_resume_at' | 'in_fifo';

export function openStore(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL, dispatch_id TEXT, subject TEXT, body TEXT, options TEXT,
      status TEXT NOT NULL DEFAULT 'new', answer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, session_id TEXT,
      input_tokens INTEGER, cache_read INTEGER, cache_write INTEGER, output_tokens INTEGER,
      latency_ms INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY, action TEXT NOT NULL, args TEXT NOT NULL, say TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', after_turn INTEGER NOT NULL,
      decided_by TEXT, owner_text TEXT, result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), decided_at TEXT
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY, dispatch_id TEXT NOT NULL UNIQUE, approval_id INTEGER, action TEXT NOT NULL,
      title TEXT NOT NULL, words TEXT, worktree TEXT, session TEXT, pr TEXT, pr_url TEXT,
      status TEXT NOT NULL DEFAULT 'working', status_at TEXT NOT NULL DEFAULT (datetime('now')),
      hidden_at TEXT, removed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Pushes held for quiet hours (push.ts). sent_at is set before sending, so a crash never sends one twice.
    CREATE TABLE IF NOT EXISTS held_pushes (
      id INTEGER PRIMARY KEY, tag TEXT NOT NULL, message TEXT NOT NULL, item TEXT, send_at TEXT NOT NULL,
      held_at TEXT NOT NULL DEFAULT (datetime('now')), sent_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS held_pushes_waiting ON held_pushes(tag) WHERE sent_at IS NULL;
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY, text TEXT NOT NULL, due_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'fired', 'done')),
      fired_at TEXT, told_at TEXT, done_at TEXT
    );
    CREATE TABLE IF NOT EXISTS today_items (
      id INTEGER PRIMARY KEY, words TEXT NOT NULL, title TEXT, kind TEXT CHECK (kind IN ('story', 'task', 'talk')), go INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'waiting', 'queued', 'working', 'ready', 'released', 'dropped', 'moved')),
      status_at TEXT NOT NULL DEFAULT (datetime('now')),
      reading TEXT, questions TEXT, assumptions TEXT, reason TEXT, result TEXT, not_proven TEXT, link TEXT, link_label TEXT, note TEXT,
      repo TEXT, spec TEXT, story TEXT, phase TEXT, brief TEXT, draft_report TEXT, dispatch TEXT, worktree TEXT, line TEXT,
      issue_url TEXT, issue_state TEXT, owed TEXT, told_at TEXT, tries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), released_at TEXT
    );
    -- The owner's words stay as he said them, whatever else changes on the row.
    CREATE TRIGGER IF NOT EXISTS today_words_fixed BEFORE UPDATE OF words ON today_items BEGIN SELECT RAISE(ABORT, 'The owner''s words do not change'); END;
    CREATE TABLE IF NOT EXISTS support_replies (
      id INTEGER PRIMARY KEY, reference TEXT NOT NULL, dealership TEXT NOT NULL, dealership_id TEXT NOT NULL, text TEXT NOT NULL,
      repo TEXT NOT NULL, pr INTEGER NOT NULL CHECK (pr > 0),
      status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'held', 'sending', 'sent', 'failed', 'unknown', 'dropped')),
      hold_kind TEXT, problem TEXT, note TEXT, outcome TEXT, tell TEXT, release_pr INTEGER, live_sha TEXT, manual_ok INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), status_at TEXT NOT NULL DEFAULT (datetime('now')),
      attempted_at TEXT, finished_at TEXT
    );
    -- One open reply per ticket, so a ticket never has two approved texts waiting to go out.
    CREATE UNIQUE INDEX IF NOT EXISTS support_replies_open ON support_replies(reference) WHERE status IN ('waiting', 'held', 'sending', 'failed', 'unknown');
    -- The approved words stay as approved.
    CREATE TRIGGER IF NOT EXISTS support_reply_text_fixed BEFORE UPDATE OF text ON support_replies BEGIN SELECT RAISE(ABORT, 'approved words do not change'); END;
    -- A send that started, finished or may have gone out can never become sendable again, whatever the code above this does.
    CREATE TRIGGER IF NOT EXISTS support_reply_once BEFORE UPDATE OF status ON support_replies
      WHEN OLD.status IN ('sending', 'sent', 'unknown') AND NEW.status IN ('waiting', 'sending')
      BEGIN SELECT RAISE(ABORT, 'a send that was attempted never goes out again'); END;
    -- Background Claude Code sessions jarvisd started (native.ts). id is the short id claude --bg printed.
    CREATE TABLE IF NOT EXISTS native_workers (
      id TEXT PRIMARY KEY, session_id TEXT, name TEXT NOT NULL, cwd TEXT NOT NULL, approval_id INTEGER,
      state TEXT NOT NULL DEFAULT 'starting', waiting_for TEXT, report TEXT, report_at TEXT, outcome TEXT, transcript TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  // Interactive (pseudo-terminal) native workers, added 2026-11-06 for artifact work.
  const nativeCols = (db.prepare('PRAGMA table_info(native_workers)').all() as { name: string }[]).map(c => c.name);
  if (!nativeCols.includes('kind')) db.exec("ALTER TABLE native_workers ADD COLUMN kind TEXT NOT NULL DEFAULT 'background'; ALTER TABLE native_workers ADD COLUMN pgid INTEGER;");
  // Interactive sessions by default (2026-11-07): what a resume replays, and the pipe jarvisd types into.
  if (!nativeCols.includes('repo')) db.exec(`ALTER TABLE native_workers ADD COLUMN repo TEXT; ALTER TABLE native_workers ADD COLUMN model TEXT; ALTER TABLE native_workers ADD COLUMN permission_mode TEXT;
    ALTER TABLE native_workers ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0; ALTER TABLE native_workers ADD COLUMN last_resume_at TEXT; ALTER TABLE native_workers ADD COLUMN in_fifo TEXT;`);
  // Side chats were recorded as requests until 2026-10-30. Hide them; their worker, worktree and session stay.
  db.exec(`UPDATE requests SET hidden_at = datetime('now') WHERE action = 'side-chat' AND hidden_at IS NULL`);
  // Added with web push; older databases get the columns here.
  const itemCols = (db.prepare('PRAGMA table_info(items)').all() as { name: string }[]).map(c => c.name);
  if (!itemCols.includes('pushes')) db.exec('ALTER TABLE items ADD COLUMN pushes INTEGER NOT NULL DEFAULT 0; ALTER TABLE items ADD COLUMN pushed_at TEXT;');
  if (!itemCols.includes('meta')) db.exec('ALTER TABLE items ADD COLUMN meta TEXT;'); // added with Gmail
  if (!itemCols.includes('answered_by')) db.exec('ALTER TABLE items ADD COLUMN answered_by TEXT;');
  const approvalCols = (db.prepare('PRAGMA table_info(approvals)').all() as { name: string }[]).map(c => c.name);
  if (!approvalCols.includes('card')) db.exec('ALTER TABLE approvals ADD COLUMN card TEXT;'); // added with the headed approval card

  // Set when the brain's turn ends without an error, or when the check reports the message lost. Messages from before this column are not in question.
  const turnCols = (db.prepare('PRAGMA table_info(turns)').all() as { name: string }[]).map(c => c.name);
  if (!turnCols.includes('settled_at')) db.exec(`ALTER TABLE turns ADD COLUMN settled_at TEXT; UPDATE turns SET settled_at = created_at WHERE role = 'owner';`);
  if (!turnCols.includes('reply_to')) db.exec('ALTER TABLE turns ADD COLUMN reply_to INTEGER;'); // the message the owner answers, set by the reply button or swipe

  const getState = (key: string): string | undefined =>
    (db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  const setState = (key: string, value: string) =>
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  return {
    db,
    getState,
    setState,
    /** Returns the new row, or undefined when the external ID was already stored (replayed delivery). */
    insertItem(i: { source: string; external_id: string; kind: string; dispatch_id?: string | null; subject?: string; body?: string; options?: string | null; meta?: string | null; status?: string }): Item | undefined {
      const r = db.prepare(`INSERT OR IGNORE INTO items (source, external_id, kind, dispatch_id, subject, body, options, meta, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(i.source, i.external_id, i.kind, i.dispatch_id ?? null, i.subject ?? '', i.body ?? '', i.options ?? null, i.meta ?? null, i.status ?? 'new');
      if (r.changes === 0) return undefined;
      return db.prepare('SELECT * FROM items WHERE id = ?').get(r.lastInsertRowid) as Item;
    },
    markItem(externalId: string, status: string, answer?: string, answeredBy?: 'jarvis') {
      db.prepare(`UPDATE items SET status = ?, answer = COALESCE(?, answer), answered_by = COALESCE(?, answered_by), updated_at = datetime('now') WHERE external_id = ?`)
        .run(status, answer ?? null, answeredBy ?? null, externalId);
    },
    setItemMeta(externalId: string, meta: string) {
      db.prepare('UPDATE items SET meta = ? WHERE external_id = ?').run(meta, externalId);
    },
    item(externalId: string): Item | undefined {
      return db.prepare('SELECT * FROM items WHERE external_id = ?').get(externalId) as Item | undefined;
    },
    /**
     * Marks an open ask as being answered before the reply goes to Orca, so a retried reply is refused.
     * Returns 'claimed', 'untracked' (an ID jarvisd never stored), or the status that blocks a second reply.
     */
    claimReply(externalId: string): string {
      const r = db.prepare(`UPDATE items SET status = 'replying', updated_at = datetime('now') WHERE external_id = ? AND status IN ('new', 'spoken')`).run(externalId);
      if (r.changes === 1) return 'claimed';
      return this.item(externalId)?.status ?? 'untracked';
    },
    /** Orca refused the reply, so the ask is open again. */
    releaseReply(externalId: string) {
      db.prepare(`UPDATE items SET status = 'spoken', updated_at = datetime('now') WHERE external_id = ? AND status = 'replying'`).run(externalId);
    },
    openItems(): Item[] {
      return db.prepare(`SELECT * FROM items WHERE status IN ('new', 'spoken', 'replying') AND kind IN ('question', 'escalation') ORDER BY id`).all() as Item[];
    },
    /** Closes asks a worker raised before one the owner has answered: the worker is past them. A reply going out is left to finish. Returns their ids. */
    closeEarlierAsks(): string[] {
      return (db.prepare(`UPDATE items SET status = 'done', updated_at = datetime('now')
        WHERE kind IN ('question', 'escalation') AND status IN ('new', 'spoken') AND dispatch_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM items a WHERE a.dispatch_id = items.dispatch_id AND a.id > items.id AND a.kind IN ('question', 'escalation') AND a.status = 'answered')
        RETURNING external_id`).all() as { external_id: string }[]).map(r => r.external_id);
    },
    /** Questions and escalations from the last 7 days, answered or not, for the ask cards in the chat history. */
    recentAsks(): Item[] {
      return db.prepare(`SELECT * FROM items WHERE source IN ('orca', 'native') AND kind IN ('question', 'escalation') AND created_at > datetime('now', '-7 days') ORDER BY id DESC LIMIT 100`).all() as Item[];
    },
    /** What jarvisd did to a native session (kind `event` items, such as a resume), oldest first, for its pane's gap lines. */
    eventsFor(dispatch: string): Item[] {
      return db.prepare(`SELECT * FROM items WHERE source = 'native' AND dispatch_id = ? AND kind = 'event' ORDER BY id`).all(dispatch) as Item[];
    },
    /** The answers a worker was sent, oldest first, for its conversation pane. */
    answersTo(dispatch: string): Item[] {
      return db.prepare(`SELECT * FROM items WHERE source IN ('orca', 'native') AND dispatch_id = ? AND kind IN ('question', 'escalation') AND status = 'answered' AND answer IS NOT NULL ORDER BY COALESCE(updated_at, created_at), id`).all(dispatch) as Item[];
    },
    /** Questions and escalations the owner answered, newest first, for the audit log. */
    answeredAsks(limit: number): Item[] {
      return db.prepare(`SELECT * FROM items WHERE source IN ('orca', 'native') AND kind IN ('question', 'escalation') AND status = 'answered' ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?`).all(limit) as Item[];
    },
    /** Approvals someone decided, newest first, for the audit log. Pending and automatic ones are left out. */
    decidedApprovals(limit: number): Approval[] {
      return db.prepare(`SELECT * FROM approvals WHERE status != 'pending' AND decided_by IS NOT NULL AND decided_by != 'automatic' ORDER BY COALESCE(decided_at, created_at) DESC LIMIT ?`).all(limit) as Approval[];
    },
    /** Emails that still wait for the owner (a reply or a decision). The brain's brief keeps the last 3 days; null means every age, for the Messages button. */
    openEmails(days: number | null = 3): Item[] {
      if (days === null) return db.prepare(`SELECT * FROM items WHERE source = 'gmail' AND status IN ('new', 'spoken') ORDER BY id`).all() as Item[];
      return db.prepare(`SELECT * FROM items WHERE source = 'gmail' AND status IN ('new', 'spoken') AND created_at > datetime('now', ?) ORDER BY id`).all(`-${days} days`) as Item[];
    },
    /** Messages the owner still has to send himself, oldest first. They stay until he taps Done, at any age (messages.ts). */
    openOutbox(): Item[] {
      return db.prepare(`SELECT * FROM items WHERE source = 'outbox' AND status IN ('new', 'spoken') ORDER BY id`).all() as Item[];
    },
    /** A send for this email that went out, is going out, or may have gone out. A second one is refused. */
    gmailSendFor(externalId: string): Approval | undefined {
      return db.prepare(`SELECT * FROM approvals WHERE action = 'gmail-send' AND json_extract(args, '$.item') = ?
        AND status IN ('approved', 'done', 'unknown') ORDER BY id DESC LIMIT 1`).get(externalId) as Approval | undefined;
    },
    addTurn(t: { role: string; text: string; session_id?: string; input_tokens?: number; cache_read?: number; cache_write?: number; output_tokens?: number; latency_ms?: number; reply_to?: number }): number {
      return Number(db.prepare(`INSERT INTO turns (role, text, session_id, input_tokens, cache_read, cache_write, output_tokens, latency_ms, reply_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.role, t.text, t.session_id ?? null, t.input_tokens ?? null,
        t.cache_read ?? null, t.cache_write ?? null, t.output_tokens ?? null, t.latency_ms ?? null, t.reply_to ?? null).lastInsertRowid);
    },
    /** One turn by id, for a quote. */
    turn(id: number): { id: number; role: string; text: string; created_at: string } | undefined {
      return db.prepare('SELECT id, role, text, created_at FROM turns WHERE id = ?').get(id) as any;
    },
    settleTurns(ids: number[]) {
      for (const id of ids) db.prepare(`UPDATE turns SET settled_at = datetime('now') WHERE id = ? AND settled_at IS NULL`).run(id);
    },
    unsettledTurns(): OwnerTurn[] {
      return db.prepare(`SELECT id, text, created_at FROM turns WHERE role = 'owner' AND settled_at IS NULL ORDER BY id`).all() as OwnerTurn[];
    },
    /** ID of the owner's latest message (0 if none). */
    lastOwnerTurn(): number {
      return (db.prepare(`SELECT MAX(id) AS id FROM turns WHERE role = 'owner'`).get() as { id: number | null }).id ?? 0;
    },
    ownerTurnAfter(turnId: number): { id: number; text: string } | undefined {
      return db.prepare(`SELECT id, text FROM turns WHERE role = 'owner' AND id > ? ORDER BY id DESC LIMIT 1`).get(turnId) as any;
    },
    addApproval(a: { action: string; args: string; say: string; card?: string | null }): Approval {
      const r = db.prepare('INSERT INTO approvals (action, args, say, after_turn, card) VALUES (?, ?, ?, ?, ?)').run(a.action, a.args, a.say, this.lastOwnerTurn(), a.card ?? null);
      return this.approval(Number(r.lastInsertRowid))!;
    },
    approval(id: number): Approval | undefined {
      return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval | undefined;
    },
    /** Moves a pending approval to a decided status. Returns false if it was not pending (already decided). */
    decide(id: number, status: string, decidedBy: string, ownerText?: string): boolean {
      return db.prepare(`UPDATE approvals SET status = ?, decided_by = ?, owner_text = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'`)
        .run(status, decidedBy, ownerText ?? null, id).changes === 1;
    },
    finishApproval(id: number, status: string, result: string) {
      db.prepare('UPDATE approvals SET status = ?, result = ? WHERE id = ?').run(status, result, id);
    },
    /**
     * The latest approval for the same action and args that would make a new one a repeat: still pending,
     * or approved, done or unresolved in the last 10 minutes. Failed and rejected ones may be proposed again.
     */
    sameApproval(action: string, args: string): Approval | undefined {
      return db.prepare(`SELECT * FROM approvals WHERE action = ? AND args = ? AND (status = 'pending'
        OR (status IN ('approved', 'done', 'unknown') AND created_at > datetime('now', '-10 minutes'))) ORDER BY id DESC LIMIT 1`).get(action, args) as Approval | undefined;
    },
    /**
     * worker-start approvals whose task is still open: pending, being run or unresolved in the last 10 minutes, or
     * done with a request that is working or waiting. A hidden or removed request stops updating, so it does not count.
     */
    openWorkerStarts(): Approval[] {
      return db.prepare(`SELECT * FROM approvals a WHERE a.action = 'worker-start' AND (a.status = 'pending'
        OR (a.status IN ('approved', 'unknown') AND COALESCE(a.decided_at, a.created_at) > datetime('now', '-10 minutes'))
        OR (a.status = 'done' AND EXISTS (SELECT 1 FROM requests r WHERE r.approval_id = a.id
          AND r.status IN ('working', 'waiting') AND r.hidden_at IS NULL AND r.removed_at IS NULL))) ORDER BY a.id DESC`).all() as Approval[];
    },
    pendingApprovals(): Approval[] {
      return db.prepare(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY id`).all() as Approval[];
    },
    /** True if the owner said anything after `since` (a UTC 'YYYY-MM-DD HH:MM:SS' timestamp from this database). */
    ownerSpokeSince(since: string): boolean {
      return !!db.prepare(`SELECT 1 FROM turns WHERE role = 'owner' AND created_at > ? LIMIT 1`).get(since);
    },
    markPushed(externalId: string) {
      db.prepare(`UPDATE items SET pushes = pushes + 1, pushed_at = datetime('now') WHERE external_id = ?`).run(externalId);
    },
    /** Holds a push until `sendAt` (UTC 'YYYY-MM-DD HH:MM:SS'). Returns false when one with the same tag already waits. */
    holdPush(message: { tag: string }, item: string | null, sendAt: string): boolean {
      return db.prepare('INSERT OR IGNORE INTO held_pushes (tag, message, item, send_at) VALUES (?, ?, ?, ?)')
        .run(message.tag, JSON.stringify(message), item, sendAt).changes === 1;
    },
    /** Held pushes not yet sent whose time has come, oldest first. */
    duePushes(now: string): { id: number; tag: string; message: string; item: string | null; held_at: string }[] {
      return db.prepare('SELECT id, tag, message, item, held_at FROM held_pushes WHERE sent_at IS NULL AND send_at <= ? ORDER BY id').all(now) as any[];
    },
    /** Marks a held push sent before it goes out. False when another sweep already took it. */
    claimHeldPush(id: number): boolean {
      return db.prepare(`UPDATE held_pushes SET sent_at = datetime('now') WHERE id = ? AND sent_at IS NULL`).run(id).changes === 1;
    },
    /** No device took it, so it waits for the next sweep (unless a newer copy with the same tag already waits). */
    releaseHeldPush(id: number) {
      db.prepare('UPDATE OR IGNORE held_pushes SET sent_at = NULL WHERE id = ?').run(id);
    },
    /** Deletes waiting pushes with this tag (the same message is going out now, or is no longer needed). */
    dropHeldPushes(tag: string): number {
      return Number(db.prepare('DELETE FROM held_pushes WHERE tag = ? AND sent_at IS NULL').run(tag).changes);
    },
    /** One row per browser; subscribing again from the same browser replaces its keys. */
    addPushSub(s: { endpoint: string; keys: { p256dh: string; auth: string } }, userAgent?: string) {
      db.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`)
        .run(s.endpoint, s.keys.p256dh, s.keys.auth, userAgent ?? null);
    },
    removePushSub(endpoint: string): boolean {
      return db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint).changes === 1;
    },
    pushSubs(): { endpoint: string; keys: { p256dh: string; auth: string } }[] {
      return (db.prepare('SELECT endpoint, p256dh, auth FROM push_subs ORDER BY created_at').all() as any[])
        .map(r => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
    },
    /** The words of a message from Jarvis, for reading it aloud again. */
    jarvisText(id: number): string | undefined {
      return (db.prepare(`SELECT text FROM turns WHERE id = ? AND role = 'jarvis'`).get(id) as { text: string } | undefined)?.text;
    },
    turnText(id: number): string | undefined {
      return (db.prepare('SELECT text FROM turns WHERE id = ?').get(id) as { text: string } | undefined)?.text;
    },
    /** The stored steps of one "Worked for" row. */
    workSteps(id: number): string | undefined {
      return (db.prepare(`SELECT text FROM turns WHERE id = ? AND role = 'jarvis-work'`).get(id) as { text: string } | undefined)?.text;
    },
    /** Returns false when the dispatch already has a request (a backfill after the live insert). */
    addRequest(r: { dispatch_id: string; approval_id?: number | null; action: string; title: string; words?: string | null; created_at?: string }): boolean {
      return db.prepare(`INSERT OR IGNORE INTO requests (dispatch_id, approval_id, action, title, words, created_at, status_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`)
        .run(r.dispatch_id, r.approval_id ?? null, r.action, r.title, r.words ?? null, r.created_at ?? null, r.created_at ?? null).changes === 1;
    },
    /** Requests still in the sidebar: not hidden by the owner, not removed with their conversation. */
    requests(): Request[] {
      return db.prepare('SELECT * FROM requests WHERE hidden_at IS NULL AND removed_at IS NULL ORDER BY id').all() as Request[];
    },
    /** Every request ever recorded, hidden and removed ones too. Only the one-time backfill reads this. */
    allRequests(): Request[] {
      return db.prepare('SELECT * FROM requests ORDER BY id').all() as Request[];
    },
    request(id: number): Request | undefined {
      return db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Request | undefined;
    },
    /** Sets the given columns; a new status also moves status_at. Only the columns named here can be written. */
    updateRequest(id: number, f: Partial<Pick<Request, 'worktree' | 'session' | 'pr' | 'pr_url' | 'status'>> & { removed?: boolean }) {
      const cols = (['worktree', 'session', 'pr', 'pr_url', 'status'] as const).filter(k => f[k] !== undefined);
      const set = [...cols.map(k => `${k} = ?`), ...(f.status ? ["status_at = datetime('now')"] : []), ...(f.removed ? ["removed_at = datetime('now')"] : [])];
      if (set.length) db.prepare(`UPDATE requests SET ${set.join(', ')} WHERE id = ?`).run(...cols.map(k => f[k] as string), id);
    },
    hideRequest(id: number): boolean {
      return db.prepare(`UPDATE requests SET hidden_at = datetime('now') WHERE id = ? AND hidden_at IS NULL`).run(id).changes === 1;
    },
    addReminder(text: string, dueAt: string): Reminder {
      const r = db.prepare('INSERT INTO reminders (text, due_at) VALUES (?, ?)').run(text, dueAt);
      return this.reminder(Number(r.lastInsertRowid))!;
    },
    reminder(id: number): Reminder | undefined {
      return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | undefined;
    },
    /** Every reminder not done, soonest first. */
    openReminders(): Reminder[] {
      return db.prepare(`SELECT * FROM reminders WHERE status != 'done' ORDER BY due_at, id`).all() as Reminder[];
    },
    /** What the check must tell now: open ones past due, and fired ones last told at or before `toldBy`. */
    dueReminders(now: string, toldBy: string): Reminder[] {
      return db.prepare(`SELECT * FROM reminders WHERE (status = 'open' AND due_at <= ?) OR (status = 'fired' AND told_at <= ?) ORDER BY due_at, id`).all(now, toldBy) as Reminder[];
    },
    /** The first telling sets `fired_at`; each telling moves `told_at`. A done reminder stays done. */
    markReminderTold(id: number, now: string) {
      db.prepare(`UPDATE reminders SET status = 'fired', fired_at = COALESCE(fired_at, ?), told_at = ? WHERE id = ? AND status != 'done'`).run(now, now, id);
    },
    /** Closes a reminder, fired or not. Undefined for an unknown id. A second call keeps the first `done_at`. */
    doneReminder(id: number, now: string): Reminder | undefined {
      db.prepare(`UPDATE reminders SET status = 'done', done_at = ? WHERE id = ? AND status != 'done'`).run(now, id);
      return this.reminder(id);
    },
    addSupportReply(r: Pick<SupportReply, 'reference' | 'dealership' | 'dealership_id' | 'text' | 'repo' | 'pr'>): SupportReply {
      const row = db.prepare('INSERT INTO support_replies (reference, dealership, dealership_id, text, repo, pr) VALUES (?, ?, ?, ?, ?, ?)')
        .run(r.reference, r.dealership, r.dealership_id, r.text, r.repo, r.pr);
      return this.supportReply(Number(row.lastInsertRowid))!;
    },
    supportReply(id: number): SupportReply | undefined {
      return db.prepare('SELECT * FROM support_replies WHERE id = ?').get(id) as SupportReply | undefined;
    },
    /** Everything not closed: waiting, on hold, mid-send, failed or unresolved. */
    openSupportReplies(): SupportReply[] {
      return db.prepare(`SELECT * FROM support_replies WHERE status IN ('waiting', 'held', 'sending', 'failed', 'unknown') ORDER BY id`).all() as SupportReply[];
    },
    owedSupportTells(): SupportReply[] {
      return db.prepare('SELECT * FROM support_replies WHERE tell IS NOT NULL ORDER BY id').all() as SupportReply[];
    },
    /** Sets the named columns; a new status also moves status_at. `text`, `reference` and `id` are not in the list, so they cannot be written. */
    setSupportReply(id: number, f: Partial<Pick<SupportReply, 'status' | 'hold_kind' | 'problem' | 'note' | 'outcome' | 'tell' | 'release_pr' | 'live_sha' | 'manual_ok' | 'finished_at'>>) {
      const allowed = ['status', 'hold_kind', 'problem', 'note', 'outcome', 'tell', 'release_pr', 'live_sha', 'manual_ok', 'finished_at'] as const;
      const cols = allowed.filter(k => f[k] !== undefined);
      const set = [...cols.map(k => `${k} = ?`), ...(f.status ? ["status_at = datetime('now')"] : [])];
      if (set.length) db.prepare(`UPDATE support_replies SET ${set.join(', ')} WHERE id = ?`).run(...cols.map(k => f[k] as string | number | null), id);
    },
    /** The record of the attempt, written before the send. False means the row left `waiting`, so nothing may go out. */
    claimSupportSend(id: number): boolean {
      return db.prepare(`UPDATE support_replies SET status = 'sending', attempted_at = datetime('now'), status_at = datetime('now') WHERE id = ? AND status = 'waiting'`).run(id).changes === 1;
    },
    addToday(words: string, go: boolean): TodayRow {
      const r = db.prepare(`INSERT INTO today_items (words, go, owed) VALUES (?, ?, 'new')`).run(words, go ? 1 : 0);
      return this.todayItem(Number(r.lastInsertRowid))!;
    },
    todayItem(id: number): TodayRow | undefined {
      return db.prepare('SELECT * FROM today_items WHERE id = ?').get(id) as TodayRow | undefined;
    },
    /** Everything the owner can still see: open rows and released history. Dropped and moved rows stay stored but are not listed. */
    todayItems(): TodayRow[] {
      return db.prepare(`SELECT * FROM today_items WHERE status NOT IN ('dropped', 'moved') ORDER BY id`).all() as TodayRow[];
    },
    /** Sets the named columns; a new status also moves status_at. `words` and `id` are not in the list, so they cannot be written. */
    setToday(id: number, f: Partial<Omit<TodayRow, 'id' | 'words' | 'status_at' | 'created_at'>>) {
      const allowed = ['title', 'kind', 'go', 'status', 'reading', 'questions', 'assumptions', 'reason', 'result', 'not_proven', 'link', 'link_label', 'note', 'repo', 'spec', 'story', 'phase', 'brief', 'draft_report', 'dispatch', 'worktree', 'line', 'issue_url', 'issue_state', 'owed', 'told_at', 'tries', 'released_at'] as const;
      const cols = allowed.filter(k => f[k] !== undefined);
      const set = [...cols.map(k => `${k} = ?`), ...(f.status ? ["status_at = datetime('now')"] : [])];
      if (set.length) db.prepare(`UPDATE today_items SET ${set.join(', ')} WHERE id = ?`).run(...cols.map(k => f[k] as string | number | null), id);
    },
    /** Moves a row only if it is still in `from`. False means something else already moved it, so a slot is never claimed twice. */
    claimToday(id: number, from: string, to: string): boolean {
      return db.prepare(`UPDATE today_items SET status = ?, status_at = datetime('now') WHERE id = ? AND status = ?`).run(to, id, from).changes === 1;
    },
    /** The request behind a worker, hidden and removed ones too. */
    requestOf(dispatch: string): Request | undefined {
      return db.prepare('SELECT * FROM requests WHERE dispatch_id = ?').get(dispatch) as Request | undefined;
    },
    /** The latest filing of the issue for this Today item, so a crash or a second Accept never files it twice. */
    todayIssueApproval(item: number): Approval | undefined {
      return db.prepare(`SELECT * FROM approvals WHERE action = 'today-issue' AND json_extract(args, '$.item') = ? AND status != 'failed' ORDER BY id DESC LIMIT 1`).get(item) as Approval | undefined;
    },
    recentTurns(n: number) {
      return (db.prepare('SELECT id, role, text, created_at, reply_to FROM turns ORDER BY id DESC LIMIT ?').all(n) as { id: number; role: string; text: string; created_at: string; reply_to: number | null }[]).reverse();
    },
    addNativeWorker(w: Omit<NativeWorkerRow, NativeOptional> & Partial<Pick<NativeWorkerRow, NativeOptional>>) {
      db.prepare(`INSERT INTO native_workers (id, session_id, name, cwd, approval_id, state, waiting_for, report, report_at, outcome, transcript, created_at, updated_at, kind, pgid,
        repo, model, permission_mode, resumes, last_resume_at, in_fifo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(w.id, w.session_id, w.name, w.cwd, w.approval_id, w.state, w.waiting_for, w.report, w.report_at, w.outcome, w.transcript, w.created_at, w.updated_at, w.kind ?? 'background', w.pgid ?? null,
          w.repo ?? null, w.model ?? null, w.permission_mode ?? null, w.resumes ?? 0, w.last_resume_at ?? null, w.in_fifo ?? null);
    },
    /** Sets the named columns and moves updated_at. `id`, `name` and `created_at` never change; `cwd` only when the listing names the session's real folder. */
    updateNativeWorker(id: string, f: Partial<Omit<NativeWorkerRow, 'id' | 'name' | 'created_at'>>) {
      const allowed = ['session_id', 'approval_id', 'state', 'waiting_for', 'report', 'report_at', 'outcome', 'transcript', 'updated_at', 'pgid', 'cwd', 'model', 'permission_mode', 'resumes', 'last_resume_at', 'in_fifo'] as const;
      const cols = allowed.filter(k => f[k] !== undefined);
      if (!cols.length) return;
      db.prepare(`UPDATE native_workers SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(k => f[k] as string | number | null), id);
    },
    nativeWorker(id: string): NativeWorkerRow | undefined {
      return db.prepare('SELECT * FROM native_workers WHERE id = ?').get(id) as NativeWorkerRow | undefined;
    },
    /** Every background worker ever started, newest first. */
    nativeWorkers(): NativeWorkerRow[] {
      return db.prepare('SELECT * FROM native_workers ORDER BY created_at DESC, rowid DESC').all() as NativeWorkerRow[];
    },
  };
}

export type Store = ReturnType<typeof openStore>;
