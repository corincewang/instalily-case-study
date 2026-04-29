/**
 * Seed MySQL from JSON and/or repo `data/all_parts.csv` + `data/all_repairs.csv`.
 *
 * Priority:
 *   1. CATALOG_SEED_PATH → full catalog JSON (parts + compat + guides)
 *   2. Else if ALL_PARTS_CSV / `data/all_parts.csv` → parts from CSV;
 *      compat from `web/data/catalog.json` when present.
 *      Repair guides: `data/all_repairs.csv` if present, else demo JSON guides.
 *      SEED_SKIP_CSV=1 skips parts CSV. SEED_SKIP_REPAIR_CSV=1 keeps JSON guides only.
 *   3. Else `web/data/data.json` / `web/data/catalog.json`
 *
 * Run from `web/`: npx prisma db seed
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { PrismaClient } from "@prisma/client";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repo `data/` (sibling of `web/`) */
const REPO_DATA = join(__dirname, "../../data");

function loadDotEnvFile(relPath) {
  const envPath = join(__dirname, relPath);
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnvFile("../.env");

if (!process.env.DATABASE_URL?.trim()) {
  console.error(
    "DATABASE_URL is missing. Add it to web/.env (e.g. mysql://root@127.0.0.1:3306/partselect_db)"
  );
  process.exit(1);
}

const prisma = new PrismaClient();

function resolveCatalogJsonPath() {
  const fromEnv = process.env.CATALOG_SEED_PATH?.trim();
  if (fromEnv) {
    const abs = join(process.cwd(), fromEnv);
    if (existsSync(fromEnv)) return fromEnv;
    if (existsSync(abs)) return abs;
    console.error(`CATALOG_SEED_PATH set but file not found: ${fromEnv}`);
    process.exit(1);
  }
  const dataJson = join(__dirname, "../data/data.json");
  const catalogJson = join(__dirname, "../data/catalog.json");
  if (existsSync(dataJson)) return dataJson;
  return catalogJson;
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== "object") {
    console.error("JSON root must be an object with optional keys: parts, compatibilities, repairGuides");
    process.exit(1);
  }
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  const compatibilities = Array.isArray(raw.compatibilities) ? raw.compatibilities : [];
  const repairGuides = Array.isArray(raw.repairGuides) ? raw.repairGuides : [];
  return { parts, compatibilities, repairGuides };
}

