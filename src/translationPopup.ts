import { setIcon } from "obsidian";
import type { HighlightColorId, TranslationLanguage, TranslationResult } from "./types";
import { t } from "./i18n";
import { getHighlightColor } from "./pdfHighlight/colors";

type PopupState = "loading" | "success" | "error";

interface PopupOptions {
	showCopyButton: boolean;
	showRetryButton: boolean;
	defaultHighlightColor: HighlightColorId;
	fontSize: number;
	lineHeight: number;
	sourceLanguage: TranslationLanguage;
	targetLanguage: Exclude<TranslationLanguage, "auto">;
	rememberSize: boolean;
	width: number;
	height: number;
	onLanguageChange: (
		sourceLanguage: TranslationLanguage,
		targetLanguage: Exclude<TranslationLanguage, "auto">,
	) => void;
	onResize: (width: number, height: number) => void;
	onTranslate: () => void;
	onRetry: () => void;
	onHighlight: () => void;
	onAddNote: () => void;
	onClose: () => void;
}

const SOURCE_LANGUAGE_OPTIONS: Array<{ value: TranslationLanguage; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "en", label: "EN" },
	{ value: "de", label: "DE" },
	{ value: "fr", label: "FR" },
	{ value: "ja", label: "JA" },
	{ value: "zh-Hans", label: "ZH" },
];

const TARGET_LANGUAGE_OPTIONS: Array<{ value: Exclude<TranslationLanguage, "auto">; label: string }> = [
	{ value: "en", label: "EN" },
	{ value: "de", label: "DE" },
	{ value: "fr", label: "FR" },
	{ value: "ja", label: "JA" },
	{ value: "zh-Hans", label: "ZH" },
];

export class TranslationPopup {
	private rootEl: HTMLElement;
	private languageEl: HTMLElement;
	private actionsEl: HTMLElement;
	private resultEl: HTMLElement;
	private lastResult = "";
	private lastRect: DOMRect | null = null;
	private options: PopupOptions;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: number | undefined;
	private manualActionsOnly = false;

	constructor(options: PopupOptions) {
		this.options = options;
		this.rootEl = activeDocument.body.createDiv({ cls: "pdf-ollama-translator-popup" });
		this.rootEl.hide();

		const headerEl = this.rootEl.createDiv({ cls: "pdf-ollama-translator-popup__header" });
		this.languageEl = headerEl.createDiv({ cls: "pdf-ollama-translator-popup__language" });
		this.actionsEl = headerEl.createDiv({ cls: "pdf-ollama-translator-popup__actions" });

		const bodyEl = this.rootEl.createDiv({ cls: "pdf-ollama-translator-popup__body" });
		this.resultEl = bodyEl.createDiv({ cls: "pdf-ollama-translator-popup__result" });
		this.resizeObserver = new ResizeObserver(() => this.handleResize());
		this.resizeObserver.observe(this.rootEl);
		this.updateOptions(options);
	}

	updateOptions(options: PopupOptions): void {
		this.options = options;
		this.rootEl.style.setProperty("--pdf-ollama-translator-font-size", `${options.fontSize}px`);
		this.rootEl.style.setProperty("--pdf-ollama-translator-line-height", String(options.lineHeight));
		this.rootEl.style.width = this.manualActionsOnly ? "max-content" : `${options.width}px`;
		this.rootEl.style.height = this.manualActionsOnly ? "auto" : `${this.getPreferredHeight(options.height)}px`;
		this.renderLanguageControls();
		this.renderActions();
		if (this.lastRect) {
			this.positionNear(this.lastRect);
		}
	}

	showLoading(rect: DOMRect, document: Document = activeDocument): void {
		this.lastResult = "";
		this.render("loading", t("popup.translating"));
		this.showAt(rect, document);
	}

	showResult(result: TranslationResult, rect: DOMRect, document: Document = activeDocument): void {
		this.lastResult = result.translatedText;
		this.render("success", result.translatedText);
		this.showAt(rect, document);
		this.fitToContent();
	}

	showError(message: string, rect: DOMRect, document: Document = activeDocument): void {
		this.lastResult = "";
		this.render("error", message);
		this.showAt(rect, document);
	}

	showInfo(message: string, rect: DOMRect, document: Document = activeDocument): void {
		this.lastResult = "";
		this.render("error", message);
		this.showAt(rect, document);
	}

