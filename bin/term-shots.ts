// Screenshots of the project terminal against the preview (npm run preview), through the real page code: the Mac pairs
// and unlocks with a WebAuthn passkey, here a virtual authenticator in headless Chrome that stands in for Touch ID, and
// the phone opens the same tmux session with the phone path. Writes PNGs to docs/screens/terminal/.
//
//   PREVIEW_PORT=7763 npm run preview      then      node bin/term-shots.ts 7763
//
// It uses the preview's own tmux server (tmux -L jarvis-preview) and nothing of jarvisd's.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 7718);
const BASE = `http://localhost:${PORT}`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screens', 'terminal');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG = 9300 + Math.floor(Math.random() * 500);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), 'jv-shots-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome is still writing; the temp folder goes later */ } };
process.on('exit', cleanup);

async function target(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try { const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json() as any[]; const p = list.find(t => t.type === 'page'); if (p) return p.webSocketDebuggerUrl; } catch { /* not up yet */ }
    await wait(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await target());
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener('message', ev => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
async function cdp(method: string, params: object = {}): Promise<any> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  const m: any = await new Promise(r => pending.set(id, r));
  if (m.error) throw new Error(`${method}: ${m.error.message}`);
  return m.result;
}
const js = async (expr: string) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.value;
async function until(expr: string, what: string, ms = 15_000) {
  for (let t = 0; t < ms; t += 150) { if (await js(expr)) return; await wait(150); }
  console.log('status:', await js(`document.getElementById('term-status').textContent`), 'active:', await js(`document.activeElement?.id`), 'rows:', await js(`[...document.querySelectorAll('.term-row')].map(r => r.textContent).join('\\n')`));
  throw new Error(`timed out: ${what}`);
}
async function shot(name: string) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, name), Buffer.from(data, 'base64'));
  console.log(join(OUT, name));
}
// The Mac screen reads key presses; the phone's hidden box reads typed text.
async function type(text: string, phone = false) {
  if (phone) return void await cdp('Input.insertText', { text });
  for (const ch of text) { await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }); }
}
async function key(k: string, code: string, vk: number, mods = 0) {
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
}
const enter = () => key('Enter', 'Enter', 13);
// A real click (the key row ignores clicks a script makes).
async function tap(sel: string) {
  const r = await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, x: r[0], y: r[1], button: 'left', clickCount: 1 });
}
const screenHas = (s: string) => `[...document.querySelectorAll('.term-row')].some(r => r.textContent.includes(${JSON.stringify(s)}))`;

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('WebAuthn.enable');
await cdp('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

// ---- the Mac: plus, Terminal, AcmeApp, Start; pair with the phone's code; Touch ID (virtual); the terminal ----
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await cdp('Page.navigate', { url: `${BASE}/?s=requests` });
await until(`!!document.querySelector('#worklist .wrow')`, 'the work list');
await js(`document.getElementById('newchat').click()`);
await until(`!document.getElementById('newpick').hidden`, 'the picker');
await js(`document.querySelector('#np-kind [data-v="terminal"]').click(); document.querySelector('#np-repo [data-v="/Users/owner/Repos/acmeapp_nextjs"]').click(); document.getElementById('np-go').click()`);
// The preview keeps a pairing in memory until it restarts; pair only the first time.
if (!(await (await fetch(`${BASE}/api/term/list`)).json() as any).paired) {
  await until(`!document.getElementById('term-pair').hidden`, 'the pairing form');
  await shot('mac-pair.png');
  const { code } = await (await fetch(`${BASE}/api/term/pair-code`, { method: 'POST', headers: { 'x-jarvis-session': 'preview' }, body: '{}' })).json() as any; // what the phone shows
  await js(`document.querySelector('#term-pair input').value = ${JSON.stringify(code)}; document.querySelector('#term-pair form').requestSubmit()`);
}
await until(`document.querySelectorAll('.term-row').length > 5`, 'the terminal screen');
await until(`document.getElementById('pane-title').textContent === 'Terminal in AcmeApp'`, 'the header');
await js(`document.getElementById('term-host').focus()`);
await type('clear; git status -sb | head -8; git --no-pager log --oneline -6 --no-decorate'); await enter();
await until(screenHas('##'), 'git output');
await wait(400);
await shot('mac-terminal.png');
// A full-screen program draws: top.
await type('top -o cpu -n 14 -s 2'); await enter();
await until(screenHas('PID'), 'top');
await wait(2500);
await shot('mac-top.png');
await type('q', false);
await wait(300);
const name = await js(`document.querySelector('#pane-sub').textContent.match(/(ev-\\d+)/)?.[1]`);
// Cmd+[ goes back to Jarvis and leaves the session running.
await key('[', 'BracketLeft', 219, 4);
await until(`document.getElementById('term').hidden`, 'back to Jarvis');
await shot('mac-worklist.png');

// ---- the phone: same session, reattached from the work list, at the phone's width ----
await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' });
await cdp('Page.navigate', { url: `${BASE}/?s=requests` });
await until(`!!document.querySelector('#worklist .wrow')`, 'the work list');
await js(`document.getElementById('railbtn').click()`);
await wait(300);
await shot('phone-worklist.png');
await js(`document.querySelector('[data-id="t:${name}"]').click()`);
await until(`document.querySelectorAll('.term-row').length > 5`, 'the phone terminal');
await js(`document.getElementById('term-input').focus()`);
await type('ls -la | head -12', true); await enter();
await until(screenHas('total'), 'ls output');
await tap('#tk-ctrl');
await wait(500);
await shot('phone-terminal.png');
await tap('#tk-ctrl');
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await wait(300);
await shot('phone-terminal-dark.png');
// End kills the tmux session.
await js(`document.getElementById('term-end').click()`);
await until(`document.getElementById('term').hidden`, 'End');
const left = await (await fetch(`${BASE}/api/term/list`)).json() as any;
console.log('after End, terminals:', JSON.stringify(left.terminals.map((t: any) => t.name)));
ws.close();
process.exit(0);
