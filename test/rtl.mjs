// Node test for src/rtl.js (WebUSB RTL-SDR driver) against test/mock_usb.js.
// Run: node test/rtl.mjs
import fs from "fs";
import vm from "vm";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { createMockRtl } = require("./mock_usb.js");

// load the classic-script driver the way the page will (no module system)
const src = fs.readFileSync(new URL("../src/rtl.js", import.meta.url), "utf8");
const ctx = vm.createContext({ console });
vm.runInContext(src + "\n;globalThis.RtlSdrUsb = RtlSdrUsb;", ctx, { filename: "rtl.js" });
const RtlSdrUsb = ctx.RtlSdrUsb;

let failures = 0;
const check = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
};

// carrier offset measured from the IQ block (phase increment of the dominant tone)
function carrierHz(block, fs) {
  let re = 0, im = 0, pi = 0, pq = 0;
  for (let i = 0; i + 1 < block.length; i += 2) {
    const I = block[i] - 127.5, Q = block[i + 1] - 127.5;
    if (i) { re += I * pi + Q * pq; im += Q * pi - I * pq; }
    pi = I; pq = Q;
  }
  return (Math.atan2(im, re) * fs) / (2 * Math.PI);
}

async function run(label, mockOpts, expect) {
  console.log(`\n== ${label}`);
  const dev = createMockRtl(mockOpts);
  const logLines = [];
  const sdr = new RtlSdrUsb(dev, (l) => logLines.push(l));
  await sdr.open();
  check(dev.opened && dev.claimed && dev.configuration.configurationValue === 1, "device opened, config 1, interface 0 claimed");
  check(sdr.tuner === expect.tuner, `tuner detected: ${sdr.tuner}`);
  check(sdr.blogV4 === expect.blogV4, `blogV4 flag: ${sdr.blogV4}`);
  check(sdr.gains.length === 29 && sdr.gains[0] === 0 && sdr.gains[28] === 49.6, `gain table: ${sdr.gains.length} steps, ${sdr.gains[0]}..${sdr.gains[28]} dB`);
  check(RtlSdrUsb.filters.length === 2 && RtlSdrUsb.filters[0].vendorId === 0x0bda, "static filters");

  const rate = await sdr.setSampleRate(2400000);
  check(Math.abs(rate - 2400000) < 1 && Math.abs(dev.mock.sampleRate() - rate) < 1e-6, `sample rate ${rate} (device ${dev.mock.sampleRate().toFixed(3)})`);

  for (const f of [145.8e6, 437e6, 1090e6, ...(expect.blogV4 ? [7.1e6] : [])]) {
    const got = await sdr.setCenterFreq(f);
    const dvc = dev.mock.tunedFreq();
    check(Math.abs(got - f) < 1000 && Math.abs(dvc - f) < 1000,
      `tune ${f / 1e6} MHz -> returned ${(got / 1e6).toFixed(6)} MHz, PLL regs decode to ${(dvc / 1e6).toFixed(6)} MHz`);
    if (expect.blogV4) {
      const hf = (dev.mock.state.tunerRegs[0x06] & 0x08) !== 0;
      const gpio5 = (dev.mock.gpo() & 0x20) !== 0;
      check(hf === f <= 28.8e6 && gpio5 === !hf, `  V4 input: HF path ${hf}, GPIO5 ${gpio5}`);
    }
  }

  for (const g of [0, 20, 33, 49.6, 100]) {
    const set = await sdr.setGain(g);
    const near = sdr.gains.reduce((a, b) => (Math.abs(b - g) < Math.abs(a - g) ? b : a));
    check(set === near && (dev.mock.state.tunerRegs[0x05] & 0x10) !== 0, `manual gain ${g} dB -> ${set} dB (LNA auto off)`);
  }
  const rg = await sdr.readGain();
  check(Number.isFinite(rg), `readGain ${rg} dB`);
  const auto = await sdr.setGain(null);
  check(auto === null && (dev.mock.state.tunerRegs[0x05] & 0x10) === 0 && (dev.mock.state.tunerRegs[0x07] & 0x10) !== 0, "auto gain (LNA + mixer AGC on)");

  await sdr.setBiasTee(true);
  check((dev.mock.gpo() & 1) === 1 && (dev.mock.gpoe() & 1) === 1 && (dev.mock.gpd() & 1) === 0, "bias tee on: GPIO0 output, high");
  const gpoWrites = dev.mock.writes((e) => e.index === 0x0210 && e.value === 0x3001);
  check(gpoWrites.length > 0 && (gpoWrites[gpoWrites.length - 1].data[0] & 1) === 1, "bias tee wrote GPO (SYS 0x3001) bit 0");
  await sdr.setBiasTee(false);
  check((dev.mock.gpo() & 1) === 0, "bias tee off: GPIO0 low");

  await sdr.setPpm(25);
  const fPpm = dev.mock.state.demod["1:63"], fPpm2 = dev.mock.state.demod["1:62"];
  check(fPpm === ((-419) & 0xff) && fPpm2 === ((-419 >> 8) & 0x3f), `ppm 25: sample-clock correction regs ${fPpm}/${fPpm2}`);
  await sdr.setPpm(0);

  await sdr.setSampleRate(1024000);
  check(Math.abs(dev.mock.sampleRate() - 1024000) < 1, `sample rate 1.024 MS/s`);
  await sdr.setSampleRate(2400000);

  await sdr.resetBuffer();
  const sizes = [16384, 65536, 512];
  for (const n of sizes) {
    const b = await sdr.readBlock(n);
    check(Object.prototype.toString.call(b) === "[object Uint8Array]", "block is a Uint8Array");
    check(b.length === n, `readBlock(${n}) -> ${b.length} bytes`);
  }
  const blk = await sdr.readBlock(262144);
  const est = carrierHz(blk, 2.4e6);
  check(Math.abs(est - mockOpts.carrierOffsetHz) < 2000, `carrier at ${est.toFixed(0)} Hz (mock ${mockOpts.carrierOffsetHz} Hz)`);
  let threw = false;
  try { await sdr.readBlock(1000); } catch (e) { threw = /multiple of 512/.test(e.message); }
  check(threw, "readBlock(1000) rejected");
  threw = false;
  try { await sdr.setSampleRate(500000); } catch (e) { threw = /Invalid sample rate/.test(e.message); }
  check(threw, "setSampleRate(500 kHz) rejected");

  await sdr.close();
  check(!dev.opened, "closed");
  check(dev.mock.writes((e) => e.index === 0x0210 && e.value === 0x3000).pop().data[0] === 0x20, "demod powered off on close");
  if (expect.logHas) check(logLines.some((l) => l.includes(expect.logHas)), `log mentions "${expect.logHas}"`);
}

