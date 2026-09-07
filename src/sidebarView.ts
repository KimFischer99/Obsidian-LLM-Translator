import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type PdfOllamaTranslatorPlugin from "./main";
import type { TranslationLanguage, TranslationProviderId } from "./types";
import { t } from "./i18n";
import { HIGHLIGHT_COLOR_ORDER, getHighlightColor } from "./pdfHighlight/colors";

export const PDF_OLLAMA_TRANSLATOR_VIEW_TYPE = "llm-translator-sidebar";
const SIDEBAR_LEAF_CLASS = "pdf-ollama-translator-sidebar-leaf";
const SIDEBAR_SPLIT_CLASS = "pdf-ollama-translator-sidebar-split";

export class PdfOllamaTranslatorSidebarView extends ItemView {
	private sourceInputEl: HTMLTextAreaElement | null = null;
	private sidebarLeafEl: HTMLElement | null = null;
	private sidebarSplitEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: PdfOllamaTranslatorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PDF_OLLAMA_TRANSLATOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "LLM Translator";
	}

	getIcon(): string {
		return "languages";
	}

	async onOpen(): Promise<void> {
		this.sidebarLeafEl = this.containerEl.closest<HTMLElement>(".workspace-leaf");
		this.sidebarSplitEl = this.sidebarLeafEl?.closest<HTMLElement>(".workspace-split.mod-right-split") ?? null;
		this.sidebarLeafEl?.addClass(SIDEBAR_LEAF_CLASS);
		this.sidebarSplitEl?.addClass(SIDEBAR_SPLIT_CLASS);
		this.render();
	}

	async onClose(): Promise<void> {
		this.sidebarLeafEl?.removeClass(SIDEBAR_LEAF_CLASS);
		this.sidebarSplitEl?.removeClass(SIDEBAR_SPLIT_CLASS);
		this.sidebarLeafEl = null;
		this.sidebarSplitEl = null;
		this.sourceInputEl = null;
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("pdf-ollama-translator-sidebar");

		const headerEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__header" });
		const titleEl = headerEl.createDiv({ cls: "pdf-ollama-translator-sidebar__title" });
		const iconEl = titleEl.createSpan({ cls: "pdf-ollama-translator-sidebar__title-icon" });
		setIcon(iconEl, "languages");
		titleEl.createSpan({ text: "LLM Translator" });

		const openSettingsButton = headerEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { title: t("sidebar.openSettings"), "aria-label": t("sidebar.openSettings") },
		});
		setIcon(openSettingsButton, "settings");
		openSettingsButton.onClickEvent(() => this.plugin.openSettingsTab());

		this.renderServiceControls(container);
		this.renderLanguageControls(container);
		this.renderTextPanels(container);
		this.renderBottomControls(container);
	}

	private renderServiceControls(container: HTMLElement): void {
		const rowEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__service-row" });
		const providerEl = rowEl.createEl("select", {
			cls: "pdf-ollama-translator-sidebar__select",
			attr: { title: this.plugin.getActiveProviderLabel(), "aria-label": t("sidebar.translationService") },
		});
		for (const option of [
			{ value: "local-llm", label: "Local LLM" },
			{ value: "cloud-api", label: "Cloud API" },
			{ value: "google", label: "Google" },
			{ value: "bing", label: "Bing" },
		]) {
			providerEl.createEl("option", { text: option.label, value: option.value });
		}
		providerEl.value = this.plugin.settings.translationProvider;
		providerEl.onchange = () => {
			void this.plugin.updateSettings({ translationProvider: providerEl.value as TranslationProviderId });
		};

		const testButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { title: t("sidebar.testConnection"), "aria-label": t("sidebar.testConnection") },
		});
		setIcon(testButton, "plug-zap");
		testButton.onClickEvent(async () => {
			testButton.disabled = true;
			const result = await this.plugin.testConnection();
			testButton.disabled = false;
			new Notice(result.message);
		});

		const translateButton = rowEl.createEl("button", {
			text: t("sidebar.translateInput"),
			cls: "pdf-ollama-translator-sidebar__primary-button",
		});
		translateButton.onClickEvent(() => {
			if (!this.sourceInputEl) {
				return;
			}
			void this.plugin.translateSidebarText(this.sourceInputEl.value, this.sourceInputEl.getBoundingClientRect());
		});
	}

	private renderLanguageControls(container: HTMLElement): void {
		const rowEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__language-row" });
		const sourceEl = rowEl.createEl("select", { cls: "pdf-ollama-translator-sidebar__select" });
		for (const option of [
			{ value: "auto", label: "Auto" },
			{ value: "en", label: "English" },
			{ value: "de", label: "Deutsch" },
			{ value: "fr", label: "Français" },
			{ value: "tr", label: "Türkçe" },
			{ value: "ja", label: "日本語" },
			{ value: "zh-Hans", label: "简体中文" },
		]) {
			sourceEl.createEl("option", { text: option.label, value: option.value });
		}
		sourceEl.value = this.plugin.settings.sourceLanguage;
		sourceEl.onchange = () => {
			void this.plugin.updateSettings({ sourceLanguage: sourceEl.value as TranslationLanguage });
		};

		const swapButton = rowEl.createEl("button", {
			cls: "pdf-ollama-translator-sidebar__icon-button",
			attr: { "aria-label": t("popup.swapLanguage"), title: t("popup.swapLanguage") },
		});
		setIcon(swapButton, "arrow-left-right");
		swapButton.onpointerdown = (event) => event.preventDefault();

		const targetEl = rowEl.createEl("select", { cls: "pdf-ollama-translator-sidebar__select" });
		for (const option of [
			{ value: "en", label: "English" },
			{ value: "de", label: "Deutsch" },
			{ value: "fr", label: "Français" },
			{ value: "tr", label: "Türkçe" },
			{ value: "ja", label: "日本語" },
			{ value: "zh-Hans", label: "简体中文" },
		]) {
			targetEl.createEl("option", { text: option.label, value: option.value });
		}
		targetEl.value = this.plugin.settings.targetLanguage;
		targetEl.onchange = () => {
			void this.plugin.updateSettings({
				targetLanguage: targetEl.value as Exclude<TranslationLanguage, "auto">,
			});
		};
		swapButton.onClickEvent(() => {
			if (sourceEl.value === "auto") {
				sourceEl.value = targetEl.value;
				targetEl.value = this.plugin.settings.targetLanguage;
			} else {
				const previousSource = sourceEl.value;
				sourceEl.value = targetEl.value;
				targetEl.value = previousSource;
			}
			void this.plugin.updateSettings({
				sourceLanguage: sourceEl.value as TranslationLanguage,
				targetLanguage: targetEl.value as Exclude<TranslationLanguage, "auto">,
			});
			void this.plugin.translateActiveSelectionFromSidebar();
		});
	}

	private renderTextPanels(container: HTMLElement): void {
		const state = this.plugin.getSidebarState();

		const sourceEl = container.createEl("textarea", {
			cls: "pdf-ollama-translator-sidebar__panel pdf-ollama-translator-sidebar__source",
			attr: {
				"aria-label": t("sidebar.sourceText"),
				placeholder: t("sidebar.sourceTextPlaceholder"),
			},
		});
		this.sourceInputEl = sourceEl;
		sourceEl.value = state.sourceText;

		const resultEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__panel pdf-ollama-translator-sidebar__panel--result" });
		if (state.status === "loading") {
			resultEl.setText(t("sidebar.translating"));
		} else if (state.status === "error") {
			resultEl.setText(state.message || t("sidebar.translationFailed"));
			resultEl.addClass("is-error");
		} else {
			resultEl.setText(state.translatedText || t("sidebar.translation"));
			resultEl.toggleClass("is-placeholder", !state.translatedText);
		}

		sourceEl.oninput = () => {
			this.plugin.setSidebarSourceText(sourceEl.value);
			resultEl.setText(t("sidebar.translation"));
			resultEl.removeClass("is-error");
			resultEl.addClass("is-placeholder");
		};
	}

	private renderBottomControls(container: HTMLElement): void {
		const controlsEl = container.createDiv({ cls: "pdf-ollama-translator-sidebar__controls" });

		this.renderHighlightControls(controlsEl);

		const quickRowEl = controlsEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-row pdf-ollama-translator-sidebar__quick-row",
		});
		quickRowEl.createSpan({ text: t("sidebar.autoTrans"), cls: "pdf-ollama-translator-sidebar__control-label" });
		const quickActionsEl = quickRowEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-actions pdf-ollama-translator-sidebar__quick-actions",
		});
		const autoToggle = quickActionsEl.createEl("input", {
			cls: "pdf-ollama-translator-sidebar__toggle",
			attr: { type: "checkbox", "aria-label": t("sidebar.autoTransLabel") },
		});
		autoToggle.checked = this.plugin.settings.autoTranslateSelection;
		autoToggle.onchange = async () => {
			await this.plugin.updateSettings({ autoTranslateSelection: autoToggle.checked });
			this.render();
		};

		quickActionsEl.createEl("button", {
			text: t("sidebar.useCurrentSelection"),
			cls: "pdf-ollama-translator-sidebar__clear-button",
		}).onClickEvent(() => void this.plugin.translateActiveSelectionFromSidebar());
		quickActionsEl.createEl("button", {
			text: t("sidebar.clear"),
			cls: "pdf-ollama-translator-sidebar__clear-button",
		}).onClickEvent(() => {
			this.plugin.clearSidebarState();
		});

		const copyRowEl = controlsEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-row pdf-ollama-translator-sidebar__copy-row",
		});
		copyRowEl.createSpan({
			text: t("sidebar.copy"),
			cls: "pdf-ollama-translator-sidebar__control-label pdf-ollama-translator-sidebar__copy-label",
		});
		const copyActionsEl = copyRowEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-actions pdf-ollama-translator-sidebar__copy-actions",
		});
		for (const item of [
			{ label: t("sidebar.raw"), action: () => this.plugin.copySidebarText("raw") },
			{ label: t("sidebar.result"), action: () => this.plugin.copySidebarText("result") },
			{ label: t("sidebar.both"), action: () => this.plugin.copySidebarText("both") },
		]) {
			copyActionsEl.createEl("button", {
				text: item.label,
				cls: "pdf-ollama-translator-sidebar__copy-button",
			}).onClickEvent(() => void item.action());
		}
	}

	private renderHighlightControls(container: HTMLElement): void {
		const rowEl = container.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-row pdf-ollama-translator-sidebar__highlight-row",
		});
		rowEl.createSpan({ text: t("sidebar.highlightColor"), cls: "pdf-ollama-translator-sidebar__control-label" });
		const paletteEl = rowEl.createDiv({
			cls: "pdf-ollama-translator-sidebar__control-actions pdf-ollama-translator-sidebar__highlight-palette",
		});

		for (const colorId of HIGHLIGHT_COLOR_ORDER) {
			const color = getHighlightColor(colorId);
			const button = paletteEl.createEl("button", {
				cls: "pdf-ollama-translator-sidebar__highlight-swatch",
				attr: {
					"aria-label": color.label,
					"aria-pressed": String(this.plugin.settings.defaultHighlightColor === colorId),
					title: color.label,
				},
			});
			button.style.setProperty("--pdf-ollama-translator-highlight-color", color.css);
			button.style.backgroundColor = color.css;
			button.toggleClass("is-active", this.plugin.settings.defaultHighlightColor === colorId);
			button.onClickEvent(async () => {
				await this.plugin.updateSettings({ defaultHighlightColor: colorId });
				this.render();
			});
		}

		const clearButton = paletteEl.createEl("button", {
			text: t("sidebar.clearAllHighlights"),
			cls: "pdf-ollama-translator-sidebar__clear-button pdf-ollama-translator-sidebar__clear-highlights-button",
		});
		clearButton.onClickEvent(() => void this.plugin.clearActivePdfHighlights());
	}
}
