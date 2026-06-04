// core/access.js — Layer 0: Direct reference lookup (zero LLM)
//
// Unified access to memory entries, original messages, and state entities
// via reference strings. Extracted from src/tools.js registerAccess.
//
// No external dependencies beyond the vault store.

import { read } from './store.js';

/**
 * Look up a memory entry, message, or state entity by reference string.
 *
 * Supported formats:
 *   "stm_12" or "ltm_3" — memory entry with children chain
 *   "msg#95" or "95"   — original message text (host must supply getMessages)
 *   "participants.Name"  — participant detail
 *   "teams.Name"         — team detail with relations
 *   "medium_tasks.ID"    — medium-term task detail
 *   "short_tasks.ID"     — short-term task detail
 *   "emergencies.ID"     — emergency detail
 *   "chain.Name"         — narrative chain for an entity
 */
export async function accessEntry(chatId, ref, options) {
    options = options || {};
    var vault = await read(chatId);
    var content = vault.content || {};
    var state = content.state || {};

    // msg#95 or bare digit → original message
    if (ref.indexOf('msg#') === 0 || /^\d+$/.test(ref)) {
        var msgId = parseInt(ref.replace('msg#', ''));
        if (options.getMessages) {
            var chat = options.getMessages();
            var msg = chat.find(function(m) { return (m.id || m.mes_id) === msgId; });
            if (!msg) return 'Message #' + msgId + ' not found.';
            var text = (msg.name ? msg.name + ': ' : '') + (typeof msg.mes === 'string' ? msg.mes : (msg.content || ''));
            if (options.entities && options.entities.length > 0) {
                var sentences = text.split(/(?<=[。！？.!?\n])/);
                text = sentences.filter(function(s) {
                    return options.entities.some(function(e) { return s.toLowerCase().indexOf(e.toLowerCase()) !== -1; });
                }).join('').trim() || text.substring(0, 300) + '... [filtered]';
            }
            return '[→' + msgId + ']\n' + text;
        }
        return 'Message access requires getMessages callback.';
    }

    // input_{index} → Trae user input history
    if (ref.indexOf('input_') === 0) {
        var inputIdx = parseInt(ref.replace('input_', ''), 10);
        if (isNaN(inputIdx) || inputIdx < 0) return 'Invalid input index: ' + ref;
        if (options.historyReader && typeof options.historyReader.readHistory === 'function') {
            try {
                var messages = await options.historyReader.readHistory('');
                if (inputIdx >= messages.length) return 'Input #' + inputIdx + ' not found. Total history: ' + messages.length;
                var entry = messages[inputIdx];
                var inputText = (entry && entry.content) || '';
                if (inputText.length > 1000) inputText = inputText.substring(0, 1000) + '... (truncated)';
                return '[→input_' + inputIdx + ']\n' + inputText;
            } catch (e) {
                return 'Error reading input history: ' + e.message;
            }
        }
        return 'Input history lookup requires historyReader (configure history in config.json).';
    }

    // stm_12 or ltm_3 → memory entry
    if (ref.indexOf('stm_') === 0 || ref.indexOf('ltm_') === 0) {
        return lookupMemoryEntry(content, ref);
    }

    // chain.X → narrative chain
    if (ref.indexOf('chain.') === 0) {
        var entityName = ref.replace('chain.', '');
        return lookupChain(content, entityName);
    }

    // time / time.X → time index view
    if (ref === 'time' || ref.indexOf('time.') === 0) {
        return lookupTimeline(content, ref);
    }

    // participants.X / teams.X / medium_tasks.X / short_tasks.X / emergencies.X → State detail
    var dotIdx = ref.indexOf('.');
    if (dotIdx > 0) {
        var domain = ref.substring(0, dotIdx);
        var name = ref.substring(dotIdx + 1);
        if (domain === 'participants') return formatParticipantDetail(state, name);
        if (domain === 'teams') return formatTeamDetail(state, name);
        if (domain === 'medium_tasks') return formatMediumTaskDetail(state, name);
        if (domain === 'short_tasks') return formatShortTaskDetail(state, name);
        if (domain === 'emergencies') return formatEmergencyDetail(state, name);

        // Backward compat aliases
        if (domain === 'characters') return formatParticipantDetail(state, name);
        if (domain === 'factions') return formatTeamDetail(state, name);
        if (domain === 'quests') return formatQuestAlias(state, name);
    }

    return 'Unknown ref format: ' + ref + '. Use stm_XX, ltm_XX, XX, participants.Name, teams.Name, medium_tasks.ID, short_tasks.ID, emergencies.ID, or chain.Name.';
}

