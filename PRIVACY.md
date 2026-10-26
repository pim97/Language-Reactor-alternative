# Xiaopin – Privacy policy

_Last updated: 26 October 2026_

Xiaopin ("the extension") is a free, open-source browser extension that shows pinyin, Chinese characters and English subtitles over videos on Crunchyroll and YouTube. This policy explains what data it handles.

## What the extension does not do

- It has **no server** of its own. The developer does not receive, collect, store, sell or share any of your data.
- It contains no analytics, tracking, advertising or telemetry.
- It does not record, download or capture video or audio, and does not take screenshots.

## Data that stays on your device

Stored only in your browser (`chrome.storage`), never sent to the developer:

- your settings (display options, language, positions of panels);
- the API key you enter for AI translation (optional);
- your word list, word statuses and cached translations and explanations;
- subtitle files you load yourself.

You can remove all of it by uninstalling the extension or with "Clear saved translations" and the word list controls on the settings page.

## Subtitle data read from the page

On Crunchyroll and YouTube the extension reads the subtitle tracks that the site's own video player already loaded in your browser session, to display them. This text stays on your device, except as described below.

## Data sent to third parties you choose

Only when you have entered your own API key, and only for the features that need it:

- **AI translation, line explanations, "Ask AI" and plain word explanations**: the relevant subtitle lines (and your question, for "Ask AI") are sent to the AI provider you selected in the settings — [OpenRouter](https://openrouter.ai/privacy) or [Anthropic](https://www.anthropic.com/legal/privacy) — using your own key. Their privacy policies apply to that data.
- **Stroke order**: when you open the stroke-order view, the extension downloads stroke data for those characters from the public jsDelivr CDN (`cdn.jsdelivr.net`). Only the character being looked up is part of the request.
- **Anki**: if you use "Add to Anki", cards are sent to the AnkiConnect add-on running on your own computer (`127.0.0.1:8765`). Nothing leaves your machine.

## Permissions

- `storage`, `unlimitedStorage`: keep settings, word list and caches on your device.
- Access to `crunchyroll.com`, `youtube.com` and `crunchyrollcdn.com`: show subtitles on those sites and read the subtitle files their players use.
- Access to `openrouter.ai` and `api.anthropic.com`: send AI requests with your own key, when you use AI features.
- Access to `cdn.jsdelivr.net`: download character stroke data.
- Access to `127.0.0.1:8765` / `localhost:8765`: talk to AnkiConnect on your own computer.

## Children

The extension is not directed at children under 13 and does not knowingly collect data from anyone.

## Contact

Questions or requests: open an issue at https://github.com/pim97/Language-Reactor-alternative/issues.

This extension is an unofficial project and is not affiliated with Crunchyroll, YouTube/Google or any other company.
