// Vocabulary tab: the word grid — one tile per word, empty until the word has
// been practised, then filled with its progress colour. Search field, a filter
// panel (max level, only pool/streak, progress buckets) and the tap mode
// (info / add-remove pool / add-remove streak).
// Same idea as the pool grid of the HSK Trainer (../chinese-trainer/js/pool.js).
"use strict";

// Ring colour of a tile = the word's CEFR level.
var LEVEL_COLORS = { A1: 'var(--lv-a1)', A2: 'var(--lv-a2)', B1: 'var(--lv-b1)', B2: 'var(--lv-b2)', C1: 'var(--lv-c1)', C2: 'var(--lv-c2)' };

var LEVEL_COUNTS = {};
LEVELS.forEach(function(l){ LEVEL_COUNTS[l] = 0; });
WORDS.forEach(function(w){ LEVEL_COUNTS[w.l]++; });

// Grid filters: max level shown (1..6 = A1..C2), only pool / only streak
// words, progress buckets (0–24, 25–49, 50–74, 75–100; several can be on,
// none = no filter).
var GRID_FILTER_KEY = 'grtrain_grid_filter_v1';
var LVL_BUCKETS = [[0, 24], [25, 49], [50, 74], [75, 100]];
function loadGridFilter(){
  var f = loadJson(GRID_FILTER_KEY, {});
  var max = parseInt(f.max, 10);
  return { max: max >= 1 && max <= LEVELS.length ? max : LEVELS.length, pool: !!f.pool, streak: !!f.streak,
    lvl: Array.isArray(f.lvl) ? f.lvl : [] };
}
var gridFilter = loadGridFilter();
var gridFilterOpen = false;
var gridSearch = '';
// Tap mode: 'info' (toast + pronunciation), 'pool' or 'streak' (add/remove).
var gridTapMode = 'info';
var poolIdSet = {}; // ids of the active pool, refreshed by refreshPoolIdSet()

// Search keys, built once: folded Greek (word, phrases), romanization, English.
var SEARCH_KEY = {};
WORDS.forEach(function(w){
  SEARCH_KEY[w.id] = { g: fold(w.w), r: fold(w.r), all: fold(w.w + ' ' + (w.x || '') + ' ' + (w.r || '') + ' ' + (w.e || '')) };
});

function refreshPoolIdSet(){
  poolIdSet = {};
  activePool().forEach(function(w){ poolIdSet[w.id] = true; });
}
function lvlBucket(lvl){
  for (var i = LVL_BUCKETS.length - 1; i >= 0; i--) if (lvl >= LVL_BUCKETS[i][0]) return i;
  return 0;
}
function activeGridFilterCount(){
  return (gridFilter.max < LEVELS.length ? 1 : 0) + (gridFilter.pool ? 1 : 0) + (gridFilter.streak ? 1 : 0) + (gridFilter.lvl.length ? 1 : 0);
}

