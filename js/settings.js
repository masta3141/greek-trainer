// Settings drawer: round options, voice, fonts, reset, import/export, Gemini key.
"use strict";

function buildVoiceSelect(){
  var sel = document.getElementById('inpVoice');
  var note = document.getElementById('voiceNote');
  if (!sel) return;
  refreshVoices();
  var el = greekVoices();
  if (!cachedVoices.length) {
    sel.innerHTML = '<option value="">' + esc(t('voiceNoneFound')) + '</option>';
    note.textContent = t('voiceNoneNote');
    return;
  }
  var best = el[0];
  sel.innerHTML = '<option value="">' + esc(best ? tf('voiceAuto', best.name) : t('voiceAutoNone')) + '</option>' +
    el.map(function(v, i){
      return '<option value="' + esc(v.name) + '"' + (v.name === settings.voiceName ? ' selected' : '') + '>' +
        esc(v.name) + ' (' + esc(v.lang) + ')' + (i === 0 ? ' · ' + esc(t('voiceBest')) : '') + '</option>';
    }).join('');
  note.textContent = !el.length ? t('voiceNoneNote')
    : voiceIsWeak(best) ? tf('voiceFoundNote', el.length) + ' ' + t('voiceWeakNote')
    : tf('voiceFoundNote', el.length);
}

function openDrawer(){
  document.getElementById('inpPool').value = settings.pool;
  document.getElementById('inpSession').value = settings.sessionSize;
  document.getElementById('inpAutoSpeak').checked = !!settings.autoSpeak;
  document.getElementById('inpRate').value = settings.speechRate;
  document.getElementById('rateVal').textContent = settings.speechRate.toFixed(2) + '×';
  document.getElementById('inpFontFamily').value = fonts.family;
  document.getElementById('inpWordSize').value = fonts.wordSize;
  document.getElementById('inpExampleSize').value = fonts.exampleSize;
  document.getElementById('wordSizeVal').textContent = fonts.wordSize + 'px';
  document.getElementById('exampleSizeVal').textContent = fonts.exampleSize + 'px';
  document.getElementById('inpGeminiKey').value = loadGeminiKey();
  showGeminiModelInfo();
  showBackupInfo();
  buildVoiceSelect();
  document.getElementById('overlay').classList.add('show');
  document.getElementById('drawer').classList.add('show');
}
function closeDrawer(){
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('drawer').classList.remove('show');
}

function showGeminiModelInfo(){
  document.getElementById('geminiModelInfo').textContent = tf('geminiModelAuto', loadGeminiModel());
}

// Pool size and words per round are saved right away; a running round just
// continues, the new values apply from the next round on.
function applyRoundSettings(){
  var pool = parseInt(document.getElementById('inpPool').value, 10);
  var sess = parseInt(document.getElementById('inpSession').value, 10);
  settings.pool = isNaN(pool) || pool < 1 ? DEFAULT_SETTINGS.pool : Math.min(pool, WORDS.length);
  settings.sessionSize = isNaN(sess) || sess < 1 ? DEFAULT_SETTINGS.sessionSize : sess;
  saveSettings();
  ensurePoolFilled();
  poolChanged();
}

