// A worker's report (its worker_done body), turned into a page that can be skimmed: the first paragraph as a summary,
// headed sections that open and close, badge rows for lines that start with HIGH, PASS and the like, tables and pictures.
// Everything else goes through web/markdown.js, which escapes all text. A module so the page and
// daemon/report.test.ts import the same code.
import { esc, STATE, requestMark } from './requestlist.js';
import { formatStamp } from './workfold.js';
import { docHref } from './contract.js';

const FENCE = /^\s*(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BOLD_LINE = /^\s{0,3}(?:\*\*([^*\n]{1,80}?)\*\*|__([^_\n]{1,80}?)__)\s*:?\s*$/;
const NOT_PROSE = /^\s*(?:[-*+]\s|\d{1,9}[.)]\s|>|\||#{1,6}\s|([-*_])(\s*\1){2,}\s*$|\[image:[^\]\n]+\]\s*$)/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const IMAGE_PATH = /(^|\s)(\/[^\s`'"]+\.(?:png|jpe?g|webp|gif))(?=[\s.,;:)]*(?:\s|$))/gi;
/** A summary longer than this keeps its first sentences, and the rest goes to Details. */
const SUMMARY_MAX = 600;
/** The first line of a report in the card shape. Bold around the word is allowed. */
const RESULT_LINE = /^\s*[*_]{0,2}(DONE|FAILED)[*_]{0,2}\s*:\s*[*_]{0,2}(.+?)[*_]{0,2}\s*$/i;
/** Points under the result line stay in the first view up to this size. A longer intro goes to Details. */
const POINTS_MAX = 700, POINTS_LINES = 10;

// Worst first: the order of the count chips. A spelling that means the same thing shows one label.
const BADGES = {
  CRITICAL: ['CRITICAL', 'bad'], BLOCKER: ['BLOCKER', 'bad'], HIGH: ['HIGH', 'bad'], FAIL: ['FAIL', 'bad'], FAILED: ['FAIL', 'bad'],
  MEDIUM: ['MEDIUM', 'warn'], MED: ['MEDIUM', 'warn'], WARN: ['WARN', 'warn'], WARNING: ['WARN', 'warn'], PARTIAL: ['PARTIAL', 'warn'], BLOCKED: ['BLOCKED', 'warn'],
  LOW: ['LOW', 'quiet'], INFO: ['INFO', 'quiet'], SKIP: ['SKIP', 'quiet'], SKIPPED: ['SKIP', 'quiet'],
  PASS: ['PASS', 'good'], PASSED: ['PASS', 'good'], OK: ['OK', 'good'], FIXED: ['FIXED', 'good'], DONE: ['DONE', 'good'],
};
const ORDER = [...new Set(Object.values(BADGES).map(b => b[0]))];
const TONE = Object.fromEntries(Object.values(BADGES));
// These also start plain sentences ("OK so the test..."), so they need punctuation or bold to count as a badge.
const WEAK = new Set(['OK', 'DONE', 'FIXED', 'INFO', 'BLOCKED', 'PARTIAL']);
const BADGE_LINE = /^\s*((?:[-*+]|\d{1,9}[.)])\s+)?(?:\[[ xX]\]\s+)?([*_`[(]*)([A-Za-z]+)([*_`\])]*)(\s*:\s*|\s+[-–—]\s+|\.\s+|\s+|$)(.*)$/;

