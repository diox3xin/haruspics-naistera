const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('function buildIdentityFromRefsDirective(');
assert.ok(start >= 0, 'buildIdentityFromRefsDirective must exist');
let depth = 0, end = -1;
for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) { end = i + 1; break; }
}
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}\nglobalThis.build = buildIdentityFromRefsDirective;`, context);

test('names come from face refs and appearance notes', () => {
    const rule = context.build(
        [{ type: 'face', name: 'Viktor' }, { type: 'clothing', name: 'Viktor' }],
        ['[CHARACTER APPEARANCE for "Lapin"]: glasses', '[USER APPEARANCE]: caramel hair', '[HAIRSTYLE INSTRUCTION for "Eva"]: bun'],
    );
    assert.match(rule, /^\[IDENTITY RULE\]/);
    assert.match(rule, /"Viktor"/);
    assert.match(rule, /"Lapin"/);
    assert.match(rule, /"the user"/);
    assert.doesNotMatch(rule, /"Eva"/);
});

test('no references and no appearance notes → no rule', () => {
    assert.equal(context.build([], ['[CLOTHING INSTRUCTION for "X"]: coat']), '');
});

test('the setting is in the defaults and bound in the UI', () => {
    assert.ok(source.includes('identityFromRefsOnly: false'));
    assert.ok(source.includes('id="iig_identity_refs_only"'));
    assert.ok(source.includes("getElementById('iig_identity_refs_only')"));
});
