const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const section = (from, to) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start + from.length);
    assert.ok(start >= 0 && end > start, `section ${from}`);
    return source.slice(start, end);
};

const context = vm.createContext({});
vm.runInContext(
    section('const WARDROBE_CATEGORIES', 'function addWardrobeItem(').replace('const WARDROBE_CATEGORIES', 'globalThis.WARDROBE_CATEGORIES') +
    section('function filterWardrobeItems(', 'function bindWardrobeToolbar('),
    context,
);

const items = [
    { id: 'a', name: 'Red Coat', description: 'wool', category: 'top' },
    { id: 'b', name: 'Jeans', description: 'blue denim', category: 'bottom' },
    { id: 'c', name: 'Old dress', description: '' }, // legacy item, no category
];

test('no filter returns everything', () => {
    assert.equal(context.filterWardrobeItems(items, { category: 'all', search: '' }).length, 3);
});

test('category filter treats missing category as full', () => {
    assert.deepEqual(Array.from(context.filterWardrobeItems(items, { category: 'full', search: '' }), i => i.id), ['c']);
    assert.deepEqual(Array.from(context.filterWardrobeItems(items, { category: 'top', search: '' }), i => i.id), ['a']);
});

test('search matches name and description, case-insensitive', () => {
    assert.deepEqual(Array.from(context.filterWardrobeItems(items, { category: 'all', search: 'COAT' }), i => i.id), ['a']);
    assert.deepEqual(Array.from(context.filterWardrobeItems(items, { category: 'all', search: 'denim' }), i => i.id), ['b']);
    assert.equal(context.filterWardrobeItems(items, { category: 'top', search: 'denim' }).length, 0);
});

test('categories include full and settings migration adds category', () => {
    assert.ok('full' in context.WARDROBE_CATEGORIES);
    assert.match(source, /if \(!Object\.hasOwn\(item, 'category'\)\) item\.category = 'full';/);
});
