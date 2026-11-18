// Prevents console window on Windows
#![windows_subsystem = "windows"]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProcessLogPayload {
    pub id: String,
    pub kind: String, // "server" or "client"
    pub stream: String, // "stdout", "stderr", "system"
    pub line: String,
    pub timestamp: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ProcessStatusPayload {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub running: bool,
    pub pid: Option<u32>,
}

struct ManagedProcess {
    kind: String,
    title: String,
    child: Arc<Mutex<Option<Child>>>,
}

#[derive(Default)]
pub struct AppState {
    processes: Arc<Mutex<HashMap<String, ManagedProcess>>>,
    client_counter: Arc<Mutex<u32>>,
}

fn get_now_time() -> String {
    let now = std::time::SystemTime::now();
    let duration = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = duration.as_secs();
    let hours = (secs / 3600) % 24;
    let mins = (secs / 60) % 60;
    let s = secs % 60;
    format!("{:02}:{:02}:{:02}", hours, mins, s)
}

fn emit_log(app: &AppHandle, id: &str, kind: &str, stream: &str, line: &str) {
    let _ = app.emit(
        "process-log",
        ProcessLogPayload {
            id: id.to_string(),
            kind: kind.to_string(),
            stream: stream.to_string(),
            line: line.to_string(),
            timestamp: get_now_time(),
        },
    );
}

fn emit_status(app: &AppHandle, id: &str, kind: &str, title: &str, running: bool, pid: Option<u32>) {
    let _ = app.emit(
        "process-status",
        ProcessStatusPayload {
            id: id.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            running,
            pid,
        },
    );
}

fn find_workspace_root(start: &std::path::Path) -> Option<PathBuf> {
    let mut current = Some(start.to_path_buf());
    while let Some(dir) = current {
        if dir.join("offline-app").exists() {
            return Some(dir);
        }
        current = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

/// Locates the bundled Node.js runtime for portable installs. Falls back to
/// `node` on PATH for development machines.
fn resolve_node(root: &std::path::Path) -> PathBuf {
    if let Ok(path) = std::env::var("VALERATE_NODE") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return candidate;
        }
    }
    let exe = if cfg!(windows) { "node.exe" } else { "node" };
    let candidates = [
        root.join("node").join(exe),
        root.join("runtime").join(exe),
        root.join(exe),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return candidate;
        }
    }
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

/// Finds the desktop client executable in both the source tree layout and the
/// portable distribution layout (Windows .exe, macOS .app, or bare binary).
fn resolve_client_exe(root: &std::path::Path) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("VALERATE_CLIENT_EXE") {
        let candidate = PathBuf::from(path);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        candidates.push(
            root.join("offline-tauri-client")
                .join("src-tauri")
                .join("target")
                .join("release")
                .join("offline-tauri-client.exe"),
        );
        candidates.push(
            root.join("offline-tauri-client")
                .join("src-tauri")
                .join("target")
                .join("debug")
                .join("offline-tauri-client.exe"),
        );
        candidates.push(root.join("client").join("offline-tauri-client.exe"));
        candidates.push(root.join("client").join("Valerate Messenger.exe"));
        candidates.push(root.join("offline-tauri-client.exe"));
    }

    #[cfg(not(windows))]
    {
        // Bundled .app from `tauri build` / the macOS portable package.
        let app_names = ["Valerate Messenger.app", "offline-tauri-client.app"];
        for app_name in app_names {
            let app = root.join("client").join(app_name);
            candidates.push(app.join("Contents").join("MacOS").join("offline-tauri-client"));
            candidates.push(app.join("Contents").join("MacOS").join("Valerate Messenger"));
            candidates.push(root.join(app_name).join("Contents").join("MacOS").join("offline-tauri-client"));
        }
        candidates.push(
            root.join("offline-tauri-client")
                .join("src-tauri")
                .join("target")
                .join("release")
                .join("offline-tauri-client"),
        );
        candidates.push(
            root.join("offline-tauri-client")
                .join("src-tauri")
                .join("target")
                .join("release")
                .join("bundle")
                .join("macos")
                .join("Valerate Messenger.app")
                .join("Contents")
                .join("MacOS")
                .join("offline-tauri-client"),
        );
        candidates.push(
            root.join("offline-tauri-client")
                .join("src-tauri")
                .join("target")
                .join("debug")
                .join("offline-tauri-client"),
        );
        candidates.push(root.join("client").join("offline-tauri-client"));
        candidates.push(root.join("offline-tauri-client-bin"));
        candidates.push(root.join("offline-tauri-client"));
    }

    candidates.into_iter().find(|candidate| candidate.exists())
}

