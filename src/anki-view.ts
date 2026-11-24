import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { ViewStateResult } from 'obsidian';
import { AnkiClient } from './anki-client';
import { DeckPlayer } from './deck-player';
import { AnkiEmbedSettings, DeckEmbedConfig, VIEW_TYPE_ANKI_EMBED } from './types';

export class AnkiView extends ItemView {
	private player: DeckPlayer | null = null;
	private config: DeckEmbedConfig = { select: true };
	private client: AnkiClient;
	private getSettings: () => AnkiEmbedSettings;
	private saveSettings?: (settings: AnkiEmbedSettings) => Promise<void>;

	constructor(
		leaf: WorkspaceLeaf,
		client: AnkiClient,
		getSettings: () => AnkiEmbedSettings,
		saveSettings?: (settings: AnkiEmbedSettings) => Promise<void>
	) {
		super(leaf);
		this.client = client;
		this.getSettings = getSettings;
		this.saveSettings = saveSettings;
		this.navigation = true;
	}

	getViewType(): string {
		return VIEW_TYPE_ANKI_EMBED;
	}

	getDisplayText(): string {
		if (this.config.card ?? this.config.cardId) {
			return `Anki: Card ${this.config.card ?? this.config.cardId}`;
		}
		if (this.config.deck) {
			return `Anki: ${this.config.deck}`;
		}
		if (this.config.query) {
			return `Anki: ${this.config.query}`;
		}
		return 'Anki review';
	}

	getIcon(): string {
		return 'layers';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('anki-embed-view-content');

		this.addAction('refresh-cw', 'Refresh cards (r)', () => {
			void this.player?.loadCards();
		});

		this.addAction('layers', 'Back to deck selection', () => {
			this.resetView();
		});

		this.renderPlayer();
	}

	public resetView(): void {
		this.config = { select: true };
		this.player?.resetToDeckPicker();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
		this.player?.destroy();
		this.player = null;
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === 'object') {
			const s = state as Partial<DeckEmbedConfig>;
			this.config = {
				card: typeof s.card === 'number' ? s.card : undefined,
				cardId: typeof s.cardId === 'number' ? s.cardId : undefined,
				deck: typeof s.deck === 'string' ? s.deck : undefined,
				query: typeof s.query === 'string' ? s.query : undefined,
				limit: typeof s.limit === 'number' ? s.limit : undefined,
				filter: s.filter,
				randomize: typeof s.randomize === 'boolean' ? s.randomize : undefined,
				select: typeof s.select === 'boolean' ? s.select : undefined,
				excludeSuspended: typeof s.excludeSuspended === 'boolean' ? s.excludeSuspended : undefined,
				order: s.order,
				counts: typeof s.counts === 'boolean' ? s.counts : undefined,
			};
		}
		await super.setState(state, result);
		this.renderPlayer();
	}

	override getState(): Record<string, unknown> {
		return {
			card: this.config.card,
			cardId: this.config.cardId,
			deck: this.config.deck,
			query: this.config.query,
			limit: this.config.limit,
			filter: this.config.filter,
			randomize: this.config.randomize,
			select: this.config.select,
		};
	}

	public setConfig(config: DeckEmbedConfig): void {
		this.config = { ...config };
		this.renderPlayer();
	}

	private renderPlayer(): void {
		this.contentEl.empty();
		const playerContainer = this.contentEl.createDiv({ cls: 'anki-embed-container is-full-view' });
		this.player = new DeckPlayer(
			playerContainer,
			this.config,
			this.client,
			this.getSettings(),
			undefined,
			true,
			(deck) => {
				this.config.deck = deck;
				this.config.select = false;
				this.app.workspace.requestSaveLayout();
			},
			this.app,
			this.saveSettings
		);
		void this.player.init();
	}
}
