//! Tool definitions (byte-parity schemas with the TS version), dispatch and
//! output formatters. Port of the handler half of `src/index.ts`.

use serde_json::{json, Map, Value};

use crate::key_pool::now_ms;
use crate::tavily::{is_keyless_envelope, format_keyless_envelope, ToolError, TavilyClient};

pub const DOCS_URLS: &[(&str, &str)] = &[
    ("search", "https://docs.tavily.com/documentation/api-reference/endpoint/search"),
    ("extract", "https://docs.tavily.com/documentation/api-reference/endpoint/extract"),
    ("crawl", "https://docs.tavily.com/documentation/api-reference/endpoint/crawl"),
    ("map", "https://docs.tavily.com/documentation/api-reference/endpoint/map"),
    ("research", "https://docs.tavily.com/documentation/api-reference/endpoint/research"),
];

/// Tool result handed back to the MCP layer.
pub struct ToolOutput {
    pub text: String,
    pub is_error: bool,
}

impl ToolOutput {
    fn ok(text: String) -> Self {
        ToolOutput { text, is_error: false }
    }
    fn err(text: String) -> Self {
        ToolOutput { text, is_error: true }
    }
}

/// Raw tool metadata: (name, description, inputSchema). Field order and text
/// mirror the TS definitions exactly so hosts see identical advertisements.
pub fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "tavily_search",
            "description": "Search the web for current information on any topic. Use for news, facts, or data beyond your knowledge cutoff. Returns snippets and source URLs.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query" },
                    "search_depth": {
                        "type": "string",
                        "enum": ["basic", "advanced", "fast", "ultra-fast"],
                        "description": "The depth of the search. 'basic' for generic results, 'advanced' for more thorough search, 'fast' for optimized low latency with high relevance, 'ultra-fast' for prioritizing latency above all else",
                        "default": "basic"
                    },
                    "topic": {
                        "type": "string",
                        "enum": ["general"],
                        "description": "The category of the search. This will determine which of our agents will be used for the search",
                        "default": "general"
                    },
                    "time_range": {
                        "type": "string",
                        "description": "The time range back from the current date to include in the search results",
                        "enum": ["day", "week", "month", "year"]
                    },
                    "start_date": {
                        "type": "string",
                        "description": "Will return all results after the specified start date. Required to be written in the format YYYY-MM-DD.",
                        "default": ""
                    },
                    "end_date": {
                        "type": "string",
                        "description": "Will return all results before the specified end date. Required to be written in the format YYYY-MM-DD",
                        "default": ""
                    },
                    "max_results": {
                        "type": "number",
                        "description": "The maximum number of search results to return",
                        "default": 5,
                        "minimum": 5,
                        "maximum": 20
                    },
                    "include_images": {
                        "type": "boolean",
                        "description": "Include a list of query-related images in the response",
                        "default": false
                    },
                    "include_image_descriptions": {
                        "type": "boolean",
                        "description": "Include a list of query-related images and their descriptions in the response",
                        "default": false
                    },
                    "include_raw_content": {
                        "type": "boolean",
                        "description": "Include the cleaned and parsed HTML content of each search result",
                        "default": false
                    },
                    "include_domains": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "A list of domains to specifically include in the search results, if the user asks to search on specific sites set this to the domain of the site",
                        "default": []
                    },
                    "exclude_domains": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "List of domains to specifically exclude, if the user asks to exclude a domain set this to the domain of the site",
                        "default": []
                    },
                    "country": {
                        "type": "string",
                        "description": "Boost search results from a specific country. Must be a full country name (e.g., 'United States', 'Japan', 'Germany'). ISO country codes (e.g., 'us', 'jp') are not supported. Available only if topic is general. See https://docs.tavily.com/documentation/api-reference/search for the full list of supported countries.",
                        "default": ""
                    },
                    "include_favicon": {
                        "type": "boolean",
                        "description": "Whether to include the favicon URL for each result",
                        "default": false
                    },
                    "exact_match": {
                        "type": "boolean",
                        "description": "Only return results containing the exact phrase(s) in quotes in your query"
                    }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "tavily_extract",
            "description": "Extract content from URLs. Returns raw page content in markdown or text format.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "List of URLs to extract content from"
                    },
                    "extract_depth": {
                        "type": "string",
                        "enum": ["basic", "advanced"],
                        "description": "Use 'advanced' for LinkedIn, protected sites, or tables/embedded content",
                        "default": "basic"
                    },
                    "include_images": {
                        "type": "boolean",
                        "description": "Include images from pages",
                        "default": false
                    },
                    "format": {
                        "type": "string",
                        "enum": ["markdown", "text"],
                        "description": "Output format",
                        "default": "markdown"
                    },
                    "include_favicon": {
                        "type": "boolean",
                        "description": "Include favicon URLs",
                        "default": false
                    },
                    "query": {
                        "type": "string",
                        "description": "Query to rerank content chunks by relevance"
                    }
                },
                "required": ["urls"]
            }
        }),
        json!({
            "name": "tavily_crawl",
            "description": "Crawl a website starting from a URL. Extracts content from pages with configurable depth and breadth.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The root URL to begin the crawl" },
                    "max_depth": {
                        "type": "integer",
                        "description": "Max depth of the crawl. Defines how far from the base URL the crawler can explore.",
                        "default": 1,
                        "minimum": 1
                    },
                    "max_breadth": {
                        "type": "integer",
                        "description": "Max number of links to follow per level of the tree (i.e., per page)",
                        "default": 20,
                        "minimum": 1
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Total number of links the crawler will process before stopping",
                        "default": 50,
                        "minimum": 1
                    },
                    "instructions": {
                        "type": "string",
                        "description": "Natural language instructions for the crawler. Instructions specify which types of pages the crawler should return."
                    },
                    "select_paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Regex patterns to select only URLs with specific path patterns (e.g., /docs/.*, /api/v1.*)",
                        "default": []
                    },
                    "select_domains": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Regex patterns to restrict crawling to specific domains or subdomains (e.g., ^docs\\.example\\.com$)",
                        "default": []
                    },
                    "allow_external": {
                        "type": "boolean",
                        "description": "Whether to return external links in the final response",
                        "default": true
                    },
                    "extract_depth": {
                        "type": "string",
                        "enum": ["basic", "advanced"],
                        "description": "Advanced extraction retrieves more data, including tables and embedded content, with higher success but may increase latency",
                        "default": "basic"
                    },
                    "format": {
                        "type": "string",
                        "enum": ["markdown", "text"],
                        "description": "The format of the extracted web page content. markdown returns content in markdown format. text returns plain text and may increase latency.",
                        "default": "markdown"
                    },
                    "include_favicon": {
                        "type": "boolean",
                        "description": "Whether to include the favicon URL for each result",
                        "default": false
                    }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "tavily_map",
            "description": "Map a website's structure. Returns a list of URLs found starting from the base URL.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The root URL to begin the mapping" },
                    "max_depth": {
                        "type": "integer",
                        "description": "Max depth of the mapping. Defines how far from the base URL the crawler can explore",
                        "default": 1,
                        "minimum": 1
                    },
                    "max_breadth": {
                        "type": "integer",
                        "description": "Max number of links to follow per level of the tree (i.e., per page)",
                        "default": 20,
                        "minimum": 1
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Total number of links the crawler will process before stopping",
                        "default": 50,
                        "minimum": 1
                    },
                    "instructions": {
                        "type": "string",
                        "description": "Natural language instructions for the crawler"
                    },
                    "select_paths": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Regex patterns to select only URLs with specific path patterns (e.g., /docs/.*, /api/v1.*)",
                        "default": []
                    },
                    "select_domains": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Regex patterns to restrict crawling to specific domains or subdomains (e.g., ^docs\\.example\\.com$)",
                        "default": []
                    },
                    "allow_external": {
                        "type": "boolean",
                        "description": "Whether to return external links in the final response",
                        "default": true
                    }
                },
                "required": ["url"]
            }
        }),
        json!({
            "name": "tavily_research",
            "description": "Perform comprehensive research on a given topic or question. Use this tool when you need to gather information from multiple sources to answer a question or complete a task. Returns a detailed response based on the research findings. Rate limit: 20 requests per minute.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "input": {
                        "type": "string",
                        "description": "A comprehensive description of the research task"
                    },
                    "model": {
                        "type": "string",
                        "enum": ["mini", "pro", "auto"],
                        "description": "Defines the degree of depth of the research. 'mini' is good for narrow tasks with few subtopics. 'pro' is good for broad tasks with many subtopics. 'auto' automatically selects the best model.",
                        "default": "auto"
                    }
                },
                "required": ["input"]
            }
        }),
        json!({
            "name": "tavily_key_status",
            "description": "Show the current state of the configured Tavily API key pool: per-key status (active/cooldown/exhausted/invalid), masked key, remaining credits, and when the pool was last probed. Optionally pass refresh=true to re-probe all keys against GET /usage before reporting (costs no search credits).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "refresh": {
                        "type": "boolean",
                        "description": "Re-probe all keys against the usage endpoint before reporting",
                        "default": false
                    }
                }
            }
        }),
    ]
}

