import { OWNER } from './config.ts';
import type http from 'node:http';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { UI_HEADER } from './access.ts';
import { TERM_HEADER, type TermGate } from './termgate.ts';
import { NAME, type Key, type TermKind } from './terminal.ts';
import type { makeTerminals } from './terminal.ts';
import type { Log } from './log.ts';

// The project terminal's routes, /api/term/*. Every route but the list needs a live UI secret, and every route that
// opens, reads, types into or ends a terminal needs a token from termgate.ts.

export type TermCtx = {
  terms: ReturnType<typeof makeTerminals>; gate: TermGate; log: Log;
  /** Is this page's UI secret live (access.ts makeUiSessions)? */
  uiOk: (headers: http.IncomingHttpHeaders) => boolean;
  /** The phone checks of access.ts: why this request is not the owner's phone, or undefined. */
  phoneRefusal: (req: http.IncomingMessage) => Promise<string | undefined>;
  repos: () => { name: string; path: string }[];
  onChange: () => void;
  /** A worktree for a Codex session; returns its folder. */
  worktree?: (repo: string, name: string) => Promise<string>;
};

const readJson = (req: http.IncomingMessage) => new Promise<any>((resolve, reject) => {
  const chunks: Buffer[] = []; let n = 0;
  req.on('data', (c: Buffer) => { n += c.length; if (n > 1e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => { try { const s = Buffer.concat(chunks).toString(); resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
function send(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

/** A git worktree beside Claude's, on a new branch from the checkout's HEAD. */
export function gitWorktree(repo: string, name: string): Promise<string> {
  const dir = join(repo, '.claude', 'worktrees', `codex-${name}`);
  return new Promise((resolve, reject) => execFile('/usr/bin/git', ['-C', repo, 'worktree', 'add', '-b', `codex-${name}`, dir, 'HEAD'], { timeout: 30_000 },
    (err, _o, e) => err ? reject(new Error(String(e || err.message).trim())) : resolve(dir)));
}

export async function termRoute(ctx: TermCtx, req: http.IncomingMessage, res: http.ServerResponse, url: string): Promise<void> {
  const { terms, gate, log } = ctx;
  const method = req.method ?? 'GET';
  if (method === 'GET' && url === '/api/term/list') return send(res, 200, { terminals: await terms.list(), paired: gate.paired() });

  const ui = typeof req.headers[UI_HEADER] === 'string' ? req.headers[UI_HEADER] as string : undefined;
  const uiLive = ctx.uiOk(req.headers);
  const refuse = (status: number, why: string, route = url) => { log('terminal refused', { route, why, device: req.headers['x-forwarded-for'] }); send(res, status, { error: why }); };
  if (!uiLive || !ui) return refuse(401, 'no open app page');

  if (method === 'GET' && url === '/api/term/stream') {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const name = q.get('name') ?? '';
    const token = req.headers[TERM_HEADER];
    const why = !NAME.test(name) ? 'bad name' : gate.refusal(token, ui, uiLive, name);
    if (why) return refuse(403, why);
    await terms.list();
    if (!terms.get(name)) return send(res, 404, { error: 'That terminal has ended.' });
    const release = gate.hold(token as string);
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    const cols = Number(q.get('cols')), rows = Number(q.get('rows'));
    const leave = terms.attach(name, f => {
      if (res.writableLength > 4e6) return void res.destroy(); // a page that cannot keep up reconnects and gets a full screen
      res.write(`${JSON.stringify(f)}\n`);
      if ('ended' in f) res.end();
    }, cols && rows ? { cols, rows } : undefined);
    const ping = setInterval(() => res.write('{}\n'), 25_000);
    req.on('close', () => { clearInterval(ping); leave(); release(); });
    return;
  }
  if (method !== 'POST') return send(res, 404);
  let body: any;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'bad body' }); }

  // ---- pairing the Mac's passkey: the code is read on the phone, typed on the Mac ----
  if (url === '/api/term/pair-code') {
    const why = await ctx.phoneRefusal(req);
    if (why) return refuse(403, `The pairing code shows only on ${OWNER}'s phone (${why}).`);
    return send(res, 200, gate.pairCode());
  }
  if (url === '/api/term/pair/options') {
    const r = gate.registerOptions(body.code, ui);
    return 'error' in r ? refuse(403, r.error) : send(res, 200, r);
  }
  if (url === '/api/term/pair') {
    const r = gate.register(body, ui);
    return 'error' in r ? refuse(403, r.error) : send(res, 200, r);
  }

  // ---- unlock: Touch ID on the Mac, the phone checks on the phone. Either gives a token for one terminal. ----
  const target = body.name === null || body.name === undefined ? null : String(body.name);
  if (target !== null && !NAME.test(target)) return send(res, 400, { error: 'bad name' });
  if (url === '/api/term/unlock/options') {
    const r = gate.unlockOptions(target, ui);
    return 'error' in r ? send(res, 200, { paired: false }) : send(res, 200, { paired: true, ...r });
  }
  if (url === '/api/term/unlock') {
    if (body.via === 'phone') {
      const why = await ctx.phoneRefusal(req);
      if (why) return refuse(403, `Not ${OWNER}'s phone (${why}). On the Mac, the terminal opens with Touch ID.`);
      return send(res, 200, gate.unlockPhone(target, ui));
    }
    const r = gate.unlockTouchId(body, ui);
    return 'error' in r ? refuse(403, r.error) : send(res, 200, r);
  }

  const token = req.headers[TERM_HEADER];
  if (url === '/api/term/open') {
    const why = gate.refusal(token, ui, uiLive, null);
    if (why) return refuse(403, why);
    const card = ctx.repos().find(r => r.path === body.repo);
    if (!card) return send(res, 400, { error: 'pick a project' });
    const kind: TermKind = body.kind === 'codex' ? 'codex' : 'terminal';
    const name = await terms.nextName(card.name);
    let cwd = card.path;
    if (kind === 'codex' && body.worktree === true) {
      try { cwd = await (ctx.worktree ?? gitWorktree)(card.path, name); }
      catch (e) { return send(res, 502, { error: `Could not make the worktree: ${(e as Error).message}` }); }
    }
    try {
      const t = await terms.open({ project: card.name, cwd, kind, name, cols: body.cols, rows: body.rows });
      gate.rebind(token as string, t.name);
      ctx.onChange();
      return send(res, 200, { terminal: t });
    } catch (e) { return send(res, 502, { error: `tmux: ${(e as Error).message}` }); }
  }

  const name = String(body.name ?? '');
  if (!NAME.test(name)) return send(res, 400, { error: 'bad name' });
  const why = gate.refusal(token, ui, uiLive, name);
  if (why) return refuse(403, why);
  if (url === '/api/term/input') {
    const keys: Key[] = Array.isArray(body.keys) ? body.keys.slice(0, 500).filter((k: any) => k && (typeof k.key === 'string' || typeof k.text === 'string')) : [];
    return (await terms.input(name, keys)) ? send(res, 204) : send(res, 409, { error: 'The terminal is not open on this page.' });
  }
  if (url === '/api/term/paste') {
    if (typeof body.text !== 'string' || body.text.length > 200_000) return send(res, 400, { error: 'text is required' });
    return (await terms.paste(name, body.text)) ? send(res, 204) : send(res, 409, { error: 'The terminal is not open on this page.' });
  }
  if (url === '/api/term/resize') return (await terms.resize(name, Number(body.cols), Number(body.rows))) ? send(res, 204) : send(res, 409);
  if (url === '/api/term/end') {
    const ok = await terms.kill(name);
    ctx.onChange();
    return ok ? send(res, 200, { ended: name }) : send(res, 404, { error: 'That terminal has already ended.' });
  }
  send(res, 404);
}
