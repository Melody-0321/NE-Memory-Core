// core/engine/consolidate.js — STM→LTM consolidation engine (cursor-based, universal)
//
// v2: consolidateWithCursor() uses the shared cursor engine for incremental,
// partial-aware consolidation with BM25 pre-grouping.
// v1: executeConsolidation() has been moved to core/engine/rp/rp-consolidate.js.
//
// Shared utilities: findNextId(), deriveTimeRange(), checkConsolidateThreshold()
// are used by both the cursor path and the RP legacy path.

import { read, write, getCursorState, updateCursorState, migrateConsolidatedSTM } from '../store.js';
import { getStmMaxUnconsolidated, getInitialLtmWindow, getLtmExpandStep, getMaxLtmWindow, getBm25SimilarityThreshold, getMaxPartialGenerations } from '../config.js';
import { buildLtmCursorPrompt } from '../prompts.js';
import { createCursorEngine } from './cursor.js';
import { tokenize } from '../retrieval-filter.js';

export function findNextId(vault) {
    var content = vault.content || {};
    var max = 0;
    (content.ltm_entries || []).forEach(function(e) {
        var num = parseInt(String(e.id || '').replace('ltm_', ''), 10);
        if (num > max) max = num;
    });
    return 'ltm_' + (max + 1);
}

export function deriveTimeRange(sourceSTMEntries) {
    var timed = sourceSTMEntries.filter(function(s) {
        return (s.period || s.time_label);
    });

    if (timed.length === 0) return null;

    var first = timed[0];
    var last = timed[timed.length - 1];

    var fmt = function(s) {
        var parts = [];
        if (s.period) parts.push(s.period);
        if (s.time_label) parts.push(s.time_label);
        return parts.join('·');
    };

    if (timed.length === 1) return fmt(first);

    if (first.period === last.period) {
        return first.period + ': ' + (first.time_label || '?') + ' → ' + (last.time_label || '?');
    }
    return fmt(first) + ' → ' + fmt(last);
}

export function checkConsolidateThreshold(vault) {
    var content = vault.content || {};
    var maxUnconsolidated = getStmMaxUnconsolidated();
    var unconsolidated = (content.unconsolidated_stm || []).filter(function(stm) { return !stm.parent_ltm; });
    if (unconsolidated.length < maxUnconsolidated) return false;
    // Also check total text length to avoid consolidating too few short entries
    var totalText = 0;
    unconsolidated.forEach(function(s) {
        totalText += (s.event || '').length + (s.scene || '').length;
    });
    if (totalText < maxUnconsolidated * 40) return false;
    return true;
}

// ─── Cursor-based consolidation (v2) ───

/**
 * Parse LTM cursor response from LLM.
 * Returns array of { summary, stmRange, status, concepts, parent_partial }.
 */
export function parseLtmCursorResponse(response, window) {
    try {
        var text = String(response || '').trim();
        var codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeMatch) text = codeMatch[1].trim();

        var arrayMatch = text.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            var parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed)) {
                return parsed.map(function(e) {
                    if (!e.status) e.status = 'closed';  // default status
                    if (e.stmRange && !e.stm_range) e.stm_range = e.stmRange;
                    return e;
                });
            }
        }

        var jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            var obj = JSON.parse(jsonMatch[0]);
            if (Array.isArray(obj)) return obj;
            if (obj.ltm_entries) return obj.ltm_entries;
        }

        return [];
    } catch (e) {
        console.warn('[core/consolidate] Failed to parse cursor LTM response:', e.message);
        return [];
    }
}

/**
 * Append LTM results from cursor engine to vault.
 */
