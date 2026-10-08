// Power-Streak: stages with their own SRS, separate from the regular session.
// Same logic as the HSK Trainer (../chinese-trainer/js/streak.js).
"use strict";

// Each press of the streak button starts a new "stage": streak +1, 5 new words
// from the pool (lowest lvl first, random within a lvl), plus every SRS card
// that is due. The stage is done once its queue is empty. The SRS runs on its
// own clock (in "days"): each new stage advances it by the real days elapsed
// since the previous stage, but at least 1 — so several stages on one day
// still bring up reviews. The streak never drops; only an explicit restart
// clears it (together with all SRS cards). The only link to regular progress:
// the first Gut/Leicht rating of a card per stage gives +1 lvl.
var STREAK_KEY = 'grtrain_streak_v1';
var STREAK_NEW_PER_STAGE = 5;
var STREAK_REQUEUE_GAP = 3;   // a "Nochmal" card comes back after this many other cards
var STREAK_MAX_IVL = 365;
var STREAK_MIN_EASE = 1.3;

function emptyStreak(){
  // cards: wordId -> {ease, ivl, due, last, reps, lapses} (due/last on the SRS clock)
  // open: current stage — {queue: [ids], rated: {id: true}, newIds: {id: true}, total}
  return { level: 0, clock: 0, lastRealDay: null, cards: {}, open: null };
}
function loadStreak(){
  try {
    var s = JSON.parse(localStorage.getItem(STREAK_KEY));
    if (s && typeof s === 'object' && s.cards && typeof s.level === 'number') return s;
  } catch(e) {}
  return emptyStreak();
}
function saveStreak(s){
  try { localStorage.setItem(STREAK_KEY, JSON.stringify(s)); } catch(e) {}
}
var powerStreak = loadStreak();

// Local calendar day as an integer, so "a day has passed" follows the user's midnight.
function localDayNumber(){
  var d = new Date();
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}
function streakStageOpen(){
  return !!(powerStreak.open && powerStreak.open.queue.length && !powerStreak.open.reviewOnly);
}
// A review-only round ("Nur wiederholen") that was left unfinished.
function streakReviewOpen(){
  return !!(powerStreak.open && powerStreak.open.queue.length && powerStreak.open.reviewOnly);
}
function streakReviewable(){
  return Object.keys(powerStreak.cards).filter(function(id){
    return WORD_BY_ID[id] && powerStreak.cards[id].last != null;
  }).map(Number);
}
// SRS clock value the next stage would run on.
function streakNextClock(){
  if (powerStreak.level === 0 || powerStreak.lastRealDay == null) return powerStreak.clock;
  return powerStreak.clock + Math.max(1, localDayNumber() - powerStreak.lastRealDay);
}
function streakDueIds(clock){
  return Object.keys(powerStreak.cards).filter(function(id){
    return WORD_BY_ID[id] && powerStreak.cards[id].due <= clock;
  }).map(Number);
}
// Pool words not yet in the streak: take the lowest-lvl group first, random within it.
function streakPickNew(n){
  var byLvl = {};
  activePool().forEach(function(w){
    if (powerStreak.cards[w.id]) return;
    var lvl = wordLvl(w.id);
    (byLvl[lvl] = byLvl[lvl] || []).push(w.id);
  });
  var levels = Object.keys(byLvl).map(Number).sort(function(a, b){ return a - b; });
  var out = [];
  for (var i = 0; i < levels.length && out.length < n; i++) {
    out = out.concat(shuffled(byLvl[levels[i]]).slice(0, n - out.length));
  }
  return out;
}
function streakNewCount(){
  ensurePoolFilled();
  return Math.min(STREAK_NEW_PER_STAGE, activePool().filter(function(w){ return !powerStreak.cards[w.id]; }).length);
}

