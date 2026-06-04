// core/schema.js — 状态 Schema 引擎 (通用 Agent 场景)
//
// Schema 是可选的结构化状态定义。当 state_schema 为 null/undefined 时，
// 所有路径回退到自由 JSON 行为。
//
// 功能：
//   - 字段级别类型校验 + max_length 截断 + enum 校验
//   - dot-path 递归解析
//   - 变更验证（未知字段警告但不阻塞，向后兼容）
//   - dot-path 深度合并
//   - 格式化摘要输出
//   - 全局块内置预设
//   - 参与者 / 团队 / 任务树 Schema 定义与校验
//
// 全局开关：可通过 isStateSchemaEnabled() / setStateSchemaEnabled() 控制整个 Schema 系统开关

import { get, set } from './config.js';

export function isStateSchemaEnabled() {
    return get('enableStateSchema', false);
}

export function setStateSchemaEnabled(val) {
    set('enableStateSchema', val);
}

// ─── 全局状态 Schema ───

export const DEFAULT_GLOBAL_SCHEMA = {
    type: 'object',
    fields: {
        context: { type: 'string', max_length: 60, expose_level: 'summary', label: 'Context' },
        period: { type: 'string', max_length: 40, expose_level: 'summary', label: 'Period' },
        date: { type: 'string', max_length: 40, expose_level: 'summary', label: 'Date' },
        current_focus: { type: 'string', max_length: 120, expose_level: 'summary', label: 'Current Focus' },
        active_participants: { type: 'string', max_length: 80, expose_level: 'summary', label: 'Active Participants' },
        teams: {
            type: 'object',
            enabled: false,
            schema: {
                type: 'object',
                fields: {
                    '*': {
                        type: 'object',
                        fields: {
                            name: { type: 'string', max_length: 20, expose_level: 'summary' },
                            description: { type: 'string', max_length: 80, expose_level: 'detail' },
                            lead: { type: 'string', max_length: 30, expose_level: 'detail' },
                            members: { type: 'string', max_length: 120, expose_level: 'detail' },
                            relations: { type: 'object', expose_level: 'detail' },
                            notes: { type: 'string', max_length: 200, expose_level: 'detail' }
                        }
                    }
                }
            }
        }
    }
};

// ─── 参与者 Schema ───

export const DEFAULT_PARTICIPANT_SCHEMA = {
    type: 'object',
    fields: {
        name: { type: 'string', max_length: 30, expose_level: 'summary', required: true },
        role: { type: 'string', max_length: 30, expose_level: 'summary', required: true },
        department: { type: 'string', max_length: 20, expose_level: 'summary', required: true },
        status: { type: 'enum', values: ['active', 'standby', 'inactive', 'departed'], expose_level: 'summary', required: true },
        expertise: { type: 'string', max_length: 80, expose_level: 'summary', required: true },
        current_task: { type: 'string', max_length: 80, expose_level: 'summary', required: false },
        workload: { type: 'string', max_length: 30, expose_level: 'detail', required: false },
        skills: { type: 'string', max_length: 120, expose_level: 'detail', required: false },
        background: { type: 'string', max_length: 200, expose_level: 'detail', required: false },
        responsibilities: { type: 'string', max_length: 120, expose_level: 'detail', required: false },
        notes: { type: 'string', max_length: 200, expose_level: 'detail', required: false }
    }
};

// ─── 团队 Schema ───

export const DEFAULT_TEAM_SCHEMA = {
    type: 'object',
    schema: {
        type: 'object',
        fields: {
            '*': {
                type: 'object',
                fields: {
                    name: { type: 'string', max_length: 20, expose_level: 'summary' },
                    description: { type: 'string', max_length: 80, expose_level: 'detail' },
                    lead: { type: 'string', max_length: 30, expose_level: 'detail' },
                    members: { type: 'string', max_length: 120, expose_level: 'detail' },
                    relations: { type: 'object', expose_level: 'detail' },
                    notes: { type: 'string', max_length: 200, expose_level: 'detail' }
                }
            }
        }
    }
};

// ─── 任务树 Schema ───

export const DEFAULT_MEDIUM_TASK_SCHEMA = {
    type: 'object',
    fields: {
        title: { type: 'string', max_length: 80, expose_level: 'summary' },
        status: { type: 'enum', values: ['active', 'standby', 'inactive', 'departed'], expose_level: 'summary' },
        description: { type: 'string', max_length: 200, expose_level: 'detail' },
        progress_summary: { type: 'string', max_length: 60, expose_level: 'summary' },
        assignee: { type: 'string', max_length: 30, expose_level: 'detail' },
        deadline: { type: 'string', max_length: 30, expose_level: 'detail' },
        created_at: { type: 'string', max_length: 30, expose_level: 'detail' },
        parent_mission: { type: 'string', max_length: 200, expose_level: 'detail' }
    }
};

