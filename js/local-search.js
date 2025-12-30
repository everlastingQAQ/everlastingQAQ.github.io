// themes/maupassant/source/js/local-search.js
(function () {
    'use strict';

    const INPUT_ID = 'local-search-input';
    const RESULT_ID = 'local-search-result';
    const SEARCH_PATH = '/search.xml';
    const DEBOUNCE_MS = 180;
    const MIN_SCORE_THRESHOLD = 0.15; // 结果最低得分阈值（0-1）

    function $(id) { return document.getElementById(id); }
    function debounce(fn, wait) {
        let t;
        return function (...args) {
            clearTimeout(t);
            t = setTimeout(() => fn.apply(this, args), wait);
        };
    }
    function escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Levenshtein 距离（用于短词模糊容错）
    function levenshtein(a, b) {
        if (!a) return b.length;
        if (!b) return a.length;
        const m = a.length, n = b.length;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
            }
        }
        return dp[m][n];
    }

    // HTML -> 纯文本
    function htmlToPlain(html) {
        const div = document.createElement('div');
        div.innerHTML = html || '';
        let text = div.textContent || div.innerText || '';
        text = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[ \u00A0]{2,}/g, ' ');
        return text;
    }

    // 提取自然语言段落并去掉行号/长数字/代码行
    function extractNaturalText(raw) {
        if (!raw) return '';
        const plain = htmlToPlain(raw);
        // 删除长连续数字串（行号残留）
        let cleaned = plain.replace(/\b\d{4,}\b/g, ' ');
        // 删除常见代码行首或宏
        const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
        const filtered = lines.filter(line => {
            if (!line) return false;
            if (/^[\d\W_]+$/.test(line)) return false;
            if (/^\s*(#include|#define|using\s+namespace|int\s+main|std::|printf|scanf|cout<<|cin>>|template<|typedef|struct|class|return\b)/i.test(line)) return false;
            if (/[\u4e00-\u9fa5]/.test(line)) return true;
            if (/[a-zA-Z]/.test(line) && /\b[a-zA-Z]{2,}\b.*\b[a-zA-Z]{2,}\b/.test(line)) return true;
            return false;
        });
        return filtered.join(' ');
    }

    // 生成 snippet 并用【】标记关键词（后续安全插入）
    function makeSnippet(content, keyword, radiusBefore = 50, radiusAfter = 100) {
        if (!content) return '';
        const lower = content.toLowerCase();
        const k = keyword.toLowerCase();
        const idx = lower.indexOf(k);
        if (idx === -1) {
            const head = content.substring(0, 120);
            return head.length < content.length ? head + '...' : head;
        }
        const start = Math.max(0, idx - radiusBefore);
        const end = Math.min(content.length, idx + k.length + radiusAfter);
        let snippet = content.substring(start, end);
        const re = new RegExp(escapeRegExp(keyword), 'gi');
        snippet = snippet.replace(re, match => `【${match}】`);
        return (start > 0 ? '... ' : '') + snippet + (end < content.length ? ' ...' : '');
    }

    // 安全插入文本并把【】替换为 <mark>
    function setSafeHTML(container, htmlString) {
        container.textContent = '';
        const PLACE_OPEN = '___HIGHLIGHT_OPEN___';
        const PLACE_CLOSE = '___HIGHLIGHT_CLOSE___';
        const safe = htmlString.replace(/【/g, PLACE_OPEN).replace(/】/g, PLACE_CLOSE);
        const parts = safe.split(PLACE_OPEN);
        parts.forEach(part => {
            const sub = part.split(PLACE_CLOSE);
            if (sub.length === 1) {
                container.appendChild(document.createTextNode(sub[0]));
            } else {
                const mark = document.createElement('mark');
                mark.textContent = sub[0];
                container.appendChild(mark);
                container.appendChild(document.createTextNode(sub[1]));
            }
        });
    }

    // 评分函数：返回 0-1 的得分
    function scoreMatch(item, query) {
        if (!query) return 0;
        const q = query.trim().toLowerCase();
        const title = (item.title || '').toLowerCase();
        const content = (item.content || '').toLowerCase();

        // token 分解（按空格/标点）
        const tokens = q.split(/\s+/).filter(Boolean);

        let score = 0;

        // 标题精确包含得分高
        if (title.includes(q)) score += 0.45;

        // 内容精确包含得分
        if (content.includes(q)) score += 0.25;

        // token 覆盖率：每个 token 在 title/content 出现加分
        let tokenMatches = 0;
        tokens.forEach(t => {
            if (!t) return;
            if (title.includes(t)) tokenMatches += 2;
            else if (content.includes(t)) tokenMatches += 1;
            else {
                // 词前缀匹配
                const re = new RegExp('\\b' + escapeRegExp(t), 'i');
                if (re.test(title)) tokenMatches += 1.2;
                else if (re.test(content)) tokenMatches += 0.6;
                else {
                    // Levenshtein 对短 token 进行容错匹配
                    if (t.length <= 6) {
                        // 在 title/content 中找最短距离
                        const words = (title + ' ' + content).split(/\W+/).filter(Boolean);
                        let best = Infinity;
                        for (let w of words) {
                            const d = levenshtein(t, w);
                            if (d < best) best = d;
                            if (best === 0) break;
                        }
                        if (best <= Math.max(1, Math.floor(t.length * 0.3))) {
                            tokenMatches += 0.8;
                        }
                    }
                }
            }
        });

        // 归一化 tokenMatches（假设每 token 最多 2 分）
        const maxTokenScore = tokens.length * 2;
        if (maxTokenScore > 0) score += 0.2 * (tokenMatches / maxTokenScore);

        // 额外：标题越短且包含 query，得分略增（更精确）
        if (title.includes(q) && title.length <= 60) score += 0.05;

        // 限制最大值为 1
        if (score > 1) score = 1;
        return score;
    }

    // 加载索引并缓存
    function loadIndex(callback) {
        fetch(SEARCH_PATH, { cache: 'no-cache' })
        .then(res => {
            if (!res.ok) throw new Error('无法加载索引文件');
            return res.text();
        })
        .then(text => {
            const parser = new DOMParser();
            const xml = parser.parseFromString(text, 'application/xml');
            const entries = xml.getElementsByTagName('entry');
            const arr = Array.from(entries).map(entry => {
                const titleNode = entry.getElementsByTagName('title')[0];
                const urlNode = entry.getElementsByTagName('url')[0];
                const contentNode = entry.getElementsByTagName('content')[0];
                const title = titleNode ? (titleNode.textContent || '') : '';
                const url = urlNode ? (urlNode.textContent || '') : '';
                const rawContent = contentNode ? (contentNode.textContent || '') : '';
                const content = extractNaturalText(rawContent);
                return { title, url, content };
            });
            callback(null, arr);
        })
        .catch(err => callback(err));
    }

    // 渲染结果（按得分排序）
    function renderResults(results, keyword) {
        const container = $(RESULT_ID);
        container.innerHTML = '';
        if (!results || results.length === 0) {
            const p = document.createElement('p');
            p.textContent = '😢 没有找到相关内容。';
            container.appendChild(p);
            return;
        }
        results.forEach(item => {
            const wrap = document.createElement('div');
            wrap.className = 'search-result';

            const a = document.createElement('a');
            a.href = item.url;
            a.textContent = item.title || item.url;
            a.style.display = 'block';
            a.style.fontWeight = '600';
            a.style.marginBottom = '6px';

            const snippetText = makeSnippet(item.content || '', keyword);
            const snippet = document.createElement('p');
            snippet.className = 'search-snippet';
            setSafeHTML(snippet, snippetText);

            wrap.appendChild(a);
            wrap.appendChild(snippet);
            container.appendChild(wrap);
        });
    }

    // 初始化并绑定事件
    function init() {
        const input = $(INPUT_ID);
        const result = $(RESULT_ID);
        if (!input || !result) return;

        let indexData = [];
        let loaded = false;

        loadIndex((err, data) => {
            if (err) {
                result.textContent = '搜索索引加载失败';
                console.error(err);
                return;
            }
            indexData = data;
            loaded = true;
        });

        function doSearchImmediate() {
            const q = input.value.trim();
            if (!q) {
                result.innerHTML = '';
                return;
            }
            if (!loaded) {
                result.textContent = '索引加载中，请稍候...';
                return;
            }
            const key = q.toLowerCase();
            // 计算每条的得分
            const scored = indexData.map(item => {
                const s = scoreMatch(item, key);
                return { item, score: s };
            }).filter(x => x.score >= MIN_SCORE_THRESHOLD);

            // 排序并取前 N（例如 50）
            scored.sort((a, b) => b.score - a.score);
            const top = scored.slice(0, 50).map(x => x.item);

            renderResults(top, q);
        }

        const debounced = debounce(doSearchImmediate, DEBOUNCE_MS);

        input.addEventListener('input', debounced);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                doSearchImmediate();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
