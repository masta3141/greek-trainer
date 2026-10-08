// Navigation: the tab bar (Vokabeln | Karten | Geschichten); the last tab is remembered.
"use strict";

var VIEWS = { vocab: 'vocabView', cards: 'cardsView', stories: 'storiesView' };

function switchView(name){
  if (!VIEWS[name]) name = 'cards';
  if (name !== 'stories') { stopNarration(); stopTryListening(); }
  Object.keys(VIEWS).forEach(function(v){
    document.getElementById(VIEWS[v]).style.display = v === name ? '' : 'none';
  });
  document.querySelectorAll('.tab-btn').forEach(function(b){
    var on = b.getAttribute('data-view') === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (name === 'stories') renderStories();
  settings.view = name;
  saveSettings();
}

// Re-renders every view (language switch, import, reset).
function renderAll(){
  renderVocab();
  render();
  renderStories();
}

function initNavigation(){
  document.querySelectorAll('.tab-btn').forEach(function(b){
    b.addEventListener('click', function(){ switchView(b.getAttribute('data-view')); window.scrollTo(0, 0); });
  });
  document.getElementById('btnLang').addEventListener('click', toggleLang);
}
