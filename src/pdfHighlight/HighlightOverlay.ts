import { setIcon, type App } from "obsidian";
import type { PdfSelectionOverlayRect, PdfTextSelection } from "../types";
import { t } from "../i18n";
import type { HighlightColorConfig } from "./types";

const HOST_CLASS = "pdf-ollama-translator-highlight-host";
const LAYER_CLASS = "pdf-ollama-translator-highlight-layer";
const OVERLAY_CLASS = "pdf-ollama-translator-highlight-overlay";
const NOTE_ICON_CLASS = "pdf-ollama-translator-highlight-note-icon";
const EDITOR_CLASS = "pdf-ollama-translator-highlight-note-editor";
const NATIVE_POPUP_WRAPPER_SELECTOR = ".popupWrapper";
const NATIVE_POPUP_CONTENT_SELECTOR = ".popupContent";
const PAGE_SELECTOR = "[data-page-number], .page, .pdf-page";
const PDF_VIEWER_SELECTOR = [
	".pdf-container",
	".pdf-viewer",
	".pdfViewer",
	".pdf-embed",
	".mod-pdf",
	".document-container",
	".workspace-leaf-content[data-type='pdf']",
].join(", ");

interface PdfViewLike {
	containerEl?: HTMLElement;
	file?: { path?: string } | null;
	getViewType?: () => string;
}

interface LeafLike {
	view?: PdfViewLike;
}

interface OverlayGroup {
	filePath?: string;
	rects: OverlayRect[];
	elements: HTMLElement[];
	icon?: HTMLElement;
	note: string;
	color: HighlightColorConfig;
	onNoteChange: (note: string, flush?: boolean) => void;
}

type OverlayRect = Pick<
	PdfSelectionOverlayRect,
	"pageNumber" | "leftRatio" | "topRatio" | "widthRatio" | "heightRatio"
> & { pageEl?: HTMLElement };

export class HighlightOverlay {
	private groups = new Map<string, OverlayGroup>();
	private layers = new Map<HTMLElement, HTMLElement>();
	private hostObservers = new Map<HTMLElement, MutationObserver>();
	private popupObservers = new Map<Document, MutationObserver>();
	private nativePopupSuppressionUntil = new WeakMap<Document, number>();
	private renderFrame: number | undefined;
	private editorEl: HTMLElement | undefined;
	private textareaEl: HTMLTextAreaElement | undefined;
	private activeId = "";
	private activeAnchor: HTMLElement | undefined;
	private listenersRegistered = false;
	private interactionDocuments = new Set<Document>();
	private lastBlankHighlightClick: { id: string; at: number } | undefined;

	constructor(
		private app: App,
		private onEditorOpen: () => void = () => undefined,
	) {}

	activate(): void {
		this.registerGlobalListeners();
	}

	render(
		id: string,
		selection: PdfTextSelection,
		color: HighlightColorConfig,
		note: string,
		onNoteChange: (note: string, flush?: boolean) => void,
	): void {
		this.remove(id);
		if (!selection.overlayRects?.length) {
			return;
		}

		this.registerGlobalListeners();
		const group: OverlayGroup = {
			filePath: selection.file?.path,
			rects: selection.overlayRects,
			elements: [],
			note,
			color,
			onNoteChange,
		};
		this.groups.set(id, group);
		this.renderGroup(id, group);
		this.updateNote(id, note);
	}

	renderPersisted(
		id: string,
		filePath: string,
		rects: OverlayRect[],
		color: HighlightColorConfig,
		note: string,
		onNoteChange: (note: string, flush?: boolean) => void,
	): void {
		this.remove(id);
		if (!rects.length) {
			return;
		}

		this.registerGlobalListeners();
		const group: OverlayGroup = {
			filePath,
			rects,
			elements: [],
			note,
			color,
			onNoteChange,
		};
		this.groups.set(id, group);
		this.renderGroup(id, group);
	}

	updateNote(id: string, note: string): void {
		const group = this.groups.get(id);
		if (!group) {
			return;
		}

		group.note = note;
		for (const overlay of group.elements) {
			this.setOverlayInteractivity(overlay, note);
		}
		if (this.activeId === id && this.textareaEl && this.textareaEl.value !== note) {
			this.textareaEl.value = note;
		}

		if (note.trim()) {
			this.ensureIcon(id, group);
		} else {
			group.icon?.remove();
			group.icon = undefined;
		}
	}

