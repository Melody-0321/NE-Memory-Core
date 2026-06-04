// core/engine/extract.js — STM extraction engine (cursor-based, universal)
//
// v2: extractWithCursor() uses the shared cursor engine for incremental,
// partial-aware extraction with BM25 pre-grouping.
// v1: executeIncrementalUpdate() has been moved to core/engine/rp/rp-extract.js.

import { read, write, appendSTMEntriesWithMeta, getCursorState, updateCursorState, appendPendingMessages, getPendingMessages, markMessagesProcessed } from '../store.js';
import { get, getExtractionMode, getInitialStmWindow, getStmExpandStep, getMaxStmWindow, getStmMinBatchForCursor, getBm25SimilarityThreshold, getMaxPartialGenerations } from '../config.js';
import { buildStmCursorPrompt } from '../prompts.js';
import { checkConsolidateThreshold, consolidateWithCursor } from './consolidate.js';
import { createCursorEngine } from './cursor.js';
import { tokenize } from '../retrieval-filter.js';

// ─── Cursor-based extraction (v2) ───

/**
 * Parse STM cursor response from LLM.
 * Returns array of { event, msgRange, status, topic, parent_partial, entities }.
 */
export function parseStmCursorResponse(response, window) {
    try {
        var text = String(response || '').trim();
        // Extract JSON from code blocks
        var codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeMatch) text = codeMatch[1].trim();

        // Try array match
        var arrayMatch = text.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            var parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) {
                // Normalize: convert msgRange to msg_range for storage consistency
                return parsed.map(function(e) {
                    if (!e.status) e.status = 'closed';  // default status
                    if (e.msgRange && !e.msg_range) e.msg_range = e.msgRange;
                    if (e.entity && !e.entities) {
                        e.entities = [{ name: String(e.entity).trim(), type: 'character' }];
                        delete e.entity;
                    }
                    return e;
                });
            }
        }

        // Try object with stm_entries key
        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            var obj = JSON.parse(jsonMatch[0]);
            if (Array.isArray(obj)) return obj;
            if (obj.stm_entries) return obj.stm_entries;
        }

        return [];
    } catch (e) {
        console.warn('[core/extract] Failed to parse cursor STM response:', e.message);
        return [];
    }
}

/**
 * Append STM results from cursor engine to vault.
 * Handles closed entries and tracks partial state separately.
 */
export async function appendStmResults(params) {
    var vault = params._vault;
    var closedResults = params.closedResults || [];
    var cursorState = params.cursorState;
    var chatId = params._chatId;

    if (!vault && chatId) {
        vault = await read(chatId);
    }
    if (!vault) return;

    if (closedResults.length > 0) {
        // Add period/scene from existing vault state
        var content = vault.content || {};
        var state = content.state || {};
        var defaultPeriod = state.time || content.story_time || new Date().toISOString().slice(0, 10);
        var defaultScene = state.scene || content.story_scene || '';

        closedResults.forEach(function(e) {
            if (!e.period) e.period = defaultPeriod;
            if (!e.scene) e.scene = defaultScene;
        });

        appendSTMEntriesWithMeta(vault, closedResults);
    }

    // Update cursor state
    if (cursorState) {
        updateCursorState(vault, 'stm', cursorState);
    }

    if (chatId) {
        vault._meta = vault._meta || {};
        vault._meta.last_pipeline_task = 'stm_extract_cursor';
        vault._meta.last_pipeline_time = new Date().toISOString();
        vault.version = (vault.version || 0) + 1;
        await write(chatId, vault);
    }
}

/**
 * Main cursor-based STM extraction entry point.
 *
 * @param {Object} [options]
 * @param {string} options.chatId - Chat session ID
 * @param {Array} options.messages - New messages to extract from
 * @param {Function} options.callLLM - LLM call function
 * @param {Object} [options.config] - Optional config overrides
 * @returns {Promise<Object>} { results, cursor, vault }
 */
