// core/retrieval.js — Layer 1: Full retrieval pipeline (BM25 → dedup → LLM synthesis)
//
// Encapsulates the complete recall_memory flow from tools.js:
//   1. BM25 pre-filter (filterCandidates) with cross-lingual query translation
//   2. Cross-call dedup tracking (msg_id fingerprint + header cache)
//   3. Entity chain & state injection (query-time entity timelines)
//   4. LLM prompt construction with dedup annotations
//   5. LLM synthesis
//   6. Cache updated msg_ids + headers for next call
//
// createRetrievalPipeline({ callLLM, readVault }) returns { search(chatId, query) }

import { filterCandidates, parseTimeConstraint, applyTimeFilter, isTimeOnlyQuery } from './retrieval-filter.js';
import { buildRetrievalMessages } from './prompts.js';

// ─── Entity chain lookup ───

function lookupEntityChains(content, entityNames) {
    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
    var chains = {};

    entityNames.forEach(function(name) {
        var chainEntries = allSTM.filter(function(e) {
            return e.entities && e.entities.some(function(en) { return en.name === name; });
        });
        if (chainEntries.length > 0) {
            chainEntries.sort(function(a, b) {
                return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
            });
            chains[name] = chainEntries;
        }
    });

    return chains;
}

// ─── State summary builder ───

function formatCompactStateSummary(content, mode) {
    var state = content.state || {};
    var lines = [];

    // Participants — grouped by status
    var participants = state.participants || {};
    /** @type {Record<string, Array<{name: string, card: object}>>} */
    var statusGroups = { active: [], standby: [], inactive: [], departed: [], unknown: [] };
    Object.keys(participants).forEach(function(name) {
        var p = participants[name];
        var status = (p && p.status) ? p.status : 'unknown';
        var group = statusGroups[status] || statusGroups.unknown;
        group.push({ name: name, card: p });
    });

    if (statusGroups.active.length > 0) {
        var activeParts = statusGroups.active.map(function(p) {
            var c = p.card;
            var extra = [];
            if (c && c.role) extra.push(c.role);
            if (c && c.current_task) extra.push(c.current_task);
            return p.name + (extra.length > 0 ? ' (' + extra.join(', ') + ')' : '');
        });
        lines.push('## Active Participants');
        lines.push(activeParts.join('\n'));
    }

    if (statusGroups.standby.length > 0) {
        lines.push('## Standby');
        lines.push(statusGroups.standby.map(function(p) { return p.name; }).join(', '));
    }

    if (statusGroups.inactive.length > 0) {
        lines.push('## Inactive');
        lines.push(statusGroups.inactive.map(function(p) { return p.name; }).join(', '));
    }

    if (statusGroups.departed.length > 0) {
        lines.push('## Departed');
        lines.push(statusGroups.departed.map(function(p) {
            var c = p.card;
            var extra = [];
            if (c && c.notes) extra.push(c.notes);
            return p.name + (extra.length > 0 ? ' (' + extra.join(', ') + ')' : '');
        }).join(', '));
    }

    // Teams
    var teams = state.teams || {};
    var teamKeys = Object.keys(teams);
    if (teamKeys.length > 0) {
        var teamParts = teamKeys.map(function(name) {
            var t = teams[name];
            var extra = [];
            if (t && t.lead) extra.push('lead: ' + t.lead);
            return name + (extra.length > 0 ? ' (' + extra.join(', ') + ')' : '');
        });
        lines.push('## Teams');
        lines.push(teamParts.join('\n'));
    }

    // Active medium tasks
    var mediumTasks = state.medium_tasks;
    if (mediumTasks && typeof mediumTasks === 'object') {
        var mtActive = Object.keys(mediumTasks).filter(function(k) {
            var t = mediumTasks[k];
            return t && t.status && t.status !== 'departed';
        });
        if (mtActive.length > 0) {
            var mtParts = mtActive.map(function(k) {
                var t = mediumTasks[k];
                var progress = t.progress_summary ? ' (' + t.progress_summary + ')' : '';
                return t.title + ' [' + (t.status || '?') + ']' + progress;
            });
            lines.push('## Active Medium Tasks');
            lines.push(mtParts.join('\n'));
        }
    }

    // Active emergencies
    var emergencies = state.emergencies;
    if (emergencies && typeof emergencies === 'object') {
        var emActive = Object.keys(emergencies).filter(function(k) {
            var e = emergencies[k];
            return e && e.status === 'active';
        });
        if (emActive.length > 0) {
            var emParts = emActive.map(function(k) {
                var e = emergencies[k];
                return e.title + ' [' + (e.severity || '?') + '] — ' + (e.status || '');
            });
            lines.push('## Emergencies');
            lines.push(emParts.join('\n'));
        }
    }

    // Context line (multi-tag)
    var contextParts = [];
    if (state.context) contextParts.push(state.context);
    if (state.period) contextParts.push(state.period);
    if (state.current_focus) contextParts.push(state.current_focus);
    if (contextParts.length > 0) lines.push('Context: ' + contextParts.join(' | '));
    else if (state.date) lines.push('Date: ' + state.date);

    return lines.join('\n');
}

