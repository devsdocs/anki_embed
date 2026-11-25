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

export function matchesCardId(val: unknown, cardIdStr: string): boolean {
	if (typeof val === 'string' || typeof val === 'number') {
		const str = String(val).trim();
		return (
			str === cardIdStr ||
			str.includes(`cardId=${cardIdStr}`) ||
			str.includes(`card=${cardIdStr}`) ||
			str.includes(`cid:${cardIdStr}`) ||
			str.includes(`cid=${cardIdStr}`)
		);
	}
	return false;
}

export function checkFrontmatterForCardId(fm: Record<string, unknown>, cardIdStr: string): boolean {
	const keys = [
		'linked-cards',
		'linked-card',
		'linkedCards',
		'linkedCard',
		'linked_cards',
		'linked_card',
		'anki-cards',
		'anki-card-id',
		'anki-card',
		'cardId',
		'card-id',
		'card',
		'cid',
		'ankiCards',
		'ankiCardId',
	];
	for (const key of keys) {
		const val = fm[key];
		if (Array.isArray(val)) {
			if (val.some((c) => matchesCardId(c, cardIdStr))) return true;
		} else if (matchesCardId(val, cardIdStr)) {
			return true;
		}
	}
	return false;
}

export function extractLinkedCardIdsFromFrontmatter(fm?: Record<string, unknown> | null): number[] {
	if (!fm) return [];
	const cardIds = new Set<number>();
	const keys = [
		'linked-cards',
		'linked-card',
		'linkedCards',
		'linkedCard',
		'linked_cards',
		'linked_card',
		'anki-cards',
		'anki-card-id',
		'anki-card',
		'cardId',
		'card-id',
		'card',
		'cid',
		'ankiCards',
		'ankiCardId',
	];

	for (const key of keys) {
		const val = fm[key];
		const parseNum = (v: unknown): void => {
			if (typeof v === 'number') {
				cardIds.add(v);
			} else if (typeof v === 'string') {
				const trimmed = v.trim();
				const num = Number.parseInt(trimmed, 10);
				if (!Number.isNaN(num) && num > 0) {
					cardIds.add(num);
				} else {
					const uriMatch = trimmed.match(/[?&]card(?:Id)?=(\d+)\b/i) ?? trimmed.match(/\b(?:cid:)?(\d{8,})\b/);
					if (uriMatch?.[1]) {
						const uriNum = Number.parseInt(uriMatch[1], 10);
						if (!Number.isNaN(uriNum) && uriNum > 0) {
							cardIds.add(uriNum);
						}
					}
				}
			}
		};

		if (Array.isArray(val)) {
			for (const item of val) {
				parseNum(item);
			}
		} else if (val !== undefined && val !== null) {
			parseNum(val);
		}
	}

	return Array.from(cardIds);
}

export function extractCardIdsFromText(content: string): number[] {
	if (!content) return [];
	const cardIds = new Set<number>();
	const uriMatches = content.matchAll(/[?&]card(?:Id)?=(\d+)\b/gi);
	for (const m of uriMatches) {
		const num = Number.parseInt(m[1] ?? '', 10);
		if (!Number.isNaN(num) && num > 0) cardIds.add(num);
	}
	const codeblockMatches = content.matchAll(/```anki\b[\s\S]*?\bcard(?:Id)?:\s*(\d+)\b[\s\S]*?```/gi);
	for (const m of codeblockMatches) {
		const num = Number.parseInt(m[1] ?? '', 10);
		if (!Number.isNaN(num) && num > 0) cardIds.add(num);
	}
	return Array.from(cardIds);
}

