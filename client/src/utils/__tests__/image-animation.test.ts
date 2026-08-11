import { describe, expect, it } from "vitest";
import { isAnimatedImageBytes } from "../image-animation";

const encoder = new TextEncoder();

function gifWithFrames(frameCount: number) {
  const header = [...encoder.encode("GIF89a"), 1, 0, 1, 0, 0, 0, 0];
  const frame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0];
  return new Uint8Array([...header, ...Array.from({ length: frameCount }, () => frame).flat(), 0x3b]);
}

function avifWithBrand(brand: "avif" | "avis") {
  const bytes = new Uint8Array(24);
  new DataView(bytes.buffer).setUint32(0, 24, false);
  bytes.set(encoder.encode("ftyp"), 4);
  bytes.set(encoder.encode(brand), 8);
  bytes.set(encoder.encode("mif1avif"), 16);
  return bytes;
}

describe("isAnimatedImageBytes", () => {
  it("distinguishes static and animated GIF files", () => {
    expect(isAnimatedImageBytes(gifWithFrames(1), "image/gif")).toBe(false);
    expect(isAnimatedImageBytes(gifWithFrames(2), "image/gif")).toBe(true);
  });

  it("detects animated PNG and WebP containers", () => {
    const png = new Uint8Array([
      0x89, ...encoder.encode("PNG"), 0x0d, 0x0a, 0x1a, 0x0a,
      0, 0, 0, 0, ...encoder.encode("acTL"), 0, 0, 0, 0,
    ]);
    const webp = new Uint8Array([
      ...encoder.encode("RIFF"), 4, 0, 0, 0, ...encoder.encode("WEBP"),
      ...encoder.encode("ANIM"), 0, 0, 0, 0,
    ]);

    expect(isAnimatedImageBytes(png, "image/png")).toBe(true);
    expect(isAnimatedImageBytes(webp, "image/webp")).toBe(true);
  });

  it("rejects the animated AVIF sequence brand", () => {
    expect(isAnimatedImageBytes(avifWithBrand("avif"), "image/avif")).toBe(false);
    expect(isAnimatedImageBytes(avifWithBrand("avis"), "image/avif")).toBe(true);
  });
});
