// Stroke order data for Hanzi Writer, one character at a time.
// The data (hanzi-writer-data, Arphic Public License) is not bundled: it is fetched
// from jsDelivr on first use and kept in a small cache.

(() => {
  const DATA_URL = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/';
  const PREFIX = 'strokes:';
  const INDEX_KEY = 'strokesIndex';   // cached characters, oldest first (not under PREFIX on purpose)
  const MAX_STORED = 400;             // ~2–4 KB per character, so at most ~1.5 MB
  const MAX_MEMORY = 200;
  const HAN = /^\p{Script=Han}$/u;

  const memory = new Map();           // char → data (insertion order = age)
  const inFlight = new Map();         // char → Promise, so parallel asks share one fetch
  let indexChain = Promise.resolve(); // index updates run one after another

  function remember(char, data) {
    memory.delete(char);
    memory.set(char, data);
    while (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
  }

  // Add char to the stored index and drop the oldest entries past MAX_STORED.
  function store(char, data) {
    indexChain = indexChain.then(async () => {
      const index = (await chrome.storage.local.get(INDEX_KEY))[INDEX_KEY] || [];
      const next = index.filter(c => c !== char);
      next.push(char);
      const drop = next.splice(0, Math.max(0, next.length - MAX_STORED));
      await chrome.storage.local.set({ [PREFIX + char]: data, [INDEX_KEY]: next });
      if (drop.length) await chrome.storage.local.remove(drop.map(c => PREFIX + c));
    }).catch(e => console.warn('[xiaopin] strokes cache', e));
    return indexChain;
  }

  // Only the fields Hanzi Writer uses; guards against odd responses.
  function clean(j) {
    if (!j || !Array.isArray(j.strokes) || !Array.isArray(j.medians) || !j.strokes.length) return null;
    const out = { strokes: j.strokes.map(String), medians: j.medians };
    if (Array.isArray(j.radStrokes)) out.radStrokes = j.radStrokes.filter(n => Number.isInteger(n));
    return out;
  }

  async function get(char) {
    if (memory.has(char)) return memory.get(char);
    const key = PREFIX + char;
    const saved = (await chrome.storage.local.get(key))[key];
    if (saved) { remember(char, saved); return saved; }
    const res = await fetch(DATA_URL + encodeURIComponent(char) + '.json');
    if (res.status === 404) throw new Error('No stroke data for ' + char);
    if (!res.ok) throw new Error('Stroke data: HTTP ' + res.status);
    const data = clean(await res.json());
    if (!data) throw new Error('No stroke data for ' + char);
    remember(char, data);
    store(char, data);
    return data;
  }

  XiaopinBg.handle('strokes.get', async msg => {
    const char = String(msg.char || '');
    if (!HAN.test(char)) return { error: 'Not a Chinese character' };
    if (!inFlight.has(char)) {
      inFlight.set(char, get(char).finally(() => inFlight.delete(char)));
    }
    try {
      return { ok: true, data: await inFlight.get(char) };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });
})();