// Filter panel below the search field, opened by the "Filter" button. An
// active tap mode keeps its hint visible even when the panel is closed.
function buildGridLegend(){
  var legend = document.getElementById('poolLegend');
  var count = activeGridFilterCount();
  var btn = document.getElementById('btnGridFilter');
  btn.textContent = t('gridFilterBtn') + (count ? ' · ' + count : '') + (gridFilterOpen ? ' ▴' : ' ▾');
  btn.classList.toggle('active', gridFilterOpen || count > 0);
  var levelChips = LEVELS.map(function(l, i){
    return '<button class="legend-chip' + (i + 1 === gridFilter.max ? '' : ' off') + '" data-max="' + (i + 1) + '" title="' + esc(tf('levelSub', LEVEL_COUNTS[l])) + '">' +
      '<span class="dot" style="background:' + LEVEL_COLORS[l] + '"></span>' + l + '</button>';
  }).join('');
  var lvlChips = LVL_BUCKETS.map(function(b, i){
    return '<button class="legend-chip' + (gridFilter.lvl.indexOf(i) >= 0 ? '' : ' off') + '" data-lvl-bucket="' + i + '" title="' + esc(tf('gridFilterLvlTitle', b[0], b[1])) + '">' +
      '<span class="dot" style="background:' + levelToColor((b[0] + b[1]) / 2) + '"></span>' + b[0] + '–' + b[1] + '</button>';
  }).join('');
  var seg = function(m, label){ return '<button class="seg-btn' + (gridTapMode === m ? ' active' : '') + '" data-tap="' + m + '">' + esc(label) + '</button>'; };
  var row = function(label, content){ return '<div class="gf-row"><span class="gf-label">' + esc(label) + '</span><div class="gf-items">' + content + '</div></div>'; };
  legend.innerHTML =
    '<div class="grid-filter-panel' + (gridFilterOpen ? ' open' : '') + '">' +
      row(t('gfLevel'), levelChips) +
      row(t('gfShow'),
        '<button class="legend-chip' + (gridFilter.pool ? '' : ' off') + '" id="btnFilterPool">' + esc(t('gridFilterPool')) + '</button>' +
        '<button class="legend-chip' + (gridFilter.streak ? '' : ' off') + '" id="btnFilterStreak">' + esc(t('gridFilterStreak')) + '</button>') +
      row(t('gfProgress'), lvlChips) +
      row(t('gfTap'), '<div class="seg">' + seg('info', t('gfTapInfo')) + seg('pool', t('gfTapPool')) + seg('streak', t('gfTapStreak')) + '</div>') +
      (count ? '<button class="hint-btn gf-reset" id="btnGridFilterReset">' + esc(t('gfReset')) + '</button>' : '') +
    '</div>' +
    (gridTapMode === 'pool' ? '<div class="pool-edit-hint">' + esc(t('poolEditHint')) + '</div>' : '') +
    (gridTapMode === 'streak' ? '<div class="pool-edit-hint">' + esc(t('streakEditHint')) + '</div>' : '');
}

function filteredGridWords(){
  var q = fold(gridSearch.trim());
  var visible = WORDS.filter(function(w){
    if (LEVELS.indexOf(w.l) >= gridFilter.max) return false;
    if (q && SEARCH_KEY[w.id].all.indexOf(q) < 0) return false;
    if (gridFilter.pool && !poolIdSet[w.id]) return false;
    if (gridFilter.streak && !powerStreak.cards[w.id]) return false;
    if (gridFilter.lvl.length && gridFilter.lvl.indexOf(lvlBucket(wordLvl(w.id))) < 0) return false;
    return true;
  });
  if (q) {
    // best matches first: exact word, then word/romanization prefix, then the rest (id order within each)
    var rank = function(w){
      var k = SEARCH_KEY[w.id];
      if (k.g === q || k.r === q) return 0;
      if (k.g.indexOf(q) === 0 || k.r.indexOf(q) === 0) return 1;
      return 2;
    };
    var r = {};
    visible.forEach(function(w){ r[w.id] = rank(w); });
    visible.sort(function(a, b){ return (r[a.id] - r[b.id]) || (a.id - b.id); });
  }
  return visible;
}

// Font size so that longer Greek words still fit into a tile.
function cellFontSize(len){
  if (len <= 5) return 15;
  if (len <= 8) return 13;
  if (len <= 11) return 11;
  return 9.5;
}

// Tiles show only the first form ("μεγάλος, -η, -ο" → "μεγάλος", "δύο, δυο" → "δύο").
function cellWord(w){ return w.w.split(',')[0].trim(); }

function wordCellMarkup(w){
  var p = progress[w.id];
  var lvl = wordLvl(w.id);
  var marks = (poolIdSet[w.id] ? ' in-pool' : '') + (powerStreak.cards[w.id] ? ' in-streak' : '');
  var title = wordWithArticle(w) + (w.r ? ' · ' + w.r : '') + ' · ' + w.e;
  var ring = 'box-shadow:0 0 0 2px ' + LEVEL_COLORS[w.l] + ';';
  var cw = cellWord(w);
  var fsize = 'font-size:' + cellFontSize(cw.length) + 'px;';
  if (p && p.seen && lvl > 0) {
    return '<div class="pool-cell learned' + marks + '" data-id="' + w.id + '" style="background:' + levelToColor(lvl) + ';' + ring + fsize + '" title="' + esc(title) + '">' +
      '<span class="cw">' + esc(cw) + '</span><span class="lvl-badge">' + lvl + '</span></div>';
  }
  // Not learned yet: an empty tile — except while searching, so you can see what was found.
  var peek = gridSearch.trim() ? '<span class="cw peek" style="' + fsize + '">' + esc(cw) + '</span>' : '';
  return '<div class="pool-cell' + marks + '" data-id="' + w.id + '" style="' + ring + '" title="' + esc(title) + '">' + peek + '</div>';
}

