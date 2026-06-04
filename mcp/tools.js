// mcp/tools.js — MCP Tool definitions for NE-Memory
//
// Uses McpServer.tool() API with Zod schemas (v1.x).

import { z } from 'zod';
import { listWorkspaces } from '../core/adapters/trae/workspace.js';
import { filterUnprocessedMessages, getProcessedMessageIds } from '../core/store.js';

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

// ─── Usage Guides ───

var GUIDE_EN = [
'# NE-Memory Usage Guide',
'',
'## Quick Start (per-turn workflow)',
'',
'After EVERY conversation turn (user message + your response), call:',
'',
'  memory_extract({',
'    chat_id: "my-session",',
'    messages: [',
'      { role: "user",    content: "...", id: "msg_1" },',
'      { role: "assistant", content: "...", id: "msg_2" }',
'    ],',
'    type: "general"       // "general" for dev/work, "roleplay" for stories',
'  })',
'',
'RULES:',
'  - ALWAYS pass BOTH user and assistant messages together (paired).',
'  - Each message MUST have a unique "id" field for dedup tracking.',
'  - If you only have the assistant response, use ai_summary parameter.',
'  - Set type="general" for dev/conversation, "roleplay" for story/narrative.',
'',
'---',
'',
'## Core Tools (sorted by typical call order)',
'',
'### 1. memory_extract (★★★ PRIMARY — call EVERY turn)',
'  Extracts short-term memories (STM) from new messages via cursor engine.',
'  - Already-processed messages are auto-skipped (reported as "skipped").',
'  - If unconsolidated STM reaches threshold, LTM consolidation auto-triggers.',
'  - Use background=true for non-blocking fire-and-forget extraction.',
'  - Use force=true to bypass the processed-message filter and re-process.',
'',
'### 2. memory_get_processed_ids',
'  Returns the set of message IDs already fully processed.',
'  Use this to check if specific messages have been extracted before resending.',
'',
'### 3. memory_get_cursor_status',
'  Shows cursor engine state: current position, pending partial events.',
'  Useful for debugging or understanding extraction progress.',
'',
'### 4. memory_get_state / memory_update_state',
'  Read/write story state: scene, time, participants, tasks, etc.',
'',
'---',
'',
'## Retrieval Tools',
'',
'### memory_search (zero LLM, BM25)',
'  Fast text search across all stored STM + LTM. No LLM call.',
'',
'### memory_synthesize (full pipeline with LLM)',
'  BM25 pre-filter → cross-call dedup → LLM synthesis. Returns narrative answer.',
'  For multi-topic: separate queries with ";;".',
'  Use timeOnly=true for chronological summaries ("What happened on Day 3?").',
'',
'### memory_access (zero LLM, direct lookup)',
'  Read any entry by reference: "stm_5", "ltm_2", "participants.Alice", "time.Day 3".',
'',
'### memory_search_tiered',
'  Multi-project layered search: current chat → sibling projects → foreign projects.',
'',
'---',
'',
'## Management Tools',
'',
'### memory_status',
'  Vault overview: STM/LTM counts, story time, version.',
'',
'### memory_consolidate',
'  Force immediate consolidation of all unconsolidated STM into LTM.',
'',
'### memory_rollback',
'  Remove memory entries by message IDs (for deleted/swiped messages).',
'',
'### memory_reset_cursor',
'  Reset cursor position to 0. Use for re-processing from scratch.',
'',
'### memory_process_history',
'  Backfill memory from Trae conversation history (SQLite).',
'  Use for first-time setup or catching up missed conversation rounds.',
'',
'### memory_list_projects',
'  List all Trae workspace projects with accessible chat history.',
'',
'### memory_get_config / memory_update_config',
'  Read or update runtime configuration (window sizes, thresholds, etc.).',
'',
'---',
'',
'## Message Format Requirements',
'',
'Each message object must have:',
'  {',
'    role: "user" | "assistant",',
'    content: "<message text>",',
'    id: "<unique message id>"    // REQUIRED for dedup & processed tracking',
'  }',
'',
'---',
'',
'',
'## Rule File Auto-Injection',
'',
'NE-Memory automatically syncs vault state to a Rule file (e.g. .trae/rules/ne-memory-state.md)',
'after memory_extract and memory_update_state. This file is loaded as system context by the IDE,',
'giving you persistent awareness of the current state (participants, tasks, scene, time, etc.)',
'without needing to call MCP tools on every turn.',
'',
'The Rule file contains:',
'- Current scene, time, date, and focus',
'- Active/standby/inactive participants with roles and tasks',
'- Teams with leads and descriptions',
'- Active medium-term tasks with progress',
'- Pending short-term tasks with assignees',
'- Active emergencies',
'',
'You do NOT need to call memory_get_state on every turn — just read the Rule file',
'(it is automatically included in your context). Use memory_get_state only when you',
'need detailed raw state data.',
'',
'To force an immediate state sync, call memory_inject_state.',
'',
'---',
'',
'## Common Patterns',
'',
'1. FIRST TIME setup: call memory_guide (this tool), then memory_process_history to backfill.',
'2. EVERY TURN: call memory_extract with paired user+assistant messages.',
'3. ON STATE CHANGE: call memory_update_state to record scene/time/participant changes.',
'4. ON MILESTONE: call memory_inject_state to force-sync the Rule file.',
'5. BEFORE SENDING: call memory_get_processed_ids to avoid sending already-seen messages.',
'6. DEBUGGING: call memory_get_cursor_status to check extraction progress.',
'7. RECOVERY: call memory_reset_cursor then memory_extract with force=true.',
].join('\n');

