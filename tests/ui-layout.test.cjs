const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');

test('settings tabs go Основное → Персонажи → Промпт и стиль → Гардероб; profiles and avatars are one sub-tab', () => {
    const order = ['Основное', 'Персонажи', 'Промпт и стиль', 'Гардероб'].map(label => source.indexOf(`label: '${label}'`));
    assert.ok(order.every((pos, i) => pos > 0 && (i === 0 || pos > order[i - 1])), 'tab order');
    assert.match(source, /label: 'Профили персонажей'[^\n]*sections: \['character_library', 'avatars'\]/);
});

test('the picture block can sit in the middle of the reply and is put back after re-renders', () => {
    assert.match(source, /promptPanelPosition: 'middle'/);
    assert.match(source, /function placePromptPanel\(/);
    assert.match(source, /new MutationObserver\(/);
    assert.match(css, /\.iig-pp, \.iig-pp \* \{ overflow-wrap: normal;/);
});

test('profiles and NPC choose the description format once, on top', () => {
    assert.match(source, /class="iig-profiles-describe-settings"/);
    assert.match(source, /profileDescribeWithCard: false/);
    assert.match(source, /describeFormatSelectHtml\('iig_npc_desc_format'/);
    assert.match(source, /function getNpcDescFormat\(/);
});

test('NPC text buttons are not squeezed into icon squares', () => {
    assert.match(source, /class="menu_button iig-npc-text-btn npc-appearance-generate"/);
    assert.match(css, /#iig_npc_list \.menu_button\.iig-npc-text-btn \{ width: auto;/);
});

test('the wardrobe window has Одежда / Причёски for the bot and the user', () => {
    assert.match(source, /data-kind="hair"/);
    assert.match(source, /function renderQuickHairstyleList\(/);
});
