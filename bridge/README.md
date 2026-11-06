# SatHunter Bridge

A small background program that lets [SatHunter Web SDR](https://z2labs.github.io/SatHunter-WEB-SDR/)
use an **RTL-SDR** (Blog V3 / V4) and an **ESP32-S3 SDR** in **any browser**, Firefox included, and on
Linux without typing a command. The page finds it by itself on `127.0.0.1:47380`.

Who needs it:

- **Firefox** (and other browsers without WebUSB / Web Serial), on any computer.
- **Linux**, in any browser: the kernel's DVB-T TV driver grabs RTL-SDR sticks, and browsers may not
  open USB devices or serial ports without udev rules. The package sets all of that up.
- Chrome or Edge on Windows, macOS, Android, ChromeOS: not needed (Windows still needs the RTL-SDR
  driver, which `SatHunter-Setup.exe` installs together with the bridge).

Chrome and Edge use their own WebUSB / Web Serial first, and turn to the bridge by themselves when it
cannot open the device (then they keep using it).

## Install

From the [bridge-1.0 release](https://github.com/z2labs/SatHunter-WEB-SDR/releases/tag/bridge-1.0):

| | file | |
|---|---|---|
| Windows | `SatHunter-Setup.exe` | RTL-SDR driver (instead of Zadig) + the bridge, starts with Windows. Unsigned: *More info* → *Run anyway* |
| Debian, Ubuntu, Mint, Raspberry Pi OS | `sathunter-bridge_1.0.0_amd64.deb` (PC), `_arm64.deb` (Raspberry Pi 4 / 5) | double-click; a system service from then on |
| Other Linux | `sathunter-bridge-linux-amd64.tar.gz` / `-arm64` | `sudo ./install.sh` |
| macOS | `sathunter-bridge-macos.zip` | `install.command` (right-click → Open the first time) |

The Linux package writes `/etc/udev/rules.d/60-sathunter-bridge.rules` (RTL-SDR sticks and ESP32 /
USB-UART ports for every user), `/etc/modprobe.d/sathunter-bridge-rtlsdr.conf` (TV driver off),
unloads the TV driver, and enables `sathunter-bridge.service`. Removing the package undoes all of it.
Started any other way, the bridge still takes the stick from the TV driver itself, and the first time
it lacks permission it asks for the password once (pkexec) to write the udev rule.

## How it works

The protocol ([PROTOCOL.md](PROTOCOL.md)) mirrors the WebUSB and Web Serial calls the page makes, so
the page's own RTL-SDR driver (`src/rtl.js`), spectrum code and firmware installer run unchanged on
`src/bridge.js`, which stands in for `navigator.usb` / `navigator.serial`. USB goes through
[nusb](https://github.com/kevinmehall/nusb) (pure Rust, no libusb; WinUSB on Windows), serial ports
through [serialport](https://github.com/serialport/serialport-rs). It listens on the loopback address
only and serves only our pages (see PROTOCOL.md) and only RTL-SDR sticks and ESP32 serial ports.

## Build

```
cd bridge && cargo build --release        # target/release/sathunter-bridge
node test/bridge_smoke.mjs bridge/target/release/sathunter-bridge
```

`.github/workflows/bridge.yml` builds every package; run it by hand with `release_tag` = `bridge-1.0`
to publish them.
