import sharp from "sharp";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "../core/util";
import type { Settings } from "../settings/schema";

const run = promisify(execFile);

export interface ImageAnalysis {
  sha256: string;
  phash: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  blurScore: number;
  brightness: number;
  issues: string[];
}

export interface StoredImage extends ImageAnalysis {
  originalPath: string;
  optimizedPath: string;
}

const ACCEPTED = new Set(["jpeg", "png", "webp", "heif", "avif", "tiff", "gif"]);

export const HEIC_UNSUPPORTED = "HEIC photos can only be read when the server runs on macOS. Export the photo as JPEG and upload that.";

/**
 * iPhone photos are usually HEIC (HEVC-compressed), which the bundled image
 * library cannot decode. On macOS the system's own `sips` tool converts them
 * to JPEG; elsewhere the upload is refused with a clear message. The returned
 * buffer is only used for analysis and the listing copy — the original bytes
 * are still what gets stored as the original.
 */
async function decodable(buffer: Buffer): Promise<Buffer> {
  const meta = await sharp(buffer, { failOn: "error" }).metadata();
  if (meta.format !== "heif" || meta.compression !== "hevc") return buffer;
  if (process.platform !== "darwin") throw new Error(HEIC_UNSUPPORTED);
  const dir = await mkdtemp(path.join(tmpdir(), "resale-heic-"));
  try {
    const input = path.join(dir, "in.heic");
    const output = path.join(dir, "out.jpg");
    await writeFile(input, buffer);
    await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "95", input, "--out", output], { timeout: 30000 });
    return await readFile(output);
  } catch {
    throw new Error("This HEIC photo could not be converted. Export it as JPEG and upload that.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Inspect an uploaded photo without changing it. Throws if it is not a readable image. */
export async function analyzeImage(original: Buffer, settings: Settings["images"]): Promise<ImageAnalysis> {
  const buffer = await decodable(original);
  const analysis = await analyzeDecoded(buffer, settings);
  // Identity (hash, size, format) always describes the file that was actually uploaded.
  return { ...analysis, sha256: sha256Hex(original), bytes: original.length, format: buffer === original ? analysis.format : "heic" };
}

async function analyzeDecoded(buffer: Buffer, settings: Settings["images"]): Promise<ImageAnalysis> {
  const meta = await sharp(buffer, { failOn: "error" }).metadata();
  if (!meta.format || !ACCEPTED.has(meta.format) || !meta.width || !meta.height) throw new Error("Unsupported or unreadable image file");

  // EXIF orientations 5-8 swap width and height once the image is auto-rotated.
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = rotated ? meta.height : meta.width;
  const height = rotated ? meta.width : meta.height;

  // Sharpness: variance of the Laplacian on a normalised greyscale copy.
  const grey = sharp(buffer).rotate().greyscale().resize(512, 512, { fit: "inside" });
  const lap = await grey
    .clone()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], scale: 1, offset: 128 })
    .raw()
    .toBuffer();
  let sum = 0;
  let sumSq = 0;
  for (const px of lap) {
    sum += px;
    sumSq += px * px;
  }
  const mean = sum / lap.length;
  const blurScore = Math.round((sumSq / lap.length - mean * mean) * 10) / 10;

  const stats = await grey.clone().stats();
  const brightness = Math.round(stats.channels[0]!.mean);

  // Difference hash: 9x8 greyscale, each bit says whether a pixel is brighter than its right-hand neighbour.
  const small = await sharp(buffer).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += small[y * 9 + x]! > small[y * 9 + x + 1]! ? "1" : "0";
  const phash = BigInt("0b" + bits).toString(16).padStart(16, "0");

  const issues: string[] = [];
  if (Math.min(width, height) < settings.minDimension) issues.push("too_small");
  if (blurScore < settings.blurThreshold) issues.push("blurry");
  if (brightness < 40) issues.push("too_dark");
  if (brightness > 235) issues.push("overexposed");

  return { sha256: sha256Hex(buffer), phash, width, height, bytes: buffer.length, format: meta.format, blurScore, brightness, issues };
}

/**
 * Keep the original untouched and write a separate marketplace-ready copy:
 * auto-oriented, resized to fit, stripped of metadata (which can include GPS
 * location), compressed as JPEG. Nothing is retouched — defects stay visible.
 */
export async function storeImage(buffer: Buffer, dir: string, id: string, settings: Settings["images"]): Promise<StoredImage> {
  const analysis = await analyzeImage(buffer, settings);
  const originals = path.join(dir, "originals");
  const optimized = path.join(dir, "optimized");
  await mkdir(originals, { recursive: true });
  await mkdir(optimized, { recursive: true });
  const ext = analysis.format === "jpeg" ? "jpg" : analysis.format;
  const originalPath = path.join(originals, `${id}.${ext}`);
  const optimizedPath = path.join(optimized, `${id}.jpg`);
  await writeFile(originalPath, buffer);
  await sharp(await decodable(buffer))
    .rotate()
    .resize(settings.maxDimension, settings.maxDimension, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: settings.jpegQuality, mozjpeg: true })
    .toFile(optimizedPath);
  return { ...analysis, originalPath, optimizedPath };
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let n = 0;
  while (x > 0n) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

const ESSENTIAL_VIEWS = ["front", "back", "tag_or_label"];

/** Which essential photos appear to be missing, given the view labels known so far. */
export function missingViews(viewLabels: (string | null)[], imageCount: number): string[] {
  const known = new Set(viewLabels.filter((v): v is string => !!v));
  if (known.size === 0) {
    // No labels yet (no vision pass): fall back to a simple count-based suggestion.
    return imageCount >= 3 ? [] : ESSENTIAL_VIEWS.slice(imageCount);
  }
  return ESSENTIAL_VIEWS.filter((v) => !known.has(v));
}
