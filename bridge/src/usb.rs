//! RTL-SDR access with nusb (no libusb): the page sends WebUSB-style control and bulk transfers.
use crate::log;
use nusb::transfer::{Completion, ControlIn, ControlOut, ControlType, Queue, Recipient, RequestBuffer, TransferError};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::Duration;

/// USB devices the bridge hands out: RTL2832U sticks (RTL-SDR Blog V3 / V4 and generic ones).
pub const ALLOWED: &[(u16, u16)] = &[(0x0bda, 0x2838), (0x0bda, 0x2832)];
const CONTROL_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_BULK: usize = 1 << 20;
const MAX_INFLIGHT: usize = 32;

pub enum BulkDone {
    Data(u32, Vec<u8>),
    /// id, error ("stall" or a message), device gone
    Err(u32, String, bool),
}

pub struct UsbSession {
    dev: nusb::Device,
    iface: nusb::Interface,
    queue: Option<(u8, Queue<RequestBuffer>)>,
    ids: VecDeque<u32>,
}

pub fn not_open() -> Value { json!({ "status": "error", "error": "no USB device is open" }) }
fn err(msg: impl std::fmt::Display) -> Value { json!({ "status": "error", "error": msg.to_string() }) }

fn key(d: &nusb::DeviceInfo) -> String { format!("{:?}", d.id()) }

fn info_json(d: &nusb::DeviceInfo) -> Value {
    json!({
        "key": key(d),
        "vendorId": d.vendor_id(), "productId": d.product_id(),
        "manufacturerName": d.manufacturer_string().unwrap_or(""),
        "productName": d.product_string().unwrap_or(""),
        "serialNumber": d.serial_number().unwrap_or(""),
        "driver": driver_name(d),
    })
}

