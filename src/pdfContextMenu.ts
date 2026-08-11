import { Menu, Notice, type App, type EventRef } from "obsidian";
import { t } from "./i18n";
import type { PdfMenuPayload, PdfOllamaTranslatorSettings, PdfTextSelection } from "./types";

/** PDF++'s plugin id, as declared in its manifest. */
const PDF_PLUS_ID = "pdf-plus";

/**
 * The `pdf-menu` workspace event is not part of Obsidian's public API: PDF++
 * introduced it as an extension point so other plugins can contribute items to
 * the PDF context menu. We reuse the exact same name in both directions.
 */
const PDF_MENU_EVENT = "pdf-menu";

/**
 * Identifies a PDF.js viewer. Kept deliberately specific: `.page` and
 * `.textLayer` alone are generic enough that another plugin's view could match,
 * and attaching our interceptor to a non-PDF leaf would suppress its native menu.
 */
const PDF_VIEWER_MARKERS = "#viewerContainer, .pdfViewer";

/**
 * Confirms a right-click landed on page content rather than the toolbar or
 * sidebar. Only consulted once the surrounding view is known to be a PDF, so
 * the looser page-level classes are safe here.
 */
const PDF_PAGE_MARKERS = "#viewerContainer, .pdfViewer, .textLayer, .page";

/**
 * This plugin's own highlight UI, which is rendered into the page layer. Mirrors
 * `isHighlightNoteTarget` in main.ts.
 */
const HIGHLIGHT_UI_MARKERS =
	".pdf-ollama-translator-highlight-overlay, .pdf-ollama-translator-highlight-note-icon, .pdf-ollama-translator-highlight-note-editor";

/** Coalesce the layout churn Obsidian emits while a leaf is opening. */
const RESCAN_DEBOUNCE_MS = 150;

/** PDF.js builds its viewer DOM asynchronously; poll briefly while it does. */
const ATTACH_RETRY_MS = 150;
const MAX_ATTACH_ATTEMPTS = 20;

export interface PdfContextMenuServiceOptions {
	app: App;
	getSettings: () => PdfOllamaTranslatorSettings;
	/** Reads the live selection, or null when nothing usable is selected. */
	getSelection: () => PdfTextSelection | null;
	/**
	 * Translates the text captured when the menu was built. `selection` is the
	 * snapshot taken at that moment, or null if it could not be read.
	 */
	onTranslate: (text: string, selection: PdfTextSelection | null) => void;
	debug?: (message: string, detail?: unknown) => void;
}

/**
 * Where a fallback listener can live. Newer Obsidian hosts PDF.js in a
 * same-origin iframe (so we hook that iframe's document); older builds render it
 * straight into the leaf (so we hook the leaf's own container element). Never
 * the parent document — that is what broke every other plugin's menu.
 */
type PdfMenuTarget = Document | HTMLElement;

interface AttachedTarget {
	target: PdfMenuTarget;
	handler: (evt: MouseEvent) => void;
}

/**
 * Adds our entries to the PDF context menu without ever taking the menu away
 * from anybody else.
 *
 * Exactly one plugin can own the PDF context menu, so we pick an owner instead
 * of racing for it:
 *
 * - **PDF++ enabled** — PDF++ owns the menu and broadcasts `pdf-menu`. We only
 *   listen and append items. We attach no DOM listeners at all.
 * - **PDF++ not enabled** — nobody offers an extension point (Obsidian has no
 *   official PDF menu event), so we take over the way PDF++ does: build the menu
 *   ourselves and broadcast `pdf-menu` so other plugins can append to ours.
 *
 * Two invariants keep this non-destructive:
 *
 * 1. Listeners are scoped to the PDF view (an iframe document or a leaf's
 *    container), never the parent document where other plugins listen.
 * 2. We never call `stopPropagation()`. To suppress the built-in menu we rely on
 *    `preventDefault()`, which Obsidian's own PDF handler explicitly honours
 *    (`if (!evt.defaultPrevented)`), and we only prevent once we actually have a
 *    menu to show.
 *
 * The invariant that keeps items from doubling up: {@link onPdfMenu} is the only
 * place that adds items. The fallback interceptor creates an empty menu and
 * broadcasts — it never adds items itself.
 */
export class PdfContextMenuService {
	private readonly attachedTargets: AttachedTarget[] = [];
	private readonly pendingFrames = new Map<HTMLIFrameElement, number>();
	private menuEventRef: EventRef | null = null;
	private rescanTimer: number | undefined;
	private workspaceRefs: EventRef[] = [];

	constructor(private readonly options: PdfContextMenuServiceOptions) {}

	onload(): void {
		const workspace = this.options.app.workspace;
		this.menuEventRef = workspace.on(
			PDF_MENU_EVENT as never,
			((menu: Menu, payload?: PdfMenuPayload) => this.onPdfMenu(menu, payload)) as never,
		);
		this.workspaceRefs = [
			workspace.on("layout-change", () => this.scheduleRescan()),
			workspace.on("active-leaf-change", () => this.scheduleRescan()),
			// Pop-out windows host their own PDF views.
			workspace.on("window-open", () => this.scheduleRescan()),
		];
		this.scheduleRescan();
	}

