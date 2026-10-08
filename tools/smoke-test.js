#!/usr/bin/env node
// Smoke test: serves the app locally, opens it in a fresh headless Chrome
// profile, clicks through the main flows and reports every JS error and
// every failed expectation. Speech output is stubbed. Your real app data is
// never touched (throwaway profile).
//
//   node tools/smoke-test.js           run headless
//   node tools/smoke-test.js --show    watch it in a visible Chrome window
//
// Needs Node 22+ (built-in fetch/WebSocket) and Chrome/Chromium. Set CHROME
// to the browser binary if it isn't found automatically. Exit code 0 = all ok.
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SHOW = process.argv.includes('--show');
const STEP_TIMEOUT_MS = 15000;

// ---------- static file server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};
function startServer(){
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- Chrome + DevTools protocol ----------
function findChrome(){
  if (process.env.CHROME) return process.env.CHROME;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (fs.existsSync(mac)) return mac;
  for (const name of ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']) {
    const r = cp.spawnSync('which', [name], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('Chrome not found — set the CHROME environment variable.');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function launchChrome(profile){
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--user-data-dir=' + profile,
    '--remote-debugging-port=0', '--window-size=1280,900', 'about:blank'];
  if (!SHOW) args.unshift('--headless=new');
  const proc = cp.spawn(findChrome(), args, { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return { proc, ws };
}

function cdp(ws, onEvent){
  let id = 0;
  const pending = {};
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending[msg.id]) { pending[msg.id](msg); delete pending[msg.id]; }
    else if (msg.method) onEvent(msg);
  };
  return (method, params) => new Promise((resolve, reject) => {
    const i = ++id;
    const timer = setTimeout(() => reject(new Error('CDP timeout: ' + method)), STEP_TIMEOUT_MS);
    pending[i] = msg => { clearTimeout(timer); resolve(msg); };
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
}

// ---------- page stubs (injected before the app loads) ----------
// Gemini is mocked inside the page (no key, no network, no cost) and speech
// output is faked: three Greek voices of different quality, utterances are
// recorded and "end" right away.
const PAGE_STUBS = `
(function(){
  var seed = 12345;
  Math.random = function(){ seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  // pretend to be a German phone, so the first start picks German
  Object.defineProperty(navigator, 'languages', { get: function(){ return ['de-DE', 'en-US']; } });
  window.confirm = function(){ return true; };
  window.alert = function(){};
  window.__downloads = [];
  var realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(){
    if (this.hasAttribute('download')) { window.__downloads.push(this.download); return; }
    return realClick.apply(this, arguments);
  };
  // a cache of another app on the same origin (the HSK Trainer) — must survive our service worker
  if (window.caches) caches.open('hskflash-shell-test');
  window.__spoken = [];
  window.__voicesUsed = [];
  var VOICES = [
    { name: 'eSpeak Greek', lang: 'el', localService: true },
    { name: 'Microsoft Athina Online (Natural) - Greek (Greece)', lang: 'el-GR', localService: false },
    { name: 'Google Deutsch', lang: 'de-DE', localService: false },
    { name: 'Melina', lang: 'el-GR', localService: true }
  ];
  window.SpeechSynthesisUtterance = function(text){ this.text = text; };
  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices = function(){ return VOICES; };
    window.speechSynthesis.cancel = function(){};
    window.speechSynthesis.speak = function(u){
      window.__spoken.push(u.text);
      window.__voicesUsed.push(u.voice ? u.voice.name : '');
      setTimeout(function(){ if (u.onend) u.onend(); }, 5);
    };
  }
  window.__prompts = [];
  var n = 0;
  var SENT = ['Η Μαρία πηγαίνει στο σπίτι.|I María pigaínei sto spíti.|Maria goes home.',
    'Ο ήλιος είναι ζεστός.|O ílios eínai zestós.|The sun is hot.',
    'Θέλω να πιω νερό.|Thélo na pio neró.|I want to drink water.'];
  function reply(text){ return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: text }] } }] }), { status: 200 })); }
  var realFetch = window.fetch;
  window.fetch = function(url, opts){
    url = String(url);
    if (url.indexOf('generativelanguage.googleapis.com') < 0) return realFetch.apply(this, arguments);
    if (url.indexOf('/v1beta/models?') >= 0) {
      var g = ['generateContent'];
      return Promise.resolve(new Response(JSON.stringify({ models: [
        { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: g },
        { name: 'models/gemini-9.9-flash-lite', supportedGenerationMethods: g },
        { name: 'models/gemini-9.9-flash-lite-preview-01-2030', supportedGenerationMethods: g }
      ] }), { status: 200 }));
    }
    var prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    window.__prompts.push(prompt);
    n++;
    var count = parseInt((/Number of sentences: (\\d+)/.exec(prompt) || [])[1], 10) || 3;
    var lines = [];
    if (/short story/.test(prompt)) {
      lines.push('Μια μικρή ιστορία|Mia mikrí istoría|A short story');
      for (var i = 0; i < count; i++) lines.push(SENT[i % SENT.length]);
    } else if (/example sentences/.test(prompt)) {
      for (var k = 0; k < 3; k++) lines.push('Πρόταση ' + n + ' ' + k + '.|Prótasi|example ' + n + '_' + k);
    } else {
      lines.push('Καλημέρα.|Kaliméra.|Good morning.');
    }
    return reply(lines.join('\\n'));
  };
})();`;

// ---------- test runner ----------
async function main(){
  const server = await startServer();
  const base = 'http://127.0.0.1:' + server.address().port + '/index.html';
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'greek-smoke-'));
  const errors = [];
  const foreign = []; // requests to anything but the local server
  const results = [];
  let chrome;

  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log((ok ? '  \x1b[32m✓\x1b[0m ' : '  \x1b[31m✗\x1b[0m ') + name + (!ok && detail !== undefined ? '  → ' + JSON.stringify(detail) : ''));
  };

  try {
    chrome = await launchChrome(profile);
    const send = cdp(chrome.ws, msg => {
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        errors.push((d.exception && d.exception.description) || d.text);
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const u = msg.params.request.url;
        if (!/^(data:|blob:|about:|chrome)/.test(u) && u.indexOf(base.replace('/index.html', '')) !== 0) foreign.push(u);
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push('console.error: ' + msg.params.args.map(a => a.value || a.description).join(' '));
      }
    });
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('evaluate failed: ' + expr.slice(0, 80) + ' → ' +
        ((r.result.exceptionDetails.exception || {}).description || r.result.exceptionDetails.text));
      return r.result.result.value;
    };
    const click = (sel) => ev('(function(){ var e = document.querySelector(' + JSON.stringify(sel) + '); if (!e) throw new Error("missing ' + sel.replace(/"/g, "'") + '"); e.click(); return true; })()');
    const exists = (sel) => ev('!!document.querySelector(' + JSON.stringify(sel) + ')');
    const count = (sel) => ev('document.querySelectorAll(' + JSON.stringify(sel) + ').length');
    const text = (sel) => ev('(document.querySelector(' + JSON.stringify(sel) + ') || {}).textContent || ""');
    async function waitFor(expr, ms){
      const until = Date.now() + (ms || 5000);
      while (Date.now() < until) { if (await ev(expr)) return true; await sleep(100); }
      return false;
    }
    const READY = 'typeof renderVocab === "function" && typeof settings === "object" && document.readyState === "complete"';
    async function load(){ await send('Page.navigate', { url: base }); await waitFor(READY, 10000); await sleep(300); }
    async function reload(){ await send('Page.reload'); await sleep(300); await waitFor(READY, 10000); await sleep(300); }
    async function search(q){ await ev('(function(){ var s = document.getElementById("vocabSearch"); s.value = ' + JSON.stringify(q) + '; s.dispatchEvent(new Event("input")); return true; })()'); await sleep(300); }
    const firstWord = () => ev('(function(){ var r = document.querySelector("#vocabGrid .pool-cell"); return r ? WORD_BY_ID[+r.getAttribute("data-id")].w : ""; })()');
    const tapWord = (w) => ev('(function(){ var w = WORDS.filter(function(x){ return x.w === ' + JSON.stringify(w) + '; })[0]; document.querySelector(\'#vocabGrid .pool-cell[data-id="\' + w.id + \'"]\').click(); return w.id; })()');

    // A failure inside one area is recorded and the run continues with the next area.
    async function section(name, fn){
      console.log(name);
      try { await fn(); } catch (e) { check(name + ': finished without aborting', false, e.message.split('\n')[0]); }
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Network.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_STUBS });

    const cur = () => ev('WORD_BY_ID[session.currentId].w');

    await section('First start', async () => {
      await load();
      check('word list is loaded (7000+ words, levels A1–C2)',
        (await ev('WORDS.length')) > 7000 && (await ev('LEVELS.every(function(l){ return LEVEL_COUNTS[l] > 0; })')));
      check('every word has a gloss', (await ev('WORDS.filter(function(w){ return !w.e; }).length')) === 0);
      check('first start follows the device language', (await ev('settings.lang')) === 'de');
      check('device language falls back to English', (await ev('detectDeviceLang(["fr-FR"])')) === 'en' && (await ev('detectDeviceLang(["ja", "de-AT"])')) === 'de');
      check('cards tab is open first', (await ev('settings.view')) === 'cards' && await ev('document.getElementById("cardsView").style.display === ""'));
      check('start screen shows free practice and streak cards', (await count('.mode-card')) === 2);
      check('pool is filled with the first 300 words', (await ev('activePool().length')) === 300 && (await ev('activePool()[0].id')) === 1);
      check('stats strip shows the pool', /300/.test(await text('#statsStrip')));
      check('the example story is added once', (await ev('stories.filter(function(s){ return s.demo; }).length')) === 1);
    });

    await section('Free practice', async () => {
      await click('#btnStart');
      check('a card is shown', await exists('#wordText'));
      check('romanization and translation are hidden at first', (await text('.rom-line')) === '' && (await text('.solution-line')) === '');
      await click('#btnToggleRom');
      check('"Umschrift zeigen" shows the romanization', (await text('.rom-line')) === (await ev('WORD_BY_ID[session.currentId].r || ""')));
      await click('#btnSolution');
      check('"Übersetzung" shows the meaning', (await text('.solution-line')).indexOf(await ev('WORD_BY_ID[session.currentId].e')) === 0);
      await ev('window.__spoken = []; true');
      await click('#btnRead');
      check('"Vorlesen" speaks the word with the best Greek voice',
        (await ev('window.__spoken[0]')) === (await cur()) && /Athina/.test(await ev('window.__voicesUsed[0]')), await ev('window.__voicesUsed'));
      for (const v of [2, 5, 1, 0, 2, 5]) {
        await click('.rate-btn[data-val="' + v + '"]');
        await sleep(1000);
      }
      check('ratings are saved to progress', (await ev('Object.keys(progress).filter(function(k){ return progress[k].lvl > 0; }).length')) > 0);
      check('rated words fill their tile in the grid', (await count('#vocabGrid .pool-cell.learned')) > 0 &&
        (await count('#vocabGrid .pool-cell.learned')) === (await ev('Object.keys(progress).filter(function(k){ return progress[k].seen && progress[k].lvl > 0; }).length')));
      const roundIds = JSON.stringify(await ev('session.ids'));
      const roundPts = JSON.stringify(await ev('session.sessionPts'));
      await click('#btnPause');
      check('"Pause" goes back to the start screen with "Fortsetzen"', !(await ev('!!session')) && await exists('#btnResume'));
      await reload();
      check('paused free round survives a reload', await exists('#btnResume'));
      await click('#btnResume');
      check('"Fortsetzen" continues the same round with its points',
        JSON.stringify(await ev('session.ids')) === roundIds && JSON.stringify(await ev('session.sessionPts')) === roundPts);
      await ev('localStorage.setItem("grtrain_gemini_key_v1", "FAKE"); true');
      await click('#btnExamples');
      await click('#btnGenExamples');
      await waitFor('examplesFor(session.currentId).length === 3');
      check('"Beispielsätze generieren" adds 3 sentences', (await ev('examplesFor(session.currentId).length')) === 3);
      check('the prompt asks for Greek at the word\'s CEFR level', /Modern Greek/.test(await ev('window.__prompts[0]')) && /CEFR A1/.test(await ev('window.__prompts[0]')));
      await click('#btnGenExamples');
      await waitFor('examplesFor(session.currentId).length === 6');
      check('"Weitere Beispiele" adds 3 more and sends the existing ones along', (await ev('examplesFor(session.currentId).length')) === 6 && /already exist/.test(await ev('window.__prompts[1]')));
      await reload();
      await waitFor('Object.keys(generatedExamples).length > 0');
      check('example sentences survive a reload (IndexedDB)', (await ev('Object.keys(generatedExamples).length')) === 1);
    });

    await section('Gemini model detection', async () => {
      await ev('detectGeminiModels(true)');
      check('newest stable flash-lite model is picked (preview ignored)', (await ev('loadGeminiModel()')) === 'gemini-9.9-flash-lite', await ev('loadGeminiModel()'));
    });

    await section('Power-Streak', async () => {
      await click('#btnStreak');
      check('first stage brings 5 new words', (await ev('powerStreak.level')) === 1 && (await ev('powerStreak.open.queue.length')) === 5);
      check('rate buttons preview the intervals', (await text('.rate-btn[data-grade="2"] .val')) !== '');
      for (let i = 0; i < 12 && await ev('!!(session && session.streak)'); i++) {
        await click('.rate-btn[data-grade="2"]');
        await sleep(1000);
      }
      check('stage is done after rating every card', !(await ev('!!session')) && (await ev('powerStreak.open.queue.length')) === 0);
      check('start screen offers the next stage and review-only', await exists('#btnStreakReview') && /\+1/.test(await text('#btnStreak')));
      check('"Gut" gave +1 progress to the streak words', await ev('Object.keys(powerStreak.cards).every(function(id){ return wordLvl(id) >= 1; })'));
    });

    await section('Vocabulary grid', async () => {
      await click('#tabVocab');
      check('one tile per word', (await count('#vocabGrid .pool-cell')) === (await ev('WORDS.length')));
      check('unpractised words are empty tiles', (await ev('Array.prototype.filter.call(document.querySelectorAll("#vocabGrid .pool-cell:not(.learned)"), function(c){ return c.textContent; }).length')) === 0);
      check('practised words show the word and their level', /\d+$/.test(await text('#vocabGrid .pool-cell.learned')));
      check('pool tiles are marked ✓, streak tiles 🔥', (await count('#vocabGrid .pool-cell.in-pool')) === (await ev('activePool().length')) &&
        (await count('#vocabGrid .pool-cell.in-streak')) === (await ev('Object.keys(powerStreak.cards).length')));
      await ev('window.__spoken = []; true');
      await click('#vocabGrid .pool-cell');
      check('tapping a tile shows its info and speaks it', (await ev('window.__spoken[0]')) === (await firstWord()) && await ev('document.getElementById("toast").classList.contains("show")'));
      await click('#btnGridFilter');
      check('"Filter" opens the filter panel', await exists('.grid-filter-panel.open'));
      await click('.legend-chip[data-max="1"]');
      check('"Stufe bis A1" shows only A1 words', (await count('#vocabGrid .pool-cell')) === (await ev('LEVEL_COUNTS.A1')) && /· 1/.test(await text('#btnGridFilter')));
      await click('#btnFilterPool');
      check('"Nur Pool" shows only pool words', (await count('#vocabGrid .pool-cell')) === (await count('#vocabGrid .pool-cell.in-pool')));
      await click('.legend-chip[data-lvl-bucket="0"]');
      check('progress bucket filter', await ev('Array.prototype.every.call(document.querySelectorAll("#vocabGrid .pool-cell"), function(c){ return wordLvl(c.getAttribute("data-id")) <= 24; })'));
      await reload();
      check('filters survive a reload', (await ev('JSON.stringify(gridFilter)')) === JSON.stringify({ max: 1, pool: true, streak: false, lvl: [0] }));
      await click('#btnGridFilter');
      await click('#btnGridFilterReset');
      check('"Filter zurücksetzen" shows all words again', (await count('#vocabGrid .pool-cell')) === (await ev('WORDS.length')));
    });

    await section('Search', async () => {
      await search('αγαπω');
      check('accent-insensitive Greek search finds αγαπώ first', /^αγαπώ/.test(await firstWord()), await firstWord());
      check('found words are visible even when not practised yet', /αγαπώ/.test(await text('#vocabGrid .pool-cell .peek')));
      await search('spiti');
      check('romanization search finds σπίτι first', (await firstWord()) === 'σπίτι', await firstWord());
      await search('house');
      check('English search finds σπίτι', await ev('Array.prototype.some.call(document.querySelectorAll("#vocabGrid .pool-cell"), function(c){ return WORD_BY_ID[+c.getAttribute("data-id")].w === "σπίτι"; })'));
      await search('χασάπης');
      await click('#btnGridFilter');
      await click('.seg-btn[data-tap="pool"]');
      check('tap mode "✓ Pool" shows its hint', await exists('.pool-edit-hint'));
      await tapWord('χασάπης');
      check('tapping adds a C2 word to the pool', await ev('activePool().some(function(w){ return w.w === "χασάπης"; })') && await exists('#vocabGrid .pool-cell.in-pool'));
      await click('.seg-btn[data-tap="streak"]');
      await tapWord('χασάπης');
      check('tap mode "🔥 Streak" adds it to the streak as a new card', await ev('(function(){ var w = WORDS.filter(function(x){ return x.w === "χασάπης"; })[0]; return !!powerStreak.cards[w.id] && powerStreak.cards[w.id].last === null; })()'));
      await click('.seg-btn[data-tap="pool"]');
      await tapWord('χασάπης');
      check('tapping again removes it from the pool', !(await ev('activePool().some(function(w){ return w.w === "χασάπης"; })')) && (await ev('activePool().length')) === 300);
      await click('.seg-btn[data-tap="pool"]');
      check('tapping the active mode again goes back to "Info"', (await ev('gridTapMode')) === 'info' && !(await exists('.pool-edit-hint')));
      await search('xyzxyz');
      check('no hits shows the empty message', await exists('.vocab-empty'));
      await search('');
    });

    await section('Stories', async () => {
      await click('#tabStories');
      await waitFor('!!formsMap', 8000);
      check('word forms are loaded for the stories', (await ev('Object.keys(formsMap).length')) > 50000);
      check('inflected forms map to their dictionary word',
        (await ev('wordForToken("πηγαίνει").w')) === 'πηγαίνω' && (await ev('wordForToken("σπίτια").w')) === 'σπίτι' && (await ev('wordForToken("έκανα").w')) === 'κάνω');
      check('library shows the example story', (await count('.story-card')) === 1 && await exists('.demo-badge'));
      await click('[data-open-id]');
      check('the story opens at its first sentence', await exists('#sentText') && (await ev('storiesState.readIdx')) === 0);
      const known = await count('#sentText .sent-word');
      check('known words in the sentence are tappable', known >= 8, known);
      await ev('window.__spoken = []; true');
      await ev('document.querySelector("#sentText .sent-word[data-wid]").click(); true');
      check('tapping a word speaks it and shows its info', (await ev('window.__spoken.length')) === 1 && await ev('document.getElementById("toast").classList.contains("show")'));
      const ids = await ev('wordsInSentence(stories[0].sentences[0].g).map(function(w){ return w.id; })');
      const before = await ev('JSON.stringify(' + JSON.stringify(ids) + '.map(wordLvl))');
      await click('.rate-row .rate-btn[data-val="2"]');
      await waitFor('storiesState.readIdx === 1');
      check('"Gut" gives +2 to every word of the sentence and moves on',
        (await ev('JSON.stringify(' + JSON.stringify(ids) + '.map(wordLvl))')) === JSON.stringify(JSON.parse(before).map(v => v + 2)) && (await ev('stories[0].currentIdx')) === 1);
      await click('#btnSentToPool');
      check('"Satz in den Pool" adds the sentence\'s words', await ev('wordsInSentence(stories[0].sentences[1].g).every(function(w){ return activePool().some(function(p){ return p.id === w.id; }); })'));
      await click('#btnNarrate');
      await waitFor('window.__spoken.indexOf(stories[0].sentences[1].e) >= 0');
      check('"Erzählen" reads Greek, English, Greek', await ev('(function(){ var s = stories[0].sentences[1]; var i = window.__spoken.indexOf(s.g); return i >= 0 && window.__spoken[i + 1] === s.e; })()'));
      await click('#btnNarrate');
      check('narration can be stopped', !(await ev('narrating')));
      await click('#btnBackToLibrary2');
      await click('#btnNewStory');
      await ev('document.getElementById("stCount").value = "3"; document.getElementById("stLevel").value = "B1"; true');
      await click('#btnGenStory');
      await waitFor('storiesState.view === "preview"');
      check('a generated story is shown for review', (await count('.story-sentence')) === 3 && /CEFR B1/.test(await ev('window.__prompts[window.__prompts.length - 1]')));
      await click('#btnAdoptStory');
      check('"Übernehmen" saves it and opens it', (await ev('stories.length')) === 2 && (await ev('storiesState.view')) === 'detail');
      await click('#btnBackToLibrary2');
      check('library lists B1 above A1', /B1/.test(await text('.story-card .story-meta')));
      await reload();
      check('stories survive a reload', (await ev('stories.length')) === 2 && (await ev('settings.view')) === 'stories');
    });

    await section('Settings', async () => {
      await click('#btnSettings');
      check('settings drawer opens', await ev('document.getElementById("drawer").classList.contains("show")'));
      check('voice list offers only Greek voices, best first', (await ev('Array.prototype.map.call(document.querySelectorAll("#inpVoice option"), function(o){ return o.value; }).join("|")')) ===
        '|Microsoft Athina Online (Natural) - Greek (Greece)|Melina|eSpeak Greek');
      await ev('var s = document.getElementById("inpVoice"); s.value = "Melina"; s.onchange({ target: s }); true');
      check('choosing a voice uses it and plays a test sentence', (await ev('settings.voiceName')) === 'Melina' && (await ev('window.__voicesUsed[window.__voicesUsed.length - 1]')) === 'Melina');
      await ev('var r = document.getElementById("inpRate"); r.value = "0.7"; r.oninput({ target: r }); true');
      check('speaking rate is saved', (await ev('settings.speechRate')) === 0.7);
      await ev('var p = document.getElementById("inpPool"); p.value = "120"; p.onchange(); true');
      check('pool size applies right away', (await ev('basePool().length')) === 120 &&
        (await text('#statsStrip')).indexOf(String(await ev('activePool().length'))) === 0, await text('#statsStrip'));
      await ev('var f = document.getElementById("inpWordSize"); f.value = "90"; f.oninput({ target: f }); true');
      check('font size changes the main field', /90px/.test(await ev('document.documentElement.style.getPropertyValue("--word-size")')));
      await click('#btnExportProgress');
      check('progress export downloads a file', /^grtrain-progress-.*\.json$/.test(await ev('window.__downloads[window.__downloads.length - 1]')));
      await click('#btnCloseDrawer');
      await ev('settings.voiceName = ""; saveSettings(); true');
    });

    await section('Full backup and restore', async () => {
      const before = await ev('JSON.stringify({ lv: powerStreak.level, st: stories.length, ex: Object.keys(generatedExamples).length, p: Object.keys(progress).length })');
      await ev('buildFullBackup().then(function(b){ window.__bk = JSON.stringify(b); return true; })');
      check('backup leaves out the API key', !(await ev('JSON.parse(window.__bk).localStorage.grtrain_gemini_key_v1')));
      await ev('appStorageKeys().forEach(function(k){ localStorage.removeItem(k); }); saveGeneratedExamples({}).then(function(){ return true; })');
      await ev('restoreFullBackup(JSON.parse(window.__bk)).then(function(){ return true; })');
      await sleep(800);
      await waitFor(READY, 10000);
      await waitFor('Object.keys(generatedExamples).length > 0', 5000);
      const after = await ev('JSON.stringify({ lv: powerStreak.level, st: stories.length, ex: Object.keys(generatedExamples).length, p: Object.keys(progress).length })');
      check('restore brings back streak, stories, examples and progress', after === before, { before, after });
      check('API key survives a restore', (await ev('loadGeminiKey()')) === 'FAKE');
      await click('#btnSettings');
      await click('#btnReset');
      check('"Fortschritt zurücksetzen" clears all progress', (await ev('Object.keys(progress).filter(function(k){ return progress[k].lvl > 0; }).length')) === 0);
    });

    await section('Language', async () => {
      await click('#btnLang');
      await click('#tabCards');
      check('switching to English translates the tabs', (await text('#tabVocab')) === 'Vocabulary' && (await text('#tabStories')) === 'Stories');
      check('the start screen is translated too', /Free practice/.test(await text('.mode-title')));
      await click('#btnLang');
      check('switching back to German', (await text('#tabVocab')) === 'Vokabeln');
      await click('#tabVocab');
    });

    await section('Mobile', async () => {
      await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 800, deviceScaleFactor: 2, mobile: true });
      await reload();
      check('no horizontal scrolling on a phone (vocabulary)', await ev('document.documentElement.scrollWidth <= window.innerWidth'), await ev('[document.documentElement.scrollWidth, window.innerWidth]'));
      await click('#tabCards');
      await click('#btnStart');
      check('no horizontal scrolling on a phone (cards)', await ev('document.documentElement.scrollWidth <= window.innerWidth'), await ev('[document.documentElement.scrollWidth, window.innerWidth]'));
      await click('#tabStories');
      await click('[data-open-id]');
      check('no horizontal scrolling on a phone (stories)', await ev('document.documentElement.scrollWidth <= window.innerWidth'), await ev('[document.documentElement.scrollWidth, window.innerWidth]'));
      await click('#btnSettings');
      await sleep(400);
      check('settings fit on a phone', await ev('document.getElementById("drawer").getBoundingClientRect().right <= window.innerWidth + 1'));
      await click('#btnCloseDrawer');
      await click('#tabVocab');
      await send('Emulation.clearDeviceMetricsOverride');
    });

    await section('Offline cache', async () => {
      await reload();
      const shell = (fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/var APP_SHELL = \[([\s\S]*?)\];/) || ['', ''])[1].match(/'[^']+'/g) || [];
      const tags = (fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').match(/(?:src|href)="([^"]+\.(?:js|css))"/g) || []).map(s => s.replace(/^(src|href)="|"$/g, ''));
      check('APP_SHELL lists every script/stylesheet of index.html', tags.every(f => shell.indexOf("'" + f + "'") >= 0), tags.filter(f => shell.indexOf("'" + f + "'") < 0));
      await waitFor('caches.keys().then(function(k){ return k.some(function(x){ return x.indexOf("grtrain-") === 0; }); })', 8000);
      await waitFor('caches.keys().then(function(ks){ return caches.open(ks.filter(function(k){ return k.indexOf("grtrain-") === 0; })[0]); }).then(function(c){ return c.keys(); }).then(function(r){ return r.length >= ' + shell.length + '; })', 8000);
      const cached = await ev('caches.keys().then(function(ks){ return caches.open(ks.filter(function(k){ return k.indexOf("grtrain-") === 0; })[0]); }).then(function(c){ return c.keys(); }).then(function(r){ return r.length; })');
      check('service worker caches every APP_SHELL file (' + shell.length + ')', cached >= shell.length, { cached, appShell: shell.length });
      check('caches of other apps on the same origin are left alone', await ev('caches.has("hskflash-shell-test")'));
      check('manifest has its own app id (not the HSK Trainer\'s "/")', JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).id !== '/');
    });
  } catch (e) {
    check('test run finished without aborting', false, e.message);
  } finally {
    check('no JavaScript errors', errors.length === 0, errors.slice(0, 5));
    check('no requests to third-party servers', foreign.length === 0, foreign.slice(0, 5));
    if (chrome) { try { chrome.ws.close(); } catch (e) {} chrome.proc.kill(); }
    server.close();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (failed ? '\x1b[31m✗ ' + failed + ' of ' + results.length + ' checks failed\x1b[0m' : '\x1b[32m✓ all ' + results.length + ' checks passed\x1b[0m'));
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
