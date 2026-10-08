// Init: service worker registration and first render. Loaded last.
"use strict";

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(function(){});
}

applyStaticTranslations();
seedDemoStory();
ensurePoolFilled(); // so the pool size shown before the first round is right
initNavigation();
initVocab();
initSettings();
renderVocab();
render();
switchView(settings.view);
// Example sentences load asynchronously from IndexedDB; refresh the card that shows them.
initExamplesStore().then(function(){ if (session && !session.finished) render(); });
detectGeminiModels(false); // background, at most weekly
