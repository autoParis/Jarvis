// Serves web/ with sample data, so the page can be looked at without a second jarvisd. daemon/main.ts starts the brain,
// the native workers, the Gmail watcher and the timers at load, so it must not run twice. This script imports only the
// card builder, writes nothing and never opens data/. Button presses change this process's memory and nothing else.
//
//   npm run preview            then open http://127.0.0.1:7718
//   ?s=question    (default)   five open items, a question first, and an urgent email behind Messages
//   ?s=requests                the same requests, no email
//   ?s=messages                plain emails only, no requests
//   ?s=approval                an approval first, with its full text
//   ?s=empty                   nothing needs the owner, nothing running
//   ?s=fr                      the same as question, in French
//   ?s=working                 the same as question, with Jarvis in the middle of a turn
//   ?s=escalation              a blocked worker's escalation
//   ?s=failed                  an escalation with the worker's own FAILED and PROPOSES fields
//   ?s=reports                 Completed rows with Report links: a short answer, a review, a 600 line audit, and one with no report
//   ?s=docs                    the Reports view: three documents in the menu's list, and a [report:] card in the chat
//   ?s=today                   the Today list with a row in every status. Every other scene has an empty list, to show the button at zero
//   ?s=migration               the Migration list with a person in every status. Every other scene has nobody on it
//   ?s=dense                   cards as long as real ones: a fields ask with long context, an approval with its two lines, an old free-form escalation
//   menu > Scheduled tasks     sample rows in every status; PREVIEW_TASKS=real reads the real launchd jobs, read-only
//   (every scene with requests) Jarvis's second message carries Approve and Reject for the slow-feed issue
//   ?s=native                  a native worker just started: its "Handed to a worker" row comes from daemon/requests.ts
//   ?s=pictures                the owner's "Anything stuck?" carries 4 attached pictures: the row of small squares
//
// Terminal and Codex from the plus run the real terminal code (daemon/terminal.ts, termgate.ts, termroutes.ts) on a
// tmux server of their own, `tmux -L jarvis-preview`, never jarvisd's sessions. Open the preview at http://localhost:7718
// (WebAuthn needs a name, not an IP): the Mac asks for a passkey as jarvisd does, and the phone checks always pass here.
// Pair the Mac with the code from `curl -s -XPOST -H 'x-jarvis-session: preview' localhost:7718/api/term/pair-code`.
// A Codex worktree is not made here. `tmux -L jarvis-preview kill-server` ends what the preview started.
//
// PREVIEW_MIGRATION=<file> fills ?s=migration with that JSON, the output of `jarvis-migration list`, in place of the
// sample people, times kept. The file is given by hand, as for PREVIEW_CLOSED.
//
// PREVIEW_CLOSED=<file> serves that JSON, an answer of GET /api/work/req:<id>/read, as a failed request with no
// conversation. The file is given by hand; this script still never opens data/.
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { askCard } from '../daemon/asks.ts';
import { byteRange, sentences } from '../daemon/voice.ts';
import { messageCard, messageOrder } from '../daemon/messages.ts';
import type { Item } from '../daemon/store.ts';
import { SAMPLE_REPORTS, SAMPLE_DOCS } from './preview-reports.ts';
import { MODELS, EFFORTS, DEFAULT_BRAIN_MODEL, parseBrainModel } from '../daemon/brainmodel.ts';
import { namedCardArgs } from '../daemon/namedactions.ts';
import { prodCard } from '../daemon/prodmcp.ts';
import { openStore } from '../daemon/store.ts';
import { makeRequests } from '../daemon/requests.ts';
import { makeToday, todayRoute } from '../daemon/today.ts';
import { makeMigration, migrationRoute } from '../daemon/migration.ts';
import { makeTerminals } from '../daemon/terminal.ts';
import { makeTermGate } from '../daemon/termgate.ts';
import { termRoute } from '../daemon/termroutes.ts';
import { terminalRows } from '../daemon/termrows.ts';
import { quoteOf, quoteLine, replyIdOf, type TurnRow } from '../daemon/quote.ts';
import { makePreviewTasks } from './preview-tasks.ts';

const CLOSED = process.env.PREVIEW_CLOSED ? JSON.parse(readFileSync(process.env.PREVIEW_CLOSED, 'utf8')) : undefined;
const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const PORT = Number(process.env.PREVIEW_PORT ?? 7718);
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** A database time, `min` minutes ago. */
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const iso = (min: number) => `${ago(min).replace(' ', 'T')}Z`;
/** A native worker's row, as daemon/native.ts builds it. */
const worker = (id: string, f: { title: string; group: string; state: 'waiting' | 'working' | 'idle'; label?: string; note?: string; worktree?: string }) => ({
  id: `n:${id}`, kind: 'worker', dispatch: `n:${id}`, steer: 'auto', ...f,
  native: { id, sessionId: `sess-${id}`, name: f.worktree ?? id, state: f.state === 'idle' ? 'done' : 'working', waitingFor: f.state === 'waiting' ? 'A question' : null, outcome: null } });
const item = (id: string, min: number, f: Partial<Item>): Item => ({ id: 0, source: 'native', external_id: id, kind: 'question', dispatch_id: null, subject: '', body: '', options: null, status: 'spoken', answer: null, created_at: ago(min), pushes: 0, pushed_at: null, meta: null, ...f });
const asked = (story: string, where: string, q: string, opts: [string, string][]) =>
  `STORY: ${story}\nWHERE: ${where}\nQUESTION: ${q}\nOPTIONS:\n${opts.map(([c, r]) => `- ${c} because ${r}`).join('\n')}`;

