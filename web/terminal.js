// The project terminal in the page. tmux draws the screen in jarvisd; this module
// shows its lines with their colours, sends keys, and gets the token that lets this page in: Touch ID on the Mac, the
// phone checks on the phone (daemon/termgate.ts). The token lives only in this module's memory.
// daemon/terminal.test.ts and daemon/termweb.test.ts import the pure parts.

// The fetch the page had before index.html wrapped it, so nothing added later to window.fetch sees the token.
const baseFetch = typeof window !== 'undefined' ? window.fetch.bind(window) : undefined;

const PALETTE = ['#1d1f21', '#e06c6c', '#7ec699', '#e5c07b', '#6cb6ff', '#c678dd', '#56c7c7', '#c8ccd0',
  '#5c6370', '#ff8b8b', '#98e0b0', '#f2d58a', '#8fc8ff', '#dc9ef0', '#7fdede', '#ffffff'];
/** xterm's 256 colours. */
export function color256(n) {
  if (n < 16) return PALETTE[n];
  if (n >= 232) { const v = 8 + (n - 232) * 10; return `rgb(${v},${v},${v})`; }
  const i = n - 16, l = [0, 95, 135, 175, 215, 255];
  return `rgb(${l[Math.floor(i / 36)]},${l[Math.floor(i / 6) % 6]},${l[i % 6]})`;
}

const SGR = /\x1b\[([0-9;:]*)m/g;
const blank = () => ({ fg: null, bg: null, bold: false, dim: false, italic: false, under: false, inverse: false, strike: false });

function applySgr(st, params) {
  const p = params === '' ? [0] : params.split(/[;:]/).map(Number);
  for (let i = 0; i < p.length; i++) {
    const n = p[i];
    if (n === 0) Object.assign(st, blank());
    else if (n === 1) st.bold = true;
    else if (n === 2) st.dim = true;
    else if (n === 3) st.italic = true;
    else if (n === 4) st.under = true;
    else if (n === 7) st.inverse = true;
    else if (n === 9) st.strike = true;
    else if (n === 22) st.bold = st.dim = false;
    else if (n === 23) st.italic = false;
    else if (n === 24) st.under = false;
    else if (n === 27) st.inverse = false;
    else if (n === 29) st.strike = false;
    else if (n >= 30 && n <= 37) st.fg = PALETTE[n - 30];
    else if (n >= 90 && n <= 97) st.fg = PALETTE[n - 90 + 8];
    else if (n >= 40 && n <= 47) st.bg = PALETTE[n - 40];
    else if (n >= 100 && n <= 107) st.bg = PALETTE[n - 100 + 8];
    else if (n === 39) st.fg = null;
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? 'fg' : 'bg';
      if (p[i + 1] === 5) { st[key] = color256(p[i + 2] ?? 0); i += 2; }
      else if (p[i + 1] === 2) { st[key] = `rgb(${p[i + 2] ?? 0},${p[i + 3] ?? 0},${p[i + 4] ?? 0})`; i += 4; }
    }
  }
}

/** One of tmux's lines (`capture-pane -e`) as cells: a character and its style each. Other escape codes are dropped. */
export function cells(line) {
  const out = [];
  const st = blank();
  let at = 0;
  const text = s => { for (const ch of s.replace(/\x1b[^m]*?[A-Za-z]|[\x00-\x1f\x7f]/g, '')) out.push({ ch, st: { ...st } }); };
  for (const m of line.matchAll(SGR)) { text(line.slice(at, m.index)); applySgr(st, m[1]); at = m.index + m[0].length; }
  text(line.slice(at));
  return out;
}

const styleOf = (st, cursor) => {
  let fg = st.fg, bg = st.bg;
  if (st.inverse !== cursor) { const f = fg; fg = bg ?? 'var(--term-bg)'; bg = f ?? 'var(--term-fg)'; }
  const css = [fg && `color:${fg}`, bg && `background:${bg}`, st.bold && 'font-weight:700', st.dim && 'opacity:.7', st.italic && 'font-style:italic',
    (st.under || st.strike) && `text-decoration:${[st.under && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ')}`].filter(Boolean).join(';');
  return css;
};

