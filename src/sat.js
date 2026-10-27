// ---------------------------------------------------------------- SatHunter: satellites, passes, Doppler, radar
// Uses satellite.js (SGP4/SDP4, MIT, inlined above). The data file (data/sats.json) is built every
// day by tools/fetch_data.py from SatNOGS DB / Network and CelesTrak and published with the page.

const SAT_DATA_URLS = ["data/sats.json", "https://z2labs.github.io/SatHunter-WEB-SDR/data/sats.json"];
const SAT_CACHE_KEY = "sathunter-web-sats";
const C_KMS = 299792.458;
const DEG = 180 / Math.PI, RAD = Math.PI / 180;

const sat = {
  list: [],            // [{n, name, hu, l1, l2, tx, rec}]
  byId: new Map(),
  generated: "", status: "", loading: false,
  passes: new Map(),   // norad -> {pass, key}
  queue: [], working: false,
  shift: 0,            // seconds added to the clock (simulated pass)
  live: null,          // selected satellite now: {look, f, doppler}
  compass: { mode: "off", heading: null, last: 0, perm: false },
};
const satNow = () => Date.now() / 1000 + sat.shift;
const satSel = () => sat.byId.get(state.satSel) || null;
const inEsp = (f) => f >= FMIN && f <= FMAX;

// ---- station (where the user is)
function station() {
  const l = state.loc;
  return { latitude: l.lat * RAD, longitude: l.lon * RAD, height: (l.alt || 0) / 1000 };
}

// ---- Maidenhead locator
function toLocator(lat, lon) {
  let x = lon + 180, y = lat + 90;
  const A = "ABCDEFGHIJKLMNOPQRSTUVWX";
  let s = A[Math.floor(x / 20)] + A[Math.floor(y / 10)];
  x %= 20; y %= 10;
  s += Math.floor(x / 2) + "" + Math.floor(y);
  x %= 2; y %= 1;
  s += A[Math.floor(x * 12)].toLowerCase() + A[Math.floor(y * 24)].toLowerCase();
  return s;
}
function fromLocator(loc) {
  const s = loc.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(s)) return null;
  let lon = (s.charCodeAt(0) - 65) * 20 - 180 + Number(s[2]) * 2;
  let lat = (s.charCodeAt(1) - 65) * 10 - 90 + Number(s[3]);
  if (s.length >= 6) { lon += (s.charCodeAt(4) - 65) / 12 + 1 / 24; lat += (s.charCodeAt(5) - 65) / 24 + 1 / 48; }
  else { lon += 1; lat += 0.5; }
  return { lat, lon };
}

// ---- orbit maths
function satRec(s) {
  if (!s.rec) { try { s.rec = satellite.twoline2satrec(s.l1, s.l2); } catch (e) { s.rec = null; } }
  return s.rec;
}
// az/el (deg), range (km) and range rate (km/s, positive = going away) at unix time t
function lookAt(s, t, st) {
  const rec = satRec(s); if (!rec) return null;
  const one = (tt) => {
    const d = new Date(tt * 1000), pv = satellite.propagate(rec, d);
    if (!pv || !pv.position || typeof pv.position === "boolean") return null;
    const ecf = satellite.eciToEcf(pv.position, satellite.gstime(d));
    return satellite.ecfToLookAngles(st, ecf);
  };
  const a = one(t), b = one(t + 1);
  if (!a || !b) return null;
  return { az: (a.azimuth * DEG + 360) % 360, el: a.elevation * DEG, range: a.rangeSat, rr: b.rangeSat - a.rangeSat };
}
// Elevation only (one propagation): the pass search calls this a lot
function elAt(s, t, st) {
  const rec = satRec(s); if (!rec) return -90;
  const d = new Date(t * 1000), pv = satellite.propagate(rec, d);
  if (!pv || !pv.position || typeof pv.position === "boolean") return -90;
  return satellite.ecfToLookAngles(st, satellite.eciToEcf(pv.position, satellite.gstime(d))).elevation * DEG;
}

