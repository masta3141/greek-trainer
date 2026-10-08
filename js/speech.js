// Speech: browser TTS (best Greek voice), read aloud, story narration, speech recognition.
"use strict";

// ---------- voices ----------
// Browsers differ a lot: Chrome on Linux only has eSpeak (robotic), while
// Android (Google), Edge (Microsoft "Online (Natural)") and Apple ship good
// Greek voices. With settings.voiceName '' the best Greek voice is picked
// automatically by voiceScore().
var cachedVoices = [];
function refreshVoices(){
  try { cachedVoices = ('speechSynthesis' in window) ? window.speechSynthesis.getVoices() : []; } catch(e) { cachedVoices = []; }
}
refreshVoices();
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = function(){
    refreshVoices();
    if (typeof buildVoiceSelect === 'function') buildVoiceSelect();
  };
}

function voiceScore(v){
  var n = v.name || '';
  var s = 0;
  if (/natural|neural|online|premium|enhanced|wavenet/i.test(n)) s += 4;
  if (/google|microsoft|apple|siri|samsung/i.test(n)) s += 2;
  if (!v.localService) s += 1; // network voices are usually the better ones
  if (/espeak|mbrola|festival|pico/i.test(n)) s -= 5;
  return s;
}
// Greek voices, best first.
function greekVoices(){
  return cachedVoices.filter(function(v){ return /^el([-_]|$)/i.test(v.lang || ''); })
    .sort(function(a, b){ return voiceScore(b) - voiceScore(a); });
}
function currentVoice(){
  var list = greekVoices();
  if (settings.voiceName) {
    var named = cachedVoices.filter(function(v){ return v.name === settings.voiceName; })[0];
    if (named) return named;
  }
  return list[0] || null;
}
// True when only a basic (eSpeak-like) Greek voice exists. On desktop Linux
// the local voices come from speech-dispatcher (eSpeak), whatever their name.
var DESKTOP_LINUX = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
function voiceIsWeak(v){ return !!v && (voiceScore(v) < 0 || (DESKTOP_LINUX && v.localService && voiceScore(v) < 2)); }

function makeUtterance(text, lang, rate){
  var u = new SpeechSynthesisUtterance(text);
  if (lang === 'el-GR') {
    var v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'el-GR';
  } else {
    u.lang = lang;
  }
  u.rate = rate;
  return u;
}

// Reads Greek text aloud; resolves when it has finished (or failed).
function speakAsync(text, lang, rate){
  return new Promise(function(resolve){
    if (!text || !('speechSynthesis' in window)) { resolve(); return; }
    try {
      var u = makeUtterance(text, lang || 'el-GR', rate || settings.speechRate);
      u.onend = function(){ resolve(); };
      u.onerror = function(){ resolve(); };
      window.speechSynthesis.speak(u);
    } catch(e) { resolve(); }
  });
}
function speak(text){
  if (!text || !('speechSynthesis' in window)) return Promise.resolve();
  try { window.speechSynthesis.cancel(); } catch(e) {}
  return speakAsync(text, 'el-GR', settings.speechRate);
}

// ---------- story narration (Greek slow → English → Greek slow, per sentence) ----------
var narrating = false;
var narrationToken = 0;

function narrationSleep(ms){
  return new Promise(function(resolve){ setTimeout(resolve, ms); });
}
function stopNarration(){
  narrationToken++;
  narrating = false;
  try { window.speechSynthesis.cancel(); } catch(e) {}
}
function narrateSentences(sentences, startIdx, onStep, onDone){
  stopNarration();
  narrating = true;
  var myToken = ++narrationToken;
  var slow = Math.max(0.5, settings.speechRate * 0.75);

  function step(i){
    if (!narrating || myToken !== narrationToken) return;
    if (i >= sentences.length) { narrating = false; onDone(); return; }
    onStep(i);
    var sent = sentences[i];
    function alive(){ return myToken === narrationToken; }
    speakAsync(sent.g, 'el-GR', slow)
      .then(function(){ if (!alive()) return Promise.reject('stopped'); return narrationSleep(280); })
      .then(function(){ if (!alive()) return Promise.reject('stopped'); return speakAsync(sent.e, 'en-US', 1.0); })
      .then(function(){ if (!alive()) return Promise.reject('stopped'); return narrationSleep(280); })
      .then(function(){ if (!alive()) return Promise.reject('stopped'); return speakAsync(sent.g, 'el-GR', slow); })
      .then(function(){ if (!alive()) return Promise.reject('stopped'); return narrationSleep(1100); })
      .then(function(){ if (!alive()) return Promise.reject('stopped'); step(i + 1); })
      .catch(function(){ /* narration was stopped mid-sentence — do nothing further */ });
  }
  step(startIdx);
}

// ---------- speech recognition ("Selbst versuchen" in story sentences) ----------
// Just for fun, no scoring: the user speaks the sentence, the browser's
// speech recognition (Chrome/Edge → Google, Safari → Apple; not in Firefox)
// transcribes it, and Gemini adds romanization + translation to what was heard.
var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
var tryRec = null;

