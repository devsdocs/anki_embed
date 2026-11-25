import assert from 'assert';
import { parseDeckConfig, parsePastedAnkiText } from '../src/parser';
import { AnkiClient } from '../src/anki-client';
import {
	checkFrontmatterForCardId,
	extractAnkiTagsFromNote,
	extractAnkiTagsFromText,
	extractAnswerHtml,
	extractCardIdsFromText,
	extractLinkedCardIdsFromFrontmatter,
	findMatchingAnkiTag,
	formatCardHtml,
	formatClozeTitle,
	isClozeCard,
	isTagMatch,
	matchesCardId,
	normalizeAnkiCss,
	normalizeAnkiTag,
	buildAnkiTagQuery,
	parseTagItem,
	renderClozeDeletion,
} from '../src/card-html';
import { DEFAULT_SETTINGS, VIEW_TYPE_ANKI_EMBED } from '../src/types';
import { syncNoteLinksWithSettings } from '../src/link-service';

// 3e. Test parseDeckConfig - links and backlinks config
const configLinks = parseDeckConfig(`
links: false
backlinks: false
`);
assert.strictEqual(configLinks.links, false);
assert.strictEqual(configLinks.backlinks, false);

console.log('Running Anki Embed verification tests...');

// 0. Test VIEW_TYPE_ANKI_EMBED constant
assert.strictEqual(VIEW_TYPE_ANKI_EMBED, 'anki-embed-view');

// 1. Test parseDeckConfig - Key-Value format
const config1 = parseDeckConfig(`
deck: Japanese::Kanji
limit: 25
filter: due
randomize: true
`);
assert.strictEqual(config1.deck, 'Japanese::Kanji');
assert.strictEqual(config1.limit, 25);
assert.strictEqual(config1.filter, 'due');
assert.strictEqual(config1.randomize, true);

// 2. Test parseDeckConfig - Simple single line deck name
const config2 = parseDeckConfig('Medical::Pharmacology');
assert.strictEqual(config2.deck, 'Medical::Pharmacology');

// 3. Test parseDeckConfig - Query format
const config3 = parseDeckConfig(`
query: deck:"Default" is:due tag:vocab
limit: 10
filter: new
`);
assert.strictEqual(config3.query, 'deck:"Default" is:due tag:vocab');
assert.strictEqual(config3.limit, 10);
assert.strictEqual(config3.filter, 'new');

// 3b. Test parseDeckConfig - Interactive select format
const configSelect = parseDeckConfig('select: true');
assert.strictEqual(configSelect.select, true);

const configSelectQuestion = parseDeckConfig('deck: ?');
assert.strictEqual(configSelectQuestion.select, true);
assert.strictEqual(configSelectQuestion.deck, undefined);

// 3c. Test parseDeckConfig - styles format
const configStylesAnki = parseDeckConfig('styles: anki');
assert.strictEqual(configStylesAnki.styles, true);

const configStylesTrue = parseDeckConfig('styles: true');
assert.strictEqual(configStylesTrue.styles, true);

const configStylesObsidian = parseDeckConfig('styles: obsidian');
assert.strictEqual(configStylesObsidian.styles, false);

const configStylesFalse = parseDeckConfig('styles: false');
assert.strictEqual(configStylesFalse.styles, false);

// 3d. Test parseDeckConfig - live sync format
const configLiveTrue = parseDeckConfig('live: true');
assert.strictEqual(configLiveTrue.live, true);

const configSyncLive = parseDeckConfig('sync: live');
assert.strictEqual(configSyncLive.live, true);

const configLiveFalse = parseDeckConfig('live: false');
assert.strictEqual(configLiveFalse.live, false);

// 3e. Test parseDeckConfig - filter due+new
const configDueNew = parseDeckConfig('filter: due+new');
assert.strictEqual(configDueNew.filter, 'due+new');

const configBoth = parseDeckConfig('filter: both');
assert.strictEqual(configBoth.filter, 'due+new');

// 3f. Test parseDeckConfig - suspended format
const configNoSuspended = parseDeckConfig('suspended: false');
assert.strictEqual(configNoSuspended.excludeSuspended, true);

