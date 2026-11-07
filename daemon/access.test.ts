import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed, makeUiSessions, parseLsof, shellRefusal, UI_HEADER } from './access.ts';

test('an action as the owner needs the secret of an app page that is still open', () => {
  const ui = makeUiSessions();
  assert.equal(ui.ok({}), false, 'a plain curl to /api/approval is refused');
  assert.equal(ui.ok({ [UI_HEADER]: 'guess' }), false);
  const a = ui.open(), b = ui.open();
  assert.notEqual(a, b);
  assert.ok(a.length >= 32);
  assert.equal(ui.ok({ [UI_HEADER]: a }), true);
  ui.close(a);
  assert.equal(ui.ok({ [UI_HEADER]: a }), false, 'the secret dies with its page');
  assert.equal(ui.ok({ [UI_HEADER]: b }), true, 'another open page keeps its own');
});

test('tailnet callers need the owner\'s login; local callers pass the login check', () => {
  assert.equal(allowed({ host: '127.0.0.1:7717' }), true);
  assert.equal(allowed({ host: 'mac.tail.ts.net', 'tailscale-user-login': 'someone@else.test' }), false);
  assert.equal(allowed({ host: 'mac.tail.ts.net', 'tailscale-user-login': 'owner@example.test' }), true);
});

// Each case below is a route measured on the Mac on 2026-11-04.
const PIXEL = '100.64.0.10', TAILSCALED = 8028;
const phone = {
  login: 'owner@example.test', forwardedFor: PIXEL, remotePort: 50000, port: 7717, servePid: TAILSCALED,
  sockets: [{ pid: TAILSCALED, name: '127.0.0.1:50000->127.0.0.1:7717' }, { pid: 10274, name: '127.0.0.1:7717->127.0.0.1:50000' }],
  serveConfig: { TCP: { 7717: { HTTPS: true } } },
};

test('the shell takes a request from the phone through tailscale serve', () => {
  assert.equal(shellRefusal(phone), undefined);
});

test('the shell refuses every route a process on the Mac has', () => {
  const refused = (p: object, why: RegExp) => assert.match(shellRefusal({ ...phone, ...p }) ?? '', why);
  refused({ forwardedFor: '100.64.0.20' }, /not the phone/); // curl or Chrome on the Mac through the tailnet URL
  refused({ forwardedFor: '100.64.0.30' }, /not the phone/); // through the proxies to the tailnet URL
  refused({ forwardedFor: `${PIXEL}, 127.0.0.1` }, /not the phone/); // the HTTP proxy adds to a forged header
  refused({ forwardedFor: undefined }, /not the phone/);
  refused({ login: undefined }, /no tailnet login/);
  // Forged headers straight to 127.0.0.1: the other end of the socket is curl.
  refused({ sockets: [{ pid: 97466, name: '127.0.0.1:50000->127.0.0.1:7717' }] }, /did not come from the tailnet node/);
  // A copy of tailscaled, or any process that names itself so, is not the launchd service's pid.
  refused({ servePid: 1 }, /did not come from the tailnet node/);
  refused({ servePid: undefined }, /not running/);
  // A SOCKS or CONNECT tunnel to 127.0.0.1:7717: from tailscaled with forged headers, and its client is connected.
  refused({ sockets: [...phone.sockets, { pid: 777, name: '127.0.0.1:60000->127.0.0.1:1055' }] }, /tunnel/);
  refused({ sockets: [...phone.sockets, { pid: TAILSCALED, name: '127.0.0.1:1056->127.0.0.1:60000' }] }, /tunnel/);
  refused({ serveConfig: { TCP: { 9999: { TCPForward: '127.0.0.1:7717' } } } }, /raw TCP forward/);
  refused({ serveConfig: undefined }, /could not be read/);
});

test('lsof field output becomes sockets per process', () => {
  assert.deepEqual(parseLsof('p8028\nf15\nn127.0.0.1:1->127.0.0.1:7717\np10274\nf16\nn127.0.0.1:7717->127.0.0.1:1\n'), [
    { pid: 8028, name: '127.0.0.1:1->127.0.0.1:7717' }, { pid: 10274, name: '127.0.0.1:7717->127.0.0.1:1' },
  ]);
});
