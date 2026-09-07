import zh from "./zh.json";
import en from "./en.json";
import tr from "./tr.json";
import { getLanguage } from "obsidian";

type Translations = typeof zh;

/**
 * Get a translated string by dot-separated key.
 * Language is detected from Obsidian's configured app language.
 * zh* → Chinese, tr* → Turkish, everything else → English.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
    const lang = getLanguage();
    const bundle: Translations = lang.startsWith("zh") ? zh : lang.startsWith("tr") ? tr : en;

    let text = resolve(bundle, key) ?? resolve(zh, key) ?? key;

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
