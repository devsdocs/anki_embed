import { sanitizeHTMLToDom, Notice, Menu, setTooltip, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { AnkiClient } from './anki-client';
import { extractAnswerHtml, formatCardHtml, isClozeCard, normalizeAnkiCss } from './card-html';
import { AnkiRemoteConfigModal } from './remote-modal';
import {
	AnkiCardInfo,
	AnkiEmbedSettings,
	DEFAULT_GAMEPAD_MAPPING,
	DEFAULT_KEYBOARD_MAPPING,
	DeckEmbedConfig,
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
	private loadRequestId = 0;
	private cardStartTime: number = 0;
	private liveSyncTimer: number | null = null;
	private onWindowFocusHandler: (() => void) | null = null;
	private currentCounts: { new: number; learn: number; review: number } | null = null;
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

	private get isLiveSync(): boolean {
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

	private calculateSessionCounts(): { new: number; learn: number; review: number } {
		let newCount = 0;
		let learnCount = 0;
		let reviewCount = 0;

		for (let i = this.currentIndex; i < this.cards.length; i++) {
			const c = this.cards[i];
			if (!c) continue;
			const isLearn = c.queue === 1 || c.queue === 3 || c.type === 1 || c.type === 3;
			const isReview = c.queue === 2 || c.type === 2 || (c.reviews ?? c.reps ?? 0) > 0;
			if (isLearn) {
				learnCount++;
			} else if (isReview) {
				reviewCount++;
			} else {
				newCount++;
			}
		}

		return { new: newCount, learn: learnCount, review: reviewCount };
	}

	private async updateCounts(deckName?: string): Promise<void> {
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
						return;
					}
				}
			} catch {
				// Fallback to session counts on failure
			}
		}
		this.currentCounts = this.calculateSessionCounts();
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
				const cardIds = await this.client.findCards(query);

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
			if (orderMode === 'reviews-first') {
				finalCards = this.sortReviewsFirst(cards, shouldRandomize);
			} else if (shouldRandomize) {
				finalCards = [...cards].sort(() => Math.random() - 0.5);
			}

			this.cards = finalCards;
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
				if (!this.isLiveSync || this.isLoading || !this.hasStarted) return;
				if (!this.container.isConnected) {
					this.stopLiveSyncWatcher();
					return;
				}
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
						await this.updateCounts(currentCard.deckName || this.config.deck);
						await this.renderCurrentCard();
					}
				} catch {
					// Ignore
				}
			})();
		}, 1500);

		this.onWindowFocusHandler = () => {
			void (async () => {
				if (!this.isLiveSync || this.isLoading || !this.hasStarted) return;
				try {
					const currentCard = await this.client.guiCurrentCard();
					if (currentCard && currentCard.cardId !== this.cards[this.currentIndex]?.cardId) {
						this.cards = [currentCard];
						this.currentIndex = 0;
						this.showingAnswer = false;
						await this.updateCounts(currentCard.deckName || this.config.deck);
						await this.renderCurrentCard();
					}
				} catch {
					// Ignore
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
		this.stopLiveSyncWatcher();
		this.stopCardTimer();
		this.isTimerPaused = false;
		this.timerPausedElapsedMs = 0;
		this.stopGamepadLoop();
	}

	public resetToDeckPicker(): void {
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
			case 'none':
			default:
				break;
		}
	}

	private async undoLastCard(): Promise<void> {
		if (this.isLiveSync) {
			try {
				await this.client.guiUndo();
				new Notice('Undid last review in Anki');
				const nextCard = await this.client.guiCurrentCard();
				if (nextCard) {
					this.cards = [nextCard];
					this.currentIndex = 0;
					this.showingAnswer = false;
					await this.updateCounts(nextCard.deckName || this.config.deck);
					await this.renderCurrentCard();
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`Failed to undo in Anki: ${msg}`);
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
		const title = titleText || this.config.deck || this.config.query || 'Anki Deck';
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
				titleContainer.createSpan({
					cls: 'anki-embed-badge',
					text: `${this.currentIndex + 1} / ${this.cards.length}`,
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

	private async renderCardInLightDom(cardEl: HTMLElement, card: AnkiCardInfo): Promise<void> {
		cardEl.addClass('card');
		const isCloze = isClozeCard(card);

		if (!this.showingAnswer) {
			const qDiv = cardEl.createDiv({ cls: 'anki-embed-question' });
			qDiv.empty();
			const qFragment = await this.getResolvedMediaFragment(formatCardHtml(card.question));
			qDiv.appendChild(qFragment);
		} else if (isCloze) {
			const aDiv = cardEl.createDiv({ cls: 'anki-embed-answer anki-embed-cloze-answer' });
			const answerHtml = formatCardHtml(card.answer, card.question);
			const aFragment = await this.getResolvedMediaFragment(answerHtml);
			aDiv.appendChild(aFragment);
		} else {
			const qDiv = cardEl.createDiv({ cls: 'anki-embed-question' });
			const qFragment = await this.getResolvedMediaFragment(formatCardHtml(card.question));
			qDiv.appendChild(qFragment);

			cardEl.createDiv({ cls: 'anki-embed-separator' });
			const aDiv = cardEl.createDiv({ cls: 'anki-embed-answer' });
			const answerHtml = extractAnswerHtml(formatCardHtml(card.answer, card.question));
			const aFragment = await this.getResolvedMediaFragment(answerHtml);
			aDiv.appendChild(aFragment);
		}
	}

	private async renderCurrentCard() {
		this.container.empty();

		if (!this.showingAnswer) {
			this.cardStartTime = Date.now();
			this.isTimerPaused = false;
			this.timerPausedElapsedMs = 0;
			this.timerExceededForCurrentCard = false;
		}

		if (this.currentIndex >= this.cards.length) {
			this.renderCompleted();
			return;
		}

		const card = this.cards[this.currentIndex];
		if (!card) return;

		this.renderHeader(card.deckName || this.config.deck, true);

		const cardEl = this.container.createDiv({ cls: 'anki-embed-card' });
		if (this.settings.minCardHeight) {
			cardEl.style.minHeight = this.settings.minCardHeight;
		}

		cardEl.addEventListener('contextmenu', (evt: MouseEvent) => {
			this.showCardContextMenu(evt, card);
		});

		const shouldUseCardStyles = this.config.styles ?? this.settings.useCardStyles;

		if (shouldUseCardStyles && typeof cardEl.attachShadow === 'function') {
			try {
				cardEl.addClass('anki-embed-card-custom');
				const shadow = cardEl.attachShadow({ mode: 'open' });

				const rawCss = await this.getCardCss(card);
				const normalizedCss = normalizeAnkiCss(rawCss);

				const baseCardCss = `
:host {
	display: block;
	width: 100%;
	min-height: 100%;
	box-sizing: border-box;
}
.card {
	background-color: var(--background-primary);
	color: var(--text-normal);
	font-family: var(--font-text);
	font-size: 1.05em;
	line-height: 1.6;
	text-align: left;
	word-wrap: break-word;
	hyphens: auto;
	padding: 20px;
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
	animation: anki-fade-in 0.25s ease-in-out;
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
@keyframes anki-fade-in {
	from {
		opacity: 0;
		transform: translateY(4px);
	}
	to {
		opacity: 1;
		transform: translateY(0);
	}
}
${normalizedCss}

.card {
	min-height: 100% !important;
	height: auto !important;
	box-sizing: border-box !important;
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

				cardContainer.addEventListener('contextmenu', (evt: MouseEvent) => {
					this.showCardContextMenu(evt, card);
				});

				const isCloze = isClozeCard(card);

				if (!this.showingAnswer) {
					const qDiv = cardContainer.createDiv({ cls: 'anki-embed-question' });
					const qFragment = await this.getResolvedMediaFragment(formatCardHtml(card.question));
					qDiv.appendChild(qFragment);
				} else if (isCloze) {
					const aDiv = cardContainer.createDiv({ cls: 'anki-embed-answer anki-embed-cloze-answer' });
					const answerHtml = formatCardHtml(card.answer, card.question);
					const aFragment = await this.getResolvedMediaFragment(answerHtml);
					aDiv.appendChild(aFragment);
				} else {
					const qDiv = cardContainer.createDiv({ cls: 'anki-embed-question' });
					const qFragment = await this.getResolvedMediaFragment(formatCardHtml(card.question));
					qDiv.appendChild(qFragment);

					cardContainer.createEl('hr', { cls: 'anki-embed-separator' });
					const aDiv = cardContainer.createDiv({ cls: 'anki-embed-answer' });
					const answerHtml = extractAnswerHtml(formatCardHtml(card.answer, card.question));
					const aFragment = await this.getResolvedMediaFragment(answerHtml);
					aDiv.appendChild(aFragment);
				}
			} catch {
				await this.renderCardInLightDom(cardEl, card);
			}
		} else {
			await this.renderCardInLightDom(cardEl, card);
		}

		const footer = this.container.createDiv({ cls: 'anki-embed-footer' });

		const shouldShowCounts = this.config.counts ?? this.settings.showCardCounts;
		if (shouldShowCounts) {
			const counts = this.currentCounts ?? this.calculateSessionCounts();
			const countsContainer = footer.createDiv({ cls: 'anki-embed-counts' });

			const newEl = countsContainer.createSpan({ cls: 'anki-count-new', text: String(counts.new) });
			newEl.setAttribute('title', `${counts.new} new cards`);

			countsContainer.createSpan({ cls: 'anki-count-sep', text: '+' });

			const learnEl = countsContainer.createSpan({ cls: 'anki-count-learn', text: String(counts.learn) });
			learnEl.setAttribute('title', `${counts.learn} learning/relearning cards`);

			countsContainer.createSpan({ cls: 'anki-count-sep', text: '+' });

			const reviewEl = countsContainer.createSpan({ cls: 'anki-count-review', text: String(counts.review) });
			reviewEl.setAttribute('title', `${counts.review} review cards`);
		}

		if (!this.showingAnswer) {
			const flipBtn = footer.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: 'Show answer',
			});
			flipBtn.onclick = () => { void this.revealAnswer(); };

			const hint = footer.createDiv({ cls: 'anki-embed-shortcut-hint' });
			hint.createSpan({ text: 'Shortcut: Press Space to reveal answer' });
			hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
		} else {
			const ratings = footer.createDiv({ cls: 'anki-embed-ratings' });

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
				const labelText = (this.isLiveSync && card.nextReviews?.[i])
					? `${opt.label} (${card.nextReviews[i]})`
					: opt.label;
				btn.createSpan({ text: labelText });
				btn.createSpan({ cls: 'anki-embed-rate-key', text: `[${opt.key}]` });

				btn.onclick = () => {
					void this.rateCurrentCard(opt.ease);
				};
			}

			const hint = footer.createDiv({ cls: 'anki-embed-shortcut-hint' });
			hint.createSpan({ text: 'Shortcuts: Press 1 for Again, 2 for Hard, 3 for Good, 4 for Easy' });
			hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
		}

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

	private async revealAnswer() {
		this.showingAnswer = true;
		if (this.isLiveSync) {
			try {
				await this.client.guiShowAnswer();
			} catch {
				// Ignore
			}
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
					await new Promise(resolve => window.setTimeout(resolve, durationMs));
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
			try {
				await this.client.guiShowAnswer();
				await this.client.guiAnswerCard(ease);
			} catch (err) {
				console.warn('Failed to answer card in Anki GUI:', err);
			}

			this.showingAnswer = false;
			try {
				const nextCard = await this.client.guiCurrentCard();
				if (nextCard) {
					this.cards = [nextCard];
					this.currentIndex = 0;
					await this.updateCounts(nextCard.deckName || this.config.deck);
					await this.renderCurrentCard();
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
			}
			return;
		}

		if (card) {
			try {
				const timeParam = this.settings.useCustomAnkiConnect ? timeTaken : undefined;
				await this.client.answerCard(card.cardId, ease, timeParam);
			} catch (err) {
				console.warn('Failed to record card answer in Anki:', err);
			}
		}

		this.currentIndex++;
		this.showingAnswer = false;
		const activeDeck = card?.deckName || this.config.deck;
		await this.updateCounts(activeDeck);
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
		const raw = `${card.question} ${card.answer}`;
		const tagMatches = raw.match(/#AK_[A-Za-z0-9_:#&/.-]+/g) || [];
		const cleanedTags = new Set<string>();

		for (const tag of tagMatches) {
			const clean = tag.replace(/^#+/, '').replace(/::#+/g, '::').trim();
			if (clean.length > 3) {
				cleanedTags.add(clean);
			}
		}

		return Array.from(cleanedTags);
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

	private generateCleanTitle(questionText: string, cardId: number): string {
		const clean = questionText
			.replace(/\*\*\[\.\.\.\]\*\*/g, '')
			.replace(/\[\.\.\.\]/g, '')
			.replace(/[*_#^[\]()]/g, ' ')
			.replace(/[\\/:*?"<>|]/g, '')
			.replace(/\s+/g, ' ')
			.trim();

		if (!clean) return `Anki Card ${cardId}`;
		if (clean.length <= 60) return clean;

		const slice = clean.slice(0, 60);
		const lastSpace = slice.lastIndexOf(' ');
		if (lastSpace > 25) {
			return slice.slice(0, lastSpace).trim();
		}
		return slice.trim();
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
			const title = this.generateCleanTitle(content.question, card.cardId);

			let filename = `${title}.md`;
			let counter = 1;
			while (this.app.vault.getAbstractFileByPath(filename)) {
				filename = `${title} (${counter}).md`;
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

			const noteContent = `---
anki-card-id: ${card.cardId}
anki-note-id: ${card.note ?? ''}
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


${tagsSection}
---

## Card Details
- **Deck**: ${deckName}
- **Card ID**: \`${card.cardId}\`
- [▶️ Review this card in Anki Embed](obsidian://anki-card?cardId=${card.cardId})

\`\`\`anki
card: ${card.cardId}
\`\`\`
`;

			const file = await this.app.vault.create(filename, noteContent);
			new Notice(`✅ Created note: ${file.basename}`);

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

			const tagLine = tags.length > 0 ? `\n> **Tags**: ${tags.map(t => `#${t.replace(/\s+/g, '_')}`).join(' ')}` : '';
			const cardSnippet = `### ${title}\n> [!quote] Question\n> ${content.question.split('\n').join('\n> ')}\n> \n> > [!success]- Answer\n> > ${answerBody.split('\n').join('\n> > ')}${tagLine ? '\n>' + tagLine : ''}\n> \n> *Deck: ${deckName}* | [Review card in Anki Embed](obsidian://anki-card?cardId=${card.cardId})\n`;

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
				await this.app.vault.create(targetPath, initialContent);
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
				new Notice(`Appended card to ${targetFile.basename}`);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to append card: ${msg}`);
		}
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
