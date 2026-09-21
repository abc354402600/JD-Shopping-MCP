# JD Shopping MCP

一个面向 ChatGPT / Codex / 其他 MCP 客户端的**只读京东商品查询 MCP**。

第一版只使用公开网页和公开价格端点，不登录京东、不保存 Cookie、不读取账号、不下单、不支付。

## 能做什么

MCP 暴露以下工具：

- `jd_parse_product`：解析京东商品 URL / SKU
- `jd_get_price`：读取公开价格
- `jd_get_product`：读取标题、价格、规格、店铺、自营/旗舰判断
- `jd_get_specs`：只取规格
- `jd_get_shop_info`：只取店铺与自营/旗舰判断
- `jd_search_products`：公开商品搜索
- `jd_compare_products`：比较 2-10 个商品

## 数据边界

京东公开网页存在动态渲染和风控，因此：

- 公开价格通常可从 `p.3.cn` 获取，但不保证包含 PLUS 价、券后价、地区专享价、以旧换新补贴等登录态/地区态价格。
- 商品标题、规格、店铺信息来自公开商品页，若 Cloudflare 出口被京东风控，字段可能缺失。
- 搜索优先访问京东公开搜索页；若失败，会尝试用 Bing 发现 `item.jd.com` 商品 URL，再回京东公开价格端点补价。此时排序**不等于京东 App 内搜索排序**。
- `isJdSelfOperated` / `isOfficialFlagship` 是基于公开页面信号的判断，并带 `confidence`，不能当作法律或平台认证证明。

每个工具返回的 `warnings` 会说明降级或缺失情况。

## 项目结构

```text
JD-Shopping-MCP/
├─ src/
│  ├─ index.ts          # Worker + MCP 工具注册
│  ├─ jd.ts             # 京东请求、解析、搜索、价格
│  ├─ parser.ts         # SKU / URL 解析
│  ├─ types.ts
│  └─ utils.ts
├─ plugin-template/     # 部署后用于 ChatGPT/Codex 插件市场的模板
├─ .agents/plugins/     # 仓库级插件市场入口
├─ scripts/
├─ package.json
├─ tsconfig.json
└─ wrangler.jsonc
```

## 本地测试

需要 Node.js 22+。

```bash
npm install
npm run typecheck
npm run dev
```

Worker 默认启动在 Wrangler 输出的本地地址。健康检查：

```text
http://localhost:8787/health
```

MCP 地址：

```text
http://localhost:8787/mcp
```

用 MCP Inspector 测试：

```bash
npx @modelcontextprotocol/inspector@latest
```

然后把 MCP URL 填入 Inspector。

## 免费部署到 Cloudflare Workers

### 方法 A：CLI（最直接）

```bash
npm install
npx wrangler login
npm run deploy
```

部署完成后会得到类似：

```text
https://jd-shopping-mcp.<你的 workers.dev 子域>.workers.dev
```

健康检查：

```text
https://...workers.dev/health
```

MCP 地址：

```text
https://...workers.dev/mcp
```

### 方法 B：Cloudflare Dashboard 连接 GitHub

1. 把本项目全部文件提交到 GitHub。
2. Cloudflare Dashboard → Workers & Pages → Create / Import repository。
3. 选择本仓库。
4. 构建/部署按 `wrangler.jsonc` 和 `package.json` 执行。
5. 部署后记下 `https://...workers.dev/mcp`。

## 可选：给 MCP 加一个简单 Bearer Token

默认 MCP 是公开的，方便个人先测试。

如果不想任何人都能调用你的 Worker：

```bash
npx wrangler secret put MCP_SHARED_TOKEN
```

然后客户端需要发送：

```text
Authorization: Bearer <你的 token>
```

注意：不同 ChatGPT 插件/客户端对自定义 Bearer Header 的支持方式不同。第一次接入建议先保持公开，确认可用后再加。

## Cloudflare 出口被京东搜索风控怎么办

这是预期内的现实风险，不是 MCP 本身故障。项目预留了 `JD_SEARCH_PROXY_URL`。

你以后如果有一个中国大陆地区的**只读搜索代理**，可设置：

```bash
npx wrangler secret put JD_SEARCH_PROXY_URL
```

代理约定：

```http
GET https://your-proxy.example/search?q=猫咪驱虫&limit=8
```

返回：

```json
{
  "results": [
    {
      "sku": "100000000000",
      "title": "商品标题",
      "url": "https://item.jd.com/100000000000.html",
      "price": 199.0,
      "shopName": "示例店铺"
    }
  ]
}
```

不配置时完全不影响其它工具。

## 部署后生成 ChatGPT / Codex 插件配置

仓库已经附带 `plugin-template/` 和 `.agents/plugins/marketplace.json`。

部署后运行：

```bash
node scripts/set-worker-url.mjs https://你的域名.workers.dev/mcp
```

它会把 `plugin-template/.mcp.json` 中的占位地址替换为真实 MCP URL。

然后提交这次改动。之后可在支持 Git 仓库插件市场的 ChatGPT/Codex 界面中添加这个仓库。

## 安全原则

这个版本明确不实现：

- 京东账号密码
- Cookie / 登录态窃取或保存
- 订单读取
- 加购物车
- 下单
- 支付

所有功能只读。
