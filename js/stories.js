// Stories: storage, Gemini story generation and the stories view.
// Same flow as the HSK Trainer (../chinese-trainer/js/stories.js), without the audio recordings.
"use strict";

var STORIES_KEY = 'grtrain_stories_v1';
function loadStories(){
  var list = loadJson(STORIES_KEY, []);
  return Array.isArray(list) ? list : [];
}
function saveStories(list){ saveJson(STORIES_KEY, list); }
var stories = loadStories();

// All-time count of story sentences read (rated); restarting or deleting a story never lowers it.
var SENTENCES_READ_KEY = 'grtrain_sentences_read_v1';
var sentencesRead = loadJson(SENTENCES_READ_KEY, 0) || 0;

var storiesState = {
  view: 'library',       // 'library' | 'generate' | 'preview' | 'detail'
  form: { count: 6, level: 'A1', topic: '' },
  generating: false,
  generateError: null,
  draft: null,           // { title: {g,r,e}, sentences: [{g,r,e}, ...], level, count }
  selectedId: null
};

// ---------- the example story (for a start without an API key) ----------
var DEMO_SEEDED_KEY = 'grtrain_demo_seeded_v1';
var DEMO_STORY = {
  id: 'story_demo_1',
  demo: true,
  level: 'A1',
  title: { g: 'Μια μέρα στη θάλασσα', r: 'Mia méra sti thálassa', e: 'A day at the sea' },
  sentences: [
    { g: 'Το πρωί η Μαρία πηγαίνει στη θάλασσα με τον φίλο της.', r: 'To proí i María pigaínei sti thálassa me ton fílo tis.', e: 'In the morning Maria goes to the sea with her friend.' },
    { g: 'Ο ήλιος είναι ζεστός και το νερό είναι καθαρό.', r: 'O ílios eínai zestós kai to neró eínai katharó.', e: 'The sun is hot and the water is clean.' },
    { g: 'Κολυμπούν πολύ και μετά τρώνε ψωμί και τυρί.', r: 'Kolymboún polý kai metá tróne psomí kai tyrí.', e: 'They swim a lot and then eat bread and cheese.' },
    { g: 'Ο Νίκος, ο φίλος της, διαβάζει ένα βιβλίο κάτω από ένα δέντρο.', r: 'O Níkos, o fílos tis, diavázei éna vivlío káto apó éna déntro.', e: 'Nikos, her friend, reads a book under a tree.' },
    { g: 'Το απόγευμα πίνουν καφέ σε μια μικρή ταβέρνα.', r: 'To apógevma pínoun kafé se mia mikrí tavérna.', e: 'In the afternoon they drink coffee in a small tavern.' },
    { g: 'Το βράδυ γυρίζουν στο σπίτι κουρασμένοι αλλά χαρούμενοι.', r: 'To vrády gyrízoun sto spíti kourasménoi allá charoúmenoi.', e: 'In the evening they go back home tired but happy.' }
  ]
};
// Adds the example story once; never touches a story with the same id.
function seedDemoStory(){
  if (loadJson(DEMO_SEEDED_KEY, false)) return;
  if (!stories.some(function(s){ return s.id === DEMO_STORY.id; })) {
    var s = JSON.parse(JSON.stringify(DEMO_STORY));
    s.count = s.sentences.length;
    s.currentIdx = 0;
    s.createdAt = new Date().toISOString();
    stories.push(s);
    saveStories(stories);
  }
  saveJson(DEMO_SEEDED_KEY, true);
}

