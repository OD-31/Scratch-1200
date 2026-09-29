// Dessin : platine SL-1200 vue de dessus, onde enroulée au centre, bandes d'onde du haut.

export const PAD_COLORS = ['#ff3b5c', '#ff9f1a', '#ffe14d', '#3ee07a', '#33b6ff', '#b56bff'];
export const SEC_PER_REV = 60 / 33.333; // un tour de disque = 1,8 s de son (à 33 tours)
const TAU = Math.PI * 2;

// Segment (index de pad) qui contient le temps t
export function segmentAt(cuts, t) {
  let idx = -1;
  for (let i = 0; i < cuts.length; i++) if (t >= cuts[i]) idx = i;
  return idx;
}

function colorAt(S, t) {
  if (!S.cuts.length) return '#00e0b8';
  const d = S.duration;
  const tt = ((t % d) + d) % d;
  const i = segmentAt(S.cuts, tt);
  return i < 0 ? '#6b717b' : PAD_COLORS[i];
}

function peakAt(S, t) {
  const d = S.duration;
  const tt = ((t % d) + d) % d;
  const i = Math.floor(tt * S.peaksPerSec);
  return S.peaks[Math.min(S.peaks.length - 1, Math.max(0, i))] || 0;
}

// ------------------------------------------------------------------ PLATINE
export function drawPlatter(ctx, w, h, S) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const R = Math.min(w, h) / 2 - 10;
  if (R < 40) return; // taille pas encore connue (mise en page en cours)
  S.geom = { cx, cy, R };
  const rot = S.angle; // rotation du disque (radians, sens horaire)

  // plateau métal (ombre + points strobo) et vinyle : dessinés une fois puis mis en cache
  const Rv = R - 26;
  const layers = platterLayers(R, Rv);
  ctx.save(); ctx.translate(cx, cy);
  ctx.save(); ctx.rotate(rot);
  ctx.drawImage(layers.plate, -layers.half, -layers.half, layers.half * 2, layers.half * 2);
  ctx.restore();
  ctx.drawImage(layers.vinyl, -layers.half, -layers.half, layers.half * 2, layers.half * 2);
  // repère tournant sur le vinyle (pour voir la rotation)
  ctx.rotate(rot);
  ctx.strokeStyle = S.touching ? '#fff' : 'rgba(0,224,184,.9)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-Rv * .42, 0); ctx.lineTo(-Rv + 10, 0); ctx.stroke();
  ctx.restore();

  // ----- onde enroulée au centre (tourne avec le disque)
  const rOut = Rv * 0.34, rIn = Rv * 0.12;
  ctx.beginPath(); ctx.arc(cx, cy, rOut + 6, 0, TAU); ctx.fillStyle = '#141519'; ctx.fill();
  if (S.loaded) drawSpiral(ctx, cx, cy, rIn, rOut, S);

  // étiquette centrale
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot);
  ctx.beginPath(); ctx.arc(0, 0, rIn - 3, 0, TAU); ctx.fillStyle = S.muted ? '#5a1010' : '#ff6a00'; ctx.fill();
  ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.font = `800 ${Math.max(8, rIn * .22)}px -apple-system, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('SKRATCH', 0, -rIn * .42);
  ctx.fillRect(rIn * .2, -2, rIn * .6, 4);
  ctx.restore();
  // axe
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, TAU); ctx.fillStyle = '#ddd'; ctx.fill();

  // ----- repère fixe de tête de lecture (midi)
  ctx.save();
  ctx.strokeStyle = '#ff2d2d'; ctx.lineWidth = 3; ctx.shadowColor = '#ff2d2d'; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.moveTo(cx, cy - rIn + 4); ctx.lineTo(cx, cy - rOut - 12); ctx.stroke();
  ctx.fillStyle = '#ff2d2d';
  ctx.beginPath(); ctx.moveTo(cx - 8, cy - rOut - 22); ctx.lineTo(cx + 8, cy - rOut - 22); ctx.lineTo(cx, cy - rOut - 10); ctx.fill();
  ctx.restore();

  drawTonearm(ctx, w, h, cx, cy, R, Rv, S);

  if (!S.loaded) {
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.font = '600 18px -apple-system, sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('Charge un sample 📂', cx, cy + Rv * .6);
  }
}

// Couches statiques de la platine, recalculées seulement si la taille change
let layerCache = null;
function platterLayers(R, Rv) {
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1);
  if (layerCache && layerCache.R === R && layerCache.dpr === dpr) return layerCache;
  const half = R + 40;
  const size = Math.ceil(half * 2 * dpr);
  const make = () => {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, half * dpr, half * dpr);
    return [c, x];
  };

  const [plate, p] = make();
  p.save();
  p.shadowColor = 'rgba(0,0,0,.55)'; p.shadowBlur = 24; p.shadowOffsetY = 8;
  p.beginPath(); p.arc(0, 0, R, 0, TAU); p.fillStyle = '#6d7076'; p.fill();
  p.restore();
  const metal = p.createRadialGradient(-R * .3, -R * .3, R * .1, 0, 0, R);
  metal.addColorStop(0, '#d4d7db'); metal.addColorStop(.7, '#8b8f95'); metal.addColorStop(1, '#5d6066');
  p.beginPath(); p.arc(0, 0, R, 0, TAU); p.fillStyle = metal; p.fill();
  p.fillStyle = '#2b2d31';
  for (const [ring, count, sz] of [[R - 5, 180, 1.6], [R - 12, 176, 1.4], [R - 19, 172, 1.2]]) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      p.fillRect(Math.cos(a) * ring - sz / 2, Math.sin(a) * ring - sz / 2, sz, sz);
    }
  }

  const [vinyl, v] = make();
  v.beginPath(); v.arc(0, 0, Rv, 0, TAU); v.fillStyle = '#0b0b0d'; v.fill();
  v.lineWidth = 1;
  for (let r = Rv - 6; r > Rv * 0.36; r -= 3) {
    v.strokeStyle = (r | 0) % 2 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.5)';
    v.beginPath(); v.arc(0, 0, r, 0, TAU); v.stroke();
  }
  for (const a0 of [-2.4, 0.74]) { // reflets de lumière fixes
    const g = v.createRadialGradient(0, 0, Rv * .36, 0, 0, Rv);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.6, 'rgba(255,255,255,.07)'); g.addColorStop(1, 'rgba(255,255,255,.02)');
    v.beginPath(); v.moveTo(0, 0); v.arc(0, 0, Rv, a0, a0 + .5); v.closePath();
    v.fillStyle = g; v.fill();
  }

  layerCache = { R, dpr, half, plate, vinyl };
  return layerCache;
}

// Spirale : chaque tour = SEC_PER_REV secondes ; le son à la position courante est sous le repère.
// Les traits sont regroupés par couleur et opacité pour limiter le nombre de tracés.
function drawSpiral(ctx, cx, cy, rIn, rOut, S) {
  const turnsBefore = 1.2, turnsAfter = 2.3;
  const total = turnsBefore + turnsAfter;
  const steps = 900;
  const band = (rOut - rIn) / (total + 0.6);
  const top = -Math.PI / 2;
  const paths = new Map();
  for (let s = 0; s < steps; s++) {
    const u = -turnsBefore + (s / steps) * total;         // tours relatifs à la tête
    const t = S.pos + u * SEC_PER_REV;
    if (S.duration < SEC_PER_REV * total && (t < S.pos - S.duration / 2 || t > S.pos + S.duration)) continue;
    const a = top - u * TAU;                              // le futur arrive depuis la gauche (sens horaire)
    const base = rOut - band * (u + turnsBefore) - band * 0.3; // sillon vers l'intérieur
    const amp = peakAt(S, t) * band * 0.9;
    const alpha = u < 0 ? 0.35 : Math.round((1 - (u / turnsAfter) * 0.55) * 8) / 8;
    const key = colorAt(S, t) + '|' + alpha;
    let path = paths.get(key);
    if (!path) { path = new Path2D(); paths.set(key, path); }
    const c = Math.cos(a), si = Math.sin(a);
    path.moveTo(cx + c * (base - amp * .5), cy + si * (base - amp * .5));
    path.lineTo(cx + c * (base + amp * .5 + 0.8), cy + si * (base + amp * .5 + 0.8));
  }
  ctx.lineWidth = Math.max(1.5, (rOut - rIn) / steps * 60);
  for (const [key, path] of paths) {
    const [color, alpha] = key.split('|');
    ctx.strokeStyle = color;
    ctx.globalAlpha = +alpha;
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

function drawTonearm(ctx, w, h, cx, cy, R, Rv, S) {
  const px = Math.min(w - 26, cx + R + 4), py = cy - R * 0.72; // pivot
  const nx = cx + Rv * 0.62, ny = cy - Rv * 0.55;               // pointe
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(px + 6, py + 10); ctx.lineTo(nx + 6, ny + 10); ctx.stroke();
  ctx.strokeStyle = '#d9dce0'; ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(nx, ny); ctx.stroke();
  ctx.fillStyle = '#222'; ctx.translate(nx, ny); ctx.rotate(Math.atan2(ny - py, nx - px));
  ctx.fillRect(-4, -9, 26, 18);
  ctx.fillStyle = S.muted ? '#ff3b3b' : '#00e0b8'; ctx.fillRect(14, -3, 6, 6);
  ctx.restore();
  ctx.beginPath(); ctx.arc(px, py, 16, 0, TAU); ctx.fillStyle = '#2a2c30'; ctx.fill();
  ctx.beginPath(); ctx.arc(px, py, 7, 0, TAU); ctx.fillStyle = '#aaa'; ctx.fill();
}

// ------------------------------------------------------------------ ONDE ZOOM (défile)
export function drawWaveZoom(ctx, w, h, S) {
  ctx.clearRect(0, 0, w, h);
  if (!S.loaded) return hintText(ctx, w, h, 'Onde du sample');
  const span = 3.2; // secondes visibles
  const mid = h / 2;
  const pxPerSec = w / span;
  const x0 = w / 2;
  // grille des temps
  if (S.beatSec > 0) {
    const beat = S.beatSec;
    const first = Math.floor((S.pos - span / 2) / beat);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    for (let b = first; b * beat < S.pos + span / 2; b++) {
      const x = x0 + (b * beat - S.pos) * pxPerSec;
      ctx.fillRect(x, 0, b % 4 === 0 ? 2 : 1, h);
    }
  }
  for (let x = 0; x < w; x += 2) {
    const t = S.pos + (x - x0) / pxPerSec;
    if (t < 0 || t > S.duration) continue;
    const p = peakAt(S, t) * (mid - 4);
    ctx.fillStyle = colorAt(S, t);
    ctx.globalAlpha = x < x0 ? 0.55 : 1;
    ctx.fillRect(x, mid - p, 1.6, p * 2 + 1);
  }
  ctx.globalAlpha = 1;
  // points de découpe
  S.cuts.forEach((c, i) => {
    const x = x0 + (c - S.pos) * pxPerSec;
    if (x < -20 || x > w + 20) return;
    marker(ctx, x, h, i);
  });
  ctx.fillStyle = '#ff2d2d'; ctx.fillRect(x0 - 1, 0, 2, h);
}

// ------------------------------------------------------------------ VUE D'ENSEMBLE
export function drawOverview(ctx, w, h, S) {
  ctx.clearRect(0, 0, w, h);
  if (!S.loaded) return hintText(ctx, w, h, S.chopMode ? 'Charge un sample pour le découper' : '');
  const mid = h / 2;
  // segments colorés en fond
  S.cuts.forEach((c, i) => {
    const end = i + 1 < S.cuts.length ? S.cuts[i + 1] : S.duration;
    ctx.fillStyle = PAD_COLORS[i] + (i === S.activePad ? '38' : '18');
    ctx.fillRect(c / S.duration * w, 0, (end - c) / S.duration * w, h);
  });
  for (let x = 0; x < w; x++) {
    const t = x / w * S.duration;
    const p = peakAt(S, t) * (mid - 3);
    ctx.fillStyle = colorAt(S, t);
    ctx.fillRect(x, mid - p, 1, p * 2 + 1);
  }
  S.cuts.forEach((c, i) => marker(ctx, c / S.duration * w, h, i));
  if (S.loop) {
    ctx.strokeStyle = '#fff'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
    ctx.strokeRect(S.loop.start / S.duration * w, 1, (S.loop.end - S.loop.start) / S.duration * w, h - 2);
    ctx.setLineDash([]);
  }
  const x = S.pos / S.duration * w;
  ctx.fillStyle = '#ff2d2d'; ctx.fillRect(x - 1, 0, 2, h);
  if (S.chopMode) {
    ctx.strokeStyle = PAD_COLORS[0]; ctx.lineWidth = 2; ctx.strokeRect(1, 1, w - 2, h - 2);
  }
}

function marker(ctx, x, h, i) {
  ctx.fillStyle = PAD_COLORS[i];
  ctx.fillRect(x - 1, 0, 2, h);
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 18, 0); ctx.lineTo(x + 18, 14); ctx.lineTo(x, 20); ctx.fill();
  ctx.fillStyle = '#000'; ctx.font = '800 11px -apple-system, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(String(i + 1), x + 5, 2);
}

function hintText(ctx, w, h, text) {
  ctx.fillStyle = '#555'; ctx.font = '600 14px -apple-system, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, w / 2, h / 2);
}
