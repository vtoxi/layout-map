/**
 * Lazy furniture catalog — file DB under ./catalog/
 * Loads index/meta once, category JSON only when needed.
 */

const BASE = new URL("./catalog/", import.meta.url);

const FALLBACK = {
  id: "cabinet",
  label: "Kitchen cabinet",
  cat: "Storage",
  widthMm: 900,
  depthMm: 600,
  heightMm: 900,
  color: "#a89070",
  hasDoors: true,
  isCabinet: true,
};

let indexPromise = null;
let metaPromise = null;
let indexData = null;
let metaData = null;

/** @type {Map<string, object>} */
const itemCache = new Map();
/** @type {Map<string, Promise<object>>} */
const categoryPromises = new Map();
/** @type {Set<string>} */
const loadedCategories = new Set();

function catalogUrl(rel) {
  return new URL(rel, BASE).href;
}

async function fetchJson(rel) {
  const res = await fetch(catalogUrl(rel), { cache: "force-cache" });
  if (!res.ok) throw new Error(`Catalog fetch failed: ${rel} (${res.status})`);
  return res.json();
}

export async function ensureIndex() {
  if (indexData) return indexData;
  if (!indexPromise) {
    indexPromise = fetchJson("index.json")
      .then((data) => {
        indexData = data;
        return data;
      })
      .catch((err) => {
        indexPromise = null;
        throw err;
      });
  }
  return indexPromise;
}

export async function ensureMeta() {
  if (metaData) return metaData;
  if (!metaPromise) {
    metaPromise = fetchJson("meta.json")
      .then((data) => {
        metaData = data;
        return data;
      })
      .catch((err) => {
        metaPromise = null;
        throw err;
      });
  }
  return metaPromise;
}

function slugForCategory(catIdOrLabel) {
  const cats = indexData?.categories || [];
  const hit = cats.find(
    (c) => c.id === catIdOrLabel || c.label === catIdOrLabel || c.slug === catIdOrLabel,
  );
  return hit?.slug || String(catIdOrLabel || "").toLowerCase().replace(/\s+/g, "-");
}

export async function loadCategory(catIdOrLabel) {
  await ensureIndex();
  const slug = slugForCategory(catIdOrLabel);
  if (loadedCategories.has(slug) && categoryPromises.has(slug)) {
    return categoryPromises.get(slug);
  }
  if (categoryPromises.has(slug)) return categoryPromises.get(slug);

  const p = fetchJson(`categories/${slug}.json`)
    .then((data) => {
      for (const it of data.items || []) {
        itemCache.set(it.id, it);
      }
      loadedCategories.add(slug);
      return data;
    })
    .catch((err) => {
      categoryPromises.delete(slug);
      throw err;
    });
  categoryPromises.set(slug, p);
  return p;
}

export function listCategories() {
  return indexData?.categories ? [...indexData.categories] : [];
}

export function listStubs() {
  return indexData?.items ? [...indexData.items] : [];
}

export function searchItems(query) {
  const q = String(query || "").trim().toLowerCase();
  const stubs = listStubs();
  if (!q) return stubs;
  return stubs.filter(
    (s) => s.label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || String(s.cat || "").toLowerCase().includes(q),
  );
}

export function getItem(id) {
  if (id && itemCache.has(id)) return itemCache.get(id);
  const stub = (indexData?.items || []).find((s) => s.id === id);
  if (stub) {
    return {
      ...FALLBACK,
      id: stub.id,
      label: stub.label,
      cat: stub.cat,
    };
  }
  return { ...FALLBACK, id: id || FALLBACK.id, label: id || FALLBACK.label };
}

export function hasCachedItem(id) {
  return itemCache.has(id);
}

export function isCategoryLoaded(catIdOrLabel) {
  if (!indexData) return false;
  return loadedCategories.has(slugForCategory(catIdOrLabel));
}

export function getLoadedItems(catLabel = null) {
  const all = [...itemCache.values()];
  if (!catLabel) return all;
  return all.filter((t) => t.cat === catLabel);
}

export async function ensureItem(id) {
  if (itemCache.has(id)) return itemCache.get(id);
  await ensureIndex();
  const stub = (indexData.items || []).find((s) => s.id === id);
  if (stub) await loadCategory(stub.slug || stub.cat);
  return getItem(id);
}

export async function ensureItems(ids) {
  await ensureIndex();
  const need = new Set();
  for (const id of ids || []) {
    if (itemCache.has(id)) continue;
    const stub = (indexData.items || []).find((s) => s.id === id);
    if (stub) need.add(stub.slug || slugForCategory(stub.cat));
  }
  await Promise.all([...need].map((slug) => loadCategory(slug)));
  return (ids || []).map((id) => getItem(id));
}

export function getColors() {
  return metaData?.colors ? [...metaData.colors] : [];
}

export function getCurtainStyles() {
  return metaData?.curtainStyles ? [...metaData.curtainStyles] : [];
}

export function getFoldModes() {
  return metaData?.foldModes ? [...metaData.foldModes] : [];
}

export async function prefetchForFurnish(preferredCat = null) {
  await Promise.all([ensureIndex(), ensureMeta()]);
  const cats = listCategories();
  const first = preferredCat
    || cats.find((c) => c.label === preferredCat)?.label
    || cats[0]?.label
    || cats[0]?.id;
  if (first) await loadCategory(first);
  return { index: indexData, meta: metaData };
}

export function getFallback() {
  return { ...FALLBACK };
}