#[cfg(target_os = "linux")]
fn driver_name(d: &nusb::DeviceInfo) -> String {
    // the kernel driver bound to interface 0 (dvb_usb_rtl28xxu = the TV driver)
    let p = d.sysfs_path().join(format!("{}:1.0", d.sysfs_path().file_name().and_then(|n| n.to_str()).unwrap_or(""))).join("driver");
    std::fs::read_link(p).ok().and_then(|l| l.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_default()
}
#[cfg(not(target_os = "linux"))]
fn driver_name(d: &nusb::DeviceInfo) -> String {
    #[cfg(target_os = "windows")]
    { return d.driver().unwrap_or("").to_string(); }
    #[allow(unreachable_code)]
    { let _ = d; String::new() }
}

/// USB devices on this computer; none when it has no USB subsystem at all (containers, CI)
fn all_devices() -> Result<Vec<nusb::DeviceInfo>, Value> {
    match nusb::list_devices() {
        Ok(d) => Ok(d.collect()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(err(format!("cannot list USB devices: {e}"))),
    }
}

pub fn list() -> Result<Value, Value> {
    Ok(Value::Array(all_devices()?.iter().filter(|d| ALLOWED.contains(&(d.vendor_id(), d.product_id()))).map(info_json).collect()))
}

fn parse_type(v: &Value) -> ControlType {
    match v["requestType"].as_str() { Some("standard") => ControlType::Standard, Some("class") => ControlType::Class, _ => ControlType::Vendor }
}
fn parse_recipient(v: &Value) -> Recipient {
    match v["recipient"].as_str() { Some("interface") => Recipient::Interface, Some("endpoint") => Recipient::Endpoint, Some("other") => Recipient::Other, _ => Recipient::Device }
}
fn u16_of(v: &Value, k: &str) -> u16 { v[k].as_u64().unwrap_or(0).min(0xffff) as u16 }

fn is_permission(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(13)
}

impl UsbSession {
    pub async fn open(v: &Value) -> Result<(UsbSession, Value), Value> {
        let want = v["key"].as_str().map(|s| s.to_string());
        let find = || -> Result<nusb::DeviceInfo, Value> {
            all_devices()?
                .into_iter()
                .filter(|d| ALLOWED.contains(&(d.vendor_id(), d.product_id())))
                .find(|d| want.as_deref().is_none_or(|k| k == key(d)))
                .ok_or_else(|| json!({ "status": "error", "error": "No RTL-SDR is plugged in.", "code": "notfound" }))
        };
        let info = find()?;
        let open = |info: &nusb::DeviceInfo| -> std::io::Result<(nusb::Device, nusb::Interface)> {
            let dev = info.open()?;
            // the TV driver (dvb_usb_rtl28xxu) holds interface 0 on Linux: take it over
            let iface = dev.detach_and_claim_interface(0)?;
            Ok((dev, iface))
        };
        let (dev, iface) = match open(&info) {
            Ok(x) => x,
            Err(e) if is_permission(&e) && crate::setup::can_elevate() => {
                log!("no permission for the RTL-SDR: asking once for the system setup");
                if crate::setup::elevate().await {
                    tokio::time::sleep(Duration::from_millis(1500)).await; // udev re-applies the rules
                    let info = find()?;
                    open(&info).map_err(|e| open_error(&e))?
                } else {
                    return Err(open_error(&e));
                }
            }
            Err(e) => return Err(open_error(&e)),
        };
        log!("RTL-SDR open: {:04x}:{:04x} {}", info.vendor_id(), info.product_id(), info.product_string().unwrap_or(""));
        Ok((UsbSession { dev, iface, queue: None, ids: VecDeque::new() }, info_json(&info)))
    }

    pub fn bulk_in(&mut self, v: &Value) -> Result<(), Value> {
        let id = v["id"].as_u64().ok_or_else(|| err("bulkIn needs a numeric id"))? as u32;
        let ep = (v["endpoint"].as_u64().unwrap_or(1) as u8 & 0x0f) | 0x80;
        let len = v["length"].as_u64().unwrap_or(0) as usize;
        if len == 0 || len > MAX_BULK { return Err(err(format!("bulkIn length {len} out of range"))); }
        if self.ids.len() >= MAX_INFLIGHT { return Err(err("too many bulk transfers in flight")); }
        if self.queue.as_ref().is_none_or(|(e, _)| *e != ep) {
            if !self.ids.is_empty() { return Err(err("bulk transfers on two endpoints at once are not supported")); }
            self.queue = Some((ep, self.iface.bulk_in_queue(ep)));
        }
        self.queue.as_mut().unwrap().1.submit(RequestBuffer::new(len));
        self.ids.push_back(id);
        Ok(())
    }

    pub async fn request(&mut self, op: &str, v: &Value) -> Result<Value, Value> {
        match op {
            "usb.controlIn" => {
                let req = ControlIn {
                    control_type: parse_type(v), recipient: parse_recipient(v),
                    request: v["request"].as_u64().unwrap_or(0) as u8, value: u16_of(v, "value"), index: u16_of(v, "index"),
                    length: u16_of(v, "length"),
                };
                match tokio::time::timeout(CONTROL_TIMEOUT, self.iface.control_in(req)).await {
                    Err(_) => Err(err("control transfer timed out")),
                    Ok(Completion { status: Err(TransferError::Stall), .. }) => Ok(json!({ "status": "stall", "data": [] })),
                    Ok(Completion { status: Err(e), .. }) => Err(err(format!("control transfer failed: {e}"))),
                    Ok(Completion { data, .. }) => Ok(json!({ "data": data })),
                }
            }
            "usb.controlOut" => {
                let data: Vec<u8> = v["data"].as_array().map(|a| a.iter().map(|x| x.as_u64().unwrap_or(0) as u8).collect()).unwrap_or_default();
                let req = ControlOut {
                    control_type: parse_type(v), recipient: parse_recipient(v),
                    request: v["request"].as_u64().unwrap_or(0) as u8, value: u16_of(v, "value"), index: u16_of(v, "index"),
                    data: &data,
                };
                match tokio::time::timeout(CONTROL_TIMEOUT, self.iface.control_out(req)).await {
                    Err(_) => Err(err("control transfer timed out")),
                    Ok(Completion { status: Err(TransferError::Stall), .. }) => Ok(json!({ "status": "stall", "bytesWritten": 0 })),
                    Ok(Completion { status: Err(e), .. }) => Err(err(format!("control transfer failed: {e}"))),
                    Ok(Completion { data: r, .. }) => Ok(json!({ "bytesWritten": r.actual_length() })),
                }
            }
            "usb.clearHalt" => {
                let ep = (v["endpoint"].as_u64().unwrap_or(1) as u8 & 0x0f) | 0x80;
                let r = match self.queue.as_mut() {
                    Some((e, q)) if *e == ep => { q.cancel_all(); while q.pending() > 0 { let _ = q.next_complete().await; } self.ids.clear(); q.clear_halt() }
                    _ => self.iface.clear_halt(ep),
                };
                r.map(|()| json!({})).map_err(|e| err(format!("clear halt: {e}")))
            }
            "usb.reset" => {
                self.queue = None;
                self.ids.clear();
                self.dev.reset().map_err(|e| err(format!("reset: {e}")))?;
                tokio::time::sleep(Duration::from_millis(100)).await;
                self.iface = self.dev.detach_and_claim_interface(0).map_err(|e| err(format!("claim after reset: {e}")))?;
                Ok(json!({}))
            }
            // WebUSB calls the page makes that need nothing here (one configuration, interface 0)
            "usb.selectConfiguration" | "usb.claimInterface" | "usb.releaseInterface" => Ok(json!({})),
            _ => Err(err(format!("unknown op {op:?}"))),
        }
    }
}

fn open_error(e: &std::io::Error) -> Value {
    if is_permission(e) {
        let hint = if cfg!(target_os = "linux") { "No permission for the RTL-SDR: install the SatHunter Bridge package (it adds the udev rule), or run  sudo sathunter-bridge --setup  once." }
            else if cfg!(target_os = "windows") { "Windows still uses its TV driver for the RTL-SDR: run the SatHunter installer once." }
            else { "No permission for the RTL-SDR." };
        json!({ "status": "error", "error": hint, "code": "permission" })
    } else if e.raw_os_error() == Some(16) || e.kind() == std::io::ErrorKind::ResourceBusy {
        json!({ "status": "error", "error": "The RTL-SDR is busy: close other SDR programs (SDR++, rtl_tcp, GQRX) and try again.", "code": "busy" })
    } else if cfg!(target_os = "windows") {
        json!({ "status": "error", "error": format!("Cannot open the RTL-SDR ({e}). Windows needs the WinUSB driver for it: run the SatHunter installer once."), "code": "driver" })
    } else {
        json!({ "status": "error", "error": format!("Cannot open the RTL-SDR: {e}") })
    }
}

/// The next finished bulk transfer, or never when none is in flight (for tokio::select!).
pub async fn next_completion(s: &mut Option<UsbSession>) -> BulkDone {
    let Some(u) = s.as_mut() else { return std::future::pending().await };
    let Some((_, q)) = u.queue.as_mut() else { return std::future::pending().await };
    if q.pending() == 0 { return std::future::pending().await; }
    let c = q.next_complete().await;
    let id = u.ids.pop_front().unwrap_or(0);
    match c.status {
        Ok(()) => BulkDone::Data(id, c.data),
        Err(TransferError::Stall) => BulkDone::Err(id, "stall".into(), false),
        Err(TransferError::Disconnected) => BulkDone::Err(id, "device disconnected".into(), true),
        Err(TransferError::Cancelled) => BulkDone::Err(id, "transfer cancelled".into(), false),
        Err(e) => BulkDone::Err(id, e.to_string(), false),
    }
}
