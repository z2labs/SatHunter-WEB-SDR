//! One-time Linux system setup: let every user reach RTL-SDR sticks and ESP32 serial ports, and keep
//! the DVB-T TV driver off RTL-SDR sticks. The .deb runs `sathunter-bridge --setup` when it is
//! installed; a bridge started some other way (plain binary, AppImage) asks for it once through
//! pkexec (the desktop's password dialog) the first time it lacks permission.

pub const UDEV_PATH: &str = "/etc/udev/rules.d/60-sathunter-bridge.rules";
pub const MODPROBE_PATH: &str = "/etc/modprobe.d/sathunter-bridge-rtlsdr.conf";

pub const UDEV_RULES: &str = r#"# SatHunter Bridge: RTL-SDR sticks and ESP32 boards for SatHunter Web SDR (any user, any browser)
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="303a", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", MODE="0666", TAG+="uaccess"
"#;

pub const MODPROBE_CONF: &str = "# SatHunter Bridge: RTL-SDR sticks are radios here, not DVB-T TV tuners\n\
blacklist dvb_usb_rtl28xxu\nblacklist rtl2832_sdr\nblacklist rtl2832\nblacklist r820t\n";

#[cfg(target_os = "linux")]
pub fn run_setup() -> i32 {
    use std::process::Command;
    // SAFETY: geteuid has no preconditions
    if unsafe { geteuid() } != 0 {
        eprintln!("--setup changes system files: run it as root (sudo sathunter-bridge --setup)");
        return 1;
    }
    for (path, text) in [(UDEV_PATH, UDEV_RULES), (MODPROBE_PATH, MODPROBE_CONF)] {
        if let Some(dir) = std::path::Path::new(path).parent() { let _ = std::fs::create_dir_all(dir); }
        if let Err(e) = std::fs::write(path, text) { eprintln!("cannot write {path}: {e}"); return 1; }
        println!("wrote {path}");
    }
    // free sticks that are plugged in now; the TV driver may not be loaded at all
    for m in ["dvb_usb_rtl28xxu", "rtl2832_sdr", "rtl2832", "r820t"] {
        let _ = Command::new("modprobe").args(["-r", "-q", m]).status();
    }
    let _ = Command::new("udevadm").args(["control", "--reload-rules"]).status();
    let _ = Command::new("udevadm").args(["trigger", "--action=add", "--subsystem-match=usb", "--attr-match=idVendor=0bda"]).status();
    let _ = Command::new("udevadm").args(["trigger", "--action=add", "--subsystem-match=tty"]).status();
    println!("done: RTL-SDR sticks and ESP32 boards work for every user now");
    0
}

#[cfg(not(target_os = "linux"))]
pub fn run_setup() -> i32 {
    eprintln!("--setup is only needed on Linux");
    0
}

#[cfg(target_os = "linux")]
extern "C" {
    fn geteuid() -> u32;
}

static TRIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// True when the setup is missing and we may still ask for it (once per bridge run).
pub fn can_elevate() -> bool {
    cfg!(target_os = "linux") && !std::path::Path::new(UDEV_PATH).exists() && !TRIED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Run `--setup` through pkexec (graphical password prompt). True when it succeeded.
pub async fn elevate() -> bool {
    TRIED.store(true, std::sync::atomic::Ordering::Relaxed);
    // an AppImage's own path is inside a FUSE mount root cannot read: use the image itself
    let exe = std::env::var_os("APPIMAGE").map(std::path::PathBuf::from).or_else(|| std::env::current_exe().ok());
    let Some(exe) = exe else { return false };
    let r = tokio::process::Command::new("pkexec").arg(exe).arg("--setup").status().await;
    match r {
        Ok(s) if s.success() => { crate::log!("system setup done"); true }
        Ok(s) => { crate::log!("system setup not done (pkexec exit {s})"); false }
        Err(e) => { crate::log!("cannot run pkexec: {e}"); false }
    }
}