function buildAnnotateTranscriptPrompt(text){
  return "You are a precise linguistic API for a Modern Greek learning app.\n" +
    "TASK: The following Greek text was produced by speech recognition of a learner. Add a romanization and an English translation.\n" +
    "TEXT: \"" + text + "\"\n" +
    "Do NOT correct or change the text, even if it seems wrong or nonsensical — translate literally what is there. You may add punctuation.\n" +
    "STRICT OUTPUT RULES:\n" +
    "1. Output MUST contain exactly 1 line. Nothing else.\n" +
    "2. Format: GREEK|ROMANIZATION|ENGLISH (romanization: simple Latin transliteration, stressed vowel marked with an acute accent)\n" +
    "3. No introduction, no markdown fences, no numbering, no explanatory text.";
}
function annotateTranscript(text){
  var apiKey = loadGeminiKey();
  if (!apiKey) return Promise.reject(new Error('no-key'));
  return callGemini(buildAnnotateTranscriptPrompt(text), apiKey).then(function(answer){
    var parsed = parseGeminiResponse(answer);
    if (!parsed.length) throw new Error(t('unreadableAnswer'));
    return parsed[0];
  });
}

function normalizeSentence(text){
  return fold(text).replace(/[\s.,;:!?·«»"'()…-]/g, '');
}

function stopTryListening(){
  if (!tryRec) return;
  var rec = tryRec;
  tryRec = null;
  try { rec.abort(); } catch(e) {}
  var tr = storiesState.tryResult;
  if (tr && tr.status === 'listening') storiesState.tryResult = null;
}

// The result lives in storiesState.tryResult and is only shown while the
// same story sentence is open: {storyId, idx, status, g, r, e, msg}
function startTryListening(storyId, idx, target){
  stopTryListening();
  stopNarration();
  var st = storiesState;
  var tr = { storyId: storyId, idx: idx, status: 'listening', g: '', r: '', e: '', msg: '' };
  st.tryResult = tr;

  var rec = new SpeechRec();
  rec.lang = 'el-GR';
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  tryRec = rec;
  var finalText = '';
  var failed = false;

  rec.onresult = function(e){
    var interim = '';
    finalText = '';
    for (var i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    tr.g = finalText + interim;
    var el = document.getElementById('tryHeard');
    if (el) el.textContent = tr.g;
  };
  rec.onerror = function(e){
    if (tryRec !== rec) return;
    failed = true;
    tr.status = 'error';
    tr.msg = e.error === 'no-speech' ? t('tryNoSpeech')
      : (e.error === 'not-allowed' || e.error === 'service-not-allowed') ? t('tryMicDenied')
      : tf('tryError', e.error);
  };
  rec.onend = function(){
    if (tryRec !== rec) return;
    tryRec = null;
    if (st.tryResult !== tr) return;
    var heard = (finalText || tr.g).trim();
    if (!failed && !heard) { tr.status = 'error'; tr.msg = t('tryNoSpeech'); }
    if (tr.status === 'error') { renderStories(); return; }
    tr.g = heard;
    // Spoken exactly right → reuse the story's own romanization/translation, no API call.
    if (normalizeSentence(heard) === normalizeSentence(target.g)) {
      tr.g = target.g; tr.r = target.r; tr.e = target.e;
      tr.status = 'done';
      renderStories();
      return;
    }
    tr.status = 'processing';
    renderStories();
    annotateTranscript(heard).then(function(r){
      if (st.tryResult !== tr) return;
      tr.g = r.g; tr.r = r.r; tr.e = r.e;
      tr.status = 'done';
      renderStories();
    }).catch(function(err){
      if (st.tryResult !== tr) return;
      tr.status = 'done';
      tr.msg = err.message === 'no-key' ? t('tryNoKey') : t('errorPrefix') + err.message;
      renderStories();
    });
  };

  try { rec.start(); } catch(e) {
    tryRec = null;
    tr.status = 'error';
    tr.msg = tf('tryError', e.message);
  }
  renderStories();
}

function renderTryBox(tr){
  if (tr.status === 'listening') {
    return '<div class="try-box"><div class="try-label">' + esc(t('tryListening')) + '</div>' +
      '<div class="try-g" id="tryHeard">' + esc(tr.g) + '</div></div>';
  }
  if (tr.status === 'error') {
    return '<div class="try-box"><div class="try-msg">' + esc(tr.msg) + '</div></div>';
  }
  return '<div class="try-box"><div class="try-label">' + esc(t('tryHeardLabel')) + '</div>' +
    '<div class="try-g">' + esc(tr.g) + '</div>' +
    (tr.status === 'processing' ? '<div class="try-msg">' + esc(t('tryProcessing')) + '</div>' : '') +
    (tr.r ? '<div class="try-r">' + esc(tr.r) + '</div>' : '') +
    (tr.e ? '<div class="try-e">' + esc(tr.e) + '</div>' : '') +
    (tr.msg ? '<div class="try-msg">' + esc(tr.msg) + '</div>' : '') +
  '</div>';
}
