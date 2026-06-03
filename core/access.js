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
 *   "characters.Name"  — character card detail
 *   "factions.Name"    — faction detail with relations
 *   "quests.Name"      — quest/task/goal/event detail
 *   "chain.Name"       — narrative chain for an entity
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

    // characters.X / factions.X / quests.X → State detail
    var dotIdx = ref.indexOf('.');
    if (dotIdx > 0) {
        var domain = ref.substring(0, dotIdx);
        var name = ref.substring(dotIdx + 1);
        if (domain === 'characters') return formatCharacterDetail(state, name);
        if (domain === 'factions') return formatFactionDetail(state, name);
        if (domain === 'quests') return formatQuestDetail(state, name);
    }

    return 'Unknown ref format: ' + ref + '. Use stm_XX, ltm_XX, XX, characters.Name, factions.Name, quests.Name, or chain.Name.';
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

// ─── State entity formatters ───

export function formatCharacterDetail(state, name) {
    var characters = state.characters || {};
    var card = characters[name];
    if (!card || typeof card !== 'object') {
        return 'Character "' + name + '" not found. Available: ' + Object.keys(characters).join(', ');
    }

    var lines = [];
    lines.push('=== ' + name + ' ===');
    lines.push('');

    var npcNames = state.npc_names;
    var isNPC = npcNames && Array.isArray(npcNames) && npcNames.indexOf(name) !== -1;

    var coreFields = ['name', 'gender_age', 'occupation', 'clothing_build', 'personality', 'status'];
    coreFields.forEach(function(key) {
        if (card[key] !== undefined && card[key] !== null && card[key] !== '') {
            lines.push(key + ': ' + String(card[key]));
        }
    });

    if (isNPC) {
        if (card.inner_thoughts) lines.push('inner_thoughts: ' + String(card.inner_thoughts));
        if (card.affection !== undefined && card.affection !== null) lines.push('affection: ' + card.affection + '/100');
        if (card.relationship) lines.push('relationship: ' + String(card.relationship));
        if (card.current_mood) lines.push('current_mood: ' + String(card.current_mood));
        if (card.past_experience) lines.push('past_experience: ' + String(card.past_experience));
    }

    if (card.injuries) lines.push('injuries: ' + String(card.injuries));
    if (card.status_effects) lines.push('status_effects: ' + String(card.status_effects));
    if (card.clothing_mode !== undefined) lines.push('clothing_mode: ' + (card.clothing_mode ? 'detailed' : 'simple'));

    var inv = card.inventory;
    var invMode = card.inventory_mode || '关闭';
    if (invMode !== '关闭' && inv && typeof inv === 'object') {
        var invLines = [];
        if (inv.gold !== undefined && inv.gold !== null) invLines.push('Gold: ' + inv.gold + 'G');
        var items = inv.items || [];
        if (items.length > 0) {
            var itemDescs = items.map(function(item) {
                var desc = (item.name || '?') + (item.qty && item.qty > 1 ? ' x' + item.qty : '');
                if (item.equipped) desc += ' [Equipped]';
                if (item.desc) desc += ' - ' + item.desc;
                return desc;
            });
            invLines.push('Items: ' + itemDescs.join('; '));
        }
        if (invLines.length > 0) {
            lines.push('inventory_mode: ' + invMode);
            lines.push('inventory: ' + invLines.join(' | '));
        }
    }

    return lines.join('\n');
}

export function formatFactionDetail(state, name) {
    var factions = state.factions || {};
    var faction = factions[name];
    if (!faction || typeof faction !== 'object') {
        return 'Faction "' + name + '" not found. Available: ' + Object.keys(factions).join(', ');
    }

    var lines = [];
    lines.push('=== ' + name + ' ===');
    lines.push('');

    if (faction.name) lines.push('name: ' + String(faction.name));
    if (faction.description) lines.push('description: ' + String(faction.description));
    if (faction.leader) lines.push('leader: ' + String(faction.leader));
    if (faction.attitude_toward_player) lines.push('attitude_toward_player: ' + String(faction.attitude_toward_player));
    if (faction.notes) lines.push('notes: ' + String(faction.notes));

    var relations = faction.relations;
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

export function formatQuestDetail(state, name) {
    var quests = state.quests;
    if (!quests || typeof quests !== 'object') {
        return 'No quests found in state.';
    }

    /** @type {any} */
    var found = null;
    var foundType = null;

    if (quests.tasks && typeof quests.tasks === 'object') {
        Object.keys(quests.tasks).forEach(function(key) {
            var t = quests.tasks[key];
            if (t && (t.name === name || key === name)) { found = t; foundType = 'task'; }
        });
    }
    if (!found && quests.goals && typeof quests.goals === 'object') {
        Object.keys(quests.goals).forEach(function(key) {
            var g = quests.goals[key];
            if (g && (g.name === name || key === name)) { found = g; foundType = 'goal'; }
        });
    }
    if (!found && quests.events && typeof quests.events === 'object') {
        Object.keys(quests.events).forEach(function(key) {
            var e = quests.events[key];
            if (e && (e.name === name || key === name)) { found = e; foundType = 'event'; }
        });
    }

    if (!found) {
        var allNames = [];
        ['tasks', 'goals', 'events'].forEach(function(section) {
            if (quests[section] && typeof quests[section] === 'object') {
                Object.keys(quests[section]).forEach(function(k) {
                    var item = quests[section][k];
                    allNames.push(item && item.name ? item.name : k);
                });
            }
        });
        return 'Quest "' + name + '" not found. Available: ' + (allNames.length > 0 ? allNames.join(', ') : '(none)');
    }

    var lines = [];
    var typeLabels = { task: '=== Task ===', goal: '=== Goal ===', event: '=== World Event ===' };
    lines.push(typeLabels[foundType] || '=== Quest ===');
    lines.push('');

    if (foundType === 'task') {
        if (found.name) lines.push('name: ' + String(found.name));
        if (found.deadline) lines.push('deadline: ' + String(found.deadline));
        if (found.status) lines.push('status: ' + String(found.status));
        if (found.type) lines.push('type: ' + String(found.type));
        if (found.issuer) lines.push('issuer: ' + String(found.issuer));
        if (found.desc) lines.push('desc: ' + String(found.desc));
        if (found.progress) lines.push('progress: ' + String(found.progress));
        if (found.posted_time) lines.push('posted_time: ' + String(found.posted_time));
        if (found.reward) lines.push('reward: ' + String(found.reward));
        if (found.penalty) lines.push('penalty: ' + String(found.penalty));
    } else if (foundType === 'goal') {
        if (found.name) lines.push('name: ' + String(found.name));
        if (found.status) lines.push('status: ' + String(found.status));
        if (found.desc) lines.push('desc: ' + String(found.desc));
        if (found.progress) lines.push('progress: ' + String(found.progress));
        if (found.posted_time) lines.push('posted_time: ' + String(found.posted_time));
        if (found.completed_time) lines.push('completed_time: ' + String(found.completed_time));
    } else if (foundType === 'event') {
        if (found.name) lines.push('name: ' + String(found.name));
        if (found.status) lines.push('status: ' + String(found.status));
        if (found.desc) lines.push('desc: ' + String(found.desc));
        if (found.started_time) lines.push('started_time: ' + String(found.started_time));
        if (found.ended_time) lines.push('ended_time: ' + String(found.ended_time));
    }

    return lines.join('\n');
}
