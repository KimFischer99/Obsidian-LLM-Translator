/**
 * Translation result cache.
 *
 * Stores exact-match translation results in an in-memory Map, persisted to a
 * JSON file (cache.json) via an injected adapter so the module stays free of
 * obsidian runtime imports and remains unit-testable.
 */

export interface TranslationCacheEntry {
	translatedText: string;
	/** Source model/provider that produced the result; informational only, never part of the key. */
	model: string;
	timestamp: number;
	version: 1;
}

export interface TranslationCacheAdapter {
	read(path: string): Promise<string | null>;
	write(path: string, data: string): Promise<void>;
}

export function buildCacheKey(
	sourceLanguage: string,
	targetLanguage: string,
	sourceText: string,
): string {
	return `${sourceLanguage}||${targetLanguage}||${sourceText}`;
}

/**
 * Strips leading/trailing whitespace and punctuation for cache-key matching.
 * Only the edges are affected; the middle stays exact-match. The original text
 * is still sent to the model on a miss.
 */
export function normalizeCacheText(text: string): string {
	return text.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

export class TranslationCache {
	private store = new Map<string, TranslationCacheEntry>();
	private writeQueue: Promise<void> = Promise.resolve();
	private loaded = false;

	constructor(
		private adapter: TranslationCacheAdapter,
		private filePath: string,
	) {}

	/**
	 * Loads the cache file into memory. Idempotent. Missing or corrupted files
	 * are tolerated and yield an empty cache; this never throws.
	 */
	async load(): Promise<void> {
		try {
			const raw = await this.adapter.read(this.filePath);
			if (raw) {
				const parsed = JSON.parse(raw) as Record<string, unknown>;
				if (parsed && typeof parsed === "object") {
					for (const [key, value] of Object.entries(parsed)) {
						const entry = value as TranslationCacheEntry;
						if (entry && typeof entry === "object" && typeof entry.translatedText === "string") {
							this.store.set(key, entry);
						}
					}
				}
			}
		} catch {
			// Corrupted file or read error: start with an empty cache.
		} finally {
			this.loaded = true;
		}
	}

	/** Returns the cached entry, or null on miss (or before load() has finished). */
	get(key: string): TranslationCacheEntry | null {
		return this.store.get(key) ?? null;
	}

	/** Stores the entry in memory and queues a serialized persist. */
	set(key: string, entry: TranslationCacheEntry): void {
		this.store.set(key, entry);
		this.persist();
	}

	/** Waits for all queued writes to land on disk. */
	flush(): Promise<void> {
		return this.writeQueue;
	}

	get size(): number {
		return this.store.size;
	}

	private persist(): void {
		this.writeQueue = this.writeQueue
			.catch(() => undefined)
			.then(() => {
				// Snapshot is read at execution time so concurrent sets never
				// overwrite each other; the last write wins.
				const payload = Object.fromEntries(this.store);
				return this.adapter.write(this.filePath, JSON.stringify(payload, null, 2));
			});
		this.writeQueue.catch(() => undefined);
	}
}
