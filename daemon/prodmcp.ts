import { OWNER_CAP } from './config.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROD_MCP_URL, TICKET_PREFIX, PRODUCT_KEY, PRODUCT_LABEL } from './config.ts';

// One call to a production AcmeApp MCP tool, run by jarvisd when the owner taps Approve. Claude Code's permission check refuses
// workers on these tools whatever the owner said. The card and the call both read the same stored tool and arguments.

export const PROD_MCP_CALL = 'prod-mcp-call';
const PROD_URL = PROD_MCP_URL;
/** jarvisd's own credential, under gitignored data/. The key itself goes in no log, card or result. */
const KEY_FILE = fileURLToPath(new URL(`../data/${PRODUCT_KEY}-prod-mcp.key`, import.meta.url));
/** A tool whose name contains one of these is never offered. This is the one refusal list. */
export const REFUSED_TOOL_WORDS = ['delete'];
const WORKER_PREFIX = `mcp__${PRODUCT_KEY}-prod__`;
/** Production's route allows 60 s, so a slower answer is a lost one. */
const TIMEOUT_MS = 90_000;
const MAX_PAGES = 20;

type Outcome = { status: 'done' | 'failed' | 'unknown'; result: string };
type Answer = { http: number; session?: string; message?: any };
export type ProdOptions = { url?: string; token?: () => string };

/** The bare tool name. A worker quotes it with Claude Code's prefix. Throws on anything refused. */
export function prodToolName(v: unknown): string {
  if (typeof v !== 'string') throw new Error(`tool is required: a production ${PRODUCT_LABEL} MCP tool name`);
  const tool = v.startsWith(WORKER_PREFIX) ? v.slice(WORKER_PREFIX.length) : v;
  if (!/^[A-Za-z][\w-]*$/.test(tool)) throw new Error(`tool must be a production ${PRODUCT_LABEL} MCP tool name, got ${JSON.stringify(v)}`);
  const word = REFUSED_TOOL_WORDS.find(w => tool.toLowerCase().includes(w));
  if (word) throw new Error(`${tool} is refused: a tool whose name contains "${word}" never runs from this card. ${OWNER_CAP} does that at a screen.`);
  return tool;
}

function prodArguments(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('arguments must be a JSON object');
  return v as Record<string, unknown>;
}

/** Throws on bad input, at the proposal and again just before the call. */
export function checkProdCall(args: any): { tool: string; arguments: Record<string, unknown> } {
  return { tool: prodToolName(args.tool), arguments: prodArguments(args.arguments) };
}

/** Marks characters a phone would hide, such as a zero-width space, so the card cannot read differently from the call. */
const visible = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, c => c === '\n' || c === '\t' ? c : `\\u{${c.codePointAt(0)!.toString(16)}}`);

function shownValue(key: string, value: unknown): string {
  const text = typeof value === 'string' ? visible(value) : visible(JSON.stringify(value, null, 2) ?? String(value));
  // The indent keeps a line inside a long value from reading as another argument.
  return text.includes('\n') ? `${key}:\n${text.split('\n').map(l => `  ${l}`).join('\n')}` : `${key}: ${text}`;
}

/** Every argument, whole. */
export function shownArguments(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  return keys.length ? keys.map(k => shownValue(k, args[k])).join('\n') : 'None';
}

/** What gets stored and shown. */
export function prodCard(call: { tool: string; arguments: Record<string, unknown> }, touches: string) {
  const runs = `On production ${PRODUCT_LABEL}. jarvisd makes this one call only when you tap Approve.\n\nTool: ${call.tool}\n\nTouches:\n${touches}\n\nArguments, in full:\n${shownArguments(call.arguments)}\n\nThen it reports what production answers.`;
  return { ...call, touches, runs };
}

/** Tickets and dealerships the arguments name, at any depth. */
function targets(v: unknown, key = ''): { tickets: string[]; dealerships: string[] } {
  const found = { tickets: [] as string[], dealerships: [] as string[] };
  const add = (t: { tickets: string[]; dealerships: string[] }) => { found.tickets.push(...t.tickets); found.dealerships.push(...t.dealerships); };
  if (typeof v === 'string' && new RegExp(`^${TICKET_PREFIX}-\\d+$`, 'i').test(v)) found.tickets.push(v.toUpperCase());
  else if ((typeof v === 'string' || typeof v === 'number') && /dealership|concession/i.test(key)) found.dealerships.push(String(v));
  else if (Array.isArray(v)) v.forEach(x => add(targets(x, key)));
  else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => add(targets(x, k)));
  return found;
}

const textOf = (result: any): string => (Array.isArray(result?.content) ? result.content : []).filter((c: any) => c?.type === 'text').map((c: any) => String(c.text)).join('\n');

