"""Decoders and screen saver in the page, on the mock RTL-SDR: APRS and SSTV audio fed through the
page's decoder hook (as the NFM demodulator does), the panel shows the frame with its position and
the SSTV picture; the screen saver comes on, shows the summary and goes off with a tap."""
import asyncio, json, os, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
DATA = json.load(open("test/fixtures/sats.json"))
from playwright.async_api import async_playwright

# AFSK audio for one APRS UI frame and a Robot 36 picture, built in the page (same generators as test/decode.mjs)
GEN = r"""
(() => {
  const fs = 48000;
  const ui = (src, dst, path, info) => { const out = []; const addr = (c, last) => { const h = c.endsWith("*"), [call, ssid] = c.replace("*", "").split("-");
      for (let i = 0; i < 6; i++) out.push((call.charCodeAt(i) || 32) << 1); out.push(0x60 | ((Number(ssid) || 0) << 1) | (h ? 0x80 : 0) | (last ? 1 : 0)); };
    addr(dst, false); addr(src, !path.length); path.forEach((p, i) => addr(p, i + 1 === path.length)); out.push(0x03, 0xf0); for (const ch of info) out.push(ch.charCodeAt(0)); return out; };
  const frame = ui("HG0LAB-1", "APRS", ["RS0ISS*"], "!4729.87N/01902.41E>SatHunter web test");
  const c = crc16x25(frame, frame.length), data = [...frame, c & 0xff, c >> 8], bits = [];
  const flag = () => { for (let k = 0; k < 8; k++) bits.push((0x7e >> k) & 1); };
  for (let i = 0; i < 40; i++) flag(); let ones = 0;
  for (const b of data) for (let k = 0; k < 8; k++) { const bit = (b >> k) & 1; bits.push(bit); if (bit) { if (++ones === 5) { bits.push(0); ones = 0; } } else ones = 0; }
  for (let i = 0; i < 4; i++) flag(); let lv = 1; const lev = bits.map((b) => (b === 0 ? (lv ^= 1) : lv));
  const a = new Float32Array(9600 + Math.floor(lev.length * fs / 1200)); let ph = 0;
  for (let i = 0; i < a.length - 9600; i++) { ph += 2 * Math.PI * (lev[Math.floor(i * 1200 / fs)] ? 1200 : 2200) / fs; a[4800 + i] = 0.4 * Math.sin(ph); }
  for (let i = 0; i < a.length; i += 2048) decFeed(a.subarray(i, i + 2048), fs, "NFM");
  // Robot 36: colour bars
  const W = 320, H = 240, bars = [[255,255,255],[255,255,0],[0,255,255],[0,255,0],[255,0,255],[255,0,0],[0,0,255],[0,0,0]];
  const ycc = ([r, g, b]) => { const y = 0.299*r+0.587*g+0.114*b, cl = (v) => Math.round(Math.min(255, Math.max(0, v))); return [cl(y), cl(128+0.713*(r-y)), cl(128+0.564*(b-y))]; };
  const tones = [[0,0.1],[1900,0.3],[1200,0.01],[1900,0.3],[1200,0.03]]; let o1 = 0;
  for (let b = 0; b < 7; b++) { const o = (8 >> b) & 1; o1 += o; tones.push([o ? 1100 : 1300, 0.03]); } tones.push([o1 % 2 ? 1100 : 1300, 0.03], [1200, 0.03]);
  const L = (v) => 1500 + 800 * v / 255;
  for (let y = 0; y < H; y++) { tones.push([1200,0.009],[1500,0.003]); const p = (x) => bars[Math.floor(x * 8 / W)];
    for (let x = 0; x < W; x++) tones.push([L(ycc(p(x))[0]), 0.088 / W]); const even = y % 2 === 0; tones.push([even ? 1500 : 2300, 0.0045], [1900, 0.0015]);
    for (let x2 = 0; x2 < W / 2; x2++) { const c = ycc(p(2 * x2)); tones.push([L(even ? c[1] : c[2]), 0.044 / (W / 2)]); } }
  tones.push([0, 0.3]);
  const n = Math.round(tones.reduce((s, t) => s + t[1], 0) * fs), s = new Float32Array(n); let t = 0, k0 = 0; ph = 0;
  for (const [f, d] of tones) { const k1 = Math.round((t + d) * fs); for (let k = k0; k < k1; k++) { ph += 2 * Math.PI * f / fs; s[k] = f ? 0.6 * Math.sin(ph) : 0; } k0 = k1; t += d; }
  for (let i = 0; i < s.length; i += 4096) decFeed(s.subarray(i, i + 4096), fs, "NFM");
  return { aprs: dec.aprs.count, sstv: dec.sstv.done.length };
})()
"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        ctx = await b.new_context(viewport={"width": 1280, "height": 800})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script("window.__SAT_DATA = " + json.dumps(DATA) + "; window.__mockRtlOptions = {carrierOffsetHz: 250000, carrierAmp: 50};")
        await pg.add_init_script(path="test/mock_usb.js")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(2700)
        if await pg.evaluate("mode") != "rtl":
            await pg.click("#rtlTopBtn")
            await pg.wait_for_timeout(2500)
        assert await pg.evaluate("mode") == "rtl"
        await pg.evaluate("showRack()")
        await pg.check("#decAprs"); await pg.check("#decSstv")
        r = await pg.evaluate(GEN)
        print("fed:", r)
        await pg.wait_for_timeout(800)
        title = await pg.inner_text("#decTitle"); lines = await pg.inner_text("#decLines")
        print("panel:", title, "|", lines.replace("\n", " | "))
        assert r["aprs"] == 1 and r["sstv"] == 1, r
        assert "HG0LAB-1 > APRS via RS0ISS*: !4729.87N/01902.41E>SatHunter web test" in lines and "47.4978 19.0402" in lines, lines
        assert "Robot 36 240/240" in title, title
        px = await pg.evaluate("(() => { const d = $('sstvCv').getContext('2d').getImageData(20, 60, 1, 1).data; return [d[0], d[1], d[2]]; })()")
        print("SSTV first bar pixel:", px)
        assert min(px) > 200, px  # white bar
        await pg.screenshot(path="test/decweb.png")
        # screen saver: 1 min, pretend the last touch was 2 minutes ago
        await pg.select_option("#saverIn", "1")
        await pg.evaluate("saver.last = Date.now() - 120000")
        await pg.wait_for_timeout(1300)
        on = await pg.evaluate("!$('saver').hidden"); txt = await pg.inner_text("#saverBox")
        print("saver on:", on, "|", txt.replace("\n", " | "))
        assert on and "MHz" in txt and "SSTV Robot 36" in txt and "APRS 1" in txt
        await pg.screenshot(path="test/saver.png")
        await pg.mouse.click(400, 300)
        await pg.wait_for_timeout(300)
        assert await pg.evaluate("$('saver').hidden"), "tap did not wake"
        print("errors:", errs)
        assert not errs, errs
        await b.close()

asyncio.run(main())
