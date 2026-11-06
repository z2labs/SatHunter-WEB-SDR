//! SatHunter Bridge: lets SatHunter Web SDR use an RTL-SDR and an ESP32-S3 SDR from any browser,
//! Firefox and Safari included, and on Linux without the user typing any command.
//!
//! The page talks to this program over a WebSocket on 127.0.0.1. The protocol mirrors the parts of
//! WebUSB and Web Serial the page uses (control and bulk transfers; open / read / write / signals),
//! so the page's own RTL-SDR driver (src/rtl.js) and ESP32 code run unchanged on top of it.
//! See PROTOCOL.md.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod serial;
mod setup;
mod usb;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

pub const DEFAULT_PORT: u16 = 47380;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Pages that may use the bridge (besides pages opened from disk and pages on localhost).
const DEFAULT_ORIGINS: &[&str] = &["https://z2labs.github.io"];

pub struct Config {
    port: u16,
    origins: Vec<String>,
}

macro_rules! log {
    ($($t:tt)*) => { eprintln!("[sathunter-bridge] {}", format!($($t)*)) };
}
pub(crate) use log;

fn usage() {
    println!(
        "SatHunter Bridge {VERSION}: RTL-SDR and ESP32-S3 access for SatHunter Web SDR in any browser.\n\n\
         Usage: sathunter-bridge [options]\n\
         \x20 --port N             listen on 127.0.0.1:N (default {DEFAULT_PORT})\n\
         \x20 --allow-origin URL   also accept pages from URL (repeatable; also SATHUNTER_BRIDGE_ORIGINS=a,b)\n\
         \x20 --setup              Linux, as root: udev rules + TV-driver blacklist (the installer runs this)\n\
         \x20 --version            print the version"
    );
}

fn main() {
    let mut cfg = Config { port: DEFAULT_PORT, origins: DEFAULT_ORIGINS.iter().map(|s| s.to_string()).collect() };
    if let Ok(v) = std::env::var("SATHUNTER_BRIDGE_ORIGINS") {
        cfg.origins.extend(v.split(',').map(|s| s.trim().trim_end_matches('/').to_string()).filter(|s| !s.is_empty()));
    }
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--port" => cfg.port = args.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| { usage(); std::process::exit(2) }),
            "--allow-origin" => cfg.origins.push(args.next().unwrap_or_default().trim_end_matches('/').to_string()),
            "--setup" => std::process::exit(setup::run_setup()),
            "--version" | "-V" => { println!("sathunter-bridge {VERSION}"); return; }
            "--help" | "-h" => { usage(); return; }
            _ => { usage(); std::process::exit(2) }
        }
    }
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
    std::process::exit(rt.block_on(serve(Arc::new(cfg))));
}

async fn serve(cfg: Arc<Config>) -> i32 {
    let addr = SocketAddr::from(([127, 0, 0, 1], cfg.port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            log!("{addr} is in use: the bridge is probably already running");
            return 0;
        }
        Err(e) => { log!("cannot listen on {addr}: {e}"); return 1; }
    };
    log!("{VERSION} listening on ws://{addr}");
    loop {
        tokio::select! {
            r = listener.accept() => match r {
                Ok((stream, _)) => { let cfg = cfg.clone(); tokio::spawn(async move { client(stream, cfg).await }); }
                Err(e) => log!("accept: {e}"),
            },
            _ = tokio::signal::ctrl_c() => { log!("stopping"); return 0; }
        }
    }
}

/// Which pages may connect. Missing Origin = not a browser (tests, scripts): allowed, they could
/// open the device themselves anyway. A browser page must be ours, a local file ("null"), or localhost.
pub fn origin_allowed(origin: Option<&str>, allowed: &[String]) -> bool {
    let Some(o) = origin else { return true };
    let o = o.trim_end_matches('/');
    if o == "null" || allowed.iter().any(|a| a == o) { return true; }
    for local in ["http://localhost", "https://localhost", "http://127.0.0.1", "https://127.0.0.1", "http://[::1]"] {
        if o == local || o.strip_prefix(local).is_some_and(|rest| rest.starts_with(':')) { return true; }
    }
    false
}

/// The Host header must name the loopback address (blocks DNS rebinding).
pub fn host_allowed(host: Option<&str>, port: u16) -> bool {
    match host {
        None => true,
        Some(h) => [format!("127.0.0.1:{port}"), format!("localhost:{port}"), "127.0.0.1".into(), "localhost".into()].iter().any(|a| a == h),
    }
}

async fn client(stream: TcpStream, cfg: Arc<Config>) {
    let _ = stream.set_nodelay(true);
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        let o = req.headers().get("origin").and_then(|v| v.to_str().ok()).map(|s| s.to_string());
        let h = req.headers().get("host").and_then(|v| v.to_str().ok());
        if !host_allowed(h, cfg.port) || !origin_allowed(o.as_deref(), &cfg.origins) {
            let mut r = ErrorResponse::new(Some(format!("origin {} is not allowed", o.as_deref().unwrap_or("?"))));
            *r.status_mut() = StatusCode::FORBIDDEN;
            return Err(r);
        }
        Ok(resp)
    };
    let ws_cfg = WebSocketConfig { max_message_size: Some(16 << 20), max_frame_size: Some(16 << 20), ..Default::default() };
    let ws = match tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(ws_cfg)).await {
        Ok(ws) => ws,
        Err(e) => { log!("rejected a connection: {e}"); return; }
    };
    let (mut sink, mut rx) = ws.split();
    let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() { break; }
        }
        let _ = sink.close().await;
    });

    let mut s = Session { out: out.clone(), usb: None, serial: None };
    loop {
        tokio::select! {
            m = rx.next() => match m {
                Some(Ok(Message::Text(t))) => s.on_text(&t).await,
                Some(Ok(Message::Binary(b))) => s.on_binary(b),
                Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            },
            c = usb::next_completion(&mut s.usb) => s.on_bulk(c),
            e = serial::next_event(&mut s.serial) => s.on_serial(e),
        }
    }
    drop(s);
    drop(out);
    let _ = writer.await;
}