try {
  await run("generic R820T dongle", { tuner: "R820T", carrierOffsetHz: 100e3 }, { tuner: "R820T", blogV4: false, logHas: "R820T" });
  await run("RTL-SDR Blog V4 (R828D)", { tuner: "R828D", blogV4: true, carrierOffsetHz: -250e3 }, { tuner: "R828D", blogV4: true, logHas: "Blog V4" });
  await run("plain R828D (16 MHz xtal)", { tuner: "R828D", blogV4: false, carrierOffsetHz: 300e3 }, { tuner: "R828D", blogV4: false });
  // no tuner answering: open() must throw a clear error
  console.log("\n== no tuner");
  const dev = createMockRtl({ tuner: "R820T" });
  dev.controlTransferIn = ((orig) => async function (s, n) { return s.index >> 8 === 6 && s.value !== 0xa0 ? { status: "stall" } : orig.call(this, s, n); })(dev.controlTransferIn);
  let msg = "";
  try { await new RtlSdrUsb(dev, () => {}).open(); } catch (e) { msg = e.message; }
  check(/no supported tuner/.test(msg), `open() without tuner throws: "${msg}"`);
} catch (e) {
  console.log("  FAIL exception:", e && e.stack ? e.stack : e);
  failures++;
}

console.log(failures ? `\nFAIL (${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
