import { AiUnavailableError, type AiProvider, type Identification, type ImageInput, type ListingText, type ListingTextRequest } from "./provider";

// SIMULATED provider for the demo and automated tests. It does not look at
// the photographs at all: it returns a fixed sample item so the rest of the
// pipeline can be exercised without an API key. Its output is always marked
// `simulated: true`, and the policy layer refuses to auto-publish a product
// identified this way to a real marketplace.

const seen = (value: string, confidence = 0.95) => ({ value, basis: "visible" as const, confidence });
const guess = (value: string, confidence = 0.7) => ({ value, basis: "inferred" as const, confidence });
const none = { value: null, basis: "inferred" as const, confidence: 0 };

export const SAMPLE_IDENTIFICATION: Identification = {
  productType: seen("t-shirt"),
  brand: seen("Nike"),
  model: guess("Sportswear Club Tee", 0.72),
  styleNumber: seen("AR4997-013", 0.9),
  department: guess("menswear", 0.85),
  size: seen("M"),
  color: seen("black"),
  material: seen("100% cotton", 0.9),
  condition: { value: "excellent", basis: "inferred", confidence: 0.8 },
  defects: ["Light fading on the collar"],
  accessories: [],
  visibleText: ["NIKE", "M", "AR4997-013", "100% COTTON"],
  authenticityConcerns: [],
  views: ["front"],
  overallConfidence: 0.9,
  summary: "Black Nike Sportswear cotton t-shirt, men's size M, in excellent used condition with light collar fading.",
  simulated: true,
  provider: "simulated",
};

export class SimulatedAiProvider implements AiProvider {
  readonly name = "simulated";
  readonly simulated = true;
  /** Tests can replace the fixture to exercise low-confidence and high-risk paths. */
  fixture: Identification = SAMPLE_IDENTIFICATION;

  available(): boolean {
    return true;
  }

  async identify(images: ImageInput[]): Promise<Identification> {
    const views = images.map((_, i) => (["front", "back", "tag_or_label", "detail"] as const)[i] ?? "other");
    return { ...this.fixture, views, simulated: true, provider: "simulated" };
  }

  async writeListings(_request: ListingTextRequest): Promise<ListingText[]> {
    // The deterministic template writer is used instead; returning nothing signals "no AI text".
    return [];
  }
}

/** Used when no provider is configured: every call fails cleanly and the product goes to manual identification. */
export class NoAiProvider implements AiProvider {
  readonly name = "none";
  readonly simulated = false;
  available(): boolean {
    return false;
  }
  async identify(): Promise<Identification> {
    throw new AiUnavailableError("No AI provider is configured");
  }
  async writeListings(): Promise<ListingText[]> {
    return [];
  }
}

export { none as EMPTY_ATTRIBUTE };
