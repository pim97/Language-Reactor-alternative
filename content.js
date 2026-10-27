// Content script: collects Chinese and English subtitle tracks for the current
// video (Crunchyroll or YouTube) and draws the pinyin / 汉字 / English overlay,
// word lookup, line history and vocabulary saving on top of the player.
(() => {
  const SITE = location.hostname.includes('youtube.com') ? 'youtube' : 'crunchyroll';

  const VIEW_DEFAULTS = {
    showPinyin: true, showHanzi: true, showEnglish: true, fontSize: 30,
    hideNative: true, pauseOnHover: true, showHistory: false, toneColors: true,
    hideCard: false,   // true = subtitles only in the history panel, not on the video
    explainLang: 'en', // language of AI explanations: 'en' | 'nl'
    extraLang: '',     // extra subtitle line under the English: '' (off) | 'nl'
    autoMode: 'chinese', // turn on by itself: 'chinese' (videos with Chinese) | 'always' | 'manual'
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
    extra: [],            // extra-language line (Dutch) as cues, same ids/timing as its source
    extraFrom: null,      // 'zh' | 'en': which track the extra line was translated from
    extraPort: null,
    extraKey: '',         // what the running/finished extra translation was started for
    extraFails: 0,        // failed attempts for this video (stops after 2, so no endless paid retries)
    active: null,         // on for this video? null = not decided yet
  };

  // ---------- on or off per video ----------
  // By default Xiaopin only turns itself on for videos with Chinese (Chinese captions
  // on YouTube; Chinese audio or subtitles on Crunchyroll). The Off / Video / History /
  // Both switch overrides that per video, and the choice is remembered.
  let videoOn = {};   // { mediaId: true | false }
  let lastActiveFor = null;   // mediaId st.active was decided for
  chrome.storage.local.get('videoOn').then(v => { videoOn = v.videoOn || {}; });

  function decideActive(mediaId, chinese) {
    if (typeof videoOn[mediaId] === 'boolean') return videoOn[mediaId];
    if (view.autoMode === 'always') return true;
    if (view.autoMode === 'manual') return false;
    return !!chinese;
  }

  async function rememberVideo(mediaId, on) {
    const all = (await chrome.storage.local.get('videoOn')).videoOn || {};
    all[mediaId] = on;
    videoOn = all;
    await chrome.storage.local.set({ videoOn: all });
  }

  // The user switched this video on or off.
  function setVideoActive(on) {
    if (!st.mediaId) return;
    rememberVideo(st.mediaId, on);
    if (!on) {
      st.active = false;
      if (st.port) { st.port.disconnect(); st.port = null; }
      if (st.extraPort) { st.extraPort.disconnect(); st.extraPort = null; st.extraKey = ''; }
      if (popupWord) closePopup();
      setStatus('Off for this video. Choose Video, History or Both to turn it on.');
      applyView();
      return;
    }
    st.active = true;
    applyView();
    // Start (again) from what the site gave us; saved translations make this free.
    if (SITE === 'crunchyroll' && lastPlay) onCrunchyrollPlay(lastPlay);
    if (SITE === 'youtube') ytActivate();
  }

  // ---------- feature plugins ----------
  // Files in features/ load after this script and call Xiaopin.register({...}).
  // The hooks are documented in features/README.md.
  const features = [];
  const featureSettings = [];   // [{ key, label, section, default }]
  const callFeatures = (hook, ...args) => {
    for (const f of features) {
      if (typeof f[hook] !== 'function') continue;
      try { f[hook](...args); } catch (e) { console.warn(`[xiaopin] ${f.id}.${hook}`, e); }
    }
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
    if (d.type === 'play') { lastSubs = d.subtitles; lastPlay = d; onCrunchyrollPlay(d); }
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
    if (st.extraPort) { st.extraPort.disconnect(); st.extraPort = null; }
    Object.assign(st, { mediaId, en: [], zh: [], enSource: null, zhSource: null, offset: 0, burnedIn: '',
      extra: [], extraFrom: null, extraKey: '', extraFails: 0 });
    if (st.mediaId !== lastActiveFor) { st.active = null; lastActiveFor = st.mediaId; }
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
  let lastPlay = null;   // last playback info, to start again when the user turns Xiaopin on

  async function onCrunchyrollPlay({ mediaId, subtitles, audioLocale }) {
    reset(mediaId);
    const enTrack = subtitles['en-US'] || Object.entries(subtitles).find(([k]) => k.startsWith('en'))?.[1];
    const zhTrack = subtitles['zh-CN'] || Object.entries(subtitles).find(([k]) => k.startsWith('zh'))?.[1];

    // A Chinese show (Chinese audio) or Chinese subtitles: on by itself. Otherwise
    // (e.g. Japanese anime) it stays off until the user turns it on.
    if (st.active === null) st.active = decideActive(mediaId, /^zh/i.test(audioLocale || '') || !!zhTrack);
    applyView();
    if (!st.active) return setStatus('Off for this episode (no Chinese). Choose Video, History or Both to turn it on.');
    setStatus('Loading subtitles…');

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

  // Caption tracks the player loaded for the current video. Kept even while Xiaopin is
  // off, so turning it on later needs no new request.
  let ytTracks = [];

  function onYoutubeTrack(d) {
    if (!d.videoId) return;
    const mediaId = 'yt:' + d.videoId;
    if (st.mediaId !== mediaId) { reset(mediaId); ytTracks = []; }
    ytTracks.push(d);
    const l = (d.tlang || d.lang).toLowerCase();
    // A Chinese track turns a not-yet-decided video on (unless the user said otherwise).
    if (st.active === null && l.startsWith('zh')) st.active = decideActive(mediaId, true);
    if (st.active) useYoutubeTrack(d);
    else applyView();
  }

  // Turned on by the user, or a Chinese track arrived: use what we have, and make
  // sure the player loads captions (any language) if it has none yet.
  function ytActivate() {
    const tracks = ytTracks;
    ytTracks = [];
    for (const d of tracks) onYoutubeTrack(d);
    if (!tracks.length) { ytAskedFor = ''; ytEnsureCaptions(true); }
  }

  function useYoutubeTrack({ videoId, lang, tlang, data }) {
    const mediaId = 'yt:' + videoId;
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
    if (st.mediaId !== mediaId || !st.active) return;
    if (st.zhSource === 'youtube' && st.enSource === 'youtube') return setStatus('Chinese and English from YouTube');
    if (st.zhSource === 'youtube' && !st.en.length) return startTranslation('zh2en', false);
    if (st.enSource === 'youtube' && !st.zh.length) {
      if (await useSavedFile(mediaId)) return;
      return startTranslation('en2zh', false);
    }
  }

  function onYoutubeCaptionState({ videoId, picked, available, noChinese, chinese }) {
    const mediaId = 'yt:' + videoId;
    if (st.mediaId !== mediaId && videoId) { reset(mediaId); ytTracks = []; }
    if (st.active === null) {
      st.active = decideActive(mediaId, !!chinese);
      if (st.active) ytActivate();
      applyView();
    }
    if (!st.active) return setStatus(noChinese || !available
      ? 'Off: this video has no Chinese captions. Choose Video, History or Both to turn it on anyway.'
      : 'Off for this video. Choose Video, History or Both to turn it on.');
    if (!available) setStatus('This video has no captions, so there is nothing to show.');
    else if (picked) setStatus(`Turned on ${picked} captions…`);
    else if (noChinese) setStatus('This video has no Chinese or English captions to show.');
  }

  // Ask the page script to switch the YouTube player to Chinese captions. While a
  // video is not (yet) on, only Chinese is asked for: other videos are left alone.
  let ytAskedFor = '';
  function ytEnsureCaptions(any = false) {
    const id = ytVideoId();
    if (!id || ytAskedFor === id) return;
    const p = document.querySelector('#movie_player');
    if (!p || !video || video.readyState < 1) return;
    // Turned off for this video, or "only when I turn it on": do nothing at all.
    if (!any && (videoOn['yt:' + id] === false || (view.autoMode === 'manual' && videoOn['yt:' + id] !== true))) {
      ytAskedFor = id;
      if (st.mediaId !== 'yt:' + id) { reset('yt:' + id); ytTracks = []; }
      st.active = false;
      applyView();
      return setStatus('Off for this video. Choose Video, History or Both to turn it on.');
    }
    const chineseOnly = !any && view.autoMode === 'chinese' && videoOn['yt:' + id] !== true;
    ytAskedFor = id;
    window.postMessage({ source: 'crpy-content', type: 'yt-enable-captions', chineseOnly }, location.origin);
    // No caption data after a few seconds: ask again with a fresh captions module.
    for (const wait of [4000, 10000]) {
      setTimeout(() => {
        const has = st.mediaId === 'yt:' + id && (st.zhSource === 'youtube' || st.enSource === 'youtube');
        // Only for a video that is (or may become) on; an off video is left alone.
        if (!has && ytVideoId() === id && st.active !== false) {
          window.postMessage({ source: 'crpy-content', type: 'yt-enable-captions', reload: true, chineseOnly }, location.origin);
        }
      }, wait);
    }
  }

  // ---------- AI translation ----------

  // en2zh: fill Chinese from English lines. zh2en: fill English from Chinese lines.
  function startTranslation(direction, force) {
    if (st.active === false) return;   // off for this video: no AI calls
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
        // Everything already saved: no "Translating…" flash, nothing is sent to the AI.
        if (m.done < m.total) setStatus(`Translating ${label} with AI… ${m.done}/${m.total}`);
      } else if (m.type === 'done') {
        setStatus(m.translated
          ? `${label}: AI translation (${m.done}/${m.total} lines, ${m.translated} new)`
          : `${label}: saved translation (${m.done}/${m.total} lines, no AI used)`);
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

  // ---------- extra language line (Dutch) ----------

  // Translated from the original Chinese; but when the Chinese itself was made by
  // the AI from English (Crunchyroll), from the English the show really has.
  function extraSource() {
    if (st.zhSource && st.zhSource !== 'ai' && st.zh.some(c => c.text)) return 'zh';
    if (st.enSource && st.enSource !== 'ai' && st.en.some(c => c.text)) return 'en';
    return null;
  }

  // Start (once per video, language and source) the extra-line translation.
  // Called on every refresh, so it must stay a cheap check.
  function ensureExtra() {
    const lang = view.extraLang;
    if (!lang || !st.mediaId || !st.active || st.extraPort || st.extraFails >= 2) return;
    const from = extraSource();
    if (!from) return;
    const src = (from === 'zh' ? st.zh : st.en).filter(c => c.text);
    const key = `${st.mediaId}|${lang}|${from}|${src.length}`;
    if (st.extraKey === key) return;
    st.extraKey = key;
    st.extraFrom = from;
    st.extra = src.map(c => ({ ...c, text: '' }));
    const byId = new Map(st.extra.map(c => [c.id, c]));
    const mediaId = st.mediaId;
    const port = chrome.runtime.connect({ name: 'translate' });
    st.extraPort = port;
    port.onMessage.addListener(m => {
      if (st.mediaId !== mediaId) return;
      if (m.type === 'progress') {
        for (const [id, text] of Object.entries(m.results)) { const c = byId.get(+id); if (c) c.text = text; }
        lastKey = ''; historyCount = -1;
      } else if (m.type === 'done') {
        // Say what happened, also when the model gave nothing usable back.
        setStatus(m.done
          ? `Dutch line: ${m.done}/${m.total} lines${m.translated ? '' : ' (saved, no AI used)'}`
          : 'Dutch line: the AI model returned no usable lines. Try another model in the settings, or choose "Translate again".');
        // Nothing usable: allow one new attempt on the next refresh instead of giving up.
        if (!m.done) { st.extraFails++; st.extraKey = ''; }
        port.disconnect(); st.extraPort = null;
      } else if (m.type === 'error') {
        setStatus('Dutch line: ' + m.error);
        st.extraFails++;
        st.extraKey = '';
        port.disconnect(); st.extraPort = null;
      }
    });
    port.onDisconnect.addListener(() => { if (st.extraPort === port) st.extraPort = null; });
    port.postMessage({
      type: 'start',
      direction: `${from}2${lang}`,
      mediaId,
      title: st.title || videoTitle(),
      lines: src.map(c => ({ id: c.id, text: c.text })),
      fromId: currentId(src),
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
    if (st.extraPort) st.extraPort.postMessage({ type: 'prioritize', fromId: currentId(st.extra) });
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
    const showExtra = !!view.extraLang && st.extra.length;
    const extraById = new Map(showExtra ? st.extra.map(c => [c.id, c]) : []);
    if (!zh.length) {
      return st.en.map(c => ({ start: c.start, end: c.end, zh: '', en: c.text,
        nl: st.extraFrom === 'en' ? extraById.get(c.id)?.text || '' : '' }));
    }
    const sameIds = st.zhSource === 'ai' || st.enSource === 'ai';
    const enById = new Map(st.en.map(c => [c.id, c]));
    const overlap = (cues, start, end) => {
      const mid = (start + end) / 2;
      return cues.filter(e => e.start <= mid && e.end >= mid && e.text).map(e => e.text).join(' ');
    };
    return zh.map(c => {
      const start = c.start + st.offset, end = c.end + st.offset;
      const en = sameIds ? enById.get(c.id)?.text || '' : overlap(st.en, start, end);
      // The extra line shares ids with the track it came from.
      let nl = '';
      if (showExtra) {
        if (st.extraFrom === 'zh' || sameIds) nl = extraById.get(c.id)?.text || '';
        else nl = overlap(st.extra, start, end);
      }
      return { start, end, zh: c.text, en, nl };
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
      let cls = vocab[segment] ? ' crpy-saved' : '';
      for (const f of features) {
        if (!f.wordClass) continue;
        try { const c = f.wordClass(segment); if (c) cls += ' ' + c; } catch (e) {}
      }
      html += `<span class="crpy-w${cls}" data-w="${esc(segment)}" data-py="${esc(pys.join(' '))}">${inner}</span>`;
    }
    return html;
  }

  function refreshAll() {
    lastKey = ''; historyCount = -1; lastCurrent = -1;
    callFeatures('onChange', api);
    ensureExtra();
    renderPanel();
  }

  // Buttons features add to each line (overlay and history), e.g. "explain".
  function lineActionsHtml(i) {
    const acts = features.flatMap(f => (f.lineActions || []).map(a => ({ ...a, f: f.id })));
    if (!acts.length) return '';
    return `<div class="crpy-line-actions">${acts.map(a =>
      `<button class="crpy-la" data-la="${esc(a.id)}" data-f="${esc(a.f)}" data-i="${i}" title="${esc(a.title || a.label)}">${esc(a.label)}</button>`
    ).join('')}</div>`;
  }

  // Index into pairedLines() of the line being spoken at time t (-1 before the first).
  function lineIndexAt(lines, t) {
    let cur = -1;
    for (let i = 0; i < lines.length; i++) { if (lines[i].start <= t + 0.05) cur = i; else break; }
    return cur;
  }

  function render() {
    if (!video || !root) return;
    const t = video.currentTime;
    const zh = st.zh.length ? CrpySubs.activeAt(st.zh, t - st.offset).filter(c => c.text) : [];
    const en = view.showEnglish && !burnedEnglish() ? CrpySubs.activeAt(st.en, t).filter(c => c.text) : [];
    // The extra (Dutch) line follows the timing of the track it was translated from.
    const nl = view.extraLang && st.extra.length
      ? CrpySubs.activeAt(st.extra, st.extraFrom === 'zh' ? t - st.offset : t).filter(c => c.text) : [];
    const key = zh.map(c => c.id).join(',') + '|' + en.map(c => c.id).join(',') + '|' +
      nl.map(c => c.id).join(',') + '|' + st.offset;
    if (key !== lastKey && !popupPinned) {
      lastKey = key;
      const showZh = view.showPinyin || view.showHanzi;
      let html = '';
      if (showZh) for (const c of zh) html += `<div class="crpy-zh">${zhHtml(c.text)}</div>`;
      for (const c of en) html += `<div class="crpy-en">${esc(c.text).replace(/\n/g, '<br>')}</div>`;
      for (const c of nl) html += `<div class="crpy-nl" lang="${esc(view.extraLang)}">${esc(c.text).replace(/\n/g, '<br>')}</div>`;
      if (html && zh.length) html += lineActionsHtml(lineIndexAt(pairedLines(), t));
      linesEl.innerHTML = html;
      callFeatures('onLineRendered', linesEl, api);
    }
    if (view.showHistory) renderHistory(t);
    callFeatures('tick', t, api);
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
          ${l.nl ? `<div class="crpy-hist-nl">${esc(l.nl)}</div>` : ''}
          ${l.zh ? lineActionsHtml(i) : ''}
        </div>`).join('') || '<div class="crpy-hist-empty">Lines appear here as they are spoken.</div>';
      callFeatures('onHistoryRendered', list, api);
      if (atBottom || lastCurrent === -1) list.scrollTop = list.scrollHeight;
    }
    if (current !== lastCurrent) {
      lastCurrent = current;
      historyEl.querySelectorAll('.crpy-hist-item.crpy-current').forEach(e => e.classList.remove('crpy-current'));
      const cur = historyEl.querySelector(`.crpy-hist-item[data-i="${current}"]`);
      if (cur) cur.classList.add('crpy-current');
    }
  }

  // Where subtitles show: off for this video, on the video, only in the history
  // panel, or both. Off is per video; the other three are one setting for all.
  const LAYOUTS = ['video', 'history', 'both'];
  function layoutMode() {
    if (st.active === false) return 'off';
    if (!view.showHistory) return 'video';
    return view.hideCard ? 'history' : 'both';
  }
  function setLayout(mode) {
    if (mode === 'off') return setVideoActive(false);
    if (st.active === false) setVideoActive(true);
    chrome.storage.sync.set({ showHistory: mode !== 'video', hideCard: mode === 'history' });
  }

  const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  function applyView() {
    if (root) {
      root.style.setProperty('--crpy-size', view.fontSize + 'px');
      // A dragged history panel floats where the user put it; otherwise it docks right.
      const hp = uiPos.history;
      root.classList.toggle('crpy-hist-float', !!hp);
      Object.assign(historyEl.style, hp
        ? { left: hp.left + 'px', top: hp.top + 'px', width: (hp.width || 360) + 'px', height: (hp.height || 320) + 'px' }
        : { left: '', top: '', width: '', height: '' });
      const card = !view.showHistory || !view.hideCard;
      root.classList.toggle('crpy-with-history', !!view.showHistory && !hp && card);
      root.classList.toggle('crpy-hide-card', !card);
      root.classList.toggle('crpy-tones', !!view.toneColors);
      const mode = layoutMode();
      root.querySelectorAll('[data-a="layout"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
      root.querySelectorAll('[data-a="lang"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === view.explainLang)));
      root.querySelectorAll('[data-a="extra"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === (view.extraLang || ''))));
      root.querySelectorAll('[data-a="auto"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === view.autoMode)));
      root.classList.toggle('crpy-inactive', st.active === false);
      historyEl.hidden = !view.showHistory || st.active === false;
    }
    // While off, the site's own subtitles stay as they are.
    document.documentElement.classList.toggle('crpy-hide-native', !!view.hideNative && st.active !== false);
    callFeatures('onView', api);
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
    for (const k of Object.keys(VIEW_DEFAULTS)) {
      const el = panelEl.querySelector(`[data-k="${k}"]`);
      if (el) el.checked = !!view[k];
    }
    panelEl.querySelector('.crpy-clearfile').hidden = st.zhSource !== 'file';
    const fp = panelEl.querySelector('.crpy-feat-panel');
    if (fp) fp.innerHTML = features.map(f => {
      try { return f.panel ? `<div data-f="${esc(f.id)}">${f.panel(api) || ''}</div>` : ''; } catch (e) { return ''; }
    }).join('');
    const tb = root && root.querySelector('.crpy-feat-toolbar');
    if (tb) tb.innerHTML = features.map(f => {
      try { return f.toolbar ? f.toolbar(api) || '' : ''; } catch (e) { return ''; }
    }).join('');
  }

  // ---------- word lookup popup ----------

  let popupWord = null, popupPinned = false, hoverPaused = false, hideTimer = null;

  // Where the user dragged the popup and the history panel to (null = automatic).
  // A dragged popup is "docked": it stays open until ✕ / Escape.
  let uiPos = { popup: null, history: null };
  let popupDocked = false;
  chrome.storage.local.get('uiPos').then(v => { if (v.uiPos) { uiPos = { ...uiPos, ...v.uiPos }; applyView(); } });
  const saveUiPos = () => chrome.storage.local.set({ uiPos });

  const popupHead = (word, py, withStar) => `<div class="crpy-pop-head" title="Drag to move · double-click to reset">
      <span class="crpy-pop-word">${esc(word)}</span>
      <span class="crpy-pop-py">${pySpans(py)}</span>
      ${withStar ? `<button class="crpy-star" title="Save to word list">${vocab[word] ? '★' : '☆'}</button>` : ''}
      <button class="crpy-pop-close" title="Close (Esc)">✕</button></div>`;

  function closePopup() {
    popupDocked = false;
    popupEl.classList.remove('crpy-docked');
    clearTimeout(hideTimer);
    popupEl.hidden = true;
    popupWord = null;
    popupPinned = false;
    lastKey = '';
    if (hoverPaused && video && !api.holdPause) video.play().catch(() => {});
    hoverPaused = false;
  }

  // Drag `el` by pointer from a handle; positions are relative to the overlay root.
  // While dragging, the pointer leaves the popup all the time: `dragging` stops that
  // from closing it.
  let dragging = false;
  function startDrag(e, el, onMove, onEnd) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    clearTimeout(hideTimer);
    const rr = root.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const dx = e.clientX - er.left, dy = e.clientY - er.top;
    const handle = e.target;
    handle.setPointerCapture?.(e.pointerId);
    const move = ev => {
      const left = Math.max(0, Math.min(ev.clientX - rr.left - dx, rr.width - er.width));
      const top = Math.max(0, Math.min(ev.clientY - rr.top - dy, rr.height - 40));
      onMove(left, top);
    };
    const up = () => {
      dragging = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      onEnd();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }

  async function showPopup(wordEl) {
    clearTimeout(hideTimer);
    const word = wordEl.dataset.w;
    popupWord = { word, py: wordEl.dataset.py, el: wordEl, line: lineTextOf(wordEl) };
    popupPinned = true;
    popupStack = [];
    if (view.pauseOnHover && video && !video.paused) { video.pause(); hoverPaused = true; }

    popupEl.innerHTML = `${popupHead(word, popupWord.py, true)}<div class="crpy-pop-body">…</div>`;
    popupEl.hidden = false;
    placePopup(wordEl);

    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'lookup', word, py: popupWord.py });
    } catch (e) {
      // The extension was reloaded or updated while this tab stayed open.
      popupEl.querySelector('.crpy-pop-body').innerHTML =
        '<div class="crpy-pop-entry">Xiaopin was updated. Refresh this page to look up words again.</div>';
      return;
    }
    if (!popupWord || popupWord.word !== word || !res) return;
    popupWord.entries = res.entries;
    popupWord.chars = res.chars;
    popupEl.querySelector('.crpy-pop-body').innerHTML = popupBody(res);
    addFeatureSections(popupEl.querySelector('.crpy-pop-body'), word);
    placePopup(wordEl);
  }

  // Extra popup sections from features (sync html or a Promise of html).
  function addFeatureSections(body, word) {
    const info = popupWord;
    for (const f of features) {
      if (!f.popup) continue;
      let out;
      try { out = f.popup(word, info, api); } catch (e) { continue; }
      if (!out) continue;
      const sec = document.createElement('div');
      sec.className = 'crpy-feat-sec';
      sec.dataset.f = f.id;
      if (f.popupFirst) body.prepend(sec); else body.appendChild(sec);
      const fill = html => {
        if (!html || popupWord !== info) { if (!html) sec.remove(); return; }
        sec.innerHTML = html;
        callFeatures('onPopupRendered', sec, word, api);
        if (popupWord) placePopup(popupWord.el);
      };
      if (typeof out.then === 'function') { sec.innerHTML = '<span class="crpy-muted">…</span>'; out.then(fill, () => sec.remove()); }
      else fill(out);
    }
  }

  const shortDef = s => String(s || '').split(/[;,]/)[0].trim();

  // CC-CEDICT entries are written for dictionary users: drop the numbered-pinyin
  // cross references and traditional|simplified pairs, and keep the first few senses.
  function tidyDef(def) {
    const senses = String(def || '')
      .replace(/\s*\[[a-zü:]+\d(?:\s+[a-zü:]+\d)*\]/gi, '')
      .replace(/[\p{Script=Han}·]+\|([\p{Script=Han}·]+)/gu, '$1')
      .split(';')
      .map(s => s.trim())
      .filter(s => s && !/^also pr\.|^also written|^variant of|^old variant/i.test(s))
      .map(s => (s.length > 70 ? s.slice(0, 68).replace(/\s+\S*$/, '') + '…' : s));
    return senses.slice(0, 4).join('; ') + (senses.length > 4 ? '; …' : '');
  }

  // Meanings of the word, then how each character is built from simpler parts.
  function popupBody({ entries, chars }) {
    let html = entries.length
      ? entries.slice(0, 3).map(e => `<div class="crpy-pop-entry"><b>${esc(e[0])}</b> ${esc(tidyDef(e[1]))}</div>`).join('')
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
    popupEl.innerHTML = `${popupHead(char, py, false)}<div class="crpy-pop-body">${popupBody(res)}</div>`;
    addFeatureSections(popupEl.querySelector('.crpy-pop-body'), char);
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

  // Above the word when it fits, else on the side with more room. The popup never
  // leaves the player: when it is taller than the room it scrolls inside itself.
  function placePopup(wordEl) {
    const M = 8, GAP = 10;
    const rr = root.getBoundingClientRect();
    if (uiPos.popup) {
      // The user put it somewhere: keep it there, inside the player.
      const top = Math.max(M, Math.min(uiPos.popup.top, rr.height - 120));
      popupEl.style.maxHeight = (rr.height - top - M) + 'px';
      const pr = popupEl.getBoundingClientRect();
      popupEl.style.left = Math.max(M, Math.min(uiPos.popup.left, rr.width - pr.width - M)) + 'px';
      popupEl.style.top = top + 'px';
      return;
    }
    const wr = wordEl.getBoundingClientRect();
    const above = wr.top - rr.top - GAP - M;
    const below = rr.bottom - wr.bottom - GAP - M;
    popupEl.style.maxHeight = '';
    const natural = popupEl.scrollHeight;
    const useAbove = natural <= above || above >= below;
    const room = Math.max(120, useAbove ? above : below);
    popupEl.style.maxHeight = Math.min(natural, room, rr.height - 2 * M) + 'px';
    const pr = popupEl.getBoundingClientRect();
    let left = wr.left - rr.left + wr.width / 2 - pr.width / 2;
    left = Math.max(M, Math.min(left, rr.width - pr.width - M));
    let top = useAbove ? wr.top - rr.top - GAP - pr.height : wr.bottom - rr.top + GAP;
    top = Math.max(M, Math.min(top, rr.height - pr.height - M));
    popupEl.style.left = left + 'px';
    popupEl.style.top = top + 'px';
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (dragging) return;
    if (popupDocked) {
      // A docked popup stays open, but the subtitles and the video carry on.
      popupPinned = false;
      lastKey = '';
      if (hoverPaused && video && !api.holdPause) video.play().catch(() => {});
      hoverPaused = false;
      return;
    }
    hideTimer = setTimeout(() => {
      popupEl.hidden = true;
      popupWord = null;
      popupPinned = false;
      lastKey = '';
      // A feature (e.g. the explain card) may be holding the pause.
      if (hoverPaused && video && !api.holdPause) { video.play().catch(() => {}); }
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
    if (e.key === 'Escape' && popupWord && !popupEl.hidden) { closePopup(); return; }
    const k = e.key.toLowerCase();
    if (k === 'h') {
      e.preventDefault(); e.stopPropagation();
      setLayout(LAYOUTS[(LAYOUTS.indexOf(layoutMode()) + 1) % LAYOUTS.length]);
      return;
    }
    for (const f of features) {
      if (f.keys && typeof f.keys[k] === 'function') {
        e.preventDefault(); e.stopPropagation();
        try { f.keys[k](api); } catch (err) { console.warn(err); }
        return;
      }
    }
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
        <div class="crpy-seg" role="group" aria-label="Where subtitles show (H)" title="Where subtitles show (H). Off is for this video only.">
          <button data-a="layout" data-v="off" title="Off for this video: nothing shown, nothing translated">Off</button>
          <button data-a="layout" data-v="video">Video</button>
          <button data-a="layout" data-v="history"><span class="crpy-btn-ic">史</span>History</button>
          <button data-a="layout" data-v="both">Both</button>
        </div>
        <span class="crpy-feat-toolbar"></span>
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
        <div class="crpy-row crpy-lang-row">Turn on by itself
          <span class="crpy-seg" role="group" aria-label="When Xiaopin turns on by itself">
            <button data-a="auto" data-v="chinese" title="Videos with Chinese captions, Chinese audio or Chinese subtitles">Chinese videos</button>
            <button data-a="auto" data-v="always">Always</button>
            <button data-a="auto" data-v="manual" title="Only on videos where you choose Video, History or Both">Never</button>
          </span></div>
        <div class="crpy-row crpy-lang-row">Extra line
          <span class="crpy-seg" role="group" aria-label="Extra subtitle line">
            <button data-a="extra" data-v="">Off</button>
            <button data-a="extra" data-v="nl">Nederlands</button>
          </span></div>
        <div class="crpy-row crpy-lang-row">Explanations in
          <span class="crpy-seg" role="group" aria-label="Language of explanations">
            <button data-a="lang" data-v="en">English</button>
            <button data-a="lang" data-v="nl">Nederlands</button>
          </span></div>
        <div class="crpy-sec">Study</div>
        ${sw('pauseOnHover', 'Pause while reading a word')}
        ${sw('showHistory', 'History panel')}
        ${sw('hideNative', 'Hide the site\'s own subtitles')}
        ${featureSettings.length ? `<div class="crpy-sec">Learning tools</div>${featureSettings.map(s => sw(s.key, esc(s.label))).join('')}` : ''}
        <div class="crpy-feat-panel"></div>
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

    // Drag the popup by its header (it then stays open) and the history panel by its header.
    // Two quick presses on a header reset it. (Detected here: preventing the default on
    // pointerdown, which dragging needs, also stops the browser's own dblclick.)
    let lastPress = { el: null, at: 0 };
    root.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      const head = e.target.closest('.crpy-pop-head, .crpy-hist-head');
      if (!head) return;
      const now = Date.now();
      const isDouble = lastPress.el === head && now - lastPress.at < 400;
      lastPress = { el: head, at: now };
      if (isDouble) {
        e.preventDefault();
        resetPosition(head.classList.contains('crpy-pop-head') ? 'popup' : 'history');
        return;
      }
      if (e.target.closest('.crpy-pop-head')) {
        // Dock right away, so the popup stays open during and after the drag.
        popupDocked = true;
        popupEl.classList.add('crpy-docked');
        startDrag(e, popupEl, (left, top) => {
          popupEl.style.left = left + 'px';
          popupEl.style.top = top + 'px';
        }, () => {
          uiPos.popup = { left: parseFloat(popupEl.style.left), top: parseFloat(popupEl.style.top) };
          popupDocked = true;
          popupEl.classList.add('crpy-docked');
          saveUiPos();
        });
      } else if (e.target.closest('.crpy-hist-head')) {
        const r = historyEl.getBoundingClientRect();
        if (!uiPos.history) {
          // Leave the dock at the same spot, with a floating size.
          uiPos.history = { left: r.left - root.getBoundingClientRect().left, top: 0, width: 360, height: Math.min(r.height, 360) };
          applyView();
        }
        startDrag(e, historyEl, (left, top) => {
          historyEl.style.left = left + 'px';
          historyEl.style.top = top + 'px';
        }, () => {
          const hr = historyEl.getBoundingClientRect();
          uiPos.history = { left: parseFloat(historyEl.style.left), top: parseFloat(historyEl.style.top), width: hr.width, height: hr.height };
          saveUiPos();
        });
      }
    });
    // The floating history panel can be resized at its corner: remember the size.
    historyEl.addEventListener('pointerup', () => {
      if (!uiPos.history) return;
      const hr = historyEl.getBoundingClientRect();
      if (Math.abs(hr.width - uiPos.history.width) > 2 || Math.abs(hr.height - uiPos.history.height) > 2) {
        uiPos.history = { ...uiPos.history, width: hr.width, height: hr.height };
        saveUiPos();
      }
    });
    // Back to automatic placement (popup) or docked on the right (history).
    function resetPosition(which) {
      if (which === 'popup') {
        uiPos.popup = null;
        popupDocked = false;
        popupEl.classList.remove('crpy-docked');
        saveUiPos();
        if (popupWord) placePopup(popupWord.el);
      } else {
        uiPos.history = null;
        saveUiPos();
        applyView();
      }
    }

    root.addEventListener('change', e => {
      const k = e.target.dataset.k;
      if (k) chrome.storage.sync.set({ [k]: e.target.checked });
    });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); fileInput.value = ''; });
    root.addEventListener('click', e => {
      const la = e.target.closest('[data-la]');
      if (la) {
        const f = features.find(x => x.id === la.dataset.f);
        const line = pairedLines()[+la.dataset.i];
        if (f && f.onLineAction && line) f.onLineAction(la.dataset.la, { ...line, index: +la.dataset.i }, api, la);
        return;
      }
      for (const f of features) {
        try { if (f.onClick && f.onClick(e, api)) return; } catch (err) { console.warn(err); }
      }
      if (e.target.closest('.crpy-pop-close')) return closePopup();
      if (e.target.closest('.crpy-star')) return toggleSave();
      if (e.target.closest('.crpy-back')) return drillBack();
      const drill = e.target.closest('.crpy-part, .crpy-char-c');
      if (drill) return drillInto(drill.dataset.c);
      const item = e.target.closest('.crpy-hist-item');
      if (item && !e.target.closest('.crpy-w')) { video.currentTime = +item.dataset.t + 0.02; return; }
      const a = e.target.dataset.a;
      if (a === 'menu') { panelEl.hidden = !panelEl.hidden; renderPanel(); }
      if (a === 'layout') { const b = e.target.closest('[data-a="layout"]'); setLayout(b.dataset.v); }
      if (a === 'lang') chrome.storage.sync.set({ explainLang: e.target.closest('[data-a="lang"]').dataset.v });
      if (a === 'extra') chrome.storage.sync.set({ extraLang: e.target.closest('[data-a="extra"]').dataset.v });
      if (a === 'auto') chrome.storage.sync.set({ autoMode: e.target.closest('[data-a="auto"]').dataset.v });
      if (a === 'closehist') setLayout('video');
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

  // ---------- plugin API (see features/README.md) ----------

  const api = {
    SITE,
    get st() { return st; },
    get video() { return video; },
    get view() { return view; },
    get root() { return root; },
    get popup() { return popupWord; },
    get vocab() { return vocab; },
    setView: (key, value) => chrome.storage.sync.set({ [key]: value }),
    pairedLines,
    lineIndexAt,
    refresh: refreshAll,
    rerenderLines: () => { lastKey = ''; },
    setStatus,
    esc,
    pySpans,
    toneOf,
    zhHtml,
    segmentsOf,
    // True once the dictionary split of this line has arrived (segmentsOf until then
    // returns a rougher fallback split; onChange fires again when it lands).
    isSegmented: text => segCache.has(text),
    videoTitle,
    lookup: (word, py) => chrome.runtime.sendMessage({ type: 'lookup', word, py }),
    send: msg => chrome.runtime.sendMessage(msg),
    seek: t => { if (video) video.currentTime = t; },
    // Set by a feature that paused the video itself, so the core doesn't resume it.
    holdPause: false,
    placePopup: () => { if (popupWord) placePopup(popupWord.el); },
  };

  window.Xiaopin = {
    api,
    register(f) {
      if (!f || !f.id || features.some(x => x.id === f.id)) return;
      features.push(f);
      for (const s of f.settings || []) {
        if (s.key in VIEW_DEFAULTS) continue;
        VIEW_DEFAULTS[s.key] = s.default;
        view[s.key] = s.default;
        featureSettings.push(s);
        chrome.storage.sync.get(s.key).then(v => { if (s.key in v) { view[s.key] = v[s.key]; applyView(); } });
      }
      try { f.init && f.init(api); } catch (e) { console.warn(`[xiaopin] ${f.id}.init`, e); }
      // A feature that arrives after the UI was built: rebuild it so its settings show.
      if (root) { root.remove(); root = null; }
      refreshAll();
    },
  };

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