const WORDS = {
  en: {
    tag: 'Story 4612', where: 'Building the export history screen.', q: 'Three dealerships have no export account yet. What should the screen show for them?',
    o1: 'Show them as "Not set up"', r1: 'every dealership stays visible with a plain label', o2: 'Hide them', r2: 'a shorter list, but a dealership can look missing',
    t2: 'Story 4623', w2: 'Cleaning up the price history page.', q2: 'The new page slows down past 2 years of price changes. How far back should it go?', o3: '2 years, with a "Show older" link', r3: 'it opens in under a second', o4: 'All 5 years', r4: 'the page takes about 4 seconds',
    say: 'Send Sam the request for the two Marketplace secrets?', sub: 'Marketplace access needed', text: 'Hi Sam,\n\nStory 4531 cannot finish without the two Marketplace secrets. Can you send them today?\n\nOwner',
    say2: 'Start a worker on story 4640?', jarvis1: 'Both are running. I will only come back to you when one needs a decision.', you1: 'How is the export history work going?',
    jarvis2: 'Story 4571 is finished and its pull request is open. Here is the new panel.\n\n[image: /tmp/run-history.png]', you2: 'Anything stuck?', jarvis3: 'Story 4555 failed twice on the same test, so I paused it. And story 4612 needs your answer.',
    w1: '#4612 Export history screen', w3: '#4555 Lead import retry', w4: '#4598 Paused accounts map', w5: '#4602 Window sticker fonts', b1: 'Babysit PR #4590 Recompute stored car payments', s1: 'Side chat: why did the feed slow down', o5: 'Weekly status report', m1: '#4571 Run history on the export accounts screen', m2: 'Dealer group switcher', d1: '#4577 Logs panel run history', old: '#4603 Keep the map on paused accounts',
    aq: 'Keep the map on paused accounts?', aa: 'Keep it', ae: 'Send the weekly recap?',
    dsay: 'Start a worker on story 4701, lead alerts queue?',
    dapproves: 'A worker starts on Opus in a new worktree. It moves the lead alerts to the task queue and opens a PR.',
    drests: 'Issue #4701 is ready. Alerts now wait up to 15 minutes on the cron job.',
  },
  fr: {
    tag: 'Story 4612', where: "Construction de l'écran d'historique des exportations.", q: "Trois concessions n'ont pas encore de compte d'exportation. Que doit afficher l'écran pour elles?",
    o1: 'Les afficher comme « Non configurée »', r1: 'chaque concession reste visible avec une étiquette claire', o2: 'Les masquer', r2: 'une liste plus courte, mais une concession peut sembler manquante',
    t2: 'Story 4623', w2: "Nettoyage de la page d'historique des prix.", q2: "La nouvelle page ralentit au-delà de 2 ans de changements de prix. Jusqu'où doit-elle remonter?", o3: '2 ans, avec un lien « Afficher les plus anciens »', r3: "elle s'ouvre en moins d'une seconde", o4: 'Les 5 ans au complet', r4: "la page prend environ 4 secondes à s'ouvrir",
    say: 'Envoyer à Sam la demande pour les deux secrets Marketplace?', sub: 'Accès Marketplace requis', text: "Bonjour Sam,\n\nLa story 4531 ne peut pas se terminer sans les deux secrets Marketplace. Peux-tu me les envoyer aujourd'hui?\n\nOwner",
    say2: 'Lancer un agent sur la story 4640?', jarvis1: "Les deux roulent. Je reviens vers toi seulement quand l'un d'eux a besoin d'une décision.", you1: "Où en est le travail sur l'historique des exportations?",
    jarvis2: "La story 4571 est terminée et sa pull request est ouverte. Voici le nouveau panneau.\n\n[image: /tmp/run-history.png]", you2: 'Quelque chose de bloqué?', jarvis3: "La story 4555 a échoué deux fois sur le même test, alors je l'ai mise en pause. Et la story 4612 attend ta réponse.",
    w1: "#4612 Écran d'historique des exportations", w3: '#4555 Nouvel essai des importations de prospects', w4: '#4598 Carte des comptes en pause', w5: '#4602 Polices des autocollants de vitres', b1: 'Babysit PR #4590 Recalcul des paiements de véhicules', s1: "Side chat: pourquoi le flux a ralenti", o5: 'Rapport hebdomadaire', m1: "#4571 Historique des envois sur l'écran des comptes", m2: 'Sélecteur de groupe de concessionnaires', d1: '#4577 Historique du panneau des journaux', old: '#4603 Garder la carte sur les comptes en pause',
    aq: 'Garder la carte sur les comptes en pause?', aa: 'La garder', ae: 'Envoyer le résumé de la semaine?',
  },
};

const clipCount = (text: string) => sentences(text.replace(/\[(?:image|report):[^\]]*\]/g, ' ')).length;
// The voice is not in the preview: every sentence is the same quiet 4 s tone, kept in memory.
let tone: Buffer | undefined;
function toneClip() {
  if (tone) return tone;
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-preview-')), file = join(dir, 'tone.m4a'); // ffmpeg writes an m4a like the real clips only to a file
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-af', 'volume=0.1', '-c:a', 'aac', '-b:a', '64k', file]);
  tone = readFileSync(file);
  rmSync(dir, { recursive: true });
  return tone;
}
let nextTurn = 1000;
const sentTurns = new Map<number, TurnRow>(); // turns sent in this preview, so a reply can quote them

