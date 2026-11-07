import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeOrca } from './fakeorca.ts';
import { openStore } from './store.ts';

const orca = fakeOrca();
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jarvis-orca');

// The three internal routes jarvis-orca reply uses, with the same rules as main.ts.
function jarvisd(s: ReturnType<typeof openStore>) {
  return http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const { id, answer } = JSON.parse(b || '{}');
    if (req.url === '/api/internal/reply-claim') {
      const status = s.claimReply(id);
      res.writeHead(status === 'claimed' || status === 'untracked' ? 200 : 409);
      return res.end(JSON.stringify({ status }));
    }
    if (req.url === '/api/internal/answered') s.markItem(id, 'answered', answer);
    if (req.url === '/api/internal/reply-release') s.releaseReply(id);
    res.writeHead(204); res.end();
  });
}

const reply = (url: string, msg: string) => new Promise<{ code: number; err: string }>(resolve =>
  execFile(SCRIPT, ['reply', '--id', msg, '--body', 'Yes, skip it'], { env: { ...process.env, JARVIS_RUN: 'run_x', JARVIS_HANDLE: 'term_x', JARVIS_URL: url } },
    (e, _out, err) => resolve({ code: e ? Number(e.code) : 0, err })));

test('jarvis-orca reply sends an answer once; a repeat is refused before it reaches Orca', async () => {
  const s = openStore(':memory:');
  s.insertItem({ source: 'orca', external_id: 'msg_1', kind: 'question' });
  const server = jarvisd(s).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    orca.answer('{"ok": false, "error": {"code": "busy"}}');
    assert.equal((await reply(url, 'msg_1')).code, 1);
    assert.equal(s.item('msg_1')!.status, 'spoken'); // refused by Orca, open again

    orca.answer('{"ok": true}');
    assert.equal((await reply(url, 'msg_1')).code, 0);
    assert.equal(s.item('msg_1')!.answer, 'Yes, skip it');

    const second = await reply(url, 'msg_1');
    assert.equal(second.code, 1);
    assert.match(second.err, /answered/);
    assert.equal(orca.calls().filter(c => c.includes('reply')).length, 2); // the refused one and the real one

    orca.answer('not json');
    s.insertItem({ source: 'orca', external_id: 'msg_2', kind: 'question' });
    assert.equal((await reply(url, 'msg_2')).code, 1);
    assert.equal(s.item('msg_2')!.status, 'replying'); // unknown outcome: never retried blindly
  } finally {
    server.close();
  }
});

test('jarvis-orca reply does not send when jarvisd is down', async () => {
  const before = orca.calls().length;
  const r = await reply('http://127.0.0.1:1', 'msg_9');
  assert.equal(r.code, 1);
  assert.match(r.err, /unreachable/);
  assert.equal(orca.calls().length, before);
});
