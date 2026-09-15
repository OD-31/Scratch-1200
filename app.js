import { computePeaks, detectBPM, timeStretch } from './dsp.js';
import { saveSample, getSample, deleteSample, listSamples, updateSample, loadSettings, saveSettings } from './storage.js';
import { drawPlatter, drawWaveZoom, drawOverview, segmentAt, SEC_PER_REV } from './render.js';

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const MAX_PADS = 6;
const PEAKS_PER_SEC = 400;

// ------------------------------------------------------------------ ÉTAT
const settings = Object.assign(
  { bpm: 90, brakeTime: 1.2, pitchRange: 8, padMode: 'instant', scratchDir: 1, stretch: false, lastId: null },
  loadSettings()
);

const st = {
  ctx: null, node: null, gain: null,
  sampleId: null, name: '',
  orig: null,          // { channels, sampleRate, duration } — fichier d'origine
  ratio: 1,            // durée actuelle / durée d'origine (time-stretch)
  duration: 0,
  peaks: new Float32Array(1),
  srcBpm: 0,
  cuts: [],            // points de découpe, en secondes du buffer actuel
  motor: 0, pitchPct: 0, rpm: 1,
  muted: false,
  pos: 0, rate: 0, msgTime: 0,
  touching: false,
  armedPad: -1, loopOn: false, loop: null,
  chopMode: false,
  stretchBusy: false,
};

const post = (m) => st.node && st.node.port.postMessage(m);
const pitchFactor = () => (1 + st.pitchPct / 100) * st.rpm;

// ------------------------------------------------------------------ DÉMARRAGE AUDIO
$('btnStart').addEventListener('pointerdown', startAudio, { once: true });

async function startAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    st.ctx = new AC({ latencyHint: 'interactive' });
    await st.ctx.audioWorklet.addModule('turntable-worklet.js');
    st.node = new AudioWorkletNode(st.ctx, 'turntable', { numberOfInputs: 0, outputChannelCount: [2] });
    st.gain = st.ctx.createGain();
    st.node.connect(st.gain).connect(st.ctx.destination);
    st.node.port.onmessage = (e) => { st.pos = e.data.pos; st.rate = e.data.rate; st.msgTime = performance.now(); };
    await st.ctx.resume();
    post({ type: 'brakeTime', value: settings.brakeTime });
    post({ type: 'pitch', value: pitchFactor() });
    $('startOverlay').hidden = true;
    if (settings.lastId) loadFromLibrary(settings.lastId, true);
  } catch (err) {
    console.error(err);
    alert("Impossible de démarrer l'audio : " + err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && st.ctx && st.ctx.state !== 'running') st.ctx.resume();
});

// ------------------------------------------------------------------ CHARGEMENT
$('btnLoad').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || !st.ctx) return;
  busy('Chargement…');
  try {
    const data = await file.arrayBuffer();
    const copy = data.slice(0);
    const audio = await decode(data);
    const id = String(Date.now());
    const name = file.name.replace(/\.[^.]+$/, '');
    await saveSample({ id, name, date: Date.now(), file: copy, srcBpm: 0, cuts: [] });
    setSample(id, name, audio, 0, []);
    toast(`« ${name} » chargé`);
  } catch (err) {
    console.error(err);
    toast('Fichier audio illisible');
  } finally { busy(false); }
});

function decode(arrayBuffer) {
  return new Promise((resolve, reject) => st.ctx.decodeAudioData(arrayBuffer, resolve, reject));
}

async function loadFromLibrary(id, silent) {
  const rec = await getSample(id).catch(() => null);
  if (!rec) return;
  busy('Chargement…');
  try {
    const audio = await decode(rec.file.slice(0));
    setSample(rec.id, rec.name, audio, rec.srcBpm || 0, rec.cuts || []);
    if (!silent) toast(`« ${rec.name} » chargé`);
  } catch (err) { console.error(err); toast('Sample illisible'); }
  finally { busy(false); }
}

