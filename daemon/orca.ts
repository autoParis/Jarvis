import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Store, Item } from './store.ts';

/** Jarvis acts as its own identity terminal, never as whatever Orca session launched it. */
export const cleanEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ORCA_')));

export type OrcaResult = { ok: boolean; result?: any; error?: { code: string; message: string } };

/** Runs one orca CLI command with --json and returns the parsed envelope. Throws only when the CLI itself fails to run or prints no JSON. */
export function orca(args: string[], timeoutMs = 60_000): Promise<OrcaResult> {
  return new Promise((resolve, reject) => {
    execFile('orca', [...args, '--json'], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: cleanEnv }, (err, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { reject(err ?? new Error(`orca ${args[0]} ${args[1] ?? ''}: no JSON output`)); }
    });
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Orca only lets a terminal coordinate a Run. Jarvis keeps one idle Orca terminal as its identity
 * (spike 2026-10-29) and binds its Run to it. Rebinds with run-use if the terminal is gone.
 */
export async function ensureIdentity(store: Store, homeWorktree: string): Promise<{ handle: string; run: string }> {
  let handle = store.getState('orca_handle');
  if (handle) {
    const shown = await orca(['terminal', 'show', '--terminal', handle]).catch(() => undefined);
    if (!shown?.ok) handle = undefined;
  }
  let rebind = false;
  if (!handle) {
    const created = await orca(['terminal', 'create', '--worktree', homeWorktree, '--title', 'JARVIS',
      '--command', 'echo "Jarvis coordinator identity. Do not close."; exec tail -f /dev/null']);
    if (!created.ok) throw new Error(`orca terminal create failed: ${created.error?.message}`);
    handle = created.result.terminal.handle as string;
    store.setState('orca_handle', handle);
    rebind = true;
  }
  let run = store.getState('orca_run');
  if (!run) {
    const r = await orca(['orchestration', 'run-create', '--objective', 'Jarvis: coordinate the owner\'s coding work', '--from', handle]);
    if (!r.ok) throw new Error(`run-create failed: ${r.error?.message}`);
    run = r.result.run.id as string;
    store.setState('orca_run', run);
  } else if (rebind) {
    const r = await orca(['orchestration', 'run-use', '--id', run, '--from', handle]);
    if (!r.ok) throw new Error(`run-use failed: ${r.error?.message}`);
  }
  return { handle, run };
}

const FORWARD = new Set(['question', 'escalation', 'worker_done']);

/**
 * Blocks on `check --wait`, writes every message to `items` before acknowledging the delivery,
 * then hands new items to `onItems`. An empty wait is a checkpoint (work.ts polls the worker list).
 */
export async function watch(opts: {
  store: Store; homeWorktree: string; killFile: string;
  onItems: (items: Item[]) => void; onTrouble: (msg: string) => void; log: (msg: string) => void;
}) {
  const { store } = opts;
  let id = await ensureIdentity(store, opts.homeWorktree);
  let ack: string | undefined;
  let failures = 0;
  for (;;) {
    if (existsSync(opts.killFile)) { await sleep(10_000); continue; }
    const args = ['orchestration', 'check', '--run', id.run, '--terminal', id.handle, '--wait',
      '--types', 'question,escalation,worker_done', '--timeout-ms', '900000', '--full'];
    if (ack) args.push('--ack', ack);
    let res: OrcaResult;
    try {
      res = await orca(args, 960_000);
    } catch (e) {
      res = { ok: false, error: { code: 'cli_failed', message: String(e) } };
    }
    if (!res.ok) {
      failures++;
      opts.log(`watcher: ${res.error?.code} ${res.error?.message}`);
      if (failures === 3) opts.onTrouble(`I can't reach Orca (${res.error?.code}). I'll keep retrying.`);
      await sleep(Math.min(60_000, 2_000 * 2 ** failures));
      if (failures % 3 === 0) id = await ensureIdentity(store, opts.homeWorktree).catch(() => id);
      continue;
    }
    failures = 0;
    ack = undefined; // the call above acknowledged the previous delivery
    const r = res.result;
    const delivery = takeDelivery(store, r);
    ack = delivery.ack; // written; acknowledge on the next check (a no-op on an Orca that already did)
    if (delivery.fresh.length) opts.onItems(delivery.fresh);
  }
}

/** One `check` answer. Orca marks a batch handled as it returns it and may send no delivery id, so a batch without one is still new mail. */
export function takeDelivery(store: Store, r: { deliveryId?: string; messages?: Parameters<typeof storeMessages>[1] }): { fresh: Item[]; ack?: string } {
  return r.messages?.length ? { fresh: storeMessages(store, r.messages), ack: r.deliveryId } : { fresh: [] };
}

/**
 * Writes each Orca message to `items` and returns the ones to hand to the brain. A replayed message that is
 * already stored comes back only if it is still 'new', which means jarvisd stopped before handing it over.
 */
export function storeMessages(store: Store, messages: { id: string; type: string; subject?: string; body?: string; payload?: unknown }[]): Item[] {
  const fresh: Item[] = [];
  for (const m of messages) {
    const payload = safeJson(m.payload);
    const item = store.insertItem({
      source: 'orca', external_id: m.id, kind: m.type, dispatch_id: payload?.dispatchId ?? null,
      subject: m.subject, body: m.body, options: payload?.options ? JSON.stringify(payload.options) : null,
      meta: payload?.outcome ? JSON.stringify({ outcome: payload.outcome }) : null,
    }) ?? store.item(m.id);
    if (!item || item.status !== 'new') continue; // replayed and already handed over
    if (FORWARD.has(item.kind)) fresh.push(item); else store.markItem(item.external_id, 'done');
  }
  return fresh;
}

function safeJson(s: unknown): any {
  if (typeof s !== 'string') return s ?? null;
  try { return JSON.parse(s); } catch { return null; }
}