export const DEFAULT_SHORT_TASK_SCHEMA = {
    type: 'object',
    fields: {
        title: { type: 'string', max_length: 80, expose_level: 'summary' },
        status: { type: 'enum', values: ['pending', 'executing', 'blocked', 'done', 'failed'], expose_level: 'summary' },
        parent_medium: { type: 'string', max_length: 40, expose_level: 'summary' },
        assignee: { type: 'string', max_length: 30, expose_level: 'summary' },
        description: { type: 'string', max_length: 200, expose_level: 'detail' },
        created_at: { type: 'string', max_length: 30, expose_level: 'detail' }
    }
};

export const DEFAULT_EMERGENCY_SCHEMA = {
    type: 'object',
    fields: {
        title: { type: 'string', max_length: 80, expose_level: 'summary' },
        status: { type: 'enum', values: ['active', 'mitigated', 'resolved'], expose_level: 'summary' },
        severity: { type: 'enum', values: ['critical', 'high', 'medium', 'low'], expose_level: 'summary' },
        interrupted: { type: 'string', max_length: 40, expose_level: 'detail' },
        description: { type: 'string', max_length: 200, expose_level: 'detail' },
        created_at: { type: 'string', max_length: 30, expose_level: 'detail' },
        resolved_at: { type: 'string', max_length: 30, expose_level: 'detail' }
    }
};

// ─── RP Schema 已迁移至 core/engine/rp/rp-schema.js ───
// 以下为向后兼容别名 (旧代码迁移参考)

/** @deprecated Use DEFAULT_PARTICIPANT_SCHEMA (general) or RP_CHARACTER_SCHEMA (roleplay) */
export const DEFAULT_CHARACTER_SCHEMA = DEFAULT_PARTICIPANT_SCHEMA;

/** @deprecated Use DEFAULT_TEAM_SCHEMA (general) or RP_FACTION_SCHEMA (roleplay) */
export const DEFAULT_FACTION_SCHEMA = DEFAULT_TEAM_SCHEMA;

/** @deprecated Use task tree schemas (general) or RP_QUESTS_SCHEMA (roleplay) */
export const DEFAULT_QUESTS_SCHEMA = {
    tasks: { type: 'object', schema: { type: 'object', fields: { '*': DEFAULT_SHORT_TASK_SCHEMA } } },
    goals: { type: 'object', schema: { type: 'object', fields: { '*': DEFAULT_MEDIUM_TASK_SCHEMA } } },
    events: { type: 'object', schema: { type: 'object', fields: { '*': DEFAULT_EMERGENCY_SCHEMA } } }
};

// ─── 字段校验 ───

// validateField — 类型检查 + max_length 截断 + enum 值校验
export function validateField(value, fieldSchema) {
    if (!fieldSchema) return { ok: true, value: value };

    var type = fieldSchema.type;

    if (type === 'string') {
        if (typeof value !== 'string') {
            if (value === null || value === undefined) return { ok: true, value: '' };
            value = String(value);
        }
        if (fieldSchema.max_length && value.length > fieldSchema.max_length) {
            value = value.substring(0, fieldSchema.max_length);
        }
    } else if (type === 'number') {
        if (typeof value !== 'number') {
            var n = Number(value);
            if (isNaN(n)) return { ok: false, value: value, error: 'Expected number, got: ' + typeof value };
            value = n;
        }
        if (fieldSchema.min !== undefined && value < fieldSchema.min) {
            return { ok: false, value: value, error: 'Value below min: ' + fieldSchema.min };
        }
        if (fieldSchema.max !== undefined && value > fieldSchema.max) {
            return { ok: false, value: value, error: 'Value above max: ' + fieldSchema.max };
        }
    } else if (type === 'boolean') {
        if (typeof value !== 'boolean') {
            return { ok: false, value: value, error: 'Expected boolean, got: ' + typeof value };
        }
    } else if (type === 'enum') {
        if (!Array.isArray(fieldSchema.values) || fieldSchema.values.indexOf(value) === -1) {
            return { ok: false, value: value, error: 'Value not in enum: ' + JSON.stringify(fieldSchema.values) };
        }
    }

    return { ok: true, value: value };
}

