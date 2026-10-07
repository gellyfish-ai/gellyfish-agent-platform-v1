'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideRedaction } = require('../safe-snapshot.js');

// Predicate covers four password signals — see GAP#654 for the threat model.
// All inputs are stripped of `value` before redaction; only the *decision*
// is tested here, not the snapshot output.

test('redacts <input type="password"> (baseline regression)', () => {
    assert.equal(decideRedaction({
        type: 'password',
        autocomplete: '',
        computedTextSecurity: 'none',
        matchesRecentFill: false,
    }), true);
});

test('redacts CSS-masked input (idmsa.apple.com pattern)', () => {
    // type=text with -webkit-text-security: disc — the leak this PR exists for
    assert.equal(decideRedaction({
        type: 'text',
        autocomplete: '',
        computedTextSecurity: 'disc',
        matchesRecentFill: false,
    }), true);
});

test('redacts CSS-masked input regardless of mask glyph (circle, square)', () => {
    for (const glyph of ['circle', 'square', 'disc']) {
        assert.equal(decideRedaction({
            type: 'text',
            autocomplete: '',
            computedTextSecurity: glyph,
            matchesRecentFill: false,
        }), true, `glyph=${glyph} should redact`);
    }
});

test('redacts input with autocomplete=current-password (X.com pattern)', () => {
    assert.equal(decideRedaction({
        type: 'text',
        autocomplete: 'current-password',
        computedTextSecurity: 'none',
        matchesRecentFill: false,
    }), true);
});

test('redacts input with autocomplete=new-password (signup flows)', () => {
    assert.equal(decideRedaction({
        type: 'text',
        autocomplete: 'new-password',
        computedTextSecurity: 'none',
        matchesRecentFill: false,
    }), true);
});

test('redacts input matching recent fill (selector + host)', () => {
    assert.equal(decideRedaction({
        type: 'text',
        autocomplete: '',
        computedTextSecurity: 'none',
        matchesRecentFill: true,
    }), true);
});

test('does NOT redact a plain text field', () => {
    assert.equal(decideRedaction({
        type: 'text',
        autocomplete: '',
        computedTextSecurity: 'none',
        matchesRecentFill: false,
    }), false);
});

test('does NOT redact email/search/tel inputs without other signals', () => {
    for (const t of ['email', 'search', 'tel', 'url', 'number']) {
        assert.equal(decideRedaction({
            type: t,
            autocomplete: '',
            computedTextSecurity: 'none',
            matchesRecentFill: false,
        }), false, `type=${t} should not redact without other signals`);
    }
});

test('does NOT redact for unrelated autocomplete tokens', () => {
    for (const ac of ['username', 'email', 'name', 'one-time-code', '']) {
        assert.equal(decideRedaction({
            type: 'text',
            autocomplete: ac,
            computedTextSecurity: 'none',
            matchesRecentFill: false,
        }), false, `autocomplete=${ac} should not redact alone`);
    }
});

test('treats empty/none/missing computedTextSecurity as not-masked', () => {
    for (const v of ['', 'none', undefined, null]) {
        assert.equal(decideRedaction({
            type: 'text',
            autocomplete: '',
            computedTextSecurity: v,
            matchesRecentFill: false,
        }), false, `computedTextSecurity=${String(v)} should not redact alone`);
    }
});

test('returns false for nullish info (defensive)', () => {
    assert.equal(decideRedaction(null), false);
    assert.equal(decideRedaction(undefined), false);
});
