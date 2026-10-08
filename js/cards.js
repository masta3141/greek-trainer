// Cards view: start screen (free practice + Power-Streak) and the flashcard itself.
// Same layout as the HSK Trainer (../chinese-trainer/js/cards.js).
"use strict";

function renderStats(){
  var mastered = WORDS.filter(function(w){ return wordLvl(w.id) >= 40; }).length;
  document.getElementById('statsStrip').innerHTML =
    '<span><b>' + activePool().length + '</b> / ' + WORDS.length + ' ' + esc(t('statsInPool')) + '</span>' +
    '<span><b>' + mastered + '</b> ' + esc(t('statsMastered')) + '</span>' +
    '<span><b>' + settings.sessionSize + '</b> ' + esc(t('statsPerRound')) + '</span>';
}

// Start/finished screen card for free practice — same layout as the
// Power-Streak card below it. The grid shows the funnel:
// all words → pool → words per round → words in focus.
function renderFreeCard(finished){
  var total = WORDS.length;
  var pool = activePool().length;
  var round = Math.min(settings.sessionSize, pool);
  var focus = Math.min(7, round); // window size of activeWindow()
  var paused = finished ? null : loadFreeSession();
  var pausedDone = paused ? paused.ids.filter(function(id){ return paused.sessionPts[id] >= 5; }).length : 0;
  var cells = [[total, 'freeFcTotal'], [pool, 'freeFcPool'], [round, 'freeFcRound'], [focus, 'freeFcFocus']];
  return '<div class="panel mode-card">' +
      '<div class="mode-head"><span class="mode-icon">🎴</span>' +
        '<span class="mode-title">' + esc(t('freeTitle')) + '</span></div>' +
      '<div class="mode-motto">' + esc(finished ? t('finishedTitle') : t('freeMotto')) + '</div>' +
      '<p>' + esc(finished ? t('finishedDesc') : paused ? tf('freePausedStatus', pausedDone, paused.ids.length) : t('freeStatus')) + '</p>' +
      '<div class="mode-grid">' +
        cells.map(function(c){
          return '<div class="mode-cell"><div class="n">' + c[0] + '</div><div class="l">' + esc(t(c[1])) + '</div></div>';
        }).join('') +
      '</div>' +
      '<div class="mode-note">' + esc(t('freeNote')) + '</div>' +
      (paused && !finished
        ? '<div class="mode-btns"><button class="btn-primary" id="btnResume">' + esc(t('freeResumeBtn')) + '</button>' +
            '<button class="btn-secondary" id="btnStart">' + esc(t('freeRestartBtn')) + '</button></div>'
        : '<div class="mode-btns"><button class="btn-primary" id="' + (finished ? 'btnAgain' : 'btnStart') + '">' +
            esc(finished ? t('newRoundBtn') : t('startBtn')) + '</button></div>') +
      '<details class="mode-info"><summary>' + esc(t('streakHowTitle')) + '</summary>' +
        '<p>' + esc(tf('freeHowText', total, pool, round)) + '</p></details>' +
    '</div>';
}

function rateButtonsHtml(attr, values, labels){
  var colors = [4, 28, 58, 92];
  return values.map(function(v, i){
    return '<button class="rate-btn" style="background:' + levelToColor(colors[i]) + '" ' + attr + '="' + v + '">' +
      esc(t(['rateNochmal', 'rateSchwer', 'rateGut', 'rateLeicht'][i])) + '<span class="val">' + esc(labels[i]) + '</span></button>';
  }).join('');
}

