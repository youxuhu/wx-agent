//! pi agent — Tauri shell.
//!
//! The shell owns exactly one child process: the local service (`server.mjs`), which in turn
//! owns one `pi --mode rpc` child per workspace. The window shows the service's own UI over
//! loopback (same origin as the service, so iframes and the element picker keep working).
//!
//! Invariants kept here: loopback only (the service refuses anything else), the child is
//! terminated on exit so no pi process outlives the app, and a failure to start is reported
//! instead of showing a blank window.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

// serde_json is only used to quote the message handed to `eval`.
use serde_json;

struct ServiceProcess(Mutex<Option<Child>>);

/// Read the service's machine-readable readiness line: {"type":"piwebui-ready","port":N}
fn wait_for_port(stdout: impl std::io::Read, timeout: std::time::Duration) -> Result<u16, String> {
    let deadline = std::time::Instant::now() + timeout;
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let line = line.map_err(|error| format!("reading service output failed: {error}"))?;
        println!("[service] {line}");
        if let Some(rest) = line.strip_prefix('{') {
            let candidate = format!("{{{rest}");
            if candidate.contains("\"piwebui-ready\"") {
                if let Some(start) = candidate.find("\"port\":") {
                    let digits: String = candidate[start + 7..].chars().take_while(|c| c.is_ascii_digit()).collect();
                    if let Ok(port) = digits.parse::<u16>() {
                        return Ok(port);
                    }
                }
            }
        }
        if std::time::Instant::now() > deadline {
            return Err(format!("service did not report a port within {timeout:?}"));
        }
    }
    Err("service exited before reporting a port".to_string())
}

fn start_service(resources: &PathBuf, agent_home: &str) -> Result<(Child, u16), String> {
    let node = resources.join("node");
    let server = resources.join("server.mjs");
    let pi_script = resources.join("pi/dist/bundle/cli.js");
    let web_dir = resources.join("dist");
    for path in [&node, &server, &pi_script, &web_dir] {
        if !path.exists() {
            return Err(format!("missing bundled file: {}", path.display()));
        }
    }
    // Tauri copies resources without guaranteeing the executable bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&node).map_err(|error| error.to_string())?.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&node, permissions).map_err(|error| error.to_string())?;
    }

    let mut child = Command::new(&node)
        .arg(&server)
        .arg("--port")
        .arg("0") // let the OS pick a free port; we read it back from the readiness line
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--cwd")
        .arg(agent_home)
        .arg("--pi-node")
        .arg(&node)
        .arg("--pi-script")
        .arg(&pi_script)
        // the bundle sits in Resources/, so the built UI needs an explicit path
        .arg("--web-dir")
        .arg(&web_dir)
        .env("PI_AGENT_DESKTOP", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("could not start the bundled node: {error}"))?;

    let stdout = child.stdout.take().ok_or("no stdout from the service")?;
    match wait_for_port(stdout, std::time::Duration::from_secs(30)) {
        Ok(port) => Ok((child, port)),
        Err(error) => {
            let _ = child.kill();
            Err(error)
        }
    }
}

fn main() {
    tauri::Builder::default()
        .manage(ServiceProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            let resources = app
                .path()
                .resource_dir()
                .map_err(|error| format!("no resource dir: {error}"))?;
            let agent_home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
            std::thread::spawn(move || match start_service(&resources, &agent_home) {
                Ok((child, port)) => {
                    let url = format!("http://127.0.0.1:{port}/");
                    println!("[shell] service ready on {url}");
                    if let Some(state) = handle.try_state::<ServiceProcess>() {
                        if let Ok(mut slot) = state.0.lock() {
                            *slot = Some(child);
                        }
                    }
                    if let Some(window) = handle.get_webview_window("main") {
                        match url.parse() {
                            Ok(parsed) => {
                                if let Err(error) = window.navigate(parsed) {
                                    eprintln!("[shell] navigate failed: {error}");
                                }
                            }
                            Err(error) => eprintln!("[shell] bad url {url}: {error}"),
                        }
                    }
                }
                Err(error) => {
                    eprintln!("[shell] service start failed: {error}");
                    // Never leave a splash screen pretending nothing happened.
                    if let Some(window) = handle.get_webview_window("main") {
                        let message = format!("the local service did not start:\n\n{error}\n\nstdlib log: run the app from a terminal to see the full output");
                        let script = format!(
                            "document.getElementById('status').textContent = {};",
                            serde_json::to_string(&message).unwrap_or_else(|_| "\"start failed\"".to_string())
                        );
                        let _ = window.eval(&script);
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the tauri application")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                // Terminating the service triggers its own shutdown(): every pi child and dev
                // server it owns goes down with it.
                if let Some(state) = app.try_state::<ServiceProcess>() {
                    if let Ok(mut slot) = state.0.lock() {
                        if let Some(mut child) = slot.take() {
                            println!("[shell] stopping the service");
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
