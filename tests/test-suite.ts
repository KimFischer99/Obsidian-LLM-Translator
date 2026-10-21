import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFArray, PDFDocument, PDFName } from "pdf-lib";
import { TFile, __setRequestUrl } from "obsidian";
import { PdfAnnotationWriter, pdfQuadPointsEqual } from "../src/pdfHighlight/PdfAnnotationWriter";
import { PdfHighlightService } from "../src/pdfHighlight/PdfHighlightService";
import { getHighlightColor } from "../src/pdfHighlight/colors";
import type { LocatedPdfHighlight, PdfHighlightQuad } from "../src/pdfHighlight/types";
import { normalizeSelectionTextForPdf } from "../src/pdfHighlight/normalize";
import { appendTranslationNote } from "../src/noteExport";
import PdfOllamaTranslatorPlugin from "../src/main";
import {
	cleanModelOutput,
	DEFAULT_TRANSLATION_PROMPT,
	migrateTranslationPrompt,
	normalizeCloudApiBaseUrl,
	TranslationCancelledError,
	TranslationTimeoutError,
	TranslatorService,
	truncateHttpErrorBody,
} from "../src/translatorService";
import type { PdfOllamaTranslatorSettings, TranslationRequest } from "../src/types";

Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });

const SETTINGS: PdfOllamaTranslatorSettings = {
	translationScope: "global",
	translationProvider: "local-llm",
	ollamaBaseUrl: "http://localhost:11434",
	model: "test-model",
	cloudApiBaseUrl: "https://api.example.com/v1",
	cloudApiKeySecretId: "test-api-key",
	cloudApiModel: "test-cloud-model",
	autoTranslateSelection: true,
	enablePopup: true,
	restrictSourceLanguages: false,
	sourceLanguage: "auto",
	targetLanguage: "zh-Hans",
	debounceMs: 0,
	requestTimeoutMs: 100,
	maxSelectionChars: 5000,
	fontSize: 13,
	lineHeight: 1.6,
	rememberPopupSize: true,
	popupWidth: 360,
	popupHeight: 220,
	showCopyButton: true,
	showRetryButton: true,
	defaultHighlightColor: "yellow",
	customPrompt: "Translate.",
	topK: 20,
	topP: 0.6,
	repeatPenalty: 1.05,
	numPredict: 4096,
	ollamaOptionsJson: "",
	cleanModelOutput: true,
	debugLogging: false,
};

const REQUEST: TranslationRequest = {
	text: "first",
	sourceLanguage: "en",
	targetLanguage: "zh-Hans",
	allowedSourceLanguages: ["en", "de", "fr", "ja", "zh-Hans"],
};

test("translation helpers validate URLs and clean bounded output", () => {
	assert.equal(normalizeCloudApiBaseUrl(" https://api.example.com/v1/// "), "https://api.example.com/v1");
	assert.equal(normalizeCloudApiBaseUrl("http://127.0.0.1:8000/v1"), "http://127.0.0.1:8000/v1");
	assert.throws(() => normalizeCloudApiBaseUrl("http://api.example.com/v1"), { name: "CloudApiBaseUrlError" });
	assert.throws(() => normalizeCloudApiBaseUrl("https://api.example.com/v1?token=secret"), { name: "CloudApiBaseUrlError" });
	assert.equal(truncateHttpErrorBody("abcdef", 4), "abc…");
	assert.equal(cleanModelOutput("<think>hidden</think>\nTranslation: \"Hello\""), "Hello");
	assert.equal(normalizeSelectionTextForPdf("A\u00a0  B\r\nC"), "A B C");
});

