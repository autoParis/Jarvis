// The names that daemon, web and vault share: gate actions, live-update event types and statuses. jarvisd imports this
// file and serves it to the page as it is, so both read the same list. daemon/contract.test.ts checks every layer
// against it, and checks that every `jarvis-*` command in vault/*.md exists in bin/.

/**
 * Every action the gate knows, with what it is:
 * - startsWorker: Approve starts a native worker, and its done result names it.
 * - automatic: runs at once with no card (the brain proposes it, the owner is told).
 * - pressed: a work-list button. Pressing it is the owner's decision, so it runs at once, and the brain cannot propose it.
 * - buttonOnly: runs only on the Approve button, never on a relayed yes.
 * - readsBack: its result says what it did, so the decided card shows it.
 */
export const ACTIONS = {
  'worker-start': { startsWorker: true },
  'question': { startsWorker: true, automatic: true },
  'side-chat': { startsWorker: true, pressed: true },
  'today-start': { startsWorker: true, pressed: true },
  'today-draft': { startsWorker: true, pressed: true },
  'session-type': { pressed: true },
  'session-phone': { pressed: true },
  'today-issue': { pressed: true },
  'worker-stop': {},
  'worker-abandon': {},
  'gh-issue-create': {},
  'terminal-send': { buttonOnly: true, readsBack: true },
  'gmail-send': { buttonOnly: true },
  'gh-pr-close': { buttonOnly: true, readsBack: true },
  'fbm-client-pause': { buttonOnly: true, readsBack: true },
  'prod-mcp-call': { buttonOnly: true, readsBack: true },
  'worker-permission': { buttonOnly: true },
};

/** The names of the actions that have this property. */
export const actionsWith = prop => new Set(Object.keys(ACTIONS).filter(a => ACTIONS[a][prop]));

/** The `type` of each message on the live-update stream (/api/events) from jarvisd to the page. */
export const EVENTS = ['history', 'turn', 'event', 'ask', 'working', 'fold', 'approval', 'pane', 'work', 'completed', 'requests',
  'messages', 'today', 'stories', 'migration', 'brain', 'audio', 'version'];

/** The status of an approval (approvals.status). */
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'done', 'failed', 'unknown'];
/** The status of a reminder. */
export const REMINDER_STATUSES = ['open', 'fired', 'done'];
/** The status of a Today row. */
export const TODAY_STATUSES = ['new', 'waiting', 'queued', 'working', 'ready', 'released', 'dropped', 'moved'];
/** The status of a support reply that waits for its fix to reach production. */
export const SUPPORT_REPLY_STATUSES = ['waiting', 'held', 'sending', 'sent', 'failed', 'unknown', 'dropped'];
/**
 * The status of a work-list row, a native worker or a project terminal (daemon/work.ts WorkStatus), with its reason:
 * - idle: nothing runs: a shell prompt, a session stopped after an hour idle, a side chat between turns.
 * - working: a turn or a program runs. Silence alone never changes it.
 * - blocked: it cannot go on without the owner. The reason says why (BLOCKED_REASONS).
 * - done: the worker reported DONE or FAILED. The reason is "failed" for a FAILED report.
 */
export const WORK_STATUSES = ['idle', 'working', 'blocked', 'done'];
/**
 * Why a row is blocked. permission: a permission card. question: an ask card. waiting on you: a WAITING line only the
 * owner ends. login and usage limit also come from Claude Code's own words in `claude agents` (screen.ts needsReason).
 * The rest come from a screen read (screen.ts BLOCKING_PROMPTS): the folder trust prompt, a login or first-run screen,
 * the MCP server approval, a settings error dialog, and any other Claude Code dialog (prompt on screen).
 */
export const BLOCKED_REASONS = ['permission', 'question', 'waiting on you', 'trust prompt', 'login', 'usage limit', 'mcp servers', 'settings error', 'prompt on screen'];
/** "blocked: login", "done: failed", "working". */
export const statusText = s => s ? (s.reason ? `${s.name}: ${s.reason}` : s.name) : '';
/** The status of a row in the Requests sidebar. */
export const REQUEST_STATUSES = ['waiting', 'working', 'review', 'done', 'failed'];

/**
 * The page address of a report in data/reports, or of the Reports list when `path` is empty. The page opens it in the
 * report viewer. An ask card, a request row and a push for an ask with a report all link here.
 */
export const docHref = path => path ? `#reports/${encodeURIComponent(path)}` : '#reports';