// Next pass above the horizon from t0 (or the one in progress), within 24 h
function nextPass(s, t0, st) {
  const STEP = 60, H = 86400;
  const bis = (a, b, upAtB) => { for (let i = 0; i < 14; i++) { const m = (a + b) / 2; ((elAt(s, m, st) > 0) === upAtB) ? (b = m) : (a = m); } return upAtB ? b : a; };
  let aos, t = t0;
  const e0 = elAt(s, t0, st);
  if (e0 > 0) {
    let tb = t0; while (tb > t0 - 3 * 3600 && elAt(s, tb - STEP, st) > 0) tb -= STEP;
    aos = tb > t0 - 3 * 3600 ? bis(tb - STEP, tb, true) : t0 - 3 * 3600;
  } else {
    for (t = t0 + STEP; t <= t0 + H; t += STEP) if (elAt(s, t, st) > 0) break;
    if (t > t0 + H) return null;
    aos = bis(t - STEP, t, true);
  }
  let te = Math.max(aos, t0);
  while (te < aos + H && elAt(s, te + STEP, st) > 0) te += STEP;
  if (te >= aos + H) {   // never sets: geostationary / always visible
    const l = lookAt(s, t0, st);
    return { always: true, aos: t0, los: t0 + H, tmax: t0, maxEl: l ? l.el : 0, aosAz: l ? l.az : 0, losAz: l ? l.az : 0 };
  }
  const los = bis(te, te + STEP, false);
  let maxEl = -90, tmax = aos;
  for (let tt = aos; tt <= los; tt += 15) { const e = elAt(s, tt, st); if (e > maxEl) { maxEl = e; tmax = tt; } }
  const la = lookAt(s, aos, st), ll = lookAt(s, los, st);
  return { always: false, aos, los, tmax, maxEl, aosAz: la ? la.az : 0, losAz: ll ? ll.az : 0 };
}

// ---- which satellites and downlinks are shown
function txShown(t) {
  if (!t[5]) return false;                              // inactive downlink
  if (state.satBand === "all") return true;
  return inEsp(t[2]) || (t[3] && inEsp(t[3]));
}
function health(t) { return t[7] ? (t[6] / t[7]) * Math.log(1 + t[6]) : 0; }
function bestTx(s) {
  let best = null;
  for (const t of s.tx) if (txShown(t) && (!best || health(t) > health(best))) best = t;
  return best || s.tx.find(txShown) || null;
}
function satCandidates() {
  const q = (state.satSearch || "").trim().toLowerCase(), favs = new Set(state.favs);
  const out = [];
  for (const s of sat.list) {
    const fav = favs.has(s.n);
    if (q && !(s.name.toLowerCase().includes(q) || String(s.n) === q || s.tx.some((t) => t[1].toLowerCase().includes(q) || t[0].toLowerCase().includes(q)))) continue;
    if (!fav && !s.tx.some(txShown)) continue;
    out.push(s);
  }
  return out;
}
const stationKey = () => state.loc.lat.toFixed(2) + "/" + state.loc.lon.toFixed(2);

// Passes are worked out a few satellites at a time so the page stays smooth
function schedulePasses() {
  const now = satNow(), key = stationKey();
  sat.queue = satCandidates().filter((s) => { const p = sat.passes.get(s.n); return !p || p.key !== key || (p.pass && p.pass.los < now) || (!p.pass && now - p.at > 1800); });
  if (!sat.working) workPasses();
}
function workPasses() {
  sat.working = true;
  const st = station(), key = stationKey(), now = satNow(), t0 = performance.now();
  while (sat.queue.length && performance.now() - t0 < 12) {
    const s = sat.queue.shift();
    sat.passes.set(s.n, { pass: nextPass(s, now, st), key, at: now });
  }
  renderSatList();
  if (sat.queue.length) setTimeout(workPasses, 0); else sat.working = false;
}

