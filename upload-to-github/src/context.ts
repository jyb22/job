import type { DB } from "./db";
import type { SecretBox } from "./security/crypto";
import type { SettingsStore } from "./settings/store";
import type { AuditLog } from "./core/audit";
import type { NotificationService } from "./notifications/service";
import type { JobQueue } from "./jobs/queue";
import type { ConnectionStore } from "./marketplaces/connections";
import type { AdapterRegistry } from "./marketplaces/registry";
import type { AiProvider } from "./ai/provider";
import type { ProductService } from "./inventory/products";
import type { ResearchService } from "./research/service";
import type { ListingService } from "./listings/service";
import type { ApprovalService } from "./approvals/service";
import type { SalesService } from "./inventory/sales";
import type { Reconciler } from "./inventory/reconcile";
import type { Pipeline } from "./workflow/pipeline";
import type { Optimizer } from "./optimize/engine";
import type { AnalyticsService } from "./analytics/service";
import type { AuthService } from "./auth/service";

/** Everything a service may need. Built once in src/app.ts; tests build their own with an in-memory database. */
export interface Ctx {
  db: DB;
  dataDir: string;
  publicBaseUrl: string | null;
  box: SecretBox;
  settings: SettingsStore;
  audit: AuditLog;
  notifications: NotificationService;
  queue: JobQueue;
  connections: ConnectionStore;
  adapters: AdapterRegistry;
  ai: () => AiProvider;
  products: ProductService;
  research: ResearchService;
  listings: ListingService;
  approvals: ApprovalService;
  sales: SalesService;
  reconciler: Reconciler;
  pipeline: Pipeline;
  optimizer: Optimizer;
  analytics: AnalyticsService;
  auth: AuthService;
}
