#!/usr/bin/env node
// Secure password filler — connects to Chrome via CDP and fills a password
// in the top document or any iframe (same-origin or cross-origin / OOPIF)
// reachable from the matched page target. Password is passed via SECRET_VALUE
// env var, never as a CLI argument, so it does not appear in `ps`.
//
// Usage: SECRET_VALUE=xxx [TARGET_URL=https://...] node fill-password.js <css-selector>

const WebSocket = require('ws');
const http = require('http');

const selector = process.argv[2];
const password = process.env.SECRET_VALUE;
const targetUrlEnv = process.env.TARGET_URL || '';

if (!selector) {
    console.error('Usage: SECRET_VALUE=xxx node fill-password.js <css-selector>');
    process.exit(1);
}

if (!password) {
    console.error('No password in SECRET_VALUE environment variable');
    process.exit(1);
}

const TIMEOUT_MS = 8000;
const ISOLATED_WORLD_NAME = 'gellyfish-fill-password';

main().catch((err) => {
    console.error(err && err.message ? err.message : String(err));
    process.exit(1);
});

async function main() {
    const targets = await fetchTopLevelTargets();

    let targetHost = '';
    try { targetHost = new URL(targetUrlEnv).hostname.toLowerCase(); } catch { /* */ }

    const pageTarget = targetHost
        ? (targets.find(t => t.type === 'page' && t.url && t.url.toLowerCase().includes(targetHost))
            || targets.find(t => t.type === 'page'))
        : targets.find(t => t.type === 'page');
    if (!pageTarget) {
        console.error('No page target found. Is Chrome running with --remote-debugging-port=9222?');
        process.exit(1);
    }

    const socket = await connectWS(pageTarget.webSocketDebuggerUrl);
    const cdp = wrapCdp(socket);

    const timeout = setTimeout(() => {
        console.error('Timeout waiting for CDP response');
        try { socket.terminate(); } catch { /* */ }
        process.exit(1);
    }, TIMEOUT_MS);

    const triedFrames = [];
    try {
        // 1) Top document — fast path, no iframe enumeration overhead.
        triedFrames.push(pageTarget.url || '<top>');
        if (await tryFillTopDoc(cdp)) {
            return done(socket, timeout, 0);
        }

        // 2) Walk every frame in the page's frame tree and run the fill in an
        //    isolated world bound to that frame. This works for same-origin
        //    iframes AND cross-origin OOPIFs without depending on Target.* —
        //    Target.setDiscoverTargets / setAutoAttach do not reliably surface
        //    OOPIF targets in modern Chrome (verified empty on 144.0.7559.133),
        //    but Page.getFrameTree always includes them.
        await cdp.send('Page.enable');
        const { frameTree } = await cdp.send('Page.getFrameTree');
        const childFrames = collectChildFrames(frameTree);

        for (const frame of childFrames) {
            triedFrames.push(frame.url || `<frame id=${frame.id}>`);
            let executionContextId;
            try {
                const iw = await cdp.send('Page.createIsolatedWorld', {
                    frameId: frame.id,
                    worldName: ISOLATED_WORLD_NAME,
                });
                executionContextId = iw.executionContextId;
            } catch {
                // Frame may have detached/navigated between getFrameTree and
                // createIsolatedWorld. Skip and continue.
                continue;
            }
            if (await tryFillInContext(cdp, executionContextId)) {
                return done(socket, timeout, 0);
            }
        }

        // 3) Not present in top doc or any reachable frame — structured error.
        clearTimeout(timeout);
        const tried = triedFrames.map(f => `  - ${f}`).join('\n');
        console.error(`Element not found in any frame.\nselector: ${selector}\ntried:\n${tried}`);
        try { socket.close(); } catch { /* */ }
        process.exit(1);
    } catch (err) {
        clearTimeout(timeout);
        try { socket.terminate(); } catch { /* */ }
        throw err;
    }
}

function done(socket, timeout, code) {
    clearTimeout(timeout);
    console.log('OK');
    try { socket.close(); } catch { /* */ }
    process.exit(code);
}

// Flatten frameTree into the list of non-root frames in DFS order.
function collectChildFrames(node, out = [], depth = 0) {
    if (depth > 0) out.push(node.frame);
    for (const child of node.childFrames || []) collectChildFrames(child, out, depth + 1);
    return out;
}

function fetchTopLevelTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json', (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Failed to parse CDP targets: ' + e.message)); }
            });
        }).on('error', (e) => reject(new Error('Failed to connect to CDP: ' + e.message)));
    });
}

function connectWS(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

// Minimal promise-based CDP wrapper. Routes responses by `id`.
function wrapCdp(socket) {
    let nextId = 1;
    const pending = new Map();
    socket.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
            else resolve(msg.result);
        }
    });
    return {
        send(method, params) {
            return new Promise((resolve, reject) => {
                const id = nextId++;
                pending.set(id, { resolve, reject });
                const payload = { id, method };
                if (params !== undefined) payload.params = params;
                socket.send(JSON.stringify(payload));
            });
        },
    };
}

async function tryFillTopDoc(cdp) {
    const expression = buildFillExpression();
    let result;
    try {
        result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
    } catch {
        return false;
    }
    return result && result.result && result.result.value === 'ok';
}

async function tryFillInContext(cdp, contextId) {
    const expression = buildFillExpression();
    let result;
    try {
        result = await cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true });
    } catch {
        return false;
    }
    return result && result.result && result.result.value === 'ok';
}

function buildFillExpression() {
    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedPassword = password.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
        (function() {
            const el = document.querySelector('${escapedSelector}');
            if (!el) return 'not_found';
            el.focus();
            el.value = '${escapedPassword}';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return 'ok';
        })()
    `;
}
