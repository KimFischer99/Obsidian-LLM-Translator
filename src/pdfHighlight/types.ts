import type { TFile } from "obsidian";
import type { HighlightColorId } from "../types";

export interface HighlightColorConfig {
	id: HighlightColorId;
	label: string;
	css: string;
	pdfRgb: [number, number, number];
}

export interface PdfCharBox {
	pageIndex: number;
	x: number;
	yBottom: number;
	x2: number;
	yTop: number;
	lineKey: number;
}

export interface PdfHighlightQuad {
	pageIndex: number;
	quadPoints: [number, number, number, number, number, number, number, number];
	rect: [number, number, number, number];
}

export interface LocatedPdfHighlight {
	file: TFile;
	normalizedText: string;
	quads: PdfHighlightQuad[];
}

export interface PersistedPdfHighlight {
	id: string;
	location: LocatedPdfHighlight;
	color: [number, number, number];
	note: string;
	overlayRects: Array<{
		pageNumber: number;
		leftRatio: number;
		topRatio: number;
		widthRatio: number;
		heightRatio: number;
	}>;
}

export type PdfHighlightToggleResult =
	| { action: "added"; count: number }
	| { action: "removed"; count: number }
	| { action: "updated"; count: number };

export type PdfHighlightToggleOutcome = PdfHighlightToggleResult & { note: string };
