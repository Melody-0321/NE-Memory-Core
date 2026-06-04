// core/retrieval-tiered.js — Multi-level Lazy Retrieval
//
// Implements tiered search with lazy fallback:
//   Level 0: Current chat (primary chat_id) — searched first
//   Level 1: Sibling chats (same project) — only if L0 < minResults
//   Level 2: Foreign projects — only if L0+L1 < minResults
//
// "Lazy" = deeper tiers are only searched when upper tiers
// don't yield enough results. Each result is annotated with
// _tier (0/1/2) and _source_chat for priority signaling.
//
// Usage:
//   import { createTieredSearch } from './retrieval-tiered.js';
//   var ts = createTieredSearch({
//     searchSingleChat: function(chatId, query, topK) { ... },
//     listAllChatIds: function() { ... },
//     getChatProjectId: function(chatId) { ... }
//   });
//   var result = await ts.search('ne-memory-dev', '架构设计');

import { filterCandidates } from './retrieval-filter.js';

/**
 * @param {object} deps
 * @param {Function} deps.searchSingleChat - (chatId, query, topK) => Promise<candidate[]>
 * @param {Function} deps.listAllChatIds - () => string[]
 * @param {Function} [deps.getChatProjectId] - (chatId) => string|null — maps chat to project
 * @returns {{ search: Function }}
 */
export function createTieredSearch(deps) {
    var searchSingleChat = deps.searchSingleChat;
    var listAllChatIds   = deps.listAllChatIds;
    var getChatProjectId = deps.getChatProjectId || function() { return null; };

    /**
     * Multi-level lazy retrieval.
     *
     * @param {string} currentChatId - Primary chat (Level 0)
     * @param {string} query - Natural language search query
     * @param {object} [options]
     * @param {number} [options.minResults=5] - Threshold to trigger fallback to next tier
     * @param {number} [options.topK=40] - Max candidates per tier
     * @param {number} [options.maxTotal=80] - Hard cap on total results across all tiers
     * @returns {Promise<{results: Array, tiers_searched: number[], total_found: number}>}
     */
    async function search(currentChatId, query, options) {
        options = options || {};
        var minResults = options.minResults || 5;
        var topK       = options.topK || 40;
        var maxTotal   = options.maxTotal || 80;

        var allResults    = [];
        var tiersSearched = [];
        var seen          = {}; // dedup by __id or id

        function addResults(candidates, tier, sourceChat) {
            if (!candidates || candidates.length === 0) return 0;
            var added = 0;
            for (var i = 0; i < candidates.length; i++) {
                if (allResults.length >= maxTotal) break;
                var id = candidates[i].__id || candidates[i].id;
                if (seen[id]) continue;
                seen[id] = true;
                candidates[i]._tier = tier;
                candidates[i]._source_chat = sourceChat;
                allResults.push(candidates[i]);
                added++;
            }
            return added;
        }

        // ─── Level 0: Current chat ───
        tiersSearched.push(0);
        try {
            var l0 = await searchSingleChat(currentChatId, query, topK);
            addResults(l0, 0, currentChatId);
        } catch (e) {
            console.warn('[tiered-search] L0 failed for', currentChatId, ':', e.message);
        }

        if (allResults.length >= minResults) {
            return { results: allResults, tiers_searched: tiersSearched, total_found: allResults.length };
        }

        // ─── Build chat buckets ───
        var allChats   = listAllChatIds ? listAllChatIds() : [];
        var currentProj = getChatProjectId(currentChatId);

        var siblings   = [];  // same project, different chat
        var foreigners = [];  // different project

        for (var i = 0; i < allChats.length; i++) {
            var cid = allChats[i];
            if (cid === currentChatId) continue;
            if (currentProj && getChatProjectId(cid) === currentProj) {
                siblings.push(cid);
            } else {
                foreigners.push(cid);
            }
        }

        // If no project mapping available, treat all other chats as siblings (Level 1)
        // This is the default behavior when getChatProjectId always returns null.
        if (!currentProj && foreigners.length > 0) {
            siblings = siblings.concat(foreigners);
            foreigners = [];
        }

        // ─── Level 1: Sibling chats ───
        if (siblings.length > 0 && allResults.length < minResults) {
            tiersSearched.push(1);
            for (var i = 0; i < siblings.length && allResults.length < minResults + topK; i++) {
                try {
                    var l1 = await searchSingleChat(siblings[i], query, topK);
                    addResults(l1, 1, siblings[i]);
                } catch (e) {
                    // skip failed chats
                }
            }
        }

        // ─── Level 2: Foreign projects ───
        if (foreigners.length > 0 && allResults.length < minResults) {
            tiersSearched.push(2);
            for (var i = 0; i < foreigners.length && allResults.length < minResults + topK; i++) {
                try {
                    var l2 = await searchSingleChat(foreigners[i], query, topK);
                    addResults(l2, 2, foreigners[i]);
                } catch (e) {
                    // skip
                }
            }
        }

        return { results: allResults, tiers_searched: tiersSearched, total_found: allResults.length };
    }

    return { search: search };
}