fn get_workspace_root() -> PathBuf {
    // Explicit override wins, then the executable location (works when the
    // dashboard is launched from an arbitrary working directory), then cwd.
    if let Ok(env_root) = std::env::var("VALERATE_ROOT") {
        let candidate = PathBuf::from(env_root);
        if candidate.join("offline-app").exists() {
            return candidate;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(root) = find_workspace_root(dir) {
                return root;
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(root) = find_workspace_root(&cwd) {
            return root;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

#[cfg(windows)]
fn port_owner_pid(port: u16) -> Option<u32> {
    let output = Command::new("netstat").args(["-ano", "-p", "tcp"]).output().ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{}", port);
    for line in text.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 5 || !cols[0].eq_ignore_ascii_case("TCP") {
            continue;
        }
        if !cols[3].eq_ignore_ascii_case("LISTENING") || !cols[1].ends_with(&suffix) {
            continue;
        }
        if let Ok(pid) = cols[4].parse::<u32>() {
            return Some(pid);
        }
    }
    None
}

#[cfg(unix)]
fn port_owner_pid(port: u16) -> Option<u32> {
    let output = Command::new("lsof")
        .args([
            "-nP",
            &format!("-iTCP:{}", port),
            "-sTCP:LISTEN",
            "-t",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find_map(|line| line.trim().parse::<u32>().ok())
}

/// Returns true when the HTTP service on `port` answers with the Valerate app.
fn looks_like_valerate_server(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{}", port).parse::<SocketAddr>() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(600)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        port
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut collected: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 2048];
    while collected.len() < 16 * 1024 {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                collected.extend_from_slice(&buffer[..n]);
                if String::from_utf8_lossy(&collected).contains("Valerate") {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let response = String::from_utf8_lossy(&collected);
    (response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
        && response.contains("Valerate")
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> bool {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn kill_pid(pid: u32) -> bool {
    Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn start_server(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mut procs = state.processes.lock().unwrap();
    let server_id = "server-main".to_string();

    if let Some(p) = procs.get(&server_id) {
        let mut child_guard = p.child.lock().unwrap();
        if let Some(ref mut c) = *child_guard {
            match c.try_wait() {
                Ok(None) => return Ok("Server is already running".to_string()),
                _ => *child_guard = None,
            }
        }
    }

    let root = get_workspace_root();
    let offline_app_dir = root.join("offline-app");
    let server_js = offline_app_dir.join("server.js");

    if !server_js.exists() {
        return Err(format!("server.js not found at {:?}", server_js));
    }

    // If a previous Valerate server survived a dashboard crash/close, it still
    // holds port 8080. Stop that orphan so the new instance can bind cleanly
    // instead of failing with EADDRINUSE.
    if let Some(pid) = port_owner_pid(8080) {
        if looks_like_valerate_server(8080) {
            emit_log(&app, &server_id, "server", "system", &format!(
                "[!] Stopping previous Valerate server (PID {}) that was still running...", pid
            ));
            if kill_pid(pid) {
                emit_log(&app, &server_id, "server", "system", "[+] Previous server stopped.");
            } else {
                emit_log(&app, &server_id, "server", "stderr", "[!] Could not stop the previous server; it may still hold port 8080.");
            }
            thread::sleep(Duration::from_millis(500));
        } else {
            emit_log(&app, &server_id, "server", "system", "[!] Port 8080 is used by another application; the server will use the next free port.");
        }
    }

    emit_log(&app, &server_id, "server", "system", &format!("[*] Starting offline communication server from {:?}", offline_app_dir));

    let node_exe = resolve_node(&root);
    emit_log(&app, &server_id, "server", "system", &format!("[*] Using Node runtime: {:?}", node_exe));

    let mut cmd = Command::new(&node_exe);
    cmd.arg("server.js")
        .current_dir(&offline_app_dir)
        // Run in HTTP dev mode so the Tauri client (WebView2) can connect
        // over plain WebSocket without certificate trust issues. The server
        // is local-only; HTTPS is still used in production / LAN mode.
        .env("ALLOW_HTTP", "1")
        .env("PORT_HTTP", "8080")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn node server: {}", e))?;
    let pid = child.id();

    emit_log(&app, &server_id, "server", "system", &format!("[+] Server process started with PID {}", pid));
    emit_status(&app, &server_id, "server", "Valerate Server (Node.js)", true, Some(pid));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child_arc = Arc::new(Mutex::new(Some(child)));

    procs.insert(
        server_id.clone(),
        ManagedProcess {
            kind: "server".to_string(),
            title: "Valerate Server (Node.js)".to_string(),
            child: Arc::clone(&child_arc),
        },
    );

    // Stream stdout in background thread
    let app_clone = app.clone();
    let sid_clone = server_id.clone();
    if let Some(out) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    emit_log(&app_clone, &sid_clone, "server", "stdout", &line);
                }
            }
        });
    }

    // Stream stderr in background thread
    let app_clone2 = app.clone();
    let sid_clone2 = server_id.clone();
    if let Some(err) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    emit_log(&app_clone2, &sid_clone2, "server", "stderr", &line);
                }
            }
        });
    }

    // Monitor exit
    let app_clone3 = app.clone();
    let sid_clone3 = server_id.clone();
    let child_arc_clone = Arc::clone(&child_arc);
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(500));
            let mut guard = child_arc_clone.lock().unwrap();
            if let Some(ref mut c) = *guard {
                match c.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code().unwrap_or(-1);
                        emit_log(&app_clone3, &sid_clone3, "server", "system", &format!("[-] Server process exited with code {}", code));
                        emit_status(&app_clone3, &sid_clone3, "server", "Valerate Server (Node.js)", false, None);
                        *guard = None;
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        *guard = None;
                        break;
                    }
                }
            } else {
                break;
            }
        }
    });

    Ok(format!("Server started with PID {}", pid))
}

