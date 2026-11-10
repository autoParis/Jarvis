// A worker's question or escalation for the Requests popup (the data comes from daemon/asks.ts): the tag and age, the body
// as markdown with its question set large, and the options as buttons, recommended first. A card with `parts` reads under
// fixed headings instead, with its context behind a More toggle. Every piece of text is escaped
// or goes through markdown(), which escapes it too. A classic script so the page can call it synchronously;
// daemon/asks.test.ts runs it in a vm.
(() => {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const age = iso => { const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000); return m < 1 ? 'now' : m < 60 ? `${Math.round(m)} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`; };

  /** `md` is markdown(text) from markdown.js. `error` is a failed tap's message, shown under the buttons. */
  function askCardHtml(card, md, error) {
    const answered = card.status === 'answered', sending = card.status === 'sending';
    const chosen = answered ? card.options.findIndex(o => o.value === card.answer) : -1;
    const line = (label, text) => text ? `<div class="ask-line"><span>${label}</span>${esc(text)}</div>` : '';
    // Default buttons are Jarvis's. Nobody recommended their first option.
    const rec = i => i === 0 && !card.suggested;
    const opts = card.options.map((o, i) => {
      const cls = ['ask-opt', rec(i) && 'rec', i === chosen && 'chosen'].filter(Boolean).join(' ');
      const tag = i === chosen ? '<span class="tag">Chosen</span>' : rec(i) ? '<span class="tag">Recommended</span>' : '';
      return `<button type="button" class="${cls}" data-i="${i}"${answered || sending ? ' disabled' : ''}>`
        + `<span class="n">${i + 1}</span><span class="l">${esc(o.label)}${o.detail ? `<span class="d">${esc(o.detail)}</span>` : ''}</span>${tag}</button>`;
    }).join('');
    let outcome = '';
    if (sending) outcome = '<div class="ask-outcome">Sending…</div>';
    else if (answered && chosen < 0) outcome = `<div class="ask-outcome"><span class="pill done">answered</span>${card.answer ? esc(card.answer) : ''}</div>`;
    else if (answered) outcome = '<div class="ask-outcome"><span class="pill done">sent</span></div>';
    if (error) outcome += `<div class="ask-outcome"><span class="pill failed">not sent</span>${esc(error)}</div>`;
    const tag = `<div class="ask-tag"><div class="ask-title">${esc(card.title)}</div>${card.at ? `<span class="ago">${age(card.at)}</span>` : ''}</div>`;
    const lines = card.kind === 'escalation' ? line('Refused', card.refused) + line('Failed', card.failed) + line('Proposes', card.proposes) : '';
    // An ask in the fields shape reads in a fixed order under short headings. The long part waits behind More.
    if (card.parts && card.question) {
      const p = card.parts, head = text => `<h3 class="card-h">${text}</h3>`;
      return tag + lines
        + (p.image ? `<div class="ask-body md">${md(p.image)}</div>` : '')
        + (p.doing ? head('What the worker is doing') + `<div class="ask-body md">${md(p.doing)}</div>` : '')
        + head('The question') + md(card.question).replace(/^<p>/, '<p class="ask-q" role="heading" aria-level="2">')
        + (opts ? head('Options') + `<div class="ask-options">${opts}</div>` : '')
        + (p.more ? `<details class="card-more"><summary>More</summary><div class="ask-body md">${md(p.more)}</div></details>` : '')
        + outcome;
    }
    // The question stays in the body's own order, so what the worker was doing reads above it and the context below it.
    let body = card.body ? md(card.body) : '';
    if (card.question) {
      const q = md(card.question);
      body = body.replace(q, () => q.replace(/^<p>/, '<p class="ask-q" role="heading" aria-level="2">'));
    }
    return tag + lines
      + (body ? `<div class="ask-body md">${body}</div>` : '')
      + (opts ? `<div class="ask-options">${opts}</div>` : '')
      + outcome;
  }
  globalThis.askCardHtml = askCardHtml;
})();
