// The mouse's back button and the browser's Back take the owner from a worker's pane, a terminal or a report to the
// main conversation. A module so daemon/backnav.test.ts can test it with a fake window.
// On the main conversation neither one does anything new: the listeners do nothing when no pane is open.

/** MouseEvent.button for the mouse's back button. */
export const BACK_BUTTON = 3;
const MARK = 'jarvisPane';

/**
 * win: { history, addEventListener, location }. current(): 'worker' (a worker's pane or a terminal), 'report' or null.
 * leave(): closes what is open, as the pane's Back button does.
 */
export function makeBackNav({ win, current, leave }) {
  const marked = () => !!win.history.state?.[MARK];
  // A worker's pane or a terminal opened: one history entry above the main conversation, so the browser's Back (and the
  // mouse's, in browsers that map it to Back) closes it and stays in the app. Moving from pane to pane adds no entry.
  // Reports have their own addresses (#report/<id>), so they need no entry.
  function opened() {
    const href = win.location.href;
    if (marked()) win.history.replaceState({ [MARK]: 1 }, '', href);
    else win.history.pushState({ [MARK]: 1 }, '', href);
  }
  /** Back to the main conversation. false when it is already open. */
  function back() {
    if (!current()) return false;
    leave();
    return true;
  }
  // mouseup is the event the browser's own back navigation can be cancelled on. Cancelled here, it cannot run twice.
  win.addEventListener('mouseup', e => {
    if (e.button !== BACK_BUTTON || !current()) return;
    e.preventDefault();
    back();
  });
  // The browser's Back left the pane's entry. A report's own address change is handled by its hashchange route.
  win.addEventListener('popstate', () => { if (!marked() && current() === 'worker') leave(); });
  return { opened, back };
}

/** The steer box's unsent text, one per pane, so leaving a pane and coming back does not lose what the owner typed. */
export function makeDrafts() {
  const drafts = new Map();
  return {
    keep(id, text) { if (!id) return; if (text) drafts.set(id, text); else drafts.delete(id); },
    take(id) { return drafts.get(id) ?? ''; },
  };
}
