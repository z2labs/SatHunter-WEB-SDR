"""The page without WebUSB and Web Serial (as in Firefox) through a fake SatHunter Bridge
(test/mock_bridge.mjs): the RTL-SDR starts by itself, spectrum and audio point; the ESP32-S3
board connects; a blank board gets its firmware. Runs in Chromium with WebUSB / Web Serial removed,
and in Firefox when Playwright has it (python -m playwright install firefox)."""
import asyncio, json, os, sys, pathlib, subprocess, hashlib
ROOT = str(pathlib.Path(__file__).resolve().parent.parent)
os.chdir(ROOT)
PAGE = pathlib.Path(ROOT, "index.html").as_uri()
DATA = json.load(open("test/fixtures/sats.json"))
FW = os.path.join(ROOT, "fw") + "/"
FILES = {0x0: FW + "bootloader/bootloader.bin", 0x8000: FW + "partition_table/partition-table.bin", 0x10000: FW + "esp_sdr.bin"}
from playwright.async_api import async_playwright

NO_NATIVE = "try { delete Navigator.prototype.usb; delete Navigator.prototype.serial; } catch (e) {}"

def start_bridge(*args):
    p = subprocess.Popen(["node", "test/mock_bridge.mjs", *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    line = p.stdout.readline().strip()
    assert line == "READY", ("mock bridge did not start", line, p.stderr.read() if p.poll() is not None else "")
    return p

def stop_bridge(p):
    p.terminate()
    try: p.wait(5)
    except subprocess.TimeoutExpired: p.kill()

async def board_state(pg):
    # ask the mock bridge directly what the board holds
    return await pg.evaluate("""(async () => { const c = await SatBridge.Conn.open(2000); try { return await c.request("test.board"); } finally { c.close(); } })()""")

async def new_page(b):
    ctx = await b.new_context(viewport={"width": 1440, "height": 860}, geolocation={"latitude": 47.4979, "longitude": 19.0402, "accuracy": 30}, permissions=["geolocation"])
    pg = await ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    await pg.add_init_script("window.__SAT_DATA = " + json.dumps(DATA) + ";")
    await pg.add_init_script(NO_NATIVE)
    return ctx, pg, errs

async def rtl_and_board(b, name):
    br = start_bridge()
    try:
        ctx, pg, errs = await new_page(b)
        await pg.goto(PAGE)
        print(name, "| WebUSB:", await pg.evaluate("'usb' in navigator"), "Web Serial:", await pg.evaluate("'serial' in navigator"))
        assert not await pg.evaluate("'usb' in navigator || 'serial' in navigator")
        await pg.wait_for_timeout(3000)
        print(name, "| auto started:", await pg.evaluate("mode"), "| bridge:", await pg.evaluate("SatBridge.available"))
        if await pg.evaluate("mode") != "rtl":
            await pg.click("#rtlTopBtn"); await pg.wait_for_timeout(3000)
        assert await pg.evaluate("mode") == "rtl", await pg.inner_text("#srcNote")
        assert await pg.evaluate("source.dev instanceof SatBridge.BridgeUSBDevice")
        info = await pg.inner_text("#fwInfo"); print(name, "| fw:", info, "| tune:", await pg.inner_text("#tuneInfo"))
        assert "Blog V4" in info and "R828D" in info, info
        await pg.wait_for_timeout(1500)
        frames = await pg.evaluate("source.stats.frames"); mb = await pg.evaluate("source.stats.bytes") / 1e6
        print(name, f"| frames: {frames}, {mb:.1f} MB IQ")
        assert frames > 20, frames
        peak = await pg.evaluate("(() => { let best=-1e9, bf=0; for (let j=0;j<data.n;j++){ if (data.avg[j]>best){best=data.avg[j]; bf=data.c-data.fs/2+(j+0.5)*data.fs/data.n;} } return bf - data.c; })()")
        print(name, "| carrier at", round(peak), "Hz from the centre")
        assert abs(peak - 250000) < 5000, peak
        # retune through the bridge
        await pg.evaluate("setFreq(145.8e6)"); await pg.wait_for_timeout(1200)
        print(name, "| tune after retune:", await pg.inner_text("#tuneInfo"))
        # the ESP32-S3 board through the bridge
        await pg.click("#connectBtn")
        for _ in range(40):
            await pg.wait_for_timeout(250)
            if await pg.evaluate("mode") == "serial" and await pg.evaluate("source.stats.frames") > 10: break
        print(name, "| board:", await pg.evaluate("mode"), "| fw:", await pg.inner_text("#fwInfo"), "| frames:", await pg.evaluate("source.stats.frames"))
        assert await pg.evaluate("mode") == "serial", await pg.inner_text("#srcNote")
        assert await pg.evaluate("source.port instanceof SatBridge.BridgeSerialPort")
        assert await pg.evaluate("source.stats.frames") > 10
        await pg.evaluate("disconnect()"); await pg.wait_for_timeout(500)
        print(name, "| errors:", errs)
        assert not errs, errs
        await ctx.close()
    finally:
        stop_bridge(br)

async def flash_blank(b, name):
    br = start_bridge("--blank-board", "--no-rtl")
    try:
        ctx, pg, errs = await new_page(b)
        await pg.goto(PAGE)
        await pg.wait_for_timeout(2500)
        await pg.click("#connectBtn")
        for _ in range(60):
            await pg.wait_for_timeout(250)
            if not await pg.is_disabled("#connectBtn"): break
        print(name, "| blank board:", await pg.inner_text("#srcNote"))
        await pg.click("#flashBtn"); await pg.click("#flashBtn")
        for _ in range(480):
            await pg.wait_for_timeout(250)
            if not await pg.is_visible("#flashProg"): break
        print(name, "| flash:", await pg.inner_text("#flashResult"))
        await pg.wait_for_timeout(4000)
        st = await board_state(pg)
        ok = True
        for off, p in FILES.items():
            want = open(p, "rb").read(); got = st["flash"].get(str(off), {})
            same = got.get("md5") == hashlib.md5(want).hexdigest() and got.get("len") == len(want); ok &= same
            print(name, f"|   0x{off:x} {p.split('/')[-1]}: {got.get('len')} bytes, {'match' if same else 'MISMATCH'}")
        print(name, "| board mode:", st["mode"], "| page:", await pg.evaluate("mode"), await pg.inner_text("#chipText"))
        assert ok and st["mode"] == "app", st
        assert await pg.evaluate("mode") == "serial"
        print(name, "| errors:", errs)
        assert not errs, errs
        await ctx.close()
    finally:
        stop_bridge(br)

async def chrome_tv_driver(b):
    """Chrome on Linux with the TV driver on the stick: WebUSB cannot claim it, the page turns to
    the bridge by itself and keeps using it next time."""
    br = start_bridge()
    try:
        ctx = await b.new_context(viewport={"width": 1440, "height": 860})
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.add_init_script("window.__SAT_DATA = " + json.dumps(DATA) + "; window.__mockRtlOptions = {blogV4: true};")
        await pg.add_init_script(path="test/mock_usb.js")
        await pg.add_init_script("""for (const d of window.__mockRtlDevices) d.claimInterface = async () => { const e = new Error("Unable to claim interface."); e.name = "NetworkError"; throw e; };""")
        await pg.goto(PAGE)
        await pg.wait_for_timeout(2500)
        print("chrome+TV driver | auto start:", await pg.evaluate("mode"), "|", await pg.inner_text("#srcNote"))
        if await pg.evaluate("mode") != "rtl":
            await pg.click("#rtlTopBtn"); await pg.wait_for_timeout(3000)
        print("chrome+TV driver | mode:", await pg.evaluate("mode"), "| via bridge:", await pg.evaluate("!!(source && source.dev instanceof SatBridge.BridgeUSBDevice)"), "| remembered:", await pg.evaluate("state.bridge"))
        assert await pg.evaluate("mode") == "rtl" and await pg.evaluate("source.dev instanceof SatBridge.BridgeUSBDevice") and await pg.evaluate("state.bridge")
        await pg.wait_for_timeout(1000)
        assert await pg.evaluate("source.stats.frames") > 10
        # next visit: straight to the bridge, no WebUSB attempt
        await pg.reload(); await pg.wait_for_timeout(3000)
        print("chrome+TV driver | after reload:", await pg.evaluate("mode"), "via bridge:", await pg.evaluate("!!(source && source.dev instanceof SatBridge.BridgeUSBDevice)"))
        assert await pg.evaluate("mode") == "rtl" and await pg.evaluate("source.dev instanceof SatBridge.BridgeUSBDevice")
        assert not errs, errs
        await ctx.close()
    finally:
        stop_bridge(br)

async def main():
    async with async_playwright() as p:
        browsers = [("chromium", await p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"]))]
        try:
            browsers.append(("firefox", await p.firefox.launch(firefox_user_prefs={"media.autoplay.default": 0})))
        except Exception as e:
            if os.environ.get("REQUIRE_FIREFOX"): raise
            print("firefox: not installed here, skipped (" + str(e).splitlines()[0][:80] + ")")
        await chrome_tv_driver(browsers[0][1])
        for name, b in browsers:
            await rtl_and_board(b, name)
            await flash_blank(b, name)
            await b.close()
    print("BRIDGE TEST PASS (" + ", ".join(n for n, _ in browsers) + ")")

asyncio.run(main())
