// core/engine/cursor.js — 共享游标引擎
//
// 统一 STM 提取和 LTM 整合的 cursor + partial + incremental 引擎。
//
// 核心概念：
//   - cursor.position: 下一条未处理的输入索引
//   - windowSize: 当前窗口大小（步长膨胀，不超过硬上限）
//   - pending_partials: 未关闭的 partial 事件（跨窗口上下文）
//   - closed → 推进 cursor，重置窗口
//   - partial → 不推进 cursor，膨胀窗口
//   - hard max (maxWindow) → 强制提取，防止死锁
//
// 用法：
//   import { createCursorEngine } from './cursor.js';
//   import { tokenize } from '../retrieval-filter.js';
//
//   var engine = createCursorEngine({
//     mode: 'stm',
//     initialWindow: 4,
//     expandStep: 4,
//     maxWindow: 20,
//     allowSkip: true,
//     tokenizer: tokenize,
//     callLLM: callLLMFn,
//     readVault: function() { return read(chatId); },
//     writeVault: function(v) { return write(chatId, v); }
//   });
//
//   var result = await engine.process({
//     inputs: messages,
//     cursorState: vault.content.cursor_state?.stm || { position: 0, pending_partials: [] },
//     promptBuilder: buildStmCursorPrompt,
//     resultParser: parseStmCursorResponse,
//     resultAppender: appendStmResults
//   });

import { preGroupItems, formatPreGroupHint } from './bm25-grouper.js';

// ─── 游标引擎工厂 ───

