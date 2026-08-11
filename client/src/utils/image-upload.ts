import { client } from "../app/runtime";
import { encodeImageDataAsAvif } from "./avif-compression";
import { encodeBlurhash } from "./blurhash";
import { isAnimatedImage } from "./image-animation";

export const DEFAULT_IMAGE_MAX_FILE_SIZE = 5 * 1024 * 1024;
export const AVIF_MAX_DIMENSION = 2560;
export const AVIF_MAX_FILE_SIZE = 5 * 1024 * 1024;

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type ImageUploadStage = "reading" | "compressing" | "uploading";

export type ImageUploadOptions = {
  maxSourceBytes?: number;
  onStage?: (stage: ImageUploadStage) => void;
};

export type ImageUploadErrorCode =
  | "animated"
  | "encode_failed"
  | "invalid_image"
  | "invalid_type"
  | "output_too_large"
  | "source_too_large"
  | "unsupported";

export class ImageUploadError extends Error {
  constructor(public code: ImageUploadErrorCode, message: string) {
    super(message);
    this.name = "ImageUploadError";
  }
}

export type UploadedImageResult = {
  url: string;
  blurhash?: string;
  width?: number;
  height?: number;
  compressedSize?: number;
};

type ImageMetadata = {
  blurhash?: string;
  width?: number;
  height?: number;
};

type MarkdownImageMetadataResult = {
  content: string;
  updated: number;
  failed: number;
};

export function isImageFile(file: File) {
  return SUPPORTED_IMAGE_TYPES.has(file.type);
}

export function getImageUploadErrorKey(error: unknown) {
  return error instanceof ImageUploadError
    ? `upload.image.errors.${error.code}`
    : "upload.failed";
}

export function calculateTargetDimensions(width: number, height: number, maxDimension = AVIF_MAX_DIMENSION) {
  const longestSide = Math.max(width, height);
  if (longestSide <= maxDimension) {
    return { width, height };
  }

  const scale = maxDimension / longestSide;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function toPositiveInteger(value?: string | null) {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function attachImageMetadataToUrl(url: string, metadata: ImageMetadata = {}) {
  const { blurhash, width, height } = metadata;
  if (!blurhash && !width && !height) {
    return url;
  }

  const [baseUrl, fragment = ""] = url.split("#", 2);
  const params = new URLSearchParams(fragment);
  if (blurhash) {
    params.set("blurhash", blurhash);
  }
  if (width) {
    params.set("width", String(width));
  }
  if (height) {
    params.set("height", String(height));
  }
  return `${baseUrl}#${params.toString()}`;
}

export function parseImageUrlMetadata(url?: string | null) {
  if (!url) {
    return {
      src: "",
      blurhash: undefined as string | undefined,
    };
  }

  const [src, fragment = ""] = url.split("#", 2);
  const params = new URLSearchParams(fragment);

  return {
    src,
    blurhash: params.get("blurhash") || undefined,
    width: toPositiveInteger(params.get("width")),
    height: toPositiveInteger(params.get("height")),
  };
}

export function stripImageUrlMetadata(url?: string | null) {
  return parseImageUrlMetadata(url).src;
}

export function buildMarkdownImage(fileName: string, url: string, metadata: ImageMetadata = {}) {
  const safeAlt = fileName.replace(/[[\]]/g, "");
  const safeUrl = url.replace(/\s/g, "%20");
  return `![${safeAlt}](${attachImageMetadataToUrl(safeUrl, metadata)})\n`;
}

async function loadImage(file: File) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Failed to load image"));
      element.src = objectUrl;
    });
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function createBlurhash(canvas: HTMLCanvasElement) {
  const longestSide = Math.max(canvas.width, canvas.height);
  const scale = Math.min(1, 48 / longestSide);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const previewCanvas = document.createElement("canvas");
  previewCanvas.width = width;
  previewCanvas.height = height;
  const context = previewCanvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return undefined;
  }

  context.drawImage(canvas, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return encodeBlurhash(imageData.data, width, height, 4, 3);
}

async function compressImageFile(
  file: File,
  maxSourceBytes: number,
  onStage?: (stage: ImageUploadStage) => void,
) {
  if (!isImageFile(file)) {
    throw new ImageUploadError("invalid_type", "Unsupported image type");
  }
  if (file.size > maxSourceBytes) {
    throw new ImageUploadError("source_too_large", "Source image is too large");
  }
  if (await isAnimatedImage(file)) {
    throw new ImageUploadError("animated", "Animated images are not supported");
  }

  let image: HTMLImageElement;
  try {
    image = await loadImage(file);
  } catch {
    throw new ImageUploadError("invalid_image", "The image could not be decoded");
  }

  if (!image.naturalWidth || !image.naturalHeight) {
    throw new ImageUploadError("invalid_image", "The image has invalid dimensions");
  }

  const dimensions = calculateTargetDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new ImageUploadError("unsupported", "Canvas image processing is unavailable");
  }

  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  const blurhash = createBlurhash(canvas);
  const imageData = context.getImageData(0, 0, dimensions.width, dimensions.height);

  if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") {
    throw new ImageUploadError("unsupported", "This browser cannot encode AVIF images");
  }

  onStage?.("compressing");
  let buffer: ArrayBuffer;
  try {
    buffer = await encodeImageDataAsAvif(imageData);
  } catch {
    throw new ImageUploadError("encode_failed", "AVIF encoding failed");
  }

  if (buffer.byteLength > AVIF_MAX_FILE_SIZE) {
    throw new ImageUploadError("output_too_large", "Compressed AVIF is too large");
  }

  const baseName = file.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]+/g, "-") || "image";
  return {
    file: new File([buffer], `${baseName}.avif`, { type: "image/avif" }),
    blurhash,
    width: dimensions.width,
    height: dimensions.height,
  };
}

