// core/prompts.js — LLM prompt builders for memory operations
//
// Merged from: engine/retrieval.js, engine/consolidate.js (buildConsolidatePrompt),
// engine/update.js (buildSTMUpdatePrompt).
// No external dependencies.

import { filterCandidates } from './retrieval-filter.js';

// ─── Retrieval (recall_memory) ───

export function buildRetrievalPrompt(query, candidates, vault, budget, context, isSummaryMode) {
    budget = budget || 800;
    context = context || {};
    isSummaryMode = isSummaryMode || false;
    var content = vault.content || {};
    var lang = (content.language === 'en') ? 'en' : 'zh';
    var state = content.state || {};
    var timeParts = [];
    if (state.time || content.story_time) timeParts.push(state.time || content.story_time);
    if (content.story_date) timeParts.push(content.story_date);
    var currentTime = timeParts.join(' ─ ');

    var candidatesText = candidates.map(function(e, i) {
        var timePart = (e.time_range || e.period || '');
        if (e.time_label) timePart = timePart + '·' + e.time_label;
        var refs;
        if (e.msg_ids && e.msg_ids.length > 0) {
            refs = ' [→' + e.msg_ids.join(',') + ']';
        } else if (e.stm_refs && e.stm_refs.length > 0) {
            refs = ' [→' + e.stm_refs.join(',') + ']';
        } else {
            refs = '';
        }
        return (i + 1) + '. [' + timePart + '] ' + (e.scene || '') + ': ' + (e.event || e.summary || '') + refs;
    }).join('\n');

    var stmCount = content.stm_entries ? content.stm_entries.length : 0;
    var ltmCount = content.ltm_entries ? content.ltm_entries.length : 0;

    // Build entity chain context
    var chainsBlock = '';
    var chains = context.chains || {};
    var chainKeys = Object.keys(chains);
    if (chainKeys.length > 0) {
        chainsBlock = '\n## Known Entity Timelines\n';
        chainKeys.forEach(function(name) {
            var chainData = chains[name];
            if (chainData && chainData.length > 0) {
                chainsBlock += '### ' + name + ' (' + chainData.length + ' events)\n';
                chainData.forEach(function(e, i) {
                    var label = (e.period || '') + (e.time_label ? '·' + e.time_label : '');
                    chainsBlock += (i + 1) + '. [' + label + '] ' + (e.scene || '') + ': ' + (e.event || '') + '\n';
                });
                chainsBlock += '\n';
            }
        });
    }

    // Build state summary context
    var stateBlock = '';
    if (context.stateSummary) {
        stateBlock = '\n## Current State\n' + context.stateSummary + '\n';
    }

    // Determine if chains are available for GROUPING rule hint
    var hasChains = chainKeys.length > 0;

    // Determine mode: 'roleplay' or 'general'
    var mode = context.mode || 'roleplay';

    // ── General Agent Mode (EN) — Layered lazy retrieval prompt ──
    if (mode === 'general' && lang === 'en') {
        return buildGeneralAgentPrompt(query, candidates, vault, budget, context, isSummaryMode, currentTime);
    }

    if (lang === 'en') {
        // Mode-specific wording
        var groupingLabel = (mode === 'general') ? 'topic' : 'narrative thread';
        var groupingLabelPlural = (mode === 'general') ? 'topics' : 'narrative threads';
        var proseLabel = (mode === 'general') ? 'coherent paragraphs' : 'narrative prose';
        var outputLabel = (mode === 'general') ? 'entity/topic' : 'entity/thread';

        var groupingRule;
        if (hasChains) {
            groupingRule = (mode === 'general')
                ? '2. GROUPING: The entity timelines above provide pre-grouped context. Use them as primary topic threads. Supplement with BM25 candidates where relevant.\n'
                : '2. GROUPING: The entity timelines above provide pre-grouped context. Use them as primary narrative threads. Supplement with BM25 candidates where relevant.\n';
        } else {
            groupingRule = (mode === 'general')
                ? '2. GROUPING: group remaining entries by topic. Each topic = one related context area.\n'
                : '2. GROUPING: group remaining entries into narrative threads. Each thread = one related storyline.\n';
        }

        var system = 'You are a memory retrieval assistant for an AI agent. You have tracked ' + stmCount + ' STM entries and ' + ltmCount + ' LTM entries.\n\n' +
            'Your task: given a query and memory context, determine which information is relevant, group it by ' + groupingLabel + ', and return a concise synthesized answer.\n\n' +
            'Rules:\n' +
            (isSummaryMode ? 'TIME SUMMARY MODE: The candidates are a complete chronological listing for the requested time period. ' +
                'Summarize ALL events in chronological order. Do NOT skip minor events. ' +
                'Group by entity/topic where natural, but preserve time ordering within each group.\n' : '') +
            '1. RELEVANCE: remove entries unrelated to the query. If relevance is uncertain, keep.\n' +
            groupingRule +
            '3. SYNTHESIS: write each ' + groupingLabel + ' as a single coherent paragraph, using ' + proseLabel + ' (not bullet points). Include key details from entries.\n' +
            '4. TIME FORMAT: prefix each reference with its time coordinate. Use the format "{period}·{time_label}·{scene}". The period comes from state.time format — do NOT invent your own time labels or "X rounds ago".\n' +
            '5. SOURCE MARKERS: end each factual claim with [→X] or [→stm:id] or [→state:path]. If multiple entries support the same claim, list all.\n' +
            '6. COGNITIVE LOAD: if there are more than 10 candidates, select only the 3-5 most important ' + groupingLabelPlural + '. Ignore the remaining candidates.\n\n' +
            'Output format:\n' +
            '## <' + outputLabel + ' name>\n<coherent paragraph with source markers>\n→ Current time: ' + currentTime + ' [→state:time]\n\n' +
            '## <' + outputLabel + ' name>\n...\n\n' +
            '## Other relevant\n<any remaining relevant entries, brief>\n\n' +
            'Keep the total response under ' + budget + ' tokens.\n\n' +
            'SELF-VERIFICATION: before returning, check for internal contradictions. If two entries describe the same entity/event with conflicting info, note which is more recent.\n\n' +
            (mode === 'general'
                ? 'MULTI-TOPIC: If the query contains ";;" separators, process each segment independently. Output one "## <topic>" section per segment.\n\n'
                : 'MULTI-TOPIC: If the query contains ";;" separators, process each segment independently. Group by topic segment, NOT by narrative thread. Output one "## <topic>" section per segment.\n\n') +
            (mode === 'general'
                ? 'TASK OUTPUT: When the query relates to task/project status, prefer a structured format:\n' +
                  '## <topic>\n**Status:** <current state>\n**Key People:** <names and roles>\n**Timeline:** <key dates>\n<paragraph with details and source markers>\n\n'
                : '') +
            stateBlock + chainsBlock +
            'Query: ' + query + '\n\nCandidates:\n' + candidatesText;

        return { system: system, user: 'Synthesize the relevant memories. Return only the formatted answer, no preamble.' };
    }

    // Mode-specific wording (ZH)
    var zhGroupingLabel = (mode === 'general') ? '话题' : '叙事线';
    var zhGroupingLabelPlural = (mode === 'general') ? '话题' : '叙事线';
    var zhProseLabel = (mode === 'general') ? '连贯段落' : '叙事性语言';
    var zhOutputLabel = (mode === 'general') ? '实体/话题' : '实体/叙事线';

    var zhGroupingRule;
    if (hasChains) {
        zhGroupingRule = (mode === 'general')
            ? '2. 分组：上方的实体时间线提供了预分组上下文。将其作为主要话题线。适当补充 BM25 候选条目。\n'
            : '2. 分组：上方的实体时间线提供了预分组上下文。将其作为主要叙事线。适当补充 BM25 候选条目。\n';
    } else {
        zhGroupingRule = (mode === 'general')
            ? '2. 分组：将剩余条目按话题分组。每条线 = 一个相关联的话题领域。\n'
            : '2. 分组：将剩余条目按叙事线分组。每条线 = 一个相关联的故事线。\n';
    }

    var systemZh = '你是一个 AI Agent 的记忆检索助手。你已追踪 ' + stmCount + ' 条 STM 条目和 ' + ltmCount + ' 条 LTM 条目。\n\n' +
        '任务：根据查询和记忆上下文，判断相关性，按' + zhGroupingLabel + '分组，返回简洁的叙事合成答案。\n\n' +
        '规则：\n' +
        (isSummaryMode ? '时间摘要模式：候选条目是所请求时间段的完整时间序列。' +
            '按时间顺序概括所有事件。不要跳过次要事件。' +
            '按实体/话题自然分组，但每组内保持时间顺序。\n' : '') +
        '1. 相关性：剔除与查询无关的条目。不确定时保留。\n' +
        zhGroupingRule +
        '3. 合成：每条' + zhGroupingLabel + '写成一个连贯段落，使用' + zhProseLabel + '（非列表格式）。包含条目的关键细节。\n' +
        '4. 时间格式：每个引用前标注时间坐标，格式为"{period}·{time_label}·{scene}"。禁止编造 "Chapter X" 或 "X轮前" 等标签。\n' +
        '5. 来源标记：每个事实性陈述后标注 [→X] 或 [→stm:id] 或 [→state:path]。\n' +
        '6. 认知负荷：若候选条目超过 10 条，仅选择 3-5 条最重要的' + zhGroupingLabelPlural + '。忽略其余。\n\n' +
        '输出格式：\n' +
        '## <' + zhOutputLabel + '名>\n<连贯段落 + 来源标记>\n→ 当前时间: ' + currentTime + ' [→state:time]\n\n' +
        '## <' + zhOutputLabel + '名>\n...\n\n' +
        '## 其他相关\n<剩余相关条目，简要>\n\n' +
        '回复总长度控制在 ' + budget + ' tokens 以内。\n\n' +
        '自我一致性检查：返回前检查内部矛盾。若两个条目描述同一实体/事件的冲突信息，标注较近时间的条目。\n\n' +
        (mode === 'general'
            ? '多话题处理：如果查询中包含 ";;" 分隔符，独立处理每个片段。按话题分段输出。每个片段输出一个 "## <话题>" 节。\n\n'
            : '多话题处理：如果查询中包含 ";;" 分隔符，独立处理每个片段。按话题分段输出，而非按叙事线。每个片段输出一个 "## <话题>" 节。如果话题涉及同一实体，合并它们。\n\n') +
        (mode === 'general'
            ? '任务型输出：当查询涉及任务/项目状态时，优先使用结构化格式：\n' +
              '## <话题>\n**状态：** <当前状态>\n**关键人物：** <姓名与角色>\n**时间线：** <关键日期>\n<包含细节和来源标记的段落>\n\n'
            : '') +
        stateBlock + chainsBlock +
        '查询：' + query + '\n\n候选记忆：\n' + candidatesText;

    return { system: systemZh, user: '合成相关记忆。仅返回格式化答案，无前缀。' };
}

