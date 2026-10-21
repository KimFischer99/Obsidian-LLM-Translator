import type { App, TFile } from "obsidian";
import type { HighlightColorId } from "../types";
import { getHighlightColorFromPdfRgb } from "./colors";
import {
	PDFArray,
	PDFDict,
	PDFDocument,
	PDFHexString,
	PDFName,
	PDFNumber,
	PDFString,
} from "pdf-lib";
import type {
	HighlightColorConfig,
	LocatedPdfHighlight,
	PdfHighlightQuad,
	PdfHighlightToggleOutcome,
	PdfHighlightToggleResult,
	PersistedPdfHighlight,
} from "./types";

const NAME_PREFIX = "llm-translator:";
const GROUP_NAME = PDFName.of("LLMTranslatorGroup");
const OPACITY = 0.35;
const TOLERANCE = 1.5;

interface ExistingAnnotation {
	index: number;
	dict: PDFDict;
	quadPoints: number[];
	color?: [number, number, number];
	note: string;
	groupId: string;
}

export class PdfAnnotationWriter {
	private queues = new Map<string, Promise<void>>();
	private writingFiles = new Set<string>();
	private lastWritten = new Map<string, { length: number; hash: string }>();

	constructor(private app: App) {}

	isWriting(path: string): boolean {
		return this.writingFiles.has(path);
	}

	async isOwnWrite(file: TFile): Promise<boolean> {
		if (this.isWriting(file.path)) return true;
		const expected = this.lastWritten.get(file.path);
		if (!expected) return false;
		try {
			const bytes = new Uint8Array(await this.app.vault.readBinary(file));
			return bytes.length === expected.length && await hashBytes(bytes) === expected.hash;
		} catch {
			return false;
		}
	}

	async toggleHighlight(
		location: LocatedPdfHighlight,
		color: HighlightColorConfig,
		note?: string,
	): Promise<PdfHighlightToggleOutcome> {
		return this.enqueue(location.file.path, async () => {
			const pdfBytes = await this.app.vault.readBinary(location.file);
			const pdfDoc = await PDFDocument.load(pdfBytes);
			const matchesByPage = this.findMatchingAnnotations(pdfDoc, location.quads);
			const matched = Array.from(matchesByPage.values()).flat();
			const existingNote = matched.find((annotation) => annotation.note.trim())?.note ?? "";
			const effectiveNote = note ?? existingNote;
			const groupId = crypto.randomUUID();
			const sameColor = matched.length === location.quads.length
				&& matched.every((annotation) => colorsEqual(annotation.color, color.pdfRgb));
			this.removeMatches(pdfDoc, matchesByPage);

			if (sameColor) {
				await this.save(location, pdfDoc);
				return { action: "removed", count: matched.length, note: effectiveNote };
			}

			for (const quad of location.quads) {
				this.addAnnotation(pdfDoc, quad, color, stableAnnotationName(location.normalizedText, quad), effectiveNote, groupId);
			}
			await this.save(location, pdfDoc);
			return {
				action: matched.length > 0 ? "updated" : "added",
				count: location.quads.length,
				note: effectiveNote,
			};
		});
	}

	async applyHighlight(
		location: LocatedPdfHighlight,
		color: HighlightColorConfig,
		note: string,
	): Promise<PdfHighlightToggleResult> {
		return this.enqueue(location.file.path, async () => {
			const pdfBytes = await this.app.vault.readBinary(location.file);
			const pdfDoc = await PDFDocument.load(pdfBytes);
			const matchesByPage = this.findMatchingAnnotations(pdfDoc, location.quads);
			const matched = Array.from(matchesByPage.values()).flat();
			const groupId = matched.find((annotation) => annotation.groupId)?.groupId ?? crypto.randomUUID();
			this.removeMatches(pdfDoc, matchesByPage);

			for (const quad of location.quads) {
				this.addAnnotation(pdfDoc, quad, color, stableAnnotationName(location.normalizedText, quad), note, groupId);
			}
			await this.save(location, pdfDoc);
			return { action: matched.length > 0 ? "updated" : "added", count: location.quads.length };
		});
	}

	async removeHighlight(
		location: LocatedPdfHighlight,
		match: "exact" | "intersecting" = "exact",
	): Promise<PdfHighlightToggleResult> {
		return this.enqueue(location.file.path, async () => {
			const pdfBytes = await this.app.vault.readBinary(location.file);
			const pdfDoc = await PDFDocument.load(pdfBytes);
			const matchesByPage = this.findMatchingAnnotations(
				pdfDoc, location.quads, match === "intersecting" ? pdfQuadPointsIntersect : pdfQuadPointsEqual,
			);
			const matched = Array.from(matchesByPage.values()).flat();
			this.removeMatches(pdfDoc, matchesByPage);
			if (matched.length > 0) {
				await this.save(location, pdfDoc);
			}
			return { action: "removed", count: matched.length };
		});
	}

