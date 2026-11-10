import { OWNER_CAP, OWNER, cleanEnv } from './config.ts';
import http from 'node:http';
import { readFileSync, existsSync, createReadStream, readdirSync, statSync, watch as fsWatch } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Item, type Approval } from './store.ts';
import { Brain, readSavedSession, gateFailed, SESSION_KEY } from './brain.ts';
import { brainModelRoute, readBrainModel, MODELS, EFFORTS } from './brainmodel.ts';
import { lazyBody, type RouteResult } from './route.ts';
import { STATIC, TYPES } from './webfiles.ts';
import { makeGate, PRESSED, WORKER_PERMISSION, UNDO_MS } from './gate.ts';
import { makeVoice, sentences, detectLang, byteRange } from './voice.ts';
import { allowed, makeUiSessions, probePhone, phoneRefusal } from './access.ts';
import { makeTerminals } from './terminal.ts';
import { makeTermGate } from './termgate.ts';
import { termRoute } from './termroutes.ts';
import { terminalRows } from './termrows.ts';
import { imageFile, imageRoots, IMAGE_TYPES } from './images.ts';
import { reportsDir, reportsRoute, REPORT_MARKER } from './reports.ts';
import { saveUpload, uploadDir, UPLOAD_LIMIT, pictureLines } from './uploads.ts';
import { loadVapid, pushAll, pushOpenAsks, makeNotifier, urgent, pushRoute } from './push.ts';
import { makeLog } from './log.ts';
import { watchGmail, gws, haiku, readPeople, withRecipients, POLL_MS as GMAIL_POLL_MS, type EmailMeta } from './gmail.ts';
import { makeTasks, execRun, tasksRoute } from './tasks.ts';
import { homedir } from 'node:os';
import { githubRepo, type WorkRow, type Work } from './work.ts';
import { makeRequests, backfillRequests, requestsRoute } from './requests.ts';
import { stop } from './steer.ts';
import { listenConfig, judge } from './listen.ts';
import { askCard, answerAsk, auditEntries, type AskCard } from './asks.ts';
import { brainAskRoute, briefLine as brainAskLine, isBrainAsk } from './brainasks.ts';
import { makeCheck, readDelivery, masterHead, CHECK_MS } from './check.ts';
import { gitSelfCheck, gitNotice } from './gitcheck.ts';
import { reminderRoute } from './reminders.ts';
import { makeMessages, emailPush, outboxLine, messagesRoute } from './messages.ts';
import { makeToday, todayRoute, todayBrief, BACKSTOP_MS } from './today.ts';
import { makeReplies, replyRoute, repliesBrief, gh } from './replies.ts';
import { makeTicketWorker } from './replyworker.ts';
import { makeMigration, migrationRoute, migrationBrief, readDealerFile } from './migration.ts';
import { makeNative, ROW_PREFIX, type NativeWorker } from './native.ts';
import { nativeRoute, routeWorkerTurn } from './nativeroutes.ts';
import { readChatFile, withEvents, fileCursor } from './transcript.ts';
import type { PeerMessage } from './brain.ts';
import { quoteOf, quoteLine, replyIdOf, type Quote } from './quote.ts';
import { voiceMessage, withPictures } from '../web/dictate.js';
import { PRODUCT_KEY, PRODUCT_LABEL, DEALERS_FILE } from './config.ts';
import { makeChatLinks } from './chatlink.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_NOTE = join(ROOT, 'vault', 'owner.md');
const PORT = Number(process.env.JARVIS_PORT ?? 7717);
const KILL_FILE = join(ROOT, 'data', 'KILL');

const store = openStore(join(ROOT, 'data', 'jarvis.db'));
const voice = makeVoice(ROOT);
const listen = listenConfig();
const log = makeLog();
// The commit this daemon runs. Master moving past it means a restart is pending (check.ts).
const startCommit = await masterHead(ROOT).catch(e => { log(`check: no start commit, restart findings are off: ${e}`); return undefined; });
const vapid = loadVapid(join(ROOT, 'data', 'vapid.json'));
// Every phone push goes through notify, which holds pushes that are not urgent during quiet hours (push.ts).
const { notify, flush: flushHeldPushes } = makeNotifier(store, m => pushAll(store, vapid, m, log), log);

// ---- SSE clients ----
const clients = new Set<http.ServerResponse>();
function broadcast(ev: object) {
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(data);
}

// ---- Migration contacts list: temporary, self-contained (migration.ts; every piece listed in docs/migration/README.md) ----
const migration = makeMigration({
  db: store.db, log, getState: store.getState, setState: store.setState,
  seed: () => readDealerFile(DEALERS_FILE || join(ROOT, 'docs', 'migration', 'dealerships.json')),
  onChange: () => broadcast({ type: 'migration', migration: migration.state() }),
});

