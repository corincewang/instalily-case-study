import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import catalogFallback from "../data/catalog.json";
import type { CatalogShape } from "./catalogTypes";
import { invalidateRepairGuideCache } from "./catalogDb";
import { prisma } from "./prisma";

/** Prefer `data/data.json` on disk if present, else bundled `catalog.json`. */
export function readCatalogFromDisk(): CatalogShape {
  const dataJson = join(process.cwd(), "data", "data.json");
  if (existsSync(dataJson)) {
    return JSON.parse(readFileSync(dataJson, "utf8")) as CatalogShape;
  }
  return catalogFallback as CatalogShape;
}

/**
 * How retrieval should access catalog data:
 * - `memory`: bundled / disk JSON — fine for demos; linear scans OK.
 * - `database`: indexed Prisma + FULLTEXT — intended for large (e.g. 100k+) part tables.
 */
export type CatalogContext =
  | { mode: "memory"; catalog: CatalogShape }
  | { mode: "database" };

/**
 * Resolve whether this process should use the full in-memory JSON slice or MySQL-backed indexed queries.
 */
export async function resolveCatalogContext(): Promise<CatalogContext> {
  if (!process.env.DATABASE_URL?.trim()) {
    return { mode: "memory", catalog: readCatalogFromDisk() };
  }
  const n = await prisma.catalogPart.count();
  if (n === 0) {
    console.warn(
      "[catalog] DATABASE_URL is set but CatalogPart is empty — using disk JSON. Run: npx prisma db seed"
    );
    return { mode: "memory", catalog: readCatalogFromDisk() };
  }
  return { mode: "database" };
}

/**
 * Load the bundled/disk demo catalog (always JSON — never full-table DB reads).
 * Prefer {@link resolveCatalogContext} for chat/agent paths.
 */
export async function loadCatalog(): Promise<CatalogShape> {
  return readCatalogFromDisk();
}

/** Call after seed or admin imports so cached repair-guide rows reload on next access. */
export function invalidateCatalogCache(): void {
  invalidateRepairGuideCache();
}
