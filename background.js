// Service worker: fetches subtitle files (no CORS limits here) and runs translations.

const DEFAULTS = {
  provider: 'openrouter',            // 'openrouter' | 'anthropic'
  openrouterKey: '',
  openrouterModel: 'anthropic/claude-haiku-5.5',
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
};

const FIRST_CHUNK = 12;  // small first batch so the current scene is ready in ~2s
const CHUNK = 40;        // lines per request after that
const PARALLEL = 4;      // requests in flight

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'fetchText') {
    fetch(msg.url)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(text => reply({ ok: true, text }), e => reply({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'openOptions') chrome.runtime.openOptionsPage();
  if (msg.type === 'segment') {
    dict().then(d => reply({ segs: msg.texts.map(t => segment(d, t)) }), () => reply({ segs: [] }));
    return true;
  }
  if (msg.type === 'lookup') {
    lookup(msg.word, msg.py).then(reply, () => reply({ entries: [], chars: [] }));
    return true;
  }
});

// CC-CEDICT (CC BY-SA 4.0, mdbg.net), as {word: [[pinyin, meanings], …]}.
let dictPromise = null;
function dict() {
  dictPromise ||= fetch(chrome.runtime.getURL('lib/cedict.json')).then(r => r.json());
  return dictPromise;
}

// ---------- word segmentation ----------
// Splits a line into dictionary words: of all ways to cut each run of Chinese
// characters into CC-CEDICT words (or single characters), take the one with the
// fewest words, and among those the fewest loose single characters
// (研究生命 → 研究 / 生命, not 研究生 / 命).

const MAX_WORD = 6;

// Long entries that are just two ordinary words (昨天晚上 = 昨天 + 晚上) are split,
// so the learner meets the building blocks; idioms (成语) stay whole.
const wordCache = new Map();
function isWord(d, w) {
  if (w.length < 2) return false;
  if (wordCache.has(w)) return wordCache.get(w);
  let ok = !!d[w];
  if (ok && w.length >= 4 && !d[w].some(e => /idiom/i.test(e[1]))) {
    for (let k = 2; k <= w.length - 2; k++) {
      if (d[w.slice(0, k)] && d[w.slice(k)]) { ok = false; break; }
    }
  }
  wordCache.set(w, ok);
  return ok;
}

function segmentRun(d, run) {
  const n = run.length;
  const cost = new Array(n + 1).fill(Infinity);
  const cut = new Array(n + 1).fill(0);
  cost[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let len = 1; len <= Math.min(MAX_WORD, i); len++) {
      const w = run.slice(i - len, i);
      if (len > 1 && !isWord(d, w)) continue;
      const c = cost[i - len] + 100 + (len === 1 ? 1 : 0);
      if (c < cost[i]) { cost[i] = c; cut[i] = len; }
    }
  }
  const out = [];
  for (let i = n; i > 0; i -= cut[i]) out.unshift(run.slice(i - cut[i], i));
  return out;
}

function segment(d, text) {
  const out = [];
  // Runs of Chinese characters are segmented; everything else passes through.
  for (const part of text.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) || []) {
    if (HAN.test(part)) out.push(...segmentRun(d, part));
    else out.push(part);
  }
  return out;
}

// Make Me a Hanzi dictionary.txt (LGPL-3.0): per character
// [definition, pinyin, decomposition (IDS), radical, etymology type, hint, semantic part, phonetic part].
let hanziPromise = null;
function hanzi() {
  hanziPromise ||= fetch(chrome.runtime.getURL('lib/hanzi.json')).then(r => r.json());
  return hanziPromise;
}

const HAN = /\p{Script=Han}/u;
const IDS = /[⿰-⿿？]/g;   // ⿰ ⿱ … layout markers and "unknown part"

// py: the word's pinyin as read in the sentence ("jiǎn dān"), to pick the right reading.
async function lookup(word, py = '') {
  const [d, h] = await Promise.all([dict(), hanzi()]);
  const entries = d[word] || [];
  const readings = py.split(/\s+/);
  const short = (c, want = '') => {
    const all = d[c] || [];
    const usable = all.filter(e => !/^(surname|old variant|variant of|used in)/i.test(e[1]));
    const ce = usable.find(e => e[0] === want) || all.find(e => e[0] === want) || usable[0] || all[0];
    const hz = h[c];
    return { py: ce?.[0] || hz?.[1] || '', def: ce?.[1] || hz?.[0] || '' };
  };
  // How each character is built from simpler parts.
  const hanChars = [...word].filter(c => HAN.test(c));
  const chars = [...new Set(hanChars)].map(char => {
    const want = readings[hanChars.indexOf(char)] || '';
    const hz = h[char] || [];
    const [, , decomp = '', radical = '', type = '', hint = '', semantic = '', phonetic = ''] = hz;
    const parts = [...new Set([...decomp.replace(IDS, '')])].filter(p => p !== char)
      .map(c => ({ c, ...short(c), role: c === semantic ? 'meaning' : c === phonetic ? 'sound' : '' }));
    return { char, ...short(char, want), parts, radical, type, hint };
  });
  return { entries, chars };
}

