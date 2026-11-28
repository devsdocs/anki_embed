import { App, FuzzySuggestModal, TFile } from 'obsidian';

export class NoteSelectModal extends FuzzySuggestModal<TFile> {
	private onSelectNote: (file: TFile) => void;

	constructor(app: App, onSelectNote: (file: TFile) => void) {
		super(app);
		this.onSelectNote = onSelectNote;
		this.setPlaceholder('Type to search for a note to link...');
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onSelectNote(file);
	}
}
