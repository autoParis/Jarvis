#!/usr/bin/env node
// Read-only. jarvisd runs this from the FBM repo after fbm-client-pause, to see what Firestore holds now.
// It prints one JSON line with these fields and nothing else from the document, and never a credential.
'use strict';

const path = require('node:path');

const at = process.argv.indexOf('--client');
const client = at === -1 ? '' : String(process.argv[at + 1] ?? '');
if (!/^[A-Za-z0-9][\w-]{0,99}$/.test(client)) {
  console.log(JSON.stringify({ error: 'bad client id' }));
  process.exit(2);
}

(async () => {
  const { db } = require(path.join(process.cwd(), 'functions/scripts/lib/firestore-init'));
  const snap = await db.collection('client').doc(client).get();
  if (!snap.exists) {
    console.log(JSON.stringify({ found: false }));
    process.exit(0);
  }
  const d = snap.data() ?? {};
  const until = d._fbMarketplace?.pauseUntil;
  const date = typeof until?.toDate === 'function' ? until.toDate() : until instanceof Date ? until : null;
  console.log(JSON.stringify({ found: true, name: String(d.name ?? ''), enabled: d.enabled ?? null, pauseUntil: date ? date.toISOString() : null }));
  process.exit(0);
})().catch(e => {
  // The code only: a message could quote the key file it failed to parse.
  console.log(JSON.stringify({ error: String(e?.code ?? 'read failed') }));
  process.exit(1);
});
