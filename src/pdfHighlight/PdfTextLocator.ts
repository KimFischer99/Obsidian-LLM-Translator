import type { App, TFile } from "obsidian";
import pdfWorkerSource from "pdfjs-dist/legacy/build/pdf.worker.mjs?worker-source";
import type { PdfSelectionOverlayRect } from "../types";
import { normalizePdfChars, normalizeSelectionTextForPdf, toRawPdfChars } from "./normalize";
import type { LocatedPdfHighlight, PdfCharBox, PdfHighlightQuad } from "./types";

interface PdfTextItem {
	str: string;
	transform: number[];
	width?: number;
	height?: number;
	hasEOL?: boolean;
}

interface PageMatch {
	pageIndex: number;
	text: string;
	map: Array<PdfCharBox | undefined>;
	start: number;
	end: number;
	matchType: "exact" | "compact";
	normalizedRects: NormalizedRect[];
	viewport: PdfViewportLike;
}

interface NormalizedRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

interface PdfViewportLike {
	width: number;
	height: number;
	convertToViewportRectangle(rect: number[]): number[];
}

export class PdfTextLocator {
	private workerUrl: string | undefined;

	constructor(
		private app: App,
		private debug: (message: string, detail?: unknown) => void,
	) {}

	async locate(
		file: TFile,
		selectedText: string,
		pageHint?: number,
		overlayRects?: PdfSelectionOverlayRect[],
	): Promise<LocatedPdfHighlight | null> {
		const normalizedSelection = normalizeSelectionTextForPdf(selectedText);
		if (normalizedSelection.length < 1) {
			return null;
		}

		const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
		pdfjsLib.GlobalWorkerOptions.workerSrc = this.getWorkerUrl();
		const data = await this.app.vault.readBinary(file);
		const documentTask = pdfjsLib.getDocument({
			data: data.slice(0),
			useWorkerFetch: false,
			isEvalSupported: false,
		} as Record<string, unknown>);
		const pdfDoc = await documentTask.promise;

		try {
			const searchOrder = buildSearchOrder(pdfDoc.numPages, pageHint);
			const matches: PageMatch[] = [];

			for (const pageNumber of searchOrder) {
				const page = await pdfDoc.getPage(pageNumber);
				const textContent = await page.getTextContent();
				const pageMatches = this.findPageMatches(
					pageNumber - 1,
					textContent.items as PdfTextItem[],
					normalizedSelection,
				);
				const viewport = page.getViewport({ scale: 1 }) as PdfViewportLike;
				for (const match of pageMatches) {
					match.viewport = viewport;
					match.normalizedRects = normalizeQuadRects(buildQuads(match), viewport);
					matches.push(match);
				}
			}

			const candidates = narrowCandidates(matches, pageHint, overlayRects);
			const selectedMatch = candidates.length === 1
				? candidates[0]
				: chooseByOverlayGeometry(candidates, overlayRects, pageHint);
			if (selectedMatch) {
				const overlayQuads = buildOverlayQuads(selectedMatch, overlayRects);
				return {
					file,
					normalizedText: normalizedSelection,
					quads: overlayQuads.length > 0 ? overlayQuads : buildQuads(selectedMatch),
				};
			}

			this.debug("PDF highlight selection could not be uniquely located.", {
				file: file.path,
				pageHint,
				normalizedSelection,
				matchCount: matches.length,
				candidateCount: candidates.length,
			});
			return null;
		} finally {
			await (pdfDoc as { destroy?: () => Promise<void> }).destroy?.();
		}
	}

	destroy(): void {
		if (this.workerUrl) {
			URL.revokeObjectURL(this.workerUrl);
			this.workerUrl = undefined;
		}
	}

	private getWorkerUrl(): string {
		if (!this.workerUrl) {
			this.workerUrl = URL.createObjectURL(new Blob([pdfWorkerSource], { type: "text/javascript" }));
		}
		return this.workerUrl;
	}

	private findPageMatches(pageIndex: number, items: PdfTextItem[], selectedText: string): PageMatch[] {
		const rawChars: Array<{ value: string; box?: PdfCharBox }> = [];
		let previousBox: PdfCharBox | undefined;

		for (const item of items) {
			if (!item.str) {
				continue;
			}
			const boxes = boxesForItem(pageIndex, item);
			const firstBox = boxes[0];
			if (previousBox && firstBox) {
				const separator = inferSeparator(previousBox, firstBox);
				if (separator) {
					rawChars.push({ value: separator });
				}
			}
			rawChars.push(...toRawPdfChars(item.str, boxes));
			if (item.hasEOL) {
				rawChars.push({ value: "\n" });
			}
			previousBox = boxes[boxes.length - 1] ?? previousBox;
		}

		const normalized = normalizePdfChars(rawChars);
		const exactMatches = findAllOccurrences(normalized.text, selectedText).map((start): PageMatch => ({
			pageIndex,
			text: normalized.text,
			map: normalized.map,
			start,
			end: start + selectedText.length,
			matchType: "exact",
			normalizedRects: [],
			viewport: { width: 0, height: 0, convertToViewportRectangle: () => [] },
		}));
		if (exactMatches.length > 0) {
			return exactMatches;
		}

		return findCompactMatches(normalized.text, selectedText).map((compactMatch): PageMatch => ({
			pageIndex,
			text: normalized.text,
			map: normalized.map,
			start: compactMatch.start,
			end: compactMatch.end,
			matchType: "compact",
			normalizedRects: [],
			viewport: { width: 0, height: 0, convertToViewportRectangle: () => [] },
		}));
	}
}

