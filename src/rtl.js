// RTL-SDR (RTL2832U + R820T/R828D, incl. RTL-SDR Blog V4) driver for WebUSB.
//
// This file is a JavaScript translation of rtl-sdr-rs (https://github.com/ccostes/rtl-sdr-rs,
// MPL-2.0) with SatHunterSDR's patches; it remains under the MPL-2.0.
// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// (rtl-sdr-rs is itself a port of librtlsdr / rtl-sdr-blog, GPL-2.0+, by Steve Markgraf et al.)
//
// ES2020, no modules, no dependencies: inlined into a classic <script>. Exposes `RtlSdrUsb`.

/* eslint-disable no-bitwise */
const RtlSdrUsb = (() => {
  "use strict";

  // ------------------------------------------------------------------ USB / RTL2832U constants
  const BLOCK_DEMOD = 0, BLOCK_USB = 1, BLOCK_SYS = 2, BLOCK_IIC = 6;
  const DEMOD_CTL = 0x3000, GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004, DEMOD_CTL_1 = 0x300b;
  const USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
  const EEPROM_ADDR = 0xa0, EEPROM_SIZE = 256;
  const INTERFACE_ID = 0, BULK_ENDPOINT = 1; // WebUSB endpoint number of 0x81

  const DEF_RTL_XTAL_FREQ = 28800000;
  const DEFAULT_FIR = [
    -54, -36, -41, -40, -32, -14, 14, 53, // i8
    101, 156, 215, 273, 327, 372, 404, 421, // i12
  ];

  // rtl-sdr-rs cargo feature "rtl_sdr_blog" (max VCO current, 2.0 V PLL drop-out, bias tee via
  // offset tuning). SatHunterSDR builds the crate without it, so it is off here too.
  const RTL_SDR_BLOG_MODS = false;

  // ------------------------------------------------------------------ R82xx constants
  const R820T_I2C_ADDR = 0x34, R828D_I2C_ADDR = 0x74;
  const R82XX_CHECK_ADDR = 0x00, R82XX_CHECK_VAL = 0x69;
  const R828D_XTAL_FREQ = 16000000;
  const VER_NUM = 49;
  const R82XX_IF_FREQ = 3570000;
  const NUM_REGS = 32, RW_REG_START = 5, NUM_CACHE_REGS = NUM_REGS - RW_REG_START;
  // librtlsdr: max_i2c_msg_len = 8 bytes per I2C message incl. the register byte
  // (rtl-sdr-rs sends up to 8 data bytes + register; the C limit is the safe one).
  const MAX_I2C_MSG_LEN = 8;
  const R828D_INPUT_SWITCH_FREQ = 345000000;
  const BLOG_V4_UPCONVERT_FREQ = 28800000;
  const BLOG_V4_NOTCH_OFF_BAND1_MAX = 2200000;
  const BLOG_V4_NOTCH_OFF_BAND2_MIN = 85000000, BLOG_V4_NOTCH_OFF_BAND2_MAX = 112000000;
  const BLOG_V4_NOTCH_OFF_BAND3_MIN = 172000000, BLOG_V4_NOTCH_OFF_BAND3_MAX = 242000000;
  const BLOG_V4_HF_MAX = 28800000;
  const BLOG_V4_VHF_MIN = 28800001, BLOG_V4_VHF_MAX = 250000000;

  const REG_INIT = [
    0x83, 0x32, 0x75, /* 05 to 07 */
    0xc0, 0x40, 0xd6, 0x6c, /* 08 to 0b */
    0xf5, 0x63, 0x75, 0x68, /* 0c to 0f */
    0x6c, 0x83, 0x80, 0x00, /* 10 to 13 */
    0x0f, 0x00, 0xc0, 0x30, /* 14 to 17 */
    0x48, 0xcc, 0x60, 0x00, /* 18 to 1b */
    0x54, 0xae, 0x4a, 0xc0, /* 1c to 1f */
  ];

  // tenths of a dB (measured with a Racal 6103E at 928 MHz, -60 dBm, see steve-m.de)
  const VGA_BASE_GAIN = -47;
  const GAINS = [
    0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372,
    386, 402, 421, 434, 439, 445, 480, 496,
  ];
  const R82XX_VGA_GAIN_STEPS = [0, 26, 26, 30, 42, 35, 24, 13, 14, 32, 36, 34, 35, 37, 35, 36];
  const R82XX_LNA_GAIN_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
  const R82XX_MIXER_GAIN_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];

  // [start MHz, open_d, rf_mux_ploy, tf_c, xtal_cap20p, xtal_cap10p, xtal_cap0p]
  const FREQ_RANGES = [
    [0, 0x08, 0x02, 0xdf, 0x02, 0x01, 0x00],
    [50, 0x08, 0x02, 0xbe, 0x02, 0x01, 0x00],
    [55, 0x08, 0x02, 0x8b, 0x02, 0x01, 0x00],
    [60, 0x08, 0x02, 0x7b, 0x02, 0x01, 0x00],
    [65, 0x08, 0x02, 0x69, 0x02, 0x01, 0x00],
    [70, 0x08, 0x02, 0x58, 0x02, 0x01, 0x00],
    [75, 0x00, 0x02, 0x44, 0x02, 0x01, 0x00],
    [80, 0x00, 0x02, 0x44, 0x02, 0x01, 0x00],
    [90, 0x00, 0x02, 0x34, 0x01, 0x01, 0x00],
    [100, 0x00, 0x02, 0x34, 0x01, 0x01, 0x00],
    [110, 0x00, 0x02, 0x24, 0x01, 0x01, 0x00],
    [120, 0x00, 0x02, 0x24, 0x01, 0x01, 0x00],
    [140, 0x00, 0x02, 0x14, 0x01, 0x01, 0x00],
    [180, 0x00, 0x02, 0x13, 0x00, 0x00, 0x00],
    [220, 0x00, 0x02, 0x13, 0x00, 0x00, 0x00],
    [250, 0x00, 0x02, 0x11, 0x00, 0x00, 0x00],
    [280, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00],
    [310, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00],
    [450, 0x00, 0x41, 0x00, 0x00, 0x00, 0x00],
    [588, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00],
    [650, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00],
  ];

  const XTAL_LOW_CAP_30P = 0, XTAL_LOW_CAP_20P = 1, XTAL_LOW_CAP_10P = 2, XTAL_LOW_CAP_0P = 3, XTAL_HIGH_CAP_0P = 4;
  const INPUT_CABLE1 = "cable1", INPUT_CABLE2 = "cable2", INPUT_AIR = "air";

  const KNOWN_TUNERS = [
    { id: "R820T", name: "Rafael Micro R820T", i2cAddr: R820T_I2C_ADDR },
    { id: "R828D", name: "Rafael Micro R828D", i2cAddr: R828D_I2C_ADDR },
  ];

  const hex = (v, w = 2) => "0x" + (v >>> 0).toString(16).padStart(w, "0");
  const sum = (a, n) => { let s = 0; for (let i = 0; i <= n; i++) s += a[i]; return s; };
  const BITREV4 = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
  const bitReverse = (b) => (BITREV4[b & 0xf] << 4) | BITREV4[b >> 4];
  const f32 = Math.fround;

  // ------------------------------------------------------------------ low-level USB I/O
  // rtl-sdr control transfers: bmRequestType 0xC0 (vendor, device, IN) / 0x40 (OUT), bRequest 0.
  class RtlUsbIo {
    constructor(dev) { this.dev = dev; }

    async readControl(value, index, length) {
      let r;
      try {
        r = await this.dev.controlTransferIn({ requestType: "vendor", recipient: "device", request: 0, value, index }, length);
      } catch (e) {
        throw new Error(`RTL-SDR control read failed (value ${hex(value, 4)}, index ${hex(index, 4)}): ${e.message || e}`);
      }
      if (r.status !== "ok") throw new Error(`RTL-SDR control read ${r.status} (value ${hex(value, 4)}, index ${hex(index, 4)})`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }

    async writeControl(value, index, data) {
      let r;
      try {
        r = await this.dev.controlTransferOut({ requestType: "vendor", recipient: "device", request: 0, value, index }, data);
      } catch (e) {
        throw new Error(`RTL-SDR control write failed (value ${hex(value, 4)}, index ${hex(index, 4)}): ${e.message || e}`);
      }
      if (r.status !== "ok") throw new Error(`RTL-SDR control write ${r.status} (value ${hex(value, 4)}, index ${hex(index, 4)})`);
      return r.bytesWritten;
    }

    // registers are read little endian but written big endian (as librtlsdr does)
    async readReg(block, addr, len) {
      const d = await this.readControl(addr, block << 8, len);
      return len === 2 ? d[0] | (d[1] << 8) : d[0];
    }

    writeReg(block, addr, val, len) {
      const data = len === 1 ? Uint8Array.of(val & 0xff) : Uint8Array.of((val >> 8) & 0xff, val & 0xff);
      return this.writeControl(addr, (block << 8) | 0x10, data);
    }

    async demodReadReg(page, addr) {
      const d = await this.readControl((addr << 8) | 0x20, page, 1);
      return d[0];
    }

    async demodWriteReg(page, addr, val, len) {
      const data = len === 1 ? Uint8Array.of(val & 0xff) : Uint8Array.of((val >> 8) & 0xff, val & 0xff);
      const n = await this.writeControl((addr << 8) | 0x20, 0x10 | page, data);
      await this.demodReadReg(0x0a, 0x01);
      return n;
    }

    readArray(block, addr, len) { return this.readControl(addr, block << 8, len); }
    writeArray(block, addr, arr) { return this.writeControl(addr, (block << 8) | 0x10, Uint8Array.from(arr)); }

    async i2cReadReg(i2cAddr, reg) {
      await this.writeArray(BLOCK_IIC, i2cAddr, [reg]);
      const d = await this.readArray(BLOCK_IIC, i2cAddr, 1);
      return d[0];
    }
    i2cWrite(i2cAddr, buf) { return this.writeArray(BLOCK_IIC, i2cAddr, buf); }
    i2cRead(i2cAddr, len) { return this.readArray(BLOCK_IIC, i2cAddr, len); }

    async readEeprom(offset, len) {
      if (offset + len > EEPROM_SIZE) throw new Error("EEPROM read out of range");
      await this.writeArray(BLOCK_IIC, EEPROM_ADDR, [offset]);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = (await this.readArray(BLOCK_IIC, EEPROM_ADDR, 1))[0];
      return out;
    }
  }

  // ------------------------------------------------------------------ R820T / R828D tuner
  class R82xx {
    // setGpio(pin, on): RTL2832 GPIO access, used for the Blog V4 upconverter switch
    constructor(io, info, isBlogV4, setGpio, log) {
      this.io = io;
      this.info = info;
      this.chip = info.id;
      this.i2cAddr = info.i2cAddr;
      this.isBlogV4 = isBlogV4 && this.chip === "R828D";
      this.setGpio = setGpio;
      this.log = log;
      this.regs = REG_INIT.slice();
      this.intFreq = 0;
      this.xtalCapSel = XTAL_LOW_CAP_30P;
      this.xtal = 0;
      this.usePredetect = false;
      this.hasLock = false;
      this.filCalCode = 0;
      this.initDone = false;
      this.lastInputSel = null;
      this.lastLo = 0; // LO actually programmed by the last set_pll (Hz)
    }

    // ---- register access (r82xx_write / r82xx_read), with the RW register cache
    readCacheReg(reg) {
      const i = reg - RW_REG_START;
      if (i < 0 || i >= NUM_CACHE_REGS) throw new Error(`R82xx: register ${hex(reg)} not cached`);
      return this.regs[i];
    }

    async writeRegs(reg, vals) {
      const i0 = reg - RW_REG_START;
      if (i0 < 0 || i0 + vals.length > NUM_CACHE_REGS) throw new Error(`R82xx: bad register write at ${hex(reg)}`);
      for (let k = 0; k < vals.length; k++) this.regs[i0 + k] = vals[k] & 0xff;
      for (let pos = 0; pos < vals.length;) {
        const size = Math.min(vals.length - pos, MAX_I2C_MSG_LEN - 1);
        const buf = new Uint8Array(size + 1);
        buf[0] = reg + pos;
        for (let k = 0; k < size; k++) buf[1 + k] = vals[pos + k] & 0xff;
        await this.io.i2cWrite(this.i2cAddr, buf);
        pos += size;
      }
    }

    writeRegMask(reg, val, mask) {
      const rc = this.readCacheReg(reg);
      return this.writeRegs(reg, [(rc & ~mask & 0xff) | (val & mask)]);
    }

    async readReg(reg, len) {
      await this.io.i2cWrite(this.i2cAddr, [reg]);
      const d = await this.io.i2cRead(this.i2cAddr, len);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = bitReverse(d[i] || 0);
      return out;
    }

    // ---- Tuner trait
    async init() {
      this.usePredetect = false;
      this.lastInputSel = null;
      this.xtalCapSel = XTAL_HIGH_CAP_0P;
      await this.writeRegs(0x05, REG_INIT);
      await this.setTvStandard();
      await this.sysfreqSel(0);
      this.initDone = true;
    }

    getGains() { return GAINS.slice(); }

    async readGain() {
      const data = await this.readReg(0x00, 4);
      const lnaIdx = data[3] & 0x0f, mixIdx = (data[3] & 0xf0) >> 4;
      const vgaIdx = this.readCacheReg(0x0c) & 0x0f;
      return sum(R82XX_LNA_GAIN_STEPS, lnaIdx) + sum(R82XX_MIXER_GAIN_STEPS, mixIdx)
        + VGA_BASE_GAIN + sum(R82XX_VGA_GAIN_STEPS, vgaIdx);
    }

    // gain: null = auto, else tenths of a dB
    async setGain(gain) {
      if (gain === null) {
        await this.writeRegMask(0x05, 0, 0x10); // LNA auto
        await this.writeRegMask(0x07, 0x10, 0x10); // mixer auto
        await this.writeRegMask(0x0c, 0x0b, 0x9f); // fixed VGA 26.5 dB
        return;
      }
      await this.writeRegMask(0x05, 0x10, 0x10); // LNA auto off
      await this.writeRegMask(0x07, 0, 0x10); // mixer auto off
      await this.readReg(0x00, 4);
      await this.writeRegMask(0x0c, 0x08, 0x9f); // fixed VGA 16.3 dB
      let total = 0, mixIndex = 0, lnaIndex = 0;
      for (let i = 0; i < 15; i++) {
        if (total >= gain) break;
        lnaIndex++;
        total += R82XX_LNA_GAIN_STEPS[lnaIndex];
        if (total >= gain) break;
        mixIndex++;
        total += R82XX_MIXER_GAIN_STEPS[mixIndex];
      }
      await this.writeRegMask(0x05, lnaIndex, 0x0f);
      await this.writeRegMask(0x07, mixIndex, 0x0f);
    }

    // returns the RF frequency the PLL actually landed on (Hz)
    async setFreq(freq) {
      const upconverted = this.isBlogV4 && freq < BLOG_V4_UPCONVERT_FREQ ? freq + BLOG_V4_UPCONVERT_FREQ : freq;
      const loFreq = upconverted + this.intFreq;
      await this.setMux(loFreq);
      await this.setPll(loFreq);

      if (this.chip === "R828D") {
        if (this.isBlogV4) {
          // notches OFF when tuned inside a notch band, ON outside
          const inNotch = freq <= BLOG_V4_NOTCH_OFF_BAND1_MAX
            || (freq >= BLOG_V4_NOTCH_OFF_BAND2_MIN && freq <= BLOG_V4_NOTCH_OFF_BAND2_MAX)
            || (freq >= BLOG_V4_NOTCH_OFF_BAND3_MIN && freq <= BLOG_V4_NOTCH_OFF_BAND3_MAX);
          await this.writeRegMask(0x17, inNotch ? 0x00 : 0x08, 0x08);

          const input = freq <= BLOG_V4_HF_MAX ? INPUT_CABLE2
            : freq >= BLOG_V4_VHF_MIN && freq <= BLOG_V4_VHF_MAX ? INPUT_CABLE1 : INPUT_AIR;
          if (this.lastInputSel !== input) {
            const [cable2In, cable1In, airIn] = input === INPUT_CABLE2 ? [0x08, 0x00, 0x20]
              : input === INPUT_CABLE1 ? [0x00, 0x40, 0x20] : [0x00, 0x00, 0x00];
            await this.writeRegMask(0x06, cable2In, 0x08); // cable 2 (HF input)
            // upconverter / HF path switch on newer V4 batches (librtlsdr-blog; a TODO in rtl-sdr-rs)
            await this.setGpio(5, !cable2In);
            await this.writeRegMask(0x05, cable1In, 0x40); // cable 1 (VHF input)
            await this.writeRegMask(0x05, airIn, 0x20); // air in (UHF input)
            this.lastInputSel = input;
            this.log(`R828D (Blog V4) input: ${input === INPUT_CABLE2 ? "HF (cable 2, upconverter)" : input === INPUT_CABLE1 ? "VHF (cable 1)" : "UHF (air in)"}`);
          }
        } else {
          const input = freq <= R828D_INPUT_SWITCH_FREQ ? INPUT_CABLE1 : INPUT_AIR;
          if (this.lastInputSel !== input) {
            await this.writeRegMask(0x05, input === INPUT_CABLE1 ? 0x60 : 0x00, 0x60);
            this.lastInputSel = input;
          }
        }
      }
      return this.lastLo - this.intFreq - (upconverted - freq);
    }

    async setBandwidth(bwIn) {
      let bw = bwIn;
      const FILT_HP_BW1 = 350000, FILT_HP_BW2 = 380000;
      const LPF = [1700000, 1600000, 1550000, 1450000, 1200000, 900000, 700000, 550000, 450000, 350000];
      let reg0a, reg0b;
      if (bw > 7000000) { this.intFreq = 4570000; reg0a = 0x10; reg0b = 0x0b; }
      else if (bw > 6000000) { this.intFreq = 4570000; reg0a = 0x10; reg0b = 0x2a; }
      else if (bw > LPF[0] + FILT_HP_BW1 + FILT_HP_BW2) { this.intFreq = 3570000; reg0a = 0x10; reg0b = 0x6b; }
      else {
        this.intFreq = 2300000;
        reg0a = 0x00; reg0b = 0x80;
        let realBw = 0;
        if (bw > LPF[0] + FILT_HP_BW1) { bw -= FILT_HP_BW2; this.intFreq += FILT_HP_BW2; realBw += FILT_HP_BW2; }
        else reg0b |= 0x20;
        if (bw > LPF[0]) { bw -= FILT_HP_BW1; this.intFreq += FILT_HP_BW1; realBw += FILT_HP_BW1; }
        else reg0b |= 0x40;
        let lpIdx = 0;
        for (let i = 0; i < LPF.length; i++) { if (bw > LPF[i]) break; lpIdx = i; }
        reg0b |= 15 - lpIdx;
        realBw += LPF[lpIdx];
        this.intFreq -= Math.trunc(realBw / 2);
      }
      await this.writeRegMask(0x0a, reg0a, 0x10);
      await this.writeRegMask(0x0b, reg0b, 0xef);
    }

    getIfFreq() { return this.intFreq; }
    getXtalFreq() { return this.xtal; }
    setXtalFreq(f) { this.xtal = f; }

    async exit() {
      if (!this.initDone) return;
      await this.writeRegs(0x06, [0xb1]);
      await this.writeRegs(0x05, [0xa0]);
      await this.writeRegs(0x07, [0x3a]);
      await this.writeRegs(0x08, [0x40]);
      await this.writeRegs(0x09, [0xc0]);
      await this.writeRegs(0x0a, [0x36]);
      await this.writeRegs(0x0c, [0x35]);
      await this.writeRegs(0x0f, [0x68]);
      await this.writeRegs(0x11, [0x03]);
      await this.writeRegs(0x17, [0xf4]);
      await this.writeRegs(0x19, [0x0c]);
    }

    // ---- tuning internals
    async setMux(freq) {
      const freqMhz = Math.floor(freq / 1e6);
      let r = FREQ_RANGES[0];
      for (const range of FREQ_RANGES) { if (freqMhz < range[0]) break; r = range; }
      const [, openD, rfMuxPloy, tfC, cap20p, cap10p, cap0p] = r;
      await this.writeRegMask(0x17, openD, 0x08); // open drain
      await this.writeRegMask(0x1a, rfMuxPloy, 0xc3); // RF_MUX, polymux
      await this.writeRegs(0x1b, [tfC]); // TF band
      let val;
      switch (this.xtalCapSel) {
        case XTAL_LOW_CAP_30P: case XTAL_LOW_CAP_20P: val = cap20p | 0x08; break;
        case XTAL_LOW_CAP_10P: val = cap10p | 0x08; break;
        case XTAL_HIGH_CAP_0P: val = cap0p; break;
        default: val = cap0p | 0x08; // XTAL_LOW_CAP_0P
      }
      await this.writeRegMask(0x10, val, 0x0b); // xtal cap & drive
      await this.writeRegMask(0x08, 0x00, 0x3f);
      await this.writeRegMask(0x09, 0x00, 0x3f);
    }

    async setVcoCurrent() {
      if (RTL_SDR_BLOG_MODS) await this.writeRegMask(0x12, 0x06, 0xff);
      else await this.writeRegMask(0x12, 0x80, 0xe0);
    }

    async setPll(freq) {
      // integer arithmetic mirrors the u8/u32 semantics of the Rust/C code
      const freqKhz = Math.floor((freq + 500) / 1000);
      const pllRef = this.xtal;
      const pllRefKhz = Math.floor((this.xtal + 500) / 1000);

      await this.writeRegMask(0x10, 0, 0x10); // refdiv2 = 0
      await this.writeRegMask(0x1a, 0x00, 0x0c); // PLL auto-tune = 128 kHz
      await this.setVcoCurrent();

      const vcoMin = 1770000, vcoMax = vcoMin * 2;
      let mixDiv = 2, divNum = 0;
      while (mixDiv <= 64) {
        if (freqKhz * mixDiv >= vcoMin && freqKhz * mixDiv < vcoMax) {
          let divBuf = mixDiv;
          while (divBuf > 2) { divBuf >>= 1; divNum++; }
          break;
        }
        mixDiv <<= 1;
      }

      let data = await this.readReg(0x00, 5);
      const vcoPowerRef = this.chip === "R828D" ? 1 : 2;
      const vcoFineTune = (data[4] & 0x30) >> 4;
      if (vcoFineTune > vcoPowerRef) divNum = (divNum - 1) & 0xff;
      else if (vcoFineTune < vcoPowerRef) divNum = (divNum + 1) & 0xff;
      await this.writeRegMask(0x10, (divNum << 5) & 0xff, 0xe0);

      const vcoFreq = freq * mixDiv;
      const nint = Math.floor(vcoFreq / (2 * pllRef)) & 0xff;
      let vcoFra = Math.floor((vcoFreq - 2 * pllRef * nint) / 1000);
      if (nint > Math.floor(128 / vcoPowerRef) - 1) throw new Error(`R82xx: no valid PLL values for ${freq} Hz`);

      // Nint = 4 * Ni2c + Si2c + 13 (with the original's u8 wrap-around)
      const ni = Math.trunc((nint - 13) / 4) & 0xff;
      const si = (nint - 4 * ni - 13) & 0xff;
      await this.writeRegs(0x14, [(ni + ((si << 6) & 0xff)) & 0xff]);

      await this.writeRegMask(0x12, vcoFra === 0 ? 0x08 : 0x00, 0x08); // pw_sdm

      // SDM calculator
      let sdm = 0, nSdm = 2;
      while (vcoFra > 1) {
        const step = Math.floor((2 * pllRefKhz) / nSdm);
        if (vcoFra > step) {
          sdm += Math.floor(32768 / (nSdm / 2));
          vcoFra -= step;
          if (nSdm >= 0x8000) break;
        }
        nSdm *= 2;
      }
      await this.writeRegs(0x16, [(sdm >> 8) & 0xff]);
      await this.writeRegs(0x15, [sdm & 0xff]);
      this.lastLo = Math.round((2 * pllRef * (nint + sdm / 65536)) / mixDiv);

      for (let i = 0; i < 2; i++) {
        data = await this.readReg(0x00, 3);
        if (data[2] & 0x40) break;
        if (i === 0) await this.setVcoCurrent(); // didn't lock, increase VCO current
      }
      if ((data[2] & 0x40) === 0) {
        this.log(`R82xx: PLL not locked at ${freq} Hz`);
        this.hasLock = false;
        return;
      }
      this.hasLock = true;
      await this.writeRegMask(0x1a, 0x08, 0x08); // PLL auto-tune = 8 kHz
    }

    // sysfreq_sel for TUNER_DIGITAL_TV / SYS_DVBT
    async sysfreqSel(freq) {
      let mixerTop, lnaTop, cpCur;
      if (freq === 506000000 || freq === 666000000 || freq === 818000000) {
        mixerTop = 0x14; lnaTop = 0xe5; cpCur = 0x28;
      } else {
        mixerTop = 0x24; lnaTop = 0xe5; cpCur = 0x38;
      }
      const lnaVthL = 0x53, mixerVthL = 0x75, airCable1In = 0x00, cable2In = 0x00;
      const preDect = 0x40, lnaDischarge = 14, filterCur = 0x40;

      if (this.usePredetect) await this.writeRegMask(0x06, preDect, 0x40);
      await this.writeRegMask(0x1d, lnaTop, 0xc7);
      await this.writeRegMask(0x1c, mixerTop, 0xf8);
      await this.writeRegs(0x0d, [lnaVthL]);
      await this.writeRegs(0x0e, [mixerVthL]);
      await this.writeRegMask(0x05, airCable1In, 0x60);
      await this.writeRegMask(0x06, cable2In, 0x08);
      await this.writeRegMask(0x11, cpCur, 0x38);
      const divBufCur = RTL_SDR_BLOG_MODS ? 0xa0
        : (freq === 506000000 || freq === 666000000 || freq === 818000000) ? 0x20 : 0x30;
      await this.writeRegMask(0x17, divBufCur, 0x30);
      await this.writeRegMask(0x0a, filterCur, 0x60);

      // LNA (not analog TV)
      await this.writeRegMask(0x1d, 0, 0x38); // LNA TOP: lowest
      await this.writeRegMask(0x1c, 0, 0x04); // normal mode
      await this.writeRegMask(0x06, 0, 0x40); // PRE_DECT off
      await this.writeRegMask(0x1a, 0x30, 0x30); // AGC clk 250 Hz
      await this.writeRegMask(0x1d, 0x18, 0x38); // LNA TOP = 3
      await this.writeRegMask(0x1c, mixerTop, 0x04); // discharge mode (mask as in the original)
      await this.writeRegMask(0x1e, lnaDischarge, 0x1f); // LNA discharge current
      await this.writeRegMask(0x1a, 0x20, 0x30); // AGC clk 60 Hz
      await this.writeRegMask(0x10, lnaDischarge, 0x04);
    }

    async setTvStandard() {
      const ifKhz = 3570, filtCalLo = 56000, filtGain = 0x10, imgR = 0x00, filtQ = 0x10;
      const hpCor = 0x6b, extEnable = 0x60, loopThrough = 0x01, ltAtt = 0x00, fltExtWidest = 0x00, polyfilCur = 0x60;

      this.regs = REG_INIT.slice();
      await this.writeRegMask(0x0c, 0x00, 0x0f); // init flag & xtal check result
      await this.writeRegMask(0x13, VER_NUM, 0x3f); // version
      await this.writeRegMask(0x1d, 0x00, 0x38); // for LT gain test (not analog TV)
      this.intFreq = ifKhz * 1000;

      for (let i = 0; i < 2; i++) { // filter calibration
        await this.writeRegMask(0x0b, hpCor, 0x60); // filt_cap
        await this.writeRegMask(0x0f, 0x04, 0x04); // cali clk on
        await this.writeRegMask(0x10, 0x00, 0x03); // xtal cap 0 pF for PLL
        await this.setPll(filtCalLo * 1000);
        await this.writeRegMask(0x0b, 0x10, 0x10); // start trigger
        await this.writeRegMask(0x0b, 0x00, 0x04); // stop trigger
        const data = await this.readReg(0x00, 5);
        this.filCalCode = data[4] & 0x0f;
        if (this.filCalCode !== 0x0f) break;
        this.filCalCode = 0; // narrowest
      }
      await this.writeRegMask(0x0a, filtQ | this.filCalCode, 0x1f);
      await this.writeRegMask(0x0b, hpCor, 0xef); // BW, filter gain, HP corner
      await this.writeRegMask(0x07, imgR, 0x80); // img_r
      await this.writeRegMask(0x06, filtGain, 0x30); // filt_3dB, V6MHz
      await this.writeRegMask(0x1e, extEnable, 0x60); // channel filter extension
      await this.writeRegMask(0x05, loopThrough, 0x80); // loop through
      await this.writeRegMask(0x1f, ltAtt, 0x80); // loop through attenuation
      await this.writeRegMask(0x0f, fltExtWidest, 0x80); // filter extension widest
      await this.writeRegMask(0x19, polyfilCur, 0x60); // RF poly filter current
    }
  }

  // ------------------------------------------------------------------ RTL2832U device
  class RtlSdrUsb {
    static get filters() {
      return [{ vendorId: 0x0bda, productId: 0x2838 }, { vendorId: 0x0bda, productId: 0x2832 }];
    }

    // opts.blogV4: true forces the RTL-SDR Blog V4 setup (SatHunterSDR's set_blog_v4_hint)
    constructor(usbDevice, log, opts) {
      if (!usbDevice) throw new Error("RtlSdrUsb: no USB device");
      this.dev = usbDevice;
      this.log = typeof log === "function" ? log : () => {};
      this.opts = opts || {};
      this.io = new RtlUsbIo(usbDevice);
      this.tuner = null; // "R820T" / "R828D"
      this.tunerName = "";
      this.blogV4 = false;
      this.gains = [];
      this.freq = 0;
      this.rate = 0;
      this.exactRate = 0;
      this.bw = 0;
      this.corr = 0;
      this.xtal = DEF_RTL_XTAL_FREQ;
      this.tunerXtal = DEF_RTL_XTAL_FREQ;
      this.forceBt = false;
      this.forceDs = false;
      this.gain = null;
      this._t = null; // R82xx instance
      this._queue = Promise.resolve();
      this._closed = false;
    }

    // serialize control sequences (the I2C repeater must not interleave)
    _locked(fn) {
      const p = this._queue.then(fn, fn);
      this._queue = p.catch(() => {});
      return p;
    }

    _need() {
      if (!this._t) throw new Error("RTL-SDR is not open");
    }

    async open() {
      const d = this.dev;
      if (!d.opened) await d.open();
      if (!d.configuration || d.configuration.configurationValue !== 1) await d.selectConfiguration(1);
      await d.claimInterface(INTERFACE_ID);
      return this._locked(() => this._init());
    }

    async _init() {
      const io = this.io;
      // dummy write; reset the device if it fails
      let ok = false;
      try { ok = (await io.writeReg(BLOCK_USB, USB_SYSCTL, 0x09, 1)) > 0; } catch (e) { ok = false; }
      if (!ok) {
        this.log("RTL-SDR: test write failed, resetting device");
        await this.dev.reset();
      }
      await this._initBaseband();
      await this._setI2cRepeater(true);

      const manufacturer = this.dev.manufacturerName || "", product = this.dev.productName || "";
      this.log(`USB strings: "${manufacturer}" / "${product}" / "${this.dev.serialNumber || ""}"`);
      this.blogV4 = !!this.opts.blogV4 || (manufacturer === "RTLSDRBlog" && product === "Blog V4");

      const info = await this._searchTuner();
      if (!info) {
        await this._setI2cRepeater(false);
        throw new Error("RTL-SDR: no supported tuner found (R820T/R828D)");
      }
      this.log(`Found ${info.name} tuner`);
      if (info.id !== "R828D" && this.blogV4) this.log("RTL-SDR Blog V4 strings but no R828D: V4 handling off");
      this.blogV4 = this.blogV4 && info.id === "R828D";
      this.log(`RTL-SDR Blog V4: ${this.blogV4}`);

      this._t = new R82xx(io, info, this.blogV4, (pin, on) => this._setGpio(pin, on), this.log);
      this.tuner = info.id;
      this.tunerName = info.name;
      // a plain R828D runs on a 16 MHz crystal; the Blog V4 keeps the RTL's 28.8 MHz
      this.tunerXtal = info.id === "R828D" && !this.blogV4 ? R828D_XTAL_FREQ : this.xtal;
      this._t.setXtalFreq(this._tunerXtalFreq());

      await io.demodWriteReg(1, 0xb1, 0x1a, 1); // disable Zero-IF mode
      await io.demodWriteReg(0, 0x08, 0x4d, 1); // only enable In-phase ADC input
      await this._setIfFreq(R82XX_IF_FREQ); // 3.57 MHz IF (DVB-T 6 MHz mode)
      await io.demodWriteReg(1, 0x15, 0x01, 1); // enable spectrum inversion

      const ee = await io.readEeprom(0, EEPROM_SIZE);
      this.forceBt = (ee[7] & 0x02) === 0; // IR endpoint bit cleared: bias tee always on
      this.forceDs = (ee[7] & 0x01) !== 0;
      if (this.forceBt) this.log("EEPROM: bias tee forced on");

      await this._t.init();
      await this._setI2cRepeater(false);
      this.gains = this._t.getGains().map((g) => g / 10);
      this.log(`RTL-SDR init complete (${this.tuner}${this.blogV4 ? ", Blog V4" : ""})`);
    }

    async _initBaseband() {
      const io = this.io;
      // USB
      await io.writeReg(BLOCK_USB, USB_SYSCTL, 0x09, 1);
      await io.writeReg(BLOCK_USB, USB_EPA_MAXPKT, 0x0002, 2);
      await io.writeReg(BLOCK_USB, USB_EPA_CTL, 0x1002, 2);
      // power-on demod
      await io.writeReg(BLOCK_SYS, DEMOD_CTL_1, 0x22, 1);
      await io.writeReg(BLOCK_SYS, DEMOD_CTL, 0xe8, 1);
      // reset demod (bit 3, soft_rst)
      await io.demodWriteReg(1, 0x01, 0x14, 1);
      await io.demodWriteReg(1, 0x01, 0x10, 1);
      // disable spectrum inversion and adjacent channel rejection
      await io.demodWriteReg(1, 0x15, 0x00, 1);
      await io.demodWriteReg(1, 0x16, 0x0000, 2);
      // clear DDC shift and IF registers
      for (let i = 0; i < 5; i++) await io.demodWriteReg(1, 0x16 + i, 0x00, 1);
      await this._setFir(DEFAULT_FIR);
      await io.demodWriteReg(0, 0x19, 0x05, 1); // SDR mode, disable DAGC (bit 5)
      await io.demodWriteReg(1, 0x93, 0xf0, 1); // init FSM state-holding register
      await io.demodWriteReg(1, 0x94, 0x0f, 1);
      await io.demodWriteReg(1, 0x11, 0x00, 1); // disable AGC (en_dagc, bit 0)
      await io.demodWriteReg(1, 0x04, 0x00, 1); // disable RF and IF AGC loop
      await io.demodWriteReg(0, 0x61, 0x60, 1); // disable PID filter
      await io.demodWriteReg(0, 0x06, 0x80, 1); // opt_adc_iq = 0, default ADC_I/ADC_Q datapath
      await io.demodWriteReg(1, 0xb1, 0x1b, 1); // Zero-IF, DC cancellation, IQ estimation/compensation
      await io.demodWriteReg(0, 0x0d, 0x83, 1); // disable 4.096 MHz clock output on TP_CK0
    }

    async _setFir(fir) {
      const tmp = new Uint8Array(20);
      for (let i = 0; i < 8; i++) {
        if (fir[i] < -128 || fir[i] > 127) throw new Error(`i8 FIR coefficient out of bounds: ${fir[i]}`);
        tmp[i] = fir[i] & 0xff;
      }
      for (let i = 0; i < 8; i += 2) {
        const v0 = fir[8 + i], v1 = fir[8 + i + 1];
        if (v0 < -2048 || v0 > 2047 || v1 < -2048 || v1 > 2047) throw new Error(`i12 FIR coefficient out of bounds: ${v0}, ${v1}`);
        const j = 8 + (i * 3) / 2;
        tmp[j] = (v0 >> 4) & 0xff;
        tmp[j + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
        tmp[j + 2] = v1 & 0xff;
      }
      for (let i = 0; i < 20; i++) await this.io.demodWriteReg(1, 0x1c + i, tmp[i], 1);
    }

    async _searchTuner() {
      for (const t of KNOWN_TUNERS) {
        try {
          const v = await this.io.i2cReadReg(t.i2cAddr, R82XX_CHECK_ADDR);
          this.log(`Probing I2C ${hex(t.i2cAddr)}: reg ${hex(R82XX_CHECK_ADDR)} = ${hex(v)}`);
          if (v === R82XX_CHECK_VAL) return t;
        } catch (e) {
          this.log(`Probing I2C ${hex(t.i2cAddr)}: no answer`);
        }
      }
      return null;
    }

    _setI2cRepeater(on) { return this.io.demodWriteReg(1, 0x01, on ? 0x18 : 0x10, 1); }

    async _setIfFreq(freq) {
      const ifFreq = -Math.trunc((freq * 4194304) / DEF_RTL_XTAL_FREQ) | 0; // 2^22
      await this.io.demodWriteReg(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
      await this.io.demodWriteReg(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
      await this.io.demodWriteReg(1, 0x1b, ifFreq & 0xff, 1);
    }

    async _setSampleFreqCorrection(ppm) {
      const offs = (Math.trunc((-ppm * 16777216) / 1000000) << 16) >> 16; // as i16
      await this.io.demodWriteReg(1, 0x3f, offs & 0xff, 1);
      await this.io.demodWriteReg(1, 0x3e, (offs >> 8) & 0x3f, 1);
    }

    // f32 arithmetic as in rtl-sdr-rs get_tuner_xtal_freq()
    _tunerXtalFreq() {
      return Math.trunc(f32(f32(this.tunerXtal) * f32(1 + f32(f32(this.corr) / 1e6))));
    }

    async _withRepeater(fn) {
      await this._setI2cRepeater(true);
      try { return await fn(); } finally { await this._setI2cRepeater(false); }
    }

    async _setGpio(pin, on) {
      if (pin === 0 && this.forceBt) on = true; // EEPROM-forced bias tee cannot be switched off
      const bit = 1 << pin;
      let r = await this.io.readReg(BLOCK_SYS, GPD, 1);
      await this.io.writeReg(BLOCK_SYS, GPD, r & ~bit & 0xff, 1);
      r = await this.io.readReg(BLOCK_SYS, GPOE, 1);
      await this.io.writeReg(BLOCK_SYS, GPOE, r | bit, 1);
      r = await this.io.readReg(BLOCK_SYS, GPO, 1);
      await this.io.writeReg(BLOCK_SYS, GPO, on ? r | bit : r & ~bit & 0xff, 1);
    }

    async _setCenterFreq(freq) {
      const actual = await this._withRepeater(() => this._t.setFreq(freq));
      this.freq = freq;
      this.actualFreq = actual;
      return actual;
    }

    // ---------------------------------------------------------------- public API
    setSampleRate(hz) {
      return this._locked(async () => {
        this._need();
        const rate = Math.round(hz);
        if (!(rate > 225000 && rate <= 3200000) || (rate > 300000 && rate <= 900000)) {
          throw new Error(`Invalid sample rate: ${hz} Hz (225-300 kHz or 0.9-3.2 MHz)`);
        }
        const num = this.xtal * 4194304; // 2^22
        const rsampRatio = Math.floor(num / rate) & 0x0ffffffc;
        const realRatio = rsampRatio | ((rsampRatio & 0x08000000) << 1);
        const realRate = num / realRatio;
        if (realRate !== rate) this.log(`Exact sample rate is ${realRate} Hz`);
        this.rate = Math.trunc(realRate);
        this.exactRate = realRate;

        await this._withRepeater(() => this._t.setBandwidth(this.bw > 0 ? this.bw : this.rate));
        await this._setIfFreq(this._t.getIfFreq());
        await this._setCenterFreq(this.freq);

        await this.io.demodWriteReg(1, 0x9f, (rsampRatio >> 16) & 0xffff, 2);
        await this.io.demodWriteReg(1, 0xa1, rsampRatio & 0xffff, 2);
        await this._setSampleFreqCorrection(this.corr);
        // reset demod (bit 3, soft_rst)
        await this.io.demodWriteReg(1, 0x01, 0x14, 1);
        await this.io.demodWriteReg(1, 0x01, 0x10, 1);
        return realRate;
      });
    }

    setCenterFreq(hz) {
      return this._locked(async () => {
        this._need();
        const f = Math.round(hz);
        if (!(f >= 0 && f <= 0xffffffff)) throw new Error(`Invalid frequency: ${hz} Hz`);
        return this._setCenterFreq(f);
      });
    }

    // db: null = tuner AGC, number = nearest manual gain step; returns the gain set (dB) or null
    setGain(db) {
      return this._locked(async () => {
        this._need();
        let g = null;
        if (db !== null && db !== undefined) {
          g = this.gains[0];
          for (const x of this.gains) if (Math.abs(x - db) < Math.abs(g - db)) g = x;
        }
        await this._withRepeater(() => this._t.setGain(g === null ? null : Math.round(g * 10)));
        this.gain = g;
        return g;
      });
    }

    // current total tuner gain in dB (LNA + mixer + VGA from the status registers)
    readGain() {
      return this._locked(async () => {
        this._need();
        return (await this._withRepeater(() => this._t.readGain())) / 10;
      });
    }

    setPpm(ppm) {
      return this._locked(async () => {
        this._need();
        const p = Math.round(ppm);
        if (p === this.corr) return;
        this.corr = p;
        await this._setSampleFreqCorrection(p);
        this._t.setXtalFreq(this._tunerXtalFreq());
        await this._setCenterFreq(this.freq);
      });
    }

    setBiasTee(on) {
      return this._locked(async () => {
        this._need();
        await this._setGpio(0, !!on);
      });
    }

    resetBuffer() {
      return this._locked(async () => {
        await this.io.writeReg(BLOCK_USB, USB_EPA_CTL, 0x1002, 2);
        await this.io.writeReg(BLOCK_USB, USB_EPA_CTL, 0x0000, 2);
      });
    }

    // one bulk IN transfer on 0x81; bytes must be a multiple of 512
    async readBlock(bytes) {
      if (!(bytes > 0) || bytes % 512 !== 0) throw new Error(`readBlock: length ${bytes} must be a positive multiple of 512`);
      let r;
      try {
        r = await this.dev.transferIn(BULK_ENDPOINT, bytes);
      } catch (e) {
        throw new Error(`RTL-SDR bulk read failed: ${e.message || e}`);
      }
      if (r.status === "stall") {
        try { await this.dev.clearHalt("in", BULK_ENDPOINT); } catch (e) { /* ignore */ }
        throw new Error("RTL-SDR bulk read stalled");
      }
      if (r.status !== "ok") throw new Error(`RTL-SDR bulk read ${r.status}`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }

    close() {
      return this._locked(async () => {
        if (this._closed) return;
        this._closed = true;
        let err = null;
        try {
          if (this._t) {
            await this._withRepeater(() => this._t.exit());
            await this.io.writeReg(BLOCK_SYS, DEMOD_CTL, 0x20, 1); // power off demod and ADCs
          }
        } catch (e) { err = e; }
        try { await this.dev.releaseInterface(INTERFACE_ID); } catch (e) { /* already released */ }
        try { if (this.dev.opened) await this.dev.close(); } catch (e) { err = err || e; }
        this._t = null;
        if (err) this.log(`RTL-SDR close: ${err.message || err}`);
      });
    }
  }

  return RtlSdrUsb;
})();

if (typeof module !== "undefined" && module.exports) module.exports = RtlSdrUsb;