// ─── General Agent Retrieval Prompt (EN) — Layered lazy retrieval ───

function buildGeneralAgentPrompt(query, candidates, vault, budget, context, isSummaryMode, currentTime) {
    budget = budget || 800;
    var content = vault.content || {};

    // ── Build entity chain set for dedup ──
    var chains = context.chains || {};
    var chainKeys = Object.keys(chains);
    var chainEntryIds = {};
    chainKeys.forEach(function(name) {
        var chainData = chains[name];
        if (chainData && chainData.length > 0) {
            chainData.forEach(function(e) {
                chainEntryIds[e.id] = true;
            });
        }
    });

    // ── Helper: format a single candidate line ──
    function formatLine(e, idx) {
        var typeTag = (e.__type || '').toLowerCase() === 'ltm' || (e.stm_refs && e.stm_refs.length > 0) ? 'LTM' : 'STM';
        var timeText = (e.time_range || e.period || '');
        if (e.time_label) timeText = timeText + ' · ' + e.time_label;
        var sceneText = (e.scene || '').substring(0, 24);
        var eventText = (e.event || e.summary || '').substring(0, 150);
        var num = String(idx + 1);
        return '[#' + num + '] ' + typeTag + ' · ' + timeText.padEnd(14) + ' · ' + sceneText.padEnd(24) + eventText;
    }

    // ── Section 1: ENTITY TIMELINES ──
    var timelinesSection = '';
    var timelineIds = {};
    if (chainKeys.length > 0) {
        timelinesSection = '━━━ ENTITY TIMELINES ━━━\n';
        chainKeys.forEach(function(name) {
            var chainData = chains[name];
            if (!chainData || chainData.length === 0) return;
            var displayed = chainData.slice(0, 8);
            displayed.forEach(function(e) { timelineIds[e.id] = true; });
            timelinesSection += '## ' + name + ' (' + displayed.length + ' events)\n';
            displayed.forEach(function(e, i) {
                timelinesSection += formatLine(e, i) + '\n';
            });
            timelinesSection += '\n';
        });
    }

    // ── Section 2: STATE (from formatCompactStateSummary) ──
    var stateSection = '';
    if (context.stateSummary) {
        stateSection = '━━━ STATE ━━━\n' + context.stateSummary + '\n';
    }

    // ── Section 3: MEMORY (BM25 candidates, deduped from timelines) ──
    var memoryCandidates = candidates.filter(function(c) {
        return !timelineIds[c.id] && !timelineIds[c.__id];
    });
    var memorySection = '━━━ MEMORY (BM25, ' + memoryCandidates.length + ' candidates) ━━━\n';
    if (isSummaryMode) {
        memorySection = '━━━ TIMELINE (chronological, ' + memoryCandidates.length + ' entries) ━━━\n';
    }
    memorySection += memoryCandidates.map(function(c, i) {
        return formatLine(c, i);
    }).join('\n');

    // ── System prompt ──
    var system = 'You are a memory retrieval assistant for an AI coding agent.\n' +
        'Synthesize the provided context into a concise, factual answer.\n\n' +
        'CONTEXT ORGANIZATION:\n' +
        '- STATE: snapshot of project/team/task state. Highest confidence — use for factual answers.\n' +
        '- ENTITY TIMELINES: events grouped by person/component.\n' +
        '- MEMORY: BM25-ranked entries. [STM]=single event (narrow scope), [LTM]=consolidated summary (broader scope).\n\n' +
        'RULES:\n' +
        '1. Answer the query directly. Skip unrelated entries.\n' +
        '2. STATE facts are highest-confidence — use them to resolve contradictions.\n' +
        '3. Include specifics: dates, names, numbers, bug IDs, PR numbers, decisions.\n' +
        '4. Be concise — a short complete answer is better than a rambling catalog.\n' +
        '5. Reference entries as [#N] when citing facts from MEMORY.\n' +
        (isSummaryMode ? '6. This is a complete chronological listing. Summarize all events in order.\n' : '') +
        '\n' +
        'OUTPUT (adapt to query intent):\n' +
        '- Status/progress → structured: Status, Timeline, Key People\n' +
        '- Entity/person → entity-focused summary with timeline\n' +
        '- Cause-analysis → root cause → fix → verification\n' +
        '- General → topic-grouped paragraphs\n' +
        '\n' +
        'If the context cannot answer the query, say so.\n' +
        '\n' +
        stateSection + '\n' +
        timelinesSection + '\n' +
        memorySection + '\n' +
        'Query: ' + query;

    return { system: system, user: 'Synthesize the relevant context. Return only the answer, no preamble.' };
}

