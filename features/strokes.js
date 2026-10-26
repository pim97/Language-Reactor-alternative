// Stroke order in the word popup: each character of the word drawn by Hanzi Writer
// (lib/hanzi-writer.min.js, loaded before this file), with an optional tracing quiz.
// Stroke data is fetched per character through the background (features/strokes-bg.js).
(() => {
  if (!window.Xiaopin) return;

  const HAN = /\p{Script=Han}/u;
  const SIZE = 90;
  const MAX_CHARS = 6;

  let expanded = false;   // remembered between popups
  let quizzing = false;
  let live = [];          // [{ cell, writer }] currently mounted
  const writerOf = new WeakMap();   // cell → writer; html restored by "← back" has none
  const dataCache = new Map();      // char → Promise of stroke data (this page only)
  let frame = 0;

  try {
    chrome.storage.local.get('strokesOpen').then(v => { expanded = !!v.strokesOpen; }, () => {});
  } catch (e) { /* extension reloaded */ }

  const hasLib = () => typeof HanziWriter !== 'undefined' && typeof HanziWriter.create === 'function';

  function load(char, api) {
    if (!dataCache.has(char)) {
      const p = Promise.resolve(api.send({ type: 'strokes.get', char })).then(r => {
        if (r && r.ok && r.data) return r.data;
        throw new Error((r && r.error) || 'No stroke data');
      });
      p.catch(() => dataCache.delete(char));   // try again next time
      dataCache.set(char, p);
      if (dataCache.size > 150) dataCache.delete(dataCache.keys().next().value);
    }
    return dataCache.get(char);
  }

  // Hanzi Writer animates colours itself, so it needs real colour values, not var(--…).
  function colors(api) {
    const cs = api.root ? getComputedStyle(api.root) : null;
    const v = (name, fallback) => (cs && cs.getPropertyValue(name).trim()) || fallback;
    return {
      strokeColor: v('--crpy-text', '#f4f4f7'),
      radicalColor: v('--crpy-accent', '#ff6a55'),
      highlightColor: v('--crpy-en', '#ffe08a'),
      drawingColor: v('--crpy-accent', '#ff6a55'),
      outlineColor: 'rgba(255, 255, 255, 0.14)',
    };
  }

  function stop(item) {
    try { item.writer.cancelQuiz(); item.writer.pauseAnimation(); } catch (e) {}
  }

  function unmountAll() {
    live.forEach(stop);
    live = [];
  }

  function mount(sk, api) {
    if (!hasLib()) return;
    const c = colors(api);
    for (const cell of sk.querySelectorAll('.crpy-sk-cell')) {
      if (writerOf.has(cell)) continue;
      const char = cell.dataset.skc;
      const item = sk.querySelector(`.crpy-sk-n[data-skc="${CSS.escape(char)}"]`);
      cell.innerHTML = '';
      cell.classList.remove('crpy-sk-missing', 'crpy-sk-done');
      let writer;
      try {
        writer = HanziWriter.create(cell, char, {
          width: SIZE,
          height: SIZE,
          padding: 6,
          ...c,
          showOutline: true,
          strokeAnimationSpeed: 1.3,
          delayBetweenStrokes: 220,
          delayBetweenLoops: 1600,
          showHintAfterMisses: 2,
          charDataLoader: (ch, onLoad, onError) => {
            load(ch, api).then(d => {
              if (item) item.textContent = d.strokes.length + (d.strokes.length === 1 ? ' stroke' : ' strokes');
              onLoad(d);
            }, onError);
          },
          onLoadCharDataError: () => {
            cell.classList.add('crpy-sk-missing');
            cell.textContent = char;
            if (item) item.textContent = 'no data';
          },
        });
      } catch (e) {
        console.warn('[xiaopin] strokes', e);
        continue;
      }
      writerOf.set(cell, writer);
      const entry = { cell, writer };
      live.push(entry);
      start(entry);
    }
  }

  function start(entry) {
    const { cell, writer } = entry;
    cell.classList.remove('crpy-sk-done');
    try {
      if (quizzing) {
        Promise.resolve(writer.quiz({ onComplete: () => cell.classList.add('crpy-sk-done') })).catch(() => {});
      } else {
        Promise.resolve(writer.loopCharacterAnimation()).catch(() => {});
      }
    } catch (e) { /* data missing */ }
  }

  function setOpen(sk, api, on) {
    sk.classList.toggle('crpy-sk-open', on);
    if (on) mount(sk, api);
    else {
      live = live.filter(x => { if (sk.contains(x.cell)) { stop(x); return false; } return true; });
      sk.querySelectorAll('.crpy-sk-cell').forEach(cell => { writerOf.delete(cell); cell.innerHTML = ''; });
    }
    syncQuizButton(sk);
    api.placePopup();
  }

  function syncQuizButton(sk) {
    const b = sk.querySelector('[data-sk="quiz"]');
    if (b) {
      b.classList.toggle('crpy-on', quizzing);
      b.textContent = quizzing ? '▶ Watch' : '✎ Trace';
      b.title = quizzing ? 'Show the animation again' : 'Trace each character with the mouse';
    }
    sk.classList.toggle('crpy-sk-quiz', quizzing);
  }

  // The overlay root stops mouseup from bubbling (so the player ignores our clicks), but
  // Hanzi Writer ends a traced stroke on document mouseup. Hand it one directly.
  window.addEventListener('mouseup', e => {
    if (!quizzing || !live.length) return;
    const root = Xiaopin.api.root;
    if (!root || !root.contains(e.target)) return;   // outside the root it reaches document anyway
    document.dispatchEvent(new MouseEvent('mouseup', { clientX: e.clientX, clientY: e.clientY }));
  }, true);

  Xiaopin.register({
    id: 'strokes',

    settings: [{ key: 'strokesOn', label: 'Stroke order in word popup', default: true }],

    popup(word, info, api) {
      if (!api.view.strokesOn || !hasLib()) return '';
      const chars = [...new Set([...String(word || '')].filter(c => HAN.test(c)))].slice(0, MAX_CHARS);
      if (!chars.length) return '';
      const { esc } = api;
      return `<div class="crpy-sk${expanded ? ' crpy-sk-open' : ''}">
        <div class="crpy-sk-bar">
          <button class="crpy-sk-btn" data-sk="toggle" title="Show how the characters are written">✍ Stroke order</button>
          <button class="crpy-sk-btn crpy-sk-quizbtn" data-sk="quiz">✎ Trace</button>
        </div>
        <div class="crpy-sk-grid">${chars.map(c => `
          <div class="crpy-sk-item">
            <div class="crpy-sk-cell" data-skc="${esc(c)}"></div>
            <div class="crpy-sk-n" data-skc="${esc(c)}"></div>
          </div>`).join('')}
        </div>
      </div>`;
    },

    onPopupRendered(sec, word, api) {
      if (sec.dataset.f !== 'strokes') return;
      unmountAll();   // a new popup replaced the old one
      const sk = sec.querySelector('.crpy-sk');
      if (!sk) return;
      syncQuizButton(sk);
      if (expanded) mount(sk, api);
    },

    onClick(e, api) {
      const b = e.target.closest && e.target.closest('.crpy-sk [data-sk]');
      if (!b) return false;
      const sk = b.closest('.crpy-sk');
      if (b.dataset.sk === 'toggle') {
        expanded = !sk.classList.contains('crpy-sk-open');
        try { chrome.storage.local.set({ strokesOpen: expanded }); } catch (err) {}
        setOpen(sk, api, expanded);
      }
      if (b.dataset.sk === 'quiz') {
        quizzing = !quizzing;
        if (!sk.classList.contains('crpy-sk-open')) {
          expanded = true;
          setOpen(sk, api, true);   // mounts straight into the new mode
        } else {
          syncQuizButton(sk);
          live.filter(x => sk.contains(x.cell)).forEach(x => { stop(x); start(x); });
        }
      }
      return true;
    },

    // Every ~half second: stop writers whose popup closed (they would keep animating),
    // and re-mount after "← back" restored the popup html without live writers.
    tick(t, api) {
      if (++frame % 30) return;
      if (live.length) {
        live = live.filter(x => {
          const on = x.cell.isConnected && !x.cell.closest('.crpy-popup[hidden]');
          if (!on) stop(x);
          return on;
        });
      }
      if (!expanded || !api.root) return;
      const sk = api.root.querySelector('.crpy-popup:not([hidden]) .crpy-sk.crpy-sk-open');
      if (sk && [...sk.querySelectorAll('.crpy-sk-cell')].some(c => !writerOf.has(c))) mount(sk, api);
    },
  });
})();