// Translation runs over a port so the page gets progress as chunks finish, and can
// tell us where the viewer is so the lines about to be shown are translated first.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'translate') return;
  const job = { from: 0, closed: false };
  port.onDisconnect.addListener(() => { job.closed = true; });
  port.onMessage.addListener(async msg => {
    if (msg.type === 'prioritize') { job.from = msg.fromId; return; }
    if (msg.type !== 'start') return;
    job.from = msg.fromId || 0;
    try {
      await translateEpisode(msg, job, upd => { if (!job.closed) port.postMessage(upd); });
    } catch (e) {
      if (!job.closed) port.postMessage({ type: 'error', error: String(e.message || e) });
    }
  });
});

async function translateEpisode({ mediaId, title, lines, force, direction = 'en2zh' }, job, send) {
  const s = await settings();
  const key = s.provider === 'anthropic' ? s.anthropicKey : s.openrouterKey;
  const model = s.provider === 'anthropic' ? s.anthropicModel : s.openrouterModel;
  if (!key) throw new Error('No API key set. Click the extension icon to add one.');

  // One saved translation per episode, kept whatever model made it. "Translate again"
  // (force) starts from scratch and overwrites it.
  const cacheKey = direction === 'zh2en' ? `tren:${mediaId}` : `tr:${mediaId}`;
  const cached = force ? {} : direction === 'zh2en'
    ? ((await chrome.storage.local.get(cacheKey))[cacheKey] || {})
    : await loadCached(mediaId);
  send({ type: 'progress', results: cached, done: Object.keys(cached).length, total: lines.length });

  const results = { ...cached };
  const pending = new Map(lines.filter(l => !(l.id in cached)).map(l => [l.id, l]));
  let first = true;

  // Next batch: untranslated lines from the viewer's position onward, wrapping to the start.
  function takeChunk() {
    const size = first ? FIRST_CHUNK : CHUNK;
    first = false;
    const ids = [...pending.keys()].sort((a, b) => a - b);
    const ordered = ids.filter(id => id >= job.from).concat(ids.filter(id => id < job.from));
    const chunk = ordered.slice(0, size).map(id => pending.get(id));
    for (const l of chunk) pending.delete(l.id);
    return chunk;
  }

  async function worker() {
    while (pending.size && !job.closed) {
      const chunk = takeChunk();
      let out;
      try {
        out = await translateChunk(s.provider, key, model, title, chunk, direction);
      } catch (e) {
        out = await translateChunk(s.provider, key, model, title, chunk, direction);   // one retry
      }
      Object.assign(results, out);
      await chrome.storage.local.set({ [cacheKey]: results });
      send({ type: 'progress', results: out, done: Object.keys(results).length, total: lines.length });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  send({ type: 'done', done: Object.keys(results).length, total: lines.length });
}

async function loadCached(mediaId) {
  const key = `tr:${mediaId}`;
  const own = (await chrome.storage.local.get(key))[key];
  if (own) return own;
  // Older versions saved per provider/model as tr:<id>:<provider>:<model>.
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter(k => k.startsWith(key + ':'));
  if (!old.length) return {};
  const merged = Object.assign({}, ...old.map(k => all[k]));
  await chrome.storage.local.set({ [key]: merged });
  await chrome.storage.local.remove(old);
  return merged;
}

const SYSTEM = `You translate English anime subtitles into natural spoken Mandarin Chinese (Simplified characters) for a learner who reads along while listening to the Mandarin audio.
- The show is usually a Chinese production; the English is itself a translation. Reconstruct what the characters most likely said in Mandarin: colloquial, natural dialogue, not stiff literal translation.
- Write character names in Chinese characters, using their original Chinese names where you know them.
- Keep each line short like a subtitle. Use Chinese punctuation. No pinyin, no explanations.
- Return every id exactly once.`;

const SYSTEM_ZH2EN = `You translate Mandarin Chinese video subtitles into natural English for a learner who reads the Chinese and pinyin alongside.
- Stay close to the meaning of the Chinese so the learner can map words, but write natural English.
- Keep each line short like a subtitle. No explanations, no pinyin.
- Put the English in the "zh" field of each item (the field name is fixed).
- Return every id exactly once.`;

const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, zh: { type: 'string' } },
        required: ['id', 'zh'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

async function translateChunk(provider, key, model, title, chunk, direction) {
  const zh2en = direction === 'zh2en';
  const user = `Video: ${title || 'unknown'}\n\nTranslate these subtitle lines:\n` +
    JSON.stringify(chunk.map(l => ({ id: l.id, [zh2en ? 'zh_source' : 'en']: l.text.replace(/\n/g, ' ') })));
  const system = zh2en ? SYSTEM_ZH2EN : SYSTEM;
  const text = provider === 'anthropic'
    ? await callAnthropic(key, model, system, user)
    : await callOpenRouter(key, model, system, user);
  const parsed = parseJson(text);
  const out = {};
  for (const l of parsed.lines || []) if (typeof l.zh === 'string') out[l.id] = l.zh.trim();
  return out;
}

async function callAnthropic(key, model, system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: user }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${j.error?.message || JSON.stringify(j)}`);
  if (j.stop_reason === 'refusal') throw new Error('Model declined this chunk.');
  return j.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

async function callOpenRouter(key, model, system, user) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + key,
      'x-title': 'Crunchyroll Pinyin Subtitles',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'subtitles', strict: true, schema: SCHEMA } },
    }),
  });
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`OpenRouter ${res.status}: ${j.error?.message || JSON.stringify(j)}`);
  return j.choices?.[0]?.message?.content || '';
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const m = /\{[\s\S]*\}/.exec(text);   // tolerate code fences or stray prose
  if (m) return JSON.parse(m[0]);
  throw new Error('Could not read translation response');
}