export async function extractWithCursor(options) {
    var chatId = options?.chatId;
    var messages = options?.messages || [];
    var callLLM = options?.callLLM;
    var config = options?.config || {};

    if (!chatId || !callLLM) {
        throw new Error('extractWithCursor requires chatId and callLLM');
    }

    // Load vault
    var vault = await read(chatId);

    // ─── Core fix: accumulate new messages in vault ───
    // This makes cursor_state.position (absolute index) meaningful across calls,
    // because the cursor engine always sees the full accumulated message array.
    appendPendingMessages(vault, messages);
    await write(chatId, vault);

    // Get the full accumulated message array and cursor state
    var allMessages = getPendingMessages(vault);
    var cursorState = getCursorState(vault, 'stm');

    if (allMessages.length === 0) {
        return { results: [], cursor: cursorState, vault: vault, added: 0, _processed_ids: [] };
    }

    // Determine allowSkip based on extraction mode
    var extractionMode = config.extractionMode || getExtractionMode();
    var allowSkip = extractionMode === 'agent';

    // Create cursor engine
    var engine = createCursorEngine({
        mode: 'stm',
        initialWindow: config.initialStmWindow || getInitialStmWindow(),
        expandStep: config.stmExpandStep || getStmExpandStep(),
        maxWindow: config.maxStmWindow || getMaxStmWindow(),
        allowSkip: allowSkip,
        tokenizer: tokenize,
        callLLM: callLLM,
        readVault: function() { return read(chatId); },
        writeVault: function(v) { return write(chatId, v); },
        similarityThreshold: config.bm25SimilarityThreshold || getBm25SimilarityThreshold(),
        maxPartialGenerations: config.maxPartialGenerations || getMaxPartialGenerations()
    });

    // Run cursor engine — pass ALL accumulated messages, cursor engine skips ahead
    var result = await engine.process({
        inputs: allMessages,
        cursorState: cursorState,
        promptBuilder: function(params) {
            return buildStmCursorPrompt({
                items: params.items,
                startIdx: params.startIdx,
                preGroups: params.preGroups,
                partials: params.partials,
                allowSkip: allowSkip,
                force: params.force
            });
        },
        resultParser: parseStmCursorResponse,
        resultAppender: async function(params) {
            await appendStmResults({
                _chatId: chatId,
                _vault: vault,
                closedResults: params.closedResults,
                cursorState: params.cursorState
            });
            // Reload vault after append
            vault = await read(chatId);
        }
    });

    // ─── Mark processed message IDs ───
    // Track ALL message IDs that the cursor has advanced past (not just those
    // covered by closed STM results).  This ensures skipped/empty windows also
    // mark their messages as processed, preventing redundant re-extraction.
    var oldPos = cursorState.position || 0;
    var newPos = (result.cursor || {}).position || oldPos;
    var pendingMsgs = getPendingMessages(vault);
    var coveredIds = [];
    for (var idx = oldPos; idx < newPos; idx++) {
        if (idx >= 0 && idx < pendingMsgs.length) {
            var msg = pendingMsgs[idx];
            var id = msg.id || msg.mes_id;
            if (id && coveredIds.indexOf(id) === -1) coveredIds.push(id);
        }
    }

    // Save final cursor state to vault
    if (result.cursor) {
        updateCursorState(vault, 'stm', result.cursor);
    }

    if (coveredIds.length > 0) {
        markMessagesProcessed(vault, coveredIds);
    }

    vault._meta = vault._meta || {};
    vault._meta.last_pipeline_task = 'stm_extract_cursor';
    vault._meta.last_pipeline_time = new Date().toISOString();
    vault.version = (vault.version || 0) + 1;
    await write(chatId, vault);

    // ─── Auto-consolidation check ───
    // Mirrors the dual-track logic in executeIncrementalUpdate().
    // Without this, cursor-engine extraction never triggers LTM consolidation.
    if (checkConsolidateThreshold(vault)) {
        try {
            var consResult = await consolidateWithCursor({ chatId: chatId, callLLM: callLLM });
            if (consResult.merged > 0) {
                vault = consResult.vault;
            }
        } catch (e) {
            console.warn('[core/extract] Auto-consolidation failed:', e.message);
            // Continue without blocking — extraction succeeded, consolidation is bonus
        }
    }

    return {
        results: result.results,
        cursor: result.cursor,
        vault: vault,
        added: (result.results || []).length,
        _processed_ids: coveredIds
    };
}
