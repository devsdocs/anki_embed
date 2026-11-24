import { App, Editor, Notice, Plugin, PluginSettingTab, WorkspaceLeaf } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import { AnkiClient } from './src/anki-client';
import { AnkiView } from './src/anki-view';
import { DeckPlayer } from './src/deck-player';
import { DeckSelectModal } from './src/deck-modal';
import { AnkiImportModal } from './src/import-modal';
import { parseDeckConfig, parsePastedAnkiText } from './src/parser';
import { AnkiEmbedSettings, DEFAULT_SETTINGS, DeckEmbedConfig, VIEW_TYPE_ANKI_EMBED } from './src/types';

export default class AnkiEmbedPlugin extends Plugin {
	settings!: AnkiEmbedSettings;
	client!: AnkiClient;

	async onload() {
		await this.loadSettings();

		this.client = new AnkiClient(this.settings.ankiConnectUrl, this.settings.apiKey);

		this.registerView(
			VIEW_TYPE_ANKI_EMBED,
			(leaf) => new AnkiView(leaf, this.client, () => this.settings)
		);

		this.addSettingTab(new AnkiEmbedSettingTab(this.app, this));

		// Left Ribbon Action
		this.addRibbonIcon('layers', 'Open Anki review in full view', () => {
			const view = this.app.workspace.activeEditor;
			if (view && view.editor) {
				new DeckSelectModal(this.app, this.client, (deckName: string) => {
					const cursor = view.editor?.getCursor();
					if (cursor) {
						const codeBlock = `\`\`\`anki\ndeck: ${deckName}\n\`\`\`\n`;
						view.editor?.replaceRange(codeBlock, cursor);
					}
				}).open();
			} else {
				void this.activateView();
			}
		});

		// On paste: wrap anki:// links in an ```anki code block
		this.registerEvent(
			this.app.workspace.on('editor-paste', (evt: ClipboardEvent, editor: Editor) => {
				if (evt.defaultPrevented) return;

				const line = editor.getCursor().line;
				const lineText = editor.getLine(line).trim();
				if (lineText !== '') return;

				const pastedTextRaw = evt.clipboardData?.getData('text/plain') ?? '';
				const parsed = parsePastedAnkiText(pastedTextRaw);
				if (!parsed) return;

				evt.preventDefault();

				const codeBlock = `\`\`\`anki\ndeck: ${parsed.deckName}\n\`\`\``;
				editor.replaceRange(codeBlock, { line, ch: 0 }, { line, ch: lineText.length });
				editor.setCursor({ line: line + 2, ch: 3 });
			})
		);

		// Register Code Block Processors: ```anki and ```anki-embed
		const renderCodeBlock = (source: string, el: HTMLElement) => {
			const config = parseDeckConfig(source);
			const player = new DeckPlayer(
				el,
				config,
				this.client,
				this.settings,
				(cfg) => {
					void this.activateView(cfg);
				},
				false
			);
			void player.init();
		};

		this.registerMarkdownCodeBlockProcessor('anki', renderCodeBlock);
		this.registerMarkdownCodeBlockProcessor('anki-embed', renderCodeBlock);

		// Commands
		this.addCommand({
			id: 'open-anki-review-in-full-view',
			name: 'Open Anki review in full view',
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: 'open-anki-deck-in-full-view',
			name: 'Open Anki deck in full view',
			callback: () => {
				new DeckSelectModal(this.app, this.client, (deckName: string) => {
					void this.activateView({ deck: deckName });
				}).open();
			},
		});

		this.addCommand({
			id: 'reset-anki-view-to-deck-selection',
			name: 'Reset Anki view to deck selection',
			callback: () => {
				const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANKI_EMBED);
				for (const leaf of leaves) {
					if (leaf.view instanceof AnkiView) {
						leaf.view.resetView();
					}
				}
			},
		});

		this.addCommand({
			id: 'insert-anki-deck-embed',
			name: 'Insert Anki deck embed',
			editorCallback: (editor: Editor) => {
				new DeckSelectModal(this.app, this.client, (deckName: string) => {
					const cursor = editor.getCursor();
					const codeBlock = `\`\`\`anki\ndeck: ${deckName}\n\`\`\`\n`;
					editor.replaceRange(codeBlock, cursor);
				}).open();
			},
		});

