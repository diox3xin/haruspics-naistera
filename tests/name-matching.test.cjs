const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('const NAME_IGNORED_WORDS');
const end = source.indexOf('function getNpcAliases', start);
assert.ok(start >= 0 && end > start, 'name matching block must exist');
const context = vm.createContext({});
vm.runInContext(`${source.slice(start, end)}\nglobalThis.match = namesAppearInPrompt; globalThis.decode = decodeNumericEntities;`, context);

test('Cyrillic names match with Unicode boundaries and case endings', () => {
    assert.equal(context.match(['Ева Гринёва'], 'Витя смотрит на Еву у подъезда'), true);
    assert.equal(context.match(['Ева'], 'Евангелие на столе'), false);
});

test('Cyrillic names are also found in Latin transliteration', () => {
    assert.equal(context.match(['Виктор Громов'], 'Close-up of Viktor in a brown jacket'), true);
    assert.equal(context.match(['Виктор Громов'], 'Gromov lights a cigarette'), true);
    assert.equal(context.match(['Тихонов'], 'Major Tikhonov stands by the car'), true);
});

test('aliases and separate words of a full name count, titles and placeholders do not', () => {
    assert.equal(context.match(['Cyril', 'Lord Sorel'], 'Sorel smiles coldly'), true);
    assert.equal(context.match(['Lord Sorel'], 'the Lord of the manor'), false);
    assert.equal(context.match(['user'], 'the user is typing'), false);
    assert.equal(context.match(['Lapin'], 'Lapinsky enters'), false);
});

test('names inside numeric HTML entities are found', () => {
    const encoded = [...'Лапин'].map(ch => `&#${ch.codePointAt(0)};`).join('');
    assert.equal(context.decode(encoded), 'Лапин');
    assert.equal(context.match(['Лапин'], `Captain ${encoded} at the desk`), true);
});
