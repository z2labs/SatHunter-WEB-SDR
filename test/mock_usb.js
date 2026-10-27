// Fake RTL-SDR (RTL2832U + R820T/R828D) behind a fake WebUSB USBDevice (test only).
// Node: const { createMockRtl } = require("./mock_usb.js")
// Browser / Playwright add_init_script: window.__mockRtl(opts) makes a device,
// window.__installMockUsb(opts) replaces navigator.usb (also done automatically when
// window.__mockRtlOptions is set before this script runs).
//
// opts: { tuner: "R820T" | "R828D", blogV4: bool, carrierOffsetHz, carrierAmp (0..127),
//         noise (std dev in LSB), eeprom7 (EEPROM byte 7), failTestWrite }
(function () {
  "use strict";
  const BITREV4 = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
  const bitReverse = (b) => (BITREV4[b & 0xf] << 4) | BITREV4[b >> 4];
  const ok = (data) => ({ status: "ok", data: new DataView(data.buffer, data.byteOffset, data.byteLength) });

  function createMockRtl(opts) {
    const o = Object.assign({ tuner: "R820T", blogV4: false, carrierOffsetHz: 100e3, carrierAmp: 60, noise: 4, eeprom7: 0x16 }, opts || {});
    if (o.blogV4 && opts && !opts.tuner) o.tuner = "R828D";
    const tunerAddr = o.tuner === "R828D" ? 0x74 : 0x34;
    const tunerXtal = o.tuner === "R828D" && !o.blogV4 ? 16e6 : 28.8e6;

    const state = {
      log: [], // every control transfer: {dir, value, index, data}
      demod: {}, // "page:addr" -> last byte(s) written
      blocks: {}, // "block:addr" -> value
      tunerRegs: new Uint8Array(32), // R82xx write registers (as written)
      i2cPtr: {}, // per I2C address read pointer
      eeprom: new Uint8Array(256),
      bulkCalls: 0,
      phase: 0,
      rng: 12345,
    };
    state.eeprom.set([0x28, 0x32, 0xda, 0x0b, 0x38, 0x28, 0xa5, o.eeprom7, 0x02]);
    // R82xx status registers 0..4 (logical values; the chip sends them bit-reversed)
    const status = [0x96, 0x00, 0x40 /* PLL lock */, 0x00, (o.tuner === "R828D" ? 0x10 : 0x20) /* vco fine tune = power ref */ | 0x08 /* fil cal */];

    function demodGet(page, addr) { const v = state.demod[page + ":" + addr]; return v === undefined ? 0 : v; }
    function blockGet(block, addr) { const v = state.blocks[block + ":" + addr]; return v === undefined ? 0 : v; }

    function i2cRead(addr, len) {
      if (addr === 0xa0) {
        const p = state.i2cPtr[addr] || 0;
        const out = state.eeprom.slice(p, p + len);
        state.i2cPtr[addr] = (p + len) & 0xff;
        return out;
      }
      if (addr !== tunerAddr) return null; // NAK
      const p = state.i2cPtr[addr] || 0;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        const r = p + i;
        // reg 0 is the chip id: 0x69 on the wire (the driver compares it unreversed)
        if (r === 0) out[i] = 0x69;
        else if (r === 3) out[i] = bitReverse(((state.tunerRegs[0x07] & 0x0f) << 4) | (state.tunerRegs[0x05] & 0x0f)); // active mixer/LNA gain index
        else out[i] = bitReverse(r < 5 ? status[r] : state.tunerRegs[r]);
      }
      return out;
    }

    function i2cWrite(addr, data) {
      if (addr === 0xa0) { state.i2cPtr[addr] = data[0]; return true; }
      if (addr !== tunerAddr) return false; // NAK
      if (!data.length) return true;
      if (data.length > 8) throw new Error("mock: I2C message longer than 8 bytes");
      state.i2cPtr[addr] = data[0];
      for (let i = 1; i < data.length; i++) state.tunerRegs[data[0] + i - 1] = data[i];
      return true;
    }

    // ---- what the hardware would be doing now, decoded from the registers
    function sampleRate() {
      const hi = demodGet(1, 0x9f), lo = demodGet(1, 0xa1);
      let ratio = ((hi << 16) | lo) >>> 0;
      if (!ratio) return 0;
      ratio = (ratio | ((ratio & 0x08000000) << 1)) >>> 0;
      return (28.8e6 * 4194304) / ratio;
    }
    function ifFreq() {
      let v = ((demodGet(1, 0x19) & 0x3f) << 16) | (demodGet(1, 0x1a) << 8) | demodGet(1, 0x1b);
      if (v & 0x200000) v -= 0x400000; // 22-bit signed
      return (-v * 28.8e6) / 4194304;
    }
    function loFreq() {
      const r = state.tunerRegs;
      const divNum = (r[0x10] >> 5) & 7, mixDiv = 2 << divNum;
      const ni = r[0x14] & 0x3f, si = r[0x14] >> 6, nint = 4 * ni + si + 13;
      const sdm = (r[0x16] << 8) | r[0x15];
      return (2 * tunerXtal * (nint + sdm / 65536)) / mixDiv;
    }
    function tunedFreq() {
      const hfPath = o.blogV4 && (state.tunerRegs[0x06] & 0x08);
      return loFreq() - ifFreq() - (hfPath ? 28.8e6 : 0);
    }

    function gauss() {
      // Box-Muller on a small LCG (deterministic)
      const u = () => { state.rng = (state.rng * 1103515245 + 12345) & 0x7fffffff; return (state.rng + 1) / 0x80000001; };
      return Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
    }

    const dev = {
      vendorId: 0x0bda,
      productId: 0x2838,
      manufacturerName: o.blogV4 ? "RTLSDRBlog" : "Realtek",
      productName: o.blogV4 ? "Blog V4" : "RTL2838UHIDIR",
      serialNumber: "00000001",
      opened: false,
      configuration: null,
      claimed: false,
      mock: { state, opts: o, sampleRate, ifFreq, loFreq, tunedFreq,
        gpo: () => blockGet(2, 0x3001), gpoe: () => blockGet(2, 0x3003), gpd: () => blockGet(2, 0x3004),
        writes: (pred) => state.log.filter((e) => e.dir === "out" && (!pred || pred(e))) },

      async open() { this.opened = true; },
      async close() { this.opened = false; this.claimed = false; },
      async selectConfiguration(v) { if (!this.opened) throw new Error("mock: not open"); this.configuration = { configurationValue: v }; },
      async claimInterface(n) { if (!this.opened || !this.configuration) throw new Error("mock: cannot claim"); if (n !== 0) throw new Error("mock: no interface " + n); this.claimed = true; },
      async releaseInterface() { this.claimed = false; },
      async reset() { state.log.push({ dir: "reset" }); },
      async clearHalt() {},

      async controlTransferOut(setup, data) {
        if (!this.claimed) throw new Error("mock: interface not claimed");
        if (setup.requestType !== "vendor" || setup.recipient !== "device" || setup.request !== 0) throw new Error("mock: unexpected setup " + JSON.stringify(setup));
        const d = data ? new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength) : data) : new Uint8Array(0);
        const { value, index } = setup;
        state.log.push({ dir: "out", value, index, data: Array.from(d) });
        if ((index & 0x10) === 0) throw new Error("mock: write without the 0x10 write flag");
        const block = index >> 8;
        if (o.failTestWrite && state.log.length === 1) return { status: "stall", bytesWritten: 0 };
        if (block === 0) { // demod: value = (addr << 8) | 0x20, index = 0x10 | page
          const page = index & 0x0f, addr = value >> 8;
          state.demod[page + ":" + addr] = d.length === 2 ? (d[0] << 8) | d[1] : d[0];
        } else if (block === 6) {
          if (!i2cWrite(value, d)) return { status: "stall", bytesWritten: 0 };
        } else {
          state.blocks[block + ":" + value] = d.length === 2 ? (d[0] << 8) | d[1] : d[0];
        }
        return { status: "ok", bytesWritten: d.length };
      },

      async controlTransferIn(setup, length) {
        if (!this.claimed) throw new Error("mock: interface not claimed");
        if (setup.requestType !== "vendor" || setup.recipient !== "device" || setup.request !== 0) throw new Error("mock: unexpected setup " + JSON.stringify(setup));
        const { value, index } = setup;
        state.log.push({ dir: "in", value, index, length });
        const block = index >> 8;
        const out = new Uint8Array(length);
        if (block === 0) {
          const page = index & 0x0f, addr = value >> 8;
          out[0] = demodGet(page, addr) & 0xff;
        } else if (block === 6) {
          const d = i2cRead(value, length);
          if (!d) return { status: "stall" };
          out.set(d);
        } else {
          const v = blockGet(block, value); // little endian read
          out[0] = v & 0xff;
          if (length > 1) out[1] = (v >> 8) & 0xff;
        }
        return ok(out);
      },

      // 8-bit offset-binary IQ: carrier at carrierOffsetHz from the tuned centre + gaussian noise
      async transferIn(endpoint, length) {
        if (!this.claimed) throw new Error("mock: interface not claimed");
        if (endpoint !== 1) throw new Error("mock: no IN endpoint " + endpoint);
        state.bulkCalls++;
        const fs = sampleRate() || 2.4e6;
        // in a browser, deliver at the real sample rate like a stick does (Node tests run unpaced)
        if (typeof window !== "undefined") await new Promise((r) => setTimeout(r, (length / 2 / fs) * 1000));
        const w = (2 * Math.PI * o.carrierOffsetHz) / fs;
        const out = new Uint8Array(length);
        const clip = (x) => (x < 0 ? 0 : x > 255 ? 255 : Math.round(x));
        for (let i = 0; i + 1 < length; i += 2) {
          out[i] = clip(127.5 + o.carrierAmp * Math.cos(state.phase) + o.noise * gauss());
          out[i + 1] = clip(127.5 + o.carrierAmp * Math.sin(state.phase) + o.noise * gauss());
          state.phase += w;
        }
        state.phase %= 2 * Math.PI;
        return ok(out);
      },
    };
    return dev;
  }

  function installMockUsb(opts) {
    const g = typeof window !== "undefined" ? window : globalThis;
    const devices = [createMockRtl(opts)];
    g.__mockRtlDevices = devices;
    const usb = {
      async requestDevice(req) {
        const f = (req && req.filters) || [];
        const d = devices.find((x) => !f.length || f.some((y) => (!y.vendorId || y.vendorId === x.vendorId) && (!y.productId || y.productId === x.productId)));
        if (!d) { const e = new Error("No device selected."); e.name = "NotFoundError"; throw e; }
        return d;
      },
      async getDevices() { return devices.slice(); },
      addEventListener() {}, removeEventListener() {}, onconnect: null, ondisconnect: null,
    };
    const nav = g.navigator;
    if (nav) {
      try { Object.defineProperty(nav, "usb", { value: usb, configurable: true }); } catch (e) { /* frozen navigator */ }
    }
    return usb;
  }

  const api = { createMockRtl, installMockUsb };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") {
    window.__mockRtl = createMockRtl;
    window.__installMockUsb = installMockUsb;
    if (window.__mockRtlOptions) installMockUsb(window.__mockRtlOptions);
  }
})();
