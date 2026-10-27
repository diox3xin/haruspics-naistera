const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function grab(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
}

function grabConst(name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    return source.slice(start, source.indexOf(';', start) + 1);
}

const context = vm.createContext({});
vm.runInContext([
    grabConst('NAME_VARIANTS_MAX'),
    source.slice(source.indexOf('const NAME_IGNORED_WORDS'), source.indexOf(']);', source.indexOf('const NAME_IGNORED_WORDS')) + 3),
    grab('splitNameList'),
    grab('buildNameVariantsRequest'),
    grab('parseGeneratedNameList'),
    'globalThis.request = buildNameVariantsRequest; globalThis.parse = parseGeneratedNameList;',
].join('\n'), context);

test('the request names the person, the known variants and both scripts', () => {
    const text = context.request('Иван Петров', ['Ваня'], 'Друзья зовут его Ванюша');
    assert.match(text, /Character name: Иван Петров/);
    assert.match(text, /Already known variants: Ваня/);
    assert.match(text, /Latin/);
    assert.match(text, /Cyrillic/);
    assert.match(text, /Ванюша/);
    assert.doesNotMatch(text, /\n\n\n/);
});

test('the request skips empty sections', () => {
    const text = context.request('Novak', [], '');
    assert.doesNotMatch(text, /Already known|Character notes/);
});

test('a plain comma list is merged after existing names without duplicates or the main name', () => {
    const names = context.parse('Ivan Petrov, Ivan, Petrov, Иван, Петров, Vanya, Ваня, ivan', ['Ваня'], 'Иван Петров');
    assert.deepEqual([...names], ['Ваня', 'Ivan Petrov', 'Ivan', 'Petrov', 'Иван', 'Петров', 'Vanya']);
});

test('chatter, numbering, quotes, think blocks and generic words are dropped', () => {
    const answer = '<think>the user wants names</think>\nHere are the variants:\n```\n1. "Eveline Greenwell", «Эвелин», Eveline, girl, Evie.\n```';
    const names = context.parse(answer, [], 'Эвелин Гринвелл');
    assert.deepEqual([...names], ['Eveline Greenwell', 'Эвелин', 'Eveline', 'Evie']);
});

test('the list is capped', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Name${String.fromCharCode(65 + (i % 26))}${i}`).join(', ');
    assert.equal(context.parse(many, [], 'X').length, 20);
});
