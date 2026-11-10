import "obsidian";

declare module "obsidian" {
	interface App {
		/**
		 * Obsidian's private plugin registry. Used only to detect whether PDF++
		 * is enabled, so we can stay out of its way instead of fighting it for
		 * the context menu.
		 */
		plugins?: {
			plugins?: Record<string, unknown>;
			enabledPlugins?: Set<string>;
		};
	}
}
