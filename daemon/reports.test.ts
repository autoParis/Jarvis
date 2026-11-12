import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, existsSync, realpathSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { reportFile, reportTitle, listReports, readReport, REPORT_MARKER } from './reports.ts';
import { sentences } from './voice.ts';
import { docHref, docRoute, docHtml, docListHtml, resolveImage } from '../web/report.js';

const vm: { markdown?: (text: string, shot: (path: string, alt?: string) => string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), vm);
const markdown = vm.markdown!;
const shot = (p: string) => `<SHOT ${p}>`;

function folder() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'jarvis-reports-')));
  const dir = join(base, 'data', 'reports');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'a.md'), '# Story draft\n\nBody');
  writeFileSync(join(dir, 'sub', 'b.md'), 'No heading here');
  writeFileSync(join(dir, 'notes.txt'), 'not markdown');
  writeFileSync(join(base, 'secret.md'), '# Outside');
  return { base, dir };
}

// ---- the path check ----

test('a .md file inside data/reports is served, subfolders included', () => {
  const { dir } = folder();
  assert.equal(reportFile(join(dir, 'a.md'), dir), join(dir, 'a.md'));
  assert.equal(reportFile(join(dir, 'sub', 'b.md'), dir), join(dir, 'sub', 'b.md'));
});

test('any other path is refused: outside, .., another extension, relative, a folder, missing, a null byte', () => {
  const { base, dir } = folder();
  assert.equal(reportFile(join(base, 'secret.md'), dir), undefined);
  assert.equal(reportFile(join(dir, '..', '..', 'secret.md'), dir), undefined);
  assert.equal(reportFile(join(dir, 'notes.txt'), dir), undefined);
  assert.equal(reportFile('data/reports/a.md', dir), undefined);
  assert.equal(reportFile(join(dir, 'sub'), dir), undefined);
  assert.equal(reportFile(join(dir, 'gone.md'), dir), undefined);
  assert.equal(reportFile(join(dir, 'a.md\0'), dir), undefined);
  assert.equal(reportFile('/etc/passwd', dir), undefined);
  assert.equal(reportFile(dir, dir), undefined);
  assert.equal(readReport(join(base, 'secret.md'), dir), undefined);
});

test('a symlink inside the folder that points out is refused; a folder named like it is not inside', () => {
  const { base, dir } = folder();
  symlinkSync(join(base, 'secret.md'), join(dir, 'link.md'));
  assert.equal(reportFile(join(dir, 'link.md'), dir), undefined);
  mkdirSync(`${dir}-evil`);
  writeFileSync(join(`${dir}-evil`, 'x.md'), '# x');
  assert.equal(reportFile(join(`${dir}-evil`, 'x.md'), dir), undefined);
});

test('a folder that is itself a symlink still works', () => {
  const { base, dir } = folder();
  const alias = join(base, 'alias');
  symlinkSync(dir, alias);
  assert.equal(reportFile(join(alias, 'a.md'), alias), join(dir, 'a.md'));
});

// ---- the list ----

test('the list is newest first, .md only, with the first heading as the title or else the file name', () => {
  const { dir } = folder();
  utimesSync(join(dir, 'a.md'), new Date('2026-11-01T12:00:00Z'), new Date('2026-11-01T12:00:00Z'));
  utimesSync(join(dir, 'sub', 'b.md'), new Date('2026-11-05T12:00:00Z'), new Date('2026-11-05T12:00:00Z'));
  const list = listReports(dir);
  assert.deepEqual(list.map(r => [r.path, r.title, r.at]), [
    [join(dir, 'sub', 'b.md'), 'b', '2026-11-05T12:00:00.000Z'],
    [join(dir, 'a.md'), 'Story draft', '2026-11-01T12:00:00.000Z'],
  ]);
});

test('a missing folder is made and lists nothing', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jarvis-reports-')), 'data', 'reports');
  assert.deepEqual(listReports(dir), []);
  assert.ok(existsSync(dir));
});

test('the title skips a heading inside a code block and drops emphasis', () => {
  assert.equal(reportTitle('```\n# not this\n```\n## **Real** title', '/x/y.md'), 'Real title');
  assert.equal(reportTitle('plain text', '/x/story-370_draft.md'), 'story 370 draft');
});

test('readReport returns the body with its title', () => {
  const { dir } = folder();
  const r = readReport(join(dir, 'a.md'), dir);
  assert.equal(r?.title, 'Story draft');
  assert.equal(r?.body, '# Story draft\n\nBody');
});

// ---- the marker ----

