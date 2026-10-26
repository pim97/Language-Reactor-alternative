// Runs in the page's own JS world. Reads responses the video player already
// received (Crunchyroll's playback info, YouTube's caption tracks) and forwards
// them to the content script. It never sends requests of its own.
(() => {
  const PLAY_RE = /\/playback\/v\d+\/([A-Z0-9]+)\/[^/]+\/[^/]+\/play/;
  const MANIFEST_RE = /\/playback\/v\d+\/manifest\//;
  const TIMEDTEXT_RE = /\/api\/timedtext/;

  const post = msg => window.postMessage({ source: 'crpy-inject', ...msg }, location.origin);
  const pathOf = u => { try { return new URL(u, location.href).pathname; } catch (e) { return u; } };

  // ---- Crunchyroll ----

  // Manifest path → subtitle locale burned into that stream (from the last play response).
  let hardSubPaths = {};

  function onManifest(url) {
    post({ type: 'stream', burnedIn: hardSubPaths[pathOf(url)] || '' });
  }

  function onPlay(url, text) {
    const m = PLAY_RE.exec(url);
    try {
      const j = JSON.parse(text);
      hardSubPaths = {};
      for (const [loc, h] of Object.entries(j.hardSubs || {})) if (h && h.url) hardSubPaths[pathOf(h.url)] = loc;
      post({ type: 'play', mediaId: m[1], audioLocale: j.audioLocale || '', subtitles: j.subtitles || {} });
    } catch (e) { /* not JSON, ignore */ }
  }

  // ---- YouTube ----

  function onTimedtext(url, text) {
    if (!text) return;
    try {
      const q = new URL(url, location.href).searchParams;
      if (q.get('fmt') && q.get('fmt') !== 'json3') return;
      post({
        type: 'timedtext',
        videoId: q.get('v') || '',
        lang: q.get('lang') || '',
        tlang: q.get('tlang') || '',
        asr: q.get('kind') === 'asr',
        data: JSON.parse(text),
      });
    } catch (e) {}
  }

  // Switch the YouTube player to Chinese captions (or English if there are none),
  // the same as picking them in the CC menu. The player then loads that track.
  function enableYoutubeCaptions(reload) {
    const p = document.querySelector('#movie_player');
    const videoId = new URLSearchParams(location.search).get('v') || '';
    const tracks = p?.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    if (!tracks.length) return post({ type: 'yt-captions', videoId, available: false });
    const score = t => {
      const l = t.languageCode.toLowerCase();
      const asr = t.kind === 'asr';
      if (l === 'zh-hans' || l === 'zh-cn') return asr ? 4 : 1;
      if (l.startsWith('zh')) return asr ? 5 : 2;
      if (l.startsWith('en')) return asr ? 6 : 3;
      return 9;
    };
    const best = [...tracks].sort((a, b) => score(a) - score(b))[0];
    if (score(best) === 9) return post({ type: 'yt-captions', videoId, available: true, picked: '' });
    // On a retry the captions module is reloaded: sometimes the player marks a track
    // as on without ever fetching it, and only a fresh module makes it load.
    if (reload) { try { p.unloadModule('captions'); } catch (e) {} }
    p.loadModule('captions');
    p.setOption('captions', 'track', { languageCode: best.languageCode, ...(best.kind ? { kind: best.kind } : {}) });
    post({ type: 'yt-captions', videoId, available: true, picked: best.languageCode + (best.kind === 'asr' ? ' (auto)' : '') });
  }

  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.source !== 'crpy-content') return;
    if (e.data.type === 'yt-enable-captions') { try { enableYoutubeCaptions(!!e.data.reload); } catch (err) {} }
  });

  // ---- hooks ----

  function handle(url, getText) {
    if (PLAY_RE.test(url)) getText().then(t => onPlay(url, t), () => {});
    else if (MANIFEST_RE.test(url)) onManifest(url);
    else if (TIMEDTEXT_RE.test(url)) getText().then(t => onTimedtext(url, t), () => {});
  }

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = (args[0] && args[0].url) || String(args[0]);
      handle(url, () => res.clone().text());
    } catch (e) {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = String(url);
    if (PLAY_RE.test(u) || MANIFEST_RE.test(u) || TIMEDTEXT_RE.test(u)) {
      if (MANIFEST_RE.test(u)) onManifest(u);
      else this.addEventListener('load', () => {
        try { handle(u, () => Promise.resolve(this.responseText)); } catch (e) {}
      });
    }
    return origOpen.call(this, method, url, ...rest);
  };
})();
