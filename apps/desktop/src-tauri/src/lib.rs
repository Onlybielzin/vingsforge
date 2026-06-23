// VingsForge desktop shell (Tauri 2). Spec 09 §3.
//
// Responsibilities of the Rust core (planned):
//   - open the main window (done below),
//   - spawn and supervise the Node sidecar host (forge-engine) over a LOCAL
//     loopback WebSocket (127.0.0.1, see @vingsforge/sidecar host + UI ipc/real),
//   - native integrations: tray, notifications, file picker, libsecret (Spec 09 §5).
//
// Unlike the OpenCovibe reference (which spawns the `claude` CLI), we own the
// engine: we run the real Node host (`@vingsforge/sidecar`) under plain `node`.
// The host listens on ws://127.0.0.1:$PORT (DEFAULT_SIDECAR_PORT = 8731) and the
// WebView's UI client (packages/ui/src/ipc/real.ts) connects to it. We do NOT
// bundle/IPC the engine — the bridge is the local WebSocket.

use std::path::{Path, PathBuf};

use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;
use uuid::Uuid;

/// Port the host should listen on. Must match @vingsforge/shared DEFAULT_SIDECAR_PORT
/// (packages/shared/src/localproto.ts) and the UI client default (ipc/real.ts).
const DEFAULT_SIDECAR_PORT: &str = "8731";

/// Env var the Node host reads its per-launch auth token from. Must match
/// @vingsforge/shared `LOCAL_AUTH_TOKEN_ENV` (packages/shared/src/localproto.ts).
const LOCAL_AUTH_TOKEN_ENV: &str = "VINGSFORGE_LOCAL_TOKEN";

/// Global the WebView reads the token from. Must match @vingsforge/shared
/// `LOCAL_AUTH_TOKEN_GLOBAL` (packages/shared/src/localproto.ts).
const LOCAL_AUTH_TOKEN_GLOBAL: &str = "__VINGSFORGE_LOCAL_TOKEN__";

/// Generate the per-launch shared secret the loopback host requires.
///
/// Binding the host to 127.0.0.1 only stops off-box attackers, NOT other local
/// processes (a malicious npm dep in another app, a browser tab opening
/// `ws://127.0.0.1:8731`, ...). So the host demands a random token, handed to the
/// WebView out of band; without it any local process could drive the engine. Two
/// v4 UUIDs (simple-encoded) give 256 bits of OS entropy with no extra crates.
fn new_auth_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

/// Relative path (from the repo root) to the built Node host entrypoint.
/// Produced by `pnpm --filter @vingsforge/sidecar build` (tsc, no bundler).
const HOST_REL_PATH: &str = "packages/sidecar/dist/host/host.js";

/// Locate the built Node host (`host.js`) for DEV / debug runs.
///
/// Resolution order (first hit wins):
///   1. `VINGSFORGE_SIDECAR` env var — an explicit absolute path to `host.js`
///      (the most robust knob; set it if the heuristics below ever miss).
///   2. Walk up from the current working directory looking for
///      `packages/sidecar/dist/host/host.js`.
///
/// Why walk up from CWD: under `tauri dev` the cwd is typically
/// `apps/desktop/src-tauri` (or `apps/desktop`), and for a plain `cargo run`
/// it may be the crate dir — in every case the repo root is some ancestor, so
/// climbing parents until we find the host is robust across those layouts.
fn locate_host() -> Option<PathBuf> {
    // 1. Explicit override.
    if let Ok(explicit) = std::env::var("VINGSFORGE_SIDECAR") {
        let p = PathBuf::from(explicit);
        if p.is_file() {
            return Some(p);
        }
        eprintln!(
            "[sidecar] VINGSFORGE_SIDECAR set but not a file: {}",
            p.display()
        );
    }

    // 2. Walk up from CWD looking for the host under the repo root.
    let cwd = std::env::current_dir().ok()?;
    let mut dir: Option<&Path> = Some(cwd.as_path());
    while let Some(d) = dir {
        let candidate = d.join(HOST_REL_PATH);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = d.parent();
    }

    None
}

/// Spawn the REAL Node sidecar host and stream its logs with a `[sidecar]` prefix.
///
/// Tolerant to failure: if `node` or `host.js` is missing we log and return, and
/// the WebView UI falls back to its mock IPC (packages/ui/src/ipc bootstrap).
fn spawn_sidecar(app: &tauri::AppHandle, auth_token: &str) {
    let host = match locate_host() {
        Some(h) => h,
        None => {
            eprintln!(
                "[sidecar] host not found ({HOST_REL_PATH}). Build it with \
                 `pnpm --filter @vingsforge/sidecar build`, or set VINGSFORGE_SIDECAR \
                 to the absolute host.js path. UI will fall back to mock."
            );
            return;
        }
    };

    let host_str = host.to_string_lossy().to_string();
    eprintln!("[sidecar] launching node {host_str} (PORT={DEFAULT_SIDECAR_PORT})");

    // Use the shell plugin's program runner for `node` (sidecar `Command` is for
    // bundled externalBin only). This streams stdout/stderr back to us as events.
    let command = app
        .shell()
        .command("node")
        .args([host_str.as_str()])
        .env("PORT", DEFAULT_SIDECAR_PORT)
        // The host refuses to start (and to accept any connection) without this.
        .env(LOCAL_AUTH_TOKEN_ENV, auth_token);

    match command.spawn() {
        Ok((mut rx, _child)) => {
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[sidecar] host exited: {payload:?}");
                            break;
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[sidecar] host error: {err}");
                        }
                        _ => {}
                    }
                }
            });
        }
        // Don't crash the shell if `node` isn't on PATH; UI falls back to mock.
        Err(err) => eprintln!("[sidecar] failed to spawn node host: {err}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // One token per launch: the host requires it on every WS handshake, and
            // the WebView must present the same value. Generate it once, hand it to
            // the host via env, and inject it into the WebView so the UI can read it
            // off `globalThis` before it opens the socket.
            let auth_token = new_auth_token();
            spawn_sidecar(app.handle(), &auth_token);

            // Inject the token into the WebView. serde_json::to_string makes a safely
            // quoted JS string literal (no injection via the token, though it is our
            // own UUID). Set both `window` and `globalThis` for robustness.
            if let Some(window) = app.get_webview_window("main") {
                let literal = serde_json::to_string(&auth_token)
                    .unwrap_or_else(|_| "\"\"".to_string());
                let script = format!(
                    "window['{global}']={literal};globalThis['{global}']={literal};",
                    global = LOCAL_AUTH_TOKEN_GLOBAL,
                    literal = literal,
                );
                if let Err(err) = window.eval(&script) {
                    eprintln!("[sidecar] failed to inject auth token into WebView: {err}");
                }
            } else {
                eprintln!("[sidecar] main window not found; auth token not injected");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running VingsForge");
}
