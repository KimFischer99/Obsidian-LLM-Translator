import { App, DropdownComponent, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type PdfOllamaTranslatorPlugin from "./main";
import { DEFAULT_TRANSLATION_PROMPT } from "./translatorService";
import type { HighlightColorId, TranslationLanguage, TranslationProviderId } from "./types";
import { t } from "./i18n";
import { HIGHLIGHT_COLOR_ORDER, getHighlightColor } from "./pdfHighlight/colors";

const SOURCE_LANGUAGE_OPTIONS: Array<{ value: TranslationLanguage; label: string }> = [
	{ value: "auto", label: "Auto" },
	{ value: "en", label: "English" },
	{ value: "de", label: "Deutsch" },
	{ value: "fr", label: "Français" },
	{ value: "tr", label: "Türkçe" },
	{ value: "ja", label: "日本語" },
	{ value: "zh-Hans", label: "简体中文" },
];

const TARGET_LANGUAGE_OPTIONS: Array<{ value: Exclude<TranslationLanguage, "auto">; label: string }> = [
	{ value: "en", label: "English" },
	{ value: "de", label: "Deutsch" },
	{ value: "fr", label: "Français" },
	{ value: "tr", label: "Türkçe" },
	{ value: "ja", label: "日本語" },
	{ value: "zh-Hans", label: "简体中文" },
];

export class PdfOllamaTranslatorSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PdfOllamaTranslatorPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("pdf-ollama-translator-settings");

		this.addSection(t("settings.section.general"));
		new Setting(containerEl)
			.setName(t("settings.translationScope"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("global", t("settings.global"))
					.addOption("pdf-only", t("settings.pdfOnly"))
					.setValue(this.plugin.settings.translationScope)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ translationScope: value as "global" | "pdf-only" });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.autoTranslateSelection"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoTranslateSelection)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ autoTranslateSelection: value });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.enablePopup"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enablePopup)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ enablePopup: value });
					}),
			);

		this.addSection(t("settings.section.service"));
		new Setting(containerEl)
			.setName(t("settings.translationService"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("local-llm", "Local LLM")
					.addOption("cloud-api", "Cloud API")
					.addOption("google", "Google")
					.addOption("bing", "Bing")
					.setValue(this.plugin.settings.translationProvider)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ translationProvider: value as TranslationProviderId });
						this.display();
					}),
			);

		if (this.plugin.settings.translationProvider === "local-llm") {
			this.renderLocalServiceSettings(containerEl);
		} else if (this.plugin.settings.translationProvider === "cloud-api") {
			this.renderCloudServiceSettings(containerEl);
		} else {
			this.renderDirectServiceSettings(containerEl);
		}

		new Setting(containerEl)
			.setName(t("settings.sourceLanguage"))
			.addDropdown((dropdown) => {
				for (const option of SOURCE_LANGUAGE_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				return dropdown
					.setValue(this.plugin.settings.sourceLanguage)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ sourceLanguage: value as TranslationLanguage });
					});
			});

		new Setting(containerEl)
			.setName(t("settings.targetLanguage"))
			.addDropdown((dropdown) => {
				for (const option of TARGET_LANGUAGE_OPTIONS) {
					dropdown.addOption(option.value, option.label);
				}
				return dropdown
					.setValue(this.plugin.settings.targetLanguage)
					.onChange(async (value) => {
						await this.plugin.updateSettings({
							targetLanguage: value as Exclude<TranslationLanguage, "auto">,
						});
					});
			});

		this.addSection(t("settings.section.interface"));
		new Setting(containerEl)
			.setName(t("settings.fontSize"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "10";
				text
					.setValue(String(this.plugin.settings.fontSize))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("fontSize", value, 10, 24);
					});
			});

		new Setting(containerEl)
			.setName(t("settings.lineHeight"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.step = "0.1";
				text
					.setValue(String(this.plugin.settings.lineHeight))
					.onChange(async (value) => {
						await this.plugin.updateFloatSetting("lineHeight", value, 1, 2.4);
					});
			});

		new Setting(containerEl)
			.setName(t("settings.rememberPopupSize"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.rememberPopupSize)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ rememberPopupSize: value });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.showCopyButton"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showCopyButton)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ showCopyButton: value });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.showRetryButton"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showRetryButton)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ showRetryButton: value });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.defaultHighlightColor"))
			.addDropdown((dropdown) => {
				for (const colorId of HIGHLIGHT_COLOR_ORDER) {
					dropdown.addOption(colorId, getHighlightColor(colorId).label);
				}
				return dropdown
					.setValue(this.plugin.settings.defaultHighlightColor)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ defaultHighlightColor: value as HighlightColorId });
					});
			});

		this.addSection(t("settings.section.advanced"));
		new Setting(containerEl)
			.setName(t("settings.maxSelectionChars"))
			.setDesc(t("settings.maxSelectionCharsDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.maxSelectionChars))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("maxSelectionChars", value, 1, 20000);
					});
			});

		new Setting(containerEl)
			.setName(t("settings.debounce"))
			.setDesc(t("settings.debounceDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("debounceMs", value, 0, 5000);
					});
			});

		new Setting(containerEl)
			.setName(t("settings.requestTimeout"))
			.setDesc(t("settings.requestTimeoutDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1000";
				text
					.setValue(String(this.plugin.settings.requestTimeoutMs))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("requestTimeoutMs", value, 1000, 300000);
					});
			});

		new Setting(containerEl)
			.setName(t("settings.customPrompt"))
			.setDesc(t("settings.customPromptDesc"))
			.addTextArea((text) => {
				text.inputEl.rows = 5;
				text.inputEl.addClass("pdf-ollama-translator-settings__textarea");
				text
					.setPlaceholder(DEFAULT_TRANSLATION_PROMPT)
					.setValue(this.plugin.settings.customPrompt || DEFAULT_TRANSLATION_PROMPT)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ customPrompt: value });
					});
			});

		if (this.plugin.settings.translationProvider === "local-llm") {
			this.renderLocalAdvancedSettings(containerEl);
		}

		new Setting(containerEl)
			.setName(t("settings.cleanOutput"))
			.setDesc(t("settings.cleanOutputDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.cleanModelOutput)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cleanModelOutput: value });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.debugLogging"))
			.setDesc(t("settings.debugLoggingDesc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLogging)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ debugLogging: value });
					}),
			);
	}

	private renderLocalServiceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.localEndpoint"))
			.addText((text) =>
				text
					.setPlaceholder("http://localhost:11434")
					.setValue(this.plugin.settings.ollamaBaseUrl)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ ollamaBaseUrl: value.trim() });
					}),
			);

		let modelDropdown: DropdownComponent | undefined;
		new Setting(containerEl)
			.setName(t("settings.modelName"))
			.addDropdown((dropdown) => {
				modelDropdown = dropdown;
				dropdown.addOption("", t("settings.selectModel"));
				if (this.plugin.settings.model) {
					dropdown.addOption(this.plugin.settings.model, this.plugin.settings.model);
				}
				return dropdown
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ model: value });
					});
			})
			.addButton((button) => this.bindTestButton(button));
		if (modelDropdown) {
			void this.populateModelDropdown(modelDropdown);
		}
	}

	private renderCloudServiceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.apiType"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("openai-compatible", "OpenAI Compatible")
					.setValue("openai-compatible"),
			);

		new Setting(containerEl)
			.setName(t("settings.apiUrl"))
			.addText((text) =>
				text
					.setPlaceholder("https://api.example.com")
					.setValue(this.plugin.settings.cloudApiBaseUrl)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cloudApiBaseUrl: value.trim() });
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.apiKey"))
			.setDesc(t("settings.apiKeyDesc"))
			.addComponent((el) => new SecretComponent(this.app, el)
				.setValue(this.plugin.settings.cloudApiKeySecretId)
				.onChange(async (value) => {
					await this.plugin.updateSettings({ cloudApiKeySecretId: value });
				}));

		new Setting(containerEl)
			.setName(t("settings.modelName"))
			.addText((text) =>
				text
					.setPlaceholder("model-name")
					.setValue(this.plugin.settings.cloudApiModel)
					.onChange(async (value) => {
						await this.plugin.updateSettings({ cloudApiModel: value.trim() });
					}),
			)
			.addButton((button) => this.bindTestButton(button));
	}

	private renderDirectServiceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName(t("settings.connectionTest"))
			.addButton((button) => this.bindTestButton(button));
	}

	private renderLocalAdvancedSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Top K")
			.setDesc(t("settings.topKDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.topK))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("topK", value, 1, 1000);
					});
			});

		new Setting(containerEl)
			.setName("Top P")
			.setDesc(t("settings.topPDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.max = "1";
				text.inputEl.step = "0.05";
				text
					.setValue(String(this.plugin.settings.topP))
					.onChange(async (value) => {
						await this.plugin.updateFloatSetting("topP", value, 0, 1);
					});
			});

		new Setting(containerEl)
			.setName("Repeat Penalty")
			.setDesc(t("settings.repeatPenaltyDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "0";
				text.inputEl.step = "0.01";
				text
					.setValue(String(this.plugin.settings.repeatPenalty))
					.onChange(async (value) => {
						await this.plugin.updateFloatSetting("repeatPenalty", value, 0, 3);
					});
			});

		new Setting(containerEl)
			.setName("Num Predict")
			.setDesc(t("settings.numPredictDesc"))
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text
					.setValue(String(this.plugin.settings.numPredict))
					.onChange(async (value) => {
						await this.plugin.updateNumberSetting("numPredict", value, 1, 32768);
					});
			});
	}

	private bindTestButton(button: import("obsidian").ButtonComponent): import("obsidian").ButtonComponent {
		return button
			.setButtonText(t("settings.test"))
			.onClick(async () => {
				button.buttonEl.disabled = true;
				button.setButtonText(t("settings.testing"));
				const result = await this.plugin.testConnection();
				button.buttonEl.disabled = false;
				button.setButtonText(t("settings.test"));
				new Notice(result.message);
			});
	}

	private async populateModelDropdown(dropdown: DropdownComponent): Promise<void> {
		try {
			const currentModel = this.plugin.settings.model;
			const models = await this.plugin.listModels();
			dropdown.selectEl.empty();
			dropdown.addOption("", t("settings.selectModel"));
			for (const model of models) {
				dropdown.addOption(model, model);
			}
			if (currentModel && !models.includes(currentModel)) {
				dropdown.addOption(currentModel, currentModel);
			}
			dropdown.setValue(currentModel);
		} catch {
			// 连接不可用时保留当前模型选项，测试按钮会显示具体错误。
		}
	}

	private addSection(title: string): void {
		new Setting(this.containerEl).setName(title).setHeading();
	}
}
