import esbuild from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const result = await esbuild.build({
	entryPoints: ["tests/test-suite.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	write: false,
	plugins: [{
		name: "obsidian-test-stub",
		setup(build) {
			build.onResolve({ filter: /pdf\.worker\.mjs\?worker-source$/ }, () => ({ path: "worker", namespace: "worker-test" }));
			build.onLoad({ filter: /.*/, namespace: "worker-test" }, () => ({ contents: 'export default "";', loader: "js" }));
			build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "obsidian-test" }));
			build.onLoad({ filter: /.*/, namespace: "obsidian-test" }, () => ({
				contents: `
					export function getLanguage() { return "en"; }
					export class Plugin {}
					export class ItemView {}
					export class PluginSettingTab {}
					export class FuzzySuggestModal {}
					export class Modal {}
					export class Notice {}
					export class Setting {}
					export class SecretComponent {}
					export function setIcon() {}
					export class TFile {
						constructor(path) {
							this.path = path;
							this.name = path.split("/").pop();
							this.extension = this.name.split(".").pop();
							this.parent = { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" };
						}
					}
					export function normalizePath(path) { return path.split("/").filter(Boolean).join("/"); }
					export function __setRequestUrl(handler) { globalThis.__obsidianRequestUrl = handler; }
					export function requestUrl(params) { return globalThis.__obsidianRequestUrl(params); }
				`,
				loader: "js",
			}));
		},
	}],
});

const source = result.outputFiles[0].text;
const buildDirectory = await mkdtemp(join(tmpdir(), "llm-translator-tests-"));
const buildPath = join(buildDirectory, "test-suite.mjs");
try {
	await writeFile(buildPath, source);
	await import(pathToFileURL(buildPath).href);
} finally {
	await rm(buildDirectory, { recursive: true, force: true });
}