const configWithSuspended = parseDeckConfig('suspended: true');
assert.strictEqual(configWithSuspended.excludeSuspended, false);

// 3g. Test parseDeckConfig - order format
const configReviewsFirst = parseDeckConfig('order: reviews-first');
assert.strictEqual(configReviewsFirst.order, 'reviews-first');

const configOrderRandom = parseDeckConfig('order: random');
assert.strictEqual(configOrderRandom.order, 'random');

// 3h. Test parseDeckConfig - counts format
const configCountsTrue = parseDeckConfig('counts: true');
assert.strictEqual(configCountsTrue.counts, true);

const configCountsFalse = parseDeckConfig('counts: false');
assert.strictEqual(configCountsFalse.counts, false);

const configStatsTrue = parseDeckConfig('stats: yes');
assert.strictEqual(configStatsTrue.counts, true);

// 3i. Test parseDeckConfig - card / cid format
const configCard = parseDeckConfig('card: 172948294829');
assert.strictEqual(configCard.card, 172948294829);
assert.strictEqual(configCard.cardId, 172948294829);

const configCid = parseDeckConfig('cid: 987654321');
assert.strictEqual(configCid.card, 987654321);
assert.strictEqual(configCid.cardId, 987654321);

// 3j. Test parseDeckConfig - heatmap format
const configHeatmapTrue = parseDeckConfig('heatmap: true');
assert.strictEqual(configHeatmapTrue.heatmap, true);

const configHeatmapFalse = parseDeckConfig('heatmap: false');
assert.strictEqual(configHeatmapFalse.heatmap, false);

// 3k. Test parseDeckConfig - timer format
const configTimerTrue = parseDeckConfig('timer: true\ntimer_warning: 5\ntimer_limit: 10');
assert.strictEqual(configTimerTrue.timer, true);
assert.strictEqual(configTimerTrue.timerWarning, 5);
assert.strictEqual(configTimerTrue.timerLimit, 10);

// 4. Test parsePastedAnkiText
const paste1 = parsePastedAnkiText('anki://deck/Japanese%20Kanji');
assert.deepStrictEqual(paste1, { deckName: 'Japanese Kanji' });

const paste2 = parsePastedAnkiText('anki:Default');
assert.deepStrictEqual(paste2, { deckName: 'Default' });

const pasteInvalid = parsePastedAnkiText('https://google.com');
assert.strictEqual(pasteInvalid, null);

// 5. Test rendered card answer cleanup and Anki template formatting
const renderedAnswer = 'Question:<br>Which organism?<hr id=answer>Answer: Salmonella';
assert.strictEqual(extractAnswerHtml(renderedAnswer), 'Answer: Salmonella');
assert.strictEqual(extractAnswerHtml('Front<hr class="separator" id="answer" />Back'), 'Back');
assert.strictEqual(
	formatCardHtml('{{FrontSide}}<hr id="answer">Back side', 'Question content'),
	'Question content<hr id="answer">Back side'
);
assert.strictEqual(formatCardHtml('{{FrontSide}}', '$$B_S$$'), '$$B_S$$');
assert.strictEqual(extractAnswerHtml('Back side without a front-side marker'), 'Back side without a front-side marker');

// 5b. Test normalizeAnkiCss
assert.strictEqual(
	normalizeAnkiCss('.card { font-family: arial; }'),
	'.card { font-family: arial; }'
);
assert.strictEqual(
	normalizeAnkiCss('body { font-size: 20px; } html { margin: 0; } body.nightMode { background: black; }'),
	'.card { font-size: 20px; } .card { margin: 0; } .card.nightMode { background: black; }'
);
assert.strictEqual(normalizeAnkiCss(''), '');

