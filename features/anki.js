// Anki: sends words (from the word popup) and whole lines straight to Anki
// through the AnkiConnect add-on. Cards get sound from Anki's own text-to-speech
// (tags in the card template), never from the video: nothing is recorded or
// captured, and no screenshots are taken.
(() => {
  if (!window.Xiaopin) return;

  const HAN = /\p{Script=Han}/u;
  const DEFAULT_DECK = 'Xiaopin';

  let api = null;
  let deck = DEFAULT_DECK;
  let deckDraft = null;          // what is typed in the deck box, kept across menu redraws
  let conn = { state: 'unknown', text: 'Not checked yet' };
  const done = new Map();        // word / sentence → 'added' | 'dup', for this page
  const startedAt = Date.now();  // auto-add only words starred after the page loaded
  const autoSeen = new Set();

  const MESSAGES = {
    offline: 'Anki is not running (open Anki with AnkiConnect installed)',
    denied: 'Anki did not allow Xiaopin. See the Xiaopin menu → Anki for the fix.',
    apikey: 'AnkiConnect asks for an API key (set "apiKey" to null in its config)',
    nobg: 'The Anki helper is not loaded (reload the extension)',
  };

  // ---------- card fields (html; Anki fields are html) ----------

  const esc = s => api.esc(String(s ?? ''));
  const pyHtml = syllables => syllables.filter(Boolean)
    .map(s => `<span class="t${api.toneOf(s)}">${esc(s)}</span>`).join('');

  // Word pinyin with tone colours: "jiǎn dān" → coloured syllables, one space apart.
  const wordPinyin = py => String(py || '').split(/\s+/).filter(Boolean)
    .map(s => pyHtml([s])).join(' ');

  // Line pinyin per dictionary word (tone-coloured syllables, words spaced), the
  // studied word in bold, punctuation kept.
  function sentencePinyin(text, word = '') {
    text = String(text || '').replace(/\s*\n\s*/g, ' ');
    if (!text || typeof pinyinPro === 'undefined') return '';
    const py = pinyinPro.pinyin(text, { type: 'array' });
    let ci = 0;
    const out = [];
    for (const seg of api.segmentsOf(text)) {
      const chars = [...seg];
      const pys = py.slice(ci, ci + chars.length);
      ci += chars.length;
      if (!HAN.test(seg)) { if (seg.trim()) out.push(esc(seg.trim())); continue; }
      const html = chars.map((c, i) => HAN.test(c) ? pyHtml([pys[i] || '']) : esc(c)).join('');
      out.push(word && seg === word ? `<b class="xp-hl">${html}</b>` : html);
    }
    // Punctuation sticks to the word before it.
    return out.reduce((s, part) => s && !/^<|^[\p{L}\p{N}]/u.test(part) ? s + part : (s ? s + ' ' : '') + part, '');
  }

  function sentenceHtml(text, word = '') {
    const t = esc(String(text || '').replace(/\s*\n\s*/g, ' '));
    if (!word) return t;
    const w = esc(word);
    return t.split(w).join(`<b class="xp-hl">${w}</b>`);
  }

  const englishHtml = text => esc(text).replace(/\n/g, '<br>');

  // Anki tags: "xiaopin" and the video title as one word (no spaces allowed).
  function tagsFor(title) {
    const slug = String(title || '').toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 50);
    return slug ? ['xiaopin', slug] : ['xiaopin'];
  }

  // Page link; on YouTube jump to the moment the line is spoken.
  function pageUrl(t) {
    const href = location.href.split('#')[0];
    if (api.SITE !== 'youtube' || !(t >= 0)) return href;
    try {
      const u = new URL(href);
      u.searchParams.set('t', Math.floor(t) + 's');
      return u.href;
    } catch (e) { return href; }
  }

  const sourceTitle = () => api.st.title || api.videoTitle() || document.title;

  function wordNote({ word, pinyin, meaning, sentence, sentenceEn, source, url }) {
    return {
      kind: 'word',
      tags: tagsFor(source),
      fields: {
        Word: esc(word),
        Pinyin: wordPinyin(pinyin),
        Meaning: meaning,
        Sentence: sentenceHtml(sentence, word),
        SentencePinyin: sentencePinyin(sentence, word),
        SentenceEnglish: englishHtml(sentenceEn),
        Source: esc(source),
        Url: esc(url),
      },
    };
  }

  // From the open popup: the reading as spoken in the line, its dictionary meanings.
  function noteFromPopup(info) {
    const entries = info.entries || [];
    const same = entries.filter(e => e[0] === info.py);
    const list = (same.length ? same : entries).slice(0, 3);
    return wordNote({
      word: info.word,
      pinyin: info.py || entries[0]?.[0] || '',
      meaning: list.map(e => esc(e[1])).join('<br>'),
      sentence: info.line?.zh || '',
      sentenceEn: info.line?.en || '',
      source: sourceTitle(),
      url: pageUrl(api.video ? api.video.currentTime : -1),
    });
  }

  // From a word-list entry (auto-add when a word is starred).
  const noteFromVocab = v => wordNote({
    word: v.word,
    pinyin: v.pinyin,
    meaning: String(v.meaning || '').split(' | ').map(esc).join('<br>'),
    sentence: v.sentence,
    sentenceEn: v.sentenceEn,
    source: v.source,
    url: v.url,
  });

  const noteFromLine = line => ({
    kind: 'sentence',
    tags: tagsFor(sourceTitle()),
    fields: {
      Sentence: sentenceHtml(line.zh),
      SentencePinyin: sentencePinyin(line.zh),
      SentenceEnglish: englishHtml(line.en),
      Source: esc(sourceTitle()),
      Url: esc(pageUrl(line.start)),
    },
  });

  // ---------- talking to the background ----------

  async function ask(msg) {
    let r;
    try { r = await api.send(msg); } catch (e) { r = null; }
    if (!r) return { ok: false, code: 'nobg', error: MESSAGES.nobg };
    if (r.error && !r.code) return { ok: false, code: 'error', error: r.error };
    return r;
  }

  function noteConn(r) {
    if (r.ok) conn = { state: 'ok', text: `Anki connected · deck ${r.deck || deck}` };
    else if (r.code === 'duplicate') conn = { state: 'ok', text: `Anki connected · deck ${deck}` };
    else conn = { state: r.code, text: MESSAGES[r.code] || r.error || 'Anki error' };
    renderPanelSoon();
  }

  async function add(note) {
    const r = await ask({ type: 'anki.add', ...note });
    noteConn(r);
    return r;
  }

  const resultText = r => r.ok ? 'Added ✓' : r.code === 'duplicate' ? 'Already in Anki'
    : MESSAGES[r.code] || r.error || 'Anki error';

  // ---------- small toast for line buttons and auto-add ----------

  let toastTimer = null;
  function toast(text, bad) {
    if (!api.root) return;
    let el = api.root.querySelector('.crpy-anki-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'crpy-anki-toast';
      api.root.appendChild(el);
    }
    el.textContent = text;
    el.classList.toggle('crpy-anki-bad', !!bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, bad ? 5000 : 2200);
  }

  // ---------- menu panel ----------

  // No panel-only redraw in the api; refresh() redraws the menu with the rest.
  function renderPanelSoon() { if (api) api.refresh(); }

  function panelHtml() {
    const denied = conn.state === 'denied'
      ? `<div class="crpy-anki-help">In Anki: <b>Tools → Add-ons → AnkiConnect → Config</b>, add
         <code>"chrome-extension://${esc(chrome.runtime.id)}"</code> to <code>webCorsOriginList</code>,
         save and restart Anki. Or click <b>Check connection</b> and choose <b>Yes</b> in Anki's dialog.</div>`
      : '';
    return `<div class="crpy-sec">Anki</div>
      <div class="crpy-anki-status crpy-anki-${esc(conn.state)}">${esc(conn.text)}</div>${denied}
      <div class="crpy-row crpy-anki-row">
        <label class="crpy-anki-decklabel">Deck <input class="crpy-anki-deck" type="text" maxlength="80"
          spellcheck="false" value="${esc(deckDraft ?? deck)}"></label>
        <button class="crpy-anki-check">Check connection</button>
      </div>`;
  }

  async function checkConnection() {
    conn = { state: 'checking', text: 'Checking… (answer the dialog in Anki if one appears)' };
    renderPanelSoon();
    const r = await ask({ type: 'anki.status' });
    if (r.ok) conn = { state: 'ok', text: `Anki connected · deck ${r.deck}${r.deckExists ? '' : ' (created on the first card)'}` };
    else noteConn(r);
    renderPanelSoon();
  }

  function saveDeck(input) {
    const v = input.value.trim().replace(/"/g, '') || DEFAULT_DECK;
    deckDraft = null;
    input.value = v;
    if (v === deck) return;
    deck = v;
    chrome.storage.sync.set({ ankiDeck: v });
    if (conn.state === 'ok') conn = { state: 'ok', text: `Anki connected · deck ${v}` };
    renderPanelSoon();
  }

  // ---------- popup button ----------

  function popupButton(word) {
    const st = done.get('w:' + word);
    const label = st === 'added' ? 'In Anki ✓' : st === 'dup' ? 'Already in Anki' : '+ Anki';
    return `<div class="crpy-anki">
      <button class="crpy-anki-add" ${st ? 'disabled' : ''} title="Add this word as an Anki card">${label}</button>
      <span class="crpy-anki-msg"></span></div>`;
  }

  async function addFromPopup(btn) {
    const info = api.popup;
    if (!info || btn.disabled) return;
    const msg = btn.parentElement.querySelector('.crpy-anki-msg');
    btn.disabled = true;
    btn.textContent = 'Adding…';
    msg.textContent = '';
    const r = await add(noteFromPopup(info));
    if (r.ok || r.code === 'duplicate') done.set('w:' + info.word, r.ok ? 'added' : 'dup');
    if (!btn.isConnected) return;
    btn.textContent = r.ok ? 'Added ✓' : r.code === 'duplicate' ? 'Already in Anki' : '+ Anki';
    btn.disabled = r.ok || r.code === 'duplicate';
    msg.textContent = r.ok || r.code === 'duplicate' ? '' : resultText(r);
    msg.classList.toggle('crpy-anki-bad', !r.ok && r.code !== 'duplicate');
    api.placePopup();
  }

  // ---------- auto-add starred words ----------

  async function autoAdd() {
    if (!api.view.ankiAutoAdd) return;
    for (const v of Object.values(api.vocab || {})) {
      if (!v || !v.word || !(v.added > startedAt) || autoSeen.has(v.word)) continue;
      autoSeen.add(v.word);
      const r = await add(noteFromVocab(v));
      if (r.ok || r.code === 'duplicate') done.set('w:' + v.word, r.ok ? 'added' : 'dup');
      if (r.ok) toast(`${v.word} added to Anki ✓`);
      else if (r.code !== 'duplicate') toast(resultText(r), true);
    }
  }

  Xiaopin.register({
    id: 'anki',

    settings: [
      { key: 'ankiOn', label: 'Anki buttons', default: true },
      { key: 'ankiAutoAdd', label: 'Add starred words to Anki', default: false },
    ],

    init(a) {
      api = a;
      chrome.storage.sync.get('ankiDeck').then(v => { if (v.ankiDeck) { deck = v.ankiDeck; renderPanelSoon(); } });
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'sync' && ch.ankiDeck) { deck = ch.ankiDeck.newValue || DEFAULT_DECK; renderPanelSoon(); }
      });
      // The deck box: the core only handles data-k switches, so listen here.
      // (Clicks are stopped at the overlay root; change / input / keydown are not.)
      document.addEventListener('input', e => {
        if (e.target.classList?.contains('crpy-anki-deck')) deckDraft = e.target.value;
      });
      document.addEventListener('change', e => {
        if (e.target.classList?.contains('crpy-anki-deck')) saveDeck(e.target);
      });
      document.addEventListener('keydown', e => {
        if (!e.target.classList?.contains('crpy-anki-deck')) return;
        e.stopPropagation();   // keep the site's player shortcuts out of the text box
        if (e.key === 'Enter') e.target.blur();
      }, true);
    },

    onChange() { autoAdd(); },
    onView() { autoAdd(); },

    popup(word) {
      if (!api.view.ankiOn) return '';
      return popupButton(word);
    },

    // A getter, so the line button disappears when "Anki buttons" is off.
    get lineActions() {
      return api && api.view.ankiOn ? [{ id: 'anki-sentence', label: '卡', title: 'Add this sentence to Anki' }] : [];
    },

    async onLineAction(id, line, a, btn) {
      if (id !== 'anki-sentence' || !line.zh) return;
      if (done.has('s:' + line.zh)) { toast('Already in Anki'); return; }
      btn.disabled = true;
      const r = await add(noteFromLine(line));
      btn.disabled = false;
      if (r.ok || r.code === 'duplicate') {
        done.set('s:' + line.zh, r.ok ? 'added' : 'dup');
        btn.textContent = '✓';
        btn.title = r.ok ? 'Added to Anki' : 'Already in Anki';
      }
      toast(r.ok ? 'Sentence added to Anki ✓' : resultText(r), !r.ok && r.code !== 'duplicate');
    },

    onClick(e) {
      const btn = e.target.closest('.crpy-anki-add');
      if (btn) { addFromPopup(btn); return true; }
      if (e.target.closest('.crpy-anki-check')) { checkConnection(); return true; }
      if (e.target.closest('.crpy-anki-deck, .crpy-anki-decklabel')) return true;
      return false;
    },

    // The core redraws the menu as html (e.g. on every status change); if the deck
    // box had focus, put the cursor back into the new one.
    panel() {
      const had = document.activeElement?.classList?.contains('crpy-anki-deck');
      const pos = had ? document.activeElement.selectionStart : 0;
      if (had) {
        setTimeout(() => {
          const el = api.root && api.root.querySelector('.crpy-anki-deck');
          if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} }
        }, 0);
      }
      return panelHtml();
    },
  });
})();
