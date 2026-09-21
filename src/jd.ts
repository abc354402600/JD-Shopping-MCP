import { canonicalProductUrl, extractSku } from "./parser";
import type { DataSource, JdPrice, JdProduct, JdSearchResponse, JdSearchResult, JdShopInfo } from "./types";
import {
  decodeHtml,
  fetchWithTimeout,
  isLikelyRiskPage,
  normalizeWhitespace,
  safeNumber,
  stripTags,
  uniq,
} from "./utils";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

const COMMON_HEADERS: HeadersInit = {
  "user-agent": USER_AGENT,
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.6",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  referer: "https://www.jd.com/",
};

function now(): string {
  return new Date().toISOString();
}

function parseJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return raw.replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"');
  }
}

function pickFirst(html: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return normalizeWhitespace(decodeHtml(parseJsonString(match[1])));
  }
  return null;
}

function parseTitle(html: string): string | null {
  const value = pickFirst(html, [
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i,
    /<div[^>]+class=["'][^"']*sku-name[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<h1[^>]*>([\s\S]*?)<\/h1>/i,
    /"skuName"\s*:\s*"([^"]+)"/i,
    /"wareName"\s*:\s*"([^"]+)"/i,
    /<title>([\s\S]*?)<\/title>/i,
  ]);
  if (!value) return null;
  return stripTags(value)
    .replace(/\s*[【\[].*?京东.*?[】\]]\s*$/i, "")
    .replace(/\s*-\s*京东\s*$/i, "")
    .trim() || null;
}

