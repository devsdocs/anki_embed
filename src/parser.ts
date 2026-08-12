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
			}
		}
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
