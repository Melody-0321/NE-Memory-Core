// core/prompts.js — LLM prompt builders for memory operations
//
// Merged from: engine/retrieval.js, engine/consolidate.js (buildConsolidatePrompt),
// engine/update.js (buildSTMUpdatePrompt).
// No external dependencies.

import { filterCandidates } from './retrieval-filter.js';

// ─── Retrieval (recall_memory) ───

export function buildRetrievalPrompt(query, candidates, vault, budget) {
    budget = budget || 800;
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

    if (lang === 'en') {
        var system = 'You are the Memory Vault for an ongoing roleplay. Current story time: ' + currentTime + '. You have tracked ' + stmCount + ' STM entries and ' + ltmCount + ' LTM entries.\n\n' +
            'Your task: given a query and a shortlist of memory candidates, determine which entries are relevant, group them by narrative thread, and return a concise synthesized answer.\n\n' +
            'Rules:\n' +
            '1. RELEVANCE: remove entries unrelated to the query. If relevance is uncertain, keep.\n' +
            '2. GROUPING: group remaining entries into narrative threads. Each thread = one related storyline.\n' +
            '3. SYNTHESIS: write each thread as a single coherent paragraph, using narrative prose (not bullet points). Include key details from entries.\n' +
            '4. TIME FORMAT: prefix each reference with its time coordinate. Use the format "{period}·{time_label}·{scene}". The period comes from state.time format — do NOT invent your own time labels or "X rounds ago".\n' +
            '5. SOURCE MARKERS: end each factual claim with [→X] or [→stm:id] or [→state:path]. If multiple entries support the same claim, list all.\n' +
            '6. CURRENT TIME ANCHOR: after each narrative thread, add a line:\n' +
            '   → Current time: ' + currentTime + ' [→state:time]\n\n' +
            'Output format:\n' +
            '## <narrative thread 1>\n<coherent paragraph with source markers>\n→ Current time: ' + currentTime + ' [→state:time]\n\n' +
            '## <narrative thread 2>\n...\n\n' +
            '## Other relevant\n<any remaining relevant entries, brief>\n\n' +
            'Keep the total response under ' + budget + ' tokens.\n\n' +
            'SELF-VERIFICATION: before returning, check for internal contradictions. If two entries describe the same entity/event with conflicting info, note which is more recent and explain the resolution.\n\n' +
            'MULTI-TOPIC: If the query contains ";;" separators, process each segment independently. Group by topic segment, NOT by narrative thread. Output one "## <topic>" section per segment. If topics are related to the same entity, combine them.\n\n' +
            'Query: ' + query + '\n\nCandidates:\n' + candidatesText;

        return { system: system, user: 'Synthesize the relevant memories. Return only the formatted answer, no preamble.' };
    }

    var systemZh = '你是这个角色扮演的记忆中枢。当前故事时间：' + currentTime + '。你已追踪 ' + stmCount + ' 条 STM 条目和 ' + ltmCount + ' 条 LTM 条目。\n\n' +
        '任务：根据查询和候选记忆清单，判断相关性，按叙事线分组，返回简洁的叙事合成答案。\n\n' +
        '规则：\n' +
        '1. 相关性：剔除与查询无关的条目。不确定时保留。\n' +
        '2. 分组：将剩余条目按叙事线分组。每条线 = 一个相关联的故事线。\n' +
        '3. 合成：每条叙事线写成一个连贯段落，使用叙事性语言（非列表格式）。包含条目的关键细节。\n' +
        '4. 时间格式：每个引用前标注时间坐标，格式为"{period}·{time_label}·{scene}"。禁止编造 "Chapter X" 或 "X轮前" 等标签。\n' +
        '5. 来源标记：每个事实性陈述后标注 [→X] 或 [→stm:id] 或 [→state:path]。\n' +
        '6. 当前时间锚点：每个叙事段末尾追加：\n' +
        '   → 当前时间: ' + currentTime + ' [→state:time]\n\n' +
        '输出格式：\n' +
        '## <叙事线1>\n<连贯段落 + 来源标记>\n→ 当前时间: ' + currentTime + ' [→state:time]\n\n' +
        '## <叙事线2>\n...\n\n' +
        '## 其他相关\n<剩余相关条目，简要>\n\n' +
        '回复总长度控制在 ' + budget + ' tokens 以内。\n\n' +
        '自我一致性检查：返回前检查内部矛盾。若两个条目描述同一实体/事件的冲突信息，标注较近时间的条目并解释结论。\n\n' +
        '多话题处理：如果查询中包含 ";;" 分隔符，独立处理每个片段。按话题分段输出，而非按叙事线。每个片段输出一个 "## <话题>" 节。如果话题涉及同一实体，合并它们。\n\n' +
        '查询：' + query + '\n\n候选记忆：\n' + candidatesText;

    return { system: systemZh, user: '合成相关记忆。仅返回格式化答案，无前缀。' };
}

export function buildRetrievalMessages(query, candidates, vault, budget) {
    var prompt = buildRetrievalPrompt(query, candidates, vault, budget);
    return [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
    ];
}

// ─── STM Extraction ───

