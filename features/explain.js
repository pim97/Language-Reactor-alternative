// "Explain this line": asks the AI for a translation, word-by-word gloss and grammar
// notes for one Chinese subtitle line, shown in a card over the video.
(() => {
  if (!window.Xiaopin) return;

  let panel = null;      // the card element inside api.root
  let current = null;    // { zh, index } of the line shown
  let resumeOnClose = false;
  let reqId = 0;
  let lastMedia = null;

  const isOpen = () => !!(panel && panel.isConnected && !panel.hidden);

  // Pinyin of the whole line for the card head (pinyin-pro is loaded before content.js).
  function linePinyin(zh) {
    try { return typeof pinyinPro !== 'undefined' ? pinyinPro.pinyin(zh, { nonZh: 'removed' }) : ''; } catch (e) { return ''; }
  }

  function ensurePanel(api) {
    if (panel && panel.isConnected && panel.parentNode === api.root) return panel;
    if (!api.root) return null;
    panel = document.createElement('div');
    panel.className = 'crpy-explain';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Line explanation');
    api.root.appendChild(panel);
    return panel;
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !isOpen()) return;
    e.preventDefault();
    e.stopPropagation();
    close(Xiaopin.api);
  }

  function open(line, api) {
    if (!line || !line.zh || !ensurePanel(api)) return;
    // Same line again: the button works as a toggle.
    if (isOpen() && current && current.zh === line.zh && current.index === line.index) return close(api);

    const v = api.video;
    if (!isOpen()) resumeOnClose = !!(v && !v.paused);
    if (v && !v.paused) v.pause();
    api.holdPause = true;   // closing the word popup must not restart the video

    current = { zh: line.zh, index: line.index };
    lastMedia = api.st.mediaId;
    panel.hidden = false;
    window.addEventListener('keydown', onKey, true);
    draw(api, line, { loading: true });
    ask(api, line);
  }

  function close(api) {
    if (!panel) return;
    reqId++;   // ignore an answer still on its way
    panel.hidden = true;
    panel.innerHTML = '';
    current = null;
    window.removeEventListener('keydown', onKey, true);
    api.holdPause = false;
    const v = api.video;
    if (resumeOnClose && v && v.paused) v.play().catch(() => {});
    resumeOnClose = false;
  }

  async function ask(api, line, force = false) {
    const id = ++reqId;
    const lines = api.pairedLines();
    const i = Number.isInteger(line.index) ? line.index : lines.findIndex(l => l.zh === line.zh);
    let res;
    try {
      res = await api.send({
        type: 'explain.line',
        zh: line.zh,
        en: line.en || '',
        prev: lines[i - 1]?.zh || '',
        next: lines[i + 1]?.zh || '',
        title: api.st.title || '',
        lang: api.view.explainLang || 'en',
        force,
      });
    } catch (e) {
      res = { error: String(e.message || e) };
    }
    if (id !== reqId || !isOpen()) return;
    if (res && res.ok && res.data) draw(api, line, { data: res.data });
    else draw(api, line, { error: (res && res.error) || 'No answer from the extension.', code: res && res.code });
  }

  function draw(api, line, { loading, data, error, code }) {
    const { esc, pySpans } = api;
    const py = linePinyin(line.zh);
    let body;
    if (loading) {
      body = '<div class="crpy-ex-loading"><span class="crpy-ex-spin"></span>Asking the AI…</div>';
    } else if (error) {
      const noKey = code === 'nokey' || /api key/i.test(error);
      body = `<div class="crpy-ex-error">${noKey ? 'Add an API key in settings to use explanations.' : esc(error)}</div>
        <div class="crpy-ex-actions">${noKey
          ? '<button data-ex="options">Open settings</button>'
          : '<button data-ex="retry">Try again</button>'}</div>`;
    } else {
      const words = (data.words || []).map(w => `
        <div class="crpy-ex-word">
          <span class="crpy-ex-wzh">${esc(w.word)}</span>
          <span class="crpy-ex-wpy">${pySpans(w.pinyin || '')}</span>
          <span class="crpy-ex-wen">${esc(w.meaning || '')}</span>
        </div>`).join('');
      const grammar = (data.grammar || []).map(g => `
        <li><span class="crpy-ex-pat">${esc(g.pattern)}</span>
          <span class="crpy-ex-gram-d">${esc(g.explanation)}</span></li>`).join('');
      body = `
        ${data.translation ? `<div class="crpy-ex-tr">${esc(data.translation)}</div>` : ''}
        ${words ? `<div class="crpy-ex-sec">Word by word</div><div class="crpy-ex-words">${words}</div>` : ''}
        ${grammar ? `<div class="crpy-ex-sec">Grammar</div><ul class="crpy-ex-gram">${grammar}</ul>` : ''}
        ${data.note ? `<div class="crpy-ex-sec">Tone</div><div class="crpy-ex-note">${esc(data.note)}</div>` : ''}
        <div class="crpy-ex-actions"><button data-ex="retry" title="Ask the AI again">Ask again</button></div>`;
    }
    panel.innerHTML = `
      <div class="crpy-ex-head">
        <span class="crpy-ex-badge">解</span>
        <div class="crpy-ex-line">
          <div class="crpy-ex-zh">${esc(line.zh)}</div>
          ${py ? `<div class="crpy-ex-py">${pySpans(py)}</div>` : ''}
          ${line.en ? `<div class="crpy-ex-en">${esc(line.en)}</div>` : ''}
        </div>
        <button class="crpy-ex-close" data-ex="close" title="Close (Esc)">✕</button>
      </div>
      <div class="crpy-ex-body">${body}</div>`;
    panel.dataset.line = JSON.stringify({ zh: line.zh, en: line.en || '', index: line.index });
  }

  function lineFromPanel() {
    try { return JSON.parse(panel.dataset.line || 'null'); } catch (e) { return null; }
  }

  Xiaopin.register({
    id: 'explain',

    lineActions: [{ id: 'explain', label: '解', title: 'Explain this line' }],

    onLineAction(actionId, line, api) {
      if (actionId === 'explain') open(line, api);
    },

    onClick(e, api) {
      const b = e.target.closest && e.target.closest('.crpy-explain [data-ex]');
      if (!b) return !!(e.target.closest && e.target.closest('.crpy-explain'));
      const a = b.dataset.ex;
      if (a === 'close') close(api);
      if (a === 'options') api.send({ type: 'openOptions' }).catch(() => {});
      if (a === 'retry') {
        const line = lineFromPanel();
        if (line) { draw(api, line, { loading: true }); ask(api, line, true); }
      }
      return true;
    },

    // A new video: the open card belongs to the old one.
    onChange(api) {
      if (isOpen() && api.st.mediaId !== lastMedia) close(api);
    },

    keys: {
      e: api => {
        if (isOpen()) return close(api);
        const v = api.video;
        if (!v) return;
        const lines = api.pairedLines();
        const i = api.lineIndexAt(lines, v.currentTime);
        if (i >= 0 && lines[i].zh) open({ ...lines[i], index: i }, api);
      },
    },
  });
})();