export function buildRetrievalMessages(query, candidates, vault, budget, context, isSummaryMode) {
    var prompt = buildRetrievalPrompt(query, candidates, vault, budget, context, isSummaryMode);
    return [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
    ];
}

// ─── Cursor Engine Prompts (v2) ───
// 供 cursor.js 使用的增量 prompt 构建器。
// 与旧的 batch prompt 不同：只发送新输入 + partial 摘要 + BM25 预分组提示。

export function buildStmCursorPrompt(params) {
    // params: { items, startIdx, preGroups, partials, allowSkip, mode, force }
    params = params || {};
    var items = params.items || [];
    var startIdx = params.startIdx || 0;
    var preGroups = params.preGroups || '';
    var partials = params.partials || [];
    var allowSkip = params.allowSkip !== undefined ? params.allowSkip : false;
    var force = params.force || false;

    // Format messages
    var msgs = items.map(function(m, i) {
        var role = m.role || (m.is_user ? 'user' : 'assistant');
        return '[' + (startIdx + i) + '] ' + role + ': ' + (m.content || m.mes || '');
    }).join('\n');

    // Format partial context
    var partialCtx = '';
    if (partials.length > 0) {
        partialCtx = '\n## 上次未完成的事件（需要在本次窗口中继续追踪）：\n';
        partials.forEach(function(p, i) {
            var desc = p.event || '';
            var range = p.msgRange || [];
            var rangeStr = range.length === 2 ? '[' + range[0] + '-' + range[1] + ']' : '[ongoing]';
            partialCtx += '  ' + (i + 1) + '. ' + rangeStr + ' ' + desc + '\n';
        });
        partialCtx += '\n如果当前窗口中的消息能闭合上述 partial 事件，请在对应条目中设置 "parent_partial": "<事件描述>"。\n';
    }

    // Build system prompt
    var system = '你是事件提取引擎。从以下 ' + items.length + ' 条新消息中提取可独立描述的事件。\n\n' +
        '规则：\n' +
        '1. 每条事件标注 "msgRange": [startIdx, endIdx]（相对于窗口内索引），表示覆盖的消息范围\n' +
        '2. "status": "closed" 表示事件已完整描述；"status": "partial" 表示事件仍在发展中，窗口内消息不足以描述完整\n' +
        '3. ' + (allowSkip
            ? '可以跳过与事件无关的消息（msgRange 可以不连续覆盖）。\n'
            : '消息必须连续覆盖，不能跳过任何消息。每条消息都必须归属于某条 STM。\n') +
        '4. 一次可以提取多条事件（0-10条）。如果没有可提取的事件，返回 []\n' +
        '5. "topic" 字段标注话题类别（如：设计/架构/bug/功能/配置/讨论）\n' +
        '6. "event" 字段使用简洁描述（最长100字）\n' +
        '7. "entity": "实体名" — 可选。标注该事件涉及的核心实体（角色/组织等）。多条实体用逗号分隔' +
        (force ? '\n\n⚠️ 已到达窗口硬上限，请务必返回至少一条 closed 或 partial 结果。不允许返回空数组。' : '') +
        partialCtx +
        (preGroups ? '\n' + preGroups : '');

    return {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: '最新消息：\n\n' + msgs + '\n\n仅输出一个 JSON 数组：\n[\n  { "event": "...", "msgRange": [0, 2], "status": "closed"|"partial", "topic": "话题", "entity": "实体名", "parent_partial": null },\n  ...\n]' }
        ],
        options: { temperature: 0.1 }
    };
}