/// Dispatch a tool call. `args` is the raw arguments object.
pub async fn dispatch(
    name: &str,
    args: &Value,
    client: &mut TavilyClient,
    schedule: (u32, String),
) -> Result<ToolOutput, ToolError> {
    match name {
        "tavily_search" => {
            let mut params = args.clone();
            // If country is set, ensure topic is general (TS parity).
            if params.get("country").is_some_and(|v| !v.is_null()) {
                params["topic"] = json!("general");
            }
            let response = client.search(params).await?;
            Ok(ToolOutput::ok(format_results(&response)))
        }
        "tavily_extract" => {
            let response = client.simple_endpoint("extract", args.clone()).await?;
            Ok(ToolOutput::ok(format_results(&response)))
        }
        "tavily_crawl" => {
            let mut params = pick(
                args,
                &[
                    "url",
                    "max_depth",
                    "max_breadth",
                    "limit",
                    "instructions",
                    "select_paths",
                    "select_domains",
                    "allow_external",
                    "extract_depth",
                    "format",
                    "include_favicon",
                ],
            );
            params["chunks_per_source"] = json!(3);
            let response = client.simple_endpoint("crawl", params).await?;
            Ok(ToolOutput::ok(format_crawl_results(&response)))
        }
        "tavily_map" => {
            let params = pick(
                args,
                &[
                    "url",
                    "max_depth",
                    "max_breadth",
                    "limit",
                    "instructions",
                    "select_paths",
                    "select_domains",
                    "allow_external",
                ],
            );
            let response = client.simple_endpoint("map", params).await?;
            Ok(ToolOutput::ok(format_map_results(&response)))
        }
        "tavily_research" => {
            let params = pick(args, &["input", "model"]);
            let response = client.research(params).await?;
            Ok(ToolOutput::ok(format_research_results(&response)))
        }
        "tavily_key_status" => {
            if args.get("refresh").and_then(|v| v.as_bool()) == Some(true) {
                client.probe_all_keys("tavily_key_status refresh").await;
            }
            let (snapshots, last_probed) = match client.key_pool.as_mut() {
                Some(pool) => (pool.snapshots(), pool.last_probed_at()),
                None => (vec![], 0),
            };
            Ok(ToolOutput::ok(format_key_status(
                &snapshots,
                last_probed,
                schedule.0,
                &schedule.1,
            )))
        }
        _ => Err(ToolError::UnknownTool(name.to_string())),
    }
}

