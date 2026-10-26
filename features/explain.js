// "Explain this line": asks the AI for a translation, word-by-word gloss and grammar
// notes for one Chinese subtitle line, shown in a card over the video.
// "Ask AI" (问) opens the same card as a chat about the line; the card also takes
// follow-up questions under an explanation.
(() => {
  if (!window.Xiaopin) return;

  let panel = null;      // the card element inside api.root
  let current = null;    // { zh, index } of the line shown
  let resumeOnClose = false;
  let reqId = 0;
  let lastMedia = null;
  let state = null;      // what the card shows: { loading, data, error, code }
  let chat = [];         // [{ role: 'user' | 'assistant', text, pending? }]
  let chatReq = 0;

  const TEXT = {
    en: { ask: 'Ask a question about this line', placeholder: 'e.g. Why is 了 used here?', send: 'Ask', thinking: 'Thinking…', you: 'You', ai: 'AI', explain: 'Explain this line' },
    nl: { ask: 'Stel een vraag over deze zin', placeholder: 'bijv. Waarom staat hier 了?', send: 'Vraag', thinking: 'Even denken…', you: 'Jij', ai: 'AI', explain: 'Leg deze zin uit' },
  };
  const t = api => TEXT[api.view.explainLang] || TEXT.en;

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

  // mode 'explain': fetch the explanation; mode 'ask': open straight on the question box.
  function open(line, api, mode = 'explain') {
    if (!line || !line.zh || !ensurePanel(api)) return;
    const same = isOpen() && current && current.zh === line.zh && current.index === line.index;
    // Same line and same button again: the button works as a toggle.
    if (same && current.mode === mode) return close(api);

    const v = api.video;
    if (!isOpen()) resumeOnClose = !!(v && !v.paused);
    if (v && !v.paused) v.pause();
    api.holdPause = true;   // closing the word popup must not restart the video

    if (!same) chat = [];
    current = { zh: line.zh, index: line.index, mode };
    lastMedia = api.st.mediaId;
    panel.hidden = false;
    window.addEventListener('keydown', onKey, true);
    if (mode === 'explain' && !(same && state && state.data)) {
      draw(api, line, { loading: true });
      ask(api, line);
    } else {
      draw(api, line, same && state ? state : {});
    }
    if (mode === 'ask') focusInput();
  }

  function focusInput() {
    setTimeout(() => panel && panel.querySelector('.crpy-ex-input')?.focus(), 0);
  }

  // Context lines and the explanation so far, for a question about the line.
  function contextFor(api, line) {
    const lines = api.pairedLines();
    const i = Number.isInteger(line.index) ? line.index : lines.findIndex(l => l.zh === line.zh);
    return { prev: lines[i - 1]?.zh || '', next: lines[i + 1]?.zh || '' };
  }

  async function sendQuestion(api) {
    const line = lineFromPanel();
    const input = panel && panel.querySelector('.crpy-ex-input');
    const q = input ? input.value.trim() : '';
    if (!line || !q) return;
    const history = chat.filter(m => !m.pending).slice(-8).map(({ role, text }) => ({ role, text }));
    chat.push({ role: 'user', text: q }, { role: 'assistant', text: '', pending: true });
    input.value = '';
    draw(api, line, state || {});
    focusInput();
    const id = ++chatReq;
    let res;
    try {
      res = await api.send({
        type: 'explain.ask',
        zh: line.zh,
        en: line.en || '',
        ...contextFor(api, line),
        title: api.st.title || '',
        lang: api.view.explainLang || 'en',
        explanation: state && state.data ? state.data : null,
        history,
        question: q,
      });
    } catch (e) {
      res = { error: String(e.message || e) };
    }
    if (id !== chatReq || !isOpen()) return;
    const last = chat[chat.length - 1];
    if (last && last.pending) {
      last.pending = false;
      last.text = res && res.ok ? res.answer
        : (res && res.code === 'nokey' ? 'Add an API key in settings to ask questions.' : (res && res.error) || 'No answer.');
      last.error = !(res && res.ok);
    }
    draw(api, line, state || {});
    focusInput();
  }

  function close(api) {
    if (!panel) return;
    reqId++;   // ignore an answer still on its way
    chatReq++;
    panel.hidden = true;
    panel.innerHTML = '';
    current = null;
    state = null;
    chat = [];
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

  function draw(api, line, s) {
    const { loading, data, error, code } = s;
    state = s;
    const { esc, pySpans } = api;
    const T = t(api);
    const py = linePinyin(line.zh);
    // Keep what the user was typing across redraws.
    const typed = panel.querySelector('.crpy-ex-input')?.value || '';
    let body;
    if (!loading && !data && !error) {
      body = `<div class="crpy-ex-actions"><button data-ex="explain">解 ${esc(T.explain)}</button></div>`;
    } else if (loading) {
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
      <div class="crpy-ex-body">${body}${chatHtml(api)}</div>`;
    panel.dataset.line = JSON.stringify({ zh: line.zh, en: line.en || '', index: line.index });
    const input = panel.querySelector('.crpy-ex-input');
    if (input) {
      input.value = typed;
      // Typing must not reach the video player's own shortcuts.
      for (const ev of ['keydown', 'keyup', 'keypress']) input.addEventListener(ev, e => {
        e.stopPropagation();
        if (ev === 'keydown' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendQuestion(api); }
        if (ev === 'keydown' && e.key === 'Escape') { e.preventDefault(); close(api); }
      });
    }
    const log = panel.querySelector('.crpy-ex-chat');
    if (log) log.scrollTop = log.scrollHeight;
  }

  // Answers sometimes use a little markdown: show **bold** as bold, keep line breaks.
  // Works on already-escaped text, so nothing from the answer becomes markup.
  const richText = html => html
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\n/g, '<br>');

  function chatHtml(api) {
    const { esc } = api;
    const T = t(api);
    const msgs = chat.map(m => `
      <div class="crpy-ex-msg crpy-ex-msg-${m.role}${m.error ? ' crpy-ex-msg-err' : ''}">
        <span class="crpy-ex-who">${m.role === 'user' ? esc(T.you) : esc(T.ai)}</span>
        <div class="crpy-ex-text">${m.pending ? `<span class="crpy-ex-spin"></span>${esc(T.thinking)}` : richText(esc(m.text))}</div>
      </div>`).join('');
    return `
      <div class="crpy-ex-sec">问 ${esc(T.ask)}</div>
      ${msgs ? `<div class="crpy-ex-chat">${msgs}</div>` : ''}
      <div class="crpy-ex-ask">
        <textarea class="crpy-ex-input" rows="1" placeholder="${esc(T.placeholder)}"></textarea>
        <button data-ex="send">${esc(T.send)}</button>
      </div>`;
  }

  function lineFromPanel() {
    try { return JSON.parse(panel.dataset.line || 'null'); } catch (e) { return null; }
  }

  Xiaopin.register({
    id: 'explain',

    lineActions: [
      { id: 'explain', label: '解', title: 'Explain this line' },
      { id: 'ask', label: '问', title: 'Ask AI about this line' },
    ],

    onLineAction(actionId, line, api) {
      if (actionId === 'explain') open(line, api, 'explain');
      if (actionId === 'ask') open(line, api, 'ask');
    },

    onClick(e, api) {
      const b = e.target.closest && e.target.closest('.crpy-explain [data-ex]');
      if (!b) return !!(e.target.closest && e.target.closest('.crpy-explain'));
      const a = b.dataset.ex;
      if (a === 'close') close(api);
      if (a === 'send') sendQuestion(api);
      if (a === 'explain') {
        const line = lineFromPanel();
        if (line) { current.mode = 'explain'; draw(api, line, { loading: true }); ask(api, line); }
      }
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
