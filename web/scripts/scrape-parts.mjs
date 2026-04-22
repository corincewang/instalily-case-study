/**
 * Scrapes real part data from PartSelect.com and merges into data/catalog.json.
 *
 * Usage:  node scripts/scrape-parts.mjs
 *
 * Adds 16 new parts (10 fridge + 6 dishwasher) to the existing 4, giving 20 total.
 * Respects the site with a 1.5s delay between requests.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, "../data/catalog.json");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// 16 new PS numbers (10 fridge + 6 dishwasher) — skip the 4 already in catalog
const NEW_PARTS = [
  // Refrigerator
  "PS12364199", // Water filter
  "PS11701542", // Door shelf bin
  "PS734935",   // Crisper drawer
  "PS11739119", // Crisper drawer with humidity control
  "PS11739091", // Deli drawer
  "PS429868",   // Ice maker
  "PS2358880",  // Door gasket
  "PS429724",   // Water inlet valve
  "PS12585623", // Evaporator fan motor (might be fridge)
  "PS11756720", // Drawer slide rail
  // Dishwasher
  "PS3406971",  // Lower dishrack wheel
  "PS10065979", // Door latch
  "PS11746591", // Spray arm
  "PS11756150", // Door gasket
  "PS11750057", // Upper rack adjuster
  "PS8260087",  // Pump & motor
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function extractText(html, re) {
  return html.match(re)?.[1]?.replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x27;/g,"'").replace(/&#x2019;/g,"'").replace(/&#x2014;/g,"—").replace(/&nbsp;/g," ").trim() ?? null;
}

function cleanText(s) {
  return s?.replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x27;/g,"'").replace(/&#x2019;/g,"'").replace(/&#x2014;/g,"—").replace(/&#xA0;/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim() ?? "";
}

async function scrapePart(psNum) {
  const numericId = psNum.replace(/^PS/i, "");
  const url = `https://www.partselect.com/PS${numericId}-.htm`;

  console.log(`  Fetching ${psNum}...`);
  let html;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { console.log(`  ✗ HTTP ${res.status}`); return null; }
    html = await res.text();
  } catch (e) {
    console.log(`  ✗ fetch error: ${e.message}`);
    return null;
  }

  // ── Core fields ──────────────────────────────────────────────────────────
  const title = extractText(html, /<h1[^>]*>([^<]+)<\/h1>/);
  if (!title) { console.log(`  ✗ no title`); return null; }

  const price = parseFloat(html.match(/data-price="([0-9.]+)"/)?.[1] ?? "0") || null;
  const ratingStr = html.match(/"ratingValue"\s+content="([0-9.]+)"/)?.[1];
  const rating = ratingStr ? parseFloat(ratingStr) : null;
  const reviewCountStr = html.match(/"reviewCount"\s+content="([0-9]+)"/)?.[1];
  const reviewCount = reviewCountStr ? parseInt(reviewCountStr) : null;

  // In-stock: look for "In Stock" text near the availability span
  const stockSection = html.match(/js-partAvailability[\s\S]{0,300}/)?.[0] ?? "";
  const inStock = /in\s*stock/i.test(stockSection) ? true :
                  /out\s*of\s*stock/i.test(stockSection) ? false : true;

  // Ship ETA
  const shipEta = html.match(/Ships[^<"]{5,60}(?:ET|today|business day)/)?.[0]?.trim() ?? null;

  // Description
  const description = extractText(html, /itemprop="description"[^>]*>([\s\S]{20,800}?)<\/div>/);

  // Manufacturer + OEM from title (title format: "Part Title OEMXXX")
  // Also look in the page
  const oemMatch = html.match(/Manufacturer[^<]*Part[^<]*Number[^<]*<[^>]+>\s*([A-Z0-9]{5,20})/i)
    ?? html.match(/OEM[^<]*Part[^<]*(?:Number|#)[^<]*<[^>]+>\s*([A-Z0-9]{5,20})/i);
  const manufacturerPartNumber = oemMatch?.[1]?.trim() ?? null;

  // Manufacturer brand from title or breadcrumb
  const brands = ["Whirlpool","GE","LG","Samsung","Bosch","KitchenAid","Maytag","Frigidaire","Electrolux","Kenmore","Amana","Thermador","Jenn-Air"];
  let manufacturer = null;
  for (const b of brands) {
    if (html.includes(b)) { manufacturer = b; break; }
  }

  // Appliance family from URL path or title
  const applianceFamily =
    /dishwasher/i.test(html.slice(0, 3000) + title) ? "dishwasher" : "refrigerator";

  // Replaces / supersedes
  const replacesSection = html.match(/[Rr]eplaces[^<]*<[^>]+>([\s\S]{0,800}?)<\/(?:div|ul|p)>/)?.[1] ?? "";
  const replaces = [...replacesSection.matchAll(/\b([A-Z]{1,3}[0-9]{5,}[A-Z0-9]*)\b/g)]
    .map(m => m[1]).filter(r => r !== psNum).slice(0, 8);

  // ── Customer reviews ─────────────────────────────────────────────────────
  const repairStories = [];
  const reviewMatches = [...html.matchAll(
    /pd__cust-review__submitted-review[\s\S]{0,2000}?(?=pd__cust-review__submitted-review|<\/section|class="pd__)|$/g
  )].slice(0, 6);

  for (let i = 0; i < reviewMatches.length; i++) {
    const r = reviewMatches[i][0];
    const author = r.match(/<span class="bold">([^<]{2,40})<\/span>\s*-/)?.[1]?.trim();
    const storyTitle = r.match(/<div class="bold">([^<]{3,100})<\/div>/)?.[1]?.trim();
    const body = r.match(/js-searchKeys[^>]*>([\s\S]{10,600}?)<\/div>/)?.[1];
    const helpful = r.match(/([0-9]+)\s*of\s*([0-9]+)/);

    if (body && cleanText(body).length > 10) {
      repairStories.push({
        id: `story-${psNum.toLowerCase()}-${i + 1}`,
        title: storyTitle ?? "Helpful review",
        body: cleanText(body),
        author: author ?? "Verified customer",
        helpfulYes: helpful ? parseInt(helpful[1]) : 0,
        helpfulTotal: helpful ? parseInt(helpful[2]) : 0,
      });
    }
  }

  // ── Keywords & symptoms (infer from title + description) ─────────────────
  const allText = `${title} ${description ?? ""}`.toLowerCase();
  const keywords = title.toLowerCase().split(/\s+/)
    .filter(w => w.length > 3 && !["with","that","this","from","your","will"].includes(w))
    .slice(0, 6);

  // Common symptom patterns
  const symptomMap = {
    "door bin|shelf bin": ["cracked door bin", "broken door shelf", "door bin won't stay in"],
    "water filter": ["water tastes bad", "filter needs replacing", "dirty water", "water flow slow"],
    "ice maker": ["no ice", "ice maker not working", "ice maker stopped", "won't make ice"],
    "drawer": ["drawer won't close", "drawer cracked", "drawer broken", "drawer falls out"],
    "gasket|seal": ["fridge not cooling", "door seal torn", "gasket damaged", "door won't seal"],
    "inlet valve|water valve": ["no water", "water dispenser not working", "water won't fill"],
    "fan|motor": ["fridge not cooling", "loud noise", "fan not spinning", "warm fridge"],
    "latch": ["door won't close", "latch broken", "door latch stuck"],
    "spray arm": ["dishes not clean", "spray arm broken", "poor wash performance"],
    "rack|wheel": ["rack won't roll", "wheels broken", "rack damaged"],
    "pump": ["dishwasher won't drain", "water in bottom", "pump noise"],
    "gasket": ["dishwasher leaking", "door seal worn", "water on floor"],
  };

  const symptoms = [];
  for (const [pattern, syms] of Object.entries(symptomMap)) {
    if (new RegExp(pattern, "i").test(allText)) {
      symptoms.push(...syms);
      break;
    }
  }
  if (symptoms.length === 0) symptoms.push(`${title.toLowerCase()} not working`, `broken ${title.toLowerCase()}`);

  // ── Install steps from description ───────────────────────────────────────
  const installSteps = description
    ? `1) Disconnect power before starting.\n2) ${description.slice(0, 300).replace(/\.\s*/g, ".\n").split("\n").filter(Boolean).slice(0,3).join("\n")}\n3) Reconnect power and test.`
    : `1) Disconnect power.\n2) Remove the old ${title.toLowerCase()} and install the replacement.\n3) Reconnect power and test.`;

  // ── Image & video ─────────────────────────────────────────────────────────
  const imgMatches = [...html.matchAll(/https:\/\/partselectcom-[^"'\s]+\/([0-9]+-1-[LMS]-[^"'\s]+\.jpg)/g)];
  const imageUrl = imgMatches.find(m => /-1-M-/.test(m[0]))?.[0]
    ?? imgMatches.find(m => /-1-L-/.test(m[0]))?.[0]
    ?? imgMatches[0]?.[0] ?? null;

  const ytMatch = html.match(/youtube\.com\/(?:embed\/|watch\?v=|vi\/)([A-Za-z0-9_-]{11})/);
  const videoId = ytMatch?.[1] ?? null;

  const part = {
    id: `part-${psNum.toLowerCase()}`,
    partNumber: psNum,
    title: title.replace(new RegExp(`\\s*${manufacturerPartNumber ?? "XXXXX"}\\s*$`), "").trim(),
    keywords,
    symptoms,
    installSteps,
    applianceFamily,
    price,
    currency: "USD",
    inStock,
    ...(shipEta ? { shipEta } : {}),
    ...(rating ? { rating: Math.round(rating * 10) / 10 } : {}),
    ...(reviewCount ? { reviewCount } : {}),
    ...(manufacturer ? { manufacturer } : {}),
    ...(manufacturerPartNumber ? { manufacturerPartNumber } : {}),
    ...(replaces.length ? { replaces } : {}),
    repairStories,
    ...(imageUrl ? { imageUrl } : {}),
    ...(videoId ? { videoId } : {}),
  };

  console.log(`  ✓ ${psNum}: "${part.title}" | $${price ?? "?"} | ${applianceFamily} | ${repairStories.length} reviews`);
  return part;
}

async function main() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const existingIds = new Set(catalog.parts.map(p => p.partNumber.toUpperCase()));

  const toFetch = NEW_PARTS.filter(ps => !existingIds.has(ps.toUpperCase()));
  console.log(`Scraping ${toFetch.length} new parts (${NEW_PARTS.length - toFetch.length} already in catalog)...\n`);

  const newParts = [];
  for (const ps of toFetch) {
    const part = await scrapePart(ps);
    if (part) newParts.push(part);
    await sleep(1500); // be polite
  }

  catalog.parts = [...catalog.parts, ...newParts];

  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  console.log(`\n✅ Done. catalog.json now has ${catalog.parts.length} parts (added ${newParts.length}).`);
}

main().catch(console.error);