function resolveAllPartsCsvPath() {
  if (process.env.SEED_SKIP_CSV === "1" || process.env.SEED_SKIP_CSV === "true") {
    return null;
  }
  const fromEnv = process.env.ALL_PARTS_CSV?.trim();
  const candidates = [];
  if (fromEnv) {
    candidates.push(fromEnv, join(process.cwd(), fromEnv), join(REPO_DATA, fromEnv));
  }
  candidates.push(join(REPO_DATA, "all_parts.csv"));
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function resolveAllRepairsCsvPath() {
  if (process.env.SEED_SKIP_REPAIR_CSV === "1" || process.env.SEED_SKIP_REPAIR_CSV === "true") {
    return null;
  }
  const fromEnv = process.env.ALL_REPAIRS_CSV?.trim();
  const candidates = [];
  if (fromEnv) {
    candidates.push(fromEnv, join(process.cwd(), fromEnv), join(REPO_DATA, fromEnv));
  }
  candidates.push(join(REPO_DATA, "all_repairs.csv"));
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function mapApplianceFamily(applianceTypes) {
  const t = (applianceTypes || "").toLowerCase();
  if (t.includes("refrigerator") || t.includes("fridge") || t.includes("freezer")) {
    return "refrigerator";
  }
  if (t.includes("dishwasher")) return "dishwasher";
  return "dishwasher";
}

function parseSymptoms(s) {
  if (!s || !String(s).trim()) return [];
  return String(s)
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseReplaces(s) {
  if (!s || !String(s).trim()) return [];
  let cleaned = String(s)
    .replace(/\s*\.\.\.\s*Show more\s*$/gi, "")
    .trim();
  return cleaned
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function titleKeywords(title) {
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 16);
}

function csvRowToPart(row) {
  const partNumber = String(row.part_id ?? "")
    .trim()
    .toUpperCase();
  if (!partNumber) return null;

  const mpn = String(row.mpn_id ?? "").trim();
  const id = `part-${partNumber.toLowerCase()}`;
  const rawPrice = parseFloat(String(row.part_price ?? "").replace(/[^\d.]/g, ""));
  const price = Number.isFinite(rawPrice) ? rawPrice : undefined;
  const avail = String(row.availability ?? "").trim();
  const inStock = /in stock/i.test(avail);

  const difficulty = String(row.install_difficulty ?? "").trim();
  const time = String(row.install_time ?? "").trim();
  const installSteps = [difficulty, time].filter(Boolean).join(" — ");

  const part = {
    id,
    partNumber,
    title: String(row.part_name ?? partNumber).trim() || partNumber,
    keywords: titleKeywords(row.part_name),
    symptoms: parseSymptoms(row.symptoms),
    installSteps: installSteps || "See product page for installation notes.",
    applianceFamily: mapApplianceFamily(row.appliance_types),
    price,
    currency: "USD",
    inStock,
    shipEta: avail || undefined,
    manufacturer: String(row.brand ?? "").trim() || undefined,
    manufacturerPartNumber: mpn || undefined,
    replaces: parseReplaces(row.replace_parts),
  };

  const productUrl = String(row.product_url ?? "").trim();
  const videoUrl = String(row.install_video_url ?? "").trim();
  if (productUrl) part.productUrl = productUrl;
  if (videoUrl) part.installVideoUrl = videoUrl;

  return part;
}

function loadPartsFromCsv(csvPath) {
  const buf = readFileSync(csvPath, "utf8");
  const rows = parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  });

  const byPs = new Map();
  for (const row of rows) {
    const p = csvRowToPart(row);
    if (p) byPs.set(p.partNumber, p);
  }
  return Array.from(byPs.values());
}

function productColumnToAppliance(product) {
  const t = String(product ?? "").toLowerCase();
  if (t.includes("refrigerator") || t.includes("fridge")) return "refrigerator";
  return "dishwasher";
}

function descriptionToSteps(description) {
  const raw = String(description ?? "").trim();
  if (!raw) return ["See the repair overview on PartSelect for step-by-step help."];
  const chunks = raw
    .split(/\.\s+/)
    .map((s) => s.trim().replace(/\.$/, ""))
    .filter((s) => s.length > 8);
  return chunks.length > 0 ? chunks : [raw];
}

/** Symptom + appliance → retrieveExact `matchFlexible` OR-groups (≥2 groups). */
function repairMatchFlexible(symptom, appliance) {
  const lc = String(symptom ?? "")
    .toLowerCase()
    .trim();
  const terms = new Set([lc]);

  const add = (xs) => {
    for (const x of xs) if (x && x.length > 1) terms.add(x.toLowerCase());
  };

  if (/noisy|noise|loud|rattle/i.test(symptom)) {
    add(["noisy", "noise", "loud", "rattling", "rattles", "making noise"]);
  }
  if (/leak|drip|wet/i.test(symptom)) {
    add(["leaking", "leak", "dripping", "puddle", "water on floor"]);
  }
  if (/will not start|won'?t start|not starting|no power|dead/i.test(symptom)) {
    add([
      "will not start",
      "won't start",
      "wont start",
      "not starting",
      "doesn't start",
      "does not start",
      "no power",
      "won't turn on",
    ]);
  }
  if (/not clean|dirty dish|won'?t clean/i.test(symptom)) {
    add([
      "not cleaning",
      "not clean",
      "won't clean",
      "doesn't clean",
      "dishes dirty",
      "poor wash",
    ]);
  }
  if (/not drain|standing water|won'?t drain/i.test(symptom)) {
    add(["not draining", "won't drain", "wont drain", "standing water", "water in bottom"]);
  }
  if (/fill with water|will not fill|not fill/i.test(symptom)) {
    add(["not filling", "won't fill", "no water", "will not fill"]);
  }
  if (/detergent|dispense soap/i.test(symptom)) {
    add(["detergent", "soap", "dispense", "not dispensing detergent"]);
  }
  if (/dry|not drying/i.test(symptom)) {
    add(["not drying", "won't dry", "still wet", "dishes wet"]);
  }
  if (/ice maker|not making ice|no ice/i.test(symptom)) {
    add([
      "ice maker",
      "icemaker",
      "ice-maker",
      "no ice",
      "not making ice",
      "stopped making ice",
    ]);
  }
  if (/water dispenser|dispensing water/i.test(symptom)) {
    add([
      "water dispenser",
      "dispenser",
      "not dispensing water",
      "no water from dispenser",
    ]);
  }
  if (/too warm|warm fridge|not cold/i.test(symptom)) {
    add(["too warm", "not cold enough", "warm fridge", "fridge warm"]);
  }
  if (/too cold|freezing food/i.test(symptom)) {
    add(["too cold", "freezing", "everything frozen"]);
  }
  if (/door latch|won'?t close|door won/i.test(symptom)) {
    add(["door latch", "won't close", "door won't", "latch"]);
  }
  if (/light not|won'?t turn on.*light/i.test(symptom)) {
    add(["light not", "light won't", "no light", "bulb"]);
  }
  if (/sweat|condensation/i.test(symptom)) {
    add(["sweating", "condensation", "sweat"]);
  }
  if (/runs too long|constantly running/i.test(symptom)) {
    add(["runs too long", "running constantly", "won't stop running"]);
  }

  if (terms.size < 3) {
    for (const w of lc.split(/\s+/)) {
      if (w.length > 3) terms.add(w);
    }
  }

  const group1 = Array.from(terms);
  const group2 =
    appliance === "dishwasher"
      ? ["dishwasher", "dish washer"]
      : ["refrigerator", "fridge", "freezer"];

  return [group1, group2];
}

/** Strict AND phrases: appliance token + symptom line (literal PartSelect-style). */
function repairMatchIncludesAll(symptom, appliance) {
  const appToken = appliance === "dishwasher" ? "dishwasher" : "refrigerator";
  return [appToken, String(symptom ?? "").toLowerCase().trim()].filter(Boolean);
}

function slugPart(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
}

function csvRowToRepairGuide(row, index) {
  const product = String(row.Product ?? "").trim();
  const symptom = String(row.symptom ?? "").trim();
  if (!symptom || !product) return null;

  const appliance = productColumnToAppliance(product);
  const id = `guide-${slugPart(product)}-${slugPart(symptom)}-${index}`;
  const difficulty = String(row.difficulty ?? "").trim();
  const pct = String(row.percentage ?? "").trim();
  const partsHint = String(row.parts ?? "").trim();
  const url = String(row.symptom_detail_url ?? "").trim();
  const video = String(row.repair_video_url ?? "").trim();

  const headerBits = [difficulty && `Difficulty: ${difficulty}`, pct && `Common: ${pct}%`].filter(
    Boolean
  );
  const steps = [...headerBits, ...descriptionToSteps(row.description)];

  const guide = {
    id,
    brand: "Various",
    appliance,
    topic: symptom,
    steps,
    matchIncludesAll: repairMatchIncludesAll(symptom, appliance),
    matchFlexible: repairMatchFlexible(symptom, appliance),
    likelyParts: [],
    commonQuestions: [],
  };

  if (partsHint) guide.partsMentioned = partsHint;
  if (url) guide.symptomDetailUrl = url;
  if (video) guide.repairVideoUrl = video;

  return guide;
}

function loadRepairsFromCsv(csvPath) {
  const buf = readFileSync(csvPath, "utf8");
  const rows = parse(buf, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    trim: true,
  });
  const out = [];
  let i = 0;
  for (const row of rows) {
    const g = csvRowToRepairGuide(row, i);
    if (g) out.push(g);
    i += 1;
  }
  return out;
}

