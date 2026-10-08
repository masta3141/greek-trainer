// Full backup: one JSON file with all app data — every grtrain_* localStorage
// entry plus the example sentences from IndexedDB. The Gemini API key is left
// out on purpose, so the file can be kept anywhere; the model check too.
"use strict";

var BACKUP_FORMAT = 'grtrain-backup-v1';
var LAST_BACKUP_KEY = 'grtrain_last_backup_v1';
var BACKUP_SKIP_KEYS = [GEMINI_KEY_STORE, GEMINI_MODEL_STORE, GEMINI_MODELS_CHECKED_KEY];

function appStorageKeys(){
  var keys = [];
  for (var i = 0; i < localStorage.length; i++) {
    var k = localStorage.key(i);
    if (k.indexOf('grtrain_') === 0 && BACKUP_SKIP_KEYS.indexOf(k) < 0) keys.push(k);
  }
  return keys;
}

function buildFullBackup(){
  var ls = {};
  appStorageKeys().forEach(function(k){ ls[k] = localStorage.getItem(k); });
  return (examplesReady || Promise.resolve()).then(function(){
    return { format: BACKUP_FORMAT, exportedAt: new Date().toISOString(), localStorage: ls, examples: generatedExamples };
  });
}

// Replaces all app data with the backup and reloads the app.
function restoreFullBackup(data){
  if (!data || data.format !== BACKUP_FORMAT || typeof data.localStorage !== 'object') {
    return Promise.reject(new Error('invalid'));
  }
  appStorageKeys().forEach(function(k){ localStorage.removeItem(k); });
  Object.keys(data.localStorage).forEach(function(k){
    if (k.indexOf('grtrain_') === 0 && BACKUP_SKIP_KEYS.indexOf(k) < 0) localStorage.setItem(k, data.localStorage[k]);
  });
  return saveGeneratedExamples(data.examples || {}).then(function(){
    setTimeout(function(){ location.reload(); }, 50);
  });
}

function showBackupInfo(){
  var el = document.getElementById('backupInfo');
  var last = loadJson(LAST_BACKUP_KEY, 0) || 0;
  var days = Math.floor((Date.now() - last) / 86400000);
  el.textContent = (!last ? t('backupNever') : days === 0 ? t('backupToday') : tf('backupDaysAgo', days)) + ' ' + t('backupKeyNote');
}

function initBackup(){
  document.getElementById('btnBackupAll').onclick = function(){
    var btn = this;
    btn.disabled = true;
    buildFullBackup().then(function(data){
      downloadJson(data, 'grtrain-backup');
      saveJson(LAST_BACKUP_KEY, Date.now());
    }).catch(function(err){
      alert(t('errorPrefix') + err.message);
    }).then(function(){
      btn.disabled = false;
      showBackupInfo();
    });
  };
  document.getElementById('btnRestoreAll').onclick = function(){ document.getElementById('inpRestoreFile').click(); };
  document.getElementById('inpRestoreFile').onchange = function(e){
    var file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      var data;
      try { data = JSON.parse(reader.result); } catch(err) { alert(t('importInvalidJson')); return; }
      if (!data || data.format !== BACKUP_FORMAT) { alert(t('backupInvalid')); return; }
      if (!confirm(t('backupRestoreConfirm'))) return;
      restoreFullBackup(data).catch(function(err){ alert(t('errorPrefix') + err.message); });
    };
    reader.readAsText(file);
  };
}
