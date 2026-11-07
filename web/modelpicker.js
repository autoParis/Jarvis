// The brain's model and effort picker: quiet text under the chat pill and a bottom sheet, like the Claude app.
// The pill shows what jarvisd reports running, never only what was tapped.

const EFFORT_LABEL = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const effortLabel = e => EFFORT_LABEL[e] ?? e;
const modelLabel = (b, id) => b.models?.find(m => m.id === id)?.label ?? id;

/** What the pill and the check mark use: the live process, else the setting the next start will use. */
export const current = b => b.running ?? b.setting;

/** The pill text, for example "Opus 5.5 Medium", or "Switching…" while the brain restarts. */
export function pillText(b) {
  if (!b) return '…';
  if (b.switching) return 'Switching…';
  const c = current(b);
  return `${modelLabel(b, c.model)} ${effortLabel(c.effort)}`;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

/** The sheet's two lists for a status from jarvisd. */
export function sheetHtml(b, effortOpen) {
  const c = current(b);
  const models = b.models.map(m => `<button type="button" class="ms-row" role="radio" aria-checked="${m.id === c.model}" data-model="${esc(m.id)}">
    <span class="ms-txt"><span class="ms-name">${esc(m.label)}</span><span class="ms-note">${esc(m.note)}</span></span>${m.id === c.model ? CHECK : ''}</button>`).join('');
  const efforts = b.efforts.map(e => `<button type="button" class="ms-row ms-eff" role="radio" aria-checked="${e === c.effort}" data-effort="${esc(e)}">
    <span class="ms-name">${esc(effortLabel(e))}</span>${e === 'medium' ? '<span class="ms-tag">Recommended</span>' : ''}${e === c.effort ? CHECK : ''}</button>`).join('');
  return `<div class="ms-list" role="radiogroup" aria-label="Model">${models}</div>
    <div class="ms-list"><button type="button" class="ms-row" id="ms-effort" aria-expanded="${effortOpen}"><span class="ms-name">Effort</span>
      <span class="ms-val">${c.effort === 'medium' ? '<span class="ms-tag">Recommended</span>' : ''}${esc(effortLabel(c.effort))}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${effortOpen ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'}"/></svg></span></button>
      ${effortOpen ? `<div role="radiogroup" aria-label="Effort">${efforts}</div>` : ''}</div>
    <p class="ms-foot">Changes Jarvis only. Workers keep their own model. The conversation carries over.</p>`;
}

/** Wires the pill and the sheet. `post` sends the new setting and returns the fetch Response. */
export function makeModelPicker({ pill, sheet, body, err, closeBtn, post }) {
  let b = null, effortOpen = false, sending = false;
  const paint = () => {
    pill.textContent = pillText(b);
    pill.disabled = !b;
    if (b && !sheet.hidden) body.innerHTML = sheetHtml(b, effortOpen);
    body.classList.toggle('busy', sending || Boolean(b?.switching));
  };
  const open = on => {
    sheet.hidden = !on;
    document.body.classList.toggle('sheet-open', on);
    if (on) { err.hidden = true; effortOpen = false; paint(); sheet.focus(); } else pill.focus();
  };
  const choose = async change => {
    if (!b || sending || b.switching) return;
    const c = current(b);
    const next = { model: c.model, effort: c.effort, ...change };
    if (next.model === c.model && next.effort === c.effort) return;
    sending = true; err.hidden = true; paint();
    try {
      const r = await post(next);
      const data = await r.json().catch(() => ({}));
      if (data.setting) b = data;
      if (!r.ok) { err.textContent = data.error || `Could not switch (${r.status}).`; err.hidden = false; }
    } catch { err.textContent = 'Could not reach Jarvis.'; err.hidden = false; }
    sending = false; paint();
  };
  pill.onclick = () => open(sheet.hidden);
  closeBtn.onclick = () => open(false);
  body.onclick = e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'ms-effort') { effortOpen = !effortOpen; return paint(); }
    if (t.dataset.model) return choose({ model: t.dataset.model });
    if (t.dataset.effort) return choose({ effort: t.dataset.effort });
  };
  return {
    show(next) { if (next) { b = next; paint(); } },
    open,
    get isOpen() { return !sheet.hidden; },
  };
}