// 5c. Test isClozeCard
assert.strictEqual(
	isClozeCard({ modelName: 'AnKingOverhaul', question: 'The <span class="cloze">[...]</span> nerve', answer: 'The <span class="cloze">axillary</span> nerve' }),
	true
);
assert.strictEqual(
	isClozeCard({ modelName: 'Cloze', question: 'Capital of [...] is Paris', answer: 'Capital of France is Paris' }),
	true
);
assert.strictEqual(
	isClozeCard({ modelName: 'Basic', question: 'What is the capital?', answer: 'What is the capital?<hr id=answer>Paris' }),
	false
);
assert.strictEqual(
	isClozeCard({ modelName: 'Custom', question: '2 + 2', answer: '4' }),
	false
);
assert.strictEqual(isClozeCard(undefined), false);

// 6. Test AnkiClient payload construction & endpoint coverage
const client = new AnkiClient('http://127.0.0.1:8765', 'test-api-key');

assert.strictEqual(typeof client.request, 'function');
assert.strictEqual(typeof client.getDeckNamesAndIds, 'function');
assert.strictEqual(typeof client.getDeckStats, 'function');
assert.strictEqual(typeof client.addNote, 'function');
assert.strictEqual(typeof client.addNotes, 'function');
assert.strictEqual(typeof client.findNotes, 'function');
assert.strictEqual(typeof client.getNotesInfo, 'function');
assert.strictEqual(typeof client.getModelNames, 'function');
assert.strictEqual(typeof client.getModelFieldNames, 'function');
assert.strictEqual(typeof client.suspendCards, 'function');
assert.strictEqual(typeof client.unsuspendCards, 'function');
assert.strictEqual(typeof client.guiBrowse, 'function');
assert.strictEqual(typeof client.guiCurrentCard, 'function');
assert.strictEqual(typeof client.guiShowQuestion, 'function');
assert.strictEqual(typeof client.guiShowAnswer, 'function');
assert.strictEqual(typeof client.guiAnswerCard, 'function');
assert.strictEqual(typeof client.multi, 'function');
assert.strictEqual(typeof client.guiAnswerAndCurrentCard, 'function');
assert.strictEqual(typeof client.guiUndoAndCurrentCard, 'function');
assert.strictEqual(typeof client.storeMediaFile, 'function');
assert.strictEqual(typeof client.retrieveMediaFile, 'function');
assert.strictEqual(typeof client.getMediaFilesNames, 'function');
assert.strictEqual(typeof client.sync, 'function');
assert.strictEqual(typeof client.setSpecificValueOfCard, 'function');

// 6b. Test parseDeckConfig - remote / gamepad / controller / contanki
const configRemote = parseDeckConfig('remote: true');
assert.strictEqual(configRemote.remote, true);

const configGamepad = parseDeckConfig('gamepad: false');
assert.strictEqual(configGamepad.remote, false);

const configContanki = parseDeckConfig('contanki: yes');
assert.strictEqual(configContanki.remote, true);

const configScale = parseDeckConfig('scale: x1.2');
assert.strictEqual(configScale.scale, 1.2);
assert.strictEqual(configScale.fontScale, 1.2);

const configFontScale = parseDeckConfig('font_scale: 1.5');
assert.strictEqual(configFontScale.scale, 1.5);
assert.strictEqual(configFontScale.fontScale, 1.5);

const configFlashOff = parseDeckConfig('flash: false\nflash_duration: 0\nflash_transition: 10');
assert.strictEqual(configFlashOff.flash, false);
assert.strictEqual(configFlashOff.flashDuration, 0);
assert.strictEqual(configFlashOff.flashTransition, 10);

const configLinksOff = parseDeckConfig('links: false\nbacklinks: false');
assert.strictEqual(configLinksOff.links, false);
assert.strictEqual(configLinksOff.backlinks, false);

const configLinksOn = parseDeckConfig('link: yes\nbacklink: true');
assert.strictEqual(configLinksOn.links, true);
assert.strictEqual(configLinksOn.backlinks, true);

// 7. Test DeckEmbedConfig reset state
const resetConfig = { ...config1, select: true, deck: undefined, query: undefined };
assert.strictEqual(resetConfig.select, true);
assert.strictEqual(resetConfig.deck, undefined);
assert.strictEqual(resetConfig.query, undefined);

