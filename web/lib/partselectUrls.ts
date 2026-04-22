/** Public PartSelect.com URLs (no API key; opens in the user's browser on their domain). */

export function normalizePartSelectNumber(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (/^PS\d{5,}$/.test(t)) return t;
  const digits = t.replace(/^PS/i, "");
  return `PS${digits}`;
}

export type PartSelectProductLinkInput = {
  partNumber: string;
  title?: string;
  manufacturer?: string;
  manufacturerPartNumber?: string;
};

/**
 * Official product detail page — same destination as PartSelect "View product".
 * Prefer slug URL when we have OEM + title (better SEO match); else minimal PS#####-.htm.
 */
export function partSelectProductPageUrl(input: PartSelectProductLinkInput): string {
  const digits = normalizePartSelectNumber(input.partNumber).replace(/^PS/i, "");
  const { title, manufacturer, manufacturerPartNumber } = input;
  if (manufacturer?.trim() && manufacturerPartNumber?.trim() && title?.trim()) {
    const slug = (s: string) => s.trim().replace(/\s+/g, "-");
    return `https://www.partselect.com/PS${digits}-${slug(manufacturer)}-${slug(manufacturerPartNumber)}-${slug(title)}.htm`;
  }
  return `https://www.partselect.com/PS${digits}-.htm`;
}

/** Official cart / checkout entry (same session as tabs opened from this origin). */
export function partSelectShoppingCartUrl(): string {
  return "https://www.partselect.com/ShoppingCart.aspx";
}
