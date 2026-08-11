import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { BlobService, StorageService } from '../storage';
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { Variables, JWTUtils, CacheImpl } from "../../core/hono-types";
import { createMockDB, createMockEnv, cleanupTestDB } from '../../../tests/fixtures';
import type { Database } from 'bun:sqlite';

function createAvifFile(name = 'test.avif', animated = false, payload = 'test') {
    const bytes = new Uint8Array(24 + payload.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 24, false);
    bytes.set(new TextEncoder().encode('ftyp'), 4);
    bytes.set(new TextEncoder().encode(animated ? 'avis' : 'avif'), 8);
    bytes.set(new TextEncoder().encode('mif1avif'), 16);
    bytes.set(new TextEncoder().encode(payload), 24);
    return new File([bytes], name, { type: 'image/avif' });
}

// Simple cache implementation for tests
class TestCacheImpl implements CacheImpl {
    private data = new Map<string, any>();
    
    async get(key: string): Promise<any | null> {
        return this.data.get(key) ?? null;
    }
    
    async set(key: string, value: any, _save?: boolean): Promise<void> {
        this.data.set(key, value);
    }
    
    async delete(key: string, _save?: boolean): Promise<void> {
        this.data.delete(key);
    }
    
    async deletePrefix(prefix: string): Promise<void> {
        for (const key of this.data.keys()) {
            if (key.startsWith(prefix)) {
                this.data.delete(key);
            }
        }
    }
    
    async getOrSet<T>(key: string, factory: () => Promise<T>): Promise<T> {
        const cached = await this.get(key);
        if (cached !== null) return cached;
        const value = await factory();
        await this.set(key, value);
        return value;
    }
    
    async getOrDefault<T>(key: string, defaultValue: T): Promise<T> {
        const cached = await this.get(key);
        return cached !== null ? cached : defaultValue;
    }
    
    async getBySuffix(_suffix: string): Promise<any[]> {
        return [];
    }
    
    async all(): Promise<Map<string, any>> {
        return new Map(this.data);
    }
    
    async save(): Promise<void> {}
    async clear(): Promise<void> {
        this.data.clear();
    }
}

