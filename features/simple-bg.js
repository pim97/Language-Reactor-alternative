// Plain-language explanation of one word as used in its sentence, in the learner's
// language (English or Dutch). Cached per language, word and sentence.

(() => {
  const PREFIX = 'simple:';

  const LANGS = {
    en: 'English',
    nl: 'Dutch (Nederlands)',
  };

  const system = lang => `You help a Mandarin learner who finds dictionary entries hard to read. Explain ONE Chinese word as it is used in the given sentence.
Write everything in ${LANGS[lang]}, in simple everyday language (about B1 level): short sentences, no jargon. When a grammar term is unavoidable, explain it in plain words.
- "meaning": what the word means here, in 1–5 words.
- "explanation": 1–2 short sentences on what it does in this sentence and when people use it. For particles (的 了 吧 呢 着 过 …) say plainly what they add.
- "memory": one short tip to remember the word or its characters, built on the character parts given (meaning part / sound part) when they help; "" if nothing useful.
Quote Chinese in Simplified characters, pinyin with tone marks.`;

  const SCHEMA = {
    type: 'object',
    properties: {
      meaning: { type: 'string' },
      explanation: { type: 'string' },
      memory: { type: 'string' },
    },
    required: ['meaning', 'explanation', 'memory'],
    additionalProperties: false,
  };

  // cyrb53: short stable hash for the storage key.
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

  XiaopinBg.handle('word.simple', async msg => {
    const word = str(msg.word);
    if (!word) return { error: 'No word' };
    const lang = LANGS[msg.lang] ? msg.lang : 'en';
    const sentence = str(msg.sentence);
    const key = `${PREFIX}${lang}:${word}:${hash(sentence)}`;

    const hit = (await chrome.storage.local.get(key))[key];
    if (hit && hit.word === word && hit.data) return { ok: true, data: hit.data, cached: true };

    const s = await XiaopinBg.settings();
    if (!(s.provider === 'anthropic' ? s.anthropicKey : s.openrouterKey)) return { error: 'nokey', code: 'nokey' };

    // Character parts from Make Me a Hanzi ground the memory tip.
    let parts = '';
    try {
      const res = await XiaopinBg.lookup(word, str(msg.py));
      parts = (res.chars || []).map(c => `${c.char} (${c.py}, ${c.def.split(';')[0]}) = ` +
        (c.parts.map(p => `${p.c}${p.role ? ' [' + p.role + ' part]' : ''} ${p.role === 'sound' ? p.py : (p.def || '').split(';')[0]}`).join(' + ') || '—') +
        (c.hint ? `; hint: ${c.hint}` : '')).join('\n');
    } catch (e) { /* the tip just gets less grounding */ }

    const user = [
      `Word: ${word}${msg.py ? ` (${str(msg.py)})` : ''}`,
      sentence ? `Sentence: ${sentence}` : '',
      msg.en ? `English subtitle of the sentence (may be loose): ${str(msg.en)}` : '',
      parts ? `Character parts:\n${parts}` : '',
    ].filter(Boolean).join('\n');

    let out;
    try {
      out = await XiaopinBg.callModel({ system: system(lang), user, schema: SCHEMA, maxTokens: 600 });
    } catch (e) {
      return { error: String(e.message || e) };
    }
    const data = { meaning: str(out?.meaning), explanation: str(out?.explanation), memory: str(out?.memory) };
    if (!data.meaning && !data.explanation) return { error: 'Empty answer' };
    await chrome.storage.local.set({ [key]: { word, data, at: Date.now() } });
    return { ok: true, data };
  });
})();
