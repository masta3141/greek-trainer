// Core: word data lookups, storage keys, settings, progress, activity, shared helpers.
"use strict";

var LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
var WORD_BY_ID = {};
WORDS.forEach(function(w){ WORD_BY_ID[w.id] = w; });

// localStorage keys: all prefixed grtrain_ and versioned _v1
var SET_KEY = 'grtrain_settings_v1';
var PROG_KEY = 'grtrain_progress_v1';
var FONT_KEY = 'grtrain_fonts_v1';
var ACTIVITY_KEY = 'grtrain_activity_days_v1';
var TOTAL_RATINGS_KEY = 'grtrain_total_ratings_v1';
var DAILY_COUNTS_KEY = 'grtrain_daily_counts_v1';
var GEMINI_KEY_STORE = 'grtrain_gemini_key_v1';
var GEMINI_MODEL_STORE = 'grtrain_gemini_model_v1';
var GEMINI_MODELS_CHECKED_KEY = 'grtrain_gemini_models_checked_v1';
var EPOCH_LONG_AGO = '2000-01-01T00:00:00.000Z';

var DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'; // fallback until detectGeminiModels() has run

// voiceName '' = pick the best Greek voice automatically; speechRate for the browser TTS
var DEFAULT_SETTINGS = { lang: '', view: 'cards', pool: 300, sessionSize: 20,
  autoSpeak: true, voiceName: '', speechRate: 0.9 };

function loadJson(key, fallback){
  try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch(e) { return fallback; }
}
function saveJson(key, v){
  try { localStorage.setItem(key, JSON.stringify(v)); } catch(e) {}
}

function loadSettings(){
  var s = loadJson(SET_KEY, {});
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function(k){ out[k] = s[k] !== undefined ? s[k] : DEFAULT_SETTINGS[k]; });
  return out;
}
function saveSettings(){ saveJson(SET_KEY, settings); }
var settings = loadSettings();

// ---------- progress ----------
// progress[wordId] = {lvl: 0..100, lr: ISO date | null, seen: bool}. Words
// without an entry count as {lvl: 0, lr: null, seen: false}. A word is in the
// pool once lr is set (EPOCH_LONG_AGO for pool-filled but never rated words).
function loadProgress(){ return loadJson(PROG_KEY, {}); }
function saveProgress(p){ saveJson(PROG_KEY, p); }
var progress = loadProgress();
function wordLvl(id){ return (progress[id] && progress[id].lvl) || 0; }
// Adds val points to a word's progress (card ratings, story sentences).
function addProgress(id, val){
  var p = progress[id] || { lvl: 0, lr: null, seen: false };
  p.lr = new Date().toISOString();
  p.lvl = Math.min((p.lvl || 0) + val, 100);
  p.seen = true;
  progress[id] = p;
}

// ---------- fonts ----------
// Only fonts installed on the device, nothing loaded from the web.
var FONT_STACKS = {
  serif: "'Noto Serif', 'GFS Didot', Georgia, 'Times New Roman', serif",
  sans: "'Noto Sans', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
};
var DEFAULT_FONTS = { family: 'serif', wordSize: 64, exampleSize: 18 };
function loadFonts(){ return Object.assign({}, DEFAULT_FONTS, loadJson(FONT_KEY, {})); }
function saveFonts(f){ saveJson(FONT_KEY, f); }
function applyFonts(){
  var root = document.documentElement.style;
  root.setProperty('--greek-font', FONT_STACKS[fonts.family] || FONT_STACKS.serif);
  root.setProperty('--word-size', 'clamp(' + Math.round(fonts.wordSize * 0.62) + 'px, 11vw, ' + fonts.wordSize + 'px)');
  root.setProperty('--example-size', fonts.exampleSize + 'px');
}
var fonts = loadFonts();
applyFonts();

// ---------- activity (streak of practice days, ratings per day) ----------
function todayStr(){ return new Date().toISOString().slice(0, 10); }
function recordActivity(){
  var days = loadJson(ACTIVITY_KEY, []);
  var t = todayStr();
  if (days.indexOf(t) === -1) { days.push(t); saveJson(ACTIVITY_KEY, days); }
  saveJson(TOTAL_RATINGS_KEY, (loadJson(TOTAL_RATINGS_KEY, 0) || 0) + 1);
  var counts = loadJson(DAILY_COUNTS_KEY, {});
  counts[t] = (counts[t] || 0) + 1;
  saveJson(DAILY_COUNTS_KEY, counts);
}

// ---------- helpers ----------
function rnd(n){ return Math.floor(Math.random() * n); }
function shuffled(arr){
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = rnd(i + 1);
    var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

// Lowercase and strip accents/diacritics, so "αγαπω" finds "αγαπώ" and
// "agapo" finds "agapó". Final sigma counts as σ.
function fold(s){
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ');
}

// Display form with the article for nouns: "η αγάπη"
function wordWithArticle(w){
  return (w.a ? w.a + ' ' : '') + w.w;
}

// Progress colour in the colours of the Greek flag: white (0) → light blue
// (25) → medium blue (50) → Hellas blue (75+), slightly deeper at 100.
var PROGRESS_STOPS = [
  { p: 0,   c: [255, 255, 255] },
  { p: 25,  c: [200, 220, 240] },
  { p: 50,  c: [112, 160, 212] },
  { p: 75,  c: [13, 94, 175] },
  { p: 100, c: [8, 70, 138] }
];
function levelToRgb(lvl){
  var v = Math.max(0, Math.min(100, lvl));
  var lo = PROGRESS_STOPS[0], hi = PROGRESS_STOPS[PROGRESS_STOPS.length - 1];
  for (var i = 0; i < PROGRESS_STOPS.length - 1; i++) {
    if (v >= PROGRESS_STOPS[i].p && v <= PROGRESS_STOPS[i+1].p) { lo = PROGRESS_STOPS[i]; hi = PROGRESS_STOPS[i+1]; break; }
  }
  var t = (v - lo.p) / ((hi.p - lo.p) || 1);
  return [0, 1, 2].map(function(k){ return Math.round(lo.c[k] + (hi.c[k] - lo.c[k]) * t); });
}
function levelToColor(lvl){ return 'rgb(' + levelToRgb(lvl).join(',') + ')'; }
// Readable text on that background: dark blue-grey on the light shades, white on the blues.
function levelTextColor(lvl){
  var c = levelToRgb(lvl);
  var lum = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
  return lum > 0.6 ? '#1c2b3c' : '#ffffff';
}
// Inline style for anything filled with a progress colour (tiles, rate buttons).
function levelStyle(lvl){ return 'background:' + levelToColor(lvl) + ';color:' + levelTextColor(lvl) + ';'; }

var toastTimer = null;
function showToast(text){
  var el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function(){ el.classList.remove('show'); }, 2600);
}
function wordInfoText(w){
  var lvl = wordLvl(w.id);
  return wordWithArticle(w) + (w.r ? ' · ' + w.r : '') + ' · ' + w.e + (lvl > 0 ? ' · ' + t('cellLevelLabel') + ' ' + lvl : '');
}
function showWordToast(w){ if (w) showToast(wordInfoText(w)); }

function downloadJson(payload, filenamePrefix){
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filenamePrefix + '-' + todayStr() + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
}
