//! Tavily MCP multi-key server (Rust rewrite of the TypeScript v0.2.2).
//! stdio server with key rotation, daily re-probe, and the full lifecycle
//! safety net from issue #2: stdin EOF, SIGTERM/SIGINT/SIGHUP, orphan
//! self-check, and timer tasks that die with the service.

mod key_pool;
mod tavily;
mod tools;

use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, Timelike};
use serde_json::{json, Map, Value};
use tokio::sync::{watch, Mutex};

use tavily::TavilyClient;
use tools::{dispatch, render_tool_error, tool_definitions};

// ---- env parsing (ports of clampInt / parseApiKeys / config constants) ----

fn clamp_u32(name: &str, min: u32, max: u32, fallback: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .map(|parsed| parsed.clamp(min as i64, max as i64) as u32)
        .unwrap_or(fallback)
}

fn parse_api_keys() -> Vec<String> {
    if let Ok(raw) = std::env::var("TAVILY_API_KEYS") {
        let keys: Vec<String> = raw
            .split([',', '\n'])
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty())
            .collect();
        if !keys.is_empty() {
            return keys;
        }
    }
    match std::env::var("TAVILY_API_KEY") {
        Ok(single) if !single.trim().is_empty() => vec![single.trim().to_string()],
        _ => vec![],
    }
}

/// Live parent pid from /proc (Linux) — mirrors process.ppid semantics.
fn current_ppid() -> u32 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find(|line| line.starts_with("PPid:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(u32::MAX)
}

// ---- MCP service handler ----

struct TavilyMcp {
    client: Arc<Mutex<TavilyClient>>,
    reprobe_hour: u32,
    reprobe_tz: String,
}

impl rmcp::ServerHandler for TavilyMcp {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        use rmcp::model::*;
        ServerInfo {
            protocol_version: ProtocolVersion::V_2025_06_18,
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: Implementation {
                name: "tavily-mcp-multi-key".to_string(),
                title: None,
                version: env!("CARGO_PKG_VERSION").to_string(),
                icons: None,
                website_url: None,
            },
            instructions: None,
        }
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParam>,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::ListToolsResult, rmcp::ErrorData> {
        let tools = tool_definitions()
            .into_iter()
            .map(|definition| {
                let schema_map: Map<String, Value> = definition["inputSchema"]
                    .as_object()
                    .cloned()
                    .unwrap_or_default();
                rmcp::model::Tool {
                    name: definition["name"].as_str().unwrap_or_default().to_string().into(),
                    title: None,
                    description: definition["description"].as_str().map(|s| s.to_string().into()),
                    input_schema: Arc::new(schema_map),
                    output_schema: None,
                    annotations: None,
                    icons: None,
                }
            })
            .collect();
        Ok(rmcp::model::ListToolsResult {
            next_cursor: None,
            tools,
        })
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParam,
        _context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
        let name = request.name.to_string();
        let args: Value = match request.arguments {
            Some(map) => Value::Object(map),
            None => json!({}),
        };

        let mut client = self.client.lock().await;
        let outcome = dispatch(&name, &args, &mut client, (self.reprobe_hour, self.reprobe_tz.clone()))
            .await;
        let output = match outcome {
            Ok(output) => output,
            Err(error) => render_tool_error(&name, error),
        };

        Ok(rmcp::model::CallToolResult {
            content: vec![rmcp::model::Content::text(output.text)],
            structured_content: None,
            is_error: if output.is_error { Some(true) } else { None },
            meta: None,
        })
    }
}

// ---- Background tasks ----

/// Daily re-probe after REPROBE_HOUR in REPROBE_TZ (calendar-day guard, port
/// of scheduleDailyReprobe). Stops when `shutdown` fires.
async fn daily_reprobe(
    client: Arc<Mutex<TavilyClient>>,
    hour: u32,
    tz_name: String,
    tick_ms: u64,
    mut shutdown: watch::Receiver<bool>,
) {
    let tz: chrono_tz::Tz = tz_name.parse().unwrap_or(chrono_tz::Asia::Shanghai);
    let mut last_probe_day = chrono::Utc::now().with_timezone(&tz).day();

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() {
                    break;
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(tick_ms.max(1))) => {
                let now = chrono::Utc::now().with_timezone(&tz);
                if now.hour() >= hour && now.day() != last_probe_day {
                    last_probe_day = now.day();
                    let reason = format!("daily re-probe {hour:02}:00 {tz_name}");
                    client.lock().await.probe_all_keys(&reason).await;
                }
            }
        }
    }
}

/// Orphan self-check: re-parenting proves the host is gone — exit (issue #2).
async fn orphan_watchdog(initial_ppid: u32, interval_ms: u64, shutdown: watch::Sender<bool>) {
    if interval_ms == 0 {
        return; // TAVILY_ORPHAN_CHECK_MS=0 disables the check entirely
    }
    loop {
        tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        if current_ppid() != initial_ppid {
            eprintln!("[tavily-mcp-multi-key] shutting down (orphaned — parent exited)");
            let _ = shutdown.send(true);
            break;
        }
    }
}