	showManualActions(rect: DOMRect, document: Document = activeDocument): void {
		this.lastResult = "";
		this.setManualActionsOnly(true);
		this.showAt(rect, document);
	}

	hide(): void {
		this.lastRect = null;
		this.rootEl.hide();
	}

	moveTo(document: Document): void {
		if (this.rootEl.ownerDocument !== document) {
			this.hide();
			document.body.appendChild(this.rootEl);
		}
	}

	onDocumentClosed(document: Document): void {
		if (this.rootEl.ownerDocument === document) this.moveTo(window.document);
	}

	reposition(): void {
		if (!this.lastRect || this.rootEl.style.display === "none") {
			return;
		}
		this.positionNear(this.lastRect);
	}

	containsTarget(target: EventTarget | null): boolean {
		return Boolean(target && typeof target === "object" && "nodeType" in target && this.rootEl.contains(target as Node));
	}

	destroy(): void {
		this.resizeObserver?.disconnect();
		window.clearTimeout(this.resizeTimer);
		this.rootEl.remove();
	}

	private render(state: PopupState, content: string): void {
		this.setManualActionsOnly(false);
		this.resultEl.setText(content);
		this.resultEl.toggleClass("pdf-ollama-translator-popup__status", state === "loading");
		this.resultEl.toggleClass("pdf-ollama-translator-popup__error", state === "error");
		this.renderActions();
	}

	private renderActions(): void {
		this.actionsEl.empty();

		if (this.options.showCopyButton && this.lastResult) {
			const copyButton = this.createIconButton("copy", t("popup.copyTranslation"));
			copyButton.onClickEvent(async () => {
				await navigator.clipboard.writeText(this.lastResult);
			});
		}
		if (this.lastResult) {
			const noteButton = this.createIconButton("file-plus", t("popup.addToNote"));
			noteButton.onClickEvent(() => this.options.onAddNote());
		}

		const highlightColor = getHighlightColor(this.options.defaultHighlightColor);
		const highlightButton = this.createIconButton("highlighter", t("popup.highlightSelection"));
		highlightButton.addClass("pdf-ollama-translator-popup__button--highlight");
		highlightButton.style.setProperty("--pdf-ollama-translator-highlight-color", highlightColor.css);
		highlightButton.onClickEvent(() => this.options.onHighlight());

		if (this.options.showRetryButton) {
			const retryButton = this.createIconButton("refresh-cw", t("popup.retryTranslation"));
			retryButton.onClickEvent(() => this.options.onRetry());
		}

		const closeButton = this.createIconButton("x", t("popup.close"));
		closeButton.onClickEvent(() => this.options.onClose());
	}

	private renderLanguageControls(): void {
		this.languageEl.empty();
		if (this.manualActionsOnly) {
			const button = this.languageEl.createEl("button", {
				cls: "pdf-ollama-translator-popup__button",
				attr: { "aria-label": t("popup.translateSelection"), title: t("popup.translateSelection") },
			});
			setIcon(button, "languages");
			button.onpointerdown = (event) => event.preventDefault();
			button.onClickEvent(() => this.options.onTranslate());
			return;
		}

		const sourceSelect = this.languageEl.createEl("select", {
			cls: "pdf-ollama-translator-popup__language-select",
			attr: { "aria-label": t("popup.sourceLanguage"), title: t("popup.sourceLanguage") },
		});
		for (const option of SOURCE_LANGUAGE_OPTIONS) {
			sourceSelect.createEl("option", { text: option.value === "auto" ? t("language.autoShort") : option.label, value: option.value });
		}
		sourceSelect.value = this.options.sourceLanguage;

		const swapButton = this.languageEl.createEl("button", {
			cls: "pdf-ollama-translator-popup__language-swap",
			attr: { "aria-label": t("popup.swapLanguage"), title: t("popup.swapLanguage") },
		});
		setIcon(swapButton, "arrow-left-right");
		swapButton.onpointerdown = (event) => event.preventDefault();

		const targetSelect = this.languageEl.createEl("select", {
			cls: "pdf-ollama-translator-popup__language-select",
			attr: { "aria-label": t("popup.targetLanguage"), title: t("popup.targetLanguage") },
		});
		for (const option of TARGET_LANGUAGE_OPTIONS) {
			targetSelect.createEl("option", { text: option.label, value: option.value });
		}
		targetSelect.value = this.options.targetLanguage;

		const updateLanguages = () => {
			this.options.onLanguageChange(
				sourceSelect.value as TranslationLanguage,
				targetSelect.value as Exclude<TranslationLanguage, "auto">,
			);
		};
		sourceSelect.onchange = updateLanguages;
		targetSelect.onchange = updateLanguages;
		swapButton.onClickEvent(() => {
			if (sourceSelect.value === "auto") {
				sourceSelect.value = targetSelect.value;
				targetSelect.value = this.options.targetLanguage;
			} else {
				const previousSource = sourceSelect.value;
				sourceSelect.value = targetSelect.value;
				targetSelect.value = previousSource;
			}
			updateLanguages();
			this.options.onRetry();
		});
	}