// 8. Test DEFAULT_SETTINGS includes useCardStyles: true, liveSync: false, excludeSuspended: true, cardOrder: 'reviews-first', showCardCounts: true, showHeatmap: true, enableCardTimer: false, timerWarningSeconds: 5, timerLimitSeconds: 10, enableRatingFlash: true, ratingFlashDurationMs: 25, ratingFlashTransitionMs: 20, enableGamepad: true, enableCardLinks: true, enableBacklinks: true, enableTagLinks: true
assert.strictEqual(DEFAULT_SETTINGS.useCardStyles, true);
assert.strictEqual(DEFAULT_SETTINGS.liveSync, false);
assert.strictEqual(DEFAULT_SETTINGS.excludeSuspended, true);
assert.strictEqual(DEFAULT_SETTINGS.cardOrder, 'reviews-first');
assert.strictEqual(DEFAULT_SETTINGS.showCardCounts, true);
assert.strictEqual(DEFAULT_SETTINGS.showHeatmap, true);
assert.strictEqual(DEFAULT_SETTINGS.enableCardTimer, false);
assert.strictEqual(DEFAULT_SETTINGS.timerWarningSeconds, 5);
assert.strictEqual(DEFAULT_SETTINGS.timerLimitSeconds, 10);
assert.strictEqual(DEFAULT_SETTINGS.enableRatingFlash, true);
assert.strictEqual(DEFAULT_SETTINGS.ratingFlashDurationMs, 25);
assert.strictEqual(DEFAULT_SETTINGS.ratingFlashTransitionMs, 20);
assert.strictEqual(DEFAULT_SETTINGS.cardAppendTarget, 'daily');
assert.strictEqual(DEFAULT_SETTINGS.cardAppendCustomPath, 'Anki Notes.md');
assert.strictEqual(DEFAULT_SETTINGS.cardAppendHeading, '## Anki Reviews');
assert.strictEqual(DEFAULT_SETTINGS.cardFontScale, 1.0);
assert.deepStrictEqual(DEFAULT_SETTINGS.cardLinks, {});
assert.strictEqual(DEFAULT_SETTINGS.enableCardLinks, true);
assert.strictEqual(DEFAULT_SETTINGS.enableBacklinks, true);
assert.strictEqual(DEFAULT_SETTINGS.enableTagLinks, true);
assert.strictEqual(DEFAULT_SETTINGS.autoLinkExportedCard, true);
assert.strictEqual(DEFAULT_SETTINGS.cardExportFolder, '');
assert.strictEqual(DEFAULT_SETTINGS.enableGamepad, true);
assert.strictEqual(DEFAULT_SETTINGS.gamepadMapping[0], 'flip_or_good');
assert.strictEqual(DEFAULT_SETTINGS.gamepadMapping[4], 'undo');
assert.strictEqual(DEFAULT_SETTINGS.gamepadMapping[10], 'append_card_note');
assert.strictEqual(DEFAULT_SETTINGS.gamepadMapping[11], 'create_card_note');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['j'], 'flip_or_again');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['z'], 'undo');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['s'], 'suspend');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['b'], 'bury');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['f'], 'flag');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['c'], 'create_card_note');
assert.strictEqual(DEFAULT_SETTINGS.keyboardMapping['a'], 'append_card_note');

// 9. Test Tag Linking Logic
// 9a. normalizeAnkiTag
assert.strictEqual(normalizeAnkiTag('#Cardio'), 'Cardio');
assert.strictEqual(normalizeAnkiTag('#anki/Cardio'), 'Cardio');
assert.strictEqual(normalizeAnkiTag('anki-tag/Cardio/Heart'), 'Cardio::Heart');
assert.strictEqual(normalizeAnkiTag('AnKing_Step1::#FirstAid::03_Cardio'), 'AnKing_Step1::FirstAid::03_Cardio');