/** A line as HTML: runs of one style in spans, the cursor's cell inverted. */
export function lineHtml(line, cursorCol, esc) {
  const cs = cells(line);
  if (cursorCol !== null && cursorCol !== undefined) while (cs.length <= cursorCol) cs.push({ ch: ' ', st: blank() });
  let html = '', run = '', runCss = null;
  const flush = () => { if (run) html += runCss ? `<span style="${runCss}">${esc(run)}</span>` : esc(run); run = ''; };
  cs.forEach((c, i) => {
    const cur = i === cursorCol;
    const css = styleOf(c.st, cur);
    if (cur) { flush(); html += `<span class="cur" style="${css}">${esc(c.ch)}</span>`; runCss = null; return; }
    if (css !== runCss) { flush(); runCss = css; }
    run += c.ch;
  });
  flush();
  return html || ' ';
}

/** The control character for Ctrl plus a key, or undefined. */
export function ctrlChar(k) {
  const c = k.length === 1 ? k.toLowerCase() : '';
  if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
  const map = { '@': '\x00', ' ': '\x00', '2': '\x00', '[': '\x1b', '3': '\x1b', '\\': '\x1c', '4': '\x1c', ']': '\x1d', '5': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '7': '\x1f', '?': '\x7f', '8': '\x7f' };
  return map[c];
}

const NAMED = { Enter: 'Enter', Backspace: 'BSpace', Escape: 'Escape', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Delete: 'Delete', Insert: 'Insert' };
/**
 * What a key press does: `{ back: true }` for Cmd+[, keys to send, or null to leave it to the browser (Cmd+C, Cmd+V,
 * Cmd+R and the rest). `ctrl` is the phone's lit Ctrl key, which applies to this press.
 */
export function keyFor(e, ctrl = false) {
  if (e.isComposing) return null;
  if (e.metaKey) return e.key === '[' ? { back: true } : null;
  if (e.key === 'Tab') return [{ key: e.shiftKey ? 'BTab' : 'Tab' }];
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return [{ key: e.key }];
  if (NAMED[e.key]) return [{ key: NAMED[e.key] }];
  if (e.key.length !== 1 && [...e.key].length !== 1) return null;
  if ((e.ctrlKey || ctrl) && !e.altKey) { const c = ctrlChar(e.key); return c === undefined ? null : [{ text: c }]; }
  return [{ text: e.key }];
}

/** Columns and rows that fit a box, from the size of one character cell. */
export const fit = (w, h, cw, ch) => ({ cols: Math.max(20, Math.floor(w / cw)), rows: Math.max(5, Math.floor(h / ch)) });

/**
 * The phone's keyboard from the visual viewport. The keyboard shrinks only the visual viewport (Chrome on Android,
 * Safari), so `inset` is the part of the layout under the keyboard or above the visible part: the page keeps that much
 * room at its bottom so the key row ends where the keyboard starts. `open` ignores a pan: the keyboard is up when the
 * visual viewport is more than 100 px shorter than the layout.
 */
export const keyboardInset = (layoutH, vvH, vvTop) => ({ inset: Math.max(0, Math.round(layoutH - vvH - vvTop)), open: layoutH - vvH > 100 });

/** The scrollTop that shows a row from `top` to `bottom` (in the box's content) in a box `viewH` tall, moving it as little as possible. */
export function keepVisible(scrollTop, viewH, top, bottom) {
  if (bottom > scrollTop + viewH) return Math.max(0, Math.ceil(bottom - viewH));
  if (top < scrollTop) return Math.max(0, Math.floor(top));
  return scrollTop;
}

/** Applies one frame from jarvisd to the screen state. Returns the row numbers to redraw. */
export function applyFrame(s, f) {
  const dirty = new Set();
  if (f.lines) { s.lines = [...f.lines]; f.lines.forEach((_, i) => dirty.add(i)); }
  for (const [i, l] of f.d ?? []) { s.lines[i] = l; dirty.add(i); }
  if (s.cursor) dirty.add(s.cursor[1]);
  s.cursor = f.cursor ?? null; s.cols = f.cols; s.rows = f.rows;
  if (s.cursor) dirty.add(s.cursor[1]);
  return dirty;
}

/** The status line under the Mac terminal. */
export const statusText = (cols, rows, live) => [live ? `Live, ${cols} × ${rows}` : 'Not connected', 'Keys go straight to the shell', '⌘[ back to Jarvis', 'Keeps running when you close the app'];

