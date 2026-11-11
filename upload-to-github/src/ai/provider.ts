import { z } from "zod";
import { CONDITIONS, type MarketplaceId } from "../core/types";

// The AI layer is behind this interface so providers can be swapped without
// touching the rest of the system. AI output is treated as a *proposal*:
// identification feeds deterministic validation, and listing text is checked
// by src/listings/guard.ts before it is accepted.

const attr = z.object({
  value: z.string().nullable().describe("The value, or null when it cannot be determined from the photos"),
  basis: z.enum(["visible", "inferred"]).describe("visible = directly readable/seen in a photo (tag, logo, label). inferred = an educated guess from appearance"),
  confidence: z.number().describe("0 to 1"),
});

export const identificationSchema = z.object({
  productType: attr.describe("e.g. t-shirt, hoodie, jeans, sneakers, handbag"),
  brand: attr,
  model: attr.describe("Product line / model name if identifiable"),
  styleNumber: attr.describe("Style / SKU / article number printed on a tag"),
  department: attr.describe("menswear, womenswear, kids or unisex"),
  size: attr.describe("Only from a visible size tag; otherwise null"),
  color: attr,
  material: attr.describe("Only from a visible fabric/care label unless clearly identifiable"),
  condition: z.object({
    value: z.enum(CONDITIONS).nullable(),
    basis: z.enum(["visible", "inferred"]),
    confidence: z.number(),
  }),
  defects: z.array(z.string()).describe("Visible damage, stains, wear, repairs. Empty if none visible."),
  accessories: z.array(z.string()).describe("Only items actually visible in the photos (box, dust bag, tags)."),
  visibleText: z.array(z.string()).describe("Text read from tags, labels and prints, verbatim"),
  authenticityConcerns: z.array(z.string()).describe("Anything suggesting the item may not be genuine. Empty if none."),
  views: z.array(z.enum(["front", "back", "tag_or_label", "detail", "defect", "side", "sole", "inside", "other"])).describe("One entry per photo, in order"),
  overallConfidence: z.number().describe("0 to 1: how confident you are in the product identity as a whole"),
  summary: z.string().describe("One factual sentence describing the item"),
});
export type Identification = z.infer<typeof identificationSchema> & { simulated?: boolean; provider?: string };

export interface ImageInput {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  base64: string;
}

/** Facts the listing writer is allowed to use. Nothing outside this object may appear in a listing. */
export interface ListingFacts {
  brand: string | null;
  model: string | null;
  productType: string | null;
  department: string | null;
  size: string | null;
  color: string | null;
  material: string | null;
  condition: string | null;
  conditionNotes: string | null;
  styleNumber: string | null;
  defects: string[];
  accessories: string[];
  measurements: Record<string, string>;
  notes: string | null;
}

export const listingTextSchema = z.object({
  listings: z.array(
    z.object({
      marketplace: z.string(),
      title: z.string(),
      description: z.string(),
      keywords: z.array(z.string()),
    }),
  ),
});

export interface ListingTextRequest {
  facts: ListingFacts;
  targets: { marketplace: MarketplaceId; titleMax: number; descriptionMax: number; style: string }[];
}

export interface ListingText {
  marketplace: MarketplaceId;
  title: string;
  description: string;
  keywords: string[];
}

export interface AiProvider {
  readonly name: string;
  /** True when this provider returns fabricated demo output. */
  readonly simulated: boolean;
  available(): boolean;
  identify(images: ImageInput[], operatorNotes?: string): Promise<Identification>;
  writeListings(request: ListingTextRequest): Promise<ListingText[]>;
}

export class AiUnavailableError extends Error {}
export class AiRefusalError extends Error {}