/// Render a ToolError the way the TS outer catch does.
pub fn render_tool_error(name: &str, error: ToolError) -> ToolOutput {
    let api_error = match &error {
        ToolError::Api(err) => Some(err),
        ToolError::KeyBound(err) => Some(err),
        ToolError::NoAvailableKeys(message) => {
            return ToolOutput::err(message.clone());
        }
        ToolError::UnknownTool(tool) => {
            return ToolOutput::err(format!("Unknown tool: {tool}"));
        }
    };
    let err = api_error.unwrap();

    // Keyless recoverable-error envelopes render as normal output (TS parity).
    if is_keyless_envelope(err.body.as_ref()) {
        return ToolOutput::ok(format_keyless_envelope(err.body.as_ref().unwrap()));
    }

    let tool_name = name.trim_start_matches("tavily_");
    let docs = DOCS_URLS
        .iter()
        .find(|(key, _)| *key == tool_name)
        .map(|(_, url)| format!("\nDocumentation: {url}"))
        .unwrap_or_default();
    ToolOutput::err(format!("Tavily API error: {}{}", err.detail, docs))
}

/// Keep only the listed keys that are present and non-null.
fn pick(args: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    if let Some(map) = args.as_object() {
        for key in keys {
            if let Some(value) = map.get(*key) {
                if !value.is_null() {
                    out.insert(key.to_string(), value.clone());
                }
            }
        }
    }
    Value::Object(out)
}

