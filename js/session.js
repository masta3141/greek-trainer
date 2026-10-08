// Flashcard session: word pool, session algorithm (port of VBA GetNext2), rating.
// Same algorithm as the HSK Trainer (../chinese-trainer/js/session.js).
"use strict";

// Fills the pool up to settings.pool words, in id order (A1 first, frequent words first).
function ensurePoolFilled(){
  var reviewed = WORDS.filter(function(w){ return progress[w.id] && progress[w.id].lr; });
  var need = settings.pool - reviewed.length;
  if (need > 0) {
    for (var i = 0; i < WORDS.length && need > 0; i++) {
      var w = WORDS[i];
      if (progress[w.id] && progress[w.id].lr) continue;
      progress[w.id] = { lvl: (progress[w.id] && progress[w.id].lvl) || 0, lr: EPOCH_LONG_AGO, seen: !!(progress[w.id] && progress[w.id].seen) };
      need--;
    }
    saveProgress(progress);
  }
}

// Base pool: the first settings.pool reviewed words in id order.
function basePool(){
  return WORDS.filter(function(w){ return progress[w.id] && progress[w.id].lr; }).slice(0, settings.pool);
}

// Manual pool selection ("+ Pool" in the vocabulary list, "Satz in den Pool"):
// wordId -> true (added) | false (removed from the base).
var POOL_OVERRIDES_KEY = 'grtrain_pool_overrides_v1';
var poolOverrides = loadJson(POOL_OVERRIDES_KEY, {});
function savePoolOverrides(o){ saveJson(POOL_OVERRIDES_KEY, o); }

// Effective pool used everywhere: base pool plus added minus removed words, in id order.
function activePool(){
  var inBase = {};
  var out = basePool().filter(function(w){ inBase[w.id] = true; return poolOverrides[w.id] !== false; });
  WORDS.forEach(function(w){ if (poolOverrides[w.id] === true && !inBase[w.id]) out.push(w); });
  return out.sort(function(a, b){ return a.id - b.id; });
}
function setWordInPool(w, on){
  var inBase = basePool().some(function(x){ return x.id === w.id; });
  if (on === inBase) delete poolOverrides[w.id];
  else poolOverrides[w.id] = on;
  savePoolOverrides(poolOverrides);
}
// After the pool changed: refresh what shows it.
function poolChanged(){
  refreshVocabMarks();
  renderStats();
  if (!session) render();
}

var session = null; // { ids, sessionPts: {id: pts}, currentId, lastWindow, finished, show* flags } or a streak session

function newSessionState(extra){
  return Object.assign({
    currentId: null,
    showRom: false,
    showTranslationInExamples: false,
    showExamples: false,
    showSolution: false,
    finished: false
  }, extra);
}

function startSession(){
  ensurePoolFilled();
  var pool = activePool();
  if (pool.length === 0) { session = null; render(); return; }
  var n = Math.min(settings.sessionSize, pool.length);

  // Reserve up to 5 slots for the words with the least progress so far (lowest
  // lvl), so weak words keep surfacing instead of being drowned out by chance.
  var leastSlots = Math.min(5, n);
  var byProgress = pool.slice().sort(function(a, b){
    var la = wordLvl(a.id), lb = wordLvl(b.id);
    if (la !== lb) return la - lb;
    return Math.random() - 0.5;
  });
  var leastProgress = byProgress.slice(0, leastSlots);
  var leastIds = {};
  leastProgress.forEach(function(w){ leastIds[w.id] = true; });

  var rest = shuffled(pool.filter(function(w){ return !leastIds[w.id]; }));
  var picked = shuffled(leastProgress.concat(rest.slice(0, n - leastProgress.length)));

  var sessionPts = {};
  picked.forEach(function(w){ sessionPts[w.id] = 0; });
  session = newSessionState({ ids: picked.map(function(w){ return w.id; }), sessionPts: sessionPts });
  pickNext();
  saveFreeSession();
}

// ---------- pause / resume of the free-practice round ----------
// The running round is kept in localStorage (ids + round points), so it can be
// paused with "⏸ Pause" and resumed later — even after the app was closed.
var FREE_SESSION_KEY = 'grtrain_free_session_v1';
function saveFreeSession(){
  try {
    if (session && !session.streak && !session.finished) {
      localStorage.setItem(FREE_SESSION_KEY, JSON.stringify({ ids: session.ids, sessionPts: session.sessionPts }));
    } else if (!session || !session.streak) {
      localStorage.removeItem(FREE_SESSION_KEY);
    }
  } catch(e) {}
}
// The paused round, or null.
function loadFreeSession(){
  var s = loadJson(FREE_SESSION_KEY, null);
  if (!s || !Array.isArray(s.ids)) return null;
  var ids = s.ids.filter(function(id){ return WORD_BY_ID[id]; });
  if (!ids.length) return null;
  var pts = {};
  ids.forEach(function(id){ pts[id] = (s.sessionPts && s.sessionPts[id]) || 0; });
  if (ids.every(function(id){ return pts[id] >= 5; })) return null;
  return { ids: ids, sessionPts: pts };
}
function resumeFreeSession(){
  var s = loadFreeSession();
  if (!s) { startSession(); return; }
  session = newSessionState({ ids: s.ids, sessionPts: s.sessionPts });
  pickNext();
}
// "⏸ Pause" in a running round (free practice or Power-Streak): back to the
// start screen; the free round is saved, an open streak stage is saved anyway.
function pauseSession(){
  if (!session) return;
  if (!session.streak) saveFreeSession();
  session = null;
  render();
}

function activeWindow(){
  // mirrors GetNext2: scan session.ids from the start, collect up to 7 with sessionPts < 5
  var dictPart = [];
  var prog = 0;
  for (var i = 0; i < session.ids.length; i++){
    var id = session.ids[i];
    if (session.sessionPts[id] < 5) dictPart.push(id);
    else prog++;
    if (dictPart.length === 7) break;
  }
  return { dictPart: dictPart, prog: prog };
}

function resetCardFlags(){
  session.generateError = null;
  session.showRom = false;
  session.showTranslationInExamples = false;
  session.showExamples = false;
  session.showSolution = false;
}

function pickNext(){
  var win = activeWindow();
  session.lastWindow = win;
  if (win.dictPart.length === 0) {
    session.finished = true;
    saveFreeSession(); // round done: nothing left to resume
    render();
    return;
  }
  var choices = win.dictPart;
  if (choices.length > 1 && session.currentId != null) {
    // Never repeat the card that's currently showing, unless it's the only one left.
    var withoutCurrent = choices.filter(function(id){ return id !== session.currentId; });
    if (withoutCurrent.length > 0) choices = withoutCurrent;
  }
  session.currentId = choices[rnd(choices.length)];
  resetCardFlags();
  render();
}

function rate(val){
  if (!session || session.currentId == null || session.awaiting) return;
  session.awaiting = true;
  var id = session.currentId;
  addProgress(id, val);
  saveProgress(progress);
  updateWordCell(id);
  recordActivity();

  if (settings.autoSpeak) speak(WORD_BY_ID[id].w);

  session.sessionPts[id] = (session.sessionPts[id] || 0) + val;
  saveFreeSession();
  session.showRom = true;
  session.showSolution = true;
  render(true);

  setTimeout(function(){
    if (!session || session.streak) return;
    session.awaiting = false;
    pickNext();
  }, 900);
}