function renderVocab(){
  refreshPoolIdSet();
  buildGridLegend();
  var visible = filteredGridWords();
  document.getElementById('vocabGrid').innerHTML = visible.length
    ? visible.map(wordCellMarkup).join('')
    : '<div class="vocab-empty">' + esc(t('vocabEmpty')) + '</div>';
}

// Re-renders one tile in place (after a rating or a pool/streak change).
function updateWordCell(id){
  var cell = document.querySelector('#vocabGrid .pool-cell[data-id="' + id + '"]');
  if (!cell) return;
  var tmp = document.createElement('div');
  tmp.innerHTML = wordCellMarkup(WORD_BY_ID[id]);
  cell.replaceWith(tmp.firstElementChild);
}
// Pool membership can change for many words at once (pool size, overrides).
function refreshVocabMarks(){ renderVocab(); }

function togglePoolWord(w){
  ensurePoolFilled();
  var on = !poolIdSet[w.id];
  setWordInPool(w, on);
  // the base pool refills itself when a word is taken out
  if (!on) ensurePoolFilled();
  poolChanged();
  showToast(tf(on ? 'poolAddedToast' : 'poolRemovedToast', wordWithArticle(w)));
}
function toggleStreakWord(w){
  var on = !powerStreak.cards[w.id];
  setWordInStreak(w, on);
  updateWordCell(w.id);
  if (!session) render();
  showToast(tf(on ? 'streakAddedToast' : 'streakRemovedToast', wordWithArticle(w)));
}

function initVocab(){
  var search = document.getElementById('vocabSearch');
  var timer = null;
  search.addEventListener('input', function(){
    clearTimeout(timer);
    timer = setTimeout(function(){ gridSearch = search.value; renderVocab(); }, 150);
  });
  document.getElementById('btnGridFilter').onclick = function(){ gridFilterOpen = !gridFilterOpen; buildGridLegend(); };
  document.getElementById('poolLegend').addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-tap')) {
      // tapping the active mode again goes back to "Info"
      var m = b.getAttribute('data-tap');
      gridTapMode = gridTapMode === m ? 'info' : m;
      buildGridLegend();
      return;
    }
    if (b.hasAttribute('data-max')) gridFilter.max = parseInt(b.getAttribute('data-max'), 10);
    else if (b.hasAttribute('data-lvl-bucket')) {
      var i = parseInt(b.getAttribute('data-lvl-bucket'), 10);
      var at = gridFilter.lvl.indexOf(i);
      if (at >= 0) gridFilter.lvl.splice(at, 1); else gridFilter.lvl.push(i);
    }
    else if (b.id === 'btnFilterPool') gridFilter.pool = !gridFilter.pool;
    else if (b.id === 'btnFilterStreak') gridFilter.streak = !gridFilter.streak;
    else if (b.id === 'btnGridFilterReset') gridFilter = { max: LEVELS.length, pool: false, streak: false, lvl: [] };
    else return;
    saveJson(GRID_FILTER_KEY, gridFilter);
    renderVocab();
  });
  document.getElementById('vocabGrid').addEventListener('click', function(e){
    var cell = e.target.closest('.pool-cell');
    if (!cell) return;
    var w = WORD_BY_ID[+cell.getAttribute('data-id')];
    if (gridTapMode === 'pool') togglePoolWord(w);
    else if (gridTapMode === 'streak') toggleStreakWord(w);
    else { showWordToast(w); speak(w.w); }
  });
}
