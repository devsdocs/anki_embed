import { sanitizeHTMLToDom, Notice, Menu, setTooltip, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { AnkiClient } from './anki-client';
import {
	checkFrontmatterForCardId,
	extractAnkiTagsFromNote,
	extractAnkiTagsFromText,
	extractAnswerHtml,
	findMatchingAnkiTag,
	formatCardHtml,
	formatClozeTitle,
	getCardStatusPill,
	isClozeCard,
	normalizeAnkiCss,
	normalizeAnkiTag,
	sortCardsForLearningMode,
} from './card-html';
import {
	linkCardToNote,
	linkTagToNote,
	unlinkCardFromNote,
} from './link-service';
import { AnkiRemoteConfigModal } from './remote-modal';
import { NoteSelectModal } from './note-modal';
import { TagSelectModal } from './tag-modal';
import {
	AnkiCardInfo,
	AnkiEmbedSettings,
	CardLinkedNotes,
	CardTagLink,
	DEFAULT_GAMEPAD_MAPPING,
	DEFAULT_KEYBOARD_MAPPING,
	DeckEmbedConfig,
	LearningOrder,
	RemoteAction,
} from './types';

interface DeckNode {
	fullPath: string;
	name: string;
	children: DeckNode[];
	level: number;
}

function buildDeckTree(deckNames: string[]): DeckNode[] {
	const rootNodes: DeckNode[] = [];
	const nodeMap = new Map<string, DeckNode>();

	for (const fullName of deckNames) {
		const parts = fullName.split('::');
		let currentPath = '';

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i]!;
			const prevPath = currentPath;
			currentPath = currentPath ? `${currentPath}::${part}` : part;

			if (!nodeMap.has(currentPath)) {
				const node: DeckNode = {
					fullPath: currentPath,
					name: part,
					children: [],
					level: i,
				};
				nodeMap.set(currentPath, node);

				if (i === 0) {
					rootNodes.push(node);
				} else {
					const parentNode = nodeMap.get(prevPath);
					if (parentNode) {
						parentNode.children.push(node);
					}
				}
			}
		}
	}

	return rootNodes;
}

function filterDeckTree(nodes: DeckNode[], query: string, expandedDecks: Set<string>): DeckNode[] {
	if (!query) return nodes;
	const lower = query.toLowerCase();

	const filterList = (list: DeckNode[]): DeckNode[] => {
		const filtered: DeckNode[] = [];
		for (const node of list) {
			const selfMatch = node.name.toLowerCase().includes(lower) || node.fullPath.toLowerCase().includes(lower);
			const matchingChildren = filterList(node.children);

			if (selfMatch || matchingChildren.length > 0) {
				expandedDecks.add(node.fullPath);
				filtered.push({
					fullPath: node.fullPath,
					name: node.name,
					children: matchingChildren,
					level: node.level,
				});
			}
		}
		return filtered;
	};

	return filterList(nodes);
}

export class DeckPlayer {
	private container: HTMLElement;
	private config: DeckEmbedConfig;
	private client: AnkiClient;
	private settings: AnkiEmbedSettings;
	private app?: App;
	private saveSettings?: (settings: AnkiEmbedSettings) => Promise<void>;

	private cards: AnkiCardInfo[] = [];
	private currentIndex: number = 0;
	private showingAnswer: boolean = false;
	private isLoading: boolean = false;
	private hasStarted: boolean = false;
	private mediaCache = new Map<string, string | null>();
	private modelStyleCache = new Map<string, string>();
	private normalizedStyleCache = new Map<string, string>();
	private preparedQuestionCache = new Map<number, DocumentFragment>();
	private preparedAnswerCache = new Map<number, DocumentFragment>();
	private headerEl: HTMLElement | null = null;
	private cardEl: HTMLElement | null = null;
	private footerEl: HTMLElement | null = null;
	private currentShadowRoot: ShadowRoot | null = null;
	private currentCardContainer: HTMLElement | null = null;
	private currentModelName: string | null = null;
	private currentFontScale: number | null = null;
	private linkedNotesCache = new Map<number, CardLinkedNotes<TFile>>();
	private cardTagsCache = new Map<number, string[]>();
	private activeLinksDropdown: HTMLElement | null = null;
	private linksDropdownCleanup: (() => void) | null = null;
	private isPollingLiveCard = false;
	private isReviewingLiveCard = false;
	private lastUserActionTimestamp = 0;
	private loadRequestId = 0;
	private cardStartTime: number = 0;
	private liveSyncTimer: number | null = null;
	private onWindowFocusHandler: (() => void) | null = null;
	private currentCounts: { new: number; learn: number; review: number; early?: number } | null = null;
	private dueCardIds: Set<number> = new Set<number>();
	private hasAcknowledgedEarlyReviews: boolean = false;
	private cardTimerInterval: number | null = null;
	private timeStreak: number = 0;
	private timerExceededForCurrentCard: boolean = false;
	private isTimerPaused: boolean = false;
	private timerPausedElapsedMs: number = 0;
	private reviewHistory: Array<{
		card: AnkiCardInfo;
		index: number;
		statsDelta: 1 | 2 | 3 | 4;
		timeStreakBefore: number;
	}> = [];
	private gamepadInterval: number | null = null;
	private prevGamepadButtons: boolean[] = [];
	private connectedGamepadName: string | null = null;
	private onGamepadConnectedHandler: ((e: GamepadEvent) => void) | null = null;
	private onGamepadDisconnectedHandler: ((e: GamepadEvent) => void) | null = null;

	public get isLearningMode(): boolean {
		if (this.config.learning !== undefined) {
			return this.config.learning;
		}
		return this.settings.enableLearningMode ?? true;
	}

	public set isLearningMode(val: boolean) {
		this.config.learning = val;
	}

	private get isLiveSync(): boolean {
		if (this.config.card !== undefined || this.config.cardId !== undefined || this.config.query !== undefined) {
			return this.config.live === true;
		}
		return this.config.live ?? this.settings.liveSync;
	}

	private sessionStats = {
		again: 0,
		hard: 0,
		good: 0,
		easy: 0,
	};

	private onOpenFullView?: (config: DeckEmbedConfig) => void;
	private onDeckChange?: (deck: string) => void;
	private isFullView: boolean;

	constructor(
		container: HTMLElement,
		config: DeckEmbedConfig,
		client: AnkiClient,
		settings: AnkiEmbedSettings,
		onOpenFullView?: (config: DeckEmbedConfig) => void,
		isFullView: boolean = false,
		onDeckChange?: (deck: string) => void,
		app?: App,
		saveSettings?: (settings: AnkiEmbedSettings) => Promise<void>
	) {
		this.container = container;
		this.config = config;
		this.client = client;
		this.settings = settings;
		this.onOpenFullView = onOpenFullView;
		this.isFullView = isFullView;
		this.onDeckChange = onDeckChange;
		this.app = app;
		this.saveSettings = saveSettings;
	}

	public async init(): Promise<void> {
		this.container.empty();
		this.container.addClass('anki-embed-container');
		if (this.isFullView) {
			this.container.addClass('is-full-view');
			this.container.addClass('is-selected');
		}
		this.container.tabIndex = 0;

		this.setupSelectionListeners();
		this.registerKeyboardShortcuts();
		this.initGamepad();
		await this.loadCards();
		if (this.isFullView) {
			this.container.focus();
		}
	}

	private setupSelectionListeners(): void {
		this.container.addEventListener('click', () => {
			this.container.focus();
			this.selectReviewBox();
		});

		this.container.addEventListener('focusin', () => {
			this.selectReviewBox();
		});

		this.container.addEventListener('focusout', (evt: FocusEvent) => {
			if (!this.container.contains(evt.relatedTarget as Node)) {
				this.container.removeClass('is-selected');
			}
		});
	}

	private selectReviewBox(): void {
		if (typeof document !== 'undefined') {
			const allEmbeds = document.querySelectorAll('.anki-embed-container.is-selected');
			allEmbeds.forEach(el => {
				if (el !== this.container) {
					el.removeClass('is-selected');
				}
			});
		}
		this.container.addClass('is-selected');
	}

	private isReviewBoxSelected(): boolean {
		if (this.isFullView) return true;
		if (typeof document === 'undefined') return true;
		return (
			this.container === document.activeElement ||
			this.container.contains(document.activeElement) ||
			this.container.hasClass('is-selected')
		);
	}

	private registerKeyboardShortcuts() {
		this.container.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement || evt.target instanceof HTMLSelectElement) {
				return;
			}

			if (this.cards.length === 0 || this.currentIndex >= this.cards.length) {
				return;
			}

			if (evt.key.toLowerCase() === 'r') {
				evt.preventDefault();
				void this.loadCards();
				return;
			}

			const mapping = this.settings.keyboardMapping ?? DEFAULT_KEYBOARD_MAPPING;
			const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;
			const action = mapping[key] ?? mapping[evt.key];