function parsed(text: string): any {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function makeProdMcp(options: ProdOptions = {}) {
  const url = options.url ?? PROD_URL;
  const token = options.token ?? (() => {
    try { return readFileSync(KEY_FILE, 'utf8').trim(); }
    catch { return ''; }
  });
  let nextId = 1;

  function secret(): string {
    const t = token();
    if (!t) throw new Error(`jarvisd has no production ${PRODUCT_LABEL} MCP credential yet`);
    return t;
  }
  const scrub = (s: string, t: string) => s.replaceAll(t, '[hidden]');

  async function post(t: string, method: string, params: unknown, session?: string): Promise<Answer> {
    const id = method.startsWith('notifications/') ? undefined : nextId++;
    const res = await fetch(url, {
      method: 'POST',
      // A redirect must not carry the credential to another address.
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${t}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }),
    });
    const body = await res.text();
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? body.split('\n').filter(l => l.startsWith('data:')).map(l => parsed(l.slice(5).trim()))
      : [parsed(body)];
    return { http: res.status, session: res.headers.get('mcp-session-id') ?? session, message: messages.find(m => m?.id === id) };
  }

  /** Starts a session. Throws when production will not, and in that case no tool ran. */
  async function open(t: string): Promise<string | undefined> {
    const init = await post(t, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jarvisd', version: '1' } });
    if (init.http === 401 || init.http === 403) throw new Error(`production refused jarvisd's credential (HTTP ${init.http})`);
    if (init.http >= 300 || !init.message?.result) throw new Error(`production did not start a session (HTTP ${init.http})`);
    await post(t, 'notifications/initialized', {}, init.session);
    return init.session;
  }

  /** Every tool this credential can see on production. */
  async function tools(): Promise<string[]> {
    const t = secret();
    try {
      const session = await open(t);
      const names: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await post(t, 'tools/list', cursor ? { cursor } : {}, session);
        const list = r.message?.result?.tools;
        if (r.http >= 300 || !Array.isArray(list)) throw new Error(`production gave no tool list (HTTP ${r.http})`);
        names.push(...list.map((x: any) => String(x.name)));
        cursor = r.message.result.nextCursor;
        if (!cursor) return names;
      }
      throw new Error('production\'s tool list did not end');
    } catch (e) { throw new Error(scrub((e as Error).message, t)); }
  }

  /** A read for the card's wording. The card still shows the target without it, so a failure costs only the name. */
  async function lookup(t: string, session: string | undefined, known: string[], tool: string, args: object): Promise<any> {
    if (!known.includes(tool)) return undefined;
    try {
      const r = await post(t, 'tools/call', { name: tool, arguments: args }, session);
      return r.http < 300 && !r.message?.result?.isError ? parsed(textOf(r.message?.result)) : undefined;
    } catch { return undefined; }
  }

  async function touches(args: Record<string, unknown>, known: string[]): Promise<string> {
    const { tickets, dealerships } = targets(args);
    if (!tickets.length && !dealerships.length) return 'No ticket or dealership is named in the arguments. Production works it out from the target above.';
    const t = secret();
    const session = await open(t).catch(() => undefined);
    const lines = await Promise.all([
      ...[...new Set(tickets)].map(async ref => {
        const title = (await lookup(t, session, known, 'support_ticket_get', { reference: ref }))?.titre;
        return `Support ticket ${ref}${title ? `, "${visible(String(title))}"` : ''}`;
      }),
      ...[...new Set(dealerships)].map(async d => {
        const p = await lookup(t, session, known, 'dealerships_get', { dealership_id: d });
        const name = p?.name ?? p?.nom ?? p?.dealership_name;
        return `Dealership ${d}${name ? `, ${visible(String(name))}` : ''}`;
      }),
    ]);
    return lines.join('\n');
  }

  return {
    /** Refuses a tool production does not have. What gets stored and shown: the checked call and the card's words, built here, so anything the brain sent under `runs` or `touches` is dropped. */
    async cardArgs(args: any) {
      const call = checkProdCall(args);
      const known = await tools().catch(e => { throw new Error(`Could not check ${call.tool} against production, so nothing was proposed: ${(e as Error).message}`); });
      if (!known.includes(call.tool)) throw new Error(`${call.tool} does not exist on the production ${PRODUCT_LABEL} server for this credential.`);
      const where = await touches(call.arguments, known);
      return prodCard(call, where);
    },

    /** The call itself, once. The answer decides the status, and no answer is unknown, because the call may have landed. */
    async run(args: any): Promise<Outcome> {
      const { tool, arguments: callArgs } = checkProdCall(args);
      let t = '';
      let session: string | undefined;
      try {
        t = secret();
        session = await open(t);
      } catch (e) {
        return { status: 'failed', result: `Nothing ran: ${scrub((e as Error).message, t || '\0')}.` };
      }
      let r: Answer;
      try { r = await post(t, 'tools/call', { name: tool, arguments: callArgs }, session); }
      catch { return { status: 'unknown', result: `Production gave no answer to ${tool}, so it may or may not have run. Check before trying again.` }; }
      const said = (s: string) => scrub(s, t).slice(0, 500);
      if (r.http === 401 || r.http === 403) return { status: 'failed', result: `Production refused the call to ${tool} (HTTP ${r.http}).` };
      if (r.http >= 500) return { status: 'unknown', result: `Production answered HTTP ${r.http} to ${tool}, so it may or may not have run. Check before trying again.` };
      if (r.http >= 300) return { status: 'failed', result: `Production refused the call to ${tool} (HTTP ${r.http}).` };
      if (r.message?.error) return { status: 'failed', result: `Production refused ${tool}: ${said(String(r.message.error.message ?? r.message.error.code))}` };
      const result = r.message?.result;
      if (!Array.isArray(result?.content)) return { status: 'unknown', result: `Production's answer to ${tool} had no result, so it may or may not have run. Check before trying again.` };
      const text = textOf(result);
      const json = parsed(text);
      if (result.isError || json?.error === true) return { status: 'failed', result: `Production refused ${tool}: ${said(String(json?.message ?? text ?? 'no reason given'))}` };
      return { status: 'done', result: `Production confirmed ${tool}: ${said(text)}` };
    },
  };
}

export type ProdMcp = ReturnType<typeof makeProdMcp>;
