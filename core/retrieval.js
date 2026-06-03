// core/retrieval.js — Layer 1: Full retrieval pipeline (BM25 → dedup → LLM synthesis)
//
// Encapsulates the complete recall_memory flow from tools.js:
//   1. BM25 pre-filter (filterCandidates)
//   2. Cross-call dedup tracking (msg_id fingerprint + header cache)
//   3. LLM prompt construction with dedup annotations
//   4. LLM synthesis
//   5. Cache updated msg_ids + headers for next call
//
// createRetrievalPipeline({ callLLM, readVault }) returns { search(chatId, query) }

import { filterCandidates } from './retrieval-filter.js';
import { buildRetrievalMessages } from './prompts.js';

export function createRetrievalPipeline(deps) {
    var callLLM = deps.callLLM;
    var readVault = deps.readVault;

    // Per-pipeline state (reset on chat switch)
    var lastRecallMsgIds = null;
    var lastRecallHeaders = null;
    var lastRecallChatId = null;

    async function search(chatId, query, options) {
        options = options || {};
        var vault = await readVault(chatId);
        var content = vault.content || {};
        var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
        var allLTM = content.ltm_entries || [];

        if (allSTM.length === 0 && allLTM.length === 0) {
            return { answer: 'No memories stored yet.', sources: [], msgIds: [] };
        }

        // ─── Level 0: BM25 filter ───
        var topCandidates = filterCandidates(query, allSTM, allLTM, 40);
        if (!topCandidates || topCandidates.length === 0) {
            return { answer: 'No relevant memories found for: ' + query, sources: [], msgIds: [] };
        }

        // ─── Dedup: reset on chat switch ───
        if (chatId !== lastRecallChatId) {
            lastRecallMsgIds = null;
            lastRecallHeaders = null;
            lastRecallChatId = chatId;
        }

        // ─── Level 1 prep: msg_id fingerprint dedup annotation ───
        if (lastRecallMsgIds && lastRecallMsgIds.length > 0) {
            var usedSet = {};
            lastRecallMsgIds.forEach(function(id) { usedSet[id] = true; });
            topCandidates.forEach(function(c) {
                var entryMsgIds = c.msg_ids || [];
                var alreadyUsed = entryMsgIds.filter(function(id) { return usedSet[id]; });
                if (alreadyUsed.length > 0) {
                    c._already_covered = alreadyUsed;
                }
            });
        }

        var budget = options.budget || 800;
        var messages = buildRetrievalMessages(query, topCandidates, vault, budget);

        // ─── Dedup note injection ───
        if (lastRecallMsgIds && lastRecallMsgIds.length > 0) {
            var dedupNote = '\n\n[DEDUP: Some candidates draw from source messages already used in a previous recall this turn.]\n';
            var hasDedup = false;
            topCandidates.forEach(function(c, i) {
                if (c._already_covered) {
                    dedupNote += '  Candidate #' + (i+1) + ' uses →' + c._already_covered.join(',→') + ' (already covered). Only include if the query asks for deeper detail.\n';
                    hasDedup = true;
                }
            });
            if (!hasDedup && lastRecallHeaders && lastRecallHeaders.length > 0) {
                dedupNote += '  (No per-candidate msg_id overlaps detected. However, previous recall covered: ' + lastRecallHeaders.join(', ') + '. Do not repeat these topics unless the query explicitly asks for more.)\n';
            }
            messages[0].content += dedupNote;
        }

        // ─── Level 1: LLM synthesis ───
        var answer;
        try {
            answer = await callLLM(messages, { timeout: 30 });
            answer = answer || 'No answer synthesized.';
        } catch (e) {
            console.warn('[core/retrieval] LLM synthesis failed:', e.message);
            answer = formatBM25Fallback(query, topCandidates.slice(0, 5));
        }

        // ─── Cache msg_ids + headers for next call dedup ───
        var msgIdMatch = answer.match(/→(\d+)/g);
        if (msgIdMatch) {
            lastRecallMsgIds = msgIdMatch.map(function(m) { return m.replace('→', ''); });
        }
        var headerMatch = answer.match(/##\s+(.+?)(?:\n|$)/g);
        if (headerMatch) {
            lastRecallHeaders = headerMatch.map(function(h) { return h.replace(/^##\s+/, '').trim(); });
        }

        return {
            answer: answer,
            sources: topCandidates.slice(0, 10).map(function(c) {
                return { type: c.__type || 'stm', id: c.id || c.__id, event: c.event, scene: c.scene, period: c.period };
            }),
            msgIds: lastRecallMsgIds
        };
    }

    // Expose dedup state for external inspection
    search.getDedupState = function() {
        return { msgIds: lastRecallMsgIds, headers: lastRecallHeaders, chatId: lastRecallChatId };
    };

    search.resetDedup = function() {
        lastRecallMsgIds = null;
        lastRecallHeaders = null;
        lastRecallChatId = null;
    };

    return { search: search };
}

// ─── BM25 fallback when LLM fails ───

function formatBM25Fallback(query, candidates) {
    var lines = ['## BM25 Results (LLM unavailable)'];
    lines.push('');
    candidates.forEach(function(c, i) {
        var label = (c.period || '') + (c.time_label ? '·' + c.time_label : '');
        var refs = (c.msg_ids || []).join(', ');
        lines.push((i + 1) + '. [' + label + '] ' + (c.scene || '') + ': ' + (c.event || c.summary || '') + ' [→' + refs + ']');
    });
    return lines.join('\n');
}
