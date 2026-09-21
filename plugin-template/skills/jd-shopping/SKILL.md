---
name: jd-shopping
description: Use the JD Shopping MCP for read-only JD.com public product search, SKU parsing, public prices, specs, shop metadata, and product comparison.
---

# JD Shopping

Use the bundled MCP tools when the user asks about JD.com products.

Rules:

- Prefer `jd_get_product` when the user provides a JD URL or SKU and wants a general overview.
- Prefer `jd_get_price` for a price-only question.
- Prefer `jd_get_specs` for specification questions.
- Prefer `jd_get_shop_info` for JD self-operated / official flagship questions.
- Use `jd_search_products` for discovery; mention any warnings if the result fell back from JD direct search.
- Use `jd_compare_products` for 2-10 exact SKU/URL comparisons.
- Treat public price as public anonymous price, not guaranteed PLUS/coupon/subsidy/region-specific checkout price.
- Never claim this plugin can log in, order, pay, or access the user's JD account.
