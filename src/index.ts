#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema, Tool} from "@modelcontextprotocol/sdk/types.js";
import axios, { type AxiosRequestConfig } from "axios";
import { randomUUID } from "crypto";
import dotenv from "dotenv";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { KeyPool, type KeyProbeResult, type KeyStatusSnapshot } from "./key-pool.js";

dotenv.config();

const API_KEYS = parseApiKeys();
const IS_KEYLESS = API_KEYS.length === 0;
const HUMAN_ID = process.env.TAVILY_HUMAN_ID;
const SESSION_ID = randomUUID();
const API_BASE_URL = (process.env.TAVILY_API_BASE_URL || 'https://api.tavily.com').replace(/\/+$/, '');

// Daily re-probe schedule. Tavily monthly credits reset on the 1st of each
// month (calendar-based, server-side truth via GET /usage), so a daily probe
// at TAVILY_REPROBE_HOUR (default 05:00, TZ-aware) both refreshes the
// remaining-credits ordering and revives keys that went exhausted mid-month.
const REPROBE_HOUR = clampInt('TAVILY_REPROBE_HOUR', 0, 23, 5);
const REPROBE_TZ = process.env.TAVILY_REPROBE_TZ || 'Asia/Shanghai';
const REPROBE_TICK_MS = clampInt('TAVILY_REPROBE_TICK_MS', 1_000, 3_600_000, 60_000);

// When every key is unavailable, allow one synchronous re-probe at most once
// per STALE_PROBE_MS so the first request after a quota reset self-heals even
// if the daily timer never fired.
const STALE_PROBE_MS = 10 * 60_000;

