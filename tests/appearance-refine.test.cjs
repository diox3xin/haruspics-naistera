const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

function grab(name) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} must exist`);
    const end = source.slice(start).search(/\r?\n\}\r?\n/);
    return source.slice(start, start + end + source.slice(start + end).indexOf('}') + 1);
}
function grabConst(name) {
    const start = source.indexOf(`const ${name} =`);
    assert.ok(start >= 0, `${name} must exist`);
    return source.slice(start, source.indexOf(';\r\n', start) + 1);
}

let chat = [];
const context = vm.createContext({ SillyTavern: { getContext: () => ({ chat }) } });
vm.runInContext([
    grabConst('NOT_A_FRESH_REPLY'), grab('isFreshBotReply'),
    grabConst('REFINE_FORBIDDEN_TAG'), grab('cleanRefinedAppearance'), grab('buildAppearanceRefineRequest'),
].join('\n'), context);

test('«Авто» skips the greeting and messages that were not generated as a reply', () => {
    chat = [{ name: 'Novak', mes: 'Greeting' }];
    assert.equal(context.isFreshBotReply(0, 'first_message'), false);
    assert.equal(context.isFreshBotReply(0, undefined), false, 'greeting without a type (older SillyTavern)');
    chat.push({ is_user: true, mes: 'Hi' }, { name: 'Novak', mes: 'Reply' });
    assert.equal(context.isFreshBotReply(2, 'normal'), true);
    assert.equal(context.isFreshBotReply(2, 'swipe'), true);
    assert.equal(context.isFreshBotReply(2, undefined), true);
    assert.equal(context.isFreshBotReply(2, 'command'), false);
    assert.equal(context.isFreshBotReply(2, 'extension'), false);
    assert.equal(context.isFreshBotReply(1, 'normal'), false, 'user message');
});

test('the refined answer becomes one clean NovelAI tag line and weight groups stay whole', () => {
    const answer = 'Tags:\n```\nAdult, Pale_Skin, 1.3::Pastel Pink Hair, single white streak::, long hair, pale skin,\n2.4::long fingernails, pink nails::, white tattoo.\n```';
    assert.equal(context.cleanRefinedAppearance(answer),
        'adult, pale skin, 1.3::pastel pink hair, single white streak::, long hair, 1.6::long fingernails, pink nails::, white tattoo');
});

test('a plain tag that repeats a weighted one is dropped; child tags never pass', () => {
    assert.equal(context.cleanRefinedAppearance('1.2::white eyelashes::, white eyelashes, loli, child, young adult, baby pink hair'),
        '1.2::white eyelashes::, young adult, baby pink hair');
});

test('the request keeps the current tags, the wishes and the NovelAI rules', () => {
    const request = context.buildAppearanceRefineRequest('pink hair, tattoo', 'волосы пастельнее, одна белая прядь');
    assert.match(request, /<current_appearance>\npink hair, tattoo\n<\/current_appearance>/);
    assert.match(request, /волосы пастельнее/);
    assert.match(request, /1\.2::tag, tag::/);
    assert.match(request, /REPLACE the old tag/);
    assert.match(request, /adult/);
});

test('profile cards have «Уточнить внешность» and the card checkbox under «Описать по аватарке»', () => {
    const card = source.slice(source.indexOf('function profileCardHtml('), source.indexOf('function rpgCharactersHtml('));
    assert.match(card, /class="menu_button iig-profile-refine"/);
    assert.match(card, /class="iig-profile-use-card-input"/);
    assert.ok(card.indexOf('iig-profile-describe"') < card.indexOf('iig-profile-use-card-input'), 'checkbox goes under the describe button');
    const top = source.slice(source.indexOf('<div class="iig-profiles-describe-settings">'), source.indexOf('profileCardHtml(\'char\''));
    assert.doesNotMatch(top, /iig-profile-use-card-input/, 'no longer in the top block');
    assert.match(source, /button\.disabled = empty \|\| !novelAI;/);
    assert.match(source, /isFreshBotReply\(messageId, type\)/);
});