async function loadImageFromUrl(url: string) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.crossOrigin = "anonymous";
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    element.src = url;
  });
  return image;
}

export async function generateImageMetadata(file: File) {
  if (!isImageFile(file)) {
    return {};
  }

  const image = await loadImage(file);
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longestSide) {
    return {};
  }

  const scale = Math.min(1, 48 / longestSide);
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {};
  }

  context.drawImage(image, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  return {
    blurhash: encodeBlurhash(imageData.data, width, height, 4, 3),
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
}

export async function generateImageMetadataFromUrl(url: string): Promise<ImageMetadata> {
  const { src, blurhash, width, height } = parseImageUrlMetadata(url);
  if (blurhash && width && height) {
    return { blurhash, width, height };
  }

  const image = await loadImageFromUrl(src);
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (!longestSide) {
    return {
      blurhash,
      width: width || undefined,
      height: height || undefined,
    };
  }

  const scale = Math.min(1, 48 / longestSide);
  const canvas = document.createElement("canvas");
  const canvasWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const canvasHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return {
      blurhash,
      width: width || image.naturalWidth || undefined,
      height: height || image.naturalHeight || undefined,
    };
  }

  context.drawImage(image, 0, 0, canvasWidth, canvasHeight);
  const imageData = context.getImageData(0, 0, canvasWidth, canvasHeight);

  return {
    blurhash: blurhash || encodeBlurhash(imageData.data, canvasWidth, canvasHeight, 4, 3),
    width: width || image.naturalWidth || undefined,
    height: height || image.naturalHeight || undefined,
  };
}

export async function enrichMarkdownImageMetadata(content: string): Promise<MarkdownImageMetadataResult> {
  const markdownPattern = /!\[(.*?)\]\((\S+?)(?:\s+"[^"]*")?\)/g;
  const htmlPattern = /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*?)>/gi;
  const markdownMatches = [...content.matchAll(markdownPattern)].map((match) => ({
    type: "markdown" as const,
    fullMatch: match[0],
    alt: match[1] || "",
    rawUrl: match[2],
  }));
  const htmlMatches = [...content.matchAll(htmlPattern)].map((match) => ({
    type: "html" as const,
    fullMatch: match[0],
    beforeSrc: match[1] || "",
    rawUrl: match[2],
    afterSrc: match[3] || "",
  }));
  const matches = [...markdownMatches, ...htmlMatches];

  if (matches.length === 0) {
    return { content, updated: 0, failed: 0 };
  }

  let nextContent = content;
  let updated = 0;
  let failed = 0;

  for (const match of matches) {
    const { fullMatch, rawUrl } = match;
    if (!fullMatch || !rawUrl) {
      continue;
    }

    const existing = parseImageUrlMetadata(rawUrl);
    if (existing.blurhash && existing.width && existing.height) {
      continue;
    }

    try {
      const metadata = await generateImageMetadataFromUrl(rawUrl);
      if (!metadata.blurhash || !metadata.width || !metadata.height) {
        failed += 1;
        continue;
      }

      const nextUrl = attachImageMetadataToUrl(existing.src, metadata);
      const replacement = match.type === "markdown"
        ? `![${match.alt}](${nextUrl})`
        : `<img${match.beforeSrc}src="${nextUrl}"${match.afterSrc}>`;
      if (replacement !== fullMatch) {
        nextContent = nextContent.replace(fullMatch, replacement);
        updated += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    content: nextContent,
    updated,
    failed,
  };
}

export async function uploadImageFile(
  file: File,
  options: ImageUploadOptions = {},
): Promise<UploadedImageResult> {
  const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_IMAGE_MAX_FILE_SIZE;
  options.onStage?.("reading");

  const compressed = await compressImageFile(file, maxSourceBytes, options.onStage);

  options.onStage?.("uploading");
  const { data, error } = await client.storage.upload(compressed.file, compressed.file.name);
  if (error) {
    throw new Error(error.value);
  }

  const url =
    typeof data === "string"
      ? data
      : data?.url;

  if (!url) {
    throw new Error("Invalid upload response");
  }

  return {
    url,
    blurhash: compressed.blurhash,
    width: compressed.width,
    height: compressed.height,
    compressedSize: compressed.file.size,
  };
}