function clampInt(envName: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(process.env[envName] ?? '', 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function parseApiKeys(): string[] {
  const multipleKeys = process.env.TAVILY_API_KEYS
    ?.split(/[\n,]/)
    .map((key) => key.trim())
    .filter(Boolean);

  if (multipleKeys && multipleKeys.length > 0) {
    return [...new Set(multipleKeys)];
  }

  const singleKey = process.env.TAVILY_API_KEY?.trim();
  return singleKey ? [singleKey] : [];
}


interface TavilyResponse {
  // Response structure from Tavily API
  query: string;
  follow_up_questions?: Array<string>;
  answer?: string;
  images?: Array<string | {
    url: string;
    description?: string;
  }>;
  results: Array<{
    title: string;
    url: string;
    content: string;
    score: number;
    published_date?: string;
    raw_content?: string;
    favicon?: string;
  }>;
}

interface TavilyCrawlResponse {
  base_url: string;
  results: Array<{
    url: string;
    raw_content: string;
    favicon?: string;
  }>;
  response_time: number;
}

interface TavilyResearchResponse {
  request_id?: string;
  status?: string;
  content?: string;
  error?: string;
}

interface TavilyMapResponse {
  base_url: string;
  results: string[];
  response_time: number;
}

class TavilyClient {
  // Core client properties
  private server: Server;
  private axiosInstance;
  private readonly keyPool = IS_KEYLESS ? undefined : new KeyPool(API_KEYS);
  private baseURLs = {
    search: `${API_BASE_URL}/search`,
    extract: `${API_BASE_URL}/extract`,
    crawl: `${API_BASE_URL}/crawl`,
    map: `${API_BASE_URL}/map`,
    research: `${API_BASE_URL}/research`,
    usage: `${API_BASE_URL}/usage`,
  };

  private docsURLs: Record<string, string> = {
    search: 'https://docs.tavily.com/documentation/api-reference/endpoint/search',
    extract: 'https://docs.tavily.com/documentation/api-reference/endpoint/extract',
    crawl: 'https://docs.tavily.com/documentation/api-reference/endpoint/crawl',
    map: 'https://docs.tavily.com/documentation/api-reference/endpoint/map',
    research: 'https://docs.tavily.com/documentation/api-reference/endpoint/research',
  };

  constructor() {
    this.server = new Server(
      {
        name: "tavily-mcp-multi-key",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.axiosInstance = axios.create({
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'X-Session-Id': SESSION_ID,
        ...(HUMAN_ID ? { 'X-Human-Id': HUMAN_ID } : {}),
      }
    });

    if (IS_KEYLESS) {
      console.error('[tavily-mcp-multi-key] no Tavily API key set; running in keyless mode. Search and extract are available; other tools will return a message explaining that an API key is required.');
    }

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error: any) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private getRequestConfig(apiKey?: string, overrides: AxiosRequestConfig = {}): AxiosRequestConfig {
    const authHeaders = IS_KEYLESS
      ? { 'X-Tavily-Access-Mode': 'keyless', 'X-Client-Source': 'tavily-mcp-keyless' }
      : { 'Authorization': `Bearer ${apiKey}`, 'X-Client-Source': 'MCP' };

    return {
      ...overrides,
      headers: {
        ...authHeaders,
        ...(overrides.headers as Record<string, string> | undefined),
      },
    };
  }

  private addApiKey<T extends Record<string, any>>(params: T, apiKey?: string): T & { api_key?: string } {
    return IS_KEYLESS ? params : { ...params, api_key: apiKey };
  }

  private async initializeKeyPool(): Promise<void> {
    if (!this.keyPool) {
      return;
    }

    await this.probeAllKeys('startup preflight');

    this.scheduleDailyReprobe();
  }

  /** Probe every key against GET /usage, refresh ordering, log a summary. */
  private async probeAllKeys(reason: string): Promise<void> {
    if (!this.keyPool) {
      return;
    }

    await this.keyPool.probe((apiKey) => this.probeKey(apiKey));

    const snapshots = this.keyPool.snapshots();
    const summary = snapshots.map((snapshot) => {
      const remaining = snapshot.remaining === undefined ? '' : `, remaining=${snapshot.remaining}`;
      return `#${snapshot.index} ${snapshot.key} ${snapshot.status}${remaining}`;
    }).join('; ');
    console.error(`[tavily-mcp-multi-key] key probe (${reason}): ${summary}`);
  }

  /**
   * Re-probe all keys once per local calendar day after REPROBE_HOUR.
   * Implemented as a short-interval check rather than a long setTimeout so a
   * suspended process (or a clock jump) still fires on the next tick after
   * the target time passes; the "already fired today" guard prevents repeats.
   */
  private scheduleDailyReprobe(): void {
    let lastProbeDay = dateInZone(new Date(), REPROBE_TZ).getDate();

    const tick = () => {
      const now = dateInZone(new Date(), REPROBE_TZ);
      if (now.getHours() >= REPROBE_HOUR && now.getDate() !== lastProbeDay) {
        lastProbeDay = now.getDate();
        this.probeAllKeys(`daily re-probe ${REPROBE_HOUR}:00 ${REPROBE_TZ}`).catch((error) => {
          console.error('[tavily-mcp-multi-key] daily re-probe failed:', error?.message ?? error);
        });
      }
    };

    setInterval(tick, REPROBE_TICK_MS);
  }

  private async probeKey(apiKey: string): Promise<KeyProbeResult> {
    try {
      const response = await this.axiosInstance.get(
        this.baseURLs.usage,
        this.getRequestConfig(apiKey, { timeout: 5000 }),
      );
      const keyUsage = response.data?.key?.usage;
      const keyLimit = response.data?.key?.limit;
      const accountUsage = response.data?.account?.plan_usage;
      const accountLimit = response.data?.account?.plan_limit;
      const usage = typeof keyLimit === 'number' ? keyUsage : accountUsage;
      const limit = typeof keyLimit === 'number' ? keyLimit : accountLimit;

      if (typeof usage !== 'number' || (typeof limit !== 'number' && limit !== null)) {
        return { status: 'active' };
      }

      if (limit === null) {
        return { status: 'active', remaining: null };
      }

      const remaining = Math.max(limit - usage, 0);
      return {
        status: remaining === 0 ? 'exhausted' : 'active',
        remaining,
      };
    } catch (error: any) {
      const status = getErrorStatus(error);

      if (status === 401) {
        return { status: 'invalid' };
      }

      if (status === 432 || status === 433) {
        return { status: 'exhausted', remaining: 0 };
      }

      // 429 on the usage endpoint rate-limits the *observation plane* only —
      // search/extract on the same key may still be fine (endpoint-level
      // limits are independent). Marking the key 'cooldown' here would block
      // the data plane too, which is wrong. Report 'unknown' so the key keeps
      // its current state (active on first probe; previous state afterwards)
      // and real requests surface any actual key-level rate limit.
      return { status: 'unknown' };
    }
  }

  private async runWithKey<T>(operation: (apiKey?: string) => Promise<T>): Promise<T> {
    if (!this.keyPool) {
      return operation(undefined);
    }

    let lastError: unknown;

    for (let attempt = 0; attempt < this.keyPool.size; attempt += 1) {
      const apiKey = this.keyPool.nextKey();
      if (!apiKey) {
        // Every key is unavailable. If our knowledge is stale (no probe for a
        // while — e.g. quotas just reset at month start), re-probe once and
        // retry before giving up. This makes the first request after a quota
        // reset self-heal even if the daily timer never fired.
        if (this.keyPool.lastProbeAgoMs > STALE_PROBE_MS) {
          await this.probeAllKeys('all keys unavailable — stale probe check');
          continue;
        }
        break;
      }

      try {
        const result = await operation(apiKey);
        this.keyPool.markSuccess(apiKey);
        return result;
      } catch (error) {
        lastError = error;
        const status = getErrorStatus(error);
        this.keyPool.markFailure(apiKey, status, getRetryAfterMs(error));

        if (error instanceof KeyBoundError || !isKeyRotationStatus(status)) {
          throw error;
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(this.keyPool.unavailableMessage());
  }

  private getDefaultParameters(): Record<string, any> {
    /**Get default parameter values from environment variable.
     * 
     * The environment variable DEFAULT_PARAMETERS should contain a JSON string 
     * with parameter names and their default values.
     * Example: DEFAULT_PARAMETERS='{"search_depth":"basic","include_images":true}'
     * 
     * Returns:
     *   Object with default parameter values, or empty object if env var is not present or invalid.
     */
    try {
      const parametersEnv = process.env.DEFAULT_PARAMETERS;
      
      if (!parametersEnv) {
        return {};
      }
      
      // Parse the JSON string
      const defaults = JSON.parse(parametersEnv);
      
      if (typeof defaults !== 'object' || defaults === null || Array.isArray(defaults)) {
        console.warn(`DEFAULT_PARAMETERS is not a valid JSON object: ${parametersEnv}`);
        return {};
      }
      
      return defaults;
    } catch (error: any) {
      console.warn(`Failed to parse DEFAULT_PARAMETERS as JSON: ${error.message}`);
      return {};
    }
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      // Define available tools: tavily_search and tavily_extract
      const tools: Tool[] = [
        {
          name: "tavily_search",
          description: "Search the web for current information on any topic. Use for news, facts, or data beyond your knowledge cutoff. Returns snippets and source URLs.",
          inputSchema: {
            type: "object",
            properties: {
              query: { 
                type: "string", 
                description: "Search query" 
              },
              search_depth: {
                type: "string",
                enum: ["basic","advanced","fast","ultra-fast"],
                description: "The depth of the search. 'basic' for generic results, 'advanced' for more thorough search, 'fast' for optimized low latency with high relevance, 'ultra-fast' for prioritizing latency above all else",
                default: "basic"
              },
              topic : {
                type: "string",
                enum: ["general"],
                description: "The category of the search. This will determine which of our agents will be used for the search",
                default: "general"
              },
              time_range: {
                type: "string",
                description: "The time range back from the current date to include in the search results",
                enum: ["day", "week", "month", "year"]
              },
              start_date: {
                type: "string",
                description: "Will return all results after the specified start date. Required to be written in the format YYYY-MM-DD.",
                default: "",
              },
              end_date: { 
                type: "string",
                description: "Will return all results before the specified end date. Required to be written in the format YYYY-MM-DD",
                default: "",
              },
              max_results: { 
                type: "number", 
                description: "The maximum number of search results to return",
                default: 5,
                minimum: 5,
                maximum: 20
              },
              include_images: { 
                type: "boolean", 
                description: "Include a list of query-related images in the response",
                default: false,
              },
              include_image_descriptions: { 
                type: "boolean", 
                description: "Include a list of query-related images and their descriptions in the response",
                default: false
              },
              include_raw_content: {
                type: "boolean",
                description: "Include the cleaned and parsed HTML content of each search result",
                default: false
              },
              include_domains: {
                type: "array",
                items: { type: "string" },
                description: "A list of domains to specifically include in the search results, if the user asks to search on specific sites set this to the domain of the site",
                default: []
              },
              exclude_domains: {
                type: "array",
                items: { type: "string" },
                description: "List of domains to specifically exclude, if the user asks to exclude a domain set this to the domain of the site",
                default: []
              },
              country: {
                type: "string",
                description: "Boost search results from a specific country. Must be a full country name (e.g., 'United States', 'Japan', 'Germany'). ISO country codes (e.g., 'us', 'jp') are not supported. Available only if topic is general. See https://docs.tavily.com/documentation/api-reference/search for the full list of supported countries.",
                default: ""
              },
              include_favicon: {
                type: "boolean",
                description: "Whether to include the favicon URL for each result",
                default: false
              },
              exact_match: {
                type: "boolean",
                description: "Only return results containing the exact phrase(s) in quotes in your query"
              }
            },
            required: ["query"]
          }
        },
        {
          name: "tavily_extract",
          description: "Extract content from URLs. Returns raw page content in markdown or text format.",
          inputSchema: {
            type: "object",
            properties: {
              urls: { 
                type: "array",
                items: { type: "string" },
                description: "List of URLs to extract content from"
              },
              extract_depth: { 
                type: "string",
                enum: ["basic", "advanced"],
                description: "Use 'advanced' for LinkedIn, protected sites, or tables/embedded content",
                default: "basic"
              },
              include_images: {
                type: "boolean",
                description: "Include images from pages",
                default: false
              },
              format: {
                type: "string",
                enum: ["markdown", "text"],
                description: "Output format",
                default: "markdown"
              },
              include_favicon: {
                type: "boolean",
                description: "Include favicon URLs",
                default: false
              },
              query: {
                type: "string",
                description: "Query to rerank content chunks by relevance"
              }
            },
            required: ["urls"]
          }
        },
        {
          name: "tavily_crawl",
          description: "Crawl a website starting from a URL. Extracts content from pages with configurable depth and breadth.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The root URL to begin the crawl"
              },
              max_depth: {
                type: "integer",
                description: "Max depth of the crawl. Defines how far from the base URL the crawler can explore.",
                default: 1,
                minimum: 1
              },
              max_breadth: {
                type: "integer",
                description: "Max number of links to follow per level of the tree (i.e., per page)",
                default: 20,
                minimum: 1
              },
              limit: {
                type: "integer",
                description: "Total number of links the crawler will process before stopping",
                default: 50,
                minimum: 1
              },
              instructions: {
                type: "string",
                description: "Natural language instructions for the crawler. Instructions specify which types of pages the crawler should return."
              },
              select_paths: {
                type: "array",
                items: { type: "string" },
                description: "Regex patterns to select only URLs with specific path patterns (e.g., /docs/.*, /api/v1.*)",
                default: []
              },
              select_domains: {
                type: "array",
                items: { type: "string" },
                description: "Regex patterns to restrict crawling to specific domains or subdomains (e.g., ^docs\\.example\\.com$)",
                default: []
              },
              allow_external: {
                type: "boolean",
                description: "Whether to return external links in the final response",
                default: true
              },
              extract_depth: {
                type: "string",
                enum: ["basic", "advanced"],
                description: "Advanced extraction retrieves more data, including tables and embedded content, with higher success but may increase latency",
                default: "basic"
              },
              format: {
                type: "string",
                enum: ["markdown","text"],
                description: "The format of the extracted web page content. markdown returns content in markdown format. text returns plain text and may increase latency.",
                default: "markdown"
              },
              include_favicon: { 
                type: "boolean", 
                description: "Whether to include the favicon URL for each result",
                default: false,
              },
            },
            required: ["url"]
          }
        },
        {
          name: "tavily_map",
          description: "Map a website's structure. Returns a list of URLs found starting from the base URL.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "The root URL to begin the mapping"
              },
              max_depth: {
                type: "integer",
                description: "Max depth of the mapping. Defines how far from the base URL the crawler can explore",
                default: 1,
                minimum: 1
              },
              max_breadth: {
                type: "integer",
                description: "Max number of links to follow per level of the tree (i.e., per page)",
                default: 20,
                minimum: 1
              },
              limit: {
                type: "integer",
                description: "Total number of links the crawler will process before stopping",
                default: 50,
                minimum: 1
              },
              instructions: {
                type: "string",
                description: "Natural language instructions for the crawler"
              },
              select_paths: {
                type: "array",
                items: { type: "string" },
                description: "Regex patterns to select only URLs with specific path patterns (e.g., /docs/.*, /api/v1.*)",
                default: []
              },
              select_domains: {
                type: "array",
                items: { type: "string" },
                description: "Regex patterns to restrict crawling to specific domains or subdomains (e.g., ^docs\\.example\\.com$)",
                default: []
              },
              allow_external: {
                type: "boolean",
                description: "Whether to return external links in the final response",
                default: true
              }
            },
            required: ["url"]
          }
        },
        {
          name: "tavily_research",
          description: "Perform comprehensive research on a given topic or question. Use this tool when you need to gather information from multiple sources to answer a question or complete a task. Returns a detailed response based on the research findings. Rate limit: 20 requests per minute.",
          inputSchema: {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: "A comprehensive description of the research task"
              },
              model: {
                type: "string",
                enum: ["mini", "pro", "auto"],
                description: "Defines the degree of depth of the research. 'mini' is good for narrow tasks with few subtopics. 'pro' is good for broad tasks with many subtopics. 'auto' automatically selects the best model.",
                default: "auto"
              }
            },
            required: ["input"]
          }
        },
        {
          name: "tavily_key_status",
          description: "Show the current state of the configured Tavily API key pool: per-key status (active/cooldown/exhausted/invalid), masked key, remaining credits, and when the pool was last probed. Optionally pass refresh=true to re-probe all keys against GET /usage before reporting (costs no search credits).",
          inputSchema: {
            type: "object",
            properties: {
              refresh: {
                type: "boolean",
                description: "Re-probe all keys against the usage endpoint before reporting",
                default: false
              }
            }
          }
        },
      ];
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      try {
        let response: TavilyResponse;
        const args = request.params.arguments ?? {};

        switch (request.params.name) {
          case "tavily_search":
            // If country is set, ensure topic is general
            if (args.country) {
              args.topic = "general";
            }
            
            response = await this.search({
              query: args.query,
              search_depth: args.search_depth,
              topic: args.topic,
              time_range: args.time_range,
              max_results: args.max_results,
              include_images: args.include_images,
              include_image_descriptions: args.include_image_descriptions,
              include_raw_content: args.include_raw_content,
              include_domains: Array.isArray(args.include_domains) ? args.include_domains : [],
              exclude_domains: Array.isArray(args.exclude_domains) ? args.exclude_domains : [],
              country: args.country,
              include_favicon: args.include_favicon,
              start_date: args.start_date,
              end_date: args.end_date,
              exact_match: args.exact_match
            });
            break;
          
          case "tavily_extract":
            response = await this.extract({
              urls: args.urls,
              extract_depth: args.extract_depth,
              include_images: args.include_images,
              format: args.format,
              include_favicon: args.include_favicon,
              query: args.query,
            });
            break;

          case "tavily_crawl":
            const crawlResponse = await this.crawl({
              url: args.url,
              max_depth: args.max_depth,
              max_breadth: args.max_breadth,
              limit: args.limit,
              instructions: args.instructions,
              select_paths: Array.isArray(args.select_paths) ? args.select_paths : [],
              select_domains: Array.isArray(args.select_domains) ? args.select_domains : [],
              allow_external: args.allow_external,
              extract_depth: args.extract_depth,
              format: args.format,
              include_favicon: args.include_favicon,
              chunks_per_source: 3,
            });
            return {
              content: [{
                type: "text",
                text: formatCrawlResults(crawlResponse)
              }]
            };

          case "tavily_map":
            const mapResponse = await this.map({
              url: args.url,
              max_depth: args.max_depth,
              max_breadth: args.max_breadth,
              limit: args.limit,
              instructions: args.instructions,
              select_paths: Array.isArray(args.select_paths) ? args.select_paths : [],
              select_domains: Array.isArray(args.select_domains) ? args.select_domains : [],
              allow_external: args.allow_external
            });
            return {
              content: [{
                type: "text",
                text: formatMapResults(mapResponse)
              }]
            };

          case "tavily_research":
            const researchResponse = await this.research({
              input: args.input,
              model: args.model
            });
            return {
              content: [{
                type: "text",
                text: formatResearchResults(researchResponse)
              }]
            };

          case "tavily_key_status":
            if (args.refresh === true) {
              await this.probeAllKeys('tavily_key_status refresh');
            }
            return {
              content: [{
                type: "text",
                text: formatKeyStatus(
                  this.keyPool ? this.keyPool.snapshots() : [],
                  this.keyPool ? this.keyPool.lastProbedAt : 0,
                  { reprobeHour: REPROBE_HOUR, reprobeTz: REPROBE_TZ },
                )
              }]
            };

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }

        return {
          content: [{
            type: "text",
            text: formatResults(response)
          }]
        };
      } catch (error: any) {
        if (axios.isAxiosError(error) || getErrorStatus(error) !== undefined) {
          if (isKeylessEnvelope(error.response?.data)) {
            return {
              content: [{
                type: "text",
                text: formatKeylessEnvelope(error.response!.data)
              }]
            };
          }
          const toolName = request.params.name?.replace('tavily_', '') || '';
          const docsUrl = this.docsURLs[toolName] || '';
          const responseData = error.response?.data;
          const detail = responseData && typeof responseData === 'object'
            ? (responseData.detail || responseData.message || responseData)
            : (error.message);
          const detailStr = typeof detail === 'object' ? JSON.stringify(detail) : String(detail);
          const docsSuffix = docsUrl ? `\nDocumentation: ${docsUrl}` : '';
          return {
            content: [{
              type: "text",
              text: `Tavily API error: ${detailStr}${docsSuffix}`
            }],
            isError: true,
          }
        }
        if (error instanceof Error && error.message.startsWith('No available Tavily API keys.')) {
          return {
            content: [{
              type: "text",
              text: error.message,
            }],
            isError: true,
          };
        }
        throw error;
      }
    });
  }


  async run(): Promise<void> {
    await this.initializeKeyPool();
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Tavily MCP multi-key server running on stdio");
  }

  async search(params: any): Promise<TavilyResponse> {
    return this.runWithKey((apiKey) => this.searchWithKey(params, apiKey));
  }

  private async searchWithKey(params: any, apiKey?: string): Promise<TavilyResponse> {
      const endpoint = this.baseURLs.search;

      const defaults = this.getDefaultParameters();
      
      // Prepare the request payload
      const searchParams: any = {
        query: params.query,
        search_depth: params.search_depth,
        topic: params.topic,
        time_range: params.time_range,
        max_results: params.max_results,
        include_images: params.include_images,
        include_image_descriptions: params.include_image_descriptions,
        include_raw_content: params.include_raw_content,
        include_domains: params.include_domains || [],
        exclude_domains: params.exclude_domains || [],
        country: params.country,
        include_favicon: params.include_favicon,
        start_date: params.start_date,
        end_date: params.end_date,
        exact_match: params.exact_match,
      };
      
      // Apply default parameters
      for (const key in searchParams) {
        if (key in defaults) {
          searchParams[key] = defaults[key];
        }
      }
      
      // We have to set defaults due to the issue with optional parameter types or defaults = None
      // Because of this, we have to set the time_range to None if start_date or end_date is set
      // or else start_date and end_date will always cause errors when sent
      if ((searchParams.start_date || searchParams.end_date) && searchParams.time_range) {
        searchParams.time_range = undefined;
      }
      
      // Remove empty values
      const cleanedParams: any = {};
      for (const key in searchParams) {
        const value = searchParams[key];
        // Skip empty strings, null, undefined, and empty arrays
        if (value !== "" && value !== null && value !== undefined && 
            !(Array.isArray(value) && value.length === 0)) {
          cleanedParams[key] = value;
        }
      }
      
      const response = await this.axiosInstance.post(
        endpoint,
        this.addApiKey(cleanedParams, apiKey),
        this.getRequestConfig(apiKey),
      );
      return response.data;
  }

  async extract(params: any): Promise<TavilyResponse> {
    return this.runWithKey(async (apiKey) => {
      const response = await this.axiosInstance.post(
        this.baseURLs.extract,
        this.addApiKey(params, apiKey),
        this.getRequestConfig(apiKey),
      );
      return response.data;
    });
  }

  async crawl(params: any): Promise<TavilyCrawlResponse> {
    return this.runWithKey(async (apiKey) => {
      const response = await this.axiosInstance.post(
        this.baseURLs.crawl,
        this.addApiKey(params, apiKey),
        this.getRequestConfig(apiKey),
      );
      return response.data;
    });
  }

  async map(params: any): Promise<TavilyMapResponse> {
    return this.runWithKey(async (apiKey) => {
      const response = await this.axiosInstance.post(
        this.baseURLs.map,
        this.addApiKey(params, apiKey),
        this.getRequestConfig(apiKey),
      );
      return response.data;
    });
  }

  async research(params: any): Promise<TavilyResearchResponse> {
    return this.runWithKey((apiKey) => this.researchWithKey(params, apiKey));
  }

  private async researchWithKey(params: any, apiKey?: string): Promise<TavilyResearchResponse> {
    const INITIAL_POLL_INTERVAL = 2000; // 2 seconds in ms
    const MAX_POLL_INTERVAL = 10000; // 10 seconds in ms
    const POLL_BACKOFF_FACTOR = 1.5;
    const MAX_PRO_MODEL_POLL_DURATION = 900000; // 15 minutes in ms
    const MAX_MINI_MODEL_POLL_DURATION = 300000; // 5 minutes in ms

    try {
      const response = await this.axiosInstance.post(this.baseURLs.research, this.addApiKey({
        input: params.input,
        model: params.model || 'auto',
      }, apiKey), this.getRequestConfig(apiKey));

      const requestId = response.data.request_id;
      if (!requestId) {
        return { error: `No request_id returned from research endpoint. Documentation: ${this.docsURLs.research}` };
      }

      // For model=auto, use pro timeout since we don't know which model will be used
      const maxPollDuration = params.model === 'mini'
        ? MAX_MINI_MODEL_POLL_DURATION
        : MAX_PRO_MODEL_POLL_DURATION;

      let pollInterval = INITIAL_POLL_INTERVAL;
      let totalElapsed = 0;

      while (totalElapsed < maxPollDuration) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        totalElapsed += pollInterval;

        try {
          const pollResponse = await this.axiosInstance.get(
            `${this.baseURLs.research}/${requestId}`,
            this.getRequestConfig(apiKey),
          );

          const status = pollResponse.data.status;

          if (status === 'completed') {
            const content = pollResponse.data.content;
            return {
              content: content || ''
            };
          }

          if (status === 'failed') {
            return { error: `Research task failed. Documentation: ${this.docsURLs.research}` };
          }

        } catch (pollError: any) {
          if (pollError.response?.status === 404) {
            return { error: 'Research task not found' };
          }
          throw new KeyBoundError(pollError);
        }

        pollInterval = Math.min(pollInterval * POLL_BACKOFF_FACTOR, MAX_POLL_INTERVAL);
      }

      return { error: `Research task timed out. Documentation: ${this.docsURLs.research}` };
    } catch (error: any) {
      // If the API signals that this request must use streaming, fall back to
      // stream=true transparently and assemble the report in memory — the tool
      // result is identical to the polling flow.
      if (error.response?.status === 400 &&
          error.response?.data?.detail?.error_code === 'research_stream_required') {
        return this.researchViaStream(params, apiKey);
      }
      throw error;
    }
  }

  private async researchViaStream(params: any, apiKey?: string): Promise<TavilyResearchResponse> {
    const HEADERS_TIMEOUT_MS = 30000;      // time budget for the response to start
    const STREAM_IDLE_TIMEOUT_MS = 300000; // 5 min: tolerate the silent report-generation phase (the report is generated then flushed at once, so no bytes flow meanwhile)
    const maxStreamDuration = params.model === 'mini' ? 300000 : 900000;

    const controller = new AbortController();
    const headerTimer = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
    let response;
    try {
      response = await this.axiosInstance.post(
        this.baseURLs.research,
        this.addApiKey({
          input: params.input,
          model: params.model || 'auto',
          stream: true
        }, apiKey),
        this.getRequestConfig(apiKey, {
          responseType: 'stream',
          signal: controller.signal,
          timeout: 0, // lifetime is enforced by the timers below, not by axios
          validateStatus: () => true
        }),
      );
    } catch (error: any) {
      if (isKeyRotationStatus(getErrorStatus(error))) {
        throw error;
      }
      const reason = controller.signal.aborted
        ? `no response after ${HEADERS_TIMEOUT_MS / 1000}s`
        : error.message;
      return { error: `Research stream request failed: ${reason}. Documentation: ${this.docsURLs.research}` };
    } finally {
      clearTimeout(headerTimer);
    }

    const stream = response.data;

    if (response.status !== 200) {
      const body = await this.readStreamBounded(stream, 16384);
      let detail = body;
      try {
        const parsed = JSON.parse(body);
        detail = JSON.stringify(parsed.detail ?? parsed);
      } catch { /* keep raw body */ }
      if (isKeyRotationStatus(response.status)) {
        const error = new Error(`Research stream request failed (HTTP ${response.status}): ${detail}`) as Error & {
          response?: { status: number; data: unknown };
        };
        error.response = { status: response.status, data: detail };
        throw error;
      }
      return { error: `Research stream request failed (HTTP ${response.status}): ${detail}. Documentation: ${this.docsURLs.research}` };
    }

    return new Promise<TavilyResearchResponse>((resolve) => {
      let content = '';
      let buffer = '';
      let settled = false;
      let idleTimer: NodeJS.Timeout | undefined;

      const settle = (result: TavilyResearchResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        clearTimeout(overallTimer);
        // Tear the connection down immediately — never leave it open once the
        // outcome is known.
        stream.destroy();
        resolve(result);
      };

      const overallTimer = setTimeout(() => {
        settle({ error: `Research stream timed out after ${maxStreamDuration / 1000}s. Documentation: ${this.docsURLs.research}` });
      }, maxStreamDuration);

      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          settle({ error: `Research stream received no data for ${STREAM_IDLE_TIMEOUT_MS / 1000}s; connection closed. Documentation: ${this.docsURLs.research}` });
        }, STREAM_IDLE_TIMEOUT_MS);
      };
      resetIdleTimer();

      const handleFrame = (frame: string) => {
        let eventType = 'message';
        const dataLines: string[] = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        const data = dataLines.join('\n');

        if (eventType === 'error') {
          let message: any = data;
          try { message = JSON.parse(data).error ?? data; } catch { /* keep raw data */ }
          if (typeof message === 'object') message = JSON.stringify(message);
          settle({ error: `Research stream error: ${message}. Documentation: ${this.docsURLs.research}` });
          return;
        }
        if (eventType === 'done') {
          settle(content
            ? { content }
            : { error: `Research stream completed without content. Documentation: ${this.docsURLs.research}` });
          return;
        }
        if (!data) return;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta;
          if (typeof delta?.content === 'string') content += delta.content;
        } catch { /* tolerate malformed frames; completion integrity is guarded by the done event */ }
      };

      stream.on('data', (chunk: Buffer) => {
        if (settled) return;
        resetIdleTimer();
        buffer += chunk.toString('utf-8');
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (settled) break;
          if (frame.trim()) handleFrame(frame);
        }
      });
      stream.on('error', (err: Error) => {
        settle({ error: `Research stream connection error: ${err.message}. Documentation: ${this.docsURLs.research}` });
      });
      // 'end'/'close' without a done event means the connection dropped before
      // completion — a partial report is worse than an explicit error.
      stream.on('end', () => {
        // The server ends the stream right after `event: done` without a
        // trailing blank line, so the final frame may still be buffered —
        // flush it before judging the outcome.
        if (!settled && buffer.trim()) handleFrame(buffer.trim());
        settle({ error: `Research stream ended before completion. Documentation: ${this.docsURLs.research}` });
      });
      stream.on('close', () => {
        settle({ error: `Research stream closed before completion. Documentation: ${this.docsURLs.research}` });
      });
    });
  }

  /** Read at most maxBytes from a stream as text, then destroy it. */
  private readStreamBounded(stream: any, maxBytes: number): Promise<string> {
    return new Promise((resolve) => {
      let data = '';
      const timer = setTimeout(() => { stream.destroy(); resolve(data); }, 10000);
      const finish = () => { clearTimeout(timer); resolve(data); };
      stream.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf-8');
        if (data.length >= maxBytes) stream.destroy();
      });
      stream.on('end', finish);
      stream.on('close', finish);
      stream.on('error', finish);
    });
  }
}

