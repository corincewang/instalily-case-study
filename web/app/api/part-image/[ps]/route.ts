/**
 * GET /api/part-image/[ps]
 *
 * Fetches the PartSelect product page server-side and extracts:
 *   - imageUrl: primary product image from the Azure Front Door CDN
 *   - videoId:  first YouTube video ID embedded on the page (install video)
 *
 * Results are cached in memory for the process lifetime.
 */
import { NextResponse } from "next/server";

type PartMedia = { imageUrl: string | null; videoId: string | null };

const cache = new Map<string, PartMedia>();

const CDN_IMAGE_RE = /https:\/\/partselectcom-[^"'\s]+\/(\d{5,}-1-[LMS]-[^"'\s]+\.jpg)/gi;
const YOUTUBE_ID_RE = /youtube\.com\/(?:embed\/|watch\?v=|vi\/)([A-Za-z0-9_-]{11})/g;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function fetchPartMedia(ps: string): Promise<PartMedia> {
  const normalized = ps.toUpperCase().replace(/^PS/i, "");
  const url = `https://www.partselect.com/PS${normalized}-.htm`;

  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return { imageUrl: null, videoId: null };
    const html = await res.text();

    // Image
    const imgMatches: string[] = [];
    let m: RegExpExecArray | null;
    const imgRe = new RegExp(CDN_IMAGE_RE.source, "gi");
    while ((m = imgRe.exec(html)) !== null) imgMatches.push(m[0]);
    const medium = imgMatches.find((u) => /-1-M-/.test(u));
    const large  = imgMatches.find((u) => /-1-L-/.test(u));
    const imageUrl = medium ?? large ?? imgMatches[0] ?? null;

    // YouTube video ID (first unique match)
    const ytRe = new RegExp(YOUTUBE_ID_RE.source, "g");
    const videoIds = new Set<string>();
    while ((m = ytRe.exec(html)) !== null) videoIds.add(m[1]);
    const videoId = videoIds.size > 0 ? [...videoIds][0] : null;

    return { imageUrl, videoId };
  } catch {
    return { imageUrl: null, videoId: null };
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ ps: string }> }
) {
  const { ps } = await params;

  if (!ps || !/^PS?\d{5,}$/i.test(ps)) {
    return NextResponse.json({ error: "invalid_ps" }, { status: 400 });
  }

  const key = ps.toUpperCase();
  if (cache.has(key)) {
    return NextResponse.json(cache.get(key));
  }

  const media = await fetchPartMedia(ps);
  cache.set(key, media);
  return NextResponse.json(media);
}
