import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { addSteps, finishSteps, type Step } from './worksteps.ts';
import { DEFAULT_BRAIN_MODEL, type BrainModel } from './brainmodel.ts';
import { STAGING_MCP_URL, PRODUCT_KEY } from './config.ts';

const IDLE_RESET_MS = 55 * 60_000; // the Max-plan prompt cache lives about 1 hour
const TOKEN_RESET = 150_000;
const HANG_MS = 120_000;
const EXIT_WAIT_MS = 5_000;

/**
 * The `claude` arguments for the brain. The owner's settings, skills and auto mode, with a short tool list because every tool name and
 * definition costs context on every turn (measured 2026-10-29 with Haiku: 35.8k tokens per fresh
 * session down to about 27.9k). Only AcmeApp stays connected as an MCP server. --strict-mcp-config
 * also turns off the claude.ai connectors (Gmail, Slack, Drive), so those, Vercel and the browser
 * go to a worker. Add a tool to `tools` or a server to `mcp` if that becomes annoying.
 * The hard lines the owner set stay hard: Sam merges, and nothing gets force-pushed.
 * Typing into another terminal and sending email go through the gate (Approve button only); jarvisd reads Gmail, the brain never does.
 * `resume` continues that session under the same id, so a model switch keeps the conversation.
 * The session is named `jarvis-brain` and accepts cross-session messages, so a background worker reaches it with
 * SendMessage and the brain answers with SendMessage (criterion 5). `dialogExpiry: never` keeps a pending message
 * from being dropped while the brain is busy.
 */
export const BRAIN_NAME = 'jarvis-brain';
export function brainArgs(o: { model: BrainModel; systemPrompt: string; resume?: string; home?: string }): string[] {
  const settings = {
    enabledPlugins: {
      'superpowers@claude-plugins-official': false, 'ui-ux-pro-max@ui-ux-pro-max-skill': false,
      'claude-code-setup@claude-plugins-official': false },
    crossSessionInbound: 'accept', dialogExpiry: 'never',
  };
  const tools = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'SendMessage', 'ListAgents'];
  const mcp = { mcpServers: { [`${PRODUCT_KEY}-staging`]: { type: 'http', url: STAGING_MCP_URL } } };
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', o.model.model, '--effort', o.model.effort,
    ...(o.resume ? ['--resume', o.resume] : []),
    '--name', BRAIN_NAME,
    '--permission-mode', 'auto', '--add-dir', o.home ?? '/',
    '--settings', JSON.stringify(settings),
    '--tools', tools.join(','), '--strict-mcp-config', '--mcp-config', JSON.stringify(mcp),
    '--disallowedTools', 'Bash(gh pr merge:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)',
    'Bash(orca terminal send:*)', 'Bash(gws gmail:*)',
    '--append-system-prompt', o.systemPrompt];
}

/** The sender and text of a cross-session message. `from` is the sender's `--name`; absent when the peer had none. */
export type PeerMessage = { from?: string; text: string };

/**
 * What a `-p` stream-json session prints when another session's SendMessage starts a turn on its own, captured live
 * on 2026-11-06 (Claude Code 2.1.316, session named jarvis-brain-probe, sender `claude --bg --name probe-sender`).
 * The message itself never comes out as a `user` event: it is only in the transcript (a `user` entry with
 * `isMeta: true`, `turnOrigin: "peer"`, content `Another Claude session sent a message:\n<cross-session-message
 * from="uds:/tmp/cc-socks/55175.sock" from-name="probe-sender" from-mode="prompting">\nRELAY-OK-77\n</cross-session-message>...`).
 * stdout, in order (shortened):
 *   {"type":"command_lifecycle","command_uuid":"e9a4b181-...","state":"started","uuid":"...","session_id":"aca69e6c-..."}
 *   {"type":"system","subtype":"init","session_id":"aca69e6c-...","tools":["ListAgents","SendMessage"],"model":"claude-haiku-5-5",...}
 *   {"type":"system","subtype":"thinking_tokens",...}
 *   {"type":"assistant","message":{"content":[{"type":"tool_use","name":"SendMessage","input":{"to":"uds:/tmp/cc-socks/55175.sock","message":"BACK-RELAY-OK-77",...}}]},...}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_...","content":[{"type":"text","text":"{\"success\":true,...}"}]}]},"parent_tool_use_id":null,...}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"Sent `BACK-RELAY-OK-77` to probe-sender.\n\nTURN-DONE"}]},...}
 *   {"type":"result","subtype":"success","result":"Sent `BACK-RELAY-OK-77` to probe-sender.\n\nTURN-DONE","num_turns":2,"result_index":1,
 *     "origin":{"kind":"peer","from":"uds:/tmp/cc-socks/55175.sock","verifiedPeerPid":55175,"msg_id":"cf5f04e5-...","name":"probe-sender","fromMode":"prompting","body":"RELAY-OK-77"},
 *     "usage":{...},"session_id":"aca69e6c-..."}
 *   {"type":"command_lifecycle","command_uuid":"e9a4b181-...","state":"completed",...}
 * A turn jarvisd sent on stdin prints no command_lifecycle lines and its result has no `origin`. So: the first line of an
 * unrequested turn is `command_lifecycle started` (or any `user` event) while the brain is idle, and the sender's name
 * and text are on that turn's `result.origin`.
 */