describe('StorageService', () => {
    let db: any;
    let sqlite: Database;
    let env: Env;
    let app: Hono<{ Bindings: Env; Variables: Variables }>;

    beforeEach(async () => {
        const mockDB = createMockDB();
        db = mockDB.db;
        sqlite = mockDB.sqlite;
        env = createMockEnv();

        app = new Hono<{ Bindings: Env; Variables: Variables }>();
        
        // Mock middleware to inject dependencies
        app.use(createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
            c.set('db', db);
            c.set('cache', new TestCacheImpl());
            c.set('serverConfig', new TestCacheImpl());
            c.set('clientConfig', new TestCacheImpl());
            c.set('jwt', {
                sign: async (payload: any) => `mock_token_${payload.id}`,
                verify: async (token: string) => token.startsWith('mock_token_') ? { id: 1 } : null,
            } as JWTUtils);
            c.set('oauth2', undefined);
            c.set('admin', false);
            c.set('env', env);
            c.set('uid', undefined);
            
            await next();
        }));

        // Mount service
        app.route('/', StorageService());
        app.route('/blob', BlobService());

        // Create test user
        await createTestUser();
    });

    afterEach(() => {
        cleanupTestDB(sqlite);
    });

    async function createTestUser() {
        sqlite.exec(`
            INSERT INTO users (id, username, openid, avatar, permission) 
            VALUES (1, 'testuser', 'gh_test', 'avatar.png', 1)
        `);
    }

    function createAppWithEnv(appEnv: Env, uid?: number) {
        const serviceApp = new Hono<{ Bindings: Env; Variables: Variables }>();
        serviceApp.use(createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
            c.set('db', db);
            c.set('cache', new TestCacheImpl());
            c.set('serverConfig', new TestCacheImpl());
            c.set('clientConfig', new TestCacheImpl());
            c.set('jwt', {
                sign: async (payload: any) => `mock_token_${payload.id}`,
                verify: async (token: string) => token.startsWith('mock_token_') ? { id: 1 } : null,
            } as JWTUtils);
            c.set('env', appEnv);
            c.set('uid', uid);
            await next();
        }));
        serviceApp.route('/', StorageService());
        serviceApp.route('/blob', BlobService());
        return serviceApp;
    }

    describe('POST / - Upload file', () => {
        it('should require authentication', async () => {
            const formData = new FormData();
            formData.append('file', new File(['test content'], 'test.txt', { type: 'text/plain' }));
            
            const res = await app.request('/', {
                method: 'POST',
                body: formData,
            }, env);

            // Could be 400 (validation) or 401 (auth)
            expect(res.status).toBeGreaterThanOrEqual(400);
            expect(res.status).toBeLessThanOrEqual(401);
        });

        it('should upload through R2 binding when configured', async () => {
            const putCalls: Array<{ key: string; type: string | undefined }> = [];
            const r2Env = createMockEnv({
                R2_BUCKET: {
                    put: async (key: string, value: any, options?: R2PutOptions) => {
                        putCalls.push({
                            key,
                            type: options?.httpMetadata && 'contentType' in options.httpMetadata
                                ? options.httpMetadata.contentType
                                : undefined,
                        });
                        return {
                            key,
                            version: '1',
                            size: value.size || 0,
                            etag: 'etag',
                            httpEtag: 'etag',
                            uploaded: new Date(),
                            storageClass: 'Standard',
                            checksums: {} as R2Checksums,
                            writeHttpMetadata: () => {},
                        } as unknown as R2Object;
                    },
                } as unknown as R2Bucket,
                S3_ACCESS_HOST: 'https://images.example.com' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const r2App = createAppWithEnv(r2Env, 1);
            const formData = new FormData();
            formData.append('key', 'untrusted.png');
            formData.append('file', createAvifFile());

            const res = await r2App.request('/', {
                method: 'POST',
                body: formData,
            }, r2Env);

            const duplicateFormData = new FormData();
            duplicateFormData.append('file', createAvifFile('duplicate.avif'));
            const duplicateRes = await r2App.request('/', {
                method: 'POST',
                body: duplicateFormData,
            }, r2Env);

            expect(res.status).toBe(200);
            expect(duplicateRes.status).toBe(200);
            expect(putCalls).toHaveLength(2);
            expect(putCalls[0]?.key).toBe(putCalls[1]?.key);
            expect(putCalls[0]?.key).toMatch(/^images\/[a-f0-9]{64}\.avif$/);
            expect(putCalls[0]?.type).toBe('image/avif');
            const payload = await res.json() as { url: string };
            expect(payload.url).toMatch(/^https:\/\/images\.example\.com\/images\/[a-f0-9]{64}\.avif$/);
        });

        it('should return an /api/blob URL when R2 is configured without S3_ACCESS_HOST', async () => {
            const putCalls: string[] = [];
            const r2Env = createMockEnv({
                R2_BUCKET: {
                    put: async (key: string) => {
                        putCalls.push(key);
                        return {
                            key,
                            version: '1',
                            size: 4,
                            etag: 'etag',
                            httpEtag: 'etag',
                            uploaded: new Date(),
                            storageClass: 'Standard',
                            checksums: {} as R2Checksums,
                            writeHttpMetadata: () => {},
                        } as unknown as R2Object;
                    },
                } as unknown as R2Bucket,
                S3_ACCESS_HOST: '' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const r2App = createAppWithEnv(r2Env, 1);
            const formData = new FormData();
            formData.append('file', createAvifFile());

            const res = await r2App.request('/', {
                method: 'POST',
                body: formData,
            }, r2Env);

            expect(res.status).toBe(200);
            expect(putCalls).toHaveLength(1);

            const payload = await res.json() as { url: string };
            expect(payload.url).toMatch(/^http:\/\/localhost\/api\/blob\/images\/[a-f0-9]{64}\.avif$/);
        });

        it('should reject non-AVIF uploads', async () => {
            const r2App = createAppWithEnv(env, 1);
            const formData = new FormData();
            formData.append('file', new File(['image'], 'test.png', { type: 'image/png' }));

            const res = await r2App.request('/', { method: 'POST', body: formData }, env);

            expect(res.status).toBe(400);
            expect(await res.text()).toBe('Only AVIF images are accepted');
        });

        it('should reject requests without a file', async () => {
            const r2App = createAppWithEnv(env, 1);
            const res = await r2App.request('/', {
                method: 'POST',
                body: new FormData(),
            }, env);

            expect(res.status).toBe(400);
            expect(await res.text()).toBe('No AVIF image uploaded');
        });

        it('should reject invalid and animated AVIF uploads', async () => {
            const r2App = createAppWithEnv(env, 1);

            for (const file of [
                new File(['not avif'], 'invalid.avif', { type: 'image/avif' }),
                createAvifFile('animated.avif', true),
            ]) {
                const formData = new FormData();
                formData.append('file', file);
                const res = await r2App.request('/', { method: 'POST', body: formData }, env);
                expect(res.status).toBe(400);
                expect(await res.text()).toBe('Invalid or animated AVIF image');
            }
        });

        it('should reject AVIF uploads larger than 5 MB', async () => {
            const r2App = createAppWithEnv(env, 1);
            const formData = new FormData();
            formData.append('file', new File(
                [new Uint8Array(5 * 1024 * 1024 + 1)],
                'large.avif',
                { type: 'image/avif' },
            ));

            const res = await r2App.request('/', { method: 'POST', body: formData }, env);

            expect(res.status).toBe(400);
            expect(await res.text()).toBe('AVIF image exceeds the 5 MB limit');
        });

        it('should return 500 when S3_ENDPOINT is not defined without R2 binding', async () => {
            const envNoS3 = createMockEnv({
                S3_ENDPOINT: '' as any,
            });
            const appNoS3 = createAppWithEnv(envNoS3, 1);

            const formData = new FormData();
            formData.append('file', createAvifFile());
            
            const res = await appNoS3.request('/', {
                method: 'POST',
                body: formData,
            }, envNoS3);

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('S3_ENDPOINT is not defined');
        });

        it('should return error when S3_ACCESS_KEY_ID is not defined without R2 binding', async () => {
            const envNoKey = createMockEnv({
                S3_ACCESS_KEY_ID: '',
            });
            const appNoKey = createAppWithEnv(envNoKey, 1);

            const formData = new FormData();
            formData.append('file', createAvifFile());
            
            const res = await appNoKey.request('/', {
                method: 'POST',
                body: formData,
            }, envNoKey);

            expect(res.status).toBe(500);
            expect(await res.text()).toBe('S3_ACCESS_KEY_ID is not defined');
        });
    });

    describe('GET /blob/* - Stream file', () => {
        it('should stream an R2 object through the blob route', async () => {
            const r2Env = createMockEnv({
                R2_BUCKET: {
                    get: async (key: string) => {
                        if (key !== 'images/test.txt') {
                            return null;
                        }

                        return {
                            key,
                            size: 4,
                            etag: 'etag',
                            httpEtag: 'etag',
                            uploaded: new Date('2025-01-01T00:00:00Z'),
                            storageClass: 'Standard',
                            checksums: {} as R2Checksums,
                            httpMetadata: { contentType: 'text/plain' },
                            writeHttpMetadata(headers: Headers) {
                                headers.set('Content-Type', 'text/plain');
                            },
                            body: new Blob(['test']).stream(),
                            bodyUsed: false,
                            arrayBuffer: async () => new TextEncoder().encode('test').buffer,
                            text: async () => 'test',
                            json: async () => ({ value: 'test' }),
                            blob: async () => new Blob(['test']),
                            bytes: async () => new Uint8Array(new TextEncoder().encode('test')),
                        } as unknown as R2ObjectBody;
                    },
                } as unknown as R2Bucket,
                S3_ACCESS_HOST: '' as any,
                S3_ENDPOINT: '' as any,
                S3_BUCKET: '' as any,
                S3_ACCESS_KEY_ID: '',
                S3_SECRET_ACCESS_KEY: '',
            });

            const r2App = createAppWithEnv(r2Env, 1);
            const res = await r2App.request('/blob/images/test.txt', { method: 'GET' }, r2Env);

            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toBe('text/plain');
            expect(res.headers.get('etag')).toBe('etag');
            expect(res.headers.get('content-length')).toBe('4');
            expect(await res.text()).toBe('test');
        });
    });
});