test("manual bar translation remains in the popup when the sidebar is visible", async () => {
	const plugin = Object.create(PdfOllamaTranslatorPlugin.prototype) as PdfOllamaTranslatorPlugin;
	const state = plugin as unknown as Record<string, unknown>;
	const selection = { text: "selected text", rect: { left: 12, top: 8 }, document: {} };
	const events: string[] = [];
	let finishTranslation!: (value: unknown) => void;
	state.settings = { ...SETTINGS, autoTranslateSelection: false };
	state.selectionReader = { readSelection: () => selection };
	state.popup = {
		showManualActions: () => events.push("manual"),
		showLoading: () => events.push("loading"),
		showResult: () => events.push("result"),
		hide: () => events.push("hidden"),
	};
	state.translator = { translate: () => new Promise((resolve) => { finishTranslation = resolve; }) };
	state.isSidebarVisible = () => true;
	state.updateSidebarState = () => undefined;
	state.debug = () => undefined;
	const call = (name: string, ...args: unknown[]) => (state[name] as (...args: unknown[]) => unknown).apply(plugin, args);

	call("scheduleSelectionTranslation", selection.document);
	const pending = call("retryLastSelection") as Promise<void>;
	assert.deepEqual(events, ["manual", "loading"]);
	call("scheduleSelectionTranslation", selection.document);
	assert.deepEqual(events, ["manual", "loading"]);
	finishTranslation({ sourceText: selection.text, translatedText: "result text" });
	await pending;
	call("scheduleSelectionTranslation", selection.document);
	assert.deepEqual(events, ["manual", "loading", "result"]);
});

test("disabling popup during a request keeps the completed result in the sidebar", async () => {
	const plugin = Object.create(PdfOllamaTranslatorPlugin.prototype) as PdfOllamaTranslatorPlugin;
	const state = plugin as unknown as Record<string, unknown>;
	const events: string[] = [];
	let finishTranslation!: (value: unknown) => void;
	state.settings = { ...SETTINGS, enablePopup: true };
	state.popup = {
		showLoading: () => events.push("loading"),
		showResult: () => events.push("result"),
		hide: () => events.push("hidden"),
	};
	state.translator = { translate: () => new Promise((resolve) => { finishTranslation = resolve; }) };
	state.isSidebarVisible = () => false;
	state.updateSidebarState = (value: { status: string }) => events.push(value.status);
	state.saveSettings = async () => undefined;
	state.syncPopupOptions = () => undefined;
	state.refreshSidebarViews = () => undefined;
	state.debug = () => undefined;
	const selection = { text: "selected text", rect: { left: 12, top: 8 }, document: {} };
	const pending = (state.translateSelection as (selection: unknown, force: boolean) => Promise<void>).call(plugin, selection, true);
	await plugin.updateSettings({ enablePopup: false });
	finishTranslation({ sourceText: selection.text, translatedText: "result text" });
	await pending;
	assert.deepEqual(events, ["loading", "loading", "hidden", "success"]);
});

test("provider lane cancels stale work and waits for the physical request", async () => {
	const transports: Array<{
		params: { body?: string };
		resolve: (response: { status: number; text: string; json: unknown }) => void;
	}> = [];
	__setRequestUrl((params: { body?: string }) => new Promise((resolve) => transports.push({ params, resolve })));

	const service = new TranslatorService(() => SETTINGS);
	const firstController = new AbortController();
	const first = service.translate({ ...REQUEST, signal: firstController.signal }).catch((error) => error);
	await nextTask();
	assert.equal(transports.length, 1);

	firstController.abort();
	assert.ok(await first instanceof TranslationCancelledError);
	const second = service.translate({ ...REQUEST, text: "second" }).catch((error) => error);
	const thirdPromise = service.translate({ ...REQUEST, text: "third" });
	assert.ok(await second instanceof TranslationCancelledError);
	assert.equal(transports.length, 1);

	transports[0].resolve(okOllamaResponse("obsolete"));
	await nextTask();
	assert.equal(transports.length, 2);
	assert.match(transports[1].params.body ?? "", /third/);
	transports[1].resolve(okOllamaResponse("latest"));
	assert.equal((await thirdPromise).translatedText, "latest");
});

