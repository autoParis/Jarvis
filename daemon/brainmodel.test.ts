import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.ts';
import { parseBrainModel, readBrainModel, saveBrainModel, changeBrainModel, DEFAULT_BRAIN_MODEL, type BrainModel } from './brainmodel.ts';
import { pillText, sheetHtml } from '../web/modelpicker.js';
import { MODELS, EFFORTS } from './brainmodel.ts';

test('the default is Opus 5.5 at medium, also when the saved value is missing or broken', () => {
  assert.deepEqual(DEFAULT_BRAIN_MODEL, { model: 'claude-opus-5-5', effort: 'medium' });
  assert.deepEqual(readBrainModel(() => undefined), DEFAULT_BRAIN_MODEL);
  assert.deepEqual(readBrainModel(() => '{not json'), DEFAULT_BRAIN_MODEL);
  assert.deepEqual(readBrainModel(() => JSON.stringify({ model: 'gpt-4', effort: 'high' })), DEFAULT_BRAIN_MODEL);
});

test('only the four models and five efforts are accepted', () => {
  for (const id of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'])
      assert.deepEqual(parseBrainModel({ model: id, effort }), { model: id, effort });
  assert.ok('error' in parseBrainModel({ model: 'claude-opus-5-5', effort: 'extreme' }));
  assert.ok('error' in parseBrainModel({ model: 'opus', effort: 'low' }));
  assert.ok('error' in parseBrainModel(null));
});

test('the setting survives a jarvisd restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'jarvis-bm-')), 'jarvis.db');
  const a = openStore(path);
  saveBrainModel(a.setState, { model: 'claude-sonnet-5-5', effort: 'high' });
  a.db.close();
  const b = openStore(path);
  assert.deepEqual(readBrainModel(b.getState), { model: 'claude-sonnet-5-5', effort: 'high' });
});

function fakeBrain(o: { busy?: boolean; refuse?: string } = {}) {
  const state = new Map<string, string>();
  const switched: BrainModel[] = [];
  const brain = {
    busy: o.busy ?? false,
    setting: { ...DEFAULT_BRAIN_MODEL } as BrainModel,
    async switchModel(m: BrainModel) { if (o.refuse) return o.refuse; switched.push(m); this.setting = m; return undefined; },
  };
  const setState = (k: string, v: string) => { state.set(k, v); };
  return { brain, state, switched, setState, saved: () => readBrainModel(k => state.get(k)) };
}

test('the endpoint saves the setting and restarts the brain on it', async () => {
  const f = fakeBrain();
  const r = await changeBrainModel({ body: { model: 'claude-haiku-5-5', effort: 'low' }, brain: f.brain, setState: f.setState, killed: false });
  assert.equal(r.status, 200);
  assert.deepEqual(f.switched, [{ model: 'claude-haiku-5-5', effort: 'low' }]);
  assert.deepEqual(f.saved(), { model: 'claude-haiku-5-5', effort: 'low' });
});

test('the endpoint refuses a bad body and a switch mid-turn, and saves nothing', async () => {
  let f = fakeBrain();
  let r = await changeBrainModel({ body: { model: 'claude-haiku-5-5' }, brain: f.brain, setState: f.setState, killed: false });
  assert.equal(r.status, 400);
  assert.equal(f.state.size, 0);
  f = fakeBrain({ busy: true });
  r = await changeBrainModel({ body: { model: 'claude-haiku-5-5', effort: 'low' }, brain: f.brain, setState: f.setState, killed: false });
  assert.equal(r.status, 409);
  assert.match(r.error!, /middle of a turn/);
  assert.equal(f.state.size, 0);
  assert.deepEqual(f.switched, []);
});

test('a switch the brain refuses puts the saved setting back', async () => {
  const f = fakeBrain({ refuse: 'A switch is already under way.' });
  const r = await changeBrainModel({ body: { model: 'claude-fable-5-1', effort: 'max' }, brain: f.brain, setState: f.setState, killed: false });
  assert.equal(r.status, 409);
  assert.deepEqual(f.saved(), DEFAULT_BRAIN_MODEL);
});

test('with the kill switch on, the setting is saved and the brain is not started', async () => {
  const f = fakeBrain();
  const r = await changeBrainModel({ body: { model: 'claude-fable-5-1', effort: 'high' }, brain: f.brain, setState: f.setState, killed: true });
  assert.equal(r.status, 200);
  assert.deepEqual(f.switched, []);
  assert.deepEqual(f.brain.setting, { model: 'claude-fable-5-1', effort: 'high' });
  assert.deepEqual(f.saved(), { model: 'claude-fable-5-1', effort: 'high' });
});

test('the pill shows what runs, the setting when nothing runs, and the check follows it', () => {
  const base = { models: MODELS, efforts: EFFORTS, switching: false };
  assert.equal(pillText({ ...base, setting: DEFAULT_BRAIN_MODEL, running: null }), 'Opus 5.5 Medium');
  const b = { ...base, setting: { model: 'claude-fable-5-1', effort: 'xhigh' }, running: { model: 'claude-sonnet-5-5', effort: 'high' } };
  assert.equal(pillText(b), 'Sonnet 5.5 High', 'the running process wins over what was tapped');
  assert.equal(pillText({ ...b, switching: true }), 'Switching…');
  const html = sheetHtml(b, true);
  assert.match(html, /aria-checked="true" data-model="claude-sonnet-5-5"/);
  assert.match(html, /aria-checked="true" data-effort="high"/);
  assert.equal(html.match(/data-model=/g)!.length, 4);
  assert.equal(html.match(/data-effort=/g)!.length, 5);
});