	remove(id: string): void {
		const group = this.groups.get(id);
		if (!group) {
			return;
		}
		this.clearRenderedElements(group);
		this.groups.delete(id);
		if (this.activeId === id) {
			this.closeEditor();
		}
		this.pruneEmptyLayers();
	}

	refresh(): void {
		this.scheduleRerender();
	}

	destroy(): void {
		if (this.renderFrame !== undefined) {
			cancelAnimationFrame(this.renderFrame);
			this.renderFrame = undefined;
		}
		for (const observer of this.hostObservers.values()) {
			observer.disconnect();
		}
		this.hostObservers.clear();
		for (const observer of this.popupObservers.values()) {
			observer.disconnect();
		}
		this.popupObservers.clear();
		for (const group of this.groups.values()) {
			this.clearRenderedElements(group);
		}
		this.groups.clear();
		for (const layer of this.layers.values()) {
			layer.remove();
		}
		this.layers.clear();
		this.editorEl?.remove();
		this.editorEl = undefined;
		this.textareaEl = undefined;
		for (const doc of this.interactionDocuments) {
			doc.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
			doc.removeEventListener("pointerup", this.handleDocumentPointerUp, true);
			doc.removeEventListener("scroll", this.handleViewportChange, true);
		}
		window.removeEventListener("resize", this.handleViewportChange);
		this.interactionDocuments.clear();
		this.listenersRegistered = false;
	}

	private renderGroup(id: string, group: OverlayGroup): void {
		this.clearRenderedElements(group);
		const host = this.resolveHost(group);
		if (!host) {
			return;
		}

		this.observeHost(host);
		const layer = this.ensureLayer(host);
		const hostRect = host.getBoundingClientRect();
		const elements: HTMLElement[] = [];

		for (const rect of group.rects) {
			const pageEl = this.resolvePageElement(rect, host);
			if (!pageEl) {
				continue;
			}

			const pageRect = pageEl.getBoundingClientRect();
			if (pageRect.width <= 0 || pageRect.height <= 0) {
				continue;
			}

			const left = pageRect.left - hostRect.left + rect.leftRatio * pageRect.width;
			const top = pageRect.top - hostRect.top + rect.topRatio * pageRect.height;
			const width = rect.widthRatio * pageRect.width;
			const height = rect.heightRatio * pageRect.height;

			const overlay = layer.ownerDocument.createElement("div");
			overlay.className = OVERLAY_CLASS;
			overlay.style.left = `${left}px`;
			overlay.style.top = `${top}px`;
			overlay.style.width = `${width}px`;
			overlay.style.height = `${height}px`;
			overlay.dataset.highlightId = id;
			this.setOverlayInteractivity(overlay, group.note);
			layer.appendChild(overlay);
			elements.push(overlay);
		}

		group.elements = elements;
		if (group.note.trim()) {
			this.ensureIcon(id, group);
		}

		if (this.activeId === id) {
			const anchor = group.icon ?? group.elements[0];
			if (!anchor) {
				return;
			}
			this.activeAnchor = anchor;
			this.repositionEditor();
		}
	}

	private clearRenderedElements(group: OverlayGroup): void {
		for (const element of group.elements) {
			element.remove();
		}
		group.icon?.remove();
		group.elements = [];
		group.icon = undefined;
	}

	private resolveHost(group: OverlayGroup): HTMLElement | null {
		const host = this.findOpenPdfHost(group.filePath);
		if (host) {
			return host;
		}

		for (const rect of group.rects) {
			if (!rect.pageEl?.isConnected) {
				continue;
			}
			const fallbackHost = rect.pageEl.closest<HTMLElement>(".workspace-leaf-content") ?? this.hostFromViewer(rect.pageEl);
			if (fallbackHost) {
				return fallbackHost;
			}
		}

		return null;
	}

