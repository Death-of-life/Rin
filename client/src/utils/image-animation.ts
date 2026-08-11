const textDecoder = new TextDecoder("ascii");

function readAscii(bytes: Uint8Array, start: number, length: number) {
  return textDecoder.decode(bytes.subarray(start, start + length));
}

function readUint32BE(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function readUint32LE(bytes: Uint8Array, offset: number) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function skipGifSubBlocks(bytes: Uint8Array, start: number) {
  let offset = start;
  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;
    if (length === 0) {
      return offset;
    }
    offset += length;
  }
  return bytes.length;
}

function isAnimatedGif(bytes: Uint8Array) {
  if (bytes.length < 13 || !readAscii(bytes, 0, 6).startsWith("GIF8")) {
    return false;
  }

  let offset = 13;
  const packed = bytes[10];
  if ((packed & 0x80) !== 0) {
    offset += 3 * 2 ** ((packed & 0x07) + 1);
  }

  let frames = 0;
  while (offset < bytes.length) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      break;
    }
    if (marker === 0x21) {
      offset += 1;
      offset = skipGifSubBlocks(bytes, offset);
      continue;
    }
    if (marker !== 0x2c || offset + 9 > bytes.length) {
      break;
    }

    frames += 1;
    if (frames > 1) {
      return true;
    }

    const imagePacked = bytes[offset + 8];
    offset += 9;
    if ((imagePacked & 0x80) !== 0) {
      offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
    }
    offset += 1;
    offset = skipGifSubBlocks(bytes, offset);
  }

  return false;
}

function isAnimatedPng(bytes: Uint8Array) {
  if (bytes.length < 8 || readAscii(bytes, 1, 3) !== "PNG") {
    return false;
  }

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = readAscii(bytes, offset + 4, 4);
    if (type === "acTL") {
      return true;
    }
    if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  return false;
}

function isAnimatedWebp(bytes: Uint8Array) {
  if (
    bytes.length < 12 ||
    readAscii(bytes, 0, 4) !== "RIFF" ||
    readAscii(bytes, 8, 4) !== "WEBP"
  ) {
    return false;
  }

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = readAscii(bytes, offset, 4);
    const length = readUint32LE(bytes, offset + 4);
    if (type === "ANIM" || type === "ANMF") {
      return true;
    }
    offset += 8 + length + (length % 2);
  }
  return false;
}

function isAnimatedAvif(bytes: Uint8Array) {
  if (bytes.length < 16 || readAscii(bytes, 4, 4) !== "ftyp") {
    return false;
  }

  const boxSize = Math.min(readUint32BE(bytes, 0), bytes.length);
  if (readAscii(bytes, 8, 4) === "avis") {
    return true;
  }
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (readAscii(bytes, offset, 4) === "avis") {
      return true;
    }
  }
  return false;
}

export function isAnimatedImageBytes(bytes: Uint8Array, mimeType: string) {
  switch (mimeType) {
    case "image/gif":
      return isAnimatedGif(bytes);
    case "image/png":
      return isAnimatedPng(bytes);
    case "image/webp":
      return isAnimatedWebp(bytes);
    case "image/avif":
      return isAnimatedAvif(bytes);
    default:
      return false;
  }
}

export async function isAnimatedImage(file: File) {
  return isAnimatedImageBytes(new Uint8Array(await file.arrayBuffer()), file.type);
}
