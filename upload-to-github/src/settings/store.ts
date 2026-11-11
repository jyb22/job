import type { DB } from "../db";
import { clock, AppError } from "../core/util";
import { settingsSchema, type Settings } from "./schema";

const KEY = "app";

/** Deep-merge plain objects; arrays and scalars in `patch` replace the base value. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  if (base === null || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export class SettingsStore {
  private cache: Settings | null = null;

  constructor(private db: DB) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    // Parsing fills in defaults for any field added since the settings were last saved.
    this.cache = settingsSchema.parse(row ? JSON.parse(row.value) : {});
    return this.cache;
  }

  /** Validate and persist a partial update. Returns the new settings. */
  update(patch: unknown, updatedBy: string): Settings {
    const merged = deepMerge(this.get(), patch);
    const parsed = settingsSchema.safeParse(merged);
    if (!parsed.success) {
      throw new AppError("invalid_settings", "Settings are not valid", 400, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    const next = parsed.data;
    if (next.automation.mode === "full_autonomous" && !next.automation.fullAutonomyAcknowledgedAt) {
      throw new AppError("full_autonomy_not_acknowledged", "Full autonomous mode must be explicitly activated by an owner (acknowledge the boundaries first).", 400);
    }
    this.db
      .prepare("INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by")
      .run(KEY, JSON.stringify(next), clock.iso(), updatedBy);
    this.cache = next;
    return next;
  }

  invalidate(): void {
    this.cache = null;
  }
}
