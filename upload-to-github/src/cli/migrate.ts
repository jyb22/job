// Apply pending database migrations:  npm run migrate
import { existsSync } from "node:fs";
import path from "node:path";
import { migrate, openDatabase } from "../db";

if (existsSync(".env")) process.loadEnvFile(".env");
const file = path.join(path.resolve(process.env.DATA_DIR ?? "./data"), "resale-ops.db");
const db = openDatabase(file);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
console.log(`Database: ${file}`);
db.close();
