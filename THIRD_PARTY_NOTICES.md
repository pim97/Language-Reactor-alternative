# Third-party notices

This project bundles the following data and libraries. Each keeps its own license.

## CC-CEDICT — `lib/cedict.json`

Chinese–English dictionary, converted to JSON (tone marks instead of tone numbers, classifier notes removed).
Community-maintained, published by MDBG: https://cc-cedict.org/wiki/

License: Creative Commons Attribution-ShareAlike 4.0 International
https://creativecommons.org/licenses/by-sa/4.0/

The converted file `lib/cedict.json` is shared under the same license.

## Make Me a Hanzi — `lib/hanzi.json`

Character decomposition and etymology data, converted from `dictionary.txt` of
https://github.com/skishore/makemeahanzi (derived from Unihan and CJKlib).

License: GNU Lesser General Public License v3.0 or later. See `lib/hanzi-COPYING.txt`
and https://www.gnu.org/licenses/lgpl-3.0.html. The converted file is shared under the same license.

## Complete HSK Vocabulary — `lib/hsk.json`

HSK 2.0 word lists (levels 1–6), converted to `{word: level}` from `wordlists/exclusive/old/*.min.json` of
https://github.com/drkameleon/complete-hsk-vocabulary (commit 7ac65bf1a6387d35f1ade478906172a19311c7f9),
by Yanis Zafirópulos.

License: MIT. See `lib/hsk-LICENSE.txt`.

## Hanzi Writer — `lib/hanzi-writer.min.js`

Stroke order animation and quiz library, v3.7.3, by David Chanin: https://github.com/chanind/hanzi-writer

License: MIT. See `lib/hanzi-writer-LICENSE.txt`.

## Hanzi Writer Data (fetched at runtime, not bundled)

Per-character stroke data from the `hanzi-writer-data` package, v2.0.1
(https://github.com/chanind/hanzi-writer-data), derived from Make Me a Hanzi and the
Arphic PL fonts "AR PL KaitiM GB" and "AR PL UKai". It is not included in this extension:
the stroke-order view downloads one character at a time from
https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/ and keeps a small local cache.

License: Arphic Public License (https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/ARPHICPL.TXT).

## pinyin-pro — `lib/pinyin-pro.js`

Pinyin conversion library, v3.26.0, by zh-lx: https://github.com/zh-lx/pinyin-pro

License: MIT. See `lib/pinyin-pro-LICENSE.txt`.
