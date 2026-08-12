import assert from 'assert';
import { parseDeckConfig, parsePastedAnkiText } from '../src/parser';
import { AnkiClient } from '../src/anki-client';

console.log('Running Anki Embed verification tests...');

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

// 4. Test parsePastedAnkiText
const paste1 = parsePastedAnkiText('anki://deck/Japanese%20Kanji');
assert.deepStrictEqual(paste1, { deckName: 'Japanese Kanji' });

const paste2 = parsePastedAnkiText('anki:Default');
assert.deepStrictEqual(paste2, { deckName: 'Default' });

const pasteInvalid = parsePastedAnkiText('https://google.com');
assert.strictEqual(pasteInvalid, null);

// 5. Test AnkiClient payload construction & endpoint coverage
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
assert.strictEqual(typeof client.storeMediaFile, 'function');
assert.strictEqual(typeof client.getMediaFilesNames, 'function');
assert.strictEqual(typeof client.sync, 'function');

console.log('✅ All verification tests passed successfully!');

