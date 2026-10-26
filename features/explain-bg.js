// AI explanation of one subtitle line: translation, word-by-word gloss, grammar.
// Answers are cached per Chinese line, so explaining the same line again is free.

(() => {
  const PREFIX = 'explain:';

  const SYSTEM = `You explain one line of Mandarin Chinese video dialogue to an English-speaking learner (roughly HSK 2–5) who is watching the video.
- "translation": natural, idiomatic English for this line in its context (one sentence or two at most).
- "words": every word of the line in order, as a native speaker would segment it (keep set phrases, idioms and names whole; skip punctuation). "pinyin" uses tone marks (nǐ hǎo), syllables separated by spaces, with the reading actually used here (tone sandhi not applied, but 了/的/着 etc. as neutral tone). "meaning" is a short English gloss of the word as used in this line (2–6 words), not a list of dictionary senses.
- "grammar": 0–4 points a learner would not get from the word glosses: sentence patterns, aspect and modal particles (了 过 着 吧 呢 啊 嘛), measure words, resultative or directional complements, 把/被, comparisons, idioms (成语) and slang. "pattern" is the structure in Chinese with a short label (e.g. "V + 得 + adj — degree complement"); "explanation" is 1–2 plain sentences about how it works in this line. Return an empty list when there is nothing worth noting.
- "note": one short sentence on tone, register, politeness or cultural nuance, or "" when there is nothing special.
- Be accurate and concise. Use English for all explanations; quote Chinese in Simplified characters. If the English subtitle given differs from the Chinese, trust the Chinese.`;

  const SCHEMA = {
    type: 'object',
    properties: {
      translation: { type: 'string' },
      words: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            word: { type: 'string' },
            pinyin: { type: 'string' },
            meaning: { type: 'string' },
          },
          required: ['word', 'pinyin', 'meaning'],
          additionalProperties: false,
        },
      },
      grammar: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            pattern: { type: 'string' },
            explanation: { type: 'string' },
          },
          required: ['pattern', 'explanation'],
          additionalProperties: false,
        },
      },
      note: { type: 'string' },
    },
    required: ['translation', 'words', 'grammar', 'note'],
    additionalProperties: false,
  };

  // cyrb53: short stable hash of the line for the storage key.
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  const str = v => (typeof v === 'string' ? v.trim() : '');
  const oneLine = v => str(v).replace(/\s*\n\s*/g, ' ');

  // Keep only well-formed parts of the model's answer, so the page never sees junk.
  function clean(out) {
    const o = out && typeof out === 'object' ? out : {};
    return {
      translation: str(o.translation),
      words: (Array.isArray(o.words) ? o.words : [])
        .map(w => ({ word: str(w?.word), pinyin: str(w?.pinyin), meaning: str(w?.meaning) }))
        .filter(w => w.word),
      grammar: (Array.isArray(o.grammar) ? o.grammar : [])
        .map(g => ({ pattern: str(g?.pattern), explanation: str(g?.explanation) }))
        .filter(g => g.pattern || g.explanation),
      note: str(o.note),
    };
  }

  XiaopinBg.handle('explain.line', async msg => {
    const zh = oneLine(msg.zh);
    if (!zh) return { error: 'No Chinese line to explain' };
    const key = PREFIX + hash(zh);

    if (!msg.force) {
      const hit = (await chrome.storage.local.get(key))[key];
      if (hit && hit.zh === zh && hit.data) return { ok: true, data: hit.data, cached: true };
    }

    const s = await XiaopinBg.settings();
    if (!(s.provider === 'anthropic' ? s.anthropicKey : s.openrouterKey)) {
      return { error: 'Add an API key in settings', code: 'nokey' };
    }

    const user = [
      `Video: ${oneLine(msg.title) || 'unknown'}`,
      msg.prev ? `Previous line: ${oneLine(msg.prev)}` : '',
      `Line to explain: ${zh}`,
      msg.en ? `English subtitle (may be loose): ${oneLine(msg.en)}` : '',
      msg.next ? `Next line: ${oneLine(msg.next)}` : '',
    ].filter(Boolean).join('\n');

    let out;
    try {
      out = await XiaopinBg.callModel({ system: SYSTEM, user, schema: SCHEMA, maxTokens: 2000 });
    } catch (e) {
      return { error: String(e.message || e) };
    }
    const data = clean(out);
    if (!data.translation && !data.words.length) return { error: 'The AI gave an empty answer. Try again.' };
    await chrome.storage.local.set({ [key]: { zh, data, at: Date.now() } });
    return { ok: true, data };
  });

  // For tests.
  self.XiaopinExplain = { hash, clean, SCHEMA };
})();