// ---- data
async function loadSats(force) {
  if (sat.loading) return;
  sat.loading = true; setSatStatus("Loading satellite data…");
  let data = null, from = "";
  if (window.__SAT_DATA) { data = window.__SAT_DATA; from = "test data"; }
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(SAT_CACHE_KEY) || "null"); } catch (e) {}
  if (!data && cached && !force && Date.now() - cached.t < 12 * 3600e3) { data = cached.data; from = "saved copy"; }
  if (!data) {
    for (const u of SAT_DATA_URLS) {
      try {
        const r = await fetch(u, { cache: "no-cache" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        data = await r.json(); from = u.startsWith("http") ? "z2labs.github.io" : "this site";
        try { localStorage.setItem(SAT_CACHE_KEY, JSON.stringify({ t: Date.now(), data })); } catch (e) { log("satellite data too big to keep: " + e.message); }
        break;
      } catch (e) { log("satellite data " + u + ": " + e.message); }
    }
  }
  if (!data && cached) { data = cached.data; from = "saved copy (offline)"; }
  sat.loading = false;
  if (!data || !Array.isArray(data.sats)) { setSatStatus("No satellite data: check the internet connection and press ⟳."); return; }
  sat.list = data.sats; sat.byId = new Map(sat.list.map((s) => [s.n, s]));
  sat.generated = data.generated || ""; sat.passes.clear();
  log("satellites: " + sat.list.length + " from " + from);
  setSatStatus("");
  schedulePasses(); updateSatCard();
}
function setSatStatus(t) { sat.status = t; renderSatHead(); }
function dataAge() {
  if (!sat.generated) return "";
  const h = (Date.now() - Date.parse(sat.generated)) / 3600e3;
  return h < 48 ? Math.max(0, Math.round(h)) + " h old" : Math.round(h / 24) + " days old";
}

// ---- list
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const clock = (t) => new Date(t * 1000).toTimeString().slice(0, 5);
function minutes(s) { const m = Math.max(0, Math.floor(s / 60)); return m >= 60 ? Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min" : m < 1 ? "<1 min" : m + " min"; }
function passText(p, now) {
  if (!p) return "No pass in the next 24 h";
  if (p.always) return "Always above the horizon";
  if (p.aos <= now) return "Overhead now · " + minutes(p.los - now) + " left";
  const w = clock(p.aos) + "–" + clock(p.los);
  return p.aos - now < 3600 ? "In " + minutes(p.aos - now) + " · " + w : w;
}
function fmtF(f) { return (f / 1e6).toFixed(3) + " MHz"; }
function sections() {
  const now = satNow(), favs = new Set(state.favs);
  const rows = satCandidates().map((s) => ({ s, p: (sat.passes.get(s.n) || {}).pass, fav: favs.has(s.n), t: bestTx(s) }));
  const up = (r) => r.p && (r.p.always || r.p.aos <= now);
  const byTime = (a, b) => (up(b) - up(a)) || ((a.p ? a.p.aos : 1e12) - (b.p ? b.p.aos : 1e12));
  const pinned = rows.filter((r) => r.fav).sort(byTime), rest = rows.filter((r) => !r.fav);
  if (state.satSort === "health") {
    rest.sort((a, b) => (b.t ? health(b.t) : 0) - (a.t ? health(a.t) : 0) || byTime(a, b));
    return [["Favourites", pinned], ["Best heard on SatNOGS", rest]];
  }
  const timed = rest.filter((r) => r.p).sort(byTime);
  return [["Favourites", pinned], ["Overhead now", timed.filter(up)],
    ["Next 2 hours", timed.filter((r) => !up(r) && r.p.aos - now < 7200)], ["Later today", timed.filter((r) => !up(r) && r.p.aos - now >= 7200)]];
}
function healthBadge(t) {
  if (!t || !t[6]) return "";
  const pct = Math.round(100 * t[6] / t[7]), cls = pct >= 60 ? "ok" : pct >= 25 ? "mid" : "low";
  const n = t[6] >= 10000 ? Math.round(t[6] / 1000) + "k" : t[6] >= 1000 ? (t[6] / 1000).toFixed(1) + "k" : t[6];
  return `<span class="hb ${cls}" title="SatNOGS: ${pct}% of ${t[7]} checked observations were good">♥ ${pct}% · ${n}</span>`;
}
let satListT = 0;
function renderSatList() {
  const box = $("satList"); if (!box) return;
  satListT = performance.now();
  if (!sat.list.length) { box.innerHTML = ""; return; }
  const now = satNow(); let html = "", any = false;
  for (const [title, rows] of sections()) {
    if (!rows.length) continue;
    any = true;
    html += `<div class="sh">${title}<span>${rows.length}</span></div>`;
    for (const r of rows) {
      const p = r.p, isUp = p && (p.always || p.aos <= now), el = p && !p.always ? p.maxEl : null;
      const elc = el == null ? "" : el >= 45 ? "ok" : el >= 20 ? "mid" : "low";
      const prog = isUp && !p.always ? `<i class="prog"><b style="width:${(100 * (now - p.aos) / (p.los - p.aos)).toFixed(0)}%"></b></i>` : "";
      const what = r.t ? fmtF(r.t[2]) + " " + esc(r.t[1]) + (inEsp(r.t[2]) ? "" : " · not on the ESP32-S3") : "";
      html += `<div class="srow${state.satSel === r.s.n ? " sel" : ""}" data-n="${r.s.n}">
        <div class="sm"><div class="sn">${esc(r.s.name)}${r.s.hu ? '<em class="hu">HU</em>' : ""}</div>
        <div class="sp${isUp ? " up" : ""}">${isUp ? "<i class=\"dot\"></i>" : ""}${passText(p, now)}</div>${prog}
        <div class="sx">${healthBadge(r.t)}${what}</div></div>
        ${el != null ? `<div class="se ${elc}"><b>${Math.round(el)}°</b><span>max</span></div>` : ""}
        <button class="star${r.fav ? " on" : ""}" data-star="${r.s.n}" type="button" aria-label="Favourite">${r.fav ? "★" : "☆"}</button></div>`;
    }
  }
  if (!any) html = `<p class="note pad">${sat.working ? "Working out the passes…" : "No satellite for this filter. Try <b>All bands</b>, or search by name."}</p>`;
  box.innerHTML = html;
}
function renderSatHead() {
  const el = $("satHead"); if (!el) return;
  el.textContent = sat.status || (sat.list.length ? sat.list.length + " satellites · data " + dataAge() : "");
}

// ---- selected satellite: card, live Doppler, tracking
function selTx(s) {
  if (!s) return null;
  const shown = s.tx.filter(txShown);
  const pool = shown.length ? shown : s.tx;
  return pool[Math.min(state.satTx || 0, pool.length - 1)] || null;
}
function selectSat(n) {
  if (state.satSel === n) return;
  state.satSel = n; state.satTx = 0; save();
  const s = satSel(), t = selTx(s);
  if (s && t && inEsp(t[2])) { state.satTrack = true; save(); }
  sat.trackStarted = false;
  updateSatCard(); renderSatList(); showRadar(true);
}
function updateSatLive() {
  const s = satSel();
  if (!s) { sat.live = null; return; }
  const now = satNow(), l = lookAt(s, now, station()), t = selTx(s);
  const f0 = t ? t[2] : 0, dop = l ? -f0 * l.rr / C_KMS : 0;
  sat.live = { look: l, f: f0 + dop, f0, dop, t };
  // Tracking: the Doppler marker follows the satellite; the receiver moves when it leaves the middle
  if (state.satTrack && t && inEsp(sat.live.f) && mode !== "flash") {
    const v = view(), m = (v.b - v.a) * 0.18;
    if (!sat.trackStarted || sat.live.f < v.a + m || sat.live.f > v.b - m) {
      sat.trackStarted = true;
      setFreq(Math.round(sat.live.f / 1e5) * 1e5, "track");
    }
  }
  viewDirty = true;
}
function updateSatCard() {
  const card = $("satCard"), s = satSel();
  card.hidden = !s;
  if (!s) { showRadar(false); return; }
  const p = (sat.passes.get(s.n) || {}).pass, now = satNow(), lv = sat.live, t = selTx(s);
  $("scName").innerHTML = esc(s.name) + (s.hu ? '<em class="hu">HU</em>' : "") + ` <span class="norad">#${s.n}</span>`;
  const txs = s.tx.filter(txShown).length ? s.tx.filter(txShown) : s.tx;
  const sel = $("scTx");
  const opts = txs.map((x, i) => `<option value="${i}">${fmtF(x[2])} ${esc(x[1])}${x[0] ? " · " + esc(x[0]) : ""}</option>`).join("");
  if (sel.dataset.k !== s.n + "/" + txs.length + "/" + state.satBand) { sel.innerHTML = opts; sel.dataset.k = s.n + "/" + txs.length + "/" + state.satBand; }
  sel.value = String(Math.min(state.satTx || 0, txs.length - 1));
  const l = lv && lv.look;
  $("scNow").textContent = l ? (l.el > 0 ? "Up: " : "Below the horizon: ") + "az " + l.az.toFixed(0) + "°, el " + l.el.toFixed(0) + "°, " + Math.round(l.range) + " km" : "";
  $("scPass").textContent = passText(p, now) + (p && !p.always ? " · max " + Math.round(p.maxEl) + "°" : "");
  if (t && lv) {
    const ok = inEsp(t[2]);
    $("scDop").innerHTML = "Doppler <b>" + (lv.dop >= 0 ? "+" : "") + (lv.dop / 1e3).toFixed(1) + " kHz</b> → " + fmtF(lv.f) +
      (ok ? "" : '<br><span class="warnt">This downlink is outside the ESP32-S3\'s 2204–2804 MHz: pass and radar only.</span>');
  } else $("scDop").textContent = "";
  $("scStar").textContent = state.favs.includes(s.n) ? "★" : "☆";
  $("scStar").classList.toggle("on", state.favs.includes(s.n));
  $("scTrack").textContent = state.satTrack ? "Tracking on" : "Track";
  $("scTrack").classList.toggle("primary", !!state.satTrack); $("scTrack").classList.toggle("trk", !!state.satTrack);
  $("scTrack").disabled = !(t && inEsp(t[2]));
  $("scSim").textContent = sat.shift ? "Back to real time" : "Simulate the next pass";
  $("simChip").hidden = !sat.shift;
  if (sat.shift) $("simChip").textContent = "Simulated time " + clock(now);
}
function toggleFav(n) {
  const i = state.favs.indexOf(n);
  if (i >= 0) state.favs.splice(i, 1); else state.favs.push(n);
  save(); renderSatList(); updateSatCard();
}
function simulatePass() {
  if (sat.shift) { sat.shift = 0; }
  else {
    const s = satSel(), p = s && (sat.passes.get(s.n) || {}).pass;
    if (!p || p.always) { toast("No pass to simulate."); return; }
    if (p.aos <= satNow()) { toast("It is overhead now."); return; }
    sat.shift = p.aos - 45 - Date.now() / 1000;
  }
  sat.trackStarted = false;
  sat.passes.clear(); schedulePasses(); updateSatLive(); updateSatCard();
}

// ---- drawing on the spectrum and the waterfall
function drawSatOverlay(ctx, v, W, ph, dpr) {
  const line = $("satLine"), lv = sat.live;
  if (!lv || !lv.t || !lv.look) { line.hidden = true; return; }
  const span = v.b - v.a, f = lv.f;
  if (f < v.a || f > v.b) { line.hidden = true; return; }
  const x = Math.round((f - v.a) / span * W) + 0.5, up = lv.look.el > 0;
  const col = up ? "#5cc88a" : "rgba(92,200,138,0.45)";
  ctx.strokeStyle = col; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ph); ctx.stroke(); ctx.setLineDash([]);
  const s = satSel(), label = s.name + "  " + (lv.dop >= 0 ? "+" : "") + (lv.dop / 1e3).toFixed(1) + " kHz";
  ctx.font = (11 * dpr) + "px 'IBM Plex Mono', monospace"; ctx.textBaseline = "top";
  const tw = ctx.measureText(label).width, lx = Math.min(W - tw - 8 * dpr, x + 6 * dpr);
  const ly = ph - 22 * dpr;
  ctx.fillStyle = "rgba(7,10,12,0.8)"; ctx.fillRect(lx - 3 * dpr, ly - 2 * dpr, tw + 6 * dpr, 16 * dpr);
  ctx.fillStyle = col; ctx.textAlign = "left"; ctx.fillText(label, lx, ly);
  line.hidden = false; line.style.left = (100 * (f - v.a) / span) + "%"; line.classList.toggle("down", !up);
}
// The demo source adds the selected satellite's signal while it is up
function satDemoSignal() {
  const lv = sat.live;
  if (!lv || !lv.t || !lv.look || lv.look.el <= 0) return null;
  return { f: lv.f, p: -50 + Math.min(1, lv.look.el / 60) * 18, wide: lv.t[4] > 2000 ? Math.min(60e3, lv.t[4] * 1.5) : 0 };
}

// ---- radar
function showRadar(on) { $("radar").hidden = !on || !satSel(); }
function drawRadar() {
  const box = $("radar"); if (box.hidden) return;
  const cv = $("radarCv"), dpr = Math.min(window.devicePixelRatio || 1, 2), size = box.classList.contains("big") ? 300 : 176;
  if (cv.width !== size * dpr) { cv.width = cv.height = size * dpr; cv.style.width = cv.style.height = size + "px"; }
  const g = cv.getContext("2d"), W = cv.width, c = W / 2, R = W / 2 - 16 * dpr;
  const head = sat.compass.mode === "on" && sat.compass.heading != null ? sat.compass.heading : 0;
  const pt = (az, el) => { const r = R * (90 - Math.max(0, el)) / 90, a = (az - head) * RAD; return [c + r * Math.sin(a), c - r * Math.cos(a)]; };
  g.clearRect(0, 0, W, W);
  g.fillStyle = "rgba(6,12,10,0.88)"; g.beginPath(); g.arc(c, c, R + 12 * dpr, 0, 7); g.fill();
  g.strokeStyle = "rgba(92,200,138,0.35)"; g.lineWidth = 1 * dpr;
  for (const e of [0, 30, 60]) { g.beginPath(); g.arc(c, c, R * (90 - e) / 90, 0, 7); g.stroke(); }
  for (let k = 0; k < 4; k++) { const [x, y] = pt(k * 90, 0); g.beginPath(); g.moveTo(c, c); g.lineTo(x, y); g.stroke(); }
  g.fillStyle = "#9fb0b8"; g.font = (10 * dpr) + "px 'IBM Plex Mono', monospace"; g.textAlign = "center"; g.textBaseline = "middle";
  [["N", 0], ["E", 90], ["S", 180], ["W", 270]].forEach(([t, az]) => { const r = R + 7 * dpr, a = (az - head) * RAD; g.fillStyle = t === "N" ? "#e5624f" : "#9fb0b8"; g.fillText(t, c + r * Math.sin(a), c - r * Math.cos(a)); });
  const s = satSel(), st = station(), now = satNow();
  // other satellites up now
  g.fillStyle = "rgba(160,176,186,0.7)";
  for (const [n, e] of sat.passes) {
    if (n === state.satSel || !e.pass || e.pass.always || e.pass.aos > now || e.pass.los < now) continue;
    const o = sat.byId.get(n), l = o && lookAt(o, now, st); if (!l || l.el <= 0) continue;
    const [x, y] = pt(l.az, l.el); g.beginPath(); g.arc(x, y, 2.5 * dpr, 0, 7); g.fill();
  }
  if (s) {
    const p = (sat.passes.get(s.n) || {}).pass;
    if (p && !p.always) {   // this pass, start to end
      g.strokeStyle = "#ffc83c"; g.lineWidth = 2 * dpr; g.beginPath(); let first = true;
      const dt = Math.max(10, (p.los - p.aos) / 60);
      for (let t = p.aos; t <= p.los + 0.1; t += dt) { const l = lookAt(s, t, st); if (!l) continue; const [x, y] = pt(l.az, l.el); if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); }
      g.stroke();
      const a = pt(p.aosAz, 0), b = pt(p.losAz, 0);
      g.fillStyle = "#5cc88a"; g.beginPath(); g.arc(a[0], a[1], 3.5 * dpr, 0, 7); g.fill();
      g.fillStyle = "#e5624f"; g.beginPath(); g.arc(b[0], b[1], 3.5 * dpr, 0, 7); g.fill();
    }
    const l = sat.live && sat.live.look;
    if (l && l.el > 0) {
      const [x, y] = pt(l.az, l.el);
      g.fillStyle = "rgba(255,200,60,0.25)"; g.beginPath(); g.arc(x, y, 10 * dpr, 0, 7); g.fill();
      g.fillStyle = "#ffc83c"; g.beginPath(); g.arc(x, y, 5 * dpr, 0, 7); g.fill();
    }
    // where the phone points (top of the radar when the compass works)
    if (sat.compass.mode === "on") { g.fillStyle = "#4fb3ff"; g.beginPath(); g.moveTo(c, 4 * dpr); g.lineTo(c - 6 * dpr, 14 * dpr); g.lineTo(c + 6 * dpr, 14 * dpr); g.closePath(); g.fill(); }
  }
  // text under the radar: compass state and aiming help
  let txt = "", cls = "";
  if (sat.compass.mode === "on") {
    cls = "ok"; txt = "Compass · heading " + Math.round(head) + "°";
    const l = sat.live && sat.live.look;
    if (l && l.el > 0) { let d = ((l.az - head + 540) % 360) - 180; txt += d > 8 ? " · turn right " + Math.round(d) + "°" : d < -8 ? " · turn left " + Math.round(-d) + "°" : " · on target"; txt += ", up " + Math.round(l.el) + "°"; }
  } else if (sat.compass.mode === "ask") { cls = "warn"; txt = "Tap to use the compass"; }
  else { cls = "warn"; txt = "No compass: north-up radar (simple mode)"; }
  const b = $("radarBadge"); b.textContent = txt; b.className = "rbadge " + cls;
}
function bindRadar() {
  const box = $("radar"); let d = null;
  box.addEventListener("pointerdown", (e) => { box.setPointerCapture(e.pointerId); d = { x: e.clientX, y: e.clientY, l: box.offsetLeft, t: box.offsetTop, moved: false }; });
  box.addEventListener("pointermove", (e) => {
    if (!d) return; const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
    if (d.moved) { const p = box.parentElement.getBoundingClientRect(); box.style.left = Math.max(0, Math.min(p.width - box.offsetWidth, d.l + dx)) + "px"; box.style.top = Math.max(0, Math.min(p.height - box.offsetHeight, d.t + dy)) + "px"; }
  });
  box.addEventListener("pointerup", () => {
    if (d && !d.moved) { if (sat.compass.mode === "ask") askCompass(); else box.classList.toggle("big"); }
    d = null;
  });
}