// ─── Memory entry lookup ───

function lookupMemoryEntry(content, ref) {
    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
    var allLTM = content.ltm_entries || [];
    var allEntries = (ref.indexOf('ltm_') === 0 ? allLTM : allSTM);
    var entry = allEntries.find(function(e) { return e.id === ref; });
    if (!entry) return 'Entry ' + ref + ' not found.';

    var lines = [];
    lines.push('=== ' + ref + ' ===');
    if (entry.time_range || entry.period) lines.push('Period: ' + (entry.time_range || entry.period));
    if (entry.scene) lines.push('Scene: ' + entry.scene);
    if (entry.event) lines.push('Event: ' + entry.event);
    if (entry.entities && entry.entities.length > 0) {
        var prefixMap = {character:'@', item:'$', faction:'&', concept:'#', location:'~', event:'!'};
        lines.push('Entities: ' + entry.entities.map(function(e) { return (prefixMap[e.type] || '?') + e.name; }).join(', '));
    }

    if (ref.indexOf('ltm_') === 0 && entry.stm_refs && entry.stm_refs.length > 0) {
        lines.push('Children: ' + entry.stm_refs.map(function(id) { return '→stm_' + id; }).join(', '));
    }
    if (entry.msg_ids && entry.msg_ids.length > 0) {
        lines.push('Children: ' + entry.msg_ids.map(function(id) { return '→' + id; }).join(', '));
    }
    return lines.join('\n');
}

// ─── Narrative chain ───

function lookupChain(content, entityName) {
    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
    var chainEntries = allSTM.filter(function(e) {
        return e.entities && e.entities.some(function(en) { return en.name === entityName; });
    });
    if (chainEntries.length === 0) return 'No narrative chain found for: ' + entityName;

    chainEntries.sort(function(a, b) { return new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(); });
    var chainLines = ['=== Chain: ' + entityName + ' (' + chainEntries.length + ' events) ==='];
    chainEntries.forEach(function(e, i) {
        var label = (e.period || '') + (e.time_label ? '·' + e.time_label : '');
        var refs = (e.msg_ids || []).map(function(id) { return '→' + id; }).join(', ');
        chainLines.push((i + 1) + '. ' + (label ? '[' + label + '] ' : '') + (e.event || '') + (refs ? ' [' + refs + ']' : ''));
    });
    return chainLines.join('\n');
}

// ─── Timeline view ───

function lookupTimeline(content, ref) {
    var filter = ref.replace('time', '').replace(/^\./, '').trim();

    var allSTM = (content.unconsolidated_stm || []).concat(content.stm_entries || []);
    var allLTM = content.ltm_entries || [];
    var allEntries = allSTM.concat(allLTM);

    var timeEntries;
    if (filter) {
        var filterLower = filter.toLowerCase();
        timeEntries = allEntries.filter(function(e) {
            var timeStr = (e.period || e.time_range || '').toLowerCase();
            return timeStr.indexOf(filterLower) !== -1;
        });
        if (timeEntries.length === 0) {
            return 'No entries found for time: ' + filter + '. Available periods: ' +
                allEntries.map(function(e) { return e.period || e.time_range; }).filter(Boolean).slice(0, 20).join(', ');
        }
    } else {
        timeEntries = allEntries.slice();
    }

    timeEntries.sort(function(a, b) {
        var ta = (a.period || a.time_range || '');
        var tb = (b.period || b.time_range || '');
        return ta.localeCompare(tb);
    });

    var label = filter ? ('Timeline: ' + filter) : 'Full Timeline';
    var lines = ['=== ' + label + ' (' + timeEntries.length + ' entries) ==='];

    timeEntries.forEach(function(e, i) {
        var time = e.period || e.time_range || '?';
        var timeLabel = e.time_label ? '·' + e.time_label : '';
        var scene = e.scene || '';
        var text = e.event || e.summary || '';
        var entryType = e.stm_refs ? '[LTM]' : '[STM]';
        lines.push((i + 1) + '. ' + entryType + ' [' + time + timeLabel + '] ' + (scene ? scene + ': ' : '') + text.substring(0, 120));
    });

    return lines.join('\n');
}

