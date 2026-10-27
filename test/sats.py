"""Satellite features: data, list, selection, Doppler marker, radar (north-up without a compass),
location from the browser, simulated pass with the demo signal."""
import asyncio, json, os, sys, pathlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
DATA = json.load(open("test/fixtures/sats.json"))
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1440, "height": 860}, geolocation={"latitude": 47.4979, "longitude": 19.0402, "accuracy": 2500}, permissions=["geolocation"])
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script("window.__SAT_DATA = " + json.dumps(DATA) + ";")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(2500)
        loc = await pg.inner_text("#locText")
        print("location:", loc)
        assert "browser location" in loc, loc
        head = await pg.inner_text("#satHead"); print("head:", head)
        lst = await pg.inner_text("#satList"); print("list (ESP band):", lst.replace("\n", " | ")[:400])
        assert "SBANDSAT-1" in lst and "ISS" not in lst, lst
        await pg.click("#satBandSeg button[data-v='all']"); await pg.wait_for_timeout(1500)
        lst = await pg.inner_text("#satList"); print("list (all):", lst.replace("\n", " | ")[:500])
        assert "ISS" in lst and "HUNSAT" in lst
        await pg.click("#satSortSeg button[data-v='health']"); await pg.wait_for_timeout(500)
        first = await pg.inner_text("#satList .srow .sn"); print("best heard first:", first)
        assert first.startswith("ISS"), first
        await pg.click("#satSortSeg button[data-v='pass']"); await pg.wait_for_timeout(300)
        await pg.click("#satBandSeg button[data-v='esp']"); await pg.wait_for_timeout(800)
        await pg.click(".srow[data-n='90001']"); await pg.wait_for_timeout(800)
        print("card:", (await pg.inner_text("#satCard")).replace("\n", " | "))
        assert not await pg.is_hidden("#radar")
        badge = await pg.inner_text("#radarBadge"); print("radar badge:", badge)
        assert "north-up" in badge
        print("tuned:", await pg.evaluate("state.freqHz"), "track:", await pg.evaluate("state.satTrack"))
        await pg.click("#scStar"); await pg.wait_for_timeout(300)
        sec = await pg.inner_text("#satList .sh"); print("first section:", sec)
        assert sec.lower().startswith("favourites")
        await pg.click("#scSim"); await pg.wait_for_timeout(500)
        # jump on to the top of the pass (the simulation runs in real time from 45 s before it)
        await pg.evaluate("(() => { const p = sat.passes.get(90001).pass; sat.shift += p.tmax - satNow(); })()")
        await pg.wait_for_timeout(2500)
        print("sim chip:", await pg.inner_text("#simChip"))
        print("card:", (await pg.inner_text("#satCard")).replace("\n", " | "))
        live = await pg.evaluate("sat.live && {el: sat.live.look.el, f: sat.live.f, dop: sat.live.dop}")
        print("live:", live, "freq", await pg.evaluate("state.freqHz"))
        assert live["el"] > 0, live
        # the demo shows the satellite: strongest bin near the Doppler-corrected frequency
        peak = await pg.evaluate("""(() => { const v = view(); let best=-1e9, bf=0; for (let j=0;j<data.n;j++){ const f=data.c-data.fs/2+(j+0.5)*data.fs/data.n; if (Math.abs(f-sat.live.f) > 2e6) continue; if (data.avg[j]>best){best=data.avg[j]; bf=f;} } return {bf, best}; })()""")
        print("peak near sat:", peak)
        assert abs(peak["bf"] - live["f"]) < 100e3, peak
        await pg.screenshot(path="test/sats.png")
        # phone layout
        await pg.set_viewport_size({"width": 400, "height": 860}); await pg.wait_for_timeout(500)
        await pg.click("#satsBtn"); await pg.wait_for_timeout(500)
        await pg.screenshot(path="test/sats_phone.png")
        await pg.click("#scSim"); await pg.wait_for_timeout(300)
        print("errors:", errs)
        await b.close()
        if errs: sys.exit(1)
asyncio.run(main())