		this.addCommand({
			id: 'insert-interactive-anki-picker',
			name: 'Insert interactive Anki deck picker',
			editorCallback: (editor: Editor) => {
				const cursor = editor.getCursor();
				const codeBlock = '```anki\nselect: true\n```\n';
				editor.replaceRange(codeBlock, cursor);
			},
		});

		this.addCommand({
			id: 'sync-anki-collection',
			name: 'Sync Anki collection',
			callback: async () => {
				try {
					await this.client.sync();
					new Notice('✅ Anki collection synchronized successfully');
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`❌ Anki sync error: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'test-ankiconnect-connection',
			name: 'Test AnkiConnect connection',
			callback: async () => {
				try {
					const version = await this.client.testConnection();
					new Notice(`✅ Connected to ankiconnect (v${version})`);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`❌ AnkiConnect error: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'import-anki-notes',
			name: 'Import Anki notes from CSV/tsv',
			callback: () => {
				new AnkiImportModal(this.app, this.client).open();
			},
		});
	}

	async activateView(config?: DeckEmbedConfig, newTab: boolean = true): Promise<AnkiView> {
		let leaf: WorkspaceLeaf | null = null;
		if (!newTab) {
			const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANKI_EMBED);
			if (existingLeaves.length > 0 && existingLeaves[0]) {
				leaf = existingLeaves[0];
			}
		}

		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
		}

		await leaf.setViewState({
			type: VIEW_TYPE_ANKI_EMBED,
			active: true,
			state: config ?? { select: true },
		});

		await this.app.workspace.revealLeaf(leaf);
		return leaf.view as AnkiView;
	}

	async loadSettings() {
		const storedSettings = (await this.loadData()) as Partial<AnkiEmbedSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, storedSettings ?? {});
		let repaired = false;

		if (typeof this.settings.ankiConnectUrl !== 'string') {
			this.settings.ankiConnectUrl = DEFAULT_SETTINGS.ankiConnectUrl;
			repaired = true;
		}
		if (typeof this.settings.apiKey !== 'string') {
			this.settings.apiKey = DEFAULT_SETTINGS.apiKey;
			repaired = true;
		}
		if (!Number.isInteger(this.settings.defaultLimit) || this.settings.defaultLimit <= 0) {
			this.settings.defaultLimit = DEFAULT_SETTINGS.defaultLimit;
			repaired = true;
		}
		if (!['all', 'due', 'new', 'due+new'].includes(this.settings.defaultFilter)) {
			this.settings.defaultFilter = DEFAULT_SETTINGS.defaultFilter;
			repaired = true;
		}
		if (typeof this.settings.randomizeCards !== 'boolean') {
			this.settings.randomizeCards = DEFAULT_SETTINGS.randomizeCards;
			repaired = true;
		}
		if (typeof this.settings.minCardHeight !== 'string') {
			this.settings.minCardHeight = DEFAULT_SETTINGS.minCardHeight;
			repaired = true;
		}
		if (typeof this.settings.useCustomAnkiConnect !== 'boolean') {
			this.settings.useCustomAnkiConnect = DEFAULT_SETTINGS.useCustomAnkiConnect;
			repaired = true;
		}
		if (typeof this.settings.useCardStyles !== 'boolean') {
			this.settings.useCardStyles = DEFAULT_SETTINGS.useCardStyles;
			repaired = true;
		}
		if (typeof this.settings.liveSync !== 'boolean') {
			this.settings.liveSync = DEFAULT_SETTINGS.liveSync;
			repaired = true;
		}
		if (typeof this.settings.excludeSuspended !== 'boolean') {
			this.settings.excludeSuspended = DEFAULT_SETTINGS.excludeSuspended;
			repaired = true;
		}
		if (!['reviews-first', 'random', 'default'].includes(this.settings.cardOrder)) {
			this.settings.cardOrder = DEFAULT_SETTINGS.cardOrder;
			repaired = true;
		}
		if (typeof this.settings.showCardCounts !== 'boolean') {
			this.settings.showCardCounts = DEFAULT_SETTINGS.showCardCounts;
			repaired = true;
		}

		if (repaired) {
			await this.saveData(this.settings);
		}
	}
}