	async readHighlights(file: TFile): Promise<PersistedPdfHighlight[]> {
		return this.enqueue(file.path, async () => {
			const pdfBytes = await this.app.vault.readBinary(file);
			const pdfDoc = await PDFDocument.load(pdfBytes);
			const highlights = new Map<string, PersistedPdfHighlight>();

			for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
				const page = pdfDoc.getPage(pageIndex);
				const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
				if (!annots) {
					continue;
				}

				for (let index = 0; index < annots.size(); index++) {
					const dict = annots.lookupMaybe(index, PDFDict);
					if (!dict || !isPluginHighlight(dict)) {
						continue;
					}
					const quadPoints = readNumberArray(dict.lookupMaybe(PDFName.of("QuadPoints"), PDFArray));
					if (quadPoints.length !== 8) {
						continue;
					}
					const rect = quadPointsToRect(quadPoints);
					const name = readString(dict.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));
					const color = readColor(dict.lookupMaybe(PDFName.of("C"), PDFArray));
					if (!name || !color) {
						continue;
					}
					const groupId = readString(dict.lookupMaybe(GROUP_NAME, PDFString, PDFHexString));
					const id = groupId ? `${file.path}:group:${groupId}` : `${file.path}:${name}:${pageIndex}:${index}`;
					const quad = { pageIndex, quadPoints: quadPoints as PdfHighlightQuad["quadPoints"], rect };
					const overlayRect = toOverlayRect(rect, page.getWidth(), page.getHeight(), pageIndex + 1);
					const existing = highlights.get(id);
					if (existing) {
						existing.location.quads.push(quad);
						existing.overlayRects.push(overlayRect);
						continue;
					}
					highlights.set(id, {
						id,
						location: {
							file,
							normalizedText: name,
							quads: [quad],
						},
						color,
						note: readString(dict.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)),
						overlayRects: [overlayRect],
					});
				}
			}
			return [...highlights.values()];
		});
	}

	async getHighlightColor(location: LocatedPdfHighlight): Promise<HighlightColorId | null> {
		if (location.quads.length === 0) return null;
		return this.enqueue(location.file.path, async () => {
			const pdfDoc = await PDFDocument.load(await this.app.vault.readBinary(location.file));
			const matches = this.findMatchingAnnotations(pdfDoc, location.quads);
			const colors = location.quads.map((quad) => matches.get(quad.pageIndex)
				?.find((annotation) => pdfQuadPointsEqual(annotation.quadPoints, quad.quadPoints))?.color);
			const colorId = colors[0] && getHighlightColorFromPdfRgb(colors[0]).id;
			return colorId && colors.every((color) => color && getHighlightColorFromPdfRgb(color).id === colorId)
				? colorId : null;
		});
	}

	async removeAllHighlights(file: TFile): Promise<number> {
		return this.enqueue(file.path, async () => {
			const pdfBytes = await this.app.vault.readBinary(file);
			const pdfDoc = await PDFDocument.load(pdfBytes);
			let removed = 0;
			for (let pageIndex = 0; pageIndex < pdfDoc.getPageCount(); pageIndex++) {
				const page = pdfDoc.getPage(pageIndex);
				const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
				if (!annots) {
					continue;
				}
				for (let index = annots.size() - 1; index >= 0; index--) {
					const dict = annots.lookupMaybe(index, PDFDict);
					if (dict && isPluginHighlight(dict)) {
						annots.remove(index);
						removed++;
					}
				}
			}
			if (removed > 0) {
				await this.save({ file } as LocatedPdfHighlight, pdfDoc);
			}
			return removed;
		});
	}

	private enqueue<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(path) ?? Promise.resolve();
		const result = previous.catch(() => undefined).then(operation);
		const settled = result.then(() => undefined, () => undefined);
		this.queues.set(path, settled);
		void settled.then(() => {
			if (this.queues.get(path) === settled) {
				this.queues.delete(path);
			}
		});
		return result;
	}

	private async save(location: LocatedPdfHighlight, pdfDoc: PDFDocument): Promise<void> {
		const modified = await pdfDoc.save();
		const hash = await hashBytes(modified);
		this.writingFiles.add(location.file.path);
		try {
			const bytes = toArrayBuffer(modified);
			await this.app.vault.modifyBinary(location.file, bytes);
			this.lastWritten.set(location.file.path, { length: modified.length, hash });
		} finally {
			this.writingFiles.delete(location.file.path);
		}
	}

	private findMatchingAnnotations(
		pdfDoc: PDFDocument,
		quads: PdfHighlightQuad[],
		matchesQuad: (left: readonly number[], right: readonly number[]) => boolean = pdfQuadPointsEqual,
	): Map<number, ExistingAnnotation[]> {
		const matches = new Map<number, ExistingAnnotation[]>();

		for (const quad of quads) {
			const page = pdfDoc.getPage(quad.pageIndex);
			const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
			if (!annots) {
				continue;
			}

			for (let index = 0; index < annots.size(); index++) {
				const dict = annots.lookupMaybe(index, PDFDict);
				if (!dict || !isPluginHighlight(dict)) {
					continue;
				}

				const existingQuad = readNumberArray(dict.lookupMaybe(PDFName.of("QuadPoints"), PDFArray));
				if (!matchesQuad(existingQuad, quad.quadPoints)) {
					continue;
				}

				const group = matches.get(quad.pageIndex) ?? [];
				if (group.some((annotation) => annotation.index === index)) {
					continue;
				}
				group.push({
					index,
					dict,
					quadPoints: existingQuad,
					color: readColor(dict.lookupMaybe(PDFName.of("C"), PDFArray)),
					note: readString(dict.lookupMaybe(PDFName.of("Contents"), PDFString, PDFHexString)),
					groupId: readString(dict.lookupMaybe(GROUP_NAME, PDFString, PDFHexString)),
				});
				matches.set(quad.pageIndex, group);
			}
		}

		return matches;
	}

	private addAnnotation(
		pdfDoc: PDFDocument,
		quad: PdfHighlightQuad,
		color: HighlightColorConfig,
		name: string,
		note: string,
		groupId: string,
	): void {
		const page = pdfDoc.getPage(quad.pageIndex);
		let annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
		if (!annots) {
			annots = pdfDoc.context.obj([]);
			page.node.set(PDFName.of("Annots"), annots);
		}

		const annotation = pdfDoc.context.obj({
			Type: PDFName.of("Annot"),
			Subtype: PDFName.of("Highlight"),
			Rect: pdfDoc.context.obj(quad.rect),
			QuadPoints: pdfDoc.context.obj(quad.quadPoints),
			C: pdfDoc.context.obj(color.pdfRgb),
			CA: PDFNumber.of(OPACITY),
			NM: PDFString.of(name),
			LLMTranslatorGroup: PDFString.of(groupId),
			F: PDFNumber.of(4),
			P: page.ref,
		});
		const trimmedNote = note.trim();
		if (trimmedNote) {
			annotation.set(PDFName.of("Contents"), PDFHexString.fromText(trimmedNote));
		}
		const annotationRef = pdfDoc.context.register(annotation);
		annots.push(annotationRef);
	}

	private removeMatches(pdfDoc: PDFDocument, matchesByPage: Map<number, ExistingAnnotation[]>): void {
		for (const [pageIndex, matches] of matchesByPage) {
			const page = pdfDoc.getPage(pageIndex);
			const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
			if (!annots) {
				continue;
			}
			for (const match of matches.sort((a, b) => b.index - a.index)) {
				annots.remove(match.index);
			}
		}
	}
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPluginHighlight(dict: PDFDict): boolean {
	const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName);
	if (subtype?.toString() !== "/Highlight") {
		return false;
	}

	const name = readString(dict.lookupMaybe(PDFName.of("NM"), PDFString, PDFHexString));
	return name.startsWith(NAME_PREFIX);
}

