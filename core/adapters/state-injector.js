// core/adapters/state-injector.js — State → Rule file auto-injection
//
// After each memory_extract or memory_update_state, formats the current vault
// state as markdown and writes it to the IDE/agent's auto-injected Rule file.
//
// Auto-detection priority (first match wins):
//   1. config.state_injection.path         (explicit manual override)
//   2. .trae/rules/ne-memory-state.md       → Trae
//   3. .cursor/rules/ne-memory-state.mdc    → Cursor (with YAML frontmatter)
//   4. .claude/rules/ne-memory-state.md     → Claude Code (modular, v2.0.64+)
//   5. .github/copilot-instructions.md      → GitHub Copilot
//   6. .windsurf/rules/ne-memory-state.md   → Windsurf (new-style)
//   7. .windsurfrules                       → Windsurf (legacy root file)
//   8. CLAUDE.md (append mode)             → Claude Code (legacy fallback)
//   9. ne-memory-state.md (project root)    → Generic fallback
//
// Environment:
//   NE_MEMORY_PROJECT_ROOT — project root directory (required)

import fs from 'node:fs';
import path from 'node:path';

// ─── File names ───
var RULES_FILE_NAME = 'ne-memory-state.md';
var CURSOR_FILE_NAME = 'ne-memory-state.mdc';

// ─── Marker for appending to CLAUDE.md ───
var CLAUDE_MARKER_START = '<!-- NE-MEMORY-STATE-START -->';
var CLAUDE_MARKER_END = '<!-- NE-MEMORY-STATE-END -->';

/**
 * @param {string} projectRoot - Absolute path to project root
 * @param {object} [explicitPath] - Optional explicit path from config
 * @returns {{ enabled: boolean, targetPath: string, mode: 'overwrite'|'append', targetType: string }}
 */
export function detectTarget(projectRoot, explicitPath) {
    if (!projectRoot) return { enabled: false, targetPath: '', mode: 'overwrite', targetType: '' };

    // 1. Explicit path from config
    if (explicitPath) {
        var resolved = path.resolve(projectRoot, explicitPath);
        return { enabled: true, targetPath: resolved, mode: 'overwrite', targetType: 'generic' };
    }

    // 2. Trae — .trae/rules/*.md
    var traeDir = path.join(projectRoot, '.trae', 'rules');
    if (fs.existsSync(traeDir)) {
        return { enabled: true, targetPath: path.join(traeDir, RULES_FILE_NAME), mode: 'overwrite', targetType: 'trae' };
    }

    // 3. Cursor — .cursor/rules/*.mdc (requires YAML frontmatter)
    var cursorDir = path.join(projectRoot, '.cursor', 'rules');
    if (fs.existsSync(cursorDir)) {
        return { enabled: true, targetPath: path.join(cursorDir, CURSOR_FILE_NAME), mode: 'overwrite', targetType: 'cursor' };
    }

    // 4. Claude Code modular — .claude/rules/*.md (v2.0.64+)
    var claudeRulesDir = path.join(projectRoot, '.claude', 'rules');
    if (fs.existsSync(claudeRulesDir)) {
        return { enabled: true, targetPath: path.join(claudeRulesDir, RULES_FILE_NAME), mode: 'overwrite', targetType: 'claude' };
    }

    // 5. GitHub Copilot — .github/copilot-instructions.md
    var copilotPath = path.join(projectRoot, '.github', 'copilot-instructions.md');
    if (fs.existsSync(copilotPath)) {
        return { enabled: true, targetPath: copilotPath, mode: 'append', targetType: 'copilot' };
    }

    // 6. Windsurf modular — .windsurf/rules/*.md
    var windsurfDir = path.join(projectRoot, '.windsurf', 'rules');
    if (fs.existsSync(windsurfDir)) {
        return { enabled: true, targetPath: path.join(windsurfDir, RULES_FILE_NAME), mode: 'overwrite', targetType: 'windsurf' };
    }

    // 7. Windsurf legacy — .windsurfrules root file
    var windsurfLegacyPath = path.join(projectRoot, '.windsurfrules');
    if (fs.existsSync(windsurfLegacyPath)) {
        return { enabled: true, targetPath: windsurfLegacyPath, mode: 'append', targetType: 'windsurf-legacy' };
    }

    // 8. Claude Code legacy — CLAUDE.md append
    var claudePath = path.join(projectRoot, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
        return { enabled: true, targetPath: claudePath, mode: 'append', targetType: 'claude-legacy' };
    }

    // 9. Generic fallback — create in project root
    return { enabled: true, targetPath: path.join(projectRoot, RULES_FILE_NAME), mode: 'overwrite', targetType: 'generic' };
}