#[tauri::command]
fn stop_server(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let procs = state.processes.lock().unwrap();
    let server_id = "server-main".to_string();

    if let Some(p) = procs.get(&server_id) {
        let mut guard = p.child.lock().unwrap();
        if let Some(mut c) = guard.take() {
            let pid = c.id();
            let _ = c.kill();
            emit_log(&app, &server_id, "server", "system", &format!("[!] Killed server process (PID {})", pid));
            emit_status(&app, &server_id, "server", "Valerate Server (Node.js)", false, None);
            return Ok(format!("Server process {} terminated", pid));
        }
    }
    Ok("Server is not currently running".to_string())
}

#[tauri::command]
fn launch_client(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let mut counter = state.client_counter.lock().unwrap();
    *counter += 1;
    let client_idx = *counter;
    let client_id = format!("client-{}", client_idx);
    let title = format!("Valerate Client #{}", client_idx);

    let root = get_workspace_root();
    let client_exe = resolve_client_exe(&root);

    emit_log(&app, &client_id, "client", "system", &format!("[*] Launching {}...", title));

    let mut cmd = if let Some(exe) = client_exe {
        let mut c = Command::new(&exe);
        // Use the executable's own folder as cwd so relative resources work.
        if let Some(dir) = exe.parent() {
            c.current_dir(dir);
        }
        c
    } else {
        // Fallback to cargo run in offline-tauri-client/src-tauri
        let mut c = Command::new("cargo");
        c.arg("run")
            .current_dir(root.join("offline-tauri-client").join("src-tauri"));
        c
    };

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn client executable: {}", e))?;
    let pid = child.id();

    emit_log(&app, &client_id, "client", "system", &format!("[+] {} running with PID {}", title, pid));
    emit_status(&app, &client_id, "client", &title, true, Some(pid));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child_arc = Arc::new(Mutex::new(Some(child)));

    {
        let mut procs = state.processes.lock().unwrap();
        procs.insert(
            client_id.clone(),
            ManagedProcess {
                kind: "client".to_string(),
                title: title.clone(),
                child: Arc::clone(&child_arc),
            },
        );
    }

    // Stream client stdout
    let app_clone = app.clone();
    let cid_clone = client_id.clone();
    if let Some(out) = stdout {
        thread::spawn(move || {
            let reader = BufReader::new(out);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    emit_log(&app_clone, &cid_clone, "client", "stdout", &line);
                }
            }
        });
    }

    // Stream client stderr
    let app_clone2 = app.clone();
    let cid_clone2 = client_id.clone();
    if let Some(err) = stderr {
        thread::spawn(move || {
            let reader = BufReader::new(err);
            for line_res in reader.lines() {
                if let Ok(line) = line_res {
                    emit_log(&app_clone2, &cid_clone2, "client", "stderr", &line);
                }
            }
        });
    }

    // Monitor exit
    let app_clone3 = app.clone();
    let cid_clone3 = client_id.clone();
    let title_clone = title.clone();
    let child_arc_clone = Arc::clone(&child_arc);
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_millis(500));
            let mut guard = child_arc_clone.lock().unwrap();
            if let Some(ref mut c) = *guard {
                match c.try_wait() {
                    Ok(Some(status)) => {
                        let code = status.code().unwrap_or(-1);
                        emit_log(&app_clone3, &cid_clone3, "client", "system", &format!("[-] {} exited with code {}", title_clone, code));
                        emit_status(&app_clone3, &cid_clone3, "client", &title_clone, false, None);
                        *guard = None;
                        break;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        *guard = None;
                        break;
                    }
                }
            } else {
                break;
            }
        }
    });

    Ok(format!("{} launched with PID {}", title, pid))
}

