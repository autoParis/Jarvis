import type http from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

// Only the owner's own accounts get in. jarvisd listens on 127.0.0.1, so tailnet traffic arrives through
// `tailscale serve`, which stamps the caller's login on each request. Tagged machines have no login.
const ALLOWED_LOGINS = new Set((process.env.JARVIS_ALLOWED_LOGINS || 'owner@example.test').split(','));
export function allowed(headers: http.IncomingHttpHeaders): boolean {
  const viaTailnet = headers['tailscale-user-login'] !== undefined || headers['x-forwarded-for'] !== undefined
    || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(headers.host ?? ''));
  return !viaTailnet || ALLOWED_LOGINS.has(String(headers['tailscale-user-login'] ?? ''));
}

// Requests that act as the owner (send, voice, Approve, the work-list buttons and steer box) must carry the
// secret of an app page that is open right now. Each /api/events stream gets a fresh random one in its first
// event, and it stops working when that stream closes. Before this, anything on the Mac could POST to
// /api/approval on 127.0.0.1 and pass as the owner's button, the brain included: it has Bash and JARVIS_URL.
// Now a plain curl is refused. A process that opens /api/events itself can still read a secret, so this
// stops an accidental or casual approval, not a determined local program.
export const UI_HEADER = 'x-jarvis-session';
export function makeUiSessions() {
  const live = new Set<string>();
  return {
    open(): string { const s = randomBytes(24).toString('base64url'); live.add(s); return s; },
    close(s: string) { live.delete(s); },
    ok(headers: http.IncomingHttpHeaders): boolean { const s = headers[UI_HEADER]; return typeof s === 'string' && live.has(s); },
  };
}

// ---- The shell pane: The owner's phone only ----
// The UI secret is not enough here, because any local process can read one from /api/events. The login header is not
// enough either: measured on 2026-11-04, a curl on this Mac through the tailnet URL gets the owner's login and the Mac's IP,
// the same as his Chrome, and a tunnel through tailscaled's own proxies (1055, 1056) to 127.0.0.1:7717 arrives from
// tailscaled with whatever headers the client wrote. So a request passes only when all of this holds together.
export const SHELL_DEVICES = new Set((process.env.JARVIS_SHELL_DEVICES || '100.64.0.10,fd7a:115c:a1e0::10').split(','));
const TS_PROXY_PORTS = [1055, 1056];

export type TcpSocket = { pid: number; name: string };
/** `lsof -Fpn` output: a `p<pid>` line, then `n<address>` lines for that process. */
export function parseLsof(out: string): TcpSocket[] {
  const sockets: TcpSocket[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') sockets.push({ pid, name: line.slice(1) });
  }
  return sockets;
}

export type ShellProbe = { login: unknown; forwardedFor: unknown; remotePort: number | undefined; port: number; servePid: number | undefined; sockets: TcpSocket[]; serveConfig: any };
/** Why this request is not the owner's phone, or undefined when it is. */
export function shellRefusal(p: ShellProbe): string | undefined {
  if (!ALLOWED_LOGINS.has(String(p.login ?? ''))) return 'no tailnet login';
  if (typeof p.forwardedFor !== 'string' || !SHELL_DEVICES.has(p.forwardedFor)) return `device ${String(p.forwardedFor ?? 'none')} is not the phone`;
  if (!p.servePid) return 'the tailnet node is not running';
  const peer = `127.0.0.1:${p.remotePort}->127.0.0.1:${p.port}`;
  if (!p.sockets.some(s => s.pid === p.servePid && s.name === peer)) return 'the connection did not come from the tailnet node';
  // A live tunnel needs its client connected, and a client that hangs up takes its connection to jarvisd with it.
  if (p.sockets.some(s => TS_PROXY_PORTS.some(port => new RegExp(`:${port}(->|$)`).test(s.name)))) return 'a tunnel through the tailnet proxies is open';
  // Raw TCP forwarding would also carry forged headers, and `serve` as Jarvis sets it up never uses it.
  const tcp = Object.values((p.serveConfig?.TCP ?? {}) as Record<string, { TCPForward?: string }>);
  if (!p.serveConfig || tcp.some(h => h.TCPForward)) return 'tailscale serve has a raw TCP forward, or its config could not be read';
  return undefined;
}

const run = (file: string, args: string[]) => new Promise<string>(done =>
  execFile(file, args, { timeout: 3000, maxBuffer: 4e6 }, (err, out) => done(err && !out ? '' : out)));

/** Reads the machine's state for shellRefusal. Absolute paths: PATH is not trusted. A failed read refuses. */
export async function probeShell(req: http.IncomingMessage, port: number): Promise<ShellProbe> {
  const remotePort = req.socket.remotePort;
  const socket = process.env.JARVIS_TS_SOCKET || `${homedir()}/.jarvis-host/ts-personal.sock`;
  const [lsof, launchd, serve] = await Promise.all([
    run('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${remotePort}`, ...TS_PROXY_PORTS.map(p => `-iTCP:${p}`), '-sTCP:ESTABLISHED', '-Fpn']),
    run('/bin/launchctl', ['list', process.env.JARVIS_TS_SERVICE || 'local.tailscale-personal']),
    run('/opt/homebrew/bin/tailscale', [`--socket=${socket}`, 'serve', 'status', '--json']),
  ]);
  let serveConfig: unknown;
  try { serveConfig = JSON.parse(serve); } catch { /* refused below */ }
  return {
    login: req.headers['tailscale-user-login'], forwardedFor: req.headers['x-forwarded-for'], remotePort, port,
    servePid: Number(/"PID" = (\d+);/.exec(launchd)?.[1]) || undefined, sockets: parseLsof(lsof), serveConfig,
  };
}