			if (action && action !== 'none') {
				evt.preventDefault();
				this.executeRemoteAction(action);
			}
		});
	}

	private buildQuery(): string {
		const targetCardId = this.config.card ?? this.config.cardId;
		if (targetCardId) {
			return `cid:${targetCardId}`;
		}

		const shouldExcludeSuspended = this.config.excludeSuspended ?? this.settings.excludeSuspended;
		const suspendedClause = shouldExcludeSuspended ? '-is:suspended' : '';

		if (this.config.query) {
			let q = this.config.query;
			if (shouldExcludeSuspended && !q.includes('is:suspended')) {
				q = `${q} -is:suspended`;
			}
			return q;
		}

		const deckName = this.config.deck ? `deck:"${this.config.deck}"` : '';
		const filterMode = this.config.filter ?? this.settings.defaultFilter;

		let filterClause = '';
		if (filterMode === 'due') {
			filterClause = 'is:due';
		} else if (filterMode === 'new') {
			filterClause = 'is:new';
		} else if (filterMode === 'due+new') {
			filterClause = '(is:due or is:new)';
		}

		const parts = [deckName, filterClause, suspendedClause].filter(Boolean);
		return parts.length > 0 ? parts.join(' ') : (shouldExcludeSuspended ? '-is:suspended' : 'is:due');
	}

	private calculateSessionCounts(): { new: number; learn: number; review: number; early?: number } {
		let newCount = 0;
		let learnCount = 0;
		let reviewCount = 0;
		let earlyCount = 0;

		for (let i = this.currentIndex; i < this.cards.length; i++) {
			const c = this.cards[i];
			if (!c) continue;
			if (c.queue === 1 || c.queue === 3) {
				learnCount++;
			} else if (this.dueCardIds.has(c.cardId)) {
				reviewCount++;
			} else if (c.queue === 0 || c.type === 0) {
				newCount++;
			} else if (c.queue === 2 || c.type === 2) {
				earlyCount++;
			} else {
				reviewCount++;
			}
		}

		return { new: newCount, learn: learnCount, review: reviewCount, early: earlyCount };
	}

	private async updateCounts(deckName?: string): Promise<void> {
		if (this.config.query || this.isLearningMode) {
			this.currentCounts = this.calculateSessionCounts();
			this.updateCountsDisplay();
			return;
		}

		const targetDeck = this.config.deck || deckName;
		if (targetDeck) {
			try {
				const statsRecord = await this.client.getDeckStats([targetDeck]);
				if (statsRecord && typeof statsRecord === 'object') {
					const statList = Object.values(statsRecord);
					const deckStat = statList.find(s => s.name?.toLowerCase() === targetDeck.toLowerCase()) || statList[0];
					if (deckStat) {
						this.currentCounts = {
							new: deckStat.new_count ?? 0,
							learn: deckStat.learn_count ?? 0,
							review: deckStat.review_count ?? 0,
						};
						this.updateCountsDisplay();
						return;
					}
				}
			} catch {
				// Fallback to session counts on failure
			}
		}
		this.currentCounts = this.calculateSessionCounts();
		this.updateCountsDisplay();
	}

	public sortCardsForLearningMode(cards: AnkiCardInfo[], dueCardIds: Set<number>, order: LearningOrder): AnkiCardInfo[] {
		return sortCardsForLearningMode(cards, dueCardIds, order);
	}

	private getCardStatusPill(card: AnkiCardInfo): { label: string; cls: string; title: string } {
		return getCardStatusPill(card, this.dueCardIds);
	}

	private sortReviewsFirst(cards: AnkiCardInfo[], randomize: boolean = false): AnkiCardInfo[] {
		const reviews: AnkiCardInfo[] = [];
		const newCards: AnkiCardInfo[] = [];

		for (const card of cards) {
			const isReview = (card.type !== undefined && card.type > 0) || 
			                 (card.queue !== undefined && card.queue > 0) || 
			                 ((card.reviews ?? card.reps ?? 0) > 0);
			if (isReview) {
				reviews.push(card);
			} else {
				newCards.push(card);
			}
		}

		if (randomize) {
			reviews.sort(() => Math.random() - 0.5);
			newCards.sort(() => Math.random() - 0.5);
		}

		return [...reviews, ...newCards];
	}

	public async loadCards(): Promise<void> {
		const requestId = ++this.loadRequestId;
		const targetCardId = this.config.card ?? this.config.cardId;
		if (this.config.select || (!this.config.deck && !this.config.query && !targetCardId && !this.isLiveSync)) {
			this.stopLiveSyncWatcher();
			await this.renderDeckPicker(requestId);
			return;
		}

		this.isLoading = true;
		this.showingAnswer = false;
		this.currentIndex = 0;
		this.sessionStats = { again: 0, hard: 0, good: 0, easy: 0 };
		this.renderLoading();

		if (this.isLiveSync) {
			this.startLiveSyncWatcher();
			await this.loadLiveCards(requestId);
			return;
		} else {
			this.stopLiveSyncWatcher();
		}

		try {
			const orderMode = this.config.order ?? this.settings.cardOrder;
			const shouldRandomize = this.config.randomize ?? this.settings.randomizeCards;
			const limit = this.config.limit ?? this.settings.defaultLimit;
			const filterMode = this.config.filter ?? this.settings.defaultFilter;
			const shouldExcludeSuspended = this.config.excludeSuspended ?? this.settings.excludeSuspended;
			const suspendedClause = shouldExcludeSuspended ? '-is:suspended' : '';
			const deckName = this.config.deck ? `deck:"${this.config.deck}"` : '';

			let selectedIds: number[] = [];

			if (targetCardId) {
				selectedIds = [targetCardId];
			} else if (orderMode === 'reviews-first' && !this.config.query && (filterMode === 'due+new' || filterMode === 'all')) {
				const dueParts = [deckName, 'is:due', suspendedClause].filter(Boolean);
				const dueQuery = dueParts.join(' ');
				const dueIds = await this.client.findCards(dueQuery);

				let pickedDue = dueIds;
				if (shouldRandomize) {
					pickedDue = [...dueIds].sort(() => Math.random() - 0.5);
				}
				if (limit > 0 && pickedDue.length > limit) {
					pickedDue = pickedDue.slice(0, limit);
				}

				selectedIds.push(...pickedDue);

				const remainingLimit = limit > 0 ? limit - selectedIds.length : 0;
				if (remainingLimit > 0 || limit <= 0) {
					const newParts = [deckName, 'is:new', suspendedClause].filter(Boolean);
					const newQuery = newParts.join(' ');
					const newIds = await this.client.findCards(newQuery);

					let pickedNew = newIds;
					if (shouldRandomize) {
						pickedNew = [...newIds].sort(() => Math.random() - 0.5);
					}
					if (limit > 0 && pickedNew.length > remainingLimit) {
						pickedNew = pickedNew.slice(0, remainingLimit);
					}
					selectedIds.push(...pickedNew);
				}
			} else {
				const query = this.buildQuery();
				let cardIds = await this.client.findCards(query);

				// Fallback 1: If 0 cards and query excluded suspended, retry without -is:suspended
				if ((!cardIds || cardIds.length === 0) && query.includes('-is:suspended')) {
					const queryWithoutSuspended = query.replace(/\s*-is:suspended\b/g, '').trim();
					if (queryWithoutSuspended) {
						const fallbackIds = await this.client.findCards(queryWithoutSuspended);
						if (fallbackIds && fallbackIds.length > 0) {
							cardIds = fallbackIds;
						}
					}
				}

				// Fallback 2: If 0 cards and query was a tag search (e.g. tag:"Heart"), try wildcard tag search (tag:*Heart*)
				if (!cardIds || cardIds.length === 0) {
					const tagMatch = query.match(/^tag:"?([^"*]+)"?/);
					if (tagMatch?.[1]) {
						const tagName = tagMatch[1];
						const wildcardQuery = `tag:*${tagName}*`;
						const fallbackIds = await this.client.findCards(wildcardQuery);
						if (fallbackIds && fallbackIds.length > 0) {
							cardIds = fallbackIds;
						}
					}
				}

				if (!cardIds || cardIds.length === 0) {
					if (requestId !== this.loadRequestId) return;
					this.cards = [];
					this.isLoading = false;
					this.renderEmpty();
					return;
				}

				selectedIds = cardIds;
				if (shouldRandomize && orderMode !== 'reviews-first') {
					selectedIds = [...cardIds].sort(() => Math.random() - 0.5);
				}

				if (limit > 0 && selectedIds.length > limit) {
					selectedIds = selectedIds.slice(0, limit);
				}
			}

			if (selectedIds.length === 0) {
				if (requestId !== this.loadRequestId) return;
				this.cards = [];
				this.isLoading = false;
				this.renderEmpty();
				return;
			}

			const cards = await this.client.getCardsInfo(selectedIds);

			if (requestId !== this.loadRequestId) return;

			let finalCards = cards;
			if (this.isLearningMode && !this.isLiveSync) {
				let dueCardIds = new Set<number>();
				try {
					const baseQuery = this.config.query
						? this.config.query
						: (this.config.deck ? `deck:"${this.config.deck}"` : '');
					const suspendedClause = shouldExcludeSuspended ? '-is:suspended' : '';
					const dueQuery = [baseQuery, 'is:due', suspendedClause].filter(Boolean).join(' ');
					const dueIds = await this.client.findCards(dueQuery);
					if (dueIds && dueIds.length > 0) {
						dueCardIds = new Set(dueIds);
					}
				} catch {
					// Fallback to empty
				}
				this.dueCardIds = dueCardIds;
				const learningOrder = this.config.learningOrder ?? this.settings.learningOrder ?? 'due-new-future';
				finalCards = this.sortCardsForLearningMode(cards, dueCardIds, learningOrder);
			} else if (orderMode === 'reviews-first') {
				finalCards = this.sortReviewsFirst(cards, shouldRandomize);
			} else if (shouldRandomize) {
				finalCards = [...cards].sort(() => Math.random() - 0.5);
			}

			this.cards = finalCards;
			this.hasAcknowledgedEarlyReviews = false;
			this.isLoading = false;

			const activeDeck = this.config.deck || this.cards[0]?.deckName;
			await this.updateCounts(activeDeck);

			if (this.cards.length === 0) {
				this.renderEmpty();
			} else if (!this.hasStarted) {
				this.renderStartScreen();
			} else {
				void this.renderCurrentCard();
			}
		} catch (err: unknown) {
			if (requestId !== this.loadRequestId) return;
			this.isLoading = false;
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				if (this.isLiveSync) {
					this.cards = [];
					this.renderEmptyLive();
					return;
				}
			}
			this.renderError(msg);
		}
	}

	private async loadLiveCards(requestId: number = this.loadRequestId): Promise<void> {
		try {
			let currentCard = await this.client.guiCurrentCard();

			if (this.config.deck) {
				const isReviewingTarget = currentCard?.deckName?.toLowerCase() === this.config.deck.toLowerCase();
				if (!currentCard || !isReviewingTarget) {
					try {
						await this.client.guiDeckReview(this.config.deck);
						currentCard = await this.client.guiCurrentCard();
					} catch {
						// Ignore
					}
				}
			}

			if (requestId !== this.loadRequestId) return;
			this.isLoading = false;

			if (!currentCard) {
				this.cards = [];
				this.renderEmptyLive();
				return;
			}

			this.cards = [currentCard];
			this.currentIndex = 0;

			await this.updateCounts(currentCard.deckName || this.config.deck);

			if (!this.hasStarted) {
				this.renderStartScreenLive(currentCard);
			} else {
				void this.renderCurrentCard();
			}
		} catch (err: unknown) {
			if (requestId !== this.loadRequestId) return;
			this.isLoading = false;
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.toLowerCase().includes('not currently active')) {
				this.cards = [];
				this.renderEmptyLive();
				return;
			}
			this.renderError(msg);
		}
	}

	private renderEmptyLive() {
		this.container.empty();
		this.renderHeader('Live reviewer');

		const body = this.container.createDiv({ cls: 'anki-embed-empty' });
		body.createDiv({ text: '⚡ Live sync: Anki desktop is not currently in review mode.' });

		const hint = body.createDiv({ cls: 'anki-embed-empty-hint', attr: { style: 'margin-top: 8px; font-size: 0.9em; opacity: 0.8;' } });
		hint.setText(this.config.deck
			? `Start reviewing "${this.config.deck}" in Anki or choose an option below:`
			: 'Open a deck for review in Anki desktop to mirror it here, or switch to offline mode:');

		const actions = body.createDiv({ cls: 'anki-embed-actions', attr: { style: 'margin-top: 14px; justify-content: center; gap: 8px; flex-wrap: wrap;' } });
		if (this.config.deck) {
			const startAnkiBtn = actions.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: `▶️ Review "${this.config.deck}" in Anki`,
			});
			startAnkiBtn.onclick = async () => {
				if (this.config.deck) {
					try {
						await this.client.guiDeckReview(this.config.deck);
						void this.loadCards();
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`Could not launch deck in Anki: ${msg}`);
					}
				}
			};
		}

		const refreshBtn = actions.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Check Anki now',
		});
		refreshBtn.onclick = () => {
			void this.loadCards();
		};

		const toggleOffBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: 'Switch to offline deck mode',
		});
		toggleOffBtn.onclick = () => {
			this.config.live = false;
			this.hasStarted = true;
			void this.loadCards();
		};

		const pickerBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: '↩ Back to deck selection',
		});
		pickerBtn.onclick = () => {
			this.resetToDeckPicker();
		};
	}

	private renderStartScreenLive(currentCard: AnkiCardInfo) {
		this.container.empty();
		this.renderHeader(currentCard.deckName || this.config.deck);

		const startDiv = this.container.createDiv({ cls: 'anki-embed-completed' });
		startDiv.createDiv({
			cls: 'anki-embed-completed-icon',
			text: '⚡',
		});
		startDiv.createEl('h3', { text: 'Connected to Anki live review' });
		startDiv.createEl('p', { text: `Active deck: ${currentCard.deckName || 'Current Deck'}. Obsidian and Anki desktop will stay synchronized.` });

		const startBtn = startDiv.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: 'Start synced session',
		});
		startBtn.onclick = () => {
			this.hasStarted = true;
			void this.renderCurrentCard();
		};

		const changeBtn = startDiv.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: 'Switch to offline deck mode',
		});
		changeBtn.onclick = () => {
			this.config.live = false;
			void this.loadCards();
		};

		const hint = startDiv.createDiv({ cls: 'anki-embed-shortcut-hint', attr: { style: 'margin-top: 16px;' } });
		hint.createSpan({ text: 'Shortcut: Press Space to start' });
		hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
	}

	private startLiveSyncWatcher() {
		this.stopLiveSyncWatcher();
		if (!this.isLiveSync) return;

		this.liveSyncTimer = window.setInterval(() => {
			void (async () => {
				if (!this.isLiveSync || this.isLoading || !this.hasStarted || this.isPollingLiveCard || this.isReviewingLiveCard) return;
				if (Date.now() - this.lastUserActionTimestamp < 1500) return;
				if (!this.container.isConnected) {
					this.stopLiveSyncWatcher();
					return;
				}
				this.isPollingLiveCard = true;
				try {
					const currentCard = await this.client.guiCurrentCard();
					if (!currentCard) {
						if (this.cards.length > 0) {
							this.cards = [];
							this.renderCompleted();
						}
						return;
					}
					const existingCard = this.cards[this.currentIndex];
					if (!existingCard || existingCard.cardId !== currentCard.cardId) {
						this.cards = [currentCard];
						this.currentIndex = 0;
						this.showingAnswer = false;
						void this.updateCounts(currentCard.deckName || this.config.deck);
						await this.renderCurrentCard();
					}
				} catch {
					// Ignore
				} finally {
					this.isPollingLiveCard = false;
				}
			})();
		}, 600);

		this.onWindowFocusHandler = () => {
			void (async () => {
				if (!this.isLiveSync || this.isLoading || !this.hasStarted || this.isPollingLiveCard || this.isReviewingLiveCard) return;
				if (Date.now() - this.lastUserActionTimestamp < 1000) return;
				this.isPollingLiveCard = true;
				try {
					const currentCard = await this.client.guiCurrentCard();
					if (currentCard && currentCard.cardId !== this.cards[this.currentIndex]?.cardId) {
						this.cards = [currentCard];
						this.currentIndex = 0;
						this.showingAnswer = false;
						void this.updateCounts(currentCard.deckName || this.config.deck);
						await this.renderCurrentCard();
					}
				} catch {
					// Ignore
				} finally {
					this.isPollingLiveCard = false;
				}
			})();
		};
		window.addEventListener('focus', this.onWindowFocusHandler);
	}

	public stopLiveSyncWatcher() {
		if (this.liveSyncTimer !== null) {
			window.clearInterval(this.liveSyncTimer);
			this.liveSyncTimer = null;
		}
		if (this.onWindowFocusHandler) {
			window.removeEventListener('focus', this.onWindowFocusHandler);
			this.onWindowFocusHandler = null;
		}
	}

	public stopCardTimer() {
		if (this.cardTimerInterval !== null) {
			window.clearInterval(this.cardTimerInterval);
			this.cardTimerInterval = null;
		}
	}

	private getCardElapsedSec(): number {
		if (this.isTimerPaused) {
			return this.timerPausedElapsedMs / 1000;
		}
		if (this.cardStartTime > 0) {
			return (Date.now() - this.cardStartTime) / 1000;
		}
		return 0;
	}

	private toggleTimerPause(timerPill: HTMLElement, clockEl: HTMLElement, timerTextEl: HTMLElement, streakEl: HTMLElement) {
		const warningSec = this.config.timerWarning ?? this.settings.timerWarningSeconds;
		const limitSec = this.config.timerLimit ?? this.settings.timerLimitSeconds;

		if (!this.isTimerPaused) {
			this.isTimerPaused = true;
			this.timerPausedElapsedMs = this.cardStartTime > 0 ? (Date.now() - this.cardStartTime) : 0;
			this.stopCardTimer();
			timerPill.removeClass('is-normal');
			timerPill.removeClass('is-warning');
			timerPill.removeClass('is-overtime');
			timerPill.addClass('is-paused');
			clockEl.setText('⏸️');
			timerPill.setAttribute('title', 'Timer paused (click to resume)');
			timerTextEl.setText(`${(this.timerPausedElapsedMs / 1000).toFixed(1)}s`);
		} else {
			this.isTimerPaused = false;
			this.cardStartTime = Date.now() - this.timerPausedElapsedMs;
			timerPill.removeClass('is-paused');
			clockEl.setText('⏱️');
			timerPill.setAttribute('title', `Card timer: Warning at ${warningSec}s, Limit at ${limitSec}s (click to pause)`);
			this.startCardTimer(timerPill, clockEl, timerTextEl, streakEl);
		}
	}

	private startCardTimer(timerPill: HTMLElement, clockEl: HTMLElement, timerTextEl: HTMLElement, streakEl: HTMLElement) {
		this.stopCardTimer();
		if (this.isTimerPaused) {
			return;
		}
		const warningSec = this.config.timerWarning ?? this.settings.timerWarningSeconds;
		const limitSec = this.config.timerLimit ?? this.settings.timerLimitSeconds;

		this.cardTimerInterval = window.setInterval(() => {
			if (!this.container.isConnected) {
				this.stopCardTimer();
				return;
			}
			if (this.isTimerPaused) {
				return;
			}

			const elapsedSec = this.getCardElapsedSec();
			timerTextEl.setText(`${elapsedSec.toFixed(1)}s`);

			if (elapsedSec >= limitSec) {
				timerPill.removeClass('is-normal');
				timerPill.removeClass('is-warning');
				timerPill.removeClass('is-paused');
				timerPill.addClass('is-overtime');

				if (!this.timerExceededForCurrentCard) {
					this.timerExceededForCurrentCard = true;
					this.timeStreak = 0;
					streakEl.setText('⚡ 0');
				}
			} else if (elapsedSec >= warningSec) {
				timerPill.removeClass('is-normal');
				timerPill.removeClass('is-overtime');
				timerPill.removeClass('is-paused');
				timerPill.addClass('is-warning');
			} else {
				timerPill.removeClass('is-warning');
				timerPill.removeClass('is-overtime');
				timerPill.removeClass('is-paused');
				timerPill.addClass('is-normal');
			}
		}, 100);
	}

	public destroy(): void {
		this.closeActiveLinksDropdown();
		this.stopLiveSyncWatcher();
		this.stopCardTimer();
		this.isTimerPaused = false;
		this.timerPausedElapsedMs = 0;
		this.stopGamepadLoop();
	}

	public resetToDeckPicker(): void {
		this.closeActiveLinksDropdown();
		this.stopLiveSyncWatcher();
		this.stopCardTimer();
		this.isTimerPaused = false;
		this.timerPausedElapsedMs = 0;
		this.timeStreak = 0;
		this.timerExceededForCurrentCard = false;
		this.reviewHistory = [];
		this.hasStarted = false;
		this.currentIndex = 0;
		this.showingAnswer = false;
		this.sessionStats = { again: 0, hard: 0, good: 0, easy: 0 };
		this.cards = [];
		this.headerEl = null;
		this.cardEl = null;
		this.footerEl = null;
		this.currentShadowRoot = null;
		this.currentCardContainer = null;
		this.currentModelName = null;
		this.currentFontScale = null;
		this.preparedQuestionCache.clear();
		this.preparedAnswerCache.clear();
		this.config.select = true;
		this.config.deck = undefined;
		this.config.query = undefined;
		this.onDeckChange?.('');
		void this.renderDeckPicker();
	}

	private initGamepad(): void {
		const isGamepadEnabled = this.config.remote ?? this.settings.enableGamepad;
		if (!isGamepadEnabled || typeof window === 'undefined') return;

		this.onGamepadConnectedHandler = (e: GamepadEvent) => {
			this.connectedGamepadName = e.gamepad.id;
			new Notice(`🎮 Connected: ${e.gamepad.id.slice(0, 30)}`);
			this.updateGamepadBadge();
		};
		this.onGamepadDisconnectedHandler = () => {
			this.connectedGamepadName = null;
			new Notice('🎮 Controller disconnected');
			this.updateGamepadBadge();
		};

		window.addEventListener('gamepadconnected', this.onGamepadConnectedHandler);
		window.addEventListener('gamepaddisconnected', this.onGamepadDisconnectedHandler);

		this.gamepadInterval = window.setInterval(() => {
			this.pollGamepadState();
		}, 50);
	}

	private stopGamepadLoop(): void {
		if (this.gamepadInterval !== null) {
			window.clearInterval(this.gamepadInterval);
			this.gamepadInterval = null;
		}
		if (this.onGamepadConnectedHandler) {
			window.removeEventListener('gamepadconnected', this.onGamepadConnectedHandler);
			this.onGamepadConnectedHandler = null;
		}
		if (this.onGamepadDisconnectedHandler) {
			window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnectedHandler);
			this.onGamepadDisconnectedHandler = null;
		}
	}

	private updateGamepadBadge(): void {
		const badge = this.container.querySelector('.anki-embed-gamepad-badge');
		if (badge) {
			if (this.connectedGamepadName) {
				badge.addClass('is-connected');
				badge.setAttribute('title', `🎮 Controller: ${this.connectedGamepadName}`);
				badge.textContent = '🎮 Remote connected';
			} else {
				badge.removeClass('is-connected');
				badge.setAttribute('title', '🎮 Anki remote / gamepad enabled (connect via bluetooth or USB)');
				badge.textContent = '🎮 Remote';
			}
		}
	}

	private pollGamepadState(): void {
		if (!this.isReviewBoxSelected()) return;
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
		const gamepads = navigator.getGamepads();
		if (!gamepads) return;

		let activeGamepad: Gamepad | null = null;
		for (let i = 0; i < gamepads.length; i++) {
			const gp = gamepads[i];
			if (gp && gp.connected) {
				activeGamepad = gp;
				break;
			}
		}

		if (!activeGamepad) {
			if (this.connectedGamepadName !== null) {
				this.connectedGamepadName = null;
				this.updateGamepadBadge();
			}
			return;
		}

		if (this.connectedGamepadName !== activeGamepad.id) {
			this.connectedGamepadName = activeGamepad.id;
			this.updateGamepadBadge();
		}

		const buttons = activeGamepad.buttons;
		for (let i = 0; i < buttons.length; i++) {
			const btn = buttons[i];
			if (!btn) continue;
			const isPressed = btn.pressed || btn.value > 0.5;
			const wasPressed = !!this.prevGamepadButtons[i];

			if (isPressed && !wasPressed) {
				this.handleGamepadButton(i);
			}
		}

		this.prevGamepadButtons = buttons.map(b => (b ? (b.pressed || b.value > 0.5) : false));
	}

	private handleGamepadButton(btnIndex: number): void {
		if (this.cards.length === 0) return;

		const mapping = this.settings.gamepadMapping ?? DEFAULT_GAMEPAD_MAPPING;
		const action = mapping[btnIndex] ?? 'none';
		this.executeRemoteAction(action);
	}

	private executeRemoteAction(action: RemoteAction): void {
		if (this.cards.length === 0) return;

		if (!this.hasStarted) {
			this.hasStarted = true;
			void this.renderCurrentCard();
			return;
		}

		switch (action) {
			case 'flip_or_good':
				if (!this.showingAnswer) {
					void this.revealAnswer();
				} else {
					void this.rateCurrentCard(3);
				}
				break;
			case 'flip_or_easy':
				if (!this.showingAnswer) {
					void this.revealAnswer();
				} else {
					void this.rateCurrentCard(4);
				}
				break;
			case 'flip_or_hard':
				if (!this.showingAnswer) {
					void this.revealAnswer();
				} else {
					void this.rateCurrentCard(2);
				}
				break;
			case 'flip_or_again':
				if (!this.showingAnswer) {
					void this.revealAnswer();
				} else {
					void this.rateCurrentCard(1);
				}
				break;
			case 'again':
				if (this.showingAnswer) void this.rateCurrentCard(1);
				break;
			case 'hard':
				if (this.showingAnswer) void this.rateCurrentCard(2);
				break;
			case 'good':
				if (this.showingAnswer) void this.rateCurrentCard(3);
				break;
			case 'easy':
				if (this.showingAnswer) void this.rateCurrentCard(4);
				break;
			case 'flip':
				if (!this.showingAnswer) void this.revealAnswer();
				break;
			case 'undo':
				void this.undoLastCard();
				break;
			case 'suspend':
				void this.suspendCurrentCard();
				break;
			case 'bury':
				void this.buryCurrentCard();
				break;
			case 'flag':
				void this.toggleFlagCurrentCard();
				break;
			case 'append_card_note': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					void this.appendCardToNote(currentCard);
				}
				break;
			}
			case 'create_card_note': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					void this.createNoteFromCard(currentCard);
				}
				break;
			}
			case 'toggle_timer': {
				const pill = this.container.querySelector<HTMLElement>('.anki-embed-timer-pill');
				if (pill) {
					pill.click();
				}
				break;
			}
			case 'link_active_note': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					void this.linkActiveNote(currentCard.cardId);
				}
				break;
			}
			case 'unlink_active_note': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					void this.unlinkActiveNote(currentCard.cardId);
				}
				break;
			}
			case 'search_link_note': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard && this.app) {
					new NoteSelectModal(this.app, (file) => {
						void this.linkNoteToCard(file, currentCard.cardId);
					}).open();
				}
				break;
			}
			case 'create_link_note': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					void this.createNoteFromCard(currentCard);
				}
				break;
			}
			case 'open_links_menu': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					const btn = this.container.querySelector<HTMLElement>('.anki-embed-links-btn');
					this.openCardLinksDropdown(btn ?? this.container, currentCard);
				}
				break;
			}
			case 'open_anki_browser': {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					void this.client.guiBrowse(`cid:${currentCard.cardId}`);
				}
				break;
			}
			case 'sync_anki': {
				void (async () => {
					try {
						await this.client.sync();
						new Notice('Anki sync complete');
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`Anki sync failed: ${msg}`);
					}
				})();
				break;
			}
			case 'refresh_cards': {
				void this.loadCards();
				break;
			}
			case 'deck_picker': {
				this.resetToDeckPicker();
				break;
			}
			case 'none':
			default:
				break;
		}
	}

	private async undoLastCard(): Promise<void> {
		if (this.isLiveSync) {
			this.isReviewingLiveCard = true;
			this.lastUserActionTimestamp = Date.now();
			try {
				new Notice('Undid last review in Anki');
				const nextCard = await this.client.guiUndoAndCurrentCard();
				if (nextCard) {
					this.cards = [nextCard];
					this.currentIndex = 0;
					this.showingAnswer = false;
					await this.renderCurrentCard();
					window.setTimeout(() => {
						void this.updateCounts(nextCard.deckName || this.config.deck);
					}, 20);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`Failed to undo in Anki: ${msg}`);
			} finally {
				this.isReviewingLiveCard = false;
			}
			return;
		}

		if (this.reviewHistory.length === 0) {
			new Notice('No previous reviews in this session to undo.');
			return;
		}

		const lastReview = this.reviewHistory.pop();
		if (!lastReview) return;

		if (lastReview.statsDelta === 1) this.sessionStats.again = Math.max(0, this.sessionStats.again - 1);
		else if (lastReview.statsDelta === 2) this.sessionStats.hard = Math.max(0, this.sessionStats.hard - 1);
		else if (lastReview.statsDelta === 3) this.sessionStats.good = Math.max(0, this.sessionStats.good - 1);
		else if (lastReview.statsDelta === 4) this.sessionStats.easy = Math.max(0, this.sessionStats.easy - 1);

		this.timeStreak = lastReview.timeStreakBefore;
		this.currentIndex = lastReview.index;
		this.showingAnswer = false;
		new Notice('Undid last card review');
		const activeDeck = lastReview.card.deckName || this.config.deck;
		await this.updateCounts(activeDeck);
		await this.renderCurrentCard();
	}

	private async suspendCurrentCard(): Promise<void> {
		const card = this.cards[this.currentIndex];
		if (!card) return;

		try {
			await this.client.suspendCards([card.cardId]);
			new Notice(`⏸️ Card ${card.cardId} suspended`);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to suspend card: ${msg}`);
		}

		if (this.isLiveSync) {
			try {
				const nextCard = await this.client.guiCurrentCard();
				if (nextCard) {
					this.cards = [nextCard];
					this.currentIndex = 0;
					this.showingAnswer = false;
					await this.updateCounts(nextCard.deckName || this.config.deck);
					await this.renderCurrentCard();
				} else {
					this.cards = [];
					this.renderCompleted();
				}
			} catch {
				// Fallback
			}
		} else {
			this.cards.splice(this.currentIndex, 1);
			this.showingAnswer = false;
			if (this.currentIndex >= this.cards.length && this.cards.length > 0) {
				this.currentIndex = 0;
			}
			const activeDeck = card.deckName || this.config.deck;
			await this.updateCounts(activeDeck);
			await this.renderCurrentCard();
		}
	}

	private async buryCurrentCard(): Promise<void> {
		const card = this.cards[this.currentIndex];
		if (!card) return;

		new Notice(`📦 Card ${card.cardId} buried for this session`);

		if (this.isLiveSync) {
			try {
				const nextCard = await this.client.guiCurrentCard();
				if (nextCard && nextCard.cardId !== card.cardId) {
					this.cards = [nextCard];
					this.currentIndex = 0;
					this.showingAnswer = false;
					await this.updateCounts(nextCard.deckName || this.config.deck);
					await this.renderCurrentCard();
					return;
				}
			} catch {
				// Fallback
			}
		}

		this.cards.splice(this.currentIndex, 1);
		this.showingAnswer = false;
		if (this.currentIndex >= this.cards.length && this.cards.length > 0) {
			this.currentIndex = 0;
		}
		const activeDeck = card.deckName || this.config.deck;
		await this.updateCounts(activeDeck);
		await this.renderCurrentCard();
	}

	private async toggleFlagCurrentCard(): Promise<void> {
		const card = this.cards[this.currentIndex];
		if (!card) return;

		const currentFlag = card.flags ?? 0;
		const newFlag = currentFlag > 0 ? 0 : 1;

		try {
			await this.client.setSpecificValueOfCard(card.cardId, ['flags'], [String(newFlag)], true);
			card.flags = newFlag;
			const msg = newFlag > 0 ? '🚩 Card flagged (Red)' : '🏳️ Flag removed';
			new Notice(msg);

			const flagBtn = this.container.querySelector('.anki-embed-btn-flag');
			if (flagBtn) {
				if (newFlag > 0) {
					flagBtn.addClass('is-flagged');
					flagBtn.textContent = '🚩';
					flagBtn.setAttribute('title', 'Remove flag from card (f)');
				} else {
					flagBtn.removeClass('is-flagged');
					flagBtn.textContent = '🏳️';
					flagBtn.setAttribute('title', 'Flag card (f)');
				}
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to update flag: ${msg}`);
		}
	}

	private async renderDeckPicker(requestId: number = this.loadRequestId): Promise<void> {
		this.container.empty();
		this.renderHeader('Select deck', false, true);

		const pickerDiv = this.container.createDiv({ cls: 'anki-embed-picker' });
		pickerDiv.createDiv({ cls: 'anki-embed-picker-title', text: 'Select deck to review' });

		try {
			const decks = await this.client.getDeckNames();
			if (requestId !== this.loadRequestId) return;
			if (!decks || decks.length === 0) {
				pickerDiv.createDiv({ cls: 'anki-embed-empty', text: 'No decks found in Anki.' });
				return;
			}

			const statsMap = new Map<string, { new: number; learn: number; review: number }>();
			try {
				const statsRecord = await this.client.getDeckStats(decks);
				if (statsRecord && typeof statsRecord === 'object') {
					for (const stat of Object.values(statsRecord)) {
						if (stat && stat.name) {
							statsMap.set(stat.name, {
								new: stat.new_count ?? 0,
								learn: stat.learn_count ?? 0,
								review: stat.review_count ?? 0,
							});
						}
					}
				}
			} catch {
				// Fallback to empty counts if stats fail
			}

			const deckTree = buildDeckTree(decks);

			const searchInput = pickerDiv.createEl('input', {
				cls: 'anki-embed-search-input',
				attr: { placeholder: 'Search decks...' },
			});

			const treeContainer = pickerDiv.createDiv({ cls: 'anki-embed-deck-tree' });

			const startBtn = pickerDiv.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: 'Start review',
			});

			const expandedDecks = new Set<string>();
			if (this.config.deck) {
				const parts = this.config.deck.split('::');
				let path = '';
				for (let i = 0; i < parts.length - 1; i++) {
					path = path ? `${path}::${parts[i]}` : parts[i]!;
					expandedDecks.add(path);
				}
			}

			let selectedDeck = this.config.deck || '';

			const updateStartButton = () => {
				if (!selectedDeck) {
					startBtn.disabled = true;
					startBtn.setText('Select a deck to start');
					startBtn.removeAttribute('title');
				} else {
					startBtn.disabled = false;
					const displayName = selectedDeck.split('::').pop() ?? selectedDeck;
					startBtn.setText(`Start review: ${displayName}`);
					startBtn.setAttribute('title', `Start review with ${selectedDeck}`);
				}
			};

			const renderNode = (node: DeckNode) => {
				const hasChildren = node.children.length > 0;
				const isExpanded = expandedDecks.has(node.fullPath);
				const isSelected = selectedDeck === node.fullPath;

				const row = treeContainer.createDiv({
					cls: `anki-embed-deck-row ${isSelected ? 'is-selected' : ''}`,
					attr: {
						'data-level': String(node.level),
						title: node.fullPath,
					},
				});

				const toggleEl = row.createSpan({
					cls: `anki-embed-deck-toggle ${hasChildren ? '' : 'is-empty'}`,
					text: hasChildren ? (isExpanded ? '▾' : '▸') : '',
				});

				if (hasChildren) {
					toggleEl.onclick = (e) => {
						e.stopPropagation();
						if (expandedDecks.has(node.fullPath)) {
							expandedDecks.delete(node.fullPath);
						} else {
							expandedDecks.add(node.fullPath);
						}
						renderTree(searchInput.value);
					};
				}

				row.createSpan({
					cls: 'anki-embed-deck-name',
					text: node.name,
				});

				const counts = statsMap.get(node.fullPath) ?? { new: 0, learn: 0, review: 0 };
				const countsContainer = row.createDiv({ cls: 'anki-deck-counts' });

				const newSpan = countsContainer.createSpan({
					cls: `anki-deck-count is-new ${counts.new === 0 ? 'is-zero' : ''}`,
					text: String(counts.new),
				});
				setTooltip(newSpan, `${counts.new} new`);

				const learnSpan = countsContainer.createSpan({
					cls: `anki-deck-count is-learn ${counts.learn === 0 ? 'is-zero' : ''}`,
					text: String(counts.learn),
				});
				setTooltip(learnSpan, `${counts.learn} learn`);

				const reviewSpan = countsContainer.createSpan({
					cls: `anki-deck-count is-review ${counts.review === 0 ? 'is-zero' : ''}`,
					text: String(counts.review),
				});
				setTooltip(reviewSpan, `${counts.review} due`);

				row.onclick = () => {
					selectedDeck = node.fullPath;
					if (hasChildren) {
						if (expandedDecks.has(node.fullPath)) {
							expandedDecks.delete(node.fullPath);
						} else {
							expandedDecks.add(node.fullPath);
						}
					}
					renderTree(searchInput.value);
					updateStartButton();
				};

				row.ondblclick = () => {
					selectedDeck = node.fullPath;
					startBtn.click();
				};

				if (hasChildren && isExpanded) {
					for (const child of node.children) {
						renderNode(child);
					}
				}
			};

			const renderTree = (query: string = '') => {
				treeContainer.empty();
				const filteredTree = filterDeckTree(deckTree, query.trim(), expandedDecks);

				if (filteredTree.length === 0) {
					treeContainer.createDiv({
						cls: 'anki-embed-empty',
						text: 'No matching decks found',
					});
					selectedDeck = '';
					updateStartButton();
					return;
				}

				const isCurrentVisible = selectedDeck && decks.some(d => d === selectedDeck && (
					!query.trim() || d.toLowerCase().includes(query.trim().toLowerCase())
				));
				if (query.trim() && (!selectedDeck || !isCurrentVisible)) {
					selectedDeck = filteredTree[0]?.fullPath ?? '';
				}

				for (const rootNode of filteredTree) {
					renderNode(rootNode);
				}
				updateStartButton();
			};

			renderTree('');
			updateStartButton();

			searchInput.oninput = () => {
				renderTree(searchInput.value);
			};

			startBtn.onclick = () => {
				if (selectedDeck) {
					this.config.deck = selectedDeck;
					this.config.select = false;
					this.hasStarted = true;
					this.onDeckChange?.(selectedDeck);
					void this.loadCards();
				}
			};

			const shouldShowHeatmap = this.config.heatmap ?? this.settings.showHeatmap;
			if (shouldShowHeatmap) {
				const heatmapContainer = pickerDiv.createDiv({ cls: 'anki-embed-heatmap-section' });
				void this.renderReviewHeatmap(heatmapContainer);
			}
		} catch (err: unknown) {
			if (requestId !== this.loadRequestId) return;
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(msg);
		}
	}

	private async renderReviewHeatmap(container: HTMLElement): Promise<void> {
		const card = container.createDiv({ cls: 'anki-embed-heatmap-card' });
		const loader = card.createDiv({ cls: 'anki-embed-empty', text: '📅 Loading review heatmap...' });

		try {
			const dailyReviews = await this.client.getNumCardsReviewedByDay();
			loader.remove();

			if (!dailyReviews || dailyReviews.length === 0) {
				card.createDiv({ cls: 'anki-embed-empty', text: 'No review history found in Anki.' });
				return;
			}

			const reviewMap = new Map<string, number>();
			let maxDaily = 0;
			let totalReviews = 0;
			for (const [dateStr, count] of dailyReviews) {
				const num = Number(count) || 0;
				reviewMap.set(dateStr, num);
				totalReviews += num;
				if (num > maxDaily) {
					maxDaily = num;
				}
			}

			const formatDateKey = (d: Date): string => {
				const y = d.getFullYear();
				const m = String(d.getMonth() + 1).padStart(2, '0');
				const day = String(d.getDate()).padStart(2, '0');
				return `${y}-${m}-${day}`;
			};

			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const todayStr = formatDateKey(today);
			const todayCount = reviewMap.get(todayStr) ?? 0;

			// Current streak
			let currentStreak = 0;
			const checkDate = new Date(today);
			if (todayCount === 0) {
				checkDate.setDate(checkDate.getDate() - 1);
			}
			while (true) {
				const key = formatDateKey(checkDate);
				const c = reviewMap.get(key) ?? 0;
				if (c > 0) {
					currentStreak++;
					checkDate.setDate(checkDate.getDate() - 1);
				} else {
					break;
				}
			}

			// Longest streak
			let longestStreak = 0;
			let tempStreak = 0;
			let prevDate: Date | null = null;
			const sortedDates = Array.from(reviewMap.keys()).sort();
			for (const dStr of sortedDates) {
				const c = reviewMap.get(dStr) ?? 0;
				if (c <= 0) continue;
				const parts = dStr.split('-').map(Number);
				if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) continue;
				const curDate = new Date(parts[0], parts[1] - 1, parts[2]);

				if (prevDate) {
					const diffDays = Math.round((curDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
					if (diffDays === 1) {
						tempStreak++;
					} else if (diffDays > 1) {
						tempStreak = 1;
					}
				} else {
					tempStreak = 1;
				}
				prevDate = curDate;
				if (tempStreak > longestStreak) {
					longestStreak = tempStreak;
				}
			}
			if (currentStreak > longestStreak) {
				longestStreak = currentStreak;
			}

			// Header with Title and Stats
			const header = card.createDiv({ cls: 'anki-embed-heatmap-header' });
			const titleDiv = header.createDiv({ cls: 'anki-embed-heatmap-title' });
			titleDiv.setText('🔥 Review activity');

			const statsDiv = header.createDiv({ cls: 'anki-embed-heatmap-stats' });

			const addStat = (val: number | string, label: string) => {
				const statBox = statsDiv.createDiv({ cls: 'anki-heatmap-stat' });
				statBox.createSpan({ cls: 'stat-value', text: String(val) });
				statBox.createSpan({ cls: 'stat-label', text: label });
			};

			addStat(currentStreak, 'Streak');
			addStat(longestStreak, 'Longest');
			addStat(todayCount, 'Today');
			addStat(totalReviews, 'Total');

			// Heatmap Grid: 40 weeks back (~9 months)
			const totalWeeks = 40;
			const dayOfWeek = today.getDay(); // 0 is Sunday
			const endSaturday = new Date(today);
			endSaturday.setDate(today.getDate() + (6 - dayOfWeek));

			const startSunday = new Date(endSaturday);
			startSunday.setDate(endSaturday.getDate() - (totalWeeks * 7 - 1));

			const scrollWrapper = card.createDiv({ cls: 'anki-embed-heatmap-scroll' });
			const monthsRow = scrollWrapper.createDiv({ cls: 'anki-heatmap-months' });

			const gridContainer = scrollWrapper.createDiv({ cls: 'anki-heatmap-grid-container' });

			// Footer with legend and live hover info
			const footer = card.createDiv({ cls: 'anki-embed-heatmap-footer' });
			const hoverInfo = footer.createSpan({
				cls: 'anki-heatmap-hover-info',
				text: 'Hover on a day to see cards reviewed',
			});
			const legend = footer.createDiv({ cls: 'anki-heatmap-legend' });
			legend.createSpan({ cls: 'anki-heatmap-legend-label', text: 'Less' });
			for (let lvl = 0; lvl <= 4; lvl++) {
				legend.createSpan({ cls: 'anki-heatmap-cell', attr: { 'data-level': String(lvl) } });
			}
			legend.createSpan({ cls: 'anki-heatmap-legend-label', text: 'More' });

			// Day labels
			const dayLabels = gridContainer.createDiv({ cls: 'anki-heatmap-day-labels' });
			const dayNames = ['', 'M', '', 'W', '', 'F', ''];
			for (const dn of dayNames) {
				dayLabels.createDiv({ text: dn });
			}

			const grid = gridContainer.createDiv({ cls: 'anki-heatmap-grid' });

			let lastMonth = -1;
			const iterDate = new Date(startSunday);
			for (let w = 0; w < totalWeeks; w++) {
				const weekDiv = grid.createDiv({ cls: 'anki-heatmap-week' });

				const curMonth = iterDate.getMonth();
				if (curMonth !== lastMonth) {
					lastMonth = curMonth;
					const monthName = iterDate.toLocaleDateString(undefined, { month: 'short' });
					monthsRow.createSpan({
						cls: 'anki-heatmap-month-label',
						text: monthName,
						attr: { style: 'width: calc(14px * 4);' },
					});
				}

				for (let d = 0; d < 7; d++) {
					const cellDate = new Date(iterDate);
					const dateKey = formatDateKey(cellDate);
					const isFuture = cellDate.getTime() > today.getTime();
					const count = reviewMap.get(dateKey) ?? 0;

					let level = 0;
					if (count > 0) {
						if (maxDaily <= 10) {
							level = count >= 6 ? 4 : count >= 4 ? 3 : count >= 2 ? 2 : 1;
						} else {
							const ratio = count / maxDaily;
							level = ratio > 0.6 ? 4 : ratio > 0.3 ? 3 : ratio > 0.1 ? 2 : 1;
						}
					}

					const formattedDate = cellDate.toLocaleDateString(undefined, {
						month: 'short',
						day: 'numeric',
						year: 'numeric',
					});
					const title = count > 0
						? `${count} cards reviewed on ${formattedDate}`
						: `No reviews on ${formattedDate}`;

					const cell = weekDiv.createDiv({
						cls: `anki-heatmap-cell ${isFuture ? 'is-future' : ''}`,
						attr: {
							'data-level': String(level),
						},
					});

					setTooltip(cell, title);

					cell.addEventListener('mouseenter', () => {
						hoverInfo.setText(`📅 ${title}`);
					});
					cell.addEventListener('mouseleave', () => {
						hoverInfo.setText('Hover on a day to see cards reviewed');
					});

					if (dateKey === todayStr) {
						cell.addClass('is-today');
					}

					iterDate.setDate(iterDate.getDate() + 1);
				}
			}

			window.setTimeout(() => {
				scrollWrapper.scrollLeft = scrollWrapper.scrollWidth;
			}, 50);
		} catch {
			loader.setText('Could not connect to Anki to load review history.');
		}
	}

	private renderStartScreen() {
		this.container.empty();
		this.renderHeader();

		const startDiv = this.container.createDiv({ cls: 'anki-embed-completed' });
		startDiv.createDiv({
			cls: 'anki-embed-completed-icon',
			text: '▶️',
		});
		startDiv.createEl('h3', { text: 'Ready to review' });
		startDiv.createEl('p', { text: `Found ${this.cards.length} cards matching your criteria.` });

		const startBtn = startDiv.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: 'Start session',
		});
		startBtn.onclick = () => {
			this.hasStarted = true;
			void this.renderCurrentCard();
		};

		const changeBtn = startDiv.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: '↩ Back to deck selection',
		});
		changeBtn.onclick = () => {
			this.resetToDeckPicker();
		};

		const hint = startDiv.createDiv({ cls: 'anki-embed-shortcut-hint', attr: { style: 'margin-top: 16px;' } });
		hint.createSpan({ text: 'Shortcut: Press Space to start' });
		hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
	}

	private renderLoading() {
		this.container.empty();
		const loader = this.container.createDiv({ cls: 'anki-embed-empty' });
		loader.createDiv({ text: '⚡ Connecting to Anki...' });
	}

	private renderEmpty() {
		this.container.empty();
		this.renderHeader('No cards');

		const body = this.container.createDiv({ cls: 'anki-embed-empty' });
		body.createDiv({ text: '🎉 No cards found matching this query or deck.' });

		if (this.config.query) {
			const queryHint = body.createDiv({
				cls: 'anki-embed-empty-query',
				attr: { style: 'margin-top: 8px; font-size: 0.88em; opacity: 0.85;' },
			});
			queryHint.createSpan({ text: 'Searched query: ' });
			queryHint.createEl('code', { text: this.config.query });
		}

		const actions = body.createDiv({ cls: 'anki-embed-actions' });
		const refreshBtn = actions.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Refresh deck',
		});
		refreshBtn.onclick = () => {
			void this.loadCards();
		};

		const changeBtn = actions.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '↩ Back to deck selection',
		});
		changeBtn.onclick = () => {
			this.resetToDeckPicker();
		};
	}

	private renderError(message: string) {
		if (message.toLowerCase().includes('not currently active')) {
			if (this.isLiveSync) {
				this.cards = [];
				this.renderEmptyLive();
				return;
			}
			this.cards = [];
			this.renderEmpty();
			return;
		}
		this.container.empty();
		const errDiv = this.container.createDiv({ cls: 'anki-embed-error' });
		errDiv.createEl('strong', { text: '⚠️ AnkiConnect error' });
		errDiv.createDiv({ text: message });

		const steps = errDiv.createEl('ul', { cls: 'anki-embed-error-steps' });
		steps.createEl('li', { text: '1. Launch the Anki application on your desktop.' });
		steps.createEl('li', { text: '2. Ensure the AnkiConnect add-on (code 2055492159) is installed in Anki.' });
		steps.createEl('li', { text: '3. Verify the AnkiConnect URL in plugin settings.' });

		const actions = errDiv.createDiv({ cls: 'anki-embed-actions', attr: { style: 'margin-top: 14px; justify-content: center; gap: 8px; flex-wrap: wrap;' } });

		const retryBtn = actions.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Retry connection',
		});
		retryBtn.onclick = () => {
			void this.loadCards();
		};

		if (this.isLiveSync) {
			const offlineBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-secondary',
				text: 'Switch to offline mode',
			});
			offlineBtn.onclick = () => {
				this.config.live = false;
				this.hasStarted = true;
				void this.loadCards();
			};
		}

		const pickerBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: '↩ Back to deck selection',
		});
		pickerBtn.onclick = () => {
			this.resetToDeckPicker();
		};
	}

	private renderHeader(titleText?: string, showOpenAnki: boolean = false, isPicker: boolean = false) {
		const header = this.container.createDiv({ cls: 'anki-embed-header' });

		const titleContainer = header.createDiv({ cls: 'anki-embed-title' });
		let title = titleText || this.config.deck;
		if (!title && this.config.query) {
			const tagMatch = this.config.query.match(/tag:(?:"\*?|\*?)(.*?)\*?"?$/);
			if (tagMatch?.[1]) {
				const parts = tagMatch[1].split('*').filter(Boolean);
				const leaf = parts[parts.length - 1] ?? tagMatch[1];
				title = `#${leaf.replace(/_/g, ' ')}`;
			} else {
				title = this.config.query;
			}
		}
		if (!title) {
			title = 'Anki Deck';
		}
		titleContainer.createSpan({ text: title });

		const isGamepadConfigured = this.config.remote ?? this.settings.enableGamepad;
		if (isGamepadConfigured && !isPicker) {
			const badge = titleContainer.createSpan({
				cls: `anki-embed-gamepad-badge ${this.connectedGamepadName ? 'is-connected' : ''}`,
				text: this.connectedGamepadName ? '🎮 Remote connected' : '🎮 Remote',
				attr: {
					title: this.connectedGamepadName
						? `🎮 Controller: ${this.connectedGamepadName} (click to customize buttons)`
						: '🎮 Anki remote / gamepad enabled (click to test and customize buttons)',
				},
			});
			if (this.app) {
				badge.onclick = () => {
					new AnkiRemoteConfigModal(this.app!, {
						settings: this.settings,
						saveData: async (updated) => {
							this.settings = updated;
							if (this.saveSettings) {
								await this.saveSettings(updated);
							}
						},
					}).open();
				};
			}
		}

		if (this.cards.length > 0) {
			if (this.isLiveSync) {
				const liveBadge = titleContainer.createSpan({
					cls: 'anki-embed-badge anki-embed-badge-live is-clickable',
					text: '⚡ Live sync',
					attr: { title: 'Live sync with Anki desktop is on (click to switch to offline deck mode)' },
				});
				liveBadge.onclick = () => {
					this.config.live = false;
					this.hasStarted = true;
					void this.loadCards();
				};
			} else {
				const counterBadge = titleContainer.createSpan({
					cls: 'anki-embed-badge is-clickable',
					text: `${this.currentIndex + 1} / ${this.cards.length}`,
					attr: { title: 'Offline mode (click to switch to live sync with Anki desktop)' },
				});
				counterBadge.onclick = () => {
					this.config.live = true;
					this.hasStarted = true;
					void this.loadCards();
				};

				const modePill = titleContainer.createSpan({
					cls: `anki-embed-badge anki-embed-mode-pill is-clickable ${this.isLearningMode ? 'is-learning' : 'is-browse'}`,
					text: this.isLearningMode ? '🎯 Learn' : '📋 Browse',
					attr: {
						title: this.isLearningMode
							? 'Mode: Learning (Anki steps & due priority). Click to switch to browse mode, right-click to change order'
							: 'Mode: Browse (linear preview). Click to switch to learning mode',
					},
				});
				modePill.onclick = (e) => {
					e.stopPropagation();
					this.isLearningMode = !this.isLearningMode;
					new Notice(this.isLearningMode ? 'Switched to learning mode (Anki steps & due priority)' : 'Switched to browse mode (linear review)');
					void this.loadCards();
				};
				modePill.addEventListener('contextmenu', (e: MouseEvent) => {
					e.preventDefault();
					e.stopPropagation();
					const menu = new Menu();
					const currentOrder = this.config.learningOrder ?? this.settings.learningOrder ?? 'due-new-future';
					menu.addItem((item) => {
						item.setTitle('Due > new > future reviews')
							.setChecked(currentOrder === 'due-new-future')
							.onClick(() => {
								this.config.learningOrder = 'due-new-future';
								new Notice('Learning order: Due > new > future reviews');
								void this.loadCards();
							});
					});
					menu.addItem((item) => {
						item.setTitle('Due > future reviews > new')
							.setChecked(currentOrder === 'due-future-new')
							.onClick(() => {
								this.config.learningOrder = 'due-future-new';
								new Notice('Learning order: Due > future reviews > new');
								void this.loadCards();
							});
					});
					menu.showAtMouseEvent(e);
				});
			}

			const shouldShowTimer = this.config.timer ?? this.settings.enableCardTimer;
			if (shouldShowTimer && !isPicker) {
				const warningSec = this.config.timerWarning ?? this.settings.timerWarningSeconds;
				const limitSec = this.config.timerLimit ?? this.settings.timerLimitSeconds;
				const timerPill = titleContainer.createDiv({
					cls: `anki-embed-timer-pill ${this.isTimerPaused ? 'is-paused' : 'is-normal'}`,
					attr: {
						title: this.isTimerPaused
							? 'Timer paused (click to resume)'
							: `Card timer: Warning at ${warningSec}s, Limit at ${limitSec}s (click to pause)`,
					},
				});
				const clockEl = timerPill.createSpan({ cls: 'anki-timer-clock', text: this.isTimerPaused ? '⏸️' : '⏱️' });
				const elapsedSoFar = this.getCardElapsedSec();
				const timerTextEl = timerPill.createSpan({
					cls: 'anki-timer-seconds',
					text: `${elapsedSoFar.toFixed(1)}s`,
				});
				const streakEl = timerPill.createSpan({
					cls: 'anki-timer-streak',
					text: `⚡ ${this.timeStreak}`,
					attr: { title: `Time limit streak: ${this.timeStreak} cards in a row under limit` },
				});

				timerPill.onclick = () => {
					this.toggleTimerPause(timerPill, clockEl, timerTextEl, streakEl);
				};

				this.startCardTimer(timerPill, clockEl, timerTextEl, streakEl);
			}

			const shouldShowLinks = this.config.links ?? this.settings.enableCardLinks;
			if (!isPicker && this.cards.length > 0 && shouldShowLinks) {
				const currentCard = this.cards[this.currentIndex];
				if (currentCard) {
					this.renderLinksButton(titleContainer, currentCard);
				}
			}
		}

		const actions = header.createDiv({ cls: 'anki-embed-actions' });

		if (isPicker) {
			const refreshBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '🔄 Refresh',
				attr: { title: 'Refresh decks from Anki' },
			});
			refreshBtn.onclick = () => {
				void this.renderDeckPicker();
			};

			const syncBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '☁️ sync',
				attr: { title: 'Sync with ankiweb' },
			});
			syncBtn.onclick = async () => {
				const originalText = syncBtn.textContent;
				syncBtn.textContent = '⏳';
				syncBtn.disabled = true;
				try {
					await this.client.sync();
					new Notice('Anki sync complete');
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Anki sync failed: ${msg}`);
				} finally {
					syncBtn.textContent = originalText;
					syncBtn.disabled = false;
				}
			};

			if (this.onOpenFullView && !this.isFullView) {
				const fullViewBtn = actions.createEl('button', {
					cls: 'anki-embed-btn-icon',
					text: '⛶',
					attr: { title: 'Open in full editor view' },
				});
				fullViewBtn.onclick = () => {
					this.onOpenFullView?.(this.config);
				};
			}
			return;
		}

		if (!this.hasStarted) {
			const refreshBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '🔄',
				attr: { title: 'Refresh cards from Anki' },
			});
			refreshBtn.onclick = () => {
				void this.loadCards();
			};

			const syncBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '☁️',
				attr: { title: 'Sync with ankiweb' },
			});
			syncBtn.onclick = async () => {
				const originalText = syncBtn.textContent;
				syncBtn.textContent = '⏳';
				syncBtn.disabled = true;
				try {
					await this.client.sync();
					new Notice('Anki sync complete');
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Anki sync failed: ${msg}`);
				} finally {
					syncBtn.textContent = originalText;
					syncBtn.disabled = false;
				}
			};

			const pickerBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '↩',
				attr: { title: 'Back to deck selection' },
			});
			pickerBtn.onclick = () => {
				this.resetToDeckPicker();
			};

			if (this.onOpenFullView && !this.isFullView) {
				const fullViewBtn = actions.createEl('button', {
					cls: 'anki-embed-btn-icon',
					text: '⛶',
					attr: { title: 'Open in full editor view' },
				});
				fullViewBtn.onclick = () => {
					this.onOpenFullView?.(this.config);
				};
			}
			return;
		}

		// When actively reviewing: keep only high-frequency compact icon buttons
		if (this.cards.length > 0 || this.reviewHistory.length > 0) {
			const undoBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon anki-embed-undo-btn',
				text: '↩️',
				attr: { title: 'Undo last review (z)' },
			});
			undoBtn.onclick = () => {
				void this.undoLastCard();
			};
		}

		if (this.cards.length > 0) {
			const currentCard = this.cards[this.currentIndex];
			if (currentCard) {
				const isFlagged = (currentCard.flags ?? 0) > 0;
				const flagBtn = actions.createEl('button', {
					cls: `anki-embed-btn-icon anki-embed-btn-flag ${isFlagged ? 'is-flagged' : ''}`,
					text: isFlagged ? '🚩' : '🏳️',
					attr: { title: isFlagged ? 'Remove flag from card (f)' : 'Flag card (f)' },
				});
				flagBtn.onclick = () => {
					void this.toggleFlagCurrentCard();
				};
			}
		}

		const syncBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-icon anki-embed-btn-sync',
			text: '☁️',
			attr: { title: 'Sync with Anki' },
		});
		syncBtn.onclick = async () => {
			const originalText = syncBtn.textContent;
			syncBtn.textContent = '⏳';
			syncBtn.disabled = true;
			try {
				await this.client.sync();
				new Notice('Anki sync complete');
				const activeDeck = this.config.deck || this.cards[0]?.deckName;
				if (activeDeck) {
					void this.updateCounts(activeDeck);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`Anki sync failed: ${msg}`);
			} finally {
				syncBtn.textContent = originalText;
				syncBtn.disabled = false;
			}
		};

		const decksBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-icon anki-embed-btn-decks',
			text: '📚',
			attr: { title: 'Back to deck selection' },
		});
		decksBtn.onclick = () => {
			this.resetToDeckPicker();
		};

		if (this.onOpenFullView && !this.isFullView) {
			const fullViewBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '⛶',
				attr: { title: 'Open in full editor view' },
			});
			fullViewBtn.onclick = () => {
				this.onOpenFullView?.(this.config);
			};
		}

		if (this.cards.length > 0 && this.cards[this.currentIndex]) {
			const currentCard = this.cards[this.currentIndex];
			const moreBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '⋯',
				attr: { title: 'More options and actions' },
			});
			moreBtn.onclick = (evt: MouseEvent) => {
				if (currentCard) {
					this.showCardContextMenu(evt, currentCard);
				}
			};
		}
	}

	private async openDeckInAnki(): Promise<void> {
		const deckToOpen = this.config.deck || (this.cards[0]?.deckName);
		if (deckToOpen) {
			try {
				await this.client.guiDeckReview(deckToOpen);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`Could not open deck in Anki: ${msg}`);
			}
		}
	}

	private async getResolvedMediaFragment(html: string): Promise<DocumentFragment> {
		if (!/<(?:img|source)\b/i.test(html)) {
			return sanitizeHTMLToDom(html);
		}

		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		const mediaElements = Array.from(doc.body.querySelectorAll('img, source'));
		
		const fetchPromises = mediaElements.map(async (element, index) => {
			const originalTitle = element.getAttribute('title');
			const originalAlt = element.getAttribute('alt');
			element.setAttribute('title', `anki-media-${index}`);
			
			const srcset = element.getAttribute('srcset');
			const source = element.getAttribute('src')?.trim() ??
				srcset?.split(',')[0]?.trim().split(/\s+/)[0];
			
			if (!source || /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')) {
				return { index, dataUrl: null, originalTitle, originalAlt };
			}

			let filename: string;
			try {
				const encodedFilename = source.split(/[?#]/, 1)[0];
				if (!encodedFilename) return { index, dataUrl: null, originalTitle, originalAlt };
				filename = decodeURIComponent(encodedFilename).replace(/^\.\/+/, '');
			} catch {
				return { index, dataUrl: null, originalTitle, originalAlt };
			}

			let mediaData = this.mediaCache.get(filename);
			if (mediaData === undefined) {
				try {
					const result = await this.client.retrieveMediaFile(filename);
					mediaData = result || null;
				} catch {
					mediaData = null;
				}
				this.mediaCache.set(filename, mediaData);
			}

			if (mediaData) {
				const dataUrl = mediaData.startsWith('data:')
					? mediaData
					: `data:${this.getMediaMimeType(filename)};base64,${mediaData}`;
				return { index, dataUrl, originalTitle, originalAlt };
			}
			
			return { index, dataUrl: null, originalTitle, originalAlt };
		});

		const results = await Promise.all(fetchPromises);
		
		const fragment = sanitizeHTMLToDom(doc.body.innerHTML);

		for (const res of results) {
			const el = fragment.querySelector(`[title="anki-media-${res.index}"]`);
			if (el) {
				if (res.originalTitle !== null) {
					el.setAttribute('title', res.originalTitle);
				} else {
					el.removeAttribute('title');
				}

				if (res.dataUrl) {
					el.setAttribute('src', res.dataUrl);
					el.removeAttribute('srcset');
				} else if (res.originalAlt) {
					el.replaceWith(document.createTextNode(res.originalAlt));
				} else {
					el.remove();
				}
			}
		}

		return fragment;
	}

	private getMediaMimeType(filename: string): string {
		const extension = filename.split('.').pop()?.toLowerCase();
		const mimeTypes: Record<string, string> = {
			avif: 'image/avif',
			bmp: 'image/bmp',
			gif: 'image/gif',
			jpeg: 'image/jpeg',
			jpg: 'image/jpeg',
			ico: 'image/x-icon',
			png: 'image/png',
			svg: 'image/svg+xml',
			tif: 'image/tiff',
			tiff: 'image/tiff',
			webp: 'image/webp',
		};
		return mimeTypes[extension ?? ''] ?? 'application/octet-stream';
	}

	private async getCardCss(card: AnkiCardInfo): Promise<string> {
		if (card.css && card.css.trim().length > 0) {
			return card.css;
		}
		if (!card.modelName) {
			return '';
		}
		if (this.modelStyleCache.has(card.modelName)) {
			return this.modelStyleCache.get(card.modelName) ?? '';
		}
		try {
			const styling = await this.client.getModelStyling(card.modelName);
			const css = styling?.css ?? '';
			this.modelStyleCache.set(card.modelName, css);
			return css;
		} catch {
			this.modelStyleCache.set(card.modelName, '');
			return '';
		}
	}

	private async getNormalizedCardCss(card: AnkiCardInfo): Promise<string> {
		const key = card.modelName || (card.css ? `custom-${card.cardId}` : '');
		if (key && this.normalizedStyleCache.has(key)) {
			return this.normalizedStyleCache.get(key) ?? '';
		}
		const rawCss = await this.getCardCss(card);
		const normalizedCss = normalizeAnkiCss(rawCss);
		if (key) {
			this.normalizedStyleCache.set(key, normalizedCss);
		}
		return normalizedCss;
	}

	private async getQuestionFragment(card: AnkiCardInfo): Promise<DocumentFragment> {
		const cached = this.preparedQuestionCache.get(card.cardId);
		if (cached) {
			this.preparedQuestionCache.delete(card.cardId);
			return cached.cloneNode(true) as DocumentFragment;
		}
		return await this.getResolvedMediaFragment(formatCardHtml(card.question));
	}

	private async getAnswerFragment(card: AnkiCardInfo): Promise<DocumentFragment> {
		const cached = this.preparedAnswerCache.get(card.cardId);
		if (cached) {
			this.preparedAnswerCache.delete(card.cardId);
			return cached.cloneNode(true) as DocumentFragment;
		}
		const isCloze = isClozeCard(card);
		const answerHtml = isCloze
			? formatCardHtml(card.answer, card.question)
			: extractAnswerHtml(formatCardHtml(card.answer, card.question));
		return await this.getResolvedMediaFragment(answerHtml);
	}

	private prepareAnswerFragment(card: AnkiCardInfo): void {
		if (this.preparedAnswerCache.has(card.cardId)) return;
		window.setTimeout(() => {
			void (async () => {
				try {
					const isCloze = isClozeCard(card);
					const answerHtml = isCloze
						? formatCardHtml(card.answer, card.question)
						: extractAnswerHtml(formatCardHtml(card.answer, card.question));
					const frag = await this.getResolvedMediaFragment(answerHtml);
					this.preparedAnswerCache.set(card.cardId, frag);
				} catch {
					// Background pre-resolve is non-fatal
				}
			})();
		}, 0);
	}

	private preparseNextCard(): void {
		if (this.isLiveSync || this.currentIndex + 1 >= this.cards.length) return;
		const nextCard = this.cards[this.currentIndex + 1];
		if (!nextCard || this.preparedQuestionCache.has(nextCard.cardId)) return;
		window.setTimeout(() => {
			void (async () => {
				try {
					void this.getNormalizedCardCss(nextCard);
					const frag = await this.getResolvedMediaFragment(formatCardHtml(nextCard.question));
					this.preparedQuestionCache.set(nextCard.cardId, frag);
				} catch {
					// Background pre-parse failure is non-fatal
				}
			})();
		}, 30);
	}

	private updateFlagButton(card?: AnkiCardInfo): void {
		const targetCard = card ?? this.cards[this.currentIndex];
		if (!targetCard) return;
		const isFlagged = (targetCard.flags ?? 0) > 0;
		const flagBtn = this.container.querySelector('.anki-embed-btn-flag');
		if (flagBtn) {
			if (isFlagged) {
				flagBtn.addClass('is-flagged');
				flagBtn.textContent = '🚩';
				flagBtn.setAttribute('title', 'Remove flag from card (f)');
			} else {
				flagBtn.removeClass('is-flagged');
				flagBtn.textContent = '🏳️';
				flagBtn.setAttribute('title', 'Flag card (f)');
			}
		}
	}

	private updateCountsDisplay(card?: AnkiCardInfo): void {
		if (!this.footerEl) return;
		const currentCard = card ?? this.cards[this.currentIndex];
		const statusPill = this.footerEl.querySelector<HTMLElement>('.anki-embed-status-pill');
		if (statusPill && currentCard && !this.isLiveSync) {
			const status = this.getCardStatusPill(currentCard);
			statusPill.className = `anki-embed-status-pill ${status.cls}`;
			statusPill.textContent = status.label;
			statusPill.setAttribute('title', status.title);
		}

		const shouldShowCounts = this.config.counts ?? this.settings.showCardCounts;
		if (!shouldShowCounts) return;
		const counts = this.currentCounts ?? this.calculateSessionCounts();
		const newEl = this.footerEl.querySelector('.anki-count-new');
		if (newEl) {
			newEl.textContent = String(counts.new);
			newEl.setAttribute('title', `${counts.new} new cards`);
		}
		const learnEl = this.footerEl.querySelector('.anki-count-learn');
		if (learnEl) {
			learnEl.textContent = String(counts.learn);
			learnEl.setAttribute('title', `${counts.learn} learning/relearning cards`);
		}
		const reviewEl = this.footerEl.querySelector('.anki-count-review');
		if (reviewEl) {
			reviewEl.textContent = String(counts.review);
			reviewEl.setAttribute('title', `${counts.review} review cards`);
		}
		let earlyEl = this.footerEl.querySelector<HTMLElement>('.anki-count-early');
		if (counts.early && counts.early > 0) {
			if (!earlyEl) {
				const countsContainer = this.footerEl.querySelector('.anki-embed-counts');
				if (countsContainer) {
					countsContainer.createSpan({ cls: 'anki-count-sep', text: '+' });
					earlyEl = countsContainer.createSpan({ cls: 'anki-count-early' });
				}
			}
			if (earlyEl) {
				earlyEl.textContent = String(counts.early);
				earlyEl.setAttribute('title', `${counts.early} future review cards (early)`);
			}
		} else if (earlyEl) {
			earlyEl.previousElementSibling?.remove();
			earlyEl.remove();
		}
	}

	private restartCardTimerIfActive(): void {
		if (!this.headerEl) return;
		const timerPill = this.headerEl.querySelector<HTMLElement>('.anki-embed-timer-pill');
		if (!timerPill) return;
		const clockEl = timerPill.querySelector<HTMLElement>('.anki-timer-clock');
		const timerTextEl = timerPill.querySelector<HTMLElement>('.anki-timer-seconds');
		const streakEl = timerPill.querySelector<HTMLElement>('.anki-timer-streak');
		if (clockEl && timerTextEl && streakEl) {
			timerPill.removeClass('is-warning');
			timerPill.removeClass('is-overtime');
			timerPill.removeClass('is-paused');
			timerPill.addClass('is-normal');
			clockEl.setText('⏱️');
			timerTextEl.setText('0.0s');
			streakEl.setText(`⚡ ${this.timeStreak}`);
			this.startCardTimer(timerPill, clockEl, timerTextEl, streakEl);
		}
	}

	private async renderCardContent(card: AnkiCardInfo, cardContainer: HTMLElement): Promise<void> {
		const isCloze = isClozeCard(card);
		if (!this.showingAnswer) {
			cardContainer.empty();
			const qDiv = cardContainer.createDiv({ cls: 'anki-embed-question' });
			const qFragment = await this.getQuestionFragment(card);
			qDiv.appendChild(qFragment);
			this.prepareAnswerFragment(card);
		} else if (isCloze) {
			cardContainer.empty();
			const aDiv = cardContainer.createDiv({ cls: 'anki-embed-answer anki-embed-cloze-answer' });
			const aFragment = await this.getAnswerFragment(card);
			aDiv.appendChild(aFragment);
		} else {
			let qDiv = cardContainer.querySelector<HTMLElement>('.anki-embed-question');
			if (!qDiv) {
				cardContainer.empty();
				qDiv = cardContainer.createDiv({ cls: 'anki-embed-question' });
				const qFragment = await this.getQuestionFragment(card);
				qDiv.appendChild(qFragment);
			}
			if (!cardContainer.querySelector('.anki-embed-answer')) {
				cardContainer.createEl('hr', { cls: 'anki-embed-separator' });
				const aDiv = cardContainer.createDiv({ cls: 'anki-embed-answer' });
				const aFragment = await this.getAnswerFragment(card);
				aDiv.appendChild(aFragment);
			}
		}
	}

	private async renderCardInLightDom(cardEl: HTMLElement, card: AnkiCardInfo): Promise<void> {
		cardEl.addClass('card');
		const fontScale = this.config.fontScale ?? this.config.scale ?? this.config.fontSize ?? this.settings.cardFontScale ?? 1.0;
		if (fontScale !== 1) {
			cardEl.style.setProperty('--anki-card-zoom', String(fontScale));
		}
		await this.renderCardContent(card, cardEl);
	}

	private renderFooterControls(controlsContainer: HTMLElement, card: AnkiCardInfo): void {
		controlsContainer.empty();
		if (!this.showingAnswer) {
			const flipBtn = controlsContainer.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: 'Show answer',
			});
			flipBtn.onclick = () => { void this.revealAnswer(); };

			const hint = controlsContainer.createDiv({ cls: 'anki-embed-shortcut-hint' });
			hint.createSpan({ text: 'Shortcut: Press Space to reveal answer' });
			hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
		} else {
			const ratings = controlsContainer.createDiv({ cls: 'anki-embed-ratings' });

			const options: Array<{ ease: 1 | 2 | 3 | 4; label: string; clsName: string; key: string }> = [
				{ ease: 1, label: 'Again', clsName: 'again', key: '1' },
				{ ease: 2, label: 'Hard', clsName: 'hard', key: '2' },
				{ ease: 3, label: 'Good', clsName: 'good', key: '3' },
				{ ease: 4, label: 'Easy', clsName: 'easy', key: '4' },
			];

			for (let i = 0; i < options.length; i++) {
				const opt = options[i];
				if (!opt) continue;
				const btn = ratings.createEl('button', {
					cls: `anki-embed-rate-btn ${opt.clsName}`,
					attr: { 'data-ease': String(opt.ease) },
				});
				btn.createSpan({ text: opt.label });
				btn.createSpan({ cls: 'anki-embed-rate-key', text: `[${opt.key}]` });
				if (card.nextReviews?.[i]) {
					btn.createSpan({ cls: 'anki-embed-rate-interval', text: card.nextReviews[i] });
				}

				btn.onclick = () => {
					void this.rateCurrentCard(opt.ease);
				};
			}

			const hint = controlsContainer.createDiv({ cls: 'anki-embed-shortcut-hint' });
			hint.createSpan({ text: 'Shortcuts: Press 1 for Again, 2 for Hard, 3 for Good, 4 for Easy' });
			hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
		}
	}

	private async renderCurrentCard() {
		this.closeActiveLinksDropdown();

		if (!this.showingAnswer) {
			this.cardStartTime = Date.now();
			this.isTimerPaused = false;
			this.timerPausedElapsedMs = 0;
			this.timerExceededForCurrentCard = false;
		}

		if (this.currentIndex >= this.cards.length) {
			this.headerEl = null;
			this.cardEl = null;
			this.footerEl = null;
			this.currentShadowRoot = null;
			this.currentCardContainer = null;
			this.currentModelName = null;
			this.currentFontScale = null;
			this.renderCompleted();
			return;
		}

		if (this.isLearningMode && !this.isLiveSync && !this.hasAcknowledgedEarlyReviews && this.currentIndex > 0) {
			const candidateCard = this.cards[this.currentIndex];
			if (candidateCard && candidateCard.queue === 2 && !this.dueCardIds.has(candidateCard.cardId)) {
				const remainingPending = this.cards.slice(this.currentIndex).filter(c => c.queue === 1 || c.queue === 3 || this.dueCardIds.has(c.cardId) || c.queue === 0);
				if (remainingPending.length === 0) {
					this.renderMilestoneScreen(this.cards.length - this.currentIndex);
					return;
				}
			}
		}

		const card = this.cards[this.currentIndex];
		if (!card) return;

		const fontScale = this.config.fontScale ?? this.config.scale ?? this.config.fontSize ?? this.settings.cardFontScale ?? 1.0;
		const shouldUseCardStyles = this.config.styles ?? this.settings.useCardStyles;

		const isLayoutMounted =
			this.headerEl !== null &&
			this.cardEl !== null &&
			this.footerEl !== null &&
			this.container.contains(this.headerEl) &&
			this.container.contains(this.cardEl) &&
			this.container.contains(this.footerEl) &&
			this.currentCardContainer !== null;

		// FAST PATH: In-place DOM update when layout is already mounted and model/styles are identical
		if (isLayoutMounted && this.currentModelName === (card.modelName ?? '') && this.currentFontScale === fontScale) {
			// Update header in-place
			if (!this.showingAnswer) {
				const badgeEl = this.headerEl!.querySelector<HTMLElement>('.anki-embed-badge:not(.anki-embed-badge-live):not(.anki-embed-mode-pill)');
				if (badgeEl) {
					badgeEl.textContent = `${this.currentIndex + 1} / ${this.cards.length}`;
				}
				const modePill = this.headerEl!.querySelector<HTMLElement>('.anki-embed-mode-pill');
				if (modePill && !this.isLiveSync) {
					modePill.className = `anki-embed-badge anki-embed-mode-pill is-clickable ${this.isLearningMode ? 'is-learning' : 'is-browse'}`;
					modePill.textContent = this.isLearningMode ? '🎯 Learn' : '📋 Browse';
					modePill.setAttribute(
						'title',
						this.isLearningMode
							? 'Mode: Learning (Anki steps & due priority). Click to switch to browse mode'
							: 'Mode: Browse (linear preview). Click to switch to learning mode'
					);
				}
				this.updateFlagButton(card);
				this.updateLinksButton();
				this.restartCardTimerIfActive();
				if (this.cardEl) {
					this.cardEl.scrollTop = 0;
				}
			}

			// Update card class (e.g. ord-based class)
			const isNightMode = typeof document !== 'undefined' && document.body.classList.contains('theme-dark');
			const ordClass = typeof card.ord === 'number' ? `card${card.ord + 1}` : '';
			this.currentCardContainer!.className = `card ${ordClass} ${isNightMode ? 'nightMode night_mode' : ''}`.trim();

			// Update card question/answer in-place
			await this.renderCardContent(card, this.currentCardContainer!);

			// Update footer controls in-place
			const controlsContainer = this.footerEl!.querySelector<HTMLElement>('.anki-embed-footer-controls');
			if (controlsContainer) {
				this.renderFooterControls(controlsContainer, card);
			}
			this.updateCountsDisplay(card);

			this.preparseNextCard();
			return;
		}

		// SLOW / INITIAL MOUNT PATH: Full build
		this.container.empty();

		this.renderHeader(card.deckName || this.config.deck, true);
		this.headerEl = this.container.querySelector<HTMLElement>('.anki-embed-header');

		const cardEl = this.container.createDiv({ cls: 'anki-embed-card' });
		this.cardEl = cardEl;
		if (this.settings.minCardHeight) {
			cardEl.style.minHeight = this.settings.minCardHeight;
		}

		if (fontScale !== 1) {
			cardEl.style.setProperty('--anki-card-zoom', String(fontScale));
		}

		cardEl.addEventListener('contextmenu', (evt: MouseEvent) => {
			const cur = this.cards[this.currentIndex];
			if (cur) {
				this.showCardContextMenu(evt, cur);
			}
		});

		this.currentModelName = card.modelName ?? '';
		this.currentFontScale = fontScale;

		if (shouldUseCardStyles && typeof cardEl.attachShadow === 'function') {
			try {
				cardEl.addClass('anki-embed-card-custom');
				const shadow = cardEl.attachShadow({ mode: 'open' });
				this.currentShadowRoot = shadow;

				const normalizedCss = await this.getNormalizedCardCss(card);

				const baseCardCss = `
:host {
	display: block;
	width: 100%;
	height: 100%;
	min-height: 0;
	margin: 0 !important;
	padding: 0 !important;
	border-radius: var(--radius-s, 6px);
	overflow-x: auto;
	overflow-y: auto;
	box-sizing: border-box;
	--anki-card-zoom: ${fontScale};
}
.card {
	background-color: var(--background-primary);
	color: var(--text-normal);
	font-family: var(--font-text);
	font-size: 1.05em;
	zoom: var(--anki-card-zoom, ${fontScale});
	line-height: 1.6;
	text-align: left;
	word-wrap: break-word;
	hyphens: auto;
	padding: ${this.isFullView ? '8px 16px' : '20px'};
	min-height: 100%;
	height: auto;
	box-sizing: border-box;
	width: 100%;
	display: flex;
	flex-direction: column;
}
.card.nightMode,
.card.night_mode {
	background-color: var(--background-primary);
	color: var(--text-normal);
}
.anki-embed-question,
.anki-embed-answer {
	width: 100%;
}
.anki-embed-answer {
	margin-top: 12px;
}
.anki-embed-separator {
	width: 80%;
	border: 0;
	height: 1px;
	background: var(--background-modifier-border);
	margin: 14px auto;
}
.cloze {
	color: var(--interactive-accent);
	font-weight: bold;
}
img {
	max-width: 100%;
	height: auto;
	border-radius: 4px;
	margin: 8px 0;
}
${normalizedCss}

.card {
	min-height: 100% !important;
	height: auto !important;
	box-sizing: border-box !important;
	margin: 0 !important;
	margin-top: 0 !important;
	margin-bottom: 0 !important;
	margin-left: 0 !important;
	margin-right: 0 !important;
	width: 100% !important;
	max-width: 100% !important;
	border-radius: var(--radius-s, 6px) !important;
}
`;
				if ('adoptedStyleSheets' in shadow && typeof CSSStyleSheet !== 'undefined') {
					const sheet = new CSSStyleSheet();
					sheet.replaceSync(baseCardCss);
					shadow.adoptedStyleSheets = [sheet];
				}

				const isNightMode = typeof document !== 'undefined' && document.body.classList.contains('theme-dark');
				const ordClass = typeof card.ord === 'number' ? `card${card.ord + 1}` : '';
				const cardContainer = (shadow as Node).createDiv({
					cls: `card ${ordClass} ${isNightMode ? 'nightMode night_mode' : ''}`.trim(),
				});
				this.currentCardContainer = cardContainer;

				cardContainer.addEventListener('contextmenu', (evt: MouseEvent) => {
					const cur = this.cards[this.currentIndex];
					if (cur) {
						this.showCardContextMenu(evt, cur);
					}
				});

				await this.renderCardContent(card, cardContainer);
			} catch {
				this.currentShadowRoot = null;
				this.currentCardContainer = cardEl;
				await this.renderCardInLightDom(cardEl, card);
			}
		} else {
			this.currentShadowRoot = null;
			this.currentCardContainer = cardEl;
			await this.renderCardInLightDom(cardEl, card);
		}

		const footer = this.container.createDiv({ cls: 'anki-embed-footer' });
		this.footerEl = footer;

		const shouldShowCounts = this.config.counts ?? this.settings.showCardCounts;
		const countsContainer = footer.createDiv({ cls: 'anki-embed-counts' });

		if (!this.isLiveSync) {
			const status = this.getCardStatusPill(card);
			countsContainer.createSpan({
				cls: `anki-embed-status-pill ${status.cls}`,
				text: status.label,
				attr: { title: status.title },
			});
			if (shouldShowCounts) {
				countsContainer.createSpan({ cls: 'anki-count-sep', text: '•' });
			}
		}

		if (shouldShowCounts) {
			const counts = this.currentCounts ?? this.calculateSessionCounts();

			const newEl = countsContainer.createSpan({ cls: 'anki-count-new', text: String(counts.new) });
			newEl.setAttribute('title', `${counts.new} new cards`);

			countsContainer.createSpan({ cls: 'anki-count-sep', text: '+' });

			const learnEl = countsContainer.createSpan({ cls: 'anki-count-learn', text: String(counts.learn) });
			learnEl.setAttribute('title', `${counts.learn} learning/relearning cards`);

			countsContainer.createSpan({ cls: 'anki-count-sep', text: '+' });

			const reviewEl = countsContainer.createSpan({ cls: 'anki-count-review', text: String(counts.review) });
			reviewEl.setAttribute('title', `${counts.review} review cards`);

			if (counts.early && counts.early > 0) {
				countsContainer.createSpan({ cls: 'anki-count-sep', text: '+' });
				const earlyEl = countsContainer.createSpan({ cls: 'anki-count-early', text: String(counts.early) });
				earlyEl.setAttribute('title', `${counts.early} future review cards (early)`);
			}
		}

		const controlsContainer = footer.createDiv({ cls: 'anki-embed-footer-controls' });
		this.renderFooterControls(controlsContainer, card);

		if (!this.isFullView) {
			const resetRow = footer.createDiv({ cls: 'anki-embed-reset-row' });
			const resetBtn = resetRow.createEl('button', {
				cls: 'anki-embed-btn-link',
				text: '↩ Back to deck selection',
				attr: { title: 'Reset view and back to deck selection' },
			});
			resetBtn.onclick = () => {
				this.resetToDeckPicker();
			};
		}

		this.preparseNextCard();
	}

	private async revealAnswer() {
		this.showingAnswer = true;
		if (this.isLiveSync) {
			this.lastUserActionTimestamp = Date.now();
			void this.client.guiShowAnswer().catch(() => {});
		}
		await this.renderCurrentCard();
	}

	private async rateCurrentCard(ease: 1 | 2 | 3 | 4): Promise<void> {
		const isFlashEnabled = this.config.flash ?? this.settings.enableRatingFlash;
		if (isFlashEnabled) {
			const targetBtn = this.container.querySelector<HTMLElement>(`.anki-embed-rate-btn[data-ease="${ease}"]`);
			if (targetBtn) {
				const transitionMs = this.config.flashTransition ?? this.settings.ratingFlashTransitionMs;
				targetBtn.style.setProperty('--anki-flash-transition', `${transitionMs}ms`);
				targetBtn.addClass('is-flashing');
				const durationMs = this.config.flashDuration ?? this.settings.ratingFlashDurationMs;
				if (durationMs > 0) {
					window.setTimeout(() => {
						targetBtn.removeClass('is-flashing');
					}, durationMs);
				}
			}
		}

		const timeTaken = this.isTimerPaused
			? this.timerPausedElapsedMs
			: (this.cardStartTime > 0 ? Date.now() - this.cardStartTime : undefined);
		const limitSec = this.config.timerLimit ?? this.settings.timerLimitSeconds;
		const prevTimeStreak = this.timeStreak;

		if (timeTaken !== undefined) {
			const timeTakenSec = timeTaken / 1000;
			if (!this.timerExceededForCurrentCard && timeTakenSec <= limitSec) {
				this.timeStreak++;
			} else {
				this.timeStreak = 0;
			}
		}
		this.stopCardTimer();
		this.cardStartTime = 0;
		this.isTimerPaused = false;
		this.timerPausedElapsedMs = 0;

		if (ease === 1) this.sessionStats.again++;
		else if (ease === 2) this.sessionStats.hard++;
		else if (ease === 3) this.sessionStats.good++;
		else if (ease === 4) this.sessionStats.easy++;

		const card = this.cards[this.currentIndex];
		if (card) {
			this.reviewHistory.push({
				card,
				index: this.currentIndex,
				statsDelta: ease,
				timeStreakBefore: prevTimeStreak,
			});
		}

		if (this.isLiveSync) {
			this.isReviewingLiveCard = true;
			this.lastUserActionTimestamp = Date.now();
			try {
				if (!this.showingAnswer) {
					await this.client.guiShowAnswer();
				}
				const nextCard = await this.client.guiAnswerAndCurrentCard(ease);
				this.showingAnswer = false;
				if (nextCard) {
					this.cards = [nextCard];
					this.currentIndex = 0;
					await this.renderCurrentCard();
					window.setTimeout(() => {
						void this.updateCounts(nextCard.deckName || this.config.deck);
					}, 20);
				} else {
					this.cards = [];
					this.renderCompleted();
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.toLowerCase().includes('not currently active')) {
					this.cards = [];
					this.renderCompleted();
				} else {
					this.renderError(msg);
				}
			} finally {
				this.isReviewingLiveCard = false;
			}
			return;
		}

		if (card) {
			const timeParam = this.settings.useCustomAnkiConnect ? timeTaken : undefined;
			if (this.isLearningMode && !this.isLiveSync) {
				try {
					await this.client.answerCard(card.cardId, ease, timeParam);
					const updatedList = await this.client.getCardsInfo([card.cardId]);
					const updated = updatedList[0];
					if (updated && (updated.queue === 1 || updated.queue === 3)) {
						// Re-insert into queue with automatic no-waiting buffer
						const remaining = this.cards.length - (this.currentIndex + 1);
						const offset = Math.min(3, remaining);
						const insertIdx = this.currentIndex + 1 + offset;
						this.cards.splice(insertIdx, 0, updated);
					}
				} catch (err: unknown) {
					console.warn('Failed to record learning answer in Anki:', err);
				}
			} else {
				void this.client.answerCard(card.cardId, ease, timeParam).catch((err) => {
					console.warn('Failed to record card answer in Anki:', err);
				});
			}
		}

		this.currentIndex++;
		this.showingAnswer = false;
		const activeDeck = card?.deckName || this.config.deck;
		void this.updateCounts(activeDeck);
		await this.renderCurrentCard();
	}

	private cleanHtmlToMarkdown(html: string): string {
		if (!html) return '';

		// Strip scripts, styles, tag containers, hints, and ankihub elements
		let md = html
			.replace(/<style[\s\S]*?<\/style>/gi, '')
			.replace(/<script[\s\S]*?<\/script>/gi, '')
			.replace(/<(?:div|span)\b[^>]*\b(?:id|class)\s*=\s*["']?[^"']*(?:tag|ankihub|hint|button|menu|reveal|toggle)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|span)>/gi, '')
			.replace(/<a\b[^>]*\bclass\s*=\s*["']?hint["'][^>]*>[\s\S]*?<\/a>/gi, '');

		// Format basic HTML tags to Markdown
		md = md
			.replace(/<(?:b|strong)\b[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, '**$1**')
			.replace(/<(?:i|em)\b[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, '*$1*')
			.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, '_$1_')
			.replace(/<sup\b[^>]*>([\s\S]*?)<\/sup>/gi, '$1')
			.replace(/<sub\b[^>]*>([\s\S]*?)<\/sub>/gi, '$1')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/p>/gi, '\n\n')
			.replace(/<p\b[^>]*>/gi, '')
			.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
			.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n');

		// Remove any remaining HTML tags
		md = md.replace(/<[^>]+>/g, '');

		// Decode common HTML entities
		md = md
			.replace(/&nbsp;/gi, ' ')
			.replace(/&amp;/gi, '&')
			.replace(/&lt;/gi, '<')
			.replace(/&gt;/gi, '>')
			.replace(/&quot;/gi, '"')
			.replace(/&#39;/gi, "'")
			.replace(/&times;/gi, '×')
			.replace(/&#8618;/gi, '↪');

		// Strip AnKing pseudo-fields, button text, and tag clutter lines
		md = md
			.replace(/PSEUDO-FIELD[^\n]*/gi, '')
			.replace(/Watch\s+[^\n]*/gi, '')
			.replace(/View Note on AnkiHub/gi, '')
			.replace(/Reveal Next/gi, '')
			.replace(/Toggle All/gi, '')
			.replace(/obsidian_exported[^\n]*/gi, '')
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
			.replace(/#AK_[^\s<>]+/g, '')
			.replace(/#[\w/:-]{6,}/g, '');

		return md
			.split('\n')
			.map(line => line.trim())
			.filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
			.join('\n')
			.trim();
	}

	private renderClozeContent(text: string, targetOrd: number, isAnswer: boolean): string {
		const targetIndex = targetOrd + 1;
		const clozeRegex = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

		return text.replace(clozeRegex, (_match: string, numStr: string, answerText: string, hintText?: string): string => {
			const num = Number.parseInt(numStr, 10);
			if (num === targetIndex) {
				if (isAnswer) {
					return `**${(answerText ?? '').trim()}**`;
				} else {
					return hintText ? `**[${hintText.trim()}]**` : '**[...]**';
				}
			} else {
				return (answerText ?? '').trim();
			}
		});
	}

	private extractTagsFromCard(card: AnkiCardInfo): string[] {
		const cleanedTags = new Set<string>();

		if (card.tags && Array.isArray(card.tags)) {
			for (const t of card.tags) {
				const clean = normalizeAnkiTag(t);
				if (clean) cleanedTags.add(clean);
			}
		}

		const cached = this.cardTagsCache.get(card.cardId);
		if (cached && Array.isArray(cached)) {
			for (const t of cached) {
				const clean = normalizeAnkiTag(t);
				if (clean) cleanedTags.add(clean);
			}
		}

		const raw = `${card.question} ${card.answer}`;
		const tagMatches = raw.match(/#AK_[A-Za-z0-9_:#&/.-]+/g) || [];

		for (const tag of tagMatches) {
			const clean = tag.replace(/^#+/, '').replace(/::#+/g, '::').trim();
			if (clean.length > 3) {
				cleanedTags.add(clean);
			}
		}

		return Array.from(cleanedTags);
	}

	public getCardTagsSync(cardId: number, card?: AnkiCardInfo): string[] {
		const c = card || this.cards.find((item) => item.cardId === cardId);
		if (!c) {
			return this.cardTagsCache.get(cardId) ?? [];
		}
		const tags = this.extractTagsFromCard(c);
		if (tags.length > 0) {
			this.cardTagsCache.set(cardId, tags);
		}
		return tags;
	}

	public async ensureCardTagsLoaded(cardId: number, card?: AnkiCardInfo): Promise<string[]> {
		const syncTags = this.getCardTagsSync(cardId, card);
		if (syncTags.length > 0) return syncTags;

		try {
			const res = await this.client.getCardsInfo([cardId]);
			if (res && res[0]?.tags && Array.isArray(res[0].tags)) {
				const fetched = res[0].tags.map((t) => normalizeAnkiTag(t)).filter(Boolean);
				if (fetched.length > 0) {
					this.cardTagsCache.set(cardId, fetched);
					const currentCard = this.cards.find((c) => c.cardId === cardId);
					if (currentCard) {
						currentCard.tags = res[0].tags;
					}
					return fetched;
				}
			}
		} catch {
			// Ignore network or connection error
		}
		return syncTags;
	}

	private extractCardContent(card: AnkiCardInfo): {
		question: string;
		answer: string;
		extra?: string;
		lectureNotes?: string;
		missedQuestions?: string;
	} {
		// 1. If Cloze card with Text field
		if (card.fields?.Text?.value) {
			const ord = card.ord ?? 0;
			const rawText = card.fields.Text.value;
			const qCloze = this.renderClozeContent(rawText, ord, false);
			const aCloze = this.renderClozeContent(rawText, ord, true);

			const extraVal = card.fields.Extra?.value ? this.cleanHtmlToMarkdown(card.fields.Extra.value) : undefined;
			const lectureVal = card.fields['Lecture Notes']?.value ? this.cleanHtmlToMarkdown(card.fields['Lecture Notes'].value) : undefined;
			const missedVal = card.fields['Missed Questions']?.value ? this.cleanHtmlToMarkdown(card.fields['Missed Questions'].value) : undefined;

			return {
				question: this.cleanHtmlToMarkdown(qCloze),
				answer: this.cleanHtmlToMarkdown(aCloze),
				extra: extraVal || undefined,
				lectureNotes: lectureVal || undefined,
				missedQuestions: missedVal || undefined,
			};
		}

		// 2. If Basic card with Front and Back fields
		if (card.fields?.Front?.value && card.fields?.Back?.value) {
			const extraVal = card.fields.Extra?.value ? this.cleanHtmlToMarkdown(card.fields.Extra.value) : undefined;
			return {
				question: this.cleanHtmlToMarkdown(card.fields.Front.value),
				answer: this.cleanHtmlToMarkdown(card.fields.Back.value),
				extra: extraVal || undefined,
			};
		}

		// 3. Fallback to parsing card.question and card.answer HTML
		const rawQuestion = card.question || '';
		let rawAnswer = card.answer || '';

		const answerMarker = /<hr\b[^>]*\bid\s*=\s*["']?answer["']?[^>]*>/i;
		const marker = rawAnswer.match(answerMarker);
		if (marker && marker.index !== undefined) {
			rawAnswer = rawAnswer.slice(marker.index + marker[0].length);
		}

		return {
			question: this.cleanHtmlToMarkdown(rawQuestion),
			answer: this.cleanHtmlToMarkdown(rawAnswer),
		};
	}

	private generateCleanTitle(questionText: string, cardId: number, maxLen: number = 0): string {
		const clean = questionText
			.replace(/\*\*\[\.\.\.\]\*\*/g, '')
			.replace(/\[\.\.\.\]/g, '')
			.replace(/[*_#^[\]()]/g, ' ')
			.replace(/[\\/:*?"<>|]/g, '')
			.replace(/\s+/g, ' ')
			.trim();

		if (!clean) return `Anki Card ${cardId}`;
		if (maxLen > 0 && clean.length > maxLen) {
			const slice = clean.slice(0, maxLen);
			const lastSpace = slice.lastIndexOf(' ');
			return lastSpace > maxLen / 2 ? slice.slice(0, lastSpace).trim() : slice.trim();
		}
		return clean;
	}

	private generateCleanFileTitle(titleText: string, cardId: number, maxLen: number = 200): string {
		let clean = titleText
			.replace(/\*\*\[\.\.\.\]\*\*/g, '[...]')
			.replace(/[*\\/:?"<>|#^]/g, '')
			.replace(/\s+/g, ' ')
			.trim();

		if (!clean) return `Anki Card ${cardId}`;
		if (maxLen > 0 && clean.length > maxLen) {
			const slice = clean.slice(0, maxLen);
			const lastSpace = slice.lastIndexOf(' ');
			return lastSpace > maxLen / 2 ? slice.slice(0, lastSpace).trim() : slice.trim();
		}
		return clean;
	}

	private showCardContextMenu(evt: MouseEvent, card: AnkiCardInfo) {
		evt.preventDefault();
		evt.stopPropagation();

		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle(this.isLiveSync ? 'Switch to offline mode' : 'Switch to live sync mode')
				.setIcon(this.isLiveSync ? 'zap-off' : 'zap')
				.onClick(() => {
					this.config.live = !this.isLiveSync;
					this.hasStarted = true;
					void this.loadCards();
				});
		});

		menu.addItem((item) => {
			item.setTitle('Back to deck selection')
				.setIcon('corner-up-left')
				.onClick(() => {
					this.resetToDeckPicker();
				});
		});

		menu.addItem((item) => {
			item.setTitle('Refresh cards from Anki')
				.setIcon('refresh-cw')
				.onClick(() => {
					void this.loadCards();
				});
		});

		menu.addItem((item) => {
			item.setTitle('Sync with ankiweb')
				.setIcon('cloud')
				.onClick(async () => {
					try {
						await this.client.sync();
						new Notice('Anki sync complete');
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`Anki sync failed: ${msg}`);
					}
				});
		});

		menu.addItem((item) => {
			item.setTitle('Open deck in Anki review')
				.setIcon('play')
				.onClick(() => {
					void this.openDeckInAnki();
				});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle('Copy card ID')
				.setIcon('copy')
				.onClick(() => {
					void navigator.clipboard.writeText(String(card.cardId)).then(() => {
						new Notice(`Copied card ID (${card.cardId}) to clipboard`);
					});
				});
		});

		const rawTitle = card.fields?.Front?.value || card.fields?.Text?.value || card.question || `Card ${card.cardId}`;
		const plainTitle = this.generateCleanTitle(this.cleanHtmlToMarkdown(rawTitle), card.cardId);

		menu.addItem((item) => {
			item.setTitle('Copy link to card')
				.setIcon('link')
				.onClick(() => {
					const link = `[Anki: ${plainTitle}](obsidian://anki-card?cardId=${card.cardId})`;
					void navigator.clipboard.writeText(link).then(() => {
						new Notice('Copied card link to clipboard');
					});
				});
		});

		menu.addItem((item) => {
			item.setTitle('Copy card embed code')
				.setIcon('code')
				.onClick(() => {
					const code = `\`\`\`anki\ncard: ${card.cardId}\n\`\`\``;
					void navigator.clipboard.writeText(code).then(() => {
						new Notice('Copied card embed codeblock to clipboard');
					});
				});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle('Append card to daily or target note')
				.setIcon('file-text')
				.onClick(() => {
					void this.appendCardToNote(card);
				});
		});

		menu.addItem((item) => {
			item.setTitle('Create Obsidian note from card')
				.setIcon('file-plus')
				.onClick(() => {
					void this.createNoteFromCard(card);
				});
		});

		const shouldShowLinks = this.config.links ?? this.settings.enableCardLinks;
		if (shouldShowLinks) {
			menu.addItem((item) => {
				item.setTitle('Linked notes and backlinks')
					.setIcon('link')
					.onClick(() => {
						const btn = this.container.querySelector<HTMLElement>('.anki-embed-links-btn');
						this.openCardLinksDropdown(btn ?? this.container, card);
					});
			});
		}

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle('Undo last review')
				.setIcon('undo')
				.onClick(() => {
					void this.undoLastCard();
				});
		});

		menu.addItem((item) => {
			const isFlagged = (card.flags ?? 0) > 0;
			item.setTitle(isFlagged ? 'Remove flag' : 'Flag card')
				.setIcon('flag')
				.onClick(() => {
					void this.toggleFlagCurrentCard();
				});
		});

		menu.addItem((item) => {
			item.setTitle('Suspend card')
				.setIcon('pause')
				.onClick(() => {
					void this.suspendCurrentCard();
				});
		});

		menu.addItem((item) => {
			item.setTitle('Bury card')
				.setIcon('archive')
				.onClick(() => {
					void this.buryCurrentCard();
				});
		});

		menu.addItem((item) => {
			item.setTitle('Customize remote controls')
				.setIcon('sliders')
				.onClick(() => {
					if (this.app) {
						new AnkiRemoteConfigModal(this.app, {
							settings: this.settings,
							saveData: async (updated) => {
								this.settings = updated;
								if (this.saveSettings) {
									await this.saveSettings(updated);
								}
							},
						}).open();
					}
				});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle('Open card in Anki desktop browser')
				.setIcon('external-link')
				.onClick(() => {
					void this.client.guiBrowse(`cid:${card.cardId}`);
				});
		});

		menu.showAtMouseEvent(evt);
	}

	private async createNoteFromCard(card: AnkiCardInfo): Promise<void> {
		if (!this.app) {
			new Notice('Cannot create note: Obsidian app reference not available.');
			return;
		}

		try {
			const content = this.extractCardContent(card);
			const isCloze = isClozeCard(card);
			const title = isCloze
				? formatClozeTitle(content.question, { card, placeholder: '**[...]**' })
				: this.generateCleanTitle(content.question, card.cardId);
			const fileTitle = this.generateCleanFileTitle(title, card.cardId, 200);

			const folderSetting = (this.settings.cardExportFolder || '').trim().replace(/^\/+|\/+$/g, '');
			let folderPrefix = '';
			if (folderSetting) {
				folderPrefix = `${folderSetting}/`;
				const parts = folderSetting.split('/');
				let currentPath = '';
				for (const part of parts) {
					currentPath = currentPath ? `${currentPath}/${part}` : part;
					if (!this.app.vault.getAbstractFileByPath(currentPath)) {
						await this.app.vault.createFolder(currentPath);
					}
				}
			}

			let filename = `${folderPrefix}${fileTitle}.md`;
			let counter = 1;
			while (this.app.vault.getAbstractFileByPath(filename)) {
				filename = `${folderPrefix}${fileTitle} (${counter}).md`;
				counter++;
			}

			const deckName = card.deckName || this.config.deck || 'Anki';
			const tags = this.extractTagsFromCard(card);

			let answerBody = content.answer;
			if (content.extra) {
				answerBody += `\n\n> [!info] Extra\n> ${content.extra.split('\n').join('\n> ')}`;
			}
			if (content.lectureNotes) {
				answerBody += `\n\n> [!note] Lecture Notes\n> ${content.lectureNotes.split('\n').join('\n> ')}`;
			}
			if (content.missedQuestions) {
				answerBody += `\n\n> [!warning] Missed Questions\n> ${content.missedQuestions.split('\n').join('\n> ')}`;
			}

			let tagsSection = '';
			if (tags.length > 0) {
				tagsSection = `\n---\n\n## Tags\n${tags.map(t => `- \`${t}\``).join('\n')}\n`;
			}

			const shouldAutoLink = this.settings.autoLinkExportedCard ?? true;
			const ankiCardsBlock = shouldAutoLink
				? `linked-cards:\n  - "${card.cardId}"\nanki-card-id: "${card.cardId}"\nanki-note-id: ${card.note ?? ''}`
				: `anki-note-id: ${card.note ?? ''}`;

			const noteContent = `---
${ankiCardsBlock}
deck: "${deckName}"
tags:
  - anki
---

# ${title}

## Question
${content.question}

## Answer
${answerBody}

## Personal Notes


---

## Card Details
- **Deck**: ${deckName}
- **Card ID**: \`${card.cardId}\`
- [▶️ Review this card in Anki Embed](obsidian://anki-card?cardId=${card.cardId})

\`\`\`anki
card: ${card.cardId}
\`\`\`
${tagsSection}`;

			const file = await this.app.vault.create(filename, noteContent);
			new Notice(`Created note: ${file.basename}`);
			if (shouldAutoLink) {
				await this.linkNoteToCard(file, card.cardId);
			}

			const leaf = this.app.workspace.getLeaf('tab');
			await leaf.openFile(file);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to create note: ${msg}`);
		}
	}

	private async appendCardToNote(card: AnkiCardInfo): Promise<void> {
		if (!this.app) {
			new Notice('Cannot append card: Obsidian app reference not available.');
			return;
		}

		try {
			const content = this.extractCardContent(card);
			const title = this.generateCleanTitle(content.question, card.cardId);

			let targetPath = '';
			const appendTarget = this.settings.cardAppendTarget ?? 'daily';

			if (appendTarget === 'daily') {
				const internalPlugins = (this.app as unknown as { internalPlugins?: { plugins?: Record<string, { instance?: { options?: { format?: string; folder?: string } } }> } }).internalPlugins;
				const dailyNotesPlugin = internalPlugins?.plugins?.['daily-notes'];
				const dailyOptions = dailyNotesPlugin?.instance?.options;
				const momentFn = (window as unknown as { moment?: (date?: Date) => { format: (fmt: string) => string } }).moment;
				let dateStr = '';
				if (typeof momentFn === 'function') {
					dateStr = momentFn().format(dailyOptions?.format || 'YYYY-MM-DD');
				} else {
					const now = new Date();
					const y = now.getFullYear();
					const m = String(now.getMonth() + 1).padStart(2, '0');
					const d = String(now.getDate()).padStart(2, '0');
					dateStr = `${y}-${m}-${d}`;
				}
				const folder = (dailyOptions?.folder || '').trim().replace(/\/+$/, '');
				targetPath = folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`;
			} else {
				targetPath = (this.settings.cardAppendCustomPath || 'Anki Notes.md').trim();
				if (!targetPath.endsWith('.md')) {
					targetPath += '.md';
				}
			}

			// Clean, single collapsible callout with question for the title and the answer underneath
			const cleanQuestionTitle = content.question.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim() || title;
			const answerLines = content.answer.trim().split('\n').map((l) => `> ${l}`).join('\n');
			const shouldAutoLink = this.settings.autoLinkExportedCard ?? true;
			const cardSnippet = `> [!question]- ${cleanQuestionTitle}\n${answerLines}\n> [Anki Card](obsidian://anki-card?cardId=${card.cardId})\n`;

			const heading = (this.settings.cardAppendHeading || '## Anki Reviews').trim();

			const targetFile = this.app.vault.getAbstractFileByPath(targetPath);
			if (!targetFile) {
				const lastSlash = targetPath.lastIndexOf('/');
				if (lastSlash > 0) {
					const folderPath = targetPath.slice(0, lastSlash);
					if (!this.app.vault.getAbstractFileByPath(folderPath)) {
						await this.app.vault.createFolder(folderPath);
					}
				}
				const initialContent = heading ? `${heading}\n\n${cardSnippet}\n` : `${cardSnippet}\n`;
				const created = await this.app.vault.create(targetPath, initialContent);
				if (shouldAutoLink && created instanceof TFile) {
					await this.linkNoteToCard(created, card.cardId);
				}
				new Notice(`Appended card to ${targetPath}`);
				return;
			}

			if (targetFile instanceof TFile) {
				const existingContent = await this.app.vault.read(targetFile);
				let newContent = '';

				if (heading && existingContent.includes(heading)) {
					const headingIdx = existingContent.indexOf(heading);
					const afterHeading = headingIdx + heading.length;
					newContent = existingContent.slice(0, afterHeading) + '\n\n' + cardSnippet + existingContent.slice(afterHeading);
				} else if (heading) {
					newContent = existingContent.trimEnd() + '\n\n' + heading + '\n\n' + cardSnippet + '\n';
				} else {
					newContent = existingContent.trimEnd() + '\n\n' + cardSnippet + '\n';
				}

				await this.app.vault.modify(targetFile, newContent);
				if (shouldAutoLink) {
					await this.linkNoteToCard(targetFile, card.cardId);
				}
				new Notice(`Appended card to ${targetFile.basename}`);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to append card: ${msg}`);
		}
	}

	public findLinkedNotes(cardId: number, skipFullVaultScan = false): CardLinkedNotes<TFile> {
		const cached = this.linkedNotesCache.get(cardId);
		if (cached && !skipFullVaultScan) {
			return cached;
		}

		const explicit: TFile[] = [];
		const backlinks: TFile[] = [];
		const tagLinks: CardTagLink<TFile>[] = [];
		if (!this.app) return { explicit, backlinks, tagLinks };

		const cardIdStr = String(cardId);
		const seenPaths = new Set<string>();

		// 1. Explicit links stored in settings.cardLinks (instant O(1))
		const explicitPaths = this.settings.cardLinks?.[cardIdStr] ?? [];
		const validExplicitPaths: string[] = [];
		for (const path of explicitPaths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const cache = this.app.metadataCache.getFileCache(file);
				// If note has frontmatter properties but card was removed, prune from settings
				if (cache?.frontmatter && !checkFrontmatterForCardId(cache.frontmatter, cardIdStr)) {
					continue;
				}
				explicit.push(file);
				seenPaths.add(file.path);
				validExplicitPaths.push(path);
			}
		}
		if (validExplicitPaths.length !== explicitPaths.length && this.settings.cardLinks) {
			if (validExplicitPaths.length > 0) {
				this.settings.cardLinks[cardIdStr] = validExplicitPaths;
			} else {
				delete this.settings.cardLinks[cardIdStr];
			}
			if (this.saveSettings) {
				void this.saveSettings(this.settings);
			}
		}

		// 2. Fast check of metadataCache frontmatter & tags
		const files = this.app.vault.getMarkdownFiles();
		const shouldScanBacklinks = (this.config.backlinks ?? this.settings.enableBacklinks) && (this.config.links ?? this.settings.enableCardLinks);
		const shouldScanTagLinks = (this.config.tagLinks ?? this.settings.enableTagLinks) && (this.config.links ?? this.settings.enableCardLinks);
		const targetUri1 = `cardId=${cardIdStr}`;
		const targetUri2 = `card=${cardIdStr}`;
		const targetCid = `cid:${cardIdStr}`;

		const card = this.cards.find((c) => c.cardId === cardId);
		const cardTags = shouldScanTagLinks ? this.getCardTagsSync(cardId, card) : [];

		for (const file of files) {
			if (seenPaths.has(file.path)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;

			if (cache.frontmatter) {
				const fm = cache.frontmatter as Record<string, unknown>;
				if (checkFrontmatterForCardId(fm, cardIdStr)) {
					explicit.push(file);
					seenPaths.add(file.path);
					continue;
				}
			}

			// Tag-based note linking
			if (shouldScanTagLinks && cardTags.length > 0) {
				const noteTags = extractAnkiTagsFromNote(cache);
				const matchedTag = findMatchingAnkiTag(cardTags, noteTags);
				if (matchedTag) {
					tagLinks.push({ file, matchedTag });
					seenPaths.add(file.path);
					continue;
				}
			}

			if (!shouldScanBacklinks) continue;

			// Backlinks check from metadataCache
			let isBacklink = false;
			if (cache.links) {
				for (const l of cache.links) {
					if (l.link.includes(targetUri1) || l.link.includes(targetUri2) || l.link.includes(targetCid)) {
						isBacklink = true;
						break;
					}
				}
			}

			if (!isBacklink && cache.embeds) {
				for (const e of cache.embeds) {
					if (e.link.includes(targetUri1) || e.link.includes(targetUri2) || e.link.includes(targetCid)) {
						isBacklink = true;
						break;
					}
				}
			}

			if (!isBacklink && cache.frontmatterLinks) {
				for (const f of cache.frontmatterLinks) {
					if (f.link.includes(targetUri1) || f.link.includes(targetUri2) || f.link.includes(targetCid)) {
						isBacklink = true;
						break;
					}
				}
			}

			if (isBacklink) {
				backlinks.push(file);
				seenPaths.add(file.path);
			}
		}

		const result: CardLinkedNotes<TFile> = { explicit, backlinks, tagLinks };
		this.linkedNotesCache.set(cardId, result);
		return result;
	}

	public async scanVaultForCard(cardId: number): Promise<CardLinkedNotes<TFile>> {
		if (!this.app) return { explicit: [], backlinks: [], tagLinks: [] };

		const shouldScanBacklinks = (this.config.backlinks ?? this.settings.enableBacklinks) && (this.config.links ?? this.settings.enableCardLinks);
		const shouldScanTagLinks = (this.config.tagLinks ?? this.settings.enableTagLinks) && (this.config.links ?? this.settings.enableCardLinks);
		if (!shouldScanBacklinks && !shouldScanTagLinks) {
			return this.findLinkedNotes(cardId, true);
		}

		const card = this.cards.find((c) => c.cardId === cardId);
		let cardTags: string[] = [];
		if (shouldScanTagLinks) {
			cardTags = await this.ensureCardTagsLoaded(cardId, card);
		}

		// Start with existing cached or fast frontmatter check
		const initial = this.findLinkedNotes(cardId, true);
		const explicit: TFile[] = [...initial.explicit];
		const backlinks: TFile[] = [...initial.backlinks];
		const tagLinks: CardTagLink<TFile>[] = [...initial.tagLinks];
		const seenPaths = new Set<string>([
			...explicit.map((f) => f.path),
			...backlinks.map((f) => f.path),
			...tagLinks.map((t) => t.file.path),
		]);

		const cardIdStr = String(cardId);
		const files = this.app.vault.getMarkdownFiles();
		const cardRegex = new RegExp(`(?:^|\\n)\\s*card(?:Id)?:\\s*${cardIdStr}\\b`);
		const uriRegex = new RegExp(`obsidian:\\/\\/(?:anki-card|anki-embed)\\?[^)\\s]*cardId=${cardIdStr}\\b`);

		for (const file of files) {
			if (seenPaths.has(file.path)) continue;

			// Check frontmatter first
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter) {
				const fm = cache.frontmatter as Record<string, unknown>;
				if (checkFrontmatterForCardId(fm, cardIdStr)) {
					explicit.push(file);
					seenPaths.add(file.path);
					continue;
				}
			}

			// Check tags from cache
			if (shouldScanTagLinks && cardTags.length > 0 && cache) {
				const noteTags = extractAnkiTagsFromNote(cache);
				const matchedTag = findMatchingAnkiTag(cardTags, noteTags);
				if (matchedTag) {
					tagLinks.push({ file, matchedTag });
					seenPaths.add(file.path);
					continue;
				}
			}

			// Read note body to discover backlinks (URI scheme, markdown codeblocks, cid references) or inline tags
			try {
				const content = await this.app.vault.cachedRead(file);

				// Check tag matches in content
				if (shouldScanTagLinks && cardTags.length > 0 && (content.includes('anki-tag') || content.includes('#anki'))) {
					const textTags = extractAnkiTagsFromText(content);
					const matchedTag = findMatchingAnkiTag(cardTags, textTags);
					if (matchedTag) {
						tagLinks.push({ file, matchedTag });
						seenPaths.add(file.path);
						continue;
					}
				}

				if (shouldScanBacklinks && content.includes(cardIdStr)) {
					const isTargetMatch =
						content.includes(`cardId=${cardIdStr}`) ||
						content.includes(`card=${cardIdStr}`) ||
						content.includes(`cid:${cardIdStr}`) ||
						content.includes(`cid=${cardIdStr}`) ||
						cardRegex.test(content) ||
						uriRegex.test(content);

					if (isTargetMatch) {
						backlinks.push(file);
						seenPaths.add(file.path);
					}
				}
			} catch {
				// Ignore read error
			}
		}

		const result: CardLinkedNotes<TFile> = { explicit, backlinks, tagLinks };
		this.linkedNotesCache.set(cardId, result);
		return result;
	}

	public async linkNoteToCard(file: TFile, cardId: number): Promise<void> {
		this.linkedNotesCache.delete(cardId);
		await linkCardToNote(this.app, file, cardId, this.settings, this.saveSettings);
		new Notice(`Linked "${file.basename}" to Anki card`);
		this.updateLinksButton();
	}

	public async linkTagToNote(file: TFile, tag: string, cardId?: number): Promise<void> {
		if (!this.app) return;
		try {
			await linkTagToNote(this.app, file, tag);
			new Notice(`Linked Anki tag "${tag}" to "${file.basename}"`);
			if (cardId !== undefined) {
				this.linkedNotesCache.delete(cardId);
				this.updateLinksButton();
			} else {
				this.linkedNotesCache.clear();
				this.updateLinksButton();
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to link tag: ${msg}`);
		}
	}

	public async unlinkNoteFromCard(file: TFile, cardId: number): Promise<void> {
		this.linkedNotesCache.delete(cardId);
		await unlinkCardFromNote(this.app, file, cardId, this.settings, this.saveSettings);
		new Notice(`Unlinked "${file.basename}" from Anki card`);
		this.updateLinksButton();
	}

	public invalidateLinksCache(cardId?: number): void {
		if (cardId !== undefined) {
			this.linkedNotesCache.delete(cardId);
		} else {
			this.linkedNotesCache.clear();
		}
		this.updateLinksButton();
	}

	public async linkActiveNote(cardId: number): Promise<void> {
		if (!this.app) return;
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active note to link.');
			return;
		}
		await this.linkNoteToCard(activeFile, cardId);
	}

	public async unlinkActiveNote(cardId: number): Promise<void> {
		if (!this.app) return;
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			new Notice('No active note to unlink.');
			return;
		}
		await this.unlinkNoteFromCard(activeFile, cardId);
	}

	private renderLinksButton(container: HTMLElement, card: AnkiCardInfo): HTMLElement {
		const btn = container.createDiv({ cls: 'anki-embed-links-btn is-empty' });
		const cardId = card.cardId;
		const cached = this.linkedNotesCache.get(cardId);

		const applyCount = (total: number, explicitCount: number, backlinkCount: number, tagLinkCount: number) => {
			btn.empty();
			if (total > 0) {
				btn.removeClass('is-empty');
				btn.addClass('is-linked');
				btn.createSpan({ text: '🔗' });
				btn.createSpan({ text: String(total) });
				const parts: string[] = [];
				if (explicitCount > 0) parts.push(`${explicitCount} linked`);
				if (tagLinkCount > 0) parts.push(`${tagLinkCount} tagged`);
				if (backlinkCount > 0) parts.push(`${backlinkCount} backlink(s)`);
				btn.setAttribute('title', `${parts.join(', ')} (click to view)`);
			} else {
				btn.removeClass('is-linked');
				btn.addClass('is-empty');
				btn.createSpan({ text: '🔗' });
				btn.createSpan({ text: '0' });
				btn.setAttribute('title', 'No linked notes (click to link note)');
			}
		};

		if (cached) {
			const total = cached.explicit.length + cached.backlinks.length + cached.tagLinks.length;
			applyCount(total, cached.explicit.length, cached.backlinks.length, cached.tagLinks.length);
		} else {
			// Fast path: instant frontmatter + settings.cardLinks + fast metadata tags (0ms)
			const fast = this.findLinkedNotes(cardId, true);
			const quickTotal = fast.explicit.length + fast.backlinks.length + fast.tagLinks.length;
			applyCount(quickTotal, fast.explicit.length, fast.backlinks.length, fast.tagLinks.length);

			// Background ensure card tags loaded if not yet present + vault scan
			window.setTimeout(() => {
				if (!this.container.isConnected) return;
				void this.ensureCardTagsLoaded(cardId, card).then(() => {
					void this.scanVaultForCard(cardId).then((res) => {
						const newTotal = res.explicit.length + res.backlinks.length + res.tagLinks.length;
						if (newTotal !== quickTotal) {
							this.updateLinksButton();
						}
					});
				});
			}, 40);
		}

		btn.onclick = (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			const activeCard = this.cards[this.currentIndex] || card;
			if (activeCard) {
				this.openCardLinksDropdown(btn, activeCard);
			}
		};

		return btn;
	}

	private updateLinksButton(): void {
		const btn = this.container.querySelector<HTMLElement>('.anki-embed-links-btn');
		const currentCard = this.cards[this.currentIndex];
		if (!btn || !currentCard) return;

		const { explicit, backlinks, tagLinks } = this.findLinkedNotes(currentCard.cardId);
		const total = explicit.length + backlinks.length + tagLinks.length;

		btn.onclick = (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			const activeCard = this.cards[this.currentIndex] || currentCard;
			if (activeCard) {
				this.openCardLinksDropdown(btn, activeCard);
			}
		};

		btn.empty();
		if (total > 0) {
			btn.removeClass('is-empty');
			btn.addClass('is-linked');
			btn.createSpan({ text: '🔗' });
			btn.createSpan({ text: String(total) });
			const parts: string[] = [];
			if (explicit.length > 0) parts.push(`${explicit.length} linked`);
			if (tagLinks.length > 0) parts.push(`${tagLinks.length} tagged`);
			if (backlinks.length > 0) parts.push(`${backlinks.length} backlink(s)`);
			btn.setAttribute('title', `${parts.join(', ')} (click to view)`);
		} else {
			btn.removeClass('is-linked');
			btn.addClass('is-empty');
			btn.createSpan({ text: '🔗' });
			btn.createSpan({ text: '0' });
			btn.setAttribute('title', 'No linked notes (click to link note)');
		}
	}

	public closeActiveLinksDropdown = (): void => {
		if (this.activeLinksDropdown) {
			this.activeLinksDropdown.remove();
			this.activeLinksDropdown = null;
		}
		if (this.linksDropdownCleanup) {
			this.linksDropdownCleanup();
			this.linksDropdownCleanup = null;
		}
	};

	private openCardLinksDropdown(anchorBtn: HTMLElement, card?: AnkiCardInfo): void {
		if (this.activeLinksDropdown) {
			this.closeActiveLinksDropdown();
			return;
		}

		const activeCard = this.cards[this.currentIndex] || card;
		if (!activeCard) return;

		const dropdown = document.body.createDiv({ cls: 'anki-links-dropdown' });
		this.activeLinksDropdown = dropdown;

		const updateDropdownPosition = () => {
			const rect = anchorBtn.getBoundingClientRect();
			const dropdownWidth = 340;
			let left = rect.left;
			if (left + dropdownWidth > window.innerWidth - 12) {
				left = Math.max(12, window.innerWidth - dropdownWidth - 12);
			}
			let top = rect.bottom + 6;
			if (top + 380 > window.innerHeight - 12) {
				top = Math.max(12, rect.top - 386);
			}
			dropdown.style.left = `${left}px`;
			dropdown.style.top = `${top}px`;
		};
		updateDropdownPosition();

		const openNote = (file: TFile) => {
			this.closeActiveLinksDropdown();
			const leaf = this.app?.workspace.getLeaf('tab') || this.app?.workspace.getLeaf();
			if (leaf) {
				void leaf.openFile(file).then(() => {
					this.app?.workspace.setActiveLeaf(leaf, { focus: true });
				});
			}
		};

		const renderDropdownContent = () => {
			dropdown.empty();

			const currentActive = this.cards[this.currentIndex] || activeCard;
			const { explicit, backlinks, tagLinks } = this.findLinkedNotes(currentActive.cardId);
			const total = explicit.length + backlinks.length + tagLinks.length;

			// Header
			const header = dropdown.createDiv({ cls: 'anki-links-dropdown-header' });
			const titleBox = header.createDiv({ cls: 'anki-links-dropdown-title' });
			titleBox.createSpan({ text: '🔗' });
			titleBox.createSpan({ text: 'Linked Notes', cls: 'anki-links-title-text' });
			titleBox.createSpan({ cls: 'anki-links-count-badge', text: String(total) });

			const closeBtn = header.createEl('button', {
				cls: 'anki-links-close-btn',
				text: '✕',
				attr: { title: 'Close menu' },
			});
			closeBtn.onclick = (e) => {
				e.stopPropagation();
				this.closeActiveLinksDropdown();
			};

			const body = dropdown.createDiv({ cls: 'anki-links-dropdown-body' });

			// Show card's Anki tags if present (with 1-click copy or link to active note!)
			const cardTags = this.getCardTagsSync(currentActive.cardId, currentActive);
			if (cardTags.length > 0) {
				const tagsContainer = body.createDiv({ cls: 'anki-links-card-tags' });
				tagsContainer.createSpan({ cls: 'anki-links-card-tags-label', text: 'Card tags:' });
				const tagsList = tagsContainer.createDiv({ cls: 'anki-links-card-tags-list' });
				const activeNote = this.app?.workspace.getActiveFile();
				for (const tag of cardTags) {
					const pill = tagsList.createSpan({ cls: 'anki-links-card-tag-pill', text: tag });
					if (activeNote) {
						pill.setAttribute('title', `Click to link "${tag}" to active note "${activeNote.basename}"`);
					} else {
						pill.setAttribute('title', `Click to copy "anki-tags: [${tag}]" for your note`);
					}
					pill.onclick = async (e) => {
						e.stopPropagation();
						const currentNote = this.app?.workspace.getActiveFile();
						if (currentNote) {
							await this.linkTagToNote(currentNote, tag, currentActive.cardId);
							renderDropdownContent();
						} else {
							void navigator.clipboard.writeText(`anki-tags: ["${tag}"]`).then(() => {
								new Notice(`Copied "anki-tags: ["${tag}"]" to clipboard`);
							});
						}
					};
				}
			}

			// If no links at all
			if (total === 0) {
				const emptyBox = body.createDiv({ cls: 'anki-links-empty' });
				emptyBox.setText('No linked notes or backlinks for this card yet.');
			}

			// 1. Explicitly linked notes section
			if (explicit.length > 0) {
				const explicitHeader = body.createDiv({ cls: 'anki-links-section-header' });
				explicitHeader.setText(`Directly Linked Notes (${explicit.length})`);

				const explicitList = body.createDiv({ cls: 'anki-links-list' });
				for (const file of explicit) {
					const row = explicitList.createDiv({
						cls: 'anki-links-row',
						attr: { title: `Click to open "${file.basename}"` },
					});
					const contentBox = row.createDiv({ cls: 'anki-links-row-content' });
					contentBox.createSpan({ cls: 'anki-links-file-icon', text: '📄' });

					const textBox = contentBox.createDiv({ cls: 'anki-links-text-block' });
					textBox.createSpan({ cls: 'anki-links-file-title', text: file.basename });
					const folder = file.parent ? file.parent.path : '';
					if (folder && folder !== '/') {
						textBox.createSpan({ cls: 'anki-links-file-path', text: folder });
					}

					const actionGroup = row.createDiv({ cls: 'anki-links-row-actions' });
					const openBtn = actionGroup.createEl('button', {
						cls: 'anki-links-open-btn',
						text: 'Open ↗',
						attr: { title: `Open "${file.basename}"` },
					});
					openBtn.onclick = (e) => {
						e.stopPropagation();
						openNote(file);
					};

					const unlinkBtn = actionGroup.createEl('button', {
						cls: 'anki-links-unlink-btn',
						text: '✕',
						attr: { title: `Unlink "${file.basename}"` },
					});
					unlinkBtn.onclick = async (e) => {
						e.stopPropagation();
						await this.unlinkNoteFromCard(file, currentActive.cardId);
						renderDropdownContent();
					};

					row.onclick = () => openNote(file);
				}
			}

			// 2. Tagged notes section
			const shouldShowTagLinks = (this.config.tagLinks ?? this.settings.enableTagLinks) && (this.config.links ?? this.settings.enableCardLinks);
			if (shouldShowTagLinks && tagLinks.length > 0) {
				const tagHeader = body.createDiv({ cls: 'anki-links-section-header' });
				tagHeader.setText(`Tagged Notes (${tagLinks.length})`);

				const tagList = body.createDiv({ cls: 'anki-links-list' });
				for (const item of tagLinks) {
					const file = item.file;
					const row = tagList.createDiv({
						cls: 'anki-links-row is-tag-link',
						attr: { title: `Click to open "${file.basename}" (matched tag: ${item.matchedTag})` },
					});
					const contentBox = row.createDiv({ cls: 'anki-links-row-content' });
					contentBox.createSpan({ cls: 'anki-links-file-icon', text: '🏷️' });

					const textBox = contentBox.createDiv({ cls: 'anki-links-text-block' });
					textBox.createSpan({ cls: 'anki-links-file-title', text: file.basename });
					const folder = file.parent ? file.parent.path : '';
					if (folder && folder !== '/') {
						textBox.createSpan({ cls: 'anki-links-file-path', text: folder });
					}

					const actionGroup = row.createDiv({ cls: 'anki-links-row-actions' });
					actionGroup.createSpan({ cls: 'anki-links-tag-badge', text: `🏷️ ${item.matchedTag}` });
					const openBtn = actionGroup.createEl('button', {
						cls: 'anki-links-open-btn',
						text: 'Open ↗',
						attr: { title: `Open "${file.basename}"` },
					});
					openBtn.onclick = (e) => {
						e.stopPropagation();
						openNote(file);
					};

					row.onclick = () => openNote(file);
				}
			}

			// 3. Backlinks section
			const shouldShowBacklinks = (this.config.backlinks ?? this.settings.enableBacklinks) && (this.config.links ?? this.settings.enableCardLinks);
			if (shouldShowBacklinks && backlinks.length > 0) {
				const backlinkHeader = body.createDiv({ cls: 'anki-links-section-header' });
				backlinkHeader.setText(`Backlinks in Vault (${backlinks.length})`);

				const backlinkList = body.createDiv({ cls: 'anki-links-list' });
				for (const file of backlinks) {
					const row = backlinkList.createDiv({
						cls: 'anki-links-row is-backlink',
						attr: { title: `Click to open "${file.basename}"` },
					});
					const contentBox = row.createDiv({ cls: 'anki-links-row-content' });
					contentBox.createSpan({ cls: 'anki-links-file-icon', text: '🔗' });

					const textBox = contentBox.createDiv({ cls: 'anki-links-text-block' });
					textBox.createSpan({ cls: 'anki-links-file-title', text: file.basename });
					const folder = file.parent ? file.parent.path : '';
					if (folder && folder !== '/') {
						textBox.createSpan({ cls: 'anki-links-file-path', text: folder });
					}

					const actionGroup = row.createDiv({ cls: 'anki-links-row-actions' });
					actionGroup.createSpan({ cls: 'anki-links-mention-badge', text: 'mention' });
					const openBtn = actionGroup.createEl('button', {
						cls: 'anki-links-open-btn',
						text: 'Open ↗',
						attr: { title: `Open "${file.basename}"` },
					});
					openBtn.onclick = (e) => {
						e.stopPropagation();
						openNote(file);
					};

					row.onclick = () => openNote(file);
				}
			}

			body.createDiv({ cls: 'anki-links-divider' });

			// 4. Quick Actions
			const actions = body.createDiv({ cls: 'anki-links-actions' });

			const activeFile = this.app?.workspace.getActiveFile();
			if (activeFile) {
				const isAlreadyLinked = explicit.some((f) => f.path === activeFile.path);
				const linkActiveBtn = actions.createEl('button', { cls: 'anki-links-action-btn' });
				linkActiveBtn.createSpan({ cls: 'anki-links-action-icon', text: isAlreadyLinked ? '➖' : '➕' });
				linkActiveBtn.createSpan({
					cls: 'anki-links-action-label',
					text: isAlreadyLinked ? `Unlink active (${activeFile.basename})` : `Link active note (${activeFile.basename})`,
				});
				linkActiveBtn.onclick = async () => {
					if (isAlreadyLinked) {
						await this.unlinkNoteFromCard(activeFile, currentActive.cardId);
					} else {
						await this.linkNoteToCard(activeFile, currentActive.cardId);
					}
					renderDropdownContent();
				};
			}

			const searchBtn = actions.createEl('button', { cls: 'anki-links-action-btn' });
			searchBtn.createSpan({ cls: 'anki-links-action-icon', text: '🔍' });
			searchBtn.createSpan({ cls: 'anki-links-action-label', text: 'Search vault to link note...' });
			searchBtn.onclick = () => {
				this.closeActiveLinksDropdown();
				if (this.app) {
					new NoteSelectModal(this.app, (file) => {
						void this.linkNoteToCard(file, currentActive.cardId);
					}).open();
				}
			};

			const searchTagBtn = actions.createEl('button', { cls: 'anki-links-action-btn' });
			searchTagBtn.createSpan({ cls: 'anki-links-action-icon', text: '🏷️' });
			searchTagBtn.createSpan({ cls: 'anki-links-action-label', text: 'Search Anki tags to link note...' });
			searchTagBtn.onclick = () => {
				this.closeActiveLinksDropdown();
				const cardTags = this.getCardTagsSync(currentActive.cardId, currentActive);
				if (this.app) {
					new TagSelectModal(
						this.app,
						this.client,
						(tag: string) => {
							const currentNote = this.app?.workspace.getActiveFile();
							if (currentNote) {
								void this.linkTagToNote(currentNote, tag, currentActive.cardId);
							} else {
								new NoteSelectModal(this.app!, (file) => {
									void this.linkTagToNote(file, tag, currentActive.cardId);
								}).open();
							}
						},
						cardTags
					).open();
				}
			};

			const createBtn = actions.createEl('button', { cls: 'anki-links-action-btn' });
			createBtn.createSpan({ cls: 'anki-links-action-icon', text: '📝' });
			createBtn.createSpan({ cls: 'anki-links-action-label', text: 'Create note from card & link' });
			createBtn.onclick = () => {
				this.closeActiveLinksDropdown();
				void this.createNoteFromCard(currentActive);
			};

			const copyUriBtn = actions.createEl('button', { cls: 'anki-links-action-btn' });
			copyUriBtn.createSpan({ cls: 'anki-links-action-icon', text: '📋' });
			copyUriBtn.createSpan({ cls: 'anki-links-action-label', text: 'Copy link to card' });
			copyUriBtn.onclick = () => {
				const rawTitle = currentActive.fields?.Front?.value || currentActive.fields?.Text?.value || currentActive.question || `Card ${currentActive.cardId}`;
				const plainTitle = this.generateCleanTitle(this.cleanHtmlToMarkdown(rawTitle), currentActive.cardId);
				const link = `[Anki: ${plainTitle}](obsidian://anki-card?cardId=${currentActive.cardId})`;
				void navigator.clipboard.writeText(link).then(() => {
					new Notice('Copied card link to clipboard');
				});
				this.closeActiveLinksDropdown();
			};
		};

		renderDropdownContent();

		// Trigger vault scan if not done yet to populate backlinks
		void this.scanVaultForCard(activeCard.cardId).then(() => {
			if (this.activeLinksDropdown === dropdown) {
				renderDropdownContent();
			}
		});

		// Listeners for outside click and escape
		const onDocClick = (e: MouseEvent) => {
			if (dropdown && !dropdown.contains(e.target as Node) && !anchorBtn.contains(e.target as Node)) {
				this.closeActiveLinksDropdown();
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				this.closeActiveLinksDropdown();
			}
		};

		window.setTimeout(() => {
			document.addEventListener('click', onDocClick);
			document.addEventListener('keydown', onKeyDown);
		}, 10);

		this.linksDropdownCleanup = () => {
			document.removeEventListener('click', onDocClick);
			document.removeEventListener('keydown', onKeyDown);
		};
	}

	private renderMilestoneScreen(futureCount: number): void {
		this.container.empty();
		this.renderHeader(this.config.deck);

		const completedDiv = this.container.createDiv({ cls: 'anki-embed-completed' });
		completedDiv.createDiv({
			cls: 'anki-embed-completed-icon',
			text: '🎉',
		});
		completedDiv.createEl('h3', { text: 'All due cards completed!' });
		completedDiv.createEl('p', {
			text: `You have completed all due learning, review, and new cards for this session. There are ${futureCount} future review card(s) remaining if you want to review ahead early.`,
		});

		const actions = completedDiv.createDiv({
			cls: 'anki-embed-actions',
			attr: { style: 'margin-top: 16px; justify-content: center; gap: 10px; flex-wrap: wrap;' },
		});
		const continueBtn = actions.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: `Continue early reviews (${futureCount} cards)`,
		});
		continueBtn.onclick = () => {
			this.hasAcknowledgedEarlyReviews = true;
			void this.renderCurrentCard();
		};

		const finishBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: 'Finish session',
		});
		finishBtn.onclick = () => {
			this.renderCompleted();
		};
	}

	private renderCompleted() {
		this.container.empty();
		this.renderHeader();

		const completedDiv = this.container.createDiv({ cls: 'anki-embed-completed' });
		completedDiv.createDiv({
			cls: 'anki-embed-completed-icon',
			text: '🎉',
		});
		completedDiv.createEl('h3', { text: 'Session complete!' });
		completedDiv.createEl('p', { text: `You reviewed ${this.cards.length} cards in this session.` });

		const statsGrid = completedDiv.createDiv({ cls: 'anki-embed-stats-grid' });

		const againCard = statsGrid.createDiv({ cls: 'anki-embed-stat-card' });
		againCard.createSpan({ text: 'Again' });
		againCard.createEl('strong', { text: String(this.sessionStats.again) });

		const hardCard = statsGrid.createDiv({ cls: 'anki-embed-stat-card' });
		hardCard.createSpan({ text: 'Hard' });
		hardCard.createEl('strong', { text: String(this.sessionStats.hard) });

		const goodCard = statsGrid.createDiv({ cls: 'anki-embed-stat-card' });
		goodCard.createSpan({ text: 'Good' });
		goodCard.createEl('strong', { text: String(this.sessionStats.good) });

		const easyCard = statsGrid.createDiv({ cls: 'anki-embed-stat-card' });
		easyCard.createSpan({ text: 'Easy' });
		easyCard.createEl('strong', { text: String(this.sessionStats.easy) });

		const restartBtn = completedDiv.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Review again',
		});
		restartBtn.onclick = () => {
			void this.loadCards();
		};

		const changeBtn = completedDiv.createEl('button', {
			cls: 'anki-embed-btn-secondary',
			text: '↩ Back to deck selection',
		});
		changeBtn.onclick = () => {
			this.resetToDeckPicker();
		};
	}
}