#[tauri::command]
fn stop_process(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    let procs = state.processes.lock().unwrap();
    if let Some(p) = procs.get(&id) {
        let mut guard = p.child.lock().unwrap();
        if let Some(mut c) = guard.take() {
            let pid = c.id();
            let _ = c.kill();
            emit_log(&app, &id, &p.kind, "system", &format!("[!] Force-closed {} (PID {})", p.title, pid));
            emit_status(&app, &id, &p.kind, &p.title, false, None);
            return Ok(format!("Terminated {}", p.title));
        }
    }
    Ok("Process not found or already stopped".to_string())
}

#[tauri::command]
fn wipe_vault_db(app: AppHandle, confirm: String) -> Result<String, String> {
    // Defence in depth: destructive IPC requires an explicit backend check,
    // not just the React confirmation dialog.
    if confirm != "WIPE PERSONAL VAULT" {
        return Err("Vault wipe requires explicit confirmation.".to_string());
    }

    let root = get_workspace_root();
    let script = root.join("offline-app").join("wipe_vault.js");
    if !script.exists() {
        return Err("wipe_vault.js not found".to_string());
    }

    emit_log(&app, "server-main", "server", "system", "[*] Executing Personal Vault wipe...");

    let mut cmd = Command::new(resolve_node(&root));
    cmd.arg(&script)
        .current_dir(root.join("offline-app"));
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run wipe_vault: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("wipe_vault.js failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        emit_log(&app, "server-main", "server", "system", line);
    }
    Ok("Personal vault wipe complete".to_string())
}

