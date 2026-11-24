import { App, FuzzySuggestModal, Notice } from 'obsidian';
import type { FuzzyMatch } from 'obsidian';
import { AnkiClient } from './anki-client';
import { AnkiTagItem, normalizeAnkiTag, parseTagItem } from './card-html';

export class TagSelectModal extends FuzzySuggestModal<AnkiTagItem> {
	private client: AnkiClient;
	private onSelectTag: (tag: string) => void;
	private tagItems: AnkiTagItem[] = [];
	private initialTags: string[] = [];

	constructor(app: App, client: AnkiClient, onSelectTag: (tag: string) => void, initialTags: string[] = []) {
		super(app);
		this.client = client;
		this.onSelectTag = onSelectTag;
		this.initialTags = initialTags;
		this.setPlaceholder('Loading tags from Anki...');

		// Allow Shift+Enter or Mod+Enter to select whatever was custom typed
		this.scope.register(['Mod'], 'Enter', () => {
			const custom = this.inputEl.value.trim();
			if (custom) {
				this.close();
				this.onSelectTag(normalizeAnkiTag(custom));
			}
		});
		this.scope.register(['Shift'], 'Enter', () => {
			const custom = this.inputEl.value.trim();
			if (custom) {
				this.close();
				this.onSelectTag(normalizeAnkiTag(custom));
			}
		});
	}

	onOpen(): void {
		void super.onOpen();
		void this.loadTags();
	}

	private addTagVariants(rawTag: string, itemMap: Map<string, AnkiTagItem>): void {
		if (!rawTag || !rawTag.trim()) return;
		const clean = normalizeAnkiTag(rawTag);
		if (!clean) return;

		// 1. Add full hierarchy tag
		if (!itemMap.has(clean)) {
			itemMap.set(clean, parseTagItem(rawTag));
		}

		// 2. Add intermediate branches so parents/subtrees are selectable with their ancestry
		if (rawTag.includes('::')) {
			const rawParts = rawTag.split('::').filter(Boolean);
			for (let i = 1; i < rawParts.length; i++) {
				const branchRaw = rawParts.slice(0, i).join('::');
				const branchClean = normalizeAnkiTag(branchRaw);
				if (branchClean && !itemMap.has(branchClean)) {
					itemMap.set(branchClean, parseTagItem(branchRaw));
				}
			}
		}
	}

	private async loadTags(): Promise<void> {
		try {
			const fetchedTags = await this.client.getTags();
			const itemMap = new Map<string, AnkiTagItem>();

			// Prioritize card/deck initial tags first
			for (const t of this.initialTags) {
				this.addTagVariants(t, itemMap);
			}

			// Add all Anki tags from profile
			for (const t of fetchedTags) {
				this.addTagVariants(t, itemMap);
			}

			this.tagItems = Array.from(itemMap.values());
			if (this.tagItems.length === 0) {
				this.setPlaceholder('No Anki tags found (press Shift+Enter to use custom tag)');
			} else {
				this.setPlaceholder(`Search ${this.tagItems.length} Anki tags (showing parents & subtags)...`);
			}

			const updateFn = (this as unknown as Record<string, (() => void) | undefined>)['updateSuggestions'];
			if (typeof updateFn === 'function') {
				updateFn.call(this);
			}
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (this.initialTags.length > 0) {
				const fallbackMap = new Map<string, AnkiTagItem>();
				for (const t of this.initialTags) {
					this.addTagVariants(t, fallbackMap);
				}
				this.tagItems = Array.from(fallbackMap.values());
				this.setPlaceholder(`Search ${this.tagItems.length} card tags...`);
				const updateFn = (this as unknown as Record<string, (() => void) | undefined>)['updateSuggestions'];
				if (typeof updateFn === 'function') {
					updateFn.call(this);
				}
			} else {
				new Notice(`Could not load Anki tags: ${msg}. Type tag and press Shift+Enter.`);
				this.setPlaceholder('Type tag and press Shift+Enter...');
			}
		}
	}

	getItems(): AnkiTagItem[] {
		return this.tagItems;
	}

	getItemText(item: AnkiTagItem): string {
		return `${item.leafTag} ${item.parentPath} ${item.tagToInsert}`;
	}

	renderSuggestion(match: FuzzyMatch<AnkiTagItem>, el: HTMLElement): void {
		el.empty();
		el.addClass('anki-tag-suggest-row');

		const topRow = el.createDiv({ cls: 'anki-tag-suggest-top' });
		topRow.createSpan({ cls: 'anki-tag-suggest-icon', text: '🏷️' });
		topRow.createSpan({ cls: 'anki-tag-suggest-leaf', text: match.item.leafTag });

		if (match.item.parentPath) {
			const parentRow = el.createDiv({ cls: 'anki-tag-suggest-parents' });
			parentRow.createSpan({ cls: 'anki-tag-parent-icon', text: '↳ ' });
			parentRow.createSpan({ cls: 'anki-tag-parent-path', text: match.item.parentPath });
		}
	}

	onChooseItem(item: AnkiTagItem): void {
		this.onSelectTag(item.tagToInsert);
	}
}
