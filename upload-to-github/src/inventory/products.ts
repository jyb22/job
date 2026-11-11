import path from "node:path";
import type { Ctx } from "../context";
import { writeTx } from "../db";
import { CONDITIONS, parseJson, type Actor, type AttributeValue, type Condition, type ImageRow, type ProductRow, type ProductStatus, type StageStatus, type WorkflowStage } from "../core/types";
import { AppError, clock, newId } from "../core/util";
import { hammingDistance, missingViews, storeImage } from "../images/process";
import type { Identification } from "../ai/provider";
import { needsSize, normaliseDepartment, normaliseProductType } from "../marketplaces/specs";
import { cleanLine, cleanText, looksLikeInstruction } from "../security/sanitize";

export interface ProductInput {
  title?: string | null;
  brand?: string | null;
  model?: string | null;
  category?: string | null;
  department?: string | null;
  size?: string | null;
  color?: string | null;
  material?: string | null;
  condition?: string | null;
  condition_notes?: string | null;
  style_number?: string | null;
  upc?: string | null;
  notes?: string | null;
  storage_location?: string | null;
  acquisition_cost_cents?: number | null;
  extra_cost_cents?: number;
  min_price_cents?: number | null;
  quantity?: number;
  /** Free-form operator attributes, e.g. measurements or marketplace-specific ids. */
  attributes?: Record<string, string>;
}

const TEXT_FIELDS = ["title", "brand", "model", "category", "department", "size", "color", "material", "condition", "condition_notes", "style_number", "upc", "notes", "storage_location"] as const;
type TextField = (typeof TEXT_FIELDS)[number];
/** Fields whose provenance (seen / inferred / operator-confirmed) is tracked. */
const TRACKED: TextField[] = ["brand", "model", "category", "department", "size", "color", "material", "condition", "style_number"];

