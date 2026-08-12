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

	onOpen(): void {
		void super.onOpen();
		void this.loadDecks();
	}

	private async loadDecks(): Promise<void> {
		try {
			this.decks = await this.client.getDeckNames();
			this.updateSuggestions();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`Failed to fetch decks from Anki: ${msg}`);
			this.close();
		}
	}

	private updateSuggestions() {
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