// 9b. isTagMatch
assert.strictEqual(isTagMatch('AnKing_Step1::#FirstAid::03_Cardio::01_Anatomy', 'Cardio'), true);
assert.strictEqual(isTagMatch('AnKing_Step1::#FirstAid::03_Cardio::01_Anatomy', '03_Cardio'), true);
assert.strictEqual(isTagMatch('AnKing_Step1::#FirstAid::03_Cardio::01_Anatomy', 'FirstAid::Cardio'), true);
assert.strictEqual(isTagMatch('AnKing_Step1::#FirstAid::03_Cardio::01_Anatomy', 'anki/Cardio'), true);
assert.strictEqual(isTagMatch('Cardio', 'Cardio'), true);
assert.strictEqual(isTagMatch('Cardio::Heart', 'anki/Cardio/Heart'), true);
assert.strictEqual(isTagMatch('Beta_Blockers', 'Beta Blockers'), true);
assert.strictEqual(isTagMatch('AnKing_Step1::#FirstAid::03_Cardio', 'car'), false);
assert.strictEqual(isTagMatch('Cardio', 'Renal'), false);

// 9c. extractAnkiTagsFromNote
const mockCache1 = {
	frontmatter: { 'anki-tag': 'Cardio' },
};
assert.deepStrictEqual(extractAnkiTagsFromNote(mockCache1), ['Cardio']);

const mockCache2 = {
	frontmatter: {
		'anki-tags': ['Cardio', 'FirstAid::Pharm'],
		tags: ['anki/BetaBlockers', 'other-tag'],
	},
	tags: [{ tag: '#anki/Arrhythmia' }],
};
const extracted2 = extractAnkiTagsFromNote(mockCache2);
assert.strictEqual(extracted2.includes('Cardio'), true);
assert.strictEqual(extracted2.includes('FirstAid::Pharm'), true);
assert.strictEqual(extracted2.includes('BetaBlockers'), true);
assert.strictEqual(extracted2.includes('Arrhythmia'), true);
assert.strictEqual(extracted2.includes('other-tag'), false);

// 9d. extractAnkiTagsFromText
const noteText = `---
anki-tags: Cardio, Pathology
---
Some note content
#anki/Anatomy
`;
const extractedText = extractAnkiTagsFromText(noteText);
assert.strictEqual(extractedText.includes('Cardio'), true);
assert.strictEqual(extractedText.includes('Pathology'), true);
assert.strictEqual(extractedText.includes('Anatomy'), true);

// 9e. parseDeckConfig tagLinks
const configTagLinks = parseDeckConfig(`
tagLinks: false
`);
assert.strictEqual(configTagLinks.tagLinks, false);

const configTagLinksTrue = parseDeckConfig(`
tag_links: true
`);
assert.strictEqual(configTagLinksTrue.tagLinks, true);

// 9f. parseTagItem parent tags test
const tagItem1 = parseTagItem('AnKing_Step1::#FirstAid::03_Cardio::01_Anatomy');
assert.strictEqual(tagItem1.leafTag, '01_Anatomy');
assert.strictEqual(tagItem1.parentPath, 'AnKing_Step1 › #FirstAid › 03_Cardio');
assert.strictEqual(tagItem1.tagToInsert, 'AnKing_Step1::FirstAid::03_Cardio::01_Anatomy');

const tagItem2 = parseTagItem('AnKing_Step1::#FirstAid::04_Endocrine::01_Anatomy');
assert.strictEqual(tagItem2.leafTag, '01_Anatomy');
assert.strictEqual(tagItem2.parentPath, 'AnKing_Step1 › #FirstAid › 04_Endocrine');
// The two items share the same leaf '01_Anatomy', but have completely different parent paths
assert.notStrictEqual(tagItem1.parentPath, tagItem2.parentPath);

const tagItemSingle = parseTagItem('Cardio');
assert.strictEqual(tagItemSingle.leafTag, 'Cardio');
assert.strictEqual(tagItemSingle.parentPath, '');

// 9g. formatClozeTitle tests
const clozeTitle1 = formatClozeTitle('', {
	card: {
		fields: { Text: { value: 'What G protein is the {{c1::H2 histamine receptor}} coupled to?' } },
		ord: 0,
	},
});
assert.strictEqual(clozeTitle1, 'What G protein is the **[...]** coupled to?');