function narrowCandidates(
	matches: PageMatch[],
	pageHint?: number,
	overlayRects?: PdfSelectionOverlayRect[],
): PageMatch[] {
	const overlayPages = new Set(
		(overlayRects ?? [])
			.map((rect) => rect.pageNumber)
			.filter((pageNumber): pageNumber is number => typeof pageNumber === "number"),
	);
	if (overlayPages.size > 0) {
		const overlayMatches = matches.filter((match) => overlayPages.has(match.pageIndex + 1));
		if (overlayMatches.length > 0) {
			return overlayMatches;
		}
	}

	if (pageHint) {
		const hintedMatches = matches.filter((match) => match.pageIndex === pageHint - 1);
		if (hintedMatches.length > 0) {
			return hintedMatches;
		}
	}
	return matches;
}

function chooseByOverlayGeometry(
	matches: PageMatch[],
	overlayRects?: PdfSelectionOverlayRect[],
	pageHint?: number,
): PageMatch | null {
	if (matches.length < 1 || !overlayRects?.length) {
		return null;
	}

	const candidatePages = new Set(matches.map((match) => match.pageIndex));
	const scored = matches.flatMap((match) => {
		const hints = overlayRects
			.filter((rect) => rect.pageNumber === match.pageIndex + 1 || (
				!rect.pageNumber
				&& (pageHint === match.pageIndex + 1 || (!pageHint && candidatePages.size === 1))
			))
			.map(toNormalizedOverlayRect);
		if (hints.length === 0 || match.normalizedRects.length === 0) {
			return [];
		}
		return [{ match, score: geometryScore(match.normalizedRects, hints) }];
	}).sort((left, right) => left.score - right.score);

	if (scored.length === 0 || scored[0].score > 0.35) {
		return null;
	}
	if (scored.length > 1) {
		const requiredMargin = Math.max(0.02, scored[0].score * 0.2);
		if (scored[1].score - scored[0].score < requiredMargin) {
			return null;
		}
	}
	return scored[0].match;
}

function toNormalizedOverlayRect(rect: PdfSelectionOverlayRect): NormalizedRect {
	return {
		left: rect.leftRatio,
		top: rect.topRatio,
		width: rect.widthRatio,
		height: rect.heightRatio,
	};
}

function geometryScore(candidateRects: NormalizedRect[], hintRects: NormalizedRect[]): number {
	const candidateBounds = unionRect(candidateRects);
	const hintBounds = unionRect(hintRects);
	const boundsScore = rectDistance(candidateBounds, hintBounds);
	const lineScore = hintRects.reduce((total, hint) => {
		return total + Math.min(...candidateRects.map((candidate) => rectDistance(candidate, hint)));
	}, 0) / hintRects.length;
	return boundsScore * 0.7 + lineScore * 0.3;
}

function rectDistance(left: NormalizedRect, right: NormalizedRect): number {
	const leftCenterX = left.left + left.width / 2;
	const leftCenterY = left.top + left.height / 2;
	const rightCenterX = right.left + right.width / 2;
	const rightCenterY = right.top + right.height / 2;
	return Math.hypot(leftCenterX - rightCenterX, leftCenterY - rightCenterY)
		+ Math.abs(left.width - right.width) * 0.5
		+ Math.abs(left.height - right.height) * 0.5;
}

