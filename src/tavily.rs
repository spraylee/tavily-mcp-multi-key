//! Tavily REST client with multi-key rotation, research polling/streaming.

use std::time::Duration;

use reqwest::{Client, Method, StatusCode};
use serde_json::{json, Value};

use crate::key_pool::{KeyPool, KeyProbeResult, ProbeOutcome, DEFAULT_COOLDOWN_MS};

pub const STALE_PROBE_MS: u64 = 10 * 60_000;

/// Error from a Tavily HTTP call: status + best-effort body detail.
#[derive(Debug)]
pub struct ApiError {
    pub status: Option<u16>,
    pub detail: String,
    /// Parsed response body when JSON (used by keyless envelope handling).
    pub body: Option<Value>,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(
                f,
                "Request failed with status code {status}: {}",
                self.detail
            ),
            None => write!(f, "{}", self.detail),
        }
    }
}

impl ApiError {
    pub fn from_reqwest(err: &reqwest::Error) -> Self {
        ApiError {
            status: err.status().map(|s| s.as_u16()),
            detail: err.to_string(),
            body: None,
        }
    }
}

pub fn is_key_rotation_status(status: Option<u16>) -> bool {
    matches!(status, Some(401) | Some(429) | Some(432) | Some(433))
}

/// Tool-level error, mirroring the TS exception flow.
#[derive(Debug)]
pub enum ToolError {
    Api(ApiError),
    /// Research poll/stream failures bound to the creating key — must not
    /// re-create the task on another key.
    KeyBound(ApiError),
    NoAvailableKeys(String),
    UnknownTool(String),
}

impl ToolError {
    fn rotation_info(&self) -> (Option<u16>, bool) {
        match self {
            ToolError::Api(err) => (err.status, false),
            ToolError::KeyBound(err) => (err.status, true),
            ToolError::NoAvailableKeys(_) => (None, false),
            ToolError::UnknownTool(_) => (None, false),
        }
    }
}

impl From<ApiError> for ToolError {
    fn from(err: ApiError) -> Self {
        ToolError::Api(err)
    }
}

pub struct TavilyClient {
    http: Client,
    pub key_pool: Option<KeyPool>,
    base_url: String,
    keyless: bool,
}

impl TavilyClient {
    pub fn new(
        api_keys: Vec<String>,
        base_url: &str,
        session_id: &str,
        human_id: Option<&str>,
    ) -> Self {
        let keyless = api_keys.is_empty();
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("accept", "application/json".parse().unwrap());
        headers.insert("content-type", "application/json".parse().unwrap());
        if let Ok(v) = session_id.parse() {
            headers.insert("x-session-id", v);
        }
        if let Some(human) = human_id {
            if let Ok(v) = human.parse() {
                headers.insert("x-human-id", v);
            }
        }
        let http = Client::builder()
            .default_headers(headers)
            .pool_idle_timeout(Duration::from_secs(90))
            .build()
            .expect("reqwest client");
        TavilyClient {
            http,
            key_pool: if keyless {
                None
            } else {
                Some(KeyPool::new(api_keys, DEFAULT_COOLDOWN_MS))
            },
            base_url: base_url.trim_end_matches('/').to_string(),
            keyless,
        }
    }

    fn auth_headers(&self, api_key: Option<&str>) -> reqwest::header::HeaderMap {
        let mut headers = reqwest::header::HeaderMap::new();
        if self.keyless {
            headers.insert("x-tavily-access-mode", "keyless".parse().unwrap());
            headers.insert("x-client-source", "tavily-mcp-keyless".parse().unwrap());
        } else {
            if let Ok(v) = format!("Bearer {}", api_key.unwrap_or_default()).parse() {
                headers.insert("authorization", v);
            }
            headers.insert("x-client-source", "MCP".parse().unwrap());
        }
        headers
    }

    fn add_api_key(&self, mut params: Value, api_key: Option<&str>) -> Value {
        if self.keyless {
            return params;
        }
        if !params.is_object() {
            params = json!({});
        }
        params["api_key"] = json!(api_key);
        params
    }