// ---- the browser part ----
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/**
 * Opens a terminal in `host`. `o`: { name (or null for a new one), start ({ repo, kind, worktree }) for a new one, onMac,
 * session() for the UI secret, esc, onInfo(info), onEnded(text), onBack(), setStatus(parts), pairBox (an element for the pairing form) }.
 */
export function openTerminal(host, o) {
  let token = '', name = o.name, ctrl = false, closed = false, ac = null, sizeTimer = 0;
  const screen = { lines: [], cursor: null, cols: 0, rows: 0 };
  const rowsEl = [];
  const grid = document.createElement('div');
  grid.className = 'term-grid';
  host.replaceChildren(grid);
  const headers = (extra = {}) => ({ 'content-type': 'application/json', 'x-jarvis-session': o.session(), ...(token ? { 'x-jarvis-term': token } : {}), ...extra });
  const post = async (path, body) => {
    const r = await baseFetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `jarvisd answered ${r.status}`);
    return j;
  };
  const say = (text, cls = '') => { grid.innerHTML = `<div class="term-msg ${cls}">${o.esc(text)}</div>`; };

  // One character cell's size, from a hidden probe in the same font.
  function cell() {
    const p = document.createElement('span');
    p.className = 'term-probe'; p.textContent = 'MMMMMMMMMM';
    grid.appendChild(p);
    const r = p.getBoundingClientRect();
    p.remove();
    return { cw: r.width / 10 || 8, ch: r.height || 17 };
  }
  const size = () => { const { cw, ch } = cell(); const b = host.getBoundingClientRect(); return fit(b.width - 16, b.height - 12, cw, ch); };

  async function pair() {
    return new Promise(resolve => {
      o.pairBox.hidden = false;
      const form = o.pairBox.querySelector('form'), input = o.pairBox.querySelector('input'), err = o.pairBox.querySelector('.term-pair-err');
      err.textContent = '';
      input.value = '';
      input.focus();
      form.onsubmit = async e => {
        e.preventDefault();
        err.textContent = '';
        const code = input.value.replace(/\D/g, '');
        try {
          const opt = await post('/api/term/pair/options', { code });
          const cred = await navigator.credentials.create({ publicKey: {
            rp: { id: opt.rpId, name: 'Jarvis' }, user: { id: fromB64u(opt.userId), name: 'owner', displayName: 'The owner' },
            challenge: fromB64u(opt.challenge), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], attestation: 'none', timeout: 60_000,
            authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
            excludeCredentials: opt.exclude.map(id => ({ type: 'public-key', id: fromB64u(id) })),
          } });
          await post('/api/term/pair', { code, id: b64u(cred.rawId), publicKey: b64u(cred.response.getPublicKey()), authenticatorData: b64u(cred.response.getAuthenticatorData()), clientDataJSON: b64u(cred.response.clientDataJSON) });
          o.pairBox.hidden = true;
          resolve(true);
        } catch (e2) { err.textContent = e2.name === 'NotAllowedError' ? 'Touch ID was cancelled. Try again.' : e2.message; }
      };
      o.pairBox.querySelector('.term-pair-cancel').onclick = () => { o.pairBox.hidden = true; resolve(false); };
    });
  }

  async function unlock() {
    if (!o.onMac) { token = (await post('/api/term/unlock', { via: 'phone', name })).token; return; }
    let opt = await post('/api/term/unlock/options', { name });
    if (!opt.paired) {
      say('This Mac needs pairing once. Type the code your phone shows.');
      if (!(await pair())) throw new Error('Not paired. The terminal opens on the Mac only with Touch ID.');
      opt = await post('/api/term/unlock/options', { name });
    }
    say('Touch ID to open the terminal…');
    let a;
    try {
      a = await navigator.credentials.get({ publicKey: { challenge: fromB64u(opt.challenge), rpId: opt.rpId, userVerification: 'required', timeout: 60_000,
        allowCredentials: opt.allow.map(id => ({ type: 'public-key', id: fromB64u(id) })) } });
    } catch (e) { throw new Error(e.name === 'NotAllowedError' ? 'Touch ID was cancelled.' : e.message); }
    token = (await post('/api/term/unlock', { name, id: b64u(a.rawId), clientDataJSON: b64u(a.response.clientDataJSON), authenticatorData: b64u(a.response.authenticatorData), signature: b64u(a.response.signature) })).token;
  }

  function draw(dirty) {
    while (rowsEl.length < screen.rows) { const d = document.createElement('div'); d.className = 'term-row'; grid.appendChild(d); rowsEl.push(d); }
    while (rowsEl.length > screen.rows) rowsEl.pop().remove();
    for (const i of dirty) if (rowsEl[i]) rowsEl[i].innerHTML = lineHtml(screen.lines[i] ?? '', screen.cursor?.[1] === i ? screen.cursor[0] : null, o.esc);
    showCursor();
    o.setStatus?.(statusText(screen.cols, screen.rows, true));
  }
  // The screen can be taller than the box until tmux answers a resize (the phone's keyboard just opened): keep the
  // cursor's row in view.
  function showCursor() {
    const r = rowsEl[screen.cursor?.[1]];
    if (!r) return;
    const top = r.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
    host.scrollTop = keepVisible(host.scrollTop, host.clientHeight, top, top + r.offsetHeight + 6);
  }

  async function stream() {
    const { cols, rows } = size();
    ac = new AbortController();
    const r = await baseFetch(`/api/term/stream?name=${encodeURIComponent(name)}&cols=${cols}&rows=${rows}`, { headers: headers(), signal: ac.signal });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `jarvisd answered ${r.status}`); }
    grid.replaceChildren(); rowsEl.length = 0;
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line || line === '{}') continue;
        const f = JSON.parse(line);
        if (f.ended) { closed = true; o.onEnded?.(f.ended); return; }
        draw(applyFrame(screen, f));
      }
    }
    if (!closed) { o.setStatus?.(statusText(screen.cols, screen.rows, false)); o.onEnded?.('The connection to jarvisd closed. Open it again from the work list.'); }
  }

  // Keys go out in order, batched while one request is on its way.
  let queue = [], sending = false;
  async function sendKeys(keys) {
    queue.push(...keys);
    if (sending) return;
    sending = true;
    while (queue.length && !closed) {
      const batch = queue; queue = [];
      await post('/api/term/input', { name, keys: batch }).catch(e => o.setStatus?.([e.message]));
    }
    sending = false;
  }
  const paste = text => text && post('/api/term/paste', { name, text }).catch(e => o.setStatus?.([e.message]));
  const setCtrl = on => { ctrl = on; o.onCtrl?.(on); };

  const ro = new ResizeObserver(() => {
    showCursor();
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => { if (token && name && !closed) { const s = size(); post('/api/term/resize', { name, ...s }).catch(() => {}); } }, 150);
  });
  ro.observe(host);

  (async () => {
    try {
      say(o.onMac ? 'Opening…' : 'Checking this is your phone…');
      await unlock();
      if (!name) {
        const { cols, rows } = size();
        name = (await post('/api/term/open', { ...o.start, cols, rows })).terminal.name;
      }
      o.onInfo?.(name);
      await stream();
    } catch (e) {
      if (e.name === 'AbortError') return;
      say(e.message, 'bad');
      o.onFail?.(e.message);
    }
  })();

  return {
    get name() { return name; },
    /** A key press on the screen (Mac) or from the phone's key row. Returns true when it was handled. */
    key(e) {
      const k = keyFor(e, ctrl);
      if (k === null) return false;
      if (k.back) { o.onBack?.(); return true; }
      if (ctrl) setCtrl(false);
      sendKeys(k);
      return true;
    },
    /** Typed text from the phone's keyboard. The lit Ctrl applies to its first character. */
    text(t) {
      if (!t) return;
      if (ctrl) { const c = ctrlChar(t[0]); setCtrl(false); if (c !== undefined) { sendKeys([{ text: c }, ...(t.length > 1 ? [{ text: t.slice(1) }] : [])]); return; } }
      sendKeys([{ text: t }]);
    },
    send: k => sendKeys(k),
    paste,
    toggleCtrl: () => setCtrl(!ctrl),
    async end() { await post('/api/term/end', { name }); closed = true; },
    /** Back: the page leaves, the session keeps running, and this page's token goes with its stream. */
    close() { closed = true; ro.disconnect(); ac?.abort(); token = ''; },
  };
}
