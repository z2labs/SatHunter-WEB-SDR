// ---------------------------------------------------------------- DSP for IQ sources (RTL-SDR): spectrum, demodulators, audio
// The ESP32-S3 makes its spectrum on the chip; the RTL-SDR sends raw 8-bit IQ, so the page does
// the FFT and the demodulation itself.

class FFT {
  constructor(n) {
    this.n = n; this.lg = Math.log2(n) | 0;
    this.cos = new Float32Array(n / 2); this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(-2 * Math.PI * i / n); this.sin[i] = Math.sin(-2 * Math.PI * i / n); }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < this.lg; b++) r |= ((i >> b) & 1) << (this.lg - 1 - b); this.rev[i] = r; }
  }
  // in-place complex FFT of re/im (Float32Array, length n)
  run(re, im) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = i + k, b = a + half, wr = this.cos[t], wi = this.sin[t];
          const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

// Windowed-sinc low-pass taps (Blackman), cutoff as a fraction of the sample rate
function lowpassTaps(n, cutoff) {
  if (n <= 1) return new Float32Array([1]);
  const h = new Float32Array(n), m = (n - 1) / 2; let s = 0;
  for (let i = 0; i < n; i++) {
    const x = i - m, sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (n - 1));
    h[i] = sinc * w; s += h[i];
  }
  for (let i = 0; i < n; i++) h[i] /= s;
  return h;
}

// Complex FIR + decimator with history between calls
class CDecim {
  constructor(taps, d) { this.h = taps; this.d = d; this.n = taps.length; this.hr = new Float32Array(this.n * 2); this.hi = new Float32Array(this.n * 2); this.p = 0; this.ph = 0; }
  // in: re/im arrays of length len; out arrays get the decimated samples, returns count
  run(re, im, len, ore, oim) {
    const h = this.h, n = this.n, d = this.d, br = this.hr, bi = this.hi; let p = this.p, ph = this.ph, k = 0;
    for (let i = 0; i < len; i++) {
      br[p] = br[p + n] = re[i]; bi[p] = bi[p + n] = im[i];
      p = p + 1 === n ? 0 : p + 1;
      if (++ph >= d) {
        ph = 0; let sr = 0, si = 0;
        for (let j = 0; j < n; j++) { const c = h[j]; sr += br[p + j] * c; si += bi[p + j] * c; }
        ore[k] = sr; oim[k] = si; k++;
      }
    }
    this.p = p; this.ph = ph; return k;
  }
}
class RDecim {
  constructor(taps, d) { this.h = taps; this.d = d; this.n = taps.length; this.b = new Float32Array(this.n * 2); this.p = 0; this.ph = 0; }
  run(x, len, out) {
    const h = this.h, n = this.n, d = this.d, b = this.b; let p = this.p, ph = this.ph, k = 0;
    for (let i = 0; i < len; i++) {
      b[p] = b[p + n] = x[i]; p = p + 1 === n ? 0 : p + 1;
      if (++ph >= d) { ph = 0; let s = 0; for (let j = 0; j < n; j++) s += b[p + j] * h[j]; out[k++] = s; }
    }
    this.p = p; this.ph = ph; return k;
  }
}

const MODES = {
  NFM: { bw: 12500 }, WFM: { bw: 180000 }, AM: { bw: 9000 }, USB: { bw: 2800 }, LSB: { bw: 2800 }, CW: { bw: 500 },
};

