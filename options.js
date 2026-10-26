const DEFAULTS = {
  provider: 'openrouter',
  openrouterKey: '',
  openrouterModel: 'anthropic/claude-haiku-5.5',
  anthropicKey: '',
  anthropicModel: 'claude-haiku-5-5',
  showPinyin: true,
  showHanzi: true,
  showEnglish: true,
  hideNative: true,
  pauseOnHover: true,
  toneColors: true,
  fontSize: 30,
};

const $ = id => document.getElementById(id);

function showProvider() {
  for (const el of document.querySelectorAll('[data-p]')) el.hidden = el.dataset.p !== $('provider').value;
}

chrome.storage.sync.get(Object.keys(DEFAULTS)).then(v => {
  const s = { ...DEFAULTS, ...v };
  for (const [k, val] of Object.entries(s)) {
    const el = $(k);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
  }
  showProvider();
});

$('provider').addEventListener('change', showProvider);

$('save').addEventListener('click', async () => {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const el = $(k);
    out[k] = el.type === 'checkbox' ? el.checked : el.value.trim();
  }
  out.fontSize = Math.min(64, Math.max(14, parseInt(out.fontSize, 10) || DEFAULTS.fontSize));
  await chrome.storage.sync.set(out);
  $('saved').textContent = 'Saved ✓';
  setTimeout(() => { $('saved').textContent = ''; }, 2000);
});

$('clearCache').addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter(k => k.startsWith('tr:') || k.startsWith('tren:')));
  $('saved').textContent = 'Translations cleared';
});

// ---------- word list ----------

const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function vocabList() {
  const v = (await chrome.storage.local.get('vocab')).vocab || {};
  return Object.values(v).sort((a, b) => b.added - a.added);
}

async function renderVocab() {
  const list = await vocabList();
  $('vocabCount').textContent = `(${list.length})`;
  $('vocab').innerHTML = list.map(w => `
    <tr>
      <td class="w">${esc(w.word)}</td>
      <td><div class="py">${esc(w.pinyin)}</div>${esc(w.meaning)}</td>
      <td class="s"><span class="zh">${esc(w.sentence)}</span><br><i>${esc(w.sentenceEn)}</i><br>
        <a href="${esc(w.url)}" target="_blank">${esc(w.source)}</a></td>
      <td><button data-del="${esc(w.word)}">✕</button></td>
    </tr>`).join('') ||
    '<tr><td><div class="empty"><img src="assets/mascot.svg" alt="">No words yet. Hover a word while watching and tap ☆.</div></td></tr>';
}

$('vocab').addEventListener('click', async e => {
  const word = e.target.dataset.del;
  if (!word) return;
  const v = (await chrome.storage.local.get('vocab')).vocab || {};
  delete v[word];
  await chrome.storage.local.set({ vocab: v });
  renderVocab();
});

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Anki: front = word, back = pinyin, meaning and the sentence it came from.
$('exportAnki').addEventListener('click', async () => {
  const clean = s => String(s || '').replace(/[\t\r\n]+/g, ' ');
  const rows = (await vocabList()).map(w => [
    clean(w.word),
    `${clean(w.pinyin)}<br>${clean(w.meaning)}<br><br>${clean(w.sentence)}<br><i>${clean(w.sentenceEn)}</i>`,
  ].join('\t'));
  download('chinese-words-anki.txt', '#separator:tab\n#html:true\n' + rows.join('\n'), 'text/plain');
});

$('exportCsv').addEventListener('click', async () => {
  const q = s => '"' + String(s || '').replace(/"/g, '""') + '"';
  const head = ['word', 'pinyin', 'meaning', 'sentence', 'sentence_en', 'source', 'url'];
  const rows = (await vocabList()).map(w => [w.word, w.pinyin, w.meaning, w.sentence, w.sentenceEn, w.source, w.url].map(q).join(','));
  download('chinese-words.csv', '﻿' + head.join(',') + '\n' + rows.join('\n'), 'text/csv');
});

chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && ch.vocab) renderVocab(); });
renderVocab();
