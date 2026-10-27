# RTL-SDR driver installer (Windows)

`SatHunter-RTL-SDR-Driver.exe` puts the WinUSB driver on RTL2832U sticks (RTL-SDR Blog V3 / V4,
USB 0BDA:2838 and 0BDA:2832) with one click, instead of Zadig. Chrome and Edge (WebUSB) and most SDR
programs need it on Windows; Android, ChromeOS, macOS and Linux do not.

It is built by `.github/workflows/driver.yml`: libwdi's `wdi-simple` (LGPL-3.0, the engine of Zadig)
with Microsoft's WinUSB redistributable, packed with Inno Setup from `rtlsdr-driver.iss`.

Undo: Device Manager → the RTL2832U device → Uninstall device, tick *Delete the driver software*,
re-plug the stick.
