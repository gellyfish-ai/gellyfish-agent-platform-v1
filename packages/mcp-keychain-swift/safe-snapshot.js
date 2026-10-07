#!/usr/bin/env node
// Safe snapshot — accessibility tree via CDP with password values redacted.
//
// Why this is more aggressive than `<input type=password>`:
//   - idmsa.apple.com (and other Apple flows) renders the password input as
//     `<input type="text">` and hides characters with `-webkit-text-security`.
//     `browser_snapshot` returns the cleartext value because the type is text.
//   - Twitter/X.com uses `<input type="text" autocomplete="current-password">`
//     in some flows.
// We layer four predicates so the redaction triggers on whichever signal the
// page exposes. Tracked in GAP#654.
//
// Inputs (env):
//   TARGET_URL         — optional, used to pick the right CDP page target
//   RECENT_FILLS_JSON  — optional JSON array `[{urlHost, selector, recordedAt}]`
//                        emitted by the keychain Swift process after a
//                        successful CDP fill. 5-minute TTL is enforced on the
//                        Swift side; we just consume.

const WebSocket = require('ws');
const http = require('http');

/**
 * Pure predicate: should this input's value be redacted?
 *
 * Exported for unit tests — the same function source is also stringified
 * into the page-eval'd script so the browser walker uses identical logic.
 *
 * `info` shape:
 *   - type:                 input.type (lowercased)
 *   - autocomplete:         input.autocomplete (lowercased) — e.g. "current-password"
 *   - computedTextSecurity: getComputedStyle(el).webkitTextSecurity ("disc"/"none"/"")
 *   - matchesRecentFill:    true if (host, selector) matches an entry from
 *                           RECENT_FILLS_JSON within the TTL
 */
function decideRedaction(info) {
    if (!info) return false;
    if (info.type === 'password') return true;
    if (info.computedTextSecurity && info.computedTextSecurity !== 'none') return true;
    if (typeof info.autocomplete === 'string' &&
        (info.autocomplete === 'current-password' || info.autocomplete === 'new-password')) {
        return true;
    }
    if (info.matchesRecentFill === true) return true;
    return false;
}

module.exports = { decideRedaction };

// When required (e.g. by the test runner), do not run the CDP flow.
if (require.main !== module) return;

// Get CDP WebSocket URL
http.get('http://localhost:9222/json', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
        try {
            const targets = JSON.parse(data);
            const targetUrl = process.env.TARGET_URL || '';
            let targetHost = '';
            try { targetHost = new URL(targetUrl).hostname.toLowerCase(); } catch {}
            const pageTarget = targetHost
                ? targets.find(t => t.type === 'page' && t.url && t.url.toLowerCase().includes(targetHost))
                    || targets.find(t => t.type === 'page')
                : targets.find(t => t.type === 'page');
            if (!pageTarget) {
                console.error('No page target found. Is Chrome running with --remote-debugging-port=9222?');
                process.exit(1);
            }
            connectAndSnapshot(pageTarget.webSocketDebuggerUrl, pageTarget.url, pageTarget.title);
        } catch (e) {
            console.error('Failed to parse CDP targets:', e.message);
            process.exit(1);
        }
    });
}).on('error', (e) => {
    console.error('Failed to connect to CDP:', e.message);
    process.exit(1);
});

