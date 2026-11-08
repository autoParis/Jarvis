// A dictation started with text in the box sends one message: the typed text, one space, then the dictated words.
// The page posts the box text with the clip (`typed`), the daemon joins them before it sends, and the page clears
// the box only after the send. Tested by daemon/dictate.test.ts.

// The message that goes out. Empty words mean nothing was heard: nothing goes out, and the typed text stays in the box.
export function withTyped(typed, words) {
  const said = String(words ?? '').trim();
  if (!said) return '';
  return [String(typed ?? '').trim(), said].filter(Boolean).join(' ');
}

// What the box holds after a dictation went out with `sent` as its typed part. Text typed while the clip was
// transcribing stays. A box changed in another way is left alone.
export function boxAfterSend(now, sent) {
  if (!sent) return now;
  if (now === sent) return '';
  if (now.startsWith(sent)) return now.slice(sent.length).trimStart();
  return now;
}

// Phone dictation (the iPhone keyboard's mic) can put its final words into the box a moment after the tap on Send.
// The send waits until the box has had no `input` or composition event for `quietMs`, and no longer than `maxMs`,
// before it reads the box. `composing()` says whether a composition is open: the wait then lasts until it ends or
// `maxMs` passes. Tested by daemon/dictate.test.ts.
export function settleBox(box, { quietMs = 250, maxMs = 1200, composing = () => false } = {}) {
  return new Promise(done => {
    const start = Date.now();
    let timer;
    const finish = () => {
      clearTimeout(timer);
      for (const ev of EVENTS) box.removeEventListener(ev, arm);
      done();
    };
    function arm() {
      clearTimeout(timer);
      const left = maxMs - (Date.now() - start);
      if (left <= 0) return finish();
      timer = setTimeout(() => (composing() && Date.now() - start < maxMs ? arm() : finish()), Math.min(quietMs, left));
    }
    for (const ev of EVENTS) box.addEventListener(ev, arm);
    arm();
  });
}
const EVENTS = ['input', 'compositionstart', 'compositionupdate', 'compositionend'];

// The one message a send posts: the box text, then one `[image: path]` line per picture. Empty when both are empty.
export function withPictures(text, lines) {
  return [String(text ?? '').trim(), ...(lines || [])].filter(Boolean).join('\n');
}
