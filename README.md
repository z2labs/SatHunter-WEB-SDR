![SatHunter Web: hunt satellites in your browser](docs/banner.png)

# SatHunter Web SDR

**Open it: [z2labs.github.io/SatHunter-WEB-SDR](https://z2labs.github.io/SatHunter-WEB-SDR/)** in any browser, or download [`index.html`](index.html) and open it from disk. Chrome and Edge reach the radio by themselves; **Firefox**, and **Linux** in any browser, use [SatHunter Bridge](bridge/), a one-click install.

The browser sibling of [SatHunterSDR](https://github.com/z2labs/SatHunter-SDR), made for classrooms: pick a satellite, see when it comes over, where to point the antenna, and its signal with the Doppler shift on the live spectrum, **with an RTL-SDR (Blog V3 / V4, listening too) or an ESP32-S3 SDR**. One HTML file, no install. It grew out of [Z2 Web SDR](https://github.com/z2labs/z2-web-sdr) and keeps all of it (16 / 40 / 80 MHz spectrum and GPU waterfall over Web Serial, firmware installer, export, debug report).

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

## RTL-SDR (Blog V3 / V4 and RTL2832U sticks)

Press **RTL-SDR** in the header (Chrome or Edge over WebUSB, any browser through [SatHunter Bridge](bridge/)). The page drives the stick itself (a JavaScript port of [rtl-sdr-rs](https://github.com/ccostes/rtl-sdr-rs), MPL-2.0, with the Blog V4 handling: R828D, 28.8 MHz tuner crystal, HF upconverter and band switching, bias tee for an LNA), makes the spectrum and waterfall, and **plays the audio**: NFM, WFM, AM, USB, LSB, CW at the listening point (tap the spectrum). A tracked satellite moves the listening point with its Doppler shift (gliding at the predicted Doppler rate between the 4-per-second updates, so a CW tone does not step) and picks the mode from its downlink.

- **Decoders** (Settings → Decoders), on the NFM audio of the listening point, ported from the SatHunterSDR app with the same algorithms: **APRS / AX.25** (AFSK1200: discriminator, DPLL, HDLC, CRC with repair of one bad bit; text and a map link for positions; the ISS digipeater on 145.825 MHz, APRS CubeSats) and **SSTV** Robot 36 / PD120 (the ISS SSTV events on 145.800 MHz; the picture builds up line by line, *Save picture* as PNG). Measured in the app's lab with a Spacewalker LNA and an RTL-SDR V3: APRS 90 % of packets at about -122.5 dBm, SSTV clean down to -132 dBm.
- **Frequency accuracy**: the R820T/R828D PLL fraction is computed in Hz and its remaining error is moved into the RTL2832's IF, as in the app (the original code was off by up to 1 kHz / mixer divider, different at each sample rate).
- **Screen saver** for OLED screens (Settings → Display): after 1-10 minutes without a touch the screen goes black with a small dim summary (time, frequency, satellite, last decode) that moves every 20 s; reception goes on, a tap wakes it.

- **Windows**: run **[SatHunter-Setup.exe](https://github.com/z2labs/SatHunter-WEB-SDR/releases/download/bridge-1.0/SatHunter-Setup.exe)** once: the RTL-SDR driver (one click, instead of Zadig) and SatHunter Bridge (for Firefox). It is unsigned, so Windows may say *Windows protected your PC*: *More info* → *Run anyway*. The driver alone is still [SatHunter-RTL-SDR-Driver.exe](https://github.com/z2labs/SatHunter-WEB-SDR/releases/download/driver-1.0/SatHunter-RTL-SDR-Driver.exe) (`driver/`).
- **Linux**: install **SatHunter Bridge** once: [the .deb for PCs](https://github.com/z2labs/SatHunter-WEB-SDR/releases/download/bridge-1.0/sathunter-bridge_1.0.0_amd64.deb) or [for a Raspberry Pi](https://github.com/z2labs/SatHunter-WEB-SDR/releases/download/bridge-1.0/sathunter-bridge_1.0.0_arm64.deb) (double-click), or the [tar.gz](https://github.com/z2labs/SatHunter-WEB-SDR/releases/tag/bridge-1.0) and `sudo ./install.sh` on other distributions. Nothing to type: it keeps the TV driver off the stick and lets every browser in. The page offers the right download when it needs it.
- **Firefox** (any computer): SatHunter Bridge as above (macOS: the zip on [the release page](https://github.com/z2labs/SatHunter-WEB-SDR/releases/tag/bridge-1.0)).
- **Android, ChromeOS, macOS** in Chrome: nothing to install.

## Use

1. Open the page in **Chrome or Edge** (Windows, macOS, Linux, Android), or in **Firefox** with [SatHunter Bridge](bridge/) installed. Without either (Safari, iOS) the page still plans passes and shows the radar, on demo data.
2. Allow the location when asked (or type it in).
3. Plug in an RTL-SDR and press **RTL-SDR**, or plug the ESP32-S3 in by its **native USB port** and press **Connect ESP32-S3** (the orange button installs the ESP-SDR firmware if needed).

## Build

`index.html` is generated; edit the files in `src/`. SatHunter Bridge (Rust): see [bridge/](bridge/).

```
python tools/build.py              # inline src/flasher.js, src/bridge.js, src/rtl.js, src/dsp.js, src/decode.js, src/sat.js, vendor/satellite.js and the firmware
python tools/build.py --check      # CI: index.html must match the sources
python tools/fetch_data.py         # data/sats.json from SatNOGS and CelesTrak (the Pages workflow runs it daily)
```

## Tests

Headless Chromium against an emulated ESP32-S3 board, an emulated RTL-SDR (`test/mock_usb.js`) and a fixture satellite set; `test/bridgeweb.py` runs the page without WebUSB / Web Serial, in Chromium and Firefox, through a fake bridge (`test/mock_bridge.mjs`):

```
pip install playwright && python -m playwright install chromium firefox
python test/gen.py && node test/run.mjs && node test/md5test.mjs
node test/rtl.mjs && node test/decode.mjs
python test/live.py && python test/flash.py && python test/reflash.py && python test/features.py && python test/wrongport.py && python test/rack.py && python test/sats.py && python test/rtlweb.py && python test/decweb.py && python test/bridgeweb.py
node test/bridge_smoke.mjs bridge/target/release/sathunter-bridge     # the real bridge, no hardware
```

## Credits and licences

GPLv3 (see `LICENSE`), SatHunter Bridge too. `src/rtl.js` is MPL-2.0 (a translation of rtl-sdr-rs). satellite.js is MIT (`vendor/satellite.js-LICENSE.md`). Satellite data: SatNOGS DB and Network by the Libre Space Foundation (CC BY-SA 4.0), CelesTrak. Firmware: [zodoczi/esp-sdr](https://github.com/zodoczi/esp-sdr) (fork of [ESPARGOS/esp-sdr](https://github.com/ESPARGOS/esp-sdr)), GPLv3.