class KeyBoundError extends Error {
  response?: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'KeyBoundError';

    if (cause && typeof cause === 'object' && 'response' in cause) {
      this.response = cause.response;
    }
  }
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  const status = candidate.response?.status ?? candidate.status;
  return typeof status === 'number' ? status : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const candidate = error as {
    response?: { headers?: Record<string, unknown> };
  };
  const retryAfter = candidate.response?.headers?.['retry-after']
    ?? candidate.response?.headers?.['Retry-After'];

  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter)) {
    return Math.max(retryAfter * 1000, 0);
  }

  if (typeof retryAfter !== 'string') {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(seconds * 1000, 0);
  }

  const timestamp = Date.parse(retryAfter);
  return Number.isNaN(timestamp) ? undefined : Math.max(timestamp - Date.now(), 0);
}

function isKeyRotationStatus(status: number | undefined): boolean {
  return status === 401 || status === 429 || status === 432 || status === 433;
}

/**
 * Convert a Date to a wall-clock Date in the given IANA time zone. The result
 * is only meaningful for calendar predicates (getDate/getHours) — used by the
 * daily re-probe scheduler so "05:00" means 05:00 in the configured zone, not
 * in server-local time. Falls back to server time on invalid zones.
 */
const dateInZoneFormatters = new Map<string, Intl.DateTimeFormat>();

