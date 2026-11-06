// A fake SatHunter Bridge (test only): the bridge's WebSocket protocol (bridge/PROTOCOL.md) on
// 127.0.0.1:47380, in front of the mock RTL-SDR (mock_usb.js) and the mock ESP32-S3 board
// (mock_board.js, run in a small fake window). No npm packages: a minimal WebSocket server.
//   node test/mock_bridge.mjs [--blank-board] [--no-rtl]
// Prints "READY" when it listens; logs every op on stderr.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createMockRtl } = require("./mock_usb.js");
const args = process.argv.slice(2);
const PORT = 47380;
const ORIGINS = ["null", "https://z2labs.github.io"];

// ---------------------------------------------------------------- devices
const rtl = args.includes("--no-rtl") ? null : createMockRtl({ blogV4: true, carrierOffsetHz: 250000, carrierAmp: 50 });
const RTL_KEY = "DeviceId(1, 4)";
function boardPort() {
  const win = { __blankBoard: args.includes("--blank-board"), __md5: async (arr) => crypto.createHash("md5").update(Buffer.from(arr)).digest("hex") };
  const nav = {};
  const ctx = vm.createContext({ window: win, navigator: nav, ReadableStream, WritableStream, TextEncoder, TextDecoder, DOMException,
    setInterval, clearInterval, setTimeout, clearTimeout, Uint8Array, Uint32Array, DataView, Math, Object, Array, Error, console });
  vm.runInContext(fs.readFileSync(path.join(here, "mock_board.js"), "utf8"), ctx);
  return { port: null, nav, win, ready: nav.serial.requestPort() };
}
const board = boardPort();
board.ready.then((p) => { board.port = p; });
export const stats = { ops: {}, origins: [] };

// ---------------------------------------------------------------- minimal WebSocket server
function frame(op, payload) {
  const n = payload.length;
  const h = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([h, payload]);
}
function wsAccept(req, sock, onMsg, onClose) {
  const key = req.headers["sec-websocket-key"];
  const acc = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + "\r\n\r\n");
  sock.setNoDelay(true);
  let buf = Buffer.alloc(0), frag = null, fragOp = 0, open = true;
  const c = {
    sendText: (s) => open && sock.write(frame(1, Buffer.from(s))),
    sendBin: (b) => open && sock.write(frame(2, Buffer.from(b.buffer, b.byteOffset, b.byteLength))),
    get open() { return open; },
  };
  const close = () => { if (!open) return; open = false; try { sock.end(frame(8, Buffer.alloc(0))); } catch (e) {} onClose(); };
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 15, masked = buf[1] & 0x80;
      let n = buf[1] & 127, o = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); o = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); o = 10; }
      const mo = o; if (masked) o += 4;
      if (buf.length < o + n) return;
      const p = Buffer.from(buf.subarray(o, o + n));
      if (masked) for (let i = 0; i < n; i++) p[i] ^= buf[mo + (i & 3)];
      buf = buf.subarray(o + n);
      if (op === 8) { close(); return; }
      if (op === 9) { sock.write(frame(10, p)); continue; }
      if (op === 0) { frag = Buffer.concat([frag, p]); if (fin) { onMsg(fragOp, frag); frag = null; } continue; }
      if (!fin) { frag = p; fragOp = op; continue; }
      onMsg(op, p);
    }
  });
  sock.on("close", close); sock.on("error", close);
  return c;
}