function loadDemoCompatGuides() {
  const p = join(__dirname, "../data/catalog.json");
  if (!existsSync(p)) return { compatibilities: [], repairGuides: [] };
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return {
    compatibilities: Array.isArray(raw.compatibilities) ? raw.compatibilities : [],
    repairGuides: Array.isArray(raw.repairGuides) ? raw.repairGuides : [],
  };
}

/** Prefer `all_repairs.csv` when present; else `demoRepairGuides` from JSON. */
function resolveRepairGuides(demoRepairGuides) {
  const csvPath = resolveAllRepairsCsvPath();
  if (csvPath) {
    const guides = loadRepairsFromCsv(csvPath);
    console.log(`Repair guides CSV: ${csvPath} → ${guides.length} guides`);
    return guides;
  }
  return demoRepairGuides;
}

function resolveCatalogToSeed() {
  if (process.env.CATALOG_SEED_PATH?.trim()) {
    const catalogPath = resolveCatalogJsonPath();
    console.log(`Using full catalog JSON: ${catalogPath}`);
    const c = normalizeCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
    c.repairGuides = resolveRepairGuides(c.repairGuides);
    return c;
  }

  const csvPath = resolveAllPartsCsvPath();
  if (csvPath) {
    console.log(`Using parts CSV: ${csvPath}`);
    const parts = loadPartsFromCsv(csvPath);
    const { compatibilities, repairGuides: demoGuides } = loadDemoCompatGuides();
    const repairGuides = resolveRepairGuides(demoGuides);
    console.log(
      `CSV → ${parts.length} unique parts; demo compat=${compatibilities.length}; repair guides=${repairGuides.length}`
    );
    return { parts, compatibilities, repairGuides };
  }

  const catalogPath = resolveCatalogJsonPath();
  console.log(`Using catalog JSON: ${catalogPath}`);
  const c = normalizeCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
  c.repairGuides = resolveRepairGuides(c.repairGuides);
  return c;
}

