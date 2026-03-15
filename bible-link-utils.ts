export interface BibleUriMatch {
	uri: string;
	start: number;
	end: number;
}

function createBibleUriPatterns(): RegExp[] {
	return [
		/\[\[(bible:(?:\/\/)?[^\]|]+)(?:\|[^\]]+)?\]\]/gi,
		/\[\[[^\]|]+\|\s*(bible:(?:\/\/)?[^\]]+)\]\]/gi,
		/\[[^\]]*]\((bible:(?:\/\/)?[^)]+)\)/gi,
		/\b(bible:(?:\/\/)?[^\s)\]]+)/gi,
	];
}

function isRangeInsideLinkSyntax(line: string, start: number, end: number): boolean {
	const patterns = [/\[[^\]]*]\([^)]+\)/g, /\[\[[^\]]+]]/g];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null = null;
		while ((match = pattern.exec(line)) !== null) {
			const linkStart = match.index;
			const linkEnd = linkStart + match[0].length;
			if (start >= linkStart && end <= linkEnd) {
				return true;
			}
		}
	}
	return false;
}

function normalizeMatchedBibleUri(input: string): string {
	return input.trim().replace(/[.,;!?]+$/, "");
}

export function parseBibleUri(uri: string): string | null {
	if (!uri.toLowerCase().startsWith("bible:")) {
		return null;
	}
	const encodedReference = uri.replace(/^bible:(\/\/)?/i, "");
	try {
		return decodeURIComponent(encodedReference).trim();
	} catch {
		return encodedReference.trim();
	}
}

export function findBibleUriMatchInLine(line: string, offset?: number): BibleUriMatch | null {
	for (const pattern of createBibleUriPatterns()) {
		let match: RegExpExecArray | null = null;
		while ((match = pattern.exec(line)) !== null) {
			const fullStart = match.index;
			const fullEnd = fullStart + match[0].length;
			const uri = match[1] ? normalizeMatchedBibleUri(match[1]) : "";
			if (!uri) {
				continue;
			}
			if (offset === undefined || (offset >= fullStart && offset < fullEnd)) {
				return { uri, start: fullStart, end: fullEnd };
			}
		}
	}
	return null;
}

export function extractBibleUriFromText(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}
	if (trimmed.toLowerCase().startsWith("bible:")) {
		const bare = trimmed.match(/^(bible:(?:\/\/)?[^\s)\]]+)/i);
		return bare ? normalizeMatchedBibleUri(bare[1]) : null;
	}
	return findBibleUriMatchInLine(trimmed)?.uri ?? null;
}

export function collectBibleUrisFromText(input: string): string[] {
	const patterns = createBibleUriPatterns();
	const found = new Set<string>();
	patterns.forEach((pattern, index) => {
		let match: RegExpExecArray | null = null;
		while ((match = pattern.exec(input)) !== null) {
			if (!match[1]) {
				continue;
			}
			const start = match.index;
			const end = start + match[0].length;
			if (index === patterns.length - 1 && isRangeInsideLinkSyntax(input, start, end)) {
				continue;
			}
			const uri = normalizeMatchedBibleUri(match[1]);
			if (uri) {
				found.add(uri);
			}
		}
	});
	return [...found];
}
