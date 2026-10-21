import zh from "./zh.json";
import en from "./en.json";
import de from "./de.json";
import fr from "./fr.json";
import ja from "./ja.json";
import tr from "./tr.json";
import { getLanguage } from "obsidian";

const bundles: Record<string, typeof en> = { en, de, fr, ja, tr, zh };

/**
 * Get a translated string by dot-separated key.
 * Language is detected from Obsidian's configured app language.
 * Supports the same interface languages as the translation selector.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
    const bundle = bundles[getLanguage().split("-")[0]] ?? en;

    let text = resolve(bundle, key) ?? resolve(en, key) ?? key;

    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.replace(new RegExp(`\\$\\{${k}\\}`, "g"), String(v));
        }
    }

    return text;
}

function resolve(obj: Record<string, unknown>, key: string): string | undefined {
    const parts = key.split(".");
    let current: unknown = obj;
    for (const part of parts) {
        if (current === null || current === undefined || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" ? current : undefined;
}
