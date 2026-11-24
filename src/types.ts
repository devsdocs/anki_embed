export type AnkiCardFilter = 'all' | 'due' | 'new' | 'due+new';
export type AnkiCardOrder = 'reviews-first' | 'random' | 'default';

export type RemoteAction =
	| 'flip_or_good'
	| 'flip_or_easy'
	| 'flip_or_hard'
	| 'flip_or_again'
	| 'again'
	| 'hard'
	| 'good'
	| 'easy'
	| 'flip'
	| 'undo'
	| 'suspend'
	| 'bury'
	| 'flag'
	| 'append_card_note'
	| 'create_card_note'
	| 'toggle_timer'
	| 'link_active_note'
	| 'unlink_active_note'
	| 'search_link_note'
	| 'create_link_note'
	| 'open_links_menu'
	| 'open_anki_browser'
	| 'sync_anki'
	| 'refresh_cards'
	| 'deck_picker'
	| 'none';

export const REMOTE_ACTION_LABELS: Record<RemoteAction, string> = {
	flip_or_good: 'Flip / Rate Good',
	flip_or_easy: 'Flip / Rate Easy',
	flip_or_hard: 'Flip / Rate Hard',
	flip_or_again: 'Flip / Rate Again',
	again: 'Rate Again (1)',
	hard: 'Rate Hard (2)',
	good: 'Rate Good (3)',
	easy: 'Rate Easy (4)',
	flip: 'Flip card / Reveal answer',
	undo: 'Undo last review',
	suspend: 'Suspend card',
	bury: 'Bury card',
	flag: 'Toggle flag (Red)',
	append_card_note: 'Append card Q&A to daily or target note',
	create_card_note: 'Create new note from card',
	toggle_timer: 'Pause / Resume timer',
	link_active_note: 'Link active note to card',
	unlink_active_note: 'Unlink active note from card',
	search_link_note: 'Search vault and link note',
	create_link_note: 'Create note from card and link',
	open_links_menu: 'Open linked notes menu',
	open_anki_browser: 'Open card in Anki desktop browser',
	sync_anki: 'Sync with AnkiWeb',
	refresh_cards: 'Refresh cards from Anki',
	deck_picker: 'Back to deck selection',
	none: 'Disabled / None',
};

export const GAMEPAD_BUTTON_NAMES: Record<number, string> = {
	0: 'Button 0 (A / Cross / South)',
	1: 'Button 1 (B / Circle / East)',
	2: 'Button 2 (X / Square / West)',
	3: 'Button 3 (Y / Triangle / North)',
	4: 'Button 4 (L1 / LB / Shoulder)',
	5: 'Button 5 (R1 / RB / Shoulder)',
	6: 'Button 6 (L2 / LT / Trigger)',
	7: 'Button 7 (R2 / RT / Trigger)',
	8: 'Button 8 (Select / Back / Share)',
	9: 'Button 9 (Start / Options / Menu)',
	10: 'Button 10 (L3 / Left Stick Click)',
	11: 'Button 11 (R3 / Right Stick Click)',
	12: 'Button 12 (D-Pad Up)',
	13: 'Button 13 (D-Pad Down)',
	14: 'Button 14 (D-Pad Left)',
	15: 'Button 15 (D-Pad Right)',
	16: 'Button 16 (Home / Guide)',
};

export const DEFAULT_GAMEPAD_MAPPING: Record<number, RemoteAction> = {
	0: 'flip_or_good',
	1: 'flip_or_easy',
	2: 'flip_or_hard',
	3: 'flip_or_again',
	4: 'undo',
	5: 'flip_or_good',
	6: 'suspend',
	7: 'bury',
	8: 'undo',
	9: 'suspend',
	10: 'append_card_note',
	11: 'create_card_note',
	12: 'flag',
	13: 'undo',
	14: 'flip_or_again',
	15: 'flip_or_good',
};

