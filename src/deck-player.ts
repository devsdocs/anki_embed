import { sanitizeHTMLToDom, Notice } from 'obsidian';
import { AnkiClient } from './anki-client';
import { extractAnswerHtml, formatCardHtml, isClozeCard, normalizeAnkiCss } from './card-html';
import { AnkiCardInfo, AnkiEmbedSettings, DeckEmbedConfig } from './types';

export class DeckPlayer {
	private container: HTMLElement;
	private config: DeckEmbedConfig;
	private client: AnkiClient;
	private settings: AnkiEmbedSettings;

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
		onDeckChange?: (deck: string) => void
	) {
		this.container = container;
		this.config = config;
		this.client = client;
		this.settings = settings;
		this.onOpenFullView = onOpenFullView;
		this.isFullView = isFullView;
		this.onDeckChange = onDeckChange;
	}

	public async init(): Promise<void> {
		this.container.empty();
		this.container.addClass('anki-embed-container');
		if (this.isFullView) {
			this.container.addClass('is-full-view');
		}
		this.container.tabIndex = 0;

		this.registerKeyboardShortcuts();
		await this.loadCards();
		if (this.isFullView) {
			this.container.focus();
		}
	}

	private registerKeyboardShortcuts() {
		this.container.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement || evt.target instanceof HTMLSelectElement) {
				return;
			}

			if (this.cards.length === 0 || this.currentIndex >= this.cards.length) {
				return;
			}

			if (!this.hasStarted) {
				if (evt.key === ' ' || evt.key === 'Enter') {
					evt.preventDefault();
					this.hasStarted = true;
					void this.renderCurrentCard();
				}
				return;
			}

			if (evt.key === ' ' || evt.key === 'Enter') {
				evt.preventDefault();
				if (!this.showingAnswer) {
					void this.revealAnswer();
				}
			} else if (this.showingAnswer && ['1', '2', '3', '4'].includes(evt.key)) {
				evt.preventDefault();
				const ease = Number.parseInt(evt.key, 10) as 1 | 2 | 3 | 4;
				void this.rateCurrentCard(ease);
			} else if (evt.key.toLowerCase() === 'r') {
				evt.preventDefault();
				void this.loadCards();
			}
		});
	}

	private buildQuery(): string {
		if (this.config.query) {
			return this.config.query;
		}

		const deckName = this.config.deck ? `deck:"${this.config.deck}"` : '';
		const filterMode = this.config.filter ?? this.settings.defaultFilter;

		let filterClause = '';
		if (filterMode === 'due') {
			filterClause = 'is:due';
		} else if (filterMode === 'new') {
			filterClause = 'is:new';
		}

		const parts = [deckName, filterClause].filter(Boolean);
		return parts.length > 0 ? parts.join(' ') : 'is:due';
	}

	public async loadCards(): Promise<void> {
		const requestId = ++this.loadRequestId;
		if (this.config.select || (!this.config.deck && !this.config.query && !this.isLiveSync)) {
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
			const query = this.buildQuery();
			const cardIds = await this.client.findCards(query);

			if (!cardIds || cardIds.length === 0) {
				if (requestId !== this.loadRequestId) return;
				this.cards = [];
				this.isLoading = false;
				this.renderEmpty();
				return;
			}

			let selectedIds = cardIds;
			const shouldRandomize = this.config.randomize ?? this.settings.randomizeCards;
			if (shouldRandomize) {
				selectedIds = [...cardIds].sort(() => Math.random() - 0.5);
			}

			const limit = this.config.limit ?? this.settings.defaultLimit;
			if (limit > 0 && selectedIds.length > limit) {
				selectedIds = selectedIds.slice(0, limit);
			}

			const cards = await this.client.getCardsInfo(selectedIds);

			if (requestId !== this.loadRequestId) return;
			this.cards = cards;
			this.isLoading = false;

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

			if (!this.hasStarted) {
				this.renderStartScreenLive(currentCard);
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

	private renderEmptyLive() {
		this.container.empty();
		this.renderHeader('Live reviewer');

		const body = this.container.createDiv({ cls: 'anki-embed-empty' });
		body.createDiv({ text: '⚡ Live sync: Anki desktop is not currently in review mode.' });

		const hint = body.createDiv({ cls: 'anki-embed-empty-hint', attr: { style: 'margin-top: 8px; font-size: 0.9em; opacity: 0.8;' } });
		hint.setText(this.config.deck
			? `Start reviewing "${this.config.deck}" in Anki or click below:`
			: 'Open a deck for review in Anki desktop to mirror it here.');

		const actions = body.createDiv({ cls: 'anki-embed-actions', attr: { style: 'margin-top: 14px; justify-content: center;' } });
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
						this.renderError(msg);
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
			void this.loadCards();
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

	public destroy(): void {
		this.stopLiveSyncWatcher();
	}

	public resetToDeckPicker(): void {
		this.stopLiveSyncWatcher();
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

	private async renderDeckPicker(requestId: number = this.loadRequestId): Promise<void> {
		this.container.empty();
		this.renderHeader('Select deck', false, true);

		const pickerDiv = this.container.createDiv({ cls: 'anki-embed-picker' });
		pickerDiv.createDiv({ cls: 'anki-embed-picker-title', text: '📚 Choose an Anki deck to review' });

		try {
			const decks = await this.client.getDeckNames();
			if (requestId !== this.loadRequestId) return;
			if (!decks || decks.length === 0) {
				pickerDiv.createDiv({ cls: 'anki-embed-empty', text: 'No decks found in Anki.' });
				return;
			}

			const searchInput = pickerDiv.createEl('input', {
				cls: 'anki-embed-search-input',
				attr: { placeholder: '🔍 Search decks...' },
			});

			const selectEl = pickerDiv.createEl('select', { cls: 'anki-embed-select' });

			const startBtn = pickerDiv.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: 'Start review',
			});

			const populateOptions = (filterText: string) => {
				selectEl.empty();
				const lower = filterText.trim().toLowerCase();
				const filtered = decks.filter(d => d.toLowerCase().includes(lower));

				if (filtered.length === 0) {
					const emptyOpt = selectEl.createEl('option', {
						value: '',
						text: 'No matching decks found',
					});
					emptyOpt.disabled = true;
					selectEl.size = 2;
					startBtn.disabled = true;
				} else {
					startBtn.disabled = false;
					for (const deck of filtered) {
						selectEl.createEl('option', { value: deck, text: deck });
					}
					selectEl.size = Math.min(8, Math.max(4, filtered.length));
					if (this.config.deck && filtered.includes(this.config.deck)) {
						selectEl.value = this.config.deck;
					} else if (filtered.length > 0) {
						selectEl.selectedIndex = 0;
					}
				}
			};

			populateOptions('');

			searchInput.oninput = () => {
				populateOptions(searchInput.value);
			};

			selectEl.ondblclick = () => {
				if (selectEl.value) {
					startBtn.click();
				}
			};

			startBtn.onclick = () => {
				const chosen = selectEl.value;
				if (chosen) {
					this.config.deck = chosen;
					this.config.select = false;
					this.hasStarted = true;
					this.onDeckChange?.(chosen);
					void this.loadCards();
				}
			};
		} catch (err: unknown) {
			if (requestId !== this.loadRequestId) return;
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(msg);
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

		const retryBtn = errDiv.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Retry connection',
		});
		retryBtn.onclick = () => {
			void this.loadCards();
		};
	}

	private renderHeader(titleText?: string, showOpenAnki: boolean = false, isPicker: boolean = false) {
		const header = this.container.createDiv({ cls: 'anki-embed-header' });

		const titleContainer = header.createDiv({ cls: 'anki-embed-title' });
		const title = titleText || this.config.deck || this.config.query || 'Anki Deck';
		titleContainer.createSpan({ text: title });

		if (this.cards.length > 0) {
			if (this.isLiveSync) {
				titleContainer.createSpan({
					cls: 'anki-embed-badge anki-embed-badge-live',
					text: '⚡ Live sync',
				});
			} else {
				titleContainer.createSpan({
					cls: 'anki-embed-badge',
					text: `${this.currentIndex + 1} / ${this.cards.length}`,
				});
			}
		}

		const actions = header.createDiv({ cls: 'anki-embed-actions' });

		if (!isPicker) {
			const liveBtn = actions.createEl('button', {
				cls: `anki-embed-btn-icon ${this.isLiveSync ? 'is-active' : ''}`,
				text: this.isLiveSync ? '⚡ Live' : '⚡ Live off',
				attr: { title: this.isLiveSync ? 'Live sync with Anki desktop is ON. Click to switch to offline deck mode.' : 'Live sync with Anki desktop is OFF. Click to turn ON.' },
			});
			liveBtn.onclick = () => {
				this.config.live = !this.isLiveSync;
				this.hasStarted = true;
				void this.loadCards();
			};
		}

		if (this.onOpenFullView && !this.isFullView) {
			const fullViewBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: 'Full view',
				attr: { title: 'Open in full editor view' },
			});
			fullViewBtn.onclick = () => {
				this.onOpenFullView?.(this.config);
			};
		}

		if (!isPicker) {
			const pickerBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '↩ Deck selection',
				attr: { title: 'Reset view and back to deck selection' },
			});
			pickerBtn.onclick = () => {
				this.resetToDeckPicker();
			};
		}

		const refreshBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-icon',
			text: '🔄 Refresh',
			attr: { title: isPicker ? 'Refresh decks from Anki' : 'Refresh cards from Anki (r)' },
		});
		refreshBtn.onclick = () => {
			if (isPicker) {
				void this.renderDeckPicker();
			} else {
				void this.loadCards();
			}
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

		if (showOpenAnki) {
			const openBtn = actions.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '↗️ Open Anki',
				attr: { title: 'Open this deck in Anki desktop app' },
			});
			openBtn.onclick = () => {
				void this.openDeckInAnki();
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
				this.renderError(msg);
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
		const timeTaken = this.cardStartTime > 0 ? Date.now() - this.cardStartTime : undefined;
		this.cardStartTime = 0;

		if (ease === 1) this.sessionStats.again++;
		else if (ease === 2) this.sessionStats.hard++;
		else if (ease === 3) this.sessionStats.good++;
		else if (ease === 4) this.sessionStats.easy++;

		const card = this.cards[this.currentIndex];

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
					await this.renderCurrentCard();
				} else {
					this.cards = [];
					this.renderCompleted();
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this.renderError(msg);
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
		await this.renderCurrentCard();
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
