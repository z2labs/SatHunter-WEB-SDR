// Node test for src/decode.js (APRS and SSTV decoders). Run: node test/decode.mjs
import fs from "fs";
import vm from "vm";

const src = fs.readFileSync(new URL("../src/decode.js", import.meta.url), "utf8");
const ctx = vm.createContext({ console, Date, Math });
vm.runInContext(src + "\n;globalThis.D = { AfskDecoder, SstvDecoder, crc16x25, aprsPosition };", ctx, { filename: "decode.js" });
const { AfskDecoder, SstvDecoder, crc16x25, aprsPosition } = ctx.D;

let failures = 0;
const check = (cond, msg) => { console.log((cond ? "  ok   " : "  FAIL ") + msg); if (!cond) failures++; };
let seed = 0x12345678;
const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());

// ---- APRS: UI frame -> HDLC/NRZI -> AFSK audio, 6 dB twist and noise
console.log("\n== APRS");
check(crc16x25(new TextEncoder().encode("123456789"), 9) === 0x906e, "CRC-16/X.25 check value 0x906E");
const pos = aprsPosition("!4729.87N/01902.41E>Hello");
check(pos && Math.abs(pos[0] - 47.497833) < 1e-5 && Math.abs(pos[1] - 19.040167) < 1e-5, "APRS position 47.4978 19.0402");
function ui(src, dst, path, info) {
  const out = [];
  const addr = (c, last) => {
    const h = c.endsWith("*"), [call, ssid] = c.replace("*", "").split("-");
    for (let i = 0; i < 6; i++) out.push((call.charCodeAt(i) || 32) << 1);
    out.push(0x60 | ((Number(ssid) || 0) << 1) | (h ? 0x80 : 0) | (last ? 1 : 0));
  };
  addr(dst, false); addr(src, !path.length); path.forEach((p, i) => addr(p, i + 1 === path.length));
  out.push(0x03, 0xf0); for (const ch of info) out.push(ch.charCodeAt(0));
  return out;
}
function nrzi(frame, pre, post) {
  const c = crc16x25(frame, frame.length), data = [...frame, c & 0xff, c >> 8], bits = [];
  const flag = () => { for (let k = 0; k < 8; k++) bits.push((0x7e >> k) & 1); };
  for (let i = 0; i < pre; i++) flag();
  let ones = 0;
  for (const b of data) for (let k = 0; k < 8; k++) { const bit = (b >> k) & 1; bits.push(bit); if (bit) { if (++ones === 5) { bits.push(0); ones = 0; } } else ones = 0; }
  for (let i = 0; i < post; i++) flag();
  let lv = 1; return bits.map((b) => (b === 0 ? (lv ^= 1) : lv));
}
{
  const fs = 48000, lv = nrzi(ui("HA5ABC-7", "APRS", ["RS0ISS*"], "!4729.87N/01902.41E>Hello from Budapest"), 40, 4);
  const a = new Float32Array(4800 * 2 + Math.floor(lv.length * fs / 1200));
  let ph = 0;
  for (let i = 0; i < a.length - 9600; i++) { ph += 2 * Math.PI * (lv[Math.floor(i * 1200 / fs)] ? 1200 : 2200) / fs; a[4800 + i] = Math.sin(ph) * 0.5; }
  let prev = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i]; a[i] = 0.3 * (0.6 * x + 0.4 * prev) + 0.05 * gauss(); prev = x; }
  const d = new AfskDecoder(fs);
  for (let i = 0; i < a.length; i += 1000) d.process(a.subarray(i, i + 1000));
  check(d.frames.length === 1, `one frame decoded (bad CRC ${d.badCrc})`);
  check(d.frames[0] && d.frames[0].tnc2 === "HA5ABC-7>APRS,RS0ISS*:!4729.87N/01902.41E>Hello from Budapest", "TNC2: " + (d.frames[0] || {}).tnc2);
  check(d.frames[0] && d.frames[0].pos && Math.abs(d.frames[0].pos[0] - 47.497833) < 1e-5, "frame carries its position");
}

// ---- SSTV Robot 36: picture -> tones (as tools/lab/sstv_test.py) -> decoder
console.log("\n== SSTV Robot 36");
{
  const W = 320, H = 240, fs = 48000;
  const bars = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]];
  const img = (x, y) => (y < H / 2 ? bars[Math.floor(x * 8 / W)] : ((Math.floor(x / 20) + Math.floor(y / 20)) % 2 ? [20, 20, 120] : [230, 230, 230]));
  const ycc = ([r, g, b]) => { const y = 0.299 * r + 0.587 * g + 0.114 * b, c = (v) => Math.round(Math.min(255, Math.max(0, v))); return [c(y), c(128 + 0.713 * (r - y)), c(128 + 0.564 * (b - y))]; };
  const tones = [[0, 0.1], [1900, 0.3], [1200, 0.01], [1900, 0.3], [1200, 0.03]];
  let ones = 0; for (let b = 0; b < 7; b++) { const o = (8 >> b) & 1; ones += o; tones.push([o ? 1100 : 1300, 0.03]); }
  tones.push([ones % 2 ? 1100 : 1300, 0.03], [1200, 0.03]);
  const lev = (v) => 1500 + 800 * v / 255;
  for (let y = 0; y < H; y++) {
    tones.push([1200, 0.009], [1500, 0.003]);
    for (let x = 0; x < W; x++) tones.push([lev(ycc(img(x, y))[0]), 0.088 / W]);
    const even = y % 2 === 0, pair = y - (y % 2);
    tones.push([even ? 1500 : 2300, 0.0045], [1900, 0.0015]);
    for (let x2 = 0; x2 < W / 2; x2++) {
      let acc = 0; for (const yy of [pair, pair + 1]) for (const xx of [2 * x2, 2 * x2 + 1]) { const c = ycc(img(xx, yy)); acc += even ? c[1] : c[2]; }
      tones.push([lev(Math.round(acc / 4)), 0.044 / (W / 2)]);
    }
  }
  tones.push([0, 0.3]);
  const total = Math.round(tones.reduce((s, t) => s + t[1], 0) * fs), a = new Float32Array(total);
  let t = 0, k0 = 0, ph = 0;
  for (const [f, s] of tones) { const k1 = Math.round((t + s) * fs); for (let k = k0; k < k1; k++) { ph += 2 * Math.PI * f / fs; a[k] = f ? Math.sin(ph) * 0.7 : 0; } k0 = k1; t += s; }
  const t1 = Date.now();
  const d = new SstvDecoder(fs);
  for (let i = 0; i < a.length; i += 4800) d.process(a.subarray(i, i + 4800));
  const ms = Date.now() - t1;
  const got = d.done[0];
  check(!!got && got.mode === "Robot 36" && got.rows === H, `picture decoded: ${got ? got.mode + ", " + got.rows + " rows, syncs " + got.syncs : "none"}`);
  if (got) {
    let e = 0, n = 0;
    for (let y = 2; y < H - 2; y++) for (let x = 4; x < W - 4; x++) { const p = img(x, y), k = (y * W + x) * 4; for (let c = 0; c < 3; c++) { e += Math.abs(p[c] - got.rgb[k + c]); n++; } }
    check(e / n < 20, `mean pixel error ${(e / n).toFixed(1)} (0-255)`);
  }
  check(ms < a.length / fs * 1000 * 0.5, `decoding took ${(ms / 1000).toFixed(1)} s for ${(a.length / fs).toFixed(1)} s of audio`);
}

console.log(failures ? `\n${failures} FAILED` : "\nPASS");
process.exit(failures ? 1 : 0);
