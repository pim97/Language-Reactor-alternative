// "In plain words": a short AI explanation of the hovered word, in context and in the
// learner's own language, shown at the top of the word popup.
(() => {
  const LABELS = {
    en: { title: 'In plain words', memory: 'Remember', nokey: 'Add an API key in settings to get plain explanations.' },
    nl: { title: 'Eenvoudig uitgelegd', memory: 'Onthouden', nokey: 'Voeg in de instellingen een API-sleutel toe voor eenvoudige uitleg.' },
  };
  const WAIT = 350;   // ms: skip words the mouse only passes over

  Xiaopin.register({
    id: 'simple',
    popupFirst: true,
    settings: [{ key: 'simpleOn', label: 'Plain explanation in word popup', default: true }],

    popup(word, info, api) {
      if (!api.view.simpleOn || !/\p{Script=Han}/u.test(word)) return '';
      const lang = LABELS[api.view.explainLang] ? api.view.explainLang : 'en';
      const L = LABELS[lang];
      return new Promise(resolve => setTimeout(resolve, WAIT)).then(async () => {
        if (!api.popup || api.popup.word !== info.word) return '';
        let res;
        try {
          res = await api.send({
            type: 'word.simple',
            word,
            py: word === info.word ? info.py : '',
            sentence: info.line?.zh || '',
            en: info.line?.en || '',
            lang,
          });
        } catch (e) { return ''; }
        if (!res || res.code === 'nokey') return `<div class="crpy-simple crpy-simple-muted">${api.esc(L.nokey)}</div>`;
        if (!res.ok) return '';
        const d = res.data;
        return `<div class="crpy-simple">
          <div class="crpy-simple-head">${api.esc(L.title)}</div>
          <div class="crpy-simple-meaning">${api.esc(d.meaning)}</div>
          ${d.explanation ? `<div class="crpy-simple-text">${api.esc(d.explanation)}</div>` : ''}
          ${d.memory ? `<div class="crpy-simple-memory"><b>${api.esc(L.memory)}:</b> ${api.esc(d.memory)}</div>` : ''}
        </div>`;
      });
    },
  });
})();
