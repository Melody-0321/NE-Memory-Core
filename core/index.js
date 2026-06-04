// core/index.js — Unified core entry point
//
// initCore({ storage, config, callLLM }) initializes all subsystems
// and returns the public API for use by MCP servers, bot backends, etc.
//
// Usage:
//   import { initCore } from './core/index.js';
//   import { createFSBackend } from './core/adapters/storage-fs.js';
//   import { createAPILLM } from './core/adapters/llm-api.js';
//
//   const ne = initCore({
//     storage: createFSBackend('./data'),
//     config:  JSON.parse(fs.readFileSync('./config.json', 'utf-8')),
//     callLLM: createAPILLM({ url: 'https://api.deepseek.com/v1/chat/completions', key: 'sk-...', model: 'deepseek-v4-flash' })
//   });
//
//   const result = await ne.extractSTM('my-chat', messages);

import { initStore, read, write, rollbackByMsgIds, getCursorState, updateCursorState, markMessagesProcessed, isMessageProcessed, getProcessedMessageIds, filterUnprocessedMessages } from './store.js';
import { initConfig, get, set, isCursorEngineEnabled, getExtractionMode, getInitialStmWindow, getStmExpandStep, getMaxStmWindow, getInitialLtmWindow, getLtmExpandStep, getMaxLtmWindow, getStmMinBatchForCursor, getLtmMinBatch, getBm25SimilarityThreshold, getMaxPartialGenerations } from './config.js';
import { filterCandidates } from './retrieval-filter.js';
import { extractWithCursor } from './engine/extract.js';
import { consolidateWithCursor } from './engine/consolidate.js';
// RP legacy fallback — only used when cursor engine is disabled
import { executeIncrementalUpdate } from './engine/rp/rp-extract.js';
import { executeConsolidation } from './engine/rp/rp-consolidate.js';
import { validateStateChanges, mergeStateChanges } from './schema.js';
import { t_narrative } from './i18n.js';
import { accessEntry } from './access.js';
import { createRetrievalPipeline } from './retrieval.js';
import { listReaders, createReader } from './adapters/history/index.js';
import './adapters/history/trae-sqlite-reader.js';
import './adapters/history/generic-json-reader.js';
import './adapters/history/openclaw-md-reader.js';
import './adapters/history/cursor-jsonl-reader.js';
import './adapters/history/claude-code-jsonl-reader.js';
import './adapters/history/copilot-json-reader.js';
import './adapters/history/openclaw-jsonl-reader.js';

