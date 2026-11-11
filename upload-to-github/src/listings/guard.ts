import type { ListingFacts, ListingText } from "../ai/provider";
import { SPECS } from "../marketplaces/specs";
import { looksLikeInstruction } from "../security/sanitize";

// Deterministic check applied to AI-written listing text before it is used.
// If the text makes a claim the verified facts do not support, it is rejected
// and the template writer's text is used instead. The goal is that a listing
// can never say more than the operator (or a visible tag) has confirmed.

const UNSUPPORTED_CLAIMS: { re: RegExp; allowed: (f: ListingFacts) => boolean; label: string }[] = [
  { re: /\b(100% )?(authentic|genuine|guaranteed|certified|verified authentic)\b/i, allowed: () => false, label: "authenticity claim" },
  { re: /\b(nwt|new with tags|brand new|never worn|unworn|deadstock)\b/i, allowed: (f) => f.condition === "new_with_tags" || f.condition === "new_without_tags", label: "new-condition claim" },
  { re: /\b(flawless|mint|perfect condition|no flaws|pristine)\b/i, allowed: (f) => f.defects.length === 0 && (f.condition === "new_with_tags" || f.condition === "new_without_tags" || f.condition === "like_new"), label: "flawless claim" },
  { re: /\b(rare|limited edition|one of a kind|collector'?s?|grail)\b/i, allowed: (f) => /rare|limited|collector/i.test(f.notes ?? ""), label: "rarity claim" },
  { re: /\b(vintage|y2k|90s|80s|70s|retro)\b/i, allowed: (f) => /vintage|y2k|90s|80s|70s|retro/i.test(`${f.notes ?? ""} ${f.model ?? ""}`), label: "era claim" },
  { re: /\b(retail|msrp|originally|worth) \$?\d/i, allowed: () => false, label: "retail price claim" },
  { re: /\b(smoke[- ]free|pet[- ]free|dry cleaned|freshly washed)\b/i, allowed: (f) => /smoke|pet|clean|wash/i.test(f.notes ?? ""), label: "care claim" },
];

const MATERIALS = /\b(cotton|polyester|wool|cashmere|silk|linen|leather|suede|denim|nylon|rayon|viscose|spandex|elastane|acrylic|fleece|down|merino|velvet|satin)\b/gi;

export interface GuardResult {
  ok: boolean;
  problems: string[];
}

export function checkListingText(text: ListingText, facts: ListingFacts): GuardResult {
  const problems: string[] = [];
  const spec = SPECS[text.marketplace];
  const body = `${text.title}\n${text.description}`;
  const factsBlob = JSON.stringify(facts).toLowerCase();

  if (spec.titleMax > 0 && text.title.length > spec.titleMax) problems.push(`title is ${text.title.length} characters (limit ${spec.titleMax})`);
  if (text.description.length > spec.descriptionMax) problems.push(`description is ${text.description.length} characters (limit ${spec.descriptionMax})`);
  if (!text.title.trim() || !text.description.trim()) problems.push("empty title or description");

  for (const claim of UNSUPPORTED_CLAIMS) {
    if (claim.re.test(body) && !claim.allowed(facts)) problems.push(`unsupported ${claim.label}`);
  }

  // Materials may only be named if the facts name them.
  for (const m of body.match(MATERIALS) ?? []) {
    if (!factsBlob.includes(m.toLowerCase())) problems.push(`material "${m}" is not in the verified facts`);
  }

  // Every number in the text (sizes, measurements, percentages, style numbers) must come from the facts.
  for (const n of body.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!factsBlob.includes(n)) problems.push(`number "${n}" is not in the verified facts`);
  }

  // The brand in the title must be the product's brand.
  if (facts.brand && !body.toLowerCase().includes(facts.brand.toLowerCase())) problems.push("brand is missing from the listing");

  // Every listed defect must be disclosed (matched on its most distinctive word).
  for (const defect of facts.defects) {
    const words = defect.toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const key = words.sort((a, b) => b.length - a.length)[0];
    if (key && !body.toLowerCase().includes(key)) problems.push(`defect not disclosed: "${defect}"`);
  }

  if (looksLikeInstruction(body)) problems.push("text contains instruction-like content");
  if (/https?:\/\/|www\.|@[a-z0-9_]{3,}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/i.test(body)) problems.push("contains a link, handle or phone number");

  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}
