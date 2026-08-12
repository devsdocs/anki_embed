import { App, Modal, Notice, Setting } from 'obsidian';
import { AnkiClient } from './anki-client';
import { parseDelimitedText } from './parser';
import { AnkiNoteParam } from './types';

export class AnkiImportModal extends Modal {
	private client: AnkiClient;
	private step: 'input' | 'mapping' | 'importing' = 'input';

	// Parsed Data
	private parsedData: string[][] = [];
	
	// Mapping State
	private decks: string[] = [];
	private models: string[] = [];
	private selectedDeck = '';
	private newDeckName = '';
	private selectedModel = '';
	private modelFields: string[] = [];
	private fieldMapping: number[] = []; // Index is field index, value is column index
	private tags = '';

	constructor(app: App, client: AnkiClient) {
		super(app);
		this.client = client;
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private render() {
		this.contentEl.empty();
		this.contentEl.addClass('anki-embed-import-modal');

		if (this.step === 'input') {
			this.renderInputStep();
		} else if (this.step === 'mapping') {
			this.renderMappingStep();
		} else if (this.step === 'importing') {
			this.renderImportingStep();
		}
	}

	private renderInputStep() {
		this.titleEl.setText('Import notes to Anki');

		this.contentEl.createEl('p', { text: 'Paste Anki-compatible text (CSV, tsv, or semicolon-separated).', cls: 'setting-item-description anki-import-desc' });

		const buttonsDiv = this.contentEl.createDiv({ cls: 'anki-import-buttons' });

		const btnClipboard = buttonsDiv.createEl('button', { text: 'Import from clipboard', cls: 'mod-cta' });
		const btnManual = buttonsDiv.createEl('button', { text: 'Open text box to edit' });

		const manualArea = this.contentEl.createDiv({ cls: 'anki-import-manual-area' });

		const textarea = manualArea.createEl('textarea', { cls: 'anki-import-textarea' });
		textarea.placeholder = 'Paste your CSV/tsv data here...';

		const btnParse = manualArea.createEl('button', { text: 'Parse text', cls: 'mod-cta' });

		btnManual.onClickEvent(() => {
			manualArea.addClass('is-visible');
			btnManual.addClass('anki-import-hidden');
			textarea.focus();
		});

		btnClipboard.onClickEvent(async () => {
			try {
				const text = await navigator.clipboard.readText();
				if (!text.trim()) {
					new Notice('Clipboard is empty.');
					return;
				}
				this.processInput(text);
			} catch {
				new Notice('Failed to read clipboard. Check permissions.');
			}
		});

		btnParse.onClickEvent(() => {
			const text = textarea.value;
			if (!text.trim()) {
				new Notice('Please paste some text first.');
				return;
			}
			this.processInput(text);
		});
	}

	private processInput(text: string) {
		try {
			const parsed = parseDelimitedText(text);
			if (parsed.length === 0) {
				new Notice('No valid data found to parse.');
				return;
			}
			this.parsedData = parsed;
			this.step = 'mapping';
			void this.loadMappingData();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to parse data: ${msg}`);
		}
	}

	private async loadMappingData() {
		this.step = 'importing'; // Temporary loading state
		this.titleEl.setText('Connecting to Anki...');
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: 'Fetching decks and models from AnkiConnect...' });

		try {
			this.decks = await this.client.getDeckNames();
			this.models = await this.client.getModelNames();
			
			if (this.decks.length > 0) this.selectedDeck = this.decks[0] ?? '';
			if (this.models.length > 0) {
				this.selectedModel = this.models[0] ?? '';
				this.modelFields = await this.client.getModelFieldNames(this.selectedModel);
				this.fieldMapping = this.modelFields.map((_, i) => (i < (this.parsedData[0]?.length ?? 0) ? i : -1));
			}
			
			this.step = 'mapping';
			this.render();
		} catch {
			new Notice('Failed to connect to AnkiConnect. Is Anki running?');
			this.close();
		}
	}

	private renderMappingStep() {
		this.titleEl.setText('Configure import');
		this.contentEl.createEl('p', { text: `Found ${this.parsedData.length} notes with ${this.parsedData[0]?.length ?? 0} columns.`, cls: 'setting-item-description' });

		// Deck Selection
		const deckSetting = new Setting(this.contentEl)
			.setName('Target deck')
			.setDesc('Select a deck or type to create a new one');
		
		const deckSelect = deckSetting.controlEl.createEl('select', { cls: 'dropdown' });
		this.decks.forEach(d => deckSelect.createEl('option', { value: d, text: d }));
		deckSelect.createEl('option', { value: '__new__', text: '+ create new deck' });
		deckSelect.value = this.selectedDeck;

		const newDeckInput = deckSetting.controlEl.createEl('input', { type: 'text', placeholder: 'New deck name...', value: this.newDeckName, cls: 'anki-import-deck-input' });
		if (this.selectedDeck === '__new__') newDeckInput.addClass('is-visible');

		deckSelect.onchange = () => {
			this.selectedDeck = deckSelect.value;
			if (this.selectedDeck === '__new__') {
				newDeckInput.addClass('is-visible');
			} else {
				newDeckInput.removeClass('is-visible');
			}
		};
		newDeckInput.oninput = () => {
			this.newDeckName = newDeckInput.value;
		};

		// Model Selection
		const modelSetting = new Setting(this.contentEl)
			.setName('Note type (model)')
			.setDesc('Select the type of note to create');

		const modelSelect = modelSetting.controlEl.createEl('select', { cls: 'dropdown' });
		this.models.forEach(m => modelSelect.createEl('option', { value: m, text: m }));
		modelSelect.value = this.selectedModel;

		modelSelect.onchange = async () => {
			this.selectedModel = modelSelect.value;
			modelSelect.disabled = true;
			try {
				this.modelFields = await this.client.getModelFieldNames(this.selectedModel);
				this.fieldMapping = this.modelFields.map((_, i) => (i < (this.parsedData[0]?.length ?? 0) ? i : -1));
				this.render();
			} catch {
				new Notice('Failed to fetch model fields.');
				modelSelect.disabled = false;
			}
		};

		this.contentEl.createEl('h4', { text: 'Field mapping' });
		const mappingContainer = this.contentEl.createDiv({ cls: 'anki-import-mapping-container' });

		this.modelFields.forEach((field, fieldIdx) => {
			const row = mappingContainer.createDiv({ cls: 'anki-import-mapping-row' });

			row.createSpan({ text: field, cls: 'setting-item-name' });

			const colSelect = row.createEl('select', { cls: 'dropdown' });
			colSelect.createEl('option', { value: '-1', text: '(Empty)' });
			for (let c = 0; c < (this.parsedData[0]?.length ?? 0); c++) {
				colSelect.createEl('option', { value: c.toString(), text: `Column ${c + 1}` });
			}
			colSelect.value = (this.fieldMapping[fieldIdx] ?? -1).toString();
			colSelect.onchange = () => {
				this.fieldMapping[fieldIdx] = parseInt(colSelect.value, 10);
			};
		});

		new Setting(this.contentEl)
			.setName('Tags')
			.setDesc('Space-separated tags to add to all imported notes')
			.addText(text => text
				.setPlaceholder('E.g. Imported tag2')
				.setValue(this.tags)
				.onChange(val => this.tags = val)
			);

		const btnDiv = this.contentEl.createDiv({ cls: 'anki-import-actions' });

		const importBtn = btnDiv.createEl('button', { text: 'Import notes', cls: 'mod-cta' });
		importBtn.onClickEvent(() => void this.executeImport());
	}

	private renderImportingStep() {
		this.titleEl.setText('Importing...');
		this.contentEl.createEl('p', { text: 'Sending notes to Anki, please wait.' });
	}

	private async executeImport() {
		const deck = this.selectedDeck === '__new__' ? this.newDeckName : this.selectedDeck;
		if (!deck.trim()) {
			new Notice('Please specify a deck name.');
			return;
		}

		this.step = 'importing';
		this.render();

		try {
			if (this.selectedDeck === '__new__') {
				await this.client.createDeck(deck);
			}

			const tags = this.tags.split(' ').map(t => t.trim()).filter(t => t.length > 0);

			const notes: AnkiNoteParam[] = this.parsedData.map(row => {
				const fields: Record<string, string> = {};
				this.modelFields.forEach((fieldName, idx) => {
					const colIdx = this.fieldMapping[idx];
					fields[fieldName] = (colIdx !== undefined && colIdx >= 0 && colIdx < row.length) ? (row[colIdx] ?? '') : '';
				});

				return {
					deckName: deck,
					modelName: this.selectedModel,
					fields,
					tags
				};
			});

			const results = await this.client.addNotes(notes);
			const successCount = results.filter(r => r !== null).length;
			const failCount = results.length - successCount;

			if (failCount > 0) {
				new Notice(`Imported ${successCount} notes. ${failCount} failed (likely duplicates).`);
			} else {
				new Notice(`Successfully imported ${successCount} notes to Anki!`);
			}
			this.close();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Import failed: ${msg}`);
			this.step = 'mapping';
			this.render();
		}
	}
}