// resolveSchemaPath — 递归解析 dot-separated 路径到 Schema 定义
export function resolveSchemaPath(stateSchema, dotPath) {
    if (!stateSchema) return null;
    var parts = dotPath.split('.');
    var current = stateSchema;
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (!current) return null;
        if (current.type === 'object' && current.fields) {
            current = current.fields[part] || current.fields['*'] || null;
        } else if (current.type === 'object' && current.schema) {
            if (current.schema && current.schema.fields) {
                current = current.schema.fields[part] || current.schema.fields['*'] || null;
            } else {
                return null;
            }
        } else {
            return null;
        }
    }
    return current;
}

// validateStateChanges — 校验变更，未知字段警告但不阻塞（向后兼容）
export function validateStateChanges(stateSchema, changes) {
    var validated = {};
    var warnings = [];

    Object.keys(changes).forEach(function (path) {
        var fieldSchema = resolveSchemaPath(stateSchema, path);

        if (!fieldSchema) {
            warnings.push({ path: path, warning: 'Field not in schema, passing through: ' + path });
            validated[path] = changes[path];
            return;
        }

        var result = validateField(changes[path], fieldSchema);
        if (result.ok) {
            validated[path] = result.value;
        } else {
            warnings.push({ path: path, warning: result.error });
        }
    });

    return { validated: validated, warnings: warnings };
}

// rebuildActiveParticipants — 从 participants.*.status==='active' 重建 global.active_participants
export function rebuildActiveParticipants(state) {
    if (!state) return state;
    var participants = state.participants;
    if (!participants || typeof participants !== 'object') return state;
    var activeNames = [];
    Object.keys(participants).forEach(function (name) {
        var card = participants[name];
        if (card && typeof card === 'object' && card.status === 'active') {
            activeNames.push(name);
        }
    });
    if (!state.global) state.global = {};
    state.global.active_participants = activeNames.join(', ');
    return state;
}

// mergeStateChanges — 按 dot-path 深度合并到状态对象
// 自动检测 participants.*.status 变化，触发 active_participants 重建
export function mergeStateChanges(state, validatedChanges) {
    var newState = JSON.parse(JSON.stringify(state || {}));

    var hasParticipantStatusChange = false;
    Object.keys(validatedChanges).forEach(function (path) {
        var parts = path.split('.');
        var current = newState;

        for (var i = 0; i < parts.length - 1; i++) {
            if (current[parts[i]] === undefined || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
                current[parts[i]] = {};
            }
            current = current[parts[i]];
        }

        var lastKey = parts[parts.length - 1];
        current[lastKey] = validatedChanges[path];

        if (parts.length >= 3 && parts[0] === 'participants' && lastKey === 'status') {
            hasParticipantStatusChange = true;
        }
    });

    if (hasParticipantStatusChange) {
        newState = rebuildActiveParticipants(newState);
    }

    return newState;
}

// ─── 校验函数 ───

// validateParticipantCard — 校验单个参与者卡是否符合 Schema 的 required 字段
export function validateParticipantCard(participantData) {
    var schema = DEFAULT_PARTICIPANT_SCHEMA;
    var errors = [];
    var fields = schema.fields || {};

    Object.keys(fields).forEach(function (key) {
        var fieldDef = fields[key];
        if (!fieldDef.required) return;
        var val = participantData[key];
        if (val === undefined || val === null || val === '') {
            errors.push('Missing required field: ' + key);
        } else if (fieldDef.type === 'enum' && Array.isArray(fieldDef.values) && fieldDef.values.indexOf(val) === -1) {
            errors.push('Invalid enum value for ' + key + ': ' + val);
        }
    });

    return { valid: errors.length === 0, errors: errors };
}

// ─── 格式化函数 ───

// formatParticipantSummary — 将参与者卡渲染为摘要文本行
export function formatParticipantSummary(state) {
    if (!state || !state.participants) return '';
    var participants = state.participants;
    var lines = [];

    Object.keys(participants).forEach(function (name) {
        var card = participants[name];
        if (!card || typeof card !== 'object') return;

        var summaryFields = [];
        var status = card.status || 'unknown';
        summaryFields.push('[' + status + ']');

        var summaryKeys = ['role', 'expertise', 'current_task'];
        summaryKeys.forEach(function (key) {
            var val = card[key];
            if (val !== undefined && val !== null && val !== '') {
                summaryFields.push(key + '=' + String(val).substring(0, 40));
            }
        });

        if (summaryFields.length > 1) {
            lines.push(name + ': ' + summaryFields.join(', '));
        }
    });

    return lines.join('\n');
}

