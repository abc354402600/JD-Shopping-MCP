import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const input = process.argv[2];
if (!input) {
  console.error("用法: node scripts/set-worker-url.mjs https://xxx.workers.dev/mcp");
  process.exit(1);
}

let url;
try {
  url = new URL(input);
} catch {
  console.error("不是有效 URL:", input);
  process.exit(1);
}
if (url.protocol !== "https:") {
  console.error("远程 MCP 应使用 HTTPS URL。");
  process.exit(1);
}
if (!url.pathname.endsWith("/mcp")) {
  url.pathname = url.pathname.replace(/\/$/, "") + "/mcp";
}

const file = resolve("plugin-template/.mcp.json");
const raw = await readFile(file, "utf8");
const data = JSON.parse(raw);
data.mcpServers["jd-shopping"].url = url.toString();
await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf8");
console.log("已更新:", file);
console.log("MCP URL:", url.toString());
