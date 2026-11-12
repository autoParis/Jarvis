// The one way a chat message leaves the box with its pictures. Every send path calls sendOut: the Send button, Enter,
// the mic dictation (tap or hold) and a hands-free clip. Before 2026-11-09 only Send and Enter took the attached
// pictures. A dictation sent the words alone and left the picture in the tray, so it went later as a second message
// (turns 4897 and 4898). Tested by daemon/compose.test.ts.
//
// `tray` is the list of attached pictures, `{ file, path?, ready? }` in the order the owner added them. `ready` is a
// promise that settles once the pen marks are drawn into `file`, so the upload never takes the picture without them.
// `upload(file)` saves one picture and returns its path, or throws. A picture keeps its path, so a clip that does not
// send (nothing heard, no wake word) does not upload it again on the next try.
// `post(lines)` sends the message with one `[image: path]` line per picture and returns true if a message went out.
// sendOut returns the pictures that went out: the caller takes them out of the tray. If an upload fails or nothing goes
// out, every picture stays in the tray.
export async function sendOut({ tray, upload, post }) {
  // Two sends at once (a tap on Send while a dictation transcribes) must not both take the same picture.
  const pics = tray.filter(p => !p.claimed);
  for (const p of pics) p.claimed = true;
  try {
    const lines = [];
    for (const p of pics) {
      await p.ready; // pen marks still being drawn into the picture (web/draw.js)
      p.path ??= await upload(p.file);
      lines.push(`[image: ${p.path}]`);
    }
    return (await post(lines)) ? pics : [];
  } finally {
    for (const p of pics) p.claimed = false;
  }
}

// A worker gets a picture as an `[image: path]` line, and this fixed line under it tells the worker to read the
// file. jarvisd adds it to each message with a picture that goes to a worker (daemon/workroutes.ts steerWorker), so a
// worker that started before this line existed reads the picture too. The pane hides it (withoutReadLine).
export const READ_PICTURES = 'Each [image: /path] line above is a picture the owner attached. Read that file with the Read tool to see it.';
const HAS_PICTURE = /\[image:\s*[^\]\n]+\]/;
export function withReadLine(text) {
  if (!HAS_PICTURE.test(text) || text.split('\n').some(l => l.trim() === READ_PICTURES)) return text;
  return `${text}\n${READ_PICTURES}`;
}
export function withoutReadLine(text) {
  return String(text ?? '').split('\n').filter(l => l.trim() !== READ_PICTURES).join('\n').trim();
}

// The query a voice clip posts: one `image` parameter per picture path. The daemon makes the lines (voiceMessage).
export function imageParams(q, lines) {
  for (const l of lines) q.append('image', l.slice('[image: '.length, -1));
  return q;
}
