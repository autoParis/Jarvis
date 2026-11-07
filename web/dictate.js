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
