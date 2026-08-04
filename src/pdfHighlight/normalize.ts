import type { PdfCharBox } from "./types";

interface RawChar {
	value: string;
	box?: PdfCharBox;
}

interface NormalizedText {
	text: string;
	map: Array<PdfCharBox | undefined>;
}

const LIGATURES: Record<string, string> = {
	"\ufb00": "ff",
	"\ufb01": "fi",
	"\ufb02": "fl",
	"\ufb03": "ffi",
	"\ufb04": "ffl",
};

export function normalizeSelectionTextForPdf(value: string): string {
	return normalizeRawChars(Array.from(value).map((char) => ({ value: char }))).text;
}

export function normalizePdfChars(rawChars: RawChar[]): NormalizedText {
	return normalizeRawChars(rawChars);
}

export function toRawPdfChars(text: string, boxes: PdfCharBox[]): RawChar[] {
	const chars = Array.from(text);
	return chars.map((value, index) => ({ value, box: boxes[index] }));
}

function normalizeRawChars(rawChars: RawChar[]): NormalizedText {
	const text: string[] = [];
	const map: Array<PdfCharBox | undefined> = [];
	let hasPendingSpace = false;
	let pendingSpaceBox: PdfCharBox | undefined;

	for (let index = 0; index < rawChars.length; index++) {
		const raw = rawChars[index];
		const value = raw.value;

		if (isHyphenationBreak(rawChars, index)) {
			index = skipFollowingWhitespace(rawChars, index + 1) - 1;
			continue;
		}

		const replacement = LIGATURES[value] ?? value.normalize("NFKC");
		for (const char of Array.from(replacement)) {
			if (/\s/.test(char)) {
				if (text.length > 0) {
					hasPendingSpace = true;
					pendingSpaceBox = pendingSpaceBox ?? raw.box;
				}
				continue;
			}

			if (hasPendingSpace && text.length > 0) {
				text.push(" ");
				map.push(pendingSpaceBox);
				hasPendingSpace = false;
				pendingSpaceBox = undefined;
			}
			text.push(char);
			map.push(raw.box);
		}
	}

	while (text.length > 0 && text[text.length - 1] === " ") {
		text.pop();
		map.pop();
	}

	return { text: text.join(""), map };
}

function isHyphenationBreak(rawChars: RawChar[], index: number): boolean {
	const current = rawChars[index]?.value;
	if (current !== "-" && current !== "\u2010" && current !== "\u2011") {
		return false;
	}

	let cursor = index + 1;
	let sawLineBreak = false;
	while (cursor < rawChars.length && /\s/.test(rawChars[cursor].value)) {
		if (rawChars[cursor].value === "\n" || rawChars[cursor].value === "\r") {
			sawLineBreak = true;
		}
		cursor++;
	}

	const previous = rawChars[index - 1]?.value ?? "";
	const next = rawChars[cursor]?.value ?? "";
	return sawLineBreak && /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(previous) && /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(next);
}

function skipFollowingWhitespace(rawChars: RawChar[], index: number): number {
	let cursor = index;
	while (cursor < rawChars.length && /\s/.test(rawChars[cursor].value)) {
		cursor++;
	}
	return cursor;
}
