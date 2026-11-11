import type { Actor, MarketplaceId } from "../core/types";
import { clock, HOUR, sha256Hex } from "../core/util";
import type { Settings } from "../settings/schema";
import { SPECS } from "../marketplaces/specs";

// The single place where "is this action allowed to execute?" is decided.
//
// It is a pure function of the action, a few facts read from the database,
// and the operator's settings. It has no access to any language model and
// takes no free text as input, so nothing an AI writes — and nothing found in
// a photo, a CSV file or a marketplace response — can change its answer.
// The AI layer may only *propose* actions; every proposal passes through here.

export type ActionType =
  // routine merchandise operations (may be autonomous inside configured rules)
  | "listing.publish"
  | "listing.update_content"
  | "listing.reprice"
  | "listing.end"
  | "inventory.update"
  // always approval-controlled
  | "listing.delete"
  | "offer.respond"
  | "refund.issue"
  | "credit.issue"
  | "label.purchase"
  | "purchase.make"
  | "subscription.purchase"
  | "payout.change"
  | "payment_method.change"
  | "bank_account.change"
  // never performed by the agent, with or without approval
  | "account.password_change"
  | "account.ownership_change"
  | "account.security_change"
  | "account.mfa_change"
  | "account.grant_permission"
  | "account.credentials_change";

const FINANCIAL: ReadonlySet<ActionType> = new Set([
  "offer.respond", "refund.issue", "credit.issue", "label.purchase", "purchase.make",
  "subscription.purchase", "payout.change", "payment_method.change", "bank_account.change", "listing.delete",
]);
const ACCOUNT_SECURITY: ReadonlySet<ActionType> = new Set([
  "account.password_change", "account.ownership_change", "account.security_change",
  "account.mfa_change", "account.grant_permission", "account.credentials_change",
]);

export interface ListingFacts {
  id: string;
  priceCents: number;
  originalPriceCents: number;
  minPriceCents: number;
  qualityScore: number | null;
  validationOk: boolean;
  integrationMode: string; // api | assisted | simulated
  lastRepricedAt: string | null;
  contentHash: string;
}

export interface ProductFacts {
  identificationConfidence: number | null;
  riskFlags: string[];
  criticalMissing: string[];
  costKnown: boolean;
}

export interface PricingFacts {
  confidence: number;
  basis: string;
  simulatedData: boolean;
  soldCompsUsed: number;
}

export interface ActionRequest {
  type: ActionType;
  actor: Actor;
  marketplace?: MarketplaceId;
  listing?: ListingFacts;
  product?: ProductFacts;
  pricing?: PricingFacts | null;
  newPriceCents?: number;
  endReason?: "verified_sale" | "operator" | "optimization";
  /** True only when a matching, unexpired human approval exists (checked by the approvals service, not asserted by the caller). */
  humanApproved?: boolean;
}

export type Outcome = "allow" | "needs_approval" | "defer" | "deny";

export interface Reason {
  code: string;
  message: string;
  /** Hard reasons cannot be overridden by an approval; the underlying problem has to be fixed. */
  hard?: boolean;
}

export interface Decision {
  outcome: Outcome;
  reasons: Reason[];
  risk: "normal" | "high";
  checked: string[];
}

const ORDER: Record<Outcome, number> = { allow: 0, defer: 1, needs_approval: 2, deny: 3 };

class Verdict {
  outcome: Outcome = "allow";
  reasons: Reason[] = [];
  risk: "normal" | "high" = "normal";
  checked: string[] = [];