function render(justAnswered){
  var main = document.getElementById('main');
  renderStats();

  if (!session || session.finished) {
    var finished = !!session;
    main.innerHTML = renderFreeCard(finished) + renderStreakCard();
    var start = document.getElementById(finished ? 'btnAgain' : 'btnStart');
    start.onclick = startSession;
    var resume = document.getElementById('btnResume');
    if (resume) resume.onclick = resumeFreeSession;
    wireStreakCard();
    return;
  }

  var w = WORD_BY_ID[session.currentId];
  var examples = examplesFor(w.id);
  var barText, dotsHtml = '', rateHtml;

  if (session.streak) {
    var sOpen = powerStreak.open;
    var sCard = powerStreak.cards[w.id];
    var isNewCard = sOpen.newIds[w.id] && !sOpen.rated[w.id];
    var newLeft = sOpen.queue.filter(function(id){ return sOpen.newIds[id] && !sOpen.rated[id]; }).length;
    barText = sOpen.reviewOnly
      ? tf('streakReviewBar', sOpen.queue.length)
      : tf('streakBar', powerStreak.level, newLeft, sOpen.queue.length - newLeft) + (isNewCard ? ' · ' + t('streakNewCard') : '');
    var sClock = sOpen.reviewOnly ? sOpen.clock : powerStreak.clock;
    // Intervals are previewed only for the first rating; repeats in the same stage don't reschedule.
    var ivls = [0, 1, 2, 3].map(function(g){
      if (sOpen.rated[w.id]) return '';
      if (g === 0) return streakIvlLabel(0);
      var r = streakSchedule(sCard, g, sClock, sOpen.reviewOnly);
      return r ? streakIvlLabel(r.ivl) : '=';
    });
    rateHtml = rateButtonsHtml('data-grade', [0, 1, 2, 3], ivls);
  } else {
    var win = session.lastWindow || activeWindow();
    barText = tf('sessionBar', win.prog, win.dictPart.length, session.ids.length);
    dotsHtml = session.ids.slice(0, 20).map(function(id){
      var cls = 'dot';
      if (session.sessionPts[id] >= 5) cls += ' done';
      else if (id === session.currentId) cls += ' active';
      return '<span class="' + cls + '"></span>';
    }).join('');
    rateHtml = rateButtonsHtml('data-val', [0, 1, 2, 5], ['+0', '+1', '+2', '+5']);
  }

  var errHtml = session.generateError ? '<div class="ex-e ex-err">' + esc(session.generateError) + '</div>' : '';
  var exHtml;
  if (examples.length) {
    exHtml = examples.map(function(ex, i){
      return '<div class="ex-row"><div class="ex-g">' +
          '<button class="ex-speak-btn" data-ex-idx="' + i + '" title="' + esc(t('sentenceSpeak')) + '">🔊</button> ' + esc(ex.g) + '</div>' +
        (session.showTranslationInExamples || session.showRom ? '<div class="ex-r">' + esc(ex.r) + '</div>' : '') +
        (session.showTranslationInExamples ? '<div class="ex-e">' + esc(ex.e) + '</div>' : '') +
      '</div>';
    }).join('') +
      (session.generating
        ? '<div class="ex-e">' + esc(t('generatingExamples')) + '</div>'
        : '<button class="hint-btn" id="btnGenExamples">' + esc(t('moreExamplesBtn')) + '</button>') + errHtml;
  } else if (session.generating) {
    exHtml = '<div class="ex-e">' + esc(t('generatingExamples')) + '</div>';
  } else {
    exHtml = '<div class="ex-e" style="margin-bottom:10px;">' + esc(t('noExamples')) + '</div>' +
      '<button class="hint-btn" id="btnGenExamples">' + esc(t('generateExamplesBtn')) + '</button>' + errHtml;
  }

  main.innerHTML =
    '<div class="session-bar">' +
      '<span>' + esc(barText) + '</span>' +
      '<button class="hint-btn session-pause" id="btnPause">' + esc(t('pauseBtn')) + '</button>' +
      '<span class="dots">' + dotsHtml + '</span>' +
    '</div>' +
    '<div class="card">' +
      '<span class="lvl lvl-' + w.l + ' card-lvl">' + w.l + '</span>' +
      '<span class="rank-note">#' + w.id + '</span>' +
      '<div class="word" id="wordText" title="' + esc(t('speakTitle')) + '">' + (w.a ? '<span class="art">' + esc(w.a) + '</span>' : '') + esc(w.w) + '</div>' +
      '<div class="rom-line">' + (session.showRom ? esc(w.r || '') : '') + '</div>' +
      '<div class="hint-row">' +
        '<button class="hint-btn' + (session.showRom ? ' on' : '') + '" id="btnToggleRom">' + esc(session.showRom ? t('romHide') : t('romShow')) + '</button>' +
        '<button class="hint-btn' + (session.showSolution ? ' on' : '') + '" id="btnSolution">' + esc(t('translationBtn')) + '</button>' +
        '<button class="hint-btn' + (session.showExamples ? ' on' : '') + '" id="btnExamples">' + esc(t('examplesBtn')) + '</button>' +
        '<button class="hint-btn" id="btnRead">' + esc(t('readBtn')) + '</button>' +
      '</div>' +
      '<div class="solution-line">' + (session.showSolution ? esc(w.e) + (w.p ? ' <span class="pos">· ' + esc(posName(w.p)) + '</span>' : '') : '') + '</div>' +
      '<div class="examples-box' + (session.showExamples ? ' show' : '') + '">' +
        (examples.length ? '<button class="hint-btn' + (session.showTranslationInExamples ? ' on' : '') + '" id="btnExTranslation" style="margin-bottom:10px;">' + esc(t('translationInExamples')) + '</button>' : '') +
        exHtml +
      '</div>' +
      '<div class="feedback-toast">' + (justAnswered ? esc(t('savedToast')) : '') + '</div>' +
      '<div class="rate-row">' + rateHtml + '</div>' +
    '</div>';

  document.getElementById('btnPause').onclick = pauseSession;
  document.getElementById('wordText').onclick = function(){ speak(w.w); };
  document.getElementById('btnRead').onclick = function(){ speak(w.w); };
  document.getElementById('btnToggleRom').onclick = function(){ session.showRom = !session.showRom; render(); };
  document.getElementById('btnSolution').onclick = function(){ session.showSolution = !session.showSolution; render(); };
  document.getElementById('btnExamples').onclick = function(){ session.showExamples = !session.showExamples; render(); };
  var exT = document.getElementById('btnExTranslation');
  if (exT) exT.onclick = function(){ session.showTranslationInExamples = !session.showTranslationInExamples; render(); };

  Array.prototype.forEach.call(main.querySelectorAll('.ex-speak-btn'), function(btn){
    btn.onclick = function(){
      var ex = examples[parseInt(btn.getAttribute('data-ex-idx'), 10)];
      if (ex) speak(ex.g);
    };
  });

  var btnGen = document.getElementById('btnGenExamples');
  if (btnGen) btnGen.onclick = function(){
    var s = session;
    s.generating = true;
    s.generateError = null;
    render();
    generateExamplesFor(w).then(function(){
      s.generating = false;
      s.showExamples = true;
      if (session === s) render();
    }).catch(function(err){
      s.generating = false;
      if (err.message !== 'no-key') s.generateError = t('errorPrefix') + err.message;
      if (session === s) render();
    });
  };

  Array.prototype.forEach.call(main.querySelectorAll('.rate-btn'), function(btn){
    btn.onclick = session.streak
      ? function(){ rateStreak(parseInt(btn.getAttribute('data-grade'), 10)); }
      : function(){ rate(parseInt(btn.getAttribute('data-val'), 10)); };
  });
}