// ---------------------------------------------------------------- the bridge protocol
function session(c) {
  let usbOpen = false, bulkQ = [], bulkRunning = false, serialOpen = false, reader = null, writer = null;
  const reply = (id, o) => c.sendText(JSON.stringify(Object.assign({ id, status: "ok" }, o)));
  const fail = (id, error, code) => c.sendText(JSON.stringify({ id, status: "error", error, code }));
  async function runBulk() {
    if (bulkRunning) return; bulkRunning = true;
    while (bulkQ.length && usbOpen && c.open) {
      const { id, length } = bulkQ.shift();
      let r;
      try { r = await rtl.transferIn(1, length); } catch (e) { c.sendText(JSON.stringify({ id, status: "error", error: String(e.message || e) })); continue; }
      // a real stick delivers at the sample rate; the Node mock does not wait
      const fs_ = 2.4e6;
      await new Promise((res) => setTimeout(res, (length / 2 / fs_) * 1000));
      const out = new Uint8Array(4 + r.data.byteLength);
      new DataView(out.buffer).setUint32(0, id, true);
      out.set(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength), 4);
      c.sendBin(out);
    }
    bulkRunning = false;
  }
  async function onText(s) {
    const m = JSON.parse(s), id = m.id;
    stats.ops[m.op] = (stats.ops[m.op] || 0) + 1;
    try {
      switch (m.op) {
        case "hello": return reply(id, { version: "mock", os: "test", features: ["usb", "serial"] });
        case "usb.list": return reply(id, { devices: rtl ? [{ key: RTL_KEY, vendorId: rtl.vendorId, productId: rtl.productId, manufacturerName: rtl.manufacturerName, productName: rtl.productName, serialNumber: rtl.serialNumber || "", driver: "" }] : [] });
        case "usb.open":
          if (!rtl || (m.key && m.key !== RTL_KEY)) return fail(id, "No RTL-SDR is plugged in.", "notfound");
          if (!rtl.opened) await rtl.open();
          await rtl.selectConfiguration(1); await rtl.claimInterface(0); usbOpen = true;
          return reply(id, { key: RTL_KEY, vendorId: rtl.vendorId, productId: rtl.productId, manufacturerName: rtl.manufacturerName, productName: rtl.productName, serialNumber: rtl.serialNumber || "" });
        case "usb.controlIn": {
          const r = await rtl.controlTransferIn({ requestType: m.requestType, recipient: m.recipient, request: m.request, value: m.value, index: m.index }, m.length);
          return reply(id, { status: r.status, data: r.data ? Array.from(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)) : [] });
        }
        case "usb.controlOut": {
          const r = await rtl.controlTransferOut({ requestType: m.requestType, recipient: m.recipient, request: m.request, value: m.value, index: m.index }, Uint8Array.from(m.data || []));
          return reply(id, { status: r.status, bytesWritten: r.bytesWritten || 0 });
        }
        case "usb.bulkIn": bulkQ.push({ id, length: m.length }); runBulk(); return;
        case "usb.clearHalt": case "usb.selectConfiguration": case "usb.claimInterface": case "usb.releaseInterface": return reply(id, {});
        case "usb.reset": if (rtl.reset) await rtl.reset(); return reply(id, {});
        case "usb.close": usbOpen = false; bulkQ = []; try { await rtl.close(); } catch (e) {} return reply(id, {});
        case "serial.list": return reply(id, { ports: [{ path: "/dev/ttyACM0", usbVendorId: 0x303a, usbProductId: 0x1001, product: "USB JTAG/serial debug unit" }] });
        case "serial.open": {
          const p = board.port || await board.ready;
          await p.open({ baudRate: m.baudRate });
          serialOpen = true; writer = p.writable.getWriter(); reader = p.readable.getReader();
          (async () => {
            try { for (;;) { const { value, done } = await reader.read(); if (done) break; const out = new Uint8Array(4 + value.length); out.set(value, 4); c.sendBin(out); } } catch (e) {}
          })();
          return reply(id, { path: m.path });
        }
        case "serial.signals": await (board.port).setSignals({ dataTerminalReady: m.dataTerminalReady, requestToSend: m.requestToSend }); return reply(id, {});
        case "serial.close": await closeSerial(); return reply(id, {});
        case "test.board": {   // test hook: what the mock board holds
          const st = board.win.__board, md5 = (u8) => crypto.createHash("md5").update(Buffer.from(u8)).digest("hex");
          return reply(id, { mode: st.mode, opens: st.opens, flash: Object.fromEntries(Object.entries(st.flash).map(([k, v]) => [k, { len: v.length, md5: md5(v) }])), ops: stats.ops });
        }
        default: return fail(id, "unknown op " + m.op);
      }
    } catch (e) { fail(id, String(e && e.message || e)); }
  }
  async function closeSerial() {
    if (!serialOpen) return; serialOpen = false;
    try { writer.releaseLock(); } catch (e) {}
    try { await reader.cancel(); } catch (e) {}
    try { reader.releaseLock(); } catch (e) {}
    try { await board.port.close(); } catch (e) {}
  }
  let chain = Promise.resolve();
  return {
    onMsg(op, p) {
      if (op === 1) { chain = chain.then(() => onText(p.toString())); return; }
      if (op === 2) { stats.ops["serial.write"] = (stats.ops["serial.write"] || 0) + 1; const w = writer, d = new Uint8Array(p); chain = chain.then(() => w && w.write(d)); }
    },
    async onClose() { const mine = usbOpen; usbOpen = false; bulkQ = []; if (mine && rtl.opened) { try { await rtl.close(); } catch (e) {} } await closeSerial(); },
  };
}

const server = http.createServer((req, res) => { res.writeHead(426); res.end("websocket only"); });
server.on("upgrade", (req, sock) => {
  const origin = req.headers.origin;
  stats.origins.push(origin || "");
  if (origin && !ORIGINS.includes(origin) && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin)) {
    sock.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
  }
  let s = null;
  const c = wsAccept(req, sock, (op, p) => s.onMsg(op, p), () => s && s.onClose());
  s = session(c);
});
server.listen(PORT, "127.0.0.1", () => { console.log("READY"); });
process.on("SIGTERM", () => { process.stderr.write(JSON.stringify(stats) + "\n"); process.exit(0); });
process.on("SIGINT", () => { process.stderr.write(JSON.stringify(stats) + "\n"); process.exit(0); });
