import type { App, TFile } from 'obsidian';
import {
	extractCardIdsFromText,
	extractLinkedCardIdsFromFrontmatter,
	matchesCardId,
} from './card-html';
import type { AnkiEmbedSettings } from './types';

/**
 * Synchronizes settings.cardLinks with the note's frontmatter properties.
 * If any card IDs were previously recorded in settings.cardLinks for this file
 * but are no longer present in the note's frontmatter properties (and not in note body backlinks),
 * they are automatically pruned.
 * If frontmatter contains new linked-card IDs, settings.cardLinks is updated to include them.
 * Returns true if settings were modified.
 */
export async function syncNoteLinksWithSettings(
	app: App,
	file: TFile,
	settings: AnkiEmbedSettings,
	saveSettings?: (s: AnkiEmbedSettings) => Promise<void>
): Promise<boolean> {
	if (!settings.cardLinks) return false;

	const cache = app.metadataCache.getFileCache(file);
	const fm = cache?.frontmatter;
	const targetKeys = [
		'linked-cards',
		'linked-card',
		'linkedCards',
		'linkedCard',
		'linked_cards',
		'linked_card',
		'anki-cards',
		'anki-card-id',
		'anki-card',
		'cardId',
		'card-id',
		'card',
		'cid',
		'ankiCards',
		'ankiCardId',
	];

	const hasPropertyKeys = fm ? targetKeys.some((k) => fm[k] !== undefined) : false;
	const existingCardIdsForFile: number[] = [];
	for (const [cardIdStr, paths] of Object.entries(settings.cardLinks)) {
		if (Array.isArray(paths) && paths.includes(file.path)) {
			const num = Number.parseInt(cardIdStr, 10);
			if (!Number.isNaN(num) && num > 0) {
				existingCardIdsForFile.push(num);
			}
		}
	}

	// If neither settings nor frontmatter have links for this file, nothing to do
	if (existingCardIdsForFile.length === 0 && !hasPropertyKeys) {
		return false;
	}

	const fmCardIds = new Set<number>(extractLinkedCardIdsFromFrontmatter(fm));
	let modified = false;

	// 1. If cards were in settings.cardLinks for this file, but removed from frontmatter
	if (existingCardIdsForFile.length > 0) {
		let textCardIds: number[] | null = null;
		for (const num of existingCardIdsForFile) {
			if (!fmCardIds.has(num)) {
				// Lazily read text to see if there is still a markdown backlink or codeblock
				if (textCardIds === null) {
					try {
						const content = await app.vault.cachedRead(file);
						textCardIds = extractCardIdsFromText(content);
					} catch {
						textCardIds = [];
					}
				}

				if (!textCardIds.includes(num)) {
					const cardIdStr = String(num);
					const currentPaths = settings.cardLinks[cardIdStr];
					if (currentPaths) {
						const filtered = currentPaths.filter((p) => p !== file.path);
						if (filtered.length > 0) {
							settings.cardLinks[cardIdStr] = filtered;
						} else {
							delete settings.cardLinks[cardIdStr];
						}
						modified = true;
					}
				}
			}
		}
	}

	// 2. If frontmatter has linked cards not yet in settings.cardLinks, register them
	for (const num of fmCardIds) {
		const cardIdStr = String(num);
		const links = settings.cardLinks[cardIdStr] ?? [];
		if (!links.includes(file.path)) {
			links.push(file.path);
			settings.cardLinks[cardIdStr] = links;
			modified = true;
		}
	}

	if (modified && saveSettings) {
		await saveSettings(settings);
	}

	return modified;
}

/**
 * Discovers all Anki card IDs associated with a given markdown note:
 * 1. From note frontmatter (e.g. linked-cards, anki-cards, anki-card-id, etc.)
 * 2. From plugin settings cardLinks mapping
 * 3. From note content backlinks (obsidian://anki-card?cardId=... or ```anki codeblocks)
 */
export async function getLinkedCardIdsForNote(
	app: App,
	file: TFile,
	settings?: AnkiEmbedSettings,
	saveSettings?: (s: AnkiEmbedSettings) => Promise<void>
): Promise<number[]> {
	if (settings) {
		await syncNoteLinksWithSettings(app, file, settings, saveSettings);
	}
	const cardIds = new Set<number>();
	const cache = app.metadataCache.getFileCache(file);
	if (cache?.frontmatter) {
		for (const id of extractLinkedCardIdsFromFrontmatter(cache.frontmatter)) {
			cardIds.add(id);
		}
	}

	if (settings?.cardLinks) {
		for (const [cardIdStr, paths] of Object.entries(settings.cardLinks)) {
			if (Array.isArray(paths) && paths.includes(file.path)) {
				const num = Number.parseInt(cardIdStr, 10);
				if (!Number.isNaN(num) && num > 0) {
					cardIds.add(num);
				}
			}
		}
	}

	try {
		const content = await app.vault.cachedRead(file);
		for (const id of extractCardIdsFromText(content)) {
			cardIds.add(id);
		}
	} catch {
		// Ignore read error
	}

	return Array.from(cardIds);
}