test("timeout is reported immediately but the next request stays queued", async () => {
	const settings = { ...SETTINGS, requestTimeoutMs: 10 };
	const transports: Array<{
		resolve: (response: { status: number; text: string; json: unknown }) => void;
	}> = [];
	__setRequestUrl(() => new Promise((resolve) => transports.push({ resolve })));
	const service = new TranslatorService(() => settings);

	const timedOut = service.translate(REQUEST).catch((error) => error);
	assert.ok(await timedOut instanceof TranslationTimeoutError);
	const nextPromise = service.translate({ ...REQUEST, text: "next" });
	await nextTask();
	assert.equal(transports.length, 1);

	transports[0].resolve(okOllamaResponse("late"));
	await nextTask();
	assert.equal(transports.length, 2);
	transports[1].resolve(okOllamaResponse("next-result"));
	assert.equal((await nextPromise).translatedText, "next-result");
});

test("queued request times out without starting another transport", async () => {
	const settings = { ...SETTINGS, requestTimeoutMs: 10 };
	const transports: Array<{ resolve: (response: { status: number; text: string; json: unknown }) => void }> = [];
	__setRequestUrl(() => new Promise((resolve) => transports.push({ resolve })));
	const service = new TranslatorService(() => settings);

	assert.ok(await service.translate(REQUEST).catch((error) => error) instanceof TranslationTimeoutError);
	const queued = service.translate({ ...REQUEST, text: "queued" }).catch((error) => error);
	assert.ok(await queued instanceof TranslationTimeoutError);
	assert.equal(transports.length, 1);
	transports[0].resolve(okOllamaResponse("late"));
	await nextTask();
	assert.equal(transports.length, 1);
});

test("cloud requests resolve the key through SecretStorage", async () => {
	let authorization = "";
	__setRequestUrl((params: { headers?: Record<string, string> }) => {
		authorization = params.headers?.Authorization ?? "";
		return Promise.resolve({
			status: 200,
			text: "",
			json: { choices: [{ message: { content: "云端译文" } }] },
		});
	});
	const settings = { ...SETTINGS, translationProvider: "cloud-api" as const };
	const service = new TranslatorService(() => settings, (id) => id === "test-api-key" ? "secret-value" : null);
	assert.equal((await service.translate(REQUEST)).translatedText, "云端译文");
	assert.equal(authorization, "Bearer secret-value");
});

test("PDF writes are serialized and preserve concurrent highlights", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const first = location([quad(10, 10, 30, 20)]);
	const second = location([quad(40, 10, 60, 20)]);

	await Promise.all([
		writer.toggleHighlight(first, getHighlightColor("yellow")),
		writer.toggleHighlight(second, getHighlightColor("blue")),
	]);
	assert.equal(await vault.annotationCount(), 2);
	assert.equal(await writer.getHighlightColor(first), "yellow");
	assert.equal(await writer.getHighlightColor(second), "blue");
	assert.equal(await writer.getHighlightColor(location([...first.quads, ...second.quads])), null);
});

test("a smaller selection removes the full highlight without touching its neighbor", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const file = { path: "test.pdf" } as never;
	const selected = location([quad(15, 12, 25, 18)], file);
	const remaining = location([quad(10, 30, 30, 40)], file);
	const first = location([quad(10, 10, 30, 20), ...remaining.quads], file);
	const second = location([quad(40, 10, 60, 20)], file);
	await writer.applyHighlight(first, getHighlightColor("yellow"), "old note");
	await writer.applyHighlight(second, getHighlightColor("blue"), "second note");
	const restored = await writer.readHighlights(file);
	const firstGroup = restored.find((entry) => entry.location.quads.length === 2);
	const secondGroup = restored.find((entry) => entry.location.quads.length === 1);
	assert.ok(firstGroup);
	assert.ok(secondGroup);

	const service = Object.create(PdfHighlightService.prototype) as PdfHighlightService;
	const state = service as unknown as Record<string, any>;
	let located = selected;
	state.locator = { locate: async () => located, restoreOverlayRects: async () => undefined };
	state.writer = writer;
	state.overlay = { remove: () => undefined, renderPersisted: () => undefined };
	state.entries = new Map([
		[firstGroup.id, { key: firstGroup.id, location: firstGroup.location, color: getHighlightColor("yellow"), note: "edited note", persisted: false }],
		[secondGroup.id, { key: secondGroup.id, location: secondGroup.location, persisted: true }],
	]);
	state.pendingRemovals = new Map();
	state.noteConflicts = new Set();
	state.isFileOpen = () => true;
	const selection = { file: first.file, text: "first" } as never;

	assert.equal(await service.removeSelectionHighlight(selection), true);
	assert.equal(await vault.annotationCount(), 1);
	assert.equal(await writer.getHighlightColor(remaining), null);
	assert.equal(await writer.getHighlightColor(second), "blue");
	assert.equal(state.entries.size, 1);
	assert.ok(state.entries.has(secondGroup.id));
	located = location([quad(70, 10, 90, 20)], file);
	assert.equal(await service.removeSelectionHighlight(selection), false);
	assert.equal(await vault.annotationCount(), 1);
});

