import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// web/paste.js is a browser script; run it in a vm with a stand-in document and box.
function setup(execResult: boolean) {
  const calls: unknown[][] = [];
  const ctx: any = { Event, document: { execCommand: (...a: unknown[]) => { calls.push(a); return execResult; } } };
  runInNewContext(readFileSync(new URL('../web/paste.js', import.meta.url), 'utf8'), ctx);
  const box = {
    selectionStart: 2, selectionEnd: 4, ranges: [] as unknown[][], fired: [] as string[],
    setRangeText(...a: unknown[]) { this.ranges.push(a); },
    dispatchEvent(ev: Event) { this.fired.push(ev.type); return true; },
  };
  return { pasteText: ctx.pasteText, calls, box };
}
function paste(text: string | null) {
  const e = { prevented: false, preventDefault() { this.prevented = true; }, clipboardData: text === null ? null : { getData: (t: string) => t === 'text/plain' ? text : '' } };
  return e;
}

test('text from the paste event is inserted, and the browser does not read the clipboard again', () => {
  const { pasteText, calls, box } = setup(true);
  const e = paste('dictated\nwords');
  assert.equal(pasteText(e, box), true);
  assert.equal(e.prevented, true);
  assert.deepEqual(calls, [['insertText', false, 'dictated\nwords']]);
  assert.deepEqual(box.ranges, []);
});

test('if execCommand refuses, the text still goes in at the selection and input fires', () => {
  const { pasteText, box } = setup(false);
  const e = paste('words');
  assert.equal(pasteText(e, box), true);
  assert.deepEqual(box.ranges, [['words', 2, 4, 'end']]);
  assert.deepEqual(box.fired, ['input']);
});

test('a paste with no text is left alone, so a picture can still attach', () => {
  for (const e of [paste(''), paste(null)]) {
    const { pasteText, calls, box } = setup(true);
    assert.equal(pasteText(e, box), false);
    assert.equal(e.prevented, false);
    assert.deepEqual(calls, []);
    assert.deepEqual(box.ranges, []);
  }
});