export function buildLtmCursorPrompt(params) {
    // params: { items, startIdx, preGroups, partials, allowSkip, mode, force }
    params = params || {};
    var items = params.items || [];
    var startIdx = params.startIdx || 0;
    var preGroups = params.preGroups || '';
    var partials = params.partials || [];
    var force = params.force || false;

    // Format STM entries
    var stmText = items.map(function(s, i) {
        var period = s.period || '';
        var scene = s.scene || '';
        var event = s.event || s.summary || '';
        return '[' + (startIdx + i) + '] ' + period + ' ' + scene + ': ' + event + ' (id=' + (s.id || '?') + ')';
    }).join('\n');

    // Format partial context
    var partialCtx = '';
    if (partials.length > 0) {
        partialCtx = '\n## 上次未收敛的概念（需要在本次窗口中继续追踪）：\n';
        partials.forEach(function(p, i) {
            var desc = p.summary || p.event || '';
            var range = p.stmRange || [];
            var rangeStr = range.length === 2 ? '[' + range[0] + '-' + range[1] + ']' : '[ongoing]';
            partialCtx += '  ' + (i + 1) + '. ' + rangeStr + ' ' + desc + '\n';
        });
        partialCtx += '\n如果当前窗口中的 STM 能闭合上述 partial 概念，请在对应条目中设置 "parent_partial": "<事件描述>"。\n';
    }

    // Get existing LTM for context
    var system = '你是长期记忆整合引擎。将短期记忆 (STM) 条目合并为长期记忆 (LTM) 摘要。\n\n' +
        '规则：\n' +
        '1. 每条 LTM 标注 "stmRange": [startIdx, endIdx]（相对于窗口内索引），表示覆盖的 STM 范围\n' +
        '2. "status": "closed" 表示概念已收敛完整；"status": "partial" 表示概念仍在发展中\n' +
        '3. STM 必须连续覆盖，不能跳过任何 STM 条目。所有输入 STM 都必须归属于某个 LTM 条目\n' +
        '4. 一次可以整合多条 LTM（0-5条）。如果没有可整合的内容，返回 []\n' +
        '5. "summary" 字段使用简洁摘要（最长150字）\n' +
        '6. "concepts" 字段列出关键概念（字符串数组）\n' +
        '7. 仅输出整合后的新 LTM 条目，不要重复已有 LTM\n' +
        (force ? '\n\n⚠️ 已到达窗口硬上限，请务必返回至少一条 closed 或 partial 结果。不允许返回空数组。' : '') +
        partialCtx +
        (preGroups ? '\n' + preGroups : '');

    return {
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: '未整合的 STM 条目：\n\n' + stmText + '\n\n仅输出一个 JSON 数组：\n[\n  { "summary": "...", "stmRange": [0, 3], "status": "closed"|"partial", "concepts": ["概念1"], "parent_partial": null },\n  ...\n]' }
        ],
        options: { temperature: 0.2 }
    };
}
