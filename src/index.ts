import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { compareProducts, getPrice, getProduct, searchProducts } from "./jd";
import { canonicalProductUrl, extractSku } from "./parser";
import { jsonText } from "./utils";

interface Env {
  MCP_SHARED_TOKEN?: string;
  JD_SEARCH_PROXY_URL?: string;
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: "JD Shopping MCP",
    version: "0.1.0",
  });

  server.registerTool(
    "jd_parse_product",
    {
      title: "解析京东商品 URL / SKU",
      description: "从京东商品链接、SKU 文本中提取 SKU，并返回标准 item.jd.com 链接。只读，不访问账号。",
      inputSchema: z.object({ input: z.string().min(1).describe("京东商品 URL 或 SKU") }),
    },
    async ({ input }) => {
      const sku = extractSku(input);
      return jsonText({ sku, url: canonicalProductUrl(sku) });
    },
  );

  server.registerTool(
    "jd_get_price",
    {
      title: "查询京东公开价格",
      description: "通过京东公开价格端点查询 SKU 的公开价格。促销券、PLUS 专享价、地区专属价可能不包含。",
      inputSchema: z.object({ input: z.string().min(1).describe("京东商品 URL 或 SKU") }),
    },
    async ({ input }) => jsonText(await getPrice(input)),
  );

  server.registerTool(
    "jd_get_product",
    {
      title: "读取京东公开商品信息",
      description: "读取公开商品页并返回标题、公开价格、规格、店铺、自营/官方旗舰店判断。字段受京东风控和动态渲染影响，返回 warnings 说明缺失项。",
      inputSchema: z.object({ input: z.string().min(1).describe("京东商品 URL 或 SKU") }),
    },
    async ({ input }) => jsonText(await getProduct(input)),
  );

  server.registerTool(
    "jd_get_specs",
    {
      title: "读取京东商品规格",
      description: "返回公开商品页可解析到的规格参数。部分动态规格可能无法从云端匿名请求获得。",
      inputSchema: z.object({ input: z.string().min(1).describe("京东商品 URL 或 SKU") }),
    },
    async ({ input }) => {
      const product = await getProduct(input);
      return jsonText({ sku: product.sku, title: product.title, specs: product.specs, warnings: product.warnings });
    },
  );

  server.registerTool(
    "jd_get_shop_info",
    {
      title: "判断京东店铺 / 自营 / 官方旗舰",
      description: "从公开商品页解析店铺名称，并尽力判断京东自营和官方旗舰店。返回 confidence 表示置信度。",
      inputSchema: z.object({ input: z.string().min(1).describe("京东商品 URL 或 SKU") }),
    },
    async ({ input }) => {
      const product = await getProduct(input);
      return jsonText({ sku: product.sku, title: product.title, shop: product.shop, warnings: product.warnings });
    },
  );

  server.registerTool(
    "jd_search_products",
    {
      title: "搜索京东公开商品",
      description: "优先搜索京东公开网页；若云端出口触发风控，则尝试仅用于发现 item.jd.com 链接的搜索引擎回退。不会登录京东。",
      inputSchema: z.object({
        query: z.string().min(1).describe("搜索关键词"),
        limit: z.number().int().min(1).max(20).default(8).describe("返回数量，1-20"),
      }),
    },
    async ({ query, limit }) => jsonText(await searchProducts(query, limit, { proxyUrl: env.JD_SEARCH_PROXY_URL })),
  );

  server.registerTool(
    "jd_compare_products",
    {
      title: "比较多个京东商品",
      description: "并行读取 2-10 个京东商品的公开标题、价格、规格和店铺信息，返回结构化数组供模型比较。",
      inputSchema: z.object({
        inputs: z.array(z.string().min(1)).min(2).max(10).describe("2-10 个京东 SKU 或商品链接"),
      }),
    },
    async ({ inputs }) => jsonText(await compareProducts(inputs)),
  );

  return server;
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json; charset=utf-8", "www-authenticate": "Bearer" },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-expose-headers", "mcp-session-id, mcp-protocol-version");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization,mcp-session-id,mcp-protocol-version,last-event-id",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        name: "JD Shopping MCP",
        version: "0.1.0",
        mcp: `${url.origin}/mcp`,
        readOnly: true,
        authentication: env.MCP_SHARED_TOKEN ? "bearer-token" : "public",
      });
    }

    if (url.pathname !== "/mcp" && url.pathname !== "/sse") {
      return new Response("Not found", { status: 404 });
    }

    if (env.MCP_SHARED_TOKEN) {
      const expected = `Bearer ${env.MCP_SHARED_TOKEN}`;
      if (request.headers.get("authorization") !== expected) return unauthorized();
    }

    // Fresh MCP server per HTTP request, as required by MCP SDK v2's stateless handler.
    const handler = createMcpHandler(() => buildServer(env), { responseMode: "json" });
    try {
      return withCors(await handler.fetch(request));
    } finally {
      await handler.close();
    }
  },
};
