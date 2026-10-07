#!/usr/bin/env node
// Secure mobile password filler - types password into iPhone via WebDriverAgent
// Usage: SECRET_VALUE=xxx node fill-mobile-password.js <x> <y> <device-udid>
// Password passed via environment variable, never as argument
// Taps the field at (x,y) then types the password via WDA

const http = require('http');

const x = parseInt(process.argv[2]);
const y = parseInt(process.argv[3]);
const udid = process.argv[4] || '';
const password = process.env.SECRET_VALUE;
const wdaPort = process.env.WDA_PORT || '8100';

if (isNaN(x) || isNaN(y)) {
    console.error('Usage: SECRET_VALUE=xxx node fill-mobile-password.js <x> <y> [device-udid]');
    process.exit(1);
}

if (!password) {
    console.error('No password in SECRET_VALUE environment variable');
    process.exit(1);
}

function wdaRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'localhost',
            port: parseInt(wdaPort),
            path: path,
            method: method,
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000,
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse WDA response: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('WDA request timeout')); });

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function main() {
    try {
        // 1. Get or create WDA session
        const status = await wdaRequest('GET', '/status');
        if (!status.value || !status.value.ready) {
            console.error('WDA is not ready');
            process.exit(1);
        }

        let sessionId = status.sessionId;
        if (!sessionId) {
            const session = await wdaRequest('POST', '/session', { capabilities: { alwaysMatch: {} } });
            sessionId = session.value?.sessionId || session.sessionId;
        }

        if (!sessionId) {
            console.error('Could not get WDA session');
            process.exit(1);
        }

        // 2. Tap the password field at (x, y)
        await wdaRequest('POST', `/session/${sessionId}/wda/tap/0`, { x, y });

        // Wait for keyboard to appear
        await new Promise(r => setTimeout(r, 500));

        // 3. Clear any existing text using triple-tap to select all, then delete
        // WDA control key codes (U+E000-U+E05D) are NOT supported by /wda/keys
        // on iOS — they get typed as literal text. Use tap-based selection instead.

        // Triple-tap to select all text in the field
        for (let i = 0; i < 3; i++) {
            await wdaRequest('POST', `/session/${sessionId}/wda/tap/0`, { x, y });
            await new Promise(r => setTimeout(r, 50));
        }
        await new Promise(r => setTimeout(r, 300));

        // Type a single character to replace any selected text, then delete it
        // This effectively clears the field
        await wdaRequest('POST', `/session/${sessionId}/wda/keys`, {
            value: [' '],
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 100));
        await wdaRequest('POST', `/session/${sessionId}/wda/keys`, {
            value: ['\b'],  // Backspace (actual character, not WDA control code)
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 100));

        // 4. Type the password character by character via WDA
        // Filter out any WDA control codes (U+E000-U+E05D) to prevent
        // them from being typed as literal text
        const chars = password.split('').filter(c => {
            const code = c.charCodeAt(0);
            return code < 0xE000 || code > 0xE05D;
        });
        await wdaRequest('POST', `/session/${sessionId}/wda/keys`, {
            value: chars,
        });

        console.log('OK');
        process.exit(0);
    } catch (e) {
        console.error('Mobile fill failed:', e.message);
        process.exit(1);
    }
}

main();