function beginStreakStage(){
  ensurePoolFilled();
  var clock = streakNextClock();
  // Cards added by hand in the grid (never shown yet) count as new words.
  var manual = [];
  var due = streakDueIds(clock).filter(function(id){
    if (powerStreak.cards[id].last == null) { manual.push(id); return false; }
    return true;
  });
  var fresh = streakPickNew(STREAK_NEW_PER_STAGE);
  var newIds = {};
  fresh.forEach(function(id){
    newIds[id] = true;
    powerStreak.cards[id] = { ease: 2.5, ivl: 0, due: clock, last: null, reps: 0, lapses: 0 };
  });
  manual.forEach(function(id){ newIds[id] = true; });
  powerStreak.clock = clock;
  powerStreak.lastRealDay = localDayNumber();
  powerStreak.level++;
  // New words first, then the reviews.
  var queue = shuffled(fresh.concat(manual)).concat(shuffled(due));
  powerStreak.open = { queue: queue, rated: {}, newIds: newIds, total: queue.length };
  saveStreak(powerStreak);
}

// Review-only round: 10 cards from the streak, no new words, streak unchanged.
// Runs on the SRS clock plus the real days since the last stage (without the
// +1-per-stage rule), and picks cards weighted towards the ones due soonest.
var STREAK_REVIEW_SIZE = 10;
function beginStreakReview(){
  var clock = powerStreak.clock + Math.max(0, localDayNumber() - (powerStreak.lastRealDay || localDayNumber()));
  var cands = streakReviewable().map(function(id){
    return { id: id, weight: 1 / (1 + Math.max(0, powerStreak.cards[id].due - clock)) };
  });
  var picked = [];
  while (picked.length < STREAK_REVIEW_SIZE && cands.length) {
    var sum = cands.reduce(function(a, c){ return a + c.weight; }, 0);
    var r = Math.random() * sum, i = 0;
    while (i < cands.length - 1 && (r -= cands[i].weight) > 0) i++;
    picked.push(cands.splice(i, 1)[0].id);
  }
  powerStreak.open = { queue: picked, rated: {}, newIds: {}, total: picked.length, reviewOnly: true, clock: clock };
  saveStreak(powerStreak);
}

// Review-only rounds push cards only gently: Schwer leaves the card exactly as
// it is (a due card stays due), and a card that isn't due yet moves back by
// just a fraction of its interval on Gut/Leicht (ease unchanged).
var STREAK_EARLY_GOOD = 0.2;
// Damping for regular reviews: intervals grow by ease × this on Gut (with the
// start ease 2.5 that's ×2: 1, 2, 4, 8, 16 … days) and additionally × the
// Leicht bonus on Leicht.
var STREAK_IVL_FACTOR = 0.8;
var STREAK_EASY_BONUS = 1.2;
var STREAK_EARLY_EASY = 0.4;

// grade: 0 Nochmal, 1 Schwer, 2 Gut, 3 Leicht. Returns the new {ease, ivl}
// without touching the card, so the rate buttons can preview the intervals —
// or null when the card is to be left unchanged.
function streakSchedule(c, grade, clock, reviewOnly){
  var ease = c.ease, ivl;
  if (reviewOnly && grade === 1) return null;
  if (reviewOnly && c.last != null && clock < c.due && grade >= 2) {
    var push = grade === 2
      ? Math.max(1, Math.round(c.ivl * STREAK_EARLY_GOOD))
      : Math.max(2, Math.round(c.ivl * STREAK_EARLY_EASY));
    return { ease: ease, ivl: Math.min(STREAK_MAX_IVL, c.due + push - clock) };
  }
  // Nochmal: due again right away, i.e. always among the due cards of the
  // next stage (also after a review-only round on a later day).
  if (grade === 0) {
    return { ease: Math.max(STREAK_MIN_EASE, c.last == null ? ease : ease - 0.2), ivl: 0 };
  }
  if (c.last == null) {
    ivl = grade === 3 ? 3 : 1;
  } else {
    // Base is the real gap since the last review: overdue cards that are still
    // known get credit for it, and cards reviewed early (review-only rounds) grow less.
    var base = Math.max(1, clock - c.last);
    // Schwer never improves a card: the interval is halved (at least 1 day).
    if (grade === 1) { ivl = Math.max(1, Math.floor(c.ivl / 2)); ease -= 0.15; }
    else {
      var good = Math.max(Math.round(base * ease * STREAK_IVL_FACTOR), c.ivl + 1);
      if (grade === 2) ivl = good;
      else { ivl = Math.max(Math.round(base * ease * STREAK_IVL_FACTOR * STREAK_EASY_BONUS), good + 1); ease += 0.1; }
    }
  }
  return { ease: Math.max(STREAK_MIN_EASE, ease), ivl: Math.min(STREAK_MAX_IVL, ivl) };
}

