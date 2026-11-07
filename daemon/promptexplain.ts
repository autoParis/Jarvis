// Says in plain words what a command at a credential prompt does to each credential file: which file, whether it reads or
// changes it, and whether the value is printed. Pure code on the command's text, so a prompt costs no model tokens.
// The rule throughout: a command this does not recognize is "cannot tell", never "only reads".

export type CredentialExplanation = {
  /** The decision, one sentence. */
  question: string;
  /** Markdown bullets: one per credential file, then what else the command does. */
  facts: string[];
};

type Simple = { words: string[]; reds: { op: string; to: string }[]; heredoc?: boolean };
type Pipeline = { stages: Simple[]; inside?: Simple };
type Parsed = { pipelines: Pipeline[]; heredocs: string[]; ok: boolean };

/** A shell command as pipelines of simple commands. Good enough to read, not to run: `ok` is false when quotes do not close. */
function parseShell(src: string, out: Parsed = { pipelines: [], heredocs: [], ok: true }, inside?: Simple): Parsed {
  const fresh = (): Simple => ({ words: [], reds: [] });
  let stage = fresh(), stages = [stage], word: string | null = null, red = '';
  let delimiters: string[] = [];
  const endWord = () => {
    if (word === null) return;
    if (red) { stage.reds.push({ op: red, to: word }); red = ''; } else stage.words.push(word);
    word = null;
  };
  const endPipeline = () => {
    endWord();
    const used = stages.filter(s => s.words.length || s.reds.length);
    if (used.length) out.pipelines.push({ stages: used, ...(inside ? { inside } : {}) });
    stage = fresh(); stages = [stage];
  };
  /** Parses `$(...)` or a backtick body, and returns the index after it. */
  const substitution = (from: number, close: ')' | '`'): number => {
    let depth = 1, n = from;
    for (; n < src.length; n++) {
      const c = src[n];
      if (c === '\\') { n++; continue; }
      if (close === '`') { if (c === '`') { depth = 0; break; } continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (depth) { out.ok = false; return src.length; }
    parseShell(src.slice(from, n), out, stage);
    word = `${word ?? ''}$()`;
    return n + 1;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i], next = src[i + 1];
    if (c === '\\') { if (next !== '\n') word = (word ?? '') + (next ?? ''); i += 2; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) { out.ok = false; break; }
      word = (word ?? '') + src.slice(i + 1, end);
      i = end + 1; continue;
    }
    if (c === '"') {
      word = word ?? '';
      let n = i + 1, closed = false;
      while (n < src.length) {
        if (src[n] === '\\') { word += src[n + 1] ?? ''; n += 2; continue; }
        if (src[n] === '"') { closed = true; break; }
        if (src[n] === '$' && src[n + 1] === '(') { n = substitution(n + 2, ')'); continue; }
        if (src[n] === '`') { n = substitution(n + 1, '`'); continue; }
        word += src[n++];
      }
      if (!closed) { out.ok = false; break; }
      i = n + 1; continue;
    }
    if (c === '$' && next === '(') { i = substitution(i + 2, ')'); continue; }
    if (c === '`') { i = substitution(i + 1, '`'); continue; }
    if (c === '#' && word === null) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === ' ' || c === '\t') { endWord(); i++; continue; }
    if (c === '\n') {
      endPipeline(); i++;
      for (const d of delimiters) {
        const end = new RegExp(`^[ \\t]*${d.replace(/[.-]/g, '\\$&')}[ \\t]*$`, 'm').exec(src.slice(i));
        out.heredocs.push(end ? src.slice(i, i + end.index) : src.slice(i));
        i = end ? i + end.index + end[0].length : src.length;
      }
      delimiters = [];
      continue;
    }
    if (c === ';' || c === '(' || c === ')' || ((c === '{' || c === '}') && word === null)) { endPipeline(); i++; continue; }
    if (c === '&' && next === '&' || c === '|' && next === '|') { endPipeline(); i += 2; continue; }
    if (c === '|') { endWord(); stage = fresh(); stages.push(stage); i += next === '&' ? 2 : 1; continue; }
    if (c === '<' && next === '<') {
      const h = /^<<-?[ \t]*(['"]?)([\w.-]+)\1/.exec(src.slice(i));
      if (h && src[i + 2] !== '<') { endWord(); delimiters.push(h[2]); stage.heredoc = true; i += h[0].length; continue; }
      endWord(); i += src[i + 2] === '<' ? 3 : 2; red = '<'; continue;
    }
    if (c === '>' || c === '<' || (c === '&' && next === '>')) {
      if (word !== null && /^\d+$/.test(word)) word = null; // the 2 of 2>
      endWord();
      if (c === '&') i++;
      const append = src[i + 1] === '>';
      const op = append ? '>>' : src[i];
      i += append ? 2 : 1;
      if (src[i] === '&') { i++; while (/[\d-]/.test(src[i] ?? '')) i++; continue; } // 2>&1 moves output, it writes no file
      red = op; continue;
    }
    if (c === '&') { endPipeline(); i++; continue; }
    word = (word ?? '') + c; i++;
  }
  endPipeline();
  if (delimiters.length) out.heredocs.push('');
  return out;
}

const PATHISH = String.raw`[^\s'"=:@,()]*`;
const CREDENTIALS: { find: RegExp; kind: string }[] = [
  { find: new RegExp(`${PATHISH}service-?account${PATHISH}\\.json`, 'gi'), kind: 'Firebase service account' },
  { find: new RegExp(`${PATHISH}tailscale${PATHISH}`, 'gi'), kind: 'Tailscale key' },
  { find: new RegExp(`${PATHISH}(?:fb|facebook|marketplace)${PATHISH}pass${PATHISH}`, 'gi'), kind: 'Facebook passwords' },
  { find: new RegExp(`${PATHISH}pass(?:word|wd)s?\\.\\w+`, 'gi'), kind: 'passwords' },
  { find: /(?<![\w.-])(?:[^\s'"=:@,()]*\/)?\.env(?:\.[\w-]+)?(?![\w-])/g, kind: 'environment secrets' },
  { find: new RegExp(`${PATHISH}(?:\\.pem|\\.p12|id_rsa|id_ed25519|credentials\\.json)(?![\\w-])`, 'gi'), kind: 'private key or credentials' },
];
/** Sample env files hold no secrets. */
const NOT_SECRET = /\.env\.(example|sample|template|dist)$/i;
/** Text a terminal may have split across lines, which the patterns above would miss. */
const NEEDLES = ['service-account', 'serviceaccount', 'tailscale'];

type Found = { file: string; kind: string };
function credentialsIn(text: string): Found[] {
  const found = new Map<string, Found>();
  for (const { find, kind } of CREDENTIALS) for (const m of text.matchAll(find)) {
    if (!NOT_SECRET.test(m[0]) && !found.has(m[0])) found.set(m[0], { file: m[0], kind });
  }
  return [...found.values()];
}

/** Worst first: the card's sentence comes from the worst thing done to any file. */
const ACTIONS = ['change', 'send', 'copy', 'unknown', 'print', 'load', 'capture', 'names', 'hidden', 'details'] as const;
type Action = typeof ACTIONS[number];
type Use = Found & { action: Action; tool: string; to?: string; variable?: string; script?: boolean };

const DETAILS = new Set(['ls', 'stat', 'file', 'du', 'test', '[', '[[', 'realpath', 'readlink', 'basename', 'dirname', 'find']);
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'grep', 'egrep', 'fgrep', 'rg', 'awk', 'sed', 'jq', 'yq', 'cut', 'sort', 'uniq', 'strings', 'xxd', 'od', 'base64', 'tr', 'nl', 'diff', 'cmp']);
const COUNTERS = new Set(['wc', 'sha256sum', 'sha1sum', 'shasum', 'md5', 'md5sum']);
const CHANGERS = new Set(['rm', 'mv', 'touch', 'chmod', 'chown', 'truncate', 'dd', 'shred', 'unlink']);
const SENDERS = new Set(['curl', 'wget', 'scp', 'rsync', 'nc', 'ncat', 'ssh', 'sftp', 'ftp', 'gh', 'aws', 'gcloud', 'gsutil', 'firebase']);
const LOADERS = new Set(['source', '.']);
const HARMLESS = new Set(['cd', 'echo', 'printf', 'pwd', 'true', 'false', 'sleep', 'date', 'which', 'type', 'export', 'set', 'unset', 'local', 'fi', 'done', 'esac', 'exit', 'return', 'mkdir', ':']);
const READ_ONLY_GIT = new Set(['rev-parse', 'status', 'log', 'diff', 'show', 'branch', 'fetch', 'remote', 'ls-files', 'grep', 'blame']);
const WRAPPERS = new Set(['sudo', 'command', 'time', 'nice', 'nohup', 'env']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const WORD_MAX = 80;

/** The real command in a stage's words: past `A=b` settings, `sudo`, `timeout 500` and `then`. */
function peel(words: string[]): { name: string; args: string[]; settings: string[] } {
  const rest = [...words], settings: string[] = [];
  for (;;) {
    const w = rest[0];
    if (w === undefined) return { name: '', args: [], settings };
    if (ASSIGNMENT.test(w)) { settings.push(rest.shift()!); continue; }
    if (KEYWORDS.has(w) || WRAPPERS.has(w)) { rest.shift(); continue; }
    if (w === 'timeout') { rest.shift(); while (rest[0]?.startsWith('-')) rest.shift(); rest.shift(); continue; }
    return { name: w.split('/').pop() || w, args: rest.slice(1), settings };
  }
}

/** Flags of a tool like `grep -nc` or `grep --count`. */
const hasFlag = (args: string[], short: string, long: string) =>
  args.some(a => a === long || (/^-[A-Za-z]+$/.test(a) && a.slice(1).includes(short)));

/** What a reader's own arguments let through, with no pipe after it. */
function ownOutput(name: string, args: string[]): Action {
  if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg') {
    if (hasFlag(args, 'c', '--count') || hasFlag(args, 'q', '--quiet') || hasFlag(args, 'l', '--files-with-matches')) return 'hidden';
  }
  if (name === 'cut' && args.some(a => a === '-d=' || a === '-d' && args[args.indexOf(a) + 1] === '=') && args.some(a => a === '-f1' || a === '-f' && args[args.indexOf(a) + 1] === '1')) return 'names';
  if (name === 'sed' && args.some(a => /^s(.)=\.\*\1\1g?$/.test(a))) return 'names';
  if (name === 'awk' && args.some(a => a === '-F=') && args.some(a => /^\{\s*print \$1\s*\}$/.test(a))) return 'names';
  return 'print';
}

/** What running this reader would do to a file. Anything that can write or run from inside a script is "cannot tell". */
function readerAction(name: string, args: string[]): Action {
  if (name === 'sed' && args.some(a => /^-i/.test(a) || a === '--in-place')) return 'change';
  if (name === 'sed' && args.some(a => /(^|;)\s*\d*\s*[we]\s/.test(a) || /\/[gip]*[we]\b/.test(a))) return 'unknown';
  if (name === 'awk' && args.some(a => /system\(|getline|>|\|/.test(a) || a === '-i')) return 'unknown';
  return ownOutput(name, args);
}

/** What the pipeline after a reader does with its output. */
function downstream(after: Simple[], from: Action, into: { to?: string; tool?: string }): Action {
  let now = from;
  for (const s of after) {
    const { name, args } = peel(s.words);
    if (SENDERS.has(name)) { into.tool = name; return 'send'; }
    if (name === 'tee') { into.to = args.find(a => !a.startsWith('-')); return 'copy'; }
    if (COUNTERS.has(name)) now = 'hidden';
    else if (READERS.has(name)) {
      const a = readerAction(name, args);
      if (a === 'unknown' || a === 'change') return 'unknown';
      if (a !== 'print') now = a;
    } else if (name) return 'unknown';
  }
  const last = after.at(-1);
  return last ? redirected(last, now, into) : now;
}

function redirected(s: Simple, action: Action, into: { to?: string }): Action {
  const out = s.reds.filter(r => r.op !== '<').at(-1);
  if (!out) return action;
  if (out.to === '/dev/null') return 'hidden';
  into.to = out.to;
  return 'copy';
}

/** A file named in a chain that also passes through `xargs` or a shell is not read the way its first command says. */
function classify(p: Pipeline, index: number, all: Simple[], parsed: Parsed): { action: Action; tool: string; to?: string; variable?: string } {
  const { name, args } = peel(all[index].words);
  const after = all.slice(index + 1);
  const into: { to?: string; tool?: string } = {};
  const tool = name;
  if (CHANGERS.has(name)) return { action: 'change', tool };
  if (LOADERS.has(name)) return { action: 'load', tool };
  if (SENDERS.has(name)) return { action: 'send', tool };
  if (name === 'cp') return { action: 'copy', tool, ...(args.filter(a => !a.startsWith('-')).at(-1) ? { to: args.filter(a => !a.startsWith('-')).at(-1) } : {}) };
  if (name === 'find') {
    if (args.some(a => /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/.test(a))) return { action: 'unknown', tool };
    return { action: after.length ? downstreamDetails(after) : 'details', tool };
  }
  let action: Action;
  if (DETAILS.has(name)) action = after.length ? downstreamDetails(after) : 'details';
  else if (COUNTERS.has(name)) action = downstream(after, 'hidden', into);
  else if (READERS.has(name)) {
    const own = readerAction(name, args);
    action = own === 'change' || own === 'unknown' ? own : after.length ? downstream(after, own, into) : redirected(all[index], own, into);
  } else return { action: 'unknown', tool };
  // Output captured by $(...): the variable holds the value, if nothing prints the variable later.
  if (p.inside && (action === 'print' || action === 'names')) {
    const outer = peel(p.inside.words);
    const bare = !outer.name || LOCAL.has(outer.name);
    if (!bare) return { action: SENDERS.has(outer.name) ? 'send' : outer.name === 'echo' || outer.name === 'printf' ? 'print' : 'unknown', tool: outer.name };
    const variable = (outer.settings.at(-1) ?? outer.args.find(a => ASSIGNMENT.test(a)) ?? '').split('=')[0];
    if (variable && printsVariable(parsed, variable)) return { action: 'print', tool, variable };
    return { action: 'capture', tool, ...(variable ? { variable } : {}) };
  }
  return { action, tool, ...(into.to ? { to: into.to } : {}), ...(into.tool ? { tool: into.tool } : {}) };
}
const LOCAL = new Set(['export', 'local', 'readonly', 'declare']);

/** Output of `ls` or `stat` carries no values, so only a command that acts on the names changes the verdict. */
function downstreamDetails(after: Simple[]): Action {
  for (const s of after) {
    const { name } = peel(s.words);
    if (name && !READERS.has(name) && !COUNTERS.has(name)) return 'unknown';
  }
  return 'details';
}

function printsVariable(parsed: Parsed, variable: string): boolean {
  const ref = new RegExp(`\\$\\{?${variable}\\b`);
  return parsed.pipelines.some(p => p.stages.some(s => {
    const { name, args } = peel(s.words);
    return (name === 'echo' || name === 'printf') && args.some(a => ref.test(a)) && !s.reds.some(r => r.op !== '<' && r.to !== '/dev/null');
  }));
}

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;
const clip = (s: string) => s.length > WORD_MAX ? `${s.slice(0, WORD_MAX - 1)}…` : s;
const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;

/** The decision for the worst thing the command does, as words that follow "Let it". */
function decision(action: Action, uses: Use[]): string {
  const files = list(uses.map(u => code(u.file)));
  const one = uses[0];
  switch (action) {
    case 'change': return `change ${files}`;
    case 'send': return `hand ${files} to ${code(one.tool)}`;
    case 'copy': return one.to ? `copy ${files} to ${code(one.to)}` : `copy ${files}`;
    case 'unknown': return `use ${files}, in a way Jarvis cannot read`;
    case 'print': return `print the values in ${files} into its terminal`;
    case 'load': return `load the values in ${files} into its shell, without printing them`;
    case 'capture': return `read ${files} into a variable, without printing the value`;
    case 'names': return `read the setting names in ${files}, without the values`;
    case 'hidden': return `read ${files}, printing only a count or a yes or no`;
    case 'details': return `look at the details of ${files}, without opening ${uses.length > 1 ? 'them' : 'it'}`;
  }
}

const detailsFact = (us: Use[]) =>
  `${list(us.map(u => `${code(u.file)} (${u.kind})`))}: only looks at details such as size, date and owner. It opens no file, so no value is read or printed.`;

function factFor(u: Use): string {
  const what = `${code(u.file)} (${u.kind})`;
  if (u.script) return `${what}: a script in this command names it. Jarvis does not read scripts, so it cannot tell whether the file is read or changed.`;
  switch (u.action) {
    case 'change': return `${what}: changes the file, using ${code(u.tool)}.`;
    case 'send': return `${what}: hands it to ${code(u.tool)}, which can send it over the network.`;
    case 'copy': return `${what}: copies the value${u.to ? ` to ${code(u.to)}` : ''}. The copy stays there after the command ends.`;
    case 'unknown': return `${what}: used by ${code(u.tool)}. Jarvis cannot tell whether that reads or changes it, so check the command below.`;
    case 'print': return `${what}: reads it and prints the value, so the value lands in the worker's terminal and log.`;
    case 'load': return `${what}: loads its values into the shell. It changes nothing and prints no value.`;
    case 'capture': return `${what}: reads it into ${u.variable ? `the variable ${code(u.variable)}` : 'a variable'}. It changes nothing and prints no value.`;
    case 'names': return `${what}: reads it and prints only the setting names. It changes nothing and prints no value.`;
    case 'hidden': return `${what}: reads it and prints only a count, a hash or a yes or no. It changes nothing and prints no value.`;
    case 'details': return detailsFact([u]);
  }
}

const worst = (a: Action, b: Action): Action => ACTIONS.indexOf(a) <= ACTIONS.indexOf(b) ? a : b;

/**
 * Reads a command at a credential prompt. `clipped` means only its end reached Jarvis: the end of a heredoc is not read as
 * commands, and the card says the start is missing.
 */
export function explainCredentialCommand(command: string, clipped: boolean): CredentialExplanation {
  let readable = command, unseen = '';
  if (clipped) {
    const ls = command.split('\n');
    // A lone "EOF" closes a heredoc whose start is gone, so everything above it is script text, not commands.
    const cut = ls.findIndex(l => /^[A-Z_][A-Z0-9_]*$/.test(l.trim())) + 1;
    unseen = ls.slice(0, cut).join('\n');
    readable = ls.slice(cut).join('\n');
  }
  const parsed = parseShell(readable);
  const uses = new Map<string, Use>();
  const add = (found: Found, u: Omit<Use, keyof Found>) => {
    const had = uses.get(found.file);
    if (!had || worst(u.action, had.action) !== had.action) uses.set(found.file, { ...found, ...u });
  };
  const opaque: string[] = [], writes: string[] = [];

  for (const p of parsed.ok ? parsed.pipelines : []) {
    p.stages.forEach((s, n) => {
      const { name, args, settings } = peel(s.words);
      const reads = s.reds.filter(r => r.op === '<').map(r => r.to);
      const found = [...args, ...reads, ...settings].flatMap(credentialsIn);
      if (found.length) {
        const c = classify(p, n, p.stages, parsed);
        for (const f of found) {
          // cp's destination and mv's name are changed, whatever the source was.
          const target = name === 'cp' && args.filter(a => !a.startsWith('-')).at(-1) === f.file;
          add(f, target ? { action: 'change', tool: name } : c);
        }
      }
      for (const r of s.reds.filter(r => r.op !== '<')) {
        if (r.to === '/dev/null') continue;
        const hit = credentialsIn(r.to);
        if (hit.length) hit.forEach(f => add(f, { action: 'change', tool: `${r.op} ${f.file}` }));
        else if (!writes.includes(r.to)) writes.push(r.to);
      }
      if (!found.length && CHANGERS.has(name)) writes.push(...args.filter(a => !a.startsWith('-')));
      const quiet = !name || DETAILS.has(name) || READERS.has(name) || COUNTERS.has(name) || HARMLESS.has(name) || LOCAL.has(name) || CHANGERS.has(name)
        || (name === 'git' && READ_ONLY_GIT.has(args[0] ?? ''));
      if (!quiet && !found.length) {
        const shown = clip([name, ...args].join(' '));
        if (!opaque.includes(shown)) opaque.push(shown);
      }
    });
  }

  // Scripts, what the cut left over, and a command that would not parse: its files are named, not understood.
  const leftovers = [unseen, ...parsed.heredocs, parsed.ok ? '' : readable].join('\n');
  for (const f of credentialsIn(leftovers)) add(f, { action: 'unknown', tool: 'a script', script: true });
  if (!uses.size) {
    const flat = command.replace(/\s+/g, '').toLowerCase();
    for (const n of NEEDLES) if (flat.includes(n)) uses.set(n, { file: n, kind: 'credential name', action: 'unknown', tool: 'this command', script: true });
  }

  const all = [...uses.values()];
  const top = all.map(u => u.action).reduce(worst, 'details' as Action);
  const worstUses = all.filter(u => u.action === top);
  const whole = !clipped && parsed.ok && !opaque.length && !parsed.heredocs.length;
  const question = !all.length
    ? `Let it run a command the credential check stopped? The part Jarvis can read names no credential file.`
    : whole ? `Let it ${decision(top, worstUses)}?`
    : `Let it run this? In the part Jarvis can read, it would ${decision(top, worstUses)}.`;

  // Files that only get looked at share one line, since the sentence would repeat.
  const looked = all.filter(u => u.action === 'details' && !u.script);
  const facts = [...all.filter(u => !looked.includes(u)).map(factFor), ...(looked.length ? [detailsFact(looked)] : [])];
  if (writes.length) facts.push(`Also writes ${list([...new Set(writes)].map(w => code(clip(w))))}, which ${writes.length > 1 ? 'are' : 'is'} not a credential file.`);
  if (opaque.length) facts.push(`Also runs ${list(opaque.map(code))}. Jarvis cannot see what ${opaque.length > 1 ? 'those do' : 'that does'} to a credential file.`);
  if (parsed.heredocs.length) facts.push('It also writes a script from inside the command. Read it below before you say yes.');
  if (!parsed.ok) facts.push('Jarvis could not read this command as a shell command. Read it below before you say yes.');
  if (clipped) facts.push('Only the end of this command reached Jarvis. The start is cut off and may do more.');
  return { question, facts };
}
