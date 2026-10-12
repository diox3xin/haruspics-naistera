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
// Single top-level function: from its signature to the first closing brace at column 0.
const fn = signature => {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, `missing ${signature}`);
    const end = source.indexOf('\n}', start);
    return source.slice(start, end + 2);
};

function makeContext(settings, profile) {
    const calls = { saved: 0, injected: 0 };
    const context = vm.createContext({
        getSettings: () => settings,
        saveSettings: () => { calls.saved++; },
        updateWardrobeInjection: () => { calls.injected++; },
        getCharacterProfile: () => profile,
        getCurrentCharacterLibraryKey: () => 'avatar:bot.png',
        migrateOldCharacterLibrary: () => {},
        SillyTavern: { getContext: () => ({}) },
        nameAppearsInPrompt: (name, prompt) => prompt.toLowerCase().includes(name.toLowerCase()),
        detectMimeType: () => 'image/png',
    });
    vm.runInContext(
        section('// Wardrobe targets:', '/** RPG characters of the current bot') +
        fn('function getCurrentRpgWardrobeTargets(') + '\n' +
        section('async function collectRpgCharacterReferences(', 'function getCharacterLibraryKey('),
        context,
    );
    return { context, calls };
}

const baseSettings = () => ({
    activeWardrobeChar: 'c1',
    activeWardrobeUser: null,
    activeWardrobeRpg: {},
    wardrobeItems: [
        { id: 'c1', target: 'char', name: 'Bot coat', description: 'coat' },
        { id: 'r1', target: 'rpg:alice', name: 'Armor', description: 'steel armor' },
        { id: 'r2', target: 'rpg:alice', name: 'Robe', description: 'blue robe' },
    ],
});
const profile = {
    rpgMode: true,
    rpgCharacters: [
        { id: 'alice', name: 'Alice', appearance: 'red hair' },
        { id: 'bob', name: 'Bob', appearance: '' },
        { id: 'nameless', name: '  ' },
    ],
};

test('RPG targets are listed only for named characters with RPG mode on', () => {
    const { context } = makeContext(baseSettings(), profile);
    assert.deepEqual(Array.from(context.getCurrentRpgWardrobeTargets(), t => t.target), ['rpg:alice', 'rpg:bob']);
    const off = makeContext(baseSettings(), { ...profile, rpgMode: false });
    assert.equal(off.context.getCurrentRpgWardrobeTargets().length, 0);
});

test('setActiveWardrobe toggles per RPG character without touching bot/user', () => {
    const settings = baseSettings();
    const { context } = makeContext(settings, profile);
    context.setActiveWardrobe('r1', 'rpg:alice');
    assert.equal(settings.activeWardrobeRpg.alice, 'r1');
    assert.equal(settings.activeWardrobeChar, 'c1');
    assert.equal(context.getActiveWardrobeItem('rpg:alice').name, 'Armor');
    assert.equal(context.getActiveWardrobeItem('rpg:bob'), null);

    context.setActiveWardrobe('r2', 'rpg:alice');
    assert.equal(settings.activeWardrobeRpg.alice, 'r2');
    context.setActiveWardrobe('r2', 'rpg:alice'); // same id again = take off
    assert.equal('alice' in settings.activeWardrobeRpg, false);
});

test('removeWardrobeItem clears RPG active outfit', () => {
    const settings = baseSettings();
    settings.activeWardrobeRpg.alice = 'r1';
    const { context } = makeContext(settings, profile);
    context.removeWardrobeItem('r1');
    assert.equal('alice' in settings.activeWardrobeRpg, false);
    assert.equal(settings.wardrobeItems.some(i => i.id === 'r1'), false);
});

test('collector returns outfits only for RPG characters named in the prompt', async () => {
    const settings = baseSettings();
    settings.activeWardrobeRpg.alice = 'r1';
    const { context } = makeContext(settings, profile);
    const hit = await context.collectRpgCharacterReferences('Alice walks into the forest', settings);
    assert.deepEqual(Array.from(hit.outfits, o => `${o.name}:${o.outfit.id}`), ['Alice:r1']);
    const miss = await context.collectRpgCharacterReferences('Bob is alone', settings);
    assert.equal(miss.outfits.length, 0);
});

test('reference generator can save into an RPG wardrobe', () => {
    assert.match(source, /state\.target === 'user' \|\| isRpgWardrobeTarget\(state\.target\) \? state\.target : 'char'/);
});
