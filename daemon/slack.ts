import type { Store, SlackRule } from './store.ts';
import type { Log } from './log.ts';

// Slack, read only. jarvisd holds a Socket Mode websocket with the app token (xapp) and reads names with the owner's
// user token (xoxp), so it sees every conversation the owner is in. It never posts: the app has no write scope.
// The owner's rules (bin/jarvis-slack, table slack_rules) decide which messages reach the brain. The rest are only counted.

export type SlackMessage = {
  channel: string; channelType: string; user: string; text: string; ts: string; thread?: string;
};
/** What a message resolves to before the rules: the conversation and author by id and by every name they go by. */
export type Resolved = {
  msg: SlackMessage; im: boolean;
  /** "#support", "DM", "group DM" */
  where: string; channelNames: string[];
  who: string; userNames: string[];
};
export type Verdict = { notify: boolean; urgent: boolean; rule?: number };

export const RULE_KINDS = ['channel', 'dm', 'person'] as const;
export const RULE_ACTIONS = ['notify', 'mute'] as const;
const URGENT_WORDS = /\b(urgent|urgently|asap|emergency|urgence|urgente?s?)\b/i;
export const COUNTS_KEY = 'slack_counts';

/** A rule target as the matcher compares it: lower case, no leading # or @. */
export const norm = (s: string) => s.trim().replace(/^[#@]/, '').toLowerCase();

/**
 * Which rule decides: a person rule first, then a rule on this conversation (a channel, or the DM with that person),
 * then `dm *` for every DM and group DM. On one level, mute wins. No rule means the message is dropped.
 * So "mute #random" and "notify person Pat" together still bring Pat's messages in #random.
 */
export function decide(rules: SlackRule[], r: Resolved): Verdict {
  const has = (names: string[], t: string) => names.includes(norm(t));
  const levels = [
    rules.filter(x => x.kind === 'person' && has(r.userNames, x.target)),
    rules.filter(x => (x.kind === 'channel' && !r.im && has(r.channelNames, x.target)) || (x.kind === 'dm' && r.msg.channelType === 'im' && has(r.userNames, x.target))),
    rules.filter(x => x.kind === 'dm' && x.target === '*' && r.im),
  ];
  for (const level of levels) {
    if (!level.length) continue;
    const mute = level.find(x => x.action === 'mute');
    if (mute) return { notify: false, urgent: false, rule: mute.id };
    const urgentRule = level.find(x => x.urgent);
    return { notify: true, urgent: !!urgentRule || URGENT_WORDS.test(r.msg.text), rule: (urgentRule ?? level[0]).id };
  }
  return { notify: false, urgent: false };
}

/** Slack markup as plain words: <@U1> becomes @name, <#C1|general> becomes #general, <url|label> becomes label. One line, at most `max` characters. */
export function summary(text: string, names: Map<string, string> = new Map(), max = 160): string {
  const plain = text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label ?? names.get(id) ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain || '(no text)';
}

/** The line the brain reads, like the [email] line. */
export function eventLine(r: Resolved, v: Verdict, names?: Map<string, string>): string {
  return `- [slack] from=${JSON.stringify(r.who)} where=${JSON.stringify(r.where)} urgent=${v.urgent}${r.msg.thread ? ' in_thread=true' : ''} summary=${JSON.stringify(summary(r.msg.text, names))}`;
}

/** The message an `events_api` envelope carries, or undefined for one the rules never see: edits, deletes, bots, the owner's own. */
export function messageOf(event: any, self: string): SlackMessage | undefined {
  if (event?.type !== 'message') return undefined;
  if (event.subtype && !['thread_broadcast', 'file_share', 'me_message'].includes(event.subtype)) return undefined;
  if (!event.user || event.bot_id || event.user === self || !event.channel || !event.ts) return undefined;
  return {
    channel: event.channel, channelType: event.channel_type ?? '', user: event.user, text: String(event.text ?? ''), ts: event.ts,
    ...(event.thread_ts && event.thread_ts !== event.ts ? { thread: event.thread_ts } : {}),
  };
}

// ---- Counts ----

export type Counts = { matched: number; dropped: number; muted: number; since: string };
export function readCounts(store: Pick<Store, 'getState'>): Counts {
  try { return { matched: 0, dropped: 0, muted: 0, since: '', ...JSON.parse(store.getState(COUNTS_KEY) ?? '{}') }; }
  catch { return { matched: 0, dropped: 0, muted: 0, since: '' }; }
}
function bump(store: Pick<Store, 'getState' | 'setState'>, key: 'matched' | 'dropped' | 'muted') {
  const c = readCounts(store);
  c[key]++;
  if (!c.since) c.since = new Date().toISOString();
  store.setState(COUNTS_KEY, JSON.stringify(c));
}

// ---- Slack Web API, read only ----

type Fetch = typeof fetch;
export type Api = (method: string, params: Record<string, string>, token: string) => Promise<any>;
/** A Web API call. Only read methods and apps.connections.open are called. A response with ok=false throws. */
export const makeApi = (f: Fetch = fetch): Api => async (method, params, token) => {
  const post = method === 'apps.connections.open';
  const res = await f(`https://slack.com/api/${method}${post ? '' : `?${new URLSearchParams(params)}`}`,
    { method: post ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const j = await res.json() as any;
  if (!j.ok) throw new Error(`slack ${method}: ${j.error ?? res.status}`);
  return j;
};

// ---- The connection ----

export type Socket = {
  send(data: string): void; close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', fn: (e: any) => void): void;
};
export type SlackDeps = {
  store: Store; log: Log; userToken: string; appToken: string;
  api?: Api; socket?: (url: string) => Socket;
  /** A message that matched a notify rule. */
  onMatch: (line: string, r: Resolved, v: Verdict, summary: string) => void;
  setTimeout?: typeof setTimeout;
};
export type SlackStatus = { state: 'off' | 'connecting' | 'connected' | 'failed'; detail?: string; at: string };

export function makeSlack(d: SlackDeps) {
  const api = d.api ?? makeApi();
  const open = d.socket ?? ((url: string) => new WebSocket(url) as unknown as Socket);
  const later = d.setTimeout ?? setTimeout;
  const users = new Map<string, { names: string[]; label: string }>();
  const channels = new Map<string, { names: string[]; where: string; im?: string }>();
  const seen: string[] = [];
  let self = '';
  let status: SlackStatus = { state: 'connecting', at: new Date().toISOString() };
  let sock: Socket | undefined;
  let stopped = false;
  let tries = 0;
  const set = (state: SlackStatus['state'], detail?: string) => { status = { state, ...(detail ? { detail } : {}), at: new Date().toISOString() }; };

  async function user(id: string) {
    if (!users.has(id)) {
      try {
        const u = (await api('users.info', { user: id }, d.userToken)).user ?? {};
        const p = u.profile ?? {};
        const label = p.real_name || u.real_name || p.display_name || u.name || id;
        users.set(id, { label, names: [id, u.name, u.real_name, p.real_name, p.display_name, ...(String(p.real_name || u.real_name || '').split(/\s+/).slice(0, 1))].filter(Boolean).map(norm) });
      } catch (e) {
        d.log(`slack: user ${id} not read: ${(e as Error).message}`);
        return { label: id, names: [norm(id)] };
      }
    }
    return users.get(id)!;
  }

  async function channel(id: string, type: string) {
    if (!channels.has(id)) {
      try {
        const c = (await api('conversations.info', { channel: id }, d.userToken)).channel ?? {};
        const im = c.is_im || type === 'im';
        const where = im ? 'DM' : c.is_mpim || type === 'mpim' ? 'group DM' : `#${c.name ?? id}`;
        channels.set(id, { where, names: [id, c.name].filter(Boolean).map(norm), ...(im && c.user ? { im: c.user } : {}) });
      } catch (e) {
        d.log(`slack: channel ${id} not read: ${(e as Error).message}`);
        return { where: type === 'im' ? 'DM' : type === 'mpim' ? 'group DM' : id, names: [norm(id)] };
      }
    }
    return channels.get(id)!;
  }

  async function resolve(m: SlackMessage): Promise<Resolved> {
    const [u, c] = await Promise.all([user(m.user), channel(m.channel, m.channelType)]);
    return { msg: m, im: m.channelType === 'im' || m.channelType === 'mpim', where: c.where, channelNames: c.names, who: u.label, userNames: u.names };
  }

  /** One message: the rules decide, then it goes to the brain or is only counted. */
  async function handle(event: any) {
    const m = messageOf(event, self);
    if (!m) return;
    const key = `${m.channel}:${m.ts}`;
    if (seen.includes(key)) return; // Slack redelivers an envelope that was not acked in time
    seen.push(key);
    if (seen.length > 500) seen.shift();
    const r = await resolve(m);
    const v = decide(d.store.slackRules(), r);
    if (!v.notify) { bump(d.store, v.rule ? 'muted' : 'dropped'); return; }
    bump(d.store, 'matched');
    const names = new Map([...users].map(([id, u]) => [id, u.label]));
    d.log('slack match', { rule: v.rule, urgent: v.urgent, where: r.where });
    d.onMatch(eventLine(r, v, names), r, v, summary(r.msg.text, names));
  }

  function retry(why: string) {
    sock = undefined;
    if (stopped) return;
    tries++;
    const wait = Math.min(300_000, 2_000 * 2 ** Math.min(tries, 8));
    d.log(`slack: reconnect in ${Math.round(wait / 1000)} s (${why})`);
    later(() => { connect().catch(e => { set('failed', String(e)); retry(String(e)); }); }, wait);
  }

  async function connect() {
    set('connecting');
    if (!self) self = (await api('auth.test', {}, d.userToken)).user_id ?? '';
    const { url } = await api('apps.connections.open', {}, d.appToken);
    const s = open(url);
    sock = s;
    let closed = false;
    const drop = (why: string) => { if (closed) return; closed = true; try { s.close(); } catch {} retry(why); };
    s.addEventListener('message', e => {
      let env: any;
      try { env = JSON.parse(String(e.data)); } catch { return; }
      if (env.envelope_id) s.send(JSON.stringify({ envelope_id: env.envelope_id })); // ack first, within Slack's 3 seconds
      if (env.type === 'hello') { tries = 0; set('connected'); d.log('slack: connected'); }
      else if (env.type === 'disconnect') drop(`slack asked: ${env.reason ?? 'disconnect'}`);
      else if (env.type === 'events_api') handle(env.payload?.event).catch(err => d.log(`slack: message not handled: ${err}`));
    });
    s.addEventListener('close', () => drop('socket closed'));
    s.addEventListener('error', e => drop(`socket error: ${e?.message ?? 'unknown'}`));
  }

  return {
    status: () => status,
    handle,
    start() {
      connect().catch(e => {
        const msg = (e as Error).message;
        // A bad or revoked token never fixes itself: stop instead of retrying forever.
        if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(msg)) { set('failed', `auth failed: ${msg}`); d.log(`slack: auth failed (${msg}), off until the tokens in .env change`); return; }
        set('failed', msg); retry(msg);
      });
    },
    stop() { stopped = true; sock?.close(); set('off', 'stopped'); },
  };
}
export type Slack = ReturnType<typeof makeSlack>;

// ---- Internal routes for bin/jarvis-slack ----

/** The routes jarvis-slack calls. Undefined when the URL is not one of them. */
export function slackRoute(store: Store, log: Log, status: () => SlackStatus, method: string, url: string, b: Record<string, unknown>): { status: number; body: unknown } | undefined {
  const base = '/api/internal/slack/rules';
  if (method === 'GET' && url === base) return { status: 200, body: { slack: status(), counts: readCounts(store), rules: store.slackRules() } };
  if (method === 'POST' && url === base) {
    const { kind, action } = b;
    const target = typeof b.target === 'string' ? b.target.trim() : '';
    const urgent = b.urgent === true;
    if (!RULE_KINDS.includes(kind as any)) return { status: 400, body: { error: `kind must be one of ${RULE_KINDS.join(', ')}` } };
    if (!RULE_ACTIONS.includes(action as any)) return { status: 400, body: { error: `action must be one of ${RULE_ACTIONS.join(', ')}` } };
    if (!target) return { status: 400, body: { error: 'a target is required: a channel name, a person, or * for every DM' } };
    if (target === '*' && kind !== 'dm') return { status: 400, body: { error: '* works only with dm' } };
    if (urgent && action === 'mute') return { status: 400, body: { error: '--urgent works only with notify' } };
    const t = target === '*' ? '*' : norm(target);
    if (store.slackRules().some(r => r.kind === kind && r.target === t)) return { status: 409, body: { error: `a ${kind} rule for ${t} already exists: remove it first` } };
    const r = store.addSlackRule(kind as SlackRule['kind'], t, action as SlackRule['action'], urgent);
    log('slack rule added', { rule: r.id, kind: r.kind, target: r.target, action: r.action, urgent: r.urgent });
    return { status: 200, body: r };
  }
  const rm = method === 'POST' && url.match(/^\/api\/internal\/slack\/rules\/(\d+)\/remove$/);
  if (rm) {
    const r = store.removeSlackRule(Number(rm[1]));
    if (!r) return { status: 404, body: { error: `no rule ${rm[1]}` } };
    log('slack rule removed', { rule: r.id });
    return { status: 200, body: r };
  }
  return undefined;
}