function readString(value: PDFString | PDFHexString | undefined): string {
	return value?.decodeText() ?? "";
}

function readColor(array: PDFArray | undefined): [number, number, number] | undefined {
	const values = readNumberArray(array);
	if (values.length < 3) {
		return undefined;
	}
	return [values[0], values[1], values[2]];
}

function readNumberArray(array: PDFArray | undefined): number[] {
	if (!array) {
		return [];
	}
	const values: number[] = [];
	for (let index = 0; index < array.size(); index++) {
		const value = array.lookupMaybe(index, PDFNumber);
		if (value) {
			values.push(value.asNumber());
		}
	}
	return values;
}

export function pdfQuadPointsEqual(left: readonly number[], right: readonly number[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => Math.abs(value - right[index]) <= TOLERANCE)
	);
}

export function pdfQuadPointsIntersect(left: readonly number[], right: readonly number[]): boolean {
	if (left.length !== 8 || right.length !== 8) return false;
	const a = quadPointsToRect(left);
	const b = quadPointsToRect(right);
	return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

function colorsEqual(
	left: [number, number, number] | undefined,
	right: readonly [number, number, number],
): boolean {
	return Boolean(left && left.every((value, index) => Math.abs(value - right[index]) <= 0.01));
}

function stableAnnotationName(text: string, quad: PdfHighlightQuad): string {
	const source = `${text}:${quad.pageIndex}:${quad.quadPoints.map((value) => Math.round(value * 10)).join(",")}`;
	let hash = 0;
	for (let index = 0; index < source.length; index++) {
		hash = (hash * 31 + source.charCodeAt(index)) >>> 0;
	}
	return `${NAME_PREFIX}${hash.toString(16)}`;
}

function quadPointsToRect(points: readonly number[]): PdfHighlightQuad["rect"] {
	const xs = [points[0], points[2], points[4], points[6]];
	const ys = [points[1], points[3], points[5], points[7]];
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function toOverlayRect(
	rect: PdfHighlightQuad["rect"],
	pageWidth: number,
	pageHeight: number,
	pageNumber: number,
): PersistedPdfHighlight["overlayRects"][number] {
	return {
		pageNumber,
		leftRatio: rect[0] / pageWidth,
		topRatio: (pageHeight - rect[3]) / pageHeight,
		widthRatio: (rect[2] - rect[0]) / pageWidth,
		heightRatio: (rect[3] - rect[1]) / pageHeight,
	};
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
	const buffer = new ArrayBuffer(value.byteLength);
	new Uint8Array(buffer).set(value);
	return buffer;
}
