const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('const FAQ_HINTS');
const end = source.indexOf('let activeFaqSection', start);
assert.ok(start >= 0 && end > start, 'FAQ_HINTS must exist');

const context = vm.createContext({});
vm.runInContext(source.slice(start, end).replace('const FAQ_HINTS', 'globalThis.FAQ_HINTS'), context);
const hints = context.FAQ_HINTS;

test('every FAQ section matches a settings section', () => {
    for (const sectionId of Object.keys(hints)) {
        assert.ok(source.includes(`data-section-id="${sectionId}"`), `missing section ${sectionId}`);
    }
});

test('every FAQ selector points to an existing control id', () => {
    for (const [sectionId, entries] of Object.entries(hints)) {
        for (const selector of Object.keys(entries)) {
            if (selector === '_section') continue;
            const id = selector.replace(/^#/, '');
            assert.ok(source.includes(`id="${id}"`), `${sectionId}: missing control ${selector}`);
        }
    }
});

test('FAQ is wired into settings init and uses stopPropagation on the button', () => {
    assert.match(source, /initCollapsibleSections\(\);\s*initFaqButtons\(\);/);
    const init = source.slice(source.indexOf('function initFaqButtons('), source.indexOf('// COLLAPSIBLE SECTIONS'));
    assert.match(init, /event\.stopPropagation\(\)/);
    assert.match(init, /key === 'Escape'/);
});