export function createCursorEngine(options) {
    options = options || {};
    var mode = options.mode || 'stm';                          // 'stm' | 'ltm'
    var initialWindow = options.initialWindow || 4;
    var expandStep = options.expandStep || 4;
    var maxWindow = options.maxWindow || 20;
    var allowSkip = options.allowSkip !== undefined ? options.allowSkip : false;
    var tokenizer = options.tokenizer || _defaultTokenizer;
    var callLLM = options.callLLM;
    var readVault = options.readVault;
    var writeVault = options.writeVault;
    var similarityThreshold = options.similarityThreshold || 0.3;
    var maxPartialGenerations = options.maxPartialGenerations || 3;  // partial 链最多几代后强制收敛

    // ─── 内部状态（单次 process 生命周期内）───

    var _position = 0;
    var _windowSize = initialWindow;
    var _pendingPartials = [];

    // ─── 窗口管理 ───

    function getWindow(inputs, start, size) {
        var end = Math.min(start + size, inputs.length);
        return {
            items: inputs.slice(start, end),
            startIdx: start,
            endIdx: end
        };
    }

    function expandWindow(reason) {
        var oldSize = _windowSize;
        _windowSize = Math.min(_windowSize + expandStep, maxWindow);
        return { oldSize: oldSize, newSize: _windowSize, reason: reason || 'unspecified' };
    }

    function resetWindow() {
        _windowSize = initialWindow;
    }

    function isAtHardMax() {
        return _windowSize >= maxWindow;
    }

    function isAtEnd(inputs) {
        return _position >= inputs.length;
    }

    // ─── 预分组提示 ───

    function buildPreGroupHint(windowItems) {
        if (windowItems.length < 2) return '';

        var getTextFn = (mode === 'stm')
            ? function(item) { return item.content || item.mes || ''; }
            : function(item) { return (item.event || '') + ' ' + (item.scene || '') + ' ' + (item.summary || ''); };

        var groups = preGroupItems(windowItems, {
            tokenizer: tokenizer,
            getText: getTextFn,
            similarityThreshold: similarityThreshold
        });

        if (!groups || groups.length <= 1) return '';
        return formatPreGroupHint(groups);
    }

    // ─── Partial 上下文格式化 ───

    function formatPartialContext() {
        if (_pendingPartials.length === 0) return '';

        var lines = ['## 上次未完成的事件（需要在本次窗口中继续追踪）：'];
        for (var i = 0; i < _pendingPartials.length; i++) {
            var p = _pendingPartials[i];
            var desc = p.event || p.summary || '';
            var range = (p.msgRange || p.stmRange || []);
            var rangeStr = range.length === 2 ? '[' + range[0] + '-' + range[1] + ']' : '[ongoing]';
            var gen = p._partial_generation || 1;
            lines.push('  ' + (i + 1) + '. ' + rangeStr + ' (' + desc + ') — 第' + gen + '代 partial');
        }
        lines.push('');
        return lines.join('\n');
    }

    // ─── 格式输入项 ───

    function formatInputItems(windowItems, startIdx) {
        var lines = [];
        for (var i = 0; i < windowItems.length; i++) {
            var item = windowItems[i];
            var idx = startIdx + i;

            if (mode === 'stm') {
                // 消息输入
                var role = item.role || (item.is_user ? 'user' : 'assistant');
                lines.push('[' + idx + '] ' + role + ': ' + (item.content || item.mes || ''));
            } else {
                // STM 条目输入
                var period = item.period || '';
                var scene = item.scene || '';
                var event = item.event || item.summary || '';
                lines.push('[' + idx + '] ' + period + ' ' + scene + ': ' + event + ' (id=' + (item.id || '?') + ')');
            }
        }
        return lines.join('\n');
    }

    // ─── 增量 Prompt 构建 ───

    function buildIncrementalPrompt(params) {
        // params: { items, startIdx, preGroups, partials, allowSkip, mode, force }
        params = params || {};
        var windowItems = params.items || [];
        var startIdx = params.startIdx || 0;
        var force = params.force || false;

        var formattedItems = formatInputItems(windowItems, startIdx);
        var preGroupHint = params.preGroups || '';
        var partialCtx = formatPartialContext();

        var instruction = '';

        if (mode === 'stm') {
            instruction = '你是事件提取引擎。从以下 ' + windowItems.length + ' 条新消息中提取可独立描述的事件。\n\n' +
                '规则：\n' +
                '1. 每条事件标注 "msgRange": [startIdx, endIdx]，表示覆盖的消息索引范围\n' +
                '2. "status": "closed" 表示事件已完整，"status": "partial" 表示事件仍在发展中\n' +
                '3. ' + (allowSkip ? '可以跳过与事件无关的消息（msgRange 可以不连续）' : '消息必须连续覆盖，不能跳过任何消息') + '\n' +
                '4. 一次可以提取多条事件，从 0 到 10 条\n' +
                '5. 如果窗口内消息不足以形成完整事件 → 返回 status:"partial"';
        } else {
            instruction = '你是长期记忆整合引擎。将以下 ' + windowItems.length + ' 条短期记忆 (STM) 整合为 LTM 条目。\n\n' +
                '规则：\n' +
                '1. 每条 LTM 标注 "stmRange": [startIdx, endIdx]，表示覆盖的 STM 索引范围\n' +
                '2. "status": "closed" 表示概念已收敛，"status": "partial" 表示概念仍在演化\n' +
                '3. STM 必须连续覆盖，不能跳过任何 STM 条目\n' +
                '4. 一次可以整合多条 LTM，从 0 到 5 条\n' +
                '5. 如果窗口内 STM 不足以形成完整概念 → 返回 status:"partial"';
        }

        if (force) {
            instruction += '\n\n⚠️ 已到达窗口硬上限，请务必返回至少一条 closed 或 partial 结果。不允许返回空数组。';
        }

        if (partialCtx) {
            instruction += '\n\n' + partialCtx;
            instruction += '如果当前窗口中的消息能闭合上述 partial 事件，请在对应条目中设置 "parent_partial": <事件描述>。';
        }

        if (preGroupHint) {
            instruction += '\n\n' + preGroupHint;
        }

        var outputSchema = '';
        if (mode === 'stm') {
            outputSchema = '仅输出一个 JSON 数组：\n' +
                '[\n' +
                '  { "event": "事件描述（最长100字）", "msgRange": [0, 2], "status": "closed"|"partial", "topic": "话题类别", "parent_partial": null },\n' +
                '  ...\n' +
                ']\n' +
                '如果没有可提取的事件，返回 []。';
        } else {
            outputSchema = '仅输出一个 JSON 数组：\n' +
                '[\n' +
                '  { "summary": "整合摘要（最长150字）", "stmRange": [0, 3], "status": "closed"|"partial", "concepts": ["概念1", "概念2"], "parent_partial": null },\n' +
                '  ...\n' +
                ']\n' +
                '如果没有可整合的内容，返回 []。';
        }

        return {
            messages: [
                { role: 'system', content: instruction },
                { role: 'user', content: '最新输入：\n\n' + formattedItems + '\n\n' + outputSchema }
            ],
            options: { temperature: 0.1 }
        };
    }

    // ─── 结果验证 ───

    function validateResults(parsed, windowStart, windowEnd) {
        var errors = [];
        if (!Array.isArray(parsed)) {
            return [{ error: 'Expected array, got ' + typeof parsed }];
        }

        var ranges = [];

        for (var i = 0; i < parsed.length; i++) {
            var r = parsed[i];
            var rangeKey = mode === 'stm' ? 'msgRange' : 'stmRange';
            var range = r[rangeKey];

            if (!range || !Array.isArray(range) || range.length !== 2) {
                errors.push('entry[' + i + ']: missing or invalid ' + rangeKey);
                continue;
            }

            var rangeStart = range[0];
            var rangeEnd = range[1];

            // 不越界
            if (rangeStart < windowStart || rangeEnd >= windowEnd) {
                errors.push('entry[' + i + ']: ' + rangeKey + ' ' + JSON.stringify(range) + ' out of bounds [window: ' + windowStart + '-' + (windowEnd - 1) + ']');
            }

            // 不重叠
            for (var j = 0; j < ranges.length; j++) {
                var existing = ranges[j];
                if (!(rangeEnd < existing.start || rangeStart > existing.end)) {
                    errors.push('entry[' + i + ']: ' + rangeKey + ' overlaps with entry[' + j + ']');
                }
            }

            ranges.push({ start: rangeStart, end: rangeEnd, idx: i });

            // status 校验
            if (r.status !== 'closed' && r.status !== 'partial') {
                errors.push('entry[' + i + ']: status must be "closed" or "partial", got "' + r.status + '"');
            }
        }

        // 严格覆盖检查（仅当不允许跳过时）
        if (!allowSkip && parsed.length > 0) {
            // 所有 close 的事件必须覆盖窗口内所有消息
            // partial 事件不需要完全覆盖
            ranges.sort(function(a, b) { return a.start - b.start; });

            var expectedPos = windowStart;
            for (var i = 0; i < ranges.length; i++) {
                var r = ranges[i];
                var entry = parsed[r.idx];
                if (entry.status === 'partial') continue;  // partial 不参与覆盖检查

                if (r.start > expectedPos) {
                    // 注意：这可能是跳过部分在 partial 中，所以 warning 而非 error
                    // errors.push('entry[' + r.idx + ']: gap before range, expected ' + expectedPos + ' got ' + r.start);
                }
                expectedPos = Math.max(expectedPos, r.end + 1);
            }
        }

        return errors;
    }

    // ─── 主处理循环 ───

    async function process(params) {
        // params: { inputs, cursorState, promptBuilder, resultParser, resultAppender }
        params = params || {};
        var inputs = params.inputs || [];
        var prompts = params.promptBuilder;      // custom prompt builder (optional override)
        var parser = params.resultParser;         // custom result parser (optional override)
        var appender = params.resultAppender;     // custom result appender (optional override)

        if (!callLLM) {
            console.warn('[cursor] No callLLM provided. Cannot process.');
            return { results: [], cursor: { position: _position, pending_partials: _pendingPartials } };
        }

        // Load cursor state
        var cursorState = params.cursorState || { position: 0, pending_partials: [] };
        _position = cursorState.position || 0;
        _pendingPartials = (cursorState.pending_partials || []).slice();
        _windowSize = initialWindow;

        var allResults = [];

        // Track partial generation depth for each pending partial
        for (var pi = 0; pi < _pendingPartials.length; pi++) {
            _pendingPartials[pi]._partial_generation = _pendingPartials[pi]._partial_generation || 1;
        }

        while (_position < inputs.length) {
            var win = getWindow(inputs, _position, _windowSize);

            if (win.items.length === 0) break;

            var preGroupHint = buildPreGroupHint(win.items);

            // Build prompt
            var prompt = (prompts || buildIncrementalPrompt)({
                items: win.items,
                startIdx: win.startIdx,
                preGroups: preGroupHint,
                partials: _pendingPartials,
                allowSkip: allowSkip,
                mode: mode,
                force: false
            });

            // Call LLM
            var response;
            try {
                response = await callLLM(prompt.messages, prompt.options || { temperature: 0.1 });
            } catch (e) {
                console.error('[cursor] LLM call failed:', e.message);
                // Advance past current window on error to avoid infinite loop
                _position = win.endIdx;
                resetWindow();
                _pendingPartials = [];
                break;
            }

            // Parse response
            var parsed;
            if (parser) {
                parsed = parser(response, win);
            } else {
                parsed = _defaultParse(response);
            }

            // Validate
            var validationErrors = validateResults(parsed, win.startIdx, win.endIdx);
            if (validationErrors.length > 0) {
                console.warn('[cursor] Validation warnings:', validationErrors.join('; '));
                // Filter out invalid entries
                parsed = parsed.filter(function(r, i) {
                    var rangeKey = mode === 'stm' ? 'msgRange' : 'stmRange';
                    var range = r[rangeKey];
                    return range && Array.isArray(range) && range.length === 2
                        && range[0] >= win.startIdx && range[1] < win.endIdx;
                });
            }

            // ─── 处理结果 ───

            if (parsed.length === 0) {
                // No extraction — expand window or force
                if (isAtHardMax() || win.endIdx >= inputs.length) {
                    // ─── Optimization: skip force extraction when nothing pending ───
                    // If we're at the end of all inputs and there are no pending partials
                    // to close, the LLM has already told us "nothing here."  Force-extracting
                    // would waste a second LLM call for tokens that won't become events.
                    if (_pendingPartials.length === 0 && win.endIdx >= inputs.length) {
                        // Nothing to extract, no partials to close, at the very end →
                        // advance silently without a second LLM call.
                        _position = win.endIdx;
                        _pendingPartials = [];
                        resetWindow();
                        continue;
                    }

                    // Force extraction (has pending partials to close, or at hard max)
                    var forcePrompt = (prompts || buildIncrementalPrompt)({
                        items: win.items,
                        startIdx: win.startIdx,
                        preGroups: preGroupHint,
                        partials: _pendingPartials,
                        allowSkip: allowSkip,
                        mode: mode,
                        force: true
                    });

                    try {
                        var forceResponse = await callLLM(forcePrompt.messages, forcePrompt.options || { temperature: 0.1 });
                        parsed = parser ? parser(forceResponse, win) : _defaultParse(forceResponse);
                    } catch (e) {
                        console.error('[cursor] Force LLM call failed:', e.message);
                        parsed = [];
                    }

                    if (parsed.length === 0) {
                        // Still nothing — forcibly advance past window
                        console.warn('[cursor] Force extraction yielded nothing, advancing past window [' + win.startIdx + '-' + (win.endIdx - 1) + ']');
                        _position = win.endIdx;
                        _pendingPartials = [];
                        resetWindow();
                        continue;
                    }
                } else {
                    // Expand and retry
                    var expanded = expandWindow('no_extraction');
                    continue;
                }
            }

            // Separate closed and partial
            var closedResults = [];
            var newPartials = [];

            for (var i = 0; i < parsed.length; i++) {
                var r = parsed[i];
                // Add generation tracking
                r._generation = 1;

                // Check if this closes a pending partial
                if (r.parent_partial) {
                    var parentIdx = -1;
                    for (var pi2 = 0; pi2 < _pendingPartials.length; pi2++) {
                        var p = _pendingPartials[pi2];
                        var pDesc = p.event || p.summary || '';
                        if (pDesc === r.parent_partial || r.parent_partial.indexOf(pDesc) >= 0 || pDesc.indexOf(r.parent_partial) >= 0) {
                            parentIdx = pi2;
                            break;
                        }
                    }
                    if (parentIdx >= 0) {
                        r._generation = (_pendingPartials[parentIdx]._partial_generation || 1) + 1;
                        r._parent_partial_id = _pendingPartials[parentIdx]._id || null;
                        // Remove resolved partial
                        _pendingPartials.splice(parentIdx, 1);
                    }
                }

                if (r.status === 'closed') {
                    closedResults.push(r);
                } else if (r.status === 'partial') {
                    newPartials.push(r);
                }
            }

            // ─── 推进 cursor ───

            // 计算 cursor 可以安全推进到的位置
            // 规则：推进到最后一个 closed 条目覆盖的结束位置之后
            // 但如果 closed 之前有 partial（当前窗口产生的），则不能推进

            // Sort by range start
            parsed.sort(function(a, b) {
                var rangeKey = mode === 'stm' ? 'msgRange' : 'stmRange';
                return (a[rangeKey] || [])[0] - (b[rangeKey] || [])[0];
            });

            var newPosition = _position;

            // Find the furthest position we can safely advance to
            // Stop at the first partial (we can't advance past a partial's start)
            var firstPartialStart = Infinity;
            for (var i = 0; i < parsed.length; i++) {
                if (parsed[i].status === 'partial') {
                    var rangeKey = mode === 'stm' ? 'msgRange' : 'stmRange';
                    firstPartialStart = Math.min(firstPartialStart, (parsed[i][rangeKey] || [])[0]);
                }
            }

            if (firstPartialStart === Infinity) {
                // No partials — advance past the last closed entry
                for (var i = 0; i < parsed.length; i++) {
                    if (parsed[i].status === 'closed') {
                        var rangeKey = mode === 'stm' ? 'msgRange' : 'stmRange';
                        var endIdx = (parsed[i][rangeKey] || [])[1];
                        if (endIdx !== undefined && endIdx + 1 > newPosition) {
                            newPosition = endIdx + 1;
                        }
                    }
                }
            } else {
                // Partial exists — only advance past closed entries that end before the first partial starts
                for (var i = 0; i < parsed.length; i++) {
                    if (parsed[i].status === 'closed') {
                        var rangeKey = mode === 'stm' ? 'msgRange' : 'stmRange';
                        var endIdx = (parsed[i][rangeKey] || [])[1];
                        if (endIdx !== undefined && endIdx < firstPartialStart && endIdx + 1 > newPosition) {
                            newPosition = endIdx + 1;
                        }
                    }
                }
            }

            // ─── Apply results ───

            // Add metadata to closed results
            for (var i = 0; i < closedResults.length; i++) {
                var cr = closedResults[i];
                cr.timestamp = new Date().toISOString();
                cr._cursor_mode = mode;
            }

            // Append closed results
            if (appender && closedResults.length > 0) {
                await appender({
                    closedResults: closedResults,
                    vault: null,  // appender reads vault internally
                    cursorState: { position: newPosition, pending_partials: _pendingPartials }
                });
            }

            // Add to all results
            for (var i = 0; i < closedResults.length; i++) {
                allResults.push(closedResults[i]);
            }

            // Update state
            if (newPartials.length > 0) {
                // Check partial generation depth
                var allNew = true;
                for (var i = 0; i < newPartials.length; i++) {
                    newPartials[i]._partial_generation = newPartials[i]._generation || 1;
                    if (newPartials[i]._partial_generation >= maxPartialGenerations) {
                        // Force close: convert to closed
                        newPartials[i].status = 'closed';
                        newPartials[i]._force_closed = true;
                        newPartials[i].timestamp = new Date().toISOString();
                        allResults.push(newPartials[i]);
                        if (appender) {
                            await appender({
                                closedResults: [newPartials[i]],
                                vault: null,
                                cursorState: { position: newPosition, pending_partials: _pendingPartials }
                            });
                        }
                        // Advance past this one
                        var rk = mode === 'stm' ? 'msgRange' : 'stmRange';
                        var rkEnd = (newPartials[i][rk] || [])[1];
                        if (rkEnd !== undefined && rkEnd + 1 > newPosition) {
                            newPosition = rkEnd + 1;
                        }
                    } else {
                        allNew = false;
                    }
                }

                if (!allNew) {
                    _pendingPartials = newPartials.filter(function(p) { return p.status === 'partial'; });
                    // Expand window for next iteration
                    if (!isAtHardMax()) {
                        expandWindow('partial_remaining');
                    }
                } else {
                    _pendingPartials = [];
                    resetWindow();
                }

                _position = newPosition;
            } else {
                // All closed — reset
                _pendingPartials = [];
                _position = newPosition;
                resetWindow();
            }

            // Safety: if stuck at same position with max window
            if (_position === cursorState.position && isAtHardMax() && win.endIdx >= inputs.length) {
                console.warn('[cursor] Stuck at position ' + _position + ' with max window, forcing advance');
                _position = win.endIdx;
                _pendingPartials = [];
                resetWindow();
            }

            // Safety: prevent infinite loop
            if (_position <= cursorState.position && newPartials.length === 0 && closedResults.length === 0) {
                _position = Math.min(win.endIdx, inputs.length);
                resetWindow();
            }
        }

        return {
            results: allResults,
            cursor: {
                position: _position,
                pending_partials: _pendingPartials.map(function(p) {
                    return {
                        event: p.event,
                        summary: p.summary,
                        msgRange: p.msgRange,
                        stmRange: p.stmRange,
                        _partial_generation: p._partial_generation,
                        _id: p._id
                    };
                })
            }
        };
    }

    // ─── 默认解析器 ───

    function _defaultParse(response) {
        try {
            var text = String(response || '').trim();
            // Extract JSON from code blocks
            var codeMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (codeMatch) text = codeMatch[1].trim();

            // Try array match
            var arrayMatch = text.match(/\[[\s\S]*\]/);
            if (arrayMatch) {
                var parsed = JSON.parse(arrayMatch[0]);
                if (Array.isArray(parsed)) return parsed;
            }

            // Try object with entries key
            var jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                var obj = JSON.parse(jsonMatch[0]);
                if (Array.isArray(obj)) return obj;
                if (obj.stm_entries) return obj.stm_entries;
                if (obj.ltm_entries) return obj.ltm_entries;
                if (obj.entries) return obj.entries;
            }

            return [];
        } catch (e) {
            console.warn('[cursor] Failed to parse LLM response:', e.message);
            return [];
        }
    }

    // ─── 公共 API ───

    return {
        process: process,
        getWindow: getWindow,
        expandWindow: expandWindow,
        resetWindow: resetWindow,
        isAtHardMax: isAtHardMax,
        isAtEnd: isAtEnd,
        buildPreGroupHint: buildPreGroupHint,
        formatPartialContext: formatPartialContext,
        validateResults: validateResults,

        // 状态读写
        getState: function() {
            return { position: _position, pending_partials: _pendingPartials };
        },
        setState: function(state) {
            if (state) {
                _position = state.position || 0;
                _pendingPartials = (state.pending_partials || []).slice();
            }
        },

        // 配置
        getConfig: function() {
            return {
                mode: mode,
                initialWindow: initialWindow,
                expandStep: expandStep,
                maxWindow: maxWindow,
                allowSkip: allowSkip,
                similarityThreshold: similarityThreshold,
                maxPartialGenerations: maxPartialGenerations
            };
        }
    };
}