function build(s: string) {
  const w = WORDS[s === 'fr' ? 'fr' : 'en'];
  const empty = s === 'empty';
  const rows = empty ? [] : [
    worker('4612', { title: w.w1, group: 'story', label: '#4612', state: 'waiting', note: 'Question', worktree: 'kelpfish' }),
    worker('4623', { title: '#4623 Price history page', group: 'story', label: '#4623', state: 'waiting', note: 'Question', worktree: 'sable' }),
    worker('4598', { title: w.w4, group: 'story', label: '#4598', state: 'working', worktree: 'marlin' }),
    worker('4602', { title: w.w5, group: 'story', label: '#4602', state: 'working', worktree: 'plover' }),
    worker('baby', { title: w.b1, group: 'babysit', label: 'PR #4590', state: 'working', worktree: 'wren' }),
    worker('side', { title: w.s1, group: 'side', state: 'idle', note: 'Idle 2 h' }),
  ];
  const requests = empty ? [] : [
    ...(CLOSED ? [{ id: CLOSED.detail.id, title: CLOSED.detail.title, words: CLOSED.detail.words, status: CLOSED.detail.status, at: CLOSED.detail.at, startedAt: CLOSED.detail.startedAt }] : []),
    { id: 1, title: w.w1, words: null, status: 'waiting', at: iso(44), startedAt: iso(70), row: 'n:4612' },
    { id: 2, title: '#4623 Price history page', words: null, status: 'waiting', at: iso(32), startedAt: iso(60), row: 'n:4623' },
    { id: 3, title: w.w3, words: null, status: 'failed', at: iso(6), startedAt: iso(55) },
    { id: 4, title: w.w4, words: null, status: 'working', at: iso(50), startedAt: iso(50), row: 'n:4598' },
    { id: 5, title: w.w5, words: null, status: 'working', at: iso(3), startedAt: iso(3), row: 'n:4602' },
    { id: 6, title: w.m1, words: null, status: 'review', at: iso(25), startedAt: iso(90), pr: 'PR #4584', url: 'https://github.com/example/repo/pull/4584' },
    { id: 7, title: w.m2, words: null, status: 'review', at: iso(60), startedAt: iso(180), pr: 'PR #4577', url: 'https://github.com/example/repo/pull/4577' },
    { id: 10, title: 'Install extension button', words: null, status: 'review', at: iso(12), startedAt: iso(90), pr: 'PR #4407', url: 'https://github.com/example/repo/pull/4407' },
    { id: 11, title: 'Raise screen fixes', words: null, status: 'review', at: iso(40), startedAt: iso(120), pr: 'PR #4407', url: 'https://github.com/example/repo/pull/4407', row: 'n:4612' },
    { id: 12, title: 'Test seller invite link', words: null, status: 'review', at: iso(70), startedAt: iso(150), pr: 'PR #4407', url: 'https://github.com/example/repo/pull/4407' },
    { id: 13, title: '#4380 Preview onboarding', words: null, status: 'review', at: iso(95), startedAt: iso(170), pr: 'PR #4407', url: 'https://github.com/example/repo/pull/4407' },
    { id: 8, title: w.d1, words: null, status: 'done', at: iso(30), startedAt: iso(200), pr: 'PR #4570', url: 'https://github.com/example/repo/pull/4570' },
    ...(s === 'reports' ? [
      { id: 20, title: 'Why did the feed slow down', words: null, status: 'done', at: iso(12), startedAt: iso(40), report: true },
      { id: 21, title: 'Review the payments branch', words: null, status: 'done', at: iso(20), startedAt: iso(70), report: true },
      { id: 22, title: 'Audit the whole app against the release checklist', words: null, status: 'done', at: iso(95), startedAt: iso(300), report: true },
      { id: 23, title: 'Update the dealer sheet', words: null, status: 'done', at: iso(140), startedAt: iso(160) },
    ] : []),
  ].map(r => s === 'reports' && r.id === 3 ? { ...r, report: true } : r);
  const q1 = item('m_4612', 44, { dispatch_id: 'n:4612', body: asked(w.tag, w.where, w.q, [[w.o1, w.r1], [w.o2, w.r2]]), options: JSON.stringify([w.o1, w.o2]) });
  const q2 = item('m_4623', 32, { dispatch_id: 'n:4623', body: asked(w.t2, w.w2, w.q2, [[w.o3, w.r3], [w.o4, w.r4]]), options: JSON.stringify([w.o3, w.o4]) });
  const blocked = item('msg_blocked_preview', 3, { kind: 'escalation', dispatch_id: 'n:4612', subject: 'Blocked: permission check still denies production reads', body: "The owner approved read-only access, but Claude Code's auto-mode check still denies it because chat approval does not reach that check. The owner needs to add this one line to permissions.allow in ~/.claude/settings.json by hand: Bash(node .claude/skills/prove-it/bin/db-read.mjs:*). That rule allows this script's GET and HEAD reads on staging and production in any session; I will not edit permissions or reach production another way. Meanwhile I am opening the draft PR and working on the part that needs no production data: showing the seller the refusal reason and letting them correct the link. Tell me when the rule is added, or if I should ship without the proof." });
  const failed = item('msg_failed_preview', 2, { kind: 'escalation', dispatch_id: 'n:4612', subject: 'Blocked: CI', body: 'FAILED: The export tests went red three times in a row on main\nPROPOSES: Pause the merge until the flaky test is fixed\nQUESTION: Hold the merge?\nOPTIONS:\n- Hold it because main is red\n- Merge anyway because the failure is unrelated' });
  const refused = item('msg_refused_preview', 5, { kind: 'escalation', dispatch_id: 'n:4612', subject: 'Blocked: permission denied on client pause', body: "The permissions layer denied the command 'node functions/scripts/reusable/pause-client.js --client exampleclient --hours 48', so I wrote nothing." });
  const named = (id: number, action: string, args: object, say: string) => ({ id, action, args: JSON.stringify(namedCardArgs(action, args)), say, status: 'pending', after_turn: 0, decided_by: null, owner_text: null, result: null, created_at: ago(4) });
  // ?s=dense: cards as long as real workers and the brain write them, to check that each reads in seconds.
  const denseAsk = item('m_4688', 20, { dispatch_id: 'n:4612', body: [
    'STORY: 4688 Marketplace photo order',
    'WHERE: Fixing the photo order sync for paused accounts, step 2 of 4.',
    'QUESTION: When a paused account comes back, should the sync reorder the photos already on Marketplace, or only the new listings?',
    'CONTEXT: The sync reads the order from the dealer feed, but 41 listings on 3 paused accounts were published before the feed had an order field. Reordering them means one edit per listing, about 6 minutes per account at the current rate limit. The FBM team said in TICKET-1040 that dealers noticed the wrong cover photo, so the old listings matter. The rate limit is shared with the publish queue, so a reorder delays new listings on the same account by the same 6 minutes.',
    'OPTIONS:',
    '- Reorder all listings because dealers see the wrong cover photo now',
    '- Only new listings because no delay for the publish queue',
    '- Ask the FBM team first because they own the rate limit',
  ].join('\n'), options: JSON.stringify(['Reorder all', 'Only new', 'Ask FBM first']) });
  const denseStart = { id: 30, action: 'worker-start', args: JSON.stringify({ repo: '/Users/owner/Repos/acmeapp', taskTitle: '#4701 Lead alerts queue', spec: 'Run the pick-and-ship skill on issue #4701. Move the lead alerts from the cron job to the new task queue so an alert goes out within one minute of a lead waiting an hour. Keep the old cron as a fallback for one week behind the LEAD_ALERTS_QUEUE flag. Done when the PR is ready with its evidence.' }),
    say: w.dsay, ...(w.dapproves ? { card: JSON.stringify({ approves: w.dapproves, restsOn: w.drests }) } : {}),
    status: 'pending', after_turn: 0, decided_by: null, owner_text: null, result: null, created_at: ago(15) };
  const solo = s === 'escalation' || s === 'failed' || s === 'named';
  const emailsOff = empty || solo || s === 'dense' || s === 'requests' || s === 'approval';
  const email = (id: string, min: number, urgent: boolean, fromName: string, from: string, subject: string, summary: string, reply: string) =>
    item(`gmail:${id}`, min, { source: 'gmail', kind: 'email', subject, body: summary, meta: JSON.stringify({ gmailId: id, threadId: `t_${id}`, from, fromName, replyTo: from, to: ['owner@example.test'], cc: [], subject, urgent, needsReply: true, reply }) });
  const emails = emailsOff ? [] : [
    ...(s === 'messages' ? [] : [email('e1', 4, true, 'Sophie Gagnon', 'sophie@example.test', 'Facebook account suspended', "Sophie says the dealership's Facebook account was suspended this morning and asks you to stop the Marketplace automation for it.", 'Hi Sophie, I am stopping the automation for that account now and will confirm once it is done.')]),
    email('e2', 50, false, 'Max Lavoie', 'max@example.test', 'Export file is missing two vehicles', 'Max sent two stock numbers that did not reach the export file last night.', 'Hi Max, thanks for the stock numbers. I am looking into it and will write back today.\n\nOwner'),
    email('e3', 90, false, 'Jordan Roy', 'jordan@example.test', 'Invoice for October', 'Jordan asks whether the October invoice can be paid this week.', ''),
    item('outbox:o1', 120, { source: 'outbox', kind: 'outbox', subject: 'FBM secrets grant', meta: JSON.stringify({ to: 'Sam', channel: 'slack', text: 'Hi Sam, could you grant me the permission to add service secrets? Thanks.' }) }),
  ];
  const asks = s === 'dense' ? [denseAsk, blocked] : s === 'messages' ? [] : s === 'escalation' ? [blocked] : s === 'failed' ? [failed] : s === 'named' ? [refused] : s === 'approval' ? [q2] : empty ? [] : [q1, q2];
  const mail = { id: 11, action: 'gmail-send', args: JSON.stringify({ to: 'sam@example.test', subject: w.sub, text: w.text }), say: w.say, status: 'pending', after_turn: 0, decided_by: null, owner_text: null, result: null, created_at: ago(18) };
  const start = { id: 12, action: 'worker-start', args: JSON.stringify({ repo: '/Users/owner/Repos/acmeapp', taskTitle: '#4640 Lead alert', spec: 'Text alert when a lead waits more than an hour.' }), say: w.say2, status: 'pending', after_turn: 0, decided_by: null, owner_text: null, result: null, created_at: ago(26) };
  const issue = { id: 13, action: 'gh-issue-create', args: JSON.stringify({ repo: 'example/repo', title: 'Feed slows down at night', body: 'The export feed takes twice as long after 10 PM.' }), say: 'Open an issue about the slow feed?', status: 'pending', after_turn: 0, chat_turn: 902, decided_by: null, owner_text: null, result: null, created_at: ago(12) };
  const approvals = s === 'dense' ? [denseStart] : s === 'named' ? [named(14, 'gh-pr-close', { repo: 'example/repo', number: 4667, comment: "Closed as superseded by #4733, the owner's decision." }, 'Close PR 4667 in example/repo?'), named(15, 'fbm-client-pause', { client: 'exampleclient', hours: 48 }, 'Pause exampleclient for 48 hours?'), { ...named(14, 'gh-pr-close', { repo: 'example/repo', number: 1, comment: 'x' }, 'Run support_ticket_reply on production?'), id: 16, action: 'prod-mcp-call', args: JSON.stringify(prodCard({ tool: 'support_ticket_reply', arguments: { reference: 'TICKET-1042', content: "Bonjour,\n\nLes photos manquantes sont revenues sur votre inventaire ce matin. Vous n'avez rien à faire de votre côté.\n\nMerci de votre patience,\nOwner", status: 'resolu' } }, 'Support ticket TICKET-1042, "Photos manquantes"')) }] : empty || solo || s === 'messages' ? [] : s === 'approval' ? [{ ...mail, created_at: ago(40) }, start] : [mail, start, issue];
  const turns = empty ? [] : [
    { id: 901, role: 'jarvis', text: w.jarvis1, created_at: ago(58) },
    { role: 'event', text: `- [worker_done] message_id=msg_preview1 dispatch=n:preview1 subject=${JSON.stringify(w.d1)} body=${JSON.stringify(w.jarvis1)}\n- [escalation] message_id=msg_preview2 dispatch=n:preview2 subject="" body="No subject on this one."`, created_at: ago(40) },
    { id: 905, role: 'owner', text: w.you1, created_at: ago(30) },
    { id: 900, role: 'jarvis-work', text: '', ms: 488_000, created_at: ago(29) },
    { id: 902, role: 'jarvis', text: w.jarvis2, created_at: ago(29) },
    { id: 906, role: 'owner', text: s === 'pictures' ? `${w.you2}\n${[1, 2, 3, 4].map(n => `[image: /r/data/uploads/20261109T140000-a${n}f3.png]`).join('\n')}` : w.you2, created_at: ago(8), ...(s === 'reply' ? { reply_to: 901 } : {}) },
    { id: 903, role: 'jarvis', text: w.jarvis3, created_at: ago(7) },
    ...(s === 'docs' ? [{ id: 904, role: 'jarvis', text: `I wrote up the story draft. It covers the menu button, the list and the chat card.\n\n[report: ${SAMPLE_DOCS[0].path}]`, created_at: ago(5) }] : []),
  ].map(t => t.role === 'jarvis' ? { ...t, clips: clipCount(t.text!) } : t);
  for (const x of turns as any[]) if (x.reply_to) x.quote = quoteOf((turns as TurnRow[]).find(q => q.id === x.reply_to)); // ?s=reply: a reply as the history brings it back
  const audit = empty ? [] : [
    { key: 'ask:old', kind: 'ask', tag: 'Story 4603', at: iso(20), question: w.aq, answer: w.aa },
    { key: 'ask:steered', kind: 'ask', tag: 'Story 4612', at: iso(15), question: 'It ended its turn without reporting.', answer: 'Keep going: finish the tests, commit on the branch and report back with worker_done when they pass.', by: 'jarvis' },
    { key: 'approval:9', kind: 'approval', tag: 'Email to Jordan', at: iso(120), question: w.ae, answer: 'Approved' },
    { key: 'approval:8', kind: 'approval', tag: 'Story 4555', at: iso(150), question: 'Start a worker on story 4555?', answer: 'Approved, then failed: spawn_failed: no worktree slot', failed: true },
  ];
  if (s === 'native') return { rows: [NATIVE_ROW, ...rows], requests: nativeRequests() as typeof requests, items: [], emails: [], approvals: [], turns, audit: [], hidden: [] as string[] };
  return { rows, requests, items: asks, emails, approvals, turns, audit, hidden: [] as string[] };
}

