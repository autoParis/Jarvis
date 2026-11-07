// Markdown for Jarvis's replies: headers, lists, bold and italic, inline code, code blocks, quotes, links.
// Every piece of message text is escaped before it lands in the HTML; only the tags written here are emitted.
// `[image: /path]` markers become thumbnails through the `shot` function the page passes in.
// A `[report: /path.md]` line becomes a card that opens that document at #reports/<path>. The daemon decides what it serves.
// A classic script so the page can call it synchronously; daemon/markdown.test.ts runs it in a vm.
(() => {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const IMAGE_MARKER = /\[image:\s*([^\]\n]+?)\s*\]/g;
  const REPORT_LINE = /^\s*\[report:\s*([^\]\n]+?)\s*\]\s*$/;
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>';
  // The file name until the page fills in the document's own title.
  const docName = p => p.split('/').pop().replace(/\.md$/i, '').replace(/[-_]+/g, ' ');
  const reportCard = p => `<a class="rcard" href="#reports/${esc(encodeURIComponent(p))}" data-report="${esc(p)}">${ICON}<span class="rcard-txt"><span class="rcard-t">${esc(docName(p))}</span><span class="rcard-k">Report · tap to read</span></span></a>`;

  function url(u) {
    const href = esc(u);
    return /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u) ? `<a href="${href}" target="_blank"><img src="${href}" alt=""></a>` : `<a href="${href}" target="_blank" rel="noopener">${href}</a>`;
  }

  // On escaped text, so the only tags here are the ones added.
  const emphasis = s => s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)(.+?)(?<=\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w*])\*(?=[^\s*])(.+?)(?<=[^\s*])\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])(.+?)(?<=[^\s_])_(?!\w)/g, '$1<em>$2</em>');

  // Code, images and links are cut out as placeholders first so emphasis and escaping never touch them.
  function inline(text, shot) {
    const kept = [];
    const keep = html => `\u0000${kept.push(html) - 1}\u0000`;
    const s = text.replace(/\u0000/g, '')
      .replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`))
      .replace(IMAGE_MARKER, (_, p) => keep(shot(p)))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, u) => keep(`<a href="${esc(u)}" target="_blank" rel="noopener">${emphasis(esc(label))}</a>`))
      .replace(/https?:\/\/[^\s)<\u0000]+/g, u => {
        const trail = u.match(/[.,;:!?]*$/)[0];
        return keep(url(u.slice(0, u.length - trail.length))) + trail;
      });
    return emphasis(esc(s)).replace(/\u0000(\d+)\u0000/g, (_, i) => kept[i]);
  }

  function markdown(text, shot) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out = [], lists = []; // open lists, innermost last: { tag, indent }
    let para = [];
    const flush = () => { if (para.length) out.push(`<p>${para.map(l => inline(l, shot)).join('<br>')}</p>`); para = []; };
    const close = (indent = -1) => { while (lists.length && lists.at(-1).indent > indent) out.push(`</li></${lists.pop().tag}>`); };
    const block = () => { flush(); close(); };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = /^\s*(```|~~~)/.exec(line))) {
        block();
        const code = [];
        while (++i < lines.length && !lines[i].trimStart().startsWith(m[1])) code.push(lines[i]);
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if ((m = REPORT_LINE.exec(line))) {
        block();
        out.push(reportCard(m[1]));
      } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        block();
        const level = Math.min(m[1].length + 1, 4);
        out.push(`<h${level}>${inline(m[2], shot)}</h${level}>`);
      } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        block();
        out.push('<hr>');
      } else if (/^\s*>/.test(line)) {
        block();
        const quote = [];
        for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i--;
        out.push(`<blockquote>${quote.map(l => inline(l, shot)).join('<br>')}</blockquote>`);
      } else if ((m = /^(\s*)([-*+]|(\d{1,9})[.)])\s+(.*)$/.exec(line))) {
        flush();
        const indent = m[1].length, tag = m[3] === undefined ? 'ul' : 'ol';
        close(indent);
        const top = lists.at(-1);
        if (top && top.indent === indent && top.tag !== tag) close(indent - 1);
        if (lists.at(-1)?.indent === indent) out.push('</li><li>');
        else {
          out.push(`<${tag}${tag === 'ol' && m[3] !== '1' ? ` start="${Number(m[3])}"` : ''}><li>`);
          lists.push({ tag, indent });
        }
        out.push(inline(m[4], shot));
      } else if (!line.trim()) {
        flush();
      } else if (lists.length && /^\s+\S/.test(line)) {
        out.push('<br>' + inline(line.trim(), shot)); // a wrapped line of the current item
      } else {
        close();
        para.push(line);
      }
    }
    block();
    return out.join('');
  }

  globalThis.markdown = markdown;
})();
