import { describe, expect, it } from "vitest";
import {
  calculateTargetDimensions,
  ImageUploadError,
  getImageUploadErrorKey,
  isImageFile,
} from "../image-upload";

describe("image upload helpers", () => {
  it("downscales landscape and portrait images without upscaling small images", () => {
    expect(calculateTargetDimensions(5120, 2880)).toEqual({ width: 2560, height: 1440 });
    expect(calculateTargetDimensions(2880, 5120)).toEqual({ width: 1440, height: 2560 });
    expect(calculateTargetDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("accepts only supported raster source formats", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"]) {
      expect(isImageFile(new File(["image"], "image", { type }))).toBe(true);
    }
    expect(isImageFile(new File(["image"], "image.svg", { type: "image/svg+xml" }))).toBe(false);
  });

  it("maps typed failures to localized user-facing messages", () => {
    expect(getImageUploadErrorKey(new ImageUploadError("animated", "animated")))
      .toBe("upload.image.errors.animated");
    expect(getImageUploadErrorKey(new Error("unknown"))).toBe("upload.failed");
  });
});