/** The badge a line starts with: { label, tone, num, text }, or undefined. Other than in capitals, the word needs bold, brackets or a colon. */
export function badgeOf(line) {
  const m = BADGE_LINE.exec(line);
  const badge = m && Object.hasOwn(BADGES, m[3].toUpperCase()) && BADGES[m[3].toUpperCase()];
  if (!badge) return undefined;
  const [, marker, open, word, close, sep] = m;
  let text = m[6];
  const emphasis = /[*_]/.test(open);
  if (open && !emphasis && !close) return undefined; // "(HIGH risk)" is a sentence in brackets
  const wrapped = !!close || (emphasis && /^[*_]/.test(text));
  if (word !== word.toUpperCase() && !wrapped && !sep.includes(':')) return undefined;
  if (WEAK.has(word.toUpperCase()) && !wrapped && sep && !sep.trim()) return undefined;
  // "**HIGH:** text" leaves the closing marks at the front. "**HIGH risk**: text" keeps its bold.
  if (emphasis && !close) text = /^[*_]/.test(text) ? text.replace(/^[*_]+\s*/, '') : open + text;
  const num = /\d+/.exec(marker ?? '')?.[0];
  return { label: badge[0], tone: badge[1], ...(num ? { num } : {}), text: text.trim() };
}

/** For each line, whether it sits inside a code fence (the fence lines included). */
function fenced(lines) {
  let fence = null;
  return lines.map(l => {
    const f = FENCE.exec(l);
    if (fence) { if (l.trimStart().startsWith(fence)) fence = null; return true; }
    if (f) { fence = f[1]; return true; }
    return false;
  });
}

function headingAt(line) {
  const h = HEADING.exec(line);
  if (h) return { level: h[1].length, title: h[2] };
  const b = BOLD_LINE.exec(line);
  return b && !badgeOf(line) ? { level: 7, title: (b[1] ?? b[2]).replace(/:$/, '') } : undefined;
}

/** The shallowest heading level splits the lines into sections; deeper headings nest inside them. */
function nest(lines) {
  const mask = fenced(lines);
  const heads = lines.map((l, i) => mask[i] ? undefined : headingAt(l));
  const levels = heads.filter(Boolean).map(h => h.level);
  if (!levels.length) return { intro: lines, sections: [] };
  const min = Math.min(...levels);
  const starts = heads.flatMap((h, i) => h?.level === min ? [i] : []);
  const before = nest(lines.slice(0, starts[0]));
  return {
    intro: before.intro,
    sections: [...before.sections, ...starts.map((s, n) => ({ title: heads[s].title, ...nest(lines.slice(s + 1, starts[n + 1])) }))],
  };
}

const hasText = lines => lines.some(l => l.trim());

/** Removes the first paragraph from `lines` and returns it. Lists, tables, code and badge rows are not paragraphs. */
function takeParagraph(lines) {
  const mask = fenced(lines);
  const prose = i => lines[i]?.trim() && !mask[i] && !NOT_PROSE.test(lines[i]) && !badgeOf(lines[i]);
  // A prose line straight after a list item is that item's wrapped text, so a paragraph starts at the top or after a blank line.
  const start = lines.findIndex((_, i) => prose(i) && (i === 0 || !lines[i - 1].trim()));
  if (start < 0) return '';
  let end = start;
  while (prose(end + 1)) end++;
  return lines.splice(start, end - start + 1).join('\n').trim();
}

/** The first paragraph of the report: above the first heading, else in the first section. */
function takeSummary(tree) {
  return takeParagraph(tree.intro) || (tree.sections[0] ? takeSummary(tree.sections[0]) : '');
}

const pruned = sections => sections.map(s => ({ ...s, sections: pruned(s.sections) })).filter(s => hasText(s.intro) || s.sections.length);

/** A row of a table, its cells without the outer pipes. `\|` is a pipe in the text. */
const cells = line => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
const tableAt = (lines, i) => lines[i].includes('|') && lines[i + 1]?.includes('|') && TABLE_RULE.test(lines[i + 1]);