// formatActiveParticipantSummary — 只渲染 status==='active' 的参与者摘要
export function formatActiveParticipantSummary(state) {
    if (!state || !state.participants) return '';
    var activeState = { participants: {} };
    var participants = state.participants;
    Object.keys(participants).forEach(function (name) {
        var card = participants[name];
        if (card && card.status === 'active') {
            activeState.participants[name] = card;
        }
    });
    if (Object.keys(activeState.participants).length === 0) return '';
    return formatParticipantSummary(activeState);
}

// formatStateSummary — 有 Schema 时输出扁平摘要，无 Schema 时回退 JSON
export function formatStateSummary(state, stateSchema) {
    if (!stateSchema) {
        if (!state || Object.keys(state).length === 0) return '';
        try { return JSON.stringify(state); } catch (e) { return ''; }
    }

    var lines = [];

    function walk(obj, prefix, sch) {
        if (!sch) return;
        if (sch.type !== 'object') return;

        var fields = sch.fields;
        if (!fields && sch.schema && sch.schema.type === 'object' && sch.schema.fields) {
            fields = sch.schema.fields;
        }
        if (!fields) return;

        var wildcardSch = fields['*'];
        var coveredKeys = {};

        Object.keys(fields).forEach(function (key) {
            if (key === '*') return;
            coveredKeys[key] = true;
            var fieldSch = fields[key];
            var fullPath = prefix ? prefix + '.' + key : key;
            var val = obj && obj[key];

            if (fieldSch.type === 'object' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
                walk(val, fullPath, fieldSch);
            } else {
                var display = val === null || val === undefined ? '-' : String(val).substring(0, 50);
                lines.push(fullPath + '=' + display);
            }
        });

        if (wildcardSch && obj && typeof obj === 'object') {
            Object.keys(obj).forEach(function (key) {
                if (coveredKeys[key]) return;
                var fullPath = prefix ? prefix + '.' + key : key;
                var val = obj[key];
                if (wildcardSch.type === 'object' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
                    walk(val, fullPath, wildcardSch);
                } else {
                    var display = val === null || val === undefined ? '-' : String(val).substring(0, 50);
                    lines.push(fullPath + '=' + display);
                }
            });
        }
    }

    walk(state, '', stateSchema);
    return lines.join(', ');
}

// formatTaskTreeSummary — 任务树截面视图（仅活跃项）
export function formatTaskTreeSummary(state) {
    if (!state) return '';
    var sections = [];

    // Mission
    if (state.mission && typeof state.mission === 'string') {
        sections.push('[Mission] ' + state.mission);
    }

    // Medium tasks
    var mediumTasks = state.medium_tasks;
    if (mediumTasks && typeof mediumTasks === 'object') {
        var mtActive = Object.keys(mediumTasks).filter(function(k) {
            var t = mediumTasks[k];
            return t && t.status && t.status !== 'departed';
        });
        if (mtActive.length > 0) {
            var mtLines = ['### Medium Tasks'];
            mtActive.forEach(function(k) {
                var t = mediumTasks[k];
                var progress = t.progress_summary ? ' (' + t.progress_summary + ')' : '';
                mtLines.push('  ' + k + ' [' + (t.status || '?') + '] ' + (t.title || '') + progress);
            });
            sections.push(mtLines.join('\n'));
        }
    }

    // Short tasks (active medium tasks only)
    var shortTasks = state.short_tasks;
    if (shortTasks && typeof shortTasks === 'object' && mediumTasks && typeof mediumTasks === 'object') {
        var activeMTKeys = Object.keys(mediumTasks).filter(function(k) {
            return mediumTasks[k] && mediumTasks[k].status && mediumTasks[k].status !== 'departed';
        });
        var activeST = Object.keys(shortTasks).filter(function(k) {
            var s = shortTasks[k];
            return s && s.parent_medium && activeMTKeys.indexOf(s.parent_medium) !== -1 && s.status !== 'done' && s.status !== 'failed';
        });
        if (activeST.length > 0) {
            var stLines = ['### Short Tasks'];
            activeST.forEach(function(k) {
                var s = shortTasks[k];
                stLines.push('  ' + k + ' [' + (s.status || '?') + '] [' + (s.parent_medium || '') + '] ' + (s.title || '') +
                    (s.assignee ? ' | assigned: ' + s.assignee : ''));
            });
            sections.push(stLines.join('\n'));
        }
    }

    // Emergencies (active only)
    var emergencies = state.emergencies;
    if (emergencies && typeof emergencies === 'object') {
        var emActive = Object.keys(emergencies).filter(function(k) {
            var e = emergencies[k];
            return e && e.status === 'active';
        });
        if (emActive.length > 0) {
            var emLines = ['### Emergencies'];
            emActive.forEach(function(k) {
                var e = emergencies[k];
                emLines.push('  ' + k + ' [' + (e.severity || '?') + '] ' + (e.title || '') + ' — ' + (e.status || ''));
            });
            sections.push(emLines.join('\n'));
        }
    }

    return sections.join('\n\n');
}