export function peerMessage(e: any): PeerMessage | undefined {
  const o = e?.origin;
  if (o && o.kind === 'peer' && typeof o.body === 'string') return { from: typeof o.name === 'string' && o.name ? o.name : undefined, text: o.body };
  // The transcript form, in case a later version prints the message as a `user` event.
  const content = e?.message?.content;
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '';
  const m = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(text);
  if (!m) return undefined;
  const name = /\bfrom-name="([^"]*)"/.exec(m[1])?.[1];
  return { from: name || undefined, text: m[2] };
}

/** The brain session jarvisd keeps in the `state` table, so a jarvisd restart resumes the same conversation. */
export type SavedSession = { id: string; tokens: number; at: number };
export const SESSION_KEY = 'brain_session';
/** The saved session, or undefined when none is saved or the row does not parse. */
export function readSavedSession(get: (key: string) => string | undefined): SavedSession | undefined {
  try {
    const s = JSON.parse(get(SESSION_KEY) || 'null');
    if (s && typeof s.id === 'string' && s.id && Number.isFinite(s.tokens) && Number.isFinite(s.at)) return s;
  } catch { /* a bad row starts fresh */ }
  return undefined;
}
/** Why a saved session must start fresh (the reset rule, spec section 8), or undefined when it can resume. */
export function staleReason(s: SavedSession, now = Date.now()): string | undefined {
  if (now - s.at > IDLE_RESET_MS) return 'idle';
  if (s.tokens > TOKEN_RESET) return 'token limit';
  return undefined;
}
/**
 * A gate button's outcome that must wake the brain at once: anything but a clean finish ('done') or a rejection.
 * 'failed' and 'unknown' are failures; any other status is unexpected after a button, so it wakes the brain too.
 */
export function gateFailed(status: string): boolean { return status !== 'done' && status !== 'rejected'; }
/** At most this many held notices ride on the next turn; older ones drop first. */
const HELD_MAX = 20;

export type BrainOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  systemPrompt: () => string; // stable across sessions so it stays cached
  brief: () => string;        // built in code from the store, sent as the first message
  model?: BrainModel;         // the saved setting; Opus 5.5 at medium when absent
  saved?: SavedSession;       // the session the last jarvisd ran; resumed at the first start when the reset rule allows
  save?: (s: SavedSession | null) => void; // keeps the live session in the state table; null after a real reset
};

/** What the app shows: the saved setting, and what the live process runs (null when no process is up). */
export type BrainStatus = { setting: BrainModel; running: BrainModel | null; switching: boolean; sessionId?: string };

/**
 * One long-running `claude -p` stream-json session. Messages queue while a turn runs and go out
 * together. Emits 'reply' (text, usage, the turn ids it answers), 'working' (true or false), 'worked' (the turn's steps and
 * duration, just before its reply; nothing for a turn with no steps), 'notice' (text for the owner).
 * A turn the process starts on its own (a worker's SendMessage; see peerMessage) ends with 'worker' (text, usage, peer)
 * instead of 'reply'; The owner's messages queue until it ends, as for any busy turn.
 * Every hand-over and every turn's end goes to the log, so a message that got no answer shows as a gap.
 */
/** One message for the next turn. `turn` is the owner's stored message. `cardApproves` marks his non-refusal answer on a brain ask card. */
type Queued = { text: string; turn?: number; cardApproves?: boolean };

