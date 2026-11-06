// ---------------------------------------------------------------- Decoders on the demodulated audio
// JS ports of SatHunterSDR's sh-dsp decoders (GPLv3, same author): AFSK1200 / AX.25 / APRS
// (core/crates/sh-dsp/src/afsk.rs) and SSTV Robot 36 / PD120 (core/crates/sh-dsp/src/sstv.rs).
// Same algorithms and constants, so the lab results of the app hold here too (APRS 90 % packets
// at about -122.5 dBm, SSTV clean to -132 dBm with the Spacewalker LNA + RTL-SDR V3).

// Blackman-windowed low-pass, unity DC gain (sh-dsp filter::lowpass)
function decLowpass(cut, trans, fs) {
  let n = Math.ceil(5.5 * fs / Math.max(1, trans)) | 1;
  n = Math.min(4095, Math.max(15, n));
  const fc = Math.min(0.4999, Math.max(1e-6, cut / fs)), m = (n - 1) / 2, t = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    t[i] = sinc * w; sum += t[i];
  }
  for (let i = 0; i < n; i++) t[i] /= sum;
  return t;
}

// Complex FIR on a mixed-down real signal: history in a doubled ring (no wrap in the inner loop)
class MixLp {
  constructor(f0, fs, taps) {
    this.taps = taps; this.n = taps.length;
    this.hr = new Float32Array(2 * this.n); this.hi = new Float32Array(2 * this.n); this.k = 0;
    this.ph = 0; this.step = 2 * Math.PI * f0 / fs;
  }
  // returns [re, im] of the filtered sample after pushing a
  push(a, out) {
    const c = Math.cos(this.ph), s = Math.sin(this.ph);
    this.ph += this.step; if (this.ph > Math.PI) this.ph -= 2 * Math.PI;
    const n = this.n, k = this.k;
    this.hr[k] = this.hr[k + n] = a * c; this.hi[k] = this.hi[k + n] = -a * s;
    this.k = (k + 1) % n;
    let re = 0, im = 0; const hr = this.hr, hi = this.hi, t = this.taps, b = this.k;
    for (let j = 0; j < n; j++) { const w = t[j]; re += hr[b + j] * w; im += hi[b + j] * w; }
    out[0] = re; out[1] = im;
  }
}

// ---- AX.25

function crc16x25(d, n) {
  let c = 0xffff;
  for (let i = 0; i < n; i++) { c ^= d[i]; for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1; }
  return ~c & 0xffff;
}

// bytes between two flags (CRC removed) -> {src, dst, path[], info (string), tnc2} or null
function ax25Parse(raw, len) {
  const addrs = []; let k = 0;
  for (;;) {
    if (len < k + 7) return null;
    let call = "";
    for (let i = 0; i < 6; i++) call += String.fromCharCode(raw[k + i] >> 1);
    call = call.trimEnd();
    if (!call || !/^[A-Za-z0-9]+$/.test(call)) return null;
    const ssid = (raw[k + 6] >> 1) & 0x0f, h = (raw[k + 6] & 0x80) !== 0;
    addrs.push([ssid > 0 ? call + "-" + ssid : call, h]);
    const last = raw[k + 6] & 1; k += 7;
    if (last) break;
    if (addrs.length > 10) return null;
  }
  if (addrs.length < 2 || len < k + 1) return null;
  const control = raw[k++];
  if ((control & 0x01) === 0 || (control & 0xef) === 0x03) { if (k >= len) return null; k++; } // PID
  let info = "";
  for (let i = k; i < len; i++) info += String.fromCharCode(raw[i]);
  const f = { dst: addrs[0][0], src: addrs[1][0], path: addrs.slice(2).map(([c, h]) => h ? c + "*" : c), info };
  f.tnc2 = f.src + ">" + [f.dst, ...f.path].join(",") + ":" + info;
  return f;
}

