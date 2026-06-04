// core/adapters/storage-fs.js — File system storage backend
//
// Node.js only. Uses fs.readFileSync / fs.writeFileSync.
//
// Storage layout:
//   Without namespace: {dataDir}/{chatId}.json        (flat, backward compatible)
//   With namespace:    {dataDir}/{namespace}/{chatId}.json  (per-project isolation)
//
// Namespace is optional: non-Trae scenarios omit it for flat storage.

import fs from 'node:fs';
import path from 'node:path';

export function createFSBackend(dataDir, namespace) {
    // namespace is optional — when provided, vaults go into a subdirectory
    // e.g. namespace = "6028f08a..." (Trae workspace hash)
    var baseDir = namespace ? path.join(dataDir, namespace) : dataDir;

    if (!fs.existsSync(baseDir)) {
        fs.mkdirSync(baseDir, { recursive: true });
    }

    function filePath(chatId) {
        var safe = String(chatId).replace(/[<>:"/\\|?*]/g, '_');
        return path.join(baseDir, safe + '.json');
    }

    return {
        // Expose for tiered search to discover chat_ids within this namespace
        baseDir: baseDir,
        namespace: namespace || null,

        read: async function(chatId) {
            var fp = filePath(chatId);
            if (!fs.existsSync(fp)) return null;
            try {
                var raw = fs.readFileSync(fp, 'utf-8');
                return JSON.parse(raw);
            } catch (e) {
                console.error('[core/storage-fs] read failed:', chatId, e.message);
                return null;
            }
        },
        write: async function(chatId, vault) {
            var fp = filePath(chatId);
            try {
                fs.writeFileSync(fp, JSON.stringify(vault, null, 2), 'utf-8');
            } catch (e) {
                console.error('[core/storage-fs] write failed:', chatId, e.message);
                throw e;
            }
        },
        remove: async function(chatId) {
            var fp = filePath(chatId);
            try {
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            } catch (e) {
                console.error('[core/storage-fs] remove failed:', chatId, e.message);
            }
        }
    };
}