/** A section's text as blocks: { type: 'md', text }, { type: 'table', head, rows } and { type: 'ranked', items }. */
export function parseBlocks(lines) {
  const out = [];
  let md = [];
  const flush = () => { if (hasText(md)) out.push({ type: 'md', text: md.join('\n').replace(/^\s*\n/, '').trimEnd() }); md = []; };
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (f) {
      md.push(lines[i]);
      while (++i < lines.length) { md.push(lines[i]); if (lines[i].trimStart().startsWith(f[1])) break; }
    } else if (tableAt(lines, i)) {
      flush();
      const head = cells(lines[i]), rows = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(head.map((_, c) => cells(lines[i])[c] ?? ''));
      i--;
      out.push({ type: 'table', head, rows });
    } else if (badgeOf(lines[i])) {
      flush();
      const items = [];
      let more = i;
      while (more < lines.length && badgeOf(lines[more])) {
        const item = badgeOf(lines[more]);
        const extra = [];
        let j = more + 1;
        // Indented lines under a row are its own text. A blank line only continues the list if another row or indented line follows.
        for (; j < lines.length; j++) {
          if (badgeOf(lines[j])) break;
          if (/^\s+\S/.test(lines[j])) { extra.push(lines[j].trim()); continue; }
          if (lines[j].trim()) break;
          const next = lines.slice(j).findIndex(l => l.trim());
          if (next < 0 || !(badgeOf(lines[j + next]) || /^\s+\S/.test(lines[j + next]))) break;
        }
        items.push({ ...item, text: [item.text, ...extra].filter(Boolean).join('\n') });
        i = j - 1;
        more = j;
      }
      out.push({ type: 'ranked', items });
    } else md.push(lines[i]);
  }
  flush();
  return out;
}

/** A bare image path in the text becomes an `[image: path]` marker. Inline code and code fences keep theirs. */
export function linkImages(text) {
  const lines = text.split('\n'), mask = fenced(lines);
  return lines.map((l, i) => mask[i] ? l : l.split('`').map((part, n) => n % 2 ? part : part.replace(IMAGE_PATH, '$1[image: $2]')).join('`')).join('\n');
}

const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const plain = s => s.replace(/\[image:[^\]\n]*\]/g, '').replace(MD_IMAGE, '').replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1').replace(/[*`]|__|^\s*(?:>|[-+]\s|\d+[.)]\s)+/g, '').replace(/\s+/g, ' ').trim();
const addCount = (to, label, n = 1) => { to[label] = (to[label] ?? 0) + n; };

/** A one-line idea of what a closed section holds. */
function previewOf(blocks, children) {
  for (const b of blocks) {
    if (b.type === 'ranked') return plain(b.items[0].text);
    if (b.type === 'table') return `Table, ${b.rows.length} ${b.rows.length === 1 ? 'row' : 'rows'}`;
    const lines = b.text.split('\n'), mask = fenced(lines);
    const line = lines.find((l, i) => !mask[i] && plain(l));
    return line ? plain(line) : 'Code';
  }
  return children.map(c => plain(c.title)).join(' · ');
}

