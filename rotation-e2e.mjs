
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "rotation-e2e", version: "0.0.1" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: "npm",
  args: ["exec", "-y", "--", "@spraylee/tavily-mcp-multi-key@0.2.0"],
  env: process.env,
});
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));

let st = await client.callTool({ name: "tavily_key_status", arguments: {} });
console.log("STATUS_INITIAL:\n" + st.content[0].text);

for (let i = 1; i <= 3; i++) {
  const r = await client.callTool({ name: "tavily_search", arguments: { query: `rotation test ${i}`, max_results: 5 } });
  console.log(`SEARCH_${i}:`, r.isError === undefined ? "OK" : "FAIL");
}

st = await client.callTool({ name: "tavily_key_status", arguments: { refresh: true } });
console.log("STATUS_AFTER:\n" + st.content[0].text);

await client.close();
process.exit(0);