// ?s=native: one native worker the gate just started. The request comes from daemon/requests.ts itself, fed the result
// gate.ts runNative stores ({"worker":"n:<id>"}), in a store in memory, so the "Handed to a worker" row is what jarvisd builds.
const NATIVE_ROW = { id: 'n:7f3a9c21', kind: 'worker', dispatch: 'n:7f3a9c21', title: 'handed-to-a-worker-401', group: 'other', state: 'working', worktree: 'handed-to-a-worker-401', steer: 'auto',
  native: { id: '7f3a9c21', sessionId: 'sess-preview', name: 'handed-to-a-worker-401', state: 'working', waitingFor: null, outcome: null } };
function nativeRequests() {
  const store = openStore(':memory:');
  const reqs = makeRequests({ store, log: () => {}, onChange: () => {}, repoOf: async () => undefined });
  const a = store.addApproval({ action: 'worker-start', args: JSON.stringify({ repo: '/Users/owner/Repos/jarvis', taskTitle: 'Handed to a worker button for native workers', spec: 's' }), say: 'Start a worker on it?' });
  store.decide(a.id, 'approved', 'button');
  store.finishApproval(a.id, 'done', JSON.stringify({ worker: NATIVE_ROW.id, sessionId: 'sess-preview', name: NATIVE_ROW.title, state: 'working' }));
  reqs.started(store.approval(a.id)!);
  return reqs.list();
}

