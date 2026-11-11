import { OWNER_CAP, OWNER, cleanEnv } from './config.ts';
import http from 'node:http';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Item, type Approval } from './store.ts';
import { Brain, readSavedSession, gateFailed, SESSION_KEY } from './brain.ts';
import { brainModelRoute, readBrainModel, MODELS, EFFORTS } from './brainmodel.ts';
import { lazyBody, type RouteResult } from './route.ts';
import { STATIC, TYPES, webVersion, versionEvent, webVersionRoute } from './webfiles.ts';
import { makeGate, gateRoute, PRESSED } from './gate.ts';
import { makeVoice, makeSpeaker, voiceRoute, voiceFileRoute, detectLang, IMAGE_MARKER, spokenSentences } from './voice.ts';
import { allowed, makeUiSessions, probePhone, phoneRefusal } from './access.ts';
import { makeTerminals } from './terminal.ts';
import { makeTermGate } from './termgate.ts';
import { termRoute } from './termroutes.ts';
import { terminalRows } from './termrows.ts';
import { imageFile, imageRoots, imageRoute } from './images.ts';
import { reportsDir, reportsRoute, reportSummary } from './reports.ts';
import { saveUpload, uploadDir, UPLOAD_LIMIT } from './uploads.ts';
import { loadVapid, pushAll, pushOpenAsks, makeNotifier, pushRoute } from './push.ts';
import { makeLog } from './log.ts';
import { watchGmail, gws, haiku, readPeople, withRecipients, POLL_MS as GMAIL_POLL_MS, type EmailMeta } from './gmail.ts';
import { makeTasks, execRun, tasksRoute } from './tasks.ts';
import { homedir } from 'node:os';
import { githubRepo, type Work } from './work.ts';
import { makeRequests, backfillRequests, requestsRoute } from './requests.ts';
import { workRoute, hiddenIds, makePaneWatcher, steerWorker } from './workroutes.ts';
import { chatLineAt } from './transcript.ts';
import { listenConfig } from './listen.ts';
import { askCard, askRoute, auditEntries, type AskCard } from './asks.ts';
import { brainAskRoute, briefLine as brainAskLine, isBrainAsk, toBrain } from './brainasks.ts';
import { makeCheck, readDelivery, masterHead, CHECK_MS } from './check.ts';
import { gitSelfCheck, gitNotice } from './gitcheck.ts';
import { reminderRoute } from './reminders.ts';
import { makeMessages, emailPush, outboxLine, messagesRoute } from './messages.ts';
import { makeToday, todayRoute, todayBrief, BACKSTOP_MS } from './today.ts';
import { makeReplies, replyRoute, repliesBrief, gh } from './replies.ts';
import { makeTicketWorker } from './replyworker.ts';
import { makeMigration, migrationRoute, migrationBrief, readDealerFile } from './migration.ts';
import { makeNative, ROW_PREFIX, type NativeWorker } from './native.ts';
import { nativeRoute } from './nativeroutes.ts';
import { quoteOf, quoteLine, replyIdOf, type Quote } from './quote.ts';
import { SERVICE_LABEL, LAUNCHD_PREFIXES } from './config.ts';
import { DEALERS_FILE, MIGRATION_SHEET_SYNC } from './config.ts';
import { makeChatLinks } from './chatlink.ts';
import { wireBrain, turnAskNote } from './brainevents.ts';
import { startNativePoll, startTaskSampler, startPushSweep, startCheck, startTodayBackstop, startTermPoll, startSheetSync } from './timers.ts';
import { syncDue, runSyncChild } from './sheetsync.ts';
import { SHEET_ID } from './sheet-edit.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER_NOTE = join(ROOT, 'vault', 'owner.md');
const PORT = Number(process.env.JARVIS_PORT ?? 7717);
const KILL_FILE = join(ROOT, 'data', 'KILL');