/**
 * Format vault state as human-readable markdown.
 * @param {object} state - The state object from vault.content.state
 * @param {object} content - vault.content (for story_time, story_scene, etc.)
 * @returns {string}
 */
export function formatStateAsMarkdown(state, content) {
    state = state || {};
    content = content || {};

    var lines = [];
    lines.push('<!-- 此文件由 NE-Memory MCP 自动生成，每轮对话后更新 -->');
    lines.push('<!-- 请勿手动编辑 -->');
    lines.push('');
    lines.push('## NE-Memory 状态快照');
    lines.push('');

    // ─── Top-level context ───
    var scene = state.scene || content.story_scene || '';
    var time = state.time || content.story_time || '';
    var date = state.date || state.story_date || content.story_date || '';

    if (scene || time || date) {
        if (scene) lines.push('- **Scene**: ' + scene);
        if (time) lines.push('- **Time**: ' + time);
        if (date) lines.push('- **Date**: ' + date);
        if (state.current_focus) lines.push('- **Focus**: ' + state.current_focus);
        lines.push('');
    }

    // ─── Participants (grouped by status) ───
    var participants = state.participants || {};
    /** @type {{ active: Array<{name: string, card: object}>, standby: Array<{name: string, card: object}>, inactive: Array<{name: string, card: object}>, departed: Array<{name: string, card: object}>, unknown: Array<{name: string, card: object}> }} */
    var statusGroups = { active: [], standby: [], inactive: [], departed: [], unknown: [] };

    Object.keys(participants).forEach(function(name) {
        var p = participants[name];
        var status = (p && p.status) ? p.status : 'unknown';
        var group = statusGroups[status] || statusGroups.unknown;
        group.push({ name: name, card: p || {} });
    });

    if (statusGroups.active.length > 0) {
        lines.push('### Active Participants');
        statusGroups.active.forEach(function(p) {
            var parts = [];
            if (p.card.role) parts.push(p.card.role);
            if (p.card.expertise) parts.push(p.card.expertise);
            if (p.card.current_task) parts.push('task: ' + p.card.current_task);
            lines.push('- **' + p.name + '**: ' + (parts.length > 0 ? parts.join(', ') : '(no details)'));
        });
        lines.push('');
    }

    var otherStatuses = ['standby', 'inactive'];
    otherStatuses.forEach(function(status) {
        if (statusGroups[status].length > 0) {
            lines.push('### ' + capitalize(status) + ' Participants');
            lines.push(statusGroups[status].map(function(p) { return '- ' + p.name; }).join('\n'));
            lines.push('');
        }
    });

    if (statusGroups.departed.length > 0) {
        lines.push('### Departed');
        lines.push(statusGroups.departed.map(function(p) {
            var note = p.card.notes ? ' (' + p.card.notes + ')' : '';
            return '- ' + p.name + note;
        }).join('\n'));
        lines.push('');
    }

    // ─── Teams ───
    var teams = state.teams || {};
    var teamKeys = Object.keys(teams);
    if (teamKeys.length > 0) {
        lines.push('### Teams');
        teamKeys.forEach(function(name) {
            var t = teams[name] || {};
            var parts = [];
            if (t.lead) parts.push('lead: ' + t.lead);
            if (t.description) parts.push(t.description);
            lines.push('- **' + name + '**: ' + (parts.length > 0 ? parts.join(', ') : '(no details)'));
        });
        lines.push('');
    }

    // ─── Medium Tasks ───
    var mediumTasks = state.medium_tasks || {};
    var mtActive = Object.keys(mediumTasks).filter(function(k) {
        var t = mediumTasks[k];
        return t && t.status && t.status !== 'departed';
    });
    if (mtActive.length > 0) {
        lines.push('### Active Medium Tasks');
        mtActive.forEach(function(k) {
            var t = mediumTasks[k];
            var progress = t.progress_summary ? ' (' + t.progress_summary + ')' : '';
            lines.push('- **' + (t.title || k) + '**: [' + (t.status || '?') + ']' + progress);
        });
        lines.push('');
    }

    // ─── Short Tasks ───
    var shortTasks = state.short_tasks || {};
    var stActive = Object.keys(shortTasks).filter(function(k) {
        var s = shortTasks[k];
        return s && s.status && s.status !== 'done' && s.status !== 'failed';
    });
    if (stActive.length > 0) {
        lines.push('### Pending Short Tasks');
        stActive.forEach(function(k) {
            var s = shortTasks[k];
            lines.push('- **' + (s.title || k) + '**: [' + (s.status || '?') + ']' +
                (s.parent_medium ? ' → ' + s.parent_medium : '') +
                (s.assignee ? ' | ' + s.assignee : ''));
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
        lines.push('### Active Emergencies');
        emActive.forEach(function(k) {
            var e = emergencies[k];
            lines.push('- **' + (e.title || k) + '**: [' + (e.severity || '?') + '] — ' + (e.status || ''));
        });
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Write state markdown to target file.
 * Handles both 'overwrite' and 'append' modes.
 *
 * @param {object} target - Result from detectTarget()
 * @param {string} markdown - Formatted markdown content
 */
export function writeStateToFile(target, markdown) {
    if (!target || !target.enabled) return;

    var dir = path.dirname(target.targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (target.mode === 'append') {
        // Read existing file, replace or append the marked section
        var existing = '';
        try {
            existing = fs.readFileSync(target.targetPath, 'utf-8');
        } catch (e) { /* file may not exist */ }

        var startIdx = existing.indexOf(CLAUDE_MARKER_START);
        var endIdx = existing.indexOf(CLAUDE_MARKER_END);

        var wrapped = CLAUDE_MARKER_START + '\n' + markdown + '\n' + CLAUDE_MARKER_END;

        if (startIdx >= 0 && endIdx > startIdx) {
            // Replace existing section
            existing = existing.substring(0, startIdx) + wrapped + existing.substring(endIdx + CLAUDE_MARKER_END.length);
        } else {
            // Append at end
            existing = (existing.trimEnd ? existing.trimEnd() : existing.trim()) + '\n\n' + wrapped + '\n';
        }

        fs.writeFileSync(target.targetPath, existing, 'utf-8');
    } else {
        // Overwrite mode
        fs.writeFileSync(target.targetPath, markdown, 'utf-8');
    }
}

/**
 * Main injection function — call after state changes.
 *
 * @param {object} options
 * @param {string} options.chatId - Chat session ID
 * @param {Function} options.readVault - ne.read(chatId)
 * @param {Function} options.getState - ne.getState(chatId)
 * @param {string} options.projectRoot - Project root directory
 * @param {string} [options.explicitPath] - Optional explicit path from config
 */
export async function injectState(options) {
    var projectRoot = options.projectRoot;
    if (!projectRoot) return { injected: false, reason: 'No project root configured' };

    var target = detectTarget(projectRoot, options.explicitPath);
    if (!target.enabled) return { injected: false, reason: 'No suitable Rule file detected' };

    try {
        var vault = await options.readVault(options.chatId);
        var content = vault.content || {};
        var state = content.state || {};
        var markdown = formatStateAsMarkdown(state, content);

        // Cursor .mdc files require YAML frontmatter with globs for auto-loading
        if (target.targetType === 'cursor') {
            markdown = '---\ndescription: NE-Memory vault state snapshot — auto-generated, do not edit\nglobs: **/*\n---\n\n' + markdown;
        }

        writeStateToFile(target, markdown);
        return { injected: true, targetPath: target.targetPath, mode: target.mode, targetType: target.targetType };
    } catch (e) {
        return { injected: false, reason: e.message };
    }
}

function capitalize(s) {
    if (!s) return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}
