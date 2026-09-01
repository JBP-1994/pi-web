const STORAGE_KEY = "pi-web:project-visibility";

export type VisibilityEntry = { deletedAt: string };
export type VisibilityMap = Record<string, VisibilityEntry>;

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

export function loadVisibilityMap(): Map<string, VisibilityEntry> {
  const storage = getStorage();
  if (!storage) return new Map();
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const map = new Map<string, VisibilityEntry>();
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = v as { deletedAt?: unknown };
      if (typeof k !== "string" || typeof entry?.deletedAt !== "string") continue;
      map.set(k, { deletedAt: entry.deletedAt });
    }
    return map;
  } catch { return new Map(); }
}

export function saveVisibilityMap(map: Map<string, VisibilityEntry>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (map.size === 0) { storage.removeItem(STORAGE_KEY); return; }
    const obj: VisibilityMap = {};
    for (const [k, v] of map) obj[k] = v;
    storage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {}
}

export function isProjectDeleted(key: string, map: ReadonlyMap<string, VisibilityEntry>): boolean {
  return map.has(key);
}

export function setProjectDeleted(key: string, deleted: boolean, map: Map<string, VisibilityEntry>): Map<string, VisibilityEntry> {
  const next = new Map(map);
  if (deleted) next.set(key, { deletedAt: new Date().toISOString() });
  else next.delete(key);
  saveVisibilityMap(next);
  return next;
}
