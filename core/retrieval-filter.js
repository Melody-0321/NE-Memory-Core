// core/retrieval-filter.js — BM25 text retrieval for NE Memory Engine
//
// Pure BM25 scoring with Chinese 2-gram tokenizer.
// No external dependencies — fully portable.
//
// Parameters: k1=1.5, b=0.75 (standard Okapi BM25)

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

function tokenize(text) {
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
}

export { tokenize };

function buildSearchableText(entry) {
    var parts = [];
    if (entry.period) parts.push(entry.period);
    if (entry.time_range) parts.push(entry.time_range);
    if (entry.time_label) parts.push(entry.time_label);
    if (entry.scene) parts.push(entry.scene);
    if (entry.event) parts.push(entry.event);
    if (entry.translation) parts.push(entry.translation);
    return parts.join(' ');
}

function bm25Score(queryTokens, docTokens, avgDocLen, totalDocs, docFreq) {
    var k1 = 1.5;
    var b = 0.75;
    var docLen = docTokens.length;
    var score = 0;

    var tfMap = {};
    for (var i = 0; i < docTokens.length; i++) {
        var t = docTokens[i];
        tfMap[t] = (tfMap[t] || 0) + 1;
    }

    var normFactor = 1 - b + b * (docLen / Math.max(avgDocLen, 1));
    var seenQuery = {};

    for (var i = 0; i < queryTokens.length; i++) {
        var term = queryTokens[i];
        if (seenQuery[term]) continue;
        seenQuery[term] = true;

        var tf = tfMap[term] || 0;
        if (tf === 0) continue;

        var df = docFreq[term] || 0;
        var idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1.0);
        var numerator = tf * (k1 + 1);
        var denominator = tf + k1 * normFactor;
        score += idf * (numerator / denominator);
    }

    return score;
}

// ─── Time constraint parsing ───

export function parseTimeConstraint(query) {
    if (!query || typeof query !== 'string') return null;

    var q = query.trim();

    // 1. Day X-Y range (narrative time)
    var dayRange = q.match(/Day\s*(\d+)\s*(?:[-–—]|to)\s*Day?\s*(\d+)/i);
    if (dayRange) {
        return { type: 'narrative_range', from: 'Day ' + dayRange[1], to: 'Day ' + dayRange[2], period: 'Day ' + dayRange[1] + '-' + dayRange[2] };
    }

    // 2. Day X (narrative time)
    var daySingle = q.match(/Day\s*(\d+)/i);
    if (daySingle) {
        return { type: 'narrative', period: 'Day ' + daySingle[1] };
    }

    // 3. Month YYYY (English month names)
    var months = ['january','february','march','april','may','june','july','august','september','october','november','december',
                  'jan','feb','mar','apr','jun','jul','aug','sep','oct','nov','dec'];
    for (var i = 0; i < months.length; i++) {
        var m = months[i];
        var re = new RegExp('\\b' + m + '\\b', 'i');
        if (re.test(q)) {
            var yearMatch = q.match(/\b(20\d{2})\b/);
            var period = m.charAt(0).toUpperCase() + m.slice(1);
            if (yearMatch) period += ' ' + yearMatch[1];
            var monthNum = (i % 12) + 1;
            return { type: 'absolute', period: period, month: monthNum, year: yearMatch ? parseInt(yearMatch[1]) : null };
        }
    }

    // 4. ISO date YYYY-MM
    var isoMatch = q.match(/\b(20\d{2})-(\d{2})\b/);
    if (isoMatch) {
        return { type: 'absolute', period: isoMatch[1] + '-' + isoMatch[2], month: parseInt(isoMatch[2]), year: parseInt(isoMatch[1]) };
    }

    // 5. Relative time
    if (/\byesterday\b/i.test(q)) return { type: 'relative', period: 'yesterday' };
    if (/\blast\s+week\b/i.test(q)) return { type: 'relative', period: 'last week' };

    return null;
}

export function applyTimeFilter(entries, constraint, content) {
    if (!constraint) return entries.slice();

    entries = entries || [];
    content = content || {};

    return entries.filter(function(e) {
        var entryTime = e.period || e.time_range || '';
        if (!entryTime) return false;

        var entryLower = entryTime.toLowerCase();

        if (constraint.type === 'narrative' || constraint.type === 'narrative_range') {
            if (constraint.type === 'narrative') {
                var targetDay = constraint.period.toLowerCase();
                return entryLower.indexOf(targetDay) === 0;
            } else {
                var dayMatch = entryLower.match(/day\s*(\d+)/);
                if (!dayMatch) return false;
                var dayNum = parseInt(dayMatch[1]);
                var fromDay = parseInt(constraint.from.toLowerCase().replace('day ', ''));
                var toDay = parseInt(constraint.to.toLowerCase().replace('day ', ''));
                return dayNum >= fromDay && dayNum <= toDay;
            }
        }

        if (constraint.type === 'absolute') {
            var period = constraint.period.toLowerCase();
            return entryLower.indexOf(period) !== -1;
        }

        if (constraint.type === 'relative') {
            return entryLower.indexOf(constraint.period.toLowerCase()) !== -1;
        }

        return true;
    });
}

