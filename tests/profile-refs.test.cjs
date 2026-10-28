const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

function grab(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    // Top-level functions end with a "}" alone on its line.
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    assert.ok(end > 0, `unterminated ${name}`);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}

function load(stContext, settings = {}) {
    const context = vm.createContext({ getSettings: () => settings, SillyTavern: { getContext: () => stContext } });
    vm.runInContext([
        'makeProfileRefId', 'makeCharacterProfile', 'getCharacterProfile', 'getCharacterLibraryKey', 'getCurrentCharacterLibraryKey',
        'getExtensionPersona', 'getExtensionCharacter', 'fillCardMacros', 'useMainProfileAvatar', 'selectProfileRef', 'removeProfileRef',
    ].map(grab).join('\n'), context);
    return context;
}

test('an old single uploaded ref becomes the first item of the refs list and stays selected', () => {
    const ctx = load({});
    const profile = ctx.makeCharacterProfile({ avatarSource: 'custom', customAvatarData: 'OLDREF' });
    assert.equal(profile.customAvatars.length, 1);
    assert.equal(profile.customAvatars[0].data, 'OLDREF');
    assert.equal(profile.customAvatarId, profile.customAvatars[0].id);
    // normalizing again does not duplicate it
    const again = ctx.makeCharacterProfile(profile);
    assert.equal(again.customAvatars.length, 1);
    assert.equal(again.customAvatarId, profile.customAvatarId);
});

test('refs can be picked, the main avatar switched back on, and a deleted active ref falls back to the main avatar', () => {
    const ctx = load({});
    const profile = ctx.makeCharacterProfile({ customAvatars: [{ id: 'a', name: 'Beach', data: 'AAA' }, { id: 'b', name: 'Coat', data: 'BBB' }] });
    assert.equal(profile.avatarSource, 'card');
    assert.ok(ctx.selectProfileRef(profile, 'b'));
    assert.equal(profile.avatarSource, 'custom');
    assert.equal(profile.customAvatarData, 'BBB');
    ctx.useMainProfileAvatar(profile);
    assert.equal(profile.avatarSource, 'card');
    assert.equal(profile.customAvatars.length, 2, 'uploaded refs stay in the list');
    ctx.selectProfileRef(profile, 'a');
    ctx.removeProfileRef(profile, 'a');
    assert.deepEqual(profile.customAvatars.map(ref => ref.id), ['b']);
    assert.equal(profile.avatarSource, 'card');
    assert.equal(profile.customAvatarData, '');
});

test('a picture taken from another card is not added to the refs list', () => {
    const ctx = load({});
    const profile = ctx.makeCharacterProfile({ avatarSource: 'custom', customAvatarData: 'CARD', pickedCharacter: 'other.png' });
    assert.equal(profile.customAvatars.length, 0);
    assert.equal(profile.pickedCharacter, 'other.png');
});

test('names and card text come from the persona chosen in the extension, not the active one', () => {
    const stContext = {
        name1: 'Ева',
        characters: [{ name: 'Novak', avatar: 'novak.png', description: 'Novak card' }, { name: 'Marta', avatar: 'marta.png', description: '{{char}} has red hair, {{user}} knows her' }],
        characterId: 0,
        powerUserSettings: {
            personas: { 'eva.png': 'Ева', 'eveline.png': 'Эвелин' },
            persona_description: 'active persona text',
            persona_descriptions: { 'eveline.png': { description: 'soft pink hair' } },
        },
    };
    const settings = { userAvatarFile: 'eveline.png' };
    const ctx = load(stContext, settings);
    const persona = ctx.getExtensionPersona(settings);
    assert.equal(persona.name, 'Эвелин');
    assert.equal(persona.description, 'soft pink hair');

    // no persona chosen in the extension → the active one
    assert.equal(ctx.getExtensionPersona({}).name, 'Ева');
    assert.equal(ctx.getExtensionPersona({}).description, 'active persona text');

    // the bot: the chat character, or the card whose picture was picked
    assert.equal(ctx.getExtensionCharacter(settings).name, 'Novak');
    settings.characterProfiles = { characters: { 'avatar:novak.png': { avatarSource: 'custom', customAvatarData: 'X', pickedCharacter: 'marta.png' } }, users: {} };
    const owner = ctx.getExtensionCharacter(settings);
    assert.equal(owner.name, 'Marta');
    assert.equal(owner.picked, true);
    assert.equal(ctx.fillCardMacros(owner.description, settings), 'Marta has red hair, Эвелин knows her');
});

test('the profile card has no «Референс» select; the picker lists own refs with upload', () => {
    assert.doesNotMatch(source, /class="iig-profile-source"/);
    assert.match(source, /class="iig-avatar-ref-file" accept="image\/\*" multiple hidden/);
    assert.match(source, /function profileRefsHtml\(/);
});

test('section hint texts stay hidden until «?» is pressed', () => {
    assert.match(css, /\.iig-settings \.iig-collapsible p\.hint \{ display: none; \}/);
    assert.match(css, /\.iig-collapsible\.iig-hints-open p\.hint \{ display: block; \}/);
    assert.match(source, /section\.classList\.add\('iig-hints-open'\)/);
    assert.match(source, /!FAQ_HINTS\[sectionId\] && !section\.querySelector\('p\.hint'\)/);
});