// ─── State entity formatters ───

export function formatParticipantDetail(state, name) {
    var participants = state.participants || {};
    var card = participants[name];
    if (!card || typeof card !== 'object') {
        return 'Participant "' + name + '" not found. Available: ' + Object.keys(participants).join(', ');
    }

    var lines = [];
    lines.push('=== ' + name + ' ===');
    lines.push('');

    var coreFields = ['name', 'role', 'department', 'expertise', 'status'];
    coreFields.forEach(function(key) {
        if (card[key] !== undefined && card[key] !== null && card[key] !== '') {
            lines.push(key + ': ' + String(card[key]));
        }
    });

    if (card.current_task) lines.push('current_task: ' + String(card.current_task));
    if (card.workload) lines.push('workload: ' + String(card.workload));
    if (card.skills) lines.push('skills: ' + String(card.skills));
    if (card.background) lines.push('background: ' + String(card.background));
    if (card.responsibilities) lines.push('responsibilities: ' + String(card.responsibilities));
    if (card.notes) lines.push('notes: ' + String(card.notes));

    return lines.join('\n');
}

export function formatTeamDetail(state, name) {
    var teams = state.teams || {};
    var team = teams[name];
    if (!team || typeof team !== 'object') {
        return 'Team "' + name + '" not found. Available: ' + Object.keys(teams).join(', ');
    }

    var lines = [];
    lines.push('=== ' + name + ' ===');
    lines.push('');

    if (team.name) lines.push('name: ' + String(team.name));
    if (team.description) lines.push('description: ' + String(team.description));
    if (team.lead) lines.push('lead: ' + String(team.lead));
    if (team.members) lines.push('members: ' + String(team.members));
    if (team.notes) lines.push('notes: ' + String(team.notes));

    var relations = team.relations;
    if (relations && typeof relations === 'object') {
        var relKeys = Object.keys(relations);
        if (relKeys.length > 0) {
            lines.push('');
            lines.push('--- Relations ---');
            relKeys.forEach(function(target) {
                lines.push(target + ': ' + String(relations[target]));
            });
        }
    }

    return lines.join('\n');
}

export function formatMediumTaskDetail(state, name) {
    var mediumTasks = state.medium_tasks || {};
    var task = mediumTasks[name];
    if (!task || typeof task !== 'object') {
        return 'Medium task "' + name + '" not found. Available: ' + Object.keys(mediumTasks).join(', ');
    }

    var lines = [];
    lines.push('=== Medium Task: ' + (task.title || name) + ' ===');
    lines.push('');
    if (task.title) lines.push('title: ' + String(task.title));
    if (task.status) lines.push('status: ' + String(task.status));
    if (task.description) lines.push('description: ' + String(task.description));
    if (task.progress_summary) lines.push('progress_summary: ' + String(task.progress_summary));
    if (task.assignee) lines.push('assignee: ' + String(task.assignee));
    if (task.deadline) lines.push('deadline: ' + String(task.deadline));
    if (task.created_at) lines.push('created_at: ' + String(task.created_at));
    if (task.parent_mission) lines.push('parent_mission: ' + String(task.parent_mission));

    // List child short tasks
    var shortTasks = state.short_tasks || {};
    var childTasks = Object.keys(shortTasks).filter(function(k) {
        var s = shortTasks[k];
        return s && s.parent_medium === name;
    });
    if (childTasks.length > 0) {
        lines.push('');
        lines.push('--- Child Short Tasks ---');
        childTasks.forEach(function(k) {
            var s = shortTasks[k];
            lines.push(k + ': [' + (s.status || '?') + '] ' + (s.title || '') +
                (s.assignee ? ' (assigned: ' + s.assignee + ')' : ''));
        });
    }

    return lines.join('\n');
}

