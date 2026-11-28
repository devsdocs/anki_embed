import { App, Modal, Notice } from 'obsidian';
import {
	AnkiEmbedSettings,
	DEFAULT_GAMEPAD_MAPPING,
	DEFAULT_KEYBOARD_MAPPING,
	GAMEPAD_BUTTON_NAMES,
	REMOTE_ACTION_LABELS,
	RemoteAction,
} from './types';

export interface RemoteSettingsProvider {
	settings: AnkiEmbedSettings;
	saveData: (data: AnkiEmbedSettings) => Promise<void>;
}

interface DetectedInput {
	type: 'gamepad' | 'keyboard';
	buttonIndex?: number;
	key?: string;
}

export class AnkiRemoteConfigModal extends Modal {
	private plugin: RemoteSettingsProvider;
	private activeTab: 'gamepad' | 'keyboard' = 'gamepad';
	private gamepadInterval: number | null = null;
	private prevGamepadButtons: boolean[] = [];
	private connectedGamepadName: string | null = null;
	private lastDetected: DetectedInput | null = null;
	private onKeyDownHandler: ((evt: KeyboardEvent) => void) | null = null;
	private onGamepadConnectedHandler: ((e: GamepadEvent) => void) | null = null;
	private onGamepadDisconnectedHandler: (() => void) | null = null;