export function buildSTMUpdatePrompt(newMessages, vault) {
    var content = vault.content || {};
    var lang = (content.language === 'en') ? 'en' : 'zh';
    var state = content.state || {};
    var timeParts = [];
    if (state.time || content.story_time) timeParts.push(state.time || content.story_time);
    if (content.story_date) timeParts.push(content.story_date);
    var currentTime = timeParts.join(' ─ ');
    var currentScene = state.scene || content.story_scene || '';

    var msgs = newMessages.map(function(m, i) {
        var role = m.role || (m.is_user ? 'user' : 'assistant');
        return '[' + (i + 1) + '] ' + role + ': ' + (m.mes || m.content || '');
    }).join('\n');

    if (lang === 'en') {
        return {
            system: 'You are an event extraction engine for a roleplay. Current time: ' + currentTime + '. Current scene: ' + currentScene + '.\n\n' +
                'Extract key story events from the latest messages. Output ONLY a JSON object:\n' +
                '{\n' +
                '  "_checkpoints": { "time": "current story time after these messages (even if unchanged, keep same value)", "scene": "current scene after these messages (even if unchanged, keep same value)" },\n' +
                '  "stm_entries": [{ "event": "concise summary (max 80)", "time_label": "optional fine-grained time like morning/afternoon etc" }]\n' +
                '}\n\n' +
                'Only extract events that advance the story, NOT every single dialogue line. Typically 1-3 events per batch.',
            user: 'Latest messages:\n\n' + msgs
        };
    }

    return {
        system: '你是一个角色扮演的事件提取引擎。当前时间：' + currentTime + '。当前场景：' + currentScene + '。\n\n' +
            '从最新消息中提取关键故事事件。仅输出一个 JSON 对象：\n' +
            '{\n' +
            '  "_checkpoints": { "time": "这些消息之后的故事时间（如无变化则保持原值）", "scene": "这些消息之后的故事场景（如无变化则保持原值）" },\n' +
            '  "stm_entries": [{ "event": "简洁摘要（最长80字）", "time_label": "可选的细粒度时间标签，如早晨/下午等" }]\n' +
            '}\n\n' +
            '只提取推动故事发展的事件，不要每条对话都提取。通常每批 1-3 个事件。',
        user: '最新消息：\n\n' + msgs
    };
}

// ─── LTM Consolidation ───

export function buildConsolidatePrompt(vault) {
    var content = vault.content || {};
    var lang = content.language === 'en' ? 'en' : 'zh';
    var ltmEntries = content.ltm_entries || [];
    var unconsolidated = (content.unconsolidated_stm || []).filter(function(stm) { return !stm.parent_ltm; });
    var ltmText = ltmEntries.map(function(e, i) {
        var refs = (e.stm_refs || []).join(', ');
        return (i + 1) + '. [' + (e.period || '') + '] ' + (e.scene || '') + ': ' + (e.event || '') + ' [→' + refs + ']';
    }).join('\n');
    var stmText = unconsolidated.map(function(e, i) {
        var refs = (e.msg_ids || []).join(', ');
        return (i + 1) + '. [' + (e.period || '') + '] ' + (e.time_label ? e.time_label + '·' : '') + (e.scene || '') + ': ' + (e.event || '') + ' [→' + refs + ']';
    }).join('\n');

    if (lang === 'en') {
        return {
            system: 'You merge short-term memories into long-term memory summaries.\n\n' +
                'Existing LTM:\n' + (ltmText || '(none)') + '\n\n' +
                'Unconsolidated STM:\n' + stmText + '\n\n' +
                'Output ONLY a JSON object:\n' +
                '{\n' +
                '  "ltm_entries": [{ "period": "time range from source STM entries (max 15). Use same format as state.time, e.g. \'Day 3-5\' or \'Day 3·黄昏→Day 5·深夜\'", "scene": "scene (max 20)", "event": "merged summary (max 100)", "stm_refs": ["stm_id1", "stm_id2"] }],\n' +
                '  "delete_stm_ids": []\n' +
                '}\n\n' +
                'IMPORTANT: NEVER put STM IDs in "delete_stm_ids". Always keep original STM entries. Only add new LTM entries and reference the STM IDs in stm_refs.',
            user: 'Merge the unconsolidated STM entries into LTM. Return only JSON.'
        };
    }

    return {
        system: '你将短期记忆条目合并为长期记忆摘要。\n\n' +
            '已有 LTM：\n' + (ltmText || '（无）') + '\n\n' +
            '未整合的 STM：\n' + stmText + '\n\n' +
            '仅输出一个 JSON 对象：\n' +
            '{\n' +
            '  "ltm_entries": [{ "period": "来源 STM 条目的时间范围（最长15字）。使用与 state.time 相同的格式，如 \'Day 3-5\' 或 \'Day 3·黄昏→Day 5·深夜\'", "scene": "场景（最长20字）", "event": "合并摘要（最长100字）", "stm_refs": ["stm_id1", "stm_id2"] }],\n' +
            '  "delete_stm_ids": []\n' +
            '}\n\n' +
            '重要：永远不要将 STM ID 放入 "delete_stm_ids"。始终保留原有的 STM 条目。只新增 LTM 条目并在 stm_refs 中引用 STM ID。',
        user: '将未整合的 STM 条目合并为 LTM。仅返回 JSON。'
    };
}