#[tauri::command]
fn wipe_all_data(app: AppHandle, state: State<'_, AppState>, confirm: String) -> Result<String, String> {
    // Destructive IPC requires an explicit backend check, not just the React
    // confirmation dialog.
    if confirm != "WIPE ALL DATA" {
        return Err("Full data wipe requires explicit confirmation.".to_string());
    }

    // 1. Stop the server managed by this dashboard. Windows locks the SQLite
    //    files and uploads while Node has them open.
    let server_id = "server-main".to_string();
    {
        let procs = state.processes.lock().unwrap();
        if let Some(p) = procs.get(&server_id) {
            let mut guard = p.child.lock().unwrap();
            if let Some(mut c) = guard.take() {
                let pid = c.id();
                let _ = c.kill();
                let _ = c.wait();
                emit_log(&app, &server_id, "server", "system", &format!("[!] Stopped server (PID {}) before wiping data", pid));
                emit_status(&app, &server_id, "server", "Valerate Server (Node.js)", false, None);
            }
        }
    }

    // 2. Also stop a server started outside the dashboard (for example via
    //    "Start Server Only"), otherwise its files stay locked.
    if let Some(pid) = port_owner_pid(8080) {
        if looks_like_valerate_server(8080) {
            emit_log(&app, &server_id, "server", "system", &format!("[!] Stopping external Valerate server (PID {}) before wiping data", pid));
            kill_pid(pid);
        }
    }

    // Give the OS a moment to release the file handles.
    thread::sleep(Duration::from_millis(600));

    // 3. Delete the account database, chats, personal vault, audit log and
    //    uploads. Recreate empty folders so the next start is clean.
    let root = get_workspace_root();
    let app_dir = root.join("offline-app");
    let targets = [app_dir.join("data"), app_dir.join("uploads")];

    let mut freed: u64 = 0;
    let mut removed = Vec::new();

    for target in targets {
        if !target.exists() {
            fs::create_dir_all(&target)
                .map_err(|e| format!("Could not create {:?}: {}", target, e))?;
            continue;
        }
        freed += directory_size(&target);
        fs::remove_dir_all(&target)
            .map_err(|e| format!("Could not delete {:?}: {}. Stop any running server and retry.", target, e))?;
        fs::create_dir_all(&target)
            .map_err(|e| format!("Could not recreate {:?}: {}", target, e))?;
        removed.push(target.display().to_string());
    }

    let mb = directory_size_fmt(freed);
    emit_log(&app, &server_id, "server", "system", &format!(
        "[+] Wiped all server data ({} freed). Accounts, chats, vault and uploads are gone.",
        mb
    ));
    for path in &removed {
        emit_log(&app, &server_id, "server", "system", &format!("    deleted {}", path));
    }

    Ok(format!("All server data wiped ({} freed)", mb))
}

fn directory_size_fmt(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{} bytes", bytes)
    }
}

fn directory_size(path: &std::path::Path) -> u64 {
    let mut total = 0;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let entry_path = entry.path();
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    total += directory_size(&entry_path);
                } else {
                    total += meta.len();
                }
            }
        }
    }
    total
}

#[tauri::command]
fn get_processes(state: State<'_, AppState>) -> Vec<ProcessStatusPayload> {
    let procs = state.processes.lock().unwrap();
    let mut list = Vec::new();
    for (id, p) in procs.iter() {
        let mut guard = p.child.lock().unwrap();
        let (running, pid) = if let Some(ref mut c) = *guard {
            match c.try_wait() {
                Ok(None) => (true, Some(c.id())),
                _ => (false, None),
            }
        } else {
            (false, None)
        };
        list.push(ProcessStatusPayload {
            id: id.clone(),
            kind: p.kind.clone(),
            title: p.title.clone(),
            running,
            pid,
        });
    }
    list
}

fn main() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            launch_client,
            stop_process,
            wipe_vault_db,
            wipe_all_data,
            get_processes
        ])
        .build(tauri::generate_context!())
        .expect("error while building valerate dashboard application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Do not leave orphaned node/server processes behind: they would
            // keep holding ports and break the next launch.
            if let Some(state) = app_handle.try_state::<AppState>() {
                if let Ok(procs) = state.processes.lock() {
                    for process in procs.values() {
                        if let Ok(mut guard) = process.child.lock() {
                            if let Some(mut child) = guard.take() {
                                let _ = child.kill();
                            }
                        }
                    }
                }
            }
        }
    });
}
