// Gemini: API key and model, the shared text call, example sentences (stored in IndexedDB).
"use strict";

// ---------- key and model ----------
function loadGeminiKey(){
  try { return localStorage.getItem(GEMINI_KEY_STORE) || ''; } catch(e) { return ''; }
}
function saveGeminiKey(k){
  try { localStorage.setItem(GEMINI_KEY_STORE, k); } catch(e) {}
}
function loadGeminiModel(){
  try { return localStorage.getItem(GEMINI_MODEL_STORE) || DEFAULT_GEMINI_MODEL; } catch(e) { return DEFAULT_GEMINI_MODEL; }
}
var GEMINI_MODELS_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// Picks the newest stable model whose id matches one of the patterns, in
// order of preference (preview/exp/dated variants don't match).
function pickNewestModel(ids, patterns){
  for (var i = 0; i < patterns.length; i++) {
    var best = null, bestVer = null;
    ids.forEach(function(id){
      var m = patterns[i].exec(id);
      if (!m) return;
      var ver = m[1].split('.').map(Number);
      if (!bestVer || ver[0] > bestVer[0] || (ver[0] === bestVer[0] && (ver[1] || 0) > (bestVer[1] || 0))) { best = id; bestVer = ver; }
    });
    if (best) return best;
  }
  return null;
}
// Asks the API which models this key can use and stores the newest
// flash-lite (else flash) model. At most once a week unless forced (new key).
function detectGeminiModels(force){
  var key = loadGeminiKey();
  if (!key) return Promise.resolve();
  try {
    var last = parseInt(localStorage.getItem(GEMINI_MODELS_CHECKED_KEY), 10) || 0;
    if (!force && Date.now() - last < GEMINI_MODELS_RECHECK_MS) return Promise.resolve();
  } catch(e) {}
  return fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=' + encodeURIComponent(key))
    .then(function(res){ if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then(function(data){
      var ids = (data.models || []).filter(function(m){
        return (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0;
      }).map(function(m){ return String(m.name).replace(/^models\//, ''); });
      var text = pickNewestModel(ids, [/^gemini-(\d+(?:\.\d+)?)-flash-lite$/, /^gemini-(\d+(?:\.\d+)?)-flash$/]);
      try {
        if (text) localStorage.setItem(GEMINI_MODEL_STORE, text);
        localStorage.setItem(GEMINI_MODELS_CHECKED_KEY, String(Date.now()));
      } catch(e) {}
    })
    .catch(function(){});
}

// Without a key: open the settings at the key field and reject with 'no-key'.
function requireGeminiKey(){
  var key = loadGeminiKey();
  if (key) return key;
  openDrawer();
  var f = document.getElementById('inpGeminiKey');
  if (f) f.focus();
  return null;
}

// One text request; resolves with the model's text answer.
function callGemini(prompt, apiKey){
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(loadGeminiModel()) +
    ':generateContent?key=' + encodeURIComponent(apiKey);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  }).then(function(res){
    if (!res.ok) return res.text().then(function(txt){ throw new Error('HTTP ' + res.status + ': ' + txt); });
    return res.json();
  }).then(function(data){
    return data.candidates[0].content.parts[0].text;
  });
}

// Lines of "GREEK|ROMANIZATION|ENGLISH" → [{g, r, e}]
function parseGeminiResponse(text){
  var out = [];
  String(text || '').split(/\n/).forEach(function(line){
    var parts = line.replace(/\r/g, '').trim().split('|');
    if (parts.length === 3 && parts[0].trim()) out.push({ g: parts[0].trim(), r: parts[1].trim(), e: parts[2].trim() });
  });
  return out;
}

// ---------- example sentences store ----------
// One IndexedDB record per word id: [{g, r, e}, ...], mirrored in memory in
// generatedExamples so examplesFor() stays synchronous. Without IndexedDB
// (e.g. blocked in private mode) one localStorage blob is used instead.
var EXAMPLES_LS_KEY = 'grtrain_examples_v1';
var EXAMPLES_DB_NAME = 'grtrain_examples_db';
var EXAMPLES_STORE = 'examples';
var examplesDbPromise = null;
var examplesUseIdb = 'indexedDB' in window;
var examplesReady = null;
var generatedExamples = {};

function examplesFor(wordId){
  return generatedExamples[String(wordId)] || [];
}
function openExamplesDB(){
  if (examplesDbPromise) return examplesDbPromise;
  examplesDbPromise = new Promise(function(resolve, reject){
    var req = indexedDB.open(EXAMPLES_DB_NAME, 1);
    req.onupgradeneeded = function(e){
      var db = e.target.result;
      if (!db.objectStoreNames.contains(EXAMPLES_STORE)) db.createObjectStore(EXAMPLES_STORE);
    };
    req.onsuccess = function(e){ resolve(e.target.result); };
    req.onerror = function(){ reject(req.error); };
  });
  return examplesDbPromise;
}
// Runs fn(store) in one readwrite transaction; resolves when it is committed.
function examplesTx(fn){
  return openExamplesDB().then(function(db){
    return new Promise(function(resolve, reject){
      var tx = db.transaction(EXAMPLES_STORE, 'readwrite');
      fn(tx.objectStore(EXAMPLES_STORE));
      tx.oncomplete = function(){ resolve(); };
      tx.onerror = function(){ reject(tx.error); };
    });
  });
}
function initExamplesStore(){
  if (!examplesUseIdb) {
    generatedExamples = loadJson(EXAMPLES_LS_KEY, {});
    examplesReady = Promise.resolve();
    return examplesReady;
  }
  examplesReady = openExamplesDB().then(function(db){
    return new Promise(function(resolve, reject){
      var req = db.transaction(EXAMPLES_STORE, 'readonly').objectStore(EXAMPLES_STORE).openCursor();
      req.onsuccess = function(){
        var cur = req.result;
        if (cur) { generatedExamples[cur.key] = cur.value; cur.continue(); } else resolve();
      };
      req.onerror = function(){ reject(req.error); };
    });
  }).catch(function(){
    examplesUseIdb = false;
    generatedExamples = loadJson(EXAMPLES_LS_KEY, {});
  });
  return examplesReady;
}
function saveGeneratedExamplesFor(key){
  if (!examplesUseIdb) { saveJson(EXAMPLES_LS_KEY, generatedExamples); return; }
  examplesTx(function(store){ store.put(generatedExamples[key], key); }).catch(function(){});
}
// Replaces the whole store (import).
function saveGeneratedExamples(g){
  generatedExamples = g;
  if (!examplesUseIdb) { saveJson(EXAMPLES_LS_KEY, g); return Promise.resolve(); }
  return examplesTx(function(store){
    store.clear();
    Object.keys(g).forEach(function(k){ store.put(g[k], k); });
  }).catch(function(){});
}

// ---------- example sentence generation ----------
// existing: sentences the word already has — Gemini is asked for new ones.
function buildExamplesPrompt(w, existing){
  return "You are a precise linguistic API for a Modern Greek learning app.\n" +
    "TASK: Generate exactly 3 distinct example sentences in Modern Greek that use the given word (any inflected form is fine).\n" +
    "INPUT PARAMETERS:\n" +
    "- Target word: " + w.w + (w.e ? " (meaning: " + w.e + ")" : "") + "\n" +
    "- Target level: CEFR " + w.l + "\n" +
    (existing && existing.length
      ? "These example sentences already exist:\n" + existing.map(function(g){ return "- " + g; }).join("\n") + "\n" +
        "Create 3 NEW sentences that differ from them in content and structure (other situations, other sentence patterns). Do not repeat or paraphrase them.\n"
      : "") +
    "STRICT OUTPUT RULES:\n" +
    "1. Output MUST contain exactly 3 lines. Nothing else.\n" +
    "2. No introduction, no markdown fences (do NOT use ```), no explanatory text.\n" +
    "3. Every sentence must use vocabulary and grammar appropriate for CEFR " + w.l + " or below, with correct accents (monotonic orthography).\n" +
    "4. Each line MUST follow this exact pipe-separated format: GREEK|ROMANIZATION|ENGLISH\n" +
    "5. ROMANIZATION is a simple Latin transliteration of the Greek sentence with the stressed vowel marked by an acute accent.";
}

function generateExamplesFor(w){
  var apiKey = requireGeminiKey();
  if (!apiKey) { alert(t('geminiKeyMissing')); return Promise.reject(new Error('no-key')); }
  var existing = examplesFor(w.id).map(function(ex){ return ex.g; });
  return callGemini(buildExamplesPrompt(w, existing), apiKey).then(function(text){
    // Drop sentences the word already has (ignoring punctuation, case, accents).
    var norm = function(g){ return fold(g).replace(/[\s.,;:!?·«»"'()…-]/g, ''); };
    var known = {};
    existing.forEach(function(g){ known[norm(g)] = true; });
    var parsed = parseGeminiResponse(text).filter(function(ex){
      var k = norm(ex.g);
      if (known[k]) return false;
      known[k] = true;
      return true;
    });
    if (!parsed.length) throw new Error(existing.length ? t('noNewSentences') : t('unreadableAnswer'));
    // Wait until the stored examples are loaded, so they aren't overwritten.
    return (examplesReady || Promise.resolve()).then(function(){
      var key = String(w.id);
      generatedExamples[key] = (generatedExamples[key] || []).concat(parsed);
      saveGeneratedExamplesFor(key);
      return parsed;
    });
  });
}