export const DEFAULT_KEYBOARD_MAPPING: Record<string, RemoteAction> = {
	' ': 'flip_or_good',
	'Enter': 'flip_or_good',
	'1': 'again',
	'2': 'hard',
	'3': 'good',
	'4': 'easy',
	'j': 'flip_or_again',
	'k': 'flip_or_hard',
	'l': 'flip_or_good',
	';': 'flip_or_easy',
	'z': 'undo',
	'u': 'undo',
	's': 'suspend',
	'@': 'suspend',
	'!': 'suspend',
	'b': 'bury',
	'-': 'bury',
	'f': 'flag',
	'*': 'flag',
	'c': 'create_card_note',
	'a': 'append_card_note',
};

export type AnkiAppendTarget = 'daily' | 'custom';

export interface AnkiEmbedSettings {
	ankiConnectUrl: string;
	apiKey: string;
	defaultLimit: number;
	defaultFilter: AnkiCardFilter;
	randomizeCards: boolean;
	minCardHeight: string;
	useCustomAnkiConnect: boolean;
	useCardStyles: boolean;
	liveSync: boolean;
	excludeSuspended: boolean;
	cardOrder: AnkiCardOrder;
	showCardCounts: boolean;
	showHeatmap: boolean;
	enableCardTimer: boolean;
	timerWarningSeconds: number;
	timerLimitSeconds: number;
	enableRatingFlash: boolean;
	ratingFlashDurationMs: number;
	ratingFlashTransitionMs: number;
	cardAppendTarget: AnkiAppendTarget;
	cardAppendCustomPath: string;
	cardAppendHeading: string;
	cardFontScale: number;
	enableGamepad: boolean;
	gamepadMapping: Record<number, RemoteAction>;
	keyboardMapping: Record<string, RemoteAction>;
	cardLinks: Record<string, string[]>;
	enableCardLinks: boolean;
	enableBacklinks: boolean;
}

export const DEFAULT_SETTINGS: AnkiEmbedSettings = {
	ankiConnectUrl: 'http://127.0.0.1:8765',
	apiKey: '',
	defaultLimit: 20,
	defaultFilter: 'all',
	randomizeCards: true,
	minCardHeight: '280px',
	useCustomAnkiConnect: false,
	useCardStyles: true,
	liveSync: false,
	excludeSuspended: true,
	cardOrder: 'reviews-first',
	showCardCounts: true,
	showHeatmap: true,
	enableCardTimer: false,
	timerWarningSeconds: 5,
	timerLimitSeconds: 10,
	enableRatingFlash: true,
	ratingFlashDurationMs: 25,
	ratingFlashTransitionMs: 20,
	cardAppendTarget: 'daily',
	cardAppendCustomPath: 'Anki Notes.md',
	cardAppendHeading: '## Anki Reviews',
	cardFontScale: 1.0,
	enableGamepad: true,
	gamepadMapping: DEFAULT_GAMEPAD_MAPPING,
	keyboardMapping: DEFAULT_KEYBOARD_MAPPING,
	cardLinks: {},
	enableCardLinks: true,
	enableBacklinks: true,
};

export const VIEW_TYPE_ANKI_EMBED = 'anki-embed-view';

export interface DeckEmbedConfig {
	card?: number;
	cardId?: number;
	deck?: string;
	query?: string;
	limit?: number;
	filter?: AnkiCardFilter;
	randomize?: boolean;
	select?: boolean;
	styles?: boolean;
	live?: boolean;
	excludeSuspended?: boolean;
	order?: AnkiCardOrder;
	counts?: boolean;
	heatmap?: boolean;
	timer?: boolean;
	timerWarning?: number;
	timerLimit?: number;
	flash?: boolean;
	flashDuration?: number;
	flashTransition?: number;
	remote?: boolean;
	fontScale?: number;
	scale?: number;
	fontSize?: number;
	links?: boolean;
	backlinks?: boolean;
	[key: string]: unknown;
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
	css?: string;
	ord?: number;
	due?: number;
	interval?: number;
	lapses?: number;
	reviews?: number;
	reps?: number;
	queue?: number;
	type?: number;
	left?: number;
	mod?: number;
	note?: number;
	flags?: number;
	buttons?: number[];
	nextReviews?: string[];
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
	time?: number;
}

export interface AnkiPermissionResult {
	permission: 'granted' | 'denied';
}

export interface AnkiResponse<T> {
	result: T | null;
	error: string | null;
}