test("a larger selection removes every intersecting highlight", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const first = location([quad(10, 10, 30, 20)]);
	const second = location([quad(40, 10, 60, 20)]);
	const outside = location([quad(70, 10, 90, 20)]);
	await writer.applyHighlight(first, getHighlightColor("yellow"), "first");
	await writer.applyHighlight(second, getHighlightColor("blue"), "second");
	await writer.applyHighlight(outside, getHighlightColor("red"), "outside");
	const broad = location([quad(5, 5, 65, 25)]);

	assert.equal((await writer.removeHighlight(broad, "intersecting")).count, 2);
	assert.equal(await vault.annotationCount(), 1);
	assert.equal(await writer.getHighlightColor(outside), "red");
});

test("Turkish uses its language code in translation requests and PDF normalization", async () => {
	let requestUrl = "";
	__setRequestUrl((params: { url: string }) => {
		requestUrl = params.url;
		return Promise.resolve({ status: 200, text: "", json: [[['hello']]] });
	});
	const service = new TranslatorService(() => ({ ...SETTINGS, translationProvider: "google" }));
	const result = await service.translate({ ...REQUEST, text: "Merhaba", sourceLanguage: "tr", targetLanguage: "en" });
	assert.equal(result.translatedText, "hello");
	assert.equal(new URL(requestUrl).searchParams.get("sl"), "tr");
	assert.equal(normalizeSelectionTextForPdf("İ-\nş"), "İş");
});

test("partial multi-line highlights are repaired before toggling off", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const firstQuad = quad(10, 10, 30, 20);
	const secondQuad = quad(10, 30, 35, 40);
	const yellow = getHighlightColor("yellow");

	await writer.applyHighlight(location([firstQuad]), yellow, "note");
	const repaired = await writer.toggleHighlight(location([firstQuad, secondQuad]), yellow);
	assert.equal(repaired.action, "updated");
	assert.equal(repaired.note, "note");
	assert.equal(await vault.annotationCount(), 2);

	const removed = await writer.toggleHighlight(location([firstQuad, secondQuad]), yellow);
	assert.equal(removed.action, "removed");
	assert.equal(await vault.annotationCount(), 0);
});

test("persisted highlight geometry matches within the PDF annotation tolerance", () => {
	assert.equal(pdfQuadPointsEqual(
		[10, 20, 30, 20, 10, 10, 30, 10],
		[11.4, 20, 30, 20, 10, 10, 30, 10],
	), true);
	assert.equal(pdfQuadPointsEqual(
		[10, 20, 30, 20, 10, 10, 30, 10],
		[11.6, 20, 30, 20, 10, 10, 30, 10],
	), false);
});