function setSample(id, name, audioBuffer, srcBpm, origCuts) {
  const channels = [];
  for (let c = 0; c < Math.min(2, audioBuffer.numberOfChannels); c++) channels.push(audioBuffer.getChannelData(c).slice());
  st.orig = { channels, sampleRate: audioBuffer.sampleRate, duration: audioBuffer.duration };
  st.sampleId = id; st.name = name;
  st.srcBpm = srcBpm || detectBPM(channels, audioBuffer.sampleRate);
  if (!srcBpm) updateSample(id, { srcBpm: st.srcBpm });
  settings.lastId = id; persist();
  st.armedPad = -1; st.loopOn = false; st.loop = null;
  $('sampleName').textContent = name;
  applyBuffer({ resetPos: true, origCuts });
}

// Envoie le buffer (étiré ou non) au moteur audio
function applyBuffer({ resetPos = false, origCuts = null } = {}) {
  if (!st.orig) return;
  const prevRatio = st.ratio;
  const cutsOrig = origCuts || st.cuts.map((c) => c / prevRatio);
  const wantRatio = settings.stretch && st.srcBpm > 0 ? st.srcBpm / settings.bpm : 1;

  const finish = (channels, ratio) => {
    st.ratio = ratio;
    st.duration = channels[0].length / st.orig.sampleRate;
    st.peaks = computePeaks(channels, Math.max(1, Math.round(st.duration * PEAKS_PER_SEC)));
    st.cuts = cutsOrig.map((c) => c * ratio).filter((c) => c < st.duration);
    if (resetPos) st.pos = st.cuts[0] || 0;
    else st.pos *= ratio / prevRatio;
    post({ type: 'load', channels, sampleRate: st.orig.sampleRate, resetPos, scalePos: resetPos ? 0 : ratio / prevRatio });
    if (resetPos && st.cuts[0]) post({ type: 'jump', value: st.cuts[0] });
    st.loop = null;
    if (st.loopOn) setLoopToSegment(segmentAt(st.cuts, st.pos));
    refreshUI();
  };

  if (Math.abs(wantRatio - 1) < 1e-4) return finish(st.orig.channels, 1);
  busy('Time stretch…');
  st.stretchBusy = true;
  setTimeout(() => {
    try { finish(timeStretch(st.orig.channels, st.orig.sampleRate, wantRatio), wantRatio); }
    finally { st.stretchBusy = false; busy(false); }
  }, 30);
}

// ------------------------------------------------------------------ TRANSPORT
function setMotor(v) {
  st.motor = v;
  post({ type: 'motor', value: v });
  $('btnPlay').classList.toggle('on', v === 1);
  $('btnReverse').classList.toggle('on', v === -1);
  $('btnStop').classList.toggle('on', v === 0);
}
$('btnPlay').addEventListener('pointerdown', () => setMotor(1));
$('btnReverse').addEventListener('pointerdown', () => setMotor(-1));
$('btnStop').addEventListener('pointerdown', () => setMotor(0));

// ------------------------------------------------------------------ MUTE / FADER
function setMute(m) {
  st.muted = m;
  if (st.gain) st.gain.gain.setTargetAtTime(m ? 0 : 1, st.ctx.currentTime, 0.003);
  $('btnMute').classList.toggle('muted', m);
  $('btnMute').querySelector('.mute-label').textContent = m ? 'MUTE' : 'SON';
}
$('btnMute').addEventListener('pointerdown', (e) => { e.preventDefault(); setMute(!st.muted); });

// ------------------------------------------------------------------ PLATINE (MAIN)
const platter = $('platter');
const hand = { id: null, lastA: 0 };

platter.addEventListener('pointerdown', (e) => {
  if (hand.id !== null || !S.geom) return;
  const { x, y } = local(platter, e);
  const dx = x - S.geom.cx, dy = y - S.geom.cy;
  if (Math.hypot(dx, dy) > S.geom.R) return;
  hand.id = e.pointerId;
  hand.lastA = Math.atan2(dy, dx);
  platter.setPointerCapture(e.pointerId);
  st.touching = true;
  post({ type: 'touch', value: true });
});

platter.addEventListener('pointermove', (e) => {
  if (e.pointerId !== hand.id) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  let total = 0;
  for (const ev of events.length ? events : [e]) {
    const { x, y } = local(platter, ev);
    const dx = x - S.geom.cx, dy = y - S.geom.cy;
    if (Math.hypot(dx, dy) < 18) continue; // trop près de l'axe : angle instable
    const a = Math.atan2(dy, dx);
    let da = a - hand.lastA;
    if (da > Math.PI) da -= TAU; else if (da < -Math.PI) da += TAU;
    hand.lastA = a;
    total += da;
  }
  if (total) {
    const sec = (total / TAU) * SEC_PER_REV * settings.scratchDir;
    post({ type: 'handDelta', value: sec });
  }
});

