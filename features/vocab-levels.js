// Vocabulary levels: every Chinese word gets a status (unknown, learning, known,
// ignored), shown as subtle underlines in subtitles and history. Adds the HSK
// level of words and how much of the episode's words you already know.
(() => {
  if (!window.Xiaopin) return;

  const STATUSES = ['unknown', 'learning', 'known', 'ignored'];
  const LABELS = { unknown: 'New', learning: 'Learning', known: 'Known', ignored: 'Ignore' };
  const HAN = /\p{Script=Han}/u;

  let api = null;
  let status = {};          // { word: 'learning' | 'known' | 'ignored' | 'unknown' (override) }
  let hsk = {};             // { word: level 1–6 } (HSK 2.0)
  let hskKnown = 0;         // words at or below this HSK level count as known
  let version = 0;          // bumped whenever anything a status depends on changes
  let lastVocab = null;
  let stats = null, statsKey = '';

  const cleanStatus = obj => {
    const out = {};
    if (obj && typeof obj === 'object') {
      for (const [w, s] of Object.entries(obj)) if (STATUSES.includes(s)) out[w] = s;
    }
    return out;
  };

  // What a word would be without an explicit status of its own.
  function implicitStatus(word) {
    if (api && api.vocab && api.vocab[word]) return 'learning';   // starred words are being learned
    const lv = hsk[word];
    if (lv && lv <= hskKnown) return 'known';
    return 'unknown';
  }
  const statusOf = word => status[word] || implicitStatus(word);

  function wordClass(word) {
    const view = api ? api.view : {};
    const s = statusOf(word);
    let cls = '';
    if (s === 'unknown' && view.vlMarkUnknown !== false) cls = 'crpy-vl-unknown';
    else if (s === 'learning' && view.vlMarkLearning !== false) cls = 'crpy-vl-learning';
    const lv = hsk[word];
    if (lv && view.vlHskBadges) cls += (cls ? ' ' : '') + 'crpy-hsk' + lv;
    return cls;
  }

  // ---------- saving ----------

  async function setWordStatus(word, s) {
    if (!word || !STATUSES.includes(s)) return;
    const all = cleanStatus((await chrome.storage.local.get('wordStatus')).wordStatus);
    // Store only what differs from the implicit status, so "New" on a plain word
    // removes the entry, but "New" on an HSK-known word is kept as an override.
    if (s === implicitStatus(word)) delete all[word]; else all[word] = s;
    status = all;
    version++;
    updateWordEls(word);
    renderPopupSection(word);
    // The storage change listener redraws the rest (history, menu, toolbar).
    await chrome.storage.local.set({ wordStatus: all });
  }

  // The subtitle card is frozen while the popup is open, so patch the classes in place.
  function updateWordEls(word) {
    if (!api || !api.root) return;
    const add = wordClass(word).split(' ').filter(Boolean);
    for (const el of api.root.querySelectorAll('.crpy-w')) {
      if (el.dataset.w !== word) continue;
      for (const c of [...el.classList]) if (/^crpy-(vl-|hsk\d)/.test(c)) el.classList.remove(c);
      el.classList.add(...add);
    }
  }

  // ---------- popup ----------

  function popupHtml(word) {
    const esc = api.esc;
    const cur = statusOf(word);
    const lv = hsk[word];
    const btns = STATUSES.map((s, i) =>
      `<button class="crpy-vl-set crpy-vl-set-${s}${s === cur ? ' crpy-on' : ''}" data-vl-set="${s}" aria-pressed="${s === cur}"` +
      ` title="${esc(LABELS[s])} (key ${i + 1})"><span class="crpy-kbd">${i + 1}</span>${esc(LABELS[s])}</button>`
    ).join('');
    return `<div class="crpy-vl-pop">
      ${lv ? `<span class="crpy-vl-hsk" title="HSK 2.0 level ${lv}">HSK ${lv}</span>` : ''}
      <div class="crpy-vl-btns" role="group" aria-label="Word status">${btns}</div></div>`;
  }

  function renderPopupSection(word) {
    if (!api || !api.root || !api.popup || api.popup.word !== word) return;
    const sec = api.root.querySelector('.crpy-feat-sec[data-f="vocab-levels"]');
    if (sec) sec.innerHTML = popupHtml(word);
  }

  // Keys 1–4 set the status of the popup word. Our own listener (not the `keys`
  // hook) so the digits stay free for the player (e.g. YouTube seeking) when no popup is open.
  function onKey(e) {
    if (!api || !api.popup || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();
    setWordStatus(api.popup.word, STATUSES[i]);
  }

  // ---------- comprehension ----------

  // Share of the episode's Chinese word tokens that are known or ignored.
  function computeStats() {
    if (api.vocab !== lastVocab) { lastVocab = api.vocab; version++; }
    const lines = api.pairedLines().filter(l => l.zh);
    let chars = 0;
    for (const l of lines) chars += l.zh.length;
    const key = `${api.st.mediaId}|${version}|${lines.length}|${chars}`;
    if (key === statsKey) return stats;

    const tok = { known: 0, learning: 0, unknown: 0 };
    const uniq = new Map();
    let complete = true;
    for (const l of lines) {
      const segs = api.segmentsOf(l.zh);
      // A cached dictionary split comes back as the same array; the fallback is new each call.
      if (segs !== api.segmentsOf(l.zh)) complete = false;
      for (const w of segs) {
        if (!HAN.test(w)) continue;
        const s = statusOf(w);
        tok[s === 'ignored' ? 'known' : s]++;
        uniq.set(w, s);
      }
    }
    const words = { known: 0, learning: 0, unknown: 0, ignored: 0 };
    for (const s of uniq.values()) words[s]++;
    const total = tok.known + tok.learning + tok.unknown;
    const res = { total, tok, words, pct: total ? Math.round(tok.known / total * 100) : 0 };
    // Keep recomputing until the dictionary split has arrived for every line.
    statsKey = complete ? key : '';
    stats = res;
    return res;
  }

  const statsTitle = s =>
    `${s.pct}% of the ${s.total} words in this episode are known · unique words: ` +
    `${s.words.known} known, ${s.words.learning} learning, ${s.words.unknown} new` +
    (s.words.ignored ? `, ${s.words.ignored} ignored` : '');

  // ---------- loading ----------

  async function loadHsk() {
    try {
      const r = await fetch(chrome.runtime.getURL('lib/hsk.json'));
      const data = r.ok ? await r.json() : null;
      if (!data || typeof data !== 'object') return;
      const out = {};
      for (const [w, lv] of Object.entries(data)) if (Number.isInteger(lv) && lv >= 1 && lv <= 6) out[w] = lv;
      hsk = out;
      version++;
      api.refresh();
    } catch (e) { console.warn('[xiaopin] vocab-levels: HSK list not available', e); }
  }

  const clampHsk = v => Math.max(0, Math.min(4, Math.round(+v) || 0));

  Xiaopin.register({
    id: 'vocab-levels',

    settings: [
      { key: 'vlMarkUnknown', label: 'Mark unknown words', default: true },
      { key: 'vlMarkLearning', label: 'Mark learning words', default: true },
      { key: 'vlHskBadges', label: 'Show HSK level on words', default: false },
    ],

    init(a) {
      api = a;
      chrome.storage.local.get('wordStatus').then(v => {
        status = cleanStatus(v && v.wordStatus); version++; api.refresh();
      }, () => {});
      // vlHskKnown is a number, so it is not a switch setting; we keep it ourselves.
      chrome.storage.sync.get('vlHskKnown').then(v => {
        hskKnown = clampHsk(v && v.vlHskKnown); version++; api.refresh();
      }, () => {});
      chrome.storage.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch.wordStatus) { status = cleanStatus(ch.wordStatus.newValue); version++; api.refresh(); }
        if (area === 'sync' && ch.vlHskKnown) { hskKnown = clampHsk(ch.vlHskKnown.newValue); version++; api.refresh(); }
      });
      window.addEventListener('keydown', onKey, true);
      loadHsk();
    },

    onChange() { if (api) computeStats(); },

    wordClass,

    popup(word) { return HAN.test(word) ? popupHtml(word) : ''; },

    onClick(e) {
      const set = e.target.closest && e.target.closest('[data-vl-set]');
      if (set) {
        if (api.popup) setWordStatus(api.popup.word, set.dataset.vlSet);
        return true;
      }
      const lv = e.target.closest && e.target.closest('[data-vl-hsk]');
      if (lv) {
        hskKnown = clampHsk(lv.dataset.vlHsk);
        version++;
        api.setView('vlHskKnown', hskKnown);
        api.refresh();
        return true;
      }
      return false;
    },

    panel() {
      const esc = api.esc;
      const s = stats;
      let html = '<div class="crpy-vl-panel"><div class="crpy-vl-row"><span>This episode</span>';
      if (s && s.total) {
        const w = n => (n / s.total * 100).toFixed(1) + '%';
        html += `<b>${s.pct}% known</b></div>
          <div class="crpy-vl-bar" title="${esc(statsTitle(s))}">
            <span class="crpy-vl-bar-known" style="width:${w(s.tok.known)}"></span>
            <span class="crpy-vl-bar-learning" style="width:${w(s.tok.learning)}"></span>
          </div>
          <div class="crpy-vl-counts">${s.words.known} known · ${s.words.learning} learning · ${s.words.unknown} new words</div>`;
      } else {
        html += '<span class="crpy-hint">no Chinese lines yet</span></div>';
      }
      const opts = [[0, 'None'], [1, '1'], [2, '1–2'], [3, '1–3'], [4, '1–4']];
      html += `<div class="crpy-row crpy-vl-hskrow" role="group" aria-label="Treat HSK levels as known">
        <span>Treat HSK as known</span>${opts.map(([v, l]) =>
          `<button data-vl-hsk="${v}" class="${v === hskKnown ? 'crpy-on' : ''}" aria-pressed="${v === hskKnown}">${l}</button>`
        ).join('')}</div>`;
      if (!Object.keys(hsk).length) html += '<div class="crpy-hint">HSK word list not loaded.</div>';
      return html + '</div>';
    },

    toolbar() {
      const s = stats;
      if (!s || !s.total) return '';
      return `<span class="crpy-btn crpy-vl-pill" title="${api.esc(statsTitle(s))}">${s.pct}% known</span>`;
    },
  });
})();