  pass(code: string): void {
    this.checked.push(code);
  }
  raise(outcome: Outcome, code: string, message: string, opts: { hard?: boolean; high?: boolean } = {}): void {
    this.checked.push(code);
    this.reasons.push({ code, message, hard: opts.hard });
    if (ORDER[outcome] > ORDER[this.outcome]) this.outcome = outcome;
    if (opts.high) this.risk = "high";
  }
  check(ok: boolean, outcome: Outcome, code: string, message: string, opts: { hard?: boolean; high?: boolean } = {}): void {
    if (ok) this.pass(code);
    else this.raise(outcome, code, message, opts);
  }
  done(): Decision {
    return { outcome: this.outcome, reasons: this.reasons, risk: this.risk, checked: this.checked };
  }
}

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export function authorize(req: ActionRequest, settings: Settings, now: Date = clock.now()): Decision {
  const v = new Verdict();
  const a = settings.automation;
  const isAgent = req.actor.type !== "user";

  // ---- 1. who is asking ----------------------------------------------------
  if (req.actor.type === "user") {
    v.check(req.actor.role === "owner" || req.actor.role === "manager", "deny", "role", "Your role cannot perform write operations.", { hard: true });
    if (v.outcome === "deny") return v.done();
  }

  // ---- 2. categories that are never autonomous -------------------------------
  if (ACCOUNT_SECURITY.has(req.type)) {
    if (isAgent) v.raise("deny", "account_security", "Account security and credential changes are never performed by the agent.", { hard: true, high: true });
    else v.check(req.actor.role === "owner", "deny", "owner_only", "Only an owner can change account security or credentials.", { hard: true });
    return v.done();
  }
  if (FINANCIAL.has(req.type)) {
    if (req.humanApproved && !isAgent) v.pass("human_authorised_financial");
    else if (req.humanApproved) v.pass("human_approved");
    else v.raise("needs_approval", "financial_action", "Financial commitments, offers, refunds and deletions always need human authorisation.", { high: true });
    if (a.emergencyStop && isAgent) v.raise("deny", "emergency_stop", "Emergency stop is active.", { hard: true });
    return v.done();
  }

  // ---- 3. global brakes ------------------------------------------------------
  const protective = (req.type === "listing.end" && req.endReason === "verified_sale") || req.type === "inventory.update";
  if (a.emergencyStop) {
    if (protective && a.protectiveDelistingDuringStop) v.pass("emergency_stop_protective_exception");
    else if (req.type === "listing.end" && !isAgent) v.pass("emergency_stop_manual_end");
    else {
      v.raise("deny", "emergency_stop", "Emergency stop is active: publishing, price changes and edits are blocked until an owner releases it.", { hard: true });
      return v.done();
    }
  } else v.pass("emergency_stop");

  if (isAgent && a.paused && !protective) {
    v.raise("defer", "paused", "Automation is paused; this action will be retried after it resumes.");
    return v.done();
  }

  // ---- 4. marketplace scope ----------------------------------------------------
  if (req.marketplace) {
    const m = settings.marketplaces[req.marketplace];
    v.check(m.enabled, "deny", "marketplace_enabled", `${SPECS[req.marketplace].name} is not enabled.`, { hard: true });
    if (isAgent && !req.humanApproved) {
      const scope =
        req.type === "listing.publish" ? m.permissions.publish
        : req.type === "listing.update_content" ? m.permissions.updateContent
        : req.type === "listing.reprice" ? m.permissions.reprice
        : req.type === "listing.end" ? m.permissions.end
        : m.permissions.updateInventory;
      const what = req.type === "listing.publish" ? "publish" : req.type === "listing.update_content" ? "edit listings" : req.type === "listing.reprice" ? "change prices" : req.type === "listing.end" ? "end listings" : "update quantities";
      v.check(scope, "needs_approval", "permission_scope", `The agent is not permitted to ${what} on ${SPECS[req.marketplace].name} on its own (Settings → Marketplaces).`);
    }
  }

  const L = req.listing;
  const t = settings.thresholds;

  // ---- 5. per-action rules -----------------------------------------------------
  switch (req.type) {
    case "listing.publish": {
      if (!L) { v.raise("deny", "no_listing", "No listing supplied.", { hard: true }); break; }
      // Problems that must be fixed; an approval cannot wave them through.
      v.check(L.validationOk, "deny", "validation", "The listing does not meet this marketplace's requirements.", { hard: true });
      v.check(L.priceCents > 0, "deny", "price_positive", "The listing has no price.", { hard: true });

      if (isAgent && !req.humanApproved) {
        v.check(a.mode !== "review_only", "needs_approval", "mode_review_only", "Review-only mode: every listing needs operator approval before it is published.");
      }

      // Exceptions: a human may approve these; the agent may never decide them itself.
      const P = req.product;
      const exc = (ok: boolean, code: string, message: string, high = false) => {
        if (ok) v.pass(code);
        else if (req.humanApproved) v.pass(`${code}:approved_exception`);
        else v.raise("needs_approval", code, message, { high });
      };
      exc(L.priceCents >= L.minPriceCents, "price_floor", `Price ${money(L.priceCents)} is below the minimum acceptable price ${money(L.minPriceCents)}.`, true);
      if (P) {
        exc(P.riskFlags.length === 0, "risk_flags", `Risk flags need human review: ${P.riskFlags.join(", ")}.`, true);
        exc(P.criticalMissing.length === 0, "critical_info", `Critical information is missing: ${P.criticalMissing.join(", ")}.`);
        exc(P.costKnown, "cost_known", "Acquisition cost is unknown, so the profit floor cannot be enforced.");
        if (isAgent) exc((P.identificationConfidence ?? 0) >= t.minIdentificationConfidence, "identification_confidence", `Product identification confidence is below ${Math.round(t.minIdentificationConfidence * 100)}%.`);
      }
      if (isAgent) {
        exc((L.qualityScore ?? 0) >= t.minListingQuality, "listing_quality", `Listing quality ${L.qualityScore ?? 0} is below the minimum ${t.minListingQuality}.`);
        exc(L.priceCents <= t.maxAutoPublishPriceCents, "max_auto_price", `Price is above the automatic publishing limit ${money(t.maxAutoPublishPriceCents)}.`, true);
        const pr = req.pricing;
        exc(!!pr, "pricing_present", "No price recommendation exists for this product.");
        if (pr) {
          exc(pr.confidence >= t.minPricingConfidence, "pricing_confidence", `Pricing confidence ${Math.round(pr.confidence * 100)}% is below the minimum.`);
          exc(!pr.simulatedData, "real_market_data", "The price is based on simulated comparables.");
          if (t.requireSoldComps) exc(pr.basis === "sold_comps", "sold_comps", "The price is not backed by enough completed-sale comparables.");
        }
      }
      break;
    }

    case "listing.reprice": {
      if (!L || req.newPriceCents === undefined) { v.raise("deny", "no_listing", "No listing or price supplied.", { hard: true }); break; }
      const next = req.newPriceCents;
      v.check(next > 0, "deny", "price_positive", "A price must be positive.", { hard: true });
      const exc = (ok: boolean, code: string, message: string, high = false) => {
        if (ok) v.pass(code);
        else if (req.humanApproved) v.pass(`${code}:approved_exception`);
        else v.raise("needs_approval", code, message, { high });
      };
      exc(next >= L.minPriceCents, "price_floor", `New price ${money(next)} is below the minimum acceptable price ${money(L.minPriceCents)}.`, true);
      const discountPct = L.originalPriceCents > 0 ? ((L.originalPriceCents - next) / L.originalPriceCents) * 100 : 0;
      exc(discountPct <= settings.pricing.maxDiscountPct + 1e-9, "max_discount", `Total discount ${discountPct.toFixed(1)}% exceeds the limit of ${settings.pricing.maxDiscountPct}%.`, true);
      if (isAgent) {
        exc(a.mode === "full_autonomous", "mode_full_required", "Automatic repricing is only available in full autonomous mode.");
        const changePct = L.priceCents > 0 ? (Math.abs(next - L.priceCents) / L.priceCents) * 100 : 100;
        exc(changePct <= t.maxAutoPriceChangePct + 1e-9, "max_change", `A ${changePct.toFixed(1)}% change exceeds the automatic limit of ${t.maxAutoPriceChangePct}%.`);
        if (L.lastRepricedAt && !req.humanApproved) {
          const hours = (now.getTime() - new Date(L.lastRepricedAt).getTime()) / HOUR;
          v.check(hours >= settings.pricing.minRepriceIntervalHours, "defer", "reprice_interval", "This listing was repriced too recently.");
        }
      }
      break;
    }

    case "listing.update_content": {
      if (isAgent && !req.humanApproved) {
        v.check(a.mode === "full_autonomous", "needs_approval", "mode_full_required", "Automatic listing edits are only available in full autonomous mode.");
      }
      if (L) v.check(L.validationOk, "deny", "validation", "The edited listing does not meet this marketplace's requirements.", { hard: true });
      break;
    }

    case "listing.end": {
      if (isAgent && req.endReason !== "verified_sale" && !req.humanApproved) {
        v.raise("needs_approval", "end_without_sale", "Ending a listing for a reason other than a verified sale needs approval.");
      } else v.pass("end_reason");
      break;
    }

    case "inventory.update":
      v.pass("inventory_update");
      break;
  }

  return v.done();
}

/** Stable fingerprint of exactly what a human is approving. If the listing changes, the approval no longer matches. */
export function actionFingerprint(type: ActionType, listingId: string | undefined, priceCents: number | undefined, contentHash: string | undefined): string {
  return sha256Hex([type, listingId ?? "", priceCents ?? "", contentHash ?? ""].join("|")).slice(0, 32);
}

/** Whether moving to a new automation mode is permitted for this actor. */
export function canChangeAutomation(actor: Actor): boolean {
  return actor.type === "user" && actor.role === "owner";
}
