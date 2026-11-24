import assert from 'assert';
import { parseDeckConfig, parsePastedAnkiText } from '../src/parser';
import { AnkiClient } from '../src/anki-client';
import { extractAnswerHtml, formatCardHtml, isClozeCard, normalizeAnkiCss } from '../src/card-html';
import { DEFAULT_SETTINGS, VIEW_TYPE_ANKI_EMBED } from '../src/types';

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
assert.strictEqual(typeof client.storeMediaFile, 'function');
assert.strictEqual(typeof client.retrieveMediaFile, 'function');
assert.strictEqual(typeof client.getMediaFilesNames, 'function');
assert.strictEqual(typeof client.sync, 'function');

// 7. Test DeckEmbedConfig reset state
const resetConfig = { ...config1, select: true, deck: undefined, query: undefined };
assert.strictEqual(resetConfig.select, true);
assert.strictEqual(resetConfig.deck, undefined);
assert.strictEqual(resetConfig.query, undefined);

// 8. Test DEFAULT_SETTINGS includes useCardStyles: true, liveSync: false, excludeSuspended: true, cardOrder: 'reviews-first', showCardCounts: true, showHeatmap: true, enableCardTimer: false, timerWarningSeconds: 5, timerLimitSeconds: 10
assert.strictEqual(DEFAULT_SETTINGS.useCardStyles, true);
assert.strictEqual(DEFAULT_SETTINGS.liveSync, false);
assert.strictEqual(DEFAULT_SETTINGS.excludeSuspended, true);
assert.strictEqual(DEFAULT_SETTINGS.cardOrder, 'reviews-first');
assert.strictEqual(DEFAULT_SETTINGS.showCardCounts, true);
assert.strictEqual(DEFAULT_SETTINGS.showHeatmap, true);
assert.strictEqual(DEFAULT_SETTINGS.enableCardTimer, false);
assert.strictEqual(DEFAULT_SETTINGS.timerWarningSeconds, 5);
assert.strictEqual(DEFAULT_SETTINGS.timerLimitSeconds, 10);

console.log('✅ All verification tests passed successfully!');

