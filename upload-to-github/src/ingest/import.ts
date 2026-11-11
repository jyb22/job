import ExcelJS from "exceljs";
import type { Ctx } from "../context";
import type { Actor } from "../core/types";
import { AppError, toCents } from "../core/util";
import type { ProductInput } from "../inventory/products";
import { cleanLine, looksLikeInstruction } from "../security/sanitize";

// Bulk import from CSV or Excel. Cell contents are untrusted text: they are
// cleaned, length-capped, and can only ever land in product data fields.

const HEADER_ALIASES: Record<string, keyof ProductInput | "cost" | "min_price" | "type"> = {
  title: "title", name: "title", item: "title", "item name": "title", product: "title",
  brand: "brand", model: "model", "model name": "model",
  category: "category", type: "category", "product type": "category", "item type": "category",
  department: "department", gender: "department",
  size: "size", color: "color", colour: "color", material: "material", fabric: "material",
  condition: "condition", "condition notes": "condition_notes", flaws: "condition_notes", defects: "condition_notes",
  "style number": "style_number", style: "style_number", "style #": "style_number",
  upc: "upc", barcode: "upc", ean: "upc",
  notes: "notes", description: "notes",
  location: "storage_location", "storage location": "storage_location", bin: "storage_location",
  cost: "cost", "acquisition cost": "cost", "purchase price": "cost", cogs: "cost", "cost of goods": "cost",
  "min price": "min_price", "minimum price": "min_price", floor: "min_price",
  quantity: "quantity", qty: "quantity",
};

/** RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

async function parseXlsx(buffer: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) return [];
  const rows: string[][] = [];
  sheet.eachRow((r) => {
    const values = (r.values as unknown[]).slice(1).map((v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "object") {
        const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
        // Formula cells contribute their computed value only; the formula itself is never used.
        return String(o.text ?? o.result ?? o.richText?.map((t) => t.text).join("") ?? "");
      }
      return String(v);
    });
    rows.push(values);
  });
  return rows;
}

export interface ImportResult {
  created: { id: string; sku: string; title: string | null }[];
  skipped: { row: number; reason: string }[];
  unmappedColumns: string[];
}

export async function importSpreadsheet(ctx: Ctx, buffer: Buffer, filename: string, actor: Actor): Promise<ImportResult> {
  const rows = /\.xlsx$/i.test(filename) ? await parseXlsx(buffer) : parseCsv(buffer.toString("utf8"));
  if (rows.length < 2) throw new AppError("empty_file", "The file has no data rows.", 400);
  if (rows.length > 2001) throw new AppError("too_many_rows", "Import at most 2,000 rows at a time.", 400);
  const header = rows[0]!.map((h) => cleanLine(h, 60).toLowerCase());
  const mapping = header.map((h) => HEADER_ALIASES[h] ?? null);
  const unmappedColumns = header.filter((h, i) => h && !mapping[i]);
  if (!mapping.some(Boolean)) throw new AppError("no_columns", "None of the column headings were recognised. Expected headings such as Brand, Type, Size, Condition, Cost.", 400);

  const result: ImportResult = { created: [], skipped: [], unmappedColumns };
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    const input: ProductInput = {};
    let suspicious = false;
    cells.forEach((raw, i) => {
      const key = mapping[i];
      const value = cleanLine(raw, key === "notes" ? 1000 : 200);
      if (!key || !value) return;
      if (looksLikeInstruction(value)) suspicious = true;
      if (key === "cost") input.acquisition_cost_cents = toCents(value);
      else if (key === "min_price") input.min_price_cents = toCents(value);
      else if (key === "quantity") input.quantity = Math.max(1, Math.min(9999, parseInt(value, 10) || 1));
      else (input as Record<string, unknown>)[key] = value;
    });
    if (!input.title && !input.brand && !input.category) {
      result.skipped.push({ row: r + 1, reason: "No title, brand or type" });
      continue;
    }
    const product = ctx.products.create(input, actor, "import");
    if (suspicious) ctx.products.refreshRisk(product.id);
    result.created.push({ id: product.id, sku: product.sku, title: product.title ?? ([product.brand, product.category].filter(Boolean).join(" ") || null) });
  }
  ctx.audit.record({ actor, action: "import.completed", detail: { filename: cleanLine(filename, 120), created: result.created.length, skipped: result.skipped.length, unmappedColumns } });
  return result;
}
