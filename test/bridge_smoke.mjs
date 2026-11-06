// The real SatHunter Bridge binary, without hardware: it starts, answers hello / usb.list /
// serial.list, says "no RTL-SDR" cleanly, and turns away pages from other sites.
//   node test/bridge_smoke.mjs bridge/target/release/sathunter-bridge
import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";

const bin = process.argv[2] || "bridge/target/release/sathunter-bridge";
const PORT = 47391;
const p = spawn(bin, ["--port", String(PORT)], { stdio: ["ignore", "inherit", "pipe"] });
let errText = ""; p.stderr.on("data", (d) => { errText += d; process.stderr.write(d); });
const fail = (m) => { console.log("BRIDGE SMOKE FAIL:", m); p.kill(); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 50 && !errText.includes("listening"); i++) await sleep(100);
if (!errText.includes("listening")) fail("did not start");

function upgrade(origin, host) {
  return new Promise((resolve) => {
    const headers = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"), Host: host || `127.0.0.1:${PORT}` };
    if (origin) headers.Origin = origin;
    const req = http.request({ host: "127.0.0.1", port: PORT, headers });
    req.on("upgrade", (res, sock) => { sock.destroy(); resolve(101); });
    req.on("response", (res) => resolve(res.statusCode));
    req.on("error", () => resolve(0));
    req.end();
  });
}
const checks = [["null", undefined, 101], ["https://z2labs.github.io", undefined, 101], ["http://localhost:8000", undefined, 101],
  ["https://evil.example", undefined, 403], ["http://localhost.evil.example", undefined, 403], ["https://z2labs.github.io", "evil.example:" + PORT, 403]];
for (const [o, h, want] of checks) {
  const got = await upgrade(o, h);
  console.log(`origin ${o} host ${h || "-"}: ${got}`);
  if (got !== want) fail(`origin ${o}: got ${got}, want ${want}`);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const wait = new Map(); let next = 1;
ws.onmessage = (m) => { const j = JSON.parse(m.data); const w = wait.get(j.id); if (w) { wait.delete(j.id); w(j); } };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws error")); }).catch((e) => fail(e.message));
const req = (op, a) => new Promise((r) => { const id = next++; wait.set(id, r); ws.send(JSON.stringify({ op, id, ...a })); });

const hello = await req("hello"); console.log("hello:", JSON.stringify(hello));
if (hello.status !== "ok" || !hello.version) fail("hello");
const ul = await req("usb.list"); console.log("usb.list:", JSON.stringify(ul));
if (ul.status !== "ok" || !Array.isArray(ul.devices)) fail("usb.list");
const sl = await req("serial.list"); console.log("serial.list:", JSON.stringify(sl));
if (sl.status !== "ok" || !Array.isArray(sl.ports)) fail("serial.list");
if (!ul.devices.length) {
  const o = await req("usb.open"); console.log("usb.open:", JSON.stringify(o));
  if (o.status !== "error" || o.code !== "notfound") fail("usb.open without a stick");
}
const c = await req("usb.controlIn", { request: 0, value: 0, index: 0, length: 1 });
if (c.status !== "error") fail("control transfer with nothing open");
const so = await req("serial.open", { path: "/etc/passwd" });
console.log("serial.open /etc/passwd:", JSON.stringify(so));
if (so.status !== "error") fail("serial.open must refuse what is not an ESP32 serial port");
const bad = await req("nope"); if (bad.status !== "error") fail("unknown op");
ws.close();
p.kill("SIGINT");
console.log("BRIDGE SMOKE PASS");
