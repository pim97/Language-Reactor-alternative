![Xiaopin 小拼 – learn Mandarin from the shows you watch](docs/banner.png)

# Xiaopin 小拼 – Pinyin Subtitles for Crunchyroll & YouTube

A free, open-source Chrome extension for learning Mandarin Chinese from the videos you already watch. It shows every line as **pinyin → 汉字 → English** with tone colours, lets you hover any word for its meaning and character breakdown, and keeps a word list you can export to Anki. A lightweight Language Reactor alternative focused on Chinese.

Meet **Xiaopin**, the red panda (小熊猫) who reads along with you.

![Pinyin, Chinese characters and English subtitles with tone colours, a word popup showing the character breakdown, and the history panel](docs/screenshot.png)

<sub>Screenshot of the overlay on a demo page (`docs/demo.html`) with example sentences, not footage from any show.</sub>

> Unofficial project. Not affiliated with, endorsed by or sponsored by Crunchyroll, YouTube/Google, Language Reactor or any other company. All trademarks belong to their owners and are used only to say which sites the extension works on.

## Features

- **Three-line subtitles**: pinyin above each character, then Chinese characters, then English.
- **Tone colours**: 1st tone red · 2nd orange · 3rd green · 4th blue · neutral grey, on both pinyin and characters, so tones stick visually.
- **Hover a word** for pinyin and meanings (CC-CEDICT). The video pauses while you read.
- **Character breakdown**: see how each character is built from simpler parts, which part gives the meaning and which the sound (好 = 女 woman + 子 child; 妈 = 女 meaning + 马 sound). Click a part to drill down.
- **Dictionary-based word splitting**: 前天, 照相馆 and 一点儿 stay one word; idioms stay whole.
- **History panel**: every line so far with pinyin, characters and English; click a line to jump back.
- **Word list**: save words with ☆ together with the sentence they came from. Export to Anki or CSV.
- **Listening keys**: `A` previous line · `S` repeat line · `D` next line.
- **Missing a language?** If a video only has Chinese or only English subtitles, the other side is translated with an AI model of your choice (OpenRouter or Anthropic API, your own key). Translations are made once per episode and cached locally, starting from where you are watching so subtitles don't lag.
- **Your own subtitle file**: load a Chinese `.srt`/`.ass` file and shift its timing if needed.

### Where the text comes from

| Site | Chinese | English |
| --- | --- | --- |
| Crunchyroll | Chinese subtitle track if the episode has one, else your own file, else AI translation | the episode's English track |
| YouTube | the video's Chinese captions (turned on automatically) | English captions if loaded, else AI translation |

If a stream already has English burned into the picture, the extension hides its own English line and places pinyin + characters above it.

## Install

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode** and click **Load unpacked**. Pick this folder.
3. Click the extension icon to open the settings. Add an OpenRouter or Anthropic API key if you want AI translation. The default model is Claude Haiku 5.5 (fast, accurate, about half a cent per episode).

## Privacy and what it does not do

- It **only reads subtitle data that the site's own player already loaded** in your browser session. It does not download, record or decrypt video or audio, and does not bypass DRM, paywalls or region locks. You need your own account and subscription.
- Subtitles, translations and your word list are stored **only in your browser** (`chrome.storage`). Nothing is uploaded or shared, except the subtitle lines you choose to send to your AI provider for translation.
- Your API key is stored locally and sent only to the provider you pick.
- This repository contains **no subtitles, video or screenshots** from any show.

Use it for personal study, in line with the terms of the sites you watch.

## How it works

| File | Role |
| --- | --- |
| `inject.js` | Runs in the page; reads the subtitle list / caption responses the player received. |
| `content.js` | Builds the overlay: pinyin, word spans, popup, history, word list, shortcuts. |
| `background.js` | Fetches subtitle files, AI translation, dictionary lookup and word splitting. |
| `subtitles.js` | Parsers for `.ass`, `.srt` and YouTube `json3`. |
| `options.html/js` | Settings and word list with Anki/CSV export. |
| `assets/`, `icons/` | Xiaopin mascot and extension icons (original artwork, MIT like the code). |
| `docs/` | README banner, screenshot and the demo pages they are rendered from. |

## Licenses

The extension code is MIT licensed (see `LICENSE`). Bundled data and libraries keep their own licenses; see `THIRD_PARTY_NOTICES.md`.
