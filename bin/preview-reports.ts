// Sample reports for bin/preview.ts: the worker_done bodies a Report link opens. All made up. `?s=reports` shows them.

const REVIEW = `Reviewed the payments branch: two problems should block the merge and the rest can wait. The tests pass on staging, but the retry path charges twice when the bank times out.

## Findings

1. HIGH: the retry path charges twice when the bank times out. See \`payments/retry.ts:88\`.
2. HIGH: a refund on a closed account throws and leaves the row locked.
3. MEDIUM: the receipt email goes out before the charge is confirmed.
4. LOW: two log lines still say "stripe" in the new provider's code.

## Checks

| Check | Result | Notes |
| --- | --- | --- |
| Unit tests | PASS | 412 of 412 |
| Staging charge | PASS | One real card, refunded |
| Bank timeout | FAIL | Charged twice, see the first finding |
| Load test | SKIP | Not run, no staging capacity |

## Screens

The receipt, as sent on staging.

[image: /tmp/sample/receipt.png]

Also compared with /Users/owner/Desktop/old-receipt.png.

## What is left

- Fix the two HIGH findings
- Run the load test once staging has room
`;

const ANSWER = `The feed slowed down because the nightly import now runs at 2 AM instead of 4 AM, on top of the backup. Moving it back should fix it.

The change is in \`jobs/schedule.ts\`, from the commit on October 28. Nothing else in the feed changed that week.`;

const FAILED = `Stopped: the import retry could not be tested, because staging has no sample lead file.

**What I tried**

- FAIL: running the retry against the empty folder
- FAIL: asking the importer for a generated file

**What is left**

Someone needs to drop one real file in the staging bucket.`;

/** A report as long as a big audit: 12 areas, 3 parts in each, findings, a results table and code. More than 600 lines. */
function audit(): string {
  const areas = ['Sign-in', 'Dealer accounts', 'Inventory import', 'Price history', 'Export feeds', 'Lead routing', 'Email sending', 'Window stickers', 'Reports', 'Billing', 'Background jobs', 'Mobile layout'];
  const levels = ['HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'LOW', 'LOW'];
  const parts = areas.map((area, a) => {
    const findings = Array.from({ length: 18 }, (_, i) => {
      const level = a % 4 === 3 && i < 6 ? 'LOW' : levels[i % levels.length];
      return `- ${level}: ${area.toLowerCase()} check ${i + 1} found that \`src/${area.toLowerCase().replace(/ /g, '-')}/step${i + 1}.ts:${40 + i}\` does not handle an empty answer from the server, so the screen keeps its old value.`;
    });
    const results = Array.from({ length: 10 }, (_, i) => `| ${area} case ${i + 1} | ${i === 3 && a % 3 === 0 ? 'FAIL' : 'PASS'} | ${120 + i * 7} ms |`);
    const notes = Array.from({ length: 12 }, (_, i) => `Note ${i + 1} on ${area.toLowerCase()}: what the code does today, written out in a full sentence so the section has real length to it.`);
    return [
      `## ${area}`, '',
      `${area} works for the normal path. The findings below cover what happens when a step gets an empty or late answer.`, '',
      '### Findings', '', ...findings, '',
      '### Test results', '', '| Case | Result | Time |', '| --- | --- | --- |', ...results, '',
      '### Notes', '', ...notes.flatMap(n => [n, '']),
      '```', `$ npm test -- ${area.toLowerCase().replace(/ /g, '-')}`, '# this hash line is output, not a heading', `${results.length} tests, ${results.filter(r => r.includes('FAIL')).length} failed`, '```', '',
    ].join('\n');
  });
  return `Audited all 12 areas of the app against the checklist, 3 parts per area. Four sign-in and dealer problems need a fix before the next release, and the rest can go on the backlog.\n\n${parts.join('\n')}`;
}

/** Keyed by request id in the preview's scene. A row left out has no report and shows no link. */
export const SAMPLE_REPORTS: Record<number, { subject: string; body: string; failed?: boolean }> = {
  3: { subject: 'Blocked: no sample lead file on staging', body: FAILED, failed: true },
  20: { subject: 'Why the feed slowed down', body: ANSWER },
  21: { subject: 'Payments branch review', body: REVIEW },
  22: { subject: 'App audit, all 12 areas', body: audit() },
};

// Sample documents for the Reports view (data/reports in the real app). `?s=docs` lists them and puts a [report:] card in the chat.
// Kept in memory: the preview never opens data/.
const DOCS_DIR = '/Users/owner/Repos/jarvis/data/reports';
const STORY = `# Story 370 draft: Reports view

The owner reads long documents on his phone today as raw markdown on the Desktop. This story gives them a page in the app.

## What changes

1. A **Reports** button in the menu lists every document, newest first.
2. Tapping one shows it formatted: headings, lists, tables, code and links.
3. A \`[report: /path.md]\` line in the chat becomes a card that opens it.

## Checks

| Check | Result | Notes |
| --- | --- | --- |
| Path outside data/reports | PASS | Refused with 404 |
| Symlink pointing out | PASS | Refused |
| Phone layout at 390 px | PASS | No sideways scroll |

## The route

\`\`\`ts
if (url === '/api/reports/file') return readReport(path, REPORTS_DIR);
\`\`\`

See the [spec](https://example.com/spec) for the full rules.

## Screens

[image: /Users/owner/Repos/jarvis/docs/screens/reports/sample.png]

## Open points

- HIGH: nothing deletes old documents yet.
- LOW: the list is capped at 200 files.
`;
const RESEARCH = `# Marketplace listing limits, research

Facebook does not publish a hard daily limit. Dealers report trouble above about 50 new listings a day.

## Sources

- Seller help pages, read on November 4
- Three dealer forums, posts from 2025 and 2026
`;
const NOTES = `# Weekly worker report

All six workers finished. Two opened pull requests, four answered questions.
`;
export const SAMPLE_DOCS = [
  { path: `${DOCS_DIR}/story-370-reports-view.md`, title: 'Story 370 draft: Reports view', min: 6, body: STORY },
  { path: `${DOCS_DIR}/marketplace-limits.md`, title: 'Marketplace listing limits, research', min: 180, body: RESEARCH },
  { path: `${DOCS_DIR}/weekly-worker-report.md`, title: 'Weekly worker report', min: 60 * 26, body: NOTES },
];
