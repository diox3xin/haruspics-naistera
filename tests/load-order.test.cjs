const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const lines = source.split(/\r?\n/);

// init() runs immediately; any top-level let/const declared after it is in the
// temporal dead zone and crashes the whole extension on load.
test('init IIFE comes after every top-level let/const', () => {
    const initLine = lines.findIndex(line => line.startsWith('(function init()'));
    assert.ok(initLine >= 0, 'init IIFE not found');
    const lateDeclarations = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line, index }) => index > initLine && /^(let|const|class) /.test(line));
    assert.deepEqual(lateDeclarations.map(d => `${d.index + 1}: ${d.line}`), []);
});

test('profiles are re-rendered when the chat changes', () => {
    const start = source.indexOf('event_types.CHAT_CHANGED');
    const block = source.slice(start, source.indexOf('});', source.indexOf('}, 100);', start)));
    assert.match(block, /renderCharacterProfiles\(\)/);
});

test('wardrobe theme feature is fully removed', () => {
    assert.doesNotMatch(source, /wardrobeTheme|applyWardrobeTheme|wardrobe_theme/);
});
