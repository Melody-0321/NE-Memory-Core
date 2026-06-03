// core/adapters/storage-fs.js — File system storage backend
//
// Node.js only. Uses fs.readFileSync / fs.writeFileSync.
// Each chatId maps to {dataDir}/{chatId}.json

import fs from 'node:fs';
import path from 'node:path';

export function createFSBackend(dataDir) {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    function filePath(chatId) {
        var safe = String(chatId).replace(/[<>:"/\\|?*]/g, '_');
        return path.join(dataDir, safe + '.json');
    }

    return {
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
