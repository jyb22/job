import type { Condition, MarketplaceId } from "../core/types";
import { titleCase } from "../core/util";
import type { ListingFacts, ListingText } from "../ai/provider";
import { SPECS } from "../marketplaces/specs";

// Deterministic listing writer. It can only arrange facts it is given, so it
// cannot invent a claim. It is always available (no API key needed) and is
// the fallback whenever AI-written text fails the guard in ./guard.ts.

const CONDITION_SENTENCE: Record<Condition, string> = {
  new_with_tags: "New with tags.",
  new_without_tags: "New without tags.",
  like_new: "Like-new condition.",
  excellent: "Excellent used condition.",
  good: "Good used condition.",
  fair: "Fair condition with visible wear.",
  poor: "Poor condition; sold as-is.",
};

function clip(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

function deptWord(dept: string | null): string | null {
  if (dept === "menswear") return "Men's";
  if (dept === "womenswear") return "Women's";
  if (dept === "kids") return "Kids'";
  return null;
}

/** Title parts in priority order; lower-priority parts are dropped first when the title is too long. */
function titleParts(f: ListingFacts, marketplace: MarketplaceId): string[] {
  const type = f.productType && f.productType !== "other" ? titleCase(f.productType) : null;
  const parts: (string | null)[] = [
    f.brand,
    f.model,
    type,
    deptWord(f.department),
    f.size ? `Size ${f.size}` : null,
    f.color ? titleCase(f.color) : null,
    marketplace === "ebay" ? f.styleNumber : null,
    marketplace === "poshmark" && f.condition === "new_with_tags" ? "NWT" : null,
  ];
  // Drop parts that merely repeat an earlier one (e.g. model already contains the item type).
  const out: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const lower = p.toLowerCase();
    if (out.some((o) => o.toLowerCase().includes(lower))) continue;
    out.push(p);
  }
  return out;
}

export function buildTitle(f: ListingFacts, marketplace: MarketplaceId): string {
  const max = SPECS[marketplace].titleMax || 80;
  const parts = titleParts(f, marketplace);
  while (parts.length > 1 && parts.join(" ").length > max) parts.pop();
  return clip(parts.join(" "), max) || "Untitled item";
}

export function buildKeywords(f: ListingFacts, marketplace: MarketplaceId): string[] {
  const max = SPECS[marketplace].maxKeywords;
  if (max === 0) return [];
  const raw = [f.brand, f.productType, f.color, f.department === "menswear" ? "mens" : f.department === "womenswear" ? "womens" : null, f.model, f.material?.replace(/[\d%]+/g, "").trim()];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const k = (r ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    if (!k || k === "other" || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

export function buildDescription(f: ListingFacts, marketplace: MarketplaceId, shippingNote?: string): string {
  const spec = SPECS[marketplace];
  const lines: string[] = [];
  const headline = [f.brand, f.model, f.productType && f.productType !== "other" ? f.productType : null].filter(Boolean).join(" ");
  if (marketplace === "depop") lines.push(buildTitle(f, marketplace));
  else if (headline) lines.push(`${headline}.`);
  lines.push("");

  const detail = (label: string, value: string | null | undefined) => {
    if (value) lines.push(`${label}: ${value}`);
  };
  detail("Brand", f.brand);
  detail("Model", f.model);
  detail("Size", f.size);
  detail("Colour", f.color ? titleCase(f.color) : null);
  detail("Material", f.material);
  detail("Style number", f.styleNumber);
  for (const [name, value] of Object.entries(f.measurements)) detail(titleCase(name), value);

  lines.push("");
  if (f.condition) {
    const label = spec.conditionLabels[f.condition as Condition] ?? f.condition;
    const sentence = CONDITION_SENTENCE[f.condition as Condition] ?? "";
    // Avoid "Good. Good used condition." when the marketplace's label and our sentence say the same thing.
    const repeats = sentence.toLowerCase().startsWith(label.toLowerCase().replace(/^used - /, ""));
    lines.push(repeats || !sentence ? `Condition: ${sentence || label + "."}` : `Condition: ${label}. ${sentence}`);
  }
  if (f.conditionNotes) lines.push(f.conditionNotes);
  if (f.defects.length) {
    lines.push("Flaws to note:");
    for (const d of f.defects) lines.push(`- ${d}`);
  } else if (f.condition && f.condition !== "new_with_tags") {
    lines.push("No flaws noted beyond normal wear for the stated condition. Please review all photos.");
  }
  if (f.accessories.length) lines.push(`Includes: ${f.accessories.join(", ")}.`);
  if (shippingNote) {
    lines.push("");
    lines.push(shippingNote);
  }

  const keywords = buildKeywords(f, marketplace);
  if (marketplace === "depop" && keywords.length) {
    lines.push("");
    lines.push(keywords.map((k) => `#${k.replace(/\s+/g, "")}`).join(" "));
  }
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return text.length > spec.descriptionMax ? clip(text, spec.descriptionMax) : text;
}

export function templateListing(f: ListingFacts, marketplace: MarketplaceId, shippingNote?: string): ListingText {
  return {
    marketplace,
    title: buildTitle(f, marketplace),
    description: buildDescription(f, marketplace, shippingNote),
    keywords: buildKeywords(f, marketplace),
  };
}