// ─── Entity name extraction from query ───

function extractEntityNames(query, content) {
    var state = content.state || {};
    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
    var knownNames = [];

    // Collect all known entity names from state and STM entries
    var participants = state.participants || {};
    Object.keys(participants).forEach(function(name) { knownNames.push(name); });

    var teams = state.teams || {};
    Object.keys(teams).forEach(function(name) { knownNames.push(name); });

    // Also collect from STM entity annotations
    allSTM.forEach(function(e) {
        if (e.entities) {
            e.entities.forEach(function(en) {
                if (knownNames.indexOf(en.name) === -1) knownNames.push(en.name);
            });
        }
    });

    // Filter: which known names appear in the query?
    var queryLower = query.toLowerCase();
    var matched = knownNames.filter(function(name) {
        return name.length > 1 && queryLower.indexOf(name.toLowerCase()) !== -1;
    });

    // Limit to 5 most relevant (longest names first — more specific)
    matched.sort(function(a, b) { return b.length - a.length; });
    return matched.slice(0, 5);
}

// ─── Cross-lingual helpers ───

function hasCJK(text) {
    if (!text) return false;
    for (var i = 0; i < text.length; i++) {
        var c = text.charCodeAt(i);
        if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF)) return true;
    }
    return false;
}

function vaultHasMixedLanguage(content) {
    var hasEN = false;
    var hasZH = false;
    var allEntries = (content.unconsolidated_stm || []).concat(content.stm_entries || []).concat(content.ltm_entries || []);
    for (var i = 0; i < allEntries.length; i++) {
        var e = allEntries[i];
        var text = (e.scene || '') + ' ' + (e.event || '') + ' ' + (e.translation || '');
        if (hasCJK(text)) hasZH = true;
        if (/[a-zA-Z]{3,}/.test(text)) hasEN = true;
        if (hasEN && hasZH) return true;
    }
    return false;
}

