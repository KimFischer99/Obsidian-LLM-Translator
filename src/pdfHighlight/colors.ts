import type { HighlightColorId } from "../types";
import type { HighlightColorConfig } from "./types";

export const HIGHLIGHT_COLORS: Record<HighlightColorId, HighlightColorConfig> = {
	yellow: {
		id: "yellow",
		label: "Yellow",
		css: "#fff36d",
		pdfRgb: [1, 0.95, 0],
	},
	red: {
		id: "red",
		label: "Red",
		css: "#ff6b6b",
		pdfRgb: [1, 0.18, 0.18],
	},
	blue: {
		id: "blue",
		label: "Blue",
		css: "#5aa9ff",
		pdfRgb: [0.1, 0.45, 1],
	},
	green: {
		id: "green",
		label: "Green",
		css: "#64d96b",
		pdfRgb: [0.15, 0.75, 0.2],
	},
	purple: {
		id: "purple",
		label: "Purple",
		css: "#b47cff",
		pdfRgb: [0.55, 0.25, 1],
	},
};

export const HIGHLIGHT_COLOR_ORDER: HighlightColorId[] = ["yellow", "red", "blue", "green", "purple"];

export function getHighlightColor(id: HighlightColorId): HighlightColorConfig {
	return HIGHLIGHT_COLORS[id] ?? HIGHLIGHT_COLORS.yellow;
}

export function getHighlightColorFromPdfRgb(rgb: readonly number[]): HighlightColorConfig {
	return HIGHLIGHT_COLOR_ORDER
		.map(getHighlightColor)
		.reduce((closest, color) => colorDistance(color.pdfRgb, rgb) < colorDistance(closest.pdfRgb, rgb) ? color : closest);
}

function colorDistance(left: readonly number[], right: readonly number[]): number {
	return left.reduce((distance, value, index) => distance + (value - (right[index] ?? 0)) ** 2, 0);
}
