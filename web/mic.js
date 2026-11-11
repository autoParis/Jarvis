// A dictation mic button: hold to talk and release to send, or tap to start and tap again to send. Escape drops the
// clip. The pane's box uses it. The chat's mic keeps its own copy of these rules in web/index.html, because hands-free
// shares that mic's stream and state. Tested by daemon/mic.test.ts.
export const HOLD_MS = 300;

/**
 * `getStream()` returns the microphone stream. `onStart()` runs as the owner starts to talk. `onHint(text)` shows what
 * the mic does now ('' when it stops). `onError(text)` shows a failure. `onClip(blob)` sends a kept clip.
 */
export function makeMic({ button, label, getStream, onStart = () => {}, onHint, onError, onClip, doc = document, Recorder = globalThis.MediaRecorder, now = () => Date.now() }) {
  let rec = null, pressedAt = 0, holding = false, latched = false;
  const show = hint => { button.classList.add('rec'); button.setAttribute('aria-label', 'Listening, tap to send'); onHint(hint); };
  /** Stops a dictation. `keep` sends the clip, false drops it. */
  function stop(keep) {
    latched = holding = false;
    if (rec && rec.state === 'recording') { rec.keep = keep; rec.stop(); }
    button.classList.remove('rec');
    button.setAttribute('aria-label', label);
    onHint('');
  }
  async function start() {
    onStart();
    let stream;
    try { stream = await getStream(); }
    catch (err) { latched = holding = false; button.classList.remove('rec'); onHint(''); onError('Microphone unavailable: ' + err.message); return; }
    if (!holding && !latched) return; // released, or cancelled, while the permission prompt was open
    const chunks = [], r = rec = new Recorder(stream);
    r.ondataavailable = ev => ev.data.size && chunks.push(ev.data);
    r.onstop = async () => {
      if (!r.keep) return;
      const blob = new Blob(chunks, { type: r.mimeType });
      if (blob.size < 2000) return; // a tap with no speech
      button.classList.add('busy');
      try { await onClip(blob); } finally { button.classList.remove('busy'); }
    };
    r.start();
  }
  button.addEventListener('pointerdown', async e => {
    e.preventDefault();
    if (latched) return stop(true);
    button.setPointerCapture?.(e.pointerId); // a drifting thumb keeps recording until it lifts
    pressedAt = now();
    holding = true;
    setTimeout(() => { if (holding) show('Listening… release to send'); }, HOLD_MS);
    await start();
  });
  const release = e => {
    e?.preventDefault();
    if (!holding) return;
    holding = false;
    if (now() - pressedAt < HOLD_MS) { latched = true; show('Listening… tap the mic to send'); return; }
    stop(true);
  };
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('contextmenu', e => e.preventDefault());
  // Keyboard Enter or Space on the mic: the first starts a dictation, the second sends it.
  button.addEventListener('click', e => {
    if (e.detail !== 0) return;
    if (latched) return stop(true);
    latched = true; show('Listening… press again to send'); start();
  });
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && latched) stop(false); });
  return { stop, active: () => holding || latched || rec?.state === 'recording' || button.classList.contains('busy') };
}
