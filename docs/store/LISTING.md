# Chrome Web Store listing – Xiaopin 1.3.1

Upload: `xiaopin-1.3.1.zip` from https://github.com/pim97/Language-Reactor-alternative/releases/tag/v1.3.1
(the zip itself, not unzipped).

## Store listing tab

**Name** (comes from the manifest): Xiaopin – Pinyin Subtitles

**Summary** (from the manifest, max 132 characters):
Learn Mandarin from video: pinyin, Chinese characters and English subtitles together, with word lookup and a word list.

**Category:** Education
**Language:** English

**Description:**

Learn Mandarin Chinese from the videos you already watch on Crunchyroll and YouTube.

Xiaopin shows every line as pinyin, Chinese characters and English at the same time, with tone colours, so you can read, listen and understand together.

WHAT YOU GET
• Three-line subtitles: pinyin above every character, then the characters, then English.
• Tone colours: 1st tone red, 2nd orange, 3rd green, 4th blue, neutral grey.
• Hover any word: pinyin and meaning (CC-CEDICT), and the video pauses while you read.
• Character breakdown: see how each character is built from simpler parts, which part gives the meaning and which the sound.
• In plain words: a short explanation of the word in this sentence, in English or Dutch, with a memory tip.
• Explain this line (解) and Ask AI (问): translation, word-by-word gloss, grammar points, and your own questions about the line.
• Known words: mark words as new, learning or known, see how much of an episode you understand, and HSK levels for every word.
• Shadowing: pause after each line, loop a line, blur English or pinyin until you hover.
• Stroke order animations with a trace mode to practise writing.
• History panel with every line so far; click to jump back. Keys A / S / D for previous, repeat and next line.
• Word list with Anki export, or send cards straight to Anki with AnkiConnect.
• Show subtitles on the video, only in the history panel, or both. Drag the popup and history wherever you like.

HOW THE TEXT IS MADE
On Crunchyroll and YouTube, Xiaopin reads the subtitle tracks the site's player already loaded. If a video has only Chinese or only English subtitles, the other language can be translated with an AI model you choose (OpenRouter or the Anthropic API, with your own key). Each episode is translated once and kept on your device.

PRIVACY
No account, no server, no tracking. Your settings, word list and translations stay in your browser. Subtitle lines are only sent to the AI provider you pick, with your own key, when you use AI features. The extension never records video or audio.

Open source: https://github.com/pim97/Language-Reactor-alternative

Unofficial tool, not affiliated with or endorsed by Crunchyroll, YouTube or Google.

**Graphic assets** (in this folder):
- Store icon 128×128: `icons/icon128.png`
- Screenshot 1280×800: `docs/store/screenshot-1280x800.png` (and optionally `docs/store/banner-1280x800.png`)
- Small promo tile 440×280: `docs/store/promo-440x280.png`

**Official URL / homepage:** https://github.com/pim97/Language-Reactor-alternative
**Support URL:** https://github.com/pim97/Language-Reactor-alternative/issues

## Privacy practices tab

**Single purpose:**
Show Chinese subtitles with pinyin, characters and English on video sites, with study tools (word lookup, character breakdown, word list), to help people learn Mandarin.

**Permission justifications:**
- `storage`: saves the user's settings, word list, word statuses and cached translations on the device.
- `unlimitedStorage`: per-episode translations, explanations and stroke data can exceed the default 10 MB local storage over time.
- Host permission `https://www.crunchyroll.com/*`, `https://www.youtube.com/*` (content scripts): show the subtitle overlay on the video and read the subtitle tracks the site's player loaded.
- Host permission `https://*.crunchyrollcdn.com/*`: download the subtitle files (.ass) that Crunchyroll's player references.
- Host permission `https://openrouter.ai/*`, `https://api.anthropic.com/*`: send AI translation and explanation requests to the provider the user chose, with the user's own API key, only when AI features are used.
- Host permission `https://cdn.jsdelivr.net/*`: download stroke-order data (JSON) for the character the user looks up.
- Host permission `http://127.0.0.1:8765/*`, `http://localhost:8765/*`: send cards to the AnkiConnect add-on on the user's own computer when the user clicks "Add to Anki".

**Remote code:** No, I am not using remote code. (All JavaScript is in the package; jsDelivr only provides JSON stroke data, which is not executed.)

**Data usage — what the extension handles:**
- ☑ Website content — subtitle text of the video is sent to the AI provider the user chooses (OpenRouter or Anthropic) when the user uses AI translation, explanations or Ask AI.
- ☐ Personally identifiable information, health, financial, authentication information (the API key is entered by the user and only stored locally / sent to that provider; it is not collected by the developer), personal communications, location, web history, user activity: not collected.

**Certifications (all three):**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://github.com/pim97/Language-Reactor-alternative/blob/main/PRIVACY.md

## Distribution tab
- Payments: Free
- Visibility: Public
- Regions: all regions