// One channel: IQ at the source rate -> audio at about 48 kHz
class Demod {
  constructor(fs, mode, bw) {
    this.fs = fs; this.mode = mode; this.bw = bw || MODES[mode].bw;
    this.d1 = Math.max(1, Math.round(fs / 240000));          // to ~240 kHz
    this.if1 = fs / this.d1;
    const c1 = Math.min(0.45 / this.d1, (mode === "WFM" ? 110000 : 0.4 * this.if1) / fs);
    this.dec1 = new CDecim(lowpassTaps(this.d1 > 1 ? 8 * this.d1 + 1 : 1, c1), this.d1);
    this.d2 = Math.max(1, Math.round(this.if1 / 48000));      // to ~48 kHz
    this.ar = this.if1 / this.d2;                             // audio rate
    this.ssb = mode === "USB" || mode === "LSB" || mode === "CW";
    // to ~48 kHz with a wide filter, then the channel filter at the audio rate (sharp enough for SSB)
    this.dec2 = mode === "WFM" ? null : new CDecim(lowpassTaps(8 * this.d2 + 1, 0.42 / this.d2), this.d2);
    this.chan = mode === "WFM" ? null : new CDecim(lowpassTaps(this.ssb ? 191 : 95, Math.min(0.45, this.bw / 2 / this.ar)), 1);
    this.wfmLp = mode === "WFM" ? new RDecim(lowpassTaps(6 * this.d2 + 31, 15000 / this.if1), this.d2) : null;
    this.ph = 0; this.ph2 = 0; this.lr = 1; this.li = 0; this.de = 0; this.dc = 0; this.agc = 0.1;
    const n = 1 << 18; this.a = new Float32Array(n); this.b = new Float32Array(n); this.c = new Float32Array(n); this.d = new Float32Array(n); this.e = new Float32Array(n);
  }
  // u8: interleaved unsigned IQ; off: channel offset from the centre (Hz); returns Float32Array of audio
  process(u8, off) {
    const n = u8.length >> 1, re = this.a, im = this.b;
    // shift the channel to 0 Hz (SSB: the passband centre)
    const shift = off + (this.mode === "USB" ? this.bw / 2 : this.mode === "LSB" ? -this.bw / 2 : this.mode === "CW" ? 0 : 0);
    const w = -2 * Math.PI * shift / this.fs; let ph = this.ph;
    const cw = Math.cos(w), sw = Math.sin(w); let pr = Math.cos(ph), pi = Math.sin(ph);
    for (let i = 0; i < n; i++) {
      const x = (u8[2 * i] - 127.4) / 128, y = (u8[2 * i + 1] - 127.4) / 128;
      re[i] = x * pr - y * pi; im[i] = x * pi + y * pr;
      const t = pr * cw - pi * sw; pi = pr * sw + pi * cw; pr = t;
      if ((i & 1023) === 0) { const m = 1 / Math.hypot(pr, pi); pr *= m; pi *= m; }
    }
    this.ph = Math.atan2(pi, pr);
    let k = this.dec1.run(re, im, n, this.c, this.d);
    const out = this.e;
    if (this.mode === "WFM") {
      const x = this.c, y = this.d, fm = this.a; let lr = this.lr, li = this.li;
      for (let i = 0; i < k; i++) { const r = x[i] * lr + y[i] * li, q = y[i] * lr - x[i] * li; fm[i] = Math.atan2(q, r) * (this.if1 / (2 * Math.PI * 75000)); lr = x[i]; li = y[i]; }
      this.lr = lr; this.li = li;
      const m = this.wfmLp.run(fm, k, out);
      const a = Math.exp(-1 / (this.ar * 50e-6)); let de = this.de;      // 50 µs de-emphasis
      for (let i = 0; i < m; i++) { de = a * de + (1 - a) * out[i]; out[i] = de * 0.9; }
      this.de = de; return out.subarray(0, m);
    }
    const m0 = this.dec2.run(this.c, this.d, k, this.a, this.b);
    const m = this.chan.run(this.a, this.b, m0, re, im);
    if (this.mode === "NFM") {
      let lr = this.lr, li = this.li, dc = this.dc; const g = this.ar / (2 * Math.PI * 5000);
      for (let i = 0; i < m; i++) { const r = re[i] * lr + im[i] * li, q = im[i] * lr - re[i] * li; let v = Math.atan2(q, r) * g; lr = re[i]; li = im[i]; dc += (v - dc) * 0.002; out[i] = (v - dc) * 0.8; }
      this.lr = lr; this.li = li; this.dc = dc; return out.subarray(0, m);
    }
    if (this.mode === "AM") {
      let dc = this.dc, agc = this.agc;
      for (let i = 0; i < m; i++) { const v = Math.hypot(re[i], im[i]); dc += (v - dc) * 0.001; agc += (Math.abs(v - dc) - agc) * 0.0005; out[i] = (v - dc) / Math.max(1e-4, agc) * 0.25; }
      this.dc = dc; this.agc = agc; return out.subarray(0, m);
    }
    // SSB / CW: back to the audio passband and take the real part
    const w2 = 2 * Math.PI * (this.mode === "USB" ? this.bw / 2 : this.mode === "LSB" ? -this.bw / 2 : 600) / this.ar; let p2 = this.ph2, agc = this.agc;
    for (let i = 0; i < m; i++) {
      const v = re[i] * Math.cos(p2) - im[i] * Math.sin(p2); p2 += w2;
      agc = Math.max(Math.abs(v), agc * 0.9995); out[i] = v / Math.max(1e-4, agc) * 0.3;
    }
    this.ph2 = p2 % (2 * Math.PI); this.agc = agc; return out.subarray(0, m);
  }
}

