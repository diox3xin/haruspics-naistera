# Fusion implementation progress

## Implemented in this working tree

- Provider-aware size, aspect-ratio and API-quality resolution; per-image panel overrides.
- Exact Images API ratios: unsupported 16:9 is rejected instead of silently mapped to 1536x1024 (3:2).
- Chat `image_config`: automatic for OpenRouter, explicit opt-in for other compatible services. Unknown Chat services receive only a textual aspect-ratio instruction.
- Panel cancellation, collapsible prompt, editable style/negative, requested dimensions and actual loaded file dimensions; guards against chat/swipe changes before saving panel results.
- Five-section settings navigation and responsive Fusion editors.
- Unified current bot/persona/NPC/RPG appearance editor; image upload, avatar import, vision description, aliases, description toggle. RPG heroes are bound to the current card. Existing libraries are retained.
- Outfit and hairstyle wardrobe with search, previews, selection, nested draft editor and crop. Escape does not close the wardrobe through an open dialog; its listener is removed on every close.
- Separate source-exclusion and target-preservation rules. These are saved per item and forwarded to image generation. Source tattoo exclusion does not erase target tattoos.
- Adapted outfit generator with optional text-model instruction refinement; result is saved as a new character-bound item. Original outfit remains unchanged.
- Scoped theme controls: colors, radius, spacing, preview and reset.
- Additive migration; previous settings, outfits and foreign message metadata are retained.
- New-generation placement switch: inline or separate Fusion block. Existing images are never moved; separate blocks retain prompt, status, retry/cancel controls and requested/actual dimensions.
- Legacy inline regeneration now checks chat, message, swipe and message text before saving; stale requests restore the previous DOM image.

## Not yet complete

- Full replacement of legacy settings controls, section-specific FAQ content, and moving all technical settings under Advanced.
- Reference selection preview before requests, comprehensive warnings about unbound descriptions, group-chat multi-bot catalog.
- Independent worn selections per bot/persona: legacy active slots are retained; character-bound items are excluded for another character but their selection is not separately restored.
- Requested/actual dimensions for legacy inline images.
- Complete image-edit capability negotiation. Adaptation is disabled for the current text-only NovelAI routes, but other providers may still reject image references. Model instructions cannot guarantee body/face fidelity.
- Existing fixed colors in legacy controls have not all been replaced by theme variables.

## Verification

Run from any directory using absolute paths:

```powershell
node --check 'C:\Users\diox3\.cline\data\workspaces\chat\haruspics-fusion\index.js'
node --test 'C:\Users\diox3\.cline\data\workspaces\chat\haruspics-fusion\tests\*.test.cjs'
git -C 'C:\Users\diox3\.cline\data\workspaces\chat\haruspics-fusion' diff --check
```

Browser tests use installed Edge/Chrome (or `IIG_TEST_BROWSER`) with stubbed SillyTavern context and API responses. They do not verify live paid image APIs or compatibility with a running Horae installation. No API keys are needed for tests.

Do not enable Fusion and sillyimages together: both currently use `inline_image_gen` settings. Changes in this iteration are local, not committed or pushed.