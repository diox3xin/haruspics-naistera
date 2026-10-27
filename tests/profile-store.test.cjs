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
    for (let i = source.indexOf(') {', start) + 2; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
    }
    throw new Error(`unterminated ${name}`);
}

const settings = {};
const context = vm.createContext({ getSettings: () => settings });
vm.runInContext(`${grab('makeCharacterProfile')}\n${grab('getCharacterProfile')}\nglobalThis.get = getCharacterProfile;`, context);

test('edits made through an earlier reference survive later lookups', () => {
    const shown = context.get('char', 'avatar:Novak.png', settings, true);
    context.get('char', 'avatar:Novak.png', settings);
    shown.aliases = 'Novak, Новак';
    shown.appearance = 'grey eyes';
    const again = context.get('char', 'avatar:Novak.png', settings);
    assert.equal(again, shown);
    assert.equal(settings.characterProfiles.characters['avatar:Novak.png'].aliases, 'Novak, Новак');
    assert.equal(again.appearance, 'grey eyes');
});

test('old stored profiles still get normalized', () => {
    settings.characterProfiles.users['avatar:old.png'] = { aliases: '  Ivan ', avatarSource: 'weird' };
    const profile = context.get('user', 'avatar:old.png', settings);
    assert.equal(profile.aliases, 'Ivan');
    assert.equal(profile.avatarSource, 'card');
    assert.deepEqual([...profile.rpgCharacters], []);
});