function parseSpecs(html: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const add = (keyRaw: string, valueRaw: string) => {
    const key = stripTags(keyRaw).replace(/[：:]$/, "").trim();
    const value = stripTags(valueRaw).trim();
    if (!key || !value || key.length > 60 || value.length > 300) return;
    if (!(key in specs)) specs[key] = value;
  };

  // JD desktop parameter lists frequently use <li title="...">键：值</li>.
  for (const match of html.matchAll(/<li[^>]*title=["']([^"']*)["'][^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = stripTags(match[2]);
    const colon = text.search(/[：:]/);
    if (colon > 0) add(text.slice(0, colon), text.slice(colon + 1));
    else if (match[1]) {
      const title = decodeHtml(match[1]);
      const tColon = title.search(/[：:]/);
      if (tColon > 0) add(title.slice(0, tColon), title.slice(tColon + 1));
    }
    if (Object.keys(specs).length >= 60) break;
  }

  // Mobile/embedded JSON often contains key/value-ish parameter objects.
  if (Object.keys(specs).length < 8) {
    for (const match of html.matchAll(/"(?:name|attName|key)"\s*:\s*"([^"]{1,80})"\s*,\s*"(?:value|attValue|val)"\s*:\s*"([^"]{1,300})"/gi)) {
      add(parseJsonString(match[1]), parseJsonString(match[2]));
      if (Object.keys(specs).length >= 60) break;
    }
  }

  return specs;
}

function parseShop(html: string): JdShopInfo {
  const shopName = pickFirst(html, [
    /"shopName"\s*:\s*"([^"]+)"/i,
    /"venderName"\s*:\s*"([^"]+)"/i,
    /<a[^>]+class=["'][^"']*(?:name|shop-name)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i,
    /<span[^>]+class=["'][^"']*shop-name[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  ]);
  const shopId = pickFirst(html, [/"shopId"\s*:\s*"?(\d+)"?/i]);
  const venderId = pickFirst(html, [/"venderId"\s*:\s*"?(\d+)"?/i, /"vendorId"\s*:\s*"?(\d+)"?/i]);
  const selfSignals = [
    /京东自营/i.test(shopName ?? ""),
    /"isJD"\s*:\s*(?:true|1|"1")/i.test(html),
    /"selfOperated"\s*:\s*(?:true|1|"1")/i.test(html),
    /京东自营/.test(html.slice(0, 500_000)),
  ];
  const isJdSelfOperated = selfSignals.some(Boolean);
  const isOfficialFlagship = /官方旗舰店|品牌旗舰店/i.test(shopName ?? "");
  const evidenceCount = selfSignals.filter(Boolean).length + (shopName ? 1 : 0);
  return {
    shopName: shopName ? stripTags(shopName) : null,
    shopId,
    venderId,
    isJdSelfOperated,
    isOfficialFlagship,
    confidence: evidenceCount >= 2 ? "high" : evidenceCount === 1 ? "medium" : "low",
  };
}

async function fetchHtml(url: string, referer?: string): Promise<{ html: string; sourceOk: boolean; status: number }> {
  const response = await fetchWithTimeout(url, {
    headers: { ...COMMON_HEADERS, ...(referer ? { referer } : {}) },
    redirect: "follow",
  });
  const html = await response.text();
  return { html, sourceOk: response.ok && !isLikelyRiskPage(html, response.status), status: response.status };
}

export async function getPrice(input: string): Promise<JdPrice> {
  const sku = extractSku(input);
  const url = `https://p.3.cn/prices/mgets?skuIds=J_${encodeURIComponent(sku)}`;
  const response = await fetchWithTimeout(url, {
    headers: {
      ...COMMON_HEADERS,
      accept: "application/json,text/plain,*/*",
      referer: canonicalProductUrl(sku),
    },
  });
  if (!response.ok) throw new Error(`京东价格接口返回 HTTP ${response.status}`);
  const data = (await response.json()) as Array<Record<string, unknown>>;
  const row = data?.[0] ?? {};
  return {
    sku,
    price: safeNumber(row.p),
    originalPrice: safeNumber(row.op ?? row.m),
    currency: "CNY",
    source: "jd-price",
    fetchedAt: now(),
  };
}

async function getPricesBatch(skus: string[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  if (!skus.length) return result;
  const ids = skus.map((sku) => `J_${sku}`).join(",");
  try {
    const response = await fetchWithTimeout(`https://p.3.cn/prices/mgets?skuIds=${encodeURIComponent(ids)}`, {
      headers: { ...COMMON_HEADERS, accept: "application/json,text/plain,*/*" },
    });
    if (!response.ok) return result;
    const data = (await response.json()) as Array<Record<string, unknown>>;
    for (const row of data) {
      const id = String(row.id ?? "").replace(/^J_/, "");
      if (id) result.set(id, safeNumber(row.p));
    }
  } catch {
    // Price is optional for search results.
  }
  return result;
}

async function fetchProductPage(sku: string): Promise<{ html: string; source: DataSource; warnings: string[] }> {
  const warnings: string[] = [];
  const desktopUrl = canonicalProductUrl(sku);
  try {
    const desktop = await fetchHtml(desktopUrl);
    if (desktop.sourceOk && parseTitle(desktop.html)) {
      return { html: desktop.html, source: "jd-item", warnings };
    }
    warnings.push(`京东桌面商品页不可稳定读取（HTTP ${desktop.status} 或命中风控页），已尝试移动页回退。`);
  } catch (error) {
    warnings.push(`京东桌面商品页请求失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const mobileUrl = `https://item.m.jd.com/product/${sku}.html`;
  try {
    const mobile = await fetchHtml(mobileUrl, "https://m.jd.com/");
    if (mobile.sourceOk && parseTitle(mobile.html)) {
      return { html: mobile.html, source: "jd-mobile-item", warnings };
    }
    warnings.push(`京东移动商品页也不可稳定读取（HTTP ${mobile.status} 或命中风控页）。`);
    return { html: mobile.html, source: "jd-mobile-item", warnings };
  } catch (error) {
    warnings.push(`京东移动商品页请求失败：${error instanceof Error ? error.message : String(error)}`);
    return { html: "", source: "jd-mobile-item", warnings };
  }
}

export async function getProduct(input: string): Promise<JdProduct> {
  const sku = extractSku(input);
  const page = await fetchProductPage(sku);
  const title = page.html ? parseTitle(page.html) : null;
  const specs = page.html ? parseSpecs(page.html) : {};
  const shop = page.html ? parseShop(page.html) : {
    shopName: null,
    shopId: null,
    venderId: null,
    isJdSelfOperated: false,
    isOfficialFlagship: false,
    confidence: "low" as const,
  };

  let price: JdPrice | null = null;
  try {
    price = await getPrice(sku);
  } catch (error) {
    page.warnings.push(`公开价格接口读取失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!title) page.warnings.push("未能从公开页面解析商品标题；京东可能对当前云端出口做了风控。SKU 和价格仍可能可用。");
  if (!Object.keys(specs).length) page.warnings.push("未解析到规格参数；部分商品规格由前端动态接口加载。此字段属于尽力而为。 ");
  if (!shop.shopName) page.warnings.push("未解析到店铺名称；自营/旗舰判断在此情况下置信度较低。");

  return {
    sku,
    url: canonicalProductUrl(sku),
    title,
    price: price?.price ?? null,
    originalPrice: price?.originalPrice ?? null,
    currency: "CNY",
    specs,
    shop,
    sources: uniq([page.source, ...(price ? [price.source] : [] as DataSource[])]),
    warnings: uniq(page.warnings),
    fetchedAt: now(),
  };
}

function parseSearchBlocks(html: string, limit: number): Array<{ sku: string; title: string | null }> {
  const out: Array<{ sku: string; title: string | null }> = [];
  const seen = new Set<string>();
  const blocks = html.match(/<li[^>]+data-sku=["']\d+["'][\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    const sku = block.match(/data-sku=["'](\d+)["']/i)?.[1];
    if (!sku || seen.has(sku)) continue;
    const titleRaw = pickFirst(block, [
      /<div[^>]+class=["'][^"']*p-name[^"']*["'][\s\S]*?<em[^>]*>([\s\S]*?)<\/em>/i,
      /<a[^>]+title=["']([^"']+)["']/i,
      /<em[^>]*>([\s\S]*?)<\/em>/i,
    ]);
    seen.add(sku);
    out.push({ sku, title: titleRaw ? stripTags(titleRaw) : null });
    if (out.length >= limit) break;
  }
  return out;
}

function parseBingJdSkus(html: string, limit: number): Array<{ sku: string; title: string | null }> {
  const out: Array<{ sku: string; title: string | null }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a[^>]+href=["']https?:\/\/item\.jd\.com\/(\d+)\.html[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const sku = match[1];
    if (seen.has(sku)) continue;
    seen.add(sku);
    out.push({ sku, title: stripTags(match[2]) || null });
    if (out.length >= limit) break;
  }
  return out;
}

async function searchViaProxy(proxyUrl: string, query: string, limit: number): Promise<JdSearchResult[]> {
  const u = new URL(proxyUrl);
  u.searchParams.set("q", query);
  u.searchParams.set("limit", String(limit));
  const response = await fetchWithTimeout(u, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`搜索代理返回 HTTP ${response.status}`);
  const body = (await response.json()) as { results?: Array<Record<string, unknown>> };
  return (body.results ?? []).slice(0, limit).flatMap((row): JdSearchResult[] => {
    const sku = String(row.sku ?? "").match(/^\d+$/)?.[0];
    if (!sku) return [];
    return [{
      sku,
      title: typeof row.title === "string" ? row.title : null,
      url: typeof row.url === "string" ? row.url : canonicalProductUrl(sku),
      price: safeNumber(row.price),
      shopName: typeof row.shopName === "string" ? row.shopName : null,
      source: "proxy",
    }];
  });
}

export async function searchProducts(
  query: string,
  limit = 8,
  options: { proxyUrl?: string } = {},
): Promise<JdSearchResponse> {
  const q = query.trim();
  if (!q) throw new Error("搜索关键词不能为空。");
  const capped = Math.max(1, Math.min(20, Math.trunc(limit)));
  const warnings: string[] = [];

  if (options.proxyUrl) {
    try {
      const proxyResults = await searchViaProxy(options.proxyUrl, q, capped);
      if (proxyResults.length) {
        return { query: q, results: proxyResults, source: "proxy", warnings, fetchedAt: now() };
      }
      warnings.push("已配置的搜索代理未返回结果，继续尝试京东公开搜索页。");
    } catch (error) {
      warnings.push(`搜索代理失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const directUrl = `https://search.jd.com/Search?keyword=${encodeURIComponent(q)}&enc=utf-8&wq=${encodeURIComponent(q)}`;
  try {
    const direct = await fetchHtml(directUrl, "https://www.jd.com/");
    if (direct.sourceOk) {
      const parsed = parseSearchBlocks(direct.html, capped);
      if (parsed.length) {
        const prices = await getPricesBatch(parsed.map((x) => x.sku));
        const results = parsed.map((x): JdSearchResult => ({
          sku: x.sku,
          title: x.title,
          url: canonicalProductUrl(x.sku),
          price: prices.get(x.sku) ?? null,
          source: "jd-search",
        }));
        return { query: q, results, source: "jd-search", warnings, fetchedAt: now() };
      }
    }
    warnings.push(`京东公开搜索页未返回可解析商品（HTTP ${direct.status} 或触发风控），启用搜索引擎回退。`);
  } catch (error) {
    warnings.push(`京东公开搜索请求失败：${error instanceof Error ? error.message : String(error)}；启用搜索引擎回退。`);
  }

  // Fallback: use Bing only for discovery of public item.jd.com URLs, then query JD price endpoint directly.
  try {
    const bingUrl = `https://www.bing.com/search?q=${encodeURIComponent(`site:item.jd.com ${q} 京东`)}`;
    const response = await fetchWithTimeout(bingUrl, {
      headers: { "user-agent": USER_AGENT, "accept-language": "zh-CN,zh;q=0.9" },
    });
    const html = await response.text();
    const parsed = parseBingJdSkus(html, capped);
    if (parsed.length) {
      const prices = await getPricesBatch(parsed.map((x) => x.sku));
      const results = parsed.map((x): JdSearchResult => ({
        sku: x.sku,
        title: x.title,
        url: canonicalProductUrl(x.sku),
        price: prices.get(x.sku) ?? null,
        source: "bing-fallback",
      }));
      warnings.push("结果通过 Bing 发现公开京东商品 URL，再由京东公开价格接口补价；排序不等同京东 App 内搜索排序。");
      return { query: q, results, source: "bing-fallback", warnings, fetchedAt: now() };
    }
  } catch (error) {
    warnings.push(`搜索引擎回退失败：${error instanceof Error ? error.message : String(error)}`);
  }

  warnings.push("当前云端出口无法稳定完成京东公开商品搜索。可设置 JD_SEARCH_PROXY_URL 接入中国大陆地区的只读搜索代理；SKU/商品链接解析和公开价格查询仍可独立使用。");
  return { query: q, results: [], source: "jd-search", warnings, fetchedAt: now() };
}

export async function compareProducts(inputs: string[]): Promise<JdProduct[]> {
  const deduped = uniq(inputs.map(extractSku));
  if (deduped.length < 2) throw new Error("至少需要两个不同的京东 SKU/商品链接进行比较。");
  if (deduped.length > 10) throw new Error("一次最多比较 10 个商品。");
  return await Promise.all(deduped.map((sku) => getProduct(sku)));
}