	destroy(): void {
		window.clearTimeout(this.rescanTimer);
		for (const timer of this.pendingFrames.values()) {
			window.clearTimeout(timer);
		}
		this.pendingFrames.clear();
		const workspace = this.options.app.workspace;
		if (this.menuEventRef) {
			workspace.offref(this.menuEventRef);
			this.menuEventRef = null;
		}
		for (const ref of this.workspaceRefs) {
			workspace.offref(ref);
		}
		this.workspaceRefs = [];
		this.detachAll();
	}

	/**
	 * True when PDF++ is enabled. We deliberately do not read PDF++'s
	 * `replaceContextMenu` setting: reaching into another plugin's settings is
	 * brittle, so we always assume an enabled PDF++ owns the menu. The cost is
	 * that a user who turns that setting off loses our PDF menu items; the
	 * benefit is that we can never fight PDF++ for the menu.
	 *
	 * A plugin that is installed but disabled appears in neither collection, so
	 * it correctly leaves us on the fallback path.
	 */
	isPdfPlusEnabled(): boolean {
		const plugins = this.options.app.plugins;
		if (plugins?.enabledPlugins?.has(PDF_PLUS_ID)) {
			return true;
		}
		return Boolean(plugins?.plugins?.[PDF_PLUS_ID]);
	}

	/**
	 * The single place where our menu items are added, no matter who broadcast
	 * the event — PDF++, ourselves, or a third plugin.
	 */
	onPdfMenu(menu: Menu, payload?: PdfMenuPayload): void {
		if (!this.options.getSettings().enableContextMenu) {
			return;
		}

		// Snapshot the selection now, while the menu is being built. By the time
		// the user clicks an item the menu has taken focus and the selection may
		// be gone, so resolving it lazily would translate stale text.
		const snapshot = this.options.getSelection();
		const text = (payload?.selection ?? snapshot?.text ?? "").trim();
		if (!text) {
			return;
		}

		menu.addItem((item) => {
			item
				.setTitle(t("contextMenu.translate"))
				.setIcon("languages")
				.onClick(() => this.options.onTranslate(text, snapshot));
		});
		menu.addItem((item) => {
			item
				.setTitle(t("contextMenu.copy"))
				.setIcon("copy")
				.onClick(async () => {
					await navigator.clipboard.writeText(text);
					new Notice(t("notice.copied"));
				});
		});
	}

	private scheduleRescan(): void {
		window.clearTimeout(this.rescanTimer);
		this.rescanTimer = window.setTimeout(() => this.rescanPdfTargets(), RESCAN_DEBOUNCE_MS);
	}

	private rescanPdfTargets(): void {
		this.pruneDetachedTargets();

		// PDF++ owns the menu; we must not install a competing interceptor.
		if (this.isPdfPlusEnabled()) {
			this.detachAll();
			return;
		}

		for (const target of this.collectPdfTargets()) {
			this.attachToTarget(target);
		}
	}

	/**
	 * Finds every place a PDF right-click can originate, scoped to PDF leaves so
	 * we never touch unrelated views or the parent document.
	 */
	private collectPdfTargets(): PdfMenuTarget[] {
		const targets: PdfMenuTarget[] = [];

		this.options.app.workspace.iterateAllLeaves((leaf) => {
			const container = leaf.view?.containerEl;
			if (!container || !this.isPdfLeaf(leaf.view?.getViewType(), container)) {
				return;
			}

			// Events inside an iframe never reach the parent DOM, so each viewer
			// iframe needs its own listener.
			for (const frame of Array.from(container.querySelectorAll("iframe"))) {
				const doc = this.readFrameDocument(frame);
				if (doc) {
					targets.push(doc);
				}
			}

			// Builds that render PDF.js directly into the leaf are covered by the
			// container itself; the handler verifies the click landed on a page.
			targets.push(container);
		});

		return targets;
	}

	private isPdfLeaf(viewType: string | undefined, container: HTMLElement): boolean {
		return viewType === "pdf" || Boolean(container.querySelector(PDF_VIEWER_MARKERS));
	}

	/**
	 * Returns a viewer iframe's document, or null when it is not (yet) a PDF
	 * viewer. Schedules a retry while PDF.js is still building its DOM.
	 */
	private readFrameDocument(frame: HTMLIFrameElement, attempt = 0): Document | null {
		let doc: Document | null = null;
		try {
			// Cross-origin frames throw here; those are never Obsidian PDF views.
			doc = frame.contentDocument;
		} catch (error) {
			this.options.debug?.("Could not access iframe document.", error);
			return null;
		}

		// Poll rather than waiting on `load`, which may already have fired.
		if (!doc || doc.readyState === "loading" || !doc.querySelector(PDF_VIEWER_MARKERS)) {
			this.retryFrame(frame, attempt);
			return null;
		}

		return doc;
	}

