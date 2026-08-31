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

	constructor(
		leaf: WorkspaceLeaf,
		client: AnkiClient,
		getSettings: () => AnkiEmbedSettings
	) {
		super(leaf);
		this.client = client;
		this.getSettings = getSettings;
		this.navigation = true;
	}

	getViewType(): string {
		return VIEW_TYPE_ANKI_EMBED;
	}

	getDisplayText(): string {
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

		this.addAction('layers', 'Change deck', () => {
			this.config = { select: true };
			this.renderPlayer();
		});

		this.renderPlayer();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
		this.player = null;
	}

	override async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === 'object') {
			const s = state as Partial<DeckEmbedConfig>;
			this.config = {
				deck: typeof s.deck === 'string' ? s.deck : undefined,
				query: typeof s.query === 'string' ? s.query : undefined,
				limit: typeof s.limit === 'number' ? s.limit : undefined,
				filter: s.filter === 'all' || s.filter === 'due' || s.filter === 'new' ? s.filter : undefined,
				randomize: typeof s.randomize === 'boolean' ? s.randomize : undefined,
				select: typeof s.select === 'boolean' ? s.select : undefined,
			};
		}
		await super.setState(state, result);
		this.renderPlayer();
	}

	override getState(): Record<string, unknown> {
		return {
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
			}
		);
		void this.player.init();
	}
}
