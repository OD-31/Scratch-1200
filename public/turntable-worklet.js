// Moteur audio de la platine : tête de lecture à vitesse variable (avant/arrière),
// moteur avec couple, arrêt progressif « coupure de courant », et suivi de la main.
//
// Qualité du son en scratch :
//  - la position donnée par la main (qui arrive par à-coups, 60-120 fois/s) est lissée
//    par un filtre du 2e ordre -> vitesse continue, sans grésillement ;
//  - le son est lu dans des versions pré-filtrées (mipmaps) quand la vitesse dépasse 1x,
//    pour éviter le repliement des aigus (aliasing) qui donne un son « granuleux ».

const TARGET_SMOOTH = 0.004; // s : lissage de la cible de la main
const FOLLOW_TIME = 0.006;   // s : temps de rattrapage de la position
const RATE_SMOOTH = 0.003;   // s : inertie de la vitesse
const MAX_RATE = 16;         // vitesse max en scratch

class TurntableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.levels = null;       // levels[k][c] : niveau k (décimé par 2^k), canal c
    this.length = 0;
    this.srcRate = sampleRate;
    this.pos = 0;             // tête de lecture (en échantillons du sample)
    this.rate = 0;            // vitesse actuelle (1 = normal, négatif = reverse)
    this.motor = 0;           // 1 = play, -1 = reverse play, 0 = moteur coupé
    this.pitch = 1;
    this.touching = false;
    this.handTarget = 0;      // position brute donnée par la main
    this.smoothTarget = 0;    // position lissée
    this.rampTarget = 0;      // cible étalée entre deux événements du doigt
    this.rampVel = 0;
    this.frame = 0;
    this.lastHandFrame = -1e9;
    this.avgInterval = sampleRate / 60; // intervalle moyen entre événements (échantillons)
    this.startTime = 0.25;
    this.brakeTime = 1.2;
    this.loop = null;
    this.blocks = 0;

    this.aTarget = 1 - Math.exp(-1 / (TARGET_SMOOTH * sampleRate));
    this.aRate = 1 - Math.exp(-1 / (RATE_SMOOTH * sampleRate));
    this.kFollow = 1 / (FOLLOW_TIME * sampleRate);

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    switch (m.type) {
      case 'load':
        this.levels = m.levels;
        this.length = m.levels[0][0].length;
        this.srcRate = m.sampleRate;
        if (m.scalePos) this.pos *= m.scalePos;
        if (m.resetPos) this.pos = 0;
        this.pos = Math.max(0, Math.min(this.pos, this.length - 1));
        this.resetHand();
        this.loop = null;
        break;
      case 'motor': this.motor = m.value; break;
      case 'pitch': this.pitch = m.value; break;
      case 'brakeTime': this.brakeTime = m.value; break;
      case 'touch':
        this.touching = m.value;
        this.resetHand();
        break;
      case 'handDelta': {
        // Le doigt envoie sa position par à-coups : on étale chaque déplacement
        // sur la durée moyenne entre deux événements pour obtenir une vitesse continue.
        const dt = this.frame - this.lastHandFrame;
        this.lastHandFrame = this.frame;
        if (dt > 0 && dt < 0.06 * sampleRate) this.avgInterval += (dt - this.avgInterval) * 0.25;
        this.handTarget += m.value * this.srcRate; // m.value en secondes de sample
        this.rampVel = (this.handTarget - this.rampTarget) / this.avgInterval;
        break;
      }
      case 'jump':
        this.pos = m.value * this.srcRate;
        this.resetHand();
        break;
      case 'loop':
        this.loop = m.value ? { start: m.value.start * this.srcRate, end: m.value.end * this.srcRate } : null;
        break;
    }
  }

  resetHand() {
    this.handTarget = this.rampTarget = this.smoothTarget = this.pos;
    this.rampVel = 0;
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
    if (!this.levels || this.length < 4) {
      for (const ch of out) ch.fill(0);
      return true;
    }

    const step = this.srcRate / sampleRate;
    const startStep = 1.5 / (this.startTime * sampleRate);
    const brakeCoef = 1 / (this.brakeTime * sampleRate);
    const outL = out[0];
    const outR = out[1] || null;
    const maxLevel = this.levels.length - 1;

    for (let i = 0; i < n; i++) {
      if (this.touching) {
        if (this.rampVel !== 0) {
          this.rampTarget += this.rampVel;
          if ((this.rampVel > 0 && this.rampTarget >= this.handTarget) ||
              (this.rampVel < 0 && this.rampTarget <= this.handTarget)) {
            this.rampTarget = this.handTarget;
            this.rampVel = 0;
          }
        }
        this.smoothTarget += (this.rampTarget - this.smoothTarget) * this.aTarget;
        let want = (this.smoothTarget - this.pos) * this.kFollow / step;
        if (want > MAX_RATE) want = MAX_RATE; else if (want < -MAX_RATE) want = -MAX_RATE;
        this.rate += (want - this.rate) * this.aRate;
      } else if (this.motor !== 0) {
        const d = this.motor * this.pitch - this.rate;
        this.rate += Math.abs(d) < startStep ? d : Math.sign(d) * startStep;
      } else if (this.rate !== 0) {
        const s = brakeCoef * Math.max(0.35, Math.abs(this.rate));
        if (Math.abs(this.rate) <= s) this.rate = 0;
        else this.rate -= Math.sign(this.rate) * s;
      }

      // Choix du niveau anti-aliasing selon la vitesse de lecture
      const speed = Math.abs(this.rate) * step;
      let l = 0, r = 0;
      if (speed <= 1 || maxLevel === 0) {
        l = this.read(0, 0); if (outR) r = this.read(0, 1);
      } else {
        let lv = Math.log2(speed);
        if (lv > maxLevel) lv = maxLevel;
        const k = Math.floor(lv), f = lv - k;
        l = this.read(k, 0); if (outR) r = this.read(k, 1);
        if (f > 0 && k < maxLevel) {
          l += (this.read(k + 1, 0) - l) * f;
          if (outR) r += (this.read(k + 1, 1) - r) * f;
        }
      }
      outL[i] = l;
      if (outR) outR[i] = r;

      const next = this.pos + this.rate * step;
      this.pos = this.wrap(next);
      if (this.pos !== next) {
        const shift = this.pos - next; // la tête a bouclé : la main suit le même saut
        this.handTarget += shift;
        this.rampTarget += shift;
        this.smoothTarget += shift;
      }
    }

    this.frame += n;
    if ((this.blocks++ & 3) === 0) {
      this.port.postMessage({ pos: this.pos / this.srcRate, rate: this.rate });
    }
    return true;
  }

  // Lecture interpolée (Hermite 4 points) dans le niveau k
  read(k, c) {
    const lvl = this.levels[k];
    const src = lvl[c] || lvl[0];
    const L = src.length;
    const p = k ? this.pos / (1 << k) : this.pos;
    let i1 = Math.floor(p);
    const t = p - i1;
    if (i1 >= L) i1 -= L;
    const i0 = i1 === 0 ? L - 1 : i1 - 1;
    const i2 = i1 + 1 >= L ? i1 + 1 - L : i1 + 1;
    const i3 = i1 + 2 >= L ? i1 + 2 - L : i1 + 2;
    const xm1 = src[i0], x0 = src[i1], x1 = src[i2], x2 = src[i3];
    const cc = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = cc + v;
    const a = w + v + (x2 - x0) * 0.5;
    const b = w + a;
    return (((a * t) - b) * t + cc) * t + x0;
  }
}

registerProcessor('turntable', TurntableProcessor);