type Scene = ReturnType<typeof build>;
let brainSetting = { ...DEFAULT_BRAIN_MODEL };
const brainInfo = () => ({ setting: brainSetting, running: brainSetting, switching: false, models: MODELS, efforts: EFFORTS });
const scenes = new Map<string, { scene: Scene; clients: Set<http.ServerResponse>; today: ReturnType<typeof makeToday>; migration: ReturnType<typeof makeMigration> }>();
const sceneOf = (req: http.IncomingMessage) => {
  const name = new URL(req.headers.referer ?? 'http://x/').searchParams.get('s') ?? 'question';
  if (!scenes.has(name)) {
    const clients = new Set<http.ServerResponse>();
    const out = (ev: object) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
    scenes.set(name, { scene: build(name), clients, today: sampleToday(name, list => out({ type: 'today', today: list() })), migration: sampleMigration(name, m => out({ type: 'migration', migration: m.state() })) });
  }
  return scenes.get(name)!;
};
/** The real Today rules on a memory-only store. The stand-in gate runs nothing and the stand-in brain hears nothing. */
function sampleToday(name: string, changed: (list: () => unknown) => void) {
  const store = openStore(':memory:');
  let issue = 4890;
  const gate = { pressed: async (action: string) => ({ id: 1, action, status: 'done', result: action === 'today-issue' ? `https://github.com/example/repo/issues/${issue++}` : JSON.stringify({ worker: `n:preview${issue++}` }) }) } as any;
  const today = makeToday({ store, gate, log: () => {}, wake: () => {}, repos: () => [{ path: '/Users/owner/Repos/acmeapp_nextjs' }], paused: () => false, onChange: () => changed(today.list), skillFor: () => 'pick-and-ship-v3' });
  if (name !== 'today') return today;
  const add = (words: string, f: Parameters<typeof store.setToday>[1], go = false) => { const r = store.addToday(words, go); store.setToday(r.id, { owed: null, ...f }); };
  add("the dealer photo order is wrong when a car comes back from the wash, it should keep the first exterior shot on top", { status: 'waiting', kind: 'story', title: 'Keep the first exterior photo on top after a re-shoot', reading: 'A re-shoot appends the new photos, so the listing leads with an interior. The fix keeps the order the owner set and only replaces matching angles.', questions: JSON.stringify([{ q: 'What happens to a photo with no matching angle?', options: ['Add it at the end', 'Ask the dealer'], recommended: 0 }]), assumptions: JSON.stringify(['Applies to all dealers', 'Only new re-shoots, old listings stay as they are']), repo: '/Users/owner/Repos/acmeapp_nextjs', story: JSON.stringify({ github: 'example/repo', title: 'Keep the first exterior photo on top after a re-shoot', body: 'Story text.' }) });
  add('look into why the Friday inventory report is late', { status: 'waiting', kind: 'task', title: 'Find why the Friday report is late', reading: 'Read the last four runs and say which step takes the time.', repo: '/Users/owner/Repos/acmeapp_nextjs', spec: 'Read the runs.', reason: 'The worker failed: it could not read the run log.', questions: '[]', assumptions: '[]' });
  add('talk about whether Alex should own the migration tracker', { status: 'waiting', kind: 'talk', title: 'Who owns the migration tracker', reading: 'A decision for you and Alex. It has no work behind it yet.', questions: '[]', assumptions: '[]' });
  add('draft the note to Sam about the staging freeze', { status: 'ready', kind: 'task', title: 'Note to Sam about the staging freeze', result: 'Draft is written and saved as a card under Messages. Nothing was sent.', not_proven: 'Whether the freeze dates are still current. I took them from last week\'s thread.', link: '#report/3', link_label: 'Report' });
  // Two real titles from Nov 6, the longest on the list, to show whether a title fits.
  add('clear the release 4599 manual steps', { status: 'ready', kind: 'task', title: 'Clear release 4599 manual steps so the TICKET-1040 reply can go', result: 'The steps are done.', not_proven: 'Nothing.', link: '#report/3', link_label: 'Report' });
  add('clear the release 4844 manual steps', { status: 'ready', kind: 'task', title: 'Clear release 4844 manual steps so four held support replies can go', result: 'The steps are done.', not_proven: 'Nothing.', link: '#report/3', link_label: 'Report' });
  add('map every place we call the old status column', { status: 'working', kind: 'task', title: 'Map the old status column', line: 'Running', dispatch: 'n:map' }, true);
  store.db.prepare(`INSERT INTO requests (dispatch_id, action, title, status) VALUES ('n:map', 'worker-start', 'Map the old status column', 'working')`).run();
  add('rename the appraisal export for the new template', { status: 'queued', kind: 'task', title: 'Rename the appraisal export', repo: '/Users/owner/Repos/acmeapp_nextjs', spec: 'Rename it.' }, true);
  add('check what Sophie meant by the second account', { status: 'new', owed: 'new', told_at: '2999-01-01 00:00:00' });
  add('summarize the October dealer calls', { status: 'released', kind: 'task', title: 'Summary of the October dealer calls', result: 'The summary is in the report.', not_proven: 'Two calls had no transcript.', link: '#report/3', link_label: 'Report' });
  return today;
}
/** The real Migration rules on a memory-only store, seeded with sample dealerships (the repo's seed file is empty). */
const SAMPLE_DEALERS = ['One', 'Two', 'Four', 'Five', 'Seven'].map(n => ({ name: `Dealer ${n}`, key: `dealer${n.toLowerCase()}` }));
function sampleMigration(name: string, changed: (m: ReturnType<typeof makeMigration>) => void) {
  const store = openStore(':memory:');
  const m: ReturnType<typeof makeMigration> = makeMigration({ db: store.db, log: () => {}, getState: store.getState, setState: store.setState, onChange: () => changed(m), seed: () => SAMPLE_DEALERS });
  if (name !== 'migration') return m;
  if (process.env.PREVIEW_MIGRATION) {
    const db = (t: string | null) => t && t.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
    for (const p of JSON.parse(readFileSync(process.env.PREVIEW_MIGRATION, 'utf8'))) {
      const id = m.add({ name: p.name, dealership: p.dealership, source: p.source, status: p.status === 'meeting' ? 'contacted' : p.status, note: p.note, from: p.addedFrom ?? 'chat' }, p.addedBy === 'jarvis' ? 'jarvis' : 'owner').body.person.id;
      store.db.prepare('UPDATE migration_people SET status = ?, meeting_at = ?, created_at = ?, status_at = ?, note_at = ?, by_hidden_at = ? WHERE id = ?')
        .run(p.status, db(p.meetingAt), db(p.createdAt), db(p.statusAt), db(p.noteAt), p.byHidden ? db(p.updatedAt) : null, id);
    }
    return m;
  }
  m.addDealer({ name: 'Dealer Twelve' });
  const add = (min: number, f: Record<string, string>, by: 'owner' | 'jarvis', status?: string, noteMin?: number) => {
    const id = m.add(f, by).body.person.id;
    // Meeting set goes in as the brain sets it, with no time; meet() below gives most of them one.
    if (status) m.status(id, { status }, status === 'meeting' ? 'jarvis' : 'owner');
    store.db.prepare(`UPDATE migration_people SET created_at = ?, status_at = ?, note_at = CASE WHEN note = '' THEN NULL ELSE ? END WHERE id = ?`).run(ago(min), ago(status ? min - 60 : min), ago(noteMin ?? min), id);
  };
  // Meeting times are whole Eastern hours from now: one tomorrow, one in four days, one that passed yesterday, one with no time yet.
  const meet = (id: number, hours: number) => {
    const t = new Date(Date.now() + hours * 3_600_000);
    t.setUTCMinutes(0, 0, 0);
    store.db.prepare('UPDATE migration_people SET meeting_at = ? WHERE id = ?').run(t.toISOString().slice(0, 19).replace('T', ' '), id);
  };
  add(140, { name: 'Max Tanner', dealership: 'Dealer One', source: 'email', note: 'Asks when his listings move over.', from: 'an email' }, 'jarvis');
  add(300, { name: 'Julie Gagnon', dealership: 'Dealer Two', source: 'text' }, 'owner');
  add(13000, { name: 'Leo Bergeron', dealership: 'Dealer Twelve', source: 'text', from: 'a text from Leo' }, 'jarvis');
  add(1500, { name: 'Karim Haddad', dealership: 'Dealer Seven', source: 'email', note: 'Sent him the setup steps Tuesday. Waiting on his Facebook login before we book the call.', from: 'chat' }, 'jarvis', 'contacted', 2900);
  add(8600, { name: 'Annie Côté', dealership: 'Dealer Five', source: 'email' }, 'owner', 'contacted');
  add(4000, { name: 'Sophie Roy', dealership: 'Dealer Twelve', source: 'text', note: 'Google Meet. Did it happen? Set the status.' }, 'owner', 'meeting');
  add(2000, { name: 'Pierre Lavoie', dealership: 'Dealer One', source: 'email', note: 'Wants to see the posting tool.', from: 'an email from Pierre' }, 'jarvis', 'meeting');
  add(2500, { name: 'Nathalie Roy', dealership: 'Dealer Two', source: 'text' }, 'owner', 'meeting');
  add(900, { name: 'Jean Gagné', dealership: 'Dealer Twelve', source: 'text', from: 'chat' }, 'jarvis', 'meeting');
  const ids = Object.fromEntries(m.state().people.map(p => [p.name, p.id]));
  meet(ids['Sophie Roy'], -22);
  meet(ids['Pierre Lavoie'], 22);
  meet(ids['Nathalie Roy'], 96);
  store.db.prepare('UPDATE migration_people SET by_hidden_at = datetime(\'now\') WHERE id = ?').run(ids['Karim Haddad']);
  add(6000, { name: 'Éric Baker', dealership: 'Dealer Five', source: 'email', note: 'All 48 listings moved Nov 3.' }, 'owner', 'migrated');
  add(7000, { name: 'Nadia Pelletier', dealership: 'Dealer Four', source: 'text' }, 'owner', 'migrated');
  return m;
}
const messagesOf = (scene: Scene) => messageOrder(scene.emails.filter(i => i.status === 'spoken').map(i => messageCard(i)));
const cardOf = (i: Item) => askCard(i, i.kind === 'escalation' ? '#4612 Export history screen' : undefined, () => true);
const uploads = new Map<string, { type: string; bytes: Buffer }>();
const body = async (req: http.IncomingMessage) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
const send = (res: http.ServerResponse, status: number, data?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(data === undefined ? '' : JSON.stringify(data)); };
const FOLD_STEPS = [
  { kind: 'thought', text: 'The owner wants to know how the export history work is going. The worker list and the pull request will say.' },
  { kind: 'note', text: 'Checking the worker and its pull request before I answer. The `export-history` branch is the one to read.' },
  { kind: 'tool', name: 'Read', input: '{"file_path":"/Users/owner/Repos/jarvis/vault/notes/export-history.md","offset":40,"limit":120}', output: '# Export history\nThe screen lists every export per dealership, newest first.' },
  { kind: 'tool', name: 'WebSearch', input: '{"query":"csv export history screen retention period dealership compliance"}', output: 'No result changes the plan.' },
  { kind: 'thought', text: 'The note matches the story, so the only open point is the three dealerships with no account. That is the question already waiting for the owner, and there is no reason to ask it a second time.' },
  { kind: 'tool', name: 'Bash', input: 'jarvis-native list 2>&1 | grep n:4612; gh pr view 4612 --json statusCheckRollup,reviewDecision,mergeable', output: 'Waiting on one question.\n38 of 38 checks passed.' },
  { kind: 'tool', name: 'Grep', input: '{"pattern":"exportAccount","path":"/Users/owner/Repos/acmeapp/app"}', output: 'No matches', failed: true },
  { kind: 'note', text: 'The worker is waiting on one question, and every check on its pull request passes.' },
  { kind: 'update', text: 'A background test run finished: 38 of 38 passed.' },
  { kind: 'tool', name: 'Bash', input: 'gh pr checks 4612', output: 'All checks passed' },
  { kind: 'tool', name: 'Bash', input: 'gh pr view 4612 --json mergeable', output: '{"mergeable":"MERGEABLE"}' },
];
const LINES = [
  { role: 'tool', text: 'Read the map component and the account status query' },
  { role: 'agent', text: 'Paused accounts still draw on the map because the query reads the old status column. I am switching it to the new one.' },
  { role: 'tool', text: 'Edit web/map.js' },
  { role: 'tool', text: 'Run the map tests: 38 passed, 1 failed' },
  { role: 'agent', text: 'The failing test expects a paused account to show a grey pin. The story says to hide it, so I am following the story and updating that test.' },
  { role: 'user', text: 'Keep going, follow the story.' },
  { role: 'agent', text: 'All 39 map tests pass now. Running the full suite before I open the pull request.' },
];

