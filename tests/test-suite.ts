import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PDFArray, PDFDocument, PDFName } from "pdf-lib";
import { __setRequestUrl } from "obsidian";
import { PdfAnnotationWriter, pdfQuadPointsEqual } from "../src/pdfHighlight/PdfAnnotationWriter";
import { getHighlightColor } from "../src/pdfHighlight/colors";
import type { LocatedPdfHighlight, PdfHighlightQuad } from "../src/pdfHighlight/types";
import { normalizeSelectionTextForPdf } from "../src/pdfHighlight/normalize";
import {
	cleanModelOutput,
	normalizeCloudApiBaseUrl,
	TranslationCancelledError,
	TranslationTimeoutError,
	TranslatorService,
	truncateHttpErrorBody,
} from "../src/translatorService";
import { TranslationCache, buildCacheKey, normalizeCacheText } from "../src/translationCache";
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
	enableContextMenu: true,
	enableTranslationCache: true,
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
	assert.match(main, /isHighlightNoteTarget\(activeDocument\.activeElement\)/);
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

test("pdf context menu stays non-destructive and PDF++ compatible", async () => {
	const [contextMenu, main] = await Promise.all([
		readProjectFile("src/pdfContextMenu.ts"),
		readProjectFile("src/main.ts"),
	]);

	const section = (from: string, to: string): string => {
		const start = contextMenu.indexOf(from);
		const end = contextMenu.indexOf(to);
		assert.ok(start >= 0 && end > start, `could not slice ${from}..${to}`);
		return contextMenu.slice(start, end);
	};

	// Assertions about forbidden calls must ignore prose, or a comment explaining
	// why we avoid an API would fail the very check that guards it.
	const stripComments = (source: string): string =>
		source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const contextMenuCode = stripComments(contextMenu);

	// The old implementation intercepted contextmenu on the parent document in
	// the capture phase and stopped propagation, which erased every other
	// plugin's menu items.
	assert.doesNotMatch(main, /registerDomEvent\(\s*activeDocument\s*,\s*"contextmenu"/);
	assert.doesNotMatch(main, /handleContextMenu/);
	assert.doesNotMatch(contextMenuCode, /stopPropagation|stopImmediatePropagation/);
	assert.doesNotMatch(contextMenuCode, /activeDocument/);

	// Markdown keeps using the official event; PDF goes through `pdf-menu`.
	assert.match(main, /this\.app\.workspace\.on\("editor-menu"/);
	assert.match(contextMenu, /PDF_MENU_EVENT = "pdf-menu"/);
	assert.match(contextMenu, /PDF_PLUS_ID = "pdf-plus"/);

	// PDF++ detection must consult both the enabled set and the live instance;
	// a stubbed-out check would silently make us fight PDF++ for the menu.
	const detection = section("isPdfPlusEnabled(): boolean", "private scheduleRescan");
	assert.match(detection, /enabledPlugins\?\.has\(PDF_PLUS_ID\)/);
	assert.match(detection, /plugins\?\.\[PDF_PLUS_ID\]/);

	// When PDF++ owns the menu we must not install a competing interceptor.
	const rescan = section("private rescanPdfTargets", "private collectPdfTargets");
	assert.match(rescan, /this\.isPdfPlusEnabled\(\)/);
	assert.match(rescan, /this\.detachAll\(\)/);

	// Obsidian's built-in PDF handler calls stopPropagation(), so a bubble-phase
	// listener would never fire and the fallback menu would never appear. Both
	// registration and removal must pass the capture flag.
	assert.match(contextMenu, /addEventListener\("contextmenu", handler, true\)/);
	assert.match(contextMenu, /removeEventListener\("contextmenu", entry\.handler, true\)/);

	// The fallback must cover PDF views that are not inside an iframe, otherwise
	// builds that render PDF.js straight into the leaf get no menu at all.
	const collect = section("private collectPdfTargets", "private isPdfLeaf");
	assert.match(collect, /querySelectorAll\("iframe"\)/);
	assert.match(collect, /targets\.push\(container\)/);

	// Deciding a leaf is a PDF must not rely on generic classes: matching `.page`
	// in a Markdown view would attach the interceptor there and suppress its
	// native menu — the exact bug this file exists to prevent.
	assert.doesNotMatch(section("const PDF_VIEWER_MARKERS", "const PDF_PAGE_MARKERS"), /\.page|\.textLayer/);
	assert.match(section("private isPdfLeaf", "private readFrameDocument"), /viewType === "pdf"/);

	// The fallback interceptor must only broadcast: it adds no items itself (so
	// our own broadcast cannot duplicate them), backs off when another handler
	// already claimed the right-click, and re-checks PDF++ because enabling a
	// plugin emits no layout event.
	const interceptor = section("private handlePdfContextMenu", "private broadcastPdfMenu");
	assert.doesNotMatch(interceptor, /menu\.addItem\(/);
	assert.match(interceptor, /evt\.defaultPrevented/);
	assert.match(interceptor, /this\.isPdfPlusEnabled\(\)/);
	assert.match(interceptor, /this\.broadcastPdfMenu\(menu/);
	// Suppress the built-in menu with preventDefault only, and only once we
	// actually have items to show.
	assert.match(interceptor, /if \(!added\)[\s\S]*?evt\.preventDefault\(\)/);
	// This plugin's own highlight UI sits inside the page layer; right-clicking it
	// must keep the native menu so copy/paste still works in the note editor.
	assert.match(interceptor, /HIGHLIGHT_UI_MARKERS/);
	assert.match(contextMenu, /HIGHLIGHT_UI_MARKERS =[\s\S]*?highlight-note-editor/);

	// Captured geometry describing different text must not be reused, or a later
	// highlight would land on the wrong words.
	const capturedCode = stripComments(
		main.slice(main.indexOf("async translateCapturedSelection"), main.indexOf("private getViewportCenterRect")),
	);
	assert.ok(capturedCode.length > 0, "could not slice translateCapturedSelection");
	assert.doesNotMatch(capturedCode, /\.\.\.\(captured/);
	assert.doesNotMatch(capturedCode, /overlayRects|pageHint/);

	// Items come solely from the `pdf-menu` listener, registered exactly once.
	assert.equal((contextMenu.match(/menu\.addItem\(/g) ?? []).length, 2);
	assert.match(section("onPdfMenu(menu: Menu", "private scheduleRescan"), /menu\.addItem\(/);
	assert.equal((contextMenu.match(/workspace\.on\(\s*PDF_MENU_EVENT/g) ?? []).length, 1);
	assert.match(contextMenu, /private menuEventRef: EventRef \| null/);

	// A third-party listener that throws must not cost us the menu, and item
	// counting must not depend on Menu's private `items` field.
	const broadcast = section("private broadcastPdfMenu", "private pruneDetachedTargets");
	assert.match(broadcast, /catch \(error\)/);
	assert.doesNotMatch(contextMenu, /\bmenu\.items\b|\{ items\?/);

	// Realm hazard: the PDF iframe is a separate JS realm.
	assert.doesNotMatch(contextMenu, /instanceof (?:Document|Node|Element)/);
});

test("build metadata describes one release version", async () => {
	const [packageJson, manifest, packageLock, versions] = await Promise.all([
		readProjectJson("package.json"),
		readProjectJson("manifest.json"),
		readProjectJson("package-lock.json"),
		readProjectJson("versions.json"),
	]);
	assert.equal(packageJson.version, "0.4.0");
	assert.equal(manifest.version, packageJson.version);
	assert.equal(packageLock.version, packageJson.version);
	assert.equal(packageLock.packages[""].version, packageJson.version);
	assert.equal(versions[packageJson.version], manifest.minAppVersion);
});

test("translation cache keys contain only language pair and source text", () => {
	assert.equal(buildCacheKey("en", "zh-Hans", "hello"), "en||zh-Hans||hello");
	assert.equal(buildCacheKey("en", "zh-Hans", "hello"), buildCacheKey("en", "zh-Hans", "hello"));
	assert.notEqual(buildCacheKey("en", "zh-Hans", "hello"), buildCacheKey("en", "zh-Hans", "hello "));
	assert.notEqual(buildCacheKey("en", "zh-Hans", "hello"), buildCacheKey("en", "de", "hello"));
});

test("cache text normalization strips only edge whitespace and punctuation", () => {
	// Edge whitespace and punctuation are removed; the middle is untouched.
	assert.equal(normalizeCacheText("  Hello, world.  "), "Hello, world");
	assert.equal(normalizeCacheText("…hello…"), "hello");
	assert.equal(normalizeCacheText("　你好，世界。　"), "你好，世界");
	assert.equal(normalizeCacheText("Hello, world"), "Hello, world");
	assert.equal(normalizeCacheText(""), "");
	assert.equal(normalizeCacheText(",,,"), "");

	// The same sentence with different edge punctuation/whitespace shares one key.
	assert.equal(
		buildCacheKey("en", "zh-Hans", normalizeCacheText(" Hello, ")),
		buildCacheKey("en", "zh-Hans", normalizeCacheText("Hello.")),
	);
});

test("translation cache misses before load, hits after set, and persists to disk", async () => {
	const adapter = new MemoryCacheAdapter();
	const cache = new TranslationCache(adapter, "cache.json");

	// Not loaded yet: safe miss, never throws.
	assert.equal(cache.get("en||zh-Hans||hello"), null);

	await cache.load();
	assert.equal(cache.get("en||zh-Hans||hello"), null);

	cache.set("en||zh-Hans||hello", { translatedText: "你好", model: "test-model", timestamp: 1, version: 1 });
	assert.equal(cache.get("en||zh-Hans||hello")?.translatedText, "你好");

	await cache.flush();
	const parsed = JSON.parse(adapter.files.get("cache.json")!) as Record<string, { translatedText: string; model: string }>;
	assert.equal(parsed["en||zh-Hans||hello"].translatedText, "你好");
	assert.equal(parsed["en||zh-Hans||hello"].model, "test-model");
});

test("translation cache tolerates corrupted files and serializes concurrent writes", async () => {
	// Corrupted file: load must not throw, cache starts empty.
	const badAdapter = new MemoryCacheAdapter();
	badAdapter.files.set("cache.json", "not-json{{{");
	const badCache = new TranslationCache(badAdapter, "cache.json");
	await badCache.load();
	assert.equal(badCache.get("en||zh-Hans||hello"), null);

	// Concurrent writes: all entries present, last write wins per key.
	const adapter = new MemoryCacheAdapter();
	const cache = new TranslationCache(adapter, "cache.json");
	await cache.load();
	cache.set("en||zh-Hans||a", { translatedText: "A", model: "m", timestamp: 1, version: 1 });
	cache.set("en||zh-Hans||b", { translatedText: "B", model: "m", timestamp: 1, version: 1 });
	cache.set("en||zh-Hans||a", { translatedText: "A2", model: "m", timestamp: 1, version: 1 });
	await cache.flush();
	const parsed = JSON.parse(adapter.files.get("cache.json")!) as Record<string, { translatedText: string }>;
	assert.equal(parsed["en||zh-Hans||a"].translatedText, "A2");
	assert.equal(parsed["en||zh-Hans||b"].translatedText, "B");
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

class MemoryCacheAdapter {
	files = new Map<string, string>();

	async read(path: string): Promise<string | null> {
		return this.files.get(path) ?? null;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}
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