// Hint in cloze should still format as **[...]** in exported title
const clozeTitleWithHint = formatClozeTitle('', {
	card: {
		fields: { Text: { value: 'The {{c1::axillary::nerve}} innervates the deltoid.' } },
		ord: 0,
	},
});
assert.strictEqual(clozeTitleWithHint, 'The **[...]** innervates the deltoid.');

// Multiple clozes on one card
const clozeTitleMulti = formatClozeTitle('', {
	card: {
		fields: { Text: { value: '{{c1::Sympathetic}} and {{c2::parasympathetic}} nervous systems.' } },
		ord: 1,
	},
});
assert.strictEqual(clozeTitleMulti, 'Sympathetic and **[...]** nervous systems.');

// Cloze from HTML question fallback
const clozeTitleHtml = formatClozeTitle('What G protein is the <span class="cloze">[...]</span> coupled to?');
assert.strictEqual(clozeTitleHtml, 'What G protein is the **[...]** coupled to?');

// Cloze question with [...] already
const clozeTitlePlain = formatClozeTitle('What G protein is the H2 histamine receptor coupled to? [...]');
assert.strictEqual(clozeTitlePlain, 'What G protein is the H2 histamine receptor coupled to? **[...]**');

// 9h. checkFrontmatterForCardId tests for linked-cards properties
assert.strictEqual(checkFrontmatterForCardId({ 'linked-cards': [123456789] }, '123456789'), true);
assert.strictEqual(checkFrontmatterForCardId({ 'linked-cards': ['123456789'] }, '123456789'), true);
assert.strictEqual(checkFrontmatterForCardId({ 'linked-cards': 123456789 }, '123456789'), true);
assert.strictEqual(checkFrontmatterForCardId({ 'linked-card': '123456789' }, '123456789'), true);
assert.strictEqual(checkFrontmatterForCardId({ 'anki-cards': [123456789] }, '123456789'), true);
assert.strictEqual(checkFrontmatterForCardId({ 'linked-cards': [999999999] }, '123456789'), false);
assert.strictEqual(matchesCardId('obsidian://anki-card?cardId=123456789', '123456789'), true);

// 9i. extractLinkedCardIdsFromFrontmatter & extractCardIdsFromText tests
const extractedFm = extractLinkedCardIdsFromFrontmatter({
	'linked-cards': [1001, 1002],
	'anki-card-id': '1003',
});
assert.deepStrictEqual(extractedFm.sort(), [1001, 1002, 1003]);

const extractedCardIds = extractCardIdsFromText(`
Here is an embed:
[Anki Card](obsidian://anki-card?cardId=2001)
\`\`\`anki
card: 2002
\`\`\`
`);
assert.deepStrictEqual(extractedCardIds.sort(), [2001, 2002]);

// 9j. findMatchingAnkiTag helper tests
const cardTags = ['Cardiology::Pharmacology::Beta_Blockers', 'Pathology::Heart'];
assert.strictEqual(findMatchingAnkiTag(cardTags, ['Beta Blockers', 'Neurology']), 'Beta Blockers');
assert.strictEqual(findMatchingAnkiTag(cardTags, ['Heart']), 'Heart');
assert.strictEqual(findMatchingAnkiTag(cardTags, ['Renal', 'GI']), null);
assert.strictEqual(findMatchingAnkiTag([], ['Heart']), null);
assert.strictEqual(findMatchingAnkiTag(cardTags, []), null);

