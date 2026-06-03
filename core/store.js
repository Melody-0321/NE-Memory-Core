// core/store.js — Vault data operations (storage-backend agnostic)
//
// Provides all data manipulation functions. I/O is delegated to an
// injected storage backend (adapters/storage-fs.js, storage-indexeddb.js, etc.)
//
// Init via: initStore(backend) where backend implements { read, write, remove }(chatId).

var _backend = null;

// Simple LRU cache: holds last N vaults in memory to avoid redundant reads
var CACHE_MAX = 3;
var CACHE_TTL_MS = 5000;
var _cache = [];

function cacheGet(chatId) {
    var now = Date.now();
    for (var i = 0; i < _cache.length; i++) {
        if (_cache[i].chatId === chatId) {
            var entry = _cache.splice(i, 1)[0];
            if (now - entry.ts < CACHE_TTL_MS) {
                _cache.unshift(entry);
                return entry.vault;
            }
            // expired, leave it removed
            break;
        }
    }
    return null;
}

function cacheSet(chatId, vault) {
    // Remove existing entry if any
    for (var i = 0; i < _cache.length; i++) {
        if (_cache[i].chatId === chatId) {
            _cache.splice(i, 1);
            break;
        }
    }
    // Trim to max size
    while (_cache.length >= CACHE_MAX) {
        _cache.pop();
    }
    _cache.unshift({ chatId: chatId, vault: vault, ts: Date.now() });
}

function cacheInvalidate(chatId) {
    for (var i = 0; i < _cache.length; i++) {
        if (_cache[i].chatId === chatId) {
            _cache.splice(i, 1);
            return;
        }
    }
}

export function initStore(backend) {
    _backend = backend;
}

function ensureBackend() {
    if (!_backend) throw new Error('Store not initialized. Call initStore(backend) first.');
}

export async function read(chatId) {
    ensureBackend();
    var cached = cacheGet(chatId);
    if (cached) return cached;
    var data = await _backend.read(chatId);
    if (data) {
        cacheSet(chatId, data);
        return data;
    }
    var empty = emptyVault(chatId);
    cacheSet(chatId, empty);
    return empty;
}

export async function write(chatId, vault) {
    ensureBackend();
    vault.updated_at = new Date().toISOString();
    cacheSet(chatId, vault);
    await _backend.write(chatId, vault);
}

export async function remove(chatId) {
    ensureBackend();
    cacheInvalidate(chatId);
    await _backend.remove(chatId);
}

// ─── Pure data operations (no I/O) ───

export function emptyVault(chatId) {
    return {
        chat_id: chatId || 'default',
        version: 0,
        content: {
            unconsolidated_stm: [],
            stm_entries: [],
            ltm_entries: [],
            story_time: 'Day 1',
            story_scene: '未知',
            state: {},
            language: 'zh'
        },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
}

export function mergeVaultFromMessages(messages, existingVault) {
    var vault = existingVault || emptyVault('');
    if (!messages || messages.length === 0) return vault;

    var processedIds = (vault.content.stm_entries || [])
        .concat(vault.content.unconsolidated_stm || [])
        .reduce(function(acc, entry) {
            (entry.msg_ids || []).forEach(function(id) { acc[id] = true; });
            return acc;
        }, {});

    return vault;
}

export function appendSTMEntries(vault, stmEntries) {
    if (!stmEntries || stmEntries.length === 0) return vault;
    var content = vault.content || {};
    var unconsolidated = content.unconsolidated_stm || [];
    var existingIds = {};
    unconsolidated.forEach(function(e) { if (e.id) existingIds[e.id] = true; });

    stmEntries.forEach(function(e) {
        if (!e.id) e.id = 'stm_' + ((content.stm_next_id = (content.stm_next_id || 0) + 1) - 1);
        if (existingIds[e.id]) return;
        existingIds[e.id] = true;
        unconsolidated.push(e);
    });

    content.unconsolidated_stm = unconsolidated;
    vault.content = content;
    vault.version = (vault.version || 0) + 1;
    return vault;
}

export function rollbackByMsgIds(vault, removedMsgIds) {
    if (!removedMsgIds || removedMsgIds.length === 0) return vault;
    var idSet = {};
    removedMsgIds.forEach(function(id) { idSet[id] = true; });

    var content = vault.content || {};
    content.unconsolidated_stm = (content.unconsolidated_stm || []).filter(function(e) {
        return !(e.msg_ids || []).some(function(mid) { return idSet[mid]; });
    });
    content.stm_entries = (content.stm_entries || []).filter(function(e) {
        return !(e.msg_ids || []).some(function(mid) { return idSet[mid]; });
    });

    vault.version = (vault.version || 0) + 1;
    return vault;
}

export function isStorageBlocked() {
    return !_backend;
}