function startStreakRound(){
  if (!streakStageOpen()) beginStreakStage();
  startStreakSession();
}
function startStreakReview(){
  if (!streakReviewOpen()) beginStreakReview();
  startStreakSession();
}
function startStreakSession(){
  session = newSessionState({ streak: true });
  streakNext();
}

function streakNext(){
  if (!session || !session.streak) return;
  // Skip ids whose word no longer exists (e.g. data changed between versions).
  while (powerStreak.open.queue.length && !WORD_BY_ID[powerStreak.open.queue[0]]) powerStreak.open.queue.shift();
  session.awaiting = false;
  if (!powerStreak.open.queue.length) {
    saveStreak(powerStreak);
    session = null; // back to the start screen, whose streak card shows "stage done"
    render();
    return;
  }
  session.currentId = powerStreak.open.queue[0];
  resetCardFlags();
  render();
}

function rateStreak(grade){
  if (!session || !session.streak || session.awaiting || session.currentId == null) return;
  session.awaiting = true;
  var id = session.currentId;
  var open = powerStreak.open;
  var clock = open.reviewOnly ? open.clock : powerStreak.clock;
  var c = powerStreak.cards[id];
  if (!open.rated[id]) {
    // Only the first rating of a card per stage schedules it and earns progress.
    open.rated[id] = true;
    var r = streakSchedule(c, grade, clock, open.reviewOnly);
    if (r) {
      if (grade === 0 && c.last != null) c.lapses++;
      c.ease = r.ease;
      c.ivl = r.ivl;
      c.due = clock + r.ivl;
      c.last = clock;
      c.reps++;
    }
    if (grade >= 2) {
      var p = progress[id] || { lvl: 0, lr: null, seen: false };
      p.lvl = Math.min((p.lvl || 0) + 1, 100);
      p.seen = true;
      progress[id] = p;
      saveProgress(progress);
      updateWordCell(id);
    }
    recordActivity();
  }
  open.queue.shift();
  if (grade === 0) open.queue.splice(Math.min(STREAK_REQUEUE_GAP, open.queue.length), 0, id);
  saveStreak(powerStreak);

  if (settings.autoSpeak) speak(WORD_BY_ID[id].w);
  session.showRom = true;
  session.showSolution = true;
  render(true);
  setTimeout(streakNext, 900);
}

// "+ Streak" in the vocabulary list: add a word as a new card (introduced in the
// next stage together with the new words) or remove it from the streak,
// including from a stage that is currently open.
function setWordInStreak(w, on){
  var id = w.id;
  if (on) {
    if (!powerStreak.cards[id]) powerStreak.cards[id] = { ease: 2.5, ivl: 0, due: powerStreak.clock, last: null, reps: 0, lapses: 0 };
  } else {
    delete powerStreak.cards[id];
    var open = powerStreak.open;
    if (open) {
      open.queue = open.queue.filter(function(q){ return q !== id; });
      delete open.rated[id];
      delete open.newIds[id];
    }
    // The card on screen in a running streak round is gone: move on.
    if (session && session.streak && session.currentId === id) { saveStreak(powerStreak); streakNext(); return; }
  }
  saveStreak(powerStreak);
}

function resetStreak(){
  if (!confirm(t('streakResetConfirm'))) return;
  powerStreak = emptyStreak();
  saveStreak(powerStreak);
  if (session && session.streak) session = null;
  render();
}