export async function appendLtmResults(params) {
    var vault = params._vault;
    var closedResults = params.closedResults || [];
    var cursorState = params.cursorState;
    var chatId = params._chatId;

    if (!vault && chatId) {
        vault = await read(chatId);
    }
    if (!vault) return;

    if (closedResults.length > 0) {
        var content = vault.content || {};

        // Assign IDs and metadata to LTM entries
        closedResults.forEach(function(ltm) {
            if (!ltm.id) ltm.id = findNextId(vault);

            // Derive time_range from covered STM entries
            var unconsolidated = content.unconsolidated_stm || [];
            var stmRange = ltm.stm_range || ltm.stmRange || [];
            var sourceSTM = [];
            if (stmRange.length === 2) {
                for (var i = stmRange[0]; i <= stmRange[1] && i < unconsolidated.length; i++) {
                    sourceSTM.push(unconsolidated[i]);
                }
            }
            if (!ltm.time_range) {
                ltm.time_range = deriveTimeRange(sourceSTM);
            }
            if (!ltm.period) {
                var period = deriveTimeRange(sourceSTM);
                if (period) ltm.period = period;
            }
            if (!ltm.scene && sourceSTM.length > 0) {
                ltm.scene = sourceSTM[0].scene || '';
            }

            // Ensure stm_refs
            ltm.stm_refs = sourceSTM.map(function(s) { return s.id; }).filter(Boolean);

            // Inherit entities from source STM for entity chain visibility
            ltm.entities = sourceSTM.reduce(function(acc, s) {
                (s.entities || []).forEach(function(e) {
                    if (!acc.find(function(a) { return a.name === e.name && a.type === e.type; })) {
                        acc.push({ name: e.name, type: e.type || 'entity' });
                    }
                });
                return acc;
            }, []);

            // Add to LTM entries
            content.ltm_entries = content.ltm_entries || [];
            content.ltm_entries.push(ltm);
        });

        // Migrate consolidated STM
        migrateConsolidatedSTM(vault, closedResults);
    }

    // Update cursor state
    if (cursorState) {
        updateCursorState(vault, 'ltm', cursorState);
    }

    if (chatId) {
        vault._meta = vault._meta || {};
        vault._meta.last_pipeline_task = 'ltm_consolidate_cursor';
        vault._meta.last_pipeline_time = new Date().toISOString();
        vault.version = (vault.version || 0) + 1;
        await write(chatId, vault);
    }
}

/**
 * Main cursor-based LTM consolidation entry point.
 *
 * @param {Object} [options]
 * @param {string} options.chatId - Chat session ID
 * @param {Function} options.callLLM - LLM call function
 * @param {Object} [options.config] - Optional config overrides
 * @returns {Promise<Object>} { results, cursor, vault }
 */
export async function consolidateWithCursor(options) {
    var chatId = options?.chatId;
    var callLLM = options?.callLLM;
    var config = options?.config || {};

    if (!chatId || !callLLM) {
        throw new Error('consolidateWithCursor requires chatId and callLLM');
    }

    // Load vault and cursor state
    var vault = await read(chatId);
    var cursorState = getCursorState(vault, 'ltm');

    // Get unconsolidated STM entries
    var content = vault.content || {};
    var allSTM = (content.unconsolidated_stm || []).filter(function(s) { return !s.parent_ltm; });

    if (allSTM.length === 0) {
        return { results: [], cursor: cursorState, vault: vault };
    }

    // Create cursor engine (LTM mode: allowSkip always false)
    var engine = createCursorEngine({
        mode: 'ltm',
        initialWindow: config.initialLtmWindow || getInitialLtmWindow(),
        expandStep: config.ltmExpandStep || getLtmExpandStep(),
        maxWindow: config.maxLtmWindow || getMaxLtmWindow(),
        allowSkip: false,  // LTM must cover all STM entries
        tokenizer: tokenize,
        callLLM: callLLM,
        readVault: function() { return read(chatId); },
        writeVault: function(v) { return write(chatId, v); },
        similarityThreshold: config.bm25SimilarityThreshold || getBm25SimilarityThreshold(),
        maxPartialGenerations: config.maxPartialGenerations || getMaxPartialGenerations()
    });

    // Run cursor engine
    var result = await engine.process({
        inputs: allSTM,
        cursorState: cursorState,
        promptBuilder: function(params) {
            return buildLtmCursorPrompt({
                items: params.items,
                startIdx: params.startIdx,
                preGroups: params.preGroups,
                partials: params.partials,
                force: params.force
            });
        },
        resultParser: parseLtmCursorResponse,
        resultAppender: async function(params) {
            await appendLtmResults({
                _chatId: chatId,
                _vault: vault,
                closedResults: params.closedResults,
                cursorState: params.cursorState
            });
            // Reload vault after append
            vault = await read(chatId);
        }
    });

    // Save final cursor state
    if (result.cursor) {
        updateCursorState(vault, 'ltm', result.cursor);
        vault._meta = vault._meta || {};
        vault._meta.last_pipeline_task = 'ltm_consolidate_cursor';
        vault._meta.last_pipeline_time = new Date().toISOString();
        vault.version = (vault.version || 0) + 1;
        await write(chatId, vault);
    }

    return {
        results: result.results,
        cursor: result.cursor,
        vault: vault,
        merged: result.results.length
    };
}
