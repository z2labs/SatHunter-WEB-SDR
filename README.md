![SatHunter Web: hunt satellites in your browser](docs/banner.png)

# SatHunter Web SDR

**Open it: [z2labs.github.io/SatHunter-WEB-SDR](https://z2labs.github.io/SatHunter-WEB-SDR/)** (Chrome or Edge), or download [`index.html`](index.html) and open it from disk.

The browser sibling of [SatHunterSDR](https://github.com/z2labs/SatHunter-SDR), made for classrooms: pick a satellite, see when it comes over, where to point the antenna, and its signal with the Doppler shift on the live spectrum of an ESP32-S3 SDR. One HTML file, no install. It grew out of [Z2 Web SDR](https://github.com/z2labs/z2-web-sdr) and keeps all of it (16 / 40 / 80 MHz spectrum and GPU waterfall over Web Serial, firmware installer, export, debug report).

## Satellites

- **Data**: satellites, downlinks and TLEs from SatNOGS DB and CelesTrak, and how well the SatNOGS ground stations hear each downlink (SatNOGS Network). The site rebuilds `data/sats.json` every day; the page keeps a copy for offline use.
- **List**: *ESP32-S3 band* (downlinks in 2204–2804 MHz, the ones the board can receive) or *All bands* (pass planning only). Grouped as Favourites · Overhead now · Next 2 hours · Later today, or *Best heard* (most reliably received on SatNOGS first). Search by name, NORAD number or mode, star your favourites.
- **Passes** with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)): start, end, maximum elevation, a progress bar while it is up.
- **Doppler**: the selected downlink's received frequency is a green line on the spectrum and the waterfall; with *Track* the receiver follows it.
- **Sky radar** over the spectrum: the pass track, the satellite now, the others overhead. Tap it for a bigger one, drag it anywhere.
  - On a **phone with a compass** it turns with the phone and says which way to turn ("turn left 30°, up 40°").
  - **Without a compass** (computers, phones without an absolute orientation sensor) it says so and stays north-up: the simple mode.
- **Location**: phones use the GPS, computers the browser's location (Wi-Fi / IP based) when it is allowed; or type latitude / longitude or a Maidenhead locator.
- **Simulate the next pass**: jumps the clock to just before it, and the demo source shows the satellite's signal moving with the Doppler shift, so it works in a classroom with no board and no satellite overhead.

## Use

1. Open the page in **Chrome or Edge** (Windows, macOS, Linux, Android). Web Serial is not available in Firefox, Safari or on iOS: there the page still plans passes and shows the radar, on demo data.
2. Allow the location when asked (or type it in).
3. Plug the ESP32-S3 in by its **native USB port** and press **Connect board**; the orange button installs the ESP-SDR firmware if needed.

## Build

`index.html` is generated; edit the files in `src/`.

```
python tools/build.py              # inline src/flasher.js, src/sat.js, vendor/satellite.js and the firmware
python tools/build.py --check      # CI: index.html must match the sources
python tools/fetch_data.py         # data/sats.json from SatNOGS and CelesTrak (the Pages workflow runs it daily)
```

## Tests

Headless Chromium against an emulated board and a fixture satellite set:

```
pip install playwright && python -m playwright install chromium
python test/gen.py && node test/run.mjs && node test/md5test.mjs
python test/live.py && python test/flash.py && python test/reflash.py && python test/features.py && python test/wrongport.py && python test/rack.py && python test/sats.py
```

## Credits and licences

GPLv3 (see `LICENSE`). satellite.js is MIT (`vendor/satellite.js-LICENSE.md`). Satellite data: SatNOGS DB and Network by the Libre Space Foundation (CC BY-SA 4.0), CelesTrak. Firmware: [zodoczi/esp-sdr](https://github.com/zodoczi/esp-sdr) (fork of [ESPARGOS/esp-sdr](https://github.com/ESPARGOS/esp-sdr)), GPLv3.