// ─── Cursor engine range validators ───

// 验证 msgRange 合法性（STM 提取用）
// ⚠️ RP 场景下，allowSkip=false → 消息必须连续覆盖
// ⚠️ Agent 场景下，allowSkip=true → 可以跳过无关消息
export function validateMsgRange(msgRange, windowStart, windowEnd, allowSkip) {
    if (!msgRange || !Array.isArray(msgRange) || msgRange.length !== 2) {
        return { valid: false, error: 'msgRange must be [start, end] array' };
    }

    var start = msgRange[0];
    var end = msgRange[1];

    if (typeof start !== 'number' || typeof end !== 'number') {
        return { valid: false, error: 'msgRange values must be numbers' };
    }

    if (start > end) {
        return { valid: false, error: 'msgRange start must be <= end, got [' + start + ', ' + end + ']' };
    }

    // 不越界
    if (start < windowStart || end >= windowEnd) {
        return { valid: false, error: 'msgRange [' + start + ', ' + end + '] out of window bounds [' + windowStart + ', ' + (windowEnd - 1) + ']' };
    }

    return { valid: true };
}

// 验证多条 msgRange 的整体合法性（无重叠、覆盖完整性）
// 返回 { valid, errors, gaps: [{from, to}] }
export function validateMsgRanges(ranges, windowStart, windowEnd, allowSkip) {
    var errors = [];
    var validated = [];

    // 先验证每条
    for (var i = 0; i < ranges.length; i++) {
        var r = ranges[i];
        var result = validateMsgRange(r.msgRange || r.msg_range, windowStart, windowEnd, allowSkip);
        if (!result.valid) {
            errors.push('entry[' + i + ']: ' + result.error);
        } else {
            validated.push({ start: r.msgRange[0] || r.msg_range[0], end: r.msgRange[1] || r.msg_range[1], idx: i });
        }
    }

    // 排序检查重叠
    validated.sort(function(a, b) { return a.start - b.start; });
    for (var i = 0; i < validated.length - 1; i++) {
        if (validated[i].end >= validated[i + 1].start) {
            errors.push('entry[' + validated[i].idx + '] overlaps with entry[' + validated[i + 1].idx + ']: [' + validated[i].start + ',' + validated[i].end + '] vs [' + validated[i + 1].start + ',' + validated[i + 1].end + ']');
        }
    }

    // 检查全覆盖（仅 RP 模式）
    if (!allowSkip && validated.length > 0) {
        var gaps = [];
        var pos = windowStart;
        for (var i = 0; i < validated.length; i++) {
            if (validated[i].start > pos) {
                gaps.push({ from: pos, to: validated[i].start - 1 });
            }
            pos = Math.max(pos, validated[i].end + 1);
        }
        if (pos < windowEnd) {
            gaps.push({ from: pos, to: windowEnd - 1 });
        }
        if (gaps.length > 0) {
            errors.push('Coverage gap detected: messages ' + gaps.map(function(g) { return '[' + g.from + '-' + g.to + ']'; }).join(', ') + ' not covered by any STM');
        }

        return { valid: errors.length === 0, errors: errors, gaps: gaps };
    }

    return { valid: errors.length === 0, errors: errors };
}

// 验证 stmRange 合法性（LTM 整合用）
// LTM 的 stmRange 引用 STM 在 unconsolidated 数组中的位置
export function validateStmRange(stmRange, unconsolidatedCount, windowStart, windowEnd) {
    if (!stmRange || !Array.isArray(stmRange) || stmRange.length !== 2) {
        return { valid: false, error: 'stmRange must be [start, end] array' };
    }

    var start = stmRange[0];
    var end = stmRange[1];

    if (typeof start !== 'number' || typeof end !== 'number') {
        return { valid: false, error: 'stmRange values must be numbers' };
    }

    if (start > end) {
        return { valid: false, error: 'stmRange start must be <= end' };
    }

    // 不越界
    if (start < windowStart || end >= windowEnd) {
        return { valid: false, error: 'stmRange out of bounds' };
    }

    return { valid: true };
}
