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
				const f = val.toLowerCase();
				if (['all', 'due', 'new'].includes(f)) {
					config.filter = f as 'all' | 'due' | 'new';
				}
				hasKeyValue = true;
			} else if (key === 'randomize' || key === 'shuffle') {
				config.randomize = val.toLowerCase() === 'true' || val === '1' || val.toLowerCase() === 'yes';
				hasKeyValue = true;
			} else if (key === 'select' || key === 'interactive') {
				config.select = val.toLowerCase() === 'true' || val === '1' || val.toLowerCase() === 'yes';
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