// ---------- finding known words in a sentence ----------
// data/forms.json maps every folded word form (lemmas and their inflected
// forms from Wiktionary) to a word id. It is fetched on first use; until it
// is there, only the lemmas themselves are recognized.
var formsMap = null;
var lemmaMap = null;
var formsLoading = null;
function loadForms(){
  if (formsMap || formsLoading) return formsLoading || Promise.resolve();
  formsLoading = fetch('data/forms.json').then(function(res){
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }).then(function(map){
    formsMap = map;
    if (document.getElementById('storiesView').style.display !== 'none') renderStories();
  }).catch(function(){ formsLoading = null; });
  return formsLoading;
}
function wordForToken(token){
  var k = fold(token);
  if (formsMap && formsMap[k]) return WORD_BY_ID[formsMap[k]] || null;
  if (!lemmaMap) {
    lemmaMap = {};
    WORDS.forEach(function(w){
      w.w.split(/[,/]/).forEach(function(v){
        v = v.trim();
        if (v && v.charAt(0) !== '-' && !lemmaMap[fold(v)]) lemmaMap[fold(v)] = w.id;
      });
    });
  }
  return WORD_BY_ID[lemmaMap[k]] || null;
}
// Splits a sentence into Greek words and the rest: [{s: text, w: word | null}, ...]
var GREEK_TOKEN = /[Ͱ-Ͽἀ-῿]+/g;
function segmentSentence(text){
  var out = [], last = 0, m;
  GREEK_TOKEN.lastIndex = 0;
  while ((m = GREEK_TOKEN.exec(text))) {
    if (m.index > last) out.push({ s: text.slice(last, m.index), w: null });
    out.push({ s: m[0], w: wordForToken(m[0]) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ s: text.slice(last), w: null });
  return out;
}
// Distinct known words of a sentence (for rating and "Satz in den Pool").
function wordsInSentence(text){
  var seen = {}, out = [];
  segmentSentence(text).forEach(function(tok){
    if (tok.w && !seen[tok.w.id]) { seen[tok.w.id] = true; out.push(tok.w); }
  });
  return out;
}
// Sentence markup with every known word as a tappable span, softly tinted
// with the word's progress colour once it has been learned a bit.
function sentenceWordsHtml(text){
  return segmentSentence(text).map(function(tok){
    if (!tok.w) return esc(tok.s);
    var lvl = wordLvl(tok.w.id);
    // Hellas blue, the stronger the better the word is known (white would vanish on the card)
    var tint = lvl > 0 ? ' style="background:rgba(13,94,175,' + (0.08 + Math.min(lvl, 100) / 100 * 0.3).toFixed(2) + ')"' : '';
    return '<span class="sent-word" data-wid="' + tok.w.id + '"' + tint + ' title="' + esc(wordInfoText(tok.w)) + '">' + esc(tok.s) + '</span>';
  }).join('');
}
// "Satz in den Pool": adds every known word of the sentence to the pool.
function addSentenceToPool(text){
  var inPool = {};
  activePool().forEach(function(w){ inPool[w.id] = true; });
  var added = 0;
  wordsInSentence(text).forEach(function(w){
    if (!inPool[w.id]) { setWordInPool(w, true); inPool[w.id] = true; added++; }
  });
  if (added) poolChanged();
  showToast(added ? tf('sentPoolAdded', added) : t('sentPoolAllIn'));
}

// ---------- generation ----------
function buildStoryPrompt(count, level, topic){
  return "You are a precise linguistic API for a Modern Greek learning app.\n" +
    "TASK: Write a short story in Modern Greek for a language learner.\n" +
    "INPUT PARAMETERS:\n" +
    "- Number of sentences: " + count + "\n" +
    "- Language level: CEFR " + level + " (use only vocabulary and grammar appropriate for " + level + " or below)\n" +
    "- Topic: " + (topic || 'a simple everyday topic of your choice') + "\n" +
    "STRICT OUTPUT RULES:\n" +
    "1. Output MUST contain exactly " + (count + 1) + " lines. Nothing else.\n" +
    "2. The first line is the story title, in the format: GREEK|ROMANIZATION|ENGLISH\n" +
    "3. Each of the next " + count + " lines is one sentence of the story, in order, in the same format: GREEK|ROMANIZATION|ENGLISH\n" +
    "4. ROMANIZATION is a simple Latin transliteration with the stressed vowel marked by an acute accent. Greek in monotonic orthography with correct accents.\n" +
    "5. No introduction, no markdown fences (do NOT use ```), no explanatory text, no numbering.\n" +
    "6. The sentences must form one coherent short story.";
}

function generateStory(count, level, topic){
  var apiKey = requireGeminiKey();
  if (!apiKey) return Promise.reject(new Error('no-key'));
  return callGemini(buildStoryPrompt(count, level, topic), apiKey).then(function(text){
    var parsed = parseGeminiResponse(text);
    if (parsed.length < 2) throw new Error(t('unreadableAnswer'));
    return { title: parsed[0], sentences: parsed.slice(1), level: level, count: parsed.length - 1 };
  });
}

function storyMeta(s){
  return (s.level || 'A1') + ' · ' + tf('storiesSentencesCount', s.count);
}
function storyProgressLabel(s){
  var cur = s.currentIdx || 0;
  if (cur >= s.sentences.length) return t('storiesFinishedLabel');
  if (cur === 0) return t('storiesNotStarted');
  return tf('storiesContinueAt', cur + 1, s.sentences.length);
}
function demoBadgeHtml(){ return '<span class="demo-badge">' + esc(t('demoBadge')) + '</span>'; }

function openStory(s, startAt){
  var st = storiesState;
  st.selectedId = s.id;
  st.view = 'detail';
  st.readIdx = Math.min(startAt, s.sentences.length - 1);
  st.readCurrent = startAt;
  st.readShowRom = false;
  st.readShowTranslation = false;
  st.readFinished = startAt >= s.sentences.length;
  st.tryResult = null;
}

// ---------- rendering ----------
function renderStories(){
  var root = document.getElementById('storiesView');
  var st = storiesState;
  loadForms();

  if (st.view === 'library') {
    // Higher levels float to the top; within a level, the newest story first.
    var sorted = stories.map(function(s, idx){ return { s: s, idx: idx }; }).sort(function(a, b){
      var ra = LEVELS.indexOf(a.s.level), rb = LEVELS.indexOf(b.s.level);
      if (ra !== rb) return rb - ra;
      return b.idx - a.idx;
    }).map(function(x){ return x.s; });
    var listHtml = stories.length
      ? sorted.map(function(s){
          return '<div class="story-card" data-id="' + s.id + '">' +
            '<div class="story-card-toprow" data-open-id="' + s.id + '">' +
              '<div><div class="story-title">' + esc(s.title.g) + '</div><div class="story-title-en">' + esc(s.title.e) + '</div>' +
                (s.demo ? demoBadgeHtml() : '') +
                '<div class="story-meta">' + esc(storyMeta(s)) + ' · ' + esc(storyProgressLabel(s)) + '</div></div>' +
              '<button class="hint-btn" data-restart-id="' + s.id + '" title="' + esc(t('storiesRestartBtn')) + '">↺</button>' +
            '</div>' +
          '</div>';
        }).join('')
      : '<div class="empty-note">' + esc(t('storiesEmpty')) + '</div>';
    root.innerHTML =
      '<div class="stories-wrap">' +
        '<div class="story-toprow"><h2 style="margin:0;font-size:16px;">' + esc(t('storiesLibraryTitle')) + '</h2>' +
          '<button class="btn-primary" id="btnNewStory" style="padding:9px 18px;font-size:13.5px;">' + esc(t('storiesNewBtn')) + '</button></div>' +
        listHtml +
      '</div>';
    document.getElementById('btnNewStory').onclick = function(){ stopNarration(); st.view = 'generate'; renderStories(); };
    Array.prototype.forEach.call(root.querySelectorAll('[data-restart-id]'), function(btn){
      btn.onclick = function(e){
        e.stopPropagation();
        var s = stories.filter(function(x){ return x.id === btn.getAttribute('data-restart-id'); })[0];
        if (!s || !confirm(t('storiesRestartConfirm'))) return;
        s.currentIdx = 0;
        saveStories(stories);
        renderStories();
      };
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-open-id]'), function(row){
      row.onclick = function(){
        stopNarration();
        var s = stories.filter(function(x){ return x.id === row.getAttribute('data-open-id'); })[0];
        if (!s) return;
        openStory(s, Math.min(s.currentIdx || 0, s.sentences.length));
        renderStories();
      };
    });
    return;
  }

  if (st.view === 'generate') {
    root.innerHTML =
      '<div class="stories-wrap">' +
        '<div class="story-toprow"><h2 style="margin:0;font-size:16px;">' + esc(t('storiesGenTitle')) + '</h2>' +
          '<button class="hint-btn" id="btnBackToLibrary">' + esc(t('storiesBackToLibrary')) + '</button></div>' +
        '<div class="story-form">' +
          '<div class="field"><label for="stCount">' + esc(t('storiesCountLabel')) + '</label>' +
            '<input type="number" id="stCount" min="2" max="30" step="1" value="' + st.form.count + '"></div>' +
          '<div class="field"><label for="stLevel">' + esc(t('storiesLevelLabel')) + '</label>' +
            '<select id="stLevel">' +
              LEVELS.map(function(l){ return '<option value="' + l + '"' + (l === st.form.level ? ' selected' : '') + '>' + l + '</option>'; }).join('') +
            '</select></div>' +
          '<div class="field"><label for="stTopic">' + esc(t('storiesTopicLabel')) + '</label>' +
            '<textarea id="stTopic" placeholder="' + esc(t('storiesTopicPlaceholder')) + '">' + esc(st.form.topic) + '</textarea></div>' +
          '<button class="btn-primary" id="btnGenStory"' + (st.generating ? ' disabled' : '') + '>' + esc(st.generating ? t('storiesGeneratingBtn') : t('storiesGenerateBtn')) + '</button>' +
          (st.generateError ? '<div class="ex-e ex-err">' + esc(st.generateError) + '</div>' : '') +
        '</div>' +
      '</div>';
    document.getElementById('btnBackToLibrary').onclick = function(){ st.view = 'library'; renderStories(); };
    document.getElementById('btnGenStory').onclick = function(){
      st.form.count = Math.max(2, Math.min(30, parseInt(document.getElementById('stCount').value, 10) || 6));
      st.form.level = document.getElementById('stLevel').value || 'A1';
      st.form.topic = document.getElementById('stTopic').value.trim();
      st.generating = true;
      st.generateError = null;
      renderStories();
      generateStory(st.form.count, st.form.level, st.form.topic).then(function(draft){
        st.generating = false;
        st.draft = draft;
        st.view = 'preview';
        renderStories();
      }).catch(function(err){
        st.generating = false;
        if (err.message !== 'no-key') st.generateError = t('errorPrefix') + err.message;
        renderStories();
      });
    };
    return;
  }

  if (st.view === 'preview' && st.draft) {
    var d = st.draft;
    root.innerHTML =
      '<div class="stories-wrap">' +
        '<div class="story-title-block">' +
          '<div class="t-g">' + esc(d.title.g) + '</div>' +
          '<div class="t-r">' + esc(d.title.r) + '</div>' +
          '<div class="t-e">' + esc(d.title.e) + '</div>' +
        '</div>' +
        d.sentences.map(function(s, i){
          return '<div class="story-sentence">' +
            '<div class="s-g"><button class="hint-btn" data-speak-idx="' + i + '" style="padding:3px 7px;">🔊</button>' + esc(s.g) + '</div>' +
            '<div class="s-r">' + esc(s.r) + '</div>' +
            '<div class="s-e">' + esc(s.e) + '</div>' +
          '</div>';
        }).join('') +
        '<div class="story-btn-row">' +
          '<button class="btn-primary" id="btnAdoptStory">' + esc(t('storiesAdoptBtn')) + '</button>' +
          '<button class="btn-secondary" id="btnDiscardStory">' + esc(t('storiesDiscardBtn')) + '</button>' +
        '</div>' +
      '</div>';
    Array.prototype.forEach.call(root.querySelectorAll('[data-speak-idx]'), function(btn){
      btn.onclick = function(){ speak(d.sentences[parseInt(btn.getAttribute('data-speak-idx'), 10)].g); };
    });
    document.getElementById('btnAdoptStory').onclick = function(){
      var story = {
        id: 'story_' + Date.now(),
        title: d.title,
        sentences: d.sentences,
        level: d.level,
        count: d.count,
        currentIdx: 0,
        createdAt: new Date().toISOString()
      };
      stories.push(story);
      saveStories(stories);
      st.draft = null;
      openStory(story, 0);
      renderStories();
    };
    document.getElementById('btnDiscardStory').onclick = function(){
      st.draft = null;
      st.view = 'generate';
      renderStories();
    };
    return;
  }

  if (st.view === 'detail') {
    var story = stories.filter(function(s){ return s.id === st.selectedId; })[0];
    if (!story) { st.view = 'library'; renderStories(); return; }
    var backToLibrary = function(){ stopNarration(); stopTryListening(); st.tryResult = null; st.view = 'library'; renderStories(); };
    var deleteStory = function(){
      stopNarration();
      if (!confirm(t('storiesDeleteConfirm'))) return;
      stories = stories.filter(function(s){ return s.id !== story.id; });
      saveStories(stories);
      st.view = 'library';
      renderStories();
    };

    if (st.readFinished) {
      root.innerHTML =
        '<div class="stories-wrap">' +
          '<div class="story-toprow"><button class="hint-btn" id="btnBackToLibrary2">' + esc(t('storiesBackToLibrary')) + '</button>' +
            '<button class="hint-btn danger-text" id="btnDeleteStory">' + esc(t('storiesDeleteBtn')) + '</button></div>' +
          '<div class="panel"><h2>' + esc(t('storiesFinishedTitle')) + '</h2>' +
            '<p>' + esc(tf('storiesFinishedDesc', story.title.g)) + '</p>' +
            '<button class="btn-primary" id="btnReadAgain">' + esc(t('storiesRestartBtn')) + '</button></div>' +
        '</div>';
      document.getElementById('btnBackToLibrary2').onclick = backToLibrary;
      document.getElementById('btnDeleteStory').onclick = deleteStory;
      document.getElementById('btnReadAgain').onclick = function(){
        stopNarration();
        story.currentIdx = 0;
        saveStories(stories);
        openStory(story, 0);
        renderStories();
      };
      return;
    }

    var idx = st.readIdx || 0;
    var current = typeof st.readCurrent === 'number' ? st.readCurrent : 0;
    var sent = story.sentences[idx];
    var isCurrent = idx === current;
    var tryHere = st.tryResult && st.tryResult.storyId === story.id && st.tryResult.idx === idx;
    var tryListening = tryHere && st.tryResult.status === 'listening';
    var dotsHtml = story.sentences.map(function(s, i){
      return '<span class="dot' + (i < current ? ' done' : '') + (i === idx ? ' active' : '') + '" data-dot-idx="' + i + '"></span>';
    }).join('');
    var dis = isCurrent ? '' : ' disabled';

    root.innerHTML =
      '<div class="stories-wrap">' +
        '<div class="story-toprow"><button class="hint-btn" id="btnBackToLibrary2">' + esc(t('storiesBackToLibrary')) + '</button>' +
          '<div style="display:flex;gap:8px;">' +
            '<button class="hint-btn' + (narrating ? ' on' : '') + '" id="btnNarrate">' + esc(narrating ? t('storiesStopBtn') : t('storiesNarrateBtn')) + '</button>' +
            '<button class="hint-btn danger-text" id="btnDeleteStory">' + esc(t('storiesDeleteBtn')) + '</button>' +
          '</div></div>' +
        '<div class="story-title-block" style="margin-bottom:14px;padding-bottom:12px;">' +
          '<div class="t-g" style="font-size:20px;">' + esc(story.title.g) + '</div>' +
          '<div class="t-e" style="margin-top:2px;">' + esc(story.title.e) + '</div>' +
          (story.demo ? '<div style="margin-top:6px;">' + demoBadgeHtml() + '</div>' : '') +
        '</div>' +
        '<div class="session-bar"><span>' + esc(tf('storiesSentenceOf', idx + 1, story.sentences.length)) + (isCurrent ? '' : esc(t('storiesRepetition'))) + '</span>' +
          '<span class="dots">' + dotsHtml + '</span></div>' +
        '<div class="card" style="margin-top:10px;">' +
          '<div class="nav-row">' +
            '<button class="hint-btn" id="btnPrevSent"' + (idx === 0 ? ' disabled' : '') + '>' + esc(t('storiesPrev')) + '</button>' +
            '<button class="hint-btn" id="btnNextSent"' + (idx === story.sentences.length - 1 ? ' disabled' : '') + '>' + esc(t('storiesNext')) + '</button>' +
          '</div>' +
          '<div class="sentence" id="sentText">' + sentenceWordsHtml(sent.g) + '</div>' +
          '<div class="rom-line">' + (st.readShowRom ? esc(sent.r) : '') + '</div>' +
          '<div class="hint-row">' +
            '<button class="hint-btn' + (st.readShowRom ? ' on' : '') + '" id="btnToggleReadRom">' + esc(st.readShowRom ? t('storiesRomHide') : t('storiesRomShow')) + '</button>' +
            '<button class="hint-btn' + (st.readShowTranslation ? ' on' : '') + '" id="btnToggleReadTranslation">' + esc(st.readShowTranslation ? t('storiesTranslationHide') : t('storiesTranslationShow')) + '</button>' +
            '<button class="hint-btn" id="btnReadSpeak">' + esc(t('readBtn')) + '</button>' +
            '<button class="hint-btn" id="btnSentToPool">' + esc(t('sentToPoolBtn')) + '</button>' +
            (SpeechRec ? '<button class="hint-btn' + (tryListening ? ' on' : '') + '" id="btnTrySpeak">' + esc(tryListening ? t('tryStopBtn') : t('tryBtn')) + '</button>' : '') +
          '</div>' +
          '<div class="solution-line">' + (st.readShowTranslation ? esc(sent.e) : '') + '</div>' +
          (tryHere ? renderTryBox(st.tryResult) : '') +
          (isCurrent ? '' : '<div class="empty-note" style="padding:8px 0;">' + esc(t('storiesRatingOnlyCurrent')) + '</div>') +
          '<div class="rate-row" style="grid-template-columns:repeat(3,1fr);">' +
            '<button class="rate-btn" style="' + levelStyle(4) + '" data-val="0"' + dis + '>' + esc(t('storiesUnderstandNo')) + '<span class="val">+0</span></button>' +
            '<button class="rate-btn" style="' + levelStyle(35) + '" data-val="1"' + dis + '>' + esc(t('storiesUnderstandHalf')) + '<span class="val">+1</span></button>' +
            '<button class="rate-btn" style="' + levelStyle(90) + '" data-val="2"' + dis + '>' + esc(t('storiesUnderstandYes')) + '<span class="val">+2</span></button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('btnBackToLibrary2').onclick = backToLibrary;
    document.getElementById('btnDeleteStory').onclick = deleteStory;
    document.getElementById('btnNarrate').onclick = function(){
      stopTryListening();
      if (narrating) { stopNarration(); renderStories(); return; }
      narrateSentences(story.sentences, idx, function(i){
        st.readIdx = i;
        st.readShowRom = true;
        st.readShowTranslation = true;
        renderStories();
      }, function(){ renderStories(); });
      renderStories();
    };
    // Tap a word: its info + pronunciation; tap elsewhere: read the whole sentence.
    document.getElementById('sentText').onclick = function(e){
      var span = e.target.closest ? e.target.closest('[data-wid]') : null;
      var w = span && WORD_BY_ID[span.getAttribute('data-wid')];
      if (w) { showWordToast(w); speak(span.textContent); } else speak(sent.g);
    };
    document.getElementById('btnReadSpeak').onclick = function(){ stopTryListening(); speak(sent.g); };
    document.getElementById('btnSentToPool').onclick = function(){ addSentenceToPool(sent.g); };
    var btnTry = document.getElementById('btnTrySpeak');
    if (btnTry) btnTry.onclick = function(){
      // Second tap while listening: stop and use what was heard so far.
      if (tryListening && tryRec) { try { tryRec.stop(); } catch(e) {} return; }
      startTryListening(story.id, idx, sent);
    };
    document.getElementById('btnToggleReadRom').onclick = function(){ st.readShowRom = !st.readShowRom; renderStories(); };
    document.getElementById('btnToggleReadTranslation').onclick = function(){ st.readShowTranslation = !st.readShowTranslation; renderStories(); };
    function goToSentence(newIdx){
      stopNarration();
      stopTryListening();
      st.tryResult = null;
      st.readIdx = newIdx;
      st.readShowRom = false;
      st.readShowTranslation = false;
      renderStories();
    }
    var btnPrev = document.getElementById('btnPrevSent');
    if (btnPrev) btnPrev.onclick = function(){ if (idx > 0) goToSentence(idx - 1); };
    var btnNext = document.getElementById('btnNextSent');
    if (btnNext) btnNext.onclick = function(){ if (idx < story.sentences.length - 1) goToSentence(idx + 1); };
    Array.prototype.forEach.call(root.querySelectorAll('.dot'), function(dot){
      dot.onclick = function(){ goToSentence(parseInt(dot.getAttribute('data-dot-idx'), 10)); };
    });
    if (isCurrent) {
      Array.prototype.forEach.call(root.querySelectorAll('.rate-row .rate-btn'), function(btn){
        btn.onclick = function(){
          if (st.rating) return;
          st.rating = true;
          stopNarration();
          stopTryListening();
          st.tryResult = null;
          var val = parseInt(btn.getAttribute('data-val'), 10);
          wordsInSentence(sent.g).forEach(function(w){
            addProgress(w.id, val);
            updateWordCell(w.id);
          });
          saveProgress(progress);
          recordActivity();
          sentencesRead++;
          saveJson(SENTENCES_READ_KEY, sentencesRead);
          // Reveal romanization and translation right away, so there's
          // something to read while (optionally) listening to the auto-speak.
          st.readShowRom = true;
          st.readShowTranslation = true;
          renderStories();
          function advance(){
            st.rating = false;
            if (current + 1 >= story.sentences.length) {
              st.readFinished = true;
              story.currentIdx = story.sentences.length;
            } else {
              st.readCurrent = current + 1;
              st.readIdx = current + 1;
              st.readShowRom = false;
              st.readShowTranslation = false;
              story.currentIdx = current + 1;
            }
            saveStories(stories);
            renderStories();
          }
          // Wait for the auto-speak to finish before moving on.
          // (with a time limit, in case a browser never reports the end of speech)
          if (settings.autoSpeak) Promise.race([speak(sent.g), narrationSleep(15000)]).then(advance);
          else setTimeout(advance, 700);
        };
      });
    }
  }
}
