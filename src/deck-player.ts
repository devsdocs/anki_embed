import { sanitizeHTMLToDom, Notice } from 'obsidian';
import { AnkiClient } from './anki-client';
import { extractAnswerHtml, formatCardHtml } from './card-html';
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
	private mediaCache = new Map<string, string | null>();
	private loadRequestId = 0;

	private sessionStats = {
		again: 0,
		hard: 0,
		good: 0,
		easy: 0,
	};

	constructor(
		container: HTMLElement,
		config: DeckEmbedConfig,
		client: AnkiClient,
		settings: AnkiEmbedSettings
	) {
		this.container = container;
		this.config = config;
		this.client = client;
		this.settings = settings;
	}

	public async init(): Promise<void> {
		this.container.empty();
		this.container.addClass('anki-embed-container');
		this.container.tabIndex = 0;

		this.registerKeyboardShortcuts();
		await this.loadCards();
	}

	private registerKeyboardShortcuts() {
		this.container.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement || evt.target instanceof HTMLSelectElement) {
				return;
			}

			if (this.cards.length === 0 || this.currentIndex >= this.cards.length) {
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
		if (this.config.select || (!this.config.deck && !this.config.query)) {
			await this.renderDeckPicker(requestId);
			return;
		}

		this.isLoading = true;
		this.showingAnswer = false;
		this.currentIndex = 0;
		this.sessionStats = { again: 0, hard: 0, good: 0, easy: 0 };
		this.renderLoading();

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

	private async renderDeckPicker(requestId: number = this.loadRequestId): Promise<void> {
		this.container.empty();
		this.renderHeader('Select deck');

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
					void this.loadCards();
				}
			};
		} catch (err: unknown) {
			if (requestId !== this.loadRequestId) return;
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(msg);
		}
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
			text: '📚 Change deck',
		});
		changeBtn.onclick = () => {
			void this.renderDeckPicker();
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

	private renderHeader(titleText?: string, showOpenAnki: boolean = false) {
		const header = this.container.createDiv({ cls: 'anki-embed-header' });

		const titleContainer = header.createDiv({ cls: 'anki-embed-title' });
		const title = titleText || this.config.deck || this.config.query || 'Anki Deck';
		titleContainer.createSpan({ text: title });

		if (this.cards.length > 0) {
			titleContainer.createSpan({
				cls: 'anki-embed-badge',
				text: `${this.currentIndex + 1} / ${this.cards.length}`,
			});
		}

		const actions = header.createDiv({ cls: 'anki-embed-actions' });

		const pickerBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-icon',
			text: '📚 Change deck',
			attr: { title: 'Switch to another deck' },
		});
		pickerBtn.onclick = () => {
			void this.renderDeckPicker();
		};

		const refreshBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-icon',
			text: '🔄 Refresh',
			attr: { title: 'Refresh cards from Anki (r)' },
		});
		refreshBtn.onclick = () => {
			void this.loadCards();
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

	private async renderCurrentCard() {
		this.container.empty();

		if (this.currentIndex >= this.cards.length) {
			this.renderCompleted();
			return;
		}

		const card = this.cards[this.currentIndex];
		if (!card) return;

		this.renderHeader(card.deckName || this.config.deck, true);

		const cardEl = this.container.createDiv({ cls: 'anki-embed-card card' });

		const qDiv = cardEl.createDiv({ cls: 'anki-embed-question' });
		qDiv.empty();
		const qFragment = await this.getResolvedMediaFragment(formatCardHtml(card.question));
		qDiv.appendChild(qFragment);

		if (this.showingAnswer) {
			cardEl.createDiv({ cls: 'anki-embed-separator' });
			const aDiv = cardEl.createDiv({ cls: 'anki-embed-answer' });
			aDiv.empty();
			const answerHtml = extractAnswerHtml(formatCardHtml(card.answer, card.question));
			const aFragment = await this.getResolvedMediaFragment(answerHtml);
			aDiv.appendChild(aFragment);
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

			for (const opt of options) {
				const btn = ratings.createEl('button', {
					cls: `anki-embed-rate-btn ${opt.clsName}`,
				});
				btn.createSpan({ text: opt.label });
				btn.createSpan({ cls: 'anki-embed-rate-key', text: `[${opt.key}]` });

				btn.onclick = () => {
					void this.rateCurrentCard(opt.ease);
				};
			}

			const hint = footer.createDiv({ cls: 'anki-embed-shortcut-hint' });
			hint.createSpan({ text: 'Shortcuts: Press 1 for Again, 2 for Hard, 3 for Good, 4 for Easy' });
			hint.createSpan({ cls: 'anki-embed-keyboard-badge', text: '⌨️ Active' });
		}
	}

	private async revealAnswer() {
		this.showingAnswer = true;
		await this.renderCurrentCard();
	}

	private async rateCurrentCard(ease: 1 | 2 | 3 | 4): Promise<void> {
		if (ease === 1) this.sessionStats.again++;
		else if (ease === 2) this.sessionStats.hard++;
		else if (ease === 3) this.sessionStats.good++;
		else if (ease === 4) this.sessionStats.easy++;

		const card = this.cards[this.currentIndex];
		if (card) {
			try {
				await this.client.answerCard(card.cardId, ease);
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
	}
}