// ---- compass (phones): absolute device orientation; desktops have none and the radar stays north-up
const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (window.matchMedia && matchMedia("(pointer: coarse)").matches && "ontouchstart" in window);
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;               // iOS
  else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;                      // Android: absolute alpha
  if (h == null || Number.isNaN(h)) return;
  const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  h = (h + so + 360) % 360;
  const c = sat.compass;
  c.heading = c.heading == null ? h : c.heading + ((((h - c.heading) + 540) % 360) - 180) * 0.25;   // smooth
  c.heading = (c.heading + 360) % 360; c.last = performance.now(); c.mode = "on";
}
function startCompass() {
  const c = sat.compass;
  if (!isMobile() || !("DeviceOrientationEvent" in window)) { c.mode = "none"; return; }
  if (typeof DeviceOrientationEvent.requestPermission === "function" && !c.perm) { c.mode = "ask"; return; }   // iOS asks on a tap
  window.addEventListener("deviceorientationabsolute", onOrientation);
  window.addEventListener("deviceorientation", onOrientation);
  c.mode = "wait";
  setTimeout(() => { if (c.mode === "wait") { c.mode = "none"; log("compass: no absolute orientation from this device"); } }, 2500);
}
async function askCompass() {
  try { const r = await DeviceOrientationEvent.requestPermission(); sat.compass.perm = r === "granted"; } catch (e) { sat.compass.perm = false; }
  if (sat.compass.perm) startCompass(); else sat.compass.mode = "none";
}

