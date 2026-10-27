"""RTL-SDR over WebUSB against the mock stick (Blog V4): connect, spectrum, listening point,
satellite tracking moves it, settings, unplug back to demo."""
import asyncio, json, os, sys, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
DATA = json.load(open("test/fixtures/sats.json"))
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        ctx = await b.new_context(viewport={"width": 1440, "height": 860}, geolocation={"latitude": 47.4979, "longitude": 19.0402, "accuracy": 30}, permissions=["geolocation"])
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script("window.__SAT_DATA = " + json.dumps(DATA) + "; window.__mockRtlOptions = {blogV4: true, carrierOffsetHz: 250000, carrierAmp: 50};")
        await pg.add_init_script(path="test/mock_usb.js")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(1200)
        # a stick the page may use already starts by itself; otherwise connect it
        await pg.wait_for_timeout(1500)
        print("auto started:", await pg.evaluate("mode"))
        if await pg.evaluate("mode") != "rtl":
            await pg.click("#rtlTopBtn")
        await pg.wait_for_timeout(2500)
        info = await pg.inner_text("#fwInfo"); tune = await pg.inner_text("#tuneInfo"); chip = await pg.inner_text("#chipText")
        print("fw:", info, "| tune:", tune, "| chip:", chip)
        assert "Blog V4" in info and "R828D" in info, info
        assert await pg.evaluate("mode") == "rtl"
        print("range:", await pg.evaluate("[FMIN, FMAX]"), "freq:", await pg.evaluate("state.freqHz"), "span:", await pg.evaluate("state.span"))
        frames = await pg.evaluate("source.stats.frames"); print("frames:", frames)
        assert frames > 20, frames
        peak = await pg.evaluate("(() => { let best=-1e9, bf=0; for (let j=0;j<data.n;j++){ if (data.avg[j]>best){best=data.avg[j]; bf=data.c-data.fs/2+(j+0.5)*data.fs/data.n;} } return bf - data.c; })()")
        print("peak offset:", peak)
        assert abs(peak - 250000) < 5000, peak
        # tap the spectrum: listening point
        box = await pg.locator("#spec").bounding_box()
        await pg.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + 60)
        await pg.wait_for_timeout(300)
        print("vfo:", await pg.evaluate("vfoHz()"), "| listen:", await pg.inner_text("#audioState"))
        # gain, bias tee, rate
        await pg.evaluate("$('#rack') && showRack()")
        await pg.fill("#gainIn", "20"); await pg.dispatch_event("#gainIn", "input")
        await pg.check("#biasTee")
        await pg.click("#spanSeg button[data-v='1024000']")
        await pg.wait_for_timeout(1200)
        print("tune:", await pg.inner_text("#tuneInfo"))
        assert "1.024" in await pg.inner_text("#tuneInfo") and "bias tee on" in await pg.inner_text("#tuneInfo")
        # satellites: ISS (145.825) is receivable now; select and track it, the listening point follows Doppler
        lst = await pg.inner_text("#satList"); print("list:", lst.replace("\n", " | ")[:300])
        assert "ISS" in lst
        await pg.click(".srow[data-n='25544']"); await pg.wait_for_timeout(800)
        await pg.click("#scSim"); await pg.wait_for_timeout(400)
        await pg.evaluate("(() => { const p = sat.passes.get(25544).pass; sat.shift += p.tmax - satNow(); })()")
        await pg.wait_for_timeout(1500)
        st = await pg.evaluate("({vfo: vfoHz(), f: sat.live.f, c: state.freqHz, mode: state.rtlMode, track: state.satTrack})")
        print("tracking:", st)
        assert abs(st["vfo"] - st["f"]) < 100 and st["mode"] == "NFM"
        await pg.screenshot(path="test/rtlweb.png")
        # unplug -> demo
        await pg.click("#rtlTopBtn"); await pg.wait_for_timeout(1200)
        print("after disconnect:", await pg.evaluate("mode"), await pg.evaluate("[FMIN, FMAX]"))
        assert await pg.evaluate("mode") == "demo"
        print("errors:", errs)
        await b.close()
        if errs: sys.exit(1)
asyncio.run(main())
