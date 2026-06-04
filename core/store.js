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
/** @type {Array<{chatId: string, vault: object, ts: number}>} */
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
            story_time: new Date().toISOString().slice(0, 10),   // YYYY-MM-DD; RP hosts should override with fictional timeline
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

// ─── Cursor state operations ───

export function getCursorState(vault, cursorType) {
    // cursorType: 'stm' | 'ltm'
    var cs = (vault.content || {}).cursor_state || {};
    return cs[cursorType] || { position: 0, pending_partials: [] };
}

export function updateCursorState(vault, cursorType, newState) {
    if (!vault.content) vault.content = {};
    if (!vault.content.cursor_state) vault.content.cursor_state = {};
    vault.content.cursor_state[cursorType] = newState || { position: 0, pending_partials: [] };
}

// ─── Pending messages accumulation (cross-call message buffer) ───

export function appendPendingMessages(vault, newMessages) {
    if (!newMessages || newMessages.length === 0) return vault;
    if (!vault.content) vault.content = {};
    if (!vault.content.pending_messages) vault.content.pending_messages = [];

    var pending = vault.content.pending_messages;
    var seenIds = {};
    pending.forEach(function(m) { if (m.id) seenIds[m.id] = true; });

    newMessages.forEach(function(m) {
        if (m.id && seenIds[m.id]) return;      // Already buffered
        if (m.id) seenIds[m.id] = true;
        pending.push(m);
    });

    vault.content.pending_messages = pending;
    vault.version = (vault.version || 0) + 1;
    return vault;
}

export function getPendingMessages(vault) {
    return (vault.content || {}).pending_messages || [];
}

// ─── Processed message ID tracking ───
// Tracks which message IDs have been fully processed (STM extracted).
// This allows the MCP server to filter already-seen messages at the entry point,
// as the original cursor-engine design intended.

/**
 * Mark specific message IDs as processed (their STM has been extracted).
 * @param {Object} vault
 * @param {string[]} msgIds - Array of message IDs to mark as processed
 * @returns {Object} vault (mutated in place)
 */
export function markMessagesProcessed(vault, msgIds) {
    if (!msgIds || msgIds.length === 0) return vault;
    if (!vault.content) vault.content = {};
    if (!vault.content.processed_message_ids_set) vault.content.processed_message_ids_set = {};
    var set = vault.content.processed_message_ids_set;
    for (var i = 0; i < msgIds.length; i++) {
        if (msgIds[i]) set[msgIds[i]] = true;
    }
    vault.version = (vault.version || 0) + 1;
    return vault;
}

/**
 * Check if a specific message ID has been processed.
 * @param {Object} vault
 * @param {string} msgId
 * @returns {boolean}
 */
export function isMessageProcessed(vault, msgId) {
    if (!msgId) return false;
    var set = (vault.content || {}).processed_message_ids_set || {};
    return !!set[msgId];
}

/**
 * Get all processed message IDs.
 * @param {Object} vault
 * @returns {string[]}
 */
export function getProcessedMessageIds(vault) {
    return Object.keys((vault.content || {}).processed_message_ids_set || {});
}

/**
 * Filter out already-processed messages from an array.
 * Returns only messages whose IDs are NOT in processed_message_ids_set.
 * @param {Object} vault
 * @param {Array} messages
 * @returns {Array} unprocessed messages
 */
export function filterUnprocessedMessages(vault, messages) {
    if (!messages || messages.length === 0) return [];
    var set = (vault.content || {}).processed_message_ids_set || {};
    return messages.filter(function(m) {
        var id = m.id || m.mes_id;
        return !id || !set[id];
    });
}

// ─── Extended STM appender (with cursor metadata) ───

export function appendSTMEntriesWithMeta(vault, entries) {
    if (!entries || entries.length === 0) return vault;
    var content = vault.content || {};
    var unconsolidated = content.unconsolidated_stm || [];
    var existingIds = {};
    unconsolidated.forEach(function(e) { if (e.id) existingIds[e.id] = true; });

    // Build processed_msg_ids map for strict coverage tracking
    if (!content.processed_msg_ids) content.processed_msg_ids = {};

    entries.forEach(function(e) {
        if (!e.id) e.id = 'stm_' + ((content.stm_next_id = (content.stm_next_id || 0) + 1) - 1);
        if (existingIds[e.id]) return;

        // Preserve cursor metadata fields
        if (!e.msg_range && e.msgRange) {
            e.msg_range = e.msgRange;
        }
        if (!e.status) e.status = 'closed';

        // Dedup by msg_range overlap: skip if range already covered
        var range = e.msg_range || e.msgRange || [];
        if (range.length === 2) {
            var alreadyCovered = true;
            for (var idx = range[0]; idx <= range[1]; idx++) {
                if (!content.processed_msg_ids[idx]) {
                    alreadyCovered = false;
                    break;
                }
            }
            if (alreadyCovered) return; // Skip duplicate

            // Track message coverage
            for (var idx = range[0]; idx <= range[1]; idx++) {
                content.processed_msg_ids[idx] = e.id;
            }
        }

        existingIds[e.id] = true;
        unconsolidated.push(e);
    });

    content.unconsolidated_stm = unconsolidated;
    vault.content = content;
    vault.version = (vault.version || 0) + 1;
    return vault;
}

// ─── LTM migration: move consolidated STM from unconsolidated → stm_entries ───

export function migrateConsolidatedSTM(vault, ltmResults) {
    if (!ltmResults || ltmResults.length === 0) return vault;
    var content = vault.content || {};
    var unconsolidated = content.unconsolidated_stm || [];
    var stmEntries = content.stm_entries || [];

    ltmResults.forEach(function(ltm) {
        var stmRange = ltm.stmRange || ltm.stm_range || [];
        if (stmRange.length !== 2) return;

        // Find STM entries covered by this LTM
        var covered = [];
        var remaining = [];
        for (var i = 0; i < unconsolidated.length; i++) {
            var stm = unconsolidated[i];
            // STM entries store their position via msg_range indices
            // For LTM, we use the position in unconsolidated list
            if (i >= stmRange[0] && i <= stmRange[1]) {
                stm.parent_ltm = ltm.id || null;
                covered.push(stm);
            } else {
                remaining.push(stm);
            }
        }

        // Set stm_refs on the LTM entry
        ltm.stm_refs = covered.map(function(s) { return s.id; }).filter(Boolean);

        // Move covered STM to stm_entries
        for (var j = 0; j < covered.length; j++) {
            stmEntries.push(covered[j]);
        }

        content.unconsolidated_stm = remaining;
    });

    content.stm_entries = stmEntries;
    vault.content = content;
    vault.version = (vault.version || 0) + 1;
    return vault;
}

export function isStorageBlocked() {
    return !_backend;
}
