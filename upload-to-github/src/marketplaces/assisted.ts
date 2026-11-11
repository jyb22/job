import type { MarketplaceId } from "../core/types";
import { BaseAdapter, NO_CAPABILITIES, UnsupportedOperationError, type AdapterCapabilities, type CreateResult, type ListingPayload } from "./adapter";
import { SPECS } from "./specs";

// Assisted mode: for marketplaces with no public seller API (Mercari,
// Poshmark, Facebook Marketplace), or where API access has not been granted
// yet. The app does not log in to, script, or scrape these sites. Instead it
// prepares a complete, validated listing packet and opens a task for the
// operator, who posts it by hand and records the listing link. Ending a
// listing after a sale elsewhere works the same way: an urgent task.
export class AssistedAdapter extends BaseAdapter {
  readonly mode = "assisted" as const;
  readonly capabilities: AdapterCapabilities = NO_CAPABILITIES;

  constructor(readonly marketplace: MarketplaceId) {
    super();
  }

  async validateConnection() {
    return { ok: true, message: `${SPECS[this.marketplace].name} runs in assisted mode: listings are prepared here and posted by you. ${SPECS[this.marketplace].apiNotes}` };
  }

  async createListing(payload: ListingPayload): Promise<CreateResult> {
    return { externalId: `pending:${payload.sku}`, url: null, state: "awaiting_operator" };
  }

  async endListing(): Promise<void> {
    throw new UnsupportedOperationError(this.marketplace, "endListing (assisted mode: the operator ends the listing)");
  }
}