const store = openStore(join(ROOT, 'data', 'jarvis.db'));
const voice = makeVoice(ROOT, (msg, data) => log(msg, data));
const listen = listenConfig();
const log = makeLog();
// The commit this daemon runs. Master moving past it means a restart is pending (check.ts).
const startCommit = await masterHead(ROOT).catch(e => { log(`check: no start commit, restart findings are off: ${e}`); return undefined; });
// The web code this daemon serves. A page that loaded other code reloads itself when it connects (web/reload.js).
const WEB_VERSION = webVersion(join(ROOT, 'web'));
log(`web version ${WEB_VERSION}`);
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

// Jarvis's voice out, one sentence at a time, and what it said lately for hands-free listening (voice.ts).
const speaker = makeSpeaker({ tts: s => voice.tts(s), broadcast, log, windowMs: listen.windowMs });

function say(role: string, text: string, quote?: Quote): number {
  const turnId = store.addTurn({ role, text, reply_to: quote?.id });
  broadcast({ type: 'turn', role, text, turnId, quote, clips: role === 'jarvis' ? spokenSentences(text).length : 0, at: new Date().toISOString() });
  if (role === 'jarvis') speaker.speak(text, turnId);
  return turnId;
}

/** A report in data/reports as an ask card, a request row and a push show it. Only pictures /image serves count. */
const reportOf = (path: string) => reportSummary(path, reportsDir(ROOT), p => Boolean(imageFile(p, imageRoots(ROOT))));

// ---- Requests sidebar: one row per worker started for the owner, its status kept from the native workers' rows (requests.ts) ----
const requests = makeRequests({ store, log, repoOf: githubRepo, mergeRepo: ROOT, reportOf, onChange: list => broadcast({ type: 'requests', requests: list }) });
const backfilled = backfillRequests(store);
if (backfilled) log(`requests: backfilled ${backfilled} from earlier worker starts`);