export class Brain extends EventEmitter {
  private proc?: ChildProcess;
  private queue: Queued[] = [];
  /** the owner's messages in the running turn. */
  private handed: number[] = [];
  /** The running turn holds the owner's answer on one of the brain's own ask cards, and that answer is not a refusal. */
  private cardApproves = false;
  busy = false;
  /** The running turn was started by a cross-session message, not by jarvisd. */
  private unrequested = false;
  private peerShapeLogged = false;
  private sentAt = 0;
  /** What the running turn has done so far. */
  private steps: Step[] = [];
  private lastTurnAt = 0;
  private contextTokens = 0;
  private hangTimer?: NodeJS.Timeout;
  private stopping = false;
  /** A model switch is waiting for the old process to exit. Messages queue meanwhile. */
  private switching = false;
  sessionId?: string;
  /** What the next start uses. */
  setting: BrainModel;
  /** What the live process was started with; the model is confirmed by its init event. */
  private running?: BrainModel;

  /** The session the last jarvisd ran, tried once at the first start. */
  private saved?: SavedSession;
  /** The process resumed the saved session and has not finished a turn yet: if it exits now, the batch goes to a fresh one. */
  private resumingSaved = false;
  private inflight: Queued[] = [];
  /** Notices that need no answer of their own (gate buttons, ask cards). They ride as one line on the next real turn. */
  private held: string[] = [];

  private o: BrainOptions;
  constructor(o: BrainOptions) { super(); this.o = o; this.setting = { ...(o.model ?? DEFAULT_BRAIN_MODEL) }; this.saved = o.saved; }

  status(): BrainStatus {
    return { setting: { ...this.setting }, running: this.proc && this.running ? { ...this.running } : null, switching: this.switching, sessionId: this.sessionId };
  }

  /**
   * Move the brain to another model or effort. Refused while a turn runs (returns the reason).
   * With a live process: wait for it to exit, then start the new one with `--resume` on the same session,
   * so no history is lost. Messages sent meanwhile queue and go out once the new process is up.
   * With no process: the next start uses it. Emits 'model' at each change of status().
   */
  async switchModel(m: BrainModel): Promise<string | undefined> {
    if (this.busy) return 'Jarvis is in the middle of a turn. Try again when it ends.';
    if (this.switching) return 'A switch is already under way.';
    this.setting = { ...m };
    const old = this.proc;
    if (!old) { this.emit('model', this.status()); return; }
    const resume = this.sessionId;
    this.switching = true;
    this.proc = undefined; // its exit handler now sees it as replaced on purpose
    this.emit('model', this.status());
    this.emit('log', 'brain switching model', { model: m.model, effort: m.effort, resume });
    await new Promise<void>(res => {
      if (old.exitCode !== null || old.signalCode !== null) return res();
      const force = setTimeout(() => old.kill('SIGKILL'), EXIT_WAIT_MS);
      old.once('exit', () => { clearTimeout(force); res(); });
      old.kill();
    });
    this.switching = false;
    if (!this.stopping) this.start(resume);
    this.emit('model', this.status());
    this.pump();
  }

  /**
   * `turn` is the stored turn id of a message from the owner. `card.approves` is set only by brainasks.ts, for the
   * owner's own answer on one of the brain's ask cards that is not a refusal (answeringOwnerCard).
   */
  send(text: string, turn?: number, card?: { approves: boolean }) { this.queue.push({ text, turn, cardApproves: card?.approves === true }); this.pump(); }
  /**
   * A notice the brain needs to know but not answer: it does not start a turn. It rides as one context line in front
   * of the next turn that something else starts. A failure must use send(), so it wakes the brain at once.
   */
  hold(text: string) {
    this.held.push(text.replace(/\s+/g, ' ').replace(/\s*Reply SILENT\.?\s*$/i, '').trim());
    if (this.held.length > HELD_MAX) this.held.splice(0, this.held.length - HELD_MAX);
    this.emit('log', 'brain holds a notice for the next turn', { held: this.held.length, notice: text.slice(0, 18) });
  }
  /** How many notices wait for the next turn. */
  get heldCount() { return this.held.length; }

  private persist() {
    if (!this.sessionId) return;
    this.o.save?.({ id: this.sessionId, tokens: this.contextTokens, at: this.lastTurnAt || Date.now() });
  }
  /** The running turn holds a message from the owner. Event, check and gate messages carry no turn id. */
  get answeringOwner() { return this.handed.length > 0; }
  /**
   * The running turn holds the owner's tap or typed answer on one of the brain's own ask cards, not a refusal.
   * Only reply-add reads it. A worker ask tap, a held notice, a [check] or a [work list] line never sets it.
   */
  get answeringOwnerCard() { return this.cardApproves; }

