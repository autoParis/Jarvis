// The phone's sideways swipe: right opens the work list, left closes it. A module so daemon/messages.test.ts can test the rule.
export const SWIPE = { minDx: 70, maxDy: 50, edge: 30 };
/** 'open', 'close' or null. A swipe from the screen's left edge stays Safari's back gesture and does nothing here. */
export function swipeAction({ startX, startY, endX, endY }, drawerOpen) {
  const dx = endX - startX, dy = Math.abs(endY - startY);
  if (Math.abs(dx) < SWIPE.minDx || dy > SWIPE.maxDy) return null;
  if (dx < 0) return drawerOpen ? 'close' : null;
  return !drawerOpen && startX >= SWIPE.edge ? 'open' : null;
}
/** Where a sideways drag already means something else: typing, holding the mic, or scrolling code sideways. */
export const SWIPE_IGNORE = 'input, textarea, select, #mic, pre, table, .ask-cmd, .fold-detail';

// Swiping a message to the left starts a reply to it (phone). The message follows the finger, and only a drag past
// `threshold` starts the reply, so a short drag does nothing.
export const REPLY_SWIPE = { lock: 10, ratio: 1.5, threshold: 64, max: 96, edge: 24 };
/** Once the finger has moved `lock` px: 'reply' for a mostly leftward drag, 'none' for anything else (a scroll, a rightward drag). null until then. */
export function replyLock(dx, dy) {
  if (Math.hypot(dx, dy) < REPLY_SWIPE.lock) return null;
  return dx < 0 && Math.abs(dx) >= Math.abs(dy) * REPLY_SWIPE.ratio ? 'reply' : 'none';
}
/** How far the message moves for a drag of dx (negative is left): one to one up to the threshold, then slower, never past max. */
export function replyOffset(dx) {
  const d = Math.max(0, -dx), { threshold: t, max } = REPLY_SWIPE;
  return d ? -(d <= t ? d : Math.min(max, t + (d - t) * 0.35)) : 0;
}
