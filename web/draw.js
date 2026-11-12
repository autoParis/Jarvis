// Pictures in the chat: the small row on a sent message, and the pen marks on a picture before it is sent.
// The pure parts (the row, the stroke list, the point mapping) have no DOM; daemon/draw.test.ts imports them.

const IMAGE_MARKER = /\[image:\s*([^\]\n]+?)\s*\]/g;

/** Takes the `[image: path]` markers out of an owner message. The text keeps its other lines. */
export function splitPictures(text) {
  const paths = [...text.matchAll(IMAGE_MARKER)].map(m => m[1]);
  if (!paths.length) return { text, paths };
  return { text: text.replace(IMAGE_MARKER, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(), paths };
}

/** The row of square thumbnails, at most 4 on a line. No file name shows: the daemon names the files at random. */
export function shotRowHtml(paths, esc) {
  if (!paths.length) return '';
  const cells = paths.map((p, i) => {
    const src = '/image?path=' + encodeURIComponent(p);
    const label = paths.length === 1 ? 'Open the picture' : `Open picture ${i + 1} of ${paths.length}`;
    return `<button type="button" class="shot" data-src="${esc(src)}" aria-label="${label}" title="${label}"><img src="${esc(src)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')"></button>`;
  }).join('');
  return `<div class="shots" style="--n:${Math.min(paths.length, 4)}">${cells}</div>`;
}

/** The pen colors: red first (the default), then yellow. Both stand out on a screenshot, light or dark. */
export const INK = ['#FF3B30', '#FFD60A'];

/** The marks on one picture, in image pixels. Undo removes the last stroke, or brings back what Clear removed. */
// The list is never changed in place, so `strokes` is the same array until a mark is added or removed.
export function makeInk(strokes = []) {
  let list = strokes;
  const done = [];
  return {
    get strokes() { return list; },
    get canUndo() { return list.length > 0 || done.length > 0; },
    begin(pt, color, width) { const s = { color, width, points: [pt] }; list = [...list, s]; done.push({ kind: 'stroke' }); return s; },
    move(pt) { list[list.length - 1]?.points.push(pt); },
    clear() { if (!list.length) return; done.push({ kind: 'clear', before: list }); list = []; },
    undo() {
      const last = done.pop();
      if (!last) { list = list.slice(0, -1); return; } // strokes from an earlier opening of the viewer
      list = last.kind === 'clear' ? last.before : list.slice(0, -1);
    },
  };
}

/** A pointer position on the shown image, as a point in the image's own pixels. */
export function toImagePoint(clientX, clientY, rect, width, height) {
  const x = (clientX - rect.left) / rect.width * width, y = (clientY - rect.top) / rect.height * height;
  return [Math.max(0, Math.min(width, x)), Math.max(0, Math.min(height, y))];
}

/** Draws the strokes on a 2D context in image pixels. */
export function paint(ctx, strokes) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const s of strokes) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    const [first, ...rest] = s.points;
    if (!rest.length) { ctx.beginPath(); ctx.arc(first[0], first[1], s.width / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (const p of rest) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
  }
}

/** The picture with its marks, at the picture's real size. PNG, or JPEG when the PNG is over the upload limit. */
export async function exportMarked(img, strokes, limit) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  paint(ctx, strokes);
  const blob = type => new Promise(r => c.toBlob(r, type, 0.92));
  let out = await blob('image/png');
  if (out && out.size > limit) out = await blob('image/jpeg');
  if (!out) throw new Error('the browser could not save the marked picture');
  return new File([out], out.type === 'image/png' ? 'marked.png' : 'marked.jpg', { type: out.type });
}