// ---------- import / export per category ----------
var importTarget = null; // 'progress' | 'examples' | 'stories'
function exportCategory(kind){
  if (kind === 'progress') downloadJson({ format: 'grtrain-progress-v1', exportedAt: new Date().toISOString(), progress: progress, streak: powerStreak, poolOverrides: poolOverrides }, 'grtrain-progress');
  if (kind === 'examples') downloadJson({ format: 'grtrain-examples-v1', exportedAt: new Date().toISOString(), generatedExamples: generatedExamples }, 'grtrain-examples');
  if (kind === 'stories') downloadJson({ format: 'grtrain-stories-v1', exportedAt: new Date().toISOString(), stories: stories }, 'grtrain-stories');
}
function importCategory(data){
  if (importTarget === 'progress') {
    if (!data || typeof data.progress !== 'object') return alert(t('importInvalidFormat'));
    if (!confirm(t('importConfirmProgress'))) return;
    progress = data.progress;
    saveProgress(progress);
    if (data.streak && typeof data.streak === 'object' && data.streak.cards) { powerStreak = data.streak; saveStreak(powerStreak); }
    if (data.poolOverrides && typeof data.poolOverrides === 'object') { poolOverrides = data.poolOverrides; savePoolOverrides(poolOverrides); }
    session = null;
    saveFreeSession();
  } else if (importTarget === 'examples') {
    if (!data || typeof data.generatedExamples !== 'object') return alert(t('importInvalidFormat'));
    if (!confirm(t('importConfirmExamples'))) return;
    saveGeneratedExamples(data.generatedExamples);
  } else if (importTarget === 'stories') {
    if (!data || !Array.isArray(data.stories)) return alert(t('importInvalidFormat'));
    if (!confirm(t('importConfirmStories'))) return;
    stories = data.stories;
    saveStories(stories);
    storiesState.view = 'library';
  } else return;
  closeDrawer();
  renderAll();
  alert(t('importDone'));
}

function resetProgress(){
  if (!confirm(t('resetConfirm'))) return;
  progress = {};
  saveProgress(progress);
  session = null;
  saveFreeSession(); // no paused round after a reset
  closeDrawer();
  ensurePoolFilled();
  renderAll();
}

function initSettings(){
  document.getElementById('btnSettings').onclick = openDrawer;
  document.getElementById('overlay').onclick = closeDrawer;
  document.getElementById('btnCloseDrawer').onclick = closeDrawer;
  document.getElementById('inpPool').onchange = applyRoundSettings;
  document.getElementById('inpSession').onchange = applyRoundSettings;
  document.getElementById('inpAutoSpeak').onchange = function(e){ settings.autoSpeak = e.target.checked; saveSettings(); };
  document.getElementById('inpVoice').onchange = function(e){ settings.voiceName = e.target.value; saveSettings(); speak(t('voiceTestText')); };
  document.getElementById('inpRate').oninput = function(e){
    settings.speechRate = parseFloat(e.target.value) || 0.9;
    document.getElementById('rateVal').textContent = settings.speechRate.toFixed(2) + '×';
    saveSettings();
  };
  document.getElementById('btnVoiceTest').onclick = function(){ speak(t('voiceTestText')); };
  document.getElementById('inpFontFamily').onchange = function(e){ fonts.family = e.target.value; saveFonts(fonts); applyFonts(); };
  document.getElementById('inpWordSize').oninput = function(e){
    fonts.wordSize = parseInt(e.target.value, 10);
    document.getElementById('wordSizeVal').textContent = fonts.wordSize + 'px';
    saveFonts(fonts);
    applyFonts();
  };
  document.getElementById('inpExampleSize').oninput = function(e){
    fonts.exampleSize = parseInt(e.target.value, 10);
    document.getElementById('exampleSizeVal').textContent = fonts.exampleSize + 'px';
    saveFonts(fonts);
    applyFonts();
  };
  document.getElementById('btnReset').onclick = resetProgress;
  document.getElementById('btnSaveGeminiKey').onclick = function(){
    saveGeminiKey(document.getElementById('inpGeminiKey').value.trim());
    detectGeminiModels(true).then(showGeminiModelInfo);
    var btn = this;
    btn.textContent = t('geminiSavedToast');
    setTimeout(function(){ btn.textContent = t('geminiSaveBtn'); }, 1500);
  };
  ['progress', 'examples', 'stories'].forEach(function(kind){
    var cap = kind.charAt(0).toUpperCase() + kind.slice(1);
    document.getElementById('btnExport' + cap).onclick = function(){ exportCategory(kind); };
    document.getElementById('btnImport' + cap).onclick = function(){ importTarget = kind; document.getElementById('inpImportFile').click(); };
  });
  document.getElementById('inpImportFile').onchange = function(e){
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      e.target.value = '';
      var data;
      try { data = JSON.parse(reader.result); } catch(err) { alert(t('importInvalidJson')); return; }
      importCategory(data);
    };
    reader.readAsText(file);
  };
  initBackup();
}