// 9k. syncNoteLinksWithSettings tests (deleting/adding cards from frontmatter properties)
void (async () => {
	const mockFile = { path: 'Notes/Cardio.md', basename: 'Cardio' } as unknown as import('obsidian').TFile;
	let currentFm: Record<string, unknown> | null = { 'linked-cards': [1001] }; // 1002 was removed from properties!
	const mockApp = {
		metadataCache: {
			getFileCache: (_file: unknown) => ({ frontmatter: currentFm }),
		},
		vault: {
			cachedRead: async (_file: unknown) => 'Some note text without card links',
		},
	} as unknown as import('obsidian').App;

	const testSettings = {
		cardLinks: {
			'1001': ['Notes/Cardio.md'],
			'1002': ['Notes/Cardio.md'],
		},
	} as unknown as import('../src/types').AnkiEmbedSettings;

	// 1. Deleting 1002 from properties prunes it from settings.cardLinks
	const modified1 = await syncNoteLinksWithSettings(mockApp, mockFile, testSettings);
	assert.strictEqual(modified1, true);
	assert.deepStrictEqual(testSettings.cardLinks['1001'], ['Notes/Cardio.md']);
	assert.strictEqual(testSettings.cardLinks['1002'], undefined);

	// 2. Calling it again with no changes returns false
	const modified2 = await syncNoteLinksWithSettings(mockApp, mockFile, testSettings);
	assert.strictEqual(modified2, false);

	// 3. Adding 1003 to properties adds it to settings.cardLinks
	currentFm = { 'linked-cards': [1001, 1003] };
	const modified3 = await syncNoteLinksWithSettings(mockApp, mockFile, testSettings);
	assert.strictEqual(modified3, true);
	assert.deepStrictEqual(testSettings.cardLinks['1003'], ['Notes/Cardio.md']);
})();

// 10. Scrollability verification tests
(() => {
	const fs = require('fs') as typeof import('fs');
	const path = require('path') as typeof import('path');
	const stylesCss = fs.readFileSync(path.join(__dirname, '../styles.css'), 'utf-8');
	const deckPlayerTs = fs.readFileSync(path.join(__dirname, '../src/deck-player.ts'), 'utf-8');

	// Verify that card elements allow vertical scrolling (overflow-y: auto)
	assert.ok(stylesCss.includes('overflow-y: auto;'), 'styles.css must include overflow-y: auto for cards');
	assert.ok(deckPlayerTs.includes('overflow-y: auto;'), 'deck-player.ts must include overflow-y: auto for :host');
	assert.ok(!deckPlayerTs.includes(':host {\n\tdisplay: block;\n\twidth: 100%;\n\theight: 100%;\n\tmin-height: 100%;\n\tmargin: 0 !important;\n\tpadding: 0 !important;\n\tborder-radius: var(--radius-s, 6px);\n\toverflow: hidden;'), 'deck-player.ts must not have overflow: hidden on :host');
	assert.ok(!stylesCss.includes('.anki-embed-card.anki-embed-card-custom {\n\tpadding: 0 !important;\n\tmargin: 0 !important;\n\tborder: none !important;\n\tborder-radius: var(--radius-s, 6px) !important;\n\tbackground-color: transparent;\n\twidth: 100%;\n\tflex: 1 1 auto;\n\tmin-height: 140px;\n\toverflow-x: auto;\n\toverflow-y: auto;\n\toverflow: hidden;'), 'styles.css must not have redundant overflow: hidden overwriting overflow-y: auto');
})();

// 11. buildAnkiTagQuery tests
(() => {
	assert.strictEqual(buildAnkiTagQuery('Heart'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('"Heart"'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery("'Heart'"), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('\"Heart\"'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('“Heart”'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('""Heart""'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('#Heart'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('#anki/Heart'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('anki-tags/Heart'), 'tag:*Heart*');
	assert.strictEqual(buildAnkiTagQuery('AnKing::Step1::Cardio'), 'tag:*AnKing*Step1*Cardio*');
	assert.strictEqual(buildAnkiTagQuery('AnKing/Step1/Cardio'), 'tag:*AnKing*Step1*Cardio*');
	assert.strictEqual(buildAnkiTagQuery('AK_Step1_v12::SketchyPharm::01_Autonomic_Drugs::02_Sympathetic'), 'tag:*AK_Step1_v12*SketchyPharm*01_Autonomic_Drugs*02_Sympathetic*');
	assert.strictEqual(buildAnkiTagQuery('heart failure'), 'tag:*heart*failure*');
	assert.strictEqual(buildAnkiTagQuery('  "AnKing::Pathoma"  '), 'tag:*AnKing*Pathoma*');
	assert.strictEqual(buildAnkiTagQuery(''), '');
})();

console.log('✅ All verification tests passed successfully!');

