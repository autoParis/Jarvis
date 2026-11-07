// Turns the shell's raw output into lines of text for the pane. It handles what line-based programs print (carriage
// return, backspace, erase to end of line) and drops other escape codes, so full-screen programs do not draw.
// daemon/shell.test.ts imports this.
const ESC = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\^_])/y;
const MAX_LINES = 5000;

export const makeScreen = () => ({ lines: [''], col: 0, held: '' });

export function feed(s, text) {
  text = s.held + text;
  s.held = '';
  let last = s.lines.length - 1;
  const put = c => {
    const line = s.lines[last];
    s.lines[last] = line.slice(0, s.col).padEnd(s.col) + c + line.slice(s.col + 1);
    s.col++;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\x1b') {
      ESC.lastIndex = i;
      const m = ESC.exec(text);
      if (!m) {
        // An escape code cut by the end of this chunk waits for the next one. A long or broken one is dropped.
        if (text.length - i < 256) { s.held = text.slice(i); break; }
        continue;
      }
      if (m[2] === 'K' && (m[1] === '' || m[1] === '0')) s.lines[last] = s.lines[last].slice(0, s.col);
      i += m[0].length - 1;
    }
    else if (c === '\n') { s.lines.push(''); last++; s.col = 0; }
    else if (c === '\r') s.col = 0;
    else if (c === '\b') s.col = Math.max(0, s.col - 1);
    else if (c === '\t') { do put(' '); while (s.col % 8); }
    else if (c >= ' ' && c !== '\x7f') put(c);
  }
  if (s.lines.length > MAX_LINES) s.lines.splice(0, s.lines.length - MAX_LINES);
  return s;
}

export const screenText = s => s.lines.join('\n');
