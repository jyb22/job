import { readFile } from "node:fs/promises";
import type { Ctx } from "../context";
import { AGENT, parseJson, type AttributeValue } from "../core/types";
import { RateLimitError } from "../core/util";
import { AiRefusalError, AiUnavailableError, type ImageInput } from "../ai/provider";

export interface PipelineResult {
  productId: string;
  status: string;
  stoppedAt?: string;
  reason?: string;
  listings: { marketplace: string; outcome: string }[];
}

/**
 * The product workflow: image analysis → identification → attribute
 * extraction → validation → market research → comparable analysis → pricing →
 * listing generation → marketplace mapping → quality validation →
 * authorisation. Publication and everything after it are separate jobs
 * started by the authorisation step.
 *
 * Every stage records its own status. The whole thing can be re-run at any
 * time (after a crash, or after the operator fixes something): each stage
 * overwrites its previous result and nothing downstream is duplicated,
 * because listings are upserted per marketplace and publication is
 * idempotent.
 */
export class Pipeline {
  constructor(private ctx: Ctx) {}

  async process(productId: string, opts: { skipIdentification?: boolean } = {}): Promise<PipelineResult> {
    const { products, research, listings, settings, audit, notifications } = this.ctx;
    let product = products.get(productId);
    const result: PipelineResult = { productId: product.id, status: product.status, listings: [] };
    if (["archived", "sold", "delisting_pending"].includes(product.status)) return { ...result, stoppedAt: "ingestion", reason: `Product is ${product.status}` };
    const stop = (stage: string, status: "identification_required" | "needs_review", reason: string): PipelineResult => {
      products.setStatus(product.id, status);
      notifications.notify({ type: "review_needed", title: `Needs your attention: ${product.title ?? product.brand ?? product.sku}`, body: reason, productId: product.id });
      return { ...result, status, stoppedAt: stage, reason };
    };

    products.setStatus(product.id, "processing");

    // ---- image analysis -------------------------------------------------------
    const images = products.images(product.id);
    const issues = images.flatMap((i) => parseJson<{ issues?: string[] }>(i.quality, {}).issues ?? []);
    products.setStage(product.id, "image_analysis", images.length ? "done" : "skipped", { photos: images.length, issues, suggestedPhotos: products.suggestedPhotos(product.id) });

    // ---- identification -------------------------------------------------------
    const attrs = parseJson<Record<string, AttributeValue>>(product.attributes, {});
    const operatorKnows = ["brand", "category", "condition"].every((f) => attrs[f] && (attrs[f]!.basis === "operator" || attrs[f]!.basis === "import"));
    if (opts.skipIdentification || operatorKnows || images.length === 0) {
      products.setStage(product.id, "identification", "skipped", { reason: operatorKnows ? "Details were entered by the operator" : images.length === 0 ? "No photos to analyse" : "Skipped" });
      if (operatorKnows && product.identification_confidence === null) this.ctx.db.prepare("UPDATE products SET identification_confidence = 1 WHERE id = ?").run(product.id);
    } else {
      products.setStage(product.id, "identification", "running");
      const ai = this.ctx.ai();
      try {
        const inputs: ImageInput[] = [];
        for (const img of images.slice(0, 12)) {
          inputs.push({ mediaType: "image/jpeg", base64: (await readFile(img.optimized_path ?? img.original_path)).toString("base64") });
        }
        const ident = await ai.identify(inputs, product.notes ?? undefined);
        product = products.applyIdentification(product.id, ident);
        products.setStage(product.id, "identification", "done", { provider: ident.provider, simulated: !!ident.simulated, confidence: ident.overallConfidence, summary: ident.summary });
        audit.record({ actor: AGENT, action: "ai.identification", entityType: "product", entityId: product.id, productId: product.id, detail: { provider: ident.provider, simulated: !!ident.simulated, confidence: ident.overallConfidence, concerns: ident.authenticityConcerns.length, defects: ident.defects.length } });
      } catch (error) {
        if (error instanceof RateLimitError) throw error; // let the queue retry later
        if (error instanceof AiUnavailableError || error instanceof AiRefusalError) {
          products.setStage(product.id, "identification", "blocked", { reason: (error as Error).message });
          audit.record({ actor: AGENT, action: "ai.identification", outcome: "failed", entityType: "product", entityId: product.id, productId: product.id, detail: { error: (error as Error).message } });
          return stop("identification", "identification_required", `Automatic identification is not available (${(error as Error).message}). Enter the brand, product type, size and condition by hand.`);
        }
        products.setStage(product.id, "identification", "failed", { error: (error as Error).message.slice(0, 300) });
        throw error;
      }
    }

    // ---- attribute extraction ---------------------------------------------------
    product = products.get(product.id);
    const tracked = parseJson<Record<string, AttributeValue>>(product.attributes, {});
    const byBasis: Record<string, string[]> = {};
    for (const [name, a] of Object.entries(tracked)) (byBasis[a.basis] ??= []).push(name);
    products.setStage(product.id, "attribute_extraction", "done", { byBasis });
    if (!product.title) {
      const title = [product.brand, product.model, product.category].filter(Boolean).join(" ");
      if (title) this.ctx.db.prepare("UPDATE products SET title = ? WHERE id = ?").run(title.slice(0, 200), product.id);
    }

    // ---- validation -----------------------------------------------------------
    const riskFlags = products.refreshRisk(product.id);
    product = products.get(product.id);
    const missing = products.criticalMissing(product, images.length);
    const lowConfidence = (product.identification_confidence ?? 0) < settings.get().thresholds.minIdentificationConfidence;
    products.setStage(product.id, "validation", missing.length ? "blocked" : "done", { missing, riskFlags, identificationConfidence: product.identification_confidence, lowConfidence });
    if (riskFlags.some((f) => f.startsWith("authenticity"))) {
      notifications.notify({ type: "authenticity_concern", severity: "warning", title: `Authenticity check needed: ${product.title ?? product.sku}`, body: `This item was flagged (${riskFlags.join(", ")}). It will not be published without your approval.`, productId: product.id });
    }
    if (riskFlags.includes("suspicious_text")) {
      notifications.notify({ type: "suspicious_activity", severity: "warning", title: `Suspicious text on ${product.sku}`, body: "Text on this product (notes, tags or imported data) looks like an instruction aimed at the system. It was ignored and the product was held for review.", productId: product.id });
    }
    const essential = missing.filter((m) => m === "product type" || m === "condition");
    if (essential.length) return stop("validation", "identification_required", `Missing information: ${missing.join(", ")}.`);

    // ---- market research + comparable analysis ------------------------------------
    products.setStage(product.id, "market_research", "running");
    const { outcomes, comps } = await research.run(product.id);
    const anySource = outcomes.some((o) => o.status === "ok");
    products.setStage(product.id, "market_research", anySource ? "done" : "blocked", { outcomes });
    const sold = comps.filter((c) => c.kind === "sold");
    products.setStage(product.id, "comparable_analysis", comps.length ? "done" : "skipped", {
      sold: sold.length,
      active: comps.length - sold.length,
      simulated: comps.some((c) => c.simulated === 1),
      averageSimilarity: comps.length ? Math.round((comps.reduce((s, c) => s + c.similarity, 0) / comps.length) * 100) / 100 : null,
    });

    // ---- pricing ----------------------------------------------------------------
    const rec = research.recommend(product.id);
    products.setStage(product.id, "pricing", rec.basis === "none" ? "blocked" : "done", { basis: rec.basis, expected: rec.expectedSellingCents, confidence: rec.confidence, flags: rec.flags, disclosures: rec.disclosures });
    if (rec.basis === "none" || rec.perMarketplace.length === 0) {
      return stop("pricing", "needs_review", rec.perMarketplace.length === 0 && rec.basis !== "none" ? "No marketplaces are enabled." : "No market data and no acquisition cost: add comparables or a cost so a price can be recommended.");
    }

    // ---- listing generation, mapping, quality -------------------------------------
    products.setStage(product.id, "listing_generation", "running");
    const drafts = await listings.generate(product.id, AGENT);
    products.setStage(product.id, "listing_generation", "done", { listings: drafts.map((d) => ({ marketplace: d.marketplace, writer: d.writer })) });
    products.setStage(product.id, "marketplace_mapping", "done", { categories: drafts.map((d) => ({ marketplace: d.marketplace, category: d.category_name, source: parseJson<{ categorySource?: string }>(d.attributes, {}).categorySource })) });
    const invalid = drafts.filter((d) => !parseJson<{ ok: boolean }>(d.validation, { ok: false }).ok);
    products.setStage(product.id, "quality_validation", "done", { scores: drafts.map((d) => ({ marketplace: d.marketplace, score: d.quality_score, valid: !invalid.includes(d) })) });

    // ---- authorisation --------------------------------------------------------------
    // The agent proposes publication for every valid draft; the policy engine decides each one.
    for (const draft of drafts) {
      if (invalid.includes(draft)) {
        result.listings.push({ marketplace: draft.marketplace, outcome: "invalid" });
        continue;
      }
      const r = listings.requestPublish(draft.id, AGENT);
      result.listings.push({ marketplace: draft.marketplace, outcome: r.outcome });
    }
    products.setStage(product.id, "authorization", "done", { decisions: result.listings });
    result.status = listings.refreshProductStatus(product.id);
    audit.record({ actor: AGENT, action: "pipeline.completed", entityType: "product", entityId: product.id, productId: product.id, detail: { status: result.status, listings: result.listings } });
    return result;
  }
}