export function normaliseCondition(text: string | null | undefined): Condition | null {
  const t = (text ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (!t) return null;
  if ((CONDITIONS as readonly string[]).includes(t)) return t as Condition;
  if (/nwt|new_with_tag|brand_new/.test(t)) return "new_with_tags";
  if (/nwot|new_without|^new$/.test(t)) return "new_without_tags";
  if (/like_new|mint/.test(t)) return "like_new";
  if (/excellent|very_good|euc|vguc/.test(t)) return "excellent";
  if (/good|guc|pre_?owned|used/.test(t)) return "good";
  if (/fair|acceptable|worn/.test(t)) return "fair";
  if (/poor|parts|damaged/.test(t)) return "poor";
  return null;
}

export interface DuplicateMatch {
  productId: string;
  sku: string;
  kind: "exact" | "near";
  distance: number;
}

export class ProductService {
  constructor(private ctx: Ctx) {}

  private get db() {
    return this.ctx.db;
  }

  // ---- identity ---------------------------------------------------------------
  /** Allocate the next SKU. Sequential, never reused, independent of what the item turns out to be. */
  private nextSku(): string {
    const row = this.db.prepare("UPDATE sku_counter SET value = value + 1 WHERE id = 1 RETURNING value").get() as { value: number };
    const now = clock.now();
    const yymm = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    return `RS-${yymm}-${String(row.value).padStart(6, "0")}`;
  }

  create(input: ProductInput, actor: Actor, source: string): ProductRow {
    return writeTx(this.db, () => {
      const id = newId("prd");
      const sku = this.nextSku();
      const now = clock.iso();
      const fields = this.cleanInput(input);
      const basis = source === "import" ? "import" : "operator";
      const attributes: Record<string, AttributeValue> = {};
      for (const f of TRACKED) if (fields[f]) attributes[f] = { value: fields[f]!, basis, confidence: 1 };
      for (const [k, v] of Object.entries(input.attributes ?? {})) attributes[cleanLine(k, 60)] = { value: cleanLine(v, 300), basis, confidence: 1 };
      const quantity = Math.max(1, Math.floor(input.quantity ?? 1));
      this.db
        .prepare(
          `INSERT INTO products (id, sku, status, title, brand, model, category, department, size, color, material, condition, condition_notes, style_number, upc, notes,
             attributes, acquisition_cost_cents, extra_cost_cents, min_price_cents, storage_location, quantity_available, source, created_at, updated_at)
           VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, sku, fields.title, fields.brand, fields.model, fields.category, fields.department, fields.size, fields.color, fields.material, fields.condition,
          fields.condition_notes, fields.style_number, fields.upc, fields.notes, JSON.stringify(attributes), input.acquisition_cost_cents ?? null,
          input.extra_cost_cents ?? 0, input.min_price_cents ?? null, fields.storage_location, quantity, source, now, now,
        );
      this.db.prepare("INSERT INTO inventory_movements (id, product_id, kind, delta_available, ref, at) VALUES (?, ?, 'intake', ?, ?, ?)").run(newId("mov"), id, quantity, source, now);
      this.setStage(id, "ingestion", "done", { source });
      this.ctx.audit.record({ actor, action: "product.created", entityType: "product", entityId: id, productId: id, detail: { sku, source } });
      return this.get(id);
    });
  }

  private cleanInput(input: ProductInput): Record<TextField, string | null> {
    const out = {} as Record<TextField, string | null>;
    for (const f of TEXT_FIELDS) {
      const raw = input[f];
      if (raw === undefined || raw === null || raw === "") { out[f] = null; continue; }
      out[f] = f === "notes" || f === "condition_notes" ? cleanText(raw, 2000) : cleanLine(raw, 200);
    }
    if (out.condition) out.condition = normaliseCondition(out.condition);
    if (out.category) out.category = normaliseProductType(out.category) === "other" ? out.category.toLowerCase() : normaliseProductType(out.category);
    if (out.department) out.department = normaliseDepartment(out.department);
    return out;
  }

  get(id: string): ProductRow {
    const row = this.db.prepare("SELECT * FROM products WHERE id = ? OR sku = ?").get(id, id) as ProductRow | undefined;
    if (!row) throw new AppError("not_found", "Product not found", 404);
    return row;
  }

  find(idOrSku: string): ProductRow | undefined {
    return this.db.prepare("SELECT * FROM products WHERE id = ? OR sku = ?").get(idOrSku, idOrSku) as ProductRow | undefined;
  }

  list(filter: { status?: string; q?: string; limit?: number; includeArchived?: boolean } = {}): ProductRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) { where.push("status = ?"); args.push(filter.status); }
    else if (!filter.includeArchived) where.push("status != 'archived'");
    if (filter.q) {
      where.push("(sku LIKE ? OR title LIKE ? OR brand LIKE ? OR model LIKE ?)");
      const like = `%${filter.q}%`;
      args.push(like, like, like, like);
    }
    return this.db.prepare(`SELECT * FROM products ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`).all(...args, Math.min(filter.limit ?? 200, 1000)) as ProductRow[];
  }

  images(productId: string): ImageRow[] {
    return this.db.prepare("SELECT * FROM product_images WHERE product_id = ? ORDER BY position").all(productId) as ImageRow[];
  }

  // ---- photos -----------------------------------------------------------------
  dirFor(productId: string): string {
    return path.join(this.ctx.dataDir, "images", productId);
  }

  /** Has this exact photo (or a near-identical one) already been uploaded for another product? */
  findDuplicate(sha256: string, phash: string, excludeProductId?: string): DuplicateMatch | null {
    const exact = this.db
      .prepare("SELECT p.id, p.sku FROM product_images i JOIN products p ON p.id = i.product_id WHERE i.sha256 = ? AND p.status != 'archived' AND p.id != ? LIMIT 1")
      .get(sha256, excludeProductId ?? "") as { id: string; sku: string } | undefined;
    if (exact) return { productId: exact.id, sku: exact.sku, kind: "exact", distance: 0 };
    const threshold = this.ctx.settings.get().images.duplicateHashDistance;
    const rows = this.db
      .prepare("SELECT i.phash, p.id, p.sku FROM product_images i JOIN products p ON p.id = i.product_id WHERE i.phash IS NOT NULL AND p.status != 'archived' AND p.id != ?")
      .all(excludeProductId ?? "") as { phash: string; id: string; sku: string }[];
    let best: DuplicateMatch | null = null;
    for (const r of rows) {
      const d = hammingDistance(phash, r.phash);
      if (d <= threshold && (!best || d < best.distance)) best = { productId: r.id, sku: r.sku, kind: "near", distance: d };
    }
    return best;
  }

  /** Store one photo on a product. The same file uploaded twice to one product is stored once. */
  async addImage(productId: string, buffer: Buffer, actor: Actor): Promise<{ image: ImageRow; added: boolean }> {
    const settings = this.ctx.settings.get().images;
    const id = newId("img");
    const stored = await storeImage(buffer, this.dirFor(productId), id, settings);
    const existing = this.db.prepare("SELECT * FROM product_images WHERE product_id = ? AND sha256 = ?").get(productId, stored.sha256) as ImageRow | undefined;
    if (existing) return { image: existing, added: false };
    const position = (this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM product_images WHERE product_id = ?").get(productId) as { p: number }).p;
    this.db
      .prepare("INSERT INTO product_images (id, product_id, position, original_path, optimized_path, sha256, phash, width, height, bytes, blur_score, quality, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, productId, position, stored.originalPath, stored.optimizedPath, stored.sha256, stored.phash, stored.width, stored.height, stored.bytes, stored.blurScore, JSON.stringify({ issues: stored.issues, brightness: stored.brightness }), clock.iso());
    this.ctx.audit.record({ actor, action: "image.added", entityType: "image", entityId: id, productId, detail: { issues: stored.issues, width: stored.width, height: stored.height } });
    return { image: this.db.prepare("SELECT * FROM product_images WHERE id = ?").get(id) as ImageRow, added: true };
  }

  reorderImages(productId: string, orderedIds: string[]): void {
    writeTx(this.db, () => {
      orderedIds.forEach((id, i) => this.db.prepare("UPDATE product_images SET position = ? WHERE id = ? AND product_id = ?").run(i, id, productId));
    });
  }

  suggestedPhotos(productId: string): string[] {
    const images = this.images(productId);
    return missingViews(images.map((i) => i.view_label), images.length);
  }

  // ---- edits ------------------------------------------------------------------
  /** Operator edit. Anything the operator sets is recorded as operator-confirmed (confidence 1). */
  update(id: string, patch: ProductInput, actor: Actor): ProductRow {
    return writeTx(this.db, () => {
      const before = this.get(id);
      const fields = this.cleanInput(patch);
      const attributes = parseJson<Record<string, AttributeValue>>(before.attributes, {});
      const sets: string[] = [];
      const args: unknown[] = [];
      const changed: Record<string, { from: unknown; to: unknown }> = {};
      for (const f of TEXT_FIELDS) {
        if (!(f in patch)) continue;
        sets.push(`${f} = ?`);
        args.push(fields[f]);
        if (before[f] !== fields[f]) changed[f] = { from: before[f], to: fields[f] };
        if (TRACKED.includes(f)) {
          if (fields[f]) attributes[f] = { value: fields[f]!, basis: "operator", confidence: 1 };
          else delete attributes[f];
        }
      }
      for (const f of ["acquisition_cost_cents", "extra_cost_cents", "min_price_cents"] as const) {
        if (!(f in patch)) continue;
        sets.push(`${f} = ?`);
        args.push(patch[f] ?? (f === "extra_cost_cents" ? 0 : null));
        if (before[f] !== patch[f]) changed[f] = { from: before[f], to: patch[f] };
      }
      for (const [k, v] of Object.entries(patch.attributes ?? {})) {
        const key = cleanLine(k, 60);
        if (v === "" || v === null) delete attributes[key];
        else attributes[key] = { value: cleanLine(v, 300), basis: "operator", confidence: 1 };
      }
      sets.push("attributes = ?", "version = version + 1", "updated_at = ?");
      args.push(JSON.stringify(attributes), clock.iso());
      this.db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).run(...args, before.id);
      this.ctx.audit.record({ actor, action: "product.updated", entityType: "product", entityId: before.id, productId: before.id, detail: { changed } });
      this.refreshRisk(before.id);
      return this.get(before.id);
    });
  }

  /** The operator has checked the item against the record: every tracked attribute becomes operator-confirmed. */
  confirmIdentification(id: string, actor: Actor): ProductRow {
    const product = this.get(id);
    const attributes = parseJson<Record<string, AttributeValue>>(product.attributes, {});
    for (const f of TRACKED) if (product[f]) attributes[f] = { value: String(product[f]), basis: "operator", confidence: 1 };
    this.db.prepare("UPDATE products SET attributes = ?, identification_confidence = 1, version = version + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(attributes), clock.iso(), product.id);
    this.ctx.audit.record({ actor, action: "product.identification_confirmed", entityType: "product", entityId: product.id, productId: product.id });
    this.refreshRisk(product.id);
    return this.get(product.id);
  }

  /**
   * Merge an AI identification into the product. Operator-confirmed values are
   * never overwritten; everything else is stored with its basis and confidence
   * so the UI can show what was seen versus what was guessed.
   */
  applyIdentification(id: string, ident: Identification): ProductRow {
    const product = this.get(id);
    const attributes = parseJson<Record<string, AttributeValue>>(product.attributes, {});
    const map: [TextField, { value: string | null; basis: "visible" | "inferred"; confidence: number }][] = [
      ["category", ident.productType],
      ["brand", ident.brand],
      ["model", ident.model],
      ["style_number", ident.styleNumber],
      ["department", ident.department],
      ["size", ident.size],
      ["color", ident.color],
      ["material", ident.material],
      ["condition", ident.condition],
    ];
    const sets: string[] = [];
    const args: unknown[] = [];
    for (const [field, a] of map) {
      const current = attributes[field];
      if (current && (current.basis === "operator" || current.basis === "import")) continue;
      let value = a.value ? cleanLine(a.value, 200) : null;
      if (value && field === "category") value = normaliseProductType(value) === "other" ? value.toLowerCase() : normaliseProductType(value);
      if (value && field === "department") value = normaliseDepartment(value);
      if (value && field === "condition") value = normaliseCondition(value);
      // A model's guess about size or material is not good enough to put on a listing.
      if (value && a.basis === "inferred" && (field === "size" || field === "material" || field === "style_number")) value = null;
      sets.push(`${field} = ?`);
      args.push(value);
      if (value) attributes[field] = { value, basis: a.basis, confidence: Math.max(0, Math.min(1, a.confidence)) };
      else delete attributes[field];
    }
    const defects = ident.defects.map((d) => cleanLine(d, 200)).filter(Boolean);
    if (!product.condition_notes && defects.length) {
      sets.push("condition_notes = ?");
      args.push(defects.join("; "));
    }
    const stored = {
      ...ident,
      defects,
      accessories: ident.accessories.map((x) => cleanLine(x, 100)).filter(Boolean),
      visibleText: ident.visibleText.map((x) => cleanLine(x, 120)).filter(Boolean).slice(0, 30),
      authenticityConcerns: ident.authenticityConcerns.map((x) => cleanLine(x, 300)).filter(Boolean),
      summary: cleanLine(ident.summary, 400),
    };
    sets.push("identification = ?", "identification_confidence = ?", "attributes = ?", "version = version + 1", "updated_at = ?");
    args.push(JSON.stringify(stored), Math.max(0, Math.min(1, ident.overallConfidence)), JSON.stringify(attributes), clock.iso());
    writeTx(this.db, () => {
      this.db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).run(...args, product.id);
      const images = this.images(product.id);
      images.forEach((img, i) => {
        if (ident.views[i]) this.db.prepare("UPDATE product_images SET view_label = ? WHERE id = ?").run(ident.views[i], img.id);
      });
    });
    this.refreshRisk(product.id);
    return this.get(product.id);
  }

  // ---- deterministic validation -------------------------------------------------
  /** Information a listing cannot responsibly go out without. */
  criticalMissing(product: ProductRow, imageCount = this.images(product.id).length): string[] {
    const missing: string[] = [];
    const type = normaliseProductType(product.category);
    if (!product.category) missing.push("product type");
    if (!product.condition) missing.push("condition");
    if (!product.brand) missing.push("brand");
    if (needsSize(type) && !product.size) missing.push("size");
    if (imageCount === 0) missing.push("photos");
    return missing;
  }

  /** Recompute risk flags from settings and stored facts. Flags only ever add scrutiny. */
  refreshRisk(id: string): string[] {
    const product = this.get(id);
    const risk = this.ctx.settings.get().risk;
    const ident = parseJson<Partial<Identification>>(product.identification, {});
    const flags: string[] = [];
    const brand = (product.brand ?? "").toLowerCase();
    if (brand && risk.highRiskBrands.some((b) => brand === b || brand.includes(b))) flags.push("authenticity_review:high_risk_brand");
    if ((ident.authenticityConcerns ?? []).length) flags.push("authenticity_concern");
    const text = [product.title, product.brand, product.model, product.notes, product.condition_notes, ...(ident.visibleText ?? [])].filter(Boolean).join(" ").toLowerCase();
    for (const word of risk.restrictedKeywords) if (text.includes(word.toLowerCase())) flags.push(`restricted_term:${word}`);
    if (looksLikeInstruction([product.notes, product.title, ...(ident.visibleText ?? [])].filter(Boolean).join("\n"))) flags.push("suspicious_text");
    this.db.prepare("UPDATE products SET risk_flags = ? WHERE id = ?").run(JSON.stringify(flags), product.id);
    return flags;
  }

  // ---- workflow bookkeeping -------------------------------------------------------
  setStatus(id: string, status: ProductStatus): void {
    this.db.prepare("UPDATE products SET status = ?, updated_at = ?, archived_at = CASE WHEN ? = 'archived' THEN ? ELSE archived_at END WHERE id = ?").run(status, clock.iso(), status, clock.iso(), id);
  }

  setStage(productId: string, stage: WorkflowStage, status: StageStatus, detail?: unknown): void {
    const now = clock.iso();
    this.db
      .prepare(
        `INSERT INTO workflow_stages (product_id, stage, status, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id, stage) DO UPDATE SET status = excluded.status, detail = excluded.detail,
           started_at = COALESCE(workflow_stages.started_at, excluded.started_at), finished_at = excluded.finished_at`,
      )
      .run(productId, stage, status, detail === undefined ? null : JSON.stringify(detail), now, status === "running" || status === "pending" ? null : now);
  }

  stages(productId: string): { stage: string; status: string; detail: unknown; started_at: string | null; finished_at: string | null }[] {
    const rows = this.db.prepare("SELECT * FROM workflow_stages WHERE product_id = ?").all(productId) as { stage: string; status: string; detail: string | null; started_at: string | null; finished_at: string | null }[];
    return rows.map((r) => ({ ...r, detail: parseJson(r.detail, null) }));
  }

  archive(id: string, actor: Actor): void {
    const product = this.get(id);
    const live = this.db.prepare("SELECT COUNT(*) AS n FROM listings WHERE product_id = ? AND status IN ('publishing','awaiting_operator','published','delisting_pending')").get(product.id) as { n: number };
    if (live.n > 0) throw new AppError("has_live_listings", "End this product's live listings before archiving it.", 409);
    this.setStatus(product.id, "archived");
    const drafts = this.db.prepare("SELECT id FROM listings WHERE product_id = ? AND status NOT IN ('sold','delisted','archived')").all(product.id) as { id: string }[];
    for (const d of drafts) this.ctx.approvals.invalidateForListing(d.id, "The item was archived.");
    this.db.prepare("UPDATE listings SET status = 'archived', updated_at = ? WHERE product_id = ? AND status NOT IN ('sold','delisted','archived')").run(clock.iso(), product.id);
    this.ctx.audit.record({ actor, action: "product.archived", entityType: "product", entityId: product.id, productId: product.id });
  }
}