// ---- where we are: GPS on phones, the browser's location on computers, or typed in
let geoWatch = null;
function requestLocation(user) {
  if (!navigator.geolocation) { setLocNote("This browser cannot tell the location: type it in."); return; }
  const mobile = isMobile();
  const ok = (p) => {
    const acc = p.coords.accuracy || 0;
    state.loc = { lat: p.coords.latitude, lon: p.coords.longitude, alt: p.coords.altitude || state.loc.alt || 0, src: mobile && acc < 150 ? "gps" : "browser", acc };
    save(); renderLoc(); sat.passes.clear(); schedulePasses();
  };
  const bad = (e) => {
    log("location: " + e.message);
    if (state.loc.src === "manual") return;
    setLocNote(e.code === 1 ? "Location not allowed: type it in (or allow it in the browser and press ⌖)." : "No location yet: type it in or try ⌖ again.");
  };
  if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  if (mobile) geoWatch = navigator.geolocation.watchPosition(ok, bad, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  else navigator.geolocation.getCurrentPosition(ok, bad, { enableHighAccuracy: false, maximumAge: 600000, timeout: 20000 });
  if (user) setLocNote(mobile ? "Asking for the GPS…" : "Asking the browser for the location…");
}
function setLocNote(t) { $("locNote").textContent = t; }
function renderLoc() {
  const l = state.loc;
  const src = l.src === "gps" ? "GPS ±" + Math.round(l.acc) + " m" : l.src === "browser" ? "browser location ±" + (l.acc >= 1000 ? (l.acc / 1000).toFixed(1) + " km" : Math.round(l.acc) + " m") : l.src === "manual" ? "set by hand" : "default: Budapest";
  $("locText").innerHTML = `<b>${Math.abs(l.lat).toFixed(3)}° ${l.lat >= 0 ? "N" : "S"} ${Math.abs(l.lon).toFixed(3)}° ${l.lon >= 0 ? "E" : "W"}</b> · ${toLocator(l.lat, l.lon)} · ${src}`;
  $("locLat").value = l.lat.toFixed(4); $("locLon").value = l.lon.toFixed(4); $("locAlt").value = Math.round(l.alt || 0); $("locLoc").value = toLocator(l.lat, l.lon);
  setLocNote(l.src === "default" ? "Press ⌖ to use your location, or type it in." : "");
}
function setManualLoc(lat, lon, alt) {
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { setLocNote("Latitude −90…90, longitude −180…180."); return; }
  if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null; }
  state.loc = { lat, lon, alt: alt || 0, src: "manual", acc: 0 }; save(); renderLoc();
  sat.passes.clear(); schedulePasses();
}