	private findOpenPdfHost(filePath?: string): HTMLElement | null {
		const leaves: LeafLike[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
		if (leaves.length === 0) {
			leaves.push(...this.app.workspace.getLeavesOfType("pdf") as LeafLike[]);
		}

		for (const leaf of leaves) {
			const view = leaf.view;
			if (!view?.containerEl || !this.isPdfView(view)) {
				continue;
			}
			if (filePath && view.file?.path !== filePath) {
				continue;
			}
			const host = this.hostFromViewer(view.containerEl);
			if (host) {
				return host;
			}
		}

		const activeView = this.app.workspace.activeLeaf?.view as PdfViewLike | undefined;
		if (activeView?.containerEl && (!filePath || activeView.file?.path === filePath)) {
			return this.hostFromViewer(activeView.containerEl);
		}

		return null;
	}

	private isPdfView(view: PdfViewLike): boolean {
		const viewType = view.getViewType?.();
		const filePath = view.file?.path?.toLowerCase() ?? "";
		return viewType === "pdf" || filePath.endsWith(".pdf") || Boolean(view.containerEl?.querySelector(PDF_VIEWER_SELECTOR));
	}

	private hostFromViewer(container: HTMLElement): HTMLElement | null {
		const viewer = container.matches(PDF_VIEWER_SELECTOR)
			? container
			: container.querySelector<HTMLElement>(PDF_VIEWER_SELECTOR);
		return viewer?.closest<HTMLElement>(".workspace-leaf-content") ?? viewer ?? null;
	}

	private resolvePageElement(rect: OverlayRect, host: HTMLElement): HTMLElement | null {
		const pages = Array.from(host.querySelectorAll<HTMLElement>(PAGE_SELECTOR));
		if (rect.pageNumber) {
			const page = pages.find((pageEl) => getPageNumber(pageEl) === rect.pageNumber);
			if (page) {
				return page;
			}
		}

		return rect.pageEl?.isConnected && host.contains(rect.pageEl) ? rect.pageEl : null;
	}

	private ensureLayer(host: HTMLElement): HTMLElement {
		host.classList.add(HOST_CLASS);

		const existing = this.layers.get(host);
		if (existing?.isConnected) {
			return existing;
		}

		const layer = Array.from(host.children)
			.find((child): child is HTMLElement => child.instanceOf(HTMLElement) && child.classList.contains(LAYER_CLASS));
		if (layer) {
			this.layers.set(host, layer);
			return layer;
		}

		const next = host.ownerDocument.createElement("div");
		next.className = LAYER_CLASS;
		host.appendChild(next);
		this.layers.set(host, next);
		return next;
	}

	private observeHost(host: HTMLElement): void {
		const doc = host.ownerDocument;
		this.registerDocumentListeners(doc);
		if (this.hostObservers.has(host)) {
			return;
		}

		const MutationObserverCtor = doc.defaultView?.MutationObserver ?? MutationObserver;
		const observer = new MutationObserverCtor((mutations) => {
			if (!mutations.some((mutation) => this.shouldRerenderForMutation(mutation))) {
				return;
			}
			this.scheduleRerender();
		});
		observer.observe(host, {
			attributes: true,
			attributeFilter: ["class", "style", "data-page-number"],
			childList: true,
			subtree: true,
		});
		this.hostObservers.set(host, observer);
	}

	private shouldRerenderForMutation(mutation: MutationRecord): boolean {
		const target = mutation.target;
		const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
		if (changedNodes.length > 0 && changedNodes.every((node) => isManagedNode(node))) {
			return false;
		}

		if (target.instanceOf(Element) && isManagedElement(target)) {
			return false;
		}

		if (
			target.instanceOf(Element) &&
			(target.closest(PAGE_SELECTOR) || target.closest(PDF_VIEWER_SELECTOR))
		) {
			return true;
		}

		return changedNodes.some((node) => (
			node.instanceOf(Element) &&
			(
					node.matches(PAGE_SELECTOR) ||
					node.matches(PDF_VIEWER_SELECTOR) ||
					Boolean(node.querySelector(`${PAGE_SELECTOR}, ${PDF_VIEWER_SELECTOR}`))
			)
		));
	}

	private scheduleRerender(): void {
		if (this.renderFrame !== undefined) {
			return;
		}
		this.renderFrame = window.requestAnimationFrame(() => {
			this.renderFrame = undefined;
			this.rerenderAll();
		});
	}

	private rerenderAll(): void {
		for (const [id, group] of this.groups) {
			this.renderGroup(id, group);
		}
		this.pruneEmptyLayers();
	}

	private pruneEmptyLayers(): void {
		for (const [host, layer] of this.layers) {
			if (!host.isConnected || layer.childElementCount === 0) {
				layer.remove();
				this.layers.delete(host);
				host.classList.remove(HOST_CLASS);
				this.hostObservers.get(host)?.disconnect();
				this.hostObservers.delete(host);
			}
		}
		for (const [host, observer] of this.hostObservers) {
			if (!host.isConnected) {
				observer.disconnect();
				this.hostObservers.delete(host);
			}
		}
	}

	private ensureIcon(id: string, group: OverlayGroup): void {
		if (group.icon || group.elements.length === 0) {
			return;
		}

		const anchor = group.elements[0];
		const layer = anchor.parentElement;
		if (!layer) {
			return;
		}

		const layerRect = layer.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		const iconEl = anchor.ownerDocument.createElement("button");
		iconEl.className = NOTE_ICON_CLASS;
		iconEl.type = "button";
		iconEl.style.left = `${anchorRect.right - layerRect.left - 4}px`;
		iconEl.style.top = `${anchorRect.top - layerRect.top - 12}px`;
		iconEl.style.setProperty("--pdf-ollama-translator-highlight-color", group.color.css);
		iconEl.setAttribute("aria-label", "Highlight note");
		setIcon(iconEl, "message-square");
		iconEl.onpointerdown = (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.openEditor(id, iconEl);
		};
		iconEl.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		layer.appendChild(iconEl);
		group.icon = iconEl;
	}

	private openEditor(id: string, anchorEl: HTMLElement): void {
		const group = this.groups.get(id);
		if (!group) {
			return;
		}

		if (this.activeId && this.activeId !== id) {
			this.commitActiveEditor();
		}
		this.onEditorOpen();
		this.activeId = id;
		this.activeAnchor = anchorEl;
		this.ensureEditor(anchorEl.ownerDocument);
		if (!this.editorEl || !this.textareaEl) {
			return;
		}

		this.textareaEl.value = group.note;
		this.editorEl.style.setProperty("--pdf-ollama-translator-note-color", group.color.css);
		this.editorEl.show();
		this.repositionEditor();
		this.textareaEl.focus();
	}

	private closeEditor(): void {
		this.commitActiveEditor();
		this.activeId = "";
		this.activeAnchor = undefined;
		this.editorEl?.hide();
	}

	private setOverlayInteractivity(overlay: HTMLElement, note: string): void {
		const hasNote = Boolean(note.trim());
		overlay.toggleClass("pdf-ollama-translator-highlight-overlay--has-note", hasNote);
	}

	private repositionEditor(): void {
		if (!this.editorEl || !this.activeAnchor || this.editorEl.style.display === "none") {
			return;
		}

		if (!this.activeAnchor.ownerDocument.body.contains(this.activeAnchor)) {
			// PDF.js temporarily replaces page and annotation layers while the file is
			// reloaded. Keep the editor open until renderGroup rebinds its anchor.
			this.scheduleRerender();
			return;
		}

		const anchorRect = this.activeAnchor.getBoundingClientRect();
		const editorRect = this.editorEl.getBoundingClientRect();
		const margin = 12;
		const rightSideLeft = anchorRect.right + 8;
		const leftSideLeft = anchorRect.left - editorRect.width - 8;
		const ownerWindow = this.editorEl.ownerDocument.defaultView ?? window;
		const preferredLeft = rightSideLeft + editorRect.width + margin <= ownerWindow.innerWidth
			? rightSideLeft
			: leftSideLeft;
		const left = clamp(preferredLeft, margin, ownerWindow.innerWidth - editorRect.width - margin);
		const top = clamp(anchorRect.top, margin, ownerWindow.innerHeight - editorRect.height - margin);
		this.editorEl.style.left = `${left}px`;
		this.editorEl.style.top = `${top}px`;
	}

	private ensureEditor(doc: Document): void {
		if (this.editorEl?.ownerDocument === doc && this.textareaEl) {
			return;
		}
		this.editorEl?.remove();
		this.editorEl = undefined;
		this.textareaEl = undefined;

		this.editorEl = doc.body.createDiv({ cls: EDITOR_CLASS });
		this.editorEl.hide();
		this.textareaEl = this.editorEl.createEl("textarea", {
			cls: "pdf-ollama-translator-highlight-note-editor__textarea",
			attr: { placeholder: "Add note" },
		});
		const footerEl = this.editorEl.createDiv({ cls: "pdf-ollama-translator-highlight-note-editor__footer" });
		const copyButton = footerEl.createEl("button", {
			cls: "pdf-ollama-translator-highlight-note-editor__copy",
			attr: { "aria-label": t("highlight.copyNote"), title: t("highlight.copyNote") },
		});
		copyButton.onpointerdown = (event) => event.preventDefault();
		setIcon(copyButton, "copy");
		copyButton.onClickEvent(async () => {
			await navigator.clipboard.writeText(this.textareaEl?.value ?? "");
		});

		this.textareaEl.oninput = () => {
			const group = this.groups.get(this.activeId);
			if (!group || !this.textareaEl) {
				return;
			}
			group.onNoteChange(this.textareaEl.value);
		};
		this.textareaEl.onkeydown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeEditor();
			}
		};
		this.registerGlobalListeners();
	}

	private commitActiveEditor(): void {
		const group = this.groups.get(this.activeId);
		if (group && this.textareaEl) {
			group.onNoteChange(this.textareaEl.value, true);
		}
	}

	private registerGlobalListeners(): void {
		if (this.listenersRegistered) {
			return;
		}
		this.listenersRegistered = true;
		this.registerDocumentListeners(activeDocument);
		window.addEventListener("resize", this.handleViewportChange);
	}

	private registerDocumentListeners(doc: Document): void {
		if (this.interactionDocuments.has(doc)) {
			return;
		}
		this.interactionDocuments.add(doc);
		doc.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
		doc.addEventListener("pointerup", this.handleDocumentPointerUp, true);
		doc.addEventListener("scroll", this.handleViewportChange, true);
		this.observeNativePopups(doc);
	}

	private handleViewportChange = (): void => {
		this.scheduleRerender();
		this.repositionEditor();
	};

	private handleDocumentPointerDown = (event: PointerEvent): void => {
		const targetNode = eventTargetNode(event.target);
		if (
			targetNode &&
			(
				this.editorEl?.contains(targetNode) ||
				this.activeAnchor?.contains(targetNode) ||
				eventTargetElement(event.target)?.closest(`.${NOTE_ICON_CLASS}`)
			)
		) {
			return;
		}

		const doc = eventDocument(event);
		if (event.button === 0 && doc) {
			const hit = this.findGroupAt(event.clientX, event.clientY, doc);
			if (hit) {
				this.suppressEmptyNativePopup(doc);
				event.preventDefault();
				event.stopImmediatePropagation();
				if (hit.group.note.trim() || this.isSecondBlankHighlightClick(hit.id)) {
					this.openEditor(hit.id, hit.group.icon ?? hit.element);
				}
				return;
			}
		}

		if (!this.editorEl || this.editorEl.style.display === "none") {
			return;
		}

		if (
			targetNode &&
			(this.editorEl.contains(targetNode) || this.activeAnchor?.contains(targetNode))
		) {
			return;
		}

		this.closeEditor();
	};

	private handleDocumentPointerUp = (event: PointerEvent): void => {
		if (event.button !== 0) {
			return;
		}
		const doc = eventDocument(event);
		if (!doc) {
			return;
		}
		const hit = this.findGroupAt(event.clientX, event.clientY, doc);
		if (!hit) {
			return;
		}

		this.suppressEmptyNativePopup(doc);
		event.preventDefault();
		event.stopImmediatePropagation();
	};

	private observeNativePopups(doc: Document): void {
		if (this.popupObservers.has(doc) || !doc.body) {
			return;
		}
		const MutationObserverCtor = doc.defaultView?.MutationObserver ?? MutationObserver;
		const observer = new MutationObserverCtor((mutations) => {
			if ((this.nativePopupSuppressionUntil.get(doc) ?? 0) < Date.now()) {
				return;
			}
			for (const mutation of mutations) {
				for (const node of Array.from(mutation.addedNodes)) {
					this.removeEmptyNativePopups(node);
				}
			}
		});
		observer.observe(doc.body, { childList: true, subtree: true });
		this.popupObservers.set(doc, observer);
	}

	private suppressEmptyNativePopup(doc: Document): void {
		this.nativePopupSuppressionUntil.set(doc, Date.now() + 1000);
		this.removeEmptyNativePopups(doc);
		doc.defaultView?.queueMicrotask(() => this.removeEmptyNativePopups(doc));
	}

	private removeEmptyNativePopups(root: Node | Document): void {
		const wrappers = new Set<Element>();
		const element = nodeElement(root);
		const closestWrapper = element?.closest(NATIVE_POPUP_WRAPPER_SELECTOR);
		if (closestWrapper) {
			wrappers.add(closestWrapper);
		}
		if ("querySelectorAll" in root) {
			for (const wrapper of Array.from(root.querySelectorAll(NATIVE_POPUP_WRAPPER_SELECTOR))) {
				wrappers.add(wrapper);
			}
		}
		for (const wrapper of wrappers) {
			const content = wrapper.querySelector(NATIVE_POPUP_CONTENT_SELECTOR);
			if (content && !content.textContent?.trim()) {
				wrapper.remove();
			}
		}
	}

	private findGroupAt(x: number, y: number, doc?: Document): { id: string; group: OverlayGroup; element: HTMLElement } | null {
		for (const [id, group] of [...this.groups.entries()].reverse()) {
			const element = group.elements.find((candidate) =>
				(!doc || candidate.ownerDocument === doc) && containsPoint(candidate.getBoundingClientRect(), x, y),
			);
			if (element) {
				return { id, group, element };
			}
		}
		return null;
	}

	private isSecondBlankHighlightClick(id: string): boolean {
		const now = Date.now();
		const isSecondClick = this.lastBlankHighlightClick?.id === id
			&& now - this.lastBlankHighlightClick.at <= 500;
		this.lastBlankHighlightClick = isSecondClick ? undefined : { id, at: now };
		return isSecondClick;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

function containsPoint(rect: DOMRect, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function eventDocument(event: Event): Document | undefined {
	const currentTarget = event.currentTarget;
	return currentTarget && typeof currentTarget === "object" && "nodeType" in currentTarget
		&& currentTarget.nodeType === 9
		? currentTarget as Document
		: undefined;
}

function eventTargetNode(target: EventTarget | null): Node | null {
	return target && typeof target === "object" && "nodeType" in target
		? target as Node
		: null;
}

function eventTargetElement(target: EventTarget | null): Element | null {
	const node = eventTargetNode(target);
	return nodeElement(node);
}

function nodeElement(node: Node | Document | null): Element | null {
	if (!node) {
		return null;
	}
	if (node.nodeType === 1) {
		return node as Element;
	}
	return "parentElement" in node ? node.parentElement : null;
}

function isManagedNode(node: Node): boolean {
	return node.instanceOf(Element) && isManagedElement(node);
}

function isManagedElement(element: Element): boolean {
	return (
		element.classList.contains(OVERLAY_CLASS) ||
		element.classList.contains(NOTE_ICON_CLASS) ||
		element.classList.contains(LAYER_CLASS)
	);
}

function getPageNumber(pageEl: HTMLElement): number | undefined {
	const candidates = [
		pageEl.dataset.pageNumber,
		pageEl.getAttribute("data-page-number"),
		pageEl.getAttribute("aria-label"),
	].filter((value): value is string => Boolean(value));

	for (const candidate of candidates) {
		const match = candidate.match(/\d+/);
		if (!match) {
			continue;
		}
		const page = Number.parseInt(match[0], 10);
		if (Number.isFinite(page) && page > 0) {
			return page;
		}
	}

	return undefined;
}
