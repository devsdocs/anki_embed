import { requestUrl } from 'obsidian';
import { deckSearchTerm } from './card-html';
import {
	AnkiAnswerParam,
	AnkiCardInfo,
	AnkiDeckStats,
	AnkiNoteInfo,
	AnkiNoteMedia,
	AnkiNoteParam,
	AnkiPermissionResult,
	AnkiResponse,
} from './types';

export class AnkiClient {
	private url: string;
	private apiKey: string;

	constructor(url: string = 'http://127.0.0.1:8765', apiKey: string = '') {
		this.url = url.trim().replace(/\/+$/, '');
		this.apiKey = apiKey.trim();
	}

	public setConfig(url: string, apiKey: string) {
		this.url = url.trim().replace(/\/+$/, '');
		this.apiKey = apiKey.trim();
	}

	public async request<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
		const payload: Record<string, unknown> = {
			action,
			version: 6,
			params,
		};

		if (this.apiKey) {
			payload['key'] = this.apiKey;
		}

		try {
			let responseData: AnkiResponse<T>;

			if (typeof requestUrl === 'function') {
				const res = await requestUrl({
					url: this.url,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
					throw: false,
				});

				if (res.status !== 200) {
					throw new Error(`AnkiConnect returned HTTP status ${res.status}`);
				}
				responseData = res.json as AnkiResponse<T>;
			} else {
				const win = typeof window !== 'undefined' ? window : null;
				const globalFetch = win ? (win as unknown as Record<string, unknown>)['fetch'] as (
					url: string,
					init?: unknown
				) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> : null;
				if (!globalFetch) {
					throw new Error('Network request failed: requestUrl is not available');
				}
				const res = await globalFetch(this.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(payload),
				});

				if (!res.ok) {
					throw new Error(`AnkiConnect returned HTTP status ${res.status}`);
				}
				responseData = (await res.json()) as AnkiResponse<T>;
			}

			if (responseData.error) {
				throw new Error(`AnkiConnect Error: ${responseData.error}`);
			}

