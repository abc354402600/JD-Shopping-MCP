export function extractSku(input: string): string {
  const raw = input.trim();
  if (/^\d{5,20}$/.test(raw)) return raw;

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep original text.
  }

  const patterns = [
    /item\.jd\.com\/(\d{5,20})\.html/i,
    /item\.m\.jd\.com\/(?:product\/)?(\d{5,20})\.html/i,
    /(?:^|[?&])sku(?:Id)?=(\d{5,20})(?:&|$)/i,
    /(?:^|[?&])wareId=(\d{5,20})(?:&|$)/i,
    /\bsku[:\s#-]*(\d{5,20})\b/i,
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match?.[1]) return match[1];
  }

  const generic = decoded.match(/\b(\d{6,20})\b/);
  if (generic?.[1]) return generic[1];
  throw new Error("无法从输入中解析京东 SKU。请提供 SKU 数字或 item.jd.com 商品链接。");
}

export function canonicalProductUrl(sku: string): string {
  return `https://item.jd.com/${sku}.html`;
}