var GUIDE_ZH = [
'# NE-Memory 使用指南',
'',
'## 快速开始（每轮对话工作流）',
'',
'每轮对话结束后（用户消息 + 你的回复），调用：',
'',
'  memory_extract({',
'    chat_id: "my-session",',
'    messages: [',
'      { role: "user",    content: "...", id: "msg_1" },',
'      { role: "assistant", content: "...", id: "msg_2" }',
'    ],',
'    type: "general"       // "general" 用于开发/工作, "roleplay" 用于叙事',
'  })',
'',
'规则：',
'  - 必须同时传入 user 和 assistant 消息（配对传递）。',
'  - 每条消息必须有唯一的 "id" 字段，用于去重追踪。',
'  - 如果只有 assistant 回复，可用 ai_summary 参数。',
'  - type="general" 用于开发对话, "roleplay" 用于故事/叙事。',
'',
'---',
'',
'## 核心工具（按典型调用顺序排列）',
'',
'### 1. memory_extract (★★★ 主工具 — 每轮必调)',
'  通过 cursor 引擎从新消息中提取短期记忆 (STM)。',
'  - 已收录的消息自动跳过（返回 "skipped" 计数）。',
'  - 未整合的 STM 达到阈值时自动触发 LTM 整合。',
'  - background=true 用于非阻塞后台上报。',
'  - force=true 绕过已收录过滤，强制重新处理。',
'',
'### 2. memory_get_processed_ids',
'  查询已被完全处理的消息 ID 集合。',
'  在发送消息前调用，避免重复发送已收录的消息。',
'',
'### 3. memory_get_cursor_status',
'  查看 cursor 引擎状态：当前位置、挂起的 partial 事件数。',
'  用于调试或了解提取进度。',
'',
'### 4. memory_get_state / memory_update_state',
'  读取/更新故事状态：场景、时间、参与者、任务等。',
'',
'---',
'',
'## 检索工具',
'',
'### memory_search (零 LLM 调用, BM25)',
'  在所有已存储的 STM + LTM 中快速文本搜索。无 LLM 调用。',
'',
'### memory_synthesize (含 LLM 的完整检索管道)',
'  BM25 预筛选 → 跨调用去重 → LLM 综合。返回叙事性答案。',
'  多主题查询用 ";;" 分隔。',
'  timeOnly=true 用于按时间汇总（"Day 3 发生了什么？"）。',
'',
'### memory_access (零 LLM, 直接引用)',
'  按引用字符串读取任意条目："stm_5", "ltm_2", "participants.Alice", "time.Day 3"。',
'',
'### memory_search_tiered',
'  多项目分层搜索：当前对话 → 同级项目 → 外部项目。',
'',
'---',
'',
'## 管理工具',
'',
'### memory_status',
'  Vault 概览：STM/LTM 数量、故事时间、版本。',
'',
'### memory_consolidate',
'  强制立即将所有未整合的 STM 整合为 LTM。',
'',
'### memory_rollback',
'  按消息 ID 删除关联的记忆条目（用于消息被删除或重发时）。',
'',
'### memory_reset_cursor',
'  将 cursor 位置重置为 0。用于从头重新处理。',
'',
'### memory_process_history',
'  从 Trae 对话历史 (SQLite) 回填记忆。',
'  用于首次设置或补齐漏掉的对话轮次。',
'',
'### memory_list_projects',
'  列出所有可访问的 Trae 工作区项目。',
'',
'### memory_get_config / memory_update_config',
'  读取或更新运行时配置（窗口大小、阈值等）。',
'',
'---',
'',
'## 消息格式要求',
'',
'每条消息对象必须包含：',
'  {',
'    role: "user" | "assistant",',
'    content: "<消息文本>",',
'    id: "<唯一消息ID>"         // 必须！用于去重和已收录追踪',
'  }',
'',
'---',
'',
'## Rule 文件自动注入',
'',
'NE-Memory 会在 memory_extract 和 memory_update_state 调用后，',
'自动将 vault 状态同步到 Rule 文件（如 .trae/rules/ne-memory-state.md）。',
'该文件会被 IDE 作为系统上下文自动加载，让你无需每次都调 MCP 工具',
'就能持续感知当前状态（参与者、任务、场景、时间等）。',
'',
'Rule 文件包含：',
'- 当前场景、时间、日期、关注点',
'- 活跃/待命/非活跃参与者及其角色和任务',
'- 团队及其负责人和描述',
'- 活跃的中期任务及进度',
'- 待处理的短期任务及分配人',
'- 活跃的紧急事项',
'',
'你无需每轮都调 memory_get_state — 直接读取 Rule 文件即可',
'（它已自动包含在你的上下文中）。仅在需要详细原始状态数据时调用 memory_get_state。',
'',
'如需立即强制同步状态，请调用 memory_inject_state。',
'',
'---',
'',
'## 常见模式',
'',
'1. 首次使用：调 memory_guide（本工具），然后 memory_process_history 回填历史。',
'2. 每轮对话：调 memory_extract，传入配对的 user+assistant 消息。',
'3. 状态变化时：调 memory_update_state 记录场景/时间/参与者变化。',
'4. 里程碑完成时：调 memory_inject_state 强制同步 Rule 文件。',
'5. 发送前检查：调 memory_get_processed_ids，避免重复发送已收录消息。',
'6. 调试：调 memory_get_cursor_status 查看提取进度。',
'7. 恢复：调 memory_reset_cursor 后再用 force=true 重新提取。',

].join('\n');