// Audio out: short AudioBuffers scheduled back to back (the browser resamples to its own rate)
class AudioOut {
  constructor() { this.ctx = null; this.t = 0; this.gain = null; this.vol = 1; this.muted = false; this.under = 0; }
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false;
      this.ctx = new AC(); this.gain = this.ctx.createGain(); this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    this.setVolume(this.vol, this.muted);
    return true;
  }
  setVolume(v, muted) { this.vol = v; this.muted = muted; if (this.gain) this.gain.gain.value = muted ? 0 : v; }
  push(samples, rate) {
    if (!this.ctx || !samples.length || this.ctx.state !== "running") return;
    const b = this.ctx.createBuffer(1, samples.length, rate); b.copyToChannel(samples instanceof Float32Array ? samples : Float32Array.from(samples), 0);
    const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.gain);
    const now = this.ctx.currentTime;
    if (this.t < now + 0.02 || this.t > now + 0.5) { if (this.t < now) this.under++; this.t = now + 0.08; }   // start / resync with a little latency
    s.start(this.t); this.t += samples.length / rate;
  }
  close() { if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; } }
}
const audioOut = new AudioOut();

// ---------------------------------------------------------------- RTL-SDR source (WebUSB): IQ in, spectrum rows and audio out
const RTL_BLOCK = 131072, RTL_INFLIGHT = 4, RTL_FPS = 90, RTL_AVG = 2;
class RtlSource {
  constructor(hooks) {
    this.h = hooks; this.dev = null; this.rtl = null; this.open = false; this.paused = false;
    this.stats = { frames: 0, lost: 0, crc: 0, bytes: 0, restarts: 0 };
    this.want = null; this.cur = {}; this.dirty = false; this.busy = false;
    this.fwInfo = ""; this.caps = ""; this.gains = [];
    this.fft = null; this.win = null; this.wsum = 1; this.re = null; this.im = null; this.acc = null;
    this.spanLeft = 0; this.toSkip = 0; this.avgN = 0; this.demod = null;
  }
  static supported() { return typeof navigator !== "undefined" && "usb" in navigator; }
  binsFor() { return [1024, 2048, 4096]; }
  async connect(existing) {
    const dev = existing || await navigator.usb.requestDevice({ filters: RtlSdrUsb.filters });
    this.dev = dev;
    const r = new RtlSdrUsb(dev, (l) => this.h.log("rtl: " + l));
    try { await r.open(); }
    catch (e) {
      try { if (dev.opened) await dev.close(); } catch (x) {}
      const m = (e && (e.name + " " + e.message)) || String(e);
      const err = new Error(m); err.driver = /claim|access denied|SecurityError|NetworkError|InvalidState/i.test(m); err.dev = dev;
      throw err;
    }
    this.rtl = r; this.open = true; this.gains = r.gains.slice();
    this.fwInfo = (r.blogV4 ? "RTL-SDR Blog V4" : "RTL-SDR") + " · tuner " + r.tuner + (dev.productName ? " · " + dev.productName : "");
    this.h.onInfo(this);
    this.loop(); this.reader();
  }
  update(s) { this.want = { ...s }; this.dirty = true; }
  async pause() { this.paused = true; this.h.onStatus("idle", "Stopped"); }
  resume() { this.paused = false; this.h.onStatus("live", "Live"); }
  async loop() {
    while (this.open) {
      if (this.dirty && !this.busy) {
        this.busy = true; this.dirty = false;
        const s = this.want, c = this.cur, r = this.rtl;
        try {
          if (s.span !== c.span) { await r.setSampleRate(s.span); c.span = s.span; this.fft = null; this.demod = null; }
          if (s.freqHz !== c.freqHz) { await r.setCenterFreq(s.freqHz); c.freqHz = s.freqHz; this.toSkip = Math.round(s.span * 0.004); }
          const g = s.gain < 0 || s.gain == null ? null : this.gains[Math.min(this.gains.length - 1, s.gain)];
          if (g !== c.gainDb || c.gain === undefined) { await r.setGain(g); c.gainDb = g; c.gain = s.gain; }
          if (s.ppm !== c.ppm) { await r.setPpm(s.ppm || 0); c.ppm = s.ppm; }
          if (!!s.bias !== c.bias) { await r.setBiasTee(!!s.bias); c.bias = !!s.bias; }
          if (s.bins !== c.bins) { c.bins = s.bins; this.fft = null; }
          if (!c.started) { await r.resetBuffer(); c.started = true; }
          if (!this.paused) this.h.onStatus("live", "Live");
          $("tuneInfo").textContent = "RTL-SDR " + (c.span / 1e6).toFixed(3) + " MS/s, " + c.bins + " bins, gain " + (g == null ? "auto" : g.toFixed(1) + " dB") + (c.bias ? ", bias tee on" : "");
        } catch (e) { this.h.log("rtl: " + e.message); }
        this.busy = false;
      }
      await sleep(30);
    }
  }
  async reader() {
    const r = this.rtl, q = [];
    try {
      while (this.open) {
        while (q.length < RTL_INFLIGHT) q.push(r.readBlock(RTL_BLOCK));
        const u8 = await q.shift();
        this.stats.bytes += u8.length;
        if (!this.paused && this.cur.span) this.process(u8);
      }
    } catch (e) {
      if (this.open) { this.open = false; this.h.log("rtl: " + e.message); this.h.onStatus("err", "RTL-SDR disconnected"); }
    }
    for (const p of q) p.catch(() => {});
  }
  setupFft() {
    const n = this.cur.bins || 2048;
    this.fft = new FFT(n); this.re = new Float32Array(n); this.im = new Float32Array(n); this.acc = new Float32Array(n);
    this.win = new Float32Array(n); let s = 0;
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / (n - 1); this.win[i] = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a); s += this.win[i]; }
    this.wsum = s; this.rowCarry = 0;
  }
  process(u8) {
    const c = this.cur, fs = c.span;
    if (this.toSkip > 0) { const k = Math.min(this.toSkip, u8.length >> 1); this.toSkip -= k; u8 = u8.subarray(k * 2); if (!u8.length) return; }
    // spectrum: RTL_FPS rows a second, each the average of RTL_AVG FFTs taken inside this block
    if (!this.fft || this.fft.n !== c.bins) this.setupFft();
    const n = this.fft.n, total = u8.length >> 1;
    this.rowCarry = (this.rowCarry || 0) + total / (fs / RTL_FPS);
    let rows = Math.floor(this.rowCarry); this.rowCarry -= rows;
    rows = Math.min(rows, Math.floor(total / (n * RTL_AVG)));
    const re = this.re, im = this.im, w = this.win, acc = this.acc, k = 1 / (RTL_AVG * this.wsum * this.wsum);
    for (let r = 0; r < rows; r++) {
      const start = Math.floor(r * (total - n * RTL_AVG) / Math.max(1, rows - 1 || 1));
      acc.fill(0);
      for (let a = 0; a < RTL_AVG; a++) {
        const p0 = start + a * n;
        for (let i = 0; i < n; i++) { const j = 2 * (p0 + i); re[i] = (u8[j] - 127.4) / 128 * w[i]; im[i] = (u8[j + 1] - 127.4) / 128 * w[i]; }
        this.fft.run(re, im);
        for (let i = 0; i < n; i++) acc[i] += re[i] * re[i] + im[i] * im[i];
      }
      const db = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = acc[(i + n / 2) % n] * k; db[i] = v > 1e-14 ? 10 * Math.log10(v) : -140; }
      this.stats.frames++;
      this.h.onSpectrum(db, n, fs, c.freqHz);
    }
    // audio
    const a = this.h.audioCfg ? this.h.audioCfg() : null;
    if (a && a.on) {
      if (!this.demod || this.demod.mode !== a.mode || this.demod.fs !== fs || this.demod.bw !== (a.bw || MODES[a.mode].bw)) this.demod = new Demod(fs, a.mode, a.bw);
      const off = a.vfo - c.freqHz;
      if (Math.abs(off) < fs / 2) audioOut.push(this.demod.process(u8, off), this.demod.ar);
    }
  }
  async close() {
    if (!this.open && !this.rtl) return;
    this.open = false;
    await sleep(60);
    try { if (this.rtl) await this.rtl.close(); } catch (e) {}
    this.rtl = null;
  }
}