function dateInZone(date: Date, timeZone: string): Date {
  let formatter = dateInZoneFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
    } catch {
      return date; // invalid zone → treat as server-local time
    }
    dateInZoneFormatters.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(date);

  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  const shifted = new Date(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  if (Number.isNaN(shifted.getTime())) {
    return date;
  }
  return shifted;
}

function isKeylessEnvelope(data: any): boolean {
  // Recognises the Tavily API's recoverable-error envelope shape.
  // Used for keyless rate-limit caps and endpoints that require an API key.
  return !!(data && typeof data === 'object'
    && data.error && typeof data.error === 'object'
    && typeof data.error.code === 'string');
}

function formatKeylessEnvelope(data: any): string {
  // Render the Tavily API's recoverable-error envelope as plain text:
  // the natural-language message, followed by retry-after (when present).
  const err = data.error;
  const lines: string[] = [String(err.message ?? '')];
  if (err.retry_after_seconds != null) {
    lines.push(`Retry after: ${err.retry_after_seconds}s`);
  }
  if (Array.isArray(err.next_actions) && err.next_actions.length > 0) {
    lines.push('', 'Continuation options:');
    for (const a of err.next_actions) {
      if (a?.type === 'agentic_payment') {
        lines.push(`- Agentic payment (${a.scheme ?? 'x402'}): ${a.details ?? ''}`);
      } else if (a?.type === 'signup') {
        lines.push(`- Sign up for a Tavily API key: ${a.url ?? ''}`);
      } else if (a?.type === 'bonus_credits' && a.eligible) {
        lines.push(`- Earn ${a.credits_on_completion ?? ''} bonus credits by POSTing answers to ${a.endpoint ?? ''}`);
        if (Array.isArray(a.questions)) {
          a.questions.forEach((q: string, i: number) => lines.push(`    ${i + 1}. ${q}`));
        }
      }
    }
  }
  return lines.filter(Boolean).join('\n');
}

