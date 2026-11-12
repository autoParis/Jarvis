// One line per event in data/jarvisd.log: ISO time, message, then the ids that tie it to a run, item or
// approval as JSON, so `grep '"approval":12'` finds everything that happened to one proposal.
// `base` is read at each call, so a caller can add ids to it later.
export type Log = (msg: string, fields?: Record<string, unknown>) => void;

export function makeLog(base: Record<string, unknown> = {}, write: (line: string) => void = l => console.log(l)): Log {
  return (msg, fields) => {
    const f = { ...base, ...fields };
    write(`${new Date().toISOString()} ${msg}${Object.keys(f).length ? ` ${JSON.stringify(f)}` : ''}`);
  };
}