const PREVIEW_REPOS = [{ name: 'acmeapp', path: '/Users/owner/Repos/acmeapp_nextjs' }, { name: 'fbm', path: '/Users/owner/Repos/FB-marketplace-uploader' }, { name: 'jarvis', path: '/Users/owner/Repos/jarvis' }];
const termState = new Map<string, string>();
const terms = makeTerminals({ log: (m, f) => console.log(m, f ?? ''), socket: 'jarvis-preview', env: { ...process.env, TERM: 'xterm-256color' } });
const termGate = makeTermGate({ store: { getState: k => termState.get(k), setState: (k, v) => { termState.set(k, v); } }, log: (m, f) => console.log(m, f ?? ''), origin: `http://localhost:${PORT}` });
await terms.list();
const withTerms = (rows: any[]) => [...rows, ...terminalRows(terms.current())];

const tasksRoute = makePreviewTasks();

http.createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const { scene, clients, today, migration } = sceneOf(req);
  const out = (ev: object) => { for (const c of clients) c.write(`data: ${JSON.stringify(ev)}\n\n`); };
  if (url.startsWith('/api/term/')) {
    return termRoute({ terms, gate: termGate, log: (m, f) => console.log(m, f ?? ''), uiOk: h => h['x-jarvis-session'] === 'preview', repos: () => PREVIEW_REPOS,
      phoneRefusal: async () => undefined, worktree: async repo => repo,
      onChange: () => { terms.list().then(() => out({ type: 'work', work: { at: '', rows: withTerms(scene.rows) } })).catch(() => {}); } }, req, res, url);
  }
  // The model picker: the switch takes a second here, as a resume does, and never touches a real brain.
  if (url === '/api/brain/model' && req.method === 'POST') {
    const m = parseBrainModel(await body(req));
    if ('error' in m) return send(res, 400, { error: m.error, ...brainInfo() });
    brainSetting = m;
    await new Promise(r => setTimeout(r, 1000));
    return send(res, 200, brainInfo());
  }
  // The Scheduled tasks screen (menu > Scheduled tasks): sample rows, or the real jobs read-only with PREVIEW_TASKS=real.
  if (url.startsWith('/api/tasks')) {
    const r = await tasksRoute(req.method ?? '', url, () => body(req));
    if (r) return send(res, r.status, r.body);
  }
  if (req.method === 'GET') {
    if (url === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'history', busy: new URL(req.headers.referer ?? 'http://x/').searchParams.get('s') === 'working', turns: scene.turns, approvals: scene.approvals.filter(a => a.status === 'pending'), work: { at: '', rows: withTerms(scene.rows) }, hidden: scene.hidden, requests: scene.requests, asks: scene.items.map(cardOf), audit: scene.audit, messages: messagesOf(scene), today: today.list(), migration: migration.state(), brain: brainInfo(), session: 'preview' })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (/^\/api\/speech\/\d+\/\d+$/.test(url)) {
      const clip = toneClip(), range = byteRange(req.headers.range, clip.length);
      if (!range || range === 'bad') { res.writeHead(200, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-length': clip.length }); return res.end(clip); }
      res.writeHead(206, { 'content-type': 'audio/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${range.start}-${range.end}/${clip.length}`, 'content-length': range.end - range.start + 1 });
      return res.end(clip.subarray(range.start, range.end + 1));
    }
    if (/^\/api\/fold\/\d+$/.test(url)) return send(res, 200, { steps: FOLD_STEPS });
    if (url === '/api/audit') return send(res, 200, scene.audit);
    if (url === '/api/requests') return send(res, 200, scene.requests);
    const docAt = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
    if (url === '/api/reports') return send(res, 200, SAMPLE_DOCS.map(d => ({ path: d.path, title: d.title, at: docAt(d.min) })));
    if (url === '/api/reports/file') {
      const d = SAMPLE_DOCS.find(x => x.path === new URL(req.url!, 'http://x').searchParams.get('path'));
      return d ? send(res, 200, { path: d.path, title: d.title, at: docAt(d.min), body: d.body }) : send(res, 404, { error: 'Only .md files in data/reports can be opened.' });
    }
    const reportOf = /^\/api\/requests\/(\d+)\/report$/.exec(url);
    if (reportOf) {
      const sample = SAMPLE_REPORTS[Number(reportOf[1])], r = scene.requests.find(x => x.id === Number(reportOf[1]));
      return sample && r ? send(res, 200, { id: r.id, title: r.title, status: r.status, at: r.at, failed: false, ...sample }) : send(res, 404, { error: 'No report is stored for this request.' });
    }
    // A request with no conversation: a short sample record, or the file from PREVIEW_CLOSED.
    const closed = /^\/api\/work\/req(?:%3A|:)(\d+)\/read$/i.exec(url);
    if (closed) {
      if (CLOSED && Number(closed[1]) === CLOSED.detail.id) return send(res, 200, CLOSED);
      const r = scene.requests.find(x => x.id === Number(closed[1]));
      return r ? send(res, 200, { lines: [], detail: { ...r, worktree: 'sample', history: [{ at: r.startedAt, kind: 'approval', title: 'Worker start: done by button', text: 'Start a worker?' }, { at: r.at, kind: 'status', title: `Status: working to ${r.status}`, failed: r.status === 'failed' }], transcript: false } }) : send(res, 404, { error: 'Jarvis has no record of it.' });
    }
    if (url === '/api/work') return send(res, 200, { at: '', rows: withTerms(scene.rows), hidden: scene.hidden, repos: PREVIEW_REPOS });
    if (url === '/api/listen/config') return send(res, 200, { client: {}, wakeWord: false });
    if (url === '/api/push/key') return send(res, 200, { publicKey: '' });
    if (/^\/api\/work\/[^/]+\/read$/.test(url)) return send(res, 200, new URL(req.url!, 'http://x').searchParams.get('cursor') ? { lines: [], cursor: 'end' } : { lines: LINES, cursor: 'end' });
    if (url === '/image') {
      const up = uploads.get(new URL(req.url!, 'http://x').searchParams.get('path') ?? '');
      if (up) { res.writeHead(200, { 'content-type': up.type }); return res.end(up.bytes); }
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="520" height="320"><rect width="520" height="320" fill="#fff"/><text x="20" y="34" font-family="sans-serif" font-size="16" font-weight="600" fill="#111">Sample picture</text>${[60, 96, 132, 168, 204, 240, 276].map(y => `<rect x="20" y="${y}" width="480" height="14" rx="3" fill="#E4E4E1"/>`).join('')}</svg>`);
    }
    const file = normalize(join(WEB, url === '/' ? 'index.html' : url));
    if (file.startsWith(WEB) && existsSync(file)) {
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(readFileSync(file));
    }
    return send(res, 404);
  }
  if (req.method !== 'POST') return send(res, 404);
  // The picker's Start: nothing starts in the preview, it answers like the gate would.
  if (url === '/api/work/side-chat') return send(res, 200, { status: 'done', result: JSON.stringify({ worker: 'n:preview1', name: 'side-chat-preview' }) });
  // The microphone here hears nothing, so a recording adds this sample line.
  if (url === '/api/today/voice') { for await (const _ of req) {} const r = today.add({ words: 'Sample words from the microphone', go: new URL(req.url!, 'http://x').searchParams.get('go') === '1' }); return send(res, r.status, { words: 'Sample words from the microphone', ...r.body }); }
  // An attached picture stays in this process's memory, under a made-up path that /image serves back. Nothing is written.
  if (url === '/api/upload') {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const path = `/preview/uploads/${uploads.size + 1}.${String(req.headers['content-type']).split('/')[1] ?? 'png'}`;
    uploads.set(path, { type: String(req.headers['content-type']), bytes: Buffer.concat(parts) });
    console.log(`upload ${path}: ${req.headers['content-type']}, ${uploads.get(path)!.bytes.length} bytes`);
    return send(res, 200, { path });
  }
  const b = await body(req).catch(() => ({}));
  if (url.startsWith('/api/migration/')) {
    const r = migrationRoute(migration, 'POST', url, b);
    if (r) return send(res, r.status, r.body);
  }
  if (url.startsWith('/api/today/')) {
    const r = await todayRoute(today, 'POST', url, b, { fromOwner: () => true });
    if (r) return send(res, r.status, r.body);
  }
  if (url === '/api/ask/answer') {
    const i = scene.items.find(x => x.external_id === b.id);
    if (!i) return send(res, 404, { error: 'That ask is not known here.' });
    i.status = 'answered'; i.answer = b.value;
    out({ type: 'ask', ask: cardOf(i) });
    return send(res, 200, { ask: cardOf(i) });
  }
  if (url === '/api/approval') {
    const a = scene.approvals.find(x => x.id === Number(b.id));
    if (!a) return send(res, 404, { error: 'not found' });
    Object.assign(a, { status: b.approve ? 'done' : 'rejected', decided_by: 'button', result: b.approve ? 'preview: nothing ran' : null });
    out({ type: 'approval', approval: a });
    return send(res, 200, a);
  }
  // A new email arriving while the page is open, for checking that it only changes the button.
  if (url === '/api/preview/email') {
    const id = `gmail:new${scene.emails.length}`;
    scene.emails.push(item(id, 0, { source: 'gmail', kind: 'email', subject: 'Site is down', body: 'The dealer site returns an error.', meta: JSON.stringify({ gmailId: id, threadId: 't_new', from: 'new@example.test', fromName: 'New Sender', replyTo: 'new@example.test', subject: 'Site is down', urgent: b.urgent === true, needsReply: true, reply: 'Looking at it now.' }) }));
    out({ type: 'messages', messages: messagesOf(scene) });
    return send(res, 200, { id });
  }
  if (url === '/api/message/send' || url === '/api/message/handled') {
    const i = scene.emails.find(x => x.external_id === b.id);
    if (!i || i.status !== 'spoken') return send(res, 409, { error: 'That message is no longer open.', messages: messagesOf(scene) });
    i.status = 'answered';
    if (url === '/api/message/send') out({ type: 'approval', approval: { id: 100 + i.id + scene.emails.indexOf(i), action: 'gmail-send', args: JSON.stringify({ item: b.id, to: JSON.parse(i.meta!).replyTo, cc: '', text: b.text }), say: 'Send the reply?', status: 'done', decided_by: 'button', result: 'preview: nothing ran', created_at: ago(0) } });
    out({ type: 'messages', messages: messagesOf(scene) });
    return send(res, 200, { messages: messagesOf(scene) });
  }
  if (url === '/api/requests/hide') {
    scene.requests = scene.requests.filter(r => r.id !== Number(b.id));
    out({ type: 'requests', requests: scene.requests });
    return send(res, 204);
  }
  if (url === '/api/work/hide') {
    scene.hidden = b.hidden === false ? scene.hidden.filter(x => x !== b.id) : [...scene.hidden, b.id];
    out({ type: 'hidden', hidden: scene.hidden });
    return send(res, 200, { hidden: scene.hidden });
  }
  if (url === '/api/send') {
    // A reply quotes a turn of the scene or one sent here. The line the brain would get goes to the console.
    const replyTo = replyIdOf(b.replyTo);
    const quote = replyTo ? quoteOf((scene.turns as TurnRow[]).find(x => x.id === replyTo) ?? sentTurns.get(replyTo)) : undefined;
    if (quote) console.log(`brain gets: ${quoteLine(quote)}`);
    const ownerTurn = nextTurn++;
    sentTurns.set(ownerTurn, { id: ownerTurn, role: 'owner', text: b.text, created_at: ago(0) });
    out({ type: 'turn', role: 'owner', text: b.text, turnId: ownerTurn, quote, at: new Date().toISOString() });
    // A turn as the daemon reports one: working, then the fold, then the reply.
    out({ type: 'working', on: true });
    setTimeout(() => {
      out({ type: 'working', on: false });
      out({ type: 'fold', id: 901, ms: 12_000, at: new Date().toISOString() });
      const turnId = nextTurn++, text = 'Preview only. Nothing was sent.';
      sentTurns.set(turnId, { id: turnId, role: 'jarvis', text, created_at: ago(0) });
      out({ type: 'turn', role: 'jarvis', text, turnId, clips: clipCount(text), at: new Date().toISOString() });
      out({ type: 'audio', turnId, i: 0, total: clipCount(text) });
    }, 800);
    return send(res, 204);
  }
  // Continue on phone: the first tap meets a terminal holding the session, the "Stop it and continue" tap succeeds.
  if (url === '/api/work/phone') {
    if (!Array.isArray((b as any).stop)) return send(res, 409, { error: 'Another process has this session open: pid 4100, claude --resume … in a terminal.', holders: [{ pid: 4100, what: 'claude --resume 9b765826-… --remote-control=Old (a terminal)' }] });
    return send(res, 200, { id: (b as any).id, remote: 'Photo sync dry runs', already: false });
  }
  if (url === '/api/work/stop') {
    const a = { id: 20 + scene.approvals.length, action: 'worker-stop', args: JSON.stringify({ dispatch: b.id }), say: 'Stop this worker?', status: 'pending', after_turn: 0, decided_by: null, owner_text: null, result: null, created_at: ago(0) };
    scene.approvals.push(a);
    return send(res, 200, { approval: a });
  }
  send(res, 200, {}); // every other press does nothing here
}).listen(PORT, '127.0.0.1', () => console.log(`Preview on http://127.0.0.1:${PORT} (?s=question, requests, messages, approval, empty, fr, escalation, failed, reports, docs, today). It writes nothing.`));
