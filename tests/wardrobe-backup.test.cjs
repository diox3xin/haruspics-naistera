const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
function grab(name, prefix = 'function') {
    const start = source.indexOf(`${prefix} ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}
function grabConst(name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/;\r?\n/);
    return source.slice(start, start + end + 1);
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let settings;
let saves = 0;
let migrations = 0;
const context = vm.createContext({
    getSettings: () => settings,
    saveSettings: () => { saves++; },
    migrateWardrobeImagesToFiles: async () => { migrations++; },
    ensureWardrobeImagesLoaded: async () => {},
    updateWardrobeInjection: () => {},
    REF_GEN_FLAG_DEFAULTS: { ignoreTattoos: false, bodyFromDescription: false },
});
vm.runInContext([
    grabConst('WARDROBE_CATEGORIES'), grabConst('WARDROBE_SORTS'), grabConst('WARDROBE_EXPORT_FORMAT'),
    'const WARDROBE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;',
    grab('normalizeWardrobeTags'), grab('getWardrobeTags'), grab('normalizeRefGenFlags'),
    grab('getWardrobeImageItems'), grab('isRpgWardrobeTarget'), grab('getActiveWardrobeId'), grab('setActiveWardrobe'),
    grab('filterWardrobeItems'), grab('sortWardrobeItems'),
    grab('buildWardrobeExport', 'async function'), grab('sanitizeImportedWardrobeItem'), grab('importWardrobeFromFile', 'async function'),
].join('\n'), context);

const ids = list => Array.from(list, item => item.id);
const fileOf = obj => ({ text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)) });

test('favourites go first in every order; «recent» and «name» sort the rest', () => {
    const items = [
        { id: 'a', name: 'Пальто', lastWornAt: 10 },
        { id: 'b', name: 'брюки', lastWornAt: 30 },
        { id: 'c', name: 'Аляска', favorite: true },
        { id: 'd', name: 'Юбка 10', lastWornAt: 20 },
        { id: 'e', name: 'Юбка 2' },
    ];
    assert.deepEqual(ids(context.sortWardrobeItems(items, 'added')), ['c', 'a', 'b', 'd', 'e']);
    assert.deepEqual(ids(context.sortWardrobeItems(items, 'recent')), ['c', 'b', 'd', 'a', 'e']);
    assert.deepEqual(ids(context.sortWardrobeItems(items, 'name')), ['c', 'b', 'a', 'e', 'd']);
    assert.deepEqual(ids(items), ['a', 'b', 'c', 'd', 'e'], 'the wardrobe itself is not reordered');
});

test('«Только избранные» filter', () => {
    const items = [{ id: 'a', name: 'x' }, { id: 'b', name: 'y', favorite: true }];
    assert.deepEqual(ids(context.filterWardrobeItems(items, { category: 'all', search: '', tag: '', favOnly: true })), ['b']);
    assert.deepEqual(ids(context.filterWardrobeItems(items, { category: 'all', search: '', tag: '' })), ['a', 'b']);
});

test('putting an outfit on remembers when; taking it off does not', () => {
    settings = { wardrobeItems: [{ id: 'a', target: 'char' }], activeWardrobeChar: null, activeWardrobeRpg: {} };
    context.setActiveWardrobe('a', 'char');
    const worn = settings.wardrobeItems[0].lastWornAt;
    assert.ok(worn > 0);
    settings.wardrobeItems[0].lastWornAt = 5;
    context.setActiveWardrobe('a', 'char'); // take off
    assert.equal(settings.activeWardrobeChar, null);
    assert.equal(settings.wardrobeItems[0].lastWornAt, 5);
});

test('export holds the pictures, not file paths; import of it restores the same wardrobe', async () => {
    const outfit = { id: 'ward_1', name: 'Рубашка', target: 'char', category: 'top', tags: ['лето'], favorite: true, description: 'striped shirt', imageFile: '/user/images/haruspics-wardrobe/ward_1.png' };
    Object.defineProperty(outfit, 'imageData', { value: PNG, writable: true, enumerable: false, configurable: true });
    settings = {
        wardrobeItems: [outfit, { id: 'ward_2', name: 'Текст', target: 'rpg:rpg_1_abc', imageData: null, description: 'red dress', category: 'full', tags: [] }],
        hairstyleItems: [{ id: 'hair_1', name: 'Коса', target: 'user', imageData: PNG, description: '' }],
    };
    const { data, missing } = await context.buildWardrobeExport();
    assert.equal(missing, 0);
    const text = JSON.stringify(data);
    assert.doesNotMatch(text, /imageFile|haruspics-wardrobe\/ward_1/);
    assert.equal(data.wardrobeItems[0].imageData, PNG);

    settings = { wardrobeItems: [], hairstyleItems: [] };
    saves = 0; migrations = 0;
    const result = await context.importWardrobeFromFile(fileOf(text));
    assert.deepEqual({ ...result }, { added: 3, skipped: 0, invalid: 0 });
    assert.equal(settings.wardrobeItems[0].imageData, PNG);
    assert.equal(settings.wardrobeItems[0].favorite, true);
    assert.deepEqual(Array.from(settings.wardrobeItems[0].tags), ['лето']);
    assert.equal(settings.wardrobeItems[1].target, 'rpg:rpg_1_abc');
    assert.equal(settings.hairstyleItems[0].name, 'Коса');
    assert.equal(saves, 1);
    assert.equal(migrations, 1, 'pictures are then moved into files');

    const again = await context.importWardrobeFromFile(fileOf(text));
    assert.deepEqual({ ...again }, { added: 0, skipped: 3, invalid: 0 }, 'same backup twice adds nothing');
    assert.equal(settings.wardrobeItems.length, 2);
});

test('import refuses other files and drops broken or dangerous items', async () => {
    settings = { wardrobeItems: [], hairstyleItems: [] };
    await assert.rejects(context.importWardrobeFromFile(fileOf('not json')), /не JSON/);
    await assert.rejects(context.importWardrobeFromFile(fileOf({ wardrobeItems: [] })), /не файл экспорта/);
    const result = await context.importWardrobeFromFile(fileOf({
        format: 'haruspics-wardrobe',
        wardrobeItems: [
            { id: 'ok', name: 'Ок', target: 'char', imageData: PNG, category: 'toString', evil: '<script>' },
            { id: 'x1', name: 'Без всего', target: 'char' },
            { id: 'x2', name: 'Плохая цель', target: 'admin', imageData: PNG },
            { id: 'x3', name: 'Не картинка', target: 'char', imageData: 'javascript:alert(1)//aaaaaaaaaaaaa' },
            null,
            { id: '../../etc', name: 'Плохой id', target: 'user', description: 'blue coat' },
        ],
        hairstyleItems: [{ id: 'h', target: 'rpg:1', imageData: PNG }],
    }));
    assert.deepEqual({ ...result }, { added: 2, skipped: 0, invalid: 5 });
    const [ok, renamed] = settings.wardrobeItems;
    assert.equal(ok.category, 'full', 'unknown category falls back');
    assert.equal(ok.evil, undefined, 'unknown fields are not imported');
    assert.match(renamed.id, /^ward_\d+_/, 'unsafe id replaced');
    assert.equal(renamed.description, 'blue coat');
});
