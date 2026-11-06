# SatHunter Bridge protocol

WebSocket on `ws://127.0.0.1:47380` (`--port` changes it). One connection serves one USB device
and one serial port; the page opens a connection per device, and short ones for listing.

Accepted pages: `Origin: null` (a page opened from disk), `https://z2labs.github.io`, `localhost` /
`127.0.0.1` on any port, and whatever `--allow-origin` / `SATHUNTER_BRIDGE_ORIGINS` add. No Origin
header (not a browser) is accepted too. The `Host` header must be the loopback address (no DNS
rebinding). Devices handed out: RTL2832U sticks (`0bda:2838`, `0bda:2832`) and USB serial ports with
the vendor ids `303a` (ESP32 native USB), `1a86`, `10c4`, `0403`, `067b`.

## Requests and answers

Requests are JSON text frames `{"op": ..., "id": n, ...}`. Answers carry the same `id` and a
`status`: `"ok"`, `"stall"` (USB STALL, as WebUSB reports it) or `"error"` with `error` (a sentence
for the user) and sometimes `code` (`notfound`, `permission`, `busy`, `driver`).

| op | arguments | answer |
|---|---|---|
| `hello` | | `version`, `os`, `features` |
| `usb.list` | | `devices: [{key, vendorId, productId, manufacturerName, productName, serialNumber, driver}]` |
| `usb.open` | `key` (optional: the first stick) | the device, as in the list. On Linux it takes interface 0 from the DVB-T TV driver |
| `usb.controlIn` | `requestType` (`vendor`/`standard`/`class`), `recipient` (`device`/`interface`/`endpoint`/`other`), `request`, `value`, `index`, `length` | `data: [bytes]` |
| `usb.controlOut` | as above, `data: [bytes]` instead of `length` | `bytesWritten` |
| `usb.bulkIn` | `endpoint` (1 = 0x81), `length` (≤ 1 MiB) | a **binary frame**: `u32 LE id` + the data; or a text answer with `stall` / `error`. Up to 32 in flight; they complete in order |
| `usb.clearHalt` | `endpoint` | |
| `usb.reset` | | |
| `usb.close` | | |
| `serial.list` | | `ports: [{path, usbVendorId, usbProductId, product, serialNumber}]` |
| `serial.open` | `path`, `baudRate` | |
| `serial.signals` | `dataTerminalReady`, `requestToSend` (each optional) | |
| `serial.close` | | |

Binary frames from the page are written to the open serial port, in order with `serial.signals`.
Serial data comes to the page as binary frames with id 0: `00 00 00 00` + the bytes.

## Events

Text frames without `id`: `{"op": "usb.disconnect"}` (the stick left the bus),
`{"op": "serial.closed", "error": ...}` (the port went away, e.g. the board resetting).
