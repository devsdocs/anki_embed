export interface AnkiEmbedSettings {
	ankiConnectUrl: string;
	apiKey: string;
	defaultLimit: number;
	defaultFilter: 'all' | 'due' | 'new';
	randomizeCards: boolean;
	minCardHeight: string;
}

export const DEFAULT_SETTINGS: AnkiEmbedSettings = {
	ankiConnectUrl: 'http://127.0.0.1:8765',
	apiKey: '',
	defaultLimit: 20,
	defaultFilter: 'all',
	randomizeCards: true,
	minCardHeight: '280px',
};

export interface DeckEmbedConfig {
	deck?: string;
	query?: string;
	limit?: number;
	filter?: 'all' | 'due' | 'new';
	randomize?: boolean;
}

export interface AnkiCardField {
	value: string;
	order: number;
}

export interface AnkiCardInfo {
	cardId: number;
	fields: Record<string, AnkiCardField>;
	question: string;
	answer: string;
	deckName: string;
	modelName: string;
	due?: number;
	interval?: number;
	lapses?: number;
	reviews?: number;
	queue?: number;
	type?: number;
	left?: number;
	mod?: number;
	note?: number;
}

export interface AnkiNoteMedia {
	url?: string;
	path?: string;
	data?: string;
	filename: string;
	skipHash?: string;
	fields: string[];
}

export interface AnkiNoteParam {
	deckName: string;
	modelName: string;
	fields: Record<string, string>;
	options?: {
		allowDuplicate?: boolean;
		duplicateScope?: string;
		duplicateScopeOptions?: {
			deckName?: string;
			checkChildren?: boolean;
			checkAllModels?: boolean;
		};
	};
	tags?: string[];
	audio?: AnkiNoteMedia[];
	video?: AnkiNoteMedia[];
	picture?: AnkiNoteMedia[];
}

export interface AnkiNoteInfo {
	noteId: number;
	profile: string;
	modelName: string;
	tags: string[];
	fields: Record<string, AnkiCardField>;
	cards: number[];
}

export interface AnkiDeckStats {
	deck_id: number;
	name: string;
	new_count: number;
	learn_count: number;
	review_count: number;
	total_in_deck: number;
}

export interface AnkiAnswerParam {
	cardId: number;
	ease: 1 | 2 | 3 | 4;
}

export interface AnkiPermissionResult {
	permission: 'granted' | 'denied';
}

export interface AnkiResponse<T> {
	result: T | null;
	error: string | null;
}