export function registerTools(server, ne, config, stateInjector) {

    // ─── memory_guide: Workflow discovery (call first!) ───
    server.tool('memory_guide',
        '📖 START HERE — Complete usage guide for NE-Memory.\n' +
        'Call this tool FIRST when you encounter this MCP server. Returns the full workflow: ' +
        'which tools to call, in what order, per-turn requirements, message format, and best practices.\n' +
        'Available in English (default) or Chinese (lang="zh").',
        {
            lang: z.string().optional().describe('Language: "en" (default) or "zh"')
        },
        async function(args) {
            var isZh = (args.lang || '').toLowerCase() === 'zh';
            var guide = isZh ? GUIDE_ZH : GUIDE_EN;
            return { content: [{ type: 'text', text: guide }] };
        }
    );

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
        '  "participants.Name" — participant detail\n' +
        '  "teams.Name" — team detail with relations\n' +
        '  "medium_tasks.ID" — medium-term task detail\n' +
        '  "short_tasks.ID" — short-term task detail\n' +
        '  "emergencies.ID" — emergency detail\n' +
        '  "chain.Name" — narrative chain for an entity\n' +
        '  "time" or "time.Day 5" — chronological timeline of all STM+LTM entries (optionally filtered by period)',
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
        'Full retrieval pipeline: BM25 pre-filter → cross-call dedup → LLM synthesis. Returns narrative answer with source references. Handles multi-topic queries via ";;" separators.\n\n' +
        'Time-aware: queries with time constraints (e.g. "Day 5", "March 2026") are automatically pre-filtered. Use timeOnly:true to force chronological mode.\n\n' +
        'When to use timeOnly: true:\n' +
        '- "Summarize Day 3", "Show everything from yesterday", "What happened in March?"\n' +
        '  → Force chronological mode: skip BM25, get complete timeline.\n\n' +
        'When to use default (timeOnly: false):\n' +
        '- "What did we decide about gRPC in March?"\n' +
        '  → Time-filtered BM25 search, best of both worlds.\n' +
        '- "Day 3 combat system architecture"\n' +
        '  → Time-filtered BM25 search within Day 3 entries.',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            query: z.string().describe('Structured natural language query. Use ";;" to separate unrelated topics.'),
            timeOnly: z.boolean().optional().describe(
                'Force chronological mode: skip BM25 and return ALL entries in the time period sorted by time. ' +
                'Use for "summarize Day X", "show everything from yesterday", "what happened in March?". ' +
                'Default: false (auto-decide: BM25 if >15 time-filtered entries, else full chronological).'
            )
        },
        async function(args) {
            var result = await ne.synthesize(args.chat_id, args.query, { timeOnly: args.timeOnly });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_search_tiered',
        'Multi-level lazy retrieval with priority tiers.\n\n' +
        'Level 0: Current chat — searched first. Only if results < minResults, falls back to Level 1.\n' +
        'Level 1: Sibling chats (same project) — only searched if L0 insufficient.\n' +
        'Level 2: Foreign projects — only searched if L0+L1 still insufficient.\n\n' +
        'Each result is annotated with _tier (0/1/2) and _source_chat for priority signaling.\n' +
        '"Lazy" = deeper tiers are only searched when upper tiers yield fewer than minResults.',
        {
            current_chat_id: z.string().describe('Primary chat ID — searched at highest priority (Level 0)'),
            query: z.string().describe('Natural language search query'),
            min_results: z.number().optional().describe('Minimum results before falling back to next tier (default: 5)'),
            top_k: z.number().optional().describe('Max candidates per tier (default: 40)'),
            max_total: z.number().optional().describe('Hard cap on total results across all tiers (default: 80)')
        },
        async function(args) {
            if (!ne.tieredSearch) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'Tiered search not configured. Set up listAllChatIds in server config.' }, null, 2) }] };
            }
            var result = await ne.tieredSearch.search(args.current_chat_id, args.query, {
                minResults: args.min_results || 5,
                topK: args.top_k || 40,
                maxTotal: args.max_total || 80
            });
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_extract',
        '📌 PRIMARY TOOL — Call after EVERY conversation turn!\n' +
        'Extracts short-term memories (STM) from new messages via cursor engine. ' +
        'Already-processed message IDs are auto-skipped. If unconsolidated STM reaches threshold, LTM consolidation auto-triggers.\n\n' +
        'CRITICAL: each message MUST have a unique "id" field for dedup tracking. ' +
        'Always pass BOTH user AND assistant messages paired together.\n\n' +
        'Call memory_guide first if this is your first time using this server.\n\n' +
        'Parameters:\n' +
        '- chat_id: session identifier\n' +
        '- messages: [{role:"user"|"assistant", content:"...", id:"<unique_id>"}]\n' +
        '- type: "general" for dev/work, "roleplay" for story (default)\n' +
        '- ai_summary: short summary of your response (if you have no assistant message object)\n' +
        '- background: true for non-blocking fire-and-forget\n' +
        '- force: true to bypass processed-message filter and re-process all',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            messages: z.array(z.object({
                role: z.string().describe('"user" or "assistant"'),
                content: z.string().describe('Message text'),
                id: z.string().optional().describe('Message ID for dedup')
            })).describe('New messages to extract events from'),
            force: z.boolean().optional().describe('If true, process all messages even if already processed'),
            ai_summary: z.string().optional().describe('Short summary of your AI response. If provided, appended as an assistant message for better recall.'),
            background: z.boolean().optional().describe('If true, run extraction in background and return immediately (default: false)'),
            type: z.string().optional().describe('Extraction mode: "general" for dev/conversation, "roleplay" for story (default: "roleplay")')
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

            // ─── Filter already-processed messages ───
            // The vault tracks which message IDs have been fully processed (STM extracted).
            // This lets the cursor engine skip already-seen messages at the entry point.
            var vault = await ne.read(args.chat_id);
            var force = args.force || false;
            var filteredMsgs = force ? msgs : filterUnprocessedMessages(vault, msgs);
            var skippedCount = msgs.length - filteredMsgs.length;
            if (skippedCount > 0) {
                warnings.push(skippedCount + ' message(s) already processed and skipped. Use force=true to re-process all.');
            }

            var extractOptions = { force: force };
            if (args.type) extractOptions.type = args.type;

            // Background mode: fire-and-forget, return immediately
            if (args.background) {
                ne.extractSTM(args.chat_id, filteredMsgs, extractOptions)
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
                    messages: filteredMsgs.length,
                    skipped: skippedCount > 0 ? skippedCount : undefined,
                    warnings: warnings.length > 0 ? warnings : null
                }, null, 2) }] };
            }

            // Blocking mode: await result
            var result = await ne.extractSTM(args.chat_id, filteredMsgs, extractOptions);

            // ─── Auto-inject state into Rule file (awaited so caller sees result) ───
            var injectResult = { injected: false, reason: 'Not configured' };
            if (stateInjector && result.added > 0) {
                try {
                    injectResult = await stateInjector(args.chat_id);
                } catch (e) {
                    injectResult = { injected: false, reason: e.message };
                }
            }

            return { content: [{ type: 'text', text: JSON.stringify({
                stm_added: result.added,
                stm_total: (result.vault.content.unconsolidated_stm || []).length,
                ltm_total: (result.vault.content.ltm_entries || []).length,
                story_time: result.vault.content.story_time || '',
                story_scene: result.vault.content.story_scene || '',
                state_injected: injectResult.injected,
                state_injection_path: injectResult.targetPath || undefined,
                state_injection_reason: injectResult.injected ? undefined : (injectResult.reason || undefined),
                skipped: skippedCount > 0 ? skippedCount : undefined,
                warnings: warnings.length > 0 ? warnings : null
            }, null, 2) }] };
        }
    );

    server.tool('memory_get_state',
        'Read the current state: global context/period/date, participants, teams, medium_tasks, short_tasks, emergencies.',
        { chat_id: z.string().describe('Chat/session identifier') },
        async function(args) {
            var result = await ne.getState(args.chat_id);
            var text = JSON.stringify(result, null, 2);
            // Append lazy retrieval hints
            text += '\n\n// Lazy retrieval: use memory_access("chain.<Name>") for entity event timelines.\n' +
                '// State entities: memory_access("participants.<Name>"), memory_access("teams.<Name>"),\n' +
                '//   memory_access("medium_tasks.<ID>"), memory_access("short_tasks.<ID>"), memory_access("emergencies.<ID>")\n' +
                '// Time index: memory_access("time") for full timeline, memory_access("time.Day 5") for specific period.';
            return { content: [{ type: 'text', text: text }] };
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

            // ─── Auto-inject state into Rule file (awaited so caller sees result) ───
            var injectResult = { injected: false, reason: 'Not configured' };
            if (stateInjector) {
                try {
                    injectResult = await stateInjector(args.chat_id);
                } catch (e) {
                    injectResult = { injected: false, reason: e.message };
                }
            }

            return { content: [{ type: 'text', text: JSON.stringify({
                applied: result.applied,
                warnings: result.warnings || undefined,
                state_injected: injectResult.injected,
                state_injection_path: injectResult.targetPath || undefined,
                state_injection_reason: injectResult.injected ? undefined : (injectResult.reason || undefined)
            }, null, 2) }] };
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
            force: z.boolean().optional().describe('If true, reprocess entries even if already processed into STM'),
            type: z.string().optional().describe('Extraction mode: "general" for dev/conversation, "roleplay" for story (default: "roleplay")')
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
                    var result = await ne.extractSTM(args.chat_id, batches[i], { force: args.force || false, type: args.type || 'roleplay' });
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
        '  stmMaxUnconsolidated: unconsolidated STM count threshold to trigger auto-consolidation (default 30)\n' +
        '  useCursorEngine: whether cursor engine is enabled (default true)',
        {},
        async function(args) {
            var cfg = {
                stmBatch: ne.getConfig('stmBatch', 10),
                stmMaxUnconsolidated: ne.getConfig('stmMaxUnconsolidated', 30),
                useCursorEngine: ne.getConfig('useCursorEngine', true),
                extractionMode: ne.getConfig('extractionMode', 'agent'),
                initialStmWindow: ne.getConfig('initialStmWindow', 4),
                stmExpandStep: ne.getConfig('stmExpandStep', 4),
                maxStmWindow: ne.getConfig('maxStmWindow', 20),
                initialLtmWindow: ne.getConfig('initialLtmWindow', 8),
                ltmExpandStep: ne.getConfig('ltmExpandStep', 4),
                maxLtmWindow: ne.getConfig('maxLtmWindow', 30),
                stmMinBatchForCursor: ne.getConfig('stmMinBatchForCursor', 3),
                ltmMinBatch: ne.getConfig('ltmMinBatch', 15),
                bm25SimilarityThreshold: ne.getConfig('bm25SimilarityThreshold', 0.3),
                maxPartialGenerations: ne.getConfig('maxPartialGenerations', 3)
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
            var allowed = ['stmBatch', 'stmMaxUnconsolidated', 'useCursorEngine', 'extractionMode',
                'initialStmWindow', 'stmExpandStep', 'maxStmWindow',
                'initialLtmWindow', 'ltmExpandStep', 'maxLtmWindow',
                'stmMinBatchForCursor', 'ltmMinBatch', 'bm25SimilarityThreshold', 'maxPartialGenerations'];
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
                stmMaxUnconsolidated: ne.getConfig('stmMaxUnconsolidated', 30),
                useCursorEngine: ne.getConfig('useCursorEngine', true),
                extractionMode: ne.getConfig('extractionMode', 'agent')
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

    server.tool('memory_get_cursor_status',
        'Get the current cursor engine status for a chat session: STM/LTM positions, pending partials, and window state.',
        { chat_id: z.string().describe('Chat/session identifier') },
        async function(args) {
            if (!ne.getCursorStatus) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'Cursor engine not available. Set useCursorEngine: true in config.' }, null, 2) }] };
            }
            var result = await ne.getCursorStatus(args.chat_id);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_reset_cursor',
        'Reset the cursor engine position. Useful for debugging or re-processing from scratch.\n\n' +
        'If cursor_type is not specified, resets both STM and LTM cursors.',
        {
            chat_id: z.string().describe('Chat/session identifier'),
            cursor_type: z.string().optional().describe('Cursor type to reset: "stm", "ltm", or omit for both')
        },
        async function(args) {
            if (!ne.resetCursor) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'Cursor engine not available. Set useCursorEngine: true in config.' }, null, 2) }] };
            }
            var result = await ne.resetCursor(args.chat_id, args.cursor_type || null);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
    );

    server.tool('memory_inject_state',
        'Write the current vault state to the IDE/agent Rule file as auto-injected context.\n\n' +
        'The Rule file (e.g. .trae/rules/ne-memory-state.md) is automatically loaded by the IDE\n' +
        'on every request, giving the LLM persistent awareness of participants, tasks, scene,\n' +
        'and other state without needing to call MCP tools each time.\n\n' +
        'Call this tool after completing a milestone, task, or significant state change to\n' +
        'ensure the auto-injected Rule file reflects the latest state.\n\n' +
        'Auto-injected after memory_extract and memory_update_state by default — use this\n' +
        'tool only when you need an explicit immediate sync outside those flows.',
        {
            chat_id: z.string().describe('Chat/session identifier')
        },
        async function(args) {
            if (!stateInjector) {
                return { content: [{ type: 'text', text: JSON.stringify({
                    state_injected: false,
                    state_injection_reason: 'State injection not configured. Set project_root and state_injection.enabled in config.json, or set NE_MEMORY_PROJECT_ROOT env var.'
                }, null, 2) }] };
            }
            try {
                var result = await stateInjector(args.chat_id);
                return { content: [{ type: 'text', text: JSON.stringify({
                    state_injected: result.injected,
                    state_injection_path: result.targetPath || undefined,
                    state_injection_mode: result.mode || undefined,
                    state_injection_target: result.targetType || undefined,
                    state_injection_reason: result.reason || undefined
                }, null, 2) }] };
            } catch (e) {
                return { content: [{ type: 'text', text: JSON.stringify({ state_injected: false, state_injection_reason: e.message }, null, 2) }] };
            }
        }
    );

    server.tool('memory_get_processed_ids',
        'Get the set of message IDs that have been fully processed (STM extracted). ' +
        'Use this to determine which messages the cursor engine has already covered, ' +
        'so callers can avoid re-sending already-processed messages.',
        { chat_id: z.string().describe('Chat/session identifier') },
        async function(args) {
            var vault = await ne.read(args.chat_id);
            var ids = getProcessedMessageIds(vault);
            return { content: [{ type: 'text', text: JSON.stringify({
                chat_id: args.chat_id,
                processed_count: ids.length,
                processed_ids: ids
            }, null, 2) }] };
        }
    );
}
