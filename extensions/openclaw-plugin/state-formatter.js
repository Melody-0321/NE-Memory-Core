// state-formatter.js — Format NE-Memory vault state as concise markdown
//
// Self-contained: reads raw vault JSON, produces injectable markdown.
// Used by both the OpenClaw plugin and the state-injector adapter.

/**
 * @param {object} vaultContent - vault.content (state, story_time, story_scene, etc.)
 * @returns {string}
 */
export function formatState(vaultContent) {
    var content = vaultContent || {};
    var state = content.state || {};

    var lines = [];

    // ─── Top-level context ───
    var scene = state.scene || content.story_scene || '';
    var time = state.time || content.story_time || '';
    var date = state.date || content.story_date || '';

    if (scene || time || date) {
        lines.push('<!-- NE-Memory state snapshot — auto-generated -->');
        if (scene) lines.push('**Scene**: ' + scene);
        if (time) lines.push('**Time**: ' + time);
        if (date) lines.push('**Date**: ' + date);
        if (state.current_focus) lines.push('**Focus**: ' + state.current_focus);
        lines.push('');
    }

    // ─── Participants ───
    var participants = state.participants || {};
    var names = Object.keys(participants);
    if (names.length > 0) {
        var active = [];
        var others = [];
        names.forEach(function(name) {
            var p = participants[name] || {};
            if (p.status === 'active') {
                var parts = [];
                if (p.role) parts.push(p.role);
                if (p.expertise) parts.push(p.expertise);
                if (p.current_task) parts.push('task: ' + p.current_task);
                active.push(name + (parts.length > 0 ? ' (' + parts.join(', ') + ')' : ''));
            } else if (p.status !== 'departed') {
                others.push(name + (p.status ? ' [' + p.status + ']' : ''));
            }
        });

        if (active.length > 0) {
            lines.push('**Active**: ' + active.join(' | '));
        }
        if (others.length > 0) {
            lines.push('**Others**: ' + others.join(', '));
        }
        if (active.length > 0 || others.length > 0) {
            lines.push('');
        }
    }

    // ─── Teams ───
    var teams = state.teams || {};
    var teamKeys = Object.keys(teams);
    if (teamKeys.length > 0) {
        lines.push('**Teams**:');
        teamKeys.forEach(function(name) {
            var t = teams[name] || {};
            var desc = t.lead ? 'lead: ' + t.lead : '';
            if (t.description) desc = desc ? desc + ', ' + t.description : t.description;
            lines.push('- ' + name + (desc ? ' — ' + desc : ''));
        });
        lines.push('');
    }

    // ─── Tasks (active only) ───
    var mediumTasks = state.medium_tasks || {};
    var mtActive = Object.keys(mediumTasks).filter(function(k) {
        var t = mediumTasks[k];
        return t && t.status && t.status !== 'departed';
    });
    if (mtActive.length > 0) {
        lines.push('**Active tasks**:');
        mtActive.forEach(function(k) {
            var t = mediumTasks[k];
            lines.push('- ' + (t.title || k) + ' [' + (t.status || '?') + ']' +
                (t.progress_summary ? ' — ' + t.progress_summary : ''));
        });
        lines.push('');
    }

    // ─── Emergencies ───
    var emergencies = state.emergencies || {};
    var emActive = Object.keys(emergencies).filter(function(k) {
        var e = emergencies[k];
        return e && e.status === 'active';
    });
    if (emActive.length > 0) {
        lines.push('**Emergencies**:');
        emActive.forEach(function(k) {
            var e = emergencies[k];
            lines.push('- ' + (e.title || k) + ' [' + (e.severity || '?') + ']');
        });
        lines.push('');
    }

    return lines.length > 2 ? lines.join('\n') : '';
}