const releaseHand = (e) => {
  if (e.pointerId !== hand.id) return;
  hand.id = null;
  st.touching = false;
  post({ type: 'touch', value: false });
};
platter.addEventListener('pointerup', releaseHand);
platter.addEventListener('pointercancel', releaseHand);

function local(el, e) {
  const r = el.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

// ------------------------------------------------------------------ PADS
const padEls = [...document.querySelectorAll('.pad')];
padEls.forEach((el) => el.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const i = +el.dataset.pad;
  if (i >= st.cuts.length) return;
  const idle = !st.touching && Math.abs(st.rate) < 0.02;
  if (settings.padMode === 'segment' && !idle && segmentAt(st.cuts, st.pos) !== i) {
    st.armedPad = st.armedPad === i ? -1 : i;
  } else {
    triggerPad(i);
  }
}));

function triggerPad(i) {
  st.armedPad = -1;
  const start = st.cuts[i];
  if (st.loopOn) setLoopToSegment(i);
  // en reverse, on démarre à la fin du segment
  const t = st.motor === -1 && !st.touching ? segEnd(i) - 0.001 : start;
  st.pos = t;
  post({ type: 'jump', value: t });
}

const segEnd = (i) => (i + 1 < st.cuts.length ? st.cuts[i + 1] : st.duration);

function setLoopToSegment(i) {
  st.loop = i >= 0 ? { start: st.cuts[i], end: segEnd(i) } : null;
  post({ type: 'loop', value: st.loop });
}

$('btnLoopPad').addEventListener('pointerdown', () => {
  st.loopOn = !st.loopOn;
  if (st.loopOn) {
    const seg = segmentAt(st.cuts, st.pos);
    if (seg < 0) { st.loopOn = false; toast("Place d'abord des points de découpe"); }
    else setLoopToSegment(seg);
  } else setLoopToSegment(-1);
  refreshUI();
});

let prevPos = 0;
function checkArmed(pos) {
  if (st.armedPad < 0) return;
  const segNow = segmentAt(st.cuts, pos), segPrev = segmentAt(st.cuts, prevPos);
  const wrapped = (st.rate > 0 && pos < prevPos - 0.02) || (st.rate < 0 && pos > prevPos + 0.02);
  const idle = !st.touching && Math.abs(st.rate) < 0.02;
  if (segNow !== segPrev || wrapped || idle) triggerPad(st.armedPad);
}

// ------------------------------------------------------------------ DÉCOUPE (CHOP)
function addCut(t) {
  if (!st.orig) return;
  if (st.cuts.length >= MAX_PADS) return toast('6 points maximum');
  if (st.cuts.some((c) => Math.abs(c - t) < 0.01)) return;
  st.cuts.push(Math.max(0, Math.min(st.duration - 0.01, t)));
  cutsChanged();
}

function cutsChanged() {
  st.cuts.sort((a, b) => a - b);
  st.armedPad = -1;
  if (st.loopOn) setLoopToSegment(segmentAt(st.cuts, st.pos));
  clearTimeout(cutsChanged.timer);
  cutsChanged.timer = setTimeout(() => {
    if (st.sampleId) updateSample(st.sampleId, { cuts: st.cuts.map((c) => c / st.ratio) });
  }, 400);
  refreshUI();
}

$('btnChop').addEventListener('click', () => {
  st.chopMode = !st.chopMode;
  if (st.chopMode) toast('CHOP : touche l’onde pour poser un point · glisse un point pour le déplacer · appui long pour le supprimer', 3500);
  refreshUI();
});
$('btnAddCut').addEventListener('click', () => addCut(st.pos));
$('btnClearCuts').addEventListener('click', () => {
  if (!st.cuts.length) return;
  st.cuts = []; st.loopOn = false; setLoopToSegment(-1);
  cutsChanged();
});

// Vue d'ensemble : déplacer / ajouter / supprimer des points, ou se positionner
const overview = $('waveOverview');
const ov = { id: null, marker: -1, moved: false, longTimer: 0, startX: 0 };

