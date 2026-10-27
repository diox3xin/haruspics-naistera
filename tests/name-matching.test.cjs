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
vm.runInContext(`${source.slice(start, end)}\nglobalThis.match = namesAppearInPrompt; globalThis.decode = decodeNumericEntities; globalThis.leads = nameLeadsTagIndex;`, context);

test('Cyrillic names match with Unicode boundaries and case endings', () => {
    assert.equal(context.match(['Ева Гринёва'], 'Ваня смотрит на Еву у подъезда'), true);
    assert.equal(context.match(['Ева'], 'Евангелие на столе'), false);
});

test('Cyrillic names are also found in Latin transliteration', () => {
    assert.equal(context.match(['Иван Петров'], 'Close-up of Ivan in a brown jacket'), true);
    assert.equal(context.match(['Иван Петров'], 'Petrov lights a cigarette'), true);
    assert.equal(context.match(['Орехов'], 'Major Orekhov stands by the car'), true);
});

test('aliases and separate words of a full name count, titles and placeholders do not', () => {
    assert.equal(context.match(['Arthur', 'Lord Ashby'], 'Ashby smiles coldly'), true);
    assert.equal(context.match(['Lord Ashby'], 'the Lord of the manor'), false);
    assert.equal(context.match(['user'], 'the user is typing'), false);
    assert.equal(context.match(['Novak'], 'Novakovsky enters'), false);
});

test('names inside numeric HTML entities are found', () => {
    const encoded = [...'Новак'].map(ch => `&#${ch.codePointAt(0)};`).join('');
    assert.equal(context.decode(encoded), 'Новак');
    assert.equal(context.match(['Новак'], `Captain ${encoded} at the desk`), true);
});

test('transliteration is matched loosely: Evelin → Eveline, v/w, kh/h, ks/x', () => {
    assert.equal(context.match(['Эвелин Гринвелл'], '2girls, Marta and Eveline at a cafe'), true);
    assert.equal(context.match(['Эвелин Гринвелл'], 'Lady Grinwell smiles'), true);
    assert.equal(context.match(['Андрей'], 'Andrei lights a cigarette'), true);
    assert.equal(context.match(['Ксения'], 'Xenia opens the door'), true);
    assert.equal(context.match(['Орехов'], 'Orehov waits'), true);
    assert.equal(context.match(['Эвелин Гринвелл'], 'Evening in the forest'), false);
});

test('a name that is also a word or tag counts only when capitalized', () => {
    const bobby = ['Bobby Novak', 'Bob', 'Bobby'];
    assert.equal(context.match(bobby, '1girl, Marta, pale pink hair, messy bob, bangs'), false);
    assert.equal(context.match(bobby, 'Bob leans on the counter'), true);
    assert.equal(context.match(bobby, 'BOB, close-up'), true);
    assert.equal(context.match(['Ivy'], 'old wall covered in ivy'), false);
    assert.equal(context.match(['Роза'], 'на столе стоит роза'), false);
    assert.equal(context.match(['Роза'], 'Розу зовут к столу'), true);
    assert.equal(context.match(['Bobby Novak'], 'bobby novak, suit'), true);
});

test('a tag that starts with the name marks its owner; "looking at X" does not', () => {
    assert.equal(context.leads(['Eveline'], 'girl, top left focus frame, Marta, looking at Eveline'), -1);
    assert.equal(context.leads(['Eveline'], 'girl, main frame, Eveline, frightened'), 2);
    assert.equal(context.leads(['Эвелин Гринвелл'], 'girl, Eveline smiling, pink hair'), 1);
    assert.equal(context.leads(['Bobby', 'Bob'], 'girl, messy bob, Bob'), 2);
});
