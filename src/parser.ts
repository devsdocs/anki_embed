import { DeckEmbedConfig } from './types';

export function parseDeckConfig(source: string): DeckEmbedConfig {
	const config: DeckEmbedConfig = {};
	const lines = source.split('\n').map(l => l.trim()).filter(l => l.length > 0);

	if (lines.length === 0) {
		return config;
	}

	let hasKeyValue = false;

	for (const line of lines) {
		const colonIdx = line.indexOf(':');
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim().toLowerCase();
			const val = line.slice(colonIdx + 1).trim();

			if (key === 'deck') {
				config.deck = val.replace(/^["']|["']$/g, '');
				hasKeyValue = true;
			} else if (key === 'query') {
				config.query = val;
				hasKeyValue = true;
			} else if (key === 'limit') {
				const num = Number.parseInt(val, 10);
				if (!Number.isNaN(num) && num > 0) {
					config.limit = num;
				}
				hasKeyValue = true;
			} else if (key === 'filter') {
				const f = val.toLowerCase().replace(/\s+/g, '');
				if (['all', 'due', 'new'].includes(f)) {
					config.filter = f as 'all' | 'due' | 'new';
				} else if (['due+new', 'due_new', 'both', 'study', 'dueandnew'].includes(f)) {
					config.filter = 'due+new';
				}
				hasKeyValue = true;
			} else if (key === 'randomize' || key === 'shuffle') {
				config.randomize = val.toLowerCase() === 'true' || val === '1' || val.toLowerCase() === 'yes';
				hasKeyValue = true;
			} else if (key === 'select' || key === 'interactive') {
				config.select = val.toLowerCase() === 'true' || val === '1' || val.toLowerCase() === 'yes';
				hasKeyValue = true;
			} else if (key === 'styles' || key === 'style') {
				const valLower = val.toLowerCase();
				if (['true', '1', 'yes', 'anki', 'original'].includes(valLower)) {
					config.styles = true;
				} else if (['false', '0', 'no', 'obsidian', 'native'].includes(valLower)) {
					config.styles = false;
				}
				hasKeyValue = true;
			} else if (key === 'live' || key === 'livesync' || key === 'sync') {
				const valLower = val.toLowerCase();
				if (['true', '1', 'yes', 'live', 'on'].includes(valLower)) {
					config.live = true;
				} else if (['false', '0', 'no', 'off', 'none'].includes(valLower)) {
					config.live = false;
				}
				hasKeyValue = true;
			} else if (key === 'suspended' || key === 'excludesuspended' || key === 'exclude_suspended' || key === 'unsuspended') {
				const valLower = val.toLowerCase();
				if (key === 'suspended') {
					config.excludeSuspended = !(valLower === 'true' || valLower === '1' || valLower === 'yes');
				} else {
					config.excludeSuspended = valLower === 'true' || valLower === '1' || valLower === 'yes';
				}
				hasKeyValue = true;
			} else if (key === 'order' || key === 'sort') {
				const valLower = val.toLowerCase().replace(/[\s_]+/g, '-');
				if (['reviews-first', 'reviews', 'review-first', 'due-first'].includes(valLower)) {
					config.order = 'reviews-first';
				} else if (['random', 'shuffle'].includes(valLower)) {
					config.order = 'random';
				} else if (['default', 'deck'].includes(valLower)) {
					config.order = 'default';
				}
				hasKeyValue = true;
			} else if (key === 'counts' || key === 'showcounts' || key === 'show_counts' || key === 'stats') {
				const valLower = val.toLowerCase();
				config.counts = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'heatmap' || key === 'showheatmap' || key === 'show_heatmap') {
				const valLower = val.toLowerCase();
				config.heatmap = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'timer' || key === 'showtimer' || key === 'show_timer') {
				const valLower = val.toLowerCase();
				config.timer = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'timer_warning' || key === 'warning' || key === 'timerwarning') {
				const num = Number.parseFloat(val);
				if (!Number.isNaN(num) && num > 0) {
					config.timerWarning = num;
				}
				hasKeyValue = true;
			} else if (key === 'timer_limit' || key === 'limit_seconds' || key === 'timerlimit' || key === 'timer_max') {
				const num = Number.parseFloat(val);
				if (!Number.isNaN(num) && num > 0) {
					config.timerLimit = num;
				}
				hasKeyValue = true;
			} else if (key === 'flash' || key === 'buttonflash' || key === 'button_flash') {
				const valLower = val.toLowerCase();
				config.flash = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'flash_duration' || key === 'flashduration') {
				const num = Number.parseInt(val, 10);
				if (!Number.isNaN(num) && num >= 0) {
					config.flashDuration = num;
				}
				hasKeyValue = true;
			} else if (key === 'flash_transition' || key === 'flashtransition') {
				const num = Number.parseInt(val, 10);
				if (!Number.isNaN(num) && num >= 0) {
					config.flashTransition = num;
				}
				hasKeyValue = true;
			} else if (key === 'remote' || key === 'gamepad' || key === 'controller' || key === 'contanki') {
				const valLower = val.toLowerCase();
				config.remote = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'card' || key === 'cardid' || key === 'cid') {
				const num = Number.parseInt(val, 10);
				if (!Number.isNaN(num) && num > 0) {
					config.card = num;
					config.cardId = num;
				}
				hasKeyValue = true;
			} else if (key === 'font_scale' || key === 'fontscale' || key === 'scale' || key === 'fontsize' || key === 'font_size') {
				const num = Number.parseFloat(val.replace(/[xX]/g, ''));
				if (!Number.isNaN(num) && num > 0) {
					config.fontScale = num;
					config.scale = num;
				}
				hasKeyValue = true;
			} else if (key === 'links' || key === 'link' || key === 'cardlinks' || key === 'card_links') {
				const valLower = val.toLowerCase();
				config.links = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'backlinks' || key === 'backlink') {
				const valLower = val.toLowerCase();
				config.backlinks = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			} else if (key === 'taglinks' || key === 'tag_links' || key === 'taglink' || key === 'tag_link') {
				const valLower = val.toLowerCase();
				config.tagLinks = valLower === 'true' || valLower === '1' || valLower === 'yes';
				hasKeyValue = true;
			}
		}
	}

	if (config.deck === '?' || config.deck?.toLowerCase() === 'select' || config.deck?.toLowerCase() === 'choose') {
		config.select = true;
		delete config.deck;
	}

	// If no explicit key:value pairs were detected, treat the raw string as deck name or query
	if (!hasKeyValue) {
		const rawText = lines.join(' ').trim();
		if (rawText.startsWith('query:') || rawText.includes('is:due') || rawText.includes('tag:')) {
			config.query = rawText.replace(/^query:\s*/i, '');
		} else {
			config.deck = rawText;
		}
	}

	return config;
}

export function parsePastedAnkiText(text: string): { deckName: string } | null {
	const trimmed = text.trim();

	// Match anki://deck/DeckName or anki:DeckName
	const uriMatch = trimmed.match(/^anki:\/\/(?:deck\/)?(.+)$/i) || trimmed.match(/^anki:(.+)$/i);
	if (uriMatch?.[1]) {
		return { deckName: decodeURIComponent(uriMatch[1].trim()) };
	}

	return null;
}

export function parseDelimitedText(text: string): string[][] {
	const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0 && !l.trim().startsWith('#'));
	if (lines.length === 0) {
		throw new Error('Text is empty or only contains comments.');
	}

	const delimiters = ['\t', ';', ','];
	let bestDelimiter = '';
	let maxCols = 0;

	// Guess delimiter by checking the first few lines
	for (const delim of delimiters) {
		const colsFirst = splitCsvLine(lines[0] ?? '', delim).length;
		if (colsFirst > 1) {
			const consistent = lines.slice(0, 5).every(l => splitCsvLine(l, delim).length === colsFirst);
			if (consistent && colsFirst > maxCols) {
				bestDelimiter = delim;
				maxCols = colsFirst;
			}
		}
	}

	// If no multi-column delimiter found, assume single column or default to tab
	if (!bestDelimiter) {
		// Just split by tab anyway
		bestDelimiter = '\t';
	}

	const parsed = lines.map(line => splitCsvLine(line, bestDelimiter).map(col => col.trim()));

	// Validate consistency (fail loudly if inconsistent)
	const colCount = parsed[0]?.length ?? 0;
	for (let i = 1; i < parsed.length; i++) {
		if ((parsed[i]?.length ?? 0) !== colCount) {
			throw new Error(`Inconsistent column count at line ${i + 1}. Expected ${colCount}, found ${parsed[i]?.length ?? 0}.`);
		}
	}

	return parsed;
}

function splitCsvLine(line: string, delimiter: string): string[] {
	const cols: string[] = [];
	let current = '';
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++; // Skip escaped quote
			} else {
				inQuotes = !inQuotes;
			}
		} else if (c === delimiter && !inQuotes) {
			cols.push(current);
			current = '';
		} else {
			current += c;
		}
	}
	cols.push(current);
	return cols;
}