// APRS position (uncompressed, with or without timestamp) -> [lat, lon] or null
function aprsPosition(info) {
  const c = info[0]; let st;
  if (c === "!" || c === "=") st = 1; else if (c === "/" || c === "@") st = 8; else return null;
  const s = info.slice(st, st + 19); if (s.length < 19) return null;
  const deg = (t, d) => { const v = Number(t.slice(0, d)), m = Number(t.slice(d, d + 5).replace(/ /g, "0")); return isFinite(v) && isFinite(m) ? v + m / 60 : NaN; };
  let lat = deg(s.slice(0, 8), 2), lon = deg(s.slice(9, 18), 3);
  if (s[7] === "S") lat = -lat; else if (s[7] !== "N") return null;
  if (s[17] === "W") lon = -lon; else if (s[17] !== "E") return null;
  return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
}

// ---- AFSK1200 decoder: FM discriminator around 1700 Hz, DPLL, NRZI, HDLC, CRC, bit repair

class AfskDecoder {
  constructor(fs) {
    this.fs = fs;
    this.mix = new MixLp(1700, fs, decLowpass(650, 500, fs));
    this.z = [0, 0]; this.lr = 1; this.li = 0;
    this.dwinN = Math.max(1, Math.round(fs / 1200 * 0.5)); this.dwin = new Float32Array(this.dwinN); this.dk = 0; this.dsum = 0;
    this.pll = 0; this.pllStep = 1200 / fs; this.prevSign = false;
    this.lastLevel = false; this.lastConf = 0;
    this.buf = new Uint8Array(512); this.nb = 0; this.conf = []; this.ones = 0; this.shift = 0; this.nbits = 0; this.inFrame = false;
    this.frames = []; this.count = 0; this.badCrc = 0; this.fixed = 0;
  }
  process(audio) {
    const z = this.z;
    for (let i = 0; i < audio.length; i++) {
      this.mix.push(audio[i], z);
      // instantaneous frequency: > 0 = space (2200 Hz), < 0 = mark (1200 Hz)
      const d = Math.atan2(z[1] * this.lr - z[0] * this.li, z[0] * this.lr + z[1] * this.li);
      this.lr = z[0]; this.li = z[1];
      this.dsum += d - this.dwin[this.dk]; this.dwin[this.dk] = d; this.dk = (this.dk + 1) % this.dwinN;
      const mark = this.dsum < 0;
      if (mark !== this.prevSign) { this.prevSign = mark; this.pll += (0.5 - this.pll) * 0.3; }
      this.pll += this.pllStep;
      if (this.pll >= 1) { this.pll -= 1; this.bit(mark, Math.abs(this.dsum)); }
    }
  }
  bit(level, conf) {
    const b = level === this.lastLevel; this.lastLevel = level;
    const c = Math.min(conf, this.lastConf); this.lastConf = conf;
    if (b) {
      if (++this.ones > 6) { this.inFrame = false; this.nb = 0; this.conf.length = 0; return; }
      this.push(1, c);
    } else {
      if (this.ones === 6) { this.flag(); this.ones = 0; return; }
      if (this.ones === 5) { this.ones = 0; return; } // stuffed 0
      this.ones = 0; this.push(0, c);
    }
  }
  push(bit, c) {
    if (!this.inFrame) return;
    this.conf.push(c);
    this.shift = (this.shift >> 1) | (bit << 7);
    if (++this.nbits === 8) {
      this.buf[this.nb++] = this.shift; this.nbits = 0;
      if (this.nb > 400) { this.inFrame = false; this.nb = 0; this.conf.length = 0; }
    }
  }
  flag() {
    const n = this.nb;
    if (this.inFrame && n >= 17) {
      const got = this.buf[n - 2] | (this.buf[n - 1] << 8);
      let f = null;
      if (crc16x25(this.buf, n - 2) === got) f = ax25Parse(this.buf, n - 2);
      else { f = this.repair(n); if (f) this.fixed++; else this.badCrc++; }
      if (f) { f.n = ++this.count; f.time = Date.now(); f.pos = aprsPosition(f.info); this.frames.push(f); if (this.frames.length > 100) this.frames.shift(); }
    }
    this.inFrame = true; this.nb = 0; this.conf.length = 0; this.nbits = 0; this.shift = 0;
  }
  // flip one of the 24 least sure bits, or it and its neighbour (one NRZI line error)
  repair(n) {
    if (n < 18 || n > 340 || this.conf.length < n * 8 || !ax25Parse(this.buf, n - 2)) return null;
    const b = this.buf.slice(0, n), idx = Array.from({ length: n * 8 }, (_, k) => k).sort((x, y) => this.conf[x] - this.conf[y]);
    const ok = () => crc16x25(b, n - 2) === (b[n - 2] | (b[n - 1] << 8));
    for (const k of idx.slice(0, 24)) {
      for (const w of [1, 2]) {
        if (k + w > n * 8) continue;
        for (let j = k; j < k + w; j++) b[j >> 3] ^= 1 << (j & 7);
        if (ok()) { const f = ax25Parse(b, n - 2); if (f) return f; }
        for (let j = k; j < k + w; j++) b[j >> 3] ^= 1 << (j & 7);
      }
    }
    return null;
  }
}

