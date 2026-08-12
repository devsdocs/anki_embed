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
