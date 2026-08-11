type EncodeResponse =
  | { id: number; buffer: ArrayBuffer }
  | { id: number; error: string };

type PendingRequest = {
  resolve: (buffer: ArrayBuffer) => void;
  reject: (error: Error) => void;
};

let worker: Worker | undefined;
let nextRequestId = 0;
const pendingRequests = new Map<number, PendingRequest>();

function rejectPendingRequests(message: string) {
  for (const { reject } of pendingRequests.values()) {
    reject(new Error(message));
  }
  pendingRequests.clear();
}

function getWorker() {
  if (worker) {
    return worker;
  }

  worker = new Worker(new URL("./avif-compression.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<EncodeResponse>) => {
    const request = pendingRequests.get(event.data.id);
    if (!request) {
      return;
    }
    pendingRequests.delete(event.data.id);
    if ("error" in event.data) {
      request.reject(new Error(event.data.error));
      return;
    }
    request.resolve(event.data.buffer);
  };
  worker.onerror = () => {
    rejectPendingRequests("AVIF encoding worker failed");
    worker?.terminate();
    worker = undefined;
  };

  return worker;
}

export function encodeImageDataAsAvif(imageData: ImageData) {
  const id = nextRequestId++;
  const encoder = getWorker();

  return new Promise<ArrayBuffer>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    encoder.postMessage({ id, imageData }, [imageData.data.buffer]);
  });
}
