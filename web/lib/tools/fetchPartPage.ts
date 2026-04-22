/**
 * Live fetch tool — retrieves real product data for any PS number directly
 * from PartSelect via Jina.ai (which bypasses Akamai CDN restrictions).
 *
 * Architecture note: this tool makes the agent extensible to the full PartSelect
 * catalog, not just the 4 parts seeded in catalog.json. The local catalog acts
 * as a fast, rich cache for common catalog parts; this tool is the fallback for
 * the long tail of real part numbers.
 *
 * Only used in the LLM path (executePartselectTool is sync; this is async).
 * Results are cached in-memory for 1 hour to avoid repeated Jina fetches.
 */

export type FetchPartPageResult =
  | {
      ok: true;
      partNumber: string;
      title: string;
      price?: number;
      inStock?: boolean;
      description?: string;
      installHint?: string;
      rating?: number;
      reviewCount?: number;
      source: "live_partselect";
    }
  | { ok: false; error: string };

// Simple in-memory cache — survives across requests in a long-running Node process.
const cache = new Map<string, { result: FetchPartPageResult; ts: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function parsePrice(text: string): number | undefined {
  // Grab the FIRST dollar-amount that looks like a retail price (not $0.00)
  const m = text.match(/\$(\d{1,4}\.\d{2})/);
  return m ? parseFloat(m[1]) : undefined;
}

function parseRating(text: string): { rating?: number; reviewCount?: number } {
  // "4.8 out of 5 stars" or "★★★★★ 406 Reviews"
  const starsMatch = text.match(/(\d\.\d)\s*out\s*of\s*5/i);
  const countMatch = text.match(/(\d[\d,]+)\s*reviews?/i);
  return {
    rating: starsMatch ? parseFloat(starsMatch[1]) : undefined,
    reviewCount: countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : undefined,
  };
}

function parseInstallHint(text: string): string | undefined {
  // PartSelect product pages often have a description paragraph with install hints
  const match =
    text.match(/To (?:repair|install|replace)[^.]+(?:\.[^.]+){0,3}\./) ??
    text.match(/(?:Open|Remove|Disconnect)[^.]+(?:\.[^.]+){0,4}\./);
  return match?.[0]?.trim();
}

export async function fetchPartPageTool(input: {
  part_number: string;
}): Promise<FetchPartPageResult> {
  const raw = input.part_number.replace(/^PS/i, "").trim();
  if (!raw || !/^\d{5,}$/.test(raw)) {
    return { ok: false, error: "part_number must be a PS##### identifier (digits only after PS)" };
  }

  const partNumber = `PS${raw}`;
  const cached = cache.get(partNumber);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const jinaUrl = `https://r.jina.ai/https://www.partselect.com/${partNumber}-.htm`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14_000);

    let res: Response;
    try {
      res = await fetch(jinaUrl, {
        headers: { Accept: "text/plain", "X-No-Cache": "true" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const err: FetchPartPageResult = {
        ok: false,
        error: `PartSelect page returned HTTP ${res.status} for ${partNumber}`,
      };
      return err;
    }

    const text = await res.text();

    // Check for "page not found" indicators
    if (/page not found|no longer available|discontinued/i.test(text.slice(0, 2000))) {
      const err: FetchPartPageResult = { ok: false, error: `${partNumber} not found on PartSelect` };
      return err;
    }

    // Extract title from Jina header line
    const titleMatch = text.match(/Title:\s*(?:Official\s+)?(.+?)\s*[–\-—]\s*PartSelect/i);
    const title = titleMatch?.[1]?.trim() ?? partNumber;

    const price = parsePrice(text);
    const inStock =
      /In\s+Stock/i.test(text) && !/Out\s+of\s+Stock/i.test(text.slice(0, 3000));

    const { rating, reviewCount } = parseRating(text);
    const description = parseInstallHint(text);

    const result: FetchPartPageResult = {
      ok: true,
      partNumber,
      title,
      price,
      inStock,
      description,
      installHint: description,
      rating,
      reviewCount,
      source: "live_partselect",
    };

    cache.set(partNumber, { result, ts: Date.now() });
    return result;
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { ok: false, error: "Live fetch timed out — PartSelect page took too long to load" };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error fetching PartSelect page",
    };
  }
}