/** Blocks, badge counts, line and picture counts and the preview, for one section and everything under it. */
function describe(s) {
  const sections = s.sections.map(describe);
  const blocks = parseBlocks(s.intro);
  const counts = {};
  for (const b of blocks) {
    if (b.type === 'ranked') b.items.forEach(i => addCount(counts, i.label));
    if (b.type === 'table') b.rows.flat().forEach(c => { const hit = cellBadge(c); if (hit) addCount(counts, hit[0]); });
  }
  let lines = s.intro.filter(l => l.trim()).length;
  let images = (linkImages(s.intro.join('\n')).match(/\[image:|!\[[^\]\n]*\]\(/g) ?? []).length;
  for (const c of sections) {
    for (const [k, n] of Object.entries(c.counts)) addCount(counts, k, n);
    lines += c.lines + 1;
    images += c.images;
  }
  return { title: s.title, blocks, sections, counts, lines, images, preview: previewOf(blocks, sections) };
}

/** A table cell that holds only a badge word, with or without bold. */
function cellBadge(cell) {
  const word = cell.replace(/[*_`]/g, '').trim();
  return Object.hasOwn(BADGES, word) ? BADGES[word] : undefined;
}

/**
 * The report's structure: { title, summary, sections, counts, lines }. A lone top heading is the report's title, not a section.
 * Text above the first heading that is not the summary becomes a section called Details. Sections with no text are dropped.
 */
export function splitReport(body) {
  const all = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  // A report in the card shape starts with its result: "DONE: <one line>". Short points under it stay in view.
  const first = all.findIndex(l => l.trim());
  const done = first >= 0 ? RESULT_LINE.exec(all[first]) : null;
  const lines = done ? all.filter((_, i) => i !== first) : all;
  let tree = nest(lines), title = '';
  if (!hasText(tree.intro) && tree.sections.length === 1) { title = tree.sections[0].title; tree = tree.sections[0]; }
  let summary, rest = [], result;
  if (done) {
    result = done[1].toUpperCase() === 'DONE' ? 'done' : 'failed';
    const points = tree.intro.join('\n').trim();
    const short = points.length <= POINTS_MAX && tree.intro.filter(l => l.trim()).length <= POINTS_LINES;
    summary = done[2] + (points && short ? `\n\n${points}` : '');
    if (short) tree = { ...tree, intro: [] };
  } else summary = takeSummary(tree);
  if (!done && summary.length > SUMMARY_MAX) {
    const cut = summary.lastIndexOf('. ', SUMMARY_MAX);
    if (cut > 0) { rest = [summary.slice(cut + 2)]; summary = summary.slice(0, cut + 1); }
  }
  const extra = [...rest, ...(rest.length ? [''] : []), ...tree.intro];
  const raw = [...(hasText(extra) ? [{ title: 'Details', intro: extra, sections: [] }] : []), ...pruned(tree.sections)];
  const sections = raw.map(describe);
  const counts = {};
  for (const s of sections) for (const [k, n] of Object.entries(s.counts)) addCount(counts, k, n);
  return { title, summary, sections, counts, lines: all.filter(l => l.trim()).length, ...(result ? { result } : {}) };
}

// ---- HTML ----

const CHEV = '<svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const badgeHtml = (label, tone, n) => `<span class="rp-badge ${tone}">${n ? `${n} ` : ''}${label}</span>`;
const countsHtml = counts => ORDER.filter(l => counts[l]).map(l => badgeHtml(l, TONE[l], counts[l])).join('');
const lineCount = n => `${n} ${n === 1 ? 'line' : 'lines'}`;

function blocksHtml(blocks, ctx) {
  const md = text => ctx.markdown(linkImages(text), ctx.shot);
  const inline = text => md(text).replace(/^<p>(.*)<\/p>$/s, '$1');
  const cell = c => { const b = cellBadge(c); return b ? badgeHtml(b[0], b[1]) : inline(c); };
  return blocks.map(b => {
    if (b.type === 'md') return `<div class="md">${md(b.text)}</div>`;
    if (b.type === 'table') {
      return `<div class="rp-table"><table><thead><tr>${b.head.map(h => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
        + `<tbody>${b.rows.map(r => `<tr>${r.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<ul class="rp-ranked">${b.items.map(i => `<li class="${i.tone}">${badgeHtml(i.label, i.tone)}<div class="md">${i.num ? `<span class="rp-num">${esc(i.num)}.</span> ` : ''}${inline(i.text)}</div></li>`).join('')}</ul>`;
  }).join('');
}

function sectionHtml(s, ctx, depth) {
  const size = [s.images ? `${s.images} ${s.images === 1 ? 'picture' : 'pictures'}` : '', lineCount(s.lines)].filter(Boolean).join(' · ');
  const title = ctx.markdown(s.title.replace(/\[image:[^\]\n]*\]/g, ''), ctx.shot).replace(/^<p>(.*)<\/p>$/s, '$1');
  return `<details class="rp-sec${depth ? ' sub' : ''}"><summary>${CHEV}<span class="rp-sec-t">${title}</span><span class="rp-size">${esc(size)}</span>`
    + `<span class="rp-sec-sub">${countsHtml(s.counts)}${s.preview ? `<span class="rp-preview">${esc(s.preview)}</span>` : ''}</span></summary>`
    + `<div class="rp-body">${blocksHtml(s.blocks, ctx)}${s.sections.map(c => sectionHtml(c, ctx, depth + 1)).join('')}</div></details>`;
}

/**
 * The whole page for one report from GET /api/requests/:id/report. `ctx` is { markdown, shot }, the renderer and the
 * picture function the page uses everywhere.
 */
export function reportHtml(r, ctx) {
  const { title, summary, sections, counts, lines, result } = splitReport(r.body);
  const lead = r.subject || title;
  const stamp = [`${requestMark(r.status)}<span>${esc(STATE[r.status] ?? r.status)}</span>`, `<span>${esc(formatStamp(r.at))}</span>`, ...(r.failed ? ['<span class="rp-failed">The worker reported a failure</span>'] : [])].join('');
  const chips = countsHtml(counts);
  const box = lead || summary || chips
    ? `<section class="rp-summary">${lead ? `<div class="rp-lead">${esc(lead)}</div>` : ''}${result ? `<h3 class="card-h">${result === 'done' ? 'Result' : 'Failed'}</h3>` : ''}${summary ? `<div class="md">${ctx.markdown(linkImages(summary), ctx.shot)}</div>` : ''}${chips ? `<div class="rp-chips">${chips}</div>` : ''}</section>`
    : '';
  const bar = sections.length
    ? `<div class="rp-bar"><span>${sections.length} ${sections.length === 1 ? 'section' : 'sections'} · ${lineCount(lines)}</span><button type="button" class="rp-all" aria-pressed="false">Expand all</button></div>`
    : '';
  return `<article class="rp"><h2 class="rp-title">${esc(r.title)}</h2><div class="rp-stamp">${stamp}</div>${box}${bar}${sections.map(s => sectionHtml(s, ctx, 0)).join('')}</article>`;
}

// ---- documents in data/reports: a list from the menu, one page per file, and the chat's [report: path] card ----

/** The address of a document's page, or of the list when `path` is empty (web/contract.js). */
export { docHref };

/** The path in a `#reports/<path>` address, '' for the list itself, undefined for any other address. */
export function docRoute(hash) {
  const m = /^#reports(?:\/(.*))?$/.exec(hash ?? '');
  if (!m) return undefined;
  try { return m[1] ? decodeURIComponent(m[1]) : ''; } catch { return undefined; }
}

/** The list from GET /api/reports, newest first as the daemon sends it. */
export function docListHtml(list) {
  if (!list.length) return '<div class="empty">No reports yet. Jarvis and the workers save long documents in data/reports, and they show here.</div>';
  const rows = list.map(d => `<li><a class="dl-row" href="${esc(docHref(d.path))}"><span class="dl-t">${esc(d.title)}</span><span class="dl-at">${esc(formatStamp(d.at))}</span></a></li>`).join('');
  return `<article class="rp"><h2 class="rp-title">Reports</h2><div class="rp-stamp"><span>${list.length} ${list.length === 1 ? 'document' : 'documents'}, newest first</span></div><ul class="dl">${rows}</ul></article>`;
}

/**
 * The absolute path of a picture a document names. A relative path is read against the document's folder, and `.` and
 * `..` are folded here only to build the address: the daemon's /image check decides what it serves.
 */
export function resolveImage(path, folder) {
  if (path.startsWith('/') || !folder) return path;
  const parts = [];
  for (const p of `${folder}/${path}`.split('/')) {
    if (p === '..') parts.pop();
    else if (p && p !== '.') parts.push(p);
  }
  return '/' + parts.join('/');
}

/** One document from GET /api/reports/file, all of it shown and nothing folded. Tables, badges and pictures as in a worker's report. */
export function docHtml(d, ctx) {
  const lines = String(d.body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const path = String(d.path ?? ''), name = path.split('/').pop();
  const folder = path.startsWith('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const shot = (p, alt) => ctx.shot(resolveImage(p, folder), alt);
  return `<article class="rp rp-doc"><div class="rp-stamp"><span>${esc(formatStamp(d.at))}</span><span>${esc(name)}</span></div><div class="rp-doc-body">${blocksHtml(parseBlocks(lines), { ...ctx, shot })}</div></article>`;
}
