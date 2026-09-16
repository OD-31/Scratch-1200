// Traitements audio hors temps réel : forme d'onde, détection de BPM, time-stretch (WSOLA).

export function toMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const m = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) m[i] += ch[i] / channels.length;
  return m;
}

// Amplitude max par tranche (pour dessiner l'onde)
export function computePeaks(channels, buckets) {
  const mono = toMono(channels);
  const peaks = new Float32Array(buckets);
  const size = mono.length / buckets;
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * size), e = Math.max(s + 1, Math.floor((b + 1) * size));
    let p = 0;
    for (let i = s; i < e && i < mono.length; i++) { const v = Math.abs(mono[i]); if (v > p) p = v; }
    peaks[b] = p;
    if (p > max) max = p;
  }
  if (max > 0) for (let b = 0; b < buckets; b++) peaks[b] /= max;
  return peaks;
}

// Estimation du BPM : autocorrélation de l'enveloppe d'attaques,
// avec repli sur la durée (boucle de 1, 2, 4, 8 ou 16 temps).
export function detectBPM(channels, sampleRate) {
  const mono = toMono(channels);
  const duration = mono.length / sampleRate;
  const hop = Math.round(sampleRate / 200); // enveloppe à 200 Hz
  const frames = Math.floor(mono.length / hop);
  const env = new Float32Array(frames);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) e += mono[i] * mono[i];
    e = Math.sqrt(e / hop);
    env[f] = Math.max(0, e - prev); // flux positif = attaques
    prev = e;
  }

  let best = 0, bestScore = 0;
  if (duration >= 3) {
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const lag = (60 / bpm) * 200;
      const l0 = Math.floor(lag), fr = lag - l0;
      let score = 0;
      for (let f = 0; f + l0 + 1 < frames; f++) {
        score += env[f] * (env[f + l0] * (1 - fr) + env[f + l0 + 1] * fr);
      }
      score /= Math.max(1, frames - l0);
      // léger bonus pour les tempos classiques du hip-hop
      if (bpm >= 85 && bpm <= 115) score *= 1.08;
      if (score > bestScore) { bestScore = score; best = bpm; }
    }
  }
  if (!best) {
    // repli : suppose une boucle d'un nombre entier de temps
    for (const beats of [16, 8, 4, 2, 1]) {
      const bpm = (60 * beats) / duration;
      if (bpm >= 70 && bpm <= 180) { best = bpm; break; }
    }
  }
  return best ? Math.round(best * 10) / 10 : 90;
}

// Versions pré-filtrées du son (mipmaps) pour la lecture rapide sans aliasing.
// levels[0] = original, levels[k] = filtré passe-bas et décimé par 2^k.
const HALFBAND = (() => {
  const taps = 63, c = (taps - 1) / 2, h = new Float32Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const m = n - c;
    const sinc = m === 0 ? 0.5 : Math.sin(Math.PI * m / 2) / (Math.PI * m);
    const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (taps - 1));
    h[n] = sinc * win;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return { h, c };
})();

function halfbandDecimate(x) {
  const { h, c } = HALFBAND;
  const L = x.length, outLen = Math.ceil(L / 2);
  const y = new Float32Array(outLen);
  const center = h[c];
  for (let j = 0; j < outLen; j++) {
    const i = j * 2;
    let acc = center * x[i];
    for (let m = 1; m <= c; m += 2) { // les coefficients pairs sont nuls
      let a = i - m, b = i + m;
      if (a < 0) a += L;
      if (b >= L) b -= L;
      acc += h[c + m] * (x[a] + x[b]);
    }
    y[j] = acc;
  }
  return y;
}

export function buildLevels(channels, count = 5) {
  const levels = [channels];
  for (let k = 1; k < count; k++) {
    const prev = levels[k - 1];
    if (prev[0].length < 256) break;
    levels.push(prev.map(halfbandDecimate));
  }
  return levels;
}

// Time-stretch WSOLA : change la durée sans changer la tonalité.
// ratio = durée de sortie / durée d'entrée  (ex. sample 90 bpm -> 100 bpm : ratio = 0.9)
export function timeStretch(channels, sampleRate, ratio) {
  if (Math.abs(ratio - 1) < 1e-4) return channels.map((c) => c.slice());
  const N = 1 << Math.round(Math.log2(sampleRate * 0.046)); // ~46 ms (2048 @ 44.1k)
  const Hs = N / 4; // recouvrement 75 % : moins d'artefacts
  const Ha = Hs / ratio;
  const tol = N / 4;
  const inLen = channels[0].length;
  const outLen = Math.round(inLen * ratio);
  const mono = toMono(channels);

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

  const outs = channels.map(() => new Float32Array(outLen + N));
  const frames = Math.ceil(outLen / Hs) + 1;
  let prevPos = 0;
  const DEC = 4; // décimation pour accélérer la corrélation

  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * Ha);
    let pos = nominal;
    if (k > 0) {
      const natural = prevPos + Hs;
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - tol), hi = Math.min(inLen - N, nominal + tol);
      for (let cand = lo; cand <= hi; cand += 2) {
        let s = 0;
        for (let i = 0; i < N; i += DEC) {
          const a = natural + i < inLen ? mono[natural + i] : 0;
          s += a * mono[cand + i];
        }
        if (s > bestScore) { bestScore = s; pos = cand; }
      }
      if (hi < lo) pos = Math.min(Math.max(0, nominal), Math.max(0, inLen - 1));
    }
    const o = k * Hs;
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c], dst = outs[c];
      for (let i = 0; i < N; i++) {
        const j = pos + i;
        if (j >= inLen || o + i >= dst.length) break;
        dst[o + i] += src[j] * win[i] * 0.5; // somme des fenêtres de Hann à 75 % = 2
      }
    }
    prevPos = pos;
  }
  return outs.map((d) => d.subarray(0, outLen).slice());
}
