# Features (plugins)

Each learning tool lives in its own files here and plugs into the core through
hooks, so tools can be added or removed without touching `content.js`.

## Content side: `features/<name>.js`

Loaded after `content.js` in the same isolated world (listed in
`manifest.json` → `content_scripts`). Register once:

```js
Xiaopin.register({
  id: 'my-tool',                       // unique

  // Switches in the in-player menu, section "Learning tools".
  // Values live in chrome.storage.sync and are read with api.view[key].
  settings: [{ key: 'myToolOn', label: 'My tool', default: true }],

  init(api) {},                        // once, right after register
  onView(api) {},                      // a setting changed
  onChange(api) {},                    // subtitles, translations or the word list changed

  // Extra CSS classes for a word span (<span class="crpy-w">) in subtitles and history.
  // Called for every word on every redraw; keep it a cheap lookup.
  wordClass(word) { return ''; },

  // Called on every animation frame with the playback time (seconds). Keep it cheap.
  tick(t, api) {},

  // After the overlay subtitle card was redrawn.
  onLineRendered(linesEl, api) {},

  // Extra section in the word popup: return html, a Promise of html, or nothing.
  popup(word, info, api) { return ''; },  // info: { word, py, line: {zh, en}, entries, chars }
  onPopupRendered(sectionEl, word, api) {},

  // Buttons under each Chinese line (overlay card and history panel).
  lineActions: [{ id: 'do-it', label: '?', title: 'Do something with this line' }],
  onLineAction(actionId, line, api, buttonEl) {},  // line: { start, end, zh, en, index }

  // Any click inside the overlay; return true when you handled it.
  onClick(event, api) { return false; },

  // Keyboard shortcuts (lowercase key → fn). Core keys: a, s, d.
  keys: { r: api => {} },

  // Html shown in the menu (under "Learning tools") and in the toolbar pill.
  panel(api) { return ''; },
  toolbar(api) { return ''; },
});
```

### `api`

| Member | What |
| --- | --- |
| `api.st` | Current state: `mediaId`, `title`, `zh` / `en` cue arrays (`{id, start, end, text}`), `zhSource`, `enSource`, `offset`. |
| `api.video` | The `<video>` element (may change when the player is rebuilt). |
| `api.view` | All settings, core and feature. `api.setView(key, value)` saves one. |
| `api.root` | The overlay root element. Feature CSS should scope under `.crpy-root`. |
| `api.popup` | The open word popup's info, or `null`. `api.placePopup()` re-positions it after content changes. |
| `api.vocab` | The saved word list `{ word: {...} }`. |
| `api.pairedLines()` | All lines as `{start, end, zh, en}` (Chinese timing, English attached). Not cached: call it on change, not every frame. |
| `api.lineIndexAt(lines, t)` | Index of the line spoken at time `t`. |
| `api.refresh()` | Redraw everything (subtitles, history, menu, toolbar). `api.rerenderLines()` redraws only the subtitle card. |
| `api.setStatus(text)` | Status line in the menu. |
| `api.esc(s)`, `api.pySpans(py)`, `api.toneOf(syllable)`, `api.zhHtml(text)` | Html escaping, tone-coloured pinyin, tone number, Chinese line → word spans. |
| `api.segmentsOf(text)` | Dictionary word split of a Chinese line (array of strings). Until the background answers it returns a rougher fallback; `api.isSegmented(text)` tells you which, and `onChange` fires when the dictionary split arrives. |
| `api.lookup(word, py)` | `{ entries: [[pinyin, meanings]], chars: [...] }` from CC-CEDICT and Make Me a Hanzi. |
| `api.send(msg)` | `chrome.runtime.sendMessage` to the background (for your `*-bg.js` handlers). |
| `api.seek(t)` | Jump the video to `t` seconds. |

Design tokens from `overlay.css` (use them so tools match): `--crpy-accent`, `--crpy-accent-soft`, `--crpy-glass`, `--crpy-glass-strong`, `--crpy-line`, `--crpy-text`, `--crpy-muted`, `--crpy-en`, `--crpy-t1` … `--crpy-t5`, `--crpy-zh-font`, `--crpy-ui-font`.

## Background side: `features/<name>-bg.js`

Imported by `background.js` with `importScripts` (the list is at the end of
`background.js`). Add message handlers:

```js
XiaopinBg.handle('myTool.do', async (msg, sender) => {
  const s = await XiaopinBg.settings();                       // provider, keys, models
  const out = await XiaopinBg.callModel({ system, user, schema, maxTokens }); // user's chosen model
  const res = await XiaopinBg.lookup(word, py);               // dictionary
  return { ok: true, out };                                   // becomes the reply
});
```

`callModel` returns the parsed object when you pass a JSON schema
(`additionalProperties: false`, all properties `required`), else plain text.
Errors are returned to the page as `{ error }`.
