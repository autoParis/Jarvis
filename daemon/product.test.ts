import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { orderRepos, projectLabel, setProduct } from '../web/newpick.js';

const CONFIG = fileURLToPath(new URL('./config.ts', import.meta.url));
const read = (env: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
  `const c = await import(${JSON.stringify(CONFIG)}); console.log(JSON.stringify({ key: c.PRODUCT_KEY, label: c.PRODUCT_LABEL, repo: c.SUPPORT_REPO, suffix: c.SUPPORT_STAFF_SUFFIX }));`],
  { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' }));

test('the product settings keep the neutral defaults without .env', () => {
  assert.deepEqual(read({}), { key: 'acmeapp', label: 'AcmeApp', repo: 'example-org/acmeapp_nextjs', suffix: '(support Exampleco)' });
});

test('the product settings come from the environment, and a bad key falls back', () => {
  const env = { JARVIS_PRODUCT_KEY: 'Shopco', JARVIS_PRODUCT_LABEL: 'ShopCo', JARVIS_SUPPORT_REPO: 'shop/web', JARVIS_SUPPORT_STAFF_SUFFIX: '(ShopCo team)' };
  assert.deepEqual(read(env), { key: 'shopco', label: 'ShopCo', repo: 'shop/web', suffix: '(ShopCo team)' });
  assert.equal(read({ JARVIS_PRODUCT_KEY: '../x' }).key, 'acmeapp');
});

test('setProduct names the product card and sorts it second', () => {
  const repos = [{ name: 'fbm', path: '/r/fbm' }, { name: 'shopco', path: '/r/shopco' }, { name: 'jarvis', path: '/r/jarvis' }];
  assert.equal(projectLabel('shopco'), 'Shopco');
  setProduct({ key: 'shopco', label: 'ShopCo' });
  assert.deepEqual(orderRepos(repos).map(r => projectLabel(r.name)), ['Jarvis', 'ShopCo', 'FBM']);
  setProduct(undefined);
  assert.equal(projectLabel('shopco'), 'ShopCo');
});