    async fn request(
        &self,
        method: Method,
        url: &str,
        body: Option<Value>,
        api_key: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, ApiError> {
        let mut builder = self
            .http
            .request(method, url)
            .headers(self.auth_headers(api_key))
            .timeout(timeout);
        if let Some(body) = body {
            builder = builder.json(&body);
        }
        let response = builder
            .send()
            .await
            .map_err(|e| ApiError::from_reqwest(&e))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| ApiError::from_reqwest(&e))?;
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));

        if !status.is_success() {
            let detail = extract_detail(&parsed, &text);
            return Err(ApiError {
                status: Some(status.as_u16()),
                detail,
                body: if parsed.is_null() { None } else { Some(parsed) },
            });
        }
        Ok(parsed)
    }

    /// Probe every key and log a summary line to stderr.
    pub async fn probe_all_keys(&mut self, reason: &str) {
        let Some(pool) = self.key_pool.as_mut() else {
            return;
        };
        let base_url = self.base_url.clone();
        let http = self.http.clone();
        pool.probe(|key| {
            let http = http.clone();
            let base_url = base_url.clone();
            async move { probe_usage(&http, &base_url, &key).await }
        })
        .await;

        let snapshots = pool.snapshots();
        let summary = snapshots
            .iter()
            .map(|s| {
                let remaining = match s.get("remaining") {
                    None | Some(Value::Null) => String::new(),
                    Some(v) => format!(", remaining={v}"),
                };
                format!(
                    "#{} {} {}{}",
                    s["index"].as_u64().unwrap_or(0),
                    s["key"].as_str().unwrap_or(""),
                    s["status"].as_str().unwrap_or(""),
                    remaining
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        eprintln!("[tavily-mcp-multi-key] key probe ({reason}): {summary}");
    }

    /// Run one tool request with key rotation (TS runWithKey). The operation
    /// enum sidesteps HRTB closure-lifetime fights: one concrete future type
    /// per endpoint, selected before the loop.
    pub async fn run_with_key(&mut self, operation: Operation) -> Result<Value, ToolError> {
        let Some(pool_size) = self.key_pool.as_ref().map(|p| p.size()) else {
            return self.execute(operation, None).await;
        };

        let mut last_error: Option<ToolError> = None;
        let mut attempt = 0usize;
        loop {
            if attempt >= pool_size {
                break;
            }
            attempt += 1;

            let api_key = match self.key_pool.as_mut().map(|p| p.next_key()) {
                Some(Some(key)) => key,
                Some(None) => {
                    // Every key unavailable. If knowledge is stale (quotas may
                    // have just reset at month start), re-probe once, retry.
                    let stale = self
                        .key_pool
                        .as_ref()
                        .map(|p| p.probe_is_stale(STALE_PROBE_MS))
                        .unwrap_or(false);
                    if stale {
                        self.probe_all_keys("all keys unavailable — stale probe check")
                            .await;
                        continue;
                    }
                    break;
                }
                None => unreachable!("key_pool vanished mid-loop"),
            };

            match self.execute(operation.clone(), Some(api_key.clone())).await {
                Ok(result) => {
                    if let Some(pool) = self.key_pool.as_mut() {
                        pool.mark_success(&api_key);
                    }
                    return Ok(result);
                }
                Err(error) => {
                    let (status, is_key_bound) = error.rotation_info();
                    if let Some(pool) = self.key_pool.as_mut() {
                        pool.mark_failure(&api_key, status, None);
                    }
                    last_error = Some(error);
                    if is_key_bound || !is_key_rotation_status(status) {
                        return Err(last_error.unwrap());
                    }
                }
            }
        }

        match last_error {
            Some(error) => Err(error),
            None => Err(ToolError::NoAvailableKeys(
                self.key_pool
                    .as_mut()
                    .map(|p| p.unavailable_message())
                    .unwrap_or_else(|| "No Tavily API keys configured.".to_string()),
            )),
        }
    }

    async fn execute(
        &self,
        operation: Operation,
        api_key: Option<String>,
    ) -> Result<Value, ToolError> {
        match operation {
            Operation::Search { params } => {
                let payload = self.add_api_key(clean_search_params(&params), api_key.as_deref());
                let url = format!("{}/search", self.base_url);
                self.request(
                    Method::POST,
                    &url,
                    Some(payload),
                    api_key.as_deref(),
                    Duration::from_secs(60),
                )
                .await
                .map_err(ToolError::Api)
            }
            Operation::Endpoint { endpoint, params } => {
                let payload = self.add_api_key(params, api_key.as_deref());
                let url = format!("{}/{endpoint}", self.base_url);
                self.request(
                    Method::POST,
                    &url,
                    Some(payload),
                    api_key.as_deref(),
                    Duration::from_secs(300),
                )
                .await
                .map_err(ToolError::Api)
            }
            Operation::Research { params } => research_with_key(self, params, api_key).await,
        }
    }

    // ---- Tool endpoints ----

    pub async fn search(&mut self, params: Value) -> Result<Value, ToolError> {
        self.run_with_key(Operation::Search { params }).await
    }

    /// extract / crawl / map share one shape: POST params to /<endpoint>.
    pub async fn simple_endpoint(
        &mut self,
        endpoint: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        self.run_with_key(Operation::Endpoint {
            endpoint: endpoint.to_string(),
            params,
        })
        .await
    }

    pub async fn research(&mut self, params: Value) -> Result<Value, ToolError> {
        self.run_with_key(Operation::Research { params }).await
    }
}

/// One tool request, chosen before the rotation loop (one concrete future
/// type per endpoint — dodges HRTB closure-lifetime fights).
#[derive(Debug, Clone)]
pub enum Operation {
    Search { params: Value },
    Endpoint { endpoint: String, params: Value },
    Research { params: Value },
}

async fn probe_usage(http: &Client, base_url: &str, api_key: &str) -> ProbeOutcome {
    let url = format!("{base_url}/usage");
    let mut headers = reqwest::header::HeaderMap::new();
    if let Ok(v) = format!("Bearer {api_key}").parse() {
        headers.insert("authorization", v);
    }
    headers.insert("x-client-source", "MCP".parse().unwrap());
    let result = http
        .get(&url)
        .headers(headers)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    match result {
        Ok(response) => {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            if !status.is_success() {
                return match status.as_u16() {
                    401 => ProbeOutcome::Result(KeyProbeResult::invalid()),
                    432 | 433 => ProbeOutcome::Result(KeyProbeResult::exhausted()),
                    _ => ProbeOutcome::Result(KeyProbeResult::unknown()),
                };
            }
            ProbeOutcome::Result(usage_to_probe_result(&parsed))
        }
        Err(_) => ProbeOutcome::NetworkError,
    }
}

// ---- Pure helpers ----

/// Parse GET /usage into a probe result (TS probeKey happy path).
pub fn usage_to_probe_result(data: &Value) -> KeyProbeResult {
    let key_limit = data.pointer("/key/limit").cloned();
    let key_limit_is_number = key_limit.as_ref().is_some_and(|v| v.as_f64().is_some());

    let (usage, limit) = if key_limit_is_number {
        (
            data.pointer("/key/usage").and_then(|v| v.as_f64()),
            key_limit,
        )
    } else {
        (
            data.pointer("/account/plan_usage").and_then(|v| v.as_f64()),
            data.pointer("/account/plan_limit").cloned(),
        )
    };

    let Some(usage) = usage else {
        return KeyProbeResult::active();
    };
    let Some(limit_value) = limit else {
        return KeyProbeResult::active();
    };
    let limit = match limit_value {
        Value::Null => return KeyProbeResult::active_remaining(None), // unlimited
        v => match v.as_f64() {
            Some(n) => n,
            None => return KeyProbeResult::active(),
        },
    };
    let remaining = (limit - usage).max(0.0);
    if remaining == 0.0 {
        KeyProbeResult::exhausted()
    } else {
        KeyProbeResult::active_remaining(Some(remaining as u64))
    }
}

/// Apply DEFAULT_PARAMETERS env, the time_range-vs-dates conflict rule, and
/// drop empty values (TS searchWithKey payload preparation).
pub fn clean_search_params(params: &Value) -> Value {
    let defaults: Value = std::env::var("DEFAULT_PARAMETERS")
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|v: &Value| v.is_object())
        .unwrap_or_else(|| json!({}));

    let mut search_params = json!({
        "query": params.get("query").cloned().unwrap_or(Value::Null),
        "search_depth": params.get("search_depth").cloned().unwrap_or(Value::Null),
        "topic": params.get("topic").cloned().unwrap_or(Value::Null),
        "time_range": params.get("time_range").cloned().unwrap_or(Value::Null),
        "max_results": params.get("max_results").cloned().unwrap_or(Value::Null),
        "include_images": params.get("include_images").cloned().unwrap_or(Value::Null),
        "include_image_descriptions": params.get("include_image_descriptions").cloned().unwrap_or(Value::Null),
        "include_raw_content": params.get("include_raw_content").cloned().unwrap_or(Value::Null),
        "include_domains": ensure_array(params.get("include_domains")),
        "exclude_domains": ensure_array(params.get("exclude_domains")),
        "country": params.get("country").cloned().unwrap_or(Value::Null),
        "include_favicon": params.get("include_favicon").cloned().unwrap_or(Value::Null),
        "start_date": params.get("start_date").cloned().unwrap_or(Value::Null),
        "end_date": params.get("end_date").cloned().unwrap_or(Value::Null),
        "exact_match": params.get("exact_match").cloned().unwrap_or(Value::Null),
    });

    if let (Some(defaults), Some(target)) = (defaults.as_object(), search_params.as_object_mut()) {
        for (key, value) in defaults {
            if target.contains_key(key) {
                target.insert(key.clone(), value.clone());
            }
        }
    }

    // start/end dates and time_range are mutually exclusive at the API.
    let has_dates = search_params
        .get("start_date")
        .is_some_and(|v| !v.is_null())
        || search_params.get("end_date").is_some_and(|v| !v.is_null());
    if has_dates
        && search_params
            .get("time_range")
            .is_some_and(|v| !v.is_null())
    {
        search_params["time_range"] = Value::Null;
    }

    // Drop empty strings / nulls / empty arrays.
    let mut cleaned = json!({});
    if let Some(target) = search_params.as_object() {
        for (key, value) in target {
            let is_empty = match value {
                Value::Null => true,
                Value::String(s) => s.is_empty(),
                Value::Array(a) => a.is_empty(),
                _ => false,
            };
            if !is_empty {
                cleaned[key.clone()] = value.clone();
            }
        }
    }
    cleaned
}

fn ensure_array(value: Option<&Value>) -> Value {
    match value {
        Some(Value::Array(a)) => json!(a),
        _ => json!([]),
    }
}

fn extract_detail(body: &Value, raw: &str) -> String {
    match body {
        Value::Object(map) => match (map.get("detail"), map.get("message")) {
            (Some(detail), _) => detail_to_string(detail),
            (None, Some(message)) => detail_to_string(message),
            (None, None) => serde_json::to_string(body).unwrap_or_else(|_| raw.to_string()),
        },
        _ => raw.to_string(),
    }
}

fn detail_to_string(detail: &Value) -> String {
    match detail {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// Render the Tavily keyless recoverable-error envelope as plain text.
pub fn format_keyless_envelope(data: &Value) -> String {
    let Some(err) = data.get("error") else {
        return String::new();
    };
    let mut lines: Vec<String> = vec![err
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()];
    if let Some(retry) = err.get("retry_after_seconds") {
        if !retry.is_null() {
            lines.push(format!("Retry after: {retry}s"));
        }
    }
    if let Some(actions) = err.get("next_actions").and_then(|v| v.as_array()) {
        if !actions.is_empty() {
            lines.push(String::new());
            lines.push("Continuation options:".to_string());
            for action in actions {
                let action_type = action.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match action_type {
                    "agentic_payment" => lines.push(format!(
                        "- Agentic payment ({}): {}",
                        action
                            .get("scheme")
                            .and_then(|v| v.as_str())
                            .unwrap_or("x402"),
                        action.get("details").and_then(|v| v.as_str()).unwrap_or("")
                    )),
                    "signup" => lines.push(format!(
                        "- Sign up for a Tavily API key: {}",
                        action.get("url").and_then(|v| v.as_str()).unwrap_or("")
                    )),
                    "bonus_credits"
                        if action
                            .get("eligible")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false) =>
                    {
                        lines.push(format!(
                            "- Earn {} bonus credits by POSTing answers to {}",
                            action
                                .get("credits_on_completion")
                                .map(|v| v.to_string())
                                .unwrap_or_default(),
                            action
                                .get("endpoint")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                        ));
                        if let Some(questions) = action.get("questions").and_then(|v| v.as_array())
                        {
                            for (i, question) in questions.iter().enumerate() {
                                lines.push(format!("    {}. {}", i + 1, question));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    lines
        .into_iter()
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn is_keyless_envelope(data: Option<&Value>) -> bool {
    data.and_then(|d| d.get("error"))
        .and_then(|e| e.get("code"))
        .and_then(|c| c.as_str())
        .is_some()
}

// ---- Research (polling + streaming fallback) ----

const RESEARCH_DOCS: &str = "https://docs.tavily.com/documentation/api-reference/endpoint/research";

async fn research_with_key(
    client: &TavilyClient,
    params: Value,
    api_key: Option<String>,
) -> Result<Value, ToolError> {
    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();
    let input = params
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let create_body = json!({ "input": input, "model": model });
    let url = format!("{}/research", client.base_url);
    let created = match client
        .request(
            Method::POST,
            &url,
            Some(client.add_api_key(create_body, api_key.as_deref())),
            api_key.as_deref(),
            Duration::from_secs(60),
        )
        .await
    {
        Ok(body) => body,
        Err(err) => {
            // 400 research_stream_required → transparent stream fallback.
            if err.status == Some(400)
                && err
                    .body
                    .as_ref()
                    .and_then(|b| b.pointer("/detail/error_code"))
                    .and_then(|v| v.as_str())
                    == Some("research_stream_required")
            {
                return research_via_stream(client, params, api_key).await;
            }
            return Err(ToolError::Api(err));
        }
    };

    let Some(request_id) = created.get("request_id").and_then(|v| v.as_str()) else {
        return Ok(
            json!({ "error": format!("No request_id returned from research endpoint. Documentation: {RESEARCH_DOCS}") }),
        );
    };

    let max_poll_ms: u64 = if model == "mini" { 300_000 } else { 900_000 };
    let mut poll_interval: u64 = 2_000;
    let mut total_elapsed: u64 = 0;

    while total_elapsed < max_poll_ms {
        tokio::time::sleep(Duration::from_millis(poll_interval)).await;
        total_elapsed += poll_interval;

        let poll_url = format!("{}/research/{}", client.base_url, request_id);
        match client
            .request(
                Method::GET,
                &poll_url,
                None,
                api_key.as_deref(),
                Duration::from_secs(30),
            )
            .await
        {
            Ok(body) => {
                let status = body
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                match status {
                    "completed" => {
                        return Ok(json!({
                            "content": body.get("content").and_then(|v| v.as_str()).unwrap_or("")
                        }));
                    }
                    "failed" => {
                        return Ok(
                            json!({ "error": format!("Research task failed. Documentation: {RESEARCH_DOCS}") }),
                        );
                    }
                    _ => {}
                }
            }
            Err(err) => {
                if err.status == Some(404) {
                    return Ok(json!({ "error": "Research task not found" }));
                }
                // Poll failures are key-bound: never re-create the task.
                return Err(ToolError::KeyBound(err));
            }
        }

        poll_interval = ((poll_interval as f64 * 1.5) as u64).min(10_000);
    }

    Ok(json!({ "error": format!("Research task timed out. Documentation: {RESEARCH_DOCS}") }))
}

async fn research_via_stream(
    client: &TavilyClient,
    params: Value,
    api_key: Option<String>,
) -> Result<Value, ToolError> {
    use futures::StreamExt;

    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();
    let max_stream_ms: u64 = if model == "mini" { 300_000 } else { 900_000 };
    let url = format!("{}/research", client.base_url);
    let body = json!({
        "input": params.get("input").cloned().unwrap_or(Value::Null),
        "model": model,
        "stream": true,
    });

    // No reqwest timeout: lifetime is governed by the timers below.
    let response = client
        .http
        .post(&url)
        .headers(client.auth_headers(api_key.as_deref()))
        .json(&client.add_api_key(body, api_key.as_deref()))
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(err) => {
            let status = err.status().map(|s| s.as_u16());
            if is_key_rotation_status(status) {
                return Err(ToolError::Api(ApiError::from_reqwest(&err)));
            }
            return Ok(
                json!({ "error": format!("Research stream request failed: {err}. Documentation: {RESEARCH_DOCS}") }),
            );
        }
    };

    let status = response.status();

    if status != StatusCode::OK {
        let text = read_body_bounded(response, 16384).await;
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .map(|parsed| {
                serde_json::to_string(parsed.get("detail").unwrap_or(&parsed))
                    .unwrap_or(text.clone())
            })
            .unwrap_or_else(|| text.clone());
        if is_key_rotation_status(Some(status.as_u16())) {
            return Err(ToolError::KeyBound(ApiError {
                status: Some(status.as_u16()),
                detail,
                body: None,
            }));
        }
        return Ok(
            json!({ "error": format!("Research stream request failed (HTTP {}): {}. Documentation: {RESEARCH_DOCS}", status.as_u16(), detail) }),
        );
    }

    // SSE consumption with idle + overall budgets.
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut content = String::new();
    let idle_budget_ms: u64 = 300_000;
    let mut since_data_ms: u64 = 0;
    let mut total_ms: u64 = 0;
    let tick = Duration::from_millis(250);

    loop {
        tokio::select! {
            _ = tokio::time::sleep(tick) => {
                total_ms = total_ms.saturating_add(tick.as_millis() as u64);
                since_data_ms = since_data_ms.saturating_add(tick.as_millis() as u64);
                if total_ms >= max_stream_ms {
                    return Ok(json!({ "error": format!("Research stream timed out after {}s. Documentation: {RESEARCH_DOCS}", max_stream_ms / 1000) }));
                }
                if since_data_ms >= idle_budget_ms {
                    return Ok(json!({ "error": format!("Research stream received no data for {}s; connection closed. Documentation: {RESEARCH_DOCS}", idle_budget_ms / 1000) }));
                }
            }
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(bytes)) => {
                        since_data_ms = 0;
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(idx) = buffer.find("\n\n") {
                            let frame: String = buffer.drain(..idx + 2).collect();
                            if let Some(outcome) = handle_sse_frame(&frame, &mut content) {
                                return Ok(outcome);
                            }
                        }
                    }
                    Some(Err(err)) => {
                        return Ok(json!({ "error": format!("Research stream connection error: {err}. Documentation: {RESEARCH_DOCS}") }));
                    }
                    None => {
                        // Connection ended: flush any trailing buffered frame
                        // (the server ends right after `event: done`).
                        let trailing = buffer.trim().to_string();
                        if !trailing.is_empty() {
                            if let Some(outcome) = handle_sse_frame(&trailing, &mut content) {
                                return Ok(outcome);
                            }
                        }
                        return Ok(json!({ "error": format!("Research stream ended before completion. Documentation: {RESEARCH_DOCS}") }));
                    }
                }
            }
        }
    }
}

/// Handle one SSE frame; Some(outcome) means the research call is finished.
fn handle_sse_frame(frame: &str, content: &mut String) -> Option<Value> {
    let mut event_type = "message".to_string();
    let mut data_lines: Vec<String> = Vec::new();
    for line in frame.split(['\r', '\n']) {
        if let Some(rest) = line.strip_prefix("event:") {
            event_type = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.trim().to_string());
        }
    }
    let data = data_lines.join("\n");

    match event_type.as_str() {
        "error" => {
            let message = serde_json::from_str::<Value>(&data)
                .ok()
                .and_then(|v| v.get("error").cloned())
                .map(|e| match e {
                    Value::String(s) => s,
                    other => other.to_string(),
                })
                .unwrap_or_else(|| data.clone());
            Some(
                json!({ "error": format!("Research stream error: {message}. Documentation: {RESEARCH_DOCS}") }),
            )
        }
        "done" => {
            if content.is_empty() {
                Some(
                    json!({ "error": format!("Research stream completed without content. Documentation: {RESEARCH_DOCS}") }),
                )
            } else {
                Some(json!({ "content": content.clone() }))
            }
        }
        _ => {
            if data.is_empty() {
                return None;
            }
            if let Ok(delta) = serde_json::from_str::<Value>(&data) {
                if let Some(delta_content) = delta
                    .pointer("/choices/0/delta/content")
                    .and_then(|v| v.as_str())
                {
                    content.push_str(delta_content);
                }
            }
            None
        }
    }
}

async fn read_body_bounded(response: reqwest::Response, max_bytes: usize) -> String {
    use futures::StreamExt;
    let mut stream = response.bytes_stream();
    let mut data = String::new();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                data.push_str(&String::from_utf8_lossy(&bytes));
                if data.len() >= max_bytes {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usage_parses_key_level_limit() {
        let data = json!({"key": {"usage": 100, "limit": 1000}, "account": {"plan_usage": 1, "plan_limit": 2}});
        let result = usage_to_probe_result(&data);
        assert_eq!(result.status, Some(crate::key_pool::KeyStatus::Active));
        assert_eq!(result.remaining, Some(Some(900)));
    }

    #[test]
    fn usage_falls_back_to_account_when_key_limit_null() {
        let data = json!({"key": {"usage": 100, "limit": null}, "account": {"plan_usage": 250, "plan_limit": 1000}});
        let result = usage_to_probe_result(&data);
        assert_eq!(result.remaining, Some(Some(750)));
    }

    #[test]
    fn usage_unlimited_when_account_limit_null() {
        let data = json!({"key": {"usage": 100, "limit": null}, "account": {"plan_usage": 250, "plan_limit": null}});
        let result = usage_to_probe_result(&data);
        assert_eq!(result.status, Some(crate::key_pool::KeyStatus::Active));
        assert_eq!(result.remaining, Some(None));
    }

    #[test]
    fn usage_exhausted_when_zero_remaining() {
        let data = json!({"key": {"usage": 1000, "limit": 1000}});
        assert_eq!(
            usage_to_probe_result(&data).status,
            Some(crate::key_pool::KeyStatus::Exhausted)
        );
    }

    #[test]
    fn usage_missing_numbers_is_active_unknown() {
        let data = json!({"key": {"usage": "oops"}});
        assert_eq!(
            usage_to_probe_result(&data).status,
            Some(crate::key_pool::KeyStatus::Active)
        );
        assert_eq!(usage_to_probe_result(&data).remaining, None);
    }

    #[test]
    fn search_params_drop_empty_and_resolve_date_conflict() {
        let params = json!({
            "query": "rust mcp",
            "topic": null,
            "include_domains": [],
            "exclude_domains": ["spam.com"],
            "time_range": "month",
            "start_date": "2026-01-01",
            "country": ""
        });
        let cleaned = clean_search_params(&params);
        assert_eq!(cleaned["query"], "rust mcp");
        assert!(cleaned.get("topic").is_none());
        assert!(cleaned.get("include_domains").is_none());
        assert_eq!(cleaned["exclude_domains"], json!(["spam.com"]));
        // time_range dropped because start_date is set
        assert!(cleaned.get("time_range").is_none());
        assert_eq!(cleaned["start_date"], "2026-01-01");
        assert!(cleaned.get("country").is_none());
    }

    #[test]
    fn sse_frames_assemble_content() {
        let mut content = String::new();
        let delta =
            "event: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n";
        assert!(handle_sse_frame(delta, &mut content).is_none());
        let delta2 =
            "event: message\ndata: {\"choices\":[{\"delta\":{\"content\":\"world\"}}]}\n\n";
        assert!(handle_sse_frame(delta2, &mut content).is_none());
        let done = "event: done\ndata: [DONE]\n\n";
        let outcome = handle_sse_frame(done, &mut content).unwrap();
        assert_eq!(outcome["content"], "hello world");
    }

    #[test]
    fn sse_error_frame() {
        let mut content = String::new();
        let frame = "event: error\ndata: {\"error\": \"boom\"}\n\n";
        let outcome = handle_sse_frame(frame, &mut content).unwrap();
        assert!(outcome["error"].as_str().unwrap().contains("boom"));
    }

    #[test]
    fn keyless_envelope_detection_and_format() {
        let data = json!({
            "error": {
                "code": "rate_limited",
                "message": "Keyless rate limit reached",
                "retry_after_seconds": 30,
                "next_actions": [
                    {"type": "signup", "url": "https://tavily.com"}
                ]
            }
        });
        assert!(is_keyless_envelope(Some(&data)));
        let text = format_keyless_envelope(&data);
        assert!(text.contains("Keyless rate limit reached"));
        assert!(text.contains("Retry after: 30s"));
        assert!(text.contains("Sign up for a Tavily API key: https://tavily.com"));
    }
}