function connectAndSnapshot(wsUrl, pageUrl, pageTitle) {
    const socket = new WebSocket(wsUrl);
    let id = 1;

    // Defensive parse — if Swift wrote garbage, fall back to no recent fills
    // rather than crashing the snapshot. The test for the predicate is what
    // actually gates correctness; this is opportunistic enrichment.
    let recentFills = [];
    try {
        const raw = process.env.RECENT_FILLS_JSON;
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) recentFills = parsed;
        }
    } catch {
        recentFills = [];
    }

    // Inject decideRedaction source + recent fills as JS literals so the page
    // walker uses identical logic to the Node-side unit tests.
    const decideSrc = decideRedaction.toString();
    const fillsLiteral = JSON.stringify(recentFills);

    socket.on('open', () => {
        socket.send(JSON.stringify({
            id: id++,
            method: 'Runtime.evaluate',
            params: {
                expression: `
                    (async function() {
                        const decideRedaction = ${decideSrc};
                        const recentFills = ${fillsLiteral};
                        const currentHost = (location.hostname || '').toLowerCase();

                        function inputMatchesRecentFill(el) {
                            for (const fill of recentFills) {
                                if (!fill || typeof fill.selector !== 'string') continue;
                                if ((fill.urlHost || '').toLowerCase() !== currentHost) continue;
                                try {
                                    if (el.matches(fill.selector)) return true;
                                } catch (_) { /* invalid selector — ignore */ }
                            }
                            return false;
                        }

                        function buildInputInfo(el) {
                            let computedTextSecurity = '';
                            try {
                                const cs = getComputedStyle(el);
                                computedTextSecurity = (cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security') || '').toLowerCase();
                            } catch (_) {}
                            return {
                                type: (el.type || '').toLowerCase(),
                                autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
                                computedTextSecurity,
                                matchesRecentFill: inputMatchesRecentFill(el)
                            };
                        }

                        function getSnapshot(node, depth = 0) {
                            const indent = '  '.repeat(depth);
                            const lines = [];

                            const role = node.role || 'generic';
                            const name = node.name || '';
                            const value = node.value || '';

                            let line = indent + '- ' + role;
                            if (name) line += ' "' + name.replace(/"/g, '\\\\"') + '"';
                            if (node.focused) line += ' [active]';
                            if (node.expanded !== undefined) line += ' [expanded=' + node.expanded + ']';
                            if (value) {
                                if (node.isPassword) {
                                    line += ': [REDACTED]';
                                } else {
                                    line += ': ' + value;
                                }
                            }

                            lines.push(line);

                            if (node.children) {
                                for (const child of node.children) {
                                    lines.push(getSnapshot(child, depth + 1));
                                }
                            }

                            return lines.join('\\n');
                        }

                        function walkDOM(element, depth = 0) {
                            const result = {
                                role: element.getAttribute?.('role') || element.tagName?.toLowerCase() || 'generic',
                                name: element.getAttribute?.('aria-label') || element.innerText?.slice(0, 100) || '',
                                value: element.value || '',
                                focused: document.activeElement === element,
                                children: []
                            };

                            if (element.tagName === 'INPUT') {
                                const info = buildInputInfo(element);
                                if (decideRedaction(info)) {
                                    result.role = 'textbox';
                                    result.name = element.getAttribute('aria-label') || element.placeholder || 'Password';
                                    result.isPassword = true;
                                }
                            }

                            if (depth > 10) return result;
                            if (element.hidden || element.style?.display === 'none') return null;

                            for (const child of (element.children || [])) {
                                const childResult = walkDOM(child, depth + 1);
                                if (childResult && (childResult.role !== 'generic' || childResult.name || childResult.value || childResult.children.length)) {
                                    result.children.push(childResult);
                                }
                            }

                            return result;
                        }

                        const tree = walkDOM(document.body);
                        return getSnapshot(tree);
                    })()
                `,
                awaitPromise: true,
                returnByValue: true
            }
        }));
    });

    socket.on('message', (data) => {
        const msg = JSON.parse(data);

        if (msg.result && msg.result.result && msg.result.result.value) {
            const lines = [];
            lines.push('### Page state');
            lines.push(`- Page URL: ${pageUrl}`);
            lines.push(`- Page Title: ${pageTitle}`);
            lines.push('- Page Snapshot:');
            lines.push('```yaml');
            lines.push(msg.result.result.value);
            lines.push('```');
            console.log(lines.join('\n'));
            socket.close();
            process.exit(0);
        }

        if (msg.result && msg.result.exceptionDetails) {
            console.error('Script error:', msg.result.exceptionDetails.text);
            socket.close();
            process.exit(1);
        }
    });

    socket.on('error', (e) => {
        console.error('WebSocket error:', e.message);
        process.exit(1);
    });

    setTimeout(() => {
        console.error('Timeout waiting for CDP response');
        socket.close();
        process.exit(1);
    }, 10000);
}
