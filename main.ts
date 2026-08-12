import { App, Editor, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { AnkiClient } from './src/anki-client';
import { DeckPlayer } from './src/deck-player';
import { DeckSelectModal } from './src/deck-modal';
import { parseDeckConfig, parsePastedAnkiText } from './src/parser';
import { AnkiEmbedSettings, DEFAULT_SETTINGS } from './src/types';

export default class AnkiEmbedPlugin extends Plugin {
	settings!: AnkiEmbedSettings;
	client!: AnkiClient;

	async onload() {
		await this.loadSettings();

		this.client = new AnkiClient(this.settings.ankiConnectUrl, this.settings.apiKey);

		this.addSettingTab(new AnkiEmbedSettingTab(this.app, this));

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
			const player = new DeckPlayer(el, config, this.client, this.settings);
			player.init();
		};

		this.registerMarkdownCodeBlockProcessor('anki', renderCodeBlock);
		this.registerMarkdownCodeBlockProcessor('anki-embed', renderCodeBlock);

		// Commands
		this.addCommand({
			id: 'insert-anki-deck-embed',
			name: 'Insert Anki Deck Embed',
			editorCallback: (editor: Editor) => {
				new DeckSelectModal(this.app, this.client, (deckName: string) => {
					const cursor = editor.getCursor();
					const codeBlock = `\`\`\`anki\ndeck: ${deckName}\n\`\`\`\n`;
					editor.replaceRange(codeBlock, cursor);
				}).open();
			},
		});

		this.addCommand({
			id: 'test-ankiconnect-connection',
			name: 'Test AnkiConnect Connection',
			callback: async () => {
				try {
					const version = await this.client.testConnection();
					new Notice(`✅ Connected to AnkiConnect (v${version})`);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`❌ AnkiConnect error: ${msg}`);
				}
			},
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<AnkiEmbedSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.client) {
			this.client.setConfig(this.settings.ankiConnectUrl, this.settings.apiKey);
		}
	}
}

class AnkiEmbedSettingTab extends PluginSettingTab {
	plugin: AnkiEmbedPlugin;

	constructor(app: App, plugin: AnkiEmbedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Anki Embed Settings' });

		new Setting(containerEl)
			.setName('AnkiConnect URL')
			.setDesc('URL of the AnkiConnect endpoint (default: http://127.0.0.1:8765)')
			.addText(text => text
				.setPlaceholder('http://127.0.0.1:8765')
				.setValue(this.plugin.settings.ankiConnectUrl)
				.onChange(async (value) => {
					this.plugin.settings.ankiConnectUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Key')
			.setDesc('Optional API key if configured in AnkiConnect')
			.addText(text => text
				.setPlaceholder('Leave blank if none')
				.setValue(this.plugin.settings.apiKey)
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default Card Limit')
			.setDesc('Maximum number of cards to load per session if not specified in code block')
			.addText(text => text
				.setPlaceholder('20')
				.setValue(String(this.plugin.settings.defaultLimit))
				.onChange(async (value) => {
					const num = Number.parseInt(value, 10);
					if (!Number.isNaN(num) && num > 0) {
						this.plugin.settings.defaultLimit = num;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName('Default Card Filter')
			.setDesc('Which cards to show by default')
			.addDropdown(dropdown => dropdown
				.addOption('all', 'All Cards')
				.addOption('due', 'Due Cards Only')
				.addOption('new', 'New Cards Only')
				.setValue(this.plugin.settings.defaultFilter)
				.onChange(async (value) => {
					this.plugin.settings.defaultFilter = value as 'all' | 'due' | 'new';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Randomize Cards')
			.setDesc('Shuffle card order for review sessions')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.randomizeCards)
				.onChange(async (value) => {
					this.plugin.settings.randomizeCards = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Minimum Card Height')
			.setDesc('Minimum height for flashcard display area (e.g. 280px)')
			.addText(text => text
				.setPlaceholder('280px')
				.setValue(this.plugin.settings.minCardHeight)
				.onChange(async (value) => {
					this.plugin.settings.minCardHeight = value;
					await this.plugin.saveSettings();
				}));
	}
}
