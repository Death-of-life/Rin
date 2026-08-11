type EncodeRequest = {
  id: number;
  imageData: ImageData;
};

type EncodeResponse =
  | { id: number; buffer: ArrayBuffer }
  | { id: number; error: string };

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const { id, imageData } = event.data;

  try {
    const { default: encode } = await import("@jsquash/avif/encode");
    const buffer = await encode(imageData, {
      bitDepth: 8,
      quality: 65,
      speed: 6,
    });
    const response: EncodeResponse = { id, buffer };
    self.postMessage(response, { transfer: [buffer] });
  } catch (error) {
    const response: EncodeResponse = {
      id,
      error: error instanceof Error ? error.message : "AVIF encoding failed",
    };
    self.postMessage(response);
  }
};

export {};
