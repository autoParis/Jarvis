import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteResult } from './route.ts';

// The files jarvisd serves from web/ as they are: each URL and its file, and the content type of each extension.
// contract.test.ts checks that every web/*.js module is listed.
export const STATIC: Record<string, string> = { '/': 'index.html', '/markdown.js': 'markdown.js', '/askcard.js': 'askcard.js', '/paste.js': 'paste.js', '/enterkey.js': 'enterkey.js', '/listen.js': 'listen.js', '/requestlist.js': 'requestlist.js', '/worklist.js': 'worklist.js', '/contract.js': 'contract.js', '/workfold.js': 'workfold.js', '/messagerow.js': 'messagerow.js', '/messages.js': 'messages.js', '/today.js': 'today.js', '/migration.js': 'migration.js', '/report.js': 'report.js', '/tasks.js': 'tasks.js', '/modelpicker.js': 'modelpicker.js', '/newpick.js': 'newpick.js', '/terminal.js': 'terminal.js', '/swipe.js': 'swipe.js', '/backnav.js': 'backnav.js', '/dictate.js': 'dictate.js', '/compose.js': 'compose.js', '/composer.js': 'composer.js', '/mic.js': 'mic.js', '/speech.js': 'speech.js', '/draw.js': 'draw.js', '/reload.js': 'reload.js', '/app.css': 'app.css', '/manifest.webmanifest': 'manifest.webmanifest', '/sw.js': 'sw.js', '/icon.svg': 'icon.svg' };
export const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.m4a': 'audio/mp4' };

/**
 * A short hash of every file in STATIC, read from `dir` (the web/ folder). jarvisd computes it once at start-up. It
 * sends it on each connect of /api/events as a 'version' event, and answers it on GET /api/version. A page that sees a
 * version other than the one it loaded with reloads itself (web/reload.js), so a restart with new web code reaches every
 * open page. A file that cannot be read counts as empty, so a missing file still gives a version.
 */
export function webVersion(dir: string): string {
  const h = createHash('sha256');
  for (const name of [...new Set(Object.values(STATIC))].sort()) {
    let body: Buffer = Buffer.alloc(0);
    try { body = readFileSync(join(dir, name)); } catch { /* counted as empty */ }
    h.update(`${name}\0${body.length}\0`).update(body);
  }
  return h.digest('hex').slice(0, 16);
}

/** The message on /api/events that tells the page which web code jarvisd serves. */
export const versionEvent = (version: string) => ({ type: 'version', version });

/** GET /api/version: the phone app asks on resume, because its stream can sleep in the background. */
export function webVersionRoute(version: string, method: string, url: string): RouteResult | undefined {
  if (method === 'GET' && url === '/api/version') return { status: 200, body: { version } };
}