  stop() { this.stopping = true; if (this.busy) this.emit('working', false); this.busy = false; this.unrequested = false; clearTimeout(this.hangTimer); this.proc?.kill(); this.proc = undefined; }

  /**
   * The first start of this jarvisd resumes the session the last one ran, when the reset rule allows it. It keeps that
   * session's token count and last turn time, so the normal reset rule goes on from there.
   */
  private startFirst() {
    const s = this.saved;
    this.saved = undefined;
    const why = s && staleReason(s);
    if (!s || why) {
      if (s) this.emit('log', 'brain saved session not resumed', { session: s.id, why });
      this.start();
      return;
    }
    this.emit('log', 'brain resumes the saved session', { session: s.id, tokens: s.tokens });
    this.start(s.id);
    this.contextTokens = s.tokens;
    this.lastTurnAt = s.at;
    this.resumingSaved = true;
    this.held.unshift(`jarvisd restarted at ${new Date().toISOString()}. This is the same conversation, but the state may have moved while it was down.`);
  }

  /** A fresh session gets the state brief; a resumed one (model switch, jarvisd restart) already has its history. */
  private start(resume?: string) {
    this.resumingSaved = false;
    this.stopping = false;
    const model = { ...this.setting };
    const p = spawn('claude', brainArgs({ model, systemPrompt: this.o.systemPrompt(), resume, home: process.env.HOME }),
      { cwd: this.o.cwd, env: this.o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    this.running = model;
    p.on('error', err => this.emit('log', `brain failed to start: ${err.message}`));
    if (resume) this.sessionId = resume;
    else { this.contextTokens = 0; this.lastTurnAt = 0; this.sessionId = undefined; this.o.save?.(null); }
    // A process that exits at once (a session that will not resume) closes stdin under a pending write.
    p.stdin!.on('error', err => this.emit('log', `brain stdin: ${err.message}`));
    p.stderr!.on('data', d => this.emit('log', `brain stderr: ${String(d).trim()}`));
    readline.createInterface({ input: p.stdout! }).on('line', line => this.onLine(line));
    p.on('exit', code => {
      if (this.proc !== p) return; // replaced on purpose
      this.proc = undefined;
      this.busy = false;
      this.unrequested = false;
      clearTimeout(this.hangTimer);
      if (this.stopping) return;
      this.emit('log', `brain exited with ${code}`);
      if (this.resumingSaved) {
        // The saved session would not resume (gone, or refused): start fresh and hand it the same batch, with no notice.
        this.emit('log', 'brain saved session would not resume, starting fresh');
        this.queue.unshift(...this.inflight);
        this.inflight = [];
        this.handed = []; this.cardApproves = false;
        this.endWork('');
        this.emit('working', false);
        this.start();
        this.pump();
        return;
      }
      this.restartWithNotice();
    });
    // The brief rides in front of whatever is queued.
    if (!resume) this.queue.unshift({ text: this.o.brief() });
  }

  private restartWithNotice() {
    if (this.handed.length) this.emit('log', 'brain lost a running turn', { turns: this.handed });
    this.handed = []; this.cardApproves = false;
    // What the lost turn did stays readable.
    this.endWork('');
    this.emit('working', false);
    this.emit('notice', 'I restarted. If I missed something you just said, say it again.');
    this.proc?.kill();
    this.proc = undefined;
    this.busy = false;
    this.start();
    this.pump();
  }

  private pump() {
    if (this.busy || this.switching || !this.queue.length) return;
    const stale = this.proc && (Date.now() - this.lastTurnAt > IDLE_RESET_MS || this.contextTokens > TOKEN_RESET);
    if (stale) { this.emit('log', 'brain reset (idle or token limit)'); this.stop(); }
    if (!this.proc) { if (this.saved) this.startFirst(); else this.start(); }
    const batch = this.queue.splice(0);
    this.inflight = batch;
    // Held notices go in front as one line; a fresh session's brief stays first.
    const notes = this.held.splice(0);
    const at = batch[0]?.text.startsWith('[session start') ? 1 : 0;
    const parts = batch.map(m => m.text);
    if (notes.length) parts.splice(at, 0, `[held notices, no answer needed] ${notes.join(' | ')}`);
    const text = parts.join('\n\n');
    this.handed = batch.flatMap(m => m.turn ?? []);
    this.cardApproves = batch.some(m => m.cardApproves);
    // The start of each message names its kind ("[worker event]", "[The owner, in English"), and stops before the owner's words.
    this.emit('log', 'brain handed', { turns: this.handed, messages: batch.map(m => m.text.slice(0, 18)), held: notes.length, chars: text.length });
    this.busy = true;
    this.unrequested = false;
    this.sentAt = Date.now();
    this.steps = [];
    this.emit('working', true);
    this.proc!.stdin!.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
    this.armHang();
  }

  /** The process started a turn that jarvisd did not send: a cross-session message arrived. */
  private startUnrequested(line: string) {
    if (!this.peerShapeLogged) { this.peerShapeLogged = true; this.emit('log', 'brain unrequested turn, first line', { line: line.slice(0, 300) }); }
    this.emit('log', 'brain started a turn on its own');
    this.busy = true;
    this.unrequested = true;
    this.sentAt = Date.now();
    this.steps = [];
    this.handed = []; this.cardApproves = false;
    this.emit('working', true);
    this.armHang();
  }

  private endWork(reply: string) {
    const steps = finishSteps(this.steps, reply);
    this.steps = [];
    if (steps.length) this.emit('worked', { steps, ms: Date.now() - this.sentAt });
  }

  private armHang() {
    clearTimeout(this.hangTimer);
    this.hangTimer = setTimeout(() => {
      if (!this.busy) return;
      this.emit('log', 'brain hung, restarting');
      this.restartWithNotice();
    }, HANG_MS);
  }

  private onLine(line: string) {
    let e: any;
    try { e = JSON.parse(line); } catch { return; }
    // Live shape (see peerMessage): the turn opens with a command_lifecycle line; a `user` event while idle counts too.
    const opensTurn = (e.type === 'command_lifecycle' && e.state === 'started') || e.type === 'user';
    if (!this.busy && this.proc && !this.stopping && opensTurn) this.startUnrequested(line);
    if (this.busy) this.armHang();
    if (e.type === 'system' && e.subtype === 'init') {
      if (this.sessionId && e.session_id && e.session_id !== this.sessionId) this.emit('log', 'brain resumed under a new session id', { was: this.sessionId, now: e.session_id });
      this.sessionId = e.session_id;
      this.persist();
      if (typeof e.model === 'string' && this.running && e.model !== this.running.model) {
        this.emit('log', 'brain reports a different model than it was started with', { asked: this.running.model, got: e.model });
        this.running = { ...this.running, model: e.model };
      }
      this.emit('model', this.status());
    }
    if (this.busy) addSteps(this.steps, e);
    if (e.type === 'result') {
      clearTimeout(this.hangTimer);
      this.busy = false;
      this.lastTurnAt = Date.now();
      this.endWork(String(e.result ?? ''));
      this.emit('working', false);
      const u = e.usage ?? {};
      // Turn usage sums every model call in the turn; the context size is the last call's input.
      const last = Array.isArray(u.iterations) && u.iterations.length ? u.iterations[u.iterations.length - 1] : u;
      this.contextTokens = (last.input_tokens ?? 0) + (last.cache_read_input_tokens ?? 0) + (last.cache_creation_input_tokens ?? 0);
      if (e.session_id && !this.sessionId) this.sessionId = e.session_id;
      this.resumingSaved = false;
      this.inflight = [];
      this.persist();
      const text = String(e.result ?? '').trim();
      const usage = {
        session_id: e.session_id, input_tokens: u.input_tokens, cache_read: u.cache_read_input_tokens,
        cache_write: u.cache_creation_input_tokens, output_tokens: u.output_tokens, latency_ms: Date.now() - this.sentAt,
        is_error: Boolean(e.is_error),
      };
      if (this.unrequested) {
        this.unrequested = false;
        const peer = peerMessage(e);
        this.emit('worker', text, usage, peer);
        this.emit('log', 'brain answered a worker message', { chars: text.length, from: peer?.from, error: Boolean(e.is_error) });
      } else {
        this.emit('reply', text, usage, this.handed);
        this.emit('log', 'brain answered', { turns: this.handed, error: Boolean(e.is_error), silent: text === 'SILENT' });
      }
      this.handed = []; this.cardApproves = false;
      this.pump();
    }
  }
}