async function translateQuery(callLLM, query, targetLang) {
    var direction = targetLang === 'zh' ? 'Chinese' : 'English';
    try {
        var result = await callLLM([
            { role: 'system', content: 'Translate the following query to ' + direction + '. Output only the translation, no explanation. Keep named entities untranslated if they are proper names.' },
            { role: 'user', content: query }
        ], { timeout: 5, max_tokens: 50, temperature: 0.0 });
        return (result || '').trim();
    } catch (e) {
        console.warn('[core/retrieval] Query translation failed:', e.message);
        return null;
    }
}

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

        // ─── Time-aware pre-filter ───
        var timeConstraint = parseTimeConstraint(query);
        var timeFiltered = null;
        var TIMELINE_BM25_THRESHOLD = 15;
        var isSummaryMode = false;

        if (timeConstraint) {
            var allEntries = allSTM.concat(allLTM);
            timeFiltered = applyTimeFilter(allEntries, timeConstraint, content);

            if (timeFiltered.length === 0) {
                return { answer: 'No entries found for time period: ' + (timeConstraint.period || query), sources: [], msgIds: [] };
            }

            // Split time-filtered results back into STM/LTM pools
            var tfSTM = [];
            var tfLTM = [];
            timeFiltered.forEach(function(e) {
                if (e.stm_refs) {
                    tfLTM.push(e);
                } else {
                    tfSTM.push(e);
                }
            });
        }

        // ─── Three-branch retrieval ───
        var topCandidates;
        var effectiveTimeOnly = false;

        if (!timeConstraint) {
            // Branch 1: No time constraint → BM25 on full pool (current default)
            // filterCandidates runs below
        } else {
            effectiveTimeOnly = options.timeOnly || isTimeOnlyQuery(query, timeConstraint);

            if (effectiveTimeOnly) {
                // Branch 2: Explicit/auto timeOnly → skip BM25, full chronological output
                isSummaryMode = true;
                topCandidates = timeFiltered.slice().sort(function(a, b) {
                    var ta = a.period || a.time_range || '';
                    var tb = b.period || b.time_range || '';
                    return ta.localeCompare(tb);
                });
                // Tag candidates
                topCandidates = topCandidates.map(function(e) {
                    var clone = JSON.parse(JSON.stringify(e));
                    clone.__type = e.stm_refs ? 'ltm' : 'stm';
                    clone.__id = e.id;
                    return clone;
                });
                // Cap at 30 entries
                if (topCandidates.length > 30) {
                    topCandidates = topCandidates.slice(0, 30);
                }
            } else if (timeFiltered.length > TIMELINE_BM25_THRESHOLD) {
                // Branch 3a: Time pool > threshold → BM25 within time pool
                allSTM = tfSTM;
                allLTM = tfLTM;
                // filterCandidates runs below with time-filtered data
            } else {
                // Branch 3b: Time pool <= threshold → skip BM25, full chronological
                isSummaryMode = true;
                topCandidates = timeFiltered.slice().sort(function(a, b) {
                    var ta = a.period || a.time_range || '';
                    var tb = b.period || b.time_range || '';
                    return ta.localeCompare(tb);
                });
                topCandidates = topCandidates.map(function(e) {
                    var clone = JSON.parse(JSON.stringify(e));
                    clone.__type = e.stm_refs ? 'ltm' : 'stm';
                    clone.__id = e.id;
                    return clone;
                });
            }
        }

        // ─── Level 0: BM25 filter with cross-lingual expansion ───
        if (!isSummaryMode) {
            topCandidates = filterCandidates(query, allSTM, allLTM, 40);
            if ((!topCandidates || topCandidates.length < 5) && vaultHasMixedLanguage(content)) {
                // Translate query for cross-lingual search
                var queryIsEN = !hasCJK(query) && /[a-zA-Z]{3,}/.test(query);
                var targetLang = queryIsEN ? 'zh' : 'en';
                var translated = await translateQuery(callLLM, query, targetLang);
                if (translated && translated !== query) {
                    var xResults = filterCandidates(translated, allSTM, allLTM, 20);
                    if (xResults && xResults.length > 0) {
                        // Merge, deduplicate by id, interleave results
                        var seen = {};
                        var merged = [];
                        var orig = topCandidates || [];
                        var add = function(arr) {
                            for (var i = 0; i < arr.length; i++) {
                                var id = arr[i].__id || arr[i].id;
                                if (!seen[id]) {
                                    seen[id] = true;
                                    merged.push(arr[i]);
                                }
                            }
                        };
                        // Interleave: alternate original and translated to balance relevance
                        var maxLen = Math.max(orig.length, xResults.length);
                        for (var i = 0; i < maxLen; i++) {
                            if (i < orig.length) add([orig[i]]);
                            if (i < xResults.length) add([xResults[i]]);
                        }
                        topCandidates = merged.slice(0, 40);
                    }
                }
            }
        }
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

        // ─── Chain & State injection ───
        var entityNames = extractEntityNames(query, content);
        var chains = entityNames.length > 0 ? lookupEntityChains(content, entityNames) : {};
        var mode = content.mode || 'roleplay';
        var stateSummary = formatCompactStateSummary(content, mode);
        var retrievalContext = {
            chains: chains,
            stateSummary: stateSummary,
            mode: mode
        };

        var messages = buildRetrievalMessages(query, topCandidates, vault, budget, retrievalContext, isSummaryMode);

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
            answer = await callLLM(messages, { timeout: 30, temperature: 0.3 });
            answer = answer || '';

            // Fallback: if synthesis is empty or too short, retry with simplified prompt
            if (answer.trim().length < 20 && topCandidates.length > 0) {
                console.warn('[core/retrieval] Synthesis too short, retrying with fallback prompt');
                var fallbackSystem = 'Given a query and a shortlist of 5 memory entries, return a concise answer synthesizing the most relevant information. Be brief and factual.';
                var fallbackUser = 'Query: ' + query + '\n\nCandidates:\n' + topCandidates.slice(0, 5).map(function(c, i) {
                    return (i+1) + '. [' + (c.time_range||c.period||'') + '] ' + (c.scene||'') + ': ' + (c.event||'');
                }).join('\n');
                answer = await callLLM([{ role: 'system', content: fallbackSystem }, { role: 'user', content: fallbackUser }], { timeout: 30, max_tokens: 256, temperature: 0.3 });
                answer = answer || 'No answer synthesized.';
            } else {
                answer = answer || 'No answer synthesized.';
            }
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