// ---- SSTV: Robot 36 and PD120 (the ISS SSTV event modes)

const SSTV_MODES = {
  8: { name: "Robot 36", w: 320, h: 240, period: 0.150, periods: 240, sync: 0.009 },
  95: { name: "PD120", w: 640, h: 496, period: 0.50848, periods: 248, sync: 0.020 },
};
const SSTV_BLACK = 1500, SSTV_WHITE = 2300, SSTV_SYNC = 1200;
const sstvLevel = (f) => Math.max(0, Math.min(255, Math.round((f - SSTV_BLACK) / (SSTV_WHITE - SSTV_BLACK) * 255)));

class SstvDecoder {
  constructor(fs) {
    this.fs = fs;
    this.mix = new MixLp(1900, fs, decLowpass(900, 600, fs));
    this.z = [0, 0]; this.lr = 1; this.li = 0;
    // frequency track as prefix sums (window means in O(1)); sample k lives at cum[k - base]
    this.cap = Math.ceil(fs * 3); this.cum = new Float64Array(this.cap + 1); this.len = 0; this.base = 0; this.n = 0;
    this.msAcc = 0; this.msN = 0; this.ms = []; this.mode = null; this.cur = null; this.done = []; this.count = 0;
  }
  process(audio) {
    const z = this.z, perMs = this.fs / 1000;
    for (let i = 0; i < audio.length; i++) {
      this.mix.push(audio[i], z);
      const f = 1900 + Math.atan2(z[1] * this.lr - z[0] * this.li, z[0] * this.lr + z[1] * this.li) * this.fs / (2 * Math.PI);
      this.lr = z[0]; this.li = z[1];
      if (this.len === this.cap) this.compact();
      this.cum[this.len + 1] = this.cum[this.len] + f; this.len++; this.n++;
      this.msAcc += f;
      if (++this.msN >= perMs) {
        this.ms.push(this.msAcc / this.msN); this.msAcc = 0; this.msN = 0;
        if (this.ms.length > 700) this.ms.shift();
        const m = this.vis(); if (m) this.start(m);
      }
      if (this.mode) this.scan();
    }
  }
  // keep the last ~1.2 s of the frequency track
  compact() {
    const keep = Math.ceil(this.fs * 1.2), drop = this.len - keep, off = this.cum[drop];
    for (let k = 0; k <= keep; k++) this.cum[k] = this.cum[k + drop] - off;
    this.len = keep; this.base += drop;
  }
  // mean frequency over [t0, t0 + len) samples, null outside the kept track
  mean(t0, len) {
    const a = Math.round(t0) - this.base, b = Math.max(a + 1, Math.round(t0 + len) - this.base);
    if (a < 0 || b > this.len) return null;
    return (this.cum[b] - this.cum[a]) / (b - a);
  }
  vis() {
    const need = 500, ms = this.ms; if (ms.length < need) return null;
    const k0 = ms.length - need;
    const mean = (a, n) => { let s = 0; for (let k = a + 3; k < a + n - 3; k++) s += ms[k]; return s / (n - 6); };
    const near = (v, f) => Math.abs(v - f) < 70;
    if (!near(mean(k0, 200), 1900) || !near(mean(k0 + 200, 30), 1200) || !near(mean(k0 + 470, 30), 1200)) return null;
    let code = 0, ones = 0;
    for (let b = 0; b < 8; b++) {
      const v = mean(k0 + 230 + 30 * b, 30);
      const one = near(v, 1100) ? 1 : near(v, 1300) ? 0 : -1;
      if (one < 0) return null;
      if (b < 7) code |= one << b;
      ones += one;
    }
    if (ones % 2) return null;
    const m = SSTV_MODES[code]; if (!m) return null;
    this.ms.length = 0;
    return m;
  }
  start(m) {
    if (this.cur && this.cur.rows * 2 >= this.cur.h) this.finish();
    this.mode = m; this.period = 0; this.periodSamples = m.period * this.fs; this.nextSync = this.n;
    this.chromaPrev = new Uint8Array(m.w).fill(128); this.yPrev = new Uint8Array(m.w);
    this.cur = { mode: m.name, w: m.w, h: m.h, rgb: new Uint8ClampedArray(m.w * m.h * 4), rows: 0, syncs: 0, started: Date.now() };
    for (let k = 3; k < this.cur.rgb.length; k += 4) this.cur.rgb[k] = 255;
  }
  finish() {
    this.cur.n = ++this.count; this.done.push(this.cur); if (this.done.length > 4) this.done.shift();
    this.cur = null; this.mode = null;
  }
  segPx(t0, s, len, n) {
    const out = new Uint8Array(n), fs = this.fs;
    for (let x = 0; x < n; x++) { const v = this.mean(t0 + (s + len * x / n) * fs, len / n * fs); out[x] = v == null ? 0 : sstvLevel(v); }
    return out;
  }
  scan() {
    const m = this.mode, fs = this.fs;
    if (this.n < this.nextSync + this.periodSamples + 0.01 * fs) return;
    // the sync: within +-8 ms of the prediction, the window of sync length with the lowest mean
    const syncLen = m.sync * fs, step = Math.max(1, fs / 4000);
    let best = Infinity, bt = this.nextSync;
    for (let t = this.nextSync - 0.008 * fs; t <= this.nextSync + 0.008 * fs; t += step) {
      const v = this.mean(t, syncLen); if (v != null && v < best) { best = v; bt = t; }
    }
    const found = Math.abs(best - SSTV_SYNC) < 120, err = bt - this.nextSync;
    let t0 = this.nextSync;
    if (found) {
      if (this.period < 4) t0 += 0.7 * err;
      else { this.periodSamples += 0.01 * err; t0 += 0.1 * err; }
    }
    const w = m.w, rows = [];
    if (m.name === "Robot 36") {
      const y = this.period, ys = this.segPx(t0, 0.012, 0.088, w), ch = this.segPx(t0, 0.106, 0.044, w / 2);
      const sep = this.mean(t0 + 0.1 * fs, 0.004 * fs) ?? SSTV_BLACK;
      const isCb = Math.abs(sep - 1900) > 250 ? sep > 1900 : y % 2 === 1;
      const full = new Uint8Array(w); for (let x = 0; x < w; x++) full[x] = ch[Math.min(ch.length - 1, x >> 1)];
      if (isCb) {
        if (y > 0) rows.push([y - 1, this.yPrev, this.chromaPrev, full]);
        rows.push([y, ys, this.chromaPrev, full]);
      } else {
        this.yPrev = ys; this.chromaPrev = full;
        rows.push([y, ys, full, new Uint8Array(w).fill(128)]);
      }
    } else {
      const s = 0.02208, l = 0.1216;
      const y0 = this.segPx(t0, s, l, w), cr = this.segPx(t0, s + l, l, w), cb = this.segPx(t0, s + 2 * l, l, w), y1 = this.segPx(t0, s + 3 * l, l, w);
      rows.push([2 * this.period, y0, cr, cb], [2 * this.period + 1, y1, cr, cb]);
    }
    const img = this.cur;
    for (const [y, ys, cr, cb] of rows) {
      if (y >= img.h) continue;
      for (let x = 0; x < w; x++) {
        const Y = ys[x], R = cr[x] - 128, B = cb[x] - 128, k = (y * w + x) * 4;
        img.rgb[k] = Y + 1.402 * R; img.rgb[k + 1] = Y - 0.344136 * B - 0.714136 * R; img.rgb[k + 2] = Y + 1.772 * B;
      }
      img.rows = Math.max(img.rows, y + 1);
    }
    img.syncs += found ? 1 : 0;
    this.period++; this.nextSync = t0 + this.periodSamples;
    if (this.period >= m.periods) this.finish();
  }
}
