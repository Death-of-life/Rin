import { Hono } from "hono";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { getStorageObject, putStorageObject } from "../utils/storage";

export const MAX_AVIF_FILE_SIZE = 5 * 1024 * 1024;

function buf2hex(buffer: ArrayBuffer) {
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}

function readAscii(bytes: Uint8Array, start: number, length: number) {
    return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function isStaticAvif(bytes: Uint8Array) {
    if (bytes.length < 16 || readAscii(bytes, 4, 4) !== "ftyp") {
        return false;
    }

    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
    if (boxSize < 16 || boxSize > bytes.length) {
        return false;
    }

    let hasAvifBrand = false;
    const majorBrand = readAscii(bytes, 8, 4);
    if (majorBrand === "avis") {
        return false;
    }
    if (majorBrand === "avif") {
        hasAvifBrand = true;
    }
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
        const brand = readAscii(bytes, offset, 4);
        if (brand === "avis") {
            return false;
        }
        if (brand === "avif") {
            hasAvifBrand = true;
        }
    }
    return hasAvifBrand;
}

export function StorageService(): Hono {
    const app = new Hono();

    // POST /storage
    app.post('/', async (c: AppContext) => {
        const uid = c.get('uid');
        const env = c.get('env');

        if (!uid) {
            return c.text('Unauthorized', 401);
        }

        const body = await profileAsync(c, 'storage_parse', () => c.req.parseBody());
        const file = body.file;
        if (!(file instanceof File)) {
            return c.text('No AVIF image uploaded', 400);
        }
        if (file.type !== 'image/avif') {
            return c.text('Only AVIF images are accepted', 400);
        }
        if (file.size > MAX_AVIF_FILE_SIZE) {
            return c.text('AVIF image exceeds the 5 MB limit', 400);
        }

        const fileBuffer = await profileAsync(c, 'storage_file_buffer', () => file.arrayBuffer());
        const fileBytes = new Uint8Array(fileBuffer);
        if (!isStaticAvif(fileBytes)) {
            return c.text('Invalid or animated AVIF image', 400);
        }

        const hashArray = await profileAsync(c, 'storage_hash', () => crypto.subtle.digest(
            { name: 'SHA-256' },
            fileBuffer
        ));
        const hash = buf2hex(hashArray);
        const hashkey = `${hash}.avif`;
        
        try {
            const result = await profileAsync(c, 'storage_put', () => putStorageObject(
                env,
                hashkey,
                fileBytes,
                'image/avif',
                new URL(c.req.url).origin,
            ));
            return c.json({ url: result.url });
        } catch (e: any) {
            console.error(e.message);
            const status = e.message?.includes('is not defined') ? 500 : 400;
            return c.text(e.message, status);
        }
    });

    return app;
}

export function BlobService(): Hono {
    const app = new Hono();

    app.get("/*", async (c: AppContext) => {
        const env = c.get("env");
        const key = c.req.path.replace(/^\/blob\/?/, "");

        if (!key) {
            return c.text("Blob key is required", 400);
        }

        try {
            const response = await profileAsync(c, "blob_fetch", () => getStorageObject(env, decodeURIComponent(key)));

            if (!response) {
                return c.text("Not found", 404);
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (error) {
            console.error("Blob fetch failed:", error);
            return c.text("Blob fetch failed", 500);
        }
    });

    return app;
}