			return responseData.result as T;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('Failed to fetch') || msg.includes('ECONNREFUSED') || msg.includes('requestUrl')) {
				throw new Error(`Could not connect to Anki at ${this.url}. Please ensure Anki is running with the AnkiConnect add-on enabled.`);
			}
			throw err;
		}
	}

	// --- System & Sync Endpoints ---

	public async testConnection(): Promise<number> {
		return await this.request<number>('version');
	}

	public async requestPermission(): Promise<AnkiPermissionResult> {
		return await this.request<AnkiPermissionResult>('requestPermission');
	}

	public async sync(): Promise<null> {
		return await this.request<null>('sync');
	}

	public async getProfiles(): Promise<string[]> {
		return await this.request<string[]>('getProfiles');
	}

	public async selectProfile(name: string): Promise<boolean> {
		return await this.request<boolean>('selectProfile', { name });
	}

	// --- Deck Endpoints ---

	public async getDeckNames(): Promise<string[]> {
		return await this.request<string[]>('deckNames');
	}

	public async getDeckNamesAndIds(): Promise<Record<string, number>> {
		return await this.request<Record<string, number>>('deckNamesAndIds');
	}

	public async getDeckStats(decks: string[]): Promise<Record<string, AnkiDeckStats>> {
		return await this.request<Record<string, AnkiDeckStats>>('getDeckStats', { decks });
	}

	public async createDeck(deck: string): Promise<number> {
		return await this.request<number>('createDeck', { deck });
	}

	public async deleteDecks(decks: string[], cardsToo: boolean = true): Promise<null> {
		return await this.request<null>('deleteDecks', { decks, cardsToo });
	}

	public async changeDeck(cards: number[], deck: string): Promise<null> {
		return await this.request<null>('changeDeck', { cards, deck });
	}

	// --- Card Endpoints ---

	public async findCards(query: string): Promise<number[]> {
		return await this.request<number[]>('findCards', { query });
	}

	/**
	 * The deck Anki desktop currently has open: the one its overview ("Study Now") screen and
	 * reviewer use. AnkiConnect has no action for this, so it is derived from Anki's
	 * `deck:current` search, which matches the open deck and its subdecks. Returns null when it
	 * can't be determined (for example when that deck has no cards).
	 */
	public async getCurrentDeckName(): Promise<string | null> {
		const ids = await this.findCards('deck:current');
		const firstId = ids[0];
		if (firstId === undefined) return null;
		const [info] = await this.getCardsInfo([firstId]);
		const cardDeck = info?.deckName;
		if (!cardDeck) return null;

		// The open deck is this card's deck or one of its parents: the deepest one that
		// still contains every card in deck:current.
		const parts = cardDeck.split('::');
		let current: string | null = null;
		for (let i = 1; i <= parts.length; i++) {
			const candidate = parts.slice(0, i).join('::');
			const outside = await this.findCards(`deck:current -${deckSearchTerm(candidate)}`);
			if (outside.length > 0) break;
			current = candidate;
		}
		return current;
	}

	/**
	 * A card's tags. Tags belong to the card's note, and AnkiConnect's cardsInfo doesn't include
	 * them, so this looks up the note. Null if the card doesn't exist.
	 */
	public async getCardTags(cardId: number): Promise<string[] | null> {
		const [info] = await this.getCardsInfo([cardId]);
		if (!info?.note) return null;
		const [note] = await this.getNotesInfo([info.note]);
		return note?.tags ?? null;
	}

	public async getCardsInfo(cards: number[]): Promise<AnkiCardInfo[]> {
		if (cards.length === 0) return [];
		return await this.request<AnkiCardInfo[]>('cardsInfo', { cards });
	}

	public async answerCards(answers: AnkiAnswerParam[]): Promise<boolean[]> {
		return await this.request<boolean[]>('answerCards', { answers });
	}

	/**
	 * Record an answer for this card in Anki's scheduler. Throws if Anki didn't record it. There is
	 * deliberately no fallback to guiAnswerCard: that grades whatever card Anki's reviewer is
	 * showing, which may be a different card.
	 */
	public async answerCard(cardId: number, ease: 1 | 2 | 3 | 4, time?: number): Promise<void> {
		const res = await this.answerCards([{ cardId, ease, time }]);
		if (!Array.isArray(res) || res[0] !== true) {
			throw new Error(`Anki didn't record the answer for card ${cardId}`);
		}
	}

	public async forgetCards(cards: number[]): Promise<boolean> {
		return await this.request<boolean>('forgetCards', { cards });
	}

	public async relearnCards(cards: number[]): Promise<boolean> {
		return await this.request<boolean>('relearnCards', { cards });
	}

	public async suspendCards(cards: number[]): Promise<boolean> {
		return await this.request<boolean>('suspend', { cards });
	}

	public async buryCards(cards: number[]): Promise<boolean> {
		return await this.request<boolean>('buryCards', { cards });
	}

	public async unsuspendCards(cards: number[]): Promise<boolean> {
		return await this.request<boolean>('unsuspend', { cards });
	}

	public async setSpecificValueOfCard(card: number, keys: string[], newValues: unknown[], warning_check: boolean = true): Promise<boolean> {
		return await this.request<boolean>('setSpecificValueOfCard', { card, keys, newValues, warning_check });
	}

	public async areSuspended(cards: number[]): Promise<boolean[]> {
		return await this.request<boolean[]>('areSuspended', { cards });
	}

	public async areDue(cards: number[]): Promise<boolean[]> {
		return await this.request<boolean[]>('areDue', { cards });
	}

	public async getIntervals(cards: number[], complete: boolean = false): Promise<number[] | number[][]> {
		return await this.request<number[] | number[][]>('getIntervals', { cards, complete });
	}

	// --- Note Endpoints ---

	public async addNote(note: AnkiNoteParam): Promise<number> {
		return await this.request<number>('addNote', { note });
	}

	public async addNotes(notes: AnkiNoteParam[]): Promise<(number | null)[]> {
		return await this.request<(number | null)[]>('addNotes', { notes });
	}

	public async canAddNotes(notes: AnkiNoteParam[]): Promise<boolean[]> {
		return await this.request<boolean[]>('canAddNotes', { notes });
	}

	public async updateNoteFields(note: { id: number; fields: Record<string, string>; audio?: AnkiNoteMedia[] }): Promise<null> {
		return await this.request<null>('updateNoteFields', { note });
	}

	public async findNotes(query: string): Promise<number[]> {
		return await this.request<number[]>('findNotes', { query });
	}

	public async getNotesInfo(notes: number[]): Promise<AnkiNoteInfo[]> {
		if (notes.length === 0) return [];
		return await this.request<AnkiNoteInfo[]>('notesInfo', { notes });
	}

	public async deleteNotes(notes: number[]): Promise<null> {
		return await this.request<null>('deleteNotes', { notes });
	}

	public async addTags(notes: number[], tags: string): Promise<null> {
		return await this.request<null>('addTags', { notes, tags });
	}

	public async removeTags(notes: number[], tags: string): Promise<null> {
		return await this.request<null>('removeTags', { notes, tags });
	}

	public async getTags(): Promise<string[]> {
		return await this.request<string[]>('getTags');
	}

	// --- Model (Note Type) Endpoints ---

	public async getModelNames(): Promise<string[]> {
		return await this.request<string[]>('modelNames');
	}

	public async getModelNamesAndIds(): Promise<Record<string, number>> {
		return await this.request<Record<string, number>>('modelNamesAndIds');
	}

	public async getModelFieldNames(modelName: string): Promise<string[]> {
		return await this.request<string[]>('modelFieldNames', { modelName });
	}

	public async getModelStyling(modelName: string): Promise<Record<string, string>> {
		return await this.request<Record<string, string>>('modelStyling', { modelName });
	}

	public async getModelTemplates(modelName: string): Promise<Record<string, Record<string, string>>> {
		return await this.request<Record<string, Record<string, string>>>('modelTemplates', { modelName });
	}

	// --- Stats & Review Endpoints ---

	public async getNumCardsReviewedToday(): Promise<number> {
		return await this.request<number>('getNumCardsReviewedToday');
	}

	public async getNumCardsReviewedByDay(): Promise<[string, number][]> {
		return await this.request<[string, number][]>('getNumCardsReviewedByDay');
	}

	public async getCollectionStatsHTML(): Promise<string> {
		return await this.request<string>('getCollectionStatsHTML');
	}

	// --- GUI Endpoints ---

	public async guiBrowse(query: string = ''): Promise<number[]> {
		return await this.request<number[]>('guiBrowse', { query });
	}

	public async guiEditNote(noteId: number): Promise<boolean> {
		return await this.request<boolean>('guiEditNote', { note: noteId });
	}

	public async guiAddCards(): Promise<boolean> {
		return await this.request<boolean>('guiAddCards');
	}

	public async guiDeckOverview(name: string): Promise<boolean> {
		return await this.request<boolean>('guiDeckOverview', { name });
	}

	public async guiDeckBrowser(): Promise<boolean> {
		return await this.request<boolean>('guiDeckBrowser');
	}

	public async guiDeckReview(name: string): Promise<boolean> {
		try {
			return await this.request<boolean>('guiDeckReview', { name });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				return false;
			}
			throw err;
		}
	}

	public async guiUndo(): Promise<boolean> {
		try {
			return await this.request<boolean>('guiUndo');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				return false;
			}
			throw err;
		}
	}

	public async guiCurrentCard(): Promise<AnkiCardInfo | null> {
		try {
			return await this.request<AnkiCardInfo | null>('guiCurrentCard');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				return null;
			}
			throw err;
		}
	}

	public async guiShowQuestion(): Promise<boolean> {
		try {
			return await this.request<boolean>('guiShowQuestion');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				return false;
			}
			throw err;
		}
	}

	public async guiShowAnswer(): Promise<boolean> {
		try {
			return await this.request<boolean>('guiShowAnswer');
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				return false;
			}
			throw err;
		}
	}

	public async guiAnswerCard(ease: 1 | 2 | 3 | 4): Promise<boolean> {
		try {
			return await this.request<boolean>('guiAnswerCard', { ease });
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				return false;
			}
			throw err;
		}
	}

	public async multi<T extends unknown[]>(actions: Array<{ action: string; params?: Record<string, unknown> }>): Promise<T> {
		return await this.request<T>('multi', { actions });
	}

	public async guiAnswerAndCurrentCard(ease: 1 | 2 | 3 | 4): Promise<AnkiCardInfo | null> {
		try {
			const res = await this.multi<[boolean, AnkiCardInfo | null]>([
				{ action: 'guiAnswerCard', params: { ease } },
				{ action: 'guiCurrentCard' },
			]);
			return res?.[1] ?? null;
		} catch {
			await this.guiAnswerCard(ease);
			return await this.guiCurrentCard();
		}
	}

	public async guiUndoAndCurrentCard(): Promise<AnkiCardInfo | null> {
		try {
			const res = await this.multi<[boolean, AnkiCardInfo | null]>([
				{ action: 'guiUndo' },
				{ action: 'guiCurrentCard' },
			]);
			return res?.[1] ?? null;
		} catch {
			await this.guiUndo();
			return await this.guiCurrentCard();
		}
	}

	// --- Media Endpoints ---

	public async storeMediaFile(filename: string, options: { data?: string; path?: string; url?: string; deleteExisting?: boolean }): Promise<string> {
		return await this.request<string>('storeMediaFile', { filename, ...options });
	}

	public async retrieveMediaFile(filename: string): Promise<string | false> {
		return await this.request<string | false>('retrieveMediaFile', { filename });
	}

	public async deleteMediaFile(filename: string): Promise<null> {
		return await this.request<null>('deleteMediaFile', { filename });
	}

	public async getMediaFilesNames(pattern: string = '*'): Promise<string[]> {
		return await this.request<string[]>('getMediaFilesNames', { pattern });
	}
}
