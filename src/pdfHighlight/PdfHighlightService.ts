import { Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type { PdfTextSelection, HighlightColorId } from "../types";
import { t } from "../i18n";
import { getHighlightColor, getHighlightColorFromPdfRgb } from "./colors";
import { HighlightOverlay } from "./HighlightOverlay";
import { PdfAnnotationWriter, pdfQuadPointsEqual, pdfQuadPointsIntersect } from "./PdfAnnotationWriter";
import { PdfTextLocator } from "./PdfTextLocator";
import { normalizeSelectionTextForPdf } from "./normalize";
import type { HighlightColorConfig, LocatedPdfHighlight, PersistedPdfHighlight } from "./types";

interface HighlightEntry {
	key: string;
	location: LocatedPdfHighlight;
	color: HighlightColorConfig;
	selection?: PdfTextSelection;
	note: string;
	persisted: boolean;
}

export class PdfHighlightService {
	private locator: PdfTextLocator;
	private writer: PdfAnnotationWriter;
	private overlay: HighlightOverlay;
	private entries = new Map<string, HighlightEntry>();
	private pendingRemovals = new Map<string, HighlightEntry>();
	private hydratedFiles = new Set<string>();
	private hydratingFiles = new Set<string>();
	private fileRevisions = new Map<string, number>();
	private noteConflicts = new Set<string>();
	private lastPdfFile: TFile | null = null;
	private lastEntryKey = "";

	constructor(
		private app: App,
		private debug: (message: string, detail?: unknown) => void,
		onNoteEditorOpen: () => void = () => undefined,
	) {
		this.locator = new PdfTextLocator(app, debug);
		this.writer = new PdfAnnotationWriter(app);
		this.overlay = new HighlightOverlay(app, onNoteEditorOpen);
		this.overlay.activate();
		window.setTimeout(() => this.refreshOverlays(), 0);
		this.app.workspace.onLayoutReady(() => {
			this.refreshOverlays();
			window.setTimeout(() => this.refreshOverlays(), 500);
		});
	}

	async toggleSelectionHighlight(selection: PdfTextSelection, colorId: HighlightColorId): Promise<void> {
		if (!selection.file || !selection.file.path.toLowerCase().endsWith(".pdf")) {
			new Notice(t("notice.highlightPdfOnly"));
			return;
		}
		if (this.noteConflicts.has(selection.file.path)) {
			new Notice(t("notice.pdfNoteConflict"));
			return;
		}

		const color = getHighlightColor(colorId);
		const location = await this.locator.locate(
			selection.file,
			selection.text,
			selection.pageHint,
			selection.overlayRects,
		);
		if (!location || location.quads.length === 0) {
			new Notice(t("notice.highlightNotFound"));
			return;
		}

		const key = getLocationKey(location);
		const existingEntries = [...this.entries.values()]
			.filter((entry) => locationsOverlap(entry.location, location));
		const existingNote = existingEntries.find((entry) => entry.note.trim())?.note
			?? existingEntries[0]?.note;
		const outcome = await this.writer.toggleHighlight(location, color, existingNote);
		for (const existing of existingEntries) {
			this.removeEntry(existing, false);
			this.pendingRemovals.delete(existing.key);
		}
		if (outcome.action === "removed") {
			this.pendingRemovals.delete(key);
			return;
		}

		const entry: HighlightEntry = {
			key,
			location,
			color,
			selection,
			note: outcome.note,
			persisted: true,
		};
		this.entries.set(key, entry);
		this.pendingRemovals.delete(key);
		this.lastEntryKey = key;
		this.overlay.render(key, selection, color, entry.note, (note, flush) => this.updateNote(key, note, flush));
	}

	async removeSelectionHighlight(selection: PdfTextSelection): Promise<boolean | null> {
		if (!selection.file?.path.toLowerCase().endsWith(".pdf")) {
			new Notice(t("notice.highlightPdfOnly"));
			return null;
		}
		if (this.noteConflicts.has(selection.file.path)) {
			new Notice(t("notice.pdfNoteConflictWriteBlocked"));
			return null;
		}
		const location = await this.locator.locate(
			selection.file, selection.text, selection.pageHint, selection.overlayRects,
		);
		if (!location) return false;
		const selectedEntries = [...this.entries.values()].filter((entry) =>
			locationsOverlap(entry.location, location, pdfQuadPointsIntersect));
		const removalLocation = {
			...location,
			quads: [...location.quads, ...selectedEntries.flatMap((entry) => entry.location.quads)],
		};
		const removedEntries = [...this.entries.values()].filter((entry) =>
			locationsOverlap(entry.location, removalLocation, pdfQuadPointsIntersect));
		for (const entry of removedEntries) {
			if (!entry.persisted) await this.persist(entry);
		}
		const result = await this.writer.removeHighlight(removalLocation, "intersecting");
		if (result.count === 0) return false;
		for (const entry of removedEntries) this.removeEntry(entry, false);
		if (removedEntries.length > 0) {
			const survivors = (await this.writer.readHighlights(selection.file))
				.filter((highlight) => removedEntries.some((entry) => locationsOverlap(entry.location, highlight.location)));
			await this.locator.restoreOverlayRects(selection.file, survivors);
			for (const highlight of survivors) {
				if (!this.entries.has(highlight.id)) this.renderPersistedHighlight(highlight);
			}
		}
		return true;
	}

	async getSelectionHighlightColor(selection: PdfTextSelection): Promise<HighlightColorId | null> {
		if (!selection.file?.path.toLowerCase().endsWith(".pdf")) return null;
		const location = await this.locator.locate(
			selection.file, selection.text, selection.pageHint, selection.overlayRects,
		);
		return location ? this.writer.getHighlightColor(location) : null;
	}

	canUndoSelection(selection: PdfTextSelection | null): boolean {
		const entry = this.entries.get(this.lastEntryKey);
		if (!entry?.selection?.file || !selection?.file) {
			return false;
		}
		return (
			entry.selection.file.path === selection.file.path &&
			normalizeSelectionTextForPdf(entry.selection.text) === normalizeSelectionTextForPdf(selection.text)
		);
	}

	undoLastHighlight(): boolean {
		const entry = this.entries.get(this.lastEntryKey);
		if (!entry) {
			return false;
		}
		if (this.noteConflicts.has(entry.location.file.path)) {
			new Notice(t("notice.pdfNoteConflictWriteBlocked"));
			return false;
		}
		this.removeEntry(entry, true);
		return true;
	}

	flushPendingForInactiveViews(): void {
		for (const entry of this.entries.values()) {
			if (!entry.persisted && !this.isFileOpen(entry.location.file.path)) {
				void this.persist(entry).catch((error) => this.reportPersistenceFailure("update", error));
			}
		}

		for (const [key, entry] of this.pendingRemovals) {
			if (!this.isFileOpen(entry.location.file.path)) {
				void this.removePersisted(key, entry).catch((error) => this.reportPersistenceFailure("removal", error));
			}
		}
	}

	async flushAllPending(): Promise<void> {
		const pending: Promise<void>[] = [];
		for (const entry of this.entries.values()) {
			if (!entry.persisted) {
				pending.push(this.persist(entry).catch((error) => this.reportPersistenceFailure("update", error)));
			}
		}

		for (const [key, entry] of this.pendingRemovals) {
			pending.push(this.removePersisted(key, entry).catch((error) => this.reportPersistenceFailure("removal", error)));
		}
		await Promise.all(pending);
	}

	refreshOverlays(): void {
		this.overlay.refresh();
		const activePdfFile = this.getPdfFileFromActiveLeaf();
		if (activePdfFile) {
			this.lastPdfFile = activePdfFile;
		}
		const openPdfFiles = this.getOpenPdfFiles();
		if (!this.lastPdfFile && openPdfFiles.length === 1) {
			this.lastPdfFile = openPdfFiles[0];
		}
		for (const file of openPdfFiles) {
			if (!this.hydratedFiles.has(file.path) && !this.hydratingFiles.has(file.path)) {
				void this.hydrateFile(file);
			}
		}
	}

	async handleVaultModify(file: TFile): Promise<void> {
		if (!file.path.toLowerCase().endsWith(".pdf") || await this.writer.isOwnWrite(file)) return;
		this.fileRevisions.set(file.path, (this.fileRevisions.get(file.path) ?? 0) + 1);
		const hasLocalChanges = [...this.entries.values()].some((entry) => entry.location.file.path === file.path && !entry.persisted)
			|| [...this.pendingRemovals.values()].some((entry) => entry.location.file.path === file.path);
		if (hasLocalChanges) {
			this.noteConflicts.add(file.path);
			new Notice(t("notice.pdfNoteConflict"));
		}
		for (const entry of [...this.entries.values()]) {
			if (entry.location.file.path === file.path && entry.persisted) {
				this.overlay.remove(entry.key);
				this.entries.delete(entry.key);
			}
		}
		this.hydratedFiles.delete(file.path);
		if (this.isFileOpen(file.path) && !this.hydratingFiles.has(file.path)) void this.hydrateFile(file);
	}

	hasPdfForClear(): boolean {
		return this.getPdfForClear() !== null;
	}

	async clearAllHighlightsForActivePdf(): Promise<number | null> {
		const file = this.getPdfForClear();
		if (!file) {
			return null;
		}
		if (this.noteConflicts.has(file.path)) {
			new Notice(t("notice.pdfNoteConflictWriteBlocked"));
			return 0;
		}

		const removed = await this.writer.removeAllHighlights(file);
		for (const entry of [...this.entries.values()]) {
			if (entry.location.file.path === file.path) this.removeEntry(entry, false);
		}
		for (const [key, entry] of this.pendingRemovals) {
			if (entry.location.file.path === file.path) this.pendingRemovals.delete(key);
		}
		this.noteConflicts.delete(file.path);
		this.hydratedFiles.add(file.path);
		if (removed > 0) {
			await this.reloadPdfViews(file);
		}
		return removed;
	}

	destroy(): void {
		this.overlay.destroy();
		this.locator.destroy();
	}

	private removeEntry(entry: HighlightEntry, persistRemoval: boolean): void {
		this.overlay.remove(entry.key);
		this.entries.delete(entry.key);
		if (this.lastEntryKey === entry.key) {
			this.lastEntryKey = "";
		}

		if (entry.persisted && persistRemoval) {
			this.pendingRemovals.set(entry.key, entry);
			void this.removePersisted(entry.key, entry)
				.catch((error) => this.reportPersistenceFailure("removal", error));
		}
	}

	private async persist(entry: HighlightEntry): Promise<void> {
		if (this.noteConflicts.has(entry.location.file.path)) {
			new Notice(t("notice.pdfNoteConflictWriteBlocked"));
			return;
		}
		const note = entry.note;
		await this.writer.applyHighlight(entry.location, entry.color, note);
		const current = this.entries.get(entry.key);
		if (current && current.note === note) {
			current.persisted = true;
			if (!this.isFileOpen(current.location.file.path)) {
				this.overlay.remove(current.key);
				this.entries.delete(current.key);
			}
		}
	}

	private async removePersisted(key: string, entry: HighlightEntry): Promise<void> {
		if (this.noteConflicts.has(entry.location.file.path)) {
			new Notice(t("notice.pdfNoteConflictWriteBlocked"));
			return;
		}
		await this.writer.removeHighlight(entry.location);
		this.pendingRemovals.delete(key);
	}

	private updateNote(key: string, note: string, flush = false): void {
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		if (entry.note === note && entry.persisted) {
			return;
		}
		entry.note = note;
		entry.persisted = false;
		this.overlay.updateNote(key, note);
		if (flush) {
			void this.persist(entry).catch((error) => this.reportPersistenceFailure("update", error));
		}
	}

	private reportPersistenceFailure(action: "update" | "removal", error: unknown): void {
		this.debug(`PDF highlight ${action} failed.`, error);
		new Notice(t("notice.highlightFailed"));
	}

	private isFileOpen(path: string): boolean {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
		if (leaves.length === 0) {
			leaves.push(...this.app.workspace.getLeavesOfType("pdf"));
		}

		return leaves.some((leaf) => (leaf.view as { file?: TFile | null }).file?.path === path);
	}

	private async hydrateFile(file: TFile): Promise<void> {
		this.hydratingFiles.add(file.path);
		const revision = this.fileRevisions.get(file.path) ?? 0;
		try {
			const highlights = await this.writer.readHighlights(file);
			await this.locator.restoreOverlayRects(file, highlights);
			if (revision !== (this.fileRevisions.get(file.path) ?? 0)) return;
			for (const highlight of highlights) {
				if (!this.entries.has(highlight.id)) this.renderPersistedHighlight(highlight);
			}
			this.hydratedFiles.add(file.path);
		} catch (error) {
			this.debug("Could not restore PDF highlight notes.", error);
		} finally {
			this.hydratingFiles.delete(file.path);
			if (revision !== (this.fileRevisions.get(file.path) ?? 0) && this.isFileOpen(file.path)) {
				void this.hydrateFile(file);
			}
		}
	}

	private renderPersistedHighlight(highlight: PersistedPdfHighlight): void {
		const color = getHighlightColorFromPdfRgb(highlight.color);
		const entry: HighlightEntry = {
			key: highlight.id,
			location: highlight.location,
			color,
			note: highlight.note,
			persisted: true,
		};
		this.entries.set(entry.key, entry);
		this.overlay.renderPersisted(
			entry.key,
			entry.location.file.path,
			highlight.overlayRects,
			color,
			entry.note,
			(note, flush) => this.updateNote(entry.key, note, flush),
		);
	}

	private getPdfFileFromActiveLeaf(): TFile | null {
		const view = this.app.workspace.activeLeaf?.view as { file?: TFile | null; getViewType?: () => string } | undefined;
		const file = view?.file;
		return file && (view?.getViewType?.() === "pdf" || file.path.toLowerCase().endsWith(".pdf")) ? file : null;
	}

	private getPdfForClear(): TFile | null {
		const activePdfFile = this.getPdfFileFromActiveLeaf();
		if (activePdfFile) {
			this.lastPdfFile = activePdfFile;
			return activePdfFile;
		}

		const openPdfFiles = this.getOpenPdfFiles();
		if (this.lastPdfFile && openPdfFiles.some((file) => file.path === this.lastPdfFile?.path)) {
			return this.lastPdfFile;
		}
		if (openPdfFiles.length === 1) {
			this.lastPdfFile = openPdfFiles[0];
			return this.lastPdfFile;
		}
		return null;
	}

	private getOpenPdfFiles(): TFile[] {
		const files = new Map<string, TFile>();
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
		leaves.push(...this.app.workspace.getLeavesOfType("pdf"));
		for (const leaf of leaves) {
			const view = leaf.view as { file?: TFile | null; getViewType?: () => string };
			const file = view.file;
			if (file && (view.getViewType?.() === "pdf" || file.path.toLowerCase().endsWith(".pdf"))) {
				files.set(file.path, file);
			}
		}
		const activeFile = this.getPdfFileFromActiveLeaf();
		if (activeFile) {
			files.set(activeFile.path, activeFile);
		}
		return [...files.values()];
	}

	private async reloadPdfViews(file: TFile): Promise<void> {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as { file?: TFile | null; getViewType?: () => string };
			if (view.file?.path === file.path && (view.getViewType?.() === "pdf" || file.path.toLowerCase().endsWith(".pdf"))) {
				leaves.push(leaf);
			}
		});

		for (const leaf of leaves) {
			const wasActive = leaf === this.app.workspace.activeLeaf;
			await leaf.setViewState({ type: "empty", active: false });
			await leaf.openFile(file, { active: wasActive });
		}
	}
}

function getLocationKey(location: LocatedPdfHighlight): string {
	const quads = location.quads
		.map((quad) => `${quad.pageIndex}:${quad.quadPoints.map((value) => Math.round(value * 10)).join(",")}`)
		.join("|");
	return `${location.file.path}:${quads}`;
}

function locationsOverlap(
	left: LocatedPdfHighlight,
	right: LocatedPdfHighlight,
	matches: (left: readonly number[], right: readonly number[]) => boolean = pdfQuadPointsEqual,
): boolean {
	return left.file.path === right.file.path && left.quads.some((leftQuad) => (
		right.quads.some((rightQuad) => (
			leftQuad.pageIndex === rightQuad.pageIndex
			&& matches(leftQuad.quadPoints, rightQuad.quadPoints)
		))
	));
}
