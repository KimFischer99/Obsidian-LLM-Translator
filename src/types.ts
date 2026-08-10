import type { TFile } from "obsidian";

export interface PdfOllamaTranslatorSettings {
	translationScope: "global" | "pdf-only";
	translationProvider: TranslationProviderId;
	ollamaBaseUrl: string;
	model: string;
	cloudApiBaseUrl: string;
	cloudApiKeySecretId: string;
	cloudApiModel: string;
	autoTranslateSelection: boolean;
	enablePopup: boolean;
	enableContextMenu: boolean;
	enableTranslationCache: boolean;
	restrictSourceLanguages: boolean;
	sourceLanguage: TranslationLanguage;
	targetLanguage: Exclude<TranslationLanguage, "auto">;
	debounceMs: number;
	requestTimeoutMs: number;
	maxSelectionChars: number;
	fontSize: number;
	lineHeight: number;
	rememberPopupSize: boolean;
	popupWidth: number;
	popupHeight: number;
	showCopyButton: boolean;
	showRetryButton: boolean;
	defaultHighlightColor: HighlightColorId;
	customPrompt: string;
	topK: number;
	topP: number;
	repeatPenalty: number;
	numPredict: number;
	ollamaOptionsJson: string;
	cleanModelOutput: boolean;
	debugLogging: boolean;
}

export type HighlightColorId = "yellow" | "red" | "blue" | "green" | "purple";

export type TranslationProviderId = "local-llm" | "cloud-api" | "google" | "bing";

export type TranslationLanguage = "auto" | "en" | "de" | "fr" | "ja" | "zh-Hans";

export interface TranslationRequest {
	text: string;
	sourceLanguage: TranslationLanguage;
	targetLanguage: Exclude<TranslationLanguage, "auto">;
	allowedSourceLanguages: Array<Exclude<TranslationLanguage, "auto">>;
	signal?: AbortSignal;
}

export interface TranslationResult {
	sourceText: string;
	translatedText: string;
	model: string;
	elapsedMs: number;
}

export interface PdfTextSelection {
	text: string;
	rect: DOMRect;
	file?: TFile;
	pageHint?: number;
	overlayRects?: PdfSelectionOverlayRect[];
}

export interface PdfSelectionOverlayRect {
	pageEl: HTMLElement;
	pageNumber?: number;
	left: number;
	top: number;
	width: number;
	height: number;
	leftRatio: number;
	topRatio: number;
	widthRatio: number;
	heightRatio: number;
}

export interface SidebarTranslationState {
	sourceText: string;
	translatedText: string;
	status: "idle" | "loading" | "success" | "error";
	message: string;
}

export type ConnectionTestResult =
	| { ok: true; message: string }
	| { ok: false; message: string };