// ---- Formatters (ports of the format* functions) ----

pub fn format_results(response: &Value) -> String {
    let mut output: Vec<String> = Vec::new();

    if let Some(answer) = response.get("answer").and_then(|v| v.as_str()) {
        if !answer.is_empty() {
            output.push(format!("Answer: {answer}"));
        }
    }

    output.push("Detailed Results:".to_string());
    if let Some(results) = response.get("results").and_then(|v| v.as_array()) {
        for result in results {
            output.push(String::new());
            output.push(format!("Title: {}", result.get("title").and_then(|v| v.as_str()).unwrap_or("")));
            output.push(format!("URL: {}", result.get("url").and_then(|v| v.as_str()).unwrap_or("")));
            output.push(format!(
                "Content: {}",
                result.get("content").and_then(|v| v.as_str()).unwrap_or("")
            ));
            if let Some(raw) = result.get("raw_content").and_then(|v| v.as_str()) {
                if !raw.is_empty() {
                    output.push(format!("Raw Content: {raw}"));
                }
            }
            if let Some(favicon) = result.get("favicon").and_then(|v| v.as_str()) {
                if !favicon.is_empty() {
                    output.push(format!("Favicon: {favicon}"));
                }
            }
        }
    }

    if let Some(images) = response.get("images").and_then(|v| v.as_array()) {
        if !images.is_empty() {
            output.push(String::new());
            output.push("Images:".to_string());
            for (index, image) in images.iter().enumerate() {
                match image {
                    Value::String(url) => output.push(format!("\n[{}] URL: {url}", index + 1)),
                    Value::Object(map) => {
                        output.push(format!(
                            "\n[{}] URL: {}",
                            index + 1,
                            map.get("url").and_then(|v| v.as_str()).unwrap_or("")
                        ));
                        if let Some(description) = map.get("description").and_then(|v| v.as_str()) {
                            if !description.is_empty() {
                                output.push(format!("   Description: {description}"));
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    output.join("\n")
}

pub fn format_crawl_results(response: &Value) -> String {
    let mut output: Vec<String> = Vec::new();

    output.push("Crawl Results:".to_string());
    output.push(format!("Base URL: {}", response.get("base_url").and_then(|v| v.as_str()).unwrap_or("")));

    output.push(String::new());
    output.push("Crawled Pages:".to_string());
    if let Some(results) = response.get("results").and_then(|v| v.as_array()) {
        for (index, page) in results.iter().enumerate() {
            output.push(String::new());
            output.push(format!("[{}] URL: {}", index + 1, page.get("url").and_then(|v| v.as_str()).unwrap_or("")));
            if let Some(raw) = page.get("raw_content").and_then(|v| v.as_str()) {
                if !raw.is_empty() {
                    let preview = if raw.chars().count() > 200 {
                        let truncated: String = raw.chars().take(200).collect();
                        format!("{truncated}...")
                    } else {
                        raw.to_string()
                    };
                    output.push(format!("Content: {preview}"));
                }
            }
            if let Some(favicon) = page.get("favicon").and_then(|v| v.as_str()) {
                if !favicon.is_empty() {
                    output.push(format!("Favicon: {favicon}"));
                }
            }
        }
    }

    output.join("\n")
}

pub fn format_map_results(response: &Value) -> String {
    let mut output: Vec<String> = Vec::new();

    output.push("Site Map Results:".to_string());
    output.push(format!("Base URL: {}", response.get("base_url").and_then(|v| v.as_str()).unwrap_or("")));

    output.push(String::new());
    output.push("Mapped Pages:".to_string());
    if let Some(results) = response.get("results").and_then(|v| v.as_array()) {
        for (index, page) in results.iter().enumerate() {
            output.push(format!("\n[{}] URL: {page}", index + 1));
        }
    }

    output.join("\n")
}

pub fn format_research_results(response: &Value) -> String {
    if let Some(error) = response.get("error").and_then(|v| v.as_str()) {
        if !error.is_empty() {
            return format!("Research Error: {error}");
        }
    }
    response
        .get("content")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("No research results available")
        .to_string()
}

pub fn format_key_status(
    snapshots: &[Value],
    last_probed_at: u64,
    reprobe_hour: u32,
    reprobe_tz: &str,
) -> String {
    if snapshots.is_empty() {
        return "Key pool is empty (keyless mode or no TAVILY_API_KEYS configured).".to_string();
    }

    let mut lines: Vec<String> = vec!["Tavily key pool status:".to_string()];
    for snapshot in snapshots {
        let remaining = match snapshot.get("remaining") {
            None => "unknown".to_string(),
            Some(Value::Null) => "unlimited".to_string(),
            Some(v) => v.to_string(),
        };
        let cooldown = if snapshot["status"] == "cooldown" {
            snapshot
                .get("availableAt")
                .and_then(|v| v.as_u64())
                .map(|at| {
                    let seconds = at.saturating_sub(now_ms()) / 1000;
                    format!(", available in {}s", seconds.max(0))
                })
                .unwrap_or_default()
        } else {
            String::new()
        };
        lines.push(format!(
            "#{} {} — {}, remaining={}{}",
            snapshot["index"].as_u64().unwrap_or(0),
            snapshot["key"].as_str().unwrap_or(""),
            snapshot["status"].as_str().unwrap_or(""),
            remaining,
            cooldown
        ));
    }

    let last_probed = if last_probed_at == 0 {
        "never".to_string()
    } else {
        let seconds = now_ms().saturating_sub(last_probed_at) / 1000;
        format!("{seconds}s ago")
    };
    lines.push(format!("Last probed: {last_probed}"));
    lines.push(format!("Daily re-probe: {reprobe_hour:02}:00 {reprobe_tz}"));
    lines.join("\n")
}

/// The `--list-tools` CLI output (TS listTools parity).
pub fn list_tools_cli() -> String {
    let descriptions = [
        ("tavily_search", "A real-time web search tool powered by Tavily's AI engine. Features include customizable search depth (basic/advanced/fast/ultra-fast), domain filtering, time-based filtering, and support for both general and news-specific searches. Returns comprehensive results with titles, URLs, content snippets, and optional image results."),
        ("tavily_extract", "Extracts and processes content from specified URLs with advanced parsing capabilities. Supports both basic and advanced extraction modes, with the latter providing enhanced data retrieval including tables and embedded content. Ideal for data collection, content analysis, and research tasks."),
        ("tavily_crawl", "A sophisticated web crawler that systematically explores websites starting from a base URL. Features include configurable depth and breadth limits, domain filtering, path pattern matching, and category-based filtering. Perfect for comprehensive site analysis, content discovery, and structured data collection."),
        ("tavily_map", "Creates detailed site maps by analyzing website structure and navigation paths. Offers configurable exploration depth, domain restrictions, and category filtering. Ideal for site audits, content organization analysis, and understanding website architecture and navigation patterns."),
        ("tavily_research", "Performs comprehensive research on any topic or question by gathering information from multiple sources. Supports different research depths ('mini' for narrow tasks, 'pro' for broad research, 'auto' for automatic selection). Ideal for in-depth analysis, report generation, and answering complex questions requiring synthesis of multiple sources."),
        ("tavily_key_status", "Shows the current state of the configured Tavily API key pool: per-key status, masked key, remaining credits, and when the pool was last probed. Optionally refreshes by re-probing GET /usage."),
    ];
    let mut out = String::from("Available tools:");
    for (name, description) in descriptions {
        out.push_str(&format!("\n\n- {name}\n  Description: {description}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_definitions_cover_six_tools() {
        let defs = tool_definitions();
        let names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            vec![
                "tavily_search",
                "tavily_extract",
                "tavily_crawl",
                "tavily_map",
                "tavily_research",
                "tavily_key_status"
            ]
        );
        // Every schema is a JSON object with the required array where expected.
        for def in &defs {
            assert_eq!(def["inputSchema"]["type"], "object");
        }
        assert_eq!(defs[0]["inputSchema"]["required"][0], "query");
        assert_eq!(defs[1]["inputSchema"]["required"][0], "urls");
        assert_eq!(defs[2]["inputSchema"]["required"][0], "url");
    }

    #[test]
    fn formats_search_results() {
        let response = json!({
            "answer": "42",
            "results": [
                {
                    "title": "Rust MCP",
                    "url": "https://example.com",
                    "content": "Some content",
                    "raw_content": "raw",
                    "favicon": "https://example.com/f.ico"
                }
            ],
            "images": [
                {"url": "https://img.example.com/a.png", "description": "an image"}
            ]
        });
        let text = format_results(&response);
        assert!(text.starts_with("Answer: 42"));
        assert!(text.contains("Detailed Results:"));
        assert!(text.contains("Title: Rust MCP"));
        assert!(text.contains("Raw Content: raw"));
        assert!(text.contains("[1] URL: https://img.example.com/a.png"));
        assert!(text.contains("   Description: an image"));
    }

    #[test]
    fn formats_crawl_with_truncation() {
        let long = "x".repeat(250);
        let response = json!({
            "base_url": "https://example.com",
            "results": [{"url": "https://example.com/a", "raw_content": long}]
        });
        let text = format_crawl_results(&response);
        assert!(text.contains("Crawl Results:"));
        assert!(text.contains("Crawled Pages:"));
        assert!(text.contains("xxxxx..."));
        assert!(text.contains("[1] URL: https://example.com/a"));
    }

    #[test]
    fn formats_key_status() {
        let snapshots = vec![json!({
            "index": 1,
            "key": "tvly-ab...1234",
            "status": "active",
            "remaining": 900
        })];
        let text = format_key_status(&snapshots, 0, 5, "Asia/Shanghai");
        assert!(text.contains("#1 tvly-ab...1234 — active, remaining=900") || text.contains("remaining=900"));
        assert!(text.contains("Last probed: never"));
        assert!(text.contains("Daily re-probe: 05:00 Asia/Shanghai"));
    }

    #[test]
    fn keyless_pool_status() {
        let text = format_key_status(&[], 0, 5, "Asia/Shanghai");
        assert!(text.contains("Key pool is empty"));
    }
}
