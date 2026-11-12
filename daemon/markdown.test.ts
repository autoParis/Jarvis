import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { sentences } from './voice.ts';

// web/markdown.js is a browser script; run it in a vm and take the function it defines.
const ctx: { markdown?: (text: string, shot: (path: string, alt?: string) => string) => string } = {};
runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), ctx);
const md = (text: string) => ctx.markdown!(text, p => `<SHOT ${p}>`);

test('Jarvis markdown renders headers, lists, emphasis, code and links', () => {
  assert.equal(md('## Status\n### Next'), '<h3>Status</h3><h4>Next</h4>');
  assert.equal(md('- one\n- **two**\n  - nested\n- three'), '<ul><li>one</li><li><strong>two</strong><ul><li>nested</li></ul></li><li>three</li></ul>');
  assert.equal(md('3. c\n4. d'), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(md('Run `npm *test*` now, *really*.'), '<p>Run <code>npm *test*</code> now, <em>really</em>.</p>');
  assert.equal(md('```\nconst a = 1 < 2;\n```'), '<pre><code>const a = 1 &lt; 2;</code></pre>');
  assert.equal(md('See [the PR](https://x.y/1) or https://x.y/2.'),
    '<p>See <a href="https://x.y/1" target="_blank" rel="noopener">the PR</a> or <a href="https://x.y/2" target="_blank" rel="noopener">https://x.y/2</a>.</p>');
  assert.equal(md('line one\nline two\n\nnext'), '<p>line one<br>line two</p><p>next</p>');
  assert.equal(md('Here:\n[image: /tmp/a.png]'), '<p>Here:<br><SHOT /tmp/a.png></p>');
  assert.equal(md('snake_case_name stays'), '<p>snake_case_name stays</p>');
});

test('message text never becomes markup', () => {
  const html = md('# <img src=x onerror=alert(1)>\n- <script>x</script>\n`<b>`\n[<i>](https://a.b/"onmouseover=x)\n**<u>**');
  assert.doesNotMatch(html, /<(img|script|b|i|u)[\s>]/);
  assert.doesNotMatch(html, /"onmouseover/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(md('[x](javascript:alert(1))'), /href/);
});

test('a markdown image becomes a picture: a path goes through shot with its alt, a web address is an img, another scheme is text', () => {
  const alt = (text: string) => ctx.markdown!(text, (p, a) => `<SHOT ${p} | ${a ?? ''}>`);
  assert.equal(alt('![Listing tab](4812-shots/01.png)'), '<p><SHOT 4812-shots/01.png | Listing tab></p>');
  assert.equal(alt('See ![a](/abs/x.png "title") here'), '<p>See <SHOT /abs/x.png | a> here</p>');
  assert.equal(alt('![a b](<my shots/x.png>)'), '<p><SHOT my shots/x.png | a b></p>');
  assert.equal(alt('![a](my%20shot.png)'), '<p><SHOT my shot.png | a></p>');
  assert.equal(alt('Here:\n[image: /tmp/a.png]'), '<p>Here:<br><SHOT /tmp/a.png | ></p>');
  assert.equal(md('![pic](https://x.y/a.png)'), '<p><a href="https://x.y/a.png" target="_blank"><img src="https://x.y/a.png" alt="pic"></a></p>');
  assert.equal(md('![" onerror="x](https://x.y/a.png)'), '<p><a href="https://x.y/a.png" target="_blank"><img src="https://x.y/a.png" alt="&quot; onerror=&quot;x"></a></p>');
  assert.doesNotMatch(md('![<b>x</b>](javascript:alert(1))'), /href|src|<b>/);
  assert.doesNotMatch(md('![x](data:image/png;base64,AAAA)'), /src/);
  assert.equal(md('`![a](b.png)`'), '<p><code>![a](b.png)</code></p>'); // inline code keeps its text
});

test('speech skips markdown symbols', () => {
  assert.deepEqual(sentences('## Status\n- **Two** PRs open.\n1. Merge `skua`.\n[The PR](https://x.y/1) is up.\n```\ncode here\n```\nDone.'),
    ['Status', 'Two PRs open.', 'Merge skua.', 'The PR is up.', 'Done.']);
});