// ─── TimeOnly auto-detection ───

var TIME_WORDS = [
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun',
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'day', 'week', 'month', 'year', 'hour', 'minute',
    'morning', 'afternoon', 'evening', 'night', 'dawn', 'dusk', 'midnight',
    'yesterday', 'today', 'tomorrow', 'tonight',
    // Chinese
    '昨天', '今天', '明天', '上午', '下午', '晚上', '早晨', '凌晨',
    '周一', '周二', '周三', '周四', '周五', '周六', '周日',
    '一月', '二月', '三月', '四月', '五月', '六月',
    '七月', '八月', '九月', '十月', '十一月', '十二月',
    '天', '周', '月', '年', '小时', '分钟',
    '星期', '礼拜'
];

function isTimeWord(word) {
    if (!word || word.length < 2) return false;
    var lower = word.toLowerCase();
    for (var i = 0; i < TIME_WORDS.length; i++) {
        if (lower === TIME_WORDS[i] || lower.indexOf(TIME_WORDS[i]) !== -1) return true;
    }
    return false;
}

export function isTimeOnlyQuery(query, timeConstraint) {
    if (!timeConstraint || !query) return false;

    var lower = query.toLowerCase().trim();
    // Strong signal: query starts with summarize/list/show everything/what happened
    if (/^(summarize|总结|概括|列出|list|show.+everything|what happened)/i.test(lower)) return true;

    var words = query.split(/[\s,，。！？!?\n]+/).filter(Boolean);
    var nonTimeWords = words.filter(function(w) { return !isTimeWord(w); });

    // <= 2 non-time words → pure time query, auto timeOnly
    return nonTimeWords.length <= 2;
}

export function filterCandidates(query, allSTM, allLTM, topK, minResults) {
    topK = topK || 40;
    minResults = minResults || 3;
    allSTM = allSTM || [];
    allLTM = allLTM || [];

    var entries = [];
    var STM_COUNT_FOR_LTM = 500;
    var useLTM = allSTM.length >= STM_COUNT_FOR_LTM;

    for (var i = 0; i < allSTM.length; i++) {
        var stm = allSTM[i];
        if (useLTM && stm.parent_ltm) continue;
        var text = buildSearchableText(stm);
        entries.push({
            _tokens: tokenize(text),
            _entry: stm,
            _type: 'stm',
            _id: stm.id,
            _score: 0
        });
    }

    if (useLTM) {
        for (var i = 0; i < allLTM.length; i++) {
            var ltm = allLTM[i];
            var text = buildSearchableText(ltm);
            entries.push({
                _tokens: tokenize(text),
                _entry: ltm,
                _type: 'ltm',
                _id: ltm.id,
                _score: 0
            });
        }
    }

    var totalDocs = entries.length;
    if (totalDocs === 0) return [];

    var docFreq = {};
    var totalTokens = 0;

    for (var i = 0; i < entries.length; i++) {
        var tokens = entries[i]._tokens;
        totalTokens += tokens.length;
        var seen = {};
        for (var j = 0; j < tokens.length; j++) {
            var term = tokens[j];
            if (!seen[term]) {
                seen[term] = true;
                docFreq[term] = (docFreq[term] || 0) + 1;
            }
        }
    }

    var avgDocLen = totalDocs > 0 ? totalTokens / totalDocs : 1;
    var queryTokens = tokenize(query);

    for (var i = 0; i < entries.length; i++) {
        entries[i]._score = bm25Score(queryTokens, entries[i]._tokens, avgDocLen, totalDocs, docFreq);
    }

    entries.sort(function (a, b) { return b._score - a._score; });

    var resultCount = Math.min(topK, entries.length);
    var results = [];
    var scoreZeroStart = -1;
    for (var i = 0; i < resultCount; i++) {
        var e = entries[i];
        if (e._score <= 0) {
            if (scoreZeroStart < 0) scoreZeroStart = i;
            if (results.length >= minResults) break;  // Enough positive results, stop
            // Fall through: include score-0 to reach minResults
        }
        var result = JSON.parse(JSON.stringify(e._entry));
        result.__type = e._type;
        result.__id = e._id;
        results.push(result);
    }

    return results;
}