test('a [report:] line in a Jarvis message becomes a card that links to its page', () => {
  const html = markdown('Here is the draft.\n\n[report: /Users/owner/Repos/jarvis/data/reports/story-370.md]', shot);
  assert.match(html, /<p>Here is the draft\.<\/p><a class="rcard" href="#reports\/%2FUsers%2Fowner%2FRepos%2Fjarvis%2Fdata%2Freports%2Fstory-370\.md" data-report="\/Users\/owner\/Repos\/jarvis\/data\/reports\/story-370\.md">/);
  assert.match(html, /<span class="rcard-t">story 370<\/span>/);
});

test('a [report:] marker inside a sentence stays text, and a path cannot break out of the card', () => {
  assert.doesNotMatch(markdown('See [report: /a.md] for more', shot), /rcard/);
  const html = markdown('[report: /x/"><script>.md]', shot);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-report="\/x\/&quot;&gt;&lt;script&gt;\.md"/);
});

test('speech skips the marker, like an image marker', () => {
  const text = 'I wrote up the draft.\n\n[report: /Users/owner/Repos/jarvis/data/reports/a.md]';
  assert.deepEqual(sentences(text.replace(REPORT_MARKER, ' ')), ['I wrote up the draft.']);
});

// ---- the pages ----

test('a document address round-trips, and other addresses are not documents', () => {
  const p = '/Users/owner/Repos/jarvis/data/reports/a b#c.md';
  assert.equal(docRoute(docHref(p)), p);
  assert.equal(docRoute(docHref('')), '');
  assert.equal(docRoute('#report/7'), undefined);
  assert.equal(docRoute(''), undefined);
  assert.equal(docRoute('#reports/%E0%A4%A'), undefined);
});

test('a document shows whole: headings, tables, code and pictures, all escaped', () => {
  const body = '# Title\n\nText <b>bold</b>\n\n| A | B |\n| --- | --- |\n| 1 | PASS |\n\n```\ncode <x>\n```\n\n[image: /Users/owner/Desktop/s.png]';
  const html = docHtml({ path: '/d/data/reports/a.md', at: '2026-11-06T15:00:00Z', body }, { markdown, shot });
  assert.match(html, /<h2>Title<\/h2>/);
  assert.match(html, /Text &lt;b&gt;bold&lt;\/b&gt;/);
  assert.match(html, /<div class="rp-table"><table>/);
  assert.match(html, /<pre><code>code &lt;x&gt;<\/code><\/pre>/);
  assert.match(html, /<SHOT \/Users\/owner\/Desktop\/s\.png>/);
  assert.match(html, /11-06 10:00 a\.m\./); // Eastern, standard time
  assert.doesNotMatch(html, /<details/);
});

test('a document shows its pictures: a relative path is read against its folder, an absolute path and an [image:] line as they are', () => {
  const seen: [string, string | undefined][] = [];
  const pic = (p: string, alt?: string) => { seen.push([p, alt]); return `<SHOT ${p}>`; };
  const body = '# Shots\n\n![Listing tab](4812-shots/01-top.png)\n\n![up](../up.png)\n\n![dot](./sub/./c.png)\n\n![abs](/Users/owner/Desktop/s.png)\n\n[image: /d/data/reports/x.png]';
  const html = docHtml({ path: '/d/data/reports/4812.md', at: '2026-11-06T15:00:00Z', body }, { markdown, shot: pic });
  assert.deepEqual(seen, [
    ['/d/data/reports/4812-shots/01-top.png', 'Listing tab'],
    ['/d/data/up.png', 'up'], // only the address: the daemon's /image check refuses it
    ['/d/data/reports/sub/c.png', 'dot'],
    ['/Users/owner/Desktop/s.png', 'abs'],
    ['/d/data/reports/x.png', undefined],
  ]);
  assert.match(html, /<SHOT \/d\/data\/reports\/4812-shots\/01-top\.png>/);
  assert.equal(resolveImage('a.png', ''), 'a.png'); // no folder: /image refuses a relative path
  assert.equal(resolveImage('../../../../etc/x.png', '/d/r'), '/etc/x.png');
});

test('the list shows each title and its Eastern time, and says so when empty', () => {
  const html = docListHtml([{ path: '/d/data/reports/a.md', title: 'A <draft>', at: '2026-11-06T15:00:00Z' }]);
  assert.match(html, /<a class="dl-row" href="#reports\/%2Fd%2Fdata%2Freports%2Fa\.md"><span class="dl-t">A &lt;draft&gt;<\/span><span class="dl-at">11-06 10:00 a\.m\.<\/span><\/a>/);
  assert.match(docListHtml([]), /No reports yet/);
});
