import { App, FuzzySuggestModal, TFile } from 'obsidian';
import { AnkiClient } from './anki-client';
import { AnkiCardInfo } from './types';

export interface LinkedCardActionItem {
	cardId: number;
	label: string;
	subtext?: string;
	action: 'open' | 'unlink' | 'unlink_all';
}

export class LinkedCardsManageModal extends FuzzySuggestModal<LinkedCardActionItem> {
	private file: TFile;
	private cardIds: number[];
	private client: AnkiClient;
	private onOpenCard: (cardId: number) => void;
	private onUnlink: (cardId: number) => Promise<void>;
	private onUnlinkAll: () => Promise<void>;
	private cardDetails: Map<number, AnkiCardInfo> = new Map();

	constructor(
		app: App,
		client: AnkiClient,
		file: TFile,
		cardIds: number[],
		onOpenCard: (cardId: number) => void,
		onUnlink: (cardId: number) => Promise<void>,
		onUnlinkAll: () => Promise<void>
	) {
		super(app);
		this.file = file;
		this.cardIds = cardIds;
		this.client = client;
		this.onOpenCard = onOpenCard;
		this.onUnlink = onUnlink;
		this.onUnlinkAll = onUnlinkAll;
		this.setPlaceholder(`Manage linked Anki cards for "${file.basename}"...`);
	}

	onOpen(): void {
		void super.onOpen();
		if (this.cardIds.length > 0) {
			void (async () => {
				try {
					const info = await this.client.getCardsInfo(this.cardIds);
					for (const card of info) {
						this.cardDetails.set(card.cardId, card);
					}
					const updateFn = (this as unknown as { updateSuggestions?: () => void }).updateSuggestions;
					if (typeof updateFn === 'function') {
						updateFn.call(this);
					}
				} catch {
					// Offline or non-fatal
				}
			})();
		}
	}

	getItems(): LinkedCardActionItem[] {
		const items: LinkedCardActionItem[] = [];

		for (const cardId of this.cardIds) {
			const info = this.cardDetails.get(cardId);
			const rawQuestion = info?.fields?.Front?.value || info?.fields?.Text?.value || info?.question || '';
			const cleanQuestion = rawQuestion
				.replace(/<[^>]+>/g, '')
				.replace(/\s+/g, ' ')
				.trim();
			const deckPrefix = info?.deckName ? `[${info.deckName}] ` : '';
			const preview = cleanQuestion ? `${deckPrefix}${cleanQuestion.slice(0, 80)}` : `Card ${cardId}`;

			items.push({
				cardId,
				label: `▶️ Review card: ${preview}`,
				subtext: `ID: ${cardId} — Open and study this card in Anki Embed`,
				action: 'open',
			});

			items.push({
				cardId,
				label: `❌ Unlink card: ${preview}`,
				subtext: `ID: ${cardId} — Remove link and frontmatter from "${this.file.basename}"`,
				action: 'unlink',
			});
		}

		if (this.cardIds.length > 1) {
			items.push({
				cardId: 0,
				label: `🗑️ Unlink all cards (${this.cardIds.length}) from "${this.file.basename}"`,
				subtext: 'Remove all card links and properties from this note',
				action: 'unlink_all',
			});
		}

		return items;
	}

	getItemText(item: LinkedCardActionItem): string {
		return `${item.label} ${item.subtext ?? ''} ${item.cardId}`;
	}

	renderSuggestion(match: { item: LinkedCardActionItem }, el: HTMLElement): void {
		el.createDiv({ text: match.item.label, cls: 'suggestion-title' });
		if (match.item.subtext) {
			el.createDiv({ text: match.item.subtext, cls: 'suggestion-note' });
		}
	}

	onChooseItem(item: LinkedCardActionItem): void {
		if (item.action === 'open') {
			this.onOpenCard(item.cardId);
		} else if (item.action === 'unlink') {
			void this.onUnlink(item.cardId);
		} else if (item.action === 'unlink_all') {
			void this.onUnlinkAll();
		}
	}
}