class AnkiEmbedSettingTab extends PluginSettingTab {
	plugin: AnkiEmbedPlugin;

	constructor(app: App, plugin: AnkiEmbedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Deck display',
				items: [
					{
						name: 'AnkiConnect URL',
						desc: 'The AnkiConnect endpoint address.',
						control: {
							type: 'text',
							key: 'ankiConnectUrl',
							placeholder: 'http://127.0.0.1:8765',
						},
					},
					{
						name: 'Use custom AnkiConnect',
						desc: 'Enable this if you are using the devsdocs/anki-connect fork. Enables time-tracking for answers.',
						control: {
							type: 'toggle',
							key: 'useCustomAnkiConnect',
							defaultValue: DEFAULT_SETTINGS.useCustomAnkiConnect,
						},
					},
					{
						name: 'API key',
						desc: 'Set this if you configured an API key in AnkiConnect.',
						control: {
							type: 'text',
							key: 'apiKey',
							placeholder: 'Leave blank if none',
						},
					},
					{
						name: 'Default card limit',
						desc: 'Maximum number of cards to load per session if not specified in code block.',
						control: {
							type: 'number',
							key: 'defaultLimit',
							defaultValue: DEFAULT_SETTINGS.defaultLimit,
							placeholder: String(DEFAULT_SETTINGS.defaultLimit),
							min: 1,
							step: 1,
							validate: (value: number) =>
								Number.isInteger(value) && value > 0 ? undefined : 'Enter a positive whole number.',
						},
					},
					{
						name: 'Default card filter',
						desc: 'Which cards to show by default.',
						control: {
							type: 'dropdown',
							key: 'defaultFilter',
							defaultValue: DEFAULT_SETTINGS.defaultFilter,
							options: {
								all: 'All cards',
								'due+new': 'Due and new cards',
								due: 'Due cards only',
								new: 'New cards only',
							},
						},
					},
					{
						name: 'Card study order',
						desc: 'Determine which cards appear first in review sessions.',
						control: {
							type: 'dropdown',
							key: 'cardOrder',
							defaultValue: DEFAULT_SETTINGS.cardOrder,
							options: {
								'reviews-first': 'Reviews first (due reviews before new cards)',
								random: 'Randomized mix',
								default: 'Deck order',
							},
						},
					},
					{
						name: 'Exclude suspended cards',
						desc: 'Automatically exclude suspended cards (-is:suspended) from study sessions.',
						control: {
							type: 'toggle',
							key: 'excludeSuspended',
							defaultValue: DEFAULT_SETTINGS.excludeSuspended,
						},
					},
					{
						name: 'Show card counts (New, Learn, Review)',
						desc: 'Display the remaining new, learning, and review card counts at the bottom of the card like in Anki desktop.',
						control: {
							type: 'toggle',
							key: 'showCardCounts',
							defaultValue: DEFAULT_SETTINGS.showCardCounts,
						},
					},
					{
						name: 'Randomize cards',
						desc: 'Shuffle card order for review sessions.',
						control: {
							type: 'toggle',
							key: 'randomizeCards',
							defaultValue: DEFAULT_SETTINGS.randomizeCards,
						},
					},
					{
						name: 'Use original Anki card styles',
						desc: 'Display cards using the original CSS styling from your Anki note types.',
						control: {
							type: 'toggle',
							key: 'useCardStyles',
							defaultValue: DEFAULT_SETTINGS.useCardStyles,
						},
					},
					{
						name: 'Live sync with Anki desktop reviewer',
						desc: 'Mirror the active review screen from the Anki desktop app. Answering in Obsidian advances Anki, and answering in Anki advances Obsidian.',
						control: {
							type: 'toggle',
							key: 'liveSync',
							defaultValue: DEFAULT_SETTINGS.liveSync,
						},
					},
					{
						name: 'Minimum card height',
						desc: 'Minimum height for the flashcard display area.',
						control: {
							type: 'text',
							key: 'minCardHeight',
							placeholder: DEFAULT_SETTINGS.minCardHeight,
						},
					},
				],
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await super.setControlValue(key, value);
		if (key === 'ankiConnectUrl' || key === 'apiKey') {
			this.plugin.client.setConfig(this.plugin.settings.ankiConnectUrl, this.plugin.settings.apiKey);
		}
	}
}