export function normalizeAnkiTag(tag: string): string {
	if (!tag) return '';
	let clean = tag.trim();
	// Remove leading #
	clean = clean.replace(/^#+/, '');
	// Remove anki/ or anki-tag/ prefix (case-insensitive)
	clean = clean.replace(/^anki(?:-tags?|tag|\/|::)\/?/i, '');
	// Remove any remaining leading #
	clean = clean.replace(/^#+/, '');
	// Replace forward slashes with :: for unified hierarchy
	clean = clean.replace(/\/+/g, '::');
	// Remove # in nested segments like ::#FirstAid -> ::FirstAid
	clean = clean.replace(/::#+/g, '::');
	return clean.trim();
}

export interface AnkiTagItem {
	tagToInsert: string;
	leafTag: string;
	parentPath: string;
	fullHierarchy: string;
}

export function parseTagItem(rawTag: string): AnkiTagItem {
	const clean = normalizeAnkiTag(rawTag);
	const rawClean = rawTag.replace(/^#+/, '').trim();
	const segments = clean.split('::').filter(Boolean);
	const rawSegments = rawClean.split('::').filter(Boolean);

	if (segments.length <= 1) {
		const name = segments[0] ?? clean;
		return {
			tagToInsert: clean,
			leafTag: name,
			parentPath: '',
			fullHierarchy: clean,
		};
	}

	const leafTag = rawSegments[rawSegments.length - 1] ?? segments[segments.length - 1] ?? clean;
	const parents = rawSegments.slice(0, -1);
	const parentPath = parents.join(' › ');

	return {
		tagToInsert: clean,
		leafTag,
		parentPath,
		fullHierarchy: clean,
	};
}

export function isTagMatch(cardTag: string, noteTag: string): boolean {
	const cNorm = normalizeAnkiTag(cardTag).toLowerCase();
	const nNorm = normalizeAnkiTag(noteTag).toLowerCase();
	if (!cNorm || !nNorm) return false;

	// Exact match
	if (cNorm === nNorm) return true;

	// Normalize spaces and underscores: e.g. "beta blockers" vs "beta_blockers"
	const cSpace = cNorm.replace(/_/g, ' ');
	const nSpace = nNorm.replace(/_/g, ' ');
	if (cSpace === nSpace) return true;

	// Hierarchical match on full hierarchy path
	if (
		cNorm.startsWith(nNorm + '::') ||
		cNorm.endsWith('::' + nNorm) ||
		cNorm.includes('::' + nNorm + '::') ||
		cSpace.startsWith(nSpace + '::') ||
		cSpace.endsWith('::' + nSpace) ||
		cSpace.includes('::' + nSpace + '::')
	) {
		return true;
	}

	// Segment-level comparison (e.g. segment "03_cardio" matches note tag "cardio")
	const cSegments = cNorm.split('::').filter(Boolean);
	const nSegments = nNorm.split('::').filter(Boolean);

	if (nSegments.length > 1) {
		// Multi-segment note tag: check if nSegments match a contiguous slice of cSegments
		for (let i = 0; i <= cSegments.length - nSegments.length; i++) {
			let allMatch = true;
			for (let j = 0; j < nSegments.length; j++) {
				const cSeg = cSegments[i + j] ?? '';
				const nSeg = nSegments[j] ?? '';
				const cStripped = cSeg.replace(/^\d+[-_]/, '');
				const nStripped = nSeg.replace(/^\d+[-_]/, '');
				const cSegSpace = cSeg.replace(/_/g, ' ');
				const nSegSpace = nSeg.replace(/_/g, ' ');
				const cStrSpace = cStripped.replace(/_/g, ' ');
				const nStrSpace = nStripped.replace(/_/g, ' ');
				if (
					cSeg !== nSeg &&
					cStripped !== nSeg &&
					cSeg !== nStripped &&
					cStripped !== nStripped &&
					cSegSpace !== nSegSpace &&
					cStrSpace !== nSegSpace &&
					cSegSpace !== nStrSpace &&
					cStrSpace !== nStrSpace
				) {
					allMatch = false;
					break;
				}
			}
			if (allMatch) return true;
		}
	} else if (nSegments.length === 1) {
		const target = nSegments[0] ?? '';
		const targetStripped = target.replace(/^\d+[-_]/, '');
		const targetSpace = target.replace(/_/g, ' ');
		const targetStrippedSpace = targetStripped.replace(/_/g, ' ');

		for (const seg of cSegments) {
			if (seg === target || seg === targetStripped) return true;
			const segStripped = seg.replace(/^\d+[-_]/, '');
			if (segStripped === target || segStripped === targetStripped) return true;
			const segSpace = seg.replace(/_/g, ' ');
			const segStrippedSpace = segStripped.replace(/_/g, ' ');
			if (
				segSpace === targetSpace ||
				segSpace === targetStrippedSpace ||
				segStrippedSpace === targetSpace ||
				segStrippedSpace === targetStrippedSpace
			) {
				return true;
			}
		}
	}

	return false;
}

export function findMatchingAnkiTag(cardTags: string[], noteTags: string[]): string | null {
	if (!cardTags.length || !noteTags.length) return null;
	for (const noteTag of noteTags) {
		for (const cardTag of cardTags) {
			if (isTagMatch(cardTag, noteTag)) {
				return noteTag;
			}
		}
	}
	return null;
}

export function extractAnkiTagsFromNote(
	cache: {
		frontmatter?: Record<string, unknown> | null;
		tags?: Array<{ tag: string }> | null;
	} | null | undefined
): string[] {
	if (!cache) return [];
	const tags = new Set<string>();

	const addTag = (val: unknown) => {
		if (typeof val === 'string') {
			for (const part of val.split(/[,;\n]/)) {
				const trimmed = part.trim();
				if (trimmed) {
					tags.add(normalizeAnkiTag(trimmed));
				}
			}
		} else if (Array.isArray(val)) {
			for (const item of val) {
				addTag(item);
			}
		}
	};

	const fm = cache.frontmatter as Record<string, unknown> | undefined;
	if (fm) {
		const tagKeys = ['anki-tags', 'anki_tags', 'anki-tag', 'anki_tag', 'ankitags', 'ankitag'];
		for (const k of tagKeys) {
			if (fm[k] !== undefined) {
				addTag(fm[k]);
			}
		}

		if (fm.anki && typeof fm.anki === 'object' && !Array.isArray(fm.anki)) {
			const ankiObj = fm.anki as Record<string, unknown>;
			if (ankiObj.tags !== undefined) addTag(ankiObj.tags);
			if (ankiObj.tag !== undefined) addTag(ankiObj.tag);
		} else if (fm.anki !== undefined) {
			addTag(fm.anki);
		}

		// Also check standard tags for anki/ prefix (e.g. tags: [anki/Cardio])
		const checkGeneralTags = (val: unknown) => {
			if (typeof val === 'string') {
				for (const part of val.split(/[,;\n]/)) {
					const trimmed = part.trim();
					if (/^#?anki(?:-tags?|tag|\/|::)/i.test(trimmed)) {
						tags.add(normalizeAnkiTag(trimmed));
					}
				}
			} else if (Array.isArray(val)) {
				for (const item of val) {
					checkGeneralTags(item);
				}
			}
		};

		if (fm.tags !== undefined) checkGeneralTags(fm.tags);
		if (fm.tag !== undefined) checkGeneralTags(fm.tag);
	}

	// Inline tags from cache.tags (e.g. #anki/Cardio or #anki-tag/Cardio)
	if (cache.tags && Array.isArray(cache.tags)) {
		for (const t of cache.tags) {
			if (t && typeof t.tag === 'string') {
				if (/^#?anki(?:-tags?|tag|\/|::)/i.test(t.tag)) {
					tags.add(normalizeAnkiTag(t.tag));
				}
			}
		}
	}

	return Array.from(tags).filter((t) => t.length > 0);
}

export function extractAnkiTagsFromText(content: string): string[] {
	if (!content) return [];
	const tags = new Set<string>();

	// 1. Check frontmatter if present
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (fmMatch && fmMatch[1]) {
		const fmText = fmMatch[1];
		const ankiTagMatch = fmText.match(/(?:anki[-_]?tags?)\s*:\s*([^\r\n]+)/i);
		if (ankiTagMatch && ankiTagMatch[1]) {
			const rawVal = ankiTagMatch[1].replace(/[\]['"]/g, '');
			for (const part of rawVal.split(/[,;\s]+/)) {
				const trimmed = part.trim();
				if (trimmed) tags.add(normalizeAnkiTag(trimmed));
			}
		}
	}

	// 2. Check inline #anki/... tags
	const inlineMatches = content.match(/#anki(?:-tags?|tag|\/|::)[A-Za-z0-9_:#&/.-]+/gi) || [];
	for (const m of inlineMatches) {
		tags.add(normalizeAnkiTag(m));
	}

	return Array.from(tags).filter((t) => t.length > 0);
}

export function renderClozeDeletion(text: string, targetOrd: number, placeholder: string = '**[...]**'): string {
	const targetIndex = targetOrd + 1;
	const clozeRegex = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

	return text.replace(clozeRegex, (_match: string, numStr: string, answerText: string): string => {
		const num = Number.parseInt(numStr, 10);
		if (num === targetIndex) {
			return placeholder;
		} else {
			return (answerText ?? '').trim();
		}
	});
}

export function formatClozeTitle(
	questionOrText: string,
	options?: {
		card?: { fields?: Record<string, { value: string }>; ord?: number; question?: string };
		placeholder?: string;
	}
): string {
	const placeholder = options?.placeholder ?? '**[...]**';
	const card = options?.card;

	let text = '';
	if (card?.fields?.Text?.value) {
		const ord = card.ord ?? 0;
		text = renderClozeDeletion(card.fields.Text.value, ord, placeholder);
	} else if (card?.question) {
		text = card.question.replace(/<(?:span|div)\b[^>]*\bclass\s*=\s*["']?cloze["'][^>]*>[\s\S]*?<\/(?:span|div)>/gi, placeholder);
	} else {
		text = questionOrText;
	}

	// Remove basic HTML tags
	text = text.replace(/<[^>]+>/g, '');

	// Decode common HTML entities
	text = text
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'");

	// Standardize cloze placeholders: ensure hint or unbolded [...] becomes the placeholder
	text = text.replace(/(?:\*\*)?\[[\s\S]*?\](?:\*\*)?/g, (match) => {
		if (match.includes('...') || match.includes('[...]')) {
			return placeholder;
		}
		return match;
	});

	// Normalize spaces and newlines
	let clean = text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
	// Remove leading markdown header marks (#)
	clean = clean.replace(/^#+\s*/, '').trim();

	return clean;
}