pub struct Session {
    out: mpsc::UnboundedSender<Message>,
    usb: Option<usb::UsbSession>,
    serial: Option<serial::SerialSession>,
}

impl Session {
    fn send(&self, v: Value) { let _ = self.out.send(Message::Text(v.to_string())); }

    async fn on_text(&mut self, t: &str) {
        let v: Value = match serde_json::from_str(t) { Ok(v) => v, Err(e) => return self.send(json!({ "status": "error", "error": format!("bad JSON: {e}") })) };
        let op = v["op"].as_str().unwrap_or("").to_string();
        let id = v.get("id").cloned().unwrap_or(Value::Null);
        let r = match op.as_str() {
            "hello" => Ok(json!({ "version": VERSION, "os": std::env::consts::OS, "features": ["usb", "serial"] })),
            "usb.list" => usb::list().map(|d| json!({ "devices": d })),
            "usb.open" => usb::UsbSession::open(&v).await.map(|(sess, info)| { self.usb = Some(sess); info }),
            "usb.bulkIn" => match self.usb.as_mut() {
                Some(u) => u.bulk_in(&v).map(|()| return_none()),
                None => Err(usb::not_open()),
            },
            "serial.list" => serial::list().map(|p| json!({ "ports": p })),
            "serial.open" => {
                self.serial = None;
                serial::SerialSession::open(&v).map(|(sess, info)| { self.serial = Some(sess); info })
            }
            "serial.signals" => match self.serial.as_ref() { Some(s) => s.signals(&v).map(|()| json!({})), None => Err(serial::not_open()) },
            "serial.close" => { self.serial = None; Ok(json!({})) }
            "usb.close" => { self.usb = None; Ok(json!({})) }
            op if op.starts_with("usb.") => match self.usb.as_mut() {
                Some(u) => u.request(op, &v).await,
                None => Err(usb::not_open()),
            },
            _ => Err(json!({ "status": "error", "error": format!("unknown op {op:?}") })),
        };
        match r {
            Ok(Value::Null) => {}
            Ok(mut ok) => { ok["id"] = id; if ok.get("status").is_none() { ok["status"] = json!("ok"); } self.send(ok) }
            Err(mut e) => { e["id"] = id; self.send(e) }
        }
    }

    /// Binary frames from the page are serial writes.
    fn on_binary(&mut self, b: Vec<u8>) {
        if let Some(s) = self.serial.as_ref() { s.write(b); }
    }

    fn on_bulk(&mut self, c: usb::BulkDone) {
        match c {
            usb::BulkDone::Data(id, data) => {
                let mut f = Vec::with_capacity(4 + data.len());
                f.extend_from_slice(&id.to_le_bytes());
                f.extend_from_slice(&data);
                let _ = self.out.send(Message::Binary(f));
            }
            usb::BulkDone::Err(id, e, gone) => {
                self.send(json!({ "id": id, "status": if e == "stall" { "stall" } else { "error" }, "error": e }));
                if gone {
                    log!("RTL-SDR left the bus");
                    self.usb = None;
                    self.send(json!({ "op": "usb.disconnect" }));
                }
            }
        }
    }

    fn on_serial(&mut self, e: serial::SerialEvent) {
        match e {
            serial::SerialEvent::Data(d) => {
                let mut f = Vec::with_capacity(4 + d.len());
                f.extend_from_slice(&0u32.to_le_bytes());
                f.extend_from_slice(&d);
                let _ = self.out.send(Message::Binary(f));
            }
            serial::SerialEvent::Closed(why) => {
                self.serial = None;
                self.send(json!({ "op": "serial.closed", "error": why }));
            }
        }
    }
}

/// A request answered later (bulk IN: the data comes as a binary frame).
fn return_none() -> Value { Value::Null }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn origins() {
        let a = vec!["https://z2labs.github.io".to_string()];
        assert!(origin_allowed(None, &a));
        assert!(origin_allowed(Some("null"), &a));
        assert!(origin_allowed(Some("https://z2labs.github.io"), &a));
        assert!(origin_allowed(Some("http://localhost:8000"), &a));
        assert!(origin_allowed(Some("http://127.0.0.1"), &a));
        assert!(!origin_allowed(Some("https://evil.example"), &a));
        assert!(!origin_allowed(Some("http://localhost.evil.example"), &a));
        assert!(!origin_allowed(Some("https://z2labs.github.io.evil.example"), &a));
    }
    #[test]
    fn hosts() {
        assert!(host_allowed(Some("127.0.0.1:47380"), 47380));
        assert!(host_allowed(Some("localhost:47380"), 47380));
        assert!(!host_allowed(Some("evil.example:47380"), 47380));
        assert!(!host_allowed(Some("127.0.0.1:1"), 47380));
    }
}
