// What the speaker button under a Jarvis message plays. One audio element, one message at a time.
// Clip i of a message always comes from clipUrl(turn, i). The daemon renders it on first request, so a reply
// still being rendered and a month-old message play the same way.

/**
 * `audio` is an HTMLAudioElement. `warm(url)` asks for the next clip early, so a replay has no gap between sentences.
 * `onChange()` runs whenever a button's state may have changed.
 * `report(event)` gets each clip's play, wait (a stall mid-clip), end, error and stop, so a glitch heard on the
 * phone shows its cause in the jarvisd log.
 */
export function makeSpeech({ audio, clipUrl, warm = () => {}, onChange = () => {}, report = () => {} }) {
  const turns = new Map(); // turn id -> { total, i, time, heard, errors, failed }. A turn in here never starts by itself again.
  const line = []; // replies waiting for the one playing to end
  let current = null, sounding = false, byHand = false, seek = 0;

  const note = (ev, extra = {}) => {
    const t = current === null ? null : turns.get(current);
    report({ ev, turn: current, i: t?.i ?? null, t: Math.round((audio.currentTime || 0) * 100) / 100, ...extra });
  };
  function entry(id, total) {
    if (!turns.has(id)) turns.set(id, { total, i: 0, time: 0, heard: 0, errors: 0, failed: false });
    return turns.get(id);
  }
  function playClip() {
    const t = turns.get(current);
    if (t.i >= t.total) return finish(t);
    seek = t.time;
    audio.src = clipUrl(current, t.i);
    audio.play().catch(err => { if (err?.name === 'NotAllowedError') blocked(); });
  }
  function finish(t) {
    t.failed = t.errors > 0 && t.heard === 0;
    Object.assign(t, { i: 0, time: 0, heard: 0, errors: 0 });
    current = null; sounding = false;
    next();
    onChange();
  }
  function next() {
    if (current === null && line.length) start(line.shift(), false);
  }
  function start(id, hand) {
    current = id; sounding = false; byHand = hand;
    turns.get(id).failed = false;
    playClip();
    onChange();
  }
  // Keeps the place in the message. A seek that has not landed yet keeps the place it was going to.
  function leave() {
    if (current === null) return;
    if (!seek) turns.get(current).time = audio.currentTime || 0;
    note('stop');
    audio.pause();
    current = null; sounding = false;
  }
  // The browser wants a gesture first. Nothing is lost: a tap on the button plays the message.
  function blocked() {
    current = null; sounding = false; line.length = 0;
    onChange();
  }

  audio.onloadedmetadata = () => { if (seek) audio.currentTime = seek; seek = 0; };
  audio.onplaying = () => {
    if (current === null) return;
    const t = turns.get(current);
    sounding = true;
    note('play', { dur: Math.round((audio.duration || 0) * 100) / 100 });
    if (t.i + 1 < t.total) warm(clipUrl(current, t.i + 1));
    onChange();
  };
  audio.onwaiting = () => { if (current !== null && sounding) note('wait'); };
  audio.onended = () => {
    if (current === null) return;
    note('end');
    const t = turns.get(current);
    t.i++; t.time = 0; t.heard++;
    playClip();
  };
  // A clip that cannot play is skipped. The button shows the failure only when no clip of the message played.
  audio.onerror = () => {
    if (current === null) return;
    note('error', { code: audio.error?.code ?? null });
    const t = turns.get(current);
    t.i++; t.time = 0; t.errors++; seek = 0;
    playClip();
  };

  return {
    /** The speaker button: stops this message, continues it, or plays it. Stopping never touches voice mode. */
    toggle(id, total) {
      entry(id, total);
      if (current === id) { leave(); next(); onChange(); return; }
      const waiting = line.indexOf(id);
      if (waiting >= 0) line.splice(waiting, 1);
      leave();
      start(id, true);
    },
    /** A clip of a new reply is ready and voice mode is on. It waits for a reply playing, and replaces a replay. */
    live(id, total, i = 0) {
      if (turns.has(id)) return;
      entry(id, total).i = i;
      if (byHand) leave();
      line.push(id);
      next();
    },
    /** Marks a reply so its later clips do not start it. Used when the owner talks over it. */
    hold(id, total) { entry(id, total); },
    /** Stops everything and drops the replies waiting. They stay playable from their buttons. */
    hush() {
      leave();
      line.length = 0;
      onChange();
    },
    active: () => current !== null || line.length > 0,
    /** idle, loading, playing, paused (a tap continues) or failed. */
    state(id) {
      if (current === id) return sounding ? 'playing' : 'loading';
      const t = turns.get(id);
      if (t?.failed) return 'failed';
      return t && (t.i > 0 || t.time > 0) ? 'paused' : 'idle';
    },
  };
}
