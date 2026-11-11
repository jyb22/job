// Consistent online backup of the database:  npm run backup
// Photos live in DATA_DIR/images and should be backed up alongside (rsync or similar).
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../db";

if (existsSync(".env")) process.loadEnvFile(".env");
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const dir = path.join(dataDir, "backups");
mkdirSync(dir, { recursive: true });
const target = path.join(dir, `resale-ops-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
const db = openDatabase(path.join(dataDir, "resale-ops.db"));
await db.backup(target);
db.close();
console.log(`Backup written to ${target}`);
