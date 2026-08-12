import { sanitizeHTMLToDom } from 'obsidian';
import { AnkiClient } from './anki-client';
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
					this.revealAnswer();
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
		if (this.config.select || (!this.config.deck && !this.config.query)) {
			await this.renderDeckPicker();
			return;
		}

		this.isLoading = true;
		this.showingAnswer = false;
		this.currentIndex = 0;
		this.renderLoading();

		try {
			const query = this.buildQuery();
			const cardIds = await this.client.findCards(query);

			if (!cardIds || cardIds.length === 0) {
				this.cards = [];
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

			this.cards = await this.client.getCardsInfo(selectedIds);
			this.isLoading = false;

			if (this.cards.length === 0) {
				this.renderEmpty();
			} else {
				this.renderCurrentCard();
			}
		} catch (err: unknown) {
			this.isLoading = false;
			const msg = err instanceof Error ? err.message : String(err);
			this.renderError(msg);
		}
	}

	private async renderDeckPicker(): Promise<void> {
		this.container.empty();
		this.renderHeader('Select deck');

		const pickerDiv = this.container.createDiv({ cls: 'anki-embed-picker' });
		pickerDiv.createDiv({ text: '📚 Choose an Anki deck to review' });

		try {
			const decks = await this.client.getDeckNames();
			if (!decks || decks.length === 0) {
				pickerDiv.createDiv({ text: 'No decks found in Anki.' });
				return;
			}

			const selectEl = pickerDiv.createEl('select', { cls: 'anki-embed-select' });
			for (const deck of decks) {
				selectEl.createEl('option', { value: deck, text: deck });
			}

			if (this.config.deck && decks.includes(this.config.deck)) {
				selectEl.value = this.config.deck;
			}

			const startBtn = pickerDiv.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: 'Start review',
			});
			startBtn.onclick = () => {
				const chosen = selectEl.value;
				if (chosen) {
					this.config.deck = chosen;
					this.config.select = false;
					void this.loadCards();
				}
			};
		} catch (err: unknown) {
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
		steps.createEl('li', { text: '3. Verify AnkiConnect URL in plugin settings (default: http://127.0.0.1:8765).' });

		const retryBtn = errDiv.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Retry connection',
		});
		retryBtn.onclick = () => {
			void this.loadCards();
		};
	}

	private renderHeader(titleText?: string) {
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

		const openBtn = actions.createEl('button', {
			cls: 'anki-embed-btn-icon',
			text: '↗️ Open Anki',
			attr: { title: 'Open this deck in Anki desktop app' },
		});
		openBtn.onclick = () => {
			void this.openDeckInAnki();
		};
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

	private formatCardHtml(rawHtml: string, questionHtml?: string): string {
		let result = rawHtml;
		if (questionHtml && result.includes('{{FrontSide}}')) {
			result = result.replace('{{FrontSide}}', questionHtml);
		}
		result = result.replace(/\[sound:([^\]]+)\]/gi, '🔊 <i>($1)</i>');
		return result;
	}

	private renderCurrentCard() {
		this.container.empty();

		if (this.currentIndex >= this.cards.length) {
			this.renderCompleted();
			return;
		}

		const card = this.cards[this.currentIndex];
		if (!card) return;

		this.renderHeader(card.deckName || this.config.deck);

		const cardEl = this.container.createDiv({ cls: 'anki-embed-card' });
		cardEl.style.minHeight = this.settings.minCardHeight;

		const qDiv = cardEl.createDiv({ cls: 'anki-embed-question' });
		qDiv.empty();
		qDiv.appendChild(sanitizeHTMLToDom(this.formatCardHtml(card.question)));

		if (this.showingAnswer) {
			cardEl.createEl('hr');
			const aDiv = cardEl.createDiv({ cls: 'anki-embed-answer' });
			aDiv.empty();
			aDiv.appendChild(sanitizeHTMLToDom(this.formatCardHtml(card.answer, card.question)));
		}

		const footer = this.container.createDiv({ cls: 'anki-embed-footer' });

		if (!this.showingAnswer) {
			const flipBtn = footer.createEl('button', {
				cls: 'anki-embed-flip-btn',
				text: 'Show answer',
			});
			flipBtn.onclick = () => this.revealAnswer();

			footer.createDiv({
				cls: 'anki-embed-shortcut-hint',
				text: 'Shortcut: Press Space to reveal answer',
			});
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

			footer.createDiv({
				cls: 'anki-embed-shortcut-hint',
				text: 'Shortcuts: Press 1 for Again, 2 for Hard, 3 for Good, 4 for Easy',
			});
		}
	}

	private revealAnswer() {
		this.showingAnswer = true;
		this.renderCurrentCard();
	}

	private async rateCurrentCard(ease: 1 | 2 | 3 | 4): Promise<void> {
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
		this.renderCurrentCard();
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

		const restartBtn = completedDiv.createEl('button', {
			cls: 'anki-embed-flip-btn',
			text: '🔄 Review again',
		});
		restartBtn.onclick = () => {
			void this.loadCards();
		};
	}
}
