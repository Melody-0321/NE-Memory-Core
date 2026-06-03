// mcp/tools.js — MCP Tool definitions for NE-Memory
//
// Uses McpServer.tool() API with Zod schemas (v1.x).

import { z } from 'zod';
import { listWorkspaces } from '../core/adapters/trae/workspace.js';

// Default batch preparation for history readers that don't provide their own
function defaultPrepareBatches(messages, options) {
    options = options || {};
    var lastN = options.lastN || 100;
    var minLength = options.minLength || 20;
    var batchSize = options.batchSize || 10;

    var entries = messages.slice(-lastN);
    var filtered = [];
    for (var i = 0; i < entries.length; i++) {
        var text = (entries[i].content || '').trim();
        if (text.length >= minLength) filtered.push(text);
    }

    var batches = [];
    for (var i = 0; i < filtered.length; i += batchSize) {
        var batchTexts = filtered.slice(i, i + batchSize);
        var batch = [];
        for (var j = 0; j < batchTexts.length; j++) {
            var idx = entries.length - filtered.length + i + j;
            batch.push({ role: 'user', content: batchTexts[j], id: 'input_' + idx });
        }
        batches.push(batch);
    }
    return batches;
}

export function registerTools(server, ne, config) {

    server.tool('memory_status',
        'Get the memory vault status for a chat session: version, STM/LTM counts, current story time and scene.',
        { chat_id: z.string().describe('Chat/session identifier') },
        async function(args) {
            var result = await ne.status(args.chat_id);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_search',
        'BM25 text search across all stored memories. Zero LLM call — returns raw candidate entries ranked by relevance.\n\n' +
        'Supports single chat_id or multiple chat_ids for cross-project search.',
        {
            chat_id: z.string().optional().describe('Single chat/session identifier'),
            chat_ids: z.array(z.string()).optional().describe('Multiple chat/session identifiers for cross-project search'),
            query: z.string().describe('Natural language search query')
        },
        async function(args) {
            if (!args.query) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'Missing query' }, null, 2) }] };
            }

            var ids = args.chat_ids || (args.chat_id ? [args.chat_id] : []);
            if (ids.length === 0) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provide chat_id or chat_ids' }, null, 2) }] };
            }

            // Single chatId: direct search
            if (ids.length === 1) {
                var result = await ne.search(ids[0], args.query);
                return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
            }

            // Multiple chatIds: search each, merge, dedup
            var allResults = [];
            var seen = {};

            for (var i = 0; i < ids.length; i++) {
                try {
                    var candidates = await ne.search(ids[i], args.query) || [];
                    for (var j = 0; j < candidates.length; j++) {
                        var c = candidates[j];
                        // The last arg is for `chat_ids` parameter not used
                        var key = (c.__type || '') + ':' + (c.__id || c.id || j);
                        if (!seen[key]) {
                            seen[key] = true;
                            allResults.push(c);
                        }
                    }
                } catch (e) {
                    // skip failed chats
                }
            }

            return { content: [{ type: 'text', text: JSON.stringify(allResults, null, 2) }] };
        }
    );

    server.tool('memory_access',
        'Direct reference lookup. Read any memory entry or state entity by its reference string. Zero LLM.\n\n' +
        'Supported refs:\n' +
        '  "stm_12" or "ltm_3" — memory entry with children chain\n' +
        '  "characters.Name" — character card detail\n' +
        '  "factions.Name" — faction detail with relations\n' +
        '  "quests.Name" — quest/task/goal/event detail\n' +
        '  "chain.Name" — narrative chain for an entity',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            ref: z.string().describe('Reference string (see description for formats)')
        },
        async function(args) {
            var result = await ne.access(args.chat_id, args.ref, {
                historyReader: ne.historyReader || null
            });
            return { content: [{ type: 'text', text: result }] };
        }
    );

    server.tool('memory_synthesize',
        'Full retrieval pipeline: BM25 pre-filter → cross-call dedup → LLM synthesis. Returns narrative answer with source references. Handles multi-topic queries via ";;" separators.',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            query: z.string().describe('Structured natural language query. Use ";;" to separate unrelated topics.')
        },
        async function(args) {
            var result = await ne.synthesize(args.chat_id, args.query);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_extract',
        'Extract short-term memories (STM) from new chat messages. Calls LLM to identify key events, then auto-triggers consolidation if the unconsolidated STM threshold is reached.\n\n' +
        'For best recall: pass both user AND assistant messages paired together, with your own AI response summary in the assistant message. This ensures both sides of the conversation are captured.\n\n' +
        'Example: messages=[{role:"user",content:"..."},{role:"assistant",content:"(your summary)"}]\n\n' +
        'When background=true, returns immediately without waiting for LLM completion. The extraction runs asynchronously in the server.',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            messages: z.array(z.object({
                role: z.string().describe('"user" or "assistant"'),
                content: z.string().describe('Message text'),
                id: z.string().optional().describe('Message ID for dedup')
            })).describe('New messages to extract events from'),
            force: z.boolean().optional().describe('If true, process all messages even if already processed'),
            ai_summary: z.string().optional().describe('Short summary of your AI response. If provided, appended as an assistant message for better recall.'),
            background: z.boolean().optional().describe('If true, run extraction in background and return immediately (default: false)')
        },
        async function(args) {
            var msgs = args.messages || [];
            var hasAssistant = msgs.some(function(m) { return m.role === 'assistant'; });
            var warnings = [];

            // If user provided ai_summary but no assistant message, append it
            if (args.ai_summary && !hasAssistant && msgs.length > 0) {
                var lastId = msgs[msgs.length - 1].id || 'msg';
                msgs.push({
                    role: 'assistant',
                    content: args.ai_summary,
                    id: 'output_' + lastId
                });
                hasAssistant = true;
            }

            // If still only user messages, warn for future calls
            if (!hasAssistant && msgs.length > 0) {
                warnings.push('Only user messages detected. For complete recall, pass paired user+assistant messages or use ai_summary parameter.');
            }

            // Background mode: fire-and-forget, return immediately
            if (args.background) {
                ne.extractSTM(args.chat_id, msgs, { force: args.force || false })
                    .then(function(result) {
                        console.error('[mcp] bg extract done for', args.chat_id, '-',
                            'stm:', result.added, 'total:', (result.vault.content.unconsolidated_stm || []).length);
                    })
                    .catch(function(e) {
                        console.error('[mcp] bg extract failed for', args.chat_id, '-', e.message);
                    });
                return { content: [{ type: 'text', text: JSON.stringify({
                    status: 'background_processing',
                    chat_id: args.chat_id,
                    messages: msgs.length,
                    warnings: warnings.length > 0 ? warnings : null
                }, null, 2) }] };
            }

            // Blocking mode: await result
            var result = await ne.extractSTM(args.chat_id, msgs, { force: args.force || false });
            return { content: [{ type: 'text', text: JSON.stringify({
                stm_added: result.added,
                stm_total: (result.vault.content.unconsolidated_stm || []).length,
                ltm_total: (result.vault.content.ltm_entries || []).length,
                story_time: result.vault.content.story_time || '',
                story_scene: result.vault.content.story_scene || '',
                warnings: warnings.length > 0 ? warnings : null
            }, null, 2) }] };
        }
    );

    server.tool('memory_get_state',
        'Read the current story state: global time/scene, character cards, factions, quests.',
        { chat_id: z.string().describe('Chat/session identifier') },
        async function(args) {
            var result = await ne.getState(args.chat_id);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_update_state',
        'Update story state fields using dot-path notation. Validates against schema before applying.',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            changes: z.record(z.string(), z.string()).describe('Dot-path key → value updates, e.g. {"scene":"Forest","time":"Dusk"}')
        },
        async function(args) {
            var result = await ne.updateState(args.chat_id, args.changes);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_consolidate',
        'Force consolidation of all unconsolidated STM entries into LTM summaries.',
        { chat_id: z.string().describe('Chat/session identifier') },
        async function(args) {
            var result = await ne.consolidate(args.chat_id);
            return { content: [{ type: 'text', text: JSON.stringify({
                ltm_created: result.merged,
                stm_unconsolidated: (result.vault.content.unconsolidated_stm || []).length,
                ltm_total: (result.vault.content.ltm_entries || []).length
            }, null, 2) }] };
        }
    );

    server.tool('memory_rollback',
        'Roll back memory entries by source message IDs. Use when messages are deleted or swiped.',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            msg_ids: z.array(z.string()).describe('Message IDs whose associated memory entries should be removed')
        },
        async function(args) {
            var result = await ne.rollback(args.chat_id, args.msg_ids);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_process_history',
        'Read the current conversation\'s user input history from Trae\'s local SQLite database and process it into STM entries. Filters short inputs and batches long ones for LLM extraction. Ideal for backfilling memory for an ongoing session.',
        {
            chat_id: z.string().describe('Chat/session identifier for storing extracted memories'),
            last_n: z.number().optional().describe('Number of most recent input history entries to process (default: 150)'),
            min_length: z.number().optional().describe('Minimum input text length to include (default: 15)'),
            batch_size: z.number().optional().describe('Entries per extraction batch (default: 20)'),
            force: z.boolean().optional().describe('If true, reprocess entries even if already processed into STM')
        },
        async function(args) {
            var historyReader = ne.historyReader || null;
            if (!historyReader || !historyReader.readHistory) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'No history reader configured. Please set "history" config in config.json.' }, null, 2) }] };
            }

            var history = await historyReader.readHistory(args.chat_id);
            if (!history || history.length === 0) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'No input history found for this chat session.' }, null, 2) }] };
            }

            var prepareFn = historyReader.prepareBatches || defaultPrepareBatches;
            var batches = prepareFn(history, {
                lastN: args.last_n || 150,
                minLength: args.min_length || 15,
                batchSize: args.batch_size || 20
            });

            var totalBatches = batches.length;
            var totalMessages = 0;
            var totalStm = 0;
            var errors = [];

            for (var i = 0; i < batches.length; i++) {
                totalMessages += batches[i].length;
                try {
                    var result = await ne.extractSTM(args.chat_id, batches[i], { force: args.force || false });
                    totalStm += result.added;
                } catch (e) {
                    errors.push('Batch ' + (i + 1) + ': ' + e.message);
                }
            }

            return { content: [{ type: 'text', text: JSON.stringify({
                input_history_total: history.length,
                processed: {
                    last_n: args.last_n || 150,
                    after_filter: totalMessages,
                    batches: totalBatches,
                    stm_created: totalStm
                },
                vault_status: await ne.status(args.chat_id),
                errors: errors.length > 0 ? errors : null
            }, null, 2) }] };
        }
    );

    server.tool('memory_get_config',
        'Read runtime configuration: STM extraction batch size and consolidation threshold.\n\n' +
        '  stmBatch: messages per batch during history backfill (default 10)\n' +
        '  stmMaxUnconsolidated: unconsolidated STM count threshold to trigger auto-consolidation (default 30)',
        {},
        async function(args) {
            var cfg = {
                stmBatch: ne.getConfig('stmBatch', 10),
                stmMaxUnconsolidated: ne.getConfig('stmMaxUnconsolidated', 30)
            };
            return { content: [{ type: 'text', text: JSON.stringify(cfg, null, 2) }] };
        }
    );

    server.tool('memory_update_config',
        'Update runtime configuration without restarting the server. Changes take effect immediately.\n\n' +
        'Allowed keys: stmBatch, stmMaxUnconsolidated\n' +
        'Example: {"stmMaxUnconsolidated": 15, "stmBatch": 20}',
        {
            changes: z.record(z.string(), z.number()).describe('Key-value config updates, e.g. {"stmMaxUnconsolidated": 15}')
        },
        async function(args) {
            var allowed = ['stmBatch', 'stmMaxUnconsolidated'];
            var applied = {};
            var rejected = {};
            var keys = Object.keys(args.changes || {});
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                if (allowed.indexOf(k) !== -1) {
                    ne.setConfig(k, args.changes[k]);
                    applied[k] = args.changes[k];
                } else {
                    rejected[k] = 'Not allowed. Allowed keys: ' + allowed.join(', ');
                }
            }
            var current = {
                stmBatch: ne.getConfig('stmBatch', 10),
                stmMaxUnconsolidated: ne.getConfig('stmMaxUnconsolidated', 30)
            };
            return { content: [{ type: 'text', text: JSON.stringify({
                applied: applied,
                rejected: Object.keys(rejected).length > 0 ? rejected : null,
                current: current
            }, null, 2) }] };
        }
    );

    server.tool('memory_list_projects',
        'List all Trae workspace projects that have accessible chat history. Use this to discover which projects are available for cross-project search.',
        {},
        async function(args) {
            var workspaceDir = (config && config.workspace_dir) || '';
            var dataDir = (config && config.data_dir) || '';
            if (!workspaceDir) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'workspace_dir not configured' }, null, 2) }] };
            }
            var projects = listWorkspaces(workspaceDir, dataDir);
            return { content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }] };
        }
    );
}
