import { App, FuzzySuggestModal, Notice } from 'obsidian';
import { AnkiClient } from './anki-client';

export class DeckSelectModal extends FuzzySuggestModal<string> {
	private client: AnkiClient;
	private onSelectDeck: (deckName: string) => void;
	private decks: string[] = [];

	constructor(app: App, client: AnkiClient, onSelectDeck: (deckName: string) => void) {
		super(app);
		this.client = client;
		this.onSelectDeck = onSelectDeck;
		this.setPlaceholder('Type to search for an Anki deck...');
	}

	async onOpen() {
		super.onOpen();
		try {
			this.decks = await this.client.getDeckNames();
			// Re-render suggest items once loaded
			this.updateSuggestions();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to fetch decks from Anki: ${msg}`);
			this.close();
		}
	}

	private updateSuggestions() {
		// Trigger internal input event to update suggest items list
		const inputEl = this.inputEl;
		inputEl.dispatchEvent(new Event('input'));
	}

	getItems(): string[] {
		return this.decks;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.onSelectDeck(item);
	}
}
