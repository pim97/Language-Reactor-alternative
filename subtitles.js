// Subtitle parsing (.ass/.ssa and .srt) into [{start, end, text}] cues, times in seconds.
const CrpySubs = (() => {
  function assTime(s) {
    const m = /(\d+):(\d+):(\d+)[.:](\d+)/.exec(s.trim());
    if (!m) return NaN;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +('0.' + m[4]);
  }

  function srtTime(s) {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s.trim());
    if (!m) return NaN;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  }

  function cleanAss(text) {
    return text
      .replace(/\{[^}]*\}/g, '')      // override tags like {\i1} or {\pos(…)}
      .replace(/\\[Nn]/g, '\n')
      .replace(/\\h/g, ' ')
      .trim();
  }

  // Styles that are on-screen signs, karaoke or song lyrics rather than dialogue.
  const NON_DIALOGUE_STYLE = /sign|song|op|ed|karaoke|title|note|insert|lyric/i;

  function parseAss(raw) {
    const cues = [];
    let fmt = null;
    let inEvents = false;
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('[')) { inEvents = /^\[events\]$/i.test(t); continue; }
      if (!inEvents) continue;
      if (/^format:/i.test(t)) {
        fmt = t.slice(7).split(',').map(s => s.trim().toLowerCase());
        continue;
      }
      if (!/^dialogue:/i.test(t) || !fmt) continue;
      const body = t.slice(t.indexOf(':') + 1);
      const parts = [];
      let rest = body;
      for (let i = 0; i < fmt.length - 1; i++) {
        const c = rest.indexOf(',');
        if (c < 0) break;
        parts.push(rest.slice(0, c));
        rest = rest.slice(c + 1);
      }
      parts.push(rest);
      const get = k => parts[fmt.indexOf(k)] || '';
      const style = get('style').trim();
      const rawText = get('text');
      // Positioned lines are almost always signs, not spoken dialogue.
      if (/\\pos\(|\\move\(/.test(rawText)) continue;
      const text = cleanAss(rawText);
      if (!text) continue;
      cues.push({
        start: assTime(get('start')),
        end: assTime(get('end')),
        text,
        style,
        sign: NON_DIALOGUE_STYLE.test(style) && !/^default|main|dialog/i.test(style),
      });
    }
    return finish(cues.filter(c => !c.sign));
  }

  function parseSrt(raw) {
    const cues = [];
    for (const block of raw.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n').filter(Boolean);
      const ti = lines.findIndex(l => l.includes('-->'));
      if (ti < 0) continue;
      const [a, b] = lines[ti].split('-->');
      const text = lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{[^}]*\}/g, '').trim();
      if (text) cues.push({ start: srtTime(a), end: srtTime(b), text });
    }
    return finish(cues);
  }

  // YouTube timedtext json3: {events: [{tStartMs, dDurationMs, segs: [{utf8}]}]}
  function parseJson3(data) {
    const cues = [];
    for (const ev of data.events || []) {
      if (!ev.segs || ev.aAppend) continue;
      const text = ev.segs.map(s => s.utf8 || '').join('').trim();
      if (!text) continue;
      const start = (ev.tStartMs || 0) / 1000;
      cues.push({ start, end: start + (ev.dDurationMs || 0) / 1000, text });
    }
    // Auto-generated captions roll on; stop each line when the next one starts.
    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) cues[i].end = cues[i + 1].start;
    }
    return finish(cues);
  }

  function finish(cues) {
    return cues
      .filter(c => isFinite(c.start) && isFinite(c.end) && c.end > c.start)
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, text }, i) => ({ id: i, start, end, text }));
  }

  function parse(raw, nameHint = '') {
    if (/\[events\]/i.test(raw) || /\.(ass|ssa)$/i.test(nameHint)) return parseAss(raw);
    return parseSrt(raw);
  }

  // All cues active at time t (cues are sorted by start).
  function activeAt(cues, t) {
    const out = [];
    for (const c of cues) {
      if (c.start > t) break;
      if (c.end > t) out.push(c);
    }
    return out;
  }

  return { parse, parseAss, parseSrt, parseJson3, activeAt };
})();