overview.addEventListener('pointerdown', (e) => {
  if (!st.orig || ov.id !== null) return;
  const { x } = local(overview, e);
  const w = overview.clientWidth;
  ov.id = e.pointerId; ov.moved = false; ov.startX = x;
  overview.setPointerCapture(e.pointerId);
  ov.marker = -1;
  let best = 22;
  st.cuts.forEach((c, i) => { const d = Math.abs(c / st.duration * w - x); if (d < best) { best = d; ov.marker = i; } });
  if (ov.marker >= 0) {
    const idx = ov.marker;
    ov.longTimer = setTimeout(() => {
      if (!ov.moved && ov.id !== null) {
        st.cuts.splice(idx, 1); ov.marker = -1; ov.id = null;
        cutsChanged(); toast('Point supprimé');
      }
    }, 650);
  } else if (st.chopMode) {
    addCut(x / w * st.duration);
    ov.id = null;
  } else {
    seek(x / w * st.duration);
  }
});

overview.addEventListener('pointermove', (e) => {
  if (e.pointerId !== ov.id) return;
  const { x } = local(overview, e);
  if (Math.abs(x - ov.startX) > 6) { ov.moved = true; clearTimeout(ov.longTimer); }
  const t = Math.max(0, Math.min(st.duration - 0.01, x / overview.clientWidth * st.duration));
  if (ov.marker >= 0) {
    if (!ov.moved) return;
    st.cuts[ov.marker] = t;
    refreshUI();
  } else seek(t);
});

const ovEnd = (e) => {
  if (e.pointerId !== ov.id) return;
  clearTimeout(ov.longTimer);
  if (ov.marker >= 0 && ov.moved) cutsChanged();
  ov.id = null; ov.marker = -1;
};
overview.addEventListener('pointerup', ovEnd);
overview.addEventListener('pointercancel', ovEnd);

function seek(t) {
  st.pos = t;
  post({ type: 'jump', value: t });
}

// Onde zoomée : glisser = scratcher, en mode CHOP toucher = poser un point
const zoom = $('waveZoom');
const zm = { id: null, lastX: 0, startX: 0, moved: false };
const ZOOM_SPAN = 3.2;

zoom.addEventListener('pointerdown', (e) => {
  if (!st.orig || zm.id !== null) return;
  zm.id = e.pointerId; zm.lastX = zm.startX = local(zoom, e).x; zm.moved = false;
  zoom.setPointerCapture(e.pointerId);
  if (!st.chopMode) { st.touching = true; post({ type: 'touch', value: true }); }
});
zoom.addEventListener('pointermove', (e) => {
  if (e.pointerId !== zm.id) return;
  const { x } = local(zoom, e);
  if (Math.abs(x - zm.startX) > 6) zm.moved = true;
  if (!st.chopMode) post({ type: 'handDelta', value: -(x - zm.lastX) / zoom.clientWidth * ZOOM_SPAN });
  zm.lastX = x;
});
const zmEnd = (e) => {
  if (e.pointerId !== zm.id) return;
  if (st.chopMode && !zm.moved) {
    addCut(st.pos + (zm.startX - zoom.clientWidth / 2) / zoom.clientWidth * ZOOM_SPAN);
  }
  if (!st.chopMode) { st.touching = false; post({ type: 'touch', value: false }); }
  zm.id = null;
};
zoom.addEventListener('pointerup', zmEnd);
zoom.addEventListener('pointercancel', zmEnd);

// ------------------------------------------------------------------ BPM / TIME STRETCH / PITCH
function setBpm(v) {
  v = Math.round(Math.max(40, Math.min(250, v)) * 10) / 10;
  if (v === settings.bpm) return;
  settings.bpm = v; persist();
  refreshUI();
  if (settings.stretch && st.orig) {
    clearTimeout(setBpm.timer);
    setBpm.timer = setTimeout(() => applyBuffer(), 450);
  }
}
$('bpmMinus').addEventListener('click', () => setBpm(settings.bpm - 1));
$('bpmPlus').addEventListener('click', () => setBpm(settings.bpm + 1));
$('bpmValue').addEventListener('click', () => {
  const v = parseFloat((prompt('BPM du morceau', settings.bpm) || '').replace(',', '.'));
  if (v > 0) setBpm(v);
});

const taps = [];
$('btnTap').addEventListener('pointerdown', () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 3) setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)));
});