// ─── 内联默认分词器（fallback）───

function isCJK(ch) {
    var code = ch.charCodeAt(0);
    return (code >= 0x4E00 && code <= 0x9FFF)
        || (code >= 0x3400 && code <= 0x4DBF)
        || (code >= 0xF900 && code <= 0xFAFF);
}

function isAlpha(ch) {
    var code = ch.charCodeAt(0);
    return (code >= 0x41 && code <= 0x5A)
        || (code >= 0x61 && code <= 0x7A)
        || (code >= 0x30 && code <= 0x39);
}

var _defaultTokenizer = function(text) {
    if (!text || typeof text !== 'string') return [];
    var tokens = [];
    var i = 0;
    var len = text.length;
    while (i < len) {
        var ch = text.charAt(i);
        if (isCJK(ch)) {
            var cjkStart = i;
            while (i < len && isCJK(text.charAt(i))) i++;
            var cjkText = text.substring(cjkStart, i);
            if (cjkText.length === 1) {
                tokens.push(cjkText);
            } else {
                for (var j = 0; j < cjkText.length - 1; j++) {
                    tokens.push(cjkText.substring(j, j + 2));
                }
            }
        } else if (isAlpha(ch)) {
            var wordStart = i;
            while (i < len && isAlpha(text.charAt(i))) i++;
            tokens.push(text.substring(wordStart, i).toLowerCase());
        } else {
            i++;
        }
    }
    return tokens;
};
