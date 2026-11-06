// SatHunter Bridge client: the RTL-SDR and the ESP32-S3 through the small SatHunter Bridge program
// (bridge/) on ws://127.0.0.1:47380, for browsers without WebUSB / Web Serial (Firefox) and for
// computers where the browser cannot open the device (Linux's TV driver, missing udev rules).
// BridgeUSBDevice and BridgeSerialPort copy the parts of USBDevice and SerialPort the page uses,
// so src/rtl.js, SerialSource and the firmware installer run on them unchanged. Protocol:
// bridge/PROTOCOL.md.
const SatBridge = (() => {
  "use strict";
  const PORT = 47380;
  const URL_ = "ws://127.0.0.1:" + PORT;
  const RELEASE = "https://github.com/z2labs/SatHunter-WEB-SDR/releases/download/bridge-1.0/";
  const DOWNLOADS = {
    linux: RELEASE + "sathunter-bridge_1.0.0_amd64.deb",
    linuxArm: RELEASE + "sathunter-bridge_1.0.0_arm64.deb",
    windows: RELEASE + "SatHunter-Setup.exe",
    mac: "https://github.com/z2labs/SatHunter-WEB-SDR/releases/tag/bridge-1.0",
    macZip: RELEASE + "sathunter-bridge-macos.zip",
    all: "https://github.com/z2labs/SatHunter-WEB-SDR/releases/tag/bridge-1.0",
  };

  const domErr = (name, msg) => { const e = new Error(msg); e.name = name; return e; };

  // one WebSocket: JSON requests with ids, binary frames [u32 LE id][payload]
  class Conn {
    static open(timeoutMs) {
      return new Promise((resolve, reject) => {
        let ws;
        try { ws = new WebSocket(URL_); } catch (e) { reject(e); return; }
        ws.binaryType = "arraybuffer";
        const t = setTimeout(() => { try { ws.close(); } catch (e) {} reject(domErr("NetworkError", "SatHunter Bridge is not running")); }, timeoutMs || 1500);
        ws.onopen = () => { clearTimeout(t); resolve(new Conn(ws)); };
        ws.onerror = () => { clearTimeout(t); reject(domErr("NetworkError", "SatHunter Bridge is not running")); };
      });
    }
    constructor(ws) {
      this.ws = ws; this.next = 1; this.wait = new Map(); this.onEvent = null; this.onData = null; this.closed = false;
      ws.onmessage = (m) => this.recv(m.data);
      ws.onclose = () => {
        this.closed = true;
        for (const w of this.wait.values()) w.reject(domErr("NetworkError", "SatHunter Bridge closed the connection"));
        this.wait.clear();
        if (this.onEvent) this.onEvent({ op: "bridge.closed" });
      };
    }
    recv(d) {
      if (typeof d === "string") {
        let j; try { j = JSON.parse(d); } catch (e) { return; }
        if (j.id != null && this.wait.has(j.id)) {
          const w = this.wait.get(j.id); this.wait.delete(j.id);
          if (j.status === "error") { const e = domErr(j.code === "notfound" ? "NotFoundError" : "NetworkError", j.error || "bridge error"); e.bridge = true; e.code = j.code; w.reject(e); }
          else w.resolve(j);
        } else if (j.op && this.onEvent) this.onEvent(j);
        return;
      }
      const id = new DataView(d, 0, 4).getUint32(0, true);
      if (id === 0) { if (this.onData) this.onData(new Uint8Array(d, 4)); return; }
      const w = this.wait.get(id);
      if (w) { this.wait.delete(id); w.resolve({ status: "ok", data: new DataView(d, 4) }); }
    }
    request(op, args) {
      if (this.closed) return Promise.reject(domErr("NetworkError", "SatHunter Bridge is not connected"));
      const id = this.next++; if (this.next > 0x7fffffff) this.next = 1;
      return new Promise((resolve, reject) => {
        this.wait.set(id, { resolve, reject });
        this.ws.send(JSON.stringify(Object.assign({ op, id }, args || {})));
      });
    }
    sendBinary(u8) { if (!this.closed) this.ws.send(u8); }
    close() { this.closed = true; try { this.ws.close(); } catch (e) {} }
  }

  // ------------------------------------------------------------------ is it running?
  let info = null, lastProbe = -1e9, probing = null;
  function probe(force) {
    if (typeof WebSocket === "undefined") return Promise.resolve(null);
    if (!force && performance.now() - lastProbe < 3000) return probing || Promise.resolve(info);
    lastProbe = performance.now();
    probing = (async () => {
      let c = null;
      try { c = await Conn.open(1200); info = await c.request("hello"); }
      catch (e) { info = null; }
      finally { if (c) c.close(); probing = null; }
      return info;
    })();
    return probing;
  }

  // a short-lived connection for listing
  async function ask(op) {
    const c = await Conn.open(1500);
    try { return await c.request(op); } finally { c.close(); }
  }

  // ------------------------------------------------------------------ WebUSB-like device
  const devices = new Map();   // key -> BridgeUSBDevice (same object while plugged in)
  class BridgeUSBDevice {
    constructor(d) { this.key = d.key; this.c = null; this.opened = false; this.configuration = null; this.update(d); }
    update(d) {
      this.vendorId = d.vendorId; this.productId = d.productId; this.manufacturerName = d.manufacturerName || "";
      this.productName = d.productName || ""; this.serialNumber = d.serialNumber || ""; this.kernelDriver = d.driver || "";
    }
    async open() {
      if (this.opened) return;
      this.c = await Conn.open(2000);
      this.c.onEvent = (ev) => {
        if (ev.op === "usb.disconnect" || ev.op === "bridge.closed") { this.opened = false; usbEvents.dispatch("disconnect", this); }
      };
      try { const d = await this.c.request("usb.open", { key: this.key }); this.update(d); }
      catch (e) { this.c.close(); this.c = null; throw e; }
      this.opened = true; this.configuration = { configurationValue: 1 };
    }
    _req(op, a) { if (!this.c) return Promise.reject(domErr("InvalidStateError", "The device must be opened first.")); return this.c.request(op, a); }
    async selectConfiguration() { this.configuration = { configurationValue: 1 }; }
    async claimInterface() {}
    async releaseInterface() {}
    async controlTransferIn(s, length) {
      const r = await this._req("usb.controlIn", { requestType: s.requestType, recipient: s.recipient, request: s.request, value: s.value, index: s.index, length });
      return { status: r.status, data: new DataView(Uint8Array.from(r.data || []).buffer) };
    }
    async controlTransferOut(s, data) {
      const u8 = data ? (data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength)) : new Uint8Array(0);
      const r = await this._req("usb.controlOut", { requestType: s.requestType, recipient: s.recipient, request: s.request, value: s.value, index: s.index, data: Array.from(u8) });
      return { status: r.status, bytesWritten: r.bytesWritten || 0 };
    }
    transferIn(endpoint, length) { return this._req("usb.bulkIn", { endpoint, length }); }
    async clearHalt(dir, endpoint) { await this._req("usb.clearHalt", { endpoint }); }
    async reset() { await this._req("usb.reset"); }
    async close() {
      const c = this.c; this.c = null; this.opened = false;
      if (c) { try { await c.request("usb.close"); } catch (e) {} c.close(); }
    }
  }

  // connect / disconnect events, made by listing the devices every 1.5 s while someone listens
  function events(listKey, make, onGone) {
    const ls = { connect: [], disconnect: [] };
    let timer = null, known = null;
    const tick = async () => {
      if (!info) { await probe(); if (!info) return; }
      let now;
      try { now = await make(); } catch (e) { return; }
      const keys = new Set(now.map(listKey));
      if (known) {
        for (const d of now) if (!known.has(listKey(d))) api.dispatch("connect", d);
        for (const k of known) if (!keys.has(k)) { const d = onGone(k); if (d) api.dispatch("disconnect", d); }
      }
      known = keys;
    };
    const api = {
      addEventListener(type, fn) { if (ls[type]) ls[type].push(fn); if (!timer) { timer = setInterval(tick, 1500); tick(); } },
      dispatch(type, d) { for (const fn of ls[type] || []) { try { fn({ type, device: d, target: d, port: d }); } catch (e) {} } },
    };
    return api;
  }

  async function usbList() {
    const r = await ask("usb.list");
    return r.devices.map((d) => { let x = devices.get(d.key); if (x) x.update(d); else devices.set(d.key, x = new BridgeUSBDevice(d)); return x; });
  }
  const usbEvents = events((d) => d.key, usbList, (k) => { const d = devices.get(k); devices.delete(k); return d; });
  const usb = {
    getDevices: usbList,
    async requestDevice(opts) {
      const fs = (opts && opts.filters) || [];
      const ds = (await usbList()).filter((d) => !fs.length || fs.some((f) => (f.vendorId == null || f.vendorId === d.vendorId) && (f.productId == null || f.productId === d.productId)));
      if (!ds.length) throw domErr("NotFoundError", "No RTL-SDR is plugged in.");
      return ds.find((d) => !d.opened) || ds[0];
    },
    addEventListener: (t, fn) => usbEvents.addEventListener(t, fn),
  };

  // ------------------------------------------------------------------ Web Serial-like port
  const ports = new Map();   // path -> BridgeSerialPort
  class BridgeSerialPort {
    constructor(p) { this.path = p.path; this.c = null; this.readable = null; this.writable = null; this.update(p); }
    update(p) { this.vid = p.usbVendorId; this.pid = p.usbProductId; this.product = p.product || ""; }
    getInfo() { return { usbVendorId: this.vid, usbProductId: this.pid }; }
    async open(o) {
      if (this.c) throw domErr("InvalidStateError", "The port is already open.");
      const c = await Conn.open(2000);
      try { await c.request("serial.open", { path: this.path, baudRate: (o && o.baudRate) || 115200 }); }
      catch (e) { c.close(); throw e; }
      this.c = c;
      let ctl = null;
      this.readable = new ReadableStream({ start: (k) => { ctl = k; } }, { highWaterMark: 64 });
      c.onData = (u8) => { try { ctl.enqueue(new Uint8Array(u8)); } catch (e) {} };
      c.onEvent = (ev) => {
        if (ev.op === "serial.closed" || ev.op === "bridge.closed") {
          try { ctl.error(domErr("NetworkError", "The device has been lost.")); } catch (e) {}
          this.readable = null; this.writable = null;
          if (this.c === c) { this.c = null; c.close(); }
        }
      };
      this._ctl = () => ctl;
      this.writable = new WritableStream({
        write: async (chunk) => {
          if (!this.c) throw domErr("NetworkError", "The port is closed.");
          this.c.sendBinary(chunk);
          while (this.c && this.c.ws.bufferedAmount > (1 << 20)) await new Promise((r) => setTimeout(r, 5));
        },
      });
    }
    async setSignals(s) {
      if (!this.c) throw domErr("InvalidStateError", "The port is closed.");
      await this.c.request("serial.signals", { dataTerminalReady: s.dataTerminalReady, requestToSend: s.requestToSend });
    }
    async close() {
      const c = this.c; this.c = null;
      if (this._ctl) { try { this._ctl().close(); } catch (e) {} }
      this.readable = null; this.writable = null;
      if (c) { try { await c.request("serial.close"); } catch (e) {} c.close(); }
    }
  }
  async function serialList() {
    const r = await ask("serial.list");
    return r.ports.map((p) => { let x = ports.get(p.path); if (x) x.update(p); else ports.set(p.path, x = new BridgeSerialPort(p)); return x; });
  }
  const serialEvents = events((p) => p.path, serialList, (k) => ports.get(k));
  const serial = {
    getPorts: serialList,
    async requestPort(opts) {
      const fs = (opts && opts.filters) || [];
      const ps = (await serialList()).filter((p) => !fs.length || fs.some((f) => f.usbVendorId == null || f.usbVendorId === p.vid));
      if (!ps.length) throw domErr("NotFoundError", "No ESP32 board is plugged in.");
      return ps.find((p) => p.vid === 0x303a && !p.c) || ps.find((p) => !p.c) || ps[0];
    },
    addEventListener: (t, fn) => serialEvents.addEventListener(t, fn),
  };

  // ------------------------------------------------------------------ install link for this computer
  // the installer for this computer, and how to run it
  function download() {
    const ua = navigator.userAgent || "", p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return { os: /Android/i.test(ua) ? "Android" : "iOS", url: "", file: "", steps: "" };
    if (/Windows/i.test(ua)) return { os: "Windows", url: DOWNLOADS.windows, file: "SatHunter-Setup.exe",
      steps: "Run it and press Install. Windows may say “Windows protected your PC”: More info → Run anyway. It also installs the RTL-SDR driver (instead of Zadig)." };
    if (/Mac/i.test(p + ua)) return { os: "macOS", url: DOWNLOADS.macZip, file: "sathunter-bridge-macos.zip",
      steps: "Open the zip, then right-click install.command → Open (the first time macOS asks because it is not from the App Store)." };
    if (/Linux|X11|CrOS/i.test(p + ua)) {
      const arm = /aarch64|arm/i.test(p + ua);
      return { os: arm ? "Linux (ARM, Raspberry Pi)" : "Linux", url: arm ? DOWNLOADS.linuxArm : DOWNLOADS.linux, file: arm ? "sathunter-bridge_1.0.0_arm64.deb" : "sathunter-bridge_1.0.0_amd64.deb",
        steps: "Open the downloaded .deb (double-click) and press Install (Ubuntu, Debian, Mint, Raspberry Pi OS). Other distributions: the tar.gz on the release page, then sudo ./install.sh." };
    }
    return { os: "", url: DOWNLOADS.all, file: "", steps: "Pick the file for your computer on the release page." };
  }

  return {
    PORT, URL: URL_, DOWNLOADS, probe, usb, serial, download,
    get available() { return !!info; },
    get info() { return info; },
    BridgeUSBDevice, BridgeSerialPort, Conn,
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = SatBridge;
