import type { DB } from "../db";
import type { MarketplaceId } from "../core/types";
import { AppError } from "../core/util";
import type { MarketplaceAdapter } from "./adapter";
import { AssistedAdapter } from "./assisted";
import type { ConnectionStore } from "./connections";
import { DepopAdapter, type DepopConfig } from "./depop";
import { EbayAdapter, type EbayConfig } from "./ebay";
import { SimulatedAdapter } from "./simulated";
import { SPECS } from "./specs";

export interface RegistryConfig {
  ebay: EbayConfig;
  depop: DepopConfig;
}

/**
 * Chooses the adapter for a marketplace from its connection mode. Adding a
 * marketplace means adding one adapter class and one case here; nothing else
 * in the application changes.
 */
export class AdapterRegistry {
  private simulated = new Map<MarketplaceId, SimulatedAdapter>();
  private api = new Map<MarketplaceId, MarketplaceAdapter>();

  constructor(
    private db: DB,
    private connections: ConnectionStore,
    private cfg: RegistryConfig,
  ) {}

  /** Marketplaces for which an official-API adapter exists in this codebase. */
  hasApiAdapter(marketplace: MarketplaceId): boolean {
    return marketplace === "ebay" || marketplace === "depop";
  }

  get(marketplace: MarketplaceId): MarketplaceAdapter {
    const conn = this.connections.get(marketplace);
    switch (conn.mode) {
      case "simulated":
        return this.sim(marketplace);
      case "assisted":
        return new AssistedAdapter(marketplace);
      case "api": {
        if (!this.hasApiAdapter(marketplace)) {
          throw new AppError("no_api_adapter", `${SPECS[marketplace].name} has no API integration here: ${SPECS[marketplace].apiNotes}`, 400);
        }
        let adapter = this.api.get(marketplace);
        if (!adapter) {
          adapter = marketplace === "ebay" ? new EbayAdapter(this.cfg.ebay, this.connections) : new DepopAdapter(this.cfg.depop, this.connections);
          this.api.set(marketplace, adapter);
        }
        return adapter;
      }
      default:
        throw new AppError("marketplace_disabled", `${SPECS[marketplace].name} is disabled.`, 400);
    }
  }

  /** The simulated adapter instance (also exposes test/demo controls such as simulateSale). */
  sim(marketplace: MarketplaceId): SimulatedAdapter {
    let adapter = this.simulated.get(marketplace);
    if (!adapter) {
      adapter = new SimulatedAdapter(marketplace, this.db);
      this.simulated.set(marketplace, adapter);
    }
    return adapter;
  }

  ebay(): EbayAdapter {
    let adapter = this.api.get("ebay");
    if (!adapter) {
      adapter = new EbayAdapter(this.cfg.ebay, this.connections);
      this.api.set("ebay", adapter);
    }
    return adapter as EbayAdapter;
  }

  depop(): DepopAdapter {
    let adapter = this.api.get("depop");
    if (!adapter) {
      adapter = new DepopAdapter(this.cfg.depop, this.connections);
      this.api.set("depop", adapter);
    }
    return adapter as DepopAdapter;
  }
}