// Set once the Today list exists, so a native sync that runs during the start (a report recovered from a transcript) waits.
let todayReady = false;
// ---- Native workers: Claude background sessions jarvisd starts itself (native.ts, nativeroutes.ts) ----
const native = makeNative({
  store, log, jarvisUrl: `http://127.0.0.1:${PORT}`, dataDir: join(ROOT, 'data'),
  onChange: () => publishWork(),
  onReport: (w, text, final, followUp) => {
    if (!final) return; // a turn that ended without DONE or FAILED is the worker asking or pausing; native.stopHook reports a silent one
    // The request and the Today row move on now, not at the next poll.
    nativeSync().catch(e => log(`native sync after a report: ${e}`));
    const line = followUp
      ? `[worker event] Native worker ${w.name} (${ROW_PREFIX}${w.id}) answered a follow-up with FAILED. Its story stays done with its earlier DONE report:\n${text}`
      : `[worker event] Native worker ${w.name} (${ROW_PREFIX}${w.id}) reported ${w.outcome}:\n${text}`;
    store.addTurn({ role: 'event', text: line });
    broadcast({ type: 'event', text: line, at: new Date().toISOString() });
    if (!existsSync(KILL_FILE)) brain.send(`${line}\n\nThis is its report, word for word. Speak it to ${OWNER} if it is an answer or a problem; a plain success is SILENT unless he asked for it. It needs no release.`);
  },
  onCard: a => {
    broadcast({ type: 'approval', approval: a });
    const args = JSON.parse(a.args);
    if (a.status === 'pending' && !existsSync(KILL_FILE)) brain.send(`[worker permission] Native worker ${args.name} wants to run ${args.tool}: ${JSON.stringify(String(args.summary).slice(0, 300))}. It waits on approval #${a.id}, a card in the app, and nothing else can answer it. Tell ${OWNER} in one sentence to tap Allow or Deny on it.`);
  },
  // An ask in the turn text that no SendMessage delivered (the brain was unreachable): the card exists, so show it and tell the brain.
  onTurnAsk: (w, item) => {
    const card = cardOf(item);
    broadcast({ type: 'event', text: `[native question] ${w.name}: ${item.body}`, at: new Date().toISOString(), asks: card ? [card] : [] });
    publishWork();
    if (!existsSync(KILL_FILE)) brain.send(turnAskNote(w, item));
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
/**
 * After every native poll and every final native report: the requests and the Today rows behind them, from the native
 * rows. Waits for `today`, which is made further down.
 */
async function nativeSync() {
  if (!todayReady) return;
  await requests.sync(nativeWork());
  today.sync();
}
startNativePoll({ poll: () => native.poll(), closeEarlier: () => closeItems(store.closeEarlierAsks(), 'an ask closed by a later answer'), sync: nativeSync, log });

// ---- Ask cards: each worker question or escalation shows as a card with its options as buttons (asks.ts) ----
const storyOf = (dispatch: string | null) => dispatch ? mergedWork().rows.find(r => r.dispatch === dispatch)?.title : undefined;
// A card shows a picture only from the folders /image serves.
const cardOf = (i: Item | undefined): AskCard | undefined => i && askCard(i, storyOf(i.dispatch_id), p => Boolean(imageFile(p, IMAGE_ROOTS)), reportOf);
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
// The brain's replies, worker turns and state, into the store, the chat and every open page (brainevents.ts).
wireBrain(brain, { store, log, broadcast, say, notify, chatLinks, native, cardOf, publish: publishWork, info: () => brainInfo(),
  tell: text => { if (!existsSync(KILL_FILE)) brain.send(text); } });
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
// The migration sheet sync needs a real sheet id (sheet-edit.ts reads JARVIS_MIGRATION_SHEET_ID) and a mode that is not off.
const SHEET_SYNC_ON = MIGRATION_SHEET_SYNC !== 'off' && SHEET_ID !== 'EXAMPLE_SHEET_ID';
const tasks = makeTasks({
  db: store.db, run: execRun(cleanEnv), uid: process.getuid?.() ?? 501, log, getState: store.getState, setState: store.setState,
  agentsDir: join(homedir(), 'Library', 'LaunchAgents'),
  prefixes: LAUNCHD_PREFIXES,
  locked: [SERVICE_LABEL],
  jarvisd: [
    { id: 'jarvisd:check', name: 'Ten-minute check', schedule: 'Every 10 minutes, 8 AM to 4 PM', everyMs: CHECK_MS, description: 'Wakes the brain on a new finding or a due reminder, and sends approved support replies.' },
    { id: 'jarvisd:today', name: 'Today list backstop', schedule: `Every ${BACKSTOP_MS / 60_000} minutes`, everyMs: BACKSTOP_MS, description: 'Catches Today items that an event missed.' },
    ...(SHEET_SYNC_ON ? [{ id: 'jarvisd:sheet-sync', name: 'Migration sheet sync', schedule: 'Every day at 7:30 AM Eastern', everyMs: 24 * 3600_000, description: `Copies the Leads list to the migration sheet through bin/sheet-edit (${MIGRATION_SHEET_SYNC === 'write' ? 'writes' : 'dry run only, writes nothing'}). Each run keeps a report in data/migration-sheet-sync/runs.` }] : []),
    ...(process.env.JARVIS_GMAIL !== 'off' ? [{ id: 'jarvisd:gmail', name: 'Gmail watcher', schedule: `Every ${GMAIL_POLL_MS / 60_000} minutes`, everyMs: GMAIL_POLL_MS, description: 'Reads new mail from the people in vault/people.md and stores it.' }] : []),
  ],
});
startTaskSampler({ sample: () => tasks.sample(), killed: () => existsSync(KILL_FILE), log });

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
startPushSweep({ flush: flushHeldPushes, openAsks: () => pushOpenAsks(store, notify, Date.now(), reportOf), killed: () => existsSync(KILL_FILE), log });

// ---- Ten-minute check, 8 AM to 4 PM Eastern: reads the state in code, wakes the brain only on a new finding or a due reminder (rules in check.ts) ----
// Pending support replies are a step of that check: each goes out once its fix is in production (rules in replies.ts).
const replies = makeReplies({ store, log, api: gh, worker: makeTicketWorker({ dataDir: join(ROOT, 'data') }), wake: text => brain.send(text), paused: () => existsSync(KILL_FILE) });
replies.recover();
const check = makeCheck({ store, poll: async () => nativeWork(), requests, delivery: () => readDelivery(ROOT), running: startCommit, brainBusy: () => brain.busy, wake: text => brain.send(text), paused: () => existsSync(KILL_FILE), replies: () => replies.tick(), log });
startCheck({ check, everyMs: CHECK_MS, record: tasks.record, log });

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
startTodayBackstop({ today, everyMs: BACKSTOP_MS, killed: () => existsSync(KILL_FILE), record: tasks.record, log });

// ---- Migration sheet sync: the Leads list to the migration sheet, once a day at 7:30 AM Eastern (sheetsync.ts) ----
if (SHEET_SYNC_ON) startSheetSync({
  mode: MIGRATION_SHEET_SYNC,
  due: () => syncDue(new Date(), store.getState('migrationSheetSyncDay')), markDay: day => store.setState('migrationSheetSyncDay', day),
  run: mode => runSyncChild(ROOT, mode, cleanEnv),
  killed: () => existsSync(KILL_FILE), record: tasks.record, wake: text => brain.send(text), log,
});

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
const pollTerms = startTermPoll({ list: () => terms.list(), current: () => terms.current(), publish: publishWork });
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
const workCtx = {
  native, store, gate, requests, log, work: mergedWork, repos, broadcast, publish: publishWork,
  sync: () => { nativeSync().catch(() => {}); }, askChanged, killed: () => existsSync(KILL_FILE), wake: (text: string) => brain.send(text),
  watchPane: makePaneWatcher({ native, broadcast, log }), chatFiles: new Map<string, string>(),
  readLog: () => { try { return readFileSync(join(ROOT, 'data', 'jarvisd.log'), 'utf8'); } catch { return ''; } },
};
const cardToBrain = toBrain(brain);
const askCtx = {
  store, log, native, cardOf, pressed: PRESSED, askChanged, publish: publishWork,
  note: (n: string, card?: { approves: boolean }) => { if (!existsSync(KILL_FILE)) cardToBrain(n, card); },
  sync: () => { nativeSync().catch(() => {}); },
  emailDone: (id: string) => { messages.dropProposals(id); messagesChanged(); },
};
const gateCtx = {
  gate, store, native, killed: () => existsSync(KILL_FILE), notice: gateNotice, proposed: chatLinks.proposed,
  hold: (text: string) => brain.hold(text), wake: (text: string) => brain.send(text),
};
const voiceFileCtx = {
  voice, speaker, jarvisText: (id: number) => store.jarvisText(id),
  // A worker's message, for read aloud in its pane. A transcript that moved or went away is a 404, not a crash.
  workerText: (row: string, line: string) => {
    const file = row.startsWith(ROW_PREFIX) ? native.transcriptFile(row) : undefined;
    try { return file ? chatLineAt(file, line) : undefined; } catch { return undefined; }
  },
  bakeoffDir: join(ROOT, 'data', 'bakeoff') };
const voiceCtx = { voice, listen, speaker, log, fromOwner, toWorker: (id: string, text: string) => steerWorker(workCtx, id, text), uploads: uploadDir(ROOT), today };
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
      // The chat microphone, hands-free listening and the Today microphone (voice.ts). The body is audio, read as bytes.
      // Before the Today route: that route reads every /api/today/ body as JSON, and the Today microphone's is audio.
      () => voiceRoute(voiceCtx, method, url, limit => readBody(req, limit), query),
      async () => url === '/api/today' || url.startsWith('/api/today/') || url.startsWith('/api/internal/today') ? todayRoute(today, method, url, await post(), owner) : undefined,
      async () => url === '/api/migration' || url.startsWith('/api/migration/') || url.startsWith('/api/internal/migration') ? migrationRoute(migration, method, url, await post()) : undefined,
      async () => url.startsWith('/api/internal/replies') ? replyRoute(store, log, method, url, await post(), { ...owner, fromOwnerCard: () => brain.answeringOwnerCard }) : undefined,
      async () => url.startsWith('/api/internal/reminders') ? reminderRoute(store, log, method, url, await post()) : undefined,
      // The work list and its row buttons (workroutes.ts).
      () => workRoute(workCtx, method, url, body, query),
      // Ask cards: a tap on an option, the audit log, an answer the brain recorded (asks.ts).
      () => askRoute(askCtx, method, url, body),
      // The approval buttons and the brain's jarvis-act calls (gate.ts).
      () => gateRoute(gateCtx, method, url, body),
      // The web code version, for a page that comes back from the background (webfiles.ts).
      async () => webVersionRoute(WEB_VERSION, method, url),
    ];
    for (const route of routes) { const r = await route(); if (r) return send(res, r.status, r.body); }
    if (req.method === 'GET' && STATIC[url]) {
      const file = join(ROOT, 'web', STATIC[url]);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(readFileSync(file));
    }
    // Rendered clips, one sentence of a stored message, and the TTS bake-off (voice.ts).
    if (await voiceFileRoute(voiceFileCtx, req, res, url)) return;
    // Pictures in `[image: ...]` markers and in reports, only from the folders in images.ts.
    if (imageRoute(IMAGE_ROOTS, req, res, url)) return;
    if (req.method === 'GET' && url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const history = store.recentTurns(80).filter(t => t.role === 'owner' || t.role === 'jarvis' || t.role === 'event' || t.role === 'jarvis-work')
        .map(t => t.role === 'jarvis-work' ? { id: t.id, role: t.role, text: '', ms: JSON.parse(t.text).ms, created_at: t.created_at }
          : t.role === 'jarvis' ? { ...t, clips: spokenSentences(t.text).length }
          : t.reply_to ? { ...t, quote: quoteOf(store.turn(t.reply_to)) } : t);
      const secret = ui.open();
      res.write(`data: ${JSON.stringify({ type: 'history', turns: history, busy: brain.busy, approvals: store.pendingApprovals(), work: mergedWork(), hidden: hiddenIds(store), requests: requests.list(), asks: store.recentAsks().map(cardOf).filter(Boolean), audit: auditEntries(store, cardOf, PRESSED, 60), messages: messages.list(), today: today.list(), migration: migration.state(), brain: brainInfo(), session: secret })}\n\n`);
      res.write(`data: ${JSON.stringify(versionEvent(WEB_VERSION))}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); ui.close(secret); termGate.dropPage(secret); });
      return;
    }
    // The page's record of each speech clip it played: play, wait (a stall), end, error, stop. See web/speech.js.
    if (req.method === 'POST' && url === '/api/speech/log') {
      const { events } = await json(req);
      if (!Array.isArray(events)) return send(res, 400);
      for (const e of events.slice(0, 100)) log('speech play', { ev: String(e?.ev).slice(0, 8), key: String(e?.turn).slice(0, 80), i: Number(e?.i), t: Number(e?.t), dur: e?.dur, code: e?.code, at: new Date(Number(e?.at) || 0).toISOString() });
      return send(res, 204);
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
    send(res, 404);
  } catch (e) {
    log(`http error ${url}: ${e}`);
    send(res, 500, { error: String(e) });
  }
}).listen(PORT, '127.0.0.1', () => log(`jarvisd on http://127.0.0.1:${PORT}`));
