// Pronunciation: hear the word (or a whole line, slowly) with the browser's own
// Mandarin voice, see the pitch curve of every syllable, and get told when a tone
// changes in speech (3rd + 3rd tone). Free and local: no AI calls.
(() => {
  if (!window.Xiaopin) return;

  const TEXT = {
    en: {
      play: 'Listen', slow: 'Slowly', spoken: 'Spoken as',
      sandhi: 'Two 3rd tones in a row: the first one is said as a 2nd tone.',
      novoice: 'No Mandarin voice found in this browser. Chrome needs to be online for its Google voices; on Windows you can also add the Chinese (Simplified) speech pack in Settings → Time & language → Speech.',
      tones: {
        1: '1st tone: high and level, like singing one note',
        2: '2nd tone: rising, like asking "huh?"',
        3: '3rd tone: low and dipping (in fast speech often just low)',
        4: '4th tone: short, falling sharply, like "No!"',
        5: 'Neutral tone: short and light',
      },
    },
    nl: {
      play: 'Luisteren', slow: 'Langzaam', spoken: 'Uitgesproken als',
      sandhi: 'Twee keer een 3e toon achter elkaar: de eerste zeg je als een 2e toon.',
      novoice: 'Geen Mandarijn-stem gevonden in deze browser. Chrome moet online zijn voor de Google-stemmen; op Windows kun je ook het spraakpakket Chinees (vereenvoudigd) toevoegen via Instellingen → Tijd en taal → Spraak.',
      tones: {
        1: '1e toon: hoog en vlak, alsof je één noot zingt',
        2: '2e toon: stijgend, zoals een vraag "hè?"',
        3: '3e toon: laag en dalend-stijgend (in snelle spraak vaak gewoon laag)',
        4: '4e toon: kort en scherp dalend, zoals "Nee!"',
        5: 'Neutrale toon: kort en licht',
      },
    },
  };
  const tx = api => TEXT[api.view.explainLang] || TEXT.en;

  // ---------- speech ----------

  let voice = null;
  function pickVoice() {
    const all = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    const zh = all.filter(v => /^zh[-_]?(CN|Hans)?/i.test(v.lang) && !/HK|TW|yue/i.test(v.lang + v.name));
    // Google's online voices sound best; then any mainland Mandarin voice.
    voice = zh.find(v => /google/i.test(v.name)) || zh.find(v => /zh[-_]CN/i.test(v.lang)) || zh[0] || null;
    return voice;
  }
  if (window.speechSynthesis) {
    pickVoice();
    speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
  }

  function speak(text, rate = 0.9) {
    if (!window.speechSynthesis || !text) return false;
    if (!voice) pickVoice();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (voice) u.voice = voice;
    u.rate = rate;
    speechSynthesis.speak(u);
    return !!voice;
  }

  // ---------- tones ----------

  const MARKS = ['', 'āēīōūǖ', 'áéíóúǘ', 'ǎěǐǒǔǚ', 'àèìòùǜ'];
  function toneOf(s) {
    for (let t = 1; t <= 4; t++) if ([...s].some(c => MARKS[t].includes(c))) return t;
    return 5;
  }
  // Same syllable with another tone mark (for showing the spoken form).
  function withTone(s, to) {
    const from = toneOf(s);
    if (from === 5) return s;
    return [...s].map(c => {
      const i = MARKS[from].indexOf(c);
      return i >= 0 ? MARKS[to][i] : c;
    }).join('');
  }

  // 3rd-tone sandhi inside a word: every 3rd tone directly before another 3rd tone
  // is said as a 2nd tone (the common simplification of the rule).
  function spokenTones(tones) {
    return tones.map((t, i) => (t === 3 && tones[i + 1] === 3 ? 2 : t));
  }

  // Pitch on the 1–5 scale (Chao tone letters): 1 = 55, 2 = 35, 3 = 214, 4 = 51.
  const CONTOUR = { 1: [5, 5], 2: [3, 5], 3: [2, 1, 4], 4: [5, 1] };
  function contourSvg(tone) {
    const y = lvl => 22 - (lvl - 1) * 5;
    const grid = [1, 2, 3, 4, 5].map(l => `<line x1="2" x2="30" y1="${y(l)}" y2="${y(l)}" class="crpy-pr-grid"/>`).join('');
    let mark;
    if (tone === 5) {
      mark = `<circle cx="16" cy="${y(3)}" r="3" class="crpy-pr-dot crpy-t5"/>`;
    } else {
      const pts = CONTOUR[tone];
      const step = 24 / (pts.length - 1);
      mark = `<polyline points="${pts.map((l, i) => `${4 + i * step},${y(l)}`).join(' ')}" class="crpy-pr-line crpy-t${tone}"/>`;
    }
    return `<svg class="crpy-pr-svg" viewBox="0 0 32 26" aria-hidden="true">${grid}${mark}</svg>`;
  }

  // ---------- popup section ----------

  function sectionHtml(word, py, api) {
    const T = tx(api);
    const { esc } = api;
    const hanzi = [...word].filter(c => /\p{Script=Han}/u.test(c));
    let syl = String(py || '').split(/\s+/).filter(Boolean);
    if (syl.length !== hanzi.length && typeof pinyinPro !== 'undefined') {
      syl = pinyinPro.pinyin(hanzi.join(''), { type: 'array' });
    }
    if (!syl.length) return '';
    const tones = syl.map(toneOf);
    const spoken = spokenTones(tones);
    const changed = spoken.some((t, i) => t !== tones[i]);

    const cells = syl.map((s, i) => `
      <div class="crpy-pr-cell" title="${esc(T.tones[spoken[i]])}">
        ${contourSvg(spoken[i])}
        <span class="crpy-pr-han">${esc(hanzi[i] || '')}</span>
        <span class="crpy-py crpy-t${spoken[i]}">${esc(withTone(s, spoken[i]))}</span>
      </div>`).join('');
    const uniq = [...new Set(spoken)].sort();
    return `<div class="crpy-pr">
      <div class="crpy-pr-row">
        <button class="crpy-pr-btn" data-pr="play" data-text="${esc(word)}" title="${esc(T.play)} (P)">🔊 ${esc(T.play)}</button>
        <button class="crpy-pr-btn" data-pr="slow" data-text="${esc(word)}">🐢 ${esc(T.slow)}</button>
      </div>
      <div class="crpy-pr-cells">${cells}</div>
      ${changed ? `<div class="crpy-pr-sandhi">${esc(T.spoken)} <b>${syl.map((s, i) => `<span class="crpy-py crpy-t${spoken[i]}">${esc(withTone(s, spoken[i]))}</span>`).join(' ')}</b> · ${esc(T.sandhi)}</div>` : ''}
      <ul class="crpy-pr-tones">${uniq.map(t => `<li><span class="crpy-pr-num crpy-t${t}">${t === 5 ? '·' : t}</span>${esc(T.tones[t])}</li>`).join('')}</ul>
      <div class="crpy-pr-novoice" hidden>${esc(T.novoice)}</div>
    </div>`;
  }

  function play(btn, rate) {
    const ok = speak(btn.dataset.text, rate);
    const sec = btn.closest('.crpy-pr');
    const warn = sec && sec.querySelector('.crpy-pr-novoice');
    if (warn) warn.hidden = ok;
  }

  Xiaopin.register({
    id: 'pronounce',
    popupFirst: true,
    settings: [{ key: 'pronounceOn', label: 'Pronunciation in word popup', default: true }],

    popup(word, info, api) {
      if (!api.view.pronounceOn || !/\p{Script=Han}/u.test(word)) return '';
      // A drilled-into character has no sentence pinyin: computed in sectionHtml.
      return sectionHtml(word, word === info.word ? info.py : '', api);
    },

    lineActions: [{ id: 'listen', label: '听', title: 'Listen to this line, slowly' }],
    onLineAction(id, line) {
      if (id === 'listen') speak(line.zh, 0.75);
    },

    onClick(e) {
      const b = e.target.closest && e.target.closest('[data-pr]');
      if (!b) return false;
      play(b, b.dataset.pr === 'slow' ? 0.55 : 0.9);
      return true;
    },

    keys: {
      // P: say the word in the open popup, else the line being spoken now.
      p: api => {
        if (api.popup) return speak(api.popup.word, 0.9);
        const v = api.video;
        if (!v) return;
        const lines = api.pairedLines();
        const i = api.lineIndexAt(lines, v.currentTime);
        if (i >= 0 && lines[i].zh) speak(lines[i].zh, 0.75);
      },
    },
  });
})();