/// SIGTERM / SIGINT / SIGHUP → clean shutdown (issue #2 loop).
/// Windows has no POSIX signals; CTRL+C/CTRL+BREAK map to the interrupt path.
async fn signal_watch(shutdown: watch::Sender<bool>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let Ok(mut sigterm) = signal(SignalKind::terminate()) else { return };
        let Ok(mut sigint) = signal(SignalKind::interrupt()) else { return };
        let Ok(mut sighup) = signal(SignalKind::hangup()) else { return };

        tokio::select! {
            _ = sigterm.recv() => eprintln!("[tavily-mcp-multi-key] shutting down (SIGTERM)"),
            _ = sigint.recv() => eprintln!("[tavily-mcp-multi-key] shutting down (SIGINT)"),
            _ = sighup.recv() => eprintln!("[tavily-mcp-multi-key] shutting down (SIGHUP)"),
        }
    }
    #[cfg(not(unix))]
    {
        match tokio::signal::ctrl_c().await {
            Ok(()) => eprintln!("[tavily-mcp-multi-key] shutting down (ctrl-c)"),
            Err(err) => eprintln!("[tavily-mcp-multi-key] signal watch error: {err}"),
        }
    }
    let _ = shutdown.send(true);
}

// ---- main ----

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--list-tools") {
        println!("{}", tools::list_tools_cli());
        return Ok(());
    }

    let api_keys = parse_api_keys();
    let keyless = api_keys.is_empty();
    if keyless {
        eprintln!(
            "[tavily-mcp-multi-key] no Tavily API key set; running in keyless mode. Search and extract are available; other tools will return a message explaining that an API key is required."
        );
    }

    let reprobe_hour = clamp_u32("TAVILY_REPROBE_HOUR", 0, 23, 5);
    let reprobe_tz = std::env::var("TAVILY_REPROBE_TZ").unwrap_or_else(|_| "Asia/Shanghai".into());
    let reprobe_tick_ms = clamp_u32("TAVILY_REPROBE_TICK_MS", 1_000, 3_600_000, 60_000) as u64;
    let orphan_check_ms = clamp_u32("TAVILY_ORPHAN_CHECK_MS", 0, 3_600_000, 60_000) as u64;

    let base_url = std::env::var("TAVILY_API_BASE_URL")
        .unwrap_or_else(|_| "https://api.tavily.com".into());
    let human_id = std::env::var("TAVILY_HUMAN_ID").ok();
    let session_id = uuid::Uuid::new_v4().to_string();

    let client = Arc::new(Mutex::new(TavilyClient::new(
        api_keys,
        &base_url,
        &session_id,
        human_id.as_deref(),
    )));

    // Startup preflight probe, then schedule the daily re-probe.
    // Earliest-possible parent snapshot, before any network round-trip widens
    // the race window (same rationale as the TS INITIAL_PPID).
    let initial_ppid = current_ppid();

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);

    if !keyless {
        client.lock().await.probe_all_keys("startup preflight").await;
        tokio::spawn(daily_reprobe(
            client.clone(),
            reprobe_hour,
            reprobe_tz.clone(),
            reprobe_tick_ms,
            shutdown_rx.clone(),
        ));
    }

    // Lifecycle safety net (issue #2) starts BEFORE the MCP handshake: a host
    // that dies without ever initializing (or without closing stdin) must
    // still not leave us lingering. TS parity: INITIAL_PPID snapshot + timers
    // live from module load, independent of transport state.
    tokio::spawn(signal_watch(shutdown_tx.clone()));
    tokio::spawn(orphan_watchdog(initial_ppid, orphan_check_ms, shutdown_tx.clone()));

    let handler = TavilyMcp {
        client: client.clone(),
        reprobe_hour,
        reprobe_tz: reprobe_tz.clone(),
    };

    let service = match tokio::select! {
        _ = shutdown_rx.changed() => {
            // Host died (signal / orphan) before the handshake completed.
            std::process::exit(0);
        }
        started = rmcp::service::serve_server(
            handler,
            (tokio::io::stdin(), tokio::io::stdout()),
        ) => started,
    } {
        Ok(service) => service,
        Err(error) => {
            // A host that closes stdin before/during the handshake walked
            // away — exit quietly instead of lingering or erroring (the
            // issue #2 contract: never outlive the host).
            eprintln!("[tavily-mcp-multi-key] host closed stdio during startup: {error}");
            std::process::exit(0);
        }
    };
    eprintln!("Tavily MCP multi-key server running on stdio");

    tokio::select! {
        changed = shutdown_rx.changed() => {
            let _ = changed;
            // Give the service a beat to flush pending responses, then exit.
            tokio::time::sleep(Duration::from_millis(100)).await;
            std::process::exit(0);
        }
        quit = service.waiting() => {
            // The transport closed (host closed stdin / peer went away) —
            // issue #2 layer 1 without a second stdin reader.
            eprintln!("[tavily-mcp-multi-key] shutting down (transport closed: {quit:?})");
            std::process::exit(0);
        }
    }
}