test("persisted highlight notes can be restored and cleared", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const file = { path: "test.pdf" } as never;
	const selected = location([quad(20, 30, 60, 45)], file);
	const note = "中文批注 😀";

	await writer.applyHighlight(selected, getHighlightColor("purple"), note);
	const restored = await writer.readHighlights(file);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].note, note);
	assert.deepEqual(restored[0].color, getHighlightColor("purple").pdfRgb);
	assert.equal(restored[0].overlayRects[0].pageNumber, 1);
	assert.equal(restored[0].overlayRects[0].leftRatio, 0.2);
	assert.equal(restored[0].overlayRects[0].topRatio, 0.55);

	assert.equal(await writer.removeAllHighlights(file), 1);
	assert.equal(await vault.annotationCount(), 0);
});

test("blank plugin highlights remain restorable without a native Contents value", async () => {
	const vault = await MemoryVault.create();
	const writer = new PdfAnnotationWriter({ vault } as never);
	const file = { path: "test.pdf" } as never;
	await writer.applyHighlight(location([quad(15, 25, 55, 40)], file), getHighlightColor("yellow"), "");

	const restored = await writer.readHighlights(file);
	assert.equal(restored.length, 1);
	assert.equal(restored[0].note, "");
});

test("translation note creation asks once and later appends to the same source note", async () => {
	const { app, files } = noteApp();
	const source = new TFile("Papers/paper.pdf");
	const snapshot = { sourceText: "Hello", translatedText: "你好", file: source, pageHint: 2 };
	const target = "Papers/paper.pdf-Translation-Note.md";
	let confirmations = 0;
	assert.equal(await appendTranslationNote(app as never, snapshot, "", async (path) => {
		assert.equal(path, target);
		confirmations++;
		return true;
	}), target);
	assert.equal(await appendTranslationNote(app as never, { ...snapshot, sourceText: "World", translatedText: "世界" }, "", async () => {
		throw new Error("confirmation must not reopen");
	}), target);
	assert.equal(confirmations, 1);
	assert.equal(files.size, 1);
	const content = files.get(target) ?? "";
	assert.equal((content.match(/<table /g) ?? []).length, 2);
	assert.equal((content.match(/<tr>/g) ?? []).length, 6);
	assert.match(content, /border:2px solid #5aa9ff[\s\S]*?<td style="padding:8px">Hello<\/td>[\s\S]*?<td[^>]*>你好<\/td>/);
	assert.match(content, /<small>Source: <a class="internal-link" href="Papers\/paper\.pdf#page=2">paper\.pdf<\/a> · Page 2<\/small>/);
	assert.doesNotMatch(content, /\*\*Original\*\*|\*\*Translation\*\*|\n---\n/);
});

test("custom Markdown target collects translations from different source files", async () => {
	const target = "Notes/Translations.md";
	const { app, files } = noteApp({ [target]: "# My notes\n" }, new TFile("Papers/two.pdf"));
	for (const [name, file] of [["one.pdf", new TFile("Papers/one.pdf")], ["two.pdf", undefined]] as const) {
		await appendTranslationNote(app as never, {
			sourceText: name,
			translatedText: `译文 ${name}`,
			file,
		}, target, async () => { throw new Error("custom target must not create a file"); });
	}
	assert.equal(files.size, 1);
	assert.match(files.get(target) ?? "", /# My notes[\s\S]*?href="Papers\/one\.pdf"[\s\S]*?href="Papers\/two\.pdf"/);
});

test("translation note table escapes snapshots and uses a matched highlight color", async () => {
	const target = "Notes/Translations.md";
	const { app, files } = noteApp({ [target]: "" });
	await appendTranslationNote(app as never, {
		sourceText: "<script>alert('x')</script>\nA & B",
		translatedText: "<b>译文</b>",
		file: new TFile('Papers/a & "b".pdf'),
		highlightColor: "red",
	}, target, async () => true);
	const content = files.get(target) ?? "";
	assert.match(content, /border:2px solid #ff6b6b/);
	assert.match(content, /&#60;script&#62;alert\(&#39;x&#39;\)&#60;\/script&#62;<br>A &#38; B/);
	assert.match(content, /href="Papers\/a &#38; &#34;b&#34;\.pdf"/);
	assert.doesNotMatch(content, /<script>|<b>译文<\/b>/);
});

test("default note name collision leaves the unrelated file untouched", async () => {
	const target = "Papers/paper.pdf-Translation-Note.md";
	const { app, files } = noteApp({ [target]: "User notes\n" });
	await assert.rejects(appendTranslationNote(app as never, {
		sourceText: "Hello", translatedText: "你好", file: new TFile("Papers/paper.pdf"),
	}, "", async () => true), /different file/);
	assert.equal(files.get(target), "User notes\n");
});

test("annotation interaction and style regression guards stay enabled", async () => {
	const [overlay, service, main, styles] = await Promise.all([
		readProjectFile("src/pdfHighlight/HighlightOverlay.ts"),
		readProjectFile("src/pdfHighlight/PdfHighlightService.ts"),
		readProjectFile("src/main.ts"),
		readProjectFile("styles.css"),
	]);

	assert.match(service, /this\.renderPersistedHighlight\(highlight\)/);
	assert.match(overlay, /event\.stopImmediatePropagation\(\)/);
	assert.doesNotMatch(overlay, /style\.(?:background|pointerEvents|cursor)\s*=/);
	assert.doesNotMatch(overlay, /instanceof (Document|Node|Element)/);
	assert.match(main, /isHighlightNoteTarget\(doc\.activeElement\)/);
	assert.doesNotMatch(main, /target instanceof Element/);
	assert.doesNotMatch(styles, /\.commentPopup|\.annotationCommentButton/);
	assert.match(styles, /\.pdf-ollama-translator-highlight-note-editor[\s\S]*?resize: both/);
	assert.match(styles, /\.pdf-ollama-translator-highlight-overlay\s*{[^}]*background: transparent[^}]*pointer-events: none/);
	assert.doesNotMatch(styles, /!important|:has\(/);
});

test("sidebar bottom controls share one guarded left-aligned action column", async () => {
	const [sidebar, styles] = await Promise.all([
		readProjectFile("src/sidebarView.ts"),
		readProjectFile("styles.css"),
	]);

	assert.equal((sidebar.match(/pdf-ollama-translator-sidebar__control-row/g) ?? []).length, 3);
	assert.equal((sidebar.match(/pdf-ollama-translator-sidebar__control-actions/g) ?? []).length, 3);
	assert.match(styles, /\.pdf-ollama-translator-sidebar\s*{[^}]*min-width: 368px/);
	assert.match(sidebar, /pdf-ollama-translator-sidebar-leaf/);
	assert.match(sidebar, /pdf-ollama-translator-sidebar-split/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar-leaf,\s*\.pdf-ollama-translator-sidebar-split\s*{[^}]*min-width: 368px/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__control-row\s*{[^}]*grid-template-columns: 80px minmax\(0, 1fr\)/);
	assert.match(styles, /\.pdf-ollama-translator-sidebar__control-actions\s*{[^}]*justify-content: flex-start[^}]*gap: 8px/);
	assert.doesNotMatch(styles, /\.pdf-ollama-translator-sidebar__(?:highlight-palette|quick-actions|copy-actions)\s*{[^}]*gap:/);
	assert.doesNotMatch(styles, /\.pdf-ollama-translator-sidebar__quick-row\s*{[\s\S]*?justify-content: space-between/);
	assert.doesNotMatch(styles, /\.pdf-ollama-translator-sidebar__copy-row\s*{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
});

test("build metadata describes one release version", async () => {
	const [packageJson, manifest, packageLock, versions] = await Promise.all([
		readProjectJson("package.json"),
		readProjectJson("manifest.json"),
		readProjectJson("package-lock.json"),
		readProjectJson("versions.json"),
	]);
	assert.equal(packageJson.version, "0.5.2");
	assert.equal(manifest.version, packageJson.version);
	assert.equal(packageLock.version, packageJson.version);
	assert.equal(packageLock.packages[""].version, packageJson.version);
	assert.equal(versions[packageJson.version], manifest.minAppVersion);
});

test("stored prompt follows the default prompt after the Turkish update", async () => {
	const legacyPrompt = "Translate English, German, French, Japanese, or Simplified Chinese into the selected target language."
		+ " Preserve terminology, numbers, formulas, citations, and paragraph breaks. Output only the translation.";
	const main = await readProjectFile("src/main.ts");

	assert.match(DEFAULT_TRANSLATION_PROMPT, /English, German, French, Turkish, Japanese/);
	assert.equal(migrateTranslationPrompt(legacyPrompt), DEFAULT_TRANSLATION_PROMPT);
	assert.equal(migrateTranslationPrompt(`  ${legacyPrompt.replace(/ /g, "   ")}\n`), DEFAULT_TRANSLATION_PROMPT);
	assert.equal(migrateTranslationPrompt("Keep it short."), "Keep it short.");
	assert.equal(migrateTranslationPrompt("  "), "  ");
	assert.match(main, /const customPrompt = migrateTranslationPrompt\(storedPrompt\)/);
});

test("note target row centers its label against the controls", async () => {
	const [settings, styles] = await Promise.all([
		readProjectFile("src/settings.ts"),
		readProjectFile("styles.css"),
	]);

	assert.match(settings, /\.setName\(t\("settings\.noteTarget"\)\)\s*\.setClass\("pdf-ollama-translator-setting--centered"\)/);
	assert.match(styles, /\.pdf-ollama-translator-settings \.setting-item\.pdf-ollama-translator-setting--centered\s*{[^}]*align-items: center/);
});

class MemoryVault {
	private constructor(private bytes: ArrayBuffer) {}

	static async create(): Promise<MemoryVault> {
		const pdf = await PDFDocument.create();
		pdf.addPage([100, 100]);
		return new MemoryVault(toArrayBuffer(await pdf.save()));
	}

	async readBinary(): Promise<ArrayBuffer> {
		return this.bytes.slice(0);
	}

	async modifyBinary(_file: unknown, bytes: ArrayBuffer): Promise<void> {
		await nextTask();
		this.bytes = bytes.slice(0);
	}

	async annotationCount(): Promise<number> {
		const pdf = await PDFDocument.load(this.bytes);
		return pdf.getPage(0).node.lookupMaybe(PDFName.of("Annots"), PDFArray)?.size() ?? 0;
	}
}

function noteApp(initial: Record<string, string> = {}, activeFile: TFile | null = null): { app: object; files: Map<string, string> } {
	const files = new Map(Object.entries(initial));
	return {
		files,
		app: {
			workspace: { getActiveFile: () => activeFile },
			vault: {
				getAbstractFileByPath: (path: string) => files.has(path) ? new TFile(path) : null,
				create: async (path: string, content: string) => {
					if (files.has(path)) throw new Error("already exists");
					files.set(path, content);
					return new TFile(path);
				},
				process: async (file: TFile, change: (content: string) => string) => {
					const next = change(files.get(file.path) ?? "");
					files.set(file.path, next);
					return next;
				},
			},
		},
	};
}

function quad(left: number, bottom: number, right: number, top: number): PdfHighlightQuad {
	return {
		pageIndex: 0,
		rect: [left, bottom, right, top],
		quadPoints: [left, top, right, top, left, bottom, right, bottom],
	};
}

function location(quads: PdfHighlightQuad[], file = { path: "test.pdf" } as never): LocatedPdfHighlight {
	return {
		file,
		normalizedText: "test",
		quads,
	};
}

function okOllamaResponse(content: string): { status: number; text: string; json: unknown } {
	return { status: 200, text: "", json: { message: { content } } };
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const result = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(result).set(bytes);
	return result;
}

function readProjectFile(filePath: string): Promise<string> {
	return readFile(resolve(process.cwd(), filePath), "utf8");
}

async function readProjectJson(filePath: string): Promise<Record<string, any>> {
	return JSON.parse(await readProjectFile(filePath));
}
