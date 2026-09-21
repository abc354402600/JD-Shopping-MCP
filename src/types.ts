export type DataSource =
  | "jd-item"
  | "jd-mobile-item"
  | "jd-price"
  | "jd-search"
  | "bing-fallback"
  | "proxy"
  | "derived";

export interface JdPrice {
  sku: string;
  price: number | null;
  originalPrice: number | null;
  currency: "CNY";
  source: DataSource;
  fetchedAt: string;
}

export interface JdShopInfo {
  shopName: string | null;
  shopId: string | null;
  venderId: string | null;
  isJdSelfOperated: boolean;
  isOfficialFlagship: boolean;
  confidence: "high" | "medium" | "low";
}

export interface JdProduct {
  sku: string;
  url: string;
  title: string | null;
  price: number | null;
  originalPrice: number | null;
  currency: "CNY";
  specs: Record<string, string>;
  shop: JdShopInfo;
  sources: DataSource[];
  warnings: string[];
  fetchedAt: string;
}

export interface JdSearchResult {
  sku: string;
  title: string | null;
  url: string;
  price: number | null;
  shopName?: string | null;
  source: DataSource;
}

export interface JdSearchResponse {
  query: string;
  results: JdSearchResult[];
  source: DataSource;
  warnings: string[];
  fetchedAt: string;
}