/**
 * Links an Anki card to a note by recording it in settings.cardLinks
 * and adding it to note frontmatter properties (linked-cards / anki-cards).
 */
export async function linkCardToNote(
	app: App | undefined,
	file: TFile,
	cardId: number,
	settings: AnkiEmbedSettings,
	saveSettings?: (s: AnkiEmbedSettings) => Promise<void>
): Promise<void> {
	const cardIdStr = String(cardId);
	if (!settings.cardLinks) {
		settings.cardLinks = {};
	}
	const links = settings.cardLinks[cardIdStr] ?? [];
	if (!links.includes(file.path)) {
		links.push(file.path);
		settings.cardLinks[cardIdStr] = links;
		if (saveSettings) {
			await saveSettings(settings);
		}
	}

	if (app) {
		try {
			await app.fileManager.processFrontMatter(file, (fmData: Record<string, unknown>) => {
				const targetKey = fmData['anki-cards'] !== undefined ? 'anki-cards' : 'linked-cards';
				const existing = fmData[targetKey];
				const currentIds = extractLinkedCardIdsFromFrontmatter({ [targetKey]: existing });
				if (!currentIds.includes(cardId)) {
					currentIds.push(cardId);
				}
				// Obsidian's list property type is multitext (list of strings).
				// Storing as strings avoids Obsidian's "Your unknown data is not compatible" dialog.
				fmData[targetKey] = currentIds.map(String);
			});
		} catch (err) {
			console.warn('Failed to update frontmatter properties for linked card:', err);
		}
	}
}

/**
 * Unlinks an Anki card from a note by removing it from settings.cardLinks
 * and stripping it from note frontmatter properties.
 */
export async function unlinkCardFromNote(
	app: App | undefined,
	file: TFile,
	cardId: number,
	settings: AnkiEmbedSettings,
	saveSettings?: (s: AnkiEmbedSettings) => Promise<void>
): Promise<void> {
	const cardIdStr = String(cardId);
	let settingsModified = false;
	if (settings.cardLinks?.[cardIdStr]) {
		settings.cardLinks[cardIdStr] = settings.cardLinks[cardIdStr].filter((p) => p !== file.path);
		if (settings.cardLinks[cardIdStr].length === 0) {
			delete settings.cardLinks[cardIdStr];
		}
		settingsModified = true;
	}
	if (settingsModified && saveSettings) {
		await saveSettings(settings);
	}

	if (app) {
		const cache = app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const targetKeys = ['linked-cards', 'linked_cards', 'linked-card', 'linked_card', 'anki-cards', 'anki-card-id', 'anki-card'];
		if (fm && targetKeys.some((k) => fm[k] !== undefined)) {
			try {
				await app.fileManager.processFrontMatter(file, (fmData: Record<string, unknown>) => {
					for (const key of ['linked-cards', 'linked_cards', 'linked-card', 'linked_card', 'anki-cards']) {
						if (fmData[key] !== undefined) {
							const currentIds = extractLinkedCardIdsFromFrontmatter({ [key]: fmData[key] });
							const filtered = currentIds.filter((id) => id !== cardId);
							if (filtered.length > 0) {
								fmData[key] = filtered.map(String);
							} else {
								delete fmData[key];
							}
						}
					}
					if (matchesCardId(fmData['anki-card-id'], cardIdStr)) {
						delete fmData['anki-card-id'];
					}
					if (matchesCardId(fmData['anki-card'], cardIdStr)) {
						delete fmData['anki-card'];
					}
				});
			} catch {
				// Frontmatter cleanup is best effort
			}
		}
	}
}

/**
 * Unlinks all provided card IDs from a note.
 */
export async function unlinkAllCardsFromNote(
	app: App,
	file: TFile,
	cardIds: number[],
	settings: AnkiEmbedSettings,
	saveSettings?: (s: AnkiEmbedSettings) => Promise<void>
): Promise<void> {
	for (const cardId of cardIds) {
		await unlinkCardFromNote(app, file, cardId, settings, saveSettings);
	}
}

/**
 * Links an Anki tag to a note frontmatter (anki-tags property).
 */
export async function linkTagToNote(app: App | undefined, file: TFile, tag: string): Promise<void> {
	if (!app) return;
	await app.fileManager.processFrontMatter(file, (fmData: Record<string, unknown>) => {
		const existing = fmData['anki-tags'] ?? fmData['anki-tag'] ?? fmData['anki_tags'] ?? fmData['anki_tag'];
		if (Array.isArray(existing)) {
			if (!existing.includes(tag)) {
				existing.push(tag);
				fmData['anki-tags'] = existing;
			}
		} else if (typeof existing === 'string') {
			if (existing !== tag) {
				fmData['anki-tags'] = [existing, tag];
				delete fmData['anki-tag'];
				delete fmData['anki_tag'];
			}
		} else {
			fmData['anki-tag'] = tag;
		}
	});
}