function formatResults(response: TavilyResponse): string {
  // Format API response into human-readable text
  const output: string[] = [];

  // Include answer if available
  if (response.answer) {
    output.push(`Answer: ${response.answer}`);
  }

  // Format detailed search results
  output.push('Detailed Results:');
  response.results.forEach(result => {
    output.push(`\nTitle: ${result.title}`);
    output.push(`URL: ${result.url}`);
    output.push(`Content: ${result.content}`);
    if (result.raw_content) {
      output.push(`Raw Content: ${result.raw_content}`);
    }
    if (result.favicon) {
      output.push(`Favicon: ${result.favicon}`);
    }
  });

    // Add images section if available
    if (response.images && response.images.length > 0) {
      output.push('\nImages:');
      response.images.forEach((image, index) => {
        if (typeof image === 'string') {
          output.push(`\n[${index + 1}] URL: ${image}`);
        } else {
          output.push(`\n[${index + 1}] URL: ${image.url}`);
          if (image.description) {
            output.push(`   Description: ${image.description}`);
          }
        }
      });
    }  

  return output.join('\n');
}

function formatCrawlResults(response: TavilyCrawlResponse): string {
  const output: string[] = [];
  
  output.push(`Crawl Results:`);
  output.push(`Base URL: ${response.base_url}`);
  
  output.push('\nCrawled Pages:');
  response.results.forEach((page, index) => {
    output.push(`\n[${index + 1}] URL: ${page.url}`);
    if (page.raw_content) {
      // Truncate content if it's too long
      const contentPreview = page.raw_content.length > 200 
        ? page.raw_content.substring(0, 200) + "..." 
        : page.raw_content;
      output.push(`Content: ${contentPreview}`);
    }
    if (page.favicon) {
      output.push(`Favicon: ${page.favicon}`);
    }
  });
  
  return output.join('\n');
}