export function formatShortTaskDetail(state, name) {
    var shortTasks = state.short_tasks || {};
    var task = shortTasks[name];
    if (!task || typeof task !== 'object') {
        return 'Short task "' + name + '" not found. Available: ' + Object.keys(shortTasks).join(', ');
    }

    var lines = [];
    lines.push('=== Short Task: ' + (task.title || name) + ' ===');
    lines.push('');
    if (task.title) lines.push('title: ' + String(task.title));
    if (task.status) lines.push('status: ' + String(task.status));
    if (task.parent_medium) lines.push('parent_medium: ' + String(task.parent_medium));
    if (task.assignee) lines.push('assignee: ' + String(task.assignee));
    if (task.description) lines.push('description: ' + String(task.description));
    if (task.created_at) lines.push('created_at: ' + String(task.created_at));

    return lines.join('\n');
}

export function formatEmergencyDetail(state, name) {
    var emergencies = state.emergencies || {};
    var emergency = emergencies[name];
    if (!emergency || typeof emergency !== 'object') {
        return 'Emergency "' + name + '" not found. Available: ' + Object.keys(emergencies).join(', ');
    }

    var lines = [];
    lines.push('=== Emergency: ' + (emergency.title || name) + ' ===');
    lines.push('');
    if (emergency.title) lines.push('title: ' + String(emergency.title));
    if (emergency.status) lines.push('status: ' + String(emergency.status));
    if (emergency.severity) lines.push('severity: ' + String(emergency.severity));
    if (emergency.interrupted) lines.push('interrupted: ' + String(emergency.interrupted));
    if (emergency.description) lines.push('description: ' + String(emergency.description));
    if (emergency.created_at) lines.push('created_at: ' + String(emergency.created_at));
    if (emergency.resolved_at) lines.push('resolved_at: ' + String(emergency.resolved_at));

    return lines.join('\n');
}

// ─── Backward compat (quests.X → search across task tree) ───

function formatQuestAlias(state, name) {
    var lines = [];

    var medium = state.medium_tasks || {};
    if (medium[name]) {
        lines.push(formatMediumTaskDetail(state, name));
    }

    var short = state.short_tasks || {};
    if (short[name]) {
        if (lines.length > 0) lines.push('\n---');
        lines.push(formatShortTaskDetail(state, name));
    }

    var emergencies = state.emergencies || {};
    if (emergencies[name]) {
        if (lines.length > 0) lines.push('\n---');
        lines.push(formatEmergencyDetail(state, name));
    }

    if (lines.length === 0) {
        var allNames = [];
        [medium, short, emergencies].forEach(function(obj) {
            Object.keys(obj).forEach(function(k) { allNames.push(k); });
        });
        return 'Quest/entry "' + name + '" not found. Available: ' + (allNames.length > 0 ? allNames.join(', ') : '(none)');
    }

    return lines.join('\n');
}

// ─── Backward compat exports ───

/** @deprecated Use formatParticipantDetail */
export function formatCharacterDetail(state, name) {
    return formatParticipantDetail(state, name);
}

/** @deprecated Use formatTeamDetail */
export function formatFactionDetail(state, name) {
    return formatTeamDetail(state, name);
}

/** @deprecated Use formatQuestAlias */
export function formatQuestDetail(state, name) {
    return formatQuestAlias(state, name);
}