// Speech goes out one sentence at a time, in order across replies, so the first sentence plays while the rest render.
let speech = Promise.resolve();
// What Jarvis said lately, for hands-free listening: the wake word's follow-up window and the echo guard.
let lastSpokeAt = 0, lastAddressedAt = 0;
let spoken: { at: number; text: string }[] = [];
// `[image: /abs/path.png]` and `[report: /abs/path.md]` markers show a picture or a card in the chat and are never read aloud.
const IMAGE_MARKER = /\[image:\s*[^\]\n]+\]/g;
const unmarked = (text: string) => text.replace(IMAGE_MARKER, ' ').replace(REPORT_MARKER, ' ');
const spokenSentences = (text: string) => sentences(unmarked(text));
function noteSpoken(s: string) {
  lastSpokeAt = Date.now();
  spoken = [...spoken.filter(x => lastSpokeAt - x.at <= listen.windowMs), { at: lastSpokeAt, text: s }];
}
function speak(text: string, turnId: number) {
  const list = spokenSentences(text);
  list.forEach((s, i) => {
    speech = speech.then(async () => {
      try {
        await voice.tts(s);
        broadcast({ type: 'audio', turnId, i, total: list.length });
        noteSpoken(s);
      }
      catch (e) { log(`tts: ${e}`); }
    });
  });
}
/** An audio file, with byte ranges: a resume seeks into the clip, and Safari refuses media without them. */
function sendClip(req: http.IncomingMessage, res: http.ServerResponse, file: string) {
  const size = statSync(file).size, range = byteRange(req.headers.range, size);
  const head = { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes' };
  if (range === 'bad') { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
  if (!range) { res.writeHead(200, { ...head, 'content-length': size }); return createReadStream(file).pipe(res); }
  res.writeHead(206, { ...head, 'content-range': `bytes ${range.start}-${range.end}/${size}`, 'content-length': range.end - range.start + 1 });
  return createReadStream(file, range).pipe(res);
}

function say(role: string, text: string, quote?: Quote): number {
  const turnId = store.addTurn({ role, text, reply_to: quote?.id });
  broadcast({ type: 'turn', role, text, turnId, quote, clips: role === 'jarvis' ? spokenSentences(text).length : 0, at: new Date().toISOString() });
  if (role === 'jarvis') speak(text, turnId);
  return turnId;
}

// ---- Requests sidebar: one row per worker started for the owner, its status kept from the native workers' rows (requests.ts) ----
const requests = makeRequests({ store, log, repoOf: githubRepo, mergeRepo: ROOT, onChange: list => broadcast({ type: 'requests', requests: list }) });
const backfilled = backfillRequests(store);
if (backfilled) log(`requests: backfilled ${backfilled} from earlier worker starts`);

// Set once the Today list exists, so a native sync that runs during the start (a report recovered from a transcript) waits.
let todayReady = false;
// ---- Native workers: Claude background sessions jarvisd starts itself (native.ts, nativeroutes.ts) ----
const native = makeNative({
  store, log, jarvisUrl: `http://127.0.0.1:${PORT}`, dataDir: join(ROOT, 'data'),
  onChange: () => publishWork(),
  onReport: (w, text, final) => {
    if (!final) return; // a turn that ended without DONE or FAILED is the worker asking or pausing; native.stopHook reports a silent one
    // The request and the Today row move on now, not at the next poll.
    nativeSync().catch(e => log(`native sync after a report: ${e}`));
    const line = `[worker event] Native worker ${w.name} (${ROW_PREFIX}${w.id}) reported ${w.outcome}:\n${text}`;
    store.addTurn({ role: 'event', text: line });
    broadcast({ type: 'event', text: line, at: new Date().toISOString() });
    if (!existsSync(KILL_FILE)) brain.send(`${line}\n\nThis is its report, word for word. Speak it to ${OWNER} if it is an answer or a problem; a plain success is SILENT unless he asked for it. It needs no release.`);
  },
  onCard: a => {
    broadcast({ type: 'approval', approval: a });
    const args = JSON.parse(a.args);
    if (a.status === 'pending' && !existsSync(KILL_FILE)) brain.send(`[worker permission] Native worker ${args.name} wants to run ${args.tool}: ${JSON.stringify(String(args.summary).slice(0, 300))}. It waits on approval #${a.id}, a card in the app, and nothing else can answer it. Tell ${OWNER} in one sentence to tap Allow or Deny on it.`);
  },
  onNotice: (w, text) => {
    // A worker that ended its turn on a question is waiting on its answer, not silent.
    if (/ended its turn without/.test(text) && store.openItems().some(i => i.source === 'native' && i.dispatch_id === `${ROW_PREFIX}${w.id}`)) return;
    const line = `[worker event] ${text} (${ROW_PREFIX}${w.id})`;
    store.addTurn({ role: 'event', text: line });
    broadcast({ type: 'event', text: line, at: new Date().toISOString() });
    if (!existsSync(KILL_FILE)) brain.send(`${line}\n\nTell ${OWNER} in one sentence if it needs him; otherwise SILENT. To send it an instruction: jarvis-native reply --worker ${w.name} --text "<words>".`);
  },
});
/** The work list with the native rows, for the app and the brain's brief. */
// Project terminals (terminal.ts): their rows join the work list. Declared here because publishWork runs at startup.
const terms = makeTerminals({ log, env: { ...cleanEnv, TERM: 'xterm-256color' } });
/** The native workers' rows. Every reader that asks whether a worker is live (the requests, the ten-minute check) takes them from here. */
const nativeWork = (): Work => ({ at: new Date().toISOString(), rows: native.rows() });
const mergedWork = (): Work => { const w = nativeWork(); return { ...w, rows: [...w.rows, ...terminalRows(terms.current())] }; };
function publishWork() { broadcast({ type: 'work', work: mergedWork() }); }
// After publishWork exists: recover() updates rows, and each update publishes the work list.
native.recover().catch(e => log(`native recover failed: ${e}`));

// Work-list buttons (Side chat, Continue on phone) answer the press directly; they never put a card in the chat.
const gate = makeGate(store, a => {
  if (a.status === 'done') requests.started(a);
  // A stopped worker can drop out of a later list, so its session and worktree are recorded now.
  if (a.action === 'worker-stop' && a.status === 'done') { try { requests.capture(JSON.parse(a.args).dispatch); } catch {} }
  if (!PRESSED.has(a.action)) broadcast({ type: 'approval', approval: a });
  if (a.action === 'gmail-send') messagesChanged();
}, log, undefined, undefined, native, { repo: ROOT, fromOwner: () => brain.answeringOwner }); // brain is set before any proposal arrives
// Can a worker still commit? One notice per new failure: jarvisd restarts after every merge, so a repeat stays quiet.
gitSelfCheck(ROOT).then(r => {
  if (r.ok) { log('git check: a worker can commit'); store.setState('gitCheck', ''); return; }
  const text = gitNotice(r);
  log('git check failed', { hook: r.hook, why: r.why });
  if (store.getState('gitCheck') === text) return;
  store.setState('gitCheck', text);
  say('jarvis', text);
  notify({ title: 'Jarvis', body: text.slice(0, 180), url: '/', tag: 'git-check' });
}).catch(e => log(`git check: ${e}`));
// ---- The Messages button: open emails and messages the owner must send himself, kept apart from the requests (messages.ts) ----
const messages = makeMessages({ store, gate, log, onChange: () => messagesChanged() });
function messagesChanged() { broadcast({ type: 'messages', messages: messages.list() }); }

/** Takes asks that no longer wait on the owner off the open list, the pushes and the brief. Their cards show as settled. */
function closeItems(ids: string[], why: string) {
  for (const id of ids) {
    store.markItem(id, 'done');
    log(why, { item: id });
    askChanged(id);
  }
}
/** The Claude session behind a work-list row, for Continue on phone: a native row's own. */
async function phoneTarget(row: WorkRow): Promise<{ sessionId: string; cwd: string; title: string; transcript?: string } | { error: string }> {
  if (row.tmux) return { error: 'A project terminal has no Claude session to continue.' };
  if (!row.native) return { error: 'Only a native worker can continue on the phone.' };
  const w = native.get(row.native.id);
  if (!w?.session_id) return { error: 'This worker has no session id yet.' };
  return { sessionId: w.session_id, cwd: w.cwd, title: w.remote ?? row.title, transcript: native.transcriptFile(w.id) };
}
// Rows the owner hid from the app. Hiding only changes the view: no worker is stopped or deleted.
const hiddenIds = (): string[] => JSON.parse(store.getState('workHidden') ?? '[]');
/**
 * After every native poll and every final native report: the requests and the Today rows behind them, from the native
 * rows. Waits for `today`, which is made further down.
 */
async function nativeSync() {
  if (!todayReady) return;
  await requests.sync(nativeWork());
  today.sync();
}
const nativePoll = () => native.poll().then(() => {
  closeItems(store.closeEarlierAsks(), 'an ask closed by a later answer');
  return nativeSync();
}).catch(e => log(`native poll failed: ${e}`));
// Native workers: `claude agents` every 30 s (native.ts poll).
setInterval(nativePoll, 30_000);
nativePoll();
// Transcript files of finished requests, found once.
const chatFiles = new Map<string, string>();
// A native pane that was read is watched: a write to its transcript broadcasts a `pane` event, and the open page reads at
// once instead of waiting for its 3 s poll. One watcher per file, debounced; dropped when the row leaves the list.
const paneWatchers = new Map<string, { close: () => void; timer?: NodeJS.Timeout }>();
function watchPane(id: string, file: string) {
  if (paneWatchers.has(id)) return;
  try {
    const w = fsWatch(file, () => {
      const p = paneWatchers.get(id); if (!p) return;
      clearTimeout(p.timer);
      p.timer = setTimeout(() => { if (native.get(id)) broadcast({ type: 'pane', id }); else { p.close(); paneWatchers.delete(id); } }, 300);
    });
    w.on('error', () => { paneWatchers.get(id)?.close(); paneWatchers.delete(id); });
    paneWatchers.set(id, { close: () => w.close() });
  } catch (e) { log('pane watch failed', { id, error: (e as Error).message }); }
}

// ---- Ask cards: each worker question or escalation shows as a card with its options as buttons (asks.ts) ----
const storyOf = (dispatch: string | null) => dispatch ? mergedWork().rows.find(r => r.dispatch === dispatch)?.title : undefined;
// A card shows a picture only from the folders /image serves.
const cardOf = (i: Item | undefined): AskCard | undefined => i && askCard(i, storyOf(i.dispatch_id), p => Boolean(imageFile(p, IMAGE_ROOTS)));
/** Sends the card's new state (sending, answered, open again) to every open page. */
function askChanged(id: string) {
  const ask = cardOf(store.item(id));
  if (ask) broadcast({ type: 'ask', ask });
}

function brief(): string {
  const items = store.openItems();
  const pending = store.pendingApprovals();
  const emails = store.openEmails();
  const outbox = store.openOutbox();
  const turns = store.recentTurns(16).filter(t => t.role === 'owner' || t.role === 'jarvis');
  return [
    `[session start ${new Date().toISOString()}] State brief, built by jarvisd. Do not answer it; reply SILENT unless something below needs ${OWNER} now.`,
    `Use jarvis-act for anything that needs ${OWNER}'s yes.`,
    items.length ? `Open asks waiting for ${OWNER}:\n${items.map(fmtItem).join('\n')}` : 'No open asks.',
    nativeLines(native.list()),
    emails.length ? `Emails waiting for ${OWNER} (last 3 days):\n${emails.map(fmtEmail).join('\n')}` : '',
    outbox.length ? `Messages ${OWNER} still has to send himself (each is a card under Messages until he taps Done):\n${outbox.map(outboxLine).join('\n')}` : '',
    todayBrief(store.todayItems()),
    migrationBrief(migration.state().people),
    repliesBrief(store.openSupportReplies()),
    pending.length ? `Proposals waiting for ${OWNER}'s yes:\n${pending.map(fmtApproval).join('\n')}` : '',
    turns.length ? `Recent conversation:\n${turns.map(t => `${t.role}: ${t.text.slice(0, 400)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** The native workers for the brief: these names may message the brain; any other sender is ignored. */
function nativeLines(ws: NativeWorker[]): string {
  const live = ws.filter(w => w.state !== 'abandoned' && Date.now() - Date.parse(w.updated_at) < 24 * 3_600_000);
  if (!live.length) return 'No native (Claude Code sessions jarvisd runs) workers running. worker-start, question and side chats start one.';
  return `Native workers (Claude Code sessions jarvisd runs; only these names may message you, answer with jarvis-native reply --worker <name>):\n${live.map(w => `- [native] name=${w.name} worker=${ROW_PREFIX}${w.id} state=${w.state}${w.waiting_for ? ` waiting_for=${JSON.stringify(w.waiting_for)}` : ''}${w.outcome ? ` outcome=${w.outcome}` : ''}${w.report ? ` last_report=${JSON.stringify(w.report.slice(0, 200))}` : ''}`).join('\n')}`;
}
function fmtItem(i: Item): string {
  if (isBrainAsk(i)) return brainAskLine(i);
  const opts = i.options ? ` options=${i.options}` : '';
  return `- [${i.kind}]${i.status === 'replying' ? ' status=replying (a reply may already have gone out; check request-show)' : ''} message_id=${i.external_id} dispatch=${i.dispatch_id ?? '?'} subject=${JSON.stringify(i.subject)} body=${JSON.stringify(i.body)}${opts}`;
}
function fmtEmail(i: Item): string {
  const m = JSON.parse(i.meta ?? '{}') as EmailMeta;
  return `- [email] item=${i.external_id} from=${JSON.stringify(m.fromName ? `${m.fromName} <${m.from}>` : m.from)} lang=${m.lang} urgent=${m.urgent} needsReply=${m.needsReply} subject=${JSON.stringify(i.subject)} summary=${JSON.stringify(i.body)} draft=${JSON.stringify(m.reply)}`;
}
const fmtApproval = (a: Approval) => `- #${a.id} ${a.action} ${JSON.stringify(a.say)} status=${a.status}${a.result ? ` result=${a.result}` : ''}`;

const brain = new Brain({
  cwd: join(ROOT, 'vault'),
  env: {
    ...cleanEnv,
    PATH: `${join(ROOT, 'bin')}:${process.env.PATH}`,
    JARVIS_URL: `http://127.0.0.1:${PORT}`,
  },
  // vault/owner.md is optional and never committed: private facts CLAUDE.md leaves generic (the owner's name, the product's real names).
  systemPrompt: () => 'You are Jarvis. Your working directory is the vault; read CLAUDE.md there first.'
    + (existsSync(OWNER_NOTE) ? `\n\n${readFileSync(OWNER_NOTE, 'utf8').trim()}` : ''),
  brief,
  model: readBrainModel(store.getState),
  // A jarvisd restart resumes the same conversation when the reset rule allows it (brain.ts startFirst).
  saved: readSavedSession(store.getState),
  save: s => store.setState(SESSION_KEY, s ? JSON.stringify(s) : ''),
});
// The proposals of a turn get Approve and Reject on the reply that asks for them (chatlink.ts).
const chatLinks = makeChatLinks(store);
const linkReply = (turnId: number | undefined) => { for (const a of chatLinks.replied(turnId)) broadcast({ type: 'approval', approval: a }); };
brain.on('reply', (raw: string, usage: any, turns: number[]) => {
  store.addTurn({ role: 'jarvis-usage', text: usage.is_error ? 'error' : '', ...usage });
  if (!usage.is_error) store.settleTurns(turns);
  if (!raw || raw === 'SILENT') return linkReply(undefined);
  const { urgent: isUrgent, text } = urgent(raw);
  linkReply(say('jarvis', text));
  if (isUrgent) notify({ title: 'Jarvis', body: unmarked(text).trim().slice(0, 180), url: '/', tag: `urgent-${Date.now()}` }, { urgent: true });
});
// One stored row per turn, the same way as jarvis-usage. The chat gets only the duration; the steps load when the owner opens the row.
brain.on('worked', (w: { steps: unknown[]; ms: number }) => {
  const id = store.addTurn({ role: 'jarvis-work', text: JSON.stringify(w) });
  broadcast({ type: 'fold', id, ms: w.ms, at: new Date().toISOString() });
});
// A turn a worker's SendMessage started. An ask with options becomes an ask card, and the brain's words are spoken as
// its answer. A notice is a status line in the chat with nothing to answer. An ask with no options goes back to the worker.
brain.on('worker', (raw: string, usage: any, peer: PeerMessage | undefined) => {
  store.addTurn({ role: 'jarvis-usage', text: usage.is_error ? 'error' : '', ...usage });
  const r = routeWorkerTurn({ native, store, log }, peer, raw);
  if (r.item) { const card = cardOf(r.item); broadcast({ type: 'event', text: `[native question] ${r.worker!.name}: ${peer!.text}`, at: new Date().toISOString(), asks: card ? [card] : [] }); publishWork(); }
  if (r.notice) {
    const line = `[worker event] ${r.worker!.name}: ${r.notice}`;
    store.addTurn({ role: 'event', text: line });
    broadcast({ type: 'event', text: line, at: new Date().toISOString() });
    publishWork();
  }
  if (r.refusal) {
    const w = r.worker!;
    native.reply(w.id, r.refusal, 'jarvis')
      .then(x => log('native ask without options: sent back', { worker: w.id, ok: x.ok, ...(x.ok ? {} : { error: x.error }) }))
      .catch(e => log('native ask without options: send back failed', { worker: w.id, error: String(e) }));
  }
  linkReply(r.speak ? say('jarvis', urgent(raw).text) : undefined);
});
brain.on('working', (on: boolean) => { if (on) chatLinks.turnStarted(); broadcast({ type: 'working', on }); });
brain.on('notice', (s: string) => say('jarvis', s));
brain.on('log', log);
brain.on('model', () => broadcast({ type: 'brain', brain: brainInfo() }));
/** A gate button's outcome: a failure or an unknown result wakes the brain at once, anything else waits for the next turn. */
function gateNotice(a: Approval, text: string) {
  if (gateFailed(a.status)) brain.send(text); else brain.hold(text);
}
const brainInfo = () => ({ ...brain.status(), models: MODELS, efforts: EFFORTS });

/** the owner's message. `replyTo` is the turn he answers (the reply button or swipe); its quote goes to the brain in front of his words. */
function fromOwner(text: string, replyTo?: number) {
  const quoted = replyTo ? store.turn(replyTo) : undefined;
  const quote = quoteOf(quoted);
  if (replyTo && !quote) log('reply: quoted turn not found, sent without the quote', { replyTo });
  const turn = say('owner', text, quote);
  if (existsSync(KILL_FILE)) {
    store.settleTurns([turn]);
    say('jarvis', 'Kill switch is on (data/KILL). Chat only, the brain is off.');
    return;
  }
  // The prompt rule alone lost to earlier French turns; tag each message with its language.
  brain.send(`${quote ? `${quoteLine({ ...quote, text: quoted!.text })}\n` : ''}[${OWNER_CAP}, in ${detectLang(text.replace(IMAGE_MARKER, ' ')) === 'fr' ? 'French: answer in French' : 'English: answer in English'}] ${text}`, turn);
}

// ---- Scheduled tasks screen: launchd jobs and jarvisd's own timers, read fresh each time (tasks.ts) ----
const tasks = makeTasks({
  db: store.db, run: execRun(cleanEnv), uid: process.getuid?.() ?? 501, log, getState: store.getState, setState: store.setState,
  agentsDir: join(homedir(), 'Library', 'LaunchAgents'),
  prefixes: (process.env.JARVIS_LAUNCHD_PREFIXES || 'io.autoroot.,com.fbm.').split(',').filter(Boolean),
  locked: [process.env.JARVIS_LAUNCHD_LABEL || 'io.autoroot.jarvis'],
  jarvisd: [
    { id: 'jarvisd:check', name: 'Ten-minute check', schedule: 'Every 10 minutes, 8 AM to 4 PM', everyMs: CHECK_MS, description: 'Wakes the brain on a new finding or a due reminder, and sends approved support replies.' },
    { id: 'jarvisd:today', name: 'Today list backstop', schedule: `Every ${BACKSTOP_MS / 60_000} minutes`, everyMs: BACKSTOP_MS, description: 'Catches Today items that an event missed.' },
    ...(process.env.JARVIS_GMAIL !== 'off' ? [{ id: 'jarvisd:gmail', name: 'Gmail watcher', schedule: `Every ${GMAIL_POLL_MS / 60_000} minutes`, everyMs: GMAIL_POLL_MS, description: 'Reads new mail from the people in vault/people.md and stores it.' }] : []),
  ],
});
const sampleTasks = () => { if (!existsSync(KILL_FILE)) tasks.sample().catch(e => log(`tasks: sample failed: ${e}`)); };
setInterval(sampleTasks, 60_000);
sampleTasks();

// ---- Gmail: mail from people in vault/people.md (rules in gmail.ts). JARVIS_GMAIL=off turns it off. ----
if (process.env.JARVIS_GMAIL !== 'off') watchGmail({
  onPoll: error => tasks.record('jarvisd:gmail', error ? 'fail' : 'ok', error ? `Poll failed: ${error.slice(0, 300)}` : undefined),
  store, gws, llm: haiku, log, killFile: KILL_FILE, people: readPeople(join(ROOT, 'vault', 'people.md')),
  onItem: (i, meta) => {
    const text = fmtEmail(i);
    store.addTurn({ role: 'event', text });
    broadcast({ type: 'event', text, at: new Date().toISOString() });
    messagesChanged();
    if (meta.urgent && i.pushes === 0) {
      notify(emailPush(i, meta), { urgent: meta.urgent, item: i.external_id })
        .then(n => { if (n > 0) store.markPushed(i.external_id); }, e => log(`push: ${e}`, { item: i.external_id }));
    }
    if (!existsSync(KILL_FILE)) brain.send(`[gmail event] New email:\n${text}`);
  },
  onTrouble: m => say('jarvis', m),
}).catch(e => { log(`gmail watcher stopped: ${e}`); say('jarvis', `My Gmail watcher stopped: ${e}`); });
// Open emails stored before reply all have no To/Cc: read them once, so the card shows who a reply goes to.
if (process.env.JARVIS_GMAIL !== 'off') (async () => {
  for (const i of store.openEmails(null)) {
    const m = JSON.parse(i.meta ?? '{}') as Partial<EmailMeta>;
    if (Array.isArray(m.to) && Array.isArray(m.cc)) continue;
    try { await withRecipients(store, gws, i.external_id, log); }
    catch (e) { log(`gmail recipients not read: ${(e as Error).message}`, { item: i.external_id }); }
  }
  messagesChanged();
})();

// ---- Push: pushes held for quiet hours, then open asks and escalations the owner has not answered (rules in push.ts) ----
let sweeping = false;
setInterval(async () => {
  if (sweeping || existsSync(KILL_FILE)) return;
  sweeping = true;
  try { await flushHeldPushes(); await pushOpenAsks(store, notify); } catch (e) { log(`push sweep: ${e}`); } finally { sweeping = false; }
}, 30_000);

// ---- Ten-minute check, 8 AM to 4 PM Eastern: reads the state in code, wakes the brain only on a new finding or a due reminder (rules in check.ts) ----
// Pending support replies are a step of that check: each goes out once its fix is in production (rules in replies.ts).
const replies = makeReplies({ store, log, api: gh, worker: makeTicketWorker({ dataDir: join(ROOT, 'data') }), wake: text => brain.send(text), paused: () => existsSync(KILL_FILE) });
replies.recover();
const check = makeCheck({ store, poll: async () => nativeWork(), requests, delivery: () => readDelivery(ROOT), running: startCommit, brainBusy: () => brain.busy, wake: text => brain.send(text), paused: () => existsSync(KILL_FILE), replies: () => replies.tick(), log });
setInterval(() => {
  check.tick().then(r => { if (r) tasks.record('jarvisd:check', 'ok'); },
    e => { log(`check: ${e}`); tasks.record('jarvisd:check', 'fail', String(e).slice(0, 300)); });
}, CHECK_MS);
check.start();

// ---- Today list: The owner's thoughts, worked up in code-decided passes. Nothing outward without his tap (rules in today.ts) ----
const today = makeToday({
  store, gate, log, repos,
  wake: text => brain.send(text),
  paused: () => existsSync(KILL_FILE),
  onChange: () => broadcast({ type: 'today', today: today.list() }),
  discuss: words => fromOwner(`Let's talk about this one from my Today list: ${words}`),
  released: i => { if (i.dispatch && !existsSync(KILL_FILE)) brain.send(`[today] ${OWNER} released item ${i.id}, dispatch ${i.dispatch}. Close the loop on its worker and branch ("Today list" in CLAUDE.md). Reply SILENT unless something needs him.`); },
});
todayReady = true;
setInterval(() => {
  if (existsSync(KILL_FILE)) return;
  today.tick().then(() => tasks.record('jarvisd:today', 'ok'), e => { log(`today timer: ${e}`); tasks.record('jarvisd:today', 'fail', String(e).slice(0, 300)); });
}, BACKSTOP_MS);
today.pass('daemon started').catch(e => log(`today pass: ${e}`));

// ---- HTTP ----
async function readBody(req: http.IncomingMessage, limit = 1e6): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('too large'); chunks.push(c); }
  return Buffer.concat(chunks);
}
const json = async (req: http.IncomingMessage) => { const b = (await readBody(req)).toString(); return b ? JSON.parse(b) : {}; };
function send(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** Repos a side chat can start in: the `- Repo:` line of each card in vault/projects. */
function repos(): { name: string; path: string }[] {
  const dir = join(ROOT, 'vault', 'projects');
  return readdirSync(dir).filter(f => f.endsWith('.md')).flatMap(f => {
    const m = readFileSync(join(dir, f), 'utf8').match(/^- Repo: `(\/[^`]+)`/m);
    return m ? [{ name: f.replace(/\.md$/, ''), path: m[1] }] : [];
  });
}

// Routes that act as the owner. They need the secret of an open app page (access.ts).
const AS_OWNER = new Set(['/api/ask/answer', '/api/requests/hide', '/api/send', '/api/voice', '/api/upload', '/api/approval', '/api/approval/undo', '/api/work/side-chat', '/api/work/open', '/api/work/desktop', '/api/work/phone', '/api/work/steer', '/api/work/stop', '/api/work/hide', '/api/today/add', '/api/today/act', '/api/today/voice', '/api/migration/add', '/api/migration/act', '/api/migration/dealer', '/api/migration/toast-close', '/api/message/send', '/api/message/handled', '/api/tasks/save', '/api/tasks/hide', '/api/tasks/ask-fix']);
const ui = makeUiSessions();

// ---- Project terminals from the new-session picker: tmux sessions, Touch ID on the Mac, the phone checks on the phone (terminal.ts, termgate.ts) ----
const termGate = makeTermGate({ store, log });
let termKey = '';
async function pollTerms() {
  const key = JSON.stringify(await terms.list().catch(() => terms.current()));
  if (key !== termKey) { termKey = key; publishWork(); }
}
setInterval(() => { pollTerms().catch(() => {}); }, 15_000);
pollTerms().catch(() => {});
const termCtx = {
  terms, gate: termGate, log, uiOk: (h: http.IncomingHttpHeaders) => ui.ok(h), repos,
  onChange: () => { pollTerms().catch(() => {}); },
  phoneRefusal: async (req: http.IncomingMessage) => phoneRefusal(await probePhone(req, PORT)),
};
const IMAGE_ROOTS = imageRoots(ROOT);
const REPORTS_DIR = reportsDir(ROOT);

// The routes' context: what each concept route needs from the rest of jarvisd.
const brainModelCtx = {
  brain, setState: store.setState, killed: () => existsSync(KILL_FILE), info: brainInfo,
  changed: () => { log('brain model set', { model: brain.setting.model, effort: brain.setting.effort }); broadcast({ type: 'brain', brain: brainInfo() }); },
};
const messagesCtx = {
  messages,
  approved: (a: Approval) => { if (!existsSync(KILL_FILE)) gateNotice(a, `[gate] ${OWNER} approved #${a.id} with the button. ${a.result ? `Result: ${a.result}` : ''} Tell him the outcome in one short sentence if it failed or needs follow-up, otherwise SILENT.`); },
  handled: (id: string) => { if (!existsSync(KILL_FILE)) brain.hold(`[gate] ${OWNER} pressed "${id.startsWith('outbox:') ? 'Done' : "I'll handle it"}" on ${id}. It left the brief. Reply SILENT.`); },
};

http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (!allowed(req.headers)) { log(`refused ${req.headers['tailscale-user-login'] ?? 'no login'} ${req.headers['x-forwarded-for'] ?? ''} ${url}`); return send(res, 403); }
  if (req.method === 'POST' && AS_OWNER.has(url) && !ui.ok(req.headers)) {
    log(`refused ${url}: no open app page`);
    return send(res, 401, { error: 'Only the open Jarvis app can do this. Reload the page and try again.' });
  }
  try {
    if (url.startsWith('/api/term/')) return await termRoute(termCtx, req, res, url);
    // Each concept owns its routes. A route answers for the URLs it owns and returns undefined for any other.
    const method = req.method ?? '', body = lazyBody(() => json(req)), query = new URL(req.url ?? '/', 'http://x').searchParams;
    const post = async () => method === 'POST' ? await body() : {};
    const owner = { fromOwner: () => brain.answeringOwner };
    const routes: (() => Promise<RouteResult | undefined> | RouteResult | undefined)[] = [
      // A native worker's hooks (from its settings file) and the brain's jarvis-native commands.
      async () => url.startsWith('/api/hooks/') || url.startsWith('/api/internal/native/') ? nativeRoute({ native, store, log, askChanged }, method, url, await post()) : undefined,
      () => reportsRoute(REPORTS_DIR, method, url, query),
      () => brainModelRoute(brainModelCtx, method, url, body),
      () => messagesRoute(messagesCtx, method, url, body),
      () => pushRoute({ store, publicKey: vapid.publicKey, log, notify }, method, url, body, String(req.headers['user-agent'] ?? '')),
      () => requestsRoute({ requests, store }, method, url, body),
      () => brainAskRoute({ store, log, changed: askChanged }, method, url, body),
      // The Scheduled tasks screen (tasks.ts).
      () => url.startsWith('/api/tasks') ? tasksRoute(tasks, method, url, body, text => fromOwner(text)) : undefined,
      async () => url === '/api/today' || url.startsWith('/api/today/') || url.startsWith('/api/internal/today') ? todayRoute(today, method, url, await post(), owner) : undefined,
      async () => url === '/api/migration' || url.startsWith('/api/migration/') || url.startsWith('/api/internal/migration') ? migrationRoute(migration, method, url, await post()) : undefined,
      async () => url.startsWith('/api/internal/replies') ? replyRoute(store, log, method, url, await post(), owner) : undefined,
      async () => url.startsWith('/api/internal/reminders') ? reminderRoute(store, log, method, url, await post()) : undefined,
    ];
    for (const route of routes) { const r = await route(); if (r) return send(res, r.status, r.body); }
    if (req.method === 'GET' && STATIC[url]) {
      const file = join(ROOT, 'web', STATIC[url]);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(readFileSync(file));
    }
    if (req.method === 'GET' && /^\/audio\/[\w-]+\.m4a$/.test(url)) {
      const file = join(voice.dir, url.slice('/audio/'.length));
      if (!existsSync(file)) return send(res, 404);
      return sendClip(req, res, file);
    }
    // One sentence of a message from Jarvis, rendered on first request. The speaker button under the message plays these.
    const clip = req.method === 'GET' ? /^\/api\/speech\/(\d+)\/(\d+)$/.exec(url) : null;
    if (clip) {
      const s = spokenSentences(store.jarvisText(Number(clip[1])) ?? '')[Number(clip[2])];
      if (!s) return send(res, 404);
      const name = await voice.tts(s);
      noteSpoken(s); // the echo guard must know these words too, or the open mic takes a replay for the owner
      return sendClip(req, res, join(voice.dir, name));
    }
    // Images named in Jarvis's `[image: ...]` markers, only from the folders in images.ts.
    if (req.method === 'GET' && url === '/image') {
      const file = imageFile(new URL(req.url ?? '/', 'http://x').searchParams.get('path') ?? '', IMAGE_ROOTS);
      if (!file) return send(res, 404);
      res.writeHead(200, { 'content-type': IMAGE_TYPES[extname(file).toLowerCase()], 'cache-control': 'private, max-age=300' });
      return createReadStream(file).pipe(res);
    }
    // Voice samples for picking the TTS model by ear (data/bakeoff/*.m4a).
    if (req.method === 'GET' && url === '/bakeoff') {
      const dir = join(ROOT, 'data', 'bakeoff');
      const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.m4a')).sort() : [];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:12px">
        <h3>TTS bake-off</h3>${files.map(f => `<p>${f}<br><audio controls preload="none" src="/bakeoff/${f}"></audio></p>`).join('')}`);
    }
    if (req.method === 'GET' && /^\/bakeoff\/[\w.-]+\.m4a$/.test(url)) {
      const file = join(ROOT, 'data', 'bakeoff', url.slice('/bakeoff/'.length));
      if (!existsSync(file)) return send(res, 404);
      res.writeHead(200, { 'content-type': 'audio/mp4' });
      return createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const history = store.recentTurns(80).filter(t => t.role === 'owner' || t.role === 'jarvis' || t.role === 'event' || t.role === 'jarvis-work')
        .map(t => t.role === 'jarvis-work' ? { id: t.id, role: t.role, text: '', ms: JSON.parse(t.text).ms, created_at: t.created_at }
          : t.role === 'jarvis' ? { ...t, clips: spokenSentences(t.text).length }
          : t.reply_to ? { ...t, quote: quoteOf(store.turn(t.reply_to)) } : t);
      const secret = ui.open();
      res.write(`data: ${JSON.stringify({ type: 'history', turns: history, busy: brain.busy, approvals: store.pendingApprovals(), work: mergedWork(), hidden: hiddenIds(), requests: requests.list(), asks: store.recentAsks().map(cardOf).filter(Boolean), audit: auditEntries(store, cardOf, PRESSED, 60), messages: messages.list(), today: today.list(), migration: migration.state(), brain: brainInfo(), session: secret })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); ui.close(secret); termGate.dropPage(secret); });
      return;
    }
    if (req.method === 'POST' && url === '/api/send') {
      const { text, replyTo } = await json(req);
      if (typeof text !== 'string' || !text.trim()) return send(res, 400);
      fromOwner(text.trim(), replyIdOf(replyTo));
      return send(res, 204);
    }
    // A picture the owner attached. The reply is the saved path; the page then sends it as an `[image: ...]` line.
    if (req.method === 'POST' && url === '/api/upload') {
      if (Number(req.headers['content-length']) > UPLOAD_LIMIT) return send(res, 413, { error: 'larger than 10 MB' });
      let body: Buffer;
      try { body = await readBody(req, UPLOAD_LIMIT); } catch { return send(res, 413, { error: 'larger than 10 MB' }); }
      const r = saveUpload(body, uploadDir(ROOT));
      if ('error' in r) return send(res, r.status, { error: r.error });
      log(`upload ${r.path} ${body.length} bytes`);
      return send(res, 200, r);
    }
    // Hands-free: the browser's detector settings (env overrides of web/listen.js DEFAULTS).
    if (req.method === 'GET' && url === '/api/listen/config') return send(res, 200, { client: listen.client, wakeWord: listen.wakeWords.length > 0 });
    if (req.method === 'POST' && url === '/api/voice') {
      const audio = await readBody(req, 20e6);
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const hands = q.get('mode') === 'listen', bargeIn = q.get('barge') === '1';
      // The pictures attached in the chat box go with the words (web/compose.js). Only files /api/upload saved pass.
      const pics = pictureLines(q.getAll('image'), uploadDir(ROOT));
      if (pics.refused.length) log('voice: picture refused, not an upload', { paths: pics.refused });
      const t0 = Date.now();
      const r = await voice.stt(audio, hands ? { threshold: listen.vadThreshold, minSpeechMs: listen.vadMinSpeechMs } : undefined);
      if (r.vadError) log(`listen: vad failed, transcribing anyway: ${r.vadError}`);
      if (!hands) {
        log(`stt ${Date.now() - t0} ms conf=${r.confidence.toFixed(2)}${pics.lines.length ? ` pictures=${pics.lines.length}` : ''}: ${r.text}`);
        // Text the owner typed before he tapped the mic goes in front of the words, and the pictures after them, as one
        // message (web/dictate.js).
        const message = voiceMessage(q.get('typed'), r.text, pics.lines);
        if (message) fromOwner(message, replyIdOf(q.get('replyTo')));
        return send(res, 200, { text: r.text, confidence: r.confidence, sent: !!message });
      }
      if (!r.speech) { log(`listen: no speech (${Date.now() - t0} ms, ${audio.length} bytes)`); return send(res, 200, { text: '', kept: false, why: 'no speech' }); }
      const now = Date.now();
      const v = judge({ text: r.text, bargeIn, now, lastSpokeAt, lastAddressedAt, recentSpoken: spoken.filter(x => now - x.at <= listen.windowMs).map(x => x.text) }, listen);
      // A dropped clip is often someone else talking; its words stay out of the log unless JARVIS_LISTEN_DEBUG=1.
      log(`listen ${Date.now() - t0} ms conf=${r.confidence.toFixed(2)} ${v.keep ? 'kept' : 'dropped'} (${v.why})${bargeIn ? ' barge-in' : ''}: ${v.keep || listen.debug ? r.text : `${r.text.split(/\s+/).filter(Boolean).length} words`}`);
      if (!v.keep) return send(res, 200, { text: '', kept: false, why: v.why });
      lastAddressedAt = now;
      fromOwner(withPictures(r.text, pics.lines));
      return send(res, 200, { text: r.text, confidence: r.confidence, kept: true, why: v.why });
    }
    // the owner tapped an option on an ask card: it goes to the worker at once, as if he had said it.
    if (req.method === 'POST' && url === '/api/ask/answer') {
      const { id, value } = await json(req);
      if (typeof id !== 'string' || typeof value !== 'string') return send(res, 400, { error: 'id and value are required' });
      const r = await answerAsk({ id, value: value.trim(), store, log, native, note: n => { if (!existsSync(KILL_FILE)) brain.hold(n); } });
      askChanged(id);
      if (r.status === 200) { publishWork(); nativeSync().catch(() => {}); }
      return send(res, r.status, { error: r.error, ask: cardOf(store.item(id)) });
    }
    if (req.method === 'POST' && url === '/api/approval') {
      const { id, approve } = await json(req);
      // A native worker's permission prompt: the tap answers the held hook, and the worker goes on or is refused.
      if (store.approval(Number(id))?.action === WORKER_PERMISSION) {
        const r = native.decide(Number(id), approve === true);
        const a = store.approval(Number(id))!;
        if (!r.ok) return send(res, 409, { error: r.error, approval: a });
        if (!existsSync(KILL_FILE)) brain.hold(`[gate] ${OWNER} ${approve ? 'allowed' : 'denied'} permission #${a.id} with the button; the worker ${approve ? 'goes on' : 'was refused and goes on without it'}. Reply SILENT.`);
        return send(res, 200, a);
      }
      let a: Approval;
      try { a = await gate.button(Number(id), approve === true); }
      catch (e) { return send(res, 409, { error: (e as Error).message, approval: store.approval(Number(id)) }); }
      // The kill switch holds here too: this was the one send that woke the brain while data/KILL was on (found 2026-11-07 by a test daemon).
      if (!existsSync(KILL_FILE)) gateNotice(a, `[gate] ${OWNER} ${approve ? 'approved' : 'rejected'} #${a.id} with the button. ${a.result ? `Result: ${a.result}` : ''} Tell him the outcome in one short sentence if it failed or needs follow-up, otherwise SILENT.`);
      return send(res, 200, a);
    }
    // Stop on a started notice: the owner takes back a worker Jarvis started at once, within UNDO_MS.
    if (req.method === 'POST' && url === '/api/approval/undo') {
      const { id } = await json(req);
      let a: Approval;
      try { a = await gate.undo(Number(id)); }
      catch (e) { return send(res, 409, { error: (e as Error).message, approval: store.approval(Number(id)) }); }
      const queued = a.id === Number(id);
      if (!existsSync(KILL_FILE)) brain.send(`[gate] ${OWNER} pressed Stop on #${id}, the worker you started at once, within ${UNDO_MS / 1000} seconds. ${queued ? 'It stops as soon as its start ends.' : `Stop #${a.id}: ${a.status}${a.result ? `, ${a.result}` : ''}.`} He does not want it as it was. Ask him in one short sentence what to change, unless he already said.`);
      return send(res, 200, a);
    }
    // The microphone in the Today popup: the words become one item, and nothing goes to the chat.
    if (req.method === 'POST' && url === '/api/today/voice') {
      const audio = await readBody(req, 20e6);
      const r = await voice.stt(audio);
      log(`today voice conf=${r.confidence.toFixed(2)}: ${r.text}`);
      if (!r.text) return send(res, 200, { words: '', today: today.list() });
      const added = today.add({ words: r.text, go: new URL(req.url ?? '/', 'http://x').searchParams.get('go') === '1' });
      return send(res, added.status, { words: r.text, ...added.body });
    }
    // The audit log panel: answered asks and decided approvals. Read-only.
    if (req.method === 'GET' && url === '/api/audit') return send(res, 200, auditEntries(store, cardOf, PRESSED));
    // ---- Work list ----
    if (req.method === 'GET' && url === '/api/work') return send(res, 200, { ...mergedWork(), hidden: hiddenIds(), repos: repos(), product: { key: PRODUCT_KEY, label: PRODUCT_LABEL }, owner: { called: OWNER, cap: OWNER_CAP } });
    // Hide or show a row in the app. Only the list of hidden ids changes.
    if (req.method === 'POST' && url === '/api/work/hide') {
      const { id, hidden } = await json(req);
      if (typeof id !== 'string' || !id) return send(res, 400, { error: 'id is required' });
      const ids = new Set(hiddenIds());
      ids.delete(id);
      if (hidden !== false) ids.add(id);
      // The newest 500 are kept, so the list cannot grow forever.
      const next = [...ids].slice(-500);
      store.setState('workHidden', JSON.stringify(next));
      broadcast({ type: 'hidden', hidden: next });
      return send(res, 200, { hidden: next });
    }
    // One "Worked for" row's steps, read when the owner opens it.
    const fold = req.method === 'GET' && url.match(/^\/api\/fold\/(\d+)$/);
    if (fold) {
      const text = store.workSteps(Number(fold[1]));
      return text ? send(res, 200, { steps: JSON.parse(text).steps }) : send(res, 404, { error: 'Not found' });
    }
    // The transcript pane: messages after `cursor` from a listed worker or session. Read-only.
    const read = req.method === 'GET' && url.match(/^\/api\/work\/([^/]+)\/read$/);
    // A request with no listed conversation (`req:<id>`): what Jarvis recorded, then the worker's transcript if it is found.
    const closed = read && /^req:(\d+)$/.exec(decodeURIComponent(read[1]));
    if (closed) {
      const cursor = new URL(req.url ?? '/', 'http://x').searchParams.get('cursor') || undefined;
      const r = await requests.read(Number(closed[1]), cursor, chatFiles, () => { try { return readFileSync(join(ROOT, 'data', 'jarvisd.log'), 'utf8'); } catch { return ''; } });
      return r ? send(res, 200, r) : send(res, 404, { error: 'Jarvis has no record of it.' });
    }
    if (read && decodeURIComponent(read[1]).startsWith(ROW_PREFIX)) {
      // A native worker: its own JSONL on disk. Replies in it are the typed lines (interactive) or the
      // cross-session messages (relay); jarvisd's own events (a resume) are gap lines; `busy` is the session's state.
      const id = decodeURIComponent(read[1]);
      const w = native.get(id);
      const file = native.transcriptFile(id);
      if (!w) return send(res, 404, { error: 'It is not in the work list any more.' });
      const busy = w.state === 'working' || w.state === 'starting';
      if (!file) return send(res, 200, { lines: [], busy, error: 'No transcript yet: the worker has not written its first turn.' });
      const cursor = new URL(req.url ?? '/', 'http://x').searchParams.get('cursor') || undefined;
      watchPane(id, file);
      try { return send(res, 200, { ...withEvents(readChatFile(file, fileCursor(cursor)), store.eventsFor(id), cursor), busy }); }
      catch (e) { return send(res, 200, { lines: [], busy, error: `Transcript unreadable: ${(e as Error).message}` }); }
    }
    if (read) return send(res, 404, { error: 'It is not in the work list any more.' });
    // the owner pressed Side chat: a normal working session in the chosen repo's main checkout, no yes needed.
    if (req.method === 'POST' && url === '/api/work/side-chat') {
      // From the new-session picker there is no first message (The owner types it in the conversation that opens) and Worktree may be on.
      const { repo, text = '', worktree } = await json(req);
      const card = repos().find(r => r.path === repo);
      if (typeof text !== 'string' || !card) return send(res, 400, { error: 'pick a project' });
      const first = text.trim();
      const a = await gate.pressed('side-chat', { repo, text: first, ...(worktree === true ? { worktree: true } : {}) }, `Side chat: ${(first || `new in ${card.name}`).slice(0, 80)}`);
      return send(res, a.status === 'done' ? 200 : 502, a);
    }
    // The steer box under the transcript. A native worker gets the words at once.
    if (req.method === 'POST' && url === '/api/work/steer') {
      const { id, text } = await json(req);
      const row = mergedWork().rows.find(r => r.id === id);
      if (!row || typeof text !== 'string') return send(res, 404, { error: 'It is not in the work list any more.' });
      if (!row.native) return send(res, 409, { error: 'Only a native worker takes a message here.' });
      // the owner's words go straight into the background session (respawned first if its process was stopped).
      if (!text.trim()) return send(res, 400, { error: 'Write a message first.' });
      const r = await native.reply(row.native.id, text.trim(), 'owner');
      if (!r.ok) return send(res, 502, { error: r.error });
      const a = store.addApproval({ action: 'session-type', args: JSON.stringify({ worker: row.id, text: text.trim() }), say: `Message to "${row.title.slice(0, 60)}"` });
      store.decide(a.id, 'approved', 'button', text.trim()); store.finishApproval(a.id, 'done', 'sent');
      const open = store.openItems().filter(i => i.source === 'native' && i.dispatch_id === row.id);
      for (const i of open) { store.markItem(i.external_id, 'answered', text.trim()); askChanged(i.external_id); }
      if (!existsSync(KILL_FILE)) brain.send(`[work list] ${OWNER} sent native worker ${row.native.name} (${row.id}) a message himself from the work list: ${JSON.stringify(text.trim())}.${open.length ? ' That answers its open question.' : ''} Reply SILENT.`);
      publishWork();
      nativeSync().catch(() => {}); // a request that was Done goes back to Working now, not at the next poll (requests.ts)
      return send(res, 200, { done: 'sent' });
    }
    if (req.method === 'POST' && url === '/api/work/stop') {
      const { id } = await json(req);
      const row = mergedWork().rows.find(r => r.id === id);
      if (!row) return send(res, 404, { error: 'It is not in the work list any more.' });
      const r = await stop(row, gate);
      return send(res, r.status, r.body);
    }
    // Opens a Terminal window on the Mac, attached to a native worker's session.
    if (req.method === 'POST' && url === '/api/work/open') {
      const { id, dispatch } = await json(req);
      const row = mergedWork().rows.find(r => r.id === (id ?? dispatch));
      if (!row?.native) return send(res, 404, { error: 'no such worker' });
      try { await native.attach(row.native.id); return send(res, 204); }
      catch (e) { return send(res, 502, { error: `Could not open Terminal: ${(e as Error).message}` }); }
    }
    // The Desktop button: stops the background session and opens the same conversation in the Claude desktop app.
    if (req.method === 'POST' && url === '/api/work/desktop') {
      const { id } = await json(req);
      const row = mergedWork().rows.find(r => r.id === id);
      if (!row?.native) return send(res, 404, { error: 'Only a native worker can open in the desktop app.' });
      try { await native.desktop(row.native.id); publishWork(); return send(res, 204); }
      catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }
    // Continue on phone: the row's own Claude session, resumed as a native interactive row with Remote Control on (native.phone).
    // `stop` lists the pids of the processes that held it, which the owner chose to end from the refusal in the pane.
    if (req.method === 'POST' && url === '/api/work/phone') {
      const { id, stop } = await json(req);
      const row = mergedWork().rows.find(r => r.id === id);
      if (!row) return send(res, 404, { error: 'It is not in the work list any more.' });
      const t = await phoneTarget(row);
      if ('error' in t) return send(res, 400, { error: t.error });
      const pids = Array.isArray(stop) ? stop.filter((p: unknown): p is number => Number.isInteger(p) && (p as number) > 1) : [];
      const a = await gate.pressed('session-phone', { session: t.sessionId, title: t.title, ...(pids.length ? { stop: pids } : {}) }, `Continue "${t.title.slice(0, 60)}" on the phone`);
      const r = await native.phone({ ...t, approvalId: a.id, stop: pids });
      gate.recorded(a.id, r.ok ? 'done' : 'failed', r.ok ? (r.already ? 'Already in the Claude app' : `Remote Control as "${r.worker.remote}" (${ROW_PREFIX}${r.worker.id})`) : r.error);
      publishWork();
      if (!r.ok) return send(res, 409, { error: r.error, holders: r.holders ?? [] });
      return send(res, 200, { id: `${ROW_PREFIX}${r.worker.id}`, remote: r.worker.remote, already: !!r.already });
    }
    // ---- Called by bin/jarvis-act and bin/jarvis-remind on behalf of the brain ----
    if (req.method === 'POST' && url === '/api/internal/answered') {
      const { id, answer } = await json(req);
      if (typeof id !== 'string' || !id) return send(res, 400, { error: 'id is required' });
      store.markItem(id, 'answered', typeof answer === 'string' ? answer : undefined);
      log('reply recorded', { item: id });
      askChanged(id); // a spoken or typed answer marks the card answered too
      if (store.item(id)?.source === 'gmail') { messages.dropProposals(id); messagesChanged(); } // jarvis-act email-done
      publishWork(); nativeSync().catch(() => {}); // the answered ask leaves "waiting" (and the Requests badge) now, not in up to 30 s
      return send(res, 204);
    }
    if (url.startsWith('/api/internal/gate/')) {
      const op = url.slice('/api/internal/gate/'.length);
      const b = req.method === 'POST' ? await json(req) : {};
      try {
        if (op === 'propose') { const a = await gate.propose(b.action, b.args, b.say, b.card, { ownerAsked: b.ownerAsked === true }); chatLinks.proposed(a); return send(res, 200, a); }
        if (op === 'revise') return send(res, 200, await gate.revise(Number(b.id), b.args, b.say, b.card));
        if (op === 'confirm') return send(res, 200, await gate.confirm(Number(b.id)));
        if (op === 'reject') return send(res, 200, gate.reject(Number(b.id)));
        if (op === 'list') return send(res, 200, store.pendingApprovals());
      } catch (e) {
        return send(res, 409, { error: (e as Error).message });
      }
    }
    send(res, 404);
  } catch (e) {
    log(`http error ${url}: ${e}`);
    send(res, 500, { error: String(e) });
  }
}).listen(PORT, '127.0.0.1', () => log(`jarvisd on http://127.0.0.1:${PORT}`));