	constructor(app: App, plugin: RemoteSettingsProvider) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.modalEl.addClass('anki-remote-modal');
		this.initListeners();
		this.render();
	}

	onClose(): void {
		this.cleanupListeners();
		this.contentEl.empty();
		void this.plugin.saveData(this.plugin.settings);
	}

	private initListeners(): void {
		if (typeof window === 'undefined') return;

		this.onGamepadConnectedHandler = (e: GamepadEvent) => {
			this.connectedGamepadName = e.gamepad.id;
			this.renderDetectorStatus();
		};
		this.onGamepadDisconnectedHandler = () => {
			this.connectedGamepadName = null;
			this.renderDetectorStatus();
		};

		window.addEventListener('gamepadconnected', this.onGamepadConnectedHandler);
		window.addEventListener('gamepaddisconnected', this.onGamepadDisconnectedHandler);

		this.onKeyDownHandler = (evt: KeyboardEvent) => {
			if (
				evt.target instanceof HTMLInputElement ||
				evt.target instanceof HTMLTextAreaElement ||
				evt.target instanceof HTMLSelectElement
			) {
				return;
			}
			evt.preventDefault();
			const key = evt.key.length === 1 ? evt.key.toLowerCase() : evt.key;
			this.handleDetectedInput({ type: 'keyboard', key });
		};
		window.addEventListener('keydown', this.onKeyDownHandler);

		this.gamepadInterval = window.setInterval(() => {
			this.pollGamepadState();
		}, 40);
	}

	private cleanupListeners(): void {
		if (this.gamepadInterval !== null) {
			window.clearInterval(this.gamepadInterval);
			this.gamepadInterval = null;
		}
		if (this.onKeyDownHandler) {
			window.removeEventListener('keydown', this.onKeyDownHandler);
			this.onKeyDownHandler = null;
		}
		if (this.onGamepadConnectedHandler) {
			window.removeEventListener('gamepadconnected', this.onGamepadConnectedHandler);
			this.onGamepadConnectedHandler = null;
		}
		if (this.onGamepadDisconnectedHandler) {
			window.removeEventListener('gamepaddisconnected', this.onGamepadDisconnectedHandler);
			this.onGamepadDisconnectedHandler = null;
		}
	}

	private pollGamepadState(): void {
		if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
		const gamepads = navigator.getGamepads();
		if (!gamepads) return;

		let activeGp: Gamepad | null = null;
		for (let i = 0; i < gamepads.length; i++) {
			const gp = gamepads[i];
			if (gp && gp.connected) {
				activeGp = gp;
				break;
			}
		}

		if (!activeGp) {
			if (this.connectedGamepadName !== null) {
				this.connectedGamepadName = null;
				this.renderDetectorStatus();
			}
			return;
		}

		if (this.connectedGamepadName !== activeGp.id) {
			this.connectedGamepadName = activeGp.id;
			this.renderDetectorStatus();
		}

		const buttons = activeGp.buttons;
		for (let i = 0; i < buttons.length; i++) {
			const btn = buttons[i];
			if (!btn) continue;
			const isPressed = btn.pressed || btn.value > 0.5;
			const wasPressed = !!this.prevGamepadButtons[i];

			if (isPressed && !wasPressed) {
				this.handleDetectedInput({ type: 'gamepad', buttonIndex: i });
			}
		}

		this.prevGamepadButtons = buttons.map(b => (b ? (b.pressed || b.value > 0.5) : false));
	}

	private handleDetectedInput(input: DetectedInput): void {
		this.lastDetected = input;
		this.renderDetectorContent();

		// Highlight corresponding row if present
		let rowId = '';
		if (input.type === 'gamepad' && input.buttonIndex !== undefined) {
			rowId = `anki-remote-btn-${input.buttonIndex}`;
			if (this.activeTab !== 'gamepad') {
				this.activeTab = 'gamepad';
				this.renderTables();
			}
		} else if (input.type === 'keyboard' && input.key !== undefined) {
			rowId = `anki-remote-key-${encodeURIComponent(input.key)}`;
			if (this.activeTab !== 'keyboard') {
				this.activeTab = 'keyboard';
				this.renderTables();
			}
		}

		if (rowId) {
			const row = this.contentEl.querySelector(`#${rowId}`);
			if (row) {
				row.addClass('is-active-row');
				row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
				window.setTimeout(() => {
					row.removeClass('is-active-row');
				}, 600);
			}
		}
	}

	private render(): void {
		this.contentEl.empty();
		this.titleEl.setText('🎮 Customize Anki remote and controller');

		// 1. Live Button Detector Box
		this.renderDetectorBox();

		// 2. Tab Navigation
		const tabContainer = this.contentEl.createDiv({ cls: 'anki-remote-tabs' });
		const gamepadTabBtn = tabContainer.createEl('button', {
			cls: `anki-remote-tab-btn ${this.activeTab === 'gamepad' ? 'is-active' : ''}`,
			text: 'Gamepad / controller',
		});
		gamepadTabBtn.onclick = () => {
			this.activeTab = 'gamepad';
			this.renderTables();
			this.updateTabStyles(tabContainer);
		};

		const keyboardTabBtn = tabContainer.createEl('button', {
			cls: `anki-remote-tab-btn ${this.activeTab === 'keyboard' ? 'is-active' : ''}`,
			text: 'Keyboard / remote',
		});
		keyboardTabBtn.onclick = () => {
			this.activeTab = 'keyboard';
			this.renderTables();
			this.updateTabStyles(tabContainer);
		};

		// 3. Mappings Table Container
		this.contentEl.createDiv({ cls: 'anki-remote-tables-container' });
		this.renderTables();

		// 4. Modal Footer Actions
		const footer = this.contentEl.createDiv({ cls: 'anki-remote-footer' });
		const resetBtn = footer.createEl('button', {
			cls: 'anki-remote-btn-secondary',
			text: 'Reset to defaults',
		});
		resetBtn.onclick = async () => {
			this.plugin.settings.gamepadMapping = { ...DEFAULT_GAMEPAD_MAPPING };
			this.plugin.settings.keyboardMapping = { ...DEFAULT_KEYBOARD_MAPPING };
			await this.plugin.saveData(this.plugin.settings);
			new Notice('Mappings reset to default');
			this.render();
		};

		const doneBtn = footer.createEl('button', {
			cls: 'mod-cta',
			text: 'Done',
		});
		doneBtn.onclick = () => {
			this.close();
		};
	}

	private updateTabStyles(container: HTMLElement): void {
		const btns = container.querySelectorAll('.anki-remote-tab-btn');
		btns.forEach((b, idx) => {
			if ((idx === 0 && this.activeTab === 'gamepad') || (idx === 1 && this.activeTab === 'keyboard')) {
				b.addClass('is-active');
			} else {
				b.removeClass('is-active');
			}
		});
	}

	private renderDetectorBox(): void {
		const detectorBox = this.contentEl.createDiv({ cls: 'anki-remote-detector' });
		detectorBox.createDiv({ cls: 'anki-remote-detector-header', text: '⚡ Live button detector and tester' });

		const statusEl = detectorBox.createDiv({ cls: 'anki-remote-detector-status' });
		statusEl.id = 'anki-remote-detector-status';
		this.renderDetectorStatus();

		const contentEl = detectorBox.createDiv({ cls: 'anki-remote-detector-content' });
		contentEl.id = 'anki-remote-detector-content';
		this.renderDetectorContent();
	}

	private renderDetectorStatus(): void {
		const el = this.contentEl.querySelector('#anki-remote-detector-status');
		if (!el) return;
		el.empty();

		if (this.connectedGamepadName) {
			el.createSpan({
				cls: 'anki-remote-status-pill is-connected',
				text: `🎮 Connected: ${this.connectedGamepadName}`,
			});
		} else {
			el.createSpan({
				cls: 'anki-remote-status-pill',
				text: '🎮 No controller detected yet (Bluetooth or USB)',
			});
		}
	}

	private renderDetectorContent(): void {
		const el = this.contentEl.querySelector('#anki-remote-detector-content');
		if (!el) return;
		el.empty();

		if (!this.lastDetected) {
			const prompt = el.createDiv({ cls: 'anki-remote-detector-prompt' });
			prompt.createSpan({ text: '👉 Press any button on your controller, remote, or keyboard to test and customize it.' });
			return;
		}

		const resultCard = el.createDiv({ cls: 'anki-remote-detected-card' });

		let title = '';
		let currentAction: RemoteAction = 'none';

		if (this.lastDetected.type === 'gamepad' && this.lastDetected.buttonIndex !== undefined) {
			const btnIdx = this.lastDetected.buttonIndex;
			title = GAMEPAD_BUTTON_NAMES[btnIdx] || `Button ${btnIdx}`;
			currentAction = this.plugin.settings.gamepadMapping[btnIdx] || 'none';
		} else if (this.lastDetected.type === 'keyboard' && this.lastDetected.key !== undefined) {
			title = `Keyboard key: "${this.lastDetected.key}"`;
			currentAction = this.plugin.settings.keyboardMapping[this.lastDetected.key] || 'none';
		}

		const badge = resultCard.createDiv({ cls: 'anki-remote-detected-badge' });
		badge.createSpan({ text: `✨ Pressed: ${title}` });

		const actionRow = resultCard.createDiv({ cls: 'anki-remote-detected-action-row' });
		actionRow.createSpan({ text: 'Assigned review action: ' });

		const selectEl = actionRow.createEl('select', { cls: 'anki-embed-select anki-remote-select' });
		this.populateActionOptions(selectEl, currentAction);

		selectEl.onchange = async () => {
			const newAction = selectEl.value as RemoteAction;
			if (this.lastDetected?.type === 'gamepad' && this.lastDetected.buttonIndex !== undefined) {
				this.plugin.settings.gamepadMapping[this.lastDetected.buttonIndex] = newAction;
			} else if (this.lastDetected?.type === 'keyboard' && this.lastDetected.key !== undefined) {
				this.plugin.settings.keyboardMapping[this.lastDetected.key] = newAction;
			}
			await this.plugin.saveData(this.plugin.settings);
			new Notice(`Updated ${title} ➔ ${REMOTE_ACTION_LABELS[newAction]}`);
			this.renderTables();
		};
	}

	private renderTables(): void {
		const container = this.contentEl.querySelector('.anki-remote-tables-container');
		if (!container) return;
		container.empty();

		if (this.activeTab === 'gamepad') {
			this.renderGamepadTable(container as HTMLElement);
		} else {
			this.renderKeyboardTable(container as HTMLElement);
		}
	}

	private renderGamepadTable(parent: HTMLElement): void {
		const tableWrapper = parent.createDiv({ cls: 'anki-remote-table-wrapper' });
		const table = tableWrapper.createEl('table', { cls: 'anki-remote-table' });

		const thead = table.createEl('thead');
		const headRow = thead.createEl('tr');
		headRow.createEl('th', { text: 'Controller button' });
		headRow.createEl('th', { text: 'Review action' });

		const tbody = table.createEl('tbody');

		// Display buttons 0 through 15 (standard buttons) + any customized extra buttons
		const knownIndices = new Set<number>();
		for (let i = 0; i <= 15; i++) knownIndices.add(i);
		for (const key of Object.keys(this.plugin.settings.gamepadMapping)) {
			const parsed = Number.parseInt(key, 10);
			if (!Number.isNaN(parsed)) knownIndices.add(parsed);
		}

		const sortedIndices = Array.from(knownIndices).sort((a, b) => a - b);

		for (const btnIdx of sortedIndices) {
			const row = tbody.createEl('tr', { cls: 'anki-remote-row' });
			row.id = `anki-remote-btn-${btnIdx}`;

			const nameCell = row.createEl('td', { cls: 'anki-remote-name-col' });
			nameCell.createSpan({
				cls: 'anki-remote-button-name',
				text: GAMEPAD_BUTTON_NAMES[btnIdx] || `Button ${btnIdx}`,
			});

			const actionCell = row.createEl('td', { cls: 'anki-remote-action-col' });
			const currentAction = this.plugin.settings.gamepadMapping[btnIdx] || 'none';
			const selectEl = actionCell.createEl('select', { cls: 'anki-embed-select anki-remote-select' });
			this.populateActionOptions(selectEl, currentAction);

			selectEl.onchange = async () => {
				const newAction = selectEl.value as RemoteAction;
				this.plugin.settings.gamepadMapping[btnIdx] = newAction;
				await this.plugin.saveData(this.plugin.settings);
				if (this.lastDetected?.type === 'gamepad' && this.lastDetected.buttonIndex === btnIdx) {
					this.renderDetectorContent();
				}
			};
		}
	}

	private renderKeyboardTable(parent: HTMLElement): void {
		const topRow = parent.createDiv({ cls: 'anki-remote-add-key-bar' });
		const keyInput = topRow.createEl('input', {
			cls: 'anki-embed-search-input',
			attr: { placeholder: 'Type a key or press it to add...', maxlength: '10' },
		});

		const addBtn = topRow.createEl('button', {
			cls: 'mod-cta',
			text: 'Add key shortcut',
		});

		addBtn.onclick = async () => {
			const rawKey = keyInput.value.trim();
			if (!rawKey) return;
			const key = rawKey.length === 1 ? rawKey.toLowerCase() : rawKey;
			if (!this.plugin.settings.keyboardMapping[key]) {
				this.plugin.settings.keyboardMapping[key] = 'flip_or_good';
				await this.plugin.saveData(this.plugin.settings);
				keyInput.value = '';
				this.renderTables();
			}
		};

		keyInput.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				addBtn.click();
			}
		});

		const tableWrapper = parent.createDiv({ cls: 'anki-remote-table-wrapper' });
		const table = tableWrapper.createEl('table', { cls: 'anki-remote-table' });

		const thead = table.createEl('thead');
		const headRow = thead.createEl('tr');
		headRow.createEl('th', { text: 'Key' });
		headRow.createEl('th', { text: 'Review action' });
		headRow.createEl('th', { text: 'Remove' });

		const tbody = table.createEl('tbody');
		const keys = Object.keys(this.plugin.settings.keyboardMapping).sort();

		for (const key of keys) {
			const row = tbody.createEl('tr', { cls: 'anki-remote-row' });
			row.id = `anki-remote-key-${encodeURIComponent(key)}`;

			const nameCell = row.createEl('td', { cls: 'anki-remote-name-col' });
			nameCell.createSpan({
				cls: 'anki-remote-key-badge',
				text: key === ' ' ? 'Space' : key,
			});

			const actionCell = row.createEl('td', { cls: 'anki-remote-action-col' });
			const currentAction = this.plugin.settings.keyboardMapping[key] || 'none';
			const selectEl = actionCell.createEl('select', { cls: 'anki-embed-select anki-remote-select' });
			this.populateActionOptions(selectEl, currentAction);

			selectEl.onchange = async () => {
				const newAction = selectEl.value as RemoteAction;
				this.plugin.settings.keyboardMapping[key] = newAction;
				await this.plugin.saveData(this.plugin.settings);
				if (this.lastDetected?.type === 'keyboard' && this.lastDetected.key === key) {
					this.renderDetectorContent();
				}
			};

			const deleteCell = row.createEl('td', { cls: 'anki-remote-delete-col' });
			const delBtn = deleteCell.createEl('button', {
				cls: 'anki-embed-btn-icon',
				text: '🗑️',
				attr: { title: 'Remove key shortcut' },
			});
			delBtn.onclick = async () => {
				delete this.plugin.settings.keyboardMapping[key];
				await this.plugin.saveData(this.plugin.settings);
				this.renderTables();
			};
		}
	}

	private populateActionOptions(selectEl: HTMLSelectElement, selectedAction: RemoteAction): void {
		const actionKeys = Object.keys(REMOTE_ACTION_LABELS) as RemoteAction[];
		for (const action of actionKeys) {
			const opt = selectEl.createEl('option', {
				value: action,
				text: REMOTE_ACTION_LABELS[action],
			});
			if (action === selectedAction) {
				opt.selected = true;
			}
		}
	}
}
