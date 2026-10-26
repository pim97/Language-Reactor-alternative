// Study modes: shadowing (pause after each line), line looping, and English /
// pinyin blurred until you hover them. Hooks: see features/README.md.
(() => {
  if (!window.Xiaopin) return;

  const INF = -1;        // smLoopCount value for "loop forever" (Infinity does not survive storage)
  const TOL = 0.08;      // act this long before a line's end, so the next line's first sound is not heard
  const JUMP = 0.75;     // a bigger forward step between two frames is a seek, not playback
  const JITTER = 0.25;   // small backward steps happen when players re-sync; they are not seeks
  const LOOP_OPTS = [[0, 'Off'], [2, '2×'], [3, '3×'], [5, '5×'], [INF, '∞']];

  let lines = [];               // cached pairedLines(), refreshed in onChange only
  let mediaId = null;
  let loopCount = 0;            // smLoopCount, kept here because it is not a checkbox setting
  let lastT = null, lastVideo = null;
  const pausedAt = new Set();   // lines we already auto-paused at (by key)
  const plays = new Map();      // line key → times played in a row (count loop)
  let loopLine = null;          // line looped forever ("r" / ⟲)
  let rewindOnPlay = null;      // forever loop + auto-pause: replay this line when the user presses play
  let revealTimer = null;
  let ownSeek = null;           // target of the seek we just made, so its 'seeking' event is ignored

  // Indices shift while AI translation fills in lines, so state is keyed by start time.
  const keyOf = l => l.start.toFixed(3);
  const endOf = l => Math.max(l.start, l.end - TOL);

  function seekTo(v, t) {
    ownSeek = t;
    v.currentTime = t;
    lastT = t;   // our own seek: don't treat it as the user jumping back
  }

  // The user moved the playhead (A / S / D, scrubber, history click).
  function userSeek(t, prev, api) {
    if (prev != null && t < prev - JITTER) forgetFrom(t);
    rewindOnPlay = null;
    // Jumping to another line ends a forever loop; S (repeat this line) keeps it.
    if (loopLine) {
      const i = api.lineIndexAt(lines, t);
      if (!lines[i] || keyOf(lines[i]) !== keyOf(loopLine)) stopLoop(api);
    }
  }

  // 'seeking' catches seeks that frame-to-frame time steps cannot tell from playback
  // (e.g. D into an overlapping next line).
  function watchVideo(v, api) {
    v.addEventListener('seeking', () => {
      const t = v.currentTime;
      if (ownSeek != null && Math.abs(t - ownSeek) < 0.05) { ownSeek = null; return; }
      ownSeek = null;
      userSeek(t, lastT, api);
      lastT = t;
    });
  }

  function resetAll() {
    pausedAt.clear(); plays.clear();
    loopLine = null; rewindOnPlay = null; lastT = null;
  }

  // The user went back: lines from here on may pause / loop again.
  function forgetFrom(t) {
    for (const l of lines) {
      if (endOf(l) <= t) continue;
      pausedAt.delete(keyOf(l));
      plays.delete(keyOf(l));
    }
  }

  function startLoop(l, api, seek) {
    loopLine = l;
    rewindOnPlay = null;
    const v = api.video;
    if (v && seek) {
      seekTo(v, l.start + 0.02);
      if (v.paused) Promise.resolve(v.play()).catch(() => {});
    }
    api.refresh();   // toolbar pill + card badge
  }

  function stopLoop(api) {
    if (!loopLine) return;
    loopLine = null;
    rewindOnPlay = null;
    api.refresh();
  }

  function setLoopCount(n, api) {
    loopCount = n;
    api.view.smLoopCount = n;
    plays.clear();
    api.refresh();
  }

  // Playback just reached the end of line l. Returns true when it seeked or paused.
  function onLineEnd(l, v, api) {
    const k = keyOf(l);
    const canPause = api.view.smAutoPause && !api.popup;   // never fight the word popup
    if (loopLine) {
      if (k !== keyOf(loopLine)) return false;              // overlapping lines don't count while looping
      if (canPause) { v.pause(); rewindOnPlay = l; }        // shadow it, then replay on play
      else seekTo(v, l.start + 0.02);
      return true;
    }
    const n = loopCount === INF ? Infinity : loopCount;
    if (n > 1) {
      const c = plays.get(k) || 1;
      if (c < n) { plays.set(k, c + 1); seekTo(v, l.start + 0.02); return true; }
    }
    if (canPause && !pausedAt.has(k)) { pausedAt.add(k); v.pause(); return true; }
    return false;
  }

  function applyClasses(api) {
    const r = api.root;
    if (!r) return;
    r.classList.toggle('crpy-blur-en', !!api.view.smBlurEnglish);
    r.classList.toggle('crpy-blur-py', !!api.view.smBlurPinyin);
  }

  Xiaopin.register({
    id: 'study-modes',

    settings: [
      { key: 'smAutoPause', label: 'Pause after each line', default: false },
      { key: 'smBlurEnglish', label: 'Blur English until hover', default: false },
      { key: 'smBlurPinyin', label: 'Blur pinyin until hover', default: false },
    ],

    init(api) {
      api.view.smLoopCount = loopCount;
      try {
        chrome.storage.sync.get('smLoopCount').then(v => {
          if (typeof v.smLoopCount === 'number') setLoopCount(v.smLoopCount, api);
        });
        // The core only tracks checkbox settings, so follow this one ourselves.
        chrome.storage.onChanged.addListener((ch, area) => {
          if (area === 'sync' && ch.smLoopCount && typeof ch.smLoopCount.newValue === 'number') {
            setLoopCount(ch.smLoopCount.newValue, api);
          }
        });
      } catch (e) {}
      applyClasses(api);
    },

    onView(api) { applyClasses(api); },

    onChange(api) {
      const id = api.st.mediaId;
      if (id !== mediaId) { mediaId = id; resetAll(); }
      lines = api.pairedLines();
      if (loopLine) {
        // Keep looping the same line when lines are rebuilt (translation, segmentation).
        const old = loopLine;
        loopLine = lines.find(l => l.zh === old.zh && l.en === old.en && Math.abs(l.start - old.start) < 3)
          || lines.find(l => l.zh === old.zh && Math.abs(l.start - old.start) < 3) || null;
        if (!loopLine) rewindOnPlay = null;
      }
    },

    tick(t, api) {
      const v = api.video;
      if (!v || !lines.length) { lastT = t; return; }
      if (v !== lastVideo) {
        lastVideo = v; lastT = t;
        try { watchVideo(v, api); } catch (e) {}
        return;
      }
      const prev = lastT;
      lastT = t;
      if (prev == null) return;
      const dt = t - prev;
      if (dt < -JITTER || dt > JUMP) userSeek(t, prev, api);   // fallback when no 'seeking' event came
      if (v.paused) return;
      if (rewindOnPlay) { const l = rewindOnPlay; rewindOnPlay = null; seekTo(v, l.start + 0.02); return; }
      if (dt <= 0 || dt > JUMP) return;
      // Lines whose end we just played through (gaps and overlaps both work this way).
      for (const l of lines) {
        if (l.start > t + 1) break;
        const e = endOf(l);
        if (prev < e && t >= e && onLineEnd(l, v, api)) return;
      }
    },

    onLineRendered(linesEl) {
      if (!loopLine || !linesEl.children.length) return;
      const b = document.createElement('div');
      b.className = 'crpy-sm-badge';
      b.title = 'Looping this line (R to stop)';
      b.textContent = '⟲';
      linesEl.appendChild(b);
    },

    lineActions: [{ id: 'sm-loop', label: '⟲', title: 'Loop this line' }],

    onLineAction(id, line, api) {
      if (id !== 'sm-loop') return;
      const l = lines.find(x => Math.abs(x.start - line.start) < 0.001 && x.zh === line.zh) || lines[line.index] || line;
      startLoop(l, api, true);
    },

    onClick(e, api) {
      const opt = e.target.closest('[data-sm-loop]');
      if (opt) {
        const n = +opt.dataset.smLoop;
        setLoopCount(n, api);
        api.setView('smLoopCount', n);
        return true;
      }
      if (e.target.closest('[data-sm="unloop"]')) { stopLoop(api); return true; }
      return false;
    },

    keys: {
      // Loop the line being spoken (or the one that just ended) until pressed again.
      r(api) {
        if (loopLine) return stopLoop(api);
        const v = api.video;
        if (!v || !lines.length) return;
        const i = api.lineIndexAt(lines, v.currentTime);
        if (i < 0) return;
        startLoop(lines[i], api, v.currentTime >= endOf(lines[i]));
      },
      // Peek at blurred text for a few seconds.
      b(api) {
        const r = api.root;
        if (!r) return;
        r.classList.add('crpy-sm-reveal');
        clearTimeout(revealTimer);
        revealTimer = setTimeout(() => {
          r.classList.remove('crpy-sm-reveal');
          if (api.root) api.root.classList.remove('crpy-sm-reveal');
        }, 3000);
      },
    },

    panel(api) {
      const seg = LOOP_OPTS.map(([n, label]) =>
        `<button data-sm-loop="${n}" class="${n === loopCount ? 'crpy-sm-on' : ''}">${label}</button>`).join('');
      return `<div class="crpy-row crpy-sm-row">Loop each line <span class="crpy-sm-seg">${seg}</span></div>
        <div class="crpy-row"><span class="crpy-hint"><span class="crpy-kbd">R</span> loop this line ·
          <span class="crpy-kbd">B</span> peek at blurred text</span></div>`;
    },

    toolbar() {
      if (!loopLine) return '';
      return '<button class="crpy-btn crpy-on crpy-sm-pill" data-sm="unloop" title="Stop looping (R)">' +
        '<span class="crpy-btn-ic">⟲</span>Looping</button>';
    },
  });
})();
