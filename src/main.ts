import { Menu, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { getProviderLabel, TranslatorService } from "./translatorService";
import { DEFAULT_TRANSLATION_PROMPT } from "./translatorService";
import { PdfSelectionReader } from "./pdfSelection";
import { PdfOllamaTranslatorSettingTab } from "./settings";
import { PDF_OLLAMA_TRANSLATOR_VIEW_TYPE, PdfOllamaTranslatorSidebarView } from "./sidebarView";
import { TranslationPopup } from "./translationPopup";
import { PdfHighlightService } from "./pdfHighlight/PdfHighlightService";
import { t } from "./i18n";
import type {
	ConnectionTestResult,
	PdfOllamaTranslatorSettings,
	PdfTextSelection,
	SidebarTranslationState,
	TranslationResult,
} from "./types";

const DEFAULT_SETTINGS: PdfOllamaTranslatorSettings = {
	translationScope: "global",
	translationProvider: "local-llm",
	ollamaBaseUrl: "http://localhost:11434",
	model: "RogerBen/HY-MT2-1.8B:latest",
	cloudApiBaseUrl: "",
	cloudApiKeySecretId: "",
	cloudApiModel: "",
	autoTranslateSelection: true,
	enablePopup: true,
	enableContextMenu: true,
	restrictSourceLanguages: true,
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
	debounceMs: 350,
	requestTimeoutMs: 30000,
	maxSelectionChars: 5000,
	fontSize: 13,
	lineHeight: 1.6,
	rememberPopupSize: true,
	popupWidth: 360,
	popupHeight: 220,
	showCopyButton: true,
	showRetryButton: true,
	defaultHighlightColor: "yellow",
	customPrompt: DEFAULT_TRANSLATION_PROMPT,
	topK: 20,
	topP: 0.6,
	repeatPenalty: 1.05,
	numPredict: 4096,
	ollamaOptionsJson: "",
	cleanModelOutput: true,
	debugLogging: false,
};

const LEGACY_CLOUD_API_SECRET_ID = "llm-translator-cloud-api-key";

interface AppWithSetting {
	setting?: {
		open: () => void;
		openTabById: (id: string) => unknown;
	};
}

export default class PdfOllamaTranslatorPlugin extends Plugin {
	settings: PdfOllamaTranslatorSettings;
	private translator: TranslatorService;
	private selectionReader: PdfSelectionReader;
	private highlightService: PdfHighlightService;
	private popup: TranslationPopup;
	private selectionTimer: number | undefined;
	private activeRequest: AbortController | undefined;
	private lastSelection: PdfTextSelection | undefined;
	private lastDocumentSelection: PdfTextSelection | undefined;
	private lastSelectionKey = "";
	private isPointerSelecting = false;
	private sidebarState: SidebarTranslationState = {
		sourceText: "",
		translatedText: "",
		status: "idle",
		message: "",
	};

	async onload(): Promise<void> {
		await this.loadSettings();

		this.translator = new TranslatorService(
			() => this.settings,
			(secretId) => this.app.secretStorage.getSecret(secretId),
		);
		this.selectionReader = new PdfSelectionReader(this.app, () => this.settings, this.debug);
		this.highlightService = new PdfHighlightService(
			this.app,
			this.debug,
			() => this.beginHighlightNoteEditing(),
		);
		this.popup = new TranslationPopup({
			showCopyButton: this.settings.showCopyButton,
			showRetryButton: this.settings.showRetryButton,
			defaultHighlightColor: this.settings.defaultHighlightColor,
			fontSize: this.settings.fontSize,
			lineHeight: this.settings.lineHeight,
			sourceLanguage: this.settings.sourceLanguage,
			targetLanguage: this.settings.targetLanguage,
			rememberSize: this.settings.rememberPopupSize,
			width: this.settings.popupWidth,
			height: this.settings.popupHeight,
			onLanguageChange: (sourceLanguage, targetLanguage) =>
				void this.updateSettings({ sourceLanguage, targetLanguage }),
			onResize: (width, height) => void this.updateSettings({ popupWidth: width, popupHeight: height }),
			onRetry: () => void this.retryLastSelection(),
			onHighlight: () => void this.highlightActiveSelection(),
		});

		this.addSettingTab(new PdfOllamaTranslatorSettingTab(this.app, this));
		this.registerSidebarView();
		this.addRibbonIcon("languages", "LLM Translator", () => {
			void this.activateSidebarView();
		});
		this.addCommand({
			id: "open-pdf-ollama-translator-sidebar",
			name: "Open sidebar",
			callback: () => void this.activateSidebarView(),
		});
		this.registerSelectionEvents();
		this.registerContextMenu();
		this.registerWorkspaceEvents();
	}

	onunload(): void {
		this.cancelActiveRequest();
		window.clearTimeout(this.selectionTimer);
		this.highlightService?.flushAllPending();
		this.highlightService?.destroy();
		this.popup?.destroy();
	}

	async updateSettings(partial: Partial<PdfOllamaTranslatorSettings>): Promise<void> {
		this.settings = { ...this.settings, ...partial };
		await this.saveSettings();
		this.syncPopupOptions();
		this.refreshSidebarViews();
	}

	async updateNumberSetting(
		key: keyof Pick<
			PdfOllamaTranslatorSettings,
			"debounceMs" | "fontSize" | "maxSelectionChars" | "numPredict" | "requestTimeoutMs" | "topK"
		>,
		value: string,
		min: number,
		max: number,
	): Promise<void> {
		const parsed = Number.parseInt(value, 10);
		if (!Number.isFinite(parsed)) {
			return;
		}

		const nextValue = Math.min(Math.max(parsed, min), max);
		await this.updateSettings({ [key]: nextValue });
	}

	async updateFloatSetting(
		key: keyof Pick<PdfOllamaTranslatorSettings, "lineHeight" | "repeatPenalty" | "topP">,
		value: string,
		min: number,
		max: number,
	): Promise<void> {
		const parsed = Number.parseFloat(value);
		if (!Number.isFinite(parsed)) {
			return;
		}

		const nextValue = Math.min(Math.max(parsed, min), max);
		await this.updateSettings({ [key]: nextValue });
	}

	async testConnection(): Promise<ConnectionTestResult> {
		const result = await this.translator.testConnection();
		this.debug("Connection test result.", result);
		return result;
	}

	async listModels(): Promise<string[]> {
		return this.translator.listModels();
	}

	getActiveProviderLabel(): string {
		return getProviderLabel(this.settings.translationProvider);
	}

	getSidebarState(): SidebarTranslationState {
		return { ...this.sidebarState };
	}

	clearSidebarState(): void {
		this.sidebarState = {
			sourceText: "",
			translatedText: "",
			status: "idle",
			message: "",
		};
		this.refreshSidebarViews();
	}

	setSidebarSourceText(sourceText: string): void {
		this.cancelActiveRequest();
		this.sidebarState = {
			sourceText,
			translatedText: "",
			status: "idle",
			message: "",
		};
	}

	async copySidebarText(mode: "raw" | "result" | "both"): Promise<void> {
		const { sourceText, translatedText } = this.sidebarState;
		const value =
			mode === "raw"
				? sourceText
				: mode === "result"
					? translatedText
					: [sourceText, translatedText].filter(Boolean).join("\n\n");

		if (!value) {
			new Notice(t("notice.nothingToCopy"));
			return;
		}

		await navigator.clipboard.writeText(value);
		new Notice(t("notice.copied"));
	}

	async translateActiveSelectionFromSidebar(): Promise<void> {
		const selection = this.selectionReader.readSelection() ?? this.lastDocumentSelection;
		if (!selection) {
			new Notice(t("notice.selectTextFirst"));
			return;
		}
		await this.translateSelection(selection, true);
	}

	async translateSidebarText(text: string, rect: DOMRect): Promise<void> {
		const sourceText = text.trim();
		if (!sourceText) {
			new Notice(t("notice.enterTextFirst"));
			return;
		}

		await this.translateSelection({ text: sourceText, rect }, true);
	}

	async highlightActiveSelection(): Promise<void> {
		const selection = this.selectionReader.readSelection() ?? this.lastSelection;
		if (!selection) {
			new Notice(t("notice.selectTextFirst"));
			return;
		}

		try {
			await this.highlightService.toggleSelectionHighlight(selection, this.settings.defaultHighlightColor);
		} catch (error) {
			this.debug("PDF highlight failed.", error);
			new Notice(`${t("notice.highlightFailed")} ${toReadableMessage(error)}`.trim());
		}
	}

	async clearActivePdfHighlights(): Promise<void> {
		if (!this.highlightService.hasPdfForClear()) {
			new Notice(t("notice.openPdfFirst"));
			return;
		}
		if (!window.confirm(t("sidebar.clearAllHighlightsConfirm"))) {
			return;
		}
		try {
			const removed = await this.highlightService.clearAllHighlightsForActivePdf();
			if (removed === null) {
				new Notice(t("notice.openPdfFirst"));
			}
		} catch (error) {
			this.debug("Could not clear PDF highlights.", error);
			new Notice(`${t("notice.highlightFailed")} ${toReadableMessage(error)}`.trim());
		}
	}

	openSettingsTab(): void {
		const setting = (this.app as AppWithSetting).setting;
		if (!setting) {
			new Notice(t("notice.cannotOpenSettings"));
			return;
		}
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	private registerSidebarView(): void {
		this.registerView(
			PDF_OLLAMA_TRANSLATOR_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new PdfOllamaTranslatorSidebarView(leaf, this),
		);
	}

	private async activateSidebarView(): Promise<void> {
		this.popup.hide();

		// Detach existing leaves to force right-side creation.
		const existingLeaves = this.app.workspace.getLeavesOfType(PDF_OLLAMA_TRANSLATOR_VIEW_TYPE);
		for (const leaf of existingLeaves) {
			leaf.detach();
		}

		// Reopen in the right sidebar
		let leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(true);
		}
		if (!leaf) {
			new Notice(t("notice.cannotOpenSidebar"));
			return;
		}
		await leaf.setViewState({ type: PDF_OLLAMA_TRANSLATOR_VIEW_TYPE, active: true });
	}

	private registerSelectionEvents(): void {
		this.registerDomEvent(activeDocument, "pointerdown", (event) => this.handleDocumentPointerDown(event), true);
		this.registerDomEvent(activeDocument, "selectionchange", () => this.handleSelectionChange());
		this.registerDomEvent(activeDocument, "mouseup", () => this.finishPointerSelection());
		this.registerDomEvent(activeDocument, "keydown", (event) => this.handleDocumentKeyDown(event));
		this.registerDomEvent(activeDocument, "keyup", (event) => {
			if (isHighlightNoteTarget(event.target)) {
				window.clearTimeout(this.selectionTimer);
				return;
			}
			this.scheduleSelectionTranslation();
		});
		this.registerDomEvent(window, "resize", () => this.popup.reposition());
		this.registerDomEvent(activeDocument, "scroll", () => this.popup.reposition(), true);
	}

	private registerWorkspaceEvents(): void {
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => {
				this.highlightService.flushPendingForInactiveViews();
				this.highlightService.refreshOverlays();
			}),
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.highlightService.flushPendingForInactiveViews();
				this.highlightService.refreshOverlays();
			}),
		);
	}

	private registerContextMenu(): void {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!this.settings.enableContextMenu) {
					return;
				}
				const text = editor.getSelection().trim();
				if (!text) {
					return;
				}
				menu.addItem((item) => {
					item
						.setTitle(t("contextMenu.translate"))
						.setIcon("languages")
						.onClick(() => void this.translateActiveSelectionFromSidebar());
				});
			}),
		);
		this.registerDomEvent(activeDocument, "contextmenu", (event) => this.handleContextMenu(event), true);
	}

	private handleContextMenu(event: MouseEvent): void {
		if (!this.settings.enableContextMenu) {
			return;
		}
		if (isHighlightNoteTarget(event.target)) {
			return;
		}
		// Markdown views are handled by `editor-menu` above; only intercept right-clicks
		// that actually land inside the active PDF container (not the sidebar, popup, etc.).
		const pdfContainer = this.selectionReader.getActivePdfContainerEl();
		if (!pdfContainer) {
			return;
		}
		if (!(event.target instanceof Node) || !pdfContainer.contains(event.target)) {
			return;
		}

		const selection = this.selectionReader.readSelection();
		if (!selection) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();

		const menu = new Menu();
		menu.addItem((item) => {
			item
				.setTitle(t("contextMenu.translate"))
				.setIcon("languages")
				.onClick(() => void this.translateSelection(selection, true));
		});
		menu.addItem((item) => {
			item
				.setTitle(t("contextMenu.copy"))
				.setIcon("copy")
				.onClick(async () => {
					await navigator.clipboard.writeText(selection.text);
					new Notice(t("notice.copied"));
				});
		});
		menu.showAtMouseEvent(event);
	}

	private handleDocumentPointerDown(event: MouseEvent): void {
		if (isHighlightNoteTarget(event.target)) {
			return;
		}
		if (this.popup.containsTarget(event.target)) {
			return;
		}

		this.hidePopup();
		this.isPointerSelecting = true;
		window.clearTimeout(this.selectionTimer);
	}

	private handleSelectionChange(): void {
		if (this.isPointerSelecting || isHighlightNoteTarget(activeDocument.activeElement)) {
			window.clearTimeout(this.selectionTimer);
			return;
		}
		this.scheduleSelectionTranslation();
	}

	private finishPointerSelection(): void {
		if (!this.isPointerSelecting) {
			return;
		}
		this.isPointerSelecting = false;
		this.scheduleSelectionTranslation();
	}

	private handleDocumentKeyDown(event: KeyboardEvent): void {
		if (isHighlightNoteTarget(event.target)) {
			return;
		}
		if (event.key.toLowerCase() !== "z" || event.shiftKey || (!event.metaKey && !event.ctrlKey)) {
			return;
		}

		const selection = this.selectionReader.readSelection();
		if (!this.highlightService.canUndoSelection(selection)) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		this.highlightService.undoLastHighlight();
	}

	private scheduleSelectionTranslation(): void {
		window.clearTimeout(this.selectionTimer);
		if (isHighlightNoteTarget(activeDocument.activeElement)) {
			return;
		}
		const selection = this.selectionReader.readSelection();
		if (selection) {
			this.lastDocumentSelection = selection;
		}
		if (!this.settings.autoTranslateSelection) {
			return;
		}

		this.selectionTimer = window.setTimeout(
			() => void this.translateCurrentSelection(),
			this.settings.debounceMs,
		);
	}

	private async translateCurrentSelection(): Promise<void> {
		const selection = this.selectionReader.readSelection();
		if (!selection) {
			return;
		}

		await this.translateSelection(selection, false);
	}

	private async retryLastSelection(): Promise<void> {
		if (!this.lastSelection) {
			new Notice(t("notice.noSelectionToRetry"));
			return;
		}
		await this.translateSelection(this.lastSelection, true);
	}

	private async translateSelection(selection: PdfTextSelection, force: boolean): Promise<void> {
		if (selection.text.length > this.settings.maxSelectionChars) {
			const message = t("notice.selectionExceedsLimit", { count: this.settings.maxSelectionChars });
			if (this.isSidebarVisible()) {
				this.updateSidebarState({
					sourceText: selection.text,
					translatedText: "",
					status: "error",
					message,
				});
			} else {
				this.popup.showInfo(message, selection.rect);
			}
			return;
		}

		const missingConfigMessage = this.getMissingProviderConfigMessage();
		if (missingConfigMessage) {
			if (this.isSidebarVisible()) {
				this.updateSidebarState({
					sourceText: selection.text,
					translatedText: "",
					status: "error",
					message: missingConfigMessage,
				});
			} else {
				this.popup.showError(missingConfigMessage, selection.rect);
			}
			return;
		}

		const selectionKey = `${selection.text}:${Math.round(selection.rect.left)}:${Math.round(selection.rect.top)}`;
		if (!force && selectionKey === this.lastSelectionKey) {
			return;
		}

		this.lastSelection = selection;
		this.lastSelectionKey = selectionKey;
		this.cancelActiveRequest();

		const request = new AbortController();
		this.activeRequest = request;
		const showPopup = !this.isSidebarVisible();
		const shouldShowPopup = showPopup && this.settings.enablePopup;
		if (shouldShowPopup) {
			this.popup.showLoading(selection.rect);
		} else {
			this.popup.hide();
		}
		this.updateSidebarState({
			sourceText: selection.text,
			translatedText: "",
			status: "loading",
			message: "",
		});
		this.debug("Translating PDF selection.", {
			length: selection.text.length,
			provider: this.settings.translationProvider,
			model: this.getActiveModelName(),
		});

		try {
			const result = await this.translator.translate({
				text: selection.text,
				sourceLanguage: this.settings.sourceLanguage,
				targetLanguage: this.settings.targetLanguage,
				allowedSourceLanguages: ["en", "de", "fr", "ja", "zh-Hans"],
				signal: request.signal,
			});
			if (!request.signal.aborted) {
				if (shouldShowPopup) {
					this.showTranslationResult(result, selection.rect);
				}
				this.updateSidebarState({
					sourceText: result.sourceText,
					translatedText: result.translatedText,
					status: "success",
					message: "",
				});
			}
		} catch (error) {
			if (request.signal.aborted) {
				return;
			}

			const message = this.translator.toReadableError(error);
			this.debug("Translation failed.", error);
			if (shouldShowPopup) {
				this.popup.showError(message, selection.rect);
			}
			this.updateSidebarState({
				sourceText: selection.text,
				translatedText: "",
				status: "error",
				message,
			});
		} finally {
			if (this.activeRequest === request) {
				this.activeRequest = undefined;
			}
		}
	}

	private showTranslationResult(result: TranslationResult, rect: DOMRect): void {
		this.popup.showResult(result, rect);
	}

	private getMissingProviderConfigMessage(): string {
		if (this.settings.translationProvider === "local-llm" && !this.settings.model.trim()) {
			return t("error.selectLocalModel");
		}
		if (this.settings.translationProvider === "cloud-api") {
			if (!this.getCloudApiKey()) {
				return t("error.fillApiKey");
			}
			if (!this.settings.cloudApiModel.trim()) {
				return t("error.fillModelName");
			}
		}
		return "";
	}

	private getActiveModelName(): string {
		if (this.settings.translationProvider === "cloud-api") {
			return this.settings.cloudApiModel;
		}
		if (this.settings.translationProvider === "local-llm") {
			return this.settings.model;
		}
		return getProviderLabel(this.settings.translationProvider);
	}

	private hidePopup(): void {
		this.cancelActiveRequest();
		this.popup.hide();
		this.lastSelectionKey = "";
	}

	private beginHighlightNoteEditing(): void {
		window.clearTimeout(this.selectionTimer);
		this.isPointerSelecting = false;
		this.hidePopup();
	}

	private cancelActiveRequest(): void {
		if (this.activeRequest) {
			this.activeRequest.abort();
			this.activeRequest = undefined;
		}
	}

	private syncPopupOptions(): void {
		this.popup.updateOptions({
			showCopyButton: this.settings.showCopyButton,
			showRetryButton: this.settings.showRetryButton,
			defaultHighlightColor: this.settings.defaultHighlightColor,
			fontSize: this.settings.fontSize,
			lineHeight: this.settings.lineHeight,
			sourceLanguage: this.settings.sourceLanguage,
			targetLanguage: this.settings.targetLanguage,
			rememberSize: this.settings.rememberPopupSize,
			width: this.settings.popupWidth,
			height: this.settings.popupHeight,
			onLanguageChange: (sourceLanguage, targetLanguage) =>
				void this.updateSettings({ sourceLanguage, targetLanguage }),
			onResize: (width, height) => void this.updateSettings({ popupWidth: width, popupHeight: height }),
			onRetry: () => void this.retryLastSelection(),
			onHighlight: () => void this.highlightActiveSelection(),
		});
	}

	private updateSidebarState(nextState: SidebarTranslationState): void {
		this.sidebarState = nextState;
		this.refreshSidebarViews();
	}

	private refreshSidebarViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(PDF_OLLAMA_TRANSLATOR_VIEW_TYPE)) {
			const view = leaf.view;
			if (view instanceof PdfOllamaTranslatorSidebarView) {
				view.refresh();
			}
		}
	}

	private isSidebarVisible(): boolean {
		return this.app.workspace
			.getLeavesOfType(PDF_OLLAMA_TRANSLATOR_VIEW_TYPE)
			.some((leaf) => {
				if (!(leaf.view instanceof PdfOllamaTranslatorSidebarView)) {
					return false;
				}

				const viewEl = leaf.view.containerEl;
				const leafEl = viewEl.closest<HTMLElement>(".workspace-leaf");
				if (leafEl && !leafEl.classList.contains("mod-active")) {
					return false;
				}

				const visibleEl = leafEl ?? viewEl;
				const rect = visibleEl.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0 && getComputedStyle(visibleEl).display !== "none";
			});
	}

	private async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Record<string, unknown> | undefined ?? {};
		const safe = loaded as unknown as Partial<PdfOllamaTranslatorSettings> & { translationProvider?: string };
		const legacyApiKey = typeof loaded.cloudApiKey === "string" ? loaded.cloudApiKey.trim() : "";
		let cloudApiKeySecretId = typeof safe.cloudApiKeySecretId === "string"
			? safe.cloudApiKeySecretId
			: "";
		if (legacyApiKey && !cloudApiKeySecretId) {
			cloudApiKeySecretId = LEGACY_CLOUD_API_SECRET_ID;
			if (!this.app.secretStorage.getSecret(cloudApiKeySecretId)) {
				this.app.secretStorage.setSecret(cloudApiKeySecretId, legacyApiKey);
			}
		}
		this.settings = {
			...DEFAULT_SETTINGS,
			...safe,
			cloudApiBaseUrl: safe.cloudApiBaseUrl ?? DEFAULT_SETTINGS.cloudApiBaseUrl,
			cloudApiKeySecretId,
			cloudApiModel: safe.cloudApiModel ?? DEFAULT_SETTINGS.cloudApiModel,
			translationProvider: safe.translationProvider ?? DEFAULT_SETTINGS.translationProvider,
		};
		if (Object.prototype.hasOwnProperty.call(loaded, "cloudApiKey")) {
			await this.saveSettings();
		}
	}

	private async saveSettings(): Promise<void> {
		const persisted = { ...this.settings } as Record<string, unknown>;
		delete persisted.cloudApiKey;
		await this.saveData(persisted);
	}

	private getCloudApiKey(): string {
		const secretId = this.settings.cloudApiKeySecretId.trim();
		return secretId ? this.app.secretStorage.getSecret(secretId)?.trim() ?? "" : "";
	}

	private debug = (message: string, detail?: unknown): void => {
		if (!this.settings.debugLogging) {
			return;
		}
		console.debug("[LLM Translator]", message, detail ?? "");
	};
}

function toReadableMessage(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "";
}

function isHighlightNoteTarget(target: EventTarget | null): boolean {
	const node = target && typeof target === "object" && "nodeType" in target
		? target as Node
		: null;
	const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
	return Boolean(
		element?.closest(
			".pdf-ollama-translator-highlight-overlay, .pdf-ollama-translator-highlight-note-icon, .pdf-ollama-translator-highlight-note-editor",
		)
	);
}