$('btnDetect').addEventListener('click', () => {
  if (!st.orig) return;
  setSrcBpm(detectBPM(st.orig.channels, st.orig.sampleRate));
  toast(`BPM détecté : ${st.srcBpm}`);
});
$('srcBpm').addEventListener('click', () => {
  if (!st.orig) return;
  const v = parseFloat((prompt('BPM d’origine du sample', st.srcBpm) || '').replace(',', '.'));
  if (v > 0) setSrcBpm(v);
});
function setSrcBpm(v) {
  st.srcBpm = Math.round(v * 10) / 10;
  if (st.sampleId) updateSample(st.sampleId, { srcBpm: st.srcBpm });
  if (settings.stretch) applyBuffer();
  refreshUI();
}

$('btnStretch').addEventListener('click', () => {
  settings.stretch = !settings.stretch; persist();
  if (settings.stretch) { setPitch(0); toast(`Time stretch : ${st.srcBpm || '?'} → ${settings.bpm} bpm, tonalité conservée`); }
  applyBuffer();
  refreshUI();
});

$('btnSync').addEventListener('click', () => {
  if (!st.srcBpm) return;
  if (settings.stretch) return toast('Déjà calé par le time stretch');
  const pct = (settings.bpm / (st.srcBpm * st.rpm) - 1) * 100;
  if (Math.abs(pct) > 50) return toast('Écart de tempo trop grand pour le pitch');
  if (Math.abs(pct) > settings.pitchRange) { settings.pitchRange = Math.abs(pct) > 16 ? 50 : 16; persist(); syncSettingsUI(); }
  setPitch(pct);
});

function setPitch(pct) {
  st.pitchPct = Math.max(-settings.pitchRange, Math.min(settings.pitchRange, pct));
  post({ type: 'pitch', value: pitchFactor() });
  refreshUI();
}
$('btnPitchReset').addEventListener('click', () => setPitch(0));
for (const [id, mul] of [['btn33', 1], ['btn45', 45 / 33.333]]) {
  $(id).addEventListener('click', () => { st.rpm = mul; post({ type: 'pitch', value: pitchFactor() }); refreshUI(); });
}

const track = $('pitchTrack');
let pitchPointer = null;
const pitchFromY = (e) => {
  const r = track.getBoundingClientRect();
  const u = (e.clientY - r.top - 17) / (r.height - 34); // 0 = haut, 1 = bas
  let pct = (Math.max(0, Math.min(1, u)) * 2 - 1) * settings.pitchRange; // + en bas, comme sur une Technics
  if (Math.abs(pct) < settings.pitchRange * 0.03) pct = 0; // cran au centre
  setPitch(pct);
};
track.addEventListener('pointerdown', (e) => { pitchPointer = e.pointerId; track.setPointerCapture(e.pointerId); pitchFromY(e); });
track.addEventListener('pointermove', (e) => { if (e.pointerId === pitchPointer) pitchFromY(e); });
track.addEventListener('pointerup', () => { pitchPointer = null; });
track.addEventListener('pointercancel', () => { pitchPointer = null; });

// ------------------------------------------------------------------ PANNEAUX
document.querySelectorAll('.panel').forEach((p) => p.addEventListener('click', (e) => {
  if (e.target === p || e.target.closest('[data-close]')) p.hidden = true;
}));

