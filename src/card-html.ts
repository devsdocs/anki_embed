export function formatCardHtml(rawHtml: string, questionHtml?: string): string {
	let result = rawHtml;
	if (questionHtml) {
		result = result.replace(/\{\{FrontSide\}\}/g, () => questionHtml);
	}
	return result.replace(/\[sound:([^\]]+)\]/gi, '🔊 <i>($1)</i>');
}

export function extractAnswerHtml(answerHtml: string): string {
	const answerMarker = /<hr\b[^>]*\bid\s*=\s*["']?answer["']?[^>]*>/i;
	const marker = answerHtml.match(answerMarker);
	if (!marker || marker.index === undefined) {
		return answerHtml;
	}

	return answerHtml.slice(marker.index + marker[0].length);
}

export function normalizeAnkiCss(css: string): string {
	if (!css) return '';
	return css.replace(/\b(?:html|body)\b/g, '.card');
}

export function isClozeCard(card?: { modelName?: string; question?: string; answer?: string }): boolean {
	if (!card) return false;
	if (card.modelName && card.modelName.toLowerCase().includes('cloze')) {
		return true;
	}
	if (card.question && (card.question.includes('[...]') || /<(?:span|div)\b[^>]*\bclass\s*=\s*["']?cloze/i.test(card.question))) {
		return true;
	}
	if (card.answer && /<(?:span|div)\b[^>]*\bclass\s*=\s*["']?cloze/i.test(card.answer)) {
		return true;
	}
	return false;
}