function formatMapResults(response: TavilyMapResponse): string {
  const output: string[] = [];

  output.push(`Site Map Results:`);
  output.push(`Base URL: ${response.base_url}`);

  output.push('\nMapped Pages:');
  response.results.forEach((page, index) => {
    output.push(`\n[${index + 1}] URL: ${page}`);
  });

  return output.join('\n');
}

function formatResearchResults(response: TavilyResearchResponse): string {
  if (response.error) {
    return `Research Error: ${response.error}`;
  }

  return response.content || 'No research results available';
}

function formatKeyStatus(
  snapshots: KeyStatusSnapshot[],
  lastProbedAt: number,
  schedule: { reprobeHour: number; reprobeTz: string },
): string {
  if (snapshots.length === 0) {
    return 'Key pool is empty (keyless mode or no TAVILY_API_KEYS configured).';
  }

  const lines: string[] = ['Tavily key pool status:'];
  for (const snapshot of snapshots) {
    const remaining = snapshot.remaining === undefined
      ? 'unknown'
      : snapshot.remaining === null
        ? 'unlimited'
        : String(snapshot.remaining);
    const cooldown = snapshot.status === 'cooldown' && snapshot.availableAt !== undefined
      ? `, available in ${Math.max(Math.ceil((snapshot.availableAt - Date.now()) / 1000), 0)}s`
      : '';
    lines.push(`#${snapshot.index} ${snapshot.key} — ${snapshot.status}, remaining=${remaining}${cooldown}`);
  }

  const lastProbed = lastProbedAt === 0
    ? 'never'
    : `${Math.max(Math.round((Date.now() - lastProbedAt) / 1000), 0)}s ago`;
  lines.push(`Last probed: ${lastProbed}`);
  lines.push(`Daily re-probe: ${String(schedule.reprobeHour).padStart(2, '0')}:00 ${schedule.reprobeTz}`);
  return lines.join('\n');
}

