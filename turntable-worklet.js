// Moteur audio de la platine : tête de lecture à vitesse variable (avant/arrière),
// moteur avec couple, arrêt progressif « coupure de courant », et suivi de la main.

const HAND_FOLLOW = 0.0035;  // réactivité du suivi de la main (par échantillon)
const MAX_RATE = 12;         // vitesse max en scratch (x fois la vitesse normale)

class TurntableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;     // Float32Array[] du sample
    this.length = 0;
    this.srcRate = sampleRate; // fréquence d'échantillonnage du sample
    this.pos = 0;             // tête de lecture (en échantillons du sample)
    this.rate = 0;            // vitesse actuelle (1 = normal, négatif = reverse)
    this.motor = 0;           // 1 = play, -1 = reverse play, 0 = moteur coupé
    this.pitch = 1;           // réglage de pitch (vitesse du moteur)
    this.touching = false;    // la main tient le disque
    this.handTarget = 0;      // position visée par la main
    this.startTime = 0.25;    // secondes pour atteindre la vitesse (démarrage)
    this.brakeTime = 1.6;     // secondes pour s'arrêter (coupure de courant)
    this.loop = null;         // {start, end} pour boucler sur un pad
    this.blocks = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.channels = m.channels;
        this.length = m.channels[0].length;
        this.srcRate = m.sampleRate;
        if (m.scalePos) this.pos *= m.scalePos;
        if (m.resetPos) this.pos = 0;
        this.pos = Math.max(0, Math.min(this.pos, this.length - 1));
        this.handTarget = this.pos;
        this.loop = null;
        break;
      case 'motor': this.motor = m.value; break;
      case 'pitch': this.pitch = m.value; break;
      case 'brakeTime': this.brakeTime = m.value; break;
      case 'touch':
        this.touching = m.value;
        this.handTarget = this.pos;
        break;
      case 'handDelta':
        // m.value en secondes de sample
        this.handTarget += m.value * this.srcRate;
        break;
      case 'jump':
        this.pos = m.value * this.srcRate;
        this.handTarget = this.pos;
        break;
      case 'loop':
        this.loop = m.value ? { start: m.value.start * this.srcRate, end: m.value.end * this.srcRate } : null;
        break;
    }
  }

  wrap(p) {
    if (this.loop && this.loop.end > this.loop.start) {
      const s = this.loop.start, len = this.loop.end - this.loop.start;
      if (p >= this.loop.end || p < s) p = s + ((((p - s) % len) + len) % len);
      return p;
    }
    const L = this.length;
    if (p >= L) p -= L;
    else if (p < 0) p += L;
    return p;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.channels || this.length < 2) {
      for (const ch of out) ch.fill(0);
      return true;
    }

    const step = this.srcRate / sampleRate; // correction de fréquence d'échantillonnage
    const startCoef = 1 / (this.startTime * sampleRate);
    const brakeCoef = 1 / (this.brakeTime * sampleRate);
    const srcL = this.channels[0];
    const srcR = this.channels[1] || srcL;
    const outL = out[0];
    const outR = out[1] || null;
    const L = this.length;

    for (let i = 0; i < n; i++) {
      if (this.touching) {
        // La main impose la position : on suit la cible avec une vitesse lissée.
        let want = (this.handTarget - this.pos) * HAND_FOLLOW * sampleRate / this.srcRate;
        if (want > MAX_RATE) want = MAX_RATE; else if (want < -MAX_RATE) want = -MAX_RATE;
        this.rate += (want - this.rate) * 0.02;
      } else {
        const target = this.motor * this.pitch;
        if (this.motor !== 0) {
          // Moteur : couple fort, rattrape vite la vitesse cible.
          const d = target - this.rate;
          const s = startCoef * 1.5;
          this.rate += Math.abs(d) < s ? d : Math.sign(d) * s;
        } else if (this.rate !== 0) {
          // Moteur coupé : décélération progressive jusqu'à l'arrêt.
          const s = brakeCoef * Math.max(0.35, Math.abs(this.rate));
          if (Math.abs(this.rate) <= s) this.rate = 0;
          else this.rate -= Math.sign(this.rate) * s;
        }
      }

      // Lecture avec interpolation d'Hermite (4 points)
      const p = this.pos;
      const i1 = Math.floor(p);
      const f = p - i1;
      const i0 = i1 - 1 < 0 ? i1 - 1 + L : i1 - 1;
      const i2 = i1 + 1 >= L ? i1 + 1 - L : i1 + 1;
      const i3 = i1 + 2 >= L ? i1 + 2 - L : i1 + 2;
      outL[i] = hermite(srcL[i0], srcL[i1], srcL[i2], srcL[i3], f);
      if (outR) outR[i] = hermite(srcR[i0], srcR[i1], srcR[i2], srcR[i3], f);

      const next = p + this.rate * step;
      this.pos = this.wrap(next);
      // si la tête a bouclé, la cible de la main suit le même saut
      if (this.pos !== next) this.handTarget += this.pos - next;
    }

    // Envoie l'état à l'interface (~86 fois/s)
    if ((this.blocks++ & 3) === 0) {
      this.port.postMessage({ pos: this.pos / this.srcRate, rate: this.rate });
    }
    return true;
  }
}

function hermite(xm1, x0, x1, x2, t) {
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const b = w + a;
  return (((a * t) - b) * t + c) * t + x0;
}

registerProcessor('turntable', TurntableProcessor);