function unionRect(rects: NormalizedRect[]): NormalizedRect {
	const left = Math.min(...rects.map((rect) => rect.left));
	const top = Math.min(...rects.map((rect) => rect.top));
	const right = Math.max(...rects.map((rect) => rect.left + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
	return { left, top, width: right - left, height: bottom - top };
}

function normalizeQuadRects(quads: PdfHighlightQuad[], viewport: PdfViewportLike): NormalizedRect[] {
	if (viewport.width <= 0 || viewport.height <= 0) {
		return [];
	}
	return quads.map((quad) => {
		const converted = viewport.convertToViewportRectangle(quad.rect);
		const left = Math.min(converted[0], converted[2]);
		const top = Math.min(converted[1], converted[3]);
		const right = Math.max(converted[0], converted[2]);
		const bottom = Math.max(converted[1], converted[3]);
		return {
			left: left / viewport.width,
			top: top / viewport.height,
			width: (right - left) / viewport.width,
			height: (bottom - top) / viewport.height,
		};
	});
}

function buildOverlayQuads(
	match: PageMatch,
	overlayRects?: PdfSelectionOverlayRect[],
): PdfHighlightQuad[] {
	if (match.viewport.width <= 0 || match.viewport.height <= 0) {
		return [];
	}

	return (overlayRects ?? [])
		.filter((rect) => rect.pageNumber === match.pageIndex + 1)
		.map((rect): PdfHighlightQuad => {
			const left = rect.leftRatio * match.viewport.width;
			const right = (rect.leftRatio + rect.widthRatio) * match.viewport.width;
			const top = (1 - rect.topRatio) * match.viewport.height;
			const bottom = (1 - rect.topRatio - rect.heightRatio) * match.viewport.height;
			return {
				pageIndex: match.pageIndex,
				quadPoints: [left, top, right, top, left, bottom, right, bottom],
				rect: [left, bottom, right, top],
			};
		})
		.filter((quad) => quad.rect[2] > quad.rect[0] && quad.rect[3] > quad.rect[1]);
}

function buildSearchOrder(numPages: number, pageHint?: number): number[] {
	const order: number[] = [];
	if (pageHint && pageHint >= 1 && pageHint <= numPages) {
		order.push(pageHint);
	}
	for (let page = 1; page <= numPages; page++) {
		if (page !== pageHint) {
			order.push(page);
		}
	}
	return order;
}

function boxesForItem(pageIndex: number, item: PdfTextItem): PdfCharBox[] {
	const chars = Array.from(item.str);
	const transform = item.transform;
	const x = finite(transform[4]);
	const y = finite(transform[5]);
	const width = Math.max(finite(item.width), estimateWidth(transform), chars.length);
	const height = Math.max(finite(item.height), estimateHeight(transform), 8);
	const charWidth = width / Math.max(chars.length, 1);
	const yBottom = y - height * 0.22;
	const yTop = y + height * 0.88;
	const lineKey = Math.round(y / 2);

	return chars.map((_, index) => ({
		pageIndex,
		x: x + charWidth * index,
		x2: x + charWidth * (index + 1),
		yBottom,
		yTop,
		lineKey,
	}));
}

function inferSeparator(previous: PdfCharBox, next: PdfCharBox): " " | "\n" | "" {
	const previousHeight = Math.max(previous.yTop - previous.yBottom, 1);
	const nextHeight = Math.max(next.yTop - next.yBottom, 1);
	const averageHeight = (previousHeight + nextHeight) / 2;
	const verticalDelta = Math.abs(next.yBottom - previous.yBottom);
	if (verticalDelta > averageHeight * 0.65) {
		return "\n";
	}

	const horizontalGap = next.x - previous.x2;
	if (horizontalGap > averageHeight * 0.18) {
		return " ";
	}

	return "";
}

function findAllOccurrences(text: string, selectedText: string): number[] {
	const starts: number[] = [];
	let start = text.indexOf(selectedText);
	while (start >= 0) {
		starts.push(start);
		start = text.indexOf(selectedText, start + 1);
	}
	return starts;
}

function findCompactMatches(pageText: string, selectedText: string): Array<{ start: number; end: number }> {
	const pageCompact: string[] = [];
	const pageIndexMap: number[] = [];
	for (let index = 0; index < pageText.length; index++) {
		const char = pageText[index];
		if (/\s/.test(char)) {
			continue;
		}
		pageCompact.push(char);
		pageIndexMap.push(index);
	}

	const selectedCompact = selectedText.replace(/\s/g, "");
	if (!selectedCompact) {
		return [];
	}

	const compactText = pageCompact.join("");
	const matches: Array<{ start: number; end: number }> = [];
	for (const compactStart of findAllOccurrences(compactText, selectedCompact)) {
		const start = pageIndexMap[compactStart];
		const end = pageIndexMap[compactStart + selectedCompact.length - 1] + 1;
		matches.push({ start, end });
	}
	return matches;
}

function buildQuads(match: PageMatch): PdfHighlightQuad[] {
	const boxes = match.map
		.slice(match.start, match.end)
		.filter((box): box is PdfCharBox => Boolean(box));
	if (boxes.length === 0) {
		return [];
	}

	const lineGroups = new Map<number, PdfCharBox[]>();
	for (const box of boxes) {
		const group = lineGroups.get(box.lineKey) ?? [];
		group.push(box);
		lineGroups.set(box.lineKey, group);
	}

	return Array.from(lineGroups.values())
		.map((lineBoxes): PdfHighlightQuad => {
			const left = Math.min(...lineBoxes.map((box) => box.x));
			const right = Math.max(...lineBoxes.map((box) => box.x2));
			const bottom = Math.min(...lineBoxes.map((box) => box.yBottom));
			const top = Math.max(...lineBoxes.map((box) => box.yTop));
			const pageIndex = lineBoxes[0].pageIndex;

			return {
				pageIndex,
				quadPoints: [left, top, right, top, left, bottom, right, bottom],
				rect: [left, bottom, right, top],
			};
		})
		.filter((quad) => quad.rect[2] - quad.rect[0] > 0 && quad.rect[3] - quad.rect[1] > 0);
}

function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function estimateWidth(transform: number[]): number {
	return Math.hypot(finite(transform[0]), finite(transform[1]));
}

function estimateHeight(transform: number[]): number {
	return Math.hypot(finite(transform[2]), finite(transform[3]));
}