// ---- wiring
function initSats() {
  if (!state.loc || typeof state.loc.lat !== "number") state.loc = { lat: 47.4979, lon: 19.0402, alt: 120, src: "default", acc: 0 };
  if (!Array.isArray(state.favs)) state.favs = [];
  renderLoc();
  $("locBtn").addEventListener("click", () => requestLocation(true));
  $("locEdit").addEventListener("click", () => { $("locForm").hidden = !$("locForm").hidden; });
  $("locSet").addEventListener("click", () => setManualLoc(parseFloat($("locLat").value.replace(",", ".")), parseFloat($("locLon").value.replace(",", ".")), parseFloat($("locAlt").value) || 0));
  $("locLocSet").addEventListener("click", () => { const p = fromLocator($("locLoc").value); if (p) setManualLoc(p.lat, p.lon, state.loc.alt); else setLocNote("A locator looks like JN97 or JN97mm."); });
  $("satRefresh").addEventListener("click", () => loadSats(true));
  $("satSearch").value = state.satSearch || "";
  $("satSearch").addEventListener("input", () => { state.satSearch = $("satSearch").value; save(); schedulePasses(); renderSatList(); });
  segInit("satBandSeg", "satBand", String, () => { schedulePasses(); renderSatList(); updateSatCard(); });
  segInit("satSortSeg", "satSort", String, renderSatList);
  $("satList").addEventListener("click", (e) => {
    const st = e.target.closest("[data-star]"); if (st) { toggleFav(Number(st.dataset.star)); return; }
    const r = e.target.closest(".srow"); if (r) { selectSat(Number(r.dataset.n)); if (isNarrow()) setSats(false); }
  });
  $("scStar").addEventListener("click", () => state.satSel && toggleFav(state.satSel));
  $("scClose").addEventListener("click", () => { state.satSel = null; state.satTrack = false; save(); sat.live = null; updateSatCard(); renderSatList(); viewDirty = true; });
  $("scTx").addEventListener("change", () => { state.satTx = Number($("scTx").value); save(); sat.trackStarted = false; updateSatLive(); updateSatCard(); });
  $("scTrack").addEventListener("click", () => { state.satTrack = !state.satTrack; sat.trackStarted = false; save(); updateSatLive(); updateSatCard(); });
  $("scSim").addEventListener("click", simulatePass);
  $("satsBtn").addEventListener("click", () => setSats(!$("sats").classList.contains("open")));
  bindRadar();
  startCompass();
  if (state.loc.src !== "manual") requestLocation(false);
  loadSats(false);
  setInterval(() => { updateSatLive(); updateSatCard(); }, 250);
  setInterval(drawRadar, 100);
  setInterval(() => { schedulePasses(); if (performance.now() - satListT > 900) renderSatList(); }, 1000);
}
function setSats(open) {
  $("sats").classList.toggle("open", open); $("satsBtn").setAttribute("aria-expanded", String(open));
  $("scrim").hidden = !open && !$("rack").classList.contains("open");
}