	private retryFrame(frame: HTMLIFrameElement, attempt: number): void {
		if (attempt >= MAX_ATTACH_ATTEMPTS || this.pendingFrames.has(frame)) {
			return;
		}

		const timer = window.setTimeout(() => {
			this.pendingFrames.delete(frame);
			if (!frame.isConnected || this.isPdfPlusEnabled()) {
				return;
			}
			const doc = this.readFrameDocument(frame, attempt + 1);
			if (doc) {
				this.attachToTarget(doc);
			}
		}, ATTACH_RETRY_MS);
		this.pendingFrames.set(frame, timer);
	}

	/**
	 * Registers on the capture phase deliberately. Obsidian's built-in PDF
	 * handler calls `stopPropagation()` and `stopImmediatePropagation()` (PDF++
	 * copies this from app.js), so a bubble-phase listener would never see the
	 * event at all.
	 */
	private attachToTarget(target: PdfMenuTarget): void {
		if (this.attachedTargets.some((entry) => entry.target === target)) {
			return;
		}

		const handler = (evt: MouseEvent): void => this.handlePdfContextMenu(evt);
		target.addEventListener("contextmenu", handler, true);
		this.attachedTargets.push({ target, handler });
		this.options.debug?.("Attached PDF context menu fallback.", {
			kind: isDocument(target) ? "iframe-document" : "leaf-container",
		});
	}

	/**
	 * Fallback interceptor, used only when PDF++ is absent.
	 *
	 * Never stops propagation: suppressing the built-in menu is done purely with
	 * `preventDefault()`, which Obsidian's own PDF handler honours. Every other
	 * listener still runs, so nobody loses their menu items.
	 */
	private handlePdfContextMenu(evt: MouseEvent): void {
		if (!this.options.getSettings().enableContextMenu) {
			return;
		}
		// PDF++ may have been enabled after we attached; enabling a plugin emits
		// no layout event, so re-check here rather than trusting the listener set.
		if (this.isPdfPlusEnabled()) {
			return;
		}
		// Someone else already handled this right-click; leave their menu alone.
		if (evt.defaultPrevented) {
			return;
		}
		// Ignore clicks on the toolbar and other chrome around the pages.
		if (!closestMatches(evt.target, PDF_PAGE_MARKERS)) {
			return;
		}
		// Our own highlight affordances live inside the page layer; right-clicking
		// them should keep the native menu (copy/paste in the note editor).
		if (closestMatches(evt.target, HIGHLIGHT_UI_MARKERS)) {
			return;
		}

		const text = this.options.getSelection()?.text.trim();
		if (!text) {
			// No selection: let the native/built-in menu appear untouched.
			return;
		}

		const menu = new Menu();
		// Broadcast only. Items come from listeners (including our own), which
		// keeps this menu extensible and prevents duplicated entries.
		const added = this.broadcastPdfMenu(menu, { selection: text });
		if (!added) {
			return;
		}

		evt.preventDefault();
		menu.showAtMouseEvent(evt);
	}

	/**
	 * Broadcasts `pdf-menu` and reports how many items listeners added.
	 *
	 * Counts by wrapping `addItem` rather than reading `Menu`'s private `items`
	 * field, so an internal rename cannot silently make every menu look empty.
	 * A listener that throws must not cost us the menu, so failures are logged
	 * and swallowed.
	 */
	private broadcastPdfMenu(menu: Menu, payload: PdfMenuPayload): number {
		type AddItem = Menu["addItem"];
		const target = menu as Menu & { addItem: AddItem };
		const original = target.addItem.bind(menu) as AddItem;
		let added = 0;

		target.addItem = ((cb: Parameters<AddItem>[0]) => {
			added += 1;
			return original(cb);
		}) as AddItem;

		try {
			this.options.app.workspace.trigger(PDF_MENU_EVENT, menu, payload);
		} catch (error) {
			this.options.debug?.("A pdf-menu listener threw.", error);
		} finally {
			delete (target as Partial<Record<"addItem", AddItem>>).addItem;
		}

		return added;
	}

	private pruneDetachedTargets(): void {
		for (let index = this.attachedTargets.length - 1; index >= 0; index -= 1) {
			const { target } = this.attachedTargets[index];
			// A document loses its window when its iframe unloads; an element
			// loses connectivity when its leaf closes.
			const alive = isDocument(target) ? Boolean(target.defaultView) : target.isConnected;
			if (!alive) {
				this.attachedTargets.splice(index, 1);
			}
		}
	}

	private detachAll(): void {
		for (const entry of this.attachedTargets) {
			entry.target.removeEventListener("contextmenu", entry.handler, true);
		}
		this.attachedTargets.length = 0;
	}
}

/** Duck-typed: the PDF iframe is a separate realm, so `instanceof` is unusable. */
function isDocument(target: PdfMenuTarget): target is Document {
	return (target as Document).nodeType === 9;
}

/** Realm-safe `closest`, for the same reason. */
function closestMatches(target: EventTarget | null, selector: string): boolean {
	const node = target as { closest?: (s: string) => unknown } | null;
	return typeof node?.closest === "function" ? Boolean(node.closest(selector)) : false;
}