$('btnLibrary').addEventListener('click', async () => {
  const list = $('libraryList');
  list.innerHTML = '';
  const items = await listSamples();
  if (!items.length) list.innerHTML = '<li><span class="name">Aucun sample pour l’instant</span></li>';
  for (const it of items) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'name';
    info.textContent = it.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${it.srcBpm ? it.srcBpm + ' bpm · ' : ''}${(it.cuts || []).length} points`;
    info.appendChild(meta);
    const load = button('Charger', 'btn btn-accent btn-small', () => { $('libraryPanel').hidden = true; loadFromLibrary(it.id); });
    const del = button('🗑', 'btn btn-small', async () => {
      if (!confirm(`Supprimer « ${it.name} » de la bibliothèque ?`)) return;
      await deleteSample(it.id); li.remove();
    });
    li.append(info, load, del);
    list.appendChild(li);
  }
  $('libraryPanel').hidden = false;
});

function button(text, cls, fn) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = text; b.addEventListener('click', fn);
  return b;
}

$('btnSettings').addEventListener('click', () => { syncSettingsUI(); $('settingsPanel').hidden = false; });
function syncSettingsUI() {
  $('brakeTime').value = settings.brakeTime;
  $('brakeOut').textContent = settings.brakeTime.toFixed(1) + ' s';
  $('pitchRange').value = String(settings.pitchRange);
  $('padMode').value = settings.padMode;
  $('scratchDir').value = String(settings.scratchDir);
}
$('brakeTime').addEventListener('input', (e) => {
  settings.brakeTime = +e.target.value; persist(); syncSettingsUI();
  post({ type: 'brakeTime', value: settings.brakeTime });
});
$('pitchRange').addEventListener('change', (e) => { settings.pitchRange = +e.target.value; persist(); setPitch(st.pitchPct); });
$('padMode').addEventListener('change', (e) => { settings.padMode = e.target.value; st.armedPad = -1; persist(); });
$('scratchDir').addEventListener('change', (e) => { settings.scratchDir = +e.target.value; persist(); });

function persist() { saveSettings(settings); }

// ------------------------------------------------------------------ UI
function refreshUI() {
  $('bpmValue').textContent = settings.bpm.toFixed(1);
  $('srcBpm').textContent = st.srcBpm ? `${st.srcBpm} bpm` : '— bpm';
  $('btnStretch').classList.toggle('on', settings.stretch);
  $('btnChop').classList.toggle('on', st.chopMode);
  $('btnLoopPad').classList.toggle('on', st.loopOn);
  $('btn33').classList.toggle('on', st.rpm === 1);
  $('btn45').classList.toggle('on', st.rpm !== 1);
  $('pitchValue').textContent = (st.pitchPct > 0 ? '+' : '') + st.pitchPct.toFixed(1) + ' %';
  const u = (st.pitchPct / settings.pitchRange + 1) / 2;
  $('pitchKnob').style.top = `calc(17px + (100% - 34px) * ${u})`;
}

let toastTimer = 0;
function toast(msg, ms = 1800) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

// ------------------------------------------------------------------ RENDU (60 i/s)
const S = { geom: null };
const canvases = [
  [platter, drawPlatter],
  [zoom, drawWaveZoom],
  [overview, drawOverview],
].map(([el, fn]) => ({ el, fn, ctx: el.getContext('2d'), w: 0, h: 0 }));

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  for (const c of canvases) {
    c.w = c.el.clientWidth; c.h = c.el.clientHeight;
    c.el.width = Math.round(c.w * dpr); c.el.height = Math.round(c.h * dpr);
    c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}
new ResizeObserver(resize).observe(document.body);
resize();

function frame() {
  // position prédite entre deux messages du moteur audio
  let pos = st.pos;
  if (st.orig && st.msgTime) {
    pos += st.rate * Math.min(0.05, (performance.now() - st.msgTime) / 1000);
    if (st.loop) { const len = st.loop.end - st.loop.start; if (pos >= st.loop.end) pos -= len; }
    pos = ((pos % st.duration) + st.duration) % st.duration;
  }
  checkArmed(pos);
  prevPos = pos;

  const active = st.orig ? segmentAt(st.cuts, pos) : -1;
  padEls.forEach((el, i) => {
    el.classList.toggle('loaded', i < st.cuts.length);
    el.classList.toggle('active', i === active);
    el.classList.toggle('armed', i === st.armedPad);
  });

  Object.assign(S, {
    loaded: !!st.orig,
    duration: st.duration || 1,
    pos,
    angle: (pos / SEC_PER_REV) * TAU,
    peaks: st.peaks,
    peaksPerSec: st.orig ? st.peaks.length / st.duration : 1,
    cuts: st.cuts,
    activePad: active,
    chopMode: st.chopMode,
    touching: st.touching,
    muted: st.muted,
    loop: st.loop,
    beatSec: st.srcBpm ? 60 / (st.srcBpm / st.ratio) : 0,
  });
  for (const c of canvases) if (c.w) c.fn(c.ctx, c.w, c.h, S);

  const m = Math.floor(pos / 60), s = (pos % 60).toFixed(2).padStart(5, '0');
  $('timeDisplay').textContent = `${m}:${s}`;
  requestAnimationFrame(frame);
}

setMotor(0);
setMute(false);
refreshUI();
requestAnimationFrame(frame);

if ('serviceWorker' in navigator && location.hostname !== 'localhost') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
