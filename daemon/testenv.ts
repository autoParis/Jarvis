// Loaded before every test file (`npm test` passes it with --import). A shell started by jarvisd carries the
// owner's .env values, and the tests expect the neutral defaults of daemon/config.ts, so drop those settings first.
for (const k of Object.keys(process.env)) if (k.startsWith('JARVIS_')) delete process.env[k];
