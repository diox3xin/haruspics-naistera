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

const settings = { wardrobeAutoDescribe: true, wardrobeDescModel: 'vision', wardrobeItems: [] };
const described = [];
const toasts = [];
const context = vm.createContext({
    getSettings: () => settings,
    saveSettings: () => {},
    iigLog: () => {},
    renderQuickWardrobeList: () => {},
    renderWardrobeGrid: () => {},
    generateWardrobeDescription: async id => {
        if (id === 'bad') throw new Error('boom');
        return `desc ${id}`;
    },
    updateWardrobeItemDescription: (id, text) => described.push([id, text]),
    toastr: {
        success: text => toasts.push(['success', text]),
        error: text => toasts.push(['error', text]),
        warning: text => toasts.push(['warning', text]),
    },
});
vm.runInContext(
    section('function normalizeWardrobeTags(', '// ============================================================\n// HAIRSTYLE SYSTEM'.replace(/\n/g, source.includes('\r\n') ? '\r\n' : '\n'))
    + section('function filterWardrobeItems(', 'function bindWardrobeToolbar('),
    context,
);

test('tags: trimmed, split by comma / semicolon / line, «#» dropped, no case duplicates', () => {
    assert.deepEqual(Array.from(context.normalizeWardrobeTags(' лето, #Casual;casual\nвечернее ,, ')), ['лето', 'Casual', 'вечернее']);
    assert.deepEqual(Array.from(context.normalizeWardrobeTags('')), []);
    assert.equal(context.normalizeWardrobeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20);
});

test('all tags of a tab, each once, sorted; legacy items without tags are fine', () => {
    const items = [{ tags: ['лето', 'Casual'] }, { tags: ['casual', 'зима'] }, {}];
    // Russian collation: Cyrillic first, then Latin.
    assert.deepEqual(Array.from(context.collectWardrobeTags(items)), ['зима', 'лето', 'Casual']);
});

test('filter by tag (case-insensitive) and search finds tags, «#tag» too', () => {
    const items = [
        { id: 'a', name: 'Coat', tags: ['зима'] },
        { id: 'b', name: 'Shorts', tags: ['лето', 'casual'] },
        { id: 'c', name: 'Old dress' },
    ];
    const ids = filter => Array.from(context.filterWardrobeItems(items, { category: 'all', search: '', tag: '', ...filter }), i => i.id);
    assert.deepEqual(ids({ tag: 'ЗИМА' }), ['a']);
    assert.deepEqual(ids({ search: 'cas' }), ['b']);
    assert.deepEqual(ids({ search: '#лето' }), ['b']);
    assert.deepEqual(ids({}), ['a', 'b', 'c']);
});

test('«Авто» describes the added outfits one by one; an error does not stop the rest', async () => {
    settings.wardrobeItems = [{ id: 'x', name: 'X', imageData: 'AAA' }, { id: 'bad', name: 'Bad', imageData: 'AAA' }, { id: 'y', name: 'Y', imageData: 'AAA' }];
    described.length = 0;
    const done = await context.autoDescribeWardrobeItems(settings.wardrobeItems);
    assert.equal(done, 2);
    assert.deepEqual(described, [['x', 'desc x'], ['y', 'desc y']]);
    assert.ok(toasts.some(([kind, text]) => kind === 'error' && /Bad/.test(text)));
    assert.equal(vm.runInContext('wardrobeDescribing.size', context), 0);
});

test('«Авто» off, no model, or text-only outfits: nothing is sent', async () => {
    described.length = 0;
    settings.wardrobeAutoDescribe = false;
    assert.equal(await context.autoDescribeWardrobeItems(settings.wardrobeItems), 0);
    settings.wardrobeAutoDescribe = true;
    assert.equal(await context.autoDescribeWardrobeItems([{ id: 't', name: 'Text only', imageData: null }]), 0);
    settings.wardrobeDescModel = '';
    assert.equal(await context.autoDescribeWardrobeItems(settings.wardrobeItems), 0);
    assert.ok(toasts.some(([kind]) => kind === 'warning'));
    assert.equal(described.length, 0);
    settings.wardrobeDescModel = 'vision';
});

test('several pictures at once: file inputs take multiple, uploads loop over all files', () => {
    assert.match(source, /<input type="file" class="iig-wardrobe-add-file" accept="image\/\*" multiple hidden>/);
    assert.match(source, /<input type="file" id="iig_wardrobe_char_file" accept="image\/\*" multiple/);
    assert.match(source, /<input type="file" id="iig_wardrobe_user_file" accept="image\/\*" multiple/);
    const add = section('function bindWardrobeAdd(', 'function filterWardrobeItems(');
    assert.match(add, /for \(const file of files\)/);
    assert.match(add, /autoDescribeWardrobeItems\(added\)/);
    const upload = section('function bindReferenceUpload(', 'function renderWardrobeGrid(');
    assert.match(upload, /for \(const file of files\)/);
    assert.match(upload, /if \(kind === 'wardrobe'\) autoDescribeWardrobeItems\(added\)/);
});

test('toolbar has «Авто» and «Теги» switches; tags show on cards only when visible', () => {
    const list = section('function renderQuickWardrobeList(', 'function bindWardrobeKindSwitch(');
    assert.match(list, /iig-wardrobe-auto/);
    assert.match(list, /iig-wardrobe-tags-toggle/);
    assert.match(list, /tagsVisible && allTags\.length/);
    assert.match(list, /tagsVisible && getWardrobeTags\(item\)\.length/);
    assert.match(list, /iig-wardrobe-tags-input/);
});