const catalog = resolveCatalogToSeed();

function normalizeCollapse(s) {
  return String(s ?? "")
    .replace(/[\s._\-]/g, "")
    .toUpperCase();
}

function buildSearchDocFromPart(p) {
  const keywords = Array.isArray(p.keywords) ? p.keywords.join(" ") : "";
  const symptoms = Array.isArray(p.symptoms) ? p.symptoms.join(" ") : "";
  const mpn = p.manufacturerPartNumber ? String(p.manufacturerPartNumber).trim() : "";
  return [p.title, p.partNumber, mpn, p.applianceFamily || "", keywords, symptoms].filter(Boolean).join("\n");
}

async function main() {
  for (const p of catalog.parts) {
    const pn = String(p.partNumber).trim().toUpperCase();
    const mpnRaw = p.manufacturerPartNumber ? String(p.manufacturerPartNumber).trim() : "";
    const mpn = mpnRaw ? mpnRaw.toUpperCase() : null;
    const applianceFamily = p.applianceFamily ? String(p.applianceFamily) : "refrigerator";
    const searchDocument = buildSearchDocFromPart(p);

    await prisma.catalogPart.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        partNumber: pn,
        manufacturerPartNumber: mpn,
        applianceFamily,
        searchDocument,
        data: p,
      },
      update: {
        partNumber: pn,
        manufacturerPartNumber: mpn,
        applianceFamily,
        searchDocument,
        data: p,
      },
    });

    await prisma.catalogPartReplace.deleteMany({ where: { partId: p.id } });
    const replaces = Array.isArray(p.replaces) ? p.replaces : [];
    let ridx = 0;
    for (const old of replaces) {
      if (typeof old !== "string") continue;
      const oc = normalizeCollapse(old);
      if (oc.length < 5) continue;
      const rid = `${p.id}-r-${ridx}-${oc}`.slice(0, 191);
      ridx += 1;
      await prisma.catalogPartReplace.create({
        data: {
          id: rid,
          oldNumberNormalized: oc,
          partId: p.id,
        },
      });
    }
  }
  for (const row of catalog.compatibilities) {
    const partNumber = String(row.partNumber).trim().toUpperCase();
    const modelNormalized = normalizeCollapse(row.model);
    await prisma.catalogCompatibility.upsert({
      where: { id: row.id },
      create: { id: row.id, partNumber, modelNormalized, data: row },
      update: { partNumber, modelNormalized, data: row },
    });
  }
  for (const g of catalog.repairGuides) {
    await prisma.catalogRepairGuide.upsert({
      where: { id: g.id },
      create: { id: g.id, data: g },
      update: { data: g },
    });
  }

  const [nPart, nCompat, nGuide] = await Promise.all([
    prisma.catalogPart.count(),
    prisma.catalogCompatibility.count(),
    prisma.catalogRepairGuide.count(),
  ]);

  console.log(
    `Seeded ${catalog.parts.length} parts, ${catalog.compatibilities.length} compat rows, ${catalog.repairGuides.length} guides.`
  );
  console.log(
    `Verified in DB: CatalogPart=${nPart}, CatalogCompatibility=${nCompat}, CatalogRepairGuide=${nGuide}`
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    void prisma.$disconnect();
    process.exit(1);
  });