export function initCore(deps) {
    // Initialize subsystems
    initConfig(deps.config || {});
    initStore(deps.storage);
    var callLLM = deps.callLLM;

    var historyReader = deps.historyReader || null;
    if (!historyReader && deps.history) {
        historyReader = createReader(deps.history);
    }
    if (!historyReader) {
        historyReader = { readHistory: async function() { return []; }, _unavailable: 'No reader configured' };
    }

    if (!callLLM) {
        console.warn('[core] No callLLM provided. extractSTM and consolidate will fail until one is set.');
    }

    // Initialize retrieval pipeline with dedup
    var retrievalPipeline = callLLM ? createRetrievalPipeline({
        callLLM: callLLM,
        readVault: read
    }) : null;

    // ─── Public API ───

    return {
        // Lifecycle
        setLLM: function(fn) {
            callLLM = fn;
            retrievalPipeline = createRetrievalPipeline({ callLLM: fn, readVault: read });
        },

        // Core CRUD
        read: function(chatId) { return read(chatId); },
        write: function(chatId, vault) { return write(chatId, vault); },

        // Search (zero LLM, pure BM25)
        search: function(chatId, query) {
            return read(chatId).then(function(vault) {
                var c = vault.content || {};
                var allSTM = (c.unconsolidated_stm || []).concat(c.stm_entries || []);
                var allLTM = c.ltm_entries || [];
                return filterCandidates(query, allSTM, allLTM, 40);
            });
        },

        // Access (Layer 0: direct reference lookup, zero LLM)
        access: function(chatId, ref, options) {
            return accessEntry(chatId, ref, options || {});
        },

        // Synthesize (Layer 1: full retrieval pipeline with dedup)
        synthesize: function(chatId, query, options) {
            if (!retrievalPipeline) return Promise.reject(new Error('No callLLM configured. Call ne.setLLM(fn) first.'));
            return retrievalPipeline.search(chatId, query, options || {});
        },

        // Rollback memory entries by message IDs
        rollback: async function(chatId, removedMsgIds) {
            var vault = await read(chatId);
            rollbackByMsgIds(vault, removedMsgIds);
            await write(chatId, vault);
            return { rolled_back: removedMsgIds.length };
        },

        // Status overview
        status: async function(chatId) {
            var vault = await read(chatId);
            var c = vault.content || {};
            var stmCount = (c.unconsolidated_stm || []).length + (c.stm_entries || []).length;
            var ltmCount = (c.ltm_entries || []).length;
            return {
                version: vault.version || 0,
                chat_id: vault.chat_id || chatId,
                stm_count: stmCount,
                ltm_count: ltmCount,
                story_time: c.story_time || '',
                story_scene: c.story_scene || '',
                updated_at: vault.updated_at || ''
            };
        },

        // STM extraction
        extractSTM: function(chatId, messages, options) {
            if (!callLLM) return Promise.reject(new Error('No callLLM configured. Call ne.setLLM(fn) first.'));
            if (isCursorEngineEnabled()) {
                return extractWithCursor({
                    chatId: chatId,
                    messages: messages,
                    callLLM: callLLM,
                    config: options || {}
                });
            }
            return executeIncrementalUpdate(chatId, messages, callLLM, options || {});
        },

        // LTM consolidation
        consolidate: function(chatId) {
            if (!callLLM) return Promise.reject(new Error('No callLLM configured. Call ne.setLLM(fn) first.'));
            if (isCursorEngineEnabled()) {
                return consolidateWithCursor({
                    chatId: chatId,
                    callLLM: callLLM
                });
            }
            return executeConsolidation(chatId, callLLM);
        },

        // Cursor pipeline: STM extract + optional auto-consolidation
        processMessages: async function(chatId, messages, options) {
            if (!callLLM) return Promise.reject(new Error('No callLLM configured. Call ne.setLLM(fn) first.'));
            options = options || {};

            var result;
            if (isCursorEngineEnabled()) {
                result = await extractWithCursor({
                    chatId: chatId,
                    messages: messages,
                    callLLM: callLLM,
                    config: options
                });
            } else {
                result = await executeIncrementalUpdate(chatId, messages, callLLM, options);
            }

            // Auto-consolidation check
            var vault = result.vault || await read(chatId);
            if (shouldConsolidateStm(vault, options)) {
                var consResult;
                if (isCursorEngineEnabled()) {
                    consResult = await consolidateWithCursor({
                        chatId: chatId,
                        callLLM: callLLM
                    });
                } else {
                    consResult = await executeConsolidation(chatId, callLLM);
                }
                return {
                    stm: result,
                    ltm: consResult,
                    vault: consResult.vault || vault
                };
            }

            return { stm: result, vault: vault };
        },

        // Cursor status
        getCursorStatus: async function(chatId) {
            var vault = await read(chatId);
            var stmCursor = getCursorState(vault, 'stm');
            var ltmCursor = getCursorState(vault, 'ltm');
            return {
                stm: {
                    position: stmCursor.position || 0,
                    pending_partials: (stmCursor.pending_partials || []).length
                },
                ltm: {
                    position: ltmCursor.position || 0,
                    pending_partials: (ltmCursor.pending_partials || []).length
                }
            };
        },

        // Reset cursor (debugging)
        resetCursor: async function(chatId, cursorType) {
            var vault = await read(chatId);
            var types = cursorType ? [cursorType] : ['stm', 'ltm'];
            types.forEach(function(t) {
                updateCursorState(vault, t, { position: 0, pending_partials: [] });
            });
            await write(chatId, vault);
            return { reset: types };
        },

        // State management
        getState: async function(chatId) {
            var vault = await read(chatId);
            return (vault.content || {}).state || {};
        },

        updateState: async function(chatId, changes) {
            var vault = await read(chatId);
            var schema = (vault.content || {}).state_schema || null;
            var result = validateStateChanges(schema, changes);
            if (result.warnings.length > 0) {
                console.warn('[core] State change warnings:', result.warnings);
            }
            var content = vault.content || {};
            content.state = mergeStateChanges(content.state || {}, result.validated);
            vault.version = (vault.version || 0) + 1;
            await write(chatId, vault);
            return { applied: result.validated, warnings: result.warnings };
        },

        // Config
        getConfig: function(key, defaultValue) { return get(key, defaultValue); },
        setConfig: function(key, value) { set(key, value); },

        // I18n
        t: function(key, replacements) { return t_narrative(key, replacements); },

        // History reader (platform-specific input history access)
        historyReader: historyReader,
        listReaders: listReaders
    };
}

export {
    filterCandidates,
    accessEntry,
    rollbackByMsgIds,
    createRetrievalPipeline
};

export { createFSBackend } from './adapters/storage-fs.js';
export { createAPILLM } from './adapters/llm-api.js';
export { createCallbackLLM } from './adapters/llm-callback.js';

// Re-export processed message ID tracking utilities
export {
    markMessagesProcessed,
    isMessageProcessed,
    getProcessedMessageIds,
    filterUnprocessedMessages
};

// ─── Cursor pipeline utilities ───

/**
 * Check if LTM consolidation should be triggered.
 * Dual condition: unconsolidated count threshold OR pending partial convergence.
 */
export function shouldConsolidateStm(vault, config) {
    config = config || {};
    var unconsolidated = vault.content.unconsolidated_stm || [];
    var ltmCursor = (vault.content.cursor_state || {}).ltm;

    // Condition 1: unconsolidated count reaches threshold
    var threshold = config.ltmMinBatch || getLtmMinBatch();
    if (unconsolidated.length >= threshold) return true;

    // Condition 2: pending LTM partials have related new STMs
    if (ltmCursor && ltmCursor.pending_partials && ltmCursor.pending_partials.length > 0) {
        return true;
    }

    return false;
}