function streakMotto(level){
  var tiers = [[100, 7], [50, 6], [30, 5], [14, 4], [7, 3], [3, 2], [1, 1], [0, 0]];
  for (var i = 0; i < tiers.length; i++) {
    if (level >= tiers[i][0]) return t('streakMotto' + tiers[i][1]);
  }
  return '';
}

// Review forecast relative to the next stage's SRS clock:
// [due, +1, +2, +3..5, >5, total cards in the streak]
function streakForecast(){
  var nc = streakNextClock();
  var b = [0, 0, 0, 0, 0];
  var ids = Object.keys(powerStreak.cards).filter(function(id){ return WORD_BY_ID[id]; });
  ids.forEach(function(id){
    var d = powerStreak.cards[id].due - nc;
    b[d <= 0 ? 0 : d === 1 ? 1 : d === 2 ? 2 : d <= 5 ? 3 : 4]++;
  });
  return b.concat(ids.length);
}

function renderStreakCard(){
  var open = streakStageOpen();
  var status, btnLabel;
  if (powerStreak.level === 0) {
    status = t('streakStatusNew');
    btnLabel = t('streakStartBtn');
  } else if (open) {
    status = tf('streakStatusOpen', powerStreak.open.queue.length);
    btnLabel = t('streakContinueBtn');
  } else {
    var dueNext = streakDueIds(streakNextClock());
    var manualNew = dueNext.filter(function(id){ return powerStreak.cards[id].last == null; }).length;
    status = tf('streakStatusDone', streakNewCount() + manualNew, dueNext.length - manualNew);
    btnLabel = t('streakNextBtn');
  }
  return '<div class="panel mode-card">' +
      '<div class="mode-head"><span class="mode-icon">🔥</span>' +
        '<span class="mode-num">' + powerStreak.level + '</span>' +
        '<span class="mode-unit">' + esc(t('streakUnit')) + '</span></div>' +
      '<div class="mode-motto">' + esc(streakMotto(powerStreak.level)) + '</div>' +
      '<p>' + esc(status) + '</p>' +
      renderStreakForecast() +
      '<div class="mode-btns"><button class="btn-primary" id="btnStreak">' + esc(btnLabel) + '</button>' +
        (!open && streakReviewable().length
          ? '<button class="btn-secondary" id="btnStreakReview">' + esc(streakReviewOpen() ? tf('streakReviewContinueBtn', powerStreak.open.queue.length) : tf('streakReviewBtn', STREAK_REVIEW_SIZE)) + '</button>'
          : '') +
      '</div>' +
      '<details class="mode-info"><summary>' + esc(t('streakHowTitle')) + '</summary>' +
        '<p>' + esc(t('streakHowText')) + '</p></details>' +
      (powerStreak.level > 0 ? '<button class="hint-btn mode-reset" id="btnStreakReset">' + esc(t('streakResetBtn')) + '</button>' : '') +
    '</div>';
}
function renderStreakForecast(){
  var f = streakForecast();
  var keys = ['streakFcDue', 'streakFcTomorrow', 'streakFcPlus2', 'streakFcPlus35', 'streakFcLater'];
  return '<div class="mode-grid">' +
      keys.map(function(k, i){
        return '<div class="mode-cell' + (i === 0 ? ' due' : '') + '"><div class="n">' + f[i] + '</div><div class="l">' + esc(t(k)) + '</div></div>';
      }).join('') +
    '</div>' +
    '<div class="mode-note">' + esc(tf('streakFcTotal', f[5])) + '</div>';
}
function wireStreakCard(){
  document.getElementById('btnStreak').onclick = startStreakRound;
  var review = document.getElementById('btnStreakReview');
  if (review) review.onclick = startStreakReview;
  var reset = document.getElementById('btnStreakReset');
  if (reset) reset.onclick = resetStreak;
}

// Interval shown under each rate button, e.g. "↻", "1 T", "3 T".
function streakIvlLabel(days){
  return days > 0 ? tf('streakDays', days) : '↻';
}
