/**
 * Inline Image Generation Extension for SillyTavern
 *
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible, Gemini-compatible (nano-banana), Naistera,
 * and official NovelAI via the SillyTavern server endpoint.
 *
 * v3.0: Wardrobe system, 4-slot priority refs, Vision API descriptions,
 *       AbortController, request timeout, sequential generation, TreeWalker fix
 */

const MODULE_NAME = 'inline_image_gen';

const processingMessages = new Set();
const activeAbortControllers = new Map();
const activePromptAbortControllers = new Map();
// Prompt panels the user opened (others stay a one-line card).
const expandedPromptPanels = new Set();
// Bot replies that have just been generated: «Авто» writes their image prompt once they are rendered.
const pendingAutoPrompts = new Set();
// messageId → { panel, mesEl }: the panel lives inside the reply text and is put back when SillyTavern re-renders it.
const promptPanels = new Map();
let promptPanelObserver = null;

const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) logBuffer.shift();
    if (level === 'ERROR') console.error('[IIG]', ...args);
    else if (level === 'WARN') console.warn('[IIG]', ...args);
    else console.log('[IIG]', ...args);
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// ============================================================
// DEFAULT SETTINGS
// ============================================================

const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai',
    endpoint: '',
    apiKey: '',
    model: '',
    naisteraModel: '',
    naisteraAspectRatio: '1:1',
    naisteraNegativePrompt: '',
    naisteraPreset: '',
    naisteraCharacterDescriptionsMode: 'as-is',
    naisteraSendCharAvatar: false,
    naisteraSendUserAvatar: false,
    naisteraPolling: false,
    naisteraPollIntervalMs: 3000,
    naisteraPollTimeoutMs: 600000,
    novelaiModel: 'nai-diffusion-5-full',
    novelaiApiKey: '',
    novelaiWidth: 832,
    novelaiHeight: 1216,
    novelaiSteps: 28,
    novelaiScale: 5,
    novelaiSampler: 'k_dpmpp_2m',
    novelaiScheduler: 'karras',
    novelaiNegativePrompt: '',
    novelaiSeed: -1,
    novelaiSm: false,
    novelaiSmDyn: false,
    novelaiDecrisper: false,
    novelaiVarietyBoost: false,
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0,
    retryDelay: 1000,
    requestTimeout: 120,
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '',
    autoDetectNames: true,
    defaultStyle: '',
    aspectRatio: '1:1',
    imageSize: '1K',
    npcReferences: [],
    // Character profiles v2 (replace characterReferenceLibrary), keyed per bot / per persona.
    // Profile: { avatarSource: 'card'|'custom', customAvatarData, appearance, rpgMode, rpgCharacters: [{ id, name, avatarData, appearance }] }
    characterProfiles: {
        characters: {},
        users: {},
    },
    // Image display mode: 'inline' (plain image tag right in the text) or 'extblocks' (images inside HTML/CSS artifacts)
    imageDisplayMode: 'inline',
    // Inject the mode instruction into the chat prompt (off by default: many users keep prompt.md in their preset)
    injectImageModeInstruction: false,
    imageModeInjectionDepth: 1,
    // DEPRECATED: old library, migrated into characterProfiles on load
    characterReferenceLibrary: {
        characters: {},
        users: {},
    },
    characterLibraryEnabled: true,
    characterLibrarySelectedKind: 'char',
    characterLibrarySelectedKey: '',
    wardrobeItems: [],
    wardrobeSendMode: 'both', // 'both', 'text', 'none'
    activeWardrobeChar: null,
    activeWardrobeUser: null,
    // Active outfit per RPG character: { [rpgCharacterId]: wardrobeItemId }
    activeWardrobeRpg: {},
    injectWardrobeToChat: true,
    wardrobeInjectionDepth: 1,
    wardrobeDescEndpoint: '',
    wardrobeDescApiKey: '',
    wardrobeDescModel: '',
    wardrobeDescPrompt: 'Describe this clothing outfit in detail for a character in a roleplay. Focus on: type of garment, color, material/texture, style, notable features, accessories. Be concise but thorough (2-4 sentences). Write in English.',
    // 'banana' — text descriptions (Nano Banana / Gemini / GPT), 'novelai' — Danbooru tags that do not override the art style.
    wardrobeDescFormat: 'banana',
    wardrobeDescPromptNovelAI: "You tag pictures for NovelAI Diffusion. List ONLY the clothing and accessories worn in this picture. Write tags exactly the way NovelAI expects them: real Danbooru tag names only, lowercase, words separated by spaces (never underscores: \"pleated skirt\", not \"pleated_skirt\"), one concept per tag, comma-separated. No sentences, no articles, no invented phrases (\"cozy autumn ensemble\" is not a tag), no weights or brackets. Colors follow Danbooru: a color + item tag (white shirt, black skirt, grey cardigan, black pantyhose; for shoes black footwear, brown footwear) plus the item type tag (boots, ankle boots, high heels, loafers). Typical tags: shirt, collared shirt, blouse, sweater, turtleneck, ribbed sweater, cardigan, jacket, leather jacket, coat, fur trim, dress, skirt, pleated skirt, plaid skirt, pencil skirt, long skirt, miniskirt, shorts, pants, jeans, corset, apron, long sleeves, short sleeves, sleeveless, puffy sleeves, juliet sleeves, wide sleeves, off shoulder, high collar, frills, lace trim, see-through, bow, ribbon, buttons, belt, brooch, choker, necklace, earrings, gloves, fingerless gloves, thighhighs, pantyhose, socks. Do NOT tag the person, hair, face, body, pose, background, lighting, art style or quality, and never use photo, realistic, photorealistic, 3d, model, mannequin or studio. Output one line of 8-25 tags and nothing else.",
    // ===== NEW: Hairstyles =====
    hairstyleItems: [],
    activeHairstyleChar: null,
    activeHairstyleUser: null,
    hairstyleSendMode: 'both', // 'both', 'text', 'none'
    // ===== NEW: Presets =====
    apiPresets: [],
    activePresetId: null,
    // ===== NEW: Style Gallery =====
    styleGalleryItems: [],
    activeStyleIds: [],
    negativeGalleryItems: [],
    activeNegativeId: '',
    // ===== Image prompt generation =====
    promptInstructionItems: [],
    activePromptInstructionId: 'builtin-image',
    promptGenEndpoint: '',
    promptGenApiKey: '',
    promptGenModel: '',
    promptGenMaxTokens: 700,
    promptGenTemperature: 0.7,
    // Stream the image prompt token by token into the message panel
    promptGenStream: false,
    // Prompt panel collapsed by default (extblocks mode only)
    promptPanelCollapsed: false,
    // «Авто»: after every new bot reply write the image prompt and then draw the picture by itself.
    promptAutoGenerate: true,
    // Where the picture / prompt block sits in a bot reply: 'middle' of the text or the 'end'.
    promptPanelPosition: 'middle',
    // Meta (style/negative) collapsed by default (extblocks mode only)
    promptMetaCollapsed: false,
    promptAppearanceOpen: false,
    // Format of «Описать по аватарке» in profiles: '' = same as «Формат описаний», or 'banana' / 'novelai'.
    profileDescFormat: '',
    // «Описать по аватарке» also reads the card / persona description (one switch for both profiles).
    profileDescribeWithCard: false,
    // Format for NPC appearance / outfit descriptions: '' = same as «Формат описаний».
    npcDescFormat: '',
    // Random Gemini format per request (aspect+size picked by the model)
    geminiRandomFormat: false,
    // ===== Reference Generator =====
    refGenSource: 'main', // 'main' | 'custom'
    refGenEndpoint: '',
    refGenApiKey: '',
    refGenModel: '',
    // ===== NEW: Collapsed sections state =====
    collapsedSections: {},
    // Remembered tab / sub-tab / Персонаж-Юзер switch of the tabbed settings panel.
    settingsUiState: { tab: 'main', sub: {}, target: 'char' },
});

// ============================================================
// MODEL DETECTION
// ============================================================

const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

const NOVELAI_MODELS = [
    ['nai-diffusion-5-full', 'NAI Diffusion V5 (Full)'],
    ['nai-diffusion-5-curated', 'NAI Diffusion V5 (Curated)'],
    ['nai-diffusion-4-5-full', 'NAI Diffusion Anime V4.5 (Full)'],
    ['nai-diffusion-4-5-curated', 'NAI Diffusion Anime V4.5 (Curated)'],
    ['nai-diffusion-4-full', 'NAI Diffusion Anime V4 (Full)'],
    ['nai-diffusion-4-curated-preview', 'NAI Diffusion Anime V4 (Curated)'],
    ['nai-diffusion-3', 'NAI Diffusion Anime V3'],
    ['nai-diffusion-2', 'NAI Diffusion Anime V2'],
    ['nai-diffusion-furry-3', 'NAI Diffusion Furry V3'],
];

const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    for (const kw of VIDEO_MODEL_KEYWORDS) { if (mid.includes(kw)) return false; }
    if (mid.includes('vision') && mid.includes('preview')) return false;
    for (const kw of IMAGE_MODEL_KEYWORDS) { if (mid.includes(kw)) return true; }
    return false;
}

function isGeminiModel(modelId) {
    return /nano-banana|gemini|flash-image|imagen/i.test(String(modelId || ''));
}

function buildGeminiRequestCandidates(baseUrl, model, apiKey) {
    const clean = baseUrl.replace(/\/$/, '');
    const lower = clean.toLowerCase();
    const cleanApiKey = normalizeApiKey(apiKey);

    if (lower.includes('googleapis.com')) {
        return [{
            url: `${clean}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanApiKey)}`,
            headers: { 'Content-Type': 'application/json' }
        }];
    }

    const candidates = [];
    const pushCandidate = (url) => {
        if (!candidates.some(candidate => candidate.url === url)) {
            candidates.push({
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cleanApiKey}`
                }
            });
        }
    };

    if (/\/v1beta$/i.test(clean)) {
        pushCandidate(`${clean}/models/${model}:generateContent`);
        pushCandidate(`${clean.replace(/\/v1beta$/i, '')}/v1/models/${model}:generateContent`);
    } else if (/\/v1$/i.test(clean)) {
        pushCandidate(`${clean.replace(/\/v1$/i, '')}/v1beta/models/${model}:generateContent`);
        pushCandidate(`${clean}/models/${model}:generateContent`);
    } else {
        pushCandidate(`${clean}/v1beta/models/${model}:generateContent`);
        pushCandidate(`${clean}/v1/models/${model}:generateContent`);
        pushCandidate(`${clean}/models/${model}:generateContent`);
    }

    return candidates;
}

function normalizeOpenAIBaseUrl(endpoint) {
    return (endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function buildOpenAIUrl(endpoint, path) {
    const cleanPath = String(path || '').replace(/^\/+/, '');
    return `${normalizeOpenAIBaseUrl(endpoint)}/v1/${cleanPath}`;
}

function isRouterEndpoint(endpoint) {
    const lower = (endpoint || '').toLowerCase();
    return lower.includes('closerouter') || lower.includes('openrouter') || lower.includes('rout.my');
}

function normalizeApiKey(apiKey) {
    return String(apiKey ?? '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/^Bearer\s+/i, '')
        .replace(/\s+/g, '')
        .trim();
}

function buildAuthHeaders(apiKey, extra = {}) {
    return {
        ...extra,
        'Authorization': `Bearer ${normalizeApiKey(apiKey)}`
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// ============================================================
// SETTINGS
// ============================================================

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = context.extensionSettings[MODULE_NAME];
    if (s.apiType === 'novelai-custom') s.apiType = 'novelai-direct';
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = defaultSettings[key];
        }
    }
    if (!s.characterReferenceLibrary || typeof s.characterReferenceLibrary !== 'object') {
        s.characterReferenceLibrary = { characters: {}, users: {} };
    }
    if (!s.characterReferenceLibrary.characters || typeof s.characterReferenceLibrary.characters !== 'object') {
        s.characterReferenceLibrary.characters = {};
    }
    if (!s.characterReferenceLibrary.users || typeof s.characterReferenceLibrary.users !== 'object') {
        s.characterReferenceLibrary.users = {};
    }
    // Migrate wardrobe items without description or category
    for (const item of (s.wardrobeItems || [])) {
        if (!Object.hasOwn(item, 'description')) item.description = '';
        if (!Object.hasOwn(item, 'category')) item.category = 'full';
    }
    if (!s.activeWardrobeRpg || typeof s.activeWardrobeRpg !== 'object' || Array.isArray(s.activeWardrobeRpg)) s.activeWardrobeRpg = {};
    if (!Array.isArray(s.styleGalleryItems)) s.styleGalleryItems = [];
    if (!Array.isArray(s.activeStyleIds)) s.activeStyleIds = [];
    for (const item of s.styleGalleryItems) {
        ensureStyleGalleryItemDefaults(item);
    }
    s.activeStyleIds = s.activeStyleIds.filter(id => s.styleGalleryItems.some(item => item.id === id));
    if (!Array.isArray(s.negativeGalleryItems)) s.negativeGalleryItems = [];
    for (const item of s.negativeGalleryItems) ensureNegativeGalleryItemDefaults(item);
    if (s.activeNegativeId && !s.negativeGalleryItems.some(item => item.id === s.activeNegativeId)) s.activeNegativeId = '';
    if (!Array.isArray(s.promptInstructionItems)) s.promptInstructionItems = [];
    for (const item of s.promptInstructionItems) ensurePromptInstructionDefaults(item);
    if (!s.promptInstructionItems.some(item => item.id === s.activePromptInstructionId)) s.activePromptInstructionId = 'builtin-image';
    if (!Number.isFinite(Number(s.promptGenMaxTokens))) s.promptGenMaxTokens = 700;
    if (!Number.isFinite(Number(s.promptGenTemperature))) s.promptGenTemperature = 0.7;
    // «Авто» became on by default (prompt + picture after every reply): switch it on once for existing settings too.
    if (!s.promptAutoDefaultApplied) { s.promptAutoGenerate = true; s.promptAutoDefaultApplied = true; }
    // The first version of the NovelAI tag prompt let the model invent phrases; move it to the current default.
    if (String(s.wardrobeDescPromptNovelAI || '').startsWith('List ONLY the clothing in this picture as Danbooru-style tags')) s.wardrobeDescPromptNovelAI = defaultSettings.wardrobeDescPromptNovelAI;
        for (const npc of (s.npcReferences || [])) {
        ensureNpcDefaults(npc);

        // миграция старого одиночного outfit -> новый массив outfits
        if (npc.outfit && npc.outfits.length === 0) {
            npc.outfits.push({
                id: 'npc_outfit_legacy_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
                name: 'Current Outfit',
                imageData: null,
                description: npc.outfit,
                createdAt: Date.now()
            });
            npc.activeOutfitId = npc.outfits[0].id;
        }
    }
    return s;
}

function saveSettings() {
    const context = SillyTavern.getContext();
    syncActivePresetFromSettings(context.extensionSettings?.[MODULE_NAME]);
    context.saveSettingsDebounced();
}

function normalizeNaisteraModel(model) {
    return String(model || '').trim();
}

function isNaisteraNovelAIModel(model) {
    return /^novelai(?:-|$)/i.test(normalizeNaisteraModel(model));
}

function normalizeNaisteraCharacterDescriptionsMode(value) {
    return ['none', 'as-is', 'character-prompt'].includes(value) ? value : 'as-is';
}

function normalizeNaisteraEndpoint(endpoint) {
    const value = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!value) return 'https://naistera.org';
    return value.replace(/\/api\/(?:generate|models)$/i, '');
}

function normalizeEndpointForProviderSwitch(apiType, endpoint) {
    const current = String(endpoint || '').trim().replace(/\/+$/, '').toLowerCase();
    const knownDefaults = new Set([
        'https://api.openai.com',
        'https://generativelanguage.googleapis.com',
        'https://naistera.org',
    ]);
    if (apiType === 'naistera' && (!current || knownDefaults.has(current))) {
        return 'https://naistera.org';
    }
    if (apiType !== 'naistera' && current === 'https://naistera.org') {
        return '';
    }
    return endpoint;
}

function formatNaisteraDescription(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object') {
        if (value.charName || value.description) {
            return `[CLOTHING: ${value.charName || 'Character'} is wearing: ${value.description || ''}]`;
        }
        return Object.values(value).filter(Boolean).join(' ');
    }
    return String(value);
}

// ============================================================
// CHARACTER PROFILES V2 (replaces characterReferenceLibrary)
// ============================================================

function makeProfileRefId() {
    return `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeCharacterProfile(raw = {}) {
    const rpgCharacters = Array.isArray(raw.rpgCharacters) ? raw.rpgCharacters : [];
    // Own refs uploaded for this bot / persona: a list to pick from. The chosen one replaces the main avatar.
    const customAvatars = (Array.isArray(raw.customAvatars) ? raw.customAvatars : [])
        .map(item => ({
            id: String(item?.id || makeProfileRefId()),
            name: String(item?.name || '').trim().slice(0, 60),
            data: String(item?.data || ''),
        }))
        .filter(item => item.data);
    const customAvatarData = String(raw.customAvatarData || '');
    // Bot only: the card whose picture was picked in the list of characters (its name and card text are used too).
    const pickedCharacter = String(raw.pickedCharacter || '').trim();
    let customAvatarId = String(raw.customAvatarId || '');
    // Older profiles kept a single uploaded ref: it becomes the first item of the list.
    if (customAvatarData && !pickedCharacter && !customAvatars.some(item => item.data === customAvatarData)) {
        customAvatarId = makeProfileRefId();
        customAvatars.unshift({ id: customAvatarId, name: 'Реф', data: customAvatarData });
    }
    if (customAvatarId && !customAvatars.some(item => item.id === customAvatarId)) {
        customAvatarId = customAvatars.find(item => item.data === customAvatarData)?.id || '';
    }
    return {
        avatarSource: raw.avatarSource === 'custom' ? 'custom' : 'card',
        customAvatarData,
        customAvatars,
        customAvatarId,
        pickedCharacter,
        appearance: String(raw.appearance || '').trim(),
        // Extra names to look for in the image prompt (e.g. "Ivan, Vanya, Petrov"), comma-separated.
        aliases: String(raw.aliases || '').trim(),
        // «Описать по аватарке» also reads the card / persona description.
        describeWithCard: Boolean(raw.describeWithCard),
        rpgMode: Boolean(raw.rpgMode),
        rpgCharacters: rpgCharacters.map(char => ({
            id: String(char?.id || `rpg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`),
            name: String(char?.name || '').trim(),
            avatarData: String(char?.avatarData || ''),
            appearance: String(char?.appearance || '').trim(),
        })).filter(char => char.name),
    };
}

function getCharacterProfile(kind, key, settings = getSettings(), create = false) {
    if (!settings.characterProfiles || typeof settings.characterProfiles !== 'object') {
        settings.characterProfiles = { characters: {}, users: {} };
    }
    const bucket = kind === 'user' ? settings.characterProfiles.users : settings.characterProfiles.characters;
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;
    
    if (!bucket[normalizedKey] && create) {
        bucket[normalizedKey] = makeCharacterProfile();
    }
    if (!bucket[normalizedKey]) return null;
    // Normalize in place: the settings UI keeps a reference to this object, a fresh copy would drop its edits.
    const stored = bucket[normalizedKey];
    return Object.assign(stored, makeCharacterProfile(stored));
}

function migrateOldCharacterLibrary(settings = getSettings()) {
    if (settings._characterProfilesMigrated) return;
    
    const oldLib = settings.characterReferenceLibrary;
    if (!oldLib || typeof oldLib !== 'object') {
        settings._characterProfilesMigrated = true;
        return;
    }
    
    if (!settings.characterProfiles) settings.characterProfiles = { characters: {}, users: {} };
    
    // Migrate all user entries
    for (const [key, entry] of Object.entries(oldLib.users || {})) {
        if (!settings.characterProfiles.users[key]) {
            settings.characterProfiles.users[key] = {
                avatarSource: entry?.primary?.imageData ? 'custom' : 'card',
                customAvatarData: String(entry?.primary?.imageData || ''),
                appearance: String(entry?.primary?.description || '').trim(),
                rpgMode: false,
                rpgCharacters: [],
            };
        }
    }
    
    // Migrate all character entries
    for (const [key, entry] of Object.entries(oldLib.characters || {})) {
        if (!settings.characterProfiles.characters[key]) {
            settings.characterProfiles.characters[key] = {
                avatarSource: entry?.primary?.imageData ? 'custom' : 'card',
                customAvatarData: String(entry?.primary?.imageData || ''),
                appearance: String(entry?.primary?.description || '').trim(),
                rpgMode: false,
                rpgCharacters: [],
            };
        }
    }
    
    settings._characterProfilesMigrated = true;
    saveSettings();
    iigLog('INFO', 'Migrated old character library to profiles v2');
}


function addRpgCharacter(name, avatarData = '', appearance = '') {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    const key = getCurrentCharacterLibraryKey();
    const profile = getCharacterProfile('char', key, settings, true);
    
    const normalized = String(name || '').trim();
    if (!normalized) throw new Error('Имя персонажа не может быть пустым');
    
    const exists = profile.rpgCharacters.some(
        char => char.name.toLowerCase() === normalized.toLowerCase()
    );
    if (exists) throw new Error(`Персонаж "${normalized}" уже существует`);
    
    const newChar = {
        id: `rpg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: normalized,
        avatarData: String(avatarData || ''),
        appearance: String(appearance || '').trim(),
    };
    
    profile.rpgCharacters.push(newChar);
    saveSettings();
    return newChar.id;
}

function removeRpgCharacter(charId) {
    const settings = getSettings();
    const key = getCurrentCharacterLibraryKey();
    const profile = getCharacterProfile('char', key, settings, false);
    if (!profile) return;
    
    profile.rpgCharacters = profile.rpgCharacters.filter(char => char.id !== charId);
    // Outfits of a removed RPG character are unreachable from any tab, so drop them with it.
    if (settings.activeWardrobeRpg) delete settings.activeWardrobeRpg[charId];
    if (Array.isArray(settings.wardrobeItems)) {
        settings.wardrobeItems = settings.wardrobeItems.filter(item => item.target !== `rpg:${charId}`);
    }
    saveSettings();
    if (typeof updateWardrobeInjection === 'function') updateWardrobeInjection();
}

function updateRpgCharacter(charId, updates = {}) {
    const settings = getSettings();
    const key = getCurrentCharacterLibraryKey();
    const profile = getCharacterProfile('char', key, settings, false);
    if (!profile) throw new Error('Профиль не найден');
    
    const char = profile.rpgCharacters.find(c => c.id === charId);
    if (!char) throw new Error('Персонаж не найден');
    
    if (updates.name !== undefined) char.name = String(updates.name || '').trim();
    if (updates.avatarData !== undefined) char.avatarData = String(updates.avatarData || '');
    if (updates.appearance !== undefined) char.appearance = String(updates.appearance || '').trim();
    
    saveSettings();
}

async function collectCharacterProfileReferences(kind, settings = getSettings()) {
    migrateOldCharacterLibrary(settings);
    
    const entity = getCurrentLibraryEntity(kind, settings);
    const profile = getCharacterProfile(kind, entity.key, settings, false);
    
    if (!profile) return { refs: [], descriptions: [], names: [], appearance: '', hasPrimary: false };
    
    const refs = [];
    const descriptions = [];
    
    // Add appearance description
    if (profile.appearance) {
        const label = kind === 'user' ? 'USER' : `CHARACTER "${entity.title}"`;
        descriptions.push(`[${label} APPEARANCE]: ${profile.appearance}`);
    }
    
    // Add custom avatar if selected
    if (profile.avatarSource === 'custom' && profile.customAvatarData) {
        refs.push({
            data: profile.customAvatarData,
            mimeType: detectMimeType(profile.customAvatarData),
            name: entity.title,
            description: profile.appearance,
            type: 'face',
        });
    }
    
    return {
        refs,
        descriptions,
        names: splitNameList(profile.aliases),
        appearance: profile.appearance || '',
        hasPrimary: profile.avatarSource === 'custom' && Boolean(profile.customAvatarData),
    };
}

async function collectRpgCharacterReferences(prompt, settings = getSettings()) {
    migrateOldCharacterLibrary(settings);
    
    const context = SillyTavern.getContext();
    const key = getCurrentCharacterLibraryKey();
    const profile = getCharacterProfile('char', key, settings, false);
    
    if (!profile || !profile.rpgMode || profile.rpgCharacters.length === 0) {
        return { refs: [], descriptions: [], outfits: [], people: [] };
    }
    
    const refs = [];
    const descriptions = [];
    const people = [];
    // Active wardrobe outfits of RPG characters mentioned in the prompt
    const outfits = [];
    
    for (const char of profile.rpgCharacters) {
        if (!char.name) continue;
        if (!namesAppearInPrompt([char.name], prompt)) continue;
        
        const outfitId = settings.activeWardrobeRpg?.[char.id];
        const outfit = outfitId ? (settings.wardrobeItems || []).find(i => i.id === outfitId) : null;
        if (outfit) outfits.push({ name: char.name, outfit });
        
        if (char.appearance) {
            descriptions.push(`[RPG CHARACTER "${char.name}" APPEARANCE]: ${char.appearance}`);
        }
        people.push({ name: char.name, names: [char.name], appearance: char.appearance || '' });
        
        if (char.avatarData) {
            refs.push({
                data: char.avatarData,
                mimeType: detectMimeType(char.avatarData),
                name: char.name,
                description: char.appearance,
                type: 'face',
            });
        }
    }
    
    return { refs, descriptions, outfits, people };
}

function getCharacterLibraryKey(character, index = 0) {
    const avatar = String(character?.avatar || '').trim();
    if (avatar) return `avatar:${avatar}`;
    const name = String(character?.name || '').trim();
    return name ? `name:${name}` : `character:${index}`;
}

function getCurrentCharacterLibraryKey() {
    const context = SillyTavern.getContext();
    const id = context.characterId;
    return getCharacterLibraryKey(context.characters?.[id], id);
}

function getCurrentUserLibraryKey(settings = getSettings()) {
    return `avatar:${String(settings.userAvatarFile || 'default').trim() || 'default'}`;
}

function makeCharacterLibraryEntry(raw = {}) {
    const primary = raw.primary && typeof raw.primary === 'object' ? raw.primary : {};
    const appearanceItems = Array.isArray(raw.appearanceItems) ? raw.appearanceItems : [];
    return {
        displayName: String(raw.displayName || '').trim(),
        primary: {
            enabled: primary.enabled !== false,
            imageData: String(primary.imageData || ''),
            description: String(primary.description || '').trim(),
        },
        appearanceItems: appearanceItems.map((item, index) => ({
            id: String(item?.id || `appearance_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`),
            type: item?.type === 'image' ? 'image' : 'text',
            enabled: item?.enabled !== false,
            imageData: String(item?.imageData || ''),
            description: String(item?.description || '').trim(),
        })).filter(item => item.type === 'text' || item.imageData),
    };
}

function getCharacterLibraryEntry(kind, key, settings = getSettings(), create = false) {
    const bucket = kind === 'user'
        ? settings.characterReferenceLibrary.users
        : settings.characterReferenceLibrary.characters;
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return null;
    if (!bucket[normalizedKey] && create) {
        bucket[normalizedKey] = makeCharacterLibraryEntry();
    }
    if (!bucket[normalizedKey]) return null;
    bucket[normalizedKey] = makeCharacterLibraryEntry(bucket[normalizedKey]);
    return bucket[normalizedKey];
}

/**
 * The persona chosen in the extension (Персонажи → Профили), not the one active in SillyTavern:
 * its name and description are used for names, «+ описание карточки», the prompt model and name search.
 */
function getExtensionPersona(settings = getSettings()) {
    const context = SillyTavern.getContext();
    const power = context.powerUserSettings || {};
    const file = String(settings.userAvatarFile || '').trim();
    const name = String((file && power.personas?.[file]) || context.name1 || 'User').trim();
    let description = '';
    if (file && power.persona_descriptions?.[file]) description = String(power.persona_descriptions[file]?.description || '');
    else if (!file) description = String(power.persona_description || '');
    return { file, name, description };
}

/**
 * The bot as set up in the extension: the chat's character, or the card whose picture was picked for it
 * in the profile (then that card's name and description are used for names and «+ описание карточки»).
 */
function getExtensionCharacter(settings = getSettings()) {
    const context = SillyTavern.getContext();
    const current = context.characters?.[context.characterId];
    if (!current) return null;
    const profile = getCharacterProfile('char', getCurrentCharacterLibraryKey(), settings);
    const pickedFile = profile?.avatarSource === 'custom' ? profile.pickedCharacter : '';
    const picked = pickedFile ? (context.characters || []).find(character => character?.avatar === pickedFile) : null;
    const owner = picked || current;
    return {
        name: String(owner.name || owner.avatar || 'Character').trim(),
        chatName: String(current.name || '').trim(),
        description: String(owner.description || ''),
        picked: Boolean(picked),
    };
}

/** {{user}} / {{char}} in a card text, filled with the extension's persona and bot. */
function fillCardMacros(raw, settings = getSettings()) {
    const context = SillyTavern.getContext();
    let text = String(raw || '').replace(/\{\{user\}\}/gi, getExtensionPersona(settings).name);
    const owner = getExtensionCharacter(settings);
    if (owner) text = text.replace(/\{\{char\}\}/gi, owner.name);
    return typeof context.substituteParams === 'function' ? context.substituteParams(text) : text;
}

function getCurrentLibraryEntity(kind, settings = getSettings()) {
    if (kind === 'user') {
        const key = getCurrentUserLibraryKey(settings);
        return { key, title: getExtensionPersona(settings).name || settings.userAvatarFile || 'User' };
    }
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    return {
        key: getCurrentCharacterLibraryKey(),
        title: character?.name || character?.avatar || 'Character',
    };
}

function readLibraryFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// ============================================================
// FETCH FUNCTIONS
// ============================================================

async function fetchModels() {
    const settings = getSettings();
    if (['novelai', 'novelai-direct'].includes(settings.apiType)) return NOVELAI_MODELS.map(([id]) => id);
    if (settings.apiType === 'naistera') {
        return await fetchNaisteraModels();
    }
    if (!settings.endpoint || !settings.apiKey) return [];
    const url = buildOpenAIUrl(settings.endpoint, 'models');
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: buildAuthHeaders(settings.apiKey)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const ids = (data.data || []).map(m => m.id).filter(Boolean);
        if (settings.apiType === 'openai-chat' || isRouterEndpoint(settings.endpoint)) {
            const filtered = ids.filter(id => isImageModel(id) || /vision|gemini|imagen|flux|image|draw|paint|gpt-4o/i.test(id));
            return filtered.length > 0 ? filtered : ids;
        }
        const filtered = ids.filter(id => isImageModel(id));
        return filtered.length > 0 ? filtered : ids;
    } catch (error) {
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

let naisteraModelCatalog = new Map();

async function fetchNaisteraModels() {
    const settings = getSettings();
    const endpoint = normalizeNaisteraEndpoint(settings.endpoint);
    const headers = { Accept: 'application/json' };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;

    const response = await fetch(`${endpoint}/api/models`, { method: 'GET', headers });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Naistera /api/models ${response.status}: ${String(detail).slice(0, 500)}`);
    }

    const payload = await response.json();
    const models = (Array.isArray(payload?.models) ? payload.models : [])
        .filter(model => model?.id && model.visible !== false && model.deprecated !== true)
        .map(model => ({
            id: String(model.id),
            name: String(model.name || model.id),
            references: model.references !== false,
            negativePrompt: model.negative_prompt === true,
        }));

    naisteraModelCatalog = new Map(models.map(model => [model.id, model]));
    iigLog('INFO', `Naistera models loaded: ${models.length}`);
    return models.map(model => model.id);
}

async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const avatars = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.avatars)
                ? payload.avatars
                : Array.isArray(payload?.files)
                    ? payload.files
                    : [];
        return avatars.map(avatar => String(avatar || '').trim()).filter(Boolean);
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

async function fetchDescriptionModels() {
    const settings = getSettings();
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    if (!endpoint || !apiKey) return [];
    const url = buildOpenAIUrl(endpoint, 'models');
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: buildAuthHeaders(apiKey)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return (data.data || []).filter(m => !isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        toastr.error(`Ошибка загрузки текстовых моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

async function fetchPromptGenerationModels() {
    const settings = getSettings();
    const endpoint = settings.promptGenEndpoint || settings.endpoint;
    const apiKey = settings.promptGenApiKey || settings.apiKey;
    if (!endpoint || !apiKey) return [];
    const response = await fetch(buildOpenAIUrl(endpoint, 'models'), {
        method: 'GET',
        headers: buildAuthHeaders(apiKey),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return (data.data || []).filter(model => model?.id && !isImageModel(model.id)).map(model => String(model.id));
}

const PROMPT_GEN_SYSTEM = [
    'You write prompts for an image generator. You are NOT a roleplay participant.',
    'The chat is only source material: never continue the story, never write the character\'s reply, dialogue, plans, timestamps, status or info blocks.',
    'The prompt instruction may have been written for the chat model (story + image tag). Use it only for what the picture shows and how the prompt is formatted.',
    'Output only the image prompt — or, if the instruction requires an image tag, only that one tag.',
].join(' ');

/** Is the picture going to NovelAI (directly, through SillyTavern or a NovelAI model on Naistera)? */
function isNovelAIPromptTarget(settings = getSettings()) {
    return NOVELAI_API_TYPES.includes(settings.apiType)
        || (settings.apiType === 'naistera' && isNaisteraNovelAIModel(settings.naisteraModel));
}

/**
 * Profile appearances of the people who can be in the picture: the bot, the persona, RPG characters and NPCs
 * mentioned in `text`. The prompt model gets them so it stops inventing a new look on every reroll —
 * the exact appearance is added to the image request anyway.
 */
function getFixedAppearances(text = '', settings = getSettings()) {
    const context = SillyTavern.getContext();
    const list = [];
    const add = (name, appearance) => {
        const value = String(appearance || '').trim();
        if (name && value && !list.some(item => item.name === name)) list.push({ name: String(name), appearance: value });
    };
    const character = context.characters?.[context.characterId];
    const charProfile = character ? getCharacterProfile('char', getCurrentLibraryEntity('char', settings).key, settings) : null;
    if (character && charProfile) add(character.name, charProfile.appearance);
    const userProfile = getCharacterProfile('user', getCurrentLibraryEntity('user', settings).key, settings);
    if (userProfile) add(getExtensionPersona(settings).name, userProfile.appearance);
    if (charProfile?.rpgMode) {
        for (const rpg of charProfile.rpgCharacters || []) if (namesAppearInPrompt([rpg.name], text)) add(rpg.name, rpg.appearance);
    }
    for (const npc of settings.npcReferences || []) {
        if (npc?.enabled && npc.name && namesAppearInPrompt([npc.name, ...getNpcAliases(npc)], text)) add(npc.name, npc.appearance);
    }
    return list;
}

function getPromptGenerationContext(message, instruction, settings = getSettings()) {
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    const chat = context.chat || [];
    const index = chat.indexOf(message);
    const history = (index >= 0 ? chat.slice(Math.max(0, index - 7), index) : chat.slice(-8).filter(item => item !== message));
    const recentMessages = history.map(item => {
        const role = item.is_user ? 'User' : item.is_system ? 'System' : (item.name || 'Character');
        return `${role}: ${String(item.mes || '').trim()}`;
    }).filter(Boolean).join('\n\n');
    const novelAI = isNovelAIPromptTarget(settings)
        ? 'Target image model: NovelAI (anime, tag-based). Write comma-separated English tags. If several characters are in the picture, write the shared scene first, then one block per character, separated by " | ".'
        : '';
    const fixed = getFixedAppearances(`${recentMessages}\n${String(message?.mes || '')}`, settings);
    const fixedBlock = fixed.length
        ? `<fixed_appearance>\n${fixed.map(item => `${item.name}: ${item.appearance}`).join('\n')}\n</fixed_appearance>\n`
            + 'The look of these characters is added to the image automatically and must stay the same in every picture. When one of them is in the picture, write their name exactly as listed (as its own tag in tag prompts), then pose, expression, outfit and action. Do NOT describe or change their hair, eyes, skin, face or body.'
        : '';
    return [
        `Character: ${character?.name || 'Unknown'}`,
        `User: ${getExtensionPersona(settings).name}`,
        `<chat_history>\n${recentMessages}\n</chat_history>`,
        `<message_to_illustrate>\n${String(message?.mes || '').trim()}\n</message_to_illustrate>`,
        `<prompt_instruction>\n${instruction.prompt}\n</prompt_instruction>`,
        fixedBlock,
        novelAI,
        'Do not continue the roleplay. Write ONLY the image-generation prompt for <message_to_illustrate> now.',
    ].filter(Boolean).join('\n\n');
}

/**
 * The prompt model sometimes answers like the chat model: story + <img data-iig-instruction='{"prompt":…}'>.
 * Take the prompt out of the tag; otherwise strip reasoning, plans, code fences and a leading "Prompt:" label.
 */
async function cleanGeneratedImagePrompt(text) {
    const raw = String(text || '');
    const tags = await parseImageTags(raw, { forceAll: true }).catch(() => []);
    const fromTags = tags.filter(tag => String(tag.prompt || '').trim());
    if (fromTags.length) {
        return { prompt: fromTags.map(tag => tag.prompt.trim()).join('\n\n'), style: fromTags[0].style || '', fromTag: true };
    }
    const prompt = raw
        .replace(/<(think|thinking|rp_plan|plan)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^```[a-z]*\s*|```\s*$/gim, '')
        .trim()
        .replace(/^\**(?:image\s+)?prompt\**\s*:\s*/i, '')
        .trim();
    return { prompt, style: '', fromTag: false };
}

/**
 * Reads an OpenAI-compatible SSE stream (data: {...choices[0].delta.content}).
 * Calls onChunk(fullTextSoFar) on every delta; returns the full text.
 */
async function readChatCompletionStream(response, onChunk) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') return text;
            try {
                const delta = JSON.parse(data).choices?.[0]?.delta?.content;
                if (delta) { text += delta; onChunk?.(text); }
            } catch { /* partial or keep-alive line */ }
        }
    }
    return text;
}

async function generateImagePromptForMessage(messageId, signal, onChunk = null) {
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!message) throw new Error('Сообщение не найдено');
    const settings = getSettings();
    const instruction = getActivePromptInstruction();
    const endpoint = settings.promptGenEndpoint || settings.endpoint;
    const apiKey = settings.promptGenApiKey || settings.apiKey;
    const model = settings.promptGenModel;
    if (!endpoint) throw new Error('Не настроен endpoint модели промпта');
    if (!apiKey) throw new Error('Не настроен API ключ модели промпта');
    if (!model) throw new Error('Не выбрана модель промпта');

    const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            model,
            temperature: Math.max(0, Math.min(2, Number(settings.promptGenTemperature) || 0.7)),
            max_tokens: Math.max(64, Math.min(4000, Number(settings.promptGenMaxTokens) || 700)),
            messages: [
                { role: 'system', content: PROMPT_GEN_SYSTEM },
                { role: 'user', content: getPromptGenerationContext(message, instruction, settings) },
            ],
            ...(onChunk ? { stream: true } : {}),
        }),
        signal,
    });
    if (!response.ok) throw new Error(`Prompt API (${response.status}): ${(await response.text().catch(() => '')).slice(0, 500)}`);
    // Some proxies ignore stream:true and answer with plain JSON
    const isStream = onChunk && response.body && /event-stream/i.test(response.headers.get('content-type') || '');
    const answer = isStream
        ? (await readChatCompletionStream(response, onChunk)).trim()
        : (await response.json()).choices?.[0]?.message?.content?.trim();
    const cleaned = await cleanGeneratedImagePrompt(answer);
    const prompt = cleaned.prompt;
    if (!prompt) throw new Error('Модель промпта вернула пустой ответ');
    if (cleaned.fromTag) iigLog('INFO', 'Prompt model answered with an image tag — took the prompt from it');

    if (!message.extra || typeof message.extra !== 'object') message.extra = {};
    message.extra.iig_prompt_block = {
        ...(message.extra.iig_prompt_block || {}),
        instructionId: instruction.id,
        sourceHash: promptSourceHash(message.mes),
        prompt,
        style: buildEffectiveStyle(cleaned.style),
        negativePrompt: getActiveNegativePrompt(),
        updatedAt: Date.now(),
    };
    await context.saveChat();
    return message.extra.iig_prompt_block;
}

async function generateImageFromPromptBlock(messageId, panel, signal) {
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    const state = message?.extra?.iig_prompt_block;
    if (!message || !state?.prompt) throw new Error('Сначала сгенерируйте или введите промпт');
    const status = panel?.querySelector('.iig-prompt-status');
    const refs = await collectReferenceImages(state.prompt).catch(() => ({ imageRefs: [], textOnlyClothing: [], warnings: [] }));
    const dataUrl = await generateImageWithRetry(state.prompt, buildEffectiveStyle(''), text => {
        if (status) status.textContent = text;
    }, { negativePrompt: getActiveNegativePrompt() || state.negativePrompt, refData: refs, signal });
    if (status) status.textContent = 'Сохранение...';
    state.imagePath = await saveImageToFile(dataUrl);
    state.updatedAt = Date.now();
    await context.saveChat();
    return state;
}

// ============================================================
// IMAGE UTILITIES
// ============================================================

async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

async function resizeImageBase64(base64, maxSize = 512) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width <= maxSize && height <= maxSize) { resolve(base64); return; }
            const ratio = Math.min(maxSize / width, maxSize / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.getContext('2d').drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = () => resolve(base64);
        img.src = `data:image/png;base64,${base64}`;
    });
}

function detectMimeType(base64Data) {
    if (!base64Data || base64Data.length < 4) return 'image/png';
    if (base64Data.startsWith('/9j/')) return 'image/jpeg';
    if (base64Data.startsWith('iVBOR')) return 'image/png';
    if (base64Data.startsWith('UklGR')) return 'image/webp';
    if (base64Data.startsWith('R0lGOD')) return 'image/gif';
    return 'image/png';
}

// ============================================================
// FILE SAVE
// ============================================================

async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();

    if (dataUrl && !dataUrl.startsWith('data:') && (dataUrl.startsWith('http://') || dataUrl.startsWith('https://'))) {
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        } catch (err) {
            throw new Error('Failed to download image from URL');
        }
    }

    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) throw new Error('Invalid data URL format');

    const format = match[1];
    const base64Data = match[2];

    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;

    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ image: base64Data, format, ch_name: charName, filename })
    });

    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }

    const result = await response.json();
    return result.path;
}

// ============================================================
// AVATAR RETRIEVAL
// ============================================================

async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        if (context.characterId === undefined || context.characterId === null) return null;
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            if (avatarUrl) return await imageUrlToBase64(avatarUrl);
        }
        const character = context.characters?.[context.characterId];
        if (character?.avatar) {
            return await imageUrlToBase64(`/characters/${encodeURIComponent(character.avatar)}`);
        }
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        if (!settings.userAvatarFile) return null;
        return await imageUrlToBase64(`/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

// ============================================================
// STYLE GALLERY SYSTEM
// ============================================================

function ensureStyleGalleryItemDefaults(item) {
    if (!item) return;
    if (!item.id) item.id = 'style_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    if (!Object.hasOwn(item, 'name')) item.name = 'Style';
    if (!Object.hasOwn(item, 'prompt')) item.prompt = '';
    if (!Object.hasOwn(item, 'previewData')) item.previewData = null;
    if (!Object.hasOwn(item, 'createdAt')) item.createdAt = Date.now();
}

function addStyleGalleryItem(name, promptText, previewData = null) {
    const settings = getSettings();
    const item = {
        id: 'style_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'Style',
        prompt: promptText || '',
        previewData,
        createdAt: Date.now()
    };
    settings.styleGalleryItems.push(item);
    saveSettings();
    return item;
}

function updateStyleGalleryItem(itemId, patch = {}) {
    const settings = getSettings();
    const item = settings.styleGalleryItems.find(i => i.id === itemId);
    if (!item) return null;
    if (Object.hasOwn(patch, 'name')) item.name = patch.name || 'Style';
    if (Object.hasOwn(patch, 'prompt')) item.prompt = patch.prompt || '';
    if (Object.hasOwn(patch, 'previewData')) item.previewData = patch.previewData || null;
    saveSettings();
    return item;
}

function removeStyleGalleryItem(itemId) {
    const settings = getSettings();
    settings.styleGalleryItems = settings.styleGalleryItems.filter(i => i.id !== itemId);
    settings.activeStyleIds = settings.activeStyleIds.filter(id => id !== itemId);
    saveSettings();
}

function toggleActiveStyle(itemId) {
    const settings = getSettings();
    if (!settings.activeStyleIds.includes(itemId)) settings.activeStyleIds.push(itemId);
    else settings.activeStyleIds = settings.activeStyleIds.filter(id => id !== itemId);
    saveSettings();
}

function getActiveStylePrompts() {
    const settings = getSettings();
    return settings.activeStyleIds
        .map(id => settings.styleGalleryItems.find(item => item.id === id))
        .filter(item => item?.prompt?.trim())
        .map(item => item.prompt.trim());
}

/**
 * A tag's "style" is often a short key written by the chat preset (e.g. "milkpic_gouache").
 * If a style-gallery item is named exactly like that key (or ends with "(key)"), use that item's full prompt,
 * so the preset's style works even when the model forgets to append the long STYLE paragraph.
 * Returns { text, itemId } — itemId is set when the key resolved to a gallery item.
 */
function resolveTagStyle(tagStyle = '') {
    const key = String(tagStyle || '').trim();
    if (!key) return { text: '', itemId: null };
    const norm = value => String(value || '').trim().toLowerCase();
    const wanted = norm(key);
    const item = (getSettings().styleGalleryItems || []).find(entry => {
        const name = norm(entry?.name);
        return entry?.prompt?.trim() && (name === wanted || name.endsWith(`(${wanted})`));
    });
    return item ? { text: item.prompt.trim(), itemId: item.id } : { text: key, itemId: null };
}

function buildEffectiveStyle(tagStyle = '') {
    const settings = getSettings();
    const resolved = resolveTagStyle(tagStyle);
    // Styles switched on in the gallery + the style named by the tag (not twice if it is also switched on).
    const active = settings.activeStyleIds
        .filter(id => id !== resolved.itemId)
        .map(id => settings.styleGalleryItems.find(item => item.id === id))
        .filter(item => item?.prompt?.trim())
        .map(item => item.prompt.trim());
    return [settings.defaultStyle, ...active, resolved.text]
        .map(part => (part || '').trim())
        .filter(Boolean)
        .join(', ');
}

function ensureNegativeGalleryItemDefaults(item) {
    if (!item) return;
    if (!item.id) item.id = `negative_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!Object.hasOwn(item, 'name')) item.name = 'Negative prompt';
    if (!Object.hasOwn(item, 'prompt')) item.prompt = '';
    if (!Object.hasOwn(item, 'createdAt')) item.createdAt = Date.now();
}

function addNegativeGalleryItem(name, promptText) {
    const settings = getSettings();
    const item = {
        id: `negative_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(name || 'Negative prompt').trim() || 'Negative prompt',
        prompt: String(promptText || '').trim(),
        createdAt: Date.now(),
    };
    settings.negativeGalleryItems.push(item);
    saveSettings();
    return item;
}

function getActiveNegativePrompt() {
    const settings = getSettings();
    const item = settings.negativeGalleryItems.find(candidate => candidate.id === settings.activeNegativeId);
    return String(item?.prompt || '').trim();
}

function getEffectiveNegativePrompt(tagNegativePrompt = '') {
    // The gallery is intentionally independent from image/API presets. A tag
    // value remains a per-image override, while the selected gallery item is
    // the extension-wide default for all providers that support negatives.
    return String(tagNegativePrompt || '').trim() || getActiveNegativePrompt();
}

const BUILTIN_PROMPT_INSTRUCTIONS = Object.freeze([
    {
        id: 'builtin-image',
        name: 'Обычная картинка',
        kind: 'image',
        builtin: true,
        prompt: 'Create one detailed image-generation prompt from the scene. Describe the characters, appearance, clothing, pose, action, environment, lighting, camera angle, composition, and mood. Preserve named character identities and concrete visual facts. Do not add story, dialogue, explanations, or markdown. Return only the final prompt in English.',
    },
    {
        id: 'builtin-comic',
        name: 'Комикс',
        kind: 'comic',
        builtin: true,
        prompt: 'Create one detailed image-generation prompt for a comic page based on the scene. Specify the number and layout of panels, reading order, continuity of characters and clothing, camera angle in each panel, actions, expressions, environment, lighting, speech bubbles or captions only when explicitly present, and clear separation between panels. Preserve all named character identities. Return only one final prompt in English, with no explanations or markdown.',
    },
]);

function ensurePromptInstructionDefaults(item) {
    if (!item) return;
    if (!item.id) item.id = `instruction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (!Object.hasOwn(item, 'name')) item.name = 'Image prompt instruction';
    if (!Object.hasOwn(item, 'kind')) item.kind = 'custom';
    if (!Object.hasOwn(item, 'prompt')) item.prompt = '';
    if (!Object.hasOwn(item, 'builtin')) item.builtin = false;
    if (!Object.hasOwn(item, 'createdAt')) item.createdAt = Date.now();
}

function getPromptInstructions(settings = getSettings()) {
    const custom = settings.promptInstructionItems || [];
    const customById = new Map(custom.map(item => [item.id, item]));
    const all = BUILTIN_PROMPT_INSTRUCTIONS.map(item => customById.get(item.id) || item);
    all.push(...custom.filter(item => !BUILTIN_PROMPT_INSTRUCTIONS.some(builtin => builtin.id === item.id)));
    return all.map(item => ({ ...item }));
}

function getActivePromptInstruction() {
    const settings = getSettings();
    return getPromptInstructions(settings).find(item => item.id === settings.activePromptInstructionId)
        || BUILTIN_PROMPT_INSTRUCTIONS[0];
}

function addPromptInstruction(name, promptText, kind = 'custom') {
    const settings = getSettings();
    const item = {
        id: `instruction_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: String(name || 'Моя инструкция').trim() || 'Моя инструкция',
        kind: kind === 'comic' ? 'comic' : 'custom',
        prompt: String(promptText || '').trim(),
        builtin: false,
        createdAt: Date.now(),
    };
    settings.promptInstructionItems.push(item);
    settings.activePromptInstructionId = item.id;
    saveSettings();
    return item;
}

function updatePromptInstruction(itemId, patch = {}) {
    const settings = getSettings();
    const builtin = BUILTIN_PROMPT_INSTRUCTIONS.find(item => item.id === itemId);
    const item = settings.promptInstructionItems.find(candidate => candidate.id === itemId);
    if (!item && !builtin) return null;
    if (builtin) {
        // Built-ins are editable through a per-user override, preserving the
        // shipped defaults for the Restore button.
        const override = {
            ...builtin,
            ...patch,
            id: builtin.id,
            builtin: true,
            overridden: true,
        };
        settings.promptInstructionItems = settings.promptInstructionItems.filter(candidate => candidate.id !== itemId);
        settings.promptInstructionItems.push(override);
        saveSettings();
        return override;
    }
    if (Object.hasOwn(patch, 'name')) item.name = String(patch.name || item.name).trim() || item.name;
    if (Object.hasOwn(patch, 'prompt')) item.prompt = String(patch.prompt || '').trim();
    if (Object.hasOwn(patch, 'kind')) item.kind = patch.kind === 'comic' ? 'comic' : 'custom';
    saveSettings();
    return item;
}

function removePromptInstruction(itemId) {
    const settings = getSettings();
    settings.promptInstructionItems = settings.promptInstructionItems.filter(item => item.id !== itemId);
    if (settings.activePromptInstructionId === itemId) settings.activePromptInstructionId = 'builtin-image';
    saveSettings();
}

function restorePromptInstruction(itemId) {
    const settings = getSettings();
    settings.promptInstructionItems = settings.promptInstructionItems.filter(item => item.id !== itemId);
    saveSettings();
}

// ============================================================
// WARDROBE SYSTEM
// ============================================================

const WARDROBE_CATEGORIES = Object.freeze({
    full: 'Полный образ',
    top: 'Верх',
    bottom: 'Низ',
    shoes: 'Обувь',
    accessories: 'Аксессуары',
    other: 'Другое',
});

function addWardrobeItem(name, imageData, target = 'char', category = 'full') {
    const settings = getSettings();
    const item = {
        id: 'ward_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'Outfit',
        imageData,
        description: '',
        target,
        category: category in WARDROBE_CATEGORIES ? category : 'full',
        createdAt: Date.now()
    };
    settings.wardrobeItems.push(item);
    // Don't call saveSettings() here to prevent panel collapse - caller will save after render
    return item;
}

// ============================================================
// HAIRSTYLE SYSTEM
// ============================================================

function addHairstyleItem(name, imageData, target = 'char') {
    const settings = getSettings();
    const item = {
        id: 'hair_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'Hairstyle',
        imageData,
        description: '',
        target,
        createdAt: Date.now()
    };
    if (!settings.hairstyleItems) settings.hairstyleItems = [];
    settings.hairstyleItems.push(item);
    saveSettings();
    return item;
}

function removeHairstyleItem(itemId) {
    const settings = getSettings();
    if (settings.activeHairstyleChar === itemId) settings.activeHairstyleChar = null;
    if (settings.activeHairstyleUser === itemId) settings.activeHairstyleUser = null;
    settings.hairstyleItems = settings.hairstyleItems.filter(i => i.id !== itemId);
    saveSettings();
}

function setActiveHairstyle(itemId, target) {
    const settings = getSettings();
    const key = target === 'char' ? 'activeHairstyleChar' : 'activeHairstyleUser';
    settings[key] = settings[key] === itemId ? null : itemId;
    saveSettings();
}

function getActiveHairstyleItem(target) {
    const settings = getSettings();
    const activeId = settings[target === 'char' ? 'activeHairstyleChar' : 'activeHairstyleUser'];
    return activeId ? (settings.hairstyleItems?.find(i => i.id === activeId) || null) : null;
}

function updateHairstyleItemDescription(itemId, description) {
    const settings = getSettings();
    const item = settings.hairstyleItems?.find(i => i.id === itemId);
    if (item) {
        item.description = description;
        saveSettings();
    }
}

const VISION_PROMPTS = Object.freeze({
    hairstyle: {
        banana: 'Describe this hairstyle in detail for a character in a roleplay. Focus on: length, color, texture, style (straight/curly/wavy), cut, notable features (bangs, layers, etc), accessories. Be concise but thorough (2-3 sentences). Write in English.',
        novelai: "You tag pictures for NovelAI Diffusion. List ONLY the hairstyle in this picture. Write tags exactly the way NovelAI expects them: real Danbooru tag names only, lowercase, words separated by spaces (never underscores: \"pleated skirt\", not \"pleated_skirt\"), one concept per tag, comma-separated. No sentences, no articles, no invented phrases (\"cozy autumn ensemble\" is not a tag), no weights or brackets. Typical tags: short hair, medium hair, long hair, very long hair, pink hair, blonde hair, streaked hair, two-tone hair, gradient hair, straight hair, wavy hair, curly hair, drill hair, ponytail, high ponytail, twintails, braid, twin braids, french braid, hair bun, single hair bun, double bun, bob cut, hime cut, blunt bangs, swept bangs, parted bangs, sidelocks, hair over one eye, ahoge, hair ribbon, hair bow, hair flower, hairclip. Do NOT tag the face, eyes, clothes, pose, background, lighting or art style, and never photo or realistic. Output one line of 4-12 tags and nothing else.",
    },
    appearance: {
        banana: 'Describe this character\'s physical appearance for a roleplay image prompt. Focus on face, hair, eyes, body type, age impression, skin tone and distinctive features (freckles, scars, tattoos, ears, horns). Do not describe the clothing, pose, background, lighting or the art style of the picture. Be concise but detailed in 2-4 sentences. Write in English.',
        novelai: "You tag pictures for NovelAI Diffusion. List this character's physical appearance. Write tags exactly the way NovelAI expects them: real Danbooru tag names only, lowercase, words separated by spaces (never underscores: \"pleated skirt\", not \"pleated_skirt\"), one concept per tag, comma-separated. No sentences, no articles, no invented phrases (\"cozy autumn ensemble\" is not a tag), no weights or brackets. Tag hair color, hair length, hairstyle and bangs, eye color, skin (pale skin, dark skin, tan), body (slim, muscular, muscular male, petite, tall), age look (mature male, mature female, old man), facial hair (stubble, beard, mustache) and distinctive features (freckles, mole under eye, scar, scar on face, tattoo, pointy ears, horns, glasses). Do NOT tag clothing, pose, expression, background, lighting, art style or quality, no 1girl/1boy, and never photo or realistic. Output one line of 8-20 tags and nothing else.",
    },
});

/** Format of vision descriptions: 'banana' (sentences) or 'novelai' (tags). */
function getVisionDescFormat(settings = getSettings()) {
    return settings.wardrobeDescFormat === 'novelai' ? 'novelai' : 'banana';
}

/** Format for NPC appearance and outfit descriptions. */
function getNpcDescFormat(settings = getSettings()) {
    if (settings.npcDescFormat === 'novelai' || settings.npcDescFormat === 'banana') return settings.npcDescFormat;
    return getVisionDescFormat(settings);
}

/** Format for describing the bot / persona appearance in profiles. */
function getProfileDescFormat(settings = getSettings()) {
    if (settings.profileDescFormat === 'novelai' || settings.profileDescFormat === 'banana') return settings.profileDescFormat;
    return getVisionDescFormat(settings);
}

/** Instruction for the vision model: kind = 'outfit' | 'hairstyle' | 'appearance'. */
function getVisionPrompt(kind, settings = getSettings(), format = getVisionDescFormat(settings)) {
    if (kind === 'outfit') {
        return format === 'novelai'
            ? (String(settings.wardrobeDescPromptNovelAI || '').trim() || defaultSettings.wardrobeDescPromptNovelAI)
            : (String(settings.wardrobeDescPrompt || '').trim() || defaultSettings.wardrobeDescPrompt);
    }
    return VISION_PROMPTS[kind]?.[format] || VISION_PROMPTS.appearance[format];
}

/** NovelAI tags come back as one clean comma-separated line (no "Tags:" label, numbering, line breaks or final dot). */
function cleanVisionAnswer(text, settings = getSettings(), format = getVisionDescFormat(settings)) {
    const answer = String(text || '').trim();
    if (format !== 'novelai') return answer;
    return answer
        .replace(/```[a-z]*|```/gi, '')
        .replace(/^\s*(?:tags?|outfit|hairstyle|appearance)\s*:\s*/i, '')
        .split(/\n+/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).join(', ')
        .split(',')
        // NovelAI style: lowercase, spaces instead of Danbooru underscores ("pleated_skirt" → "pleated skirt"), no duplicates.
        .map(tag => tag.trim().replace(/[.;]+$/, '').replace(/(\p{L})_(?=\p{L})/gu, '$1 ').replace(/\s+/g, ' ').toLowerCase())
        .filter((tag, index, all) => tag && all.indexOf(tag) === index)
        .join(', ');
}

/** Card text of the current bot, or the persona description, with {{char}}/{{user}} filled in. */
function getCardAppearanceSource(kind, settings = getSettings()) {
    const raw = kind === 'user'
        ? getExtensionPersona(settings).description
        : (getExtensionCharacter(settings)?.description || '');
    return fillCardMacros(raw, settings).trim().slice(0, 6000);
}

/**
 * Appearance from the avatar picture, optionally together with the card text («+ описание карточки»).
 * Without a picture but with card text the appearance is taken from the text alone.
 */
async function describeAppearance({ image = '', cardText = '', format = getProfileDescFormat() } = {}) {
    const settings = getSettings();
    const card = String(cardText || '').trim();
    if (!image && !card) throw new Error('Нет ни картинки, ни описания карточки');
    let instruction = getVisionPrompt('appearance', settings, format);
    if (card) {
        instruction += image
            ? '\n\nThe text below describes the SAME character. Also use the physical appearance it states (hair, eyes, skin, height, body, scars, tattoos, ears, horns and similar permanent traits), even where the picture does not show them clearly; when the picture and the text disagree about a permanent trait, follow the text. Ignore personality, backstory, clothing and everything that is not physical appearance.'
            : '\n\nThere is no picture: take the physical appearance only from the character text below (hair, eyes, skin, height, body, scars, tattoos, ears, horns and similar permanent traits). Ignore personality, backstory, clothing and everything that is not physical appearance.';
        instruction += `\n<character_text>\n${card}\n</character_text>`;
    }
    if (image) return await generateVisionDescriptionFromImage(image, instruction, format);

    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;
    if (!endpoint || !apiKey || !model) throw new Error('Настройте модель в «Vision API для описаний»');
    const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ model, max_tokens: 500, temperature: 0.3, messages: [{ role: 'user', content: instruction }] }),
    });
    if (!response.ok) throw new Error(`API ошибка (${response.status}): ${(await response.text().catch(() => '?')).slice(0, 300)}`);
    const result = await response.json();
    const description = cleanVisionAnswer(result.choices?.[0]?.message?.content, settings, format);
    if (!description) throw new Error('Модель вернула пустой ответ');
    return description;
}

async function generateHairstyleDescription(itemId) {
    const settings = getSettings();
    const item = settings.hairstyleItems?.find(i => i.id === itemId);
    if (!item?.imageData) throw new Error('Нет данных изображения');

    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;
    if (!endpoint) throw new Error('Не настроен эндпоинт для генерации описаний');
    if (!apiKey) throw new Error('Не настроен API ключ');
    if (!model) throw new Error('Не выбрана модель для описаний');

    const promptText = getVisionPrompt('hairstyle', settings);

    const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            model,
            max_tokens: 500,
            temperature: 0.3,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${item.imageData}` } },
                    { type: 'text', text: promptText }
                ]
            }],
        })
    });

    if (!response.ok) throw new Error(`API ошибка (${response.status}): ${await response.text().catch(() => '?')}`);
    const result = await response.json();
    const description = cleanVisionAnswer(result.choices?.[0]?.message?.content, settings);
    if (!description) throw new Error('Модель вернула пустой ответ');

    iigLog('INFO', `Generated hairstyle description for "${item.name}": ${description.substring(0, 100)}...`);
    return description;
}

// Wardrobe targets: 'char', 'user' or 'rpg:<rpgCharacterId>' (RPG characters of the current bot).
function isRpgWardrobeTarget(target) {
    return typeof target === 'string' && target.startsWith('rpg:') && target.length > 4;
}

function getActiveWardrobeId(target, settings = getSettings()) {
    if (isRpgWardrobeTarget(target)) return settings.activeWardrobeRpg?.[target.slice(4)] || null;
    return settings[target === 'char' ? 'activeWardrobeChar' : 'activeWardrobeUser'] || null;
}

function removeWardrobeItem(itemId) {
    const settings = getSettings();
    if (settings.activeWardrobeChar === itemId) settings.activeWardrobeChar = null;
    if (settings.activeWardrobeUser === itemId) settings.activeWardrobeUser = null;
    for (const [rpgId, activeId] of Object.entries(settings.activeWardrobeRpg || {})) {
        if (activeId === itemId) delete settings.activeWardrobeRpg[rpgId];
    }
    settings.wardrobeItems = settings.wardrobeItems.filter(i => i.id !== itemId);
    // Don't call saveSettings() here to prevent panel collapse - caller will save after render
    updateWardrobeInjection();
}

function setActiveWardrobe(itemId, target) {
    const settings = getSettings();
    if (isRpgWardrobeTarget(target)) {
        const rpgId = target.slice(4);
        if (!settings.activeWardrobeRpg || typeof settings.activeWardrobeRpg !== 'object') settings.activeWardrobeRpg = {};
        if (settings.activeWardrobeRpg[rpgId] === itemId || !itemId) delete settings.activeWardrobeRpg[rpgId];
        else settings.activeWardrobeRpg[rpgId] = itemId;
    } else {
        const key = target === 'char' ? 'activeWardrobeChar' : 'activeWardrobeUser';
        settings[key] = settings[key] === itemId ? null : itemId;
    }
    saveSettings();
    updateWardrobeInjection();
}

function getActiveWardrobeItem(target) {
    const settings = getSettings();
    const activeId = getActiveWardrobeId(target, settings);
    return activeId ? (settings.wardrobeItems.find(i => i.id === activeId) || null) : null;
}

/** RPG characters of the current bot that can wear wardrobe items (RPG mode on, named). */
function getCurrentRpgWardrobeTargets(settings = getSettings()) {
    const profile = getCharacterProfile('char', getCurrentCharacterLibraryKey(), settings, false);
    if (!profile?.rpgMode || !Array.isArray(profile.rpgCharacters)) return [];
    return profile.rpgCharacters
        .filter(c => c?.id && String(c.name || '').trim())
        .map(c => ({ target: `rpg:${c.id}`, id: c.id, name: String(c.name).trim() }));
}

function updateWardrobeItemDescription(itemId, description) {
    const settings = getSettings();
    const item = settings.wardrobeItems.find(i => i.id === itemId);
    if (item) {
        item.description = description;
        // Don't call saveSettings() here to prevent panel collapse - caller will save after render
        updateWardrobeInjection();
    }
}

async function generateWardrobeDescription(itemId) {
    const settings = getSettings();
    const item = settings.wardrobeItems.find(i => i.id === itemId);
    if (!item?.imageData) throw new Error('Нет данных изображения');

    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;
    if (!endpoint) throw new Error('Не настроен эндпоинт для генерации описаний');
    if (!apiKey) throw new Error('Не настроен API ключ');
    if (!model) throw new Error('Не выбрана модель для описаний');

    const promptText = getVisionPrompt('outfit', settings);

    const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            model,
            max_tokens: 500,
            temperature: 0.3,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${item.imageData}` } },
                    { type: 'text', text: promptText }
                ]
            }],
        })
    });

    if (!response.ok) throw new Error(`API ошибка (${response.status}): ${await response.text().catch(() => '?')}`);
    const result = await response.json();
    const description = cleanVisionAnswer(result.choices?.[0]?.message?.content, settings);
    if (!description) throw new Error('Модель вернула пустой ответ');

    iigLog('INFO', `Generated wardrobe description for "${item.name}": ${description.substring(0, 100)}...`);
    return description;
}

function ensureNpcDefaults(npc) {
    if (!npc) return;
    if (!Object.hasOwn(npc, 'appearance')) npc.appearance = '';
    if (!Object.hasOwn(npc, 'outfit')) npc.outfit = '';
    if (!Array.isArray(npc.outfits)) npc.outfits = [];
    if (!Object.hasOwn(npc, 'activeOutfitId')) npc.activeOutfitId = null;

    for (const outfit of npc.outfits) {
        if (!Object.hasOwn(outfit, 'description')) outfit.description = '';
        if (!Object.hasOwn(outfit, 'imageData')) outfit.imageData = null;
    }
}

async function generateVisionDescriptionFromImage(imageData, promptText, format = getVisionDescFormat()) {
    const settings = getSettings();
    if (!imageData) throw new Error('Нет данных изображения');

    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;

    if (!endpoint) throw new Error('Не настроен эндпоинт для генерации описаний');
    if (!apiKey) throw new Error('Не настроен API ключ');
    if (!model) throw new Error('Не выбрана модель для описаний');

    const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            model,
            max_tokens: 500,
            temperature: 0.3,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } },
                    { type: 'text', text: promptText }
                ]
            }],
        })
    });

    if (!response.ok) {
        throw new Error(`API ошибка (${response.status}): ${await response.text().catch(() => '?')}`);
    }

    const result = await response.json();
    const description = cleanVisionAnswer(result.choices?.[0]?.message?.content, settings, format);
    if (!description) throw new Error('Модель вернула пустой ответ');
    return description;
}

async function generateNpcAppearanceDescription(npcIndex) {
    const settings = getSettings();
    const npc = settings.npcReferences?.[npcIndex];
    if (!npc?.imageData) throw new Error('Сначала загрузите картинку NPC');

    const format = getNpcDescFormat(settings);
    const promptText = getVisionPrompt('appearance', settings, format);

    const description = await generateVisionDescriptionFromImage(npc.imageData, promptText, format);
    iigLog('INFO', `Generated NPC appearance for "${npc.name}": ${description.substring(0, 100)}...`);
    return description;
}

function addNpcOutfit(npcIndex, name, imageData) {
    const settings = getSettings();
    const npc = settings.npcReferences?.[npcIndex];
    if (!npc) return null;

    ensureNpcDefaults(npc);

    const item = {
        id: 'npc_outfit_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        name: name || 'Outfit',
        imageData,
        description: '',
        createdAt: Date.now()
    };

    npc.outfits.push(item);
    if (!npc.activeOutfitId) npc.activeOutfitId = item.id;
    saveSettings();
    return item;
}

function getActiveNpcOutfit(npc) {
    ensureNpcDefaults(npc);
    return npc.activeOutfitId ? (npc.outfits.find(i => i.id === npc.activeOutfitId) || null) : null;
}

function setActiveNpcOutfit(npcIndex, outfitId) {
    const settings = getSettings();
    const npc = settings.npcReferences?.[npcIndex];
    if (!npc) return;

    ensureNpcDefaults(npc);
    npc.activeOutfitId = npc.activeOutfitId === outfitId ? null : outfitId;
    saveSettings();
}

function removeNpcOutfit(npcIndex, outfitId) {
    const settings = getSettings();
    const npc = settings.npcReferences?.[npcIndex];
    if (!npc) return;

    ensureNpcDefaults(npc);
    if (npc.activeOutfitId === outfitId) npc.activeOutfitId = null;
    npc.outfits = npc.outfits.filter(i => i.id !== outfitId);
    if (!npc.activeOutfitId && npc.outfits.length > 0) npc.activeOutfitId = npc.outfits[0].id;
    saveSettings();
}

function updateNpcOutfitDescription(npcIndex, outfitId, description) {
    const settings = getSettings();
    const npc = settings.npcReferences?.[npcIndex];
    if (!npc) return;

    ensureNpcDefaults(npc);
    const outfit = npc.outfits.find(i => i.id === outfitId);
    if (outfit) {
        outfit.description = description;
        saveSettings();
    }
}

async function generateNpcOutfitDescription(npcIndex, outfitId) {
    const settings = getSettings();
    const npc = settings.npcReferences?.[npcIndex];
    if (!npc) throw new Error('NPC не найден');

    ensureNpcDefaults(npc);
    const outfit = npc.outfits.find(i => i.id === outfitId);
    if (!outfit?.imageData) throw new Error('Нет данных изображения');

    const format = getNpcDescFormat(settings);
    const promptText = getVisionPrompt('outfit', settings, format);
    const description = await generateVisionDescriptionFromImage(outfit.imageData, promptText, format);

    iigLog('INFO', `Generated NPC outfit for "${npc.name}" / "${outfit.name}": ${description.substring(0, 100)}...`);
    return description;
}
const IMAGE_TAG_FORMAT = `<img data-iig-instruction='{"style":"[STYLE]","prompt":"[DESC]","aspect_ratio":"[RATIO]","image_size":"[SIZE]"}' src="[IMG:GEN]">`;

const IMAGE_TAG_RULES = [
    'Single quotes wrap the attribute, double quotes inside JSON. Never reverse this.',
    '[DESC]: detailed English prompt (characters, action, environment, lighting, camera). ALWAYS start each character description with the character\'s name, exactly as it is spelled in the character list.',
    '[RATIO]: one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. [SIZE]: 1K, 2K or 4K.',
    'src="[IMG:GEN]" marks a NEW image. Never copy paths of already generated images.',
].join('\n- ');

function normalizeImageDisplayMode(mode) {
    return mode === 'extblocks' ? 'extblocks' : 'inline';
}

function buildImageModeInstruction(mode) {
    if (normalizeImageDisplayMode(mode) === 'extblocks') {
        return `[Image generation — external blocks mode]
Embed a visual HTML/CSS artifact (no JavaScript, no markdown code blocks) into the response, thematically tied to the scene. Use a unique wrapper id, mobile-first sizing. Place 1-5 generated images inside the artifact using this exact tag:
${IMAGE_TAG_FORMAT}
- ${IMAGE_TAG_RULES}`;
    }
    return `[Image generation — inline mode]
When a scene deserves an illustration, insert the image tag directly into the narrative text, on its own line, between paragraphs. Do NOT wrap it in HTML blocks, artifacts, tables or code blocks. Use this exact tag:
${IMAGE_TAG_FORMAT}
- ${IMAGE_TAG_RULES}`;
}

function updateImageModeInjection() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        if (typeof context.setExtensionPrompt !== 'function') return;
        const key = MODULE_NAME + '_image_mode';
        if (!settings.enabled || !settings.injectImageModeInstruction) {
            context.setExtensionPrompt(key, '', 0, 0);
            return;
        }
        const depth = Math.max(0, Math.min(100, parseInt(settings.imageModeInjectionDepth, 10) || 1));
        context.setExtensionPrompt(key, buildImageModeInstruction(settings.imageDisplayMode), 1, depth);
    } catch (error) {
        iigLog('ERROR', 'Error updating image mode injection:', error);
    }
}

function applyImageDisplayMode(mode = getSettings().imageDisplayMode) {
    const normalized = normalizeImageDisplayMode(mode);
    document.body?.classList.toggle('iig-mode-inline', normalized === 'inline');
    document.body?.classList.toggle('iig-mode-extblocks', normalized === 'extblocks');
}

function updateWardrobeInjection() {
    try {
        const context = SillyTavern.getContext();
        const settings = getSettings();
        const INJECTION_KEY = MODULE_NAME + '_wardrobe';

        if (!settings.injectWardrobeToChat) {
            if (typeof context.setExtensionPrompt === 'function') {
                context.setExtensionPrompt(INJECTION_KEY, '', 0, 0);
            }
            return;
        }

        const parts = [];

        const charItem = getActiveWardrobeItem('char');
        if (charItem?.description) {
            const charName = context.characters?.[context.characterId]?.name || 'Character';
            parts.push(`[${charName} is currently wearing: ${charItem.description}]`);
        }

        const userItem = getActiveWardrobeItem('user');
        if (userItem?.description) {
            const userName = getExtensionPersona(settings).name;
            parts.push(`[${userName} is currently wearing: ${userItem.description}]`);
        }

        for (const rpg of getCurrentRpgWardrobeTargets(settings)) {
            const rpgItem = getActiveWardrobeItem(rpg.target);
            if (rpgItem?.description) parts.push(`[${rpg.name} is currently wearing: ${rpgItem.description}]`);
        }

        const depth = settings.wardrobeInjectionDepth || 1;
        if (typeof context.setExtensionPrompt === 'function') {
            context.setExtensionPrompt(INJECTION_KEY, parts.join('\n'), 1, depth);
        }
    } catch (error) {
        iigLog('ERROR', 'Error updating wardrobe injection:', error);
    }
}

// ============================================================
// REFERENCE GENERATOR (body-type / outfit reference sheets)
// ============================================================

const REF_GEN_FLAG_DEFAULTS = Object.freeze({
    ignoreTattoos: true,
    bodyFromDescription: true,
    noHairTransfer: false,
    noAccessoriesTransfer: false,
});

function normalizeRefGenFlags(flags = {}) {
    const out = {};
    for (const key of Object.keys(REF_GEN_FLAG_DEFAULTS)) {
        out[key] = typeof flags?.[key] === 'boolean' ? flags[key] : REF_GEN_FLAG_DEFAULTS[key];
    }
    return out;
}

/** Builds the final editable prompt from the generator state. Pure: no settings or DOM access. */
function buildReferenceGenPrompt(state = {}) {
    const flags = normalizeRefGenFlags(state.flags);
    const name = String(state.name || '').trim() || 'the character';
    const description = String(state.refinedDescription || state.description || '').trim();
    const lines = [
        `Full-body character reference sheet of ${name}: single figure, front view, neutral standing A-pose, plain light-grey background, even studio lighting, no props, no text.`,
    ];
    if (state.hasCharacterRef) lines.push('Keep the face and identity from the CHARACTER reference image.');
    if (state.hasOutfitRef) lines.push('Dress the character in the outfit from the OUTFIT reference image. Copy only the clothing, not the face or body of the person wearing it.');
    if (description) lines.push(`Appearance and body: ${description}`);
    if (flags.bodyFromDescription) lines.push('Body type, height and proportions MUST follow the text description, not the reference images.');
    if (flags.ignoreTattoos) lines.push('Do NOT transfer tattoos, piercings, scars or body markings from any reference image.');
    if (flags.noHairTransfer) lines.push('Do NOT copy the hairstyle or hair color from the outfit reference.');
    if (flags.noAccessoriesTransfer) lines.push('Do NOT copy jewelry, bags, hats, glasses or other accessories from the outfit reference.');
    return lines.join('\n');
}

async function refineReferenceDescription(text, signal) {
    const settings = getSettings();
    const source = String(text || '').trim();
    if (!source) throw new Error('Сначала введите описание');
    const endpoint = settings.promptGenEndpoint || settings.endpoint;
    const apiKey = settings.promptGenApiKey || settings.apiKey;
    const model = settings.promptGenModel;
    if (!endpoint || !apiKey || !model) throw new Error('Для AI-уточнения настройте модель промпта (раздел «Генерация промпта»)');
    const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
        method: 'POST',
        headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
            model,
            temperature: 0.4,
            max_tokens: 400,
            messages: [{
                role: 'user',
                content: 'Rewrite the following character appearance notes into a concise English description for an image model. Focus on body type, height, proportions, skin tone, face, hair and clothing details if present. 2-5 sentences, no preamble, no markdown.\n\n' + source,
            }],
        }),
        signal,
    });
    if (!response.ok) throw new Error(`Prompt API (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`);
    const result = await response.json();
    const refined = result.choices?.[0]?.message?.content?.trim();
    if (!refined) throw new Error('Модель вернула пустой ответ');
    return refined;
}

function buildRefGenImageRefs(state = {}) {
    const refs = [];
    const name = String(state.name || '').trim() || 'Character';
    if (state.characterImage) refs.push({ type: 'face', name, data: state.characterImage, mimeType: detectMimeType(state.characterImage) });
    if (state.outfitImage) refs.push({ type: 'clothing', name, outfitName: 'outfit', description: 'copy the outfit only, not the face or body', data: state.outfitImage, mimeType: detectMimeType(state.outfitImage) });
    return refs;
}

async function imageResultToBase64(result) {
    let value = String(result || '');
    if (/^https?:\/\//i.test(value)) {
        const blob = await (await fetch(value)).blob();
        value = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(String(reader.result || ''));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }
    const base64 = value.startsWith('data:') ? value.split(',')[1] : value;
    if (!base64) throw new Error('Не удалось прочитать картинку из ответа');
    return base64;
}

/** Generates the reference via the main image API or the custom one. Returns raw base64. */
async function generateReferenceImage(state, onStatus, signal) {
    const settings = getSettings();
    const prompt = String(state.finalPrompt || '').trim() || buildReferenceGenPrompt(state);
    const imageRefs = buildRefGenImageRefs(state);

    if (settings.refGenSource === 'custom') {
        if (!settings.refGenEndpoint || !settings.refGenApiKey || !settings.refGenModel) {
            throw new Error('Заполните endpoint, ключ и модель генератора референсов');
        }
        onStatus?.('Генерация (свой API)...');
        const content = [{ type: 'text', text: prompt }];
        for (const ref of imageRefs) content.push({ type: 'image_url', image_url: { url: `data:${ref.mimeType};base64,${ref.data}` } });
        const response = await fetch(buildOpenAIUrl(settings.refGenEndpoint, 'chat/completions'), {
            method: 'POST',
            headers: buildAuthHeaders(settings.refGenApiKey, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ model: settings.refGenModel, messages: [{ role: 'user', content }], modalities: ['image', 'text'] }),
            signal,
        });
        if (!response.ok) throw new Error(`API (${response.status}): ${(await response.text().catch(() => '')).slice(0, 300)}`);
        const image = parseImageFromApiResponse(await response.json());
        if (!image) throw new Error('В ответе нет картинки');
        return imageResultToBase64(image);
    }

    if (['novelai', 'novelai-direct'].includes(settings.apiType) && imageRefs.length) {
        toastr.warning('NovelAI не принимает картинки-референсы: будет использован только текст', 'Генератор');
    }
    const refData = { imageRefs, textOnlyClothing: [], textDirectives: [], warnings: [] };
    const result = await generateImageWithRetry(prompt, '', onStatus, { refData, negativePrompt: '', aspectRatio: '2:3', signal });
    return imageResultToBase64(result);
}

/** Saves the generated reference as a wardrobe item, keeping description and prompt for later edits. */
function saveGeneratedReference(state, resizedImage) {
    if (!resizedImage) throw new Error('Сначала сгенерируйте картинку');
    const target = state.target === 'user' || isRpgWardrobeTarget(state.target) ? state.target : 'char';
    const name = String(state.itemName || '').trim() || `Референс ${String(state.name || '').trim() || ''}`.trim();
    const item = addWardrobeItem(name, resizedImage, target, state.category || 'full');
    item.description = String(state.refinedDescription || state.description || '').trim();
    item.refGen = {
        sourceDescription: String(state.description || ''),
        refinedDescription: String(state.refinedDescription || ''),
        finalPrompt: String(state.finalPrompt || ''),
        flags: normalizeRefGenFlags(state.flags),
        createdAt: Date.now(),
    };
    saveSettings();
    return item;
}

// ============================================================
// API PRESETS SYSTEM
// ============================================================

const PRESET_FIELDS = [
    'apiType', 'endpoint', 'apiKey', 'model',
    'size', 'quality', 'aspectRatio', 'imageSize',
    'naisteraModel', 'naisteraAspectRatio', 'naisteraNegativePrompt',
    'naisteraPreset', 'naisteraCharacterDescriptionsMode',
    'naisteraSendCharAvatar', 'naisteraSendUserAvatar',
    'naisteraPolling', 'naisteraPollIntervalMs', 'naisteraPollTimeoutMs',
    'novelaiModel', 'novelaiWidth', 'novelaiHeight', 'novelaiSteps',
    'novelaiScale', 'novelaiSampler', 'novelaiScheduler', 'novelaiNegativePrompt',
    'novelaiSeed', 'novelaiSm', 'novelaiSmDyn', 'novelaiDecrisper', 'novelaiVarietyBoost'
];

function saveCurrentAsPreset(name) {
    const settings = getSettings();
    const preset = {
        id: 'preset_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
        name: name || 'Preset',
        createdAt: Date.now(),
    };
    for (const field of PRESET_FIELDS) {
        preset[field] = settings[field];
    }
    settings.apiPresets.push(preset);
    settings.activePresetId = preset.id;
    saveSettings();
    return preset;
}

const NOVELAI_API_TYPES = Object.freeze(['novelai', 'novelai-direct']);

/**
 * A preset only owns the provider fields of its own API type: choosing a Gemini/router preset must not touch the
 * NovelAI negative, size or steps (and the other way round). Common fields (API type, endpoint, key, model…) always apply.
 */
function presetFieldApplies(field, apiType) {
    if (field.startsWith('novelai')) return NOVELAI_API_TYPES.includes(apiType);
    if (field.startsWith('naistera')) return apiType === 'naistera';
    return true;
}

function loadPreset(presetId) {
    const settings = getSettings();
    const preset = settings.apiPresets.find(p => p.id === presetId);
    if (!preset) return false;
    for (const field of PRESET_FIELDS) {
        if (Object.hasOwn(preset, field) && presetFieldApplies(field, preset.apiType)) {
            settings[field] = preset[field];
        }
    }
    settings.activePresetId = presetId;
    saveSettings();
    return true;
}

/**
 * Live presets: while a preset is selected, every edit of its fields is written into it, so nothing «resets»
 * the next time the preset is chosen (no need to press «Обновить пресет»). Switching to another API type while a
 * preset is selected detaches the preset instead of rewriting it.
 */
function syncActivePresetFromSettings(settings) {
    if (!settings?.activePresetId || !Array.isArray(settings.apiPresets)) return;
    const preset = settings.apiPresets.find(p => p.id === settings.activePresetId);
    if (!preset) { settings.activePresetId = null; return; }
    if (preset.apiType && settings.apiType !== preset.apiType) {
        settings.activePresetId = null;
        const select = typeof document !== 'undefined' ? document.getElementById('iig_preset_select') : null;
        if (select) select.value = '';
        return;
    }
    for (const field of PRESET_FIELDS) {
        if (presetFieldApplies(field, preset.apiType)) preset[field] = settings[field];
    }
}

function deletePreset(presetId) {
    const settings = getSettings();
    settings.apiPresets = settings.apiPresets.filter(p => p.id !== presetId);
    if (settings.activePresetId === presetId) settings.activePresetId = null;
    saveSettings();
}

function updatePresetFromCurrent(presetId) {
    const settings = getSettings();
    const preset = settings.apiPresets.find(p => p.id === presetId);
    if (!preset) return;
    for (const field of PRESET_FIELDS) {
        preset[field] = settings[field];
    }
    saveSettings();
}

function renderPresetSelect() {
    const settings = getSettings();
    const select = document.getElementById('iig_preset_select');
    if (!select) return;
    const currentVal = settings.activePresetId || '';
    select.innerHTML = '<option value="">-- без пресета --</option>';
    for (const p of settings.apiPresets) {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        opt.selected = p.id === currentVal;
        select.appendChild(opt);
    }
}

// ============================================================
// FAQ / HELP HINTS
// ============================================================

const FAQ_HINTS = Object.freeze({
    display_mode: {
        '#iig_image_display_mode': 'Инлайн: картинка между абзацами. Внешние блоки: картинки внутри HTML-артефактов.',
        '#iig_inject_image_mode': 'Если prompt.md уже в пресете — выключите, чтобы не дублировать инструкцию.',
        '#iig_image_mode_depth': 'На сколько сообщений от конца чата вставлять инструкцию (0 = после последнего).',
    },
    api: {
        '#iig_api_type': 'OpenAI-совместимые, Gemini (через nano-banana), Naistera, NovelAI.',
        '#iig_endpoint': 'URL API (например, https://api.openai.com/v1 или локальный прокси).',
        '#iig_model': 'Имя модели (dall-e-3, flux-1.1-pro и т.д.).',
        '#iig_aspect_ratio': 'Соотношение сторон. Тег в промпте имеет приоритет.',
        '#iig_image_size': 'Разрешение. 1K, 2K или 4K (поддержка зависит от модели).',
    },
    prompt_generator: {
        '#iig_prompt_gen_endpoint': 'Endpoint модели, которая генерирует prompt картинки из сообщения.',
        '#iig_prompt_instruction_select': 'Шаблон инструкции (обычная картинка, комикс и т.д.).',
        '#iig_prompt_gen_max_tokens': 'Максимальная длина prompt (64–4000).',
    },
    style: {
        '#iig_default_style': 'Стиль по умолчанию (например, "anime", "3d render"). Можно оставить пустым.',
        '#iig_style_prompt': 'Текст, который добавится к prompt при выборе этого стиля.',
    },
    avatars: {
        '#iig_auto_detect_names': 'Авто-поиск имён в промпте и отправка их лиц как референсов.',
        '#iig_send_char_avatar': 'Отправлять лицо персонажа как референс во все промпты (даже если имя не упомянуто).',
        '#iig_send_user_avatar': 'Отправлять лицо юзера как референс во все промпты.',
    },
    wardrobe_char: {
        '#iig_wardrobe_char_name': 'Название outfit (пальто, летнее платье и т.д.).',
        '#iig_wardrobe_char_file': 'Загрузить картинку outfit. Система опишет её через vision API.',
    },
    wardrobe_inject: {
        '#iig_inject_wardrobe': 'Вставлять описание активной одежды в промпт чата.',
        '#iig_wardrobe_send_mode': 'Что отправлять в генерацию картинок: фото одежды с текстом или только текст.',
        '#iig_wardrobe_injection_depth': 'На сколько сообщений от конца чата вставлять описание одежды.',
    },
    vision: {
        '#iig_wardrobe_desc_endpoint': 'API для vision-описаний (GPT-4o, Claude 3.5 Sonnet и т.д.).',
        '#iig_wardrobe_desc_prompt': 'Инструкция для vision модели: что описывать на картинке outfit.',
    },
    refgen: {
        _section: 'Отдельный API для вкладки «Генератор» в гардеробе. Если поля пустые, используется основной API. В самой вкладке источник переключается между «основной» и «этот».',
        '#iig_refgen_endpoint': 'URL OpenAI-совместимого API для референсов (например, https://api.example.com/v1).',
        '#iig_refgen_api_key': 'Ключ этого API. Хранится в настройках SillyTavern, кнопка с глазом показывает его.',
        '#iig_refgen_model': 'Модель для картинок-референсов. AI-уточнение описания идёт через модель из «Генерации промпта».',
    },
    wardrobe_user: {
        _section: 'Одежда юзера. Для RPG-персонажей наряды добавляются кнопкой «+» прямо в гардеробе, на их вкладке.',
    },
    hairstyle_mode: {
        _section: 'Что отправлять в генерацию для причёсок: картинку с текстом, только текст или ничего.',
    },
    npc: {
        _section: 'Дополнительные персонажи (NPC). Если их имя упомянуто в промпте, система отправит их лица как референсы.',
    },
    character_library: {
        _section: 'Профили персонажей и юзера. Включают лицо, описание внешности и RPG-режим с несколькими телами.',
    },
    errors: {
        '#iig_max_retries': 'Сколько раз повторять запрос при ошибке сети (0 = не повторять).',
        '#iig_retry_delay': 'Задержка между попытками (мс).',
        '#iig_request_timeout': 'Таймаут запроса (сек). Увеличьте для медленных моделей.',
    },
});

let activeFaqSection = null;

function clearFaqHints() {
    document.querySelectorAll('.iig-faq-hint').forEach(hint => hint.remove());
    document.querySelectorAll('.iig-collapsible.iig-hints-open').forEach(section => section.classList.remove('iig-hints-open'));
    document.querySelectorAll('.iig-faq-highlight').forEach(el => el.classList.remove('iig-faq-highlight'));
    document.querySelectorAll('.iig-faq-btn.iig-faq-active').forEach(btn => {
        btn.classList.remove('iig-faq-active');
        btn.setAttribute('aria-pressed', 'false');
    });
}

function toggleFaqHints(sectionId, button) {
    const section = button?.closest('.iig-collapsible');
    const wasActive = activeFaqSection === sectionId;
    clearFaqHints();
    activeFaqSection = null;
    if (wasActive || !section) return;

    // The section's own hint texts (p.hint) are hidden until «?» is pressed.
    const hints = FAQ_HINTS[sectionId] || {};
    activeFaqSection = sectionId;
    section.classList.add('iig-hints-open');
    button.classList.add('iig-faq-active');
    button.setAttribute('aria-pressed', 'true');

    // Hints are only visible inside an expanded section.
    if (section.classList.contains('collapsed')) section.classList.remove('collapsed');

    const content = section.querySelector('.iig-collapsible-content');
    // A section with its own hint text does not need the short FAQ line on top as well.
    if (hints._section && content && !content.querySelector('p.hint')) {
        const badge = document.createElement('div');
        badge.className = 'iig-faq-hint iig-faq-section-hint';
        badge.setAttribute('role', 'note');
        badge.textContent = hints._section;
        content.insertBefore(badge, content.firstChild);
    }

    for (const [selector, text] of Object.entries(hints)) {
        if (selector === '_section') continue;
        const target = section.querySelector(selector);
        if (!target) continue;
        target.classList.add('iig-faq-highlight');
        const badge = document.createElement('div');
        badge.className = 'iig-faq-hint';
        badge.setAttribute('role', 'note');
        badge.textContent = text;
        const row = target.closest('.flex-row, .checkbox_label') || target;
        row.insertAdjacentElement('afterend', badge);
    }
}

function closeFaqHints() {
    if (!activeFaqSection) return false;
    clearFaqHints();
    activeFaqSection = null;
    return true;
}

let faqEscBound = false;

function initFaqButtons() {
    document.querySelectorAll('#extensions_settings .iig-collapsible-header').forEach(header => {
        const section = header.closest('.iig-collapsible');
        const sectionId = section?.dataset.sectionId;
        // «?» for every section with hints: FAQ lines or its own hint texts, which stay hidden until it is pressed.
        if (!sectionId || header.querySelector('.iig-faq-btn')) return;
        if (!FAQ_HINTS[sectionId] && !section.querySelector('p.hint')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'iig-faq-btn';
        button.dataset.sectionId = sectionId;
        button.title = 'Подсказки по разделу';
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-pressed', 'false');
        button.innerHTML = '<i class="fa-solid fa-circle-question" aria-hidden="true"></i>';
        // Do not let the click (or Enter/Space) toggle the section collapse.
        button.addEventListener('click', event => {
            event.stopPropagation();
            toggleFaqHints(sectionId, button);
        });
        header.appendChild(button);
    });
    if (faqEscBound) return;
    faqEscBound = true;
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && closeFaqHints()) event.stopPropagation();
    });
}

// ============================================================
// TABBED SETTINGS LAYOUT
// ============================================================
// The settings markup is still a flat list of .iig-collapsible sections (all ids and bindings stay the
// same). organizeSettingsTabs() moves those sections into tabs → sub-tabs so only one block is visible
// at a time instead of a long column of collapsible rows.
// A sub-tab either lists `sections`, or has `byTarget` — then a Персонаж / Юзер switch picks the section.

const SETTINGS_TABS = Object.freeze([
    { id: 'main', label: 'Основное', icon: 'fa-sliders', subs: [
        { id: 'api', label: 'API', icon: 'fa-plug', sections: ['api'] },
        { id: 'display', label: 'Отображение', icon: 'fa-image', sections: ['display_mode'] },
        { id: 'errors', label: 'Повторы и логи', icon: 'fa-gear', sections: ['errors'] },
    ] },
    { id: 'people', label: 'Персонажи', icon: 'fa-users', subs: [
        { id: 'profiles', label: 'Профили персонажей', icon: 'fa-id-card', sections: ['character_library'] },
        { id: 'npc', label: 'NPC', icon: 'fa-masks-theater', sections: ['npc'] },
        { id: 'refgen', label: 'API рефов', icon: 'fa-dna', sections: ['refgen'] },
    ] },
    { id: 'prompt', label: 'Промпт и стиль', icon: 'fa-wand-magic-sparkles', subs: [
        { id: 'generator', label: 'Генератор промпта', icon: 'fa-wand-magic-sparkles', sections: ['prompt_generator'] },
        { id: 'style', label: 'Стили и негативы', icon: 'fa-palette', sections: ['style'] },
    ] },
    { id: 'wardrobe', label: 'Гардероб', icon: 'fa-shirt', subs: [
        { id: 'outfits', label: 'Наряды', icon: 'fa-shirt', byTarget: { char: 'wardrobe_char', user: 'wardrobe_user' } },
        { id: 'hair', label: 'Причёски', icon: 'fa-scissors', byTarget: { char: 'hairstyle_char', user: 'hairstyle_user' } },
        { id: 'send', label: 'Отправка', icon: 'fa-paper-plane', sections: ['wardrobe_inject', 'hairstyle_mode'] },
        { id: 'vision', label: 'Описание по фото', icon: 'fa-eye', sections: ['vision'] },
    ] },
]);

const SETTINGS_TARGETS = Object.freeze([
    { id: 'char', label: 'Персонаж', icon: 'fa-user' },
    { id: 'user', label: 'Юзер', icon: 'fa-user-pen' },
]);

function getSettingsUiState(settings = getSettings()) {
    const state = settings.settingsUiState && typeof settings.settingsUiState === 'object' ? settings.settingsUiState : {};
    if (!SETTINGS_TABS.some(tab => tab.id === state.tab)) state.tab = SETTINGS_TABS[0].id;
    if (!state.sub || typeof state.sub !== 'object') state.sub = {};
    if (!SETTINGS_TARGETS.some(t => t.id === state.target)) state.target = 'char';
    settings.settingsUiState = state;
    return state;
}

function buildSettingsTabButton(cls, id, label, icon, active) {
    return `<button type="button" class="${cls}${active ? ' iig-active' : ''}" data-id="${escapeHtml(id)}" role="tab" aria-selected="${active}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;
}

function organizeSettingsTabs() {
    const root = document.querySelector('#iig_settings_root .inline-drawer-content');
    if (!root || root.querySelector('.iig-settings-tabs')) return;

    const sectionById = new Map();
    root.querySelectorAll(':scope > .iig-collapsible').forEach(section => sectionById.set(section.dataset.sectionId, section));

    const nav = document.createElement('div');
    nav.className = 'iig-settings-tabs';
    nav.setAttribute('role', 'tablist');
    const panes = document.createElement('div');
    panes.className = 'iig-settings-panes';

    for (const tab of SETTINGS_TABS) {
        nav.insertAdjacentHTML('beforeend', buildSettingsTabButton('iig-settings-tab', tab.id, tab.label, tab.icon, false));
        const pane = document.createElement('div');
        pane.className = 'iig-settings-pane';
        pane.dataset.tab = tab.id;
        pane.innerHTML = `
            <div class="iig-settings-subtabs" role="tablist">${tab.subs.map(sub => buildSettingsTabButton('iig-settings-subtab', sub.id, sub.label, sub.icon, false)).join('')}</div>
            ${tab.subs.some(sub => sub.byTarget) ? `<div class="iig-settings-target" role="tablist" aria-label="Чей">${SETTINGS_TARGETS.map(t => buildSettingsTabButton('iig-settings-target-btn', t.id, t.label, t.icon, false)).join('')}</div>` : ''}
            <div class="iig-settings-pane-body"></div>`;
        const body = pane.querySelector('.iig-settings-pane-body');
        for (const sub of tab.subs) {
            const ids = sub.byTarget ? Object.values(sub.byTarget) : sub.sections;
            for (const id of ids) {
                const section = sectionById.get(id);
                if (!section) continue;
                section.classList.add('iig-in-tab');
                section.classList.remove('collapsed');
                section.dataset.tabSub = sub.id;
                body.appendChild(section);
                sectionById.delete(id);
            }
        }
        panes.appendChild(pane);
    }

    // Anything not mapped to a tab (e.g. a section added later) stays visible in «Основное».
    const leftovers = [...sectionById.values()];
    root.appendChild(nav);
    root.appendChild(panes);
    const mainBody = panes.querySelector('.iig-settings-pane[data-tab="main"] .iig-settings-pane-body');
    leftovers.forEach(section => mainBody?.appendChild(section));

    nav.addEventListener('click', event => {
        const button = event.target.closest('.iig-settings-tab');
        if (!button) return;
        getSettingsUiState().tab = button.dataset.id;
        applySettingsTabs();
        saveSettings();
    });
    panes.addEventListener('click', event => {
        const subButton = event.target.closest('.iig-settings-subtab');
        const targetButton = event.target.closest('.iig-settings-target-btn');
        if (!subButton && !targetButton) return;
        const state = getSettingsUiState();
        if (subButton) state.sub[subButton.closest('.iig-settings-pane').dataset.tab] = subButton.dataset.id;
        if (targetButton) state.target = targetButton.dataset.id;
        applySettingsTabs();
        saveSettings();
    });

    applySettingsTabs();
}

function applySettingsTabs() {
    const root = document.querySelector('#iig_settings_root');
    if (!root) return;
    const state = getSettingsUiState();
    const setActive = (button, active) => {
        button.classList.toggle('iig-active', active);
        button.setAttribute('aria-selected', String(active));
    };

    for (const tab of SETTINGS_TABS) {
        const pane = root.querySelector(`.iig-settings-pane[data-tab="${tab.id}"]`);
        if (!pane) continue;
        const tabActive = state.tab === tab.id;
        pane.hidden = !tabActive;
        const tabButton = root.querySelector(`.iig-settings-tab[data-id="${tab.id}"]`);
        if (tabButton) setActive(tabButton, tabActive);

        const sub = tab.subs.find(s => s.id === state.sub[tab.id]) || tab.subs[0];
        pane.querySelectorAll('.iig-settings-subtab').forEach(b => setActive(b, b.dataset.id === sub.id));
        const targetRow = pane.querySelector('.iig-settings-target');
        if (targetRow) {
            targetRow.hidden = !sub.byTarget;
            targetRow.querySelectorAll('.iig-settings-target-btn').forEach(b => setActive(b, b.dataset.id === state.target));
        }
        const visible = new Set(sub.byTarget ? [sub.byTarget[state.target]] : sub.sections);
        pane.querySelectorAll('.iig-settings-pane-body > .iig-collapsible').forEach(section => {
            const known = section.classList.contains('iig-in-tab');
            section.hidden = known ? !visible.has(section.dataset.sectionId) : false;
        });
    }
}

// ============================================================
// COLLAPSIBLE SECTIONS
// ============================================================

function initCollapsibleSections() {
    const settings = getSettings();
    document.querySelectorAll('.iig-collapsible-header').forEach(header => {
        const section = header.closest('.iig-collapsible');
        if (!section) return;
        // Sections inside the tabbed layout are always expanded; the header is just a title + FAQ button.
        if (section.classList.contains('iig-in-tab')) return;
        const sectionId = section.dataset.sectionId;

        // Restore saved state
        if (sectionId && settings.collapsedSections[sectionId]) {
            section.classList.add('collapsed');
        }

        header.addEventListener('click', () => {
            section.classList.toggle('collapsed');
            if (sectionId) {
                settings.collapsedSections[sectionId] = section.classList.contains('collapsed');
                saveSettings();
            }
        });
    });
}

// ============================================================
// NAME DETECTION
// ============================================================

// ============================================================
// NAME MATCHING (who is in the picture?)
// ============================================================
// A reference (face / outfit / appearance text) is sent only for people the image prompt actually mentions.
// - A name field may hold several names: "Иван Петров, Ваня, Ivan" (separators: , ; | / or new line).
// - Every name also counts by its separate words ("Петров" alone matches "Иван Петров"), except titles and
//   generic placeholders ("user", "персонаж", "Lord", "капитан"…), which never trigger on their own.
// - Cyrillic names are also searched in Latin transliteration, because chat models write image prompts in English.
// - Russian case endings are tolerated ("Ева" also finds "Еву", "Евой").
// - Word boundaries are Unicode-aware (plain \b only knows Latin letters).

const NAME_IGNORED_WORDS = new Set([
    'user', 'char', 'character', 'persona', 'you', 'me', 'npc', 'bot', 'the', 'and', 'of', 'man', 'woman', 'girl', 'boy',
    'mr', 'mrs', 'ms', 'miss', 'sir', 'lady', 'lord', 'king', 'queen', 'prince', 'princess', 'captain', 'capt', 'major',
    'colonel', 'lt', 'lieutenant', 'sergeant', 'doctor', 'dr', 'professor', 'prof', 'officer', 'detective', 'agent',
    'юзер', 'пользователь', 'персонаж', 'персона', 'бот', 'нпс', 'господин', 'госпожа', 'капитан', 'майор', 'полковник',
    'лейтенант', 'сержант', 'доктор', 'профессор', 'король', 'королева', 'принц', 'принцесса', 'лорд', 'леди',
]);

const RU_TO_LATIN = Object.freeze({
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
});

/** SillyTavern can store Cyrillic inside the image tag attribute as &#1040;… — turn it back into letters. */
function decodeNumericEntities(text) {
    const value = String(text ?? '');
    if (!value.includes('&#')) return value;
    return value
        .replace(/&#x([0-9a-f]+);/gi, (match, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return match; } })
        .replace(/&#(\d+);/g, (match, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return match; } });
}

function transliterateRu(text) {
    return String(text || '').toLowerCase().replace(/[а-яё]/g, letter => RU_TO_LATIN[letter] ?? letter);
}

/** "Иван Петров, Ваня; Ivan" → ['Иван Петров', 'Ваня', 'Ivan'] */
function splitNameList(value) {
    const list = Array.isArray(value) ? value : [value];
    return list.flatMap(item => String(item ?? '').split(/[,;|/\n]+/)).map(name => name.trim()).filter(Boolean);
}

/**
 * All strings that should count as a mention of this person: Map<text, isTransliteration>.
 * Transliterations are matched loosely (see latinSpellingPattern), because «Эвелин Гринвелл» is written
 * "Eveline Grinwell" in English, «Андрей» — "Andrei", «Ксения» — "Xenia", «Орехов» — "Orehov" or "Orekhov".
 */
function buildNameVariants(names) {
    const variants = new Map();
    const add = raw => {
        const value = String(raw || '').trim().toLowerCase();
        if (value.length < 2 || NAME_IGNORED_WORDS.has(value) || /^\{\{.*\}\}$/.test(value)) return;
        if (!variants.has(value)) variants.set(value, false);
        if (/[а-яё]/.test(value)) {
            const latin = transliterateRu(value);
            if (latin.length >= 2 && !NAME_IGNORED_WORDS.has(latin) && !variants.has(latin)) variants.set(latin, true);
        }
    };
    for (const name of splitNameList(names)) {
        add(name);
        const words = name.split(/\s+/).filter(Boolean);
        if (words.length > 1) for (const word of words) if (word.replace(/[^\p{L}]/gu, '').length >= 3) add(word);
    }
    return variants;
}

const LATIN_SPELLING_ALTERNATIVES = Object.freeze({
    shch: '(?:shch|sch|sh)', kh: '(?:kh|h)', ks: '(?:ks|x)', ts: '(?:ts|tz|c)', iya: '(?:iya|ia|ija)',
    yu: '(?:yu|iu|ju|u)', ya: '(?:ya|ia|ja)', ey: '(?:ey|ei|ej|y)', v: '[vw]', y: '[yij]',
});

/** Loose pattern for an automatic transliteration: v/w, kh/h, ks/x…, plus up to 2 extra letters at the end (Evelin → Eveline). */
function latinSpellingPattern(latin) {
    return latin.split(/\s+/).map((word, index, words) => {
        const body = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/shch|kh|ks|ts|iya|yu|ya|ey|v|y/g, match => LATIN_SPELLING_ALTERNATIVES[match]);
        return index === words.length - 1 && word.length >= 4 ? `${body}[a-z]{0,2}` : body;
    }).join('\\s+');
}

function nameVariantPattern(variant, isTransliteration = false) {
    if (isTransliteration && /^[a-z\s]+$/.test(variant)) return latinSpellingPattern(variant);
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    // Russian declension: a single Cyrillic word ending in a vowel/й/ь may change that ending (Ева → Еву, Евой).
    if (/^[а-яё]{3,}$/.test(variant) && /[аеёиоуыэюяйь]$/.test(variant)) {
        return `${escaped.slice(0, -1)}[а-яё]{0,3}`;
    }
    if (/^[а-яё]{4,}$/.test(variant)) return `${escaped}[а-яё]{0,3}`;
    return escaped;
}

/**
 * Names that are also ordinary words or image tags ("messy bob" haircut, "rose", "ivy", "will").
 * Such a name counts only when it is written with a capital letter: "Bob" is a person, "bob" is a haircut.
 */
const NAME_COMMON_WORDS = new Set([
    'bob', 'rob', 'bill', 'will', 'mark', 'jack', 'max', 'ray', 'art', 'frank', 'dean', 'drew', 'guy', 'gene', 'pat', 'rich',
    'nick', 'miles', 'chase', 'hunter', 'archer', 'mason', 'cooper', 'cliff', 'chip', 'bud', 'buddy', 'buck', 'colt', 'rex',
    'rocky', 'rusty', 'dusty', 'sandy', 'penny', 'sunny', 'misty', 'sky', 'skye', 'rain', 'storm', 'snow', 'river', 'reed',
    'stone', 'dawn', 'eve', 'may', 'june', 'april', 'august', 'summer', 'autumn', 'winter', 'faith', 'hope', 'grace', 'joy',
    'rose', 'lily', 'iris', 'violet', 'daisy', 'ivy', 'holly', 'hazel', 'amber', 'ruby', 'pearl', 'jade', 'coral', 'crystal',
    'ginger', 'honey', 'candy', 'cherry', 'olive', 'sage', 'fern', 'willow', 'ash', 'robin', 'wren', 'jay', 'raven', 'kitty',
    'bunny', 'angel', 'baby', 'doll', 'star', 'scarlet', 'scarlett', 'blue', 'red', 'silver', 'ebony', 'coco', 'sugar',
    'cookie', 'pepper', 'page', 'bambi', 'goldie', 'brandy', 'destiny', 'dot', 'flora', 'fawn',
    'роза', 'лилия', 'вера', 'надежда', 'любовь', 'лев', 'слава', 'мир', 'роман', 'заря', 'звезда',
]);

/** Regexps for every spelling of the names. `atStart` — only at the very beginning of the text (one tag). */
function nameRegexps(names, atStart = false) {
    const before = atStart ? '^\\s*' : '(?<![\\p{L}\\p{N}_])';
    return [...buildNameVariants(names)].map(([variant, isTransliteration]) => {
        const pattern = nameVariantPattern(variant, isTransliteration);
        if (NAME_COMMON_WORDS.has(variant)) {
            const capitalized = pattern.charAt(0).toUpperCase() + pattern.slice(1);
            return new RegExp(`${before}(?:${capitalized}|${variant.toUpperCase()})(?![\\p{L}\\p{N}_])`, 'u');
        }
        return new RegExp(`${before}${pattern}(?![\\p{L}\\p{N}_])`, 'iu');
    });
}

/** True when any of the names (or their words / transliterations) is mentioned in the prompt. */
function namesAppearInPrompt(names, prompt) {
    const text = decodeNumericEntities(prompt);
    if (!text) return false;
    return nameRegexps(names).some(regexp => regexp.test(text));
}

/**
 * Index of the first comma-separated tag that STARTS with one of the names ("Eveline", "Eveline smiling"), or -1.
 * "looking at Eveline" only mentions her — such a part of the prompt is about somebody else.
 */
function nameLeadsTagIndex(names, prompt) {
    const tags = decodeNumericEntities(prompt).split(',');
    const regexps = nameRegexps(names, true);
    return tags.findIndex(tag => regexps.some(regexp => regexp.test(tag)));
}

function nameAppearsInPrompt(name, prompt) {
    return namesAppearInPrompt([name], prompt);
}

/** NPC name + its «Другие имена» (array in old data, or a comma-separated string). */
function getNpcAliases(npc) {
    return splitNameList(npc?.aliases || []);
}

const NAME_VARIANTS_MAX = 20;

/** Request text for the «Сгенерировать имена» button: how this person's name can be written in RU/EN image prompts. */
function buildNameVariantsRequest(name, existing = [], context = '') {
    const known = splitNameList(existing);
    const notes = String(context || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
    return [
        `Character name: ${String(name || '').trim()}`,
        known.length ? `Already known variants: ${known.join(', ')}` : null,
        notes ? `Character notes (look only for nicknames of THIS character): ${notes}` : null,
        '',
        'List how this character can be named in an image prompt written in English or in Russian:',
        '- full name, first name and surname, in the original script;',
        '- the same in English (Latin) spelling and in Russian (Cyrillic) spelling, with the usual transliteration;',
        '- common short forms of the first name (e.g. Aleksey → Alyosha, Lyosha; Алексей → Лёша) and nicknames from the notes.',
        'Do not add other characters, titles, roles, pronouns or generic words (girl, man, boss).',
        `Answer with ONE comma-separated line, at most ${NAME_VARIANTS_MAX} items, no numbering, no explanation.`,
    ].filter(line => line !== null).join('\n');
}

/** Model answer → name list, merged after the existing names (no duplicates, no repeat of the main name). */
function parseGeneratedNameList(text, existing = [], mainName = '') {
    const body = String(text || '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/```[a-z]*\n?|```/gi, '');
    const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
    const listLines = lines.filter(line => line.includes(','));
    const candidates = splitNameList(listLines.length ? listLines.join(',') : lines.join(','))
        .map(item => item
            .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')
            .replace(/^[^:]{0,40}:\s*/, '')
            .replace(/^["'«“„]+|["'»”.!]+$/g, '')
            .trim())
        .filter(item => item.length >= 2 && item.length <= 40 && item.split(/\s+/).length <= 4)
        .filter(item => /\p{L}/u.test(item) && !/[<>{}[\]=]/.test(item))
        .filter(item => !NAME_IGNORED_WORDS.has(item.toLowerCase()));
    const seen = new Set([String(mainName || '').trim().toLowerCase()]);
    const result = [];
    for (const item of [...splitNameList(existing), ...candidates]) {
        const key = item.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result.slice(0, Math.max(NAME_VARIANTS_MAX, splitNameList(existing).length));
}

/** Short text answer: the wardrobe-description model if it is set up, otherwise the main chat model of SillyTavern. */
async function generateShortTextWithModel(promptText, { maxTokens = 600 } = {}) {
    const settings = getSettings();
    const endpoint = settings.wardrobeDescEndpoint || settings.endpoint;
    const apiKey = settings.wardrobeDescApiKey || settings.apiKey;
    const model = settings.wardrobeDescModel;
    if (endpoint && apiKey && model) {
        const response = await fetch(buildOpenAIUrl(endpoint, 'chat/completions'), {
            method: 'POST',
            headers: buildAuthHeaders(apiKey, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'user', content: promptText }] }),
        });
        if (!response.ok) throw new Error(`API ошибка (${response.status}): ${(await response.text().catch(() => '?')).slice(0, 300)}`);
        const result = await response.json();
        const text = result.choices?.[0]?.message?.content;
        const answer = (Array.isArray(text) ? text.map(part => part?.text || '').join('') : String(text || '')).trim();
        if (!answer) throw new Error('Модель вернула пустой ответ');
        return answer;
    }
    const context = SillyTavern.getContext();
    if (typeof context.generateRaw !== 'function') {
        throw new Error('Выберите модель в «Описание гардероба» или подключите модель чата в SillyTavern');
    }
    const systemPrompt = 'You are a precise assistant. Follow the output format exactly.';
    // Newer SillyTavern takes one options object, older versions take positional arguments.
    const answer = context.generateRaw.length >= 2
        ? await context.generateRaw(promptText, null, false, false, systemPrompt, maxTokens)
        : await context.generateRaw({ prompt: promptText, systemPrompt, responseLength: maxTokens });
    if (!String(answer || '').trim()) throw new Error('Модель чата вернула пустой ответ');
    return String(answer).trim();
}

/** Asks the model for RU/EN spellings and short forms of a name; returns the merged list. */
async function generateNameVariants(name, existing = [], context = '') {
    const mainName = String(name || '').trim();
    if (!mainName) throw new Error('Сначала укажите имя');
    const answer = await generateShortTextWithModel(buildNameVariantsRequest(mainName, existing, context));
    const names = parseGeneratedNameList(answer, existing, mainName);
    iigLog('INFO', `Generated name variants for "${mainName}": ${names.join(', ')}`);
    return names;
}

/** Spinner on a «generate names» button while the request runs. */
async function runNameGenerationButton(button, task) {
    if (!button || button.disabled || button.classList.contains('disabled')) return;
    const html = button.innerHTML;
    button.disabled = true;
    button.classList.add('disabled');
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    try {
        await task();
    } catch (error) {
        iigLog('ERROR', `Name generation failed: ${error.message}`);
        toastr.error(`Ошибка: ${error.message}`, 'Имена');
    } finally {
        if (button.isConnected) {
            button.disabled = false;
            button.classList.remove('disabled');
            button.innerHTML = html;
        }
    }
}

// ============================================================
// 4-SLOT REFERENCE COLLECTOR
// ============================================================

const MAX_IMAGE_REFS = 4;

/**
 * Collects reference images with 4-slot priority system.
 * Priority: faces (char > user > NPCs) > clothing.
 * If clothing doesn't fit into 4 slots, it's returned as text-only.
 *
 * @param {string} prompt - Combined prompt text for name detection
 * @returns {{ imageRefs: Array, textOnlyClothing: Array, warnings: Array }}
 */
async function collectReferenceImages(prompt) {
    const settings = getSettings();
    const context = SillyTavern.getContext();

    const faceRefs = [];
    const clothingRefs = [];
    const textOnlyClothing = [];
    const textDirectives = [];
    const warnings = [];
    // Hairstyles and NPC outfits that belong to one person. NovelAI gets them inside that person's own prompt,
    // otherwise they are general tags and every figure in the picture wears them.
    const personTags = [];
    const personDirectives = new Set();
    const addPersonDirective = (name, description, directive, kind = 'outfit') => {
        textDirectives.push(directive);
        personDirectives.add(directive);
        personTags.push({ charName: name, description: String(description || '').trim(), kind });
    };

    const charName = context.characters?.[context.characterId]?.name || null;
    // The persona chosen in the extension, not the one active in SillyTavern.
    const userName = getExtensionPersona(settings).name || null;
    // A bot whose picture was taken from another card is also found by that card's name.
    const charOwner = getExtensionCharacter(settings);
    const charExtraNames = charOwner?.picked && charOwner.name !== charName ? [charOwner.name] : [];

    const characterLibrary = await collectCharacterProfileReferences('char', settings);
    const userLibrary = await collectCharacterProfileReferences('user', settings);

    // Who is in the picture? A bot/persona is included when its name (or one of its profile names) is mentioned
    // in the prompt, or when «Всегда отправлять» is on. Their face, appearance text, outfit and hairstyle all follow
    // this decision, so people who are not in the scene do not take reference slots.
    const textOnly = ['novelai', 'novelai-direct'].includes(settings.apiType);
    const useNaisteraRefs = settings.apiType === 'naistera';
    // «Всегда отправлять аватар» is about pictures; NovelAI gets no pictures, so there a bot/persona is added
    // only when the prompt mentions them (otherwise e.g. the bot's tags leak into a "2girls" scene without him).
    const charAlways = !textOnly && Boolean(useNaisteraRefs ? settings.naisteraSendCharAvatar : settings.sendCharAvatar);
    const userAlways = !textOnly && Boolean(useNaisteraRefs ? settings.naisteraSendUserAvatar : settings.sendUserAvatar);
    const charMentioned = Boolean(charName) && namesAppearInPrompt([charName, ...charExtraNames, ...characterLibrary.names], prompt);
    const userMentioned = Boolean(userName) && namesAppearInPrompt([userName, ...userLibrary.names], prompt);
    const includeChar = Boolean(charName) && (charAlways || (settings.autoDetectNames && charMentioned));
    const includeUser = Boolean(userName) && (userAlways || (settings.autoDetectNames && userMentioned));
    iigLog('INFO', `In scene: char "${charName}" ${includeChar ? 'yes' : 'no'} (mentioned: ${charMentioned}), user "${userName}" ${includeUser ? 'yes' : 'no'} (mentioned: ${userMentioned})`);

    if (includeChar) textDirectives.push(...characterLibrary.descriptions);
    if (includeUser) textDirectives.push(...userLibrary.descriptions);

    // People in the picture with their own appearance text — NovelAI puts each of them into a separate character prompt.
    // appearanceDirectives marks the generic "[... APPEARANCE]" lines so NovelAI can drop them in favour of `people`.
    const people = [];
    const appearanceDirectives = new Set([...characterLibrary.descriptions, ...userLibrary.descriptions]);
    if (includeChar) people.push({ name: charName, names: [charName, ...charExtraNames, ...characterLibrary.names], appearance: characterLibrary.appearance || '' });
    if (includeUser) people.push({ name: userName, names: [userName, ...userLibrary.names], appearance: userLibrary.appearance || '' });

    // RPG characters (multi-character bots)
    const rpgRefs = await collectRpgCharacterReferences(prompt, settings);
    textDirectives.push(...rpgRefs.descriptions);
    for (const directive of rpgRefs.descriptions || []) appearanceDirectives.add(directive);
    people.push(...(rpgRefs.people || []));

    // ===== STEP 1: Collect face references (HIGHEST PRIORITY) =====

    const needCharAvatar = !textOnly && includeChar && !characterLibrary.hasPrimary;
    if (includeChar && characterLibrary.refs.length > 0) faceRefs.push(...characterLibrary.refs);

    if (needCharAvatar) {
        const charAvatar = await getCharacterAvatarBase64();
        if (charAvatar) {
            const resized = await resizeImageBase64(charAvatar, 768);
            faceRefs.push({
                data: resized,
                mimeType: detectMimeType(resized),
                name: charName || 'Character',
                type: 'face'
            });
            iigLog('INFO', `Face ref: "${charName}" added (${Math.round(resized.length / 1024)}KB)`);
        }
    }

    const needUserAvatar = !textOnly && includeUser && !userLibrary.hasPrimary;
    if (includeUser && userLibrary.refs.length > 0) faceRefs.push(...userLibrary.refs);

    // RPG character face refs (NovelAI receives text descriptions only)
    if (!['novelai', 'novelai-direct'].includes(settings.apiType) && rpgRefs.refs.length > 0) {
        faceRefs.push(...rpgRefs.refs);
        iigLog('INFO', `Face refs: ${rpgRefs.refs.length} RPG character(s) added`);
    }

    if (needUserAvatar) {
        const userAvatar = await getUserAvatarBase64();
        if (userAvatar) {
            const resized = await resizeImageBase64(userAvatar, 768);
            faceRefs.push({
                data: resized,
                mimeType: detectMimeType(resized),
                name: userName || 'User',
                type: 'face'
            });
            iigLog('INFO', `Face ref: "${userName}" added (${Math.round(resized.length / 1024)}KB)`);
        }
    }

    // NPC faces + appearance + NPC outfits
    if (settings.npcReferences && settings.npcReferences.length > 0) {
        for (const npc of settings.npcReferences) {
            ensureNpcDefaults(npc);
            if (!npc.enabled || !npc.name) continue;
            if (!namesAppearInPrompt([npc.name, ...getNpcAliases(npc)], prompt)) continue;

            if (npc.imageData) {
                faceRefs.push({
                    data: npc.imageData,
                    mimeType: detectMimeType(npc.imageData),
                    name: npc.name,
                    type: 'face'
                });
                iigLog('INFO', `Face ref: NPC "${npc.name}" added (${Math.round(npc.imageData.length / 1024)}KB)`);
            }

            if (npc.appearance) {
                const directive = `[CHARACTER APPEARANCE for "${npc.name}"]: ${npc.appearance}`;
                textDirectives.push(directive);
                appearanceDirectives.add(directive);
            }
            people.push({ name: npc.name, names: [npc.name, ...getNpcAliases(npc)], appearance: npc.appearance || '' });

            const activeNpcOutfit = getActiveNpcOutfit(npc);
            if (activeNpcOutfit?.imageData) {
                clothingRefs.push({
                    data: activeNpcOutfit.imageData,
                    mimeType: detectMimeType(activeNpcOutfit.imageData),
                    name: npc.name,
                    outfitName: activeNpcOutfit.name,
                    description: activeNpcOutfit.description || '',
                    type: 'clothing'
                });
            } else if (activeNpcOutfit?.description) {
                addPersonDirective(npc.name, activeNpcOutfit.description, `[CLOTHING INSTRUCTION for "${npc.name}"]: ${npc.name} is wearing: ${activeNpcOutfit.description}`);
            } else if (npc.outfit) {
                addPersonDirective(npc.name, npc.outfit, `[CLOTHING INSTRUCTION for "${npc.name}"]: ${npc.name} is wearing: ${npc.outfit}`);
            }
        }
    }

    // ===== STEP 2: Collect clothing references =====

    const textOnlyProvider = ['novelai', 'novelai-direct'].includes(settings.apiType);
    const wardrobeMode = settings.wardrobeSendMode || 'both';
    const pushOutfit = (name, outfit) => {
        if (!outfit || wardrobeMode === 'none') return;
        if (outfit.imageData && wardrobeMode === 'both' && !textOnlyProvider) {
            clothingRefs.push({
                data: outfit.imageData, mimeType: detectMimeType(outfit.imageData),
                name, outfitName: outfit.name, description: outfit.description || '', type: 'clothing'
            });
        } else if (outfit.description?.trim()) {
            textOnlyClothing.push({ charName: name, outfitName: outfit.name, description: outfit.description });
        } else {
            warnings.push(`Одежда "${outfit.name}" для ${name} не отправлена: добавьте текстовое описание.`);
        }
    };
    // RPG characters mentioned in the prompt wear their own active outfits
    for (const { name, outfit } of (rpgRefs.outfits || [])) pushOutfit(name, outfit);

    for (const target of ['char', 'user']) {
        if (target === 'char' ? !includeChar : !includeUser) continue;
        const name = target === 'char' ? (charName || 'Character') : (userName || 'User');
        pushOutfit(name, getActiveWardrobeItem(target));

        const hairstyle = getActiveHairstyleItem(target);
        const hairMode = settings.hairstyleSendMode || 'both';
        if (hairstyle && hairMode !== 'none') {
            if (hairstyle.description?.trim()) {
                addPersonDirective(name, hairstyle.description, `[HAIRSTYLE INSTRUCTION for "${name}"]: ${hairstyle.description}`, 'hairstyle');
            }
            if (hairstyle.imageData && hairMode === 'both' && !textOnlyProvider) {
                clothingRefs.push({
                    data: hairstyle.imageData, mimeType: detectMimeType(hairstyle.imageData),
                    name, outfitName: hairstyle.name, description: `Hairstyle for ${name}: ${hairstyle.description || hairstyle.name}`, type: 'hairstyle'
                });
            } else if (!hairstyle.description?.trim()) {
                warnings.push(`Причёска "${hairstyle.name}" для ${name} не отправлена: добавьте текстовое описание.`);
            }
        }
    }

    // Both NovelAI routes are text-only. Do not drop outfit
    // descriptions just because the four image slots are already full.
    if (['novelai', 'novelai-direct'].includes(settings.apiType)) {
        return {
            imageRefs: [],
            textOnlyClothing: [...textOnlyClothing, ...clothingRefs.filter(ref => ref.description && ref.type !== 'hairstyle').map(ref => ({
                charName: ref.name,
                description: ref.description,
            }))],
            // Appearance, outfits and hairstyles go per person (`people`, `textOnlyClothing`, `personTags`).
            textDirectives: textDirectives.filter(directive => !appearanceDirectives.has(directive) && !personDirectives.has(directive)),
            personTags,
            people,
            warnings,
        };
    }

    // ===== STEP 3: Apply 4-slot priority =====

    // If faces alone exceed the limit, trim them (char > user > NPCs in order)
    if (faceRefs.length > MAX_IMAGE_REFS) {
        const trimmed = faceRefs.length - MAX_IMAGE_REFS;
        const removed = faceRefs.splice(MAX_IMAGE_REFS);
        for (const r of removed) {
            iigLog('WARN', `Face ref "${r.name}" trimmed: exceeds ${MAX_IMAGE_REFS}-slot limit`);
        }
        warnings.push(`Слишком много лиц (${faceRefs.length + trimmed}). Последние ${trimmed} NPC не отправлены как рефы.`);
    }

    const freeSlots = Math.max(0, MAX_IMAGE_REFS - faceRefs.length);
    const clothingAsImage = clothingRefs.slice(0, freeSlots);
    const clothingAsTextOnly = clothingRefs.slice(freeSlots);

    // Process text-only clothing
    for (const c of clothingAsTextOnly) {
        if (c.type === 'hairstyle') continue; // Its description is already in textDirectives.
        if (c.description) {
            textOnlyClothing.push({
                charName: c.name,
                outfitName: c.outfitName,
                description: c.description
            });
            iigLog('INFO', `Clothing for "${c.name}" sent as TEXT (no image slot available): "${c.description.substring(0, 60)}..."`);
        } else {
            const warn = `Одежда "${c.outfitName}" для ${c.name} не отправлена: нет свободного слота и нет текстового описания.`;
            warnings.push(warn);
            iigLog('WARN', warn);
        }
    }

    // Final array: faces first, then clothing images
    const imageRefs = [...faceRefs, ...clothingAsImage];

    iigLog('INFO', `Reference collection: ${faceRefs.length} face(s), ${clothingAsImage.length} clothing image(s), ${textOnlyClothing.length} clothing text(s), ${warnings.length} warning(s). Total image refs: ${imageRefs.length}/${MAX_IMAGE_REFS}`);

    return { imageRefs, textOnlyClothing, textDirectives, warnings };
}

// ============================================================
// IMAGE GENERATION: OpenAI
// ============================================================

function getNaisteraModelInfo(model) {
    return naisteraModelCatalog.get(normalizeNaisteraModel(model)) || null;
}

function extractNaisteraDataUrl(result) {
    const candidates = [];
    const push = value => {
        if (value == null) return;
        if (typeof value === 'string') candidates.push(value);
        if (typeof value === 'object') {
            candidates.push(value.data_url, value.url, value.uri, value.image,
                value.b64_json, value.b64, value.base64);
        }
    };

    push(result?.data_url);
    push(result?.image);
    push(result?.url);
    push(result?.images?.[0]);
    push(result?.data?.[0]);
    push(result?.result);

    for (const candidate of candidates) {
        const normalized = normalizeReturnedImage(candidate);
        if (normalized) return normalized;
        if (typeof candidate === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(candidate) && candidate.length > 100) {
            return `data:image/png;base64,${candidate.replace(/\s+/g, '')}`;
        }
    }
    return null;
}

function naisteraAbortError() {
    return new Error('Генерация отменена пользователем');
}

async function pollNaisteraJob(endpoint, jobId, settings, signal) {
    const base = normalizeNaisteraEndpoint(endpoint);
    const url = `${base}/api/generate/jobs/${encodeURIComponent(jobId)}`;
    const intervalMs = Math.max(1000, Math.min(30000, Number(settings.naisteraPollIntervalMs) || 3000));
    const timeoutMs = Math.max(30000, Math.min(900000, Number(settings.naisteraPollTimeoutMs) || 600000));
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        if (signal?.aborted) throw naisteraAbortError();
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${settings.apiKey}`,
                Accept: 'application/json',
            },
            signal,
        });
        const text = await response.text().catch(() => '');
        let result = null;
        try { result = text ? JSON.parse(text) : null; } catch (_) { /* handled below */ }

        if (!response.ok) {
            throw new Error(`Naistera polling error (${response.status}): ${text.slice(0, 800)}`);
        }
        if (extractNaisteraDataUrl(result)) return result;

        const status = String(result?.status || '').toLowerCase();
        if (status === 'failed' || result?.error) {
            throw new Error(`Naistera generation failed: ${result?.detail || result?.error?.detail || result?.error || 'Unknown error'}`);
        }

        await new Promise(resolve => {
            const timer = setTimeout(resolve, intervalMs);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
    }
    throw new Error(`Naistera polling timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function generateImageNaistera(prompt, style, refData, options = {}) {
    const settings = getSettings();
    const endpoint = normalizeNaisteraEndpoint(settings.endpoint);
    const model = normalizeNaisteraModel(settings.naisteraModel);
    if (!getNaisteraModelInfo(model)) {
        try {
            await fetchNaisteraModels();
        } catch (error) {
            iigLog('WARN', `Naistera model metadata unavailable: ${error?.message || error}`);
        }
    }
    const modelInfo = getNaisteraModelInfo(model);
    const descriptionMode = normalizeNaisteraCharacterDescriptionsMode(settings.naisteraCharacterDescriptionsMode);
    const { imageRefs = [], textOnlyClothing = [], textDirectives = [] } = refData || {};

    const promptParts = [];
    // sillyimages sends NovelAI styles as ordinary prompt text, while other
    // Naistera models receive the explicit style marker.
    if (style) promptParts.push(isNaisteraNovelAIModel(model) ? style : `[Style: ${style}]`);
    if (descriptionMode === 'as-is') {
        promptParts.push(...textDirectives);
        for (const clothing of textOnlyClothing) {
            promptParts.push(`[CLOTHING: ${clothing.charName || 'Character'} is wearing: ${clothing.description || ''}]`);
        }
    }
    if (descriptionMode === 'character-prompt') {
        const descriptions = [...textDirectives, ...textOnlyClothing]
            .map(formatNaisteraDescription)
            .filter(Boolean);
        if (descriptions.length > 0) promptParts.push(`[CHARACTER DESCRIPTIONS]\n${descriptions.join('\n')}`);
    }
    promptParts.push(prompt);


    // Random aspect ratio for nano-banana models in Naistera (respects prompt-specified ratio)
    let aspectRatio = options.aspectRatio || settings.naisteraAspectRatio || '1:1';
    const isNaisteraNanaBanana = isGeminiModel(model);
    if (isNaisteraNanaBanana && settings.geminiRandomFormat && !options.aspectRatio) {
        const validRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
        aspectRatio = validRatios[Math.floor(Math.random() * validRatios.length)];
        iigLog('INFO', `Naistera random format (nano-banana): ${aspectRatio}`);
    }

    const body = {
        prompt: promptParts.join('\n\n'),
        aspect_ratio: aspectRatio,
        model,
    };

    const selectedGalleryNegative = options.negativePrompt == null
        ? String(settings.negativeGalleryItems?.find(item => item.id === settings.activeNegativeId)?.prompt || '').trim()
        : String(options.negativePrompt || '').trim();
    const negativePrompt = selectedGalleryNegative || String(settings.naisteraNegativePrompt || '').trim();
    if (negativePrompt && modelInfo?.negativePrompt === true) body.negative_prompt = negativePrompt;
    const preset = String(options.preset ?? settings.naisteraPreset ?? '').trim();
    if (preset) body.preset = preset;

    if (imageRefs.length > 0 && modelInfo?.references !== false) {
        body.reference_objects = imageRefs.map(ref => ({
            image: `data:${ref.mimeType || 'image/png'};base64,${ref.data}`,
            description: descriptionMode === 'none'
                ? ''
                : (ref.description || ref.outfitName || ref.name || ''),
        })).filter(ref => ref.image);
    }
    if (settings.naisteraPolling) body.sync = false;

    iigLog('INFO', `Naistera request: model=${model}, refs=${body.reference_objects?.length || 0}, polling=${!!settings.naisteraPolling}`);

    // Debug: show ref counts on mobile (temporary diagnostic)
    const refCount = body.reference_objects?.length || 0;
    const estimatedSizeKB = refCount > 0 ? Math.round(body.reference_objects.reduce((sum, r) => sum + (r.image?.length || 0), 0) / 1024) : 0;
    toastr.info(
        `Refs: ${refCount} objects | ~${estimatedSizeKB}KB`,
        `Debug Naistera (${model})`,
        { timeOut: 15000, extendedTimeOut: 10000 }
    );

    const response = await fetch(`${endpoint}/api/generate`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Naistera API error (${response.status}): ${text.slice(0, 800)}`);
    }

    let result = await response.json();
    if (result?.job_id && !extractNaisteraDataUrl(result)) {
        result = await pollNaisteraJob(endpoint, result.job_id, settings, options.signal);
    }
    const dataUrl = extractNaisteraDataUrl(result);
    if (!dataUrl) throw new Error('Naistera response does not contain an image');
    return dataUrl;
}

// Direct NovelAI returns a ZIP; extract the first PNG without server access or dependencies.
async function extractNovelAIPng(archive) {
    const bytes = new Uint8Array(archive);
    if (bytes.length < 22 || bytes.length > 60 * 1024 * 1024) throw new Error('NovelAI не вернул ZIP с изображением.');
    const view = new DataView(archive);
    const uint16 = offset => view.getUint16(offset, true);
    const uint32 = offset => view.getUint32(offset, true);
    let end = -1;
    for (let pos = bytes.length - 22; pos >= Math.max(0, bytes.length - 65557); pos--) {
        if (uint32(pos) === 0x06054b50 && pos + 22 + uint16(pos + 20) === bytes.length) { end = pos; break; }
    }
    if (end < 0) throw new Error('NovelAI не вернул ZIP с изображением.');
    const entries = uint16(end + 10);
    let offset = uint32(end + 16);
    if (entries > 100 || offset >= end) throw new Error('Некорректный ZIP-ответ NovelAI.');
    for (let index = 0; index < entries; index++) {
        if (offset + 46 > end || uint32(offset) !== 0x02014b50) break;
        const flags = uint16(offset + 8);
        const method = uint16(offset + 10);
        const length = uint32(offset + 20);
        const nameLength = uint16(offset + 28);
        const extraLength = uint16(offset + 30);
        const commentLength = uint16(offset + 32);
        const localOffset = uint32(offset + 42);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        if (next > end) break;
        const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
        if (name.toLowerCase().endsWith('.png') && !name.startsWith('__MACOSX/')) {
            if (flags & 1 || ![0, 8].includes(method) || localOffset + 30 > bytes.length || uint32(localOffset) !== 0x04034b50) break;
            const start = localOffset + 30 + uint16(localOffset + 26) + uint16(localOffset + 28);
            if (start + length > bytes.length || length > 50 * 1024 * 1024) break;
            const compressed = bytes.subarray(start, start + length);
            const png = method === 0 ? compressed : new Uint8Array(await new Response(
                new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')),
            ).arrayBuffer());
            if (png.length > 50 * 1024 * 1024 || png.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => png[i] === byte)) {
                throw new Error('NovelAI вернул ZIP без корректного PNG.');
            }
            let base64 = '';
            for (let i = 0; i < png.length; i += 0x6000) {
                base64 += String.fromCharCode(...png.subarray(i, i + 0x6000));
            }
            return btoa(base64);
        }
        offset = next;
    }
    throw new Error('NovelAI вернул ZIP без PNG.');
}

const NOVELAI_MAX_CHARACTERS = 6;

/** V4 / V4.5 / V5 models understand separate per-character prompts. */
function novelAISupportsCharacterPrompts(model) {
    return /^nai-diffusion-(4|5)/.test(String(model || ''));
}

/** Clothing words: when a character's own "|" part already dresses them, the wardrobe text is not added again. */
const NOVELAI_GARMENT_PATTERN = /\b(?:dress|gown|skirt|blouse|shirt|t-shirt|sweater|jumper|hoodie|jacket|coat|cardigan|vest|waistcoat|suit|uniform|apron|robe|kimono|yukata|pants|trousers|jeans|shorts|leggings|corset|bodice|lingerie|bra|bikini|swimsuit|pajamas|nightgown|negligee|cape|cloak|tunic|overalls|turtleneck|blazer|tank top|crop top|camisole|leotard|armor|armour|naked|nude|topless)\b/i;

/**
 * Where a character stands, from words like "top left focus frame", "on the right", "bottom panel".
 * Returns NovelAI grid coordinates or null. Body parts ("left hand") are not positions.
 */
function novelAICenterFor(caption) {
    const text = String(caption || '').toLowerCase();
    const patterns = [
        /\b(top|upper|bottom|lower)[\s-]+(left|right)\b/,
        /\b(?:on the )(left|right)\b/,
        /\b(main|center|centre|middle)[\s-]+(?:frame|panel)\b/,
        /\b(left|right)(?:[\s-]+side|[\s-]+(?:focus[\s-]+)?(?:frame|panel))\b/,
        /\b(top|upper|bottom|lower)(?:[\s-]+(?:focus[\s-]+)?(?:frame|panel))\b/,
    ];
    let best = null;
    for (const pattern of patterns) {
        const match = pattern.exec(text);
        if (match && (!best || match.index < best.index)) best = match;
    }
    if (!best) return null;
    const words = best.slice(1).filter(Boolean);
    const x = words.includes('left') ? 0.3 : words.includes('right') ? 0.7 : 0.5;
    const y = words.some(word => word === 'top' || word === 'upper') ? 0.3 : words.some(word => word === 'bottom' || word === 'lower') ? 0.7 : 0.5;
    return { x, y };
}

/**
 * Splits a NovelAI prompt written as "scene | character 1 | character 2" and attaches every person's own
 * appearance, hairstyle and outfit to the segment that names them. The outfit is skipped when that segment already
 * describes clothes (the prompt model dressed them from the wardrobe injection) — a second, longer copy made the
 * caption so heavy that NovelAI spread its details over the other figures.
 * People in the scene without a segment of their own get a separate character prompt.
 * Returns { base: string[], characters: string[] } — tag chunks, not yet joined.
 */
function buildNovelAICaptions(prompt, refData = {}) {
    const people = Array.isArray(refData.people) ? refData.people : [];
    const outfits = new Map();
    const extras = new Map();
    const add = (map, name, description) => {
        const text = String(description || '').trim();
        if (!text) return;
        const key = String(name || '').trim().toLowerCase();
        map.set(key, [...(map.get(key) || []), text]);
    };
    for (const clothing of (refData.textOnlyClothing || [])) add(outfits, clothing.charName, clothing.description);
    for (const ref of (refData.imageRefs || [])) if (ref.type === 'clothing') add(outfits, ref.name, ref.description);
    for (const tag of (refData.personTags || [])) add(tag.kind === 'hairstyle' ? extras : outfits, tag.charName, tag.description);

    const keyOf = person => String(person.name || '').trim().toLowerCase();
    const tagsFor = (person, segment = '') => [
        String(person.appearance || '').trim(),
        ...(extras.get(keyOf(person)) || []),
        ...(NOVELAI_GARMENT_PATTERN.test(segment) ? [] : (outfits.get(keyOf(person)) || [])),
    ].filter(Boolean);
    const handled = new Set();

    const segments = String(prompt || '').split('|').map(part => part.trim()).filter(Boolean);
    const characterSegments = segments.slice(1, 1 + NOVELAI_MAX_CHARACTERS);
    // A "|" part belongs to the person whose name starts one of its tags, the earliest such tag wins.
    // A part that only mentions someone ("looking at Eveline") is not theirs.
    const candidates = [];
    people.forEach(person => characterSegments.forEach((segment, index) => {
        const tagIndex = nameLeadsTagIndex(person.names || [person.name], segment);
        if (tagIndex >= 0) candidates.push({ person, index, tagIndex });
    }));
    candidates.sort((a, b) => a.tagIndex - b.tagIndex || a.index - b.index);
    const owners = new Array(characterSegments.length).fill(null);
    const placed = new Set();
    for (const { person, index } of candidates) {
        if (owners[index] || placed.has(person)) continue;
        owners[index] = person;
        placed.add(person);
        handled.add(keyOf(person));
    }
    const characters = characterSegments.map((segment, index) => {
        const person = owners[index];
        return [segment, ...(person ? tagsFor(person, segment) : [])].filter(Boolean).join(', ');
    });
    // More segments than NovelAI allows: keep the extra text in the base prompt instead of losing it.
    const overflow = segments.slice(1 + NOVELAI_MAX_CHARACTERS);

    const base = [];
    for (const person of people) {
        if (placed.has(person)) continue;
        const tags = tagsFor(person);
        handled.add(keyOf(person));
        if (!tags.length) continue;
        if (characters.length < NOVELAI_MAX_CHARACTERS) characters.push([person.name, ...tags].filter(Boolean).join(', '));
        else base.push(...tags);
    }
    // Outfits/hairstyles of people without an appearance entry (e.g. only a wardrobe item) are not lost either.
    for (const map of [outfits, extras]) for (const [key, list] of map) if (!handled.has(key)) base.push(...list);
    base.push(segments[0] || '', ...overflow);
    return { base: base.filter(Boolean), characters };
}

/**
 * NovelAI draws lettering only from "Text:" at the very END of the base prompt (several texts — one per paragraph).
 * Prompts often carry "…, text: Hello" inside a character's "|" part, where it lands in the middle of the final string
 * and comes out as gibberish. Takes every ", text: …" (up to the end of its "|" part) out and returns them separately.
 */
function extractNovelAIText(prompt) {
    const texts = [];
    const segments = String(prompt || '').split('|').map(segment => {
        const pieces = segment.split(/(?:^|,)\s*text\s*:\s*/i);
        for (const piece of pieces.slice(1)) {
            const text = piece.trim().replace(/[\s,]+$/, '').replace(/^["'«“„]+|["'»”]+$/g, '').trim();
            if (text && !texts.includes(text)) texts.push(text);
        }
        return pieces[0].trim().replace(/[\s,]+$/, '');
    });
    return { prompt: segments.join(' | '), texts };
}

/** A negative with "text" / "letters" makes NovelAI scribble instead of writing the requested words. */
const NOVELAI_TEXT_BLOCKING_TAGS = new Set(['text', 'letters', 'letter', 'words', 'english text', 'no text', 'speech bubble', 'speech bubbles']);
function negativeWithoutTextBan(negative) {
    return String(negative || '').split(',')
        .filter(tag => !NOVELAI_TEXT_BLOCKING_TAGS.has(tag.trim().toLowerCase().replace(/^[{[(]+|[}\])]+$/g, '')))
        .join(',').replace(/^\s*,|,\s*$/g, '').trim();
}

// Both NovelAI routes use text descriptions only, not image references.
async function generateImageNovelAI(prompt, style, refData = {}, options = {}) {
    const settings = getSettings();
    const lettering = extractNovelAIText(prompt);
    prompt = lettering.prompt;
    const captions = buildNovelAICaptions(prompt, refData);
    const parts = [];
    if (style) parts.push(style);
    parts.push(...(refData.textDirectives || []));
    parts.push(...captions.base);
    // Separate character prompts exist only in the direct API with V4+ models; SillyTavern's endpoint gets one string,
    // where each character's tags at least follow that character's own part of the prompt.
    const useCharacterPrompts = settings.apiType === 'novelai-direct'
        && novelAISupportsCharacterPrompts(settings.novelaiModel) && captions.characters.length > 0;
    if (!useCharacterPrompts) parts.push(...captions.characters);
    if (lettering.texts.length) {
        const latinOnly = lettering.texts.every(text => !/[^\u0000-\u024f\s\p{P}\p{N}]/u.test(text));
        parts.push('text', ...(latinOnly ? ['english text'] : []));
    }

    const ratio = String(options.aspectRatio || '');
    let width = Number(settings.novelaiWidth);
    let height = Number(settings.novelaiHeight);
    if (/^\d+:\d+$/.test(ratio)) {
        const [w, h] = ratio.split(':').map(Number);
        if (w > 0 && h > 0 && w / h >= 0.4 && w / h <= 2.5) {
            const area = width * height;
            width = Math.round(Math.sqrt(area * w / h) / 64) * 64;
            height = Math.round(Math.sqrt(area * h / w) / 64) * 64;
        }
    }
    const negativeSource = (options.negativePrompt == null
        ? String(settings.negativeGalleryItems?.find(item => item.id === settings.activeNegativeId)?.prompt || '').trim()
        : String(options.negativePrompt || '').trim()) || String(settings.novelaiNegativePrompt || '').trim();
    const body = {
        // "Text:" must be the very last thing in the prompt; several texts go one per paragraph.
        prompt: parts.filter(Boolean).join(', ') + (lettering.texts.length ? `, Text: ${lettering.texts.join('\n\n')}` : ''),
        model: settings.novelaiModel,
        negative_prompt: lettering.texts.length ? negativeWithoutTextBan(negativeSource) : negativeSource,
        width,
        height,
        steps: Number(settings.novelaiSteps),
        scale: Number(settings.novelaiScale),
        sampler: settings.novelaiSampler,
        scheduler: settings.novelaiScheduler,
        seed: Number(settings.novelaiSeed),
        sm: settings.novelaiSm,
        sm_dyn: settings.novelaiSmDyn,
        decrisper: settings.novelaiDecrisper,
        variety_boost: settings.novelaiVarietyBoost,
    };
    const direct = settings.apiType === 'novelai-direct';
    const token = direct ? normalizeApiKey(settings.novelaiApiKey) : '';
    if (direct && !token) throw new Error('Введите NovelAI Access Token в настройках haruspics.');
    const characterCaptions = useCharacterPrompts ? captions.characters : [];
    // Positions from the prompt ("top left focus frame", "on the right") keep each person in their own place.
    const centers = characterCaptions.map(text => novelAICenterFor(text));
    const useCoords = centers.some(Boolean);
    const centerOf = index => centers[index] || { x: 0.5, y: 0.5 };
    iigLog('INFO', `NovelAI ${direct ? 'direct' : 'SillyTavern'}: model=${body.model}, size=${width}x${height}, text=${body.prompt.length} chars, character prompts=${characterCaptions.length}`);
    const negative = body.negative_prompt || '';
    const directBody = direct ? {
        action: 'generate', input: body.prompt, model: body.model,
        parameters: {
            params_version: body.model.startsWith('nai-diffusion-5-') ? 4 : 3,
            prefer_brownian: true, negative_prompt: negative,
            width, height, steps: body.steps, scale: body.scale,
            seed: body.seed >= 0 ? body.seed : Math.floor(Math.random() * 9999999999),
            sampler: body.sampler, noise_schedule: body.scheduler, n_samples: 1,
            ucPreset: 0, qualityToggle: false, add_original_image: false,
            controlnet_strength: 1, deliberate_euler_ancestral_bug: false,
            dynamic_thresholding: body.decrisper, legacy: false, legacy_v3_extend: false,
            sm: body.sm, sm_dyn: body.sm_dyn, uncond_scale: 1,
            skip_cfg_above_sigma: null, use_coords: useCoords,
            characterPrompts: characterCaptions.map((text, index) => ({ prompt: text, uc: '', center: centerOf(index), enabled: true })),
            reference_image_multiple: [], reference_information_extracted_multiple: [], reference_strength_multiple: [],
            v4_negative_prompt: { caption: { base_caption: negative, char_captions: characterCaptions.map((text, index) => ({ char_caption: '', centers: [centerOf(index)] })) }, legacy_uc: false },
            v4_prompt: { caption: { base_caption: body.prompt, char_captions: characterCaptions.map((text, index) => ({ char_caption: text, centers: [centerOf(index)] })) }, use_coords: useCoords, use_order: true },
        },
    } : null;
    const response = await fetch(direct ? 'https://image.novelai.net/ai/generate-image' : '/api/novelai/generate-image', {
        method: 'POST',
        headers: direct ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : SillyTavern.getContext().getRequestHeaders(),
        body: JSON.stringify(direct ? directBody : body),
        signal: options.signal,
    });
    if (!response.ok) {
        if (direct) {
            const detail = (await response.text().catch(() => '')).slice(0, 1000);
            throw new Error(`NovelAI HTTP ${response.status}: ${detail.replaceAll(token, '[redacted]') || response.statusText}`);
        }
        if (response.status === 400) throw new Error('NovelAI: укажите Access Token в секретах SillyTavern.');
        if (response.status === 404) throw new Error('NovelAI: сервер SillyTavern не поддерживает /api/novelai/generate-image. Обновите SillyTavern.');
        throw new Error(`NovelAI через SillyTavern: HTTP ${response.status}. Проверьте токен, модель и журнал сервера.`);
    }
    if (direct) return `data:image/png;base64,${await extractNovelAIPng(await response.arrayBuffer())}`;
    const base64 = (await response.text()).trim();
    if (!base64.startsWith('iVBORw0KGgo') || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new Error('NovelAI: SillyTavern вернул некорректное изображение.');
    }
    return `data:image/png;base64,${base64}`;
}

async function generateImageOpenAI(prompt, style, refData, options = {}) {
    const settings = getSettings();
    const url = buildOpenAIUrl(settings.endpoint, 'images/generations');

    const { imageRefs = [], textOnlyClothing = [], textDirectives = [] } = refData;

    // Build enhanced prompt
    const promptParts = [];

    if (style) promptParts.push(`[Style: ${style}]`);
        for (const directive of textDirectives) {
        promptParts.push(directive);
    }


    // Text-only clothing instructions
    for (const c of textOnlyClothing) {
        promptParts.push(`[CLOTHING: ${c.charName} is wearing: ${c.description}]`);
    }

    // Clothing from imageRefs that are clothing type
    for (const ref of imageRefs) {
        if (ref.type === 'clothing' && ref.description) {
            promptParts.push(`[CLOTHING for ${ref.name}: ${ref.description}]`);
        }
    }

    promptParts.push(prompt);

    const fullPrompt = promptParts.join('\n\n');

    let size = settings.size;
    if (options.aspectRatio) {
        // Map any "W:H" ratio to the closest size supported by the Images API
        const [w, h] = String(options.aspectRatio).split(':').map(Number);
        if (w > 0 && h > 0) {
            if (w > h) size = '1536x1024';
            else if (w < h) size = '1024x1536';
            else size = '1024x1024';
        }
    }

    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        response_format: 'b64_json'
    };

    const galleryNegative = options.negativePrompt == null
        ? String(settings.negativeGalleryItems?.find(item => item.id === settings.activeNegativeId)?.prompt || '').trim()
        : String(options.negativePrompt || '').trim();
    if (galleryNegative) body.negative_prompt = galleryNegative;

    if (size && size !== 'auto') body.size = size;

    // Send reference images via body.image (gpt-image-1 compatible)
    if (imageRefs.length === 1) {
        body.image = `data:${imageRefs[0].mimeType};base64,${imageRefs[0].data}`;
    } else if (imageRefs.length > 1) {
        body.image = imageRefs.map(ref => `data:${ref.mimeType};base64,${ref.data}`);
    }

    iigLog('INFO', `OpenAI Request: model=${body.model}, size=${body.size || 'auto'}, refs=${imageRefs.length}, prompt=${fullPrompt.length} chars`);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildAuthHeaders(settings.apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: options.signal
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }

    const result = await response.json();
    const dataList = result.data || result.images || [];

    if (dataList.length === 0) {
        if (result.url) return result.url;
        if (result.image) return result.image.startsWith('data:') ? result.image : `data:image/png;base64,${result.image}`;
        if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
        throw new Error('No image data in response');
    }

    const imageObj = dataList[0];
    const b64Data = imageObj.b64_json || imageObj.b64 || imageObj.base64 || imageObj.image;
    const urlData = imageObj.url || imageObj.uri;

    if (b64Data) {
        if (b64Data.startsWith('data:')) return b64Data;
        let mimeType = 'image/png';
        if (b64Data.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (b64Data.startsWith('UklGR')) mimeType = 'image/webp';
        return `data:${mimeType};base64,${b64Data}`;
    }

    if (urlData) return urlData;
    throw new Error('Unexpected image response format');
}

function normalizeReturnedImage(value) {
    if (!value) return null;
    if (typeof value !== 'string') return null;
    const clean = value.trim();
    if (!clean) return null;
    if (clean.startsWith('data:image/')) return clean;
    if (/^https?:\/\//i.test(clean)) return clean;
    if (/^[A-Za-z0-9+/=\r\n]+$/.test(clean) && clean.length > 100) {
        const compact = clean.replace(/\s+/g, '');
        let mimeType = 'image/png';
        if (compact.startsWith('/9j/')) mimeType = 'image/jpeg';
        else if (compact.startsWith('UklGR')) mimeType = 'image/webp';
        return `data:${mimeType};base64,${compact}`;
    }
    return null;
}

function extractImageFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const dataUrl = text.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+/);
    if (dataUrl) return normalizeReturnedImage(dataUrl[0]);
    const markdownImage = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
    if (markdownImage) return markdownImage[1];
    const plainImageUrl = text.match(/https?:\/\/[^\s)"']+\.(?:png|jpe?g|webp|gif)(?:\?[^\s)"']*)?/i);
    if (plainImageUrl) return plainImageUrl[0];
    return null;
}

function parseImageFromApiResponse(result) {
    const candidates = [];
    const push = (value) => {
        if (value == null) return;
        if (typeof value === 'string') candidates.push(value);
        else if (typeof value === 'object') {
            candidates.push(value.url, value.uri, value.b64_json, value.b64, value.base64, value.image);
            candidates.push(value.image_url?.url, value.image_url);
            if (value.data) candidates.push(value.data);
        }
    };

    push(result?.url);
    push(result?.uri);
    push(result?.image);
    push(result?.b64_json);
    for (const item of (result?.data || [])) push(item);
    for (const item of (result?.images || [])) push(item);

    for (const choice of (result?.choices || [])) {
        const message = choice?.message || choice?.delta || {};
        push(message.image);
        push(message.image_url);
        for (const image of (message.images || [])) push(image);
        const content = message.content;
        if (typeof content === 'string') candidates.push(content);
        else if (Array.isArray(content)) {
            for (const part of content) {
                push(part);
                push(part?.image_url);
                push(part?.image);
                if (part?.type === 'text') push(part.text);
            }
        }
    }

    for (const candidate of candidates) {
        const normalized = normalizeReturnedImage(candidate) || extractImageFromText(candidate);
        if (normalized) return normalized;
    }
    return null;
}

/**
 * One numbered list that matches the order the images are attached in, so the model knows exactly which picture is whom:
 * "Image 1 = FACE of "Ivan" …, Image 2 = OUTFIT of "Eva" …".
 */
function buildReferenceLegend(imageRefs) {
    const lines = imageRefs.map((ref, index) => {
        const n = index + 1;
        if (ref.type === 'face') return `Image ${n} = FACE of "${ref.name}": keep this person's face and identity exactly (not the pose, expression, framing or art style of the picture).`;
        if (ref.type === 'clothing') return `Image ${n} = OUTFIT of "${ref.name}"${ref.outfitName ? ` ("${ref.outfitName}")` : ''}: copy only the clothing, not the face, body or pose.${ref.description ? ` ${ref.description}` : ''}`;
        if (ref.type === 'hairstyle') return `Image ${n} = HAIRSTYLE of "${ref.name}": copy only the hair, not the face.`;
        return `Image ${n} = reference for "${ref.name}".`;
    });
    return `[REFERENCE IMAGES, in the order they are attached]\n${lines.join('\n')}\nUse each reference only for its own named person. Draw only the people the scene mentions.`;
}

async function generateImageOpenAIChat(prompt, style, refData, options = {}) {
    const settings = getSettings();
    const url = buildOpenAIUrl(settings.endpoint, 'chat/completions');
    const { imageRefs = [], textOnlyClothing = [], textDirectives = [] } = refData;

    // Get aspect ratio and image size from options or settings
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    // Random format for Gemini models: randomize aspect ratio only (image size stays from settings).
    // If the prompt tag already specified an aspect ratio, keep it.
    const isGemini = isGeminiModel(settings.model || '') || settings.apiType === 'gemini';
    if (isGemini && settings.geminiRandomFormat && !options.aspectRatio) {
        aspectRatio = VALID_ASPECT_RATIOS[Math.floor(Math.random() * VALID_ASPECT_RATIOS.length)];
        iigLog('INFO', `Gemini random format (router): ${aspectRatio} ${imageSize}`);
    }

    const promptParts = [];
    promptParts.push('Generate an image from the following instruction. Return the generated image in the response.');
    
    // Add aspect ratio instruction to prevent reference image aspect from being copied
    promptParts.push(`[IMAGE SPECIFICATIONS: aspect ratio ${aspectRatio}, do NOT copy the aspect ratio from reference images, use ${aspectRatio} for the final output]`);
    
    if (style) promptParts.push(`[Art Style: ${style}]`);
    for (const directive of textDirectives) promptParts.push(directive);
    for (const c of textOnlyClothing) promptParts.push(`[CLOTHING: ${c.charName} is wearing: ${c.description}]`);
    if (imageRefs.length) promptParts.push(buildReferenceLegend(imageRefs));
    promptParts.push(`[SCENE TO GENERATE]\n${prompt}`);
    const galleryNegative = options.negativePrompt == null
        ? String(settings.negativeGalleryItems?.find(item => item.id === settings.activeNegativeId)?.prompt || '').trim()
        : String(options.negativePrompt || '').trim();
    if (galleryNegative) promptParts.push(`[NEGATIVE PROMPT: ${galleryNegative}]`);
    const fullPrompt = promptParts.join('\n\n');

    const content = [{ type: 'text', text: fullPrompt }];
    for (const ref of imageRefs) {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${ref.mimeType};base64,${ref.data}` }
        });
    }

    // Debug: show ref counts on mobile (temporary diagnostic)
    const faceCount = imageRefs.filter(r => r.type === 'face').length;
    const clothingCount = imageRefs.filter(r => r.type === 'clothing').length;
    const hairstyleCount = imageRefs.filter(r => r.type === 'hairstyle').length;
    const estimatedSizeKB = Math.round(imageRefs.reduce((sum, r) => sum + (r.data?.length || 0), 0) / 1024);
    toastr.info(
        `Refs: ${faceCount} faces, ${clothingCount} clothes, ${hairstyleCount} hair | ~${estimatedSizeKB}KB`,
        `Debug OpenAI/Router (${settings.model})`,
        { timeOut: 15000, extendedTimeOut: 10000 }
    );

    const body = {
        model: settings.model,
        messages: [{ role: 'user', content }],
        modalities: ['image', 'text']
    };

    // Add image_config for Gemini models via Router (OpenRouter, CloseRouter, rout.my)
    if (isRouterEndpoint(settings.endpoint)) {
        body.image_config = {
            aspect_ratio: aspectRatio,
            image_size: imageSize
        };
    }

    iigLog('INFO', `OpenAI Chat/Router Request: model=${body.model}, refs=${imageRefs.length}, aspect=${aspectRatio}, size=${imageSize}, prompt=${fullPrompt.length} chars`);

    const response = await fetch(url, {
        method: 'POST',
        headers: buildAuthHeaders(settings.apiKey, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: options.signal
    });

    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`API Error (${response.status}): ${text.slice(0, 500)}`);
    }

    const result = await response.json().catch(() => null);
    if (!result) {
        const text = await response.clone().text().catch(() => '');
        throw new Error(`API returned non-JSON response (status ${response.status}): ${text.slice(0, 300) || '(empty body)'}`);
    }
    const image = parseImageFromApiResponse(result);
    if (!image) throw new Error('No image data in chat/completions response');
    return image;
}

// ============================================================
// IMAGE GENERATION: Gemini (nano-banana)
// ============================================================

const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

async function generateImageGemini(prompt, style, refData, options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const baseUrl = settings.endpoint.replace(/\/$/, '');
    const requestCandidates = buildGeminiRequestCandidates(baseUrl, model, settings.apiKey);

    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) aspectRatio = '1:1';
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) imageSize = '1K';

    // Gemini random format: pick random aspect ratio per request (image size stays from settings).
    // If the prompt tag already specified an aspect ratio, keep it.
    if (settings.apiType === 'gemini' && settings.geminiRandomFormat && !options.aspectRatio) {
        aspectRatio = VALID_ASPECT_RATIOS[Math.floor(Math.random() * VALID_ASPECT_RATIOS.length)];
        iigLog('INFO', `Gemini random format: ${aspectRatio} ${imageSize}`);
    }

    const { imageRefs = [], textOnlyClothing = [], textDirectives = [] } = refData;

    // Separate face and clothing refs
    const faceRefs = imageRefs.filter(r => r.type === 'face');
    const clothingImageRefs = imageRefs.filter(r => r.type === 'clothing');
    const hairstyleRefs = imageRefs.filter(r => r.type === 'hairstyle');

    // Log reference breakdown for debugging "refs not visible" issues
    iigLog('INFO', `Gemini refs: faces=${faceRefs.length}, clothingImages=${clothingImageRefs.length}, hairstyles=${hairstyleRefs.length}, textClothing=${textOnlyClothing.length}, textDirectives=${textDirectives.length}`);

    // Debug: show ref counts on mobile (temporary diagnostic)
    const estimatedSizeKB = Math.round(imageRefs.reduce((sum, r) => sum + (r.data?.length || 0), 0) / 1024);
    toastr.info(
        `Refs: ${faceRefs.length} faces, ${clothingImageRefs.length} clothes, ${hairstyleRefs.length} hair | ~${estimatedSizeKB}KB`,
        `Debug Gemini (${settings.model})`,
        { timeOut: 15000, extendedTimeOut: 10000 }
    );

    const parts = [];

    // ===== PRE-INSTRUCTION =====
    if (imageRefs.length > 0) {
        let preInstruction = `[CRITICAL INSTRUCTIONS FOR REFERENCE IMAGES]\n`;
        preInstruction += `You will receive ${imageRefs.length} reference image(s).\n`;
        preInstruction += `RULES:\n`;
        preInstruction += `1. FACE references have ABSOLUTE PRIORITY. Copy faces EXACTLY from face reference images.\n`;
        preInstruction += `2. CLOTHING references show ONLY the outfit design. Do NOT copy faces or body shapes from clothing images.\n`;
        preInstruction += `3. If a face in a clothing reference conflicts with a face reference, ALWAYS use the FACE reference.\n`;
        parts.push({ text: preInstruction });
    }

    // ===== FACE REFERENCES (HIGHEST PRIORITY, FIRST) =====
    let refCounter = 0;
    for (const ref of faceRefs) {
        refCounter++;
        parts.push({
            inlineData: { mimeType: ref.mimeType, data: ref.data }
        });
        parts.push({
            text: `[FACE REFERENCE #${refCounter}: "${ref.name}"]\n` +
                `This is the EXACT face and appearance of "${ref.name}".\n` +
                `COPY IDENTICALLY: face shape, eye shape & color, nose, mouth, jawline, hair color & style, skin tone.\n` +
                `Include ALL distinctive features (freckles, scars, moles, etc).\n` +
                `DO NOT modify, stylize, or "improve" this face. REPRODUCE IT EXACTLY AS SHOWN.\n`
        });
    }

    // ===== CLOTHING IMAGE REFERENCES (LOWER PRIORITY) =====
    for (const ref of clothingImageRefs) {
        refCounter++;
        parts.push({
            inlineData: { mimeType: ref.mimeType, data: ref.data }
        });
        let clothingLabel = `[CLOTHING-ONLY REFERENCE #${refCounter} for "${ref.name}": "${ref.outfitName || 'outfit'}"]\n`;
        clothingLabel += `⚠️ THIS IMAGE SHOWS ONLY CLOTHING/OUTFIT DESIGN.\n`;
        clothingLabel += `DO NOT copy any face, body shape, or person from this image.\n`;
        clothingLabel += `ONLY copy: garment type, fabric, colors, patterns, accessories, and overall style.\n`;
        clothingLabel += `"${ref.name}" MUST be wearing exactly this outfit.\n`;
        if (ref.description) {
            clothingLabel += `Outfit details: ${ref.description}\n`;
        }
        parts.push({ text: clothingLabel });
    }

    for (const ref of hairstyleRefs) {
        parts.push({ inlineData: { mimeType: ref.mimeType, data: ref.data } });
        parts.push({ text: `[HAIRSTYLE REFERENCE for "${ref.name}"]: Copy only the hair, not the face. ${ref.description || ''}` });
    }

    // ===== BUILD MAIN PROMPT =====
    let fullPrompt = '';

    // Character mapping
    if (imageRefs.length > 0) {
        fullPrompt += `[CHARACTER & CLOTHING MAPPING]\n`;
        let idx = 0;
        for (const ref of faceRefs) {
            idx++;
            fullPrompt += `• "${ref.name}" = Face Reference #${idx} (COPY FACE EXACTLY)\n`;
        }
        for (const ref of clothingImageRefs) {
            idx++;
            fullPrompt += `• "${ref.name}'s outfit" = Clothing Reference #${idx} (COPY GARMENT ONLY, NOT FACE)\n`;
        }
        fullPrompt += `\nCRITICAL: Face features must be IDENTICAL to face references. Clothing references affect ONLY what characters wear.\n\n`;
    }

    // Text-only clothing instructions
    if (textOnlyClothing.length > 0) {
        for (const c of textOnlyClothing) {
            fullPrompt += `[CLOTHING INSTRUCTION for "${c.charName}"]: ${c.charName} is wearing: ${c.description}\n\n`;
        }
    }
    
    if (textDirectives.length > 0) {
        for (const directive of textDirectives) {
            fullPrompt += `${directive}\n\n`;
        }
    }

    // Style
    if (style) {
        fullPrompt += `[Art Style: ${style}]\n\n`;
    }
    const galleryNegative = getEffectiveNegativePrompt(options.negativePrompt);
    if (galleryNegative) fullPrompt += `[NEGATIVE PROMPT: ${galleryNegative}]\n\n`;

    // Main scene prompt
    fullPrompt += `[SCENE TO GENERATE]\n${prompt}\n[END SCENE]`;

    // Final reminder
    if (faceRefs.length > 0) {
        fullPrompt += `\n\n[FINAL REMINDER]\n`;
        fullPrompt += `The characters in this scene MUST look EXACTLY like their face reference images.\n`;
        fullPrompt += `Check each character's face against their reference before finalizing.\n`;
        if (clothingImageRefs.length > 0) {
            fullPrompt += `Clothing references affect ONLY the garments, NOT faces or body shapes.\n`;
        }
    }

    parts.push({ text: fullPrompt });

    iigLog('INFO', `Gemini request: ${faceRefs.length} face(s), ${clothingImageRefs.length} clothing img(s), ${textOnlyClothing.length} clothing text(s), prompt ${fullPrompt.length} chars`);

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: { aspectRatio, imageSize }
        }
    };

        // Safety: serialize body and check size
    let bodyString;
    try {
        bodyString = JSON.stringify(body);
    } catch (serializeError) {
        throw new Error(`Failed to serialize request body: ${serializeError.message}. Try reducing the number of reference images.`);
    }

    iigLog('INFO', `Gemini request body size: ${(bodyString.length / 1024 / 1024).toFixed(2)}MB`);

    let response = null;
    let lastStatus = 0;
    let lastText = '';

    for (const candidate of requestCandidates) {
        iigLog('INFO', `Gemini endpoint candidate: ${candidate.url}`);
        const res = await fetch(candidate.url, {
            method: 'POST',
            headers: candidate.headers,
            body: bodyString,
            signal: options.signal
        });

        if (res.ok) {
            response = res;
            break;
        }

        lastStatus = res.status;
        lastText = await res.text().catch(() => '');
        iigLog('WARN', `Gemini endpoint failed (${res.status}) ${candidate.url} :: ${lastText.substring(0, 200)}`);
    }

    if (!response) {
        throw new Error(`API Error (${lastStatus || '?'}): ${lastText || 'All Gemini endpoints failed'}`);
    }

    const result = await response.json();
    const candidates = result.candidates || [];
    if (candidates.length === 0) throw new Error('No candidates in response');

    const responseParts = candidates[0].content?.parts || [];
    for (const part of responseParts) {
        if (part.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        if (part.inline_data) return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
    }
    throw new Error('No image found in Gemini response');
}

// ============================================================
// GENERATION WITH RETRY
// ============================================================

function validateSettings() {
    const settings = getSettings();
    const errors = [];
    if (!['naistera', 'novelai', 'novelai-direct'].includes(settings.apiType) && !settings.endpoint) errors.push('URL эндпоинта не настроен');
    if (!['novelai', 'novelai-direct'].includes(settings.apiType) && !settings.apiKey) errors.push('API ключ не настроен');
    if (settings.apiType === 'novelai-direct' && !normalizeApiKey(settings.novelaiApiKey)) errors.push('Укажите NovelAI Access Token в расширении');
    const selectedModel = settings.apiType === 'naistera' ? normalizeNaisteraModel(settings.naisteraModel)
        : ['novelai', 'novelai-direct'].includes(settings.apiType) ? settings.novelaiModel : settings.model;
    if (!selectedModel || (['novelai', 'novelai-direct'].includes(settings.apiType) && !NOVELAI_MODELS.some(([id]) => id === selectedModel))) {
        errors.push('Модель не выбрана');
    }
    if (['novelai', 'novelai-direct'].includes(settings.apiType) && (
        !Number.isInteger(Number(settings.novelaiWidth)) || Number(settings.novelaiWidth) < 64 || Number(settings.novelaiWidth) > 2048 ||
        !Number.isInteger(Number(settings.novelaiHeight)) || Number(settings.novelaiHeight) < 64 || Number(settings.novelaiHeight) > 2048 ||
        !Number.isInteger(Number(settings.novelaiSteps)) || Number(settings.novelaiSteps) < 1 || Number(settings.novelaiSteps) > 50 ||
        !Number.isFinite(Number(settings.novelaiScale)) || Number(settings.novelaiScale) < 0 || Number(settings.novelaiScale) > 30
    )) errors.push('Некорректные размеры или параметры NovelAI');
    if (errors.length > 0) throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
}

async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    validateSettings();
    const settings = getSettings();

    // Use pre-collected refData or collect now
    let refData = options.refData;
    if (!refData) {
        onStatusUpdate?.('Сбор референсов...');
        refData = await collectReferenceImages(prompt);
    }

    // Show warnings from ref collection
    if (refData.warnings?.length > 0) {
        for (const w of refData.warnings) {
            toastr.warning(w, 'Референсы', { timeOut: 6000 });
        }
    }

    const timeoutMs = (settings.requestTimeout || 120) * 1000;
    const externalSignal = options.signal;

    let lastError;
    for (let attempt = 0; attempt <= settings.maxRetries; attempt++) {
        const timeoutController = new AbortController();
        const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);
        const onExternalAbort = () => timeoutController.abort();
        externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

        try {
            if (externalSignal?.aborted) throw new DOMException('Отменено пользователем', 'AbortError');

            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${settings.maxRetries})` : ''}...`);
            const genOptions = { ...options, signal: timeoutController.signal };

            const isRouterApi = isRouterEndpoint(settings.endpoint);
            const useGeminiApi = settings.apiType === 'gemini' && !isRouterApi;
            if (settings.apiType === 'naistera') {
                return await generateImageNaistera(prompt, style, refData, genOptions);
            }
            if (['novelai', 'novelai-direct'].includes(settings.apiType)) {
                return await generateImageNovelAI(prompt, style, refData, genOptions);
            }
            const useChatApi = settings.apiType === 'openai-chat' ||
                (isRouterApi && (settings.apiType === 'openai' || settings.apiType === 'gemini'));

            if (useGeminiApi) {
                return await generateImageGemini(prompt, style, refData, genOptions);
            }

            if (useChatApi) {
                return await generateImageOpenAIChat(prompt, style, refData, genOptions);
            }

            return await generateImageOpenAI(prompt, style, refData, genOptions);
        } catch (error) {
            lastError = error;
            if (error.name === 'AbortError') {
                lastError = externalSignal?.aborted
                    ? new Error('Отменено пользователем')
                    : new Error(`Таймаут: сервер не ответил за ${settings.requestTimeout}с`);
                break;
            }
            const isRetryable = /429|503|502|504|timeout|network/i.test(error.message);
            if (!isRetryable || attempt === settings.maxRetries) break;
            const delay = settings.retryDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener('abort', onExternalAbort);
        }
    }
    throw lastError;
}

// ============================================================
// TAG PARSING
// ============================================================

async function checkFileExists(path) {
    try { return (await fetch(path, { method: 'HEAD' })).ok; } catch (e) { return false; }
}

// Resolve error.svg next to this script (the extension folder is haruspics-naistera, not sillyimages).
const ERROR_IMAGE_PATH = (() => {
    try { return new URL('./error.svg', import.meta.url).pathname; } catch (_) { return '/scripts/extensions/third-party/haruspics-naistera/error.svg'; }
})();

async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];

    // NEW FORMAT: <img data-iig-instruction='...' src='...'>
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) { searchPos = markerPos + 1; continue; }
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) { searchPos = markerPos + 1; continue; }

        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchPos = markerPos + 1; continue; }
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) { searchPos = markerPos + 1; continue; }
        imgEnd++;

        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';

        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg');
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;

        if (hasErrorImage && !forceAll) { searchPos = imgEnd; continue; }
        if (forceAll) needsGeneration = true;
        else if (hasMarker || !srcValue) needsGeneration = true;
        else if (hasPath && checkExistence) { if (!(await checkFileExists(srcValue))) needsGeneration = true; }
        else if (hasPath) { searchPos = imgEnd; continue; }

        if (!needsGeneration) { searchPos = imgEnd; continue; }

        try {
            let nj = instructionJson
                .replace(/"/g, '"').replace(/'/g, "'").replace(/'/g, "'")
                .replace(/"/g, '"').replace(/&/g, '&')
                .replace(/\u201c/g, '"').replace(/\u201d/g, '"')
                .replace(/\u2018/g, "'").replace(/\u2019/g, "'");
            const data = JSON.parse(nj);
            tags.push({
                fullMatch: fullImgTag, index: imgStart,
                style: decodeNumericEntities(data.style || ''), prompt: decodeNumericEntities(data.prompt || ''),
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                preset: data.preset || null,
                negativePrompt: data.negative_prompt || data.negativePrompt || null,
                isNewFormat: true, existingSrc: srcValue || null
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${e.message}`);
        }
        searchPos = imgEnd;
    }

    // LEGACY FORMAT: [IMG:GEN:{...}]
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        const jsonStart = markerIndex + marker.length;
        let braceCount = 0, jsonEnd = -1, inString = false, escapeNext = false;
        for (let i = jsonStart; i < text.length; i++) {
            const c = text[i];
            if (escapeNext) { escapeNext = false; continue; }
            if (c === '\\' && inString) { escapeNext = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
                if (c === '{') braceCount++;
                else if (c === '}') { braceCount--; if (braceCount === 0) { jsonEnd = i + 1; break; } }
            }
        }
        if (jsonEnd === -1) { searchStart = jsonStart; continue; }
        if (!text.substring(jsonEnd).startsWith(']')) { searchStart = jsonEnd; continue; }
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        const jsonStr = text.substring(jsonStart, jsonEnd);
        try {
            let data;
            try {
                data = JSON.parse(jsonStr);
            } catch (_) {
                try {
                    data = JSON.parse(jsonStr.replace(/'/g, '"'));
                } catch (__) {
                    const relaxed = jsonStr
                        .replace(/(\w+)\s*:/g, '"$1":')
                        .replace(/:\s*'([^']*)'/g, ':"$1"');
                    data = JSON.parse(relaxed);
                }
            }
            tags.push({
                fullMatch: tagOnly, index: markerIndex,
                style: decodeNumericEntities(data.style || ''), prompt: decodeNumericEntities(data.prompt || ''),
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                preset: data.preset || null,
                negativePrompt: data.negative_prompt || data.negativePrompt || null,
                isNewFormat: false
            });
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag: ${e.message}`);
        }
        searchStart = jsonEnd + 1;
    }

    return tags;
}

// ============================================================
// DOM HELPERS
// ============================================================

function createLoadingPlaceholder(tagId, onCancel) {
    const el = document.createElement('div');
    el.className = 'iig-loading-placeholder';
    el.dataset.tagId = tagId;
    el.style.cssText = 'position: relative; min-height: 80px;';
    el.innerHTML = `<div class="iig-spinner"></div><div class="iig-status">Генерация картинки...</div>`;

    if (onCancel) {
        const x = document.createElement('div');
        x.title = 'Отменить генерацию';
        x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        x.style.cssText = 'position:absolute;top:4px;right:4px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:0.5;border-radius:50%;background:rgba(0,0,0,0.4);color:#fff;font-size:13px;z-index:1;';
        x.addEventListener('mouseenter', () => { x.style.opacity = '1'; });
        x.addEventListener('mouseleave', () => { x.style.opacity = '0.5'; });
        x.addEventListener('click', (e) => {
            e.stopPropagation();
            onCancel();
            x.style.pointerEvents = 'none';
            x.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
            const statusEl = el.querySelector('.iig-status');
            if (statusEl) statusEl.textContent = 'Отмена...';
        });
        el.appendChild(x);
    }

    return el;
}

function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    if (tagInfo.fullMatch) {
        const m = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (m) img.setAttribute('data-iig-instruction', m[2]);
    }
    return img;
}

function wrapImageWithRegen(img, messageId, tagIndex) {
    const wrapper = document.createElement('div');
    wrapper.className = 'iig-image-wrapper';
    wrapper.dataset.tagIndex = tagIndex;
    wrapper.style.cssText = 'position:relative;display:inline-block;';

    const regenBtn = document.createElement('button');
    regenBtn.type = 'button';
    regenBtn.className = 'iig-image-regen';
    regenBtn.dataset.messageId = messageId;
    regenBtn.dataset.tagIndex = tagIndex;
    regenBtn.title = 'Перегенерировать эту картинку';
    regenBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
    regenBtn.setAttribute('aria-label', regenBtn.title);
    regenBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:30px;height:30px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:50%;background:rgba(0,0,0,0.65);color:#fff;font-size:13px;z-index:1;';
    wrapper.appendChild(regenBtn);
    wrapper.appendChild(img);
    return wrapper;
}

function buildGeneratedImageTag(tag, imagePath) {
    const instruction = JSON.stringify({
        prompt: tag.prompt, style: tag.style, aspect_ratio: tag.aspectRatio,
        image_size: tag.imageSize, quality: tag.quality, preset: tag.preset,
        negative_prompt: tag.negativePrompt
    }).replace(/[&'<>]/g, char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return `<img class="iig-generated-image" data-iig-instruction='${instruction}' src="${escapeHtml(imagePath)}">`;
}

async function restoreImageRegenButtons(messageElement, messageId) {
    const message = SillyTavern.getContext().chat[messageId];
    if (!message || message.is_user || processingMessages.has(messageId)) return;
    const text = message.mes;
    const tags = await parseImageTags(text, { forceAll: true });
    if (message.mes !== text || !messageElement.isConnected || processingMessages.has(messageId)) return;
    const images = Array.from(messageElement.querySelectorAll('.mes_text img'));
    const used = new Set();
    const normalizeSrc = value => {
        try { return new URL(value, document.baseURI).href; } catch (_) { return value; }
    };
    tags.forEach((tag, index) => {
        if (!tag.existingSrc || tag.existingSrc.includes('[IMG:')) return;
        const img = images.find(image => !used.has(image) &&
            normalizeSrc(image.getAttribute('src')) === normalizeSrc(tag.existingSrc));
        if (!img) return;
        used.add(img);
        const existing = img.closest('.iig-image-wrapper');
        const button = existing?.querySelector('.iig-image-regen');
        if (button) {
            existing.dataset.tagIndex = index;
            button.dataset.messageId = messageId;
            button.dataset.tagIndex = index;
            return;
        }
        const marker = document.createElement('span');
        (existing || img).replaceWith(marker);
        marker.replaceWith(wrapImageWithRegen(img, messageId, index));
    });
}

function observeImageRegenButtons() {
    const chat = document.getElementById('chat');
    if (!chat || chat.dataset.iigRegenObserver) return;
    chat.dataset.iigRegenObserver = 'true';
    const pending = new Set();
    let timer;
    const observer = new MutationObserver(records => {
        for (const record of records) {
            const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
            const message = element?.closest('.mes');
            if (message) pending.add(message);
            for (const node of record.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                if (node.matches('.mes')) pending.add(node);
                node.querySelectorAll('.mes').forEach(mes => pending.add(mes));
            }
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
            for (const message of pending) {
                  const messageId = Number(message.getAttribute('mesid'));
                  if (Number.isInteger(messageId) && typeof ensurePromptPanelForMessage === 'function') ensurePromptPanelForMessage(message, messageId);
                restoreImageRegenButtons(message, Number(message.getAttribute('mesid')))
                    .catch(error => iigLog('WARN', 'Cannot restore image buttons:', error.message));
            }
            pending.clear();
        }, 50);
    });
    observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    // Capture clicks before links/lightboxes and survive cloned/re-rendered buttons.
    chat.addEventListener('click', event => {
        const button = event.target.closest?.('.iig-image-regen');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const messageId = Number(button.closest('.mes')?.getAttribute('mesid'));
        regenerateSingleImage(messageId, Number(button.dataset.tagIndex))
            .catch(error => { iigLog('ERROR', error.message); toastr.error(error.message); });
    }, true);
}

// ============================================================
// MESSAGE PROCESSING
// ============================================================

async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enabled) return;
    if (processingMessages.has(messageId)) return;

    const message = context.chat[messageId];
    if (!message || message.is_user) return;

    const tags = await parseImageTags(message.mes, { checkExistence: true });
    if (tags.length === 0) return;

    processingMessages.add(messageId);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);

    // Collect references ONCE using all prompts
    const allPrompts = tags.map(t => t.prompt).join(' ');
    let sharedRefData;
    try {
        sharedRefData = await collectReferenceImages(allPrompts);
    } catch (e) {
        sharedRefData = { imageRefs: [], textOnlyClothing: [], warnings: [] };
        iigLog('WARN', 'Failed to collect references:', e.message);
    }

    // Prepare legacy tag placeholders via TreeWalker (DOM-safe)
    for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (!tag.isNewFormat) {
            const walker = document.createTreeWalker(mesTextEl, NodeFilter.SHOW_TEXT, null);
            let textNode;
            while ((textNode = walker.nextNode())) {
                const pos = textNode.textContent.indexOf(tag.fullMatch);
                if (pos !== -1) {
                    const beforeText = textNode.textContent.substring(0, pos);
                    const afterText = textNode.textContent.substring(pos + tag.fullMatch.length);
                    const placeholder = document.createElement('span');
                    placeholder.dataset.iigPlaceholder = `iig-${messageId}-${i}`;
                    const parent = textNode.parentNode;
                    if (beforeText) parent.insertBefore(document.createTextNode(beforeText), textNode);
                    parent.insertBefore(placeholder, textNode);
                    if (afterText) parent.insertBefore(document.createTextNode(afterText), textNode);
                    parent.removeChild(textNode);
                    tag._placeholderEl = placeholder;
                    break;
                }
            }
        }
    }

    // Sequential generation
    for (let index = 0; index < tags.length; index++) {
        if (abortController.signal.aborted) break;

        const tag = tags[index];
        const tagId = `iig-${messageId}-${index}`;

        const tagStyle = buildEffectiveStyle(tag.style);

        const loadingPlaceholder = createLoadingPlaceholder(tagId, () => abortController.abort());

        let targetElement = null;

        if (tag.isNewFormat) {
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            const searchPrompt = tag.prompt.substring(0, 30);

            for (const img of allImgs) {
                const instr = img.getAttribute('data-iig-instruction');
                if (!instr) continue;
                const decoded = instr.replace(/"/g, '"').replace(/'/g, "'")
                    .replace(/'/g, "'").replace(/"/g, '"').replace(/&/g, '&');
                if (decoded.includes(searchPrompt)) { targetElement = img; break; }
                try {
                    const d = JSON.parse(decoded.replace(/'/g, '"'));
                    if (d.prompt?.substring(0, 30) === tag.prompt.substring(0, 30)) { targetElement = img; break; }
                } catch (_) {}
                if (instr.includes(searchPrompt)) { targetElement = img; break; }
            }

            if (!targetElement) {
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        targetElement = img; break;
                    }
                }
            }

            if (!targetElement) {
                for (const img of mesTextEl.querySelectorAll('img')) {
                    const src = img.getAttribute('src') || '';
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        targetElement = img; break;
                    }
                }
            }
        } else {
            targetElement = tag._placeholderEl || null;
        }

        if (targetElement) targetElement.replaceWith(loadingPlaceholder);
        else mesTextEl.appendChild(loadingPlaceholder);

        const statusEl = loadingPlaceholder.querySelector('.iig-status');

        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt, tagStyle,
                (s) => { if (statusEl) statusEl.textContent = s; },
                {
                    aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality,
                    preset: tag.preset, negativePrompt: tag.negativePrompt,
                    refData: sharedRefData,
                    signal: abortController.signal
                }
            );

            if (statusEl) statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);

            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tagStyle}\nPrompt: ${tag.prompt}`;

            if (tag.isNewFormat) {
                const instrMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instrMatch) img.setAttribute('data-iig-instruction', instrMatch[2]);
            }

            const wrapped = wrapImageWithRegen(img, messageId, index);
            loadingPlaceholder.replaceWith(wrapped);

            message.mes = message.mes.replace(tag.fullMatch, buildGeneratedImageTag(tag, imagePath));

            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);

            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);

            message.mes = message.mes.replace(tag.fullMatch, buildGeneratedImageTag(tag, ERROR_IMAGE_PATH));

            if (abortController.signal.aborted) {
                toastr.warning('Генерация отменена', 'Генерация картинок');
                break;
            }
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    }

    processingMessages.delete(messageId);
    activeAbortControllers.delete(messageId);
    await context.saveChat();

    // Do not rebuild .mes_text here. ExtBlocks may expose its generated
    // content through extra.display_text and Horae mounts panels beside it.
    // ST owns message formatting; our MutationObserver restores only image
    // controls after another extension rerenders the message.
    await restoreImageRegenButtons(messageElement, messageId);
}

// ============================================================
// SINGLE IMAGE REGENERATION
// ============================================================

async function regenerateSingleImage(messageId, tagIndex) {
    if (processingMessages.has(messageId)) {
        toastr.info('В этом сообщении уже идёт генерация. Дождитесь завершения или отмените её.');
        return;
    }
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (processingMessages.has(messageId)) return;
    if (!tags[tagIndex]) { toastr.error('Тег не найден'); return; }
    const tag = tags[tagIndex];

    const settings = getSettings();
    const tagStyle = buildEffectiveStyle(tag.style);

    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    const allWrappers = Array.from(mesTextEl.querySelectorAll('.iig-image-wrapper'));
    const allImgs = Array.from(mesTextEl.querySelectorAll('img.iig-generated-image, img.iig-error-image, img[data-iig-instruction]'));
    const targetEl = allWrappers.find(el => Number(el.dataset.tagIndex) === tagIndex) || allImgs[tagIndex];
    if (!targetEl) { toastr.error('Картинка не найдена в DOM'); return; }
    processingMessages.add(messageId);

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);
    const lp = createLoadingPlaceholder(`iig-single-${messageId}-${tagIndex}`, () => abortController.abort());
    targetEl.replaceWith(lp);
    const statusEl = lp.querySelector('.iig-status');

    let refData;
    try { refData = await collectReferenceImages(tag.prompt); } catch (_) {
        refData = { imageRefs: [], textOnlyClothing: [], warnings: [] };
    }

    try {
        const dataUrl = await generateImageWithRetry(
            tag.prompt, tagStyle,
            (s) => { if (statusEl) statusEl.textContent = s; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality, preset: tag.preset, negativePrompt: tag.negativePrompt, refData, signal: abortController.signal }
        );
        if (statusEl) statusEl.textContent = 'Сохранение...';
        const imagePath = await saveImageToFile(dataUrl);

        const img = document.createElement('img');
        img.className = 'iig-generated-image';
        img.src = imagePath;
        img.alt = tag.prompt;
        const instrMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instrMatch) img.setAttribute('data-iig-instruction', instrMatch[2]);

        const wrapped = wrapImageWithRegen(img, messageId, tagIndex);
        lp.replaceWith(wrapped);

        message.mes = message.mes.replace(tag.fullMatch, buildGeneratedImageTag(tag, imagePath));
        await context.saveChat();
        toastr.success('Картинка перегенерирована', 'Генерация картинок', { timeOut: 2000 });
    } catch (error) {
        iigLog('ERROR', `Single regen failed: ${error.message}`);
        lp.replaceWith(targetEl);
        if (abortController.signal.aborted) toastr.warning('Генерация отменена');
        else toastr.error(`Ошибка: ${error.message}`);
    } finally {
        processingMessages.delete(messageId);
        activeAbortControllers.delete(messageId);
        await restoreImageRegenButtons(messageElement, messageId);
    }
}

// ============================================================
// MESSAGE REGENERATION (ALL IMAGES)
// ============================================================

async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) { toastr.error('Сообщение не найдено'); return; }

    const tags = await parseImageTags(message.mes, { forceAll: true });
    if (tags.length === 0) { toastr.warning('Нет тегов для перегенерации'); return; }

    const settings = getSettings();

    processingMessages.add(messageId);
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) { processingMessages.delete(messageId); return; }
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) { processingMessages.delete(messageId); return; }

    const abortController = new AbortController();
    activeAbortControllers.set(messageId, abortController);

    // Shared references
    const allPrompts = tags.map(t => t.prompt).join(' ');
    let sharedRefData;
    try { sharedRefData = await collectReferenceImages(allPrompts); } catch (e) {
        sharedRefData = { imageRefs: [], textOnlyClothing: [], warnings: [] };
    }

    const allWrappers = Array.from(mesTextEl.querySelectorAll('.iig-image-wrapper'));
    const allBareImgs = Array.from(mesTextEl.querySelectorAll('img[data-iig-instruction], img.iig-generated-image, img.iig-error-image'));
    const targetPool = allWrappers.length >= tags.length ? allWrappers :
        allWrappers.length > 0 ? allWrappers : allBareImgs;

    for (let index = 0; index < tags.length; index++) {
        if (abortController.signal.aborted) break;

        const tag = tags[index];
        const tagStyle = buildEffectiveStyle(tag.style);

        const targetEl = targetPool[index] || null;
        if (!targetEl) { iigLog('WARN', `No matching element for tag ${index}`); continue; }

        const innerImg = targetEl.querySelector?.('img[data-iig-instruction]') || targetEl;
        let lp = null;

        try {
            const instruction = innerImg.getAttribute?.('data-iig-instruction');
            lp = createLoadingPlaceholder(`iig-regen-${messageId}-${index}`, () => abortController.abort());
            targetEl.replaceWith(lp);
            const statusEl = lp.querySelector('.iig-status');

            const dataUrl = await generateImageWithRetry(
                tag.prompt, tagStyle,
                (s) => { if (statusEl) statusEl.textContent = s; },
                {
                    aspectRatio: tag.aspectRatio,
                    imageSize: tag.imageSize,
                    quality: tag.quality,
                    preset: tag.preset,
                    negativePrompt: tag.negativePrompt,
                    refData: sharedRefData,
                    signal: abortController.signal
                }
            );

            if (statusEl) statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);

            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            if (instruction) img.setAttribute('data-iig-instruction', instruction);

            const wrapped = wrapImageWithRegen(img, messageId, index);
            lp.replaceWith(wrapped);

            message.mes = message.mes.replace(tag.fullMatch, tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`));
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Regen failed for tag ${index}: ${error.message}`);
            // Put the previous picture back; otherwise the «Генерация… / Отмена» placeholder stayed forever.
            if (lp?.isConnected) lp.replaceWith(targetEl);
            if (abortController.signal.aborted) { toastr.warning('Перегенерация отменена'); break; }
            toastr.error(`Ошибка: ${error.message}`);
        }
    }

    processingMessages.delete(messageId);
    activeAbortControllers.delete(messageId);
    await context.saveChat();
}

// ============================================================
// REGEN BUTTONS ON MESSAGES
// ============================================================

function addRegenerateButton(messageElement, messageId) {
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    const extra = messageElement.querySelector('.extraMesButtons');
    if (!extra) return;
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => { e.stopPropagation(); await regenerateMessageImages(messageId); });
    extra.appendChild(btn);
}

function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat?.length) return;
    for (const el of document.querySelectorAll('#chat .mes')) {
        const mesId = el.getAttribute('mesid');
        if (mesId === null) continue;
        const mid = parseInt(mesId, 10);
        const msg = context.chat[mid];
        if (msg && !msg.is_user) {
            addRegenerateButton(el, mid);
            restoreImageRegenButtons(el, mid);
        }
    }
}

/** Is this reply being written right now (streaming)? The block waits for the end instead of riding along. */
function isMessageStreaming(messageId) {
    const processor = SillyTavern.getContext().streamingProcessor;
    if (!processor || processor.isFinished || processor.isStopped) return false;
    const streamingId = Number(processor.messageId);
    return !Number.isInteger(streamingId) || streamingId === Number(messageId);
}

function ensurePromptPanelForMessage(messageElement, messageId, { rerender = false } = {}) {
    if (!messageElement || messageId == null) return null;
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!message || message.is_user) return null;
    const known = promptPanels.get(messageId);
    // While the reply streams, the block is not shown: its spot is chosen once the whole text is there
    // (otherwise it lands after the first paragraphs, i.e. at the top, and stays there).
    if (isMessageStreaming(messageId)) {
        if (known) {
            known.panel.remove();
            known.anchor = null;
        }
        messageElement.querySelectorAll('.iig-prompt-panel').forEach(panel => panel.remove());
        return null;
    }
    let panel = known?.mesEl === messageElement ? known.panel : messageElement.querySelector('.iig-prompt-panel');
    const isNew = !panel;
    if (!panel) {
        panel = document.createElement('div');
        panel.className = 'iig-prompt-panel';
    }
    const entry = known?.mesEl === messageElement ? known : { panel, mesEl: messageElement, anchor: null };
    entry.panel = panel;
    promptPanels.set(messageId, entry);
    placePromptPanel(messageElement, panel, entry);
    if (isNew || (rerender && !activePromptAbortControllers.has(messageId))) renderPromptPanel(panel, messageId);
    return panel;
}

/**
 * Puts the block in the middle of the reply (after the middle paragraph) or after the text.
 * ExtBlocks mode always uses the end: there the reply HTML is rebuilt into artifacts.
 */
function placePromptPanel(messageElement, panel, entry = null) {
    const text = messageElement.querySelector('.mes_text');
    const settings = getSettings();
    const middle = settings.promptPanelPosition !== 'end' && normalizeImageDisplayMode(settings.imageDisplayMode) !== 'extblocks';
    if (!text || !middle) {
        const host = text?.parentElement || messageElement;
        if (panel.parentElement !== host || (text && panel.previousElementSibling !== text && host.lastElementChild !== panel)) host.appendChild(panel);
        return;
    }
    const { container, blocks } = promptPanelBlocks(text, panel);
    const lengths = blocks.map(block => block.textContent.replace(/\s+/g, ' ').trim().length);
    const total = lengths.reduce((sum, length) => sum + length, 0);
    if (lengths.filter(Boolean).length < 2) {
        if (panel.parentElement !== text || text.lastElementChild !== panel) text.appendChild(panel);
        return;
    }
    // The spot is chosen once — after the paragraph where the middle of the text is — and kept as a text
    // position, so re-renders and swipes put the block back to the same place instead of moving it around.
    if (entry && entry.anchor == null) entry.anchor = Math.round(total / 2);
    const target = Math.min(entry?.anchor ?? Math.round(total / 2), total);
    let index = 0;
    for (let sum = 0; index < blocks.length; index++) {
        sum += lengths[index];
        if (lengths[index] && sum >= target) break;
    }
    // Never after the last paragraph (that is «в конце») and never after an empty block (a line, a picture).
    const lastText = lengths.map(Boolean).lastIndexOf(true);
    index = Math.min(index, lastText - 1);
    while (index > 0 && !lengths[index]) index--;
    const anchor = blocks[Math.max(0, index)];
    if (panel.previousElementSibling !== anchor || panel.parentElement !== container) anchor.after(panel);
}

/**
 * Paragraph-level blocks of the reply. When the whole text sits inside one plain wrapper
 * (a <div> with the paragraphs inside), the block goes between those paragraphs, not after the wrapper.
 */
function promptPanelBlocks(text, panel) {
    let container = text;
    for (let depth = 0; depth < 3; depth++) {
        const blocks = [...container.children].filter(child => child !== panel && !child.classList.contains('iig-prompt-panel') && !/^(BR|SCRIPT|STYLE)$/.test(child.tagName));
        const withText = blocks.filter(block => block.textContent.trim());
        const only = withText.length === 1 ? withText[0] : null;
        const paragraphs = only ? [...only.children].filter(child => /^(P|BLOCKQUOTE|UL|OL|H[1-6])$/.test(child.tagName)).length : 0;
        if (only && /^(DIV|SECTION|ARTICLE|BLOCKQUOTE)$/.test(only.tagName) && paragraphs >= 2) {
            container = only;
            continue;
        }
        return { container, blocks };
    }
    return { container, blocks: [...container.children].filter(child => child !== panel && !child.classList.contains('iig-prompt-panel')) };
}

/** SillyTavern rebuilds the reply HTML on edits, swipes and streaming — put lost panels back. */
function observePromptPanels() {
    const chat = document.getElementById('chat');
    if (!chat || promptPanelObserver) return;
    let scheduled = false;
    promptPanelObserver = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            for (const [messageId, entry] of promptPanels) {
                if (!entry.mesEl.isConnected) { promptPanels.delete(messageId); continue; }
                if (!entry.mesEl.contains(entry.panel) && !isMessageStreaming(messageId)) placePromptPanel(entry.mesEl, entry.panel, entry);
            }
        });
    });
    promptPanelObserver.observe(chat, { childList: true, subtree: true });
}

function replaceAllPromptPanels() {
    for (const entry of promptPanels.values()) {
        entry.anchor = null;
        if (entry.mesEl.isConnected) placePromptPanel(entry.mesEl, entry.panel, entry);
    }
}

/** «Внешность» under the prompt: the same profile appearance fields as in Персонажи → Профили. */
function promptAppearanceHtml(settings = getSettings()) {
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    const rows = [];
    if (character) {
        const profile = getCharacterProfile('char', getCurrentLibraryEntity('char', settings).key, settings, true);
        rows.push({ kind: 'char', name: character.name, value: profile?.appearance || '' });
    }
    const userProfile = getCharacterProfile('user', getCurrentLibraryEntity('user', settings).key, settings, true);
    rows.push({ kind: 'user', name: getExtensionPersona(settings).name || 'Персона', value: userProfile?.appearance || '' });
    return `<details class="iig-prompt-appearance" ${settings.promptAppearanceOpen ? 'open' : ''}>
            <summary title="Точная внешность: модель промпта не придумывает её заново, расширение само добавляет её в картинку"><i class="fa-solid fa-user-pen" aria-hidden="true"></i> Внешность</summary>
            ${rows.map(row => `<label class="iig-prompt-appearance-row"><span>${row.kind === 'user' ? 'Персона' : 'Бот'}: ${escapeHtml(row.name)}</span>
                <textarea class="text_pole iig-prompt-appearance-input" data-kind="${row.kind}" rows="2" placeholder="Пусто — заполните здесь или кнопкой «Описать по аватарке» в Персонажи → Профили">${escapeHtml(row.value)}</textarea></label>`).join('')}
        </details>`;
}

function bindPromptAppearance(panel) {
    panel.querySelector('.iig-prompt-appearance')?.addEventListener('toggle', event => {
        const settings = getSettings();
        if (settings.promptAppearanceOpen === event.currentTarget.open) return;
        settings.promptAppearanceOpen = event.currentTarget.open;
        saveSettings();
    });
    panel.querySelectorAll('.iig-prompt-appearance-input').forEach(input => {
        input.addEventListener('input', () => {
            const settings = getSettings();
            const kind = input.dataset.kind === 'user' ? 'user' : 'char';
            const profile = getCharacterProfile(kind, getCurrentLibraryEntity(kind, settings).key, settings, true);
            if (!profile) return;
            profile.appearance = input.value;
            saveSettings();
            // Other open panels and the settings card show the same profile.
            document.querySelectorAll(`.iig-prompt-appearance-input[data-kind="${kind}"]`).forEach(other => { if (other !== input) other.value = input.value; });
            const settingsField = document.querySelector(`.iig-profile-card[data-profile-kind="${kind}"] .iig-profile-appearance`);
            if (settingsField) settingsField.value = input.value;
        });
    });
}

/** Saves a generated picture (same-origin path or data URL) under its own file name. */
function downloadGeneratedImage(src) {
    const url = String(src || '');
    if (!url) return;
    const name = decodeURIComponent(url.split('?')[0].split('/').pop() || '') || `image_${Date.now()}.png`;
    const link = document.createElement('a');
    link.href = url;
    link.download = /^data:/.test(url) ? `image_${Date.now()}.png` : name;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

/** Full-screen preview of a generated picture with a download button. Esc, ✕ or a click beside the picture closes it. */
function openImageViewer(src, caption = '') {
    if (!src) return;
    document.getElementById('iig-image-viewer')?.remove();
    const previousFocus = document.activeElement;
    const viewer = document.createElement('div');
    viewer.id = 'iig-image-viewer';
    viewer.setAttribute('role', 'dialog');
    viewer.setAttribute('aria-modal', 'true');
    viewer.setAttribute('aria-label', 'Просмотр картинки');
    viewer.innerHTML = `
        <div class="iig-viewer-bar">
            <button type="button" class="iig-viewer-btn iig-viewer-download"><i class="fa-solid fa-download" aria-hidden="true"></i><span>Скачать</span></button>
            <button type="button" class="iig-viewer-btn iig-viewer-close" aria-label="Закрыть"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
        <img class="iig-viewer-image" src="${escapeHtml(src)}" alt="${escapeHtml(caption || 'Картинка')}">`;
    const close = () => {
        document.removeEventListener('keydown', onKey, true);
        viewer.remove();
        previousFocus?.focus?.();
    };
    const onKey = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    };
    viewer.addEventListener('click', event => {
        if (event.target === viewer) close();
    });
    viewer.querySelector('.iig-viewer-close').addEventListener('click', close);
    viewer.querySelector('.iig-viewer-download').addEventListener('click', () => downloadGeneratedImage(src));
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(viewer);
    viewer.querySelector('.iig-viewer-close').focus();
}

/** Short fingerprint of the reply text: «Авто» does not write a prompt again for a reply that already has one. */
function promptSourceHash(text) {
    let hash = 0;
    for (const char of String(text || '')) hash = (hash * 31 + char.codePointAt(0)) | 0;
    return String(hash);
}

function getPromptPanel(messageId) {
    const known = promptPanels.get(messageId)?.panel;
    if (known?.isConnected) return known;
    return document.querySelector(`#chat .mes[mesid="${messageId}"] .iig-prompt-panel`);
}

/** One line of the prompt for the collapsed card: its start, or — while it is being written — its newest words. */
function promptPreviewText(text, fromEnd = false) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length <= 220) return value;
    return fromEnd ? `…${value.slice(-220)}` : value.slice(0, 220);
}

/** Status chip, one-line preview, Stop button and the running stripe — without rebuilding the panel. */
function updatePromptPanelChrome(panel, messageId, { status = '', error = false } = {}) {
    if (!panel) return;
    const message = SillyTavern.getContext().chat?.[messageId];
    const prompt = String(message?.extra?.iig_prompt_block?.prompt || '');
    const writing = activePromptAbortControllers.has(messageId);
    const drawing = activeAbortControllers.has(messageId);
    panel.classList.toggle('is-busy', writing || drawing);
    panel.classList.toggle('has-error', Boolean(error));
    const [chipText, chipState] = writing ? ['пишу промпт', 'busy'] : drawing ? ['рисую', 'busy'] : error ? ['ошибка', 'error'] : prompt ? ['готов', 'ready'] : ['пусто', 'empty'];
    panel.querySelectorAll('.iig-prompt-chip').forEach(chip => {
        chip.textContent = chipText;
        chip.dataset.state = chipState;
        chip.title = error ? status : '';
    });
    const preview = panel.querySelector('.iig-pp-preview');
    if (preview && !writing) {
        preview.textContent = error ? status : (promptPreviewText(prompt) || 'Промпта ещё нет — нажмите «Промпт» или напишите свой');
        preview.classList.toggle('is-placeholder', !prompt && !error);
    }
    const statusLine = panel.querySelector('.iig-prompt-status');
    if (statusLine && status) statusLine.textContent = status;
    const badge = panel.querySelector('.iig-pp-busy-badge');
    if (badge) badge.textContent = writing ? 'Пишу промпт…' : drawing ? 'Рисую…' : '';
    panel.querySelectorAll('.iig-prompt-cancel').forEach(cancel => { cancel.hidden = !(writing || drawing); });
    panel.querySelectorAll('.iig-prompt-generate').forEach(generate => { generate.hidden = writing; });
    panel.querySelectorAll('.iig-image-from-prompt').forEach(button => button.classList.toggle('disabled', drawing));
}

function setPromptPanelExpanded(panel, messageId, expanded) {
    if (expanded) expandedPromptPanels.add(messageId); else expandedPromptPanels.delete(messageId);
    panel.classList.toggle('is-expanded', expanded);
    panel.querySelector('.iig-prompt-panel-body')?.classList.toggle('iig-collapsed-hidden', !expanded);
    panel.querySelectorAll('.iig-prompt-panel-toggle').forEach(button => {
        button.setAttribute('aria-expanded', String(expanded));
        button.title = expanded ? 'Свернуть' : (button.classList.contains('iig-pp-details') ? 'Подробнее: промпт и настройки' : 'Развернуть');
    });
    const details = panel.querySelector('.iig-pp-details span');
    if (details) details.textContent = expanded ? 'Свернуть' : 'Подробнее';
}

/** Writes the image prompt for a reply; used by the «Промпт» button and by «Авто». */
async function runPromptGeneration(messageId, { auto = false } = {}) {
    if (activePromptAbortControllers.has(messageId)) return false;
    const controller = new AbortController();
    activePromptAbortControllers.set(messageId, controller);
    const startPanel = getPromptPanel(messageId);
    updatePromptPanelChrome(startPanel, messageId, { status: 'Пишу промпт…' });
    const startPreview = startPanel?.querySelector('.iig-pp-preview');
    if (startPreview) { startPreview.textContent = 'Пишу промпт…'; startPreview.classList.add('is-placeholder'); }
    const onChunk = getSettings().promptGenStream
        ? text => {
            const panel = getPromptPanel(messageId);
            if (!panel) return;
            const textarea = panel.querySelector('.iig-prompt-value');
            if (textarea) { textarea.value = text; textarea.scrollTop = textarea.scrollHeight; }
            const preview = panel.querySelector('.iig-pp-preview');
            if (preview) { preview.textContent = promptPreviewText(text, true); preview.classList.remove('is-placeholder'); }
        }
        : null;
    try {
        await generateImagePromptForMessage(messageId, controller.signal, onChunk);
        activePromptAbortControllers.delete(messageId);
        const panel = getPromptPanel(messageId);
        if (panel) renderPromptPanel(panel, messageId);
        if (!auto) toastr.success('Промпт картинки готов');
        return true;
    } catch (error) {
        activePromptAbortControllers.delete(messageId);
        const aborted = error?.name === 'AbortError';
        const panel = getPromptPanel(messageId);
        if (panel) {
            renderPromptPanel(panel, messageId);
            updatePromptPanelChrome(panel, messageId, aborted ? { status: 'Остановлено' } : { status: error.message, error: true });
        }
        if (aborted) toastr.info('Генерация промпта остановлена');
        else if (!auto) toastr.error(`Промпт: ${error.message}`);
        return false;
    } finally {
        activePromptAbortControllers.delete(messageId);
    }
}

/** «Авто»: a new bot reply gets its image prompt once, unless it already has one for this exact text. */
function maybeAutoGeneratePrompt(messageId) {
    const settings = getSettings();
    if (!settings.promptAutoGenerate) return;
    const message = SillyTavern.getContext().chat?.[messageId];
    if (!message || message.is_user || message.is_system || !String(message.mes || '').trim()) return;
    if (message.extra?.iig_prompt_block?.sourceHash === promptSourceHash(message.mes)) return;
    // Prompt first, then the picture right away — no extra button press.
    runPromptGeneration(messageId, { auto: true }).then(ok => { if (ok) runImageFromPrompt(messageId, { auto: true }); });
}

async function runImageFromPrompt(messageId, { auto = false } = {}) {
    if (activeAbortControllers.has(messageId) || activePromptAbortControllers.has(messageId)) return;
    const hasPrompt = () => Boolean(String(SillyTavern.getContext().chat?.[messageId]?.extra?.iig_prompt_block?.prompt || '').trim());
    // No prompt yet: write it first, then draw.
    if (!hasPrompt() && !(await runPromptGeneration(messageId, { auto: true }))) return;
    if (!hasPrompt()) return;
    const controller = new AbortController();
    activeAbortControllers.set(messageId, controller);
    updatePromptPanelChrome(getPromptPanel(messageId), messageId, { status: 'Рисую…' });
    try {
        await generateImageFromPromptBlock(messageId, getPromptPanel(messageId), controller.signal);
        activeAbortControllers.delete(messageId);
        const panel = getPromptPanel(messageId);
        if (panel) renderPromptPanel(panel, messageId);
        if (!auto) toastr.success('Картинка по промпту готова');
    } catch (error) {
        activeAbortControllers.delete(messageId);
        const aborted = error?.name === 'AbortError';
        updatePromptPanelChrome(getPromptPanel(messageId), messageId, aborted ? { status: 'Остановлено' } : { status: error.message, error: true });
        if (!aborted && !auto) toastr.error(`Картинка: ${error.message}`);
    } finally {
        activeAbortControllers.delete(messageId);
    }
}

function renderPromptPanel(panel, messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat?.[messageId];
    if (!panel || !message) return;
    const state = message.extra?.iig_prompt_block || {};
    const settings = getSettings();
    const instruction = getPromptInstructions().find(item => item.id === state.instructionId) || getActivePromptInstruction();
    const expanded = expandedPromptPanels.has(messageId);
    const style = state.style || buildEffectiveStyle('') || '';
    const negative = state.negativePrompt || getActiveNegativePrompt() || '';
    const showFormat = settings.apiType === 'gemini' || isGeminiModel(settings.model || '');
    const image = state.imagePath ? escapeHtml(state.imagePath) : '';

    panel.classList.add('iig-pp');
    panel.classList.toggle('has-image', Boolean(image));
    panel.innerHTML = `
        ${image ? `<figure class="iig-pp-figure">
            <button type="button" class="iig-pp-image-open" title="Открыть на весь экран"><img class="iig-prompt-result-image" src="${image}" alt="${escapeHtml(state.prompt || 'Картинка')}"></button>
            <span class="iig-pp-busy-badge" aria-live="polite"></span>
            <figcaption class="iig-pp-figure-actions">
                <button type="button" class="iig-pp-image-btn iig-pp-image-download" title="Скачать картинку" aria-label="Скачать"><i class="fa-solid fa-download" aria-hidden="true"></i></button>
                <button type="button" class="iig-pp-image-btn iig-image-from-prompt" title="Перерисовать по этому промпту" aria-label="Перерисовать"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i></button>
                <button type="button" class="iig-pp-image-btn iig-prompt-cancel" hidden title="Остановить" aria-label="Остановить"><i class="fa-solid fa-stop" aria-hidden="true"></i></button>
                <button type="button" class="iig-pp-image-btn iig-pp-image-full" title="Открыть на весь экран" aria-label="На весь экран"><i class="fa-solid fa-expand" aria-hidden="true"></i></button>
                <button type="button" class="iig-pp-image-btn iig-pp-details iig-prompt-panel-toggle" aria-expanded="${expanded}" title="Подробнее: промпт и настройки"><i class="fa-solid fa-sliders" aria-hidden="true"></i><span>Подробнее</span></button>
            </figcaption>
        </figure>` : ''}
        ${image ? '' : `<div class="iig-pp-dock" role="toolbar" aria-label="Картинка к ответу">
            <button type="button" class="iig-pp-icon iig-prompt-generate" title="Написать промпт по этому ответу" aria-label="Написать промпт"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>
            <button type="button" class="iig-pp-icon iig-image-from-prompt" title="Нарисовать картинку (если промпта нет — сначала напишет его)" aria-label="Нарисовать картинку"><i class="fa-solid fa-image" aria-hidden="true"></i></button>
            <button type="button" class="iig-pp-icon iig-pp-icon-stop iig-prompt-cancel" hidden title="Остановить" aria-label="Остановить"><i class="fa-solid fa-stop" aria-hidden="true"></i></button>
            <button type="button" class="iig-pp-icon iig-prompt-auto-toggle${settings.promptAutoGenerate ? ' is-on' : ''}" aria-pressed="${!!settings.promptAutoGenerate}" title="Авто: промпт и картинка сами после каждого нового ответа" aria-label="Авто"><i class="fa-solid fa-robot" aria-hidden="true"></i></button>
            <span class="iig-pp-dock-status iig-prompt-chip" aria-live="polite"></span>
            <button type="button" class="iig-pp-icon iig-prompt-panel-toggle" aria-expanded="${expanded}" title="Подробнее: промпт и настройки" aria-label="Подробнее"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
        </div>`}
        <div class="iig-pp-head">
            <button type="button" class="iig-pp-summary iig-prompt-panel-toggle" aria-expanded="${expanded}" title="${expanded ? 'Свернуть' : 'Развернуть'}">
                <span class="iig-pp-thumb"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></span>
                <span class="iig-pp-text">
                    <span class="iig-pp-title">Промпт картинки <span class="iig-pp-chip iig-prompt-chip"></span></span>
                    <span class="iig-pp-preview"></span>
                </span>
            </button>
            <div class="iig-pp-actions">
                <button type="button" class="menu_button iig-pp-btn iig-prompt-generate" title="Написать промпт по этому ответу"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i><span>Промпт</span></button>
                <button type="button" class="menu_button iig-pp-btn iig-prompt-cancel" hidden title="Остановить"><i class="fa-solid fa-stop" aria-hidden="true"></i><span>Стоп</span></button>
                <button type="button" class="menu_button iig-pp-btn iig-image-from-prompt" title="Нарисовать картинку по промпту"><i class="fa-solid fa-image" aria-hidden="true"></i><span>Картинка</span></button>
                <button type="button" class="iig-pp-chevron iig-prompt-panel-toggle" aria-expanded="${expanded}" title="${expanded ? 'Свернуть' : 'Развернуть'}" aria-label="Развернуть панель промпта"><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button>
            </div>
        </div>
        <div class="iig-pp-body iig-prompt-panel-body ${expanded ? '' : 'iig-collapsed-hidden'}">
            <div class="iig-pp-toolbar iig-prompt-panel-controls">
                <span class="iig-pp-instruction iig-prompt-selection" title="Инструкция для модели промпта — выбирается в настройках"><i class="fa-solid fa-scroll" aria-hidden="true"></i> ${escapeHtml(instruction.name)}</span>
                <span class="iig-pp-main-actions">
                    <button type="button" class="menu_button iig-pp-pill iig-pp-primary iig-prompt-generate" title="Написать промпт по этому ответу"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Промпт</button>
                    <button type="button" class="menu_button iig-pp-pill iig-pp-primary iig-prompt-cancel" hidden title="Остановить"><i class="fa-solid fa-stop" aria-hidden="true"></i> Стоп</button>
                    <button type="button" class="menu_button iig-pp-pill iig-pp-primary iig-image-from-prompt" title="Нарисовать картинку по промпту"><i class="fa-solid fa-image" aria-hidden="true"></i> ${image ? 'Перерисовать' : 'Картинка'}</button>
                </span>
                <span class="iig-pp-toggles">
                    <button type="button" class="menu_button iig-pp-pill iig-prompt-auto-toggle${settings.promptAutoGenerate ? ' is-on' : ''}" aria-pressed="${!!settings.promptAutoGenerate}" title="Авто: промпт и картинка сами после каждого нового ответа"><i class="fa-solid fa-robot" aria-hidden="true"></i> Авто</button>
                    <button type="button" class="menu_button iig-pp-pill iig-prompt-stream-toggle${settings.promptGenStream ? ' iig-stream-on is-on' : ''}" aria-pressed="${!!settings.promptGenStream}" title="Показывать промпт, пока он пишется"><i class="fa-solid fa-bolt" aria-hidden="true"></i> Стрим</button>
                    ${showFormat ? `<button type="button" class="menu_button iig-pp-pill iig-gemini-format-toggle${settings.geminiRandomFormat ? ' iig-format-on is-on' : ''}" aria-pressed="${!!settings.geminiRandomFormat}" title="Случайный формат Gemini (каждый запрос)"><i class="fa-solid fa-dice" aria-hidden="true"></i> Формат</button>` : ''}
                </span>
            </div>
            <textarea class="text_pole iig-prompt-value" rows="5" placeholder="Нажмите «Промпт» или напишите свой — картинка нарисуется по этому тексту"></textarea>
            <div class="iig-pp-status iig-prompt-status" role="status"></div>
            ${promptAppearanceHtml(settings)}
            <details class="iig-pp-meta" ${settings.promptMetaCollapsed ? '' : 'open'}>
                <summary class="iig-prompt-meta-toggle">Стиль и негатив</summary>
                <dl>
                    <dt>Стиль</dt><dd>${escapeHtml(style || 'не выбран')}</dd>
                    <dt>Негатив</dt><dd>${escapeHtml(negative || 'не выбран')}</dd>
                </dl>
            </details>
        </div>
        <div class="iig-pp-progress" aria-hidden="true"></div>`;

    setPromptPanelExpanded(panel, messageId, expanded);
    updatePromptPanelChrome(panel, messageId);

    const openViewer = () => openImageViewer(state.imagePath, state.prompt);
    panel.querySelector('.iig-pp-image-open')?.addEventListener('click', openViewer);
    panel.querySelector('.iig-pp-image-full')?.addEventListener('click', openViewer);
    panel.querySelector('.iig-pp-image-download')?.addEventListener('click', () => downloadGeneratedImage(state.imagePath));

    panel.querySelectorAll('.iig-prompt-panel-toggle').forEach(button => button.addEventListener('click', () => {
        setPromptPanelExpanded(panel, messageId, !expandedPromptPanels.has(messageId));
    }));
    panel.querySelector('.iig-pp-meta')?.addEventListener('toggle', event => {
        const settings = getSettings();
        const collapsed = !event.currentTarget.open;
        if (settings.promptMetaCollapsed === collapsed) return;
        settings.promptMetaCollapsed = collapsed;
        saveSettings();
    });
    bindPromptAppearance(panel);

    const textarea = panel.querySelector('.iig-prompt-value');
    textarea.value = activePromptAbortControllers.has(messageId) ? textarea.value : (state.prompt || '');
    textarea.addEventListener('change', async () => {
        if (!message.extra || typeof message.extra !== 'object') message.extra = {};
        message.extra.iig_prompt_block = {
            ...(message.extra.iig_prompt_block || {}),
            prompt: textarea.value.trim(),
            style: buildEffectiveStyle(''),
            negativePrompt: getActiveNegativePrompt(),
            updatedAt: Date.now(),
        };
        updatePromptPanelChrome(panel, messageId);
        await context.saveChat();
    });

    panel.querySelectorAll('.iig-prompt-cancel').forEach(button => button.addEventListener('click', () => {
        activePromptAbortControllers.get(messageId)?.abort();
        activeAbortControllers.get(messageId)?.abort();
    }));
    panel.querySelectorAll('.iig-prompt-generate').forEach(button => button.addEventListener('click', () => runPromptGeneration(messageId)));
    panel.querySelectorAll('.iig-image-from-prompt').forEach(button => button.addEventListener('click', () => runImageFromPrompt(messageId)));

    const syncToggle = (selector, value, extraClass) => document.querySelectorAll(selector).forEach(button => {
        button.classList.toggle('is-on', value);
        if (extraClass) button.classList.toggle(extraClass, value);
        button.setAttribute('aria-pressed', String(value));
    });
    panel.querySelectorAll('.iig-prompt-auto-toggle').forEach(toggleButton => toggleButton.addEventListener('click', () => {
        const settings = getSettings();
        settings.promptAutoGenerate = !settings.promptAutoGenerate;
        saveSettings();
        syncToggle('.iig-prompt-auto-toggle', settings.promptAutoGenerate);
        toastr.info(settings.promptAutoGenerate ? 'Авто: промпт и картинка будут появляться сами после каждого нового ответа' : 'Авто выключено: нажимайте ✦ (промпт) или 🖼 (картинка) сами');
    }));
    panel.querySelector('.iig-prompt-stream-toggle')?.addEventListener('click', () => {
        const settings = getSettings();
        settings.promptGenStream = !settings.promptGenStream;
        saveSettings();
        syncToggle('.iig-prompt-stream-toggle', settings.promptGenStream, 'iig-stream-on');
        toastr.info(settings.promptGenStream ? 'Стриминг промпта включён' : 'Стриминг промпта выключен');
    });
    panel.querySelector('.iig-gemini-format-toggle')?.addEventListener('click', () => {
        const settings = getSettings();
        settings.geminiRandomFormat = !settings.geminiRandomFormat;
        saveSettings();
        syncToggle('.iig-gemini-format-toggle', settings.geminiRandomFormat, 'iig-format-on');
        toastr.info(settings.geminiRandomFormat ? 'Gemini: рандомный формат включён' : 'Gemini: фиксированный формат');
    });
}

function addPromptPanelsToExistingMessages() {
    const context = SillyTavern.getContext();
    for (const element of document.querySelectorAll('#chat .mes')) {
        const id = element.getAttribute('mesid');
        if (id !== null && context.chat?.[Number(id)] && !context.chat[Number(id)].is_user) ensurePromptPanelForMessage(element, Number(id));
    }
}

async function onMessageReceived(messageId) {
    const settings = getSettings();
    if (!settings.enabled) return;
    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;
    addRegenerateButton(el, messageId);
    ensurePromptPanelForMessage(el, Number(messageId), { rerender: true });
    if (pendingAutoPrompts.delete(Number(messageId))) maybeAutoGeneratePrompt(Number(messageId));
    await processMessageTags(messageId);
    await restoreImageRegenButtons(el, messageId);
}

// ============================================================
// UI: NPC LIST
// ============================================================

function renderNpcList() {
    const settings = getSettings();
    const container = document.getElementById('iig_npc_list');
    if (!container) return;
    container.innerHTML = '';

    if (!settings.npcReferences || settings.npcReferences.length === 0) {
        container.innerHTML = '<p style="color:#5a5252;font-size:13px;">Нет добавленных NPC</p>';
        return;
    }

    for (let i = 0; i < settings.npcReferences.length; i++) {
        const npc = settings.npcReferences[i];
        ensureNpcDefaults(npc);

        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px;margin-bottom:8px;background:rgba(0,0,0,0.1);';

        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = npc.enabled !== false;
        checkbox.addEventListener('change', (e) => {
            settings.npcReferences[i].enabled = e.target.checked;
            saveSettings();
        });

        const preview = document.createElement('div');
        preview.style.cssText = 'width:40px;height:40px;border-radius:6px;overflow:hidden;flex-shrink:0;cursor:pointer;';
        if (npc.imageData) {
            const img = document.createElement('img');
            img.src = `data:image/jpeg;base64,${npc.imageData}`;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            preview.appendChild(img);
        } else {
            preview.style.cssText += 'background:#2a2a2a;display:flex;align-items:center;justify-content:center;';
            preview.innerHTML = '<i class="fa-solid fa-user" style="color:#5a5252;font-size:16px;"></i>';
        }

        preview.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => {
                    const rawBase64 = ev.target.result.split(',')[1];
                    try {
                        const resized = await resizeImageBase64(rawBase64, 768);
                        settings.npcReferences[i].imageData = resized;
                        saveSettings();
                        renderNpcList();
                        toastr.success(`Картинка для ${npc.name} загружена`, 'NPC');
                    } catch (err) {
                        toastr.error('Ошибка сжатия картинки', 'NPC');
                    }
                };
                reader.readAsDataURL(file);
            });
            fileInput.click();
        });

        const nameSpan = document.createElement('span');
        nameSpan.textContent = npc.name;
        nameSpan.style.cssText = 'flex:1;min-width:0;color:#e8e0e0;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;';
        const aliasList = getNpcAliases(npc);
        if (aliasList.length) {
            const aliasHint = document.createElement('small');
            aliasHint.textContent = aliasList.join(', ');
            aliasHint.style.cssText = 'display:block;color:#7a7272;font-size:12px;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            nameSpan.appendChild(aliasHint);
        }

        const expandBtn = document.createElement('div');
        expandBtn.className = 'menu_button';
        expandBtn.title = 'Развернуть/свернуть';
        expandBtn.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
        expandBtn.dataset.expanded = 'false';

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'menu_button';
        deleteBtn.title = 'Удалить NPC';
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        deleteBtn.style.color = '#cc5555';
        deleteBtn.addEventListener('click', () => {
            if (!confirm(`Удалить NPC "${npc.name}"?`)) return;
            settings.npcReferences.splice(i, 1);
            saveSettings();
            renderNpcList();
            toastr.info(`NPC "${npc.name}" удалён`, 'NPC');
        });

        headerRow.appendChild(checkbox);
        headerRow.appendChild(preview);
        headerRow.appendChild(nameSpan);
        headerRow.appendChild(expandBtn);
        headerRow.appendChild(deleteBtn);

        const activeNpcOutfit = getActiveNpcOutfit(npc);

        const outfitsHtml = npc.outfits.map(outfit => {
            const active = outfit.id === npc.activeOutfitId;
            return `
                <div class="npc-outfit-card" data-npc-index="${i}" data-outfit-id="${outfit.id}" style="position:relative;width:72px;border:2px solid ${active ? '#ffb6c1' : 'rgba(255,255,255,0.08)'};border-radius:8px;overflow:hidden;cursor:pointer;background:rgba(255,255,255,0.02);">
                    <div style="width:100%;height:72px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;overflow:hidden;">
                        ${outfit.imageData
                            ? `<img src="data:image/png;base64,${outfit.imageData}" style="width:100%;height:100%;object-fit:cover;">`
                            : `<i class="fa-solid fa-shirt" style="color:#666;"></i>`}
                    </div>
                    <div style="padding:4px;font-size:11px;color:#fff;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${outfit.name}</div>
                </div>
            `;
        }).join('');

        const detailsPanel = document.createElement('div');
        detailsPanel.style.cssText = 'display:none;padding-top:8px;border-top:1px solid rgba(255,255,255,0.05);';
        detailsPanel.innerHTML = `
            <div style="margin-bottom:8px;">
                <label style="font-size:13px;color:#9a9292;display:block;margin-bottom:3px;">Другие имена (через запятую):</label>
                <div class="iig-names-row">
                    <input type="text" class="text_pole npc-aliases-input" data-npc-index="${i}" style="font-size:13px;"
                        placeholder="Misha, Orekhov, Миша…" value="${escapeHtml(getNpcAliases(npc).join(', '))}">
                    <button type="button" class="menu_button iig-names-generate npc-aliases-generate" title="Сгенерировать варианты имени и фамилии на русском и английском (модель описаний гардероба или модель чата)" aria-label="Сгенерировать имена"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>
                </div>
                <div style="font-size:12px;color:#7a7272;margin-top:2px;">Реф уходит, если в промпте есть имя, любое из этих слов или их транслит (Орехов → Orekhov).</div>
            </div>
            <div style="margin-bottom:8px;">
                <label style="font-size:13px;color:#9a9292;display:block;margin-bottom:3px;">Описание внешности:</label>
                <textarea class="text_pole npc-appearance-input" rows="3" style="width:100%;font-size:13px;resize:vertical;"
                    placeholder="Опишите внешность NPC..."
                    data-npc-index="${i}">${npc.appearance || ''}</textarea>
                <div style="display:flex;gap:6px;margin-top:4px;">
                    <div class="menu_button iig-npc-text-btn npc-appearance-generate" data-npc-index="${i}" style="font-size:13px;">
                        <i class="fa-solid fa-robot"></i> Сгенерировать
                    </div>
                    <div class="menu_button iig-npc-text-btn npc-appearance-save" data-npc-index="${i}" style="font-size:13px;">
                        <i class="fa-solid fa-floppy-disk"></i> Сохранить
                    </div>
                </div>
                <div id="npc_appearance_status_${i}" style="display:none;font-size:12px;margin-top:4px;"></div>
            </div>

            <div style="margin-bottom:8px;">
                <label style="font-size:13px;color:#9a9292;display:block;margin-bottom:3px;">Наряды NPC:</label>
                <div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
                    <input type="text" class="text_pole npc-outfit-name" data-npc-index="${i}" placeholder="Название наряда..." style="flex:1;font-size:13px;">
                    <div class="menu_button iig-npc-text-btn npc-outfit-add" data-npc-index="${i}" style="font-size:13px;">
                        <i class="fa-solid fa-plus"></i> Добавить
                    </div>
                </div>
                <div class="npc-outfits-grid" style="display:flex;flex-wrap:wrap;gap:8px;max-height:180px;overflow-y:auto;margin-bottom:8px;">
                    ${outfitsHtml || '<div style="color:#666;font-size:13px;">Нарядов пока нет</div>'}
                </div>
            </div>

            ${activeNpcOutfit ? `
                <div>
                    <label style="font-size:13px;color:#9a9292;display:block;margin-bottom:3px;">Описание активного наряда: <b>${activeNpcOutfit.name}</b></label>
                    <textarea class="text_pole npc-outfit-description" rows="3" style="width:100%;font-size:13px;resize:vertical;"
                        data-npc-index="${i}" data-outfit-id="${activeNpcOutfit.id}"
                        placeholder="Введите описание наряда вручную или сгенерируйте...">${activeNpcOutfit.description || ''}</textarea>
                    <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;">
                        <div class="menu_button iig-npc-text-btn npc-outfit-generate" data-npc-index="${i}" data-outfit-id="${activeNpcOutfit.id}" style="font-size:13px;">
                            <i class="fa-solid fa-robot"></i> Сгенерировать
                        </div>
                        <div class="menu_button iig-npc-text-btn npc-outfit-save" data-npc-index="${i}" data-outfit-id="${activeNpcOutfit.id}" style="font-size:13px;">
                            <i class="fa-solid fa-floppy-disk"></i> Сохранить
                        </div>
                        <div class="menu_button iig-npc-text-btn npc-outfit-clear" data-npc-index="${i}" data-outfit-id="${activeNpcOutfit.id}" style="font-size:13px;">
                            <i class="fa-solid fa-eraser"></i>
                        </div>
                        <div class="menu_button iig-npc-text-btn npc-outfit-delete" data-npc-index="${i}" data-outfit-id="${activeNpcOutfit.id}" style="font-size:13px;color:#cc5555;">
                            <i class="fa-solid fa-trash"></i>
                        </div>
                    </div>
                    <div id="npc_outfit_status_${i}" style="display:none;font-size:12px;margin-top:4px;"></div>
                </div>
            ` : ''}
        `;

        expandBtn.addEventListener('click', () => {
            const isExpanded = expandBtn.dataset.expanded === 'true';
            expandBtn.dataset.expanded = !isExpanded;
            detailsPanel.style.display = isExpanded ? 'none' : 'block';
            expandBtn.querySelector('i').classList.toggle('fa-chevron-down', isExpanded);
            expandBtn.querySelector('i').classList.toggle('fa-chevron-up', !isExpanded);
        });

        detailsPanel.querySelector('.npc-aliases-input')?.addEventListener('change', (e) => {
            settings.npcReferences[i].aliases = splitNameList(e.target.value);
            saveSettings();
            renderNpcList();
        });

        detailsPanel.querySelector('.npc-aliases-generate')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = settings.npcReferences[i];
            const input = detailsPanel.querySelector('.npc-aliases-input');
            runNameGenerationButton(e.currentTarget, async () => {
                const names = await generateNameVariants(target?.name, splitNameList(input?.value || ''), '');
                target.aliases = names;
                if (input) input.value = names.join(', ');
                saveSettings();
                toastr.success(names.join(', ') || 'Новых вариантов нет', `Имена: ${target.name}`, { timeOut: 6000 });
            });
        });

        detailsPanel.querySelector('.npc-appearance-input')?.addEventListener('blur', (e) => {
            const idx = parseInt(e.target.dataset.npcIndex);
            settings.npcReferences[idx].appearance = e.target.value;
            saveSettings();
        });

        detailsPanel.querySelector('.npc-appearance-save')?.addEventListener('click', () => {
            const textarea = detailsPanel.querySelector('.npc-appearance-input');
            settings.npcReferences[i].appearance = textarea.value;
            saveSettings();
            toastr.success('Описание внешности сохранено');
        });

        detailsPanel.querySelector('.npc-appearance-generate')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const statusEl = document.getElementById(`npc_appearance_status_${i}`);
            const textarea = detailsPanel.querySelector('.npc-appearance-input');

            btn.classList.add('disabled');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.textContent = 'Анализ изображения NPC...';
                statusEl.style.color = '#aaa';
            }

            try {
                const desc = await generateNpcAppearanceDescription(i);
                textarea.value = desc;
                settings.npcReferences[i].appearance = desc;
                saveSettings();
                if (statusEl) {
                    statusEl.textContent = 'Описание внешности сгенерировано!';
                    statusEl.style.color = '#8f8';
                }
                toastr.success('Внешность NPC сгенерирована');
            } catch (error) {
                if (statusEl) {
                    statusEl.textContent = `Ошибка: ${error.message}`;
                    statusEl.style.color = '#f88';
                }
                toastr.error(`Ошибка: ${error.message}`);
            } finally {
                btn.classList.remove('disabled');
                btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
                setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
            }
        });

        detailsPanel.querySelector('.npc-outfit-add')?.addEventListener('click', () => {
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const resized = await resizeImageBase64(reader.result.split(',')[1], 512);
                    const nameInput = detailsPanel.querySelector('.npc-outfit-name');
                    const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, '') || 'Outfit';
                    addNpcOutfit(i, name, resized);
                    renderNpcList();
                    toastr.success(`Наряд "${name}" добавлен для ${npc.name}`);
                };
                reader.readAsDataURL(file);
            });
            fileInput.click();
        });

        detailsPanel.querySelectorAll('.npc-outfit-card').forEach(el => {
            el.addEventListener('click', () => {
                setActiveNpcOutfit(i, el.dataset.outfitId);
                renderNpcList();
            });
        });

        detailsPanel.querySelector('.npc-outfit-description')?.addEventListener('blur', (e) => {
            updateNpcOutfitDescription(i, e.target.dataset.outfitId, e.target.value);
        });

        detailsPanel.querySelector('.npc-outfit-save')?.addEventListener('click', () => {
            const textarea = detailsPanel.querySelector('.npc-outfit-description');
            if (!textarea) return;
            updateNpcOutfitDescription(i, textarea.dataset.outfitId, textarea.value);
            toastr.success('Описание наряда сохранено');
        });

        detailsPanel.querySelector('.npc-outfit-clear')?.addEventListener('click', () => {
            const textarea = detailsPanel.querySelector('.npc-outfit-description');
            if (!textarea) return;
            textarea.value = '';
            updateNpcOutfitDescription(i, textarea.dataset.outfitId, '');
            toastr.info('Описание наряда очищено');
            renderNpcList();
        });

        detailsPanel.querySelector('.npc-outfit-delete')?.addEventListener('click', () => {
            const outfitId = detailsPanel.querySelector('.npc-outfit-description')?.dataset.outfitId;
            if (!outfitId) return;
            removeNpcOutfit(i, outfitId);
            renderNpcList();
            toastr.info('Наряд удалён');
        });

        detailsPanel.querySelector('.npc-outfit-generate')?.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            const outfitId = btn.dataset.outfitId;
            const statusEl = document.getElementById(`npc_outfit_status_${i}`);
            const textarea = detailsPanel.querySelector('.npc-outfit-description');

            btn.classList.add('disabled');
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
            if (statusEl) {
                statusEl.style.display = 'block';
                statusEl.textContent = 'Анализ изображения наряда...';
                statusEl.style.color = '#aaa';
            }

            try {
                const desc = await generateNpcOutfitDescription(i, outfitId);
                if (textarea) textarea.value = desc;
                updateNpcOutfitDescription(i, outfitId, desc);
                if (statusEl) {
                    statusEl.textContent = 'Описание наряда сгенерировано!';
                    statusEl.style.color = '#8f8';
                }
                toastr.success('Описание наряда NPC сгенерировано');
                renderNpcList();
            } catch (error) {
                if (statusEl) {
                    statusEl.textContent = `Ошибка: ${error.message}`;
                    statusEl.style.color = '#f88';
                }
                toastr.error(`Ошибка: ${error.message}`);
            } finally {
                btn.classList.remove('disabled');
                btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
                setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
            }
        });

        card.appendChild(headerRow);
        card.appendChild(detailsPanel);
        container.appendChild(card);
    }
}

// ============================================================
// UI: WARDROBE GRID & DESCRIPTION PANEL
// ============================================================

function getCropRectangle(start, end, width, height) {
    const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(value)));
    const x1 = clamp(start.x, width), y1 = clamp(start.y, height);
    const x2 = clamp(end.x, width), y2 = clamp(end.y, height);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

/** Keep clicks inside our own popups from reaching SillyTavern's "click outside closes drawer" handler. */
function shieldFromDrawerAutoClose(element) {
    for (const type of ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'pointerup']) {
        element.addEventListener(type, event => event.stopPropagation());
    }
}

// Returns null on cancel; the caller saves only after explicit confirmation.
function openReferenceImageEditor(imageData, title = 'Просмотр и обрезка') {
    return new Promise(resolve => {
        const previousFocus = document.activeElement;
        const dialog = document.createElement('dialog');
        dialog.className = 'iig-image-editor';
        dialog.innerHTML = `
            <h3></h3>
            <p>Выделите область мышью или пальцем. Без выделения сохранится всё изображение.</p>
            <div class="iig-crop-stage"><img alt="Изображение для обрезки" draggable="false"><div class="iig-crop-selection" hidden></div></div>
            <p class="iig-crop-status" role="status">Загрузка изображения…</p>
            <div class="iig-image-editor-actions">
                <button type="button" class="menu_button" data-action="reset">Сбросить область</button>
                <button type="button" class="menu_button" data-action="save" disabled>Сохранить</button>
                <button type="button" class="menu_button" data-action="cancel">Закрыть без сохранения</button>
            </div>`;
        dialog.querySelector('h3').textContent = title;
        const img = dialog.querySelector('img');
        const stage = dialog.querySelector('.iig-crop-stage');
        const selection = dialog.querySelector('.iig-crop-selection');
        const status = dialog.querySelector('.iig-crop-status');
        const save = dialog.querySelector('[data-action="save"]');
        let start = null, crop = null, pointerId = null;
        const finish = result => {
            dialog.close();
            dialog.remove();
            previousFocus?.focus();
            resolve(result);
        };
        const reset = () => {
            crop = null;
            selection.hidden = true;
            status.textContent = `${img.naturalWidth} × ${img.naturalHeight} — всё изображение`;
            save.textContent = 'Сохранить без обрезки';
        };
        const point = event => {
            const rect = img.getBoundingClientRect();
            return {
                x: (event.clientX - rect.left) * img.naturalWidth / rect.width,
                y: (event.clientY - rect.top) * img.naturalHeight / rect.height
            };
        };
        const update = event => {
            crop = getCropRectangle(start, point(event), img.naturalWidth, img.naturalHeight);
            selection.hidden = false;
            selection.style.left = `${crop.x / img.naturalWidth * 100}%`;
            selection.style.top = `${crop.y / img.naturalHeight * 100}%`;
            selection.style.width = `${crop.width / img.naturalWidth * 100}%`;
            selection.style.height = `${crop.height / img.naturalHeight * 100}%`;
            status.textContent = `${crop.width} × ${crop.height}`;
            save.textContent = 'Обрезать и сохранить';
        };
        stage.addEventListener('pointerdown', event => {
            if (save.disabled || (event.pointerType === 'mouse' && event.button !== 0) || pointerId !== null) return;
            event.preventDefault();
            pointerId = event.pointerId;
            start = point(event);
            stage.setPointerCapture(pointerId);
            update(event);
        });
        stage.addEventListener('pointermove', event => {
            if (event.pointerId === pointerId) update(event);
        });
        stage.addEventListener('pointerup', event => {
            if (event.pointerId !== pointerId) return;
            update(event);
            stage.releasePointerCapture(pointerId);
            pointerId = null;
            if (crop.width < 2 || crop.height < 2) reset();
        });
        stage.addEventListener('pointercancel', () => { pointerId = null; reset(); });
        dialog.querySelector('[data-action="reset"]').addEventListener('click', reset);
        dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        dialog.addEventListener('keydown', event => event.stopPropagation());
        // SillyTavern closes an open (unpinned) top drawer — e.g. the Extensions panel — on any
        // mousedown/mouseup/touch outside it. The editor is mounted outside the drawer, so without this
        // pressing «Сохранить» closed the whole extension settings panel.
        shieldFromDrawerAutoClose(dialog);
        save.addEventListener('click', () => {
            try {
                if (!crop) { finish(imageData); return; }
                if (crop.width < 2 || crop.height < 2) return;
                const canvas = document.createElement('canvas');
                canvas.width = crop.width;
                canvas.height = crop.height;
                canvas.getContext('2d').drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
                finish(canvas.toDataURL('image/png').split(',')[1]);
            } catch (error) {
                status.textContent = `Не удалось обрезать изображение: ${error.message}`;
            }
        });
        img.onload = () => { save.disabled = false; reset(); };
        img.onerror = () => { status.textContent = 'Не удалось открыть изображение. Выберите другой файл.'; };
        // Mount inside the wardrobe modal when it is open, so the editor belongs to that window.
        // Overlay click handler checks e.target === overlay, and keydown is stopped above,
        // so interacting with the editor never closes the wardrobe.
        const host = (typeof iigWardrobeModal !== 'undefined' && iigWardrobeModal?.isConnected)
            ? (iigWardrobeModal.querySelector('#iig-wardrobe-modal') || iigWardrobeModal)
            : document.body;
        host.appendChild(dialog);
        dialog.showModal();
        img.src = `data:${detectMimeType(imageData)};base64,${imageData}`;
    });
}

function editSavedReferenceImage(item, render) {
    return openReferenceImageEditor(item.imageData, item.name).then(async edited => {
        if (edited === null || edited === item.imageData) return;
        item.imageData = await resizeImageBase64(edited, 512);
        saveSettings();
        render();
        renderQuickWardrobeList();
        toastr.success('Изображение обрезано и сохранено');
    });
}

/**
 * Settings-grid card for wardrobe / hairstyle items.
 * Layout: image (click = select/take off) → name → action row (crop, delete).
 * Nothing is overlaid on the image except the "active" check mark.
 */
function buildReferenceCard({ item, isActive, onSelect, onDelete, rerender }) {
    const card = document.createElement('div');
    card.className = `iig-ref-card${isActive ? ' iig-ref-card-active' : ''}`;

    const media = document.createElement('button');
    media.type = 'button';
    media.className = 'iig-ref-card-img';
    const actionLabel = isActive ? 'Снять' : 'Выбрать';
    media.title = actionLabel;
    media.setAttribute('aria-pressed', String(isActive));
    media.setAttribute('aria-label', `${actionLabel}: ${item.name}`);
    if (item.imageData) {
        const img = document.createElement('img');
        img.src = `data:${detectMimeType(item.imageData)};base64,${item.imageData}`;
        img.alt = '';
        media.appendChild(img);
    } else {
        media.innerHTML = '<i class="fa-solid fa-font" aria-hidden="true"></i>';
    }
    if (isActive) {
        const check = document.createElement('span');
        check.className = 'iig-ref-card-check';
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = '<i class="fa-solid fa-check"></i>';
        media.appendChild(check);
    }
    media.addEventListener('click', onSelect);
    card.appendChild(media);

    const name = document.createElement('div');
    name.className = 'iig-ref-card-name';
    name.title = item.name;
    if (item.description) {
        const descIcon = document.createElement('i');
        descIcon.className = 'fa-solid fa-file-lines';
        descIcon.title = 'Есть описание';
        name.appendChild(descIcon);
    }
    name.appendChild(document.createTextNode(item.name));
    card.appendChild(name);

    const actions = document.createElement('div');
    actions.className = 'iig-ref-card-actions';
    if (item.imageData) {
        const crop = document.createElement('button');
        crop.type = 'button';
        crop.className = 'iig-ref-card-btn';
        crop.title = 'Открыть / обрезать';
        crop.setAttribute('aria-label', `Открыть или обрезать: ${item.name}`);
        crop.innerHTML = '<i class="fa-solid fa-crop-simple" aria-hidden="true"></i>';
        crop.addEventListener('click', () => editSavedReferenceImage(item, rerender));
        actions.appendChild(crop);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'iig-ref-card-btn iig-ref-card-btn-danger';
    del.title = 'Удалить';
    del.setAttribute('aria-label', `Удалить: ${item.name}`);
    del.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i>';
    del.addEventListener('click', () => {
        if (confirm(`Удалить «${item.name}»?`)) onDelete();
    });
    actions.appendChild(del);
    card.appendChild(actions);

    return card;
}

function bindReferenceUpload(kind, target) {
    const fileInput = document.getElementById(`iig_${kind}_${target}_file`);
    const nameInput = document.getElementById(`iig_${kind}_${target}_name`);
    const render = () => kind === 'wardrobe' ? renderWardrobeGrid(target) : renderHairstyleGrid(target);
    document.getElementById(`iig_${kind}_${target}_add`)?.addEventListener('click', () => fileInput?.click());
    document.getElementById(`iig_${kind}_${target}_text`)?.addEventListener('click', () => {
        const name = nameInput?.value?.trim() || 'Текстовый наряд';
        const item = addWardrobeItem(name, null, target);
        setActiveWardrobe(item.id, target);
        if (nameInput) nameInput.value = '';
        render();
        saveSettings();
    });
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files[0];
        if (!file) return;
        try {
            const original = await readLibraryFileAsBase64(file);
            const edited = await openReferenceImageEditor(original, 'Просмотр и обрезка перед добавлением');
            if (edited === null) return;
            const resized = await resizeImageBase64(edited, 512);
            const name = nameInput?.value?.trim() || file.name.replace(/\.[^.]+$/, '');
            if (kind === 'wardrobe') addWardrobeItem(name, resized, target);
            else addHairstyleItem(name, resized, target);
            if (nameInput) nameInput.value = '';
            render();
            renderQuickWardrobeList();
            saveSettings();
        } catch (error) { toastr.error(`Не удалось добавить изображение: ${error.message}`); }
        finally { fileInput.value = ''; }
    });
}

function renderWardrobeGrid(target) {
    const settings = getSettings();
    const containerId = `iig_wardrobe_${target}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = settings.wardrobeItems.filter(i => i.target === target);
    const activeId = settings[target === 'char' ? 'activeWardrobeChar' : 'activeWardrobeUser'];

    if (items.length === 0) {
        container.innerHTML = '<div style="color:#5a5252;font-size:13px;padding:8px 0;">Нет одежды. Нажмите + чтобы добавить.</div>';
        renderWardrobeDescriptionPanel(target);
        return;
    }

    container.innerHTML = '';
    container.style.cssText = '';
    container.classList.add('iig-ref-grid');

    for (const item of items) {
        container.appendChild(buildReferenceCard({
            item,
            isActive: item.id === activeId,
            onSelect: () => { setActiveWardrobe(item.id, target); renderWardrobeGrid(target); updateFloatingButtonBadge(); },
            onDelete: () => { removeWardrobeItem(item.id); renderWardrobeGrid(target); updateFloatingButtonBadge(); saveSettings(); toastr.info('Одежда удалена'); },
            rerender: () => renderWardrobeGrid(target),
        }));
    }

    renderWardrobeDescriptionPanel(target);
}

function renderWardrobeDescriptionPanel(target) {
    const panelId = `iig_wardrobe_desc_${target}`;
    let panel = document.getElementById(panelId);

    if (!panel) {
        const grid = document.getElementById(`iig_wardrobe_${target}`);
        if (!grid) return;
        panel = document.createElement('div');
        panel.id = panelId;
        grid.parentNode.insertBefore(panel, grid.nextSibling);
    }

    const activeItem = getActiveWardrobeItem(target);
    if (!activeItem) {
        panel.innerHTML = '';
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    panel.style.cssText = 'margin:8px 0;padding:8px;border:1px solid rgba(255,182,193,0.15);border-radius:8px;background:rgba(255,182,193,0.03);';
    panel.innerHTML = `
        <div style="font-size:13px;color:#e8e0e0;margin-bottom:4px;">
            <i class="fa-solid fa-shirt" style="margin-right:4px;"></i>
            Описание: <b>${escapeHtml(activeItem.name)}</b>
        </div>
        <div class="flex-row" style="margin-bottom:4px;">
            <label for="iig_ward_category_${target}" style="font-size:13px;">Категория</label>
            <select id="iig_ward_category_${target}" class="flex1 iig-ward-category" data-wardrobe-id="${escapeHtml(activeItem.id)}">
                ${Object.entries(WARDROBE_CATEGORIES).map(([key, label]) => `<option value="${key}" ${(activeItem.category || 'full') === key ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
        </div>
        <textarea class="text_pole" rows="3" style="width:100%;font-size:13px;resize:vertical;"
            placeholder="Введите описание одежды вручную или сгенерируйте через AI..."
            data-wardrobe-id="${activeItem.id}">${escapeHtml(activeItem.description)}</textarea>
        <div style="display:flex;gap:6px;margin-top:4px;">
            <div class="menu_button iig-ward-desc-generate" data-wardrobe-id="${activeItem.id}" style="flex:1;font-size:13px;">
                <i class="fa-solid fa-robot"></i> Сгенерировать
            </div>
            <div class="menu_button iig-ward-desc-save" data-wardrobe-id="${activeItem.id}" style="font-size:13px;">
                <i class="fa-solid fa-floppy-disk"></i> Сохранить
            </div>
            <div class="menu_button iig-ward-desc-clear" data-wardrobe-id="${activeItem.id}" style="font-size:13px;">
                <i class="fa-solid fa-eraser"></i>
            </div>
        </div>
        <div id="iig_ward_desc_status_${target}" style="display:none;font-size:12px;margin-top:4px;"></div>
    `;

    const textarea = panel.querySelector('textarea');

    panel.querySelector('.iig-ward-category')?.addEventListener('change', event => {
        const settings = getSettings();
        const item = settings.wardrobeItems.find(i => i.id === event.target.dataset.wardrobeId);
        if (!item) return;
        item.category = event.target.value in WARDROBE_CATEGORIES ? event.target.value : 'full';
        saveSettings();
        renderQuickWardrobeList();
    });

    textarea?.addEventListener('blur', () => {
        updateWardrobeItemDescription(textarea.dataset.wardrobeId, textarea.value);
        saveSettings();
    });

    panel.querySelector('.iig-ward-desc-save')?.addEventListener('click', () => {
        updateWardrobeItemDescription(textarea.dataset.wardrobeId, textarea.value);
        toastr.success('Описание сохранено');
        renderWardrobeGrid(target);
        saveSettings();
    });

    panel.querySelector('.iig-ward-desc-clear')?.addEventListener('click', () => {
        textarea.value = '';
        updateWardrobeItemDescription(textarea.dataset.wardrobeId, '');
        toastr.info('Описание очищено');
        renderWardrobeGrid(target);
        saveSettings();
    });

    panel.querySelector('.iig-ward-desc-generate')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const itemId = btn.dataset.wardrobeId;
        const statusEl = document.getElementById(`iig_ward_desc_status_${target}`);

        btn.classList.add('disabled');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Отправка картинки vision-модели...'; statusEl.style.color = '#aaa'; }

        try {
            const desc = await generateWardrobeDescription(itemId);
            textarea.value = desc;
            updateWardrobeItemDescription(itemId, desc);
            if (statusEl) { statusEl.textContent = 'Описание сгенерировано!'; statusEl.style.color = '#8f8'; }
            toastr.success('Описание сгенерировано через AI');
            renderWardrobeGrid(target);
            saveSettings();
        } catch (error) {
            iigLog('ERROR', 'Failed to generate wardrobe description:', error);
            if (statusEl) { statusEl.textContent = `Ошибка: ${error.message}`; statusEl.style.color = '#f88'; }
            toastr.error(`Ошибка: ${error.message}`);
        } finally {
            btn.classList.remove('disabled');
            btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
        }
    });
}

// ============================================================
// UI: HAIRSTYLE GRID & DESCRIPTION PANEL
// ============================================================

function renderHairstyleGrid(target) {
    const settings = getSettings();
    const containerId = `iig_hairstyle_${target}`;
    const container = document.getElementById(containerId);
    if (!container) return;

    const items = (settings.hairstyleItems || []).filter(i => i.target === target);
    const activeId = settings[target === 'char' ? 'activeHairstyleChar' : 'activeHairstyleUser'];

    if (items.length === 0) {
        container.innerHTML = '<div style="color:#5a5252;font-size:13px;padding:8px 0;">Нет причёсок. Нажмите + чтобы добавить.</div>';
        renderHairstyleDescriptionPanel(target);
        return;
    }

    container.innerHTML = '';
    container.style.cssText = '';
    container.classList.add('iig-ref-grid');

    for (const item of items) {
        container.appendChild(buildReferenceCard({
            item,
            isActive: item.id === activeId,
            onSelect: () => { setActiveHairstyle(item.id, target); renderHairstyleGrid(target); },
            onDelete: () => { removeHairstyleItem(item.id); renderHairstyleGrid(target); toastr.info('Причёска удалена'); },
            rerender: () => renderHairstyleGrid(target),
        }));
    }

    renderHairstyleDescriptionPanel(target);
}

function renderHairstyleDescriptionPanel(target) {
    const panelId = `iig_hairstyle_desc_${target}`;
    let panel = document.getElementById(panelId);

    if (!panel) {
        const grid = document.getElementById(`iig_hairstyle_${target}`);
        if (!grid) return;
        panel = document.createElement('div');
        panel.id = panelId;
        grid.parentNode.insertBefore(panel, grid.nextSibling);
    }

    const activeItem = getActiveHairstyleItem(target);
    if (!activeItem) {
        panel.innerHTML = '';
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    panel.style.cssText = 'margin:8px 0;padding:8px;border:1px solid rgba(255,182,193,0.15);border-radius:8px;background:rgba(255,182,193,0.03);';
    panel.innerHTML = `
        <div style="font-size:13px;color:#e8e0e0;margin-bottom:4px;">
            <i class="fa-solid fa-scissors" style="margin-right:4px;"></i>
            Описание: <b>${escapeHtml(activeItem.name)}</b>
        </div>
        <textarea class="text_pole" rows="3" style="width:100%;font-size:13px;resize:vertical;"
            placeholder="Введите описание причёски вручную или сгенерируйте через AI..."
            data-hairstyle-id="${activeItem.id}">${escapeHtml(activeItem.description)}</textarea>
        <div style="display:flex;gap:6px;margin-top:4px;">
            <div class="menu_button iig-hair-desc-generate" data-hairstyle-id="${activeItem.id}" style="flex:1;font-size:13px;">
                <i class="fa-solid fa-robot"></i> Сгенерировать
            </div>
            <div class="menu_button iig-hair-desc-save" data-hairstyle-id="${activeItem.id}" style="font-size:13px;">
                <i class="fa-solid fa-floppy-disk"></i> Сохранить
            </div>
            <div class="menu_button iig-hair-desc-clear" data-hairstyle-id="${activeItem.id}" style="font-size:13px;">
                <i class="fa-solid fa-eraser"></i>
            </div>
        </div>
        <div id="iig_hair_desc_status_${target}" style="display:none;font-size:12px;margin-top:4px;"></div>
    `;

    const textarea = panel.querySelector('textarea');

    textarea?.addEventListener('blur', () => {
        updateHairstyleItemDescription(textarea.dataset.hairstyleId, textarea.value);
    });

    panel.querySelector('.iig-hair-desc-save')?.addEventListener('click', () => {
        updateHairstyleItemDescription(textarea.dataset.hairstyleId, textarea.value);
        toastr.success('Описание сохранено');
        renderHairstyleGrid(target);
    });

    panel.querySelector('.iig-hair-desc-clear')?.addEventListener('click', () => {
        textarea.value = '';
        updateHairstyleItemDescription(textarea.dataset.hairstyleId, '');
        toastr.info('Описание очищено');
        renderHairstyleGrid(target);
    });

    panel.querySelector('.iig-hair-desc-generate')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const itemId = btn.dataset.hairstyleId;
        const statusEl = document.getElementById(`iig_hair_desc_status_${target}`);

        btn.classList.add('disabled');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Генерация...';
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Отправка картинки vision-модели...'; statusEl.style.color = '#aaa'; }

        try {
            const desc = await generateHairstyleDescription(itemId);
            textarea.value = desc;
            updateHairstyleItemDescription(itemId, desc);
            if (statusEl) { statusEl.textContent = 'Описание сгенерировано!'; statusEl.style.color = '#8f8'; }
            toastr.success('Описание сгенерировано через AI');
            renderHairstyleGrid(target);
        } catch (error) {
            iigLog('ERROR', 'Failed to generate hairstyle description:', error);
            if (statusEl) { statusEl.textContent = `Ошибка: ${error.message}`; statusEl.style.color = '#f88'; }
            toastr.error(`Ошибка: ${error.message}`);
        } finally {
            btn.classList.remove('disabled');
            btn.innerHTML = '<i class="fa-solid fa-robot"></i> Сгенерировать';
            setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 5000);
        }
    });
}

// ============================================================
// UI: AVATAR DROPDOWN
// ============================================================

function renderStyleGallery() {
    const settings = getSettings();
    const container = document.getElementById('iig_style_gallery_grid');
    const activeInfo = document.getElementById('iig_style_gallery_active_info');
    if (!container) return;

    const items = settings.styleGalleryItems || [];
    const activeIds = settings.activeStyleIds || [];
    if (activeInfo) {
        activeInfo.textContent = activeIds.length > 0
            ? `Активных стилей: ${activeIds.length}`
            : 'Активные стили не выбраны';
    }

    if (items.length === 0) {
        container.innerHTML = '<div class="iig-style-empty">Нет стилей. Добавьте карточку с prompt стиля и, при желании, preview.</div>';
        return;
    }

    container.innerHTML = items.map(item => {
        ensureStyleGalleryItemDefaults(item);
        const active = activeIds.includes(item.id);
        return `
            <div class="iig-style-card ${active ? 'active' : ''}" data-style-id="${escapeHtml(item.id)}" title="Нажмите, чтобы включить/выключить стиль">
                <div class="iig-style-preview">
                    ${item.previewData
                        ? `<img src="data:image/png;base64,${item.previewData}" alt="${escapeHtml(item.name)}">`
                        : `<div class="iig-style-placeholder"><i class="fa-solid fa-palette"></i></div>`}
                    ${active ? '<div class="iig-style-check"><i class="fa-solid fa-check"></i></div>' : ''}
                </div>
                <div class="iig-style-body">
                    <div class="iig-style-name">${escapeHtml(item.name || 'Style')}</div>
                    <div class="iig-style-prompt">${escapeHtml(item.prompt || 'Без prompt')}</div>
                </div>
                <div class="iig-style-actions">
                    <button type="button" class="menu_button iig-style-edit" title="Редактировать"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="menu_button iig-style-preview-replace" title="Заменить preview"><i class="fa-solid fa-image"></i></button>
                    <button type="button" class="menu_button iig-style-delete" title="Удалить"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join('');

    container.querySelectorAll('.iig-style-card').forEach(card => {
        const itemId = card.dataset.styleId;
        card.addEventListener('click', () => {
            toggleActiveStyle(itemId);
            renderStyleGallery();
        });

        card.querySelector('.iig-style-edit')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = getSettings().styleGalleryItems.find(i => i.id === itemId);
            if (!item) return;
            const name = prompt('Название стиля:', item.name || 'Style');
            if (name === null) return;
            const promptText = prompt('Prompt стиля:', item.prompt || '');
            if (promptText === null) return;
            updateStyleGalleryItem(itemId, { name: name.trim() || 'Style', prompt: promptText.trim() });
            renderStyleGallery();
            toastr.success('Стиль обновлён', 'Галерея стилей');
        });

        card.querySelector('.iig-style-preview-replace')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = 'image/*';
            fileInput.addEventListener('change', async (ev) => {
                const file = ev.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onloadend = async () => {
                    const resized = await resizeImageBase64(reader.result.split(',')[1], 512);
                    updateStyleGalleryItem(itemId, { previewData: resized });
                    renderStyleGallery();
                    toastr.success('Preview обновлён', 'Галерея стилей');
                };
                reader.readAsDataURL(file);
            });
            fileInput.click();
        });

        card.querySelector('.iig-style-delete')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const item = getSettings().styleGalleryItems.find(i => i.id === itemId);
            if (!confirm(`Удалить стиль "${item?.name || 'Style'}"?`)) return;
            removeStyleGalleryItem(itemId);
            renderStyleGallery();
            toastr.info('Стиль удалён', 'Галерея стилей');
        });
    });
}

function renderNegativeGallery() {
    const settings = getSettings();
    const container = document.getElementById('iig_negative_gallery_grid');
    const activeInfo = document.getElementById('iig_negative_gallery_active_info');
    if (!container) return;
    const items = settings.negativeGalleryItems || [];
    const active = items.find(item => item.id === settings.activeNegativeId);
    if (activeInfo) activeInfo.textContent = active ? `Активен: ${active.name}` : 'Негатив не выбран';
    if (items.length === 0) {
        container.innerHTML = '<div class="iig-style-empty">Негативных промптов пока нет.</div>';
        return;
    }
    container.innerHTML = items.map(item => {
        ensureNegativeGalleryItemDefaults(item);
        const selected = item.id === settings.activeNegativeId;
        return `<div class="iig-negative-row ${selected ? 'active' : ''}" data-negative-id="${escapeHtml(item.id)}">
            <div class="iig-negative-row-main"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.prompt)}</span></div>
            <div class="iig-negative-actions">
                <button type="button" class="menu_button iig-negative-edit" title="Редактировать"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="menu_button iig-negative-delete" title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`;
    }).join('');
    container.querySelectorAll('.iig-negative-row').forEach(row => {
        const id = row.dataset.negativeId;
        row.addEventListener('click', () => {
            settings.activeNegativeId = settings.activeNegativeId === id ? '' : id;
            saveSettings();
            renderNegativeGallery();
        });
        row.querySelector('.iig-negative-edit')?.addEventListener('click', event => {
            event.stopPropagation();
            const item = settings.negativeGalleryItems.find(candidate => candidate.id === id);
            if (!item) return;
            const name = prompt('Название негативного промпта:', item.name);
            if (name === null) return;
            const value = prompt('Негативный промпт:', item.prompt);
            if (value === null) return;
            item.name = name.trim() || item.name;
            item.prompt = value.trim();
            saveSettings();
            renderNegativeGallery();
        });
        row.querySelector('.iig-negative-delete')?.addEventListener('click', event => {
            event.stopPropagation();
            if (!confirm('Удалить этот негативный промпт?')) return;
            settings.negativeGalleryItems = settings.negativeGalleryItems.filter(item => item.id !== id);
            if (settings.activeNegativeId === id) settings.activeNegativeId = '';
            saveSettings();
            renderNegativeGallery();
        });
    });
}

function renderPromptInstructionEditor() {
    const settings = getSettings();
    const select = document.getElementById('iig_prompt_instruction_select');
    const name = document.getElementById('iig_prompt_instruction_name');
    const kind = document.getElementById('iig_prompt_instruction_kind');
    const promptText = document.getElementById('iig_prompt_instruction_text');
    const remove = document.getElementById('iig_prompt_instruction_delete');
    const restore = document.getElementById('iig_prompt_instruction_restore');
    if (!select || !promptText) return;
    const items = getPromptInstructions(settings);
    select.innerHTML = items.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    select.value = settings.activePromptInstructionId;
    const item = items.find(candidate => candidate.id === settings.activePromptInstructionId) || items[0];
    if (!item) return;
    settings.activePromptInstructionId = item.id;
    if (name) name.value = item.name;
    if (kind) kind.value = item.kind || 'custom';
    promptText.value = item.prompt;
    if (remove) remove.disabled = item.builtin;
    if (restore) restore.style.display = item.builtin ? '' : 'none';
}

function savePromptInstructionEditor() {
    const settings = getSettings();
    const id = document.getElementById('iig_prompt_instruction_select')?.value;
    if (!id) return;
    const item = updatePromptInstruction(id, {
        name: document.getElementById('iig_prompt_instruction_name')?.value,
        kind: document.getElementById('iig_prompt_instruction_kind')?.value,
        prompt: document.getElementById('iig_prompt_instruction_text')?.value,
    });
    settings.activePromptInstructionId = id;
    saveSettings();
    renderPromptInstructionEditor();
    if (item) toastr.success('Инструкция сохранена', 'Генератор image-prompt');
}

function renderAvatarDropdown(avatars = []) {
    const settings = getSettings();
    const list = document.getElementById('iig_avatar_dropdown_list');
    if (!list) return;
    list.innerHTML = '';

    const emptyItem = document.createElement('div');
    emptyItem.className = `iig-avatar-dropdown-item iig-no-avatar ${!settings.userAvatarFile ? 'selected' : ''}`;
    emptyItem.dataset.value = '';
    emptyItem.innerHTML = `
        <div style="width:36px;height:36px;border-radius:5px;background:rgba(255,255,255,0.03);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
            <i class="fa-solid fa-ban" style="color:#5a5252;font-size:13px;"></i>
        </div>
        <span class="iig-item-name">-- Не выбран --</span>
    `;
    emptyItem.addEventListener('click', () => selectAvatar('', null));
    list.appendChild(emptyItem);

    for (const avatarFile of avatars) {
        const item = document.createElement('div');
        item.className = `iig-avatar-dropdown-item ${settings.userAvatarFile === avatarFile ? 'selected' : ''}`;
        item.dataset.value = avatarFile;

        const thumb = document.createElement('img');
        thumb.className = 'iig-item-thumb';
        thumb.src = `/User Avatars/${encodeURIComponent(avatarFile)}`;
        thumb.alt = avatarFile;
        thumb.loading = 'lazy';
        thumb.onerror = function () { this.style.display = 'none'; };

        const name = document.createElement('span');
        name.className = 'iig-item-name';
        name.textContent = avatarFile;

        item.appendChild(thumb);
        item.appendChild(name);
        item.addEventListener('click', () => selectAvatar(avatarFile, thumb.src));
        list.appendChild(item);
    }
}

async function loadAndRenderAvatars() {
    try {
        const avatars = await fetchUserAvatars();
        renderAvatarDropdown(avatars);
    } catch (error) {
        iigLog('ERROR', 'Failed to load avatars:', error.message);
    }
}

function selectAvatar(avatarFile) {
    const settings = getSettings();
    settings.userAvatarFile = avatarFile;
    saveSettings();

    const selected = document.getElementById('iig_avatar_dropdown_selected');
    if (selected) {
        if (avatarFile) {
            selected.innerHTML = `
                <img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(avatarFile)}" alt="" onerror="this.style.display='none'">
                <span class="iig-dropdown-text">${avatarFile}</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        } else {
            selected.innerHTML = `
                <div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
                <span class="iig-dropdown-text">-- Не выбран --</span>
                <span class="iig-dropdown-arrow fa-solid fa-chevron-down"></span>
            `;
        }
    }

    const list = document.getElementById('iig_avatar_dropdown_list');
    if (list) {
        list.querySelectorAll('.iig-avatar-dropdown-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.value === avatarFile);
        });
    }

    const dropdown = document.getElementById('iig_avatar_dropdown');
    if (dropdown) dropdown.classList.remove('open');
}

function updateCharAvatarPreview() {
    const context = SillyTavern.getContext();
    const preview = document.getElementById('iig-char-avatar-preview');
    if (!preview) return;
    const character = context.characters?.[context.characterId];
    if (character?.avatar) {
        const img = preview.querySelector('img');
        if (img) img.src = `/characters/${encodeURIComponent(character.avatar)}`;
        preview.style.display = '';
    } else {
        preview.style.display = 'none';
    }
}

// ============================================================
// SETTINGS UI
// ============================================================

function libraryPreviewHtml(src, fallback = 'fa-user') {
    return src
        ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.style.display='none'">`
        : `<span><i class="fa-solid ${fallback}"></i></span>`;
}

/** Dropdown «Текстом · Banana / Тегами · NovelAI» with a visible arrow. */
function describeFormatSelectHtml(id, cls, value) {
    return `<span class="iig-select-wrap">
            <select id="${id}" class="${cls}" aria-label="Формат описания">
                <option value="banana" ${value === 'banana' ? 'selected' : ''}>Текстом · Nano Banana</option>
                <option value="novelai" ${value === 'novelai' ? 'selected' : ''}>Тегами · NovelAI</option>
            </select>
            <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
        </span>`;
}

/** What the profile sends as the face: «свой реф «…»», «картинка из «…»» or the main avatar. */
function profileAvatarSourceLabel(kind, profile) {
    if (profile.avatarSource === 'custom' && profile.customAvatarData) {
        const ref = profile.customAvatars.find(item => item.id === profile.customAvatarId);
        if (ref) return `свой реф «${ref.name || 'Реф'}»`;
        if (kind === 'char' && profile.pickedCharacter) {
            const picked = (SillyTavern.getContext().characters || []).find(character => character?.avatar === profile.pickedCharacter);
            return `картинка из «${picked?.name || profile.pickedCharacter}»`;
        }
        return 'свой реф';
    }
    return kind === 'user' ? 'основная аватарка' : 'обложка карточки';
}

function profileCardHtml(kind, entity, profile, cardPreview) {
    const settings = getSettings();
    const customPreview = profile.customAvatarData ? `data:${detectMimeType(profile.customAvatarData)};base64,${profile.customAvatarData}` : '';
    const preview = profile.avatarSource === 'custom' && customPreview ? customPreview : cardPreview;
    const label = kind === 'user' ? 'Персона' : 'Бот';
    const always = kind === 'user' ? settings.sendUserAvatar : settings.sendCharAvatar;
    return `
        <div class="iig-profile-card" data-profile-kind="${kind}">
            <div class="iig-profile-head">
                <button type="button" class="iig-profile-avatar-btn" title="${kind === 'user' ? 'Выбрать персону или свой реф' : 'Выбрать картинку бота: свой реф или другой персонаж'}" aria-haspopup="true" aria-expanded="false">
                    ${preview ? `<img src="${escapeHtml(preview)}" alt="" onerror="this.style.display='none'">` : `<span class="iig-profile-avatar-empty"><i class="fa-solid ${kind === 'user' ? 'fa-user' : 'fa-user-pen'}" aria-hidden="true"></i></span>`}
                    <span class="iig-profile-avatar-edit" aria-hidden="true"><i class="fa-solid fa-pen"></i></span>
                </button>
                <div class="iig-profile-head-text">
                    <h4>${escapeHtml(entity.title)}</h4>
                    <small>${label}${kind === 'user' && settings.userAvatarFile ? ` · ${escapeHtml(settings.userAvatarFile)}` : ''}</small>
                    <small class="iig-profile-source-label"><i class="fa-solid fa-image" aria-hidden="true"></i> Реф: ${escapeHtml(profileAvatarSourceLabel(kind, profile))}</small>
                    <div class="iig-profile-head-controls">
                        <label class="checkbox_label iig-profile-always" title="Отправлять ${kind === 'user' ? 'аватар юзера' : 'аватар персонажа'} во все картинки, даже если имени нет в промпте (для NovelAI не действует)"><input type="checkbox" class="iig-profile-always-input" ${always ? 'checked' : ''}><span>Всегда отправлять аватар</span></label>
                        <button type="button" class="menu_button iig-profile-avatar-refresh" title="Обновить аватарку и список" aria-label="Обновить"><i class="fa-solid fa-arrows-rotate" aria-hidden="true"></i></button>
                    </div>
                </div>
            </div>
            <div class="iig-profile-avatar-picker" hidden></div>
            <div class="iig-profile-field">
                <label title="Если имя или любое из этих слов есть в промпте картинки — реф и описание уйдут в генерацию">Имена в промпте</label>
                <div class="iig-names-row">
                    <input type="text" class="text_pole iig-profile-aliases" value="${escapeHtml(profile.aliases)}" placeholder="${kind === 'user' ? 'Eva, Ева, Evie' : 'Ivan, Vanya, Petrov'}">
                    <button type="button" class="menu_button iig-names-generate iig-profile-aliases-generate" title="Сгенерировать варианты имени и фамилии на русском и английском (модель описаний гардероба или модель чата)" aria-label="Сгенерировать имена"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>
                </div>
            </div>
            <div class="iig-profile-field">
                <label>Внешность</label>
                <textarea class="text_pole iig-profile-appearance" rows="3" placeholder="Волосы, глаза, кожа, телосложение, приметы...">${escapeHtml(profile.appearance)}</textarea>
                <div class="iig-profile-describe-row">
                    <button type="button" class="menu_button iig-profile-describe" title="Описать внешность по ${profile.avatarSource === 'custom' ? 'загруженному рефу' : 'аватарке'} — формат и «+ описание» выбираются вверху"><i class="fa-solid fa-eye" aria-hidden="true"></i> Описать по ${profile.avatarSource === 'custom' ? 'рефу' : 'аватарке'}</button>
                </div>
            </div>
        </div>`;
}

function rpgCharactersHtml(profile) {
    const rows = profile.rpgCharacters.map(char => `
        <div class="iig-rpg-row" data-rpg-id="${escapeHtml(char.id)}">
            <div class="iig-library-editor-avatar">${libraryPreviewHtml(char.avatarData ? `data:${detectMimeType(char.avatarData)};base64,${char.avatarData}` : '', 'fa-user')}</div>
            <div class="flex1">
                <input type="text" class="text_pole iig-rpg-name" value="${escapeHtml(char.name)}" placeholder="Имя как в промпте">
                <textarea class="text_pole iig-rpg-appearance" rows="2" placeholder="Описание внешности...">${escapeHtml(char.appearance)}</textarea>
            </div>
            <div class="iig-rpg-actions">
                <input type="file" class="iig-rpg-file" accept="image/*" hidden>
                <button type="button" class="menu_button iig-rpg-upload" title="Загрузить реф"><i class="fa-solid fa-image"></i></button>
                <button type="button" class="menu_button iig-rpg-remove" title="Удалить"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>`).join('');
    return `
        <div class="iig-profile-card">
            <label class="checkbox_label"><input type="checkbox" id="iig_rpg_mode" ${profile.rpgMode ? 'checked' : ''}><span>RPG-режим: несколько персонажей в одной карточке</span></label>
            <p class="hint">Реф и описание персонажа отправляются, только если его имя встречается в промпте картинки (без учёта регистра, целым словом). Имя должно совпадать с тем, как модель пишет его в промпте.</p>
            <div class="${profile.rpgMode ? '' : 'hidden'}">
                ${rows || '<div class="iig-library-empty">Персонажей пока нет</div>'}
                <div class="flex-row">
                    <input type="text" id="iig_rpg_new_name" class="text_pole flex1" placeholder="Имя нового персонажа">
                    <button type="button" class="menu_button" id="iig_rpg_add"><i class="fa-solid fa-plus"></i> Добавить</button>
                </div>
            </div>
        </div>`;
}

async function readProfileImage(file) {
    const raw = await readLibraryFileAsBase64(file);
    return await resizeImageBase64(raw, 768);
}

function renderCharacterProfiles() {
    const settings = getSettings();
    const container = document.getElementById('iig_character_library');
    if (!container) return;
    migrateOldCharacterLibrary(settings);

    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    const charEntity = getCurrentLibraryEntity('char', settings);
    const userEntity = getCurrentLibraryEntity('user', settings);
    const charProfile = character ? getCharacterProfile('char', charEntity.key, settings, true) : null;
    const userProfile = getCharacterProfile('user', userEntity.key, settings, true);
    const persona = getExtensionPersona(settings);
    const charOwner = getExtensionCharacter(settings);

    // «Авто-определение имён» lives in the profiles' top block now: keep its node (and listener) across re-renders.
    const commonPart = document.getElementById('iig_avatar_part_common');
    commonPart?.remove();

    // Full-size pictures: the small thumbnails looked blurry at this size.
    const charPreview = character?.avatar ? `/characters/${encodeURIComponent(character.avatar)}` : '';
    const userPreview = settings.userAvatarFile ? `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}` : '';

    container.innerHTML = `
        <div class="iig-profiles">
            <div class="iig-profiles-describe-settings">
                <div class="iig-profile-field">
                    <label for="iig_profile_desc_format">Как описывать внешность по аватарке</label>
                    <div class="iig-profiles-describe-controls">
                        ${describeFormatSelectHtml('iig_profile_desc_format', 'iig-profile-desc-format', getProfileDescFormat())}
                        <label class="checkbox_label iig-profile-use-card" title="Вместе с картинкой учитывать внешность из описания карточки бота и описания персоны. Выключено — только по картинке."><input type="checkbox" class="iig-profile-use-card-input" ${settings.profileDescribeWithCard ? 'checked' : ''}><span>+ описание внешности из карточки персонажей</span></label>
                    </div>
                </div>
            </div>
            ${charProfile ? profileCardHtml('char', charEntity, charProfile, charPreview) : '<div class="iig-library-empty">Откройте чат с персонажем, чтобы настроить бота.</div>'}
            ${profileCardHtml('user', userEntity, userProfile, userPreview)}
            ${charProfile ? rpgCharactersHtml(charProfile) : ''}
        </div>`;

    if (commonPart) container.querySelector('.iig-profiles-describe-settings')?.appendChild(commonPart);

    // Names are generated for the persona / bot chosen here, not for the persona active in SillyTavern.
    bindCharacterProfileEvents(container, { char: charProfile, user: userProfile }, {
        char: { name: charOwner?.name || character?.name || charEntity.title, notes: fillCardMacros(charOwner?.description || '', settings) },
        user: { name: persona.name, notes: fillCardMacros(persona.description, settings) },
    });
}

/** Pictures to choose from: the user's personas, or the characters (plus «обложка карточки») for the bot. */
async function profileAvatarChoices(kind, profile) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    if (kind === 'user') {
        const names = context.powerUserSettings?.personas || {};
        return (await fetchUserAvatars()).map(file => ({
            id: file,
            name: names[file] || file,
            thumb: `/thumbnail?type=persona&file=${encodeURIComponent(file)}`,
            selected: file === settings.userAvatarFile && profile.avatarSource !== 'custom',
        }));
    }
    const current = context.characters?.[context.characterId];
    const picked = profile.avatarSource === 'custom' && !profile.customAvatarId ? profile.pickedCharacter : '';
    return [
        ...(current?.avatar ? [{ id: '__card__', name: 'Обложка карточки', thumb: `/thumbnail?type=avatar&file=${encodeURIComponent(current.avatar)}`, selected: profile.avatarSource !== 'custom' }] : []),
        ...(context.characters || []).filter(character => character?.avatar && character.avatar !== 'none').map(character => ({
            id: character.avatar,
            name: character.name || character.avatar,
            thumb: `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`,
            selected: Boolean(picked) && character.avatar === picked,
        })),
    ];
}

/** Use the main avatar (persona picture / card cover) again instead of an own ref. */
function useMainProfileAvatar(profile) {
    profile.avatarSource = 'card';
    profile.pickedCharacter = '';
    // A picture taken from another card is not kept; uploaded refs stay in the list.
    if (!profile.customAvatarId) profile.customAvatarData = '';
}

function selectProfileRef(profile, id) {
    const ref = profile.customAvatars.find(item => item.id === id);
    if (!ref) return false;
    profile.avatarSource = 'custom';
    profile.customAvatarId = ref.id;
    profile.customAvatarData = ref.data;
    profile.pickedCharacter = '';
    return true;
}

function removeProfileRef(profile, id) {
    const wasActive = profile.customAvatarId === id;
    profile.customAvatars = profile.customAvatars.filter(item => item.id !== id);
    if (wasActive) {
        profile.customAvatarId = '';
        useMainProfileAvatar(profile);
    }
}

async function addProfileRefs(profile, files) {
    let last = null;
    for (const file of files) {
        if (!String(file?.type || '').startsWith('image/')) continue;
        const data = await readProfileImage(file);
        if (!data) continue;
        last = { id: makeProfileRefId(), name: String(file.name || 'Реф').replace(/\.[^.]+$/, '').slice(0, 60), data };
        profile.customAvatars.push(last);
    }
    if (last) selectProfileRef(profile, last.id);
    return Boolean(last);
}

/** Re-render the profiles and open the same picture list again (after uploading or deleting a ref). */
function reopenProfileAvatarPicker(kind) {
    renderCharacterProfiles();
    document.querySelector(`#iig_character_library .iig-profile-card[data-profile-kind="${kind}"] .iig-profile-avatar-btn`)?.click();
}

function profileRefsHtml(profile) {
    const tiles = profile.customAvatars.map(ref => {
        const selected = profile.avatarSource === 'custom' && profile.customAvatarId === ref.id;
        return `<div class="iig-avatar-ref">
                <button type="button" class="iig-avatar-choice${selected ? ' is-selected' : ''}" data-ref-id="${escapeHtml(ref.id)}" title="${escapeHtml(ref.name || 'Реф')}">
                    <img src="data:${detectMimeType(ref.data)};base64,${ref.data}" alt="">
                    <span>${escapeHtml(ref.name || 'Реф')}</span>
                </button>
                <button type="button" class="iig-avatar-ref-remove" data-ref-id="${escapeHtml(ref.id)}" title="Удалить реф" aria-label="Удалить реф ${escapeHtml(ref.name || '')}"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </div>`;
    }).join('');
    return `
        <div class="iig-avatar-picker-label">Свои рефы <small>— выбранный заменяет основную аватарку</small></div>
        <div class="iig-avatar-picker-grid iig-avatar-refs-grid">
            ${tiles}
            <button type="button" class="iig-avatar-choice iig-avatar-upload" title="Загрузить свои рефы (можно несколько)">
                <span class="iig-avatar-upload-icon"><i class="fa-solid fa-plus" aria-hidden="true"></i></span>
                <span>Загрузить</span>
            </button>
            <input type="file" class="iig-avatar-ref-file" accept="image/*" multiple hidden>
        </div>`;
}

async function openProfileAvatarPicker(card, kind, profile) {
    const picker = card.querySelector('.iig-profile-avatar-picker');
    const opener = card.querySelector('.iig-profile-avatar-btn');
    if (!picker) return;
    if (!picker.hidden) { picker.hidden = true; opener?.setAttribute('aria-expanded', 'false'); return; }
    picker.hidden = false;
    opener?.setAttribute('aria-expanded', 'true');
    picker.innerHTML = '<div class="iig-avatar-picker-note">Загрузка…</div>';
    let choices = [];
    try {
        choices = await profileAvatarChoices(kind, profile);
    } catch (error) {
        picker.innerHTML = `<div class="iig-avatar-picker-note">Не удалось загрузить список: ${escapeHtml(error.message)}</div>`;
        return;
    }
    picker.innerHTML = `
        <div class="iig-avatar-picker-head">
            <input type="search" class="text_pole iig-avatar-picker-search" placeholder="${kind === 'user' ? 'Поиск персоны' : 'Поиск персонажа'}" aria-label="Поиск">
            <button type="button" class="menu_button iig-avatar-picker-close" title="Закрыть" aria-label="Закрыть"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
        </div>
        ${profileRefsHtml(profile)}
        <div class="iig-avatar-picker-label">${kind === 'user' ? 'Персоны' : 'Обложка карточки и другие персонажи'}</div>
        <div class="iig-avatar-picker-grid iig-avatar-choices-list">${choices.map(choice => `
            <button type="button" class="iig-avatar-choice${choice.selected ? ' is-selected' : ''}" data-id="${escapeHtml(choice.id)}" title="${escapeHtml(choice.name)}">
                <img src="${escapeHtml(choice.thumb)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
                <span>${escapeHtml(choice.name)}</span>
            </button>`).join('') || '<div class="iig-avatar-picker-note">Список пуст</div>'}
        </div>`;
    picker.querySelector('.iig-avatar-picker-close')?.addEventListener('click', () => { picker.hidden = true; opener?.setAttribute('aria-expanded', 'false'); });
    picker.querySelector('.iig-avatar-picker-search')?.addEventListener('input', event => {
        const needle = event.target.value.trim().toLowerCase();
        picker.querySelectorAll('.iig-avatar-choices-list .iig-avatar-choice').forEach(button => {
            button.hidden = Boolean(needle) && !button.title.toLowerCase().includes(needle);
        });
    });
    // Own refs: pick one, delete one, upload new ones.
    picker.querySelectorAll('.iig-avatar-choice[data-ref-id]').forEach(button => button.addEventListener('click', () => {
        if (!selectProfileRef(profile, button.dataset.refId)) return;
        saveSettings();
        renderCharacterProfiles();
    }));
    picker.querySelectorAll('.iig-avatar-ref-remove').forEach(button => button.addEventListener('click', () => {
        const ref = profile.customAvatars.find(item => item.id === button.dataset.refId);
        if (!ref || !confirm(`Удалить реф «${ref.name || 'Реф'}»?`)) return;
        removeProfileRef(profile, ref.id);
        saveSettings();
        reopenProfileAvatarPicker(kind);
    }));
    const refInput = picker.querySelector('.iig-avatar-ref-file');
    picker.querySelector('.iig-avatar-upload')?.addEventListener('click', () => refInput?.click());
    refInput?.addEventListener('change', async event => {
        const files = Array.from(event.target.files || []);
        if (!files.length) return;
        try {
            if (!await addProfileRefs(profile, files)) throw new Error('это не картинка');
            saveSettings();
            reopenProfileAvatarPicker(kind);
        } catch (error) {
            toastr.error(`Не удалось загрузить: ${error.message}`, 'Профили');
        }
    });
    picker.querySelectorAll('.iig-avatar-choice[data-id]').forEach(button => button.addEventListener('click', async () => {
        const id = button.dataset.id;
        try {
            if (kind === 'user') {
                // The same persona again → back to its main avatar; another persona → that persona's profile.
                if (id === getSettings().userAvatarFile) useMainProfileAvatar(profile);
                else selectAvatar(id);
            } else if (id === '__card__') {
                useMainProfileAvatar(profile);
            } else {
                button.classList.add('is-loading');
                const raw = await imageUrlToBase64(`/characters/${encodeURIComponent(id)}`);
                if (!raw) throw new Error('картинка не загрузилась');
                profile.customAvatarData = await resizeImageBase64(raw, 768);
                profile.customAvatarId = '';
                profile.pickedCharacter = id;
                profile.avatarSource = 'custom';
            }
            saveSettings();
            renderCharacterProfiles();
        } catch (error) {
            button.classList.remove('is-loading');
            toastr.error(`Не удалось выбрать: ${error.message}`, 'Профили');
        }
    }));
    picker.querySelector('.iig-avatar-picker-search')?.focus();
}

function bindCharacterProfileEvents(container, profiles, owners = {}) {
    container.querySelectorAll('.iig-profile-card[data-profile-kind]').forEach(card => {
        const kind = card.dataset.profileKind;
        const profile = profiles[kind];
        if (!profile) return;
        card.querySelector('.iig-profile-avatar-btn')?.addEventListener('click', () => openProfileAvatarPicker(card, kind, profile));
        card.querySelector('.iig-profile-always-input')?.addEventListener('change', event => {
            const settings = getSettings();
            const key = kind === 'user' ? 'sendUserAvatar' : 'sendCharAvatar';
            settings[key] = event.target.checked;
            const legacy = document.getElementById(kind === 'user' ? 'iig_send_user_avatar' : 'iig_send_char_avatar');
            if (legacy) legacy.checked = event.target.checked;
            saveSettings();
        });
        card.querySelector('.iig-profile-avatar-refresh')?.addEventListener('click', () => {
            if (kind === 'user') loadAndRenderAvatars();
            renderCharacterProfiles();
            toastr.info('Обновлено', 'Профили');
        });
    });
    container.querySelector('.iig-profile-desc-format')?.addEventListener('change', event => {
        const settings = getSettings();
        settings.profileDescFormat = event.target.value === 'novelai' ? 'novelai' : 'banana';
        saveSettings();
    });
    container.querySelector('.iig-profile-use-card-input')?.addEventListener('change', event => {
        getSettings().profileDescribeWithCard = event.target.checked;
        saveSettings();
    });
    container.querySelectorAll('.iig-profile-card[data-profile-kind]').forEach(card => {
        const profile = profiles[card.dataset.profileKind];
        if (!profile) return;
        card.querySelector('.iig-profile-appearance')?.addEventListener('input', event => {
            profile.appearance = event.target.value;
            saveSettings();
            document.querySelectorAll(`.iig-prompt-appearance-input[data-kind="${card.dataset.profileKind}"]`).forEach(input => { input.value = event.target.value; });
        });
        card.querySelector('.iig-profile-aliases')?.addEventListener('change', event => {
            profile.aliases = String(event.target.value || '').trim();
            saveSettings();
        });
        card.querySelector('.iig-profile-describe')?.addEventListener('click', async event => {
            const kind = card.dataset.profileKind;
            const textarea = card.querySelector('.iig-profile-appearance');
            if (String(textarea?.value || '').trim() && !confirm('Заменить текущее описание внешности новым?')) return;
            const button = event.currentTarget;
            const html = button.innerHTML;
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Описываю…';
            try {
                const image = profile.avatarSource === 'custom' && profile.customAvatarData
                    ? profile.customAvatarData
                    : (kind === 'user' ? await getUserAvatarBase64() : await getCharacterAvatarBase64());
                const withCard = Boolean(getSettings().profileDescribeWithCard);
                const cardText = withCard ? getCardAppearanceSource(kind) : '';
                if (!image && !cardText) throw new Error(kind === 'user' ? 'Не найдена аватарка персоны — выберите её в «Аватары»' : 'Не найдена аватарка бота');
                if (withCard && !cardText) toastr.info(`Описание ${kind === 'user' ? 'персоны' : 'карточки'} пустое — описываю только по картинке`, 'Профили');
                const description = await describeAppearance({ image: image ? await resizeImageBase64(image, 768) : '', cardText, format: getProfileDescFormat() });
                profile.appearance = description;
                if (textarea) textarea.value = description;
                document.querySelectorAll(`.iig-prompt-appearance-input[data-kind="${kind}"]`).forEach(input => { input.value = description; });
                saveSettings();
                toastr.success('Описание внешности готово', 'Профили');
            } catch (error) {
                iigLog('ERROR', `Avatar description failed: ${error.message}`);
                toastr.error(`Ошибка: ${error.message}`, 'Профили');
            } finally {
                if (button.isConnected) { button.disabled = false; button.innerHTML = html; }
            }
        });
        card.querySelector('.iig-profile-aliases-generate')?.addEventListener('click', event => {
            const owner = owners[card.dataset.profileKind] || {};
            const input = card.querySelector('.iig-profile-aliases');
            runNameGenerationButton(event.currentTarget, async () => {
                const names = await generateNameVariants(owner.name, splitNameList(input?.value || ''), owner.notes);
                profile.aliases = names.join(', ');
                if (input) input.value = profile.aliases;
                saveSettings();
                toastr.success(profile.aliases || 'Новых вариантов нет', `Имена: ${owner.name}`, { timeOut: 6000 });
            });
        });
    });
    bindRpgCharacterEvents(container, profiles.char);
}

function bindRpgCharacterEvents(container, charProfile) {
    if (!charProfile) return;
    container.querySelector('#iig_rpg_mode')?.addEventListener('change', event => {
        charProfile.rpgMode = event.target.checked;
        saveSettings();
        renderCharacterProfiles();
    });
    container.querySelector('#iig_rpg_add')?.addEventListener('click', () => {
        try {
            addRpgCharacter(container.querySelector('#iig_rpg_new_name')?.value);
            renderCharacterProfiles();
        } catch (error) {
            toastr.warning(error.message);
        }
    });
    container.querySelectorAll('.iig-rpg-row').forEach(row => {
        const id = row.dataset.rpgId;
        row.querySelector('.iig-rpg-name')?.addEventListener('change', event => {
            const name = event.target.value.trim();
            if (!name) { toastr.warning('Имя не может быть пустым'); renderCharacterProfiles(); return; }
            updateRpgCharacter(id, { name });
        });
        row.querySelector('.iig-rpg-appearance')?.addEventListener('input', event => updateRpgCharacter(id, { appearance: event.target.value }));
        row.querySelector('.iig-rpg-upload')?.addEventListener('click', () => row.querySelector('.iig-rpg-file')?.click());
        row.querySelector('.iig-rpg-file')?.addEventListener('change', async event => {
            const file = event.target.files?.[0];
            if (!file) return;
            updateRpgCharacter(id, { avatarData: await readProfileImage(file) });
            renderCharacterProfiles();
        });
        row.querySelector('.iig-rpg-remove')?.addEventListener('click', () => {
            if (!confirm('Удалить персонажа?')) return;
            removeRpgCharacter(id);
            renderCharacterProfiles();
        });
    });
}

function createSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    const html = `
        <div class="iig-settings" id="iig_settings_root">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🎨 Inline Image Generation v3.0</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Enable toggle -->
                    <label class="checkbox_label" style="margin-bottom:10px;">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>

                    <!-- ======= SECTION: Display mode ======= -->
                    <div class="iig-collapsible" data-section-id="display_mode">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🖼️ Режим отображения</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div class="flex-row">
                                <label for="iig_image_display_mode">Режим</label>
                                <select id="iig_image_display_mode" class="flex1">
                                    <option value="inline" ${normalizeImageDisplayMode(settings.imageDisplayMode) === 'inline' ? 'selected' : ''}>Инлайн (картинка прямо в тексте)</option>
                                    <option value="extblocks" ${normalizeImageDisplayMode(settings.imageDisplayMode) === 'extblocks' ? 'selected' : ''}>Внешние блоки (HTML-артефакты)</option>
                                </select>
                            </div>
                            <p class="hint">Инлайн: модель ставит тег картинки между абзацами, без HTML-обёрток. Внешние блоки: модель встраивает картинки в HTML/CSS-артефакты (для ExtBlocks).</p>
                            <div class="flex-row">
                                <label for="iig_prompt_panel_position">Блок «Промпт картинки»</label>
                                <select id="iig_prompt_panel_position" class="flex1">
                                    <option value="middle" ${settings.promptPanelPosition !== 'end' ? 'selected' : ''}>В середине ответа</option>
                                    <option value="end" ${settings.promptPanelPosition === 'end' ? 'selected' : ''}>В конце ответа</option>
                                </select>
                            </div>
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_inject_image_mode" ${settings.injectImageModeInstruction ? 'checked' : ''}>
                                <span>Добавлять инструкцию режима в промпт</span>
                            </label>
                            <p class="hint">Выключите, если инструкция (prompt.md) уже есть в вашем пресете, чтобы не дублировать её.</p>
                            <div class="flex-row">
                                <label for="iig_image_mode_depth">Глубина вставки</label>
                                <input type="number" id="iig_image_mode_depth" class="text_pole" value="${settings.imageModeInjectionDepth || 1}" min="0" max="100" style="width:70px;">
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: API ======= -->
                    <div class="iig-collapsible" data-section-id="api">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🔌 API и модель</span>
                        </div>
                        <div class="iig-collapsible-content">

                            <!-- Presets -->
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                                <label style="font-size:13px;color:#9a9292;flex-shrink:0;">Пресет:</label>
                                <select id="iig_preset_select" class="flex1" style="font-size:13px;"></select>
                                <div class="menu_button" id="iig_preset_save" title="Сохранить текущие настройки как новый пресет"><i class="fa-solid fa-floppy-disk"></i></div>
                                <div class="menu_button" id="iig_preset_update" title="Обновить выбранный пресет текущими настройками"><i class="fa-solid fa-arrows-rotate"></i></div>
                                <div class="menu_button" id="iig_preset_delete" title="Удалить выбранный пресет" style="color:#cc5555;"><i class="fa-solid fa-trash"></i></div>
                            </div>

                            <div class="flex-row">
                                <label>Тип API</label>
                                <select id="iig_api_type" class="flex1">
                                    <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI Images API (/v1/images)</option>
                                    <option value="openai-chat" ${settings.apiType === 'openai-chat' ? 'selected' : ''}>OpenAI Chat/Router (/v1/chat/completions)</option>
                                    <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini (nano-banana)</option>
                                    <option value="naistera" ${settings.apiType === 'naistera' ? 'selected' : ''}>Naistera (включая NovelAI)</option>
                                    <option value="novelai" ${settings.apiType === 'novelai' ? 'selected' : ''}>NovelAI официальный (через SillyTavern)</option>
                                    <option value="novelai-direct" ${settings.apiType === 'novelai-direct' ? 'selected' : ''}>NovelAI напрямую (свой Access Token)</option>
                                </select>
                            </div>

                            <div class="flex-row ${['novelai', 'novelai-direct'].includes(settings.apiType) ? 'hidden' : ''}" id="iig_endpoint_row">
                                <label>Эндпоинт</label>
                                <input type="text" id="iig_endpoint" class="text_pole flex1" value="${settings.endpoint || ''}" placeholder="${settings.apiType === 'naistera' ? 'https://naistera.org' : 'https://api.openai.com'}">
                            </div>

                            <div class="flex-row ${['novelai', 'novelai-direct'].includes(settings.apiType) ? 'hidden' : ''}" id="iig_api_key_row">
                                <label>API ключ</label>
                                <input type="password" id="iig_api_key" class="text_pole flex1" value="${settings.apiKey || ''}" placeholder="sk-...">
                                <div class="menu_button iig-key-toggle" id="iig_key_toggle"><i class="fa-solid fa-eye"></i></div>
                            </div>

                            <div class="flex-row ${['naistera', 'novelai', 'novelai-direct'].includes(settings.apiType) ? 'hidden' : ''}" id="iig_standard_model_row">
                                <label>Модель</label>
                                <select id="iig_model" class="flex1">
                                    ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">Выберите модель</option>'}
                                </select>
                                <div class="menu_button iig-refresh-btn" id="iig_refresh_models" title="Обновить список моделей"><i class="fa-solid fa-arrows-rotate"></i></div>
                            </div>

                            <div id="iig_novelai_section" class="${!['novelai', 'novelai-direct'].includes(settings.apiType) ? 'hidden' : ''}">
                                <p class="hint">Прямой режим не требует доступа к серверу: запрос идёт из браузера на image.novelai.net. Access Token сохраняется в настройках расширения SillyTavern (не в защищённых секретах сервера). Не используйте его в чужой установке SillyTavern. Изображения-референсы не отправляются.</p>
                                <div class="flex-row ${settings.apiType !== 'novelai-direct' ? 'hidden' : ''}" id="iig_novelai_token_row">
                                    <label>NovelAI Access Token</label>
                                    <input type="password" id="iig_novelai_token" class="text_pole flex1" value="${escapeHtml(settings.novelaiApiKey || '')}" autocomplete="off" placeholder="Вставьте NovelAI Access Token">
                                    <div class="menu_button" id="iig_novelai_token_toggle" title="Показать или скрыть токен"><i class="fa-solid fa-eye"></i></div>
                                </div>
                                <div class="flex-row">
                                    <label>Модель NovelAI</label>
                                    <select id="iig_novelai_model" class="flex1">
                                        ${NOVELAI_MODELS.map(([id, name]) => `<option value="${id}" ${settings.novelaiModel === id ? 'selected' : ''}>${name}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="flex-row">
                                    <label>Access Token</label>
                                    <div class="menu_button" id="iig_novelai_check">Проверить подключение</div>
                                </div>
                                <div class="flex-row">
                                    <label>Ширина × высота</label>
                                    <input type="number" id="iig_novelai_width" class="text_pole" value="${escapeHtml(settings.novelaiWidth)}" min="64" max="2048" step="64" style="width:90px;">
                                    <input type="number" id="iig_novelai_height" class="text_pole" value="${escapeHtml(settings.novelaiHeight)}" min="64" max="2048" step="64" style="width:90px;">
                                </div>
                                <div class="flex-row">
                                    <label>Steps / Guidance</label>
                                    <input type="number" id="iig_novelai_steps" class="text_pole" value="${escapeHtml(settings.novelaiSteps)}" min="1" max="50" step="1" style="width:90px;">
                                    <input type="number" id="iig_novelai_scale" class="text_pole" value="${escapeHtml(settings.novelaiScale)}" min="0" max="30" step="0.1" style="width:90px;">
                                </div>
                                <div class="flex-row">
                                    <label>Sampler</label>
                                    <select id="iig_novelai_sampler" class="flex1">
                                        ${['k_dpmpp_2m', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'k_euler', 'k_euler_ancestral', 'ddim'].map(value => `<option value="${value}" ${settings.novelaiSampler === value ? 'selected' : ''}>${value}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="flex-row">
                                    <label>Scheduler</label>
                                    <select id="iig_novelai_scheduler" class="flex1">
                                        ${['karras', 'native', 'exponential', 'polyexponential'].map(value => `<option value="${value}" ${settings.novelaiScheduler === value ? 'selected' : ''}>${value}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="flex-row">
                                    <label>Negative prompt</label>
                                    <input type="text" id="iig_novelai_negative_prompt" class="text_pole flex1" value="${escapeHtml(settings.novelaiNegativePrompt)}">
                                </div>
                                <div class="flex-row">
                                    <label>Seed (-1 случайный)</label>
                                    <input type="number" id="iig_novelai_seed" class="text_pole" value="${escapeHtml(settings.novelaiSeed)}" min="-1" step="1">
                                </div>
                                ${[['sm', 'SMEA'], ['sm_dyn', 'SMEA Dyn'], ['decrisper', 'Decrisper'], ['variety_boost', 'Variety Boost']].map(([id, label]) => {
                                    const key = { sm: 'novelaiSm', sm_dyn: 'novelaiSmDyn', decrisper: 'novelaiDecrisper', variety_boost: 'novelaiVarietyBoost' }[id];
                                    return `<label class="checkbox_label"><input type="checkbox" id="iig_novelai_${id}" ${settings[key] ? 'checked' : ''}><span>${label}</span></label>`;
                                }).join('')}
                            </div>

                            <div id="iig_naistera_section" class="${settings.apiType !== 'naistera' ? 'hidden' : ''}">
                                <div class="flex-row">
                                    <label>Модель Naistera / NovelAI</label>
                                    <select id="iig_naistera_model" class="flex1">
                                        ${settings.naisteraModel ? `<option value="${escapeHtml(settings.naisteraModel)}" selected>${escapeHtml(settings.naisteraModel)}</option>` : '<option value="">Загрузите список моделей</option>'}
                                    </select>
                                    <div class="menu_button iig-refresh-btn" id="iig_refresh_naistera_models" title="Загрузить модели Naistera"><i class="fa-solid fa-arrows-rotate"></i></div>
                                </div>
                                <p class="hint">Токен берётся из Telegram-бота Naistera. Модели NovelAI доступны через этот же провайдер.</p>
                                <label class="checkbox_label">
                                    <input type="checkbox" id="iig_naistera_send_char_avatar" ${settings.naisteraSendCharAvatar ? 'checked' : ''}>
                                    <span>Отправлять аватар персонажа в Naistera</span>
                                </label>
                                <label class="checkbox_label">
                                    <input type="checkbox" id="iig_naistera_send_user_avatar" ${settings.naisteraSendUserAvatar ? 'checked' : ''}>
                                    <span>Отправлять аватар юзера в Naistera</span>
                                </label>
                                <div class="flex-row">
                                    <label>Aspect Ratio</label>
                                    <select id="iig_naistera_aspect_ratio" class="flex1">
                                        ${['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'].map(r => `<option value="${r}" ${settings.naisteraAspectRatio === r ? 'selected' : ''}>${r}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="flex-row">
                                    <label>Preset</label>
                                    <input type="text" id="iig_naistera_preset" class="text_pole flex1" value="${escapeHtml(settings.naisteraPreset || '')}" placeholder="Необязательно">
                                </div>
                                <div class="flex-row">
                                    <label>Negative prompt</label>
                                    <input type="text" id="iig_naistera_negative_prompt" class="text_pole flex1" value="${escapeHtml(settings.naisteraNegativePrompt || '')}" placeholder="Отправляется моделям с поддержкой">
                                </div>
                                <div class="flex-row">
                                    <label>Описание персонажей</label>
                                    <select id="iig_naistera_character_descriptions" class="flex1">
                                        <option value="none" ${settings.naisteraCharacterDescriptionsMode === 'none' ? 'selected' : ''}>Не отправлять</option>
                                        <option value="as-is" ${settings.naisteraCharacterDescriptionsMode === 'as-is' ? 'selected' : ''}>Как есть</option>
                                        <option value="character-prompt" ${settings.naisteraCharacterDescriptionsMode === 'character-prompt' ? 'selected' : ''}>Блок описаний персонажа</option>
                                    </select>
                                </div>
                                <label class="checkbox_label">
                                    <input type="checkbox" id="iig_naistera_polling" ${settings.naisteraPolling ? 'checked' : ''}>
                                    <span>Использовать polling для асинхронной генерации</span>
                                </label>
                                <div class="flex-row">
                                    <label>Интервал polling (мс)</label>
                                    <input type="number" id="iig_naistera_poll_interval" class="text_pole" value="${settings.naisteraPollIntervalMs}" min="1000" max="30000" step="500">
                                </div>
                                <div class="flex-row">
                                    <label>Таймаут polling (мс)</label>
                                    <input type="number" id="iig_naistera_poll_timeout" class="text_pole" value="${settings.naisteraPollTimeoutMs}" min="30000" max="900000" step="10000">
                                </div>
                            </div>

                            <h5>Разрешение изображений</h5>
                            <p class="hint">Настройки ниже применяются в зависимости от выбранного API. Значения из тегов [IMG:GEN:{json}] имеют приоритет.</p>

                            <div class="flex-row ${settings.apiType === 'openai' ? '' : 'hidden'}" id="iig_openai_size_row">
                                <label>Размер (OpenAI)</label>
                                <select id="iig_size" class="flex1">
                                    <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024×1024</option>
                                    <option value="1536x1024" ${settings.size === '1536x1024' ? 'selected' : ''}>1536×1024 (широко)</option>
                                    <option value="1024x1536" ${settings.size === '1024x1536' ? 'selected' : ''}>1024×1536 (высоко)</option>
                                    <option value="auto" ${settings.size === 'auto' ? 'selected' : ''}>auto</option>
                                </select>
                            </div>

                            <div class="flex-row ${settings.apiType === 'openai' ? '' : 'hidden'}" id="iig_quality_row">
                                <label>Качество (OpenAI)</label>
                                <select id="iig_quality" class="flex1">
                                    <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>standard</option>
                                    <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>hd</option>
                                    <option value="low" ${settings.quality === 'low' ? 'selected' : ''}>low</option>
                                </select>
                            </div>

                            <div class="${['gemini', 'openai-chat'].includes(settings.apiType) ? '' : 'hidden'}" id="iig_aspect_size_section">
                                <div class="flex-row">
                                    <label>Aspect Ratio</label>
                                    <select id="iig_aspect_ratio" class="flex1">
                                        ${['1:1','2:3','3:2','3:4','4:3','4:5','5:4','9:16','16:9','21:9'].map(r =>
                                            `<option value="${r}" ${settings.aspectRatio === r ? 'selected' : ''}>${r}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                                <div class="flex-row">
                                    <label>Image Size</label>
                                    <select id="iig_image_size" class="flex1">
                                        ${['1K','2K','4K'].map(s =>
                                            `<option value="${s}" ${settings.imageSize === s ? 'selected' : ''}>${s}</option>`
                                        ).join('')}
                                    </select>
                                </div>
                                <p class="hint">Для Gemini и Router (OpenRouter/CloseRouter). 1K ≈ 1024px, 2K ≈ 2048px, 4K ≈ 4096px по длинной стороне.</p>
                                <label class="checkbox_label">
                                    <input type="checkbox" id="iig_gemini_random_format" ${settings.geminiRandomFormat ? 'checked' : ''}>
                                    <span>Формат из промпта или случайный (aspect ratio)</span>
                                </label>
                            </div>

                        </div>
                    </div>

                    <!-- ======= SECTION: Image prompt generator ======= -->
                    <div class="iig-collapsible" data-section-id="prompt_generator">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-wand-magic-sparkles iig-collapse-icon"></i>
                            <span>🪄 Генератор промпта картинки</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Отдельная текстовая модель создаёт prompt из сообщения. Она не изменяет основной текст чата.</p>
                            <div class="flex-row"><label>Endpoint</label><input type="text" id="iig_prompt_gen_endpoint" class="text_pole flex1" value="${escapeHtml(settings.promptGenEndpoint || '')}" placeholder="Пусто = основной endpoint"></div>
                            <div class="flex-row"><label>API ключ</label><input type="password" id="iig_prompt_gen_api_key" class="text_pole flex1" value="${escapeHtml(settings.promptGenApiKey || '')}" placeholder="Пусто = основной ключ"></div>
                            <div class="flex-row"><label>Модель</label><select id="iig_prompt_gen_model" class="flex1"><option value="">-- Выберите текстовую модель --</option>${settings.promptGenModel ? `<option value="${escapeHtml(settings.promptGenModel)}" selected>${escapeHtml(settings.promptGenModel)}</option>` : ''}</select><button type="button" class="menu_button" id="iig_refresh_prompt_gen_models"><i class="fa-solid fa-arrows-rotate"></i></button></div>
                            <div class="flex-row"><label>Инструкция</label><select id="iig_prompt_instruction_select" class="flex1"></select></div>
                            <div class="flex-row"><label>Название</label><input type="text" id="iig_prompt_instruction_name" class="text_pole flex1"></div>
                            <div class="flex-row"><label>Тип</label><select id="iig_prompt_instruction_kind" class="flex1"><option value="image">Обычная картинка</option><option value="comic">Комикс</option><option value="custom">Своя</option></select></div>
                            <textarea id="iig_prompt_instruction_text" class="text_pole" rows="7" placeholder="Инструкция для текстовой модели..."></textarea>
                            <div class="iig-prompt-instruction-actions"><button type="button" class="menu_button" id="iig_prompt_instruction_save"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button><button type="button" class="menu_button" id="iig_prompt_instruction_new"><i class="fa-solid fa-plus"></i> Создать свою</button><button type="button" class="menu_button" id="iig_prompt_instruction_restore"><i class="fa-solid fa-rotate-left"></i> Восстановить</button><button type="button" class="menu_button" id="iig_prompt_instruction_delete"><i class="fa-solid fa-trash"></i> Удалить</button></div>
                            <div class="flex-row"><label>Max tokens</label><input type="number" id="iig_prompt_gen_max_tokens" class="text_pole" value="${escapeHtml(settings.promptGenMaxTokens)}" min="64" max="4000"></div>
                            <div class="flex-row"><label>Temperature</label><input type="number" id="iig_prompt_gen_temperature" class="text_pole" value="${escapeHtml(settings.promptGenTemperature)}" min="0" max="2" step="0.1"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Style ======= -->
                    <div class="iig-collapsible" data-section-id="style">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🎨 Стиль по умолчанию</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <textarea id="iig_default_style" class="text_pole" rows="3" placeholder="Стиль, добавляемый ко всем генерациям...">${settings.defaultStyle || ''}</textarea>
                            <p class="hint">Этот стиль будет добавлен к каждому промпту автоматически.</p>
                            <hr>
                            <div style="display:flex;align-items:center;gap:6px;margin:8px 0;">
                                <input type="text" id="iig_style_name" class="text_pole" placeholder="Название стиля..." style="flex:1;">
                                <div class="menu_button" id="iig_style_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <input type="file" id="iig_style_preview_file" accept="image/*" style="display:none;">
                            </div>
                            <textarea id="iig_style_prompt" class="text_pole" rows="3" placeholder="Prompt стиля, например: cinematic anime style, soft lighting..."></textarea>
                            <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0;gap:8px;">
                                <span id="iig_style_gallery_active_info" class="hint">Активные стили не выбраны</span>
                                <div class="menu_button" id="iig_style_clear_active"><i class="fa-solid fa-ban"></i> Снять все</div>
                            </div>
                            <div id="iig_style_gallery_grid" class="iig-style-gallery-grid"></div>
                            <hr>
                            <h4>🚫 Галерея негативов</h4>
                            <div style="display:flex;align-items:center;gap:6px;margin:8px 0;"><input type="text" id="iig_negative_name" class="text_pole" placeholder="Название" style="flex:1"><button type="button" class="menu_button" id="iig_negative_add"><i class="fa-solid fa-plus"></i> Добавить</button></div>
                            <textarea id="iig_negative_prompt" class="text_pole" rows="3" placeholder="blurry, low quality, bad anatomy..."></textarea>
                            <div style="display:flex;align-items:center;justify-content:space-between;margin:6px 0;gap:8px;"><span id="iig_negative_gallery_active_info" class="hint">Негатив не выбран</span><button type="button" class="menu_button" id="iig_negative_clear_active"><i class="fa-solid fa-ban"></i> Снять</button></div>
                            <div id="iig_negative_gallery_grid" class="iig-negative-gallery-grid"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Avatars ======= -->
                    <div class="iig-collapsible" data-section-id="avatars">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👤 Аватары и референсы</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div id="iig_avatar_part_common">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_auto_detect_names" ${settings.autoDetectNames ? 'checked' : ''}>
                                <span>Авто-определение имён в промпте</span>
                            </label>
                            <p class="hint">Персонаж, юзер и NPC попадают в картинку (лицо, внешность, наряд), только если их имя есть в промпте. Имена ищутся и транслитом (Иван → Ivan), дополнительные имена — в профилях и у NPC. «Всегда отправлять» ниже добавляет человека даже без упоминания; для NovelAI эти галочки не действуют.</p>

                            </div>
                            <div id="iig_avatar_part_char">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                                <span>Всегда отправлять аватар персонажа</span>
                            </label>
                            <div id="iig-char-avatar-preview" class="iig-avatar-preview" style="margin-bottom:8px;">
                                <img src="" alt="Аватар персонажа">
                            </div>

                            </div>
                            <div id="iig_avatar_part_user">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                                <span>Всегда отправлять аватар юзера</span>
                            </label>

                            <div id="iig_user_avatar_row" style="margin-top:4px;">
                                <div class="flex-row">
                                    <label>Аватар юзера</label>
                                    <div class="iig-avatar-dropdown flex1" id="iig_avatar_dropdown">
                                        <div class="iig-avatar-dropdown-selected" id="iig_avatar_dropdown_selected">
                                            ${settings.userAvatarFile
                                                ? `<img class="iig-dropdown-thumb" src="/User Avatars/${encodeURIComponent(settings.userAvatarFile)}">
                                                   <span class="iig-dropdown-text">${settings.userAvatarFile}</span>`
                                                : `<div class="iig-dropdown-placeholder"><i class="fa-solid fa-user"></i></div>
                                                   <span class="iig-dropdown-text">Не выбран</span>`
                                            }
                                            <i class="fa-solid fa-chevron-down iig-dropdown-arrow"></i>
                                        </div>
                                        <div class="iig-avatar-dropdown-list" id="iig_avatar_dropdown_list"></div>
                                    </div>
                                    <div class="menu_button iig-refresh-btn" id="iig_refresh_avatars" title="Обновить список"><i class="fa-solid fa-arrows-rotate"></i></div>
                                </div>
                            </div>
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Wardrobe Char ======= -->
                    <div class="iig-collapsible" data-section-id="wardrobe_char">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👗 Гардероб — Персонаж</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                <input type="text" id="iig_wardrobe_char_name" class="text_pole flex1" placeholder="Название наряда...">
                                <div class="menu_button" id="iig_wardrobe_char_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <button type="button" class="menu_button" id="iig_wardrobe_char_text" title="Создать наряд без изображения">Текст</button>
                                <input type="file" id="iig_wardrobe_char_file" accept="image/*" style="display:none;">
                            </div>
                            <div id="iig_wardrobe_char"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Wardrobe User ======= -->
                    <div class="iig-collapsible" data-section-id="wardrobe_user">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👗 Гардероб — Юзер</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                <input type="text" id="iig_wardrobe_user_name" class="text_pole flex1" placeholder="Название наряда...">
                                <div class="menu_button" id="iig_wardrobe_user_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <button type="button" class="menu_button" id="iig_wardrobe_user_text" title="Создать наряд без изображения">Текст</button>
                                <input type="file" id="iig_wardrobe_user_file" accept="image/*" style="display:none;">
                            </div>
                            <div id="iig_wardrobe_user"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Wardrobe Injection ======= -->
                    <div class="iig-collapsible" data-section-id="wardrobe_inject">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>💉 Отправка гардероба и инжект в чат</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <label class="checkbox_label">
                                <input type="checkbox" id="iig_inject_wardrobe" ${settings.injectWardrobeToChat ? 'checked' : ''}>
                                <span>Инжектить описание одежды в чат</span>
                            </label>
                            <p class="hint">Описание активной одежды будет добавлено в контекст для текстовой модели.</p>
                            <div class="flex-row">
                                <label for="iig_wardrobe_send_mode">В генерацию картинок</label>
                                <select id="iig_wardrobe_send_mode" class="flex1">
                                    <option value="both" ${settings.wardrobeSendMode === 'both' ? 'selected' : ''}>Фото + текст</option>
                                    <option value="text" ${settings.wardrobeSendMode === 'text' ? 'selected' : ''}>Только текст</option>
                                    <option value="none" ${settings.wardrobeSendMode === 'none' ? 'selected' : ''}>Не отправлять</option>
                                </select>
                            </div>
                            <p class="hint">Для гардероба персонажа и юзера. NovelAI получает только описание независимо от наличия фото. Для Naistera можно выбрать «Только текст». Инжект в чат настраивается отдельно.</p>
                            <div class="flex-row">
                                <label>Глубина инжекта</label>
                                <input type="number" id="iig_wardrobe_injection_depth" class="text_pole" value="${settings.wardrobeInjectionDepth || 1}" min="0" max="100" style="width:70px;">
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Hairstyle Char ======= -->
                    <div class="iig-collapsible" data-section-id="hairstyle_char">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>✂️ Причёски — Персонаж</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                <input type="text" id="iig_hairstyle_char_name" class="text_pole flex1" placeholder="Название причёски...">
                                <div class="menu_button" id="iig_hairstyle_char_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <input type="file" id="iig_hairstyle_char_file" accept="image/*" style="display:none;">
                            </div>
                            <div id="iig_hairstyle_char" style="max-height:400px;overflow-y:auto;"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Hairstyle User ======= -->
                    <div class="iig-collapsible" data-section-id="hairstyle_user">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>✂️ Причёски — Юзер</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
                                <input type="text" id="iig_hairstyle_user_name" class="text_pole flex1" placeholder="Название причёски...">
                                <div class="menu_button" id="iig_hairstyle_user_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                                <input type="file" id="iig_hairstyle_user_file" accept="image/*" style="display:none;">
                            </div>
                            <div id="iig_hairstyle_user" style="max-height:400px;overflow-y:auto;"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Hairstyle Send Mode ======= -->
                    <div class="iig-collapsible" data-section-id="hairstyle_mode">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>✂️ Режим отправки причёсок</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div class="flex-row">
                                <label>Режим</label>
                                <select id="iig_hairstyle_send_mode" class="flex1">
                                    <option value="both" ${settings.hairstyleSendMode === 'both' ? 'selected' : ''}>Фото + текст</option>
                                    <option value="text" ${settings.hairstyleSendMode === 'text' ? 'selected' : ''}>Только текст</option>
                                    <option value="none" ${settings.hairstyleSendMode === 'none' ? 'selected' : ''}>Не отправлять</option>
                                </select>
                            </div>
                            <p class="hint">Как отправлять референсы причёсок: с фото, только текстовое описание, или не отправлять вообще.</p>
                        </div>
                    </div>

                    <!-- ======= SECTION: Vision API ======= -->
                    <div class="iig-collapsible" data-section-id="vision">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🤖 Vision API для описаний одежды и внешности</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Отдельный API для генерации текстовых описаний одежды по картинке. Если не настроено, используется основной API.</p>
                            <div class="flex-row">
                                <label>Эндпоинт</label>
                                <input type="text" id="iig_wardrobe_desc_endpoint" class="text_pole flex1" value="${settings.wardrobeDescEndpoint || ''}" placeholder="Оставьте пустым для основного">
                            </div>
                            <div class="flex-row">
                                <label>API ключ</label>
                                <input type="password" id="iig_wardrobe_desc_api_key" class="text_pole flex1" value="${settings.wardrobeDescApiKey || ''}" placeholder="Оставьте пустым для основного">
                                <div class="menu_button iig-key-toggle" id="iig_desc_key_toggle"><i class="fa-solid fa-eye"></i></div>
                            </div>
                            <div class="flex-row">
                                <label>Модель</label>
                                <select id="iig_wardrobe_desc_model" class="flex1">
                                    ${settings.wardrobeDescModel ? `<option value="${settings.wardrobeDescModel}" selected>${settings.wardrobeDescModel}</option>` : '<option value="">Выберите модель</option>'}
                                </select>
                                <div class="menu_button iig-refresh-btn" id="iig_refresh_desc_models" title="Обновить"><i class="fa-solid fa-arrows-rotate"></i></div>
                            </div>
                            <div class="flex-row">
                                <label title="Как описывать одежду, причёски и внешность по картинке">Формат описаний</label>
                                <select id="iig_wardrobe_desc_format" class="flex1">
                                    <option value="banana" ${getVisionDescFormat(settings) === 'banana' ? 'selected' : ''}>Nano Banana / GPT — текстом</option>
                                    <option value="novelai" ${getVisionDescFormat(settings) === 'novelai' ? 'selected' : ''}>NovelAI — тегами</option>
                                </select>
                            </div>
                            <p class="hint">NovelAI плохо переносит длинные описания прозой: они перебивают стиль картинки. В режиме «тегами» одежда, причёски и внешность (кнопки описания в гардеробе, у NPC и в профилях) описываются короткими тегами без слов про фото и реализм. Уже готовые описания не меняются — нажмите «Описать» ещё раз.</p>
                            <div class="flex-row ${getVisionDescFormat(settings) === 'banana' ? '' : 'hidden'}" id="iig_wardrobe_desc_prompt_row" style="align-items:flex-start;">
                                <label>Промпт (текст)</label>
                                <textarea id="iig_wardrobe_desc_prompt" class="text_pole flex1" rows="3">${escapeHtml(settings.wardrobeDescPrompt || '')}</textarea>
                            </div>
                            <div class="flex-row ${getVisionDescFormat(settings) === 'novelai' ? '' : 'hidden'}" id="iig_wardrobe_desc_prompt_novelai_row" style="align-items:flex-start;">
                                <label>Промпт (теги)</label>
                                <textarea id="iig_wardrobe_desc_prompt_novelai" class="text_pole flex1" rows="4">${escapeHtml(settings.wardrobeDescPromptNovelAI || '')}</textarea>
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Reference Generator API ======= -->
                    <div class="iig-collapsible" data-section-id="refgen">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🧬 API для генератора референсов</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Альтернативный API для генерации референсов тел и образов. В гардеробе можно переключаться между основным API и этим. Для AI-уточнения описаний используется модель промптов (раздел «Генерация промпта»).</p>
                            <div class="flex-row">
                                <label>Эндпоинт</label>
                                <input type="text" id="iig_refgen_endpoint" class="text_pole flex1" value="${settings.refGenEndpoint || ''}" placeholder="https://api.example.com/v1">
                            </div>
                            <div class="flex-row">
                                <label>API ключ</label>
                                <input type="password" id="iig_refgen_api_key" class="text_pole flex1" value="${settings.refGenApiKey || ''}">
                                <div class="menu_button iig-key-toggle" id="iig_refgen_key_toggle"><i class="fa-solid fa-eye"></i></div>
                            </div>
                            <div class="flex-row">
                                <label>Модель</label>
                                <input type="text" id="iig_refgen_model" class="text_pole flex1" value="${settings.refGenModel || ''}" placeholder="gpt-4o">
                            </div>
                        </div>
                    </div>

                    <!-- ======= SECTION: NPC ======= -->
                    <div class="iig-collapsible" data-section-id="npc">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>🎭 NPC-референсы</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Добавьте NPC с картинками. Если имя NPC появляется в промпте картинки, его аватар будет отправлен как референс.</p>
                            <div class="iig-profile-field iig-npc-describe-settings">
                                <label for="iig_npc_desc_format">Как описывать внешность и наряды NPC по картинке</label>
                                <div class="iig-profiles-describe-controls">${describeFormatSelectHtml('iig_npc_desc_format', 'iig-npc-desc-format', getNpcDescFormat(settings))}</div>
                            </div>
                            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                                <input type="text" id="iig_npc_new_name" class="text_pole flex1" placeholder="Имя NPC...">
                                <div class="menu_button" id="iig_npc_add"><i class="fa-solid fa-plus"></i> Добавить</div>
                            </div>
                            <div id="iig_npc_list"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Character Profiles ======= -->
                    <div class="iig-collapsible" data-section-id="character_library">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>👤 Профили персонажей</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <p class="hint">Нажмите на большую аватарку, чтобы выбрать картинку: основную аватарку, другую персону или персонажа, или свои рефы — их можно загрузить несколько и выбирать из списка. Имена, «+ описание внешности из карточки» и поиск имени в промпте берутся у персоны и бота, выбранных здесь, а не у активной персоны таверны. RPG-режим позволяет добавить несколько персонажей в одну карточку бота — их рефы и описания отправляются, только если имя встречается в промпте.</p>
                            <div id="iig_character_library"></div>
                        </div>
                    </div>

                    <!-- ======= SECTION: Error Handling & Logs ======= -->
                    <div class="iig-collapsible" data-section-id="errors">
                        <div class="iig-collapsible-header">
                            <i class="fa-solid fa-chevron-down iig-collapse-icon"></i>
                            <span>⚙️ Генерация и ошибки</span>
                        </div>
                        <div class="iig-collapsible-content">
                            <div class="flex-row">
                                <label>Макс. повторов</label>
                                <input type="number" id="iig_max_retries" class="text_pole" value="${settings.maxRetries}" min="0" max="10" style="width:70px;">
                            </div>
                            <div class="flex-row">
                                <label>Задержка повтора (мс)</label>
                                <input type="number" id="iig_retry_delay" class="text_pole" value="${settings.retryDelay}" min="500" max="30000" step="500" style="width:90px;">
                            </div>
                            <div class="flex-row">
                                <label>Таймаут (сек)</label>
                                <input type="number" id="iig_request_timeout" class="text_pole" value="${settings.requestTimeout}" min="10" max="600" style="width:70px;">
                            </div>
                            <div style="margin-top:8px;">
                                <div class="menu_button" id="iig_export_logs"><i class="fa-solid fa-download"></i> Экспорт логов</div>
                            </div>
                        </div>
                    </div>

                </div>
            </div>
        </div>
    `;

    container.insertAdjacentHTML('beforeend', html);

    bindSettingsEvents();
    organizeSettingsTabs();
    initCollapsibleSections();
    initFaqButtons();
    updateCharAvatarPreview();
    renderPresetSelect();
}

function bindSettingsEvents() {
    const settings = getSettings();

    const updateProviderVisibility = (type) => {
        document.getElementById('iig_endpoint_row')?.classList.toggle('hidden', ['novelai', 'novelai-direct'].includes(type));
        document.getElementById('iig_api_key_row')?.classList.toggle('hidden', ['novelai', 'novelai-direct'].includes(type));
        document.getElementById('iig_standard_model_row')?.classList.toggle('hidden', ['naistera', 'novelai', 'novelai-direct'].includes(type));
        // Images API uses pixel size/quality; Chat/Router and Gemini use aspect ratio + image size
        document.getElementById('iig_openai_size_row')?.classList.toggle('hidden', type !== 'openai');
        document.getElementById('iig_quality_row')?.classList.toggle('hidden', type !== 'openai');
        document.getElementById('iig_aspect_size_section')?.classList.toggle('hidden', !['gemini', 'openai-chat'].includes(type));
        document.getElementById('iig_naistera_section')?.classList.toggle('hidden', type !== 'naistera');
        document.getElementById('iig_novelai_section')?.classList.toggle('hidden', !['novelai', 'novelai-direct'].includes(type));
        document.getElementById('iig_novelai_token_row')?.classList.toggle('hidden', type !== 'novelai-direct');
    };

    document.getElementById('iig_enabled')?.addEventListener('change', (e) => { settings.enabled = e.target.checked; saveSettings(); updateImageModeInjection(); });

    // Image display mode
    document.getElementById('iig_npc_desc_format')?.addEventListener('change', (e) => {
        settings.npcDescFormat = e.target.value === 'novelai' ? 'novelai' : 'banana';
        saveSettings();
    });
    document.getElementById('iig_prompt_panel_position')?.addEventListener('change', (e) => {
        settings.promptPanelPosition = e.target.value === 'end' ? 'end' : 'middle';
        saveSettings();
        replaceAllPromptPanels();
    });
    document.getElementById('iig_image_display_mode')?.addEventListener('change', (e) => {
        settings.imageDisplayMode = normalizeImageDisplayMode(e.target.value);
        saveSettings();
        applyImageDisplayMode(settings.imageDisplayMode);
        updateImageModeInjection();
    });
    document.getElementById('iig_inject_image_mode')?.addEventListener('change', (e) => {
        settings.injectImageModeInstruction = e.target.checked;
        saveSettings();
        updateImageModeInjection();
    });
    document.getElementById('iig_image_mode_depth')?.addEventListener('input', (e) => {
        settings.imageModeInjectionDepth = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 1));
        saveSettings();
        updateImageModeInjection();
    });

    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        settings.endpoint = normalizeEndpointForProviderSwitch(e.target.value, settings.endpoint);
        saveSettings();
        const endpointInput = document.getElementById('iig_endpoint');
        if (endpointInput) {
            endpointInput.value = settings.endpoint || '';
            endpointInput.placeholder = e.target.value === 'naistera' ? 'https://naistera.org' : 'https://api.openai.com';
        }
        updateProviderVisibility(e.target.value);
    });

    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => { settings.endpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => { settings.apiKey = e.target.value; saveSettings(); });

    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
    });

    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            const current = settings.model;
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === current;
                select.appendChild(opt);
            }
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_naistera_model')?.addEventListener('change', (e) => {
        settings.naisteraModel = normalizeNaisteraModel(e.target.value);
        saveSettings();
    });

    document.getElementById('iig_refresh_naistera_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_naistera_model');
            const current = normalizeNaisteraModel(settings.naisteraModel);
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = naisteraModelCatalog.get(model)?.name || model;
                option.selected = model === current;
                select.appendChild(option);
            }
            if (!current && models.length > 0) {
                settings.naisteraModel = models[0];
                select.value = models[0];
                saveSettings();
            }
            toastr.success(`Найдено моделей Naistera: ${models.length}`, 'Генерация картинок');
        } catch (err) {
            toastr.error(`Ошибка загрузки моделей Naistera: ${err.message}`, 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });

    document.getElementById('iig_naistera_aspect_ratio')?.addEventListener('change', (e) => { settings.naisteraAspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_preset')?.addEventListener('input', (e) => { settings.naisteraPreset = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_negative_prompt')?.addEventListener('input', (e) => { settings.naisteraNegativePrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_character_descriptions')?.addEventListener('change', (e) => { settings.naisteraCharacterDescriptionsMode = e.target.value; saveSettings(); });
    document.getElementById('iig_naistera_send_char_avatar')?.addEventListener('change', (e) => { settings.naisteraSendCharAvatar = e.target.checked; saveSettings(); });
    document.getElementById('iig_naistera_send_user_avatar')?.addEventListener('change', (e) => { settings.naisteraSendUserAvatar = e.target.checked; saveSettings(); });
    document.getElementById('iig_naistera_polling')?.addEventListener('change', (e) => { settings.naisteraPolling = e.target.checked; saveSettings(); });
    document.getElementById('iig_naistera_poll_interval')?.addEventListener('change', (e) => { settings.naisteraPollIntervalMs = Math.max(1000, parseInt(e.target.value, 10) || 3000); saveSettings(); });
    document.getElementById('iig_naistera_poll_timeout')?.addEventListener('change', (e) => { settings.naisteraPollTimeoutMs = Math.max(30000, parseInt(e.target.value, 10) || 600000); saveSettings(); });

    document.getElementById('iig_novelai_model')?.addEventListener('change', (e) => { settings.novelaiModel = e.target.value; saveSettings(); });
    document.getElementById('iig_novelai_token')?.addEventListener('change', (e) => { settings.novelaiApiKey = normalizeApiKey(e.target.value); e.target.value = settings.novelaiApiKey; saveSettings(); });
    document.getElementById('iig_novelai_token_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_novelai_token');
        input.type = input.type === 'password' ? 'text' : 'password';
    });
    for (const [id, field] of [
        ['width', 'novelaiWidth'], ['height', 'novelaiHeight'], ['steps', 'novelaiSteps'],
        ['scale', 'novelaiScale'], ['seed', 'novelaiSeed'],
    ]) {
        document.getElementById(`iig_novelai_${id}`)?.addEventListener('change', (e) => {
            const input = e.target;
            const value = Number(input.value);
            if (!Number.isFinite(value) || input.validity.rangeUnderflow || input.validity.rangeOverflow || input.validity.stepMismatch || input.value.trim() === '') {
                input.value = settings[field];
                toastr.warning('Некорректное значение параметра NovelAI');
                return;
            }
            settings[field] = value;
            saveSettings();
        });
    }
    for (const [id, field] of [
        ['sampler', 'novelaiSampler'], ['scheduler', 'novelaiScheduler'], ['negative_prompt', 'novelaiNegativePrompt'],
    ]) {
        document.getElementById(`iig_novelai_${id}`)?.addEventListener(id === 'negative_prompt' ? 'input' : 'change', (e) => {
            settings[field] = e.target.value;
            saveSettings();
        });
    }
    for (const [id, field] of [
        ['sm', 'novelaiSm'], ['sm_dyn', 'novelaiSmDyn'],
        ['decrisper', 'novelaiDecrisper'], ['variety_boost', 'novelaiVarietyBoost'],
    ]) {
        document.getElementById(`iig_novelai_${id}`)?.addEventListener('change', (e) => {
            settings[field] = e.target.checked;
            saveSettings();
        });
    }
    document.getElementById('iig_novelai_check')?.addEventListener('click', async (e) => {
        const button = e.currentTarget;
        button.classList.add('loading');
        try {
            const direct = settings.apiType === 'novelai-direct';
            const token = normalizeApiKey(document.getElementById('iig_novelai_token')?.value || settings.novelaiApiKey);
            if (direct && !token) throw new Error('Введите NovelAI Access Token');
            const response = await fetch(direct ? 'https://image.novelai.net/user/subscription' : '/api/novelai/status', direct ? {
                method: 'GET', headers: { Authorization: `Bearer ${token}` },
            } : {
                method: 'POST', headers: SillyTavern.getContext().getRequestHeaders(), body: JSON.stringify({}),
            });
            if (!response.ok) {
                throw new Error(response.status === 401 && direct ? 'Неверный NovelAI Access Token' : response.status === 400 && !direct ? 'Access Token не задан в SillyTavern' : `HTTP ${response.status}`);
            }
            if (!direct) {
                const result = await response.json();
                if (result?.error) throw new Error('NovelAI отклонил токен. Проверьте секреты SillyTavern.');
            }
            if (direct) { settings.novelaiApiKey = token; saveSettings(); }
            toastr.success('NovelAI подключён', 'Генерация картинок');
        } catch (error) {
            toastr.error(`NovelAI: ${error.message}`, 'Генерация картинок');
        } finally {
            button.classList.remove('loading');
        }
    });

    document.getElementById('iig_size')?.addEventListener('change', (e) => { settings.size = e.target.value; saveSettings(); });
    document.getElementById('iig_quality')?.addEventListener('change', (e) => { settings.quality = e.target.value; saveSettings(); });
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => { settings.aspectRatio = e.target.value; saveSettings(); });
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => { settings.imageSize = e.target.value; saveSettings(); });
    document.getElementById('iig_gemini_random_format')?.addEventListener('change', (e) => { settings.geminiRandomFormat = e.target.checked; saveSettings(); });

    document.getElementById('iig_default_style')?.addEventListener('input', (e) => { settings.defaultStyle = e.target.value; saveSettings(); });

    document.getElementById('iig_prompt_gen_endpoint')?.addEventListener('input', e => { settings.promptGenEndpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_prompt_gen_api_key')?.addEventListener('input', e => { settings.promptGenApiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_prompt_gen_model')?.addEventListener('change', e => { settings.promptGenModel = e.target.value; saveSettings(); });
    document.getElementById('iig_prompt_gen_max_tokens')?.addEventListener('change', e => { settings.promptGenMaxTokens = Math.max(64, Math.min(4000, Number(e.target.value) || 700)); saveSettings(); });
    document.getElementById('iig_prompt_gen_temperature')?.addEventListener('change', e => { settings.promptGenTemperature = Math.max(0, Math.min(2, Number(e.target.value) || 0.7)); saveSettings(); });
    document.getElementById('iig_prompt_instruction_select')?.addEventListener('change', e => { settings.activePromptInstructionId = e.target.value; saveSettings(); renderPromptInstructionEditor(); });
    document.getElementById('iig_prompt_instruction_save')?.addEventListener('click', savePromptInstructionEditor);
    document.getElementById('iig_prompt_instruction_new')?.addEventListener('click', () => {
        const item = addPromptInstruction('Моя инструкция', 'Create an image-generation prompt from the scene. Return only the final prompt in English.', 'custom');
        settings.activePromptInstructionId = item.id;
        renderPromptInstructionEditor();
    });
    document.getElementById('iig_prompt_instruction_restore')?.addEventListener('click', () => {
        const id = document.getElementById('iig_prompt_instruction_select')?.value;
        if (!id) return;
        restorePromptInstruction(id);
        renderPromptInstructionEditor();
    });
    document.getElementById('iig_prompt_instruction_delete')?.addEventListener('click', () => {
        const id = document.getElementById('iig_prompt_instruction_select')?.value;
        const item = getPromptInstructions().find(candidate => candidate.id === id);
        if (!id || item?.builtin || !confirm('Удалить эту инструкцию?')) return;
        removePromptInstruction(id);
        renderPromptInstructionEditor();
    });
    document.getElementById('iig_refresh_prompt_gen_models')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        button.classList.add('loading');
        try {
            const models = await fetchPromptGenerationModels();
            const select = document.getElementById('iig_prompt_gen_model');
            select.innerHTML = '<option value="">-- Выберите текстовую модель --</option>';
            models.forEach(model => {
                const option = document.createElement('option');
                option.value = model; option.textContent = model; option.selected = model === settings.promptGenModel;
                select.appendChild(option);
            });
            toastr.success(`Найдено текстовых моделей: ${models.length}`);
        } catch (error) { toastr.error(`Ошибка загрузки моделей: ${error.message}`); }
        finally { button.classList.remove('loading'); }
    });

    document.getElementById('iig_style_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_style_name');
        const promptInput = document.getElementById('iig_style_prompt');
        const promptText = promptInput?.value?.trim() || '';
        if (!promptText) { toastr.warning('Введите prompt стиля', 'Галерея стилей'); return; }
        const name = nameInput?.value?.trim() || 'Style';
        addStyleGalleryItem(name, promptText, null);
        if (nameInput) nameInput.value = '';
        if (promptInput) promptInput.value = '';
        renderStyleGallery();
        toastr.success(`Стиль "${name}" добавлен. Preview можно загрузить кнопкой картинки на карточке.`, 'Галерея стилей');
    });

    document.getElementById('iig_style_clear_active')?.addEventListener('click', () => {
        settings.activeStyleIds = [];
        saveSettings();
        renderStyleGallery();
    });

    document.getElementById('iig_negative_add')?.addEventListener('click', () => {
        const promptText = document.getElementById('iig_negative_prompt')?.value?.trim();
        if (!promptText) { toastr.warning('Введите негативный prompt'); return; }
        addNegativeGalleryItem(document.getElementById('iig_negative_name')?.value, promptText);
        document.getElementById('iig_negative_name').value = '';
        document.getElementById('iig_negative_prompt').value = '';
        renderNegativeGallery();
    });
    document.getElementById('iig_negative_clear_active')?.addEventListener('click', () => { settings.activeNegativeId = ''; saveSettings(); renderNegativeGallery(); });

    document.getElementById('iig_auto_detect_names')?.addEventListener('change', (e) => { settings.autoDetectNames = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => { settings.sendCharAvatar = e.target.checked; saveSettings(); });

    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked; saveSettings();

        
    });

    // Avatar dropdown
    document.getElementById('iig_avatar_dropdown_selected')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown) {
            const wasOpen = dropdown.classList.contains('open');
            dropdown.classList.toggle('open');
            if (!wasOpen) {
                const list = document.getElementById('iig_avatar_dropdown_list');
                if (list && list.children.length === 0) loadAndRenderAvatars();
            }
        }
    });

    document.addEventListener('click', (e) => {
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown && !dropdown.contains(e.target)) dropdown.classList.remove('open');
    });

    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget; btn.classList.add('loading');
        await loadAndRenderAvatars();
        btn.classList.remove('loading');
        toastr.success('Аватары обновлены');
        const dropdown = document.getElementById('iig_avatar_dropdown');
        if (dropdown) dropdown.classList.add('open');
    });

    // Wardrobe injection
    document.getElementById('iig_inject_wardrobe')?.addEventListener('change', (e) => {
        settings.injectWardrobeToChat = e.target.checked; saveSettings(); updateWardrobeInjection();
    });

    document.getElementById('iig_wardrobe_injection_depth')?.addEventListener('input', (e) => {
        settings.wardrobeInjectionDepth = parseInt(e.target.value) || 1; saveSettings(); updateWardrobeInjection();
    });

    // Wardrobe add buttons
    bindReferenceUpload('wardrobe', 'char');
    bindReferenceUpload('wardrobe', 'user');
    document.getElementById('iig_wardrobe_send_mode')?.addEventListener('change', event => {
        settings.wardrobeSendMode = event.target.value;
        saveSettings();
    });

    // Vision API settings
    document.getElementById('iig_wardrobe_desc_endpoint')?.addEventListener('input', (e) => { settings.wardrobeDescEndpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_wardrobe_desc_api_key')?.addEventListener('input', (e) => { settings.wardrobeDescApiKey = e.target.value; saveSettings(); });

    document.getElementById('iig_desc_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_wardrobe_desc_api_key');
        const icon = document.querySelector('#iig_desc_key_toggle i');
        if (input.type === 'password') { input.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
        else { input.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    // Reference generator API settings
    document.getElementById('iig_refgen_endpoint')?.addEventListener('input', e => { settings.refGenEndpoint = e.target.value; saveSettings(); });
    document.getElementById('iig_refgen_api_key')?.addEventListener('input', e => { settings.refGenApiKey = e.target.value; saveSettings(); });
    document.getElementById('iig_refgen_model')?.addEventListener('input', e => { settings.refGenModel = e.target.value; saveSettings(); });
    document.getElementById('iig_refgen_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_refgen_api_key');
        const icon = document.querySelector('#iig_refgen_key_toggle i');
        if (input?.type === 'password') { input.type = 'text'; icon?.classList.replace('fa-eye', 'fa-eye-slash'); }
        else if (input) { input.type = 'password'; icon?.classList.replace('fa-eye-slash', 'fa-eye'); }
    });

    document.getElementById('iig_wardrobe_desc_model')?.addEventListener('change', (e) => { settings.wardrobeDescModel = e.target.value; saveSettings(); });

    document.getElementById('iig_refresh_desc_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget; btn.classList.add('loading');
        try {
            const models = await fetchDescriptionModels();
            const select = document.getElementById('iig_wardrobe_desc_model');
            select.innerHTML = '<option value="">-- Выберите --</option>';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m; opt.selected = m === settings.wardrobeDescModel;
                select.appendChild(opt);
            }
            toastr.success(`Найдено текстовых моделей: ${models.length}`);
        } catch (err) { toastr.error('Ошибка загрузки моделей'); }
        finally { btn.classList.remove('loading'); }
    });

    document.getElementById('iig_wardrobe_desc_prompt')?.addEventListener('input', (e) => { settings.wardrobeDescPrompt = e.target.value; saveSettings(); });
    document.getElementById('iig_wardrobe_desc_prompt_novelai')?.addEventListener('input', (e) => { settings.wardrobeDescPromptNovelAI = e.target.value; saveSettings(); });
    document.getElementById('iig_wardrobe_desc_format')?.addEventListener('change', (e) => {
        settings.wardrobeDescFormat = e.target.value === 'novelai' ? 'novelai' : 'banana';
        document.getElementById('iig_wardrobe_desc_prompt_row')?.classList.toggle('hidden', settings.wardrobeDescFormat !== 'banana');
        document.getElementById('iig_wardrobe_desc_prompt_novelai_row')?.classList.toggle('hidden', settings.wardrobeDescFormat !== 'novelai');
        // Profiles and NPC follow this choice until their own format is picked there.
        if (!settings.profileDescFormat) document.querySelectorAll('.iig-profile-desc-format').forEach(select => { select.value = settings.wardrobeDescFormat; });
        if (!settings.npcDescFormat) document.querySelectorAll('.iig-npc-desc-format').forEach(select => { select.value = settings.wardrobeDescFormat; });
        saveSettings();
    });

    // NPC
    document.getElementById('iig_npc_add')?.addEventListener('click', () => {
        const nameInput = document.getElementById('iig_npc_new_name');
        const name = nameInput?.value?.trim();
        if (!name) { toastr.warning('Введите имя NPC'); return; }
        if (!settings.npcReferences) settings.npcReferences = [];
        if (settings.npcReferences.some(n => n.name.toLowerCase() === name.toLowerCase())) {
            toastr.warning(`NPC "${name}" уже существует`); return;
        }
        settings.npcReferences.push({
            name,
            imageData: null,
            enabled: true,
            appearance: '',
            outfit: '',
            outfits: [],
            activeOutfitId: null
        });

        saveSettings();
        nameInput.value = '';
        renderNpcList();
        toastr.success(`NPC "${name}" добавлен. Загрузите картинку!`);
    });

        // ===== PRESETS =====
    document.getElementById('iig_preset_select')?.addEventListener('change', (e) => {
        const presetId = e.target.value;
        if (!presetId) {
            settings.activePresetId = null;
            saveSettings();
            return;
        }
        if (loadPreset(presetId)) {
            // Sync UI with loaded preset values
            const s = getSettings();
            const endpointEl = document.getElementById('iig_endpoint');
            const apiKeyEl = document.getElementById('iig_api_key');
            const apiTypeEl = document.getElementById('iig_api_type');
            const modelEl = document.getElementById('iig_model');
            const sizeEl = document.getElementById('iig_size');
            const qualityEl = document.getElementById('iig_quality');
            const aspectEl = document.getElementById('iig_aspect_ratio');
            const imgSizeEl = document.getElementById('iig_image_size');
            const naisteraSectionEl = document.getElementById('iig_naistera_section');
            const standardModelRowEl = document.getElementById('iig_standard_model_row');
            const naisteraModelEl = document.getElementById('iig_naistera_model');
            const naisteraAspectEl = document.getElementById('iig_naistera_aspect_ratio');
            const naisteraPresetEl = document.getElementById('iig_naistera_preset');
            const naisteraNegativeEl = document.getElementById('iig_naistera_negative_prompt');
            const naisteraDescriptionsEl = document.getElementById('iig_naistera_character_descriptions');
            const naisteraPollingEl = document.getElementById('iig_naistera_polling');
            const naisteraCharAvatarEl = document.getElementById('iig_naistera_send_char_avatar');
            const naisteraUserAvatarEl = document.getElementById('iig_naistera_send_user_avatar');

            if (endpointEl) endpointEl.value = s.endpoint || '';
            if (apiKeyEl) apiKeyEl.value = s.apiKey || '';
            if (apiTypeEl) {
                apiTypeEl.value = s.apiType;
                updateProviderVisibility(s.apiType);
            }
            if (sizeEl) sizeEl.value = s.size;
            if (qualityEl) qualityEl.value = s.quality;
            if (aspectEl) aspectEl.value = s.aspectRatio;
            if (imgSizeEl) imgSizeEl.value = s.imageSize;

            // Refresh model list then select
            if (modelEl) {
                modelEl.innerHTML = `<option value="${s.model}" selected>${s.model}</option>`;
            }
            if (naisteraModelEl) naisteraModelEl.innerHTML = `<option value="${escapeHtml(s.naisteraModel || '')}" selected>${escapeHtml(s.naisteraModel || 'Выберите модель')}</option>`;
            if (naisteraAspectEl) naisteraAspectEl.value = s.naisteraAspectRatio || '1:1';
            if (naisteraPresetEl) naisteraPresetEl.value = s.naisteraPreset || '';
            if (naisteraNegativeEl) naisteraNegativeEl.value = s.naisteraNegativePrompt || '';
            if (naisteraDescriptionsEl) naisteraDescriptionsEl.value = s.naisteraCharacterDescriptionsMode || 'as-is';
            if (naisteraPollingEl) naisteraPollingEl.checked = !!s.naisteraPolling;
            if (naisteraCharAvatarEl) naisteraCharAvatarEl.checked = !!s.naisteraSendCharAvatar;
            if (naisteraUserAvatarEl) naisteraUserAvatarEl.checked = !!s.naisteraSendUserAvatar;
            for (const [id, field] of [
                ['model', 'novelaiModel'], ['width', 'novelaiWidth'], ['height', 'novelaiHeight'],
                ['steps', 'novelaiSteps'], ['scale', 'novelaiScale'], ['sampler', 'novelaiSampler'],
                ['scheduler', 'novelaiScheduler'], ['negative_prompt', 'novelaiNegativePrompt'], ['seed', 'novelaiSeed'],
            ]) {
                const input = document.getElementById(`iig_novelai_${id}`);
                if (input) input.value = s[field];
            }
            for (const [id, field] of [
                ['sm', 'novelaiSm'], ['sm_dyn', 'novelaiSmDyn'],
                ['decrisper', 'novelaiDecrisper'], ['variety_boost', 'novelaiVarietyBoost'],
            ]) {
                const input = document.getElementById(`iig_novelai_${id}`);
                if (input) input.checked = !!s[field];
            }

            toastr.success('Пресет загружен', 'Пресеты API');
        }
    });

    document.getElementById('iig_preset_save')?.addEventListener('click', () => {
        const name = prompt('Название пресета:');
        if (!name?.trim()) return;
        saveCurrentAsPreset(name.trim());
        renderPresetSelect();
        toastr.success(`Пресет "${name}" сохранён`, 'Пресеты API');
    });

    document.getElementById('iig_preset_update')?.addEventListener('click', () => {
        const select = document.getElementById('iig_preset_select');
        const presetId = select?.value;
        if (!presetId) { toastr.warning('Сначала выберите пресет'); return; }
        const preset = settings.apiPresets.find(p => p.id === presetId);
        if (!preset) return;
        updatePresetFromCurrent(presetId);
        toastr.success(`Пресет "${preset.name}" обновлён`, 'Пресеты API');
    });

    document.getElementById('iig_preset_delete')?.addEventListener('click', () => {
        const select = document.getElementById('iig_preset_select');
        const presetId = select?.value;
        if (!presetId) { toastr.warning('Сначала выберите пресет'); return; }
        const preset = settings.apiPresets.find(p => p.id === presetId);
        if (!preset) return;
        if (!confirm(`Удалить пресет "${preset.name}"?`)) return;
        deletePreset(presetId);
        renderPresetSelect();
        toastr.info(`Пресет "${preset.name}" удалён`, 'Пресеты API');
    });

    // Error handling
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => { settings.maxRetries = parseInt(e.target.value) || 0; saveSettings(); });
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => { settings.retryDelay = parseInt(e.target.value) || 1000; saveSettings(); });
    document.getElementById('iig_request_timeout')?.addEventListener('input', (e) => { settings.requestTimeout = parseInt(e.target.value) || 120; saveSettings(); });

    document.getElementById('iig_export_logs')?.addEventListener('click', exportLogs);

    // Hairstyle add buttons
    bindReferenceUpload('hairstyle', 'char');
    bindReferenceUpload('hairstyle', 'user');

    // Hairstyle send mode
    document.getElementById('iig_hairstyle_send_mode')?.addEventListener('change', (e) => {
        settings.hairstyleSendMode = e.target.value;
        saveSettings();
    });

    // Render dynamic lists
    renderNpcList();
    renderWardrobeGrid('char');
    renderWardrobeGrid('user');
    renderHairstyleGrid('char');
    renderHairstyleGrid('user');
    renderStyleGallery();
    renderNegativeGallery();
    renderPromptInstructionEditor();
    renderCharacterProfiles();
}

// ============================================================
// FLOATING WARDROBE BUTTON
// ============================================================

let iigFloatingBtn = null;
let iigWardrobeModal = null;
let iigCurrentWardrobeTab = 'char';
// «Одежда» or «Причёски» inside the bot / user tab of the wardrobe window.
let iigWardrobeKind = 'outfit';
let iigWardrobeFilter = { category: 'all', search: '' };
let iigRefGenState = {
    target: 'char',
    name: '',
    characterImage: null,
    outfitImage: null,
    description: '',
    refinedDescription: '',
    finalPrompt: '',
    flags: { ...REF_GEN_FLAG_DEFAULTS },
    resultImage: null,
    itemName: '',
    category: 'full',
    busy: false,
    status: '',
};

function createFloatingWardrobeButton() {
    // Remove existing button if any
    iigFloatingBtn?.remove();
    iigWardrobeModal?.remove();
    
    // Left part of the chat input bar (hamburger / extensions wand live here)
    const leftSendForm = document.getElementById('leftSendForm');

    iigFloatingBtn = document.createElement('div');
    iigFloatingBtn.title = 'Гардероб';
    iigFloatingBtn.setAttribute('role', 'button');
    iigFloatingBtn.setAttribute('tabindex', '0');
    iigFloatingBtn.setAttribute('aria-label', 'Гардероб');
    iigFloatingBtn.addEventListener('click', toggleWardrobeModal);
    iigFloatingBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleWardrobeModal(); }
    });

    if (leftSendForm) {
        // Same pattern as SillyTavern's own #options_button
        iigFloatingBtn.id = 'iig-wardrobe-btn';
        iigFloatingBtn.className = 'fa-solid fa-shirt interactable';
        leftSendForm.appendChild(iigFloatingBtn);
        iigLog('INFO', 'Wardrobe button added to input bar');
    } else {
        // Fallback for themes without #leftSendForm
        iigFloatingBtn.id = 'iig-float-btn';
        iigFloatingBtn.innerHTML = '<i class="fa-solid fa-shirt"></i>';
        document.body.appendChild(iigFloatingBtn);
        iigLog('WARN', '#leftSendForm not found, using floating wardrobe button');
    }

    updateFloatingButtonBadge();
}

function updateFloatingButtonBadge() {
    if (!iigFloatingBtn) return;
    
    const settings = getSettings();
    let activeCount = 0;
    
    // Count active outfits (bot, user and RPG characters of the current bot)
    if (settings.activeWardrobeChar) activeCount++;
    if (settings.activeWardrobeUser) activeCount++;
    for (const rpg of getCurrentRpgWardrobeTargets(settings)) {
        if (getActiveWardrobeId(rpg.target, settings)) activeCount++;
    }
    
    // Remove existing badge
    const existingBadge = iigFloatingBtn.querySelector('.iig-bar-count');
    if (existingBadge) existingBadge.remove();
    
    // Add badge if there are active outfits
    if (activeCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'iig-bar-count';
        badge.textContent = activeCount;
        badge.setAttribute('aria-label', `${activeCount} активных нарядов`);
        iigFloatingBtn.appendChild(badge);
    }
    
    // Toggle active state
    iigFloatingBtn.classList.toggle('iig-float-active', activeCount > 0);
}

function toggleWardrobeModal() {
    if (iigWardrobeModal) {
        closeWardrobeModal();
        return;
    }
    
    openWardrobeModal();
}

function openWardrobeModal() {
    closeWardrobeModal();
    
    // Create overlay
    const overlay = document.createElement('div');
    overlay.id = 'iig-wardrobe-modal-overlay';
    
    // Create modal
    const modal = document.createElement('div');
    modal.id = 'iig-wardrobe-modal';
    
    modal.innerHTML = `
        <div class="iig-wardrobe-header">
            <div class="iig-wardrobe-header-title">
                <i class="fa-solid fa-shirt"></i>
                <span>Гардероб</span>
            </div>
            <div class="iig-wardrobe-close" title="Закрыть">
                <i class="fa-solid fa-xmark"></i>
            </div>
        </div>
        <div class="iig-wardrobe-tabs">
            ${buildWardrobeTabs().map(tab => `
            <div class="iig-wardrobe-tab ${tab.id === iigCurrentWardrobeTab ? 'iig-tab-active' : ''}" data-tab="${escapeHtml(tab.id)}" role="tab" tabindex="0" aria-selected="${tab.id === iigCurrentWardrobeTab}">
                <i class="fa-solid ${tab.icon}" aria-hidden="true"></i> ${escapeHtml(tab.label)}
            </div>`).join('')}
        </div>
        <div class="iig-wardrobe-content" id="iig-wardrobe-content"></div>
    `;
    
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    iigWardrobeModal = overlay;
    
    // Event listeners
    modal.querySelector('.iig-wardrobe-close').addEventListener('click', closeWardrobeModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeWardrobeModal();
    });
    
    modal.querySelectorAll('.iig-wardrobe-tab').forEach(tab => {
        const select = () => {
            iigCurrentWardrobeTab = tab.dataset.tab;
            modal.querySelectorAll('.iig-wardrobe-tab').forEach(t => {
                const active = t.dataset.tab === iigCurrentWardrobeTab;
                t.classList.toggle('iig-tab-active', active);
                t.setAttribute('aria-selected', String(active));
            });
            renderQuickWardrobeList();
        };
        tab.addEventListener('click', select);
        tab.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
        });
    });
    
    // Close on Escape (but not if a native modal dialog is currently open)
    const escHandler = (e) => {
        if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
            closeWardrobeModal();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
    
    // Initial render
    renderQuickWardrobeList();
}

function closeWardrobeModal() {
    iigWardrobeModal?.remove();
    iigWardrobeModal = null;
}

/** Tabs: bot, user, one per RPG character of the current bot, generator. Resets a stale RPG tab. */
function buildWardrobeTabs(settings = getSettings()) {
    const tabs = [
        { id: 'char', label: 'Персонаж', icon: 'fa-user' },
        { id: 'user', label: 'Юзер', icon: 'fa-user-pen' },
        ...getCurrentRpgWardrobeTargets(settings).map(rpg => ({ id: rpg.target, label: rpg.name, icon: 'fa-dice-d20' })),
        { id: 'gen', label: 'Генератор', icon: 'fa-wand-magic-sparkles' },
    ];
    if (!tabs.some(tab => tab.id === iigCurrentWardrobeTab)) iigCurrentWardrobeTab = 'char';
    return tabs;
}

function renderQuickWardrobeList() {
    const content = document.getElementById('iig-wardrobe-content');
    if (!content) return;
    
    if (iigCurrentWardrobeTab === 'gen') {
        renderReferenceGenerator(content);
        return;
    }

    const settings = getSettings();
    const target = iigCurrentWardrobeTab;
    // Hairstyles exist for the bot and the user (not for RPG characters).
    const hairAllowed = target === 'char' || target === 'user';
    if (!hairAllowed) iigWardrobeKind = 'outfit';
    const kindSwitch = hairAllowed ? `
        <div class="iig-wardrobe-kinds" role="tablist" aria-label="Что показать">
            <button type="button" class="iig-wardrobe-kind ${iigWardrobeKind === 'outfit' ? 'iig-active' : ''}" data-kind="outfit" role="tab" aria-selected="${iigWardrobeKind === 'outfit'}"><i class="fa-solid fa-shirt" aria-hidden="true"></i> Одежда</button>
            <button type="button" class="iig-wardrobe-kind ${iigWardrobeKind === 'hair' ? 'iig-active' : ''}" data-kind="hair" role="tab" aria-selected="${iigWardrobeKind === 'hair'}"><i class="fa-solid fa-scissors" aria-hidden="true"></i> Причёски</button>
        </div>` : '';
    if (iigWardrobeKind === 'hair') {
        renderQuickHairstyleList(content, target, kindSwitch);
        return;
    }
    const allItems = settings.wardrobeItems?.filter(i => i.target === target) || [];
    const activeId = getActiveWardrobeId(target, settings);
    const activeItem = allItems.find(i => i.id === activeId) || null;
    const items = filterWardrobeItems(allItems, iigWardrobeFilter);
    const imgSrc = item => `data:${detectMimeType(item.imageData)};base64,${item.imageData}`;

    const toolbar = `
        <div class="iig-wardrobe-toolbar">
            <input type="search" class="text_pole iig-wardrobe-search" placeholder="Поиск по названию и описанию" aria-label="Поиск одежды" value="${escapeHtml(iigWardrobeFilter.search)}">
            <details class="iig-wardrobe-filter">
                <summary title="Категория"><i class="fa-solid fa-filter" aria-hidden="true"></i><span>${escapeHtml(iigWardrobeFilter.category === 'all' ? 'Все' : (WARDROBE_CATEGORIES[iigWardrobeFilter.category] || 'Все'))}</span></summary>
                <div class="iig-wardrobe-filter-menu" role="radiogroup" aria-label="Категория">
                    ${[['all', 'Все категории'], ...Object.entries(WARDROBE_CATEGORIES)].map(([key, label]) => `
                        <label><input type="radio" name="iig_wardrobe_cat" value="${key}" ${iigWardrobeFilter.category === key ? 'checked' : ''}> ${escapeHtml(label)}</label>`).join('')}
                </div>
            </details>
            <button type="button" class="menu_button iig-wardrobe-add" title="Добавить одежду" aria-label="Добавить одежду"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
            <input type="file" class="iig-wardrobe-add-file" accept="image/*" hidden>
        </div>`;

    const body = items.length === 0
        ? `<div class="iig-no-outfits">
                <i class="fa-solid fa-shirt" aria-hidden="true"></i>
                <p>${allItems.length === 0 ? 'Нет нарядов в гардеробе' : 'Ничего не найдено'}</p>
                ${allItems.length === 0 ? '<small>Нажмите «+», чтобы добавить картинку одежды</small>' : ''}
           </div>`
        : `<div class="iig-wardrobe-grid">${items.map(item => `
            <div class="iig-wardrobe-card ${item.id === activeId ? 'iig-card-active' : ''}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0" aria-pressed="${item.id === activeId}" title="${item.id === activeId ? 'Снять' : 'Надеть'}">
                ${item.imageData
                    ? `<img class="iig-wardrobe-card-img" src="${imgSrc(item)}" alt="${escapeHtml(item.name)}" draggable="false">`
                    : '<div class="iig-wardrobe-card-img iig-card-placeholder"><i class="fa-solid fa-shirt" aria-hidden="true"></i></div>'}
                <div class="iig-wardrobe-card-body">
                    <div class="iig-wardrobe-card-title">${escapeHtml(item.name)}</div>
                    <div class="iig-wardrobe-card-category">${escapeHtml(WARDROBE_CATEGORIES[item.category] || WARDROBE_CATEGORIES.full)}</div>
                </div>
                ${item.id === activeId ? '<div class="iig-card-check" aria-hidden="true"><i class="fa-solid fa-check"></i></div>' : ''}
                <div class="iig-card-tools">
                    ${item.imageData ? `<button type="button" class="iig-card-tool iig-card-view" title="Открыть картинку / обрезать" aria-label="Открыть картинку ${escapeHtml(item.name)}"><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i></button>` : ''}
                    ${item.imageData ? `<button type="button" class="iig-card-tool iig-card-describe" data-id="${escapeHtml(item.id)}" title="Описать через AI" aria-label="Описать ${escapeHtml(item.name)}"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>` : ''}
                    <button type="button" class="iig-card-tool iig-card-delete" title="Удалить" aria-label="Удалить ${escapeHtml(item.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
                </div>
            </div>`).join('')}
           </div>`;

    const footer = `
        <div class="iig-wardrobe-footer">
            <span class="iig-footer-label">Сейчас надето:</span>
            ${activeItem
                ? `${activeItem.imageData ? `<img src="${imgSrc(activeItem)}" alt="">` : ''}
                   <span class="iig-footer-name">${escapeHtml(activeItem.name)}</span>
                   <button type="button" class="menu_button iig-footer-clear" title="Снять" aria-label="Снять одежду"><i class="fa-solid fa-xmark"></i></button>`
                : '<span class="iig-footer-name iig-footer-empty">ничего</span>'}
        </div>
        ${activeItem ? `
        <div class="iig-wardrobe-description">
            <label for="iig_wardrobe_desc_${escapeHtml(activeItem.id)}"><i class="fa-solid fa-align-left"></i> Описание для промпта:</label>
            <textarea id="iig_wardrobe_desc_${escapeHtml(activeItem.id)}" class="text_pole" rows="3" placeholder="Описание одежды, которое будет передано в промпт">${escapeHtml(activeItem.description || '')}</textarea>
        </div>` : ''}`;

    content.innerHTML = kindSwitch + toolbar + body + footer;
    bindWardrobeKindSwitch(content);
    bindWardrobeToolbar(content);
    bindWardrobeCards(content, target, activeItem);
    bindWardrobeAdd(content, target);
}

function bindWardrobeKindSwitch(content) {
    content.querySelectorAll('.iig-wardrobe-kind').forEach(button => button.addEventListener('click', () => {
        iigWardrobeKind = button.dataset.kind === 'hair' ? 'hair' : 'outfit';
        renderQuickWardrobeList();
    }));
}

/** «Причёски» in the wardrobe window: the same cards as outfits — click to put on / take off. */
function renderQuickHairstyleList(content, target, kindSwitch) {
    const settings = getSettings();
    const allItems = (settings.hairstyleItems || []).filter(item => (item.target || 'char') === target);
    const activeItem = getActiveHairstyleItem(target);
    const activeId = activeItem?.id || null;
    const needle = String(iigWardrobeFilter.search || '').trim().toLowerCase();
    const items = needle
        ? allItems.filter(item => String(item.name || '').toLowerCase().includes(needle) || String(item.description || '').toLowerCase().includes(needle))
        : allItems;
    const imgSrc = item => `data:${detectMimeType(item.imageData)};base64,${item.imageData}`;

    const toolbar = `
        <div class="iig-wardrobe-toolbar">
            <input type="search" class="text_pole iig-wardrobe-search" placeholder="Поиск причёски" aria-label="Поиск причёски" value="${escapeHtml(iigWardrobeFilter.search)}">
            <button type="button" class="menu_button iig-wardrobe-add" title="Добавить причёску" aria-label="Добавить причёску"><i class="fa-solid fa-plus" aria-hidden="true"></i></button>
            <input type="file" class="iig-wardrobe-add-file" accept="image/*" hidden>
        </div>`;
    const body = items.length === 0
        ? `<div class="iig-no-outfits">
                <i class="fa-solid fa-scissors" aria-hidden="true"></i>
                <p>${allItems.length === 0 ? 'Причёсок пока нет' : 'Ничего не найдено'}</p>
                ${allItems.length === 0 ? '<small>Нажмите «+», чтобы добавить картинку причёски</small>' : ''}
           </div>`
        : `<div class="iig-wardrobe-grid">${items.map(item => `
            <div class="iig-wardrobe-card ${item.id === activeId ? 'iig-card-active' : ''}" data-id="${escapeHtml(item.id)}" role="button" tabindex="0" aria-pressed="${item.id === activeId}" title="${item.id === activeId ? 'Снять' : 'Выбрать'}">
                ${item.imageData
                    ? `<img class="iig-wardrobe-card-img" src="${imgSrc(item)}" alt="${escapeHtml(item.name)}" draggable="false">`
                    : '<div class="iig-wardrobe-card-img iig-card-placeholder"><i class="fa-solid fa-scissors" aria-hidden="true"></i></div>'}
                <div class="iig-wardrobe-card-body">
                    <div class="iig-wardrobe-card-title">${escapeHtml(item.name)}</div>
                    <div class="iig-wardrobe-card-category">${item.description ? 'с описанием' : 'без описания'}</div>
                </div>
                ${item.id === activeId ? '<div class="iig-card-check" aria-hidden="true"><i class="fa-solid fa-check"></i></div>' : ''}
                <div class="iig-card-tools">
                    ${item.imageData ? `<button type="button" class="iig-card-tool iig-card-view" title="Открыть картинку / обрезать" aria-label="Открыть картинку ${escapeHtml(item.name)}"><i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i></button>` : ''}
                    ${item.imageData ? `<button type="button" class="iig-card-tool iig-card-describe" title="Описать через AI" aria-label="Описать ${escapeHtml(item.name)}"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i></button>` : ''}
                    <button type="button" class="iig-card-tool iig-card-delete" title="Удалить" aria-label="Удалить ${escapeHtml(item.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
                </div>
            </div>`).join('')}
           </div>`;
    const footer = `
        <div class="iig-wardrobe-footer">
            <span class="iig-footer-label">Сейчас причёска:</span>
            ${activeItem
                ? `${activeItem.imageData ? `<img src="${imgSrc(activeItem)}" alt="">` : ''}
                   <span class="iig-footer-name">${escapeHtml(activeItem.name)}</span>
                   <button type="button" class="menu_button iig-footer-clear" title="Снять" aria-label="Снять причёску"><i class="fa-solid fa-xmark"></i></button>`
                : '<span class="iig-footer-name iig-footer-empty">своя</span>'}
        </div>
        ${activeItem ? `
        <div class="iig-wardrobe-description">
            <label for="iig_hair_desc_${escapeHtml(activeItem.id)}"><i class="fa-solid fa-align-left"></i> Описание для промпта:</label>
            <textarea id="iig_hair_desc_${escapeHtml(activeItem.id)}" class="text_pole iig-hair-desc" rows="3" placeholder="Описание причёски, которое будет передано в промпт">${escapeHtml(activeItem.description || '')}</textarea>
        </div>` : ''}`;

    content.innerHTML = kindSwitch + toolbar + body + footer;
    bindWardrobeKindSwitch(content);
    bindWardrobeToolbar(content);

    const toggle = itemId => {
        const wasActive = activeId === itemId;
        setActiveHairstyle(itemId, target);
        renderQuickWardrobeList();
        const item = settings.hairstyleItems.find(i => i.id === itemId);
        if (item) toastr[wasActive ? 'info' : 'success'](`${wasActive ? 'Снята' : 'Выбрана'} причёска: ${item.name}`, 'Гардероб');
    };
    content.querySelectorAll('.iig-wardrobe-card').forEach(card => {
        const itemId = card.dataset.id;
        const item = () => settings.hairstyleItems.find(i => i.id === itemId);
        card.querySelector('.iig-card-view')?.addEventListener('click', event => {
            event.stopPropagation();
            if (item()) editSavedReferenceImage(item(), renderQuickWardrobeList);
        });
        card.querySelector('.iig-card-delete')?.addEventListener('click', event => {
            event.stopPropagation();
            if (!item() || !confirm(`Удалить причёску «${item().name}»?`)) return;
            const name = item().name;
            removeHairstyleItem(itemId);
            renderQuickWardrobeList();
            toastr.info(`Удалено: ${name}`, 'Гардероб');
        });
        card.querySelector('.iig-card-describe')?.addEventListener('click', async event => {
            event.stopPropagation();
            const button = event.currentTarget;
            button.disabled = true;
            button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
            try {
                updateHairstyleItemDescription(itemId, await generateHairstyleDescription(itemId));
                saveSettings();
                toastr.success(`Описание готово: ${item()?.name || ''}`, 'Гардероб', { timeOut: 4000 });
                renderQuickWardrobeList();
            } catch (error) {
                toastr.error(`Ошибка: ${error.message}`, 'Гардероб');
                button.disabled = false;
                button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>';
            }
        });
        card.addEventListener('click', () => toggle(itemId));
        card.addEventListener('keydown', event => {
            if (event.target !== card) return;
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(itemId); }
        });
    });
    content.querySelector('.iig-footer-clear')?.addEventListener('click', () => { if (activeId) toggle(activeId); });
    content.querySelector('.iig-hair-desc')?.addEventListener('blur', event => {
        updateHairstyleItemDescription(activeId, event.target.value);
        saveSettings();
        toastr.info('Описание сохранено', 'Гардероб');
    });
    const addButton = content.querySelector('.iig-wardrobe-add');
    const addInput = content.querySelector('.iig-wardrobe-add-file');
    addButton?.addEventListener('click', () => addInput?.click());
    addInput?.addEventListener('change', async () => {
        const file = addInput.files?.[0];
        if (!file) return;
        try {
            const resized = await resizeImageBase64(await readLibraryFileAsBase64(file), 512);
            const added = addHairstyleItem(file.name.replace(/\.[^.]+$/, '').trim() || 'Hairstyle', resized, target);
            toastr.success(`Добавлено: ${added.name}`, 'Гардероб');
            renderQuickWardrobeList();
        } catch (error) {
            toastr.error(`Не удалось добавить: ${error.message}`, 'Гардероб');
        } finally {
            addInput.value = '';
        }
    });
}

/** "+" in the wardrobe: upload an outfit image for the current target (bot, user or RPG character). */
function bindWardrobeAdd(container, target) {
    const button = container.querySelector('.iig-wardrobe-add');
    const input = container.querySelector('.iig-wardrobe-add-file');
    button?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const resized = await resizeImageBase64(await readLibraryFileAsBase64(file), 512);
            const name = file.name.replace(/\.[^.]+$/, '').trim() || 'Outfit';
            const category = iigWardrobeFilter.category in WARDROBE_CATEGORIES ? iigWardrobeFilter.category : 'full';
            const item = addWardrobeItem(name, resized, target, category);
            toastr.success(`Добавлено: ${item.name}. Описание можно задать в настройках или через генератор.`, 'Гардероб');
            renderQuickWardrobeList();
            saveSettings();
        } catch (error) {
            toastr.error(`Не удалось добавить: ${error.message}`, 'Гардероб');
        } finally {
            input.value = '';
        }
    });
}

function filterWardrobeItems(items, filter) {
    const category = filter?.category || 'all';
    const needle = String(filter?.search || '').trim().toLowerCase();
    return items.filter(item => {
        if (category !== 'all' && (item.category || 'full') !== category) return false;
        if (!needle) return true;
        return String(item.name || '').toLowerCase().includes(needle)
            || String(item.description || '').toLowerCase().includes(needle);
    });
}

function bindWardrobeToolbar(container) {
    const search = container.querySelector('.iig-wardrobe-search');
    search?.addEventListener('input', event => {
        iigWardrobeFilter.search = event.target.value;
        const caret = event.target.selectionStart;
        renderQuickWardrobeList();
        // Re-render replaces the input; restore focus and caret so typing is not interrupted.
        const fresh = document.querySelector('#iig-wardrobe-content .iig-wardrobe-search');
        if (fresh) {
            fresh.focus();
            try { fresh.setSelectionRange(caret, caret); } catch (_) { /* type=search may not support it */ }
        }
    });
    container.querySelectorAll('input[name="iig_wardrobe_cat"]').forEach(radio => {
        radio.addEventListener('change', () => {
            iigWardrobeFilter.category = radio.value;
            renderQuickWardrobeList();
        });
    });
}

function bindWardrobeCards(container, target, activeItem) {
    const settings = getSettings();
    const toggleItem = itemId => {
        const wasActive = activeItem?.id === itemId;
        // setActiveWardrobe toggles: same id → null.
        setActiveWardrobe(itemId, target);
        updateFloatingButtonBadge();
        renderQuickWardrobeList();
        const item = settings.wardrobeItems.find(i => i.id === itemId);
        if (item) toastr[wasActive ? 'info' : 'success'](`${wasActive ? 'Снят' : 'Надет'}: ${item.name}`, 'Гардероб');
    };

    container.querySelectorAll('.iig-wardrobe-card').forEach(card => {
        const itemId = card.dataset.id;
        // Click anywhere on the card (picture included) = put on / take off.
        // The picture itself opens only through the dedicated magnifier button.
        card.querySelector('.iig-card-view')?.addEventListener('click', event => {
            event.stopPropagation();
            const item = settings.wardrobeItems.find(i => i.id === itemId);
            if (item) editSavedReferenceImage(item, renderQuickWardrobeList);
        });
        card.querySelector('.iig-card-delete')?.addEventListener('click', event => {
            event.stopPropagation();
            const item = settings.wardrobeItems.find(i => i.id === itemId);
            if (!item || !confirm(`Удалить «${item.name}» из гардероба?`)) return;
            removeWardrobeItem(itemId);
            updateFloatingButtonBadge();
            renderQuickWardrobeList();
            saveSettings();
            toastr.info(`Удалено: ${item.name}`, 'Гардероб');
        });
        card.querySelector('.iig-card-describe')?.addEventListener('click', async event => {
            event.stopPropagation();
            const item = settings.wardrobeItems.find(i => i.id === itemId);
            if (!item?.imageData) return;
            const btn = event.currentTarget;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
            try {
                const desc = await generateWardrobeDescription(itemId);
                updateWardrobeItemDescription(itemId, desc);
                saveSettings();
                toastr.success(`Описание сгенерировано для ${item.name}`, 'Гардероб', { timeOut: 4000 });
                renderQuickWardrobeList();
            } catch (error) {
                iigLog('ERROR', `Failed to generate wardrobe description (modal): ${error.message}`);
                toastr.error(`Ошибка: ${error.message}`, 'Гардероб');
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i>';
            }
        });
        card.addEventListener('click', () => toggleItem(itemId));
        card.addEventListener('keydown', event => {
            if (event.target !== card) return;
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleItem(itemId); }
        });
    });

    container.querySelector('.iig-footer-clear')?.addEventListener('click', () => {
        if (activeItem) toggleItem(activeItem.id);
    });

    const descArea = container.querySelector(`#iig_wardrobe_desc_${CSS.escape(activeItem?.id || '')}`);
    if (descArea && activeItem) {
        descArea.addEventListener('blur', () => {
            updateWardrobeItemDescription(activeItem.id, descArea.value);
            saveSettings();
            toastr.info('Описание сохранено', 'Гардероб');
        });
    }
}

function renderReferenceGenerator(content) {
    const settings = getSettings();
    const s = iigRefGenState;
    s.flags = normalizeRefGenFlags(s.flags);
    const src = data => `data:${detectMimeType(data)};base64,${data}`;
    const slot = (key, label) => `
        <div class="iig-refgen-slot">
            <div class="iig-refgen-slot-label">${label}</div>
            ${s[key] ? `<img src="${src(s[key])}" alt="${label}">` : '<div class="iig-refgen-slot-empty"><i class="fa-solid fa-image" aria-hidden="true"></i></div>'}
            <div class="iig-refgen-slot-actions">
                <button type="button" class="menu_button iig-refgen-upload" data-slot="${key}">Загрузить</button>
                ${s[key] ? `<button type="button" class="menu_button iig-refgen-clear" data-slot="${key}" aria-label="Убрать">✕</button>` : ''}
            </div>
        </div>`;
    const flag = (key, label) => `<label class="checkbox_label"><input type="checkbox" class="iig-refgen-flag" data-flag="${key}" ${s.flags[key] ? 'checked' : ''}> <span>${label}</span></label>`;
    const outfits = (settings.wardrobeItems || []).filter(i => i.imageData);
    const disabled = s.busy ? 'disabled' : '';

    content.innerHTML = `
        <div class="iig-refgen">
            <details class="iig-refgen-help">
                <summary title="Как пользоваться генератором"><i class="fa-solid fa-circle-question" aria-hidden="true"></i> Как это работает?</summary>
                <ol>
                    <li><b>API</b>: основной API картинок или свой (раздел «API для генератора референсов» в настройках).</li>
                    <li><b>Персонаж / Одежда</b>: загрузите фото лица и одежды или выберите одежду из гардероба.</li>
                    <li><b>Описание</b>: тип тела и внешность. «AI-уточнение» перепишет его через модель промптов, результат можно править.</li>
                    <li><b>Флажки</b>: что не переносить с картинок (тату, волосы, аксессуары).</li>
                    <li><b>Собрать промпт</b>, при необходимости поправьте текст, затем <b>Сгенерировать</b>.</li>
                    <li>Выберите, чей это гардероб (персонаж, юзер или RPG-персонаж), и <b>сохраните</b>. Описание и промпт сохранятся вместе с картинкой.</li>
                </ol>
            </details>
            <div class="flex-row">
                <label for="iig_refgen_source">API</label>
                <select id="iig_refgen_source" class="flex1">
                    <option value="main" ${settings.refGenSource !== 'custom' ? 'selected' : ''}>Основной API картинок</option>
                    <option value="custom" ${settings.refGenSource === 'custom' ? 'selected' : ''}>Свой API (настройки расширения)</option>
                </select>
            </div>
            <div class="flex-row">
                <label for="iig_refgen_name">Имя</label>
                <input id="iig_refgen_name" class="text_pole flex1" value="${escapeHtml(s.name)}" placeholder="Имя персонажа">
            </div>
            <div class="iig-refgen-slots">${slot('characterImage', 'Персонаж')}${slot('outfitImage', 'Одежда')}</div>
            ${outfits.length ? `<select id="iig_refgen_pick_outfit" class="text_pole" aria-label="Взять одежду из гардероба">
                <option value="">— одежда из гардероба —</option>
                ${outfits.map(i => `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('')}
            </select>` : ''}
            <input type="file" id="iig_refgen_file" accept="image/*" hidden>
            <label for="iig_refgen_desc">Описание (тело, внешность)</label>
            <textarea id="iig_refgen_desc" class="text_pole" rows="3" placeholder="Например: высокая, атлетичная, широкие плечи...">${escapeHtml(s.description)}</textarea>
            <button type="button" class="menu_button iig-refgen-refine" ${disabled}><i class="fa-solid fa-robot"></i> AI-уточнение</button>
            <label for="iig_refgen_refined">Уточнённое описание</label>
            <textarea id="iig_refgen_refined" class="text_pole" rows="3" placeholder="Появится после AI-уточнения, можно править">${escapeHtml(s.refinedDescription)}</textarea>
            <div class="iig-refgen-flags">
                ${flag('ignoreTattoos', 'Игнорировать тату и пирсинг')}
                ${flag('bodyFromDescription', 'Тип тела из описания')}
                ${flag('noHairTransfer', 'Не переносить волосы')}
                ${flag('noAccessoriesTransfer', 'Не переносить аксессуары')}
            </div>
            <button type="button" class="menu_button iig-refgen-build" ${disabled}><i class="fa-solid fa-hammer"></i> Собрать промпт</button>
            <label for="iig_refgen_prompt">Итоговый промпт</label>
            <textarea id="iig_refgen_prompt" class="text_pole" rows="5">${escapeHtml(s.finalPrompt)}</textarea>
            <button type="button" class="menu_button iig-refgen-generate" ${disabled}><i class="fa-solid fa-image"></i> Сгенерировать</button>
            <div class="iig-refgen-status" role="status" aria-live="polite">${escapeHtml(s.status)}</div>
            ${s.resultImage ? `
            <img class="iig-refgen-result" src="${src(s.resultImage)}" alt="Сгенерированный референс">
            <div class="flex-row">
                <input id="iig_refgen_item_name" class="text_pole flex1" value="${escapeHtml(s.itemName)}" placeholder="Название в гардеробе" aria-label="Название в гардеробе">
                <select id="iig_refgen_target" aria-label="Чей гардероб">
                    <option value="char" ${s.target === 'char' ? 'selected' : ''}>Персонаж</option>
                    <option value="user" ${s.target === 'user' ? 'selected' : ''}>Юзер</option>
                    ${getCurrentRpgWardrobeTargets(settings).map(rpg => `<option value="${escapeHtml(rpg.target)}" ${s.target === rpg.target ? 'selected' : ''}>RPG: ${escapeHtml(rpg.name)}</option>`).join('')}
                </select>
            </div>
            <button type="button" class="menu_button iig-refgen-save" ${disabled}><i class="fa-solid fa-floppy-disk"></i> Сохранить в гардероб</button>` : ''}
        </div>`;
    bindReferenceGenerator(content);
}

function getRefGenPromptState(s = iigRefGenState) {
    return { ...s, hasCharacterRef: Boolean(s.characterImage), hasOutfitRef: Boolean(s.outfitImage) };
}

function bindReferenceGenerator(content) {
    const settings = getSettings();
    const s = iigRefGenState;
    const $ = selector => content.querySelector(selector);
    // Re-render only if the generator tab is still on screen (the modal may be closed mid-request).
    const rerender = () => {
        if (iigCurrentWardrobeTab === 'gen' && document.getElementById('iig-wardrobe-content')) renderQuickWardrobeList();
    };
    const runBusy = async (status, task) => {
        if (s.busy) return;
        s.busy = true;
        s.status = status;
        rerender();
        try {
            await task(text => { s.status = text; const el = document.querySelector('.iig-refgen-status'); if (el) el.textContent = text; });
            s.status = '';
        } catch (error) {
            s.status = `Ошибка: ${error.message}`;
            toastr.error(error.message, 'Генератор референсов');
        } finally {
            s.busy = false;
            rerender();
        }
    };

    if (!s.name) {
        const context = SillyTavern.getContext();
        const name = context.characters?.[context.characterId]?.name || '';
        if (name) { s.name = name; const input = $('#iig_refgen_name'); if (input) input.value = name; }
    }

    $('#iig_refgen_source')?.addEventListener('change', event => {
        settings.refGenSource = event.target.value === 'custom' ? 'custom' : 'main';
        saveSettings();
    });

    // Text fields update state only; no re-render, so typing is not interrupted.
    const bindText = (selector, key) => $(selector)?.addEventListener('input', event => { s[key] = event.target.value; });
    bindText('#iig_refgen_name', 'name');
    bindText('#iig_refgen_desc', 'description');
    bindText('#iig_refgen_refined', 'refinedDescription');
    bindText('#iig_refgen_prompt', 'finalPrompt');
    bindText('#iig_refgen_item_name', 'itemName');
    $('#iig_refgen_target')?.addEventListener('change', event => { s.target = event.target.value; });

    content.querySelectorAll('.iig-refgen-flag').forEach(box => {
        box.addEventListener('change', () => { s.flags = { ...normalizeRefGenFlags(s.flags), [box.dataset.flag]: box.checked }; });
    });

    const fileInput = $('#iig_refgen_file');
    let pendingSlot = null;
    content.querySelectorAll('.iig-refgen-upload').forEach(button => {
        button.addEventListener('click', () => { pendingSlot = button.dataset.slot; fileInput?.click(); });
    });
    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        if (!file || !pendingSlot) return;
        try {
            s[pendingSlot] = await resizeImageBase64(await readLibraryFileAsBase64(file), 1024);
            rerender();
        } catch (error) {
            toastr.error(`Не удалось загрузить картинку: ${error.message}`);
        } finally {
            fileInput.value = '';
        }
    });
    content.querySelectorAll('.iig-refgen-clear').forEach(button => {
        button.addEventListener('click', () => { s[button.dataset.slot] = null; rerender(); });
    });
    $('#iig_refgen_pick_outfit')?.addEventListener('change', event => {
        const item = (settings.wardrobeItems || []).find(i => i.id === event.target.value);
        if (!item?.imageData) return;
        s.outfitImage = item.imageData;
        rerender();
    });

    $('.iig-refgen-refine')?.addEventListener('click', () => runBusy('AI-уточнение...', async () => {
        s.refinedDescription = await refineReferenceDescription(s.description);
    }));
    $('.iig-refgen-build')?.addEventListener('click', () => {
        s.finalPrompt = buildReferenceGenPrompt(getRefGenPromptState());
        rerender();
    });
    $('.iig-refgen-generate')?.addEventListener('click', () => runBusy('Генерация...', async onStatus => {
        if (!String(s.finalPrompt || '').trim()) s.finalPrompt = buildReferenceGenPrompt(getRefGenPromptState());
        s.resultImage = await generateReferenceImage(getRefGenPromptState(), onStatus);
        if (!s.itemName) s.itemName = `Референс ${s.name || ''}`.trim();
    }));
    $('.iig-refgen-save')?.addEventListener('click', () => runBusy('Сохранение...', async () => {
        const resized = await resizeImageBase64(s.resultImage, 512);
        const item = saveGeneratedReference(s, resized);
        updateWardrobeInjection();
        toastr.success(`Сохранено в гардероб: ${item.name}`, 'Генератор референсов');
    }));
}

// ============================================================
// INIT
// Must stay at the very end of the file: it runs immediately and
// touches module-level `let` state declared above (TDZ otherwise).
// ============================================================

(function init() {
    const context = SillyTavern.getContext();
    getSettings();

    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        observeImageRegenButtons();
        addButtonsToExistingMessages();
        addPromptPanelsToExistingMessages();
        applyImageDisplayMode();
        updateWardrobeInjection();
        updateImageModeInjection();
        console.log('[IIG] Inline Image Generation v3.0 loaded');
    });

    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            observeImageRegenButtons();
            addButtonsToExistingMessages();
            promptPanels.clear();
            addPromptPanelsToExistingMessages();
            observePromptPanels();
            updateWardrobeInjection();
            updateImageModeInjection();
            // Bot profile / RPG mode depend on the open character
            renderCharacterProfiles();
            updateFloatingButtonBadge();
            if (iigWardrobeModal) openWardrobeModal();
        }, 100);
        setTimeout(updateCharAvatarPreview, 200);
    });

    // A swipe shows another variant of the reply with its own prompt block data.
    context.eventSource.on(context.event_types.MESSAGE_SWIPED, (messageId) => {
        const id = Number(messageId);
        const el = document.querySelector(`#chat .mes[mesid="${id}"]`);
        if (el) setTimeout(() => ensurePromptPanelForMessage(el, id, { rerender: true }), 50);
    });
    // Deleting messages renumbers them: rebuild the blocks from scratch.
    context.eventSource.on(context.event_types.MESSAGE_DELETED, () => {
        setTimeout(() => {
            for (const entry of promptPanels.values()) entry.panel.remove();
            promptPanels.clear();
            addPromptPanelsToExistingMessages();
        }, 50);
    });

    // Only freshly generated replies (not old messages rendered on chat load) get an automatic prompt.
    context.eventSource.on(context.event_types.MESSAGE_RECEIVED, (messageId) => {
        if (getSettings().promptAutoGenerate && Number.isInteger(Number(messageId))) pendingAutoPrompts.add(Number(messageId));
    });

    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        await onMessageReceived(messageId);
    });

    // Wardrobe button in the input bar
    createFloatingWardrobeButton();
    observePromptPanels();

    console.log('[IIG] Inline Image Generation v3.0 initialized');
})();

