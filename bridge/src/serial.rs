//! Serial ports for the ESP32-S3 SDR (its native USB port) and the firmware installer
//! (also USB-UART bridges). A reader thread and a writer thread per open port, so a slow
//! UART never blocks the WebSocket.
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use std::time::Duration;
use tokio::sync::mpsc;

/// Espressif native USB, CH34x, CP210x, FTDI, Prolific (the page's UART_VIDS).
pub const ALLOWED_VIDS: &[u16] = &[0x303a, 0x1a86, 0x10c4, 0x0403, 0x067b];

pub enum SerialEvent {
    Data(Vec<u8>),
    Closed(String),
}

enum Cmd {
    Write(Vec<u8>),
    Signals(Option<bool>, Option<bool>),
}

pub struct SerialSession {
    rx: mpsc::UnboundedReceiver<SerialEvent>,
    cmd: std_mpsc::Sender<Cmd>,
    stop: Arc<AtomicBool>,
}

impl Drop for SerialSession {
    fn drop(&mut self) { self.stop.store(true, Ordering::Relaxed); }
}

pub fn not_open() -> Value { json!({ "status": "error", "error": "no serial port is open" }) }
fn err(msg: impl std::fmt::Display) -> Value { json!({ "status": "error", "error": msg.to_string() }) }

fn usb_info(p: &serialport::SerialPortInfo) -> Option<&serialport::UsbPortInfo> {
    match &p.port_type { serialport::SerialPortType::UsbPort(u) => Some(u), _ => None }
}

pub fn list() -> Result<Value, Value> {
    let ports = serialport::available_ports().map_err(|e| err(format!("cannot list serial ports: {e}")))?;
    Ok(Value::Array(
        ports.iter()
            .filter_map(|p| usb_info(p).filter(|u| ALLOWED_VIDS.contains(&u.vid)).map(|u| (p, u)))
            // macOS lists every port twice (cu.* and tty.*): keep cu.*
            .filter(|(p, _)| !p.port_name.starts_with("/dev/tty."))
            .map(|(p, u)| json!({
                "path": p.port_name, "usbVendorId": u.vid, "usbProductId": u.pid,
                "product": u.product.clone().unwrap_or_default(), "serialNumber": u.serial_number.clone().unwrap_or_default(),
            }))
            .collect(),
    ))
}

fn allowed_path(path: &str) -> bool {
    serialport::available_ports().ok().is_some_and(|ps| ps.iter().any(|p| p.port_name == path && usb_info(p).is_some_and(|u| ALLOWED_VIDS.contains(&u.vid))))
}

impl SerialSession {
    pub fn open(v: &Value) -> Result<(SerialSession, Value), Value> {
        let path = v["path"].as_str().ok_or_else(|| err("serial.open needs a path"))?.to_string();
        if !allowed_path(&path) { return Err(json!({ "status": "error", "error": format!("{path} is not a USB serial port of an ESP32 board"), "code": "notfound" })); }
        let baud = v["baudRate"].as_u64().unwrap_or(115200) as u32;
        let port = serialport::new(&path, baud).timeout(Duration::from_millis(20)).open().map_err(|e| {
            let busy = matches!(e.kind, serialport::ErrorKind::Io(std::io::ErrorKind::ResourceBusy)) || e.description.contains("busy") || e.description.contains("Access is denied");
            let perm = matches!(e.kind, serialport::ErrorKind::Io(std::io::ErrorKind::PermissionDenied));
            if busy { json!({ "status": "error", "error": "The port is busy. Close SDR++ or any other program that has it open, then try again.", "code": "busy" }) }
            else if perm { json!({ "status": "error", "error": format!("No permission for {path}: install the SatHunter Bridge package, or run  sudo sathunter-bridge --setup  once."), "code": "permission" }) }
            else { err(format!("cannot open {path}: {e}")) }
        })?;
        let mut reader = port.try_clone().map_err(|e| err(format!("cannot open {path}: {e}")))?;
        let mut writer = port;
        let stop = Arc::new(AtomicBool::new(false));
        let (tx, rx) = mpsc::unbounded_channel();
        let (cmd, cmd_rx) = std_mpsc::channel::<Cmd>();

        let stop_r = stop.clone();
        std::thread::Builder::new().name("serial-read".into()).spawn(move || {
            let mut buf = vec![0u8; 1 << 16];
            while !stop_r.load(Ordering::Relaxed) {
                match reader.read(&mut buf) {
                    Ok(0) => std::thread::sleep(Duration::from_millis(2)),
                    Ok(n) => { if tx.send(SerialEvent::Data(buf[..n].to_vec())).is_err() { break; } }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) => { if !stop_r.load(Ordering::Relaxed) { let _ = tx.send(SerialEvent::Closed(e.to_string())); } break; }
                }
            }
        }).map_err(|e| err(e))?;

        let stop_w = stop.clone();
        std::thread::Builder::new().name("serial-write".into()).spawn(move || {
            while let Ok(c) = cmd_rx.recv() {
                if stop_w.load(Ordering::Relaxed) { break; }
                let r = match c {
                    Cmd::Write(d) => writer.write_all(&d).and_then(|()| writer.flush()),
                    Cmd::Signals(dtr, rts) => (|| -> serialport::Result<()> {
                        if let Some(d) = dtr { writer.write_data_terminal_ready(d)?; }
                        if let Some(r) = rts { writer.write_request_to_send(r)?; }
                        Ok(())
                    })().map_err(std::io::Error::from),
                };
                if r.is_err() { break; } // the reader reports the port going away
            }
        }).map_err(|e| err(e))?;

        crate::log!("serial open: {path} at {baud} Bd");
        Ok((SerialSession { rx, cmd, stop }, json!({ "path": path })))
    }

    pub fn write(&self, d: Vec<u8>) { let _ = self.cmd.send(Cmd::Write(d)); }

    pub fn signals(&self, v: &Value) -> Result<(), Value> {
        self.cmd.send(Cmd::Signals(v["dataTerminalReady"].as_bool(), v["requestToSend"].as_bool())).map_err(|_| not_open())
    }
}

/// The next serial event, or never when no port is open (for tokio::select!).
pub async fn next_event(s: &mut Option<SerialSession>) -> SerialEvent {
    match s.as_mut() {
        Some(p) => p.rx.recv().await.unwrap_or_else(|| SerialEvent::Closed("port closed".into())),
        None => std::future::pending().await,
    }
}
