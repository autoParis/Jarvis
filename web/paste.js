// Text pasted into a box goes in from the paste event itself. Chrome reads the clipboard a second time for its own
// insert, and that read sometimes comes back empty with FluidVoice's Cmd+V: the event held the full text, the insert
// got nothing, and the box stayed empty (caught live on 2026-11-02).
// A classic script so the page can call it synchronously; daemon/paste.test.ts runs it in a vm.
(() => {
  /** True if `e` carried text and it is now in `box`. False leaves the paste to the caller or the browser. */
  function pasteText(e, box) {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return false;
    e.preventDefault();
    // execCommand keeps Cmd+Z working and fires the box's input event.
    if (!document.execCommand('insertText', false, text)) {
      box.setRangeText(text, box.selectionStart, box.selectionEnd, 'end');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }
  globalThis.pasteText = pasteText;
})();