	private createIconButton(icon: string, label: string): HTMLButtonElement {
		const button = this.actionsEl.createEl("button", {
			cls: "pdf-ollama-translator-popup__button",
			attr: { "aria-label": label, title: label },
		});
		button.onpointerdown = (event) => event.preventDefault();
		setIcon(button, icon);
		return button;
	}

	private setManualActionsOnly(value: boolean): void {
		if (this.manualActionsOnly === value) return;
		this.manualActionsOnly = value;
		this.rootEl.toggleClass("pdf-ollama-translator-popup--actions-only", value);
		this.rootEl.style.width = value ? "max-content" : `${this.options.width}px`;
		this.rootEl.style.height = value ? "auto" : `${this.getPreferredHeight(this.options.height)}px`;
		if (value) window.clearTimeout(this.resizeTimer);
		this.renderLanguageControls();
		this.renderActions();
	}

	private showAt(rect: DOMRect, document: Document): void {
		this.moveTo(document);
		this.lastRect = rect;
		this.rootEl.show();
		this.positionNear(rect);
	}

	private positionNear(rect: DOMRect): void {
		const window = this.rootEl.ownerDocument.defaultView ?? activeWindow;
		const margin = 12;
		const popupRect = this.rootEl.getBoundingClientRect();
		const desiredLeft = rect.left;
		const desiredTop = rect.bottom + 8;
		const maxLeft = window.innerWidth - popupRect.width - margin;
		const maxTop = window.innerHeight - popupRect.height - margin;
		const left = clamp(desiredLeft, margin, Math.max(margin, maxLeft));
		const top = clamp(desiredTop, margin, Math.max(margin, maxTop));

		this.rootEl.style.left = `${left}px`;
		this.rootEl.style.top = `${top}px`;
	}

	private fitToContent(): void {
		const window = this.rootEl.ownerDocument.defaultView ?? activeWindow;
		const margin = 12;
		const maxHeight = window.innerHeight - margin * 2;
		const headerHeight = this.languageEl.parentElement?.getBoundingClientRect().height ?? 32;
		const bodyEl = this.resultEl.parentElement;
		if (!bodyEl) {
			return;
		}

		const bodyStyle = window.getComputedStyle(bodyEl);
		const verticalBodySpace =
			Number.parseFloat(bodyStyle.paddingTop) +
			Number.parseFloat(bodyStyle.paddingBottom) +
			Number.parseFloat(bodyStyle.marginTop) +
			Number.parseFloat(bodyStyle.marginBottom);
		const contentHeight = this.resultEl.scrollHeight + headerHeight + verticalBodySpace + 2;
		const nextHeight = clamp(
			Math.ceil(contentHeight),
			Number.parseFloat(window.getComputedStyle(this.rootEl).minHeight) || 150,
			maxHeight,
		);

		this.rootEl.style.height = `${nextHeight}px`;
		if (this.lastRect) {
			this.positionNear(this.lastRect);
		}
	}

	private getPreferredHeight(savedHeight: number): number {
		const window = this.rootEl.ownerDocument.defaultView ?? activeWindow;
		const minHeight = Number.parseFloat(window.getComputedStyle(this.rootEl).minHeight) || 150;
		const maxHeight = window.innerHeight - 24;
		return clamp(savedHeight, minHeight, Math.max(minHeight, maxHeight));
	}

	private handleResize(): void {
		if (this.manualActionsOnly || !this.options.rememberSize || this.rootEl.style.display === "none") {
			return;
		}

		window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => {
			const rect = this.rootEl.getBoundingClientRect();
			this.options.onResize(Math.round(rect.width), Math.round(rect.height));
		}, 250);
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
