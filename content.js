// Content script: collects Chinese and English subtitle tracks for the current
// video (Crunchyroll or YouTube) and draws the pinyin / 汉字 / English overlay,
// word lookup, line history and vocabulary saving on top of the player.
(() => {
  const SITE = location.hostname.includes('youtube.com') ? 'youtube' : 'crunchyroll';

  const VIEW_DEFAULTS = {
    showPinyin: true, showHanzi: true, showEnglish: true, fontSize: 30,
    hideNative: true, pauseOnHover: true, showHistory: false, toneColors: true,
  };
  let view = { ...VIEW_DEFAULTS };

  const st = {
    mediaId: null,
    title: '',
    en: [],
    zh: [],
    enSource: null,       // 'crunchyroll' | 'youtube' | 'ai'
    zhSource: null,       // 'crunchyroll' | 'youtube' | 'file' | 'ai'
    offset: 0,            // seconds added to Chinese-track timing (own files)
    burnedIn: '',         // subtitle locale burned into the video stream, if any
    status: 'Waiting for video…',
    port: null,
  };

  let vocab = {};
  chrome.storage.local.get('vocab').then(v => { vocab = v.vocab || {}; refreshAll(); });

  chrome.storage.sync.get(Object.keys(VIEW_DEFAULTS)).then(v => { view = { ...view, ...v }; applyView(); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync') {
      for (const k of Object.keys(VIEW_DEFAULTS)) if (ch[k]) view[k] = ch[k].newValue;
      applyView();
    }
    if (area === 'local' && ch.vocab) { vocab = ch.vocab.newValue || {}; refreshAll(); }
  });

  window.addEventListener('message', e => {
    if (e.source !== window || !e.data || e.data.source !== 'crpy-inject') return;
    const d = e.data;
    if (d.type === 'play') { lastSubs = d.subtitles; onCrunchyrollPlay(d); }
    if (d.type === 'stream') {
      st.burnedIn = d.burnedIn;
      if (root) root.classList.toggle('crpy-burned', burnedEnglish());
      refreshAll();
    }
    if (d.type === 'timedtext') onYoutubeTrack(d);
    if (d.type === 'yt-captions') onYoutubeCaptionState(d);
  });

  // The player sometimes streams a version with English already in the picture
  // (Crunchyroll has no "Off" for some audio tracks). Then we skip our own English.
  const burnedEnglish = () => /^en/i.test(st.burnedIn || '');

  function fetchText(url) {
    return chrome.runtime.sendMessage({ type: 'fetchText', url }).then(r => {
      if (!r || !r.ok) throw new Error(r ? r.error : 'no response');
      return r.text;
    });
  }

  function setStatus(s) { st.status = s; renderPanel(); }

  function reset(mediaId) {
    if (st.port) { st.port.disconnect(); st.port = null; }
    Object.assign(st, { mediaId, en: [], zh: [], enSource: null, zhSource: null, offset: 0, burnedIn: '' });
    st.title = videoTitle();
    if (root) root.classList.remove('crpy-burned');
    historyCount = -1;
    refreshAll();
  }

  function videoTitle() {
    return document.title.replace(/ - Watch on Crunchyroll$/, '').replace(/ - YouTube$/, '').replace(/^\(\d+\)\s*/, '');
  }

  // ---------- Crunchyroll ----------

  let lastSubs = {};

  async function onCrunchyrollPlay({ mediaId, subtitles }) {
    reset(mediaId);
    setStatus('Loading subtitles…');

    const enTrack = subtitles['en-US'] || Object.entries(subtitles).find(([k]) => k.startsWith('en'))?.[1];
    const zhTrack = subtitles['zh-CN'] || Object.entries(subtitles).find(([k]) => k.startsWith('zh'))?.[1];

    try {
      if (enTrack) { st.en = CrpySubs.parse(await fetchText(enTrack.url), '.ass'); st.enSource = 'crunchyroll'; }
    } catch (e) { console.warn('[crpy] English subtitles failed', e); }
    if (st.mediaId !== mediaId) return;

    // 1. Chinese subtitles from Crunchyroll itself
    if (zhTrack) {
      try {
        st.zh = CrpySubs.parse(await fetchText(zhTrack.url), '.ass');
        st.zhSource = 'crunchyroll';
        refreshAll();
        return setStatus(`Chinese from Crunchyroll (${st.zh.length} lines)`);
      } catch (e) { console.warn('[crpy] Chinese subtitles failed', e); }
    }

    // 2. A file the user loaded earlier for this episode
    if (await useSavedFile(mediaId)) return;

    // 3. Translate the English lines
    if (st.en.length) startTranslation('en2zh', false);
    else setStatus('No English or Chinese subtitles found for this episode.');
  }

  async function useSavedFile(mediaId) {
    const fileKey = 'file:' + mediaId;
    const saved = (await chrome.storage.local.get(fileKey))[fileKey];
    if (st.mediaId !== mediaId || !saved) return false;
    if (st.port) { st.port.disconnect(); st.port = null; }
    st.zh = saved.cues; st.offset = saved.offset || 0; st.zhSource = 'file';
    refreshAll();
    setStatus(`Chinese from your file "${saved.name}"`);
    return true;
  }

  // ---------- YouTube ----------

  let ytDecideTimer = null;

  function ytVideoId() { return new URLSearchParams(location.search).get('v') || ''; }

  function onYoutubeTrack({ videoId, lang, tlang, data }) {
    if (!videoId) return;
    const mediaId = 'yt:' + videoId;
    if (st.mediaId !== mediaId) reset(mediaId);
    const cues = CrpySubs.parseJson3(data);
    if (!cues.length) return;
    const l = (tlang || lang).toLowerCase();
    if (l.startsWith('zh')) {
      if (st.zhSource !== 'youtube' || !tlang) { st.zh = cues; st.zhSource = 'youtube'; }
    } else if (l.startsWith('en')) {
      if (st.enSource !== 'youtube' || !tlang) { st.en = cues; st.enSource = 'youtube'; }
    } else {
      setStatus('Pick Chinese or English captions (CC) for this video.');
      return;
    }
    refreshAll();
    // The player may still load a second track (e.g. auto-translated English); wait a moment.
    clearTimeout(ytDecideTimer);
    ytDecideTimer = setTimeout(() => ytDecide(mediaId), 1500);
  }

  async function ytDecide(mediaId) {
    if (st.mediaId !== mediaId) return;
    if (st.zhSource === 'youtube' && st.enSource === 'youtube') return setStatus('Chinese and English from YouTube');
    if (st.zhSource === 'youtube' && !st.en.length) return startTranslation('zh2en', false);
    if (st.enSource === 'youtube' && !st.zh.length) {
      if (await useSavedFile(mediaId)) return;
      return startTranslation('en2zh', false);
    }
  }

  function onYoutubeCaptionState({ videoId, picked, available }) {
    if (st.mediaId !== 'yt:' + videoId && videoId) reset('yt:' + videoId);
    if (!available) setStatus('This video has no captions, so there is nothing to show.');
    else if (picked) setStatus(`Turned on ${picked} captions…`);
  }

  // Ask the page script to switch the YouTube player to Chinese (or English) captions.
  let ytAskedFor = '';
  function ytEnsureCaptions() {
    const id = ytVideoId();
    if (!id || ytAskedFor === id) return;
    const p = document.querySelector('#movie_player');
    if (!p || !video || video.readyState < 1) return;
    ytAskedFor = id;
    window.postMessage({ source: 'crpy-content', type: 'yt-enable-captions' }, location.origin);
  }

  // ---------- AI translation ----------

  // en2zh: fill Chinese from English lines. zh2en: fill English from Chinese lines.
  function startTranslation(direction, force) {
    if (st.port) st.port.disconnect();
    const mediaId = st.mediaId;
    const src = direction === 'en2zh' ? st.en : st.zh;
    const target = src.map(c => ({ ...c, text: '' }));
    if (direction === 'en2zh') { st.zh = target; st.zhSource = 'ai'; } else { st.en = target; st.enSource = 'ai'; }
    const byId = new Map(target.map(c => [c.id, c]));
    const label = direction === 'en2zh' ? 'Chinese' : 'English';
    const port = chrome.runtime.connect({ name: 'translate' });
    st.port = port;
    st.direction = direction;
    port.onMessage.addListener(m => {
      if (st.mediaId !== mediaId) return;
      if (m.type === 'progress') {
        for (const [id, text] of Object.entries(m.results)) { const c = byId.get(+id); if (c) c.text = text; }
        refreshAll();
        setStatus(`Translating ${label} with AI… ${m.done}/${m.total}`);
      } else if (m.type === 'done') {
        setStatus(`${label}: AI translation (${m.done}/${m.total} lines)`);
        port.disconnect(); st.port = null;
      } else if (m.type === 'error') {
        setStatus('Translation: ' + m.error);
        port.disconnect(); st.port = null;
      }
    });
    port.onDisconnect.addListener(() => { if (st.port === port) st.port = null; });
    port.postMessage({
      type: 'start',
      direction,
      mediaId,
      title: st.title || videoTitle(),
      lines: src.map(c => ({ id: c.id, text: c.text })),
      fromId: currentId(src),
      force,
    });
  }

  // First line that hasn't finished yet at the current playback time.
  function currentId(cues) {
    const t = video ? video.currentTime : 0;
    const c = cues.find(c => c.end > t);
    return c ? c.id : 0;
  }

  function onSeeked() {
    if (st.port) {
      const src = st.direction === 'zh2en' ? st.zh : st.en;
      st.port.postMessage({ type: 'prioritize', fromId: currentId(src) });
    }
  }

  // ---------- own subtitle file ----------

  async function loadFile(file) {
    const raw = await file.text();
    const cues = CrpySubs.parse(raw, file.name);
    if (!cues.length) return setStatus('Could not read any lines from ' + file.name);
    if (st.port) { st.port.disconnect(); st.port = null; }
    st.zh = cues; st.zhSource = 'file'; st.offset = 0;
    refreshAll();
    if (st.mediaId) await chrome.storage.local.set({ ['file:' + st.mediaId]: { name: file.name, cues, offset: 0 } });
    setStatus(`Chinese from your file "${file.name}" (${cues.length} lines)`);
  }

  async function clearFile() {
    if (!st.mediaId) return;
    await chrome.storage.local.remove('file:' + st.mediaId);
    if (SITE === 'crunchyroll') onCrunchyrollPlay({ mediaId: st.mediaId, subtitles: lastSubs });
    else { ytAskedFor = ''; reset(null); }
  }

  async function setOffset(delta) {
    st.offset = Math.round((st.offset + delta) * 10) / 10;
    refreshAll();
    if (st.zhSource === 'file' && st.mediaId) {
      const k = 'file:' + st.mediaId;
      const saved = (await chrome.storage.local.get(k))[k];
      if (saved) { saved.offset = st.offset; await chrome.storage.local.set({ [k]: saved }); }
    }
  }

  // ---------- lines: Chinese paired with English ----------

  // One entry per spoken line: Chinese when we have it (timing from the Chinese
  // track), with the English that overlaps it. Falls back to English-only lines.
  function pairedLines() {
    const zh = st.zh.filter(c => c.text);
    if (!zh.length) return st.en.map(c => ({ start: c.start, end: c.end, zh: '', en: c.text }));
    const sameIds = st.zhSource === 'ai' || st.enSource === 'ai';
    const enById = new Map(st.en.map(c => [c.id, c]));
    return zh.map(c => {
      const start = c.start + st.offset, end = c.end + st.offset;
      let en = '';
      if (sameIds) en = enById.get(c.id)?.text || '';
      else {
        const mid = (start + end) / 2;
        en = st.en.filter(e => e.start <= mid && e.end >= mid).map(e => e.text).join(' ');
      }
      return { start, end, zh: c.text, en };
    });
  }

  // ---------- rendering ----------

  let root, linesEl, panelEl, historyEl, popupEl, video, lastKey = '', historyCount = -1, lastCurrent = -1;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const HAN = /\p{Script=Han}/u;
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

  // Word splitting comes from the background (dictionary-based, more accurate than
  // Intl.Segmenter). Until a line's answer arrives we fall back to Intl.Segmenter.
  const segCache = new Map();
  const segWanted = new Set();
  let segTimer = null;

  function segmentsOf(text) {
    const hit = segCache.get(text);
    if (hit) return hit;
    segWanted.add(text);
    if (!segTimer) segTimer = setTimeout(requestSegments, 0);
    return [...segmenter.segment(text)].map(s => s.segment);
  }

  async function requestSegments() {
    segTimer = null;
    const texts = [...segWanted];
    segWanted.clear();
    if (!texts.length) return;
    const res = await chrome.runtime.sendMessage({ type: 'segment', texts }).catch(() => null);
    if (!res || !res.segs) return;
    texts.forEach((t, i) => { if (res.segs[i]) segCache.set(t, res.segs[i]); });
    refreshAll();
  }

  // Tone number of a pinyin syllable from its tone mark (5 = neutral).
  const TONE_MARKS = ['', 'āēīōūǖ', 'áéíóúǘ', 'ǎěǐǒǔǚ', 'àèìòùǜ'];
  function toneOf(syllable) {
    for (let t = 1; t <= 4; t++) if ([...syllable].some(c => TONE_MARKS[t].includes(c))) return t;
    return 5;
  }
  const pySpans = py => py.split(/\s+/).filter(Boolean)
    .map(s => `<span class="crpy-py crpy-t${toneOf(s)}">${esc(s)}</span>`).join(' ');

  // Chinese line → word spans (for lookup) holding per-character ruby pinyin.
  function zhHtml(text, opts = view) {
    const py = pinyinPro.pinyin(text, { type: 'array' });
    let html = '', ci = 0;
    for (const segment of segmentsOf(text)) {
      const segChars = [...segment];
      const pys = py.slice(ci, ci + segChars.length);
      ci += segChars.length;
      if (!HAN.test(segment)) {
        html += segment === '\n' ? '<br>' : esc(segment);
        continue;
      }
      let inner;
      if (opts.showPinyin && opts.showHanzi) {
        inner = segChars.map((c, i) => {
          if (!HAN.test(c)) return esc(c);
          const t = 'crpy-t' + toneOf(pys[i] || '');
          return `<ruby class="${t}">${esc(c)}<rt class="${t}">${esc(pys[i] || '')}</rt></ruby>`;
        }).join('');
      } else if (opts.showPinyin) {
        inner = `<span class="crpy-pyonly">${pys.map(p => `<span class="crpy-py crpy-t${toneOf(p)}">${esc(p)}</span>`).join('')}</span> `;
      } else {
        inner = segChars.map((c, i) => `<ruby class="crpy-t${toneOf(pys[i] || '')}">${esc(c)}</ruby>`).join('');
      }
      const saved = vocab[segment] ? ' crpy-saved' : '';
      html += `<span class="crpy-w${saved}" data-w="${esc(segment)}" data-py="${esc(pys.join(' '))}">${inner}</span>`;
    }
    return html;
  }

  function refreshAll() { lastKey = ''; historyCount = -1; lastCurrent = -1; renderPanel(); }

  function render() {
    if (!video || !root) return;
    const t = video.currentTime;
    const zh = st.zh.length ? CrpySubs.activeAt(st.zh, t - st.offset).filter(c => c.text) : [];
    const en = view.showEnglish && !burnedEnglish() ? CrpySubs.activeAt(st.en, t).filter(c => c.text) : [];
    const key = zh.map(c => c.id).join(',') + '|' + en.map(c => c.id).join(',') + '|' + st.offset;
    if (key !== lastKey && !popupPinned) {
      lastKey = key;
      const showZh = view.showPinyin || view.showHanzi;
      let html = '';
      if (showZh) for (const c of zh) html += `<div class="crpy-zh">${zhHtml(c.text)}</div>`;
      for (const c of en) html += `<div class="crpy-en">${esc(c.text).replace(/\n/g, '<br>')}</div>`;
      linesEl.innerHTML = html;
    }
    if (view.showHistory) renderHistory(t);
  }

  function renderHistory(t) {
    const lines = pairedLines();
    let count = 0;
    while (count < lines.length && lines[count].start <= t) count++;
    const current = count - 1;
    if (count !== historyCount) {
      historyCount = count;
      const list = historyEl.querySelector('.crpy-hist-list');
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
      list.innerHTML = lines.slice(0, count).map((l, i) => `
        <div class="crpy-hist-item" data-i="${i}" data-t="${l.start}">
          <div class="crpy-hist-time">${fmtTime(l.start)}</div>
          ${l.zh ? `<div class="crpy-hist-zh">${zhHtml(l.zh, { showPinyin: true, showHanzi: true })}</div>` : ''}
          ${l.en ? `<div class="crpy-hist-en">${esc(l.en)}</div>` : ''}
        </div>`).join('') || '<div class="crpy-hist-empty">Lines appear here as they are spoken.</div>';
      if (atBottom || lastCurrent === -1) list.scrollTop = list.scrollHeight;
    }
    if (current !== lastCurrent) {
      lastCurrent = current;
      historyEl.querySelectorAll('.crpy-hist-item.crpy-current').forEach(e => e.classList.remove('crpy-current'));
      const cur = historyEl.querySelector(`.crpy-hist-item[data-i="${current}"]`);
      if (cur) cur.classList.add('crpy-current');
    }
  }

  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function applyView() {
    if (root) {
      root.style.setProperty('--crpy-size', view.fontSize + 'px');
      root.classList.toggle('crpy-with-history', !!view.showHistory);
      root.classList.toggle('crpy-tones', !!view.toneColors);
      root.querySelector('[data-a="history"]').classList.toggle('crpy-on', !!view.showHistory);
      historyEl.hidden = !view.showHistory;
    }
    document.documentElement.classList.toggle('crpy-hide-native', !!view.hideNative);
    refreshAll();
  }

  function renderPanel() {
    if (!panelEl) return;
    const names = { crunchyroll: 'Crunchyroll', youtube: 'YouTube', file: 'own file', ai: 'AI translation' };
    panelEl.querySelector('.crpy-status').textContent = st.status +
      (burnedEnglish() ? ' · English is burned into this video, so ours is hidden' : '');
    panelEl.querySelector('.crpy-src').textContent =
      `中文: ${names[st.zhSource] || '—'} · English: ${names[st.enSource] || '—'}`;
    panelEl.querySelector('.crpy-offset').textContent = (st.offset > 0 ? '+' : '') + st.offset.toFixed(1) + 's';
    for (const k of ['showPinyin', 'showHanzi', 'showEnglish', 'hideNative', 'pauseOnHover', 'showHistory', 'toneColors']) {
      const el = panelEl.querySelector(`[data-k="${k}"]`);
      if (el) el.checked = !!view[k];
    }
    panelEl.querySelector('.crpy-clearfile').hidden = st.zhSource !== 'file';
  }

  // ---------- word lookup popup ----------

  let popupWord = null, popupPinned = false, hoverPaused = false, hideTimer = null;

  async function showPopup(wordEl) {
    clearTimeout(hideTimer);
    const word = wordEl.dataset.w;
    popupWord = { word, py: wordEl.dataset.py, el: wordEl, line: lineTextOf(wordEl) };
    popupPinned = true;
    popupStack = [];
    if (view.pauseOnHover && video && !video.paused) { video.pause(); hoverPaused = true; }

    popupEl.innerHTML = `<div class="crpy-pop-head"><span class="crpy-pop-word">${esc(word)}</span>
      <span class="crpy-pop-py">${pySpans(popupWord.py)}</span>
      <button class="crpy-star" title="Save to word list">${vocab[word] ? '★' : '☆'}</button></div>
      <div class="crpy-pop-body">…</div>`;
    popupEl.hidden = false;
    placePopup(wordEl);

    const res = await chrome.runtime.sendMessage({ type: 'lookup', word, py: popupWord.py });
    if (!popupWord || popupWord.word !== word) return;
    popupWord.entries = res.entries;
    popupEl.querySelector('.crpy-pop-body').innerHTML = popupBody(res);
    placePopup(wordEl);
  }

  const shortDef = s => String(s || '').split(/[;,]/)[0].trim();

  // Meanings of the word, then how each character is built from simpler parts.
  function popupBody({ entries, chars }) {
    let html = entries.length
      ? entries.slice(0, 3).map(e => `<div class="crpy-pop-entry"><b>${esc(e[0])}</b> ${esc(e[1])}</div>`).join('')
      : '';
    const built = chars.filter(c => c.parts.length || chars.length > 1);
    if (built.length) {
      html += '<div class="crpy-pop-build">' + built.map(c => {
        const parts = c.parts.map(p =>
          `<span class="crpy-part" data-c="${esc(p.c)}" title="${esc(p.def)}">` +
          `<span class="crpy-part-c">${esc(p.c)}</span>` +
          (p.role ? `<span class="crpy-role crpy-role-${p.role}">${p.role}</span>` : '') +
          `<span class="crpy-part-d">${esc(p.role === 'sound' ? p.py : shortDef(p.def))}</span></span>`
        ).join('<span class="crpy-plus">+</span>');
        const hint = c.type === 'pictophonetic' ? '' : c.hint;
        return `<div class="crpy-char">
          <span class="crpy-char-c" data-c="${esc(c.char)}">${esc(c.char)}</span>
          <span class="crpy-char-py">${pySpans(c.py)}</span>
          <span class="crpy-char-d">${esc(shortDef(c.def))}</span>
          ${parts ? `<div class="crpy-parts">= ${parts}</div>` : ''}
          ${hint ? `<div class="crpy-hint-line">${esc(hint)}</div>` : ''}
        </div>`;
      }).join('') + '</div>';
    }
    if (popupStack.length) html += '<div class="crpy-pop-back"><button class="crpy-back">← back</button></div>';
    return html || '<div class="crpy-pop-entry">—</div>';
  }

  // Click a character or one of its parts to see how that one is built.
  let popupStack = [];
  async function drillInto(char) {
    if (!popupWord) return;
    popupStack.push(popupEl.innerHTML);
    const res = await chrome.runtime.sendMessage({ type: 'lookup', word: char });
    const py = res.chars[0]?.py || '';
    popupEl.innerHTML = `<div class="crpy-pop-head"><span class="crpy-pop-word">${esc(char)}</span>
      <span class="crpy-pop-py">${pySpans(py)}</span></div>
      <div class="crpy-pop-body">${popupBody(res)}</div>`;
    placePopup(popupWord.el);
  }

  function drillBack() {
    const prev = popupStack.pop();
    if (prev != null) popupEl.innerHTML = prev;
    if (popupWord) placePopup(popupWord.el);
  }

  function lineTextOf(wordEl) {
    const line = wordEl.closest('.crpy-zh, .crpy-hist-zh');
    if (!line) return { zh: '', en: '' };
    const zh = [...line.querySelectorAll('.crpy-w')].length ? textWithoutRt(line) : '';
    let en = '';
    const item = wordEl.closest('.crpy-hist-item');
    if (item) en = item.querySelector('.crpy-hist-en')?.textContent || '';
    else en = [...linesEl.querySelectorAll('.crpy-en')].map(e => e.textContent).join(' ');
    return { zh, en };
  }

  function textWithoutRt(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('rt, .crpy-pyonly').forEach(r => r.remove());
    return c.textContent.trim();
  }

  function placePopup(wordEl) {
    const rr = root.getBoundingClientRect();
    const wr = wordEl.getBoundingClientRect();
    const pr = popupEl.getBoundingClientRect();
    let left = wr.left - rr.left + wr.width / 2 - pr.width / 2;
    left = Math.max(8, Math.min(left, rr.width - pr.width - 8));
    let top = wr.top - rr.top - pr.height - 10;
    if (top < 8) top = wr.bottom - rr.top + 10;
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      popupEl.hidden = true;
      popupWord = null;
      popupPinned = false;
      lastKey = '';
      if (hoverPaused && video) { video.play().catch(() => {}); }
      hoverPaused = false;
    }, 250);
  }

  async function toggleSave() {
    if (!popupWord) return;
    const { word, py, entries, line } = popupWord;
    const all = (await chrome.storage.local.get('vocab')).vocab || {};
    if (all[word]) delete all[word];
    else all[word] = {
      word,
      pinyin: entries?.[0]?.[0] || py,
      meaning: (entries || []).slice(0, 2).map(e => e[1]).join(' | '),
      sentence: line.zh,
      sentenceEn: line.en,
      source: st.title || videoTitle(),
      url: location.href.split('#')[0],
      time: video ? Math.floor(video.currentTime) : 0,
      added: Date.now(),
    };
    await chrome.storage.local.set({ vocab: all });
    vocab = all;
    popupEl.querySelector('.crpy-star').textContent = all[word] ? '★' : '☆';
    document.querySelectorAll('.crpy-w').forEach(el => el.classList.toggle('crpy-saved', !!all[el.dataset.w]));
  }

  // ---------- line navigation (A / S / D) ----------

  function seekLine(which) {
    const lines = pairedLines();
    if (!video || !lines.length) return;
    const t = video.currentTime;
    let cur = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].start <= t + 0.05) cur = i;
    const target = which === 'prev' ? Math.max(0, (t - (lines[cur]?.start ?? 0) > 1 ? cur : cur - 1))
      : which === 'next' ? Math.min(lines.length - 1, cur + 1)
      : Math.max(0, cur);
    video.currentTime = lines[target].start + 0.02;
    if (video.paused) video.play().catch(() => {});
  }

  window.addEventListener('keydown', e => {
    if (!video || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const map = { a: 'prev', s: 'repeat', d: 'next' };
    const which = map[e.key.toLowerCase()];
    if (!which) return;
    e.preventDefault();
    e.stopPropagation();
    seekLine(which);
  }, true);

  // ---------- building the UI ----------

  function buildUi(container) {
    root = document.createElement('div');
    root.className = 'crpy-root';
    const mascot = chrome.runtime.getURL('assets/mascot.svg');
    const sw = (k, label) => `<label class="crpy-switch"><span>${label}</span><input type="checkbox" data-k="${k}"></label>`;
    root.innerHTML = `
      <div class="crpy-lines"></div>
      <div class="crpy-popup" hidden></div>
      <div class="crpy-history" hidden>
        <div class="crpy-hist-head">History
          <span class="crpy-hist-keys"><span class="crpy-kbd">A</span> back · <span class="crpy-kbd">S</span> repeat · <span class="crpy-kbd">D</span> next</span>
          <button data-a="closehist" title="Close">✕</button></div>
        <div class="crpy-hist-list"></div>
      </div>
      <div class="crpy-buttons">
        <button class="crpy-btn crpy-logo" data-a="menu" title="Xiaopin menu"><img class="crpy-mascot" src="${mascot}" alt="">Xiaopin</button>
        <button class="crpy-btn" data-a="history" title="All lines so far"><span class="crpy-btn-ic">史</span>History</button>
      </div>
      <div class="crpy-panel" hidden>
        <div class="crpy-panel-head"><img class="crpy-mascot-lg" src="${mascot}" alt="">
          <div><div class="crpy-brand">Xiaopin <span>小拼</span></div><div class="crpy-src"></div></div></div>
        <div class="crpy-status"></div>
        <div class="crpy-sec">Show</div>
        ${sw('showPinyin', 'Pinyin')}
        ${sw('showHanzi', 'Chinese characters')}
        ${sw('showEnglish', 'English')}
        ${sw('toneColors', 'Tone colours')}
        <div class="crpy-row">Text size <button data-a="smaller">A−</button><button data-a="bigger">A+</button></div>
        <div class="crpy-sec">Study</div>
        ${sw('pauseOnHover', 'Pause while reading a word')}
        ${sw('showHistory', 'History panel')}
        ${sw('hideNative', 'Hide the site\'s own subtitles')}
        <div class="crpy-sec">Chinese text</div>
        <div class="crpy-row">
          <button data-a="file">Load .srt / .ass…</button>
          <button data-a="clearfile" class="crpy-clearfile">Remove file</button>
          <button data-a="retranslate">Translate again</button>
          <input type="file" accept=".srt,.ass,.ssa" hidden>
        </div>
        <div class="crpy-row">Timing <button data-a="minus">−0.5s</button><span class="crpy-offset"></span><button data-a="plus">+0.5s</button></div>
        <div class="crpy-row" style="margin-top:12px"><button data-a="options">Word list &amp; settings</button>
          <span class="crpy-hint"><span class="crpy-kbd">A</span> <span class="crpy-kbd">S</span> <span class="crpy-kbd">D</span> line keys</span></div>
      </div>`;
    linesEl = root.querySelector('.crpy-lines');
    panelEl = root.querySelector('.crpy-panel');
    historyEl = root.querySelector('.crpy-history');
    popupEl = root.querySelector('.crpy-popup');
    const fileInput = root.querySelector('input[type=file]');

    // Keep clicks inside our UI from reaching the player (play/pause, fullscreen…).
    // Stopped at the root, after our own handlers on the root have run.
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'wheel']) {
      root.addEventListener(ev, e => e.stopPropagation());
    }

    // React to real mouse movement only: a new line appearing under a resting
    // cursor must not open the popup (and pause the video).
    root.addEventListener('mousemove', e => {
      const w = e.target.closest('.crpy-w');
      if (w && w !== popupWord?.el) showPopup(w);
      else if (w || e.target.closest('.crpy-popup')) clearTimeout(hideTimer);
    });
    root.addEventListener('mouseout', e => {
      const to = e.relatedTarget;
      if (popupWord && !(to && (to.closest?.('.crpy-popup') || to === popupWord.el || popupWord.el.contains(to)))) scheduleHide();
    });

    root.addEventListener('change', e => {
      const k = e.target.dataset.k;
      if (k) chrome.storage.sync.set({ [k]: e.target.checked });
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
    root.addEventListener('click', e => {
      if (e.target.closest('.crpy-star')) return toggleSave();
      if (e.target.closest('.crpy-back')) return drillBack();
      const drill = e.target.closest('.crpy-part, .crpy-char-c');
      if (drill) return drillInto(drill.dataset.c);
      const item = e.target.closest('.crpy-hist-item');
      if (item && !e.target.closest('.crpy-w')) { video.currentTime = +item.dataset.t + 0.02; return; }
      const a = e.target.dataset.a;
      if (a === 'menu') { panelEl.hidden = !panelEl.hidden; renderPanel(); }
      if (a === 'history' || a === 'closehist') chrome.storage.sync.set({ showHistory: !view.showHistory });
      if (a === 'file') fileInput.click();
      if (a === 'clearfile') clearFile();
      if (a === 'minus') setOffset(-0.5);
      if (a === 'plus') setOffset(0.5);
      if (a === 'smaller') chrome.storage.sync.set({ fontSize: Math.max(14, view.fontSize - 2) });
      if (a === 'bigger') chrome.storage.sync.set({ fontSize: Math.min(64, view.fontSize + 2) });
      if (a === 'retranslate') {
        if (st.zhSource === 'ai' && st.en.length) startTranslation('en2zh', true);
        else if (st.enSource === 'ai' && st.zh.length) startTranslation('zh2en', true);
      }
      if (a === 'options') chrome.runtime.sendMessage({ type: 'openOptions' });
    });

    container.appendChild(root);
    root.classList.toggle('crpy-burned', burnedEnglish());
    root.classList.add('crpy-site-' + SITE);
    applyView();
  }

  function findVideo() {
    if (SITE === 'youtube') {
      const v = document.querySelector('#movie_player video.html5-main-video') || document.querySelector('#movie_player video');
      return v ? { v, container: document.querySelector('#movie_player') } : null;
    }
    const v = document.querySelector('.bitmovinplayer-container video') || document.querySelector('video');
    return v ? { v, container: v.parentElement } : null;
  }

  // The player is created and replaced by the page at will; reattach when needed.
  function tick() {
    const found = findVideo();
    if (found && (!root || !root.isConnected || found.v !== video)) {
      if (video) video.removeEventListener('seeked', onSeeked);
      video = found.v;
      video.addEventListener('seeked', onSeeked);
      if (root) root.remove();
      buildUi(found.container);
    }
    if (SITE === 'youtube') {
      const id = ytVideoId();
      if (st.mediaId && id && st.mediaId !== 'yt:' + id) reset(null);
      if (location.pathname === '/watch') ytEnsureCaptions();
    }
    render();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