function listTools(): void {
  const tools = [
    {
      name: "tavily_search",
      description: "A real-time web search tool powered by Tavily's AI engine. Features include customizable search depth (basic/advanced/fast/ultra-fast), domain filtering, time-based filtering, and support for both general and news-specific searches. Returns comprehensive results with titles, URLs, content snippets, and optional image results."
    },
    {
      name: "tavily_extract",
      description: "Extracts and processes content from specified URLs with advanced parsing capabilities. Supports both basic and advanced extraction modes, with the latter providing enhanced data retrieval including tables and embedded content. Ideal for data collection, content analysis, and research tasks."
    },
    {
      name: "tavily_crawl",
      description: "A sophisticated web crawler that systematically explores websites starting from a base URL. Features include configurable depth and breadth limits, domain filtering, path pattern matching, and category-based filtering. Perfect for comprehensive site analysis, content discovery, and structured data collection."
    },
    {
      name: "tavily_map",
      description: "Creates detailed site maps by analyzing website structure and navigation paths. Offers configurable exploration depth, domain restrictions, and category filtering. Ideal for site audits, content organization analysis, and understanding website architecture and navigation patterns."
    },
    {
      name: "tavily_research",
      description: "Performs comprehensive research on any topic or question by gathering information from multiple sources. Supports different research depths ('mini' for narrow tasks, 'pro' for broad research, 'auto' for automatic selection). Ideal for in-depth analysis, report generation, and answering complex questions requiring synthesis of multiple sources."
    },
    {
      name: "tavily_key_status",
      description: "Shows the current state of the configured Tavily API key pool: per-key status, masked key, remaining credits, and when the pool was last probed. Optionally refreshes by re-probing GET /usage."
    }
  ];

  console.log("Available tools:");
  tools.forEach(tool => {
    console.log(`\n- ${tool.name}`);
    console.log(`  Description: ${tool.description}`);
  });
  process.exit(0);
}

// Add this interface before the command line parsing
interface Arguments {
  'list-tools': boolean;
  _: (string | number)[];
  $0: string;
}

// Modify the command line parsing section to use proper typing
const argv = yargs(hideBin(process.argv))
  .option('list-tools', {
    type: 'boolean',
    description: 'List all available tools and exit',
    default: false
  })
  .help()
  .parse() as Arguments;

// List tools if requested
if (argv['list-tools']) {
  listTools();
}

// Otherwise start the server
const server = new TavilyClient();
server.run().catch(console.error);
