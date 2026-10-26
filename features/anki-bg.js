// Anki (background side): talks to the AnkiConnect add-on on 127.0.0.1:8765.
// Runs here and not in the page because the page's origin (crunchyroll.com,
// youtube.com) is not one AnkiConnect trusts; ours is chrome-extension://<id>.
// Replies never throw: { ok: true, … } or { ok: false, code, error }.
(() => {
  const HOSTS = ['http://127.0.0.1:8765', 'http://localhost:8765'];
  const DEFAULT_DECK = 'Xiaopin';
  const WORD_MODEL = 'Xiaopin';
  const SENTENCE_MODEL = 'Xiaopin Sentence';

  // Anki's built-in text-to-speech (https://docs.ankiweb.net/templates/fields.html#text-to-speech).
  // Anki picks the first voice in the list that the OS has, so cards speak on
  // macOS / iOS (Tingting) and Windows (Huihui, Yaoyao) without any recorded audio.
  const VOICES = 'voices=Apple_Tingting,Microsoft_Huihui,Microsoft_Yaoyao';
  const tts = field => `{{tts zh_CN ${VOICES}:${field}}}`;

  // Tone colours (1 red · 2 orange · 3 green · 4 blue · neutral grey), darker for
  // Anki's light mode, the overlay's own colours for night mode.
  const CSS = `
.card {
  font-family: "Inter", "Segoe UI", Roboto, system-ui, sans-serif;
  font-size: 18px;
  line-height: 1.5;
  text-align: center;
  color: #1d1e26;
  background: #fbfaf7;
  padding: 24px 16px;
}
.card.nightMode, .nightMode .card { color: #f4f4f7; background: #15161d; }
.zh { font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Source Han Sans SC", sans-serif; }
.xp-word { font-size: 64px; font-weight: 500; line-height: 1.15; }
.xp-sentence-front { font-size: 32px; line-height: 1.4; max-width: 34em; margin: 0 auto; }
hr#answer { border: none; border-top: 1px solid rgba(127, 127, 127, 0.25); margin: 18px auto; max-width: 30em; }
.xp-py { font-size: 26px; font-weight: 600; margin-bottom: 6px; }
.xp-meaning { font-size: 18px; max-width: 30em; margin: 0 auto 18px; }
.xp-box {
  max-width: 34em;
  margin: 0 auto;
  padding: 14px 18px;
  border-radius: 14px;
  background: rgba(127, 127, 127, 0.08);
}
.xp-sent { font-size: 24px; }
.xp-sent-py { font-size: 15px; font-weight: 600; margin-top: 4px; }
.xp-en { font-size: 16px; font-style: italic; opacity: 0.8; margin-top: 8px; }
.xp-hl { color: #e8553f; font-weight: 700; }
.nightMode .xp-hl { color: #ff6a55; }
.xp-src { display: inline-block; margin-top: 16px; font-size: 13px; opacity: 0.65; color: inherit; }
.t1 { color: #d93a3a; } .t2 { color: #e08600; } .t3 { color: #23934a; } .t4 { color: #2f6fe0; } .t5 { color: #8a8d99; }
.nightMode .t1 { color: #ff7a7a; } .nightMode .t2 { color: #ffb65c; } .nightMode .t3 { color: #6fdc95; }
.nightMode .t4 { color: #72a9ff; } .nightMode .t5 { color: #b9bccb; }
`;

  const SOURCE = `{{#Url}}<a class="xp-src" href="{{Url}}">{{Source}}</a>{{/Url}}{{^Url}}{{#Source}}<span class="xp-src">{{Source}}</span>{{/Source}}{{/Url}}`;

  const MODELS = {
    [WORD_MODEL]: {
      fields: ['Word', 'Pinyin', 'Meaning', 'Sentence', 'SentencePinyin', 'SentenceEnglish', 'Source', 'Url'],
      templates: [{
        Name: 'Recognise',
        Front: `<div class="xp-word zh">{{Word}}</div>\n${tts('Word')}`,
        // {{FrontSide}} does not auto-play the front's audio again on the back.
        Back: `{{FrontSide}}
<hr id="answer">
<div class="xp-py">{{Pinyin}}</div>
<div class="xp-meaning">{{Meaning}}</div>
{{#Sentence}}<div class="xp-box">
<div class="xp-sent zh">{{Sentence}}</div>
${tts('Sentence')}
{{#SentencePinyin}}<div class="xp-sent-py">{{SentencePinyin}}</div>{{/SentencePinyin}}
{{#SentenceEnglish}}<div class="xp-en">{{SentenceEnglish}}</div>{{/SentenceEnglish}}
</div>{{/Sentence}}
${SOURCE}`,
      }],
    },
    [SENTENCE_MODEL]: {
      fields: ['Sentence', 'SentencePinyin', 'SentenceEnglish', 'Source', 'Url'],
      templates: [{
        Name: 'Read',
        Front: `<div class="xp-sentence-front zh">{{Sentence}}</div>\n${tts('Sentence')}`,
        Back: `{{FrontSide}}
<hr id="answer">
<div class="xp-box">
<div class="xp-sent-py">{{SentencePinyin}}</div>
{{#SentenceEnglish}}<div class="xp-en">{{SentenceEnglish}}</div>{{/SentenceEnglish}}
</div>
${SOURCE}`,
      }],
    },
  };

  const origin = () => `chrome-extension://${chrome.runtime.id}`;

  const fail = (code, error) => Object.assign(new Error(error), { code });

  // Remembered for the life of the service worker; cleared when Anki says otherwise.
  let host = null;
  let granted = false;
  let haveModels = new Set();
  let haveDecks = new Set();
  const forget = () => { granted = false; haveModels = new Set(); haveDecks = new Set(); };

  async function post(url, body, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { method: 'POST', body, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function invoke(action, params = {}) {
    const { ankiKey } = await chrome.storage.sync.get('ankiKey');
    const body = JSON.stringify({ action, version: 6, params, ...(ankiKey ? { key: ankiKey } : {}) });
    // requestPermission waits for the user to click in Anki's dialog.
    const ms = action === 'requestPermission' ? 120000 : 15000;
    let res = null;
    for (const h of host ? [host, ...HOSTS.filter(x => x !== host)] : HOSTS) {
      try { res = await post(h, body, ms); host = h; break; } catch (e) { /* try the next address */ }
    }
    if (!res) { host = null; throw fail('offline', 'Anki is not running (open Anki with AnkiConnect installed)'); }
    if (res.status === 403) { granted = false; throw fail('denied', 'Anki did not allow Xiaopin'); }
    let j;
    try { j = await res.json(); } catch (e) { throw fail('error', `AnkiConnect replied HTTP ${res.status}`); }
    if (j && typeof j === 'object' && 'error' in j && 'result' in j) {
      if (j.error) throw fail(/duplicate/i.test(j.error) ? 'duplicate' : /api key/i.test(j.error) ? 'apikey' : 'error', j.error);
      return j.result;
    }
    return j;   // very old AnkiConnect versions answer without the envelope
  }

  // Must come first: AnkiConnect only answers origins in its webCorsOriginList,
  // and for others shows the user an Allow / Deny dialog.
  async function ensurePermission() {
    if (granted) return;
    const r = await invoke('requestPermission');
    if (!r || r.permission !== 'granted') throw fail('denied', 'Anki did not allow Xiaopin');
    if (r.requireApikey) {
      const { ankiKey } = await chrome.storage.sync.get('ankiKey');
      if (!ankiKey) throw fail('apikey', 'AnkiConnect wants an API key; Xiaopin does not support one in the menu yet');
    }
    granted = true;
  }

  async function ensureModel(name) {
    if (haveModels.has(name)) return;
    const names = await invoke('modelNames');
    if (!(names || []).includes(name)) {
      const m = MODELS[name];
      await invoke('createModel', {
        modelName: name, inOrderFields: m.fields, css: CSS, isCloze: false, cardTemplates: m.templates,
      });
    }
    haveModels.add(name);
  }

  async function ensureDeck(deck) {
    if (haveDecks.has(deck)) return;
    const decks = await invoke('deckNames');
    if (!(decks || []).includes(deck)) await invoke('createDeck', { deck });
    haveDecks.add(deck);
  }

  async function deckName(msg) {
    const v = (msg && msg.deck) || (await chrome.storage.sync.get('ankiDeck')).ankiDeck;
    return String(v || '').trim() || DEFAULT_DECK;
  }

  const reply = e => ({
    ok: false,
    code: e.code || 'error',
    error: String(e.message || e),
    ...(e.code === 'denied' ? { origin: origin() } : {}),
  });

  XiaopinBg.handle('anki.status', async msg => {
    try {
      forget();   // a fresh check, e.g. after the user changed AnkiConnect's config
      await ensurePermission();
      const deck = await deckName(msg);
      const decks = await invoke('deckNames');
      return { ok: true, deck, deckExists: (decks || []).includes(deck), origin: origin() };
    } catch (e) {
      return reply(e);
    }
  });

  // msg: { kind: 'word' | 'sentence', fields: {…}, tags: [...] }
  XiaopinBg.handle('anki.add', async msg => {
    const modelName = msg.kind === 'sentence' ? SENTENCE_MODEL : WORD_MODEL;
    const fields = {};
    for (const f of MODELS[modelName].fields) fields[f] = String((msg.fields || {})[f] || '');
    const tags = (msg.tags || []).map(t => String(t).replace(/\s+/g, '_')).filter(Boolean);
    for (let attempt = 0; ; attempt++) {
      try {
        await ensurePermission();
        const deck = await deckName(msg);
        await ensureModel(modelName);
        await ensureDeck(deck);
        const noteId = await invoke('addNote', {
          note: {
            deckName: deck, modelName, fields, tags,
            options: {
              allowDuplicate: false,
              duplicateScope: 'deck',
              duplicateScopeOptions: { deckName: deck, checkChildren: false, checkAllModels: false },
            },
          },
        });
        return { ok: true, noteId, deck };
      } catch (e) {
        // The deck or note type was deleted in Anki since we last looked: look again once.
        if (attempt === 0 && e.code === 'error' && /(deck|model) was not found/i.test(e.message)) { forget(); continue; }
        return reply(e);
      }
    }
  });
})();
