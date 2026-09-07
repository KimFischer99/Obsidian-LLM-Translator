import type {
	ConnectionTestResult,
	PdfOllamaTranslatorSettings,
	TranslationRequest,
	TranslationResult,
	TranslationLanguage,
	TranslationProviderId,
} from "./types";
import { requestUrl } from "obsidian";
import { t } from "./i18n";

interface OllamaChatResponse {
	message?: {
		content?: string;
		thinking?: string;
	};
	error?: string;
}

interface OllamaTagsResponse {
	models?: Array<{
		name?: string;
		model?: string;
	}>;
}

interface CloudChatResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
	error?: {
		message?: string;
	};
}

interface TranslationExecutionContext {
	transportSettlements: Promise<void>[];
}

interface ScheduledTranslation {
	request: TranslationRequest;
	run: (context: TranslationExecutionContext) => Promise<TranslationResult>;
	resolve: (result: TranslationResult) => void;
	reject: (error: unknown) => void;
	queuedAbortListener?: () => void;
}

interface ProviderLane {
	active?: ScheduledTranslation;
	pending?: ScheduledTranslation;
}

const MAX_HTTP_ERROR_BODY_LENGTH = 1_000;

export type CloudApiBaseUrlErrorCode =
	| "required"
	| "invalid"
	| "protocol"
	| "https-required";

export class CloudApiBaseUrlError extends Error {
	constructor(readonly code: CloudApiBaseUrlErrorCode) {
		super(code);
		this.name = "CloudApiBaseUrlError";
	}
}

export class TranslationCancelledError extends Error {
	constructor(message = t("error.requestCancelled")) {
		super(message);
		this.name = "AbortError";
	}
}

export class TranslationTimeoutError extends Error {
	constructor(message = t("error.requestTimedOut")) {
		super(message);
		this.name = "TimeoutError";
	}
}

export const DEFAULT_TRANSLATION_PROMPT =
	"Translate English, German, French, Turkish, Japanese, or Simplified Chinese into the selected target language. Preserve terminology, numbers, formulas, citations, and paragraph breaks. Output only the translation.";

const LANGUAGE_NAMES: Record<TranslationLanguage, string> = {
	auto: "auto-detected language",
	en: "English",
	de: "German",
	fr: "French",
	tr: "Turkish",
	ja: "Japanese",
	"zh-Hans": "Simplified Chinese",
};

const PROVIDER_LABELS: Record<TranslationProviderId, string> = {
	"local-llm": "Local LLM",
	"cloud-api": "Cloud API",
	google: "Google",
	bing: "Bing",
};

export function getProviderLabel(provider: TranslationProviderId): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

export function normalizeCloudApiBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) {
		throw new CloudApiBaseUrlError("required");
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new CloudApiBaseUrlError("invalid");
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new CloudApiBaseUrlError("protocol");
	}
	if (parsed.search || parsed.hash) {
		throw new CloudApiBaseUrlError("invalid");
	}

	if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
		throw new CloudApiBaseUrlError("https-required");
	}

	const path = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.origin}${path}`;
}

export function truncateHttpErrorBody(value: string, maxLength = MAX_HTTP_ERROR_BODY_LENGTH): string {
	const trimmed = value.trim();
	if (maxLength <= 0) {
		return "";
	}
	if (trimmed.length <= maxLength) {
		return trimmed;
	}
	return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

export class TranslatorService {
	private readonly providerLanes = new Map<TranslationProviderId, ProviderLane>();

	constructor(
		private getSettings: () => PdfOllamaTranslatorSettings,
		private getSecret: (secretId: string) => string | null = () => null,
	) {}

	async translate(request: TranslationRequest): Promise<TranslationResult> {
		const provider = this.getSettings().translationProvider;
		return this.scheduleTranslation(provider, request, (context) => {
			if (provider === "cloud-api") {
				return this.translateWithCloudApi(request, context);
			}
			if (provider === "google") {
				return this.translateWithGoogle(request, context);
			}
			if (provider === "bing") {
				return this.translateWithBing(request, context);
			}
			return this.translateWithOllama(request, context);
		});
	}

	private async translateWithOllama(request: TranslationRequest, context: TranslationExecutionContext): Promise<TranslationResult> {
		const settings = this.getSettings();
		const model = settings.model.trim();
		if (!model) {
			throw new Error(t("error.selectLocalModel"));
		}

		const startedAt = performance.now();
		const response = await this.requestUrlWithTimeout({
			url: this.getChatUrl(settings.ollamaBaseUrl),
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				stream: false,
				options: buildOllamaOptions(settings),
				messages: [
					{ role: "system", content: this.getSystemPrompt(settings, request) },
					{ role: "user", content: request.text },
				],
			}),
		}, settings.requestTimeoutMs, request.signal, context);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Ollama"));
		}

		const data = response.json as OllamaChatResponse;
		if (data.error) {
			throw new Error(data.error);
		}

		const rawContent = data.message?.content?.trim() ?? "";
		if (!rawContent) {
			throw new Error(t("error.ollamaReturnedEmpty"));
		}

		return {
			sourceText: request.text,
			translatedText: settings.cleanModelOutput ? cleanModelOutput(rawContent) : rawContent,
			model,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	private async translateWithCloudApi(request: TranslationRequest, context: TranslationExecutionContext): Promise<TranslationResult> {
		const settings = this.getSettings();
		const apiKeySecretId = settings.cloudApiKeySecretId.trim();
		const apiKey = apiKeySecretId ? this.getSecret(apiKeySecretId)?.trim() ?? "" : "";
		const model = settings.cloudApiModel.trim();
		if (!apiKey) {
			throw new Error(t("error.fillApiKey"));
		}
		if (!model) {
			throw new Error(t("error.fillModelName"));
		}

		const startedAt = performance.now();
		const cloudChatUrl = this.getCloudChatUrl(settings.cloudApiBaseUrl);
		const response = await this.requestUrlWithTimeout({
			url: cloudChatUrl,
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			contentType: "application/json",
			body: JSON.stringify({
				model,
				stream: false,
				messages: [
					{ role: "system", content: this.getSystemPrompt(settings, request) },
					{ role: "user", content: request.text },
				],
			}),
		}, settings.requestTimeoutMs, request.signal, context);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Cloud API"));
		}

		const data = response.json as CloudChatResponse;
		if (data.error) {
			throw new Error(data.error.message ?? t("error.cloudApiError"));
		}

		const rawContent = data.choices?.[0]?.message?.content?.trim() ?? "";
		if (!rawContent) {
			throw new Error(t("error.cloudApiReturnedEmpty"));
		}

		return {
			sourceText: request.text,
			translatedText: settings.cleanModelOutput ? cleanModelOutput(rawContent) : rawContent,
			model,
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	private async translateWithGoogle(request: TranslationRequest, context: TranslationExecutionContext): Promise<TranslationResult> {
		const settings = this.getSettings();
		const startedAt = performance.now();
		const source = toGoogleLanguage(request.sourceLanguage);
		const target = toGoogleLanguage(request.targetLanguage);
		const url = new URL("https://translate.googleapis.com/translate_a/single");
		url.searchParams.set("client", "gtx");
		url.searchParams.set("sl", source);
		url.searchParams.set("tl", target);
		url.searchParams.set("dt", "t");
		url.searchParams.set("q", request.text);

		const response = await this.requestUrlWithTimeout({ url: url.toString() }, settings.requestTimeoutMs, request.signal, context);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Google Translate"));
		}

		const translatedText = parseGoogleResponse(response.json);
		if (!translatedText) {
			throw new Error(t("error.googleReturnedEmpty"));
		}
		return {
			sourceText: request.text,
			translatedText,
			model: "Google",
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	private async translateWithBing(request: TranslationRequest, context: TranslationExecutionContext): Promise<TranslationResult> {
		const settings = this.getSettings();
		const startedAt = performance.now();
		const target = toBingLanguage(request.targetLanguage);
		const source = request.sourceLanguage === "auto" ? "" : `&from=${encodeURIComponent(toBingLanguage(request.sourceLanguage))}`;
		const url = `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0${source}&to=${encodeURIComponent(target)}`;
		const token = await this.getBingAuthToken(settings.requestTimeoutMs, request.signal, context);
		const response = await this.requestUrlWithTimeout({
			url,
			method: "POST",
			headers: {
				Accept: "*/*",
				"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
				Authorization: `Bearer ${token}`,
				"Cache-Control": "no-cache",
				Pragma: "no-cache",
				Referer: "https://appsumo.com/",
				"Referrer-Policy": "strict-origin-when-cross-origin",
			},
			contentType: "application/json",
			body: JSON.stringify([{ text: request.text }]),
		}, settings.requestTimeoutMs, request.signal, context);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Bing Translate"));
		}

		const translatedText = parseBingResponse(response.json);
		if (!translatedText) {
			throw new Error(t("error.bingReturnedEmpty"));
		}
		return {
			sourceText: request.text,
			translatedText,
			model: "Bing",
			elapsedMs: Math.round(performance.now() - startedAt),
		};
	}

	async testConnection(): Promise<ConnectionTestResult> {
		const provider = this.getSettings().translationProvider;
		if (provider !== "local-llm") {
			try {
				const result = await this.translate({
					text: "Hello",
					sourceLanguage: "en",
					targetLanguage: "zh-Hans",
					allowedSourceLanguages: ["en", "de", "fr", "tr", "ja", "zh-Hans"],
				});
				return { ok: true, message: t("error.connectionSuccess", { provider: getProviderLabel(provider), result: result.translatedText }) };
			} catch (error) {
				return { ok: false, message: this.toReadableError(error) };
			}
		}

		const settings = this.getSettings();
		const model = settings.model.trim();
		if (!model) {
			return { ok: false, message: t("error.modelNameEmpty") };
		}

		try {
			const response = await this.requestUrlWithTimeout({
				url: this.getTagsUrl(settings.ollamaBaseUrl),
			}, settings.requestTimeoutMs);

			if (response.status < 200 || response.status >= 300) {
				return { ok: false, message: this.toHttpError(response, "Ollama") };
			}

			const data = response.json as OllamaTagsResponse;
			const models = data.models ?? [];
			const hasModel = models.some((item) => item.name === model || item.model === model);
			if (!hasModel) {
				return {
					ok: false,
					message: t("error.ollamaConnectedButModelNotFound", { model }),
				};
			}

			return { ok: true, message: t("error.modelAvailable", { model }) };
		} catch (error) {
			return { ok: false, message: this.toReadableError(error) };
		}
	}

	async listModels(): Promise<string[]> {
		const settings = this.getSettings();
		const response = await this.requestUrlWithTimeout({
			url: this.getTagsUrl(settings.ollamaBaseUrl),
		}, settings.requestTimeoutMs);

		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Ollama"));
		}

		const data = response.json as OllamaTagsResponse;
		return (data.models ?? [])
			.map((item) => item.name ?? item.model ?? "")
			.filter((name) => name.length > 0)
			.sort((a, b) => a.localeCompare(b));
	}

	toReadableError(error: unknown): string {
		if (error instanceof TranslationTimeoutError || error instanceof TranslationCancelledError) {
			return error.message;
		}
		if (error instanceof DOMException && error.name === "AbortError") {
			return t("error.requestCancelled");
		}
		if (error instanceof TypeError) {
			return t("error.cannotConnectOllama");
		}
		if (error instanceof Error) {
			return error.message;
		}
		return t("error.unknownError");
	}

	private getChatUrl(baseUrl: string): string {
		return `${this.getApiBaseUrl(baseUrl)}/chat`;
	}

	private getTagsUrl(baseUrl: string): string {
		return `${this.getApiBaseUrl(baseUrl)}/tags`;
	}

	private getCloudChatUrl(baseUrl: string): string {
		try {
			return `${normalizeCloudApiBaseUrl(baseUrl)}/chat/completions`;
		} catch (error) {
			if (!(error instanceof CloudApiBaseUrlError)) {
				throw error;
			}
			const keyByCode: Record<CloudApiBaseUrlErrorCode, string> = {
				required: "error.cloudApiBaseUrlRequired",
				invalid: "error.cloudApiBaseUrlInvalid",
				protocol: "error.cloudApiBaseUrlProtocol",
				"https-required": "error.cloudApiBaseUrlHttpsRequired",
			};
			throw new Error(t(keyByCode[error.code]));
		}
	}

	private async getBingAuthToken(
		timeoutMs: number,
		signal: AbortSignal | undefined,
		context: TranslationExecutionContext,
	): Promise<string> {
		const response = await this.requestUrlWithTimeout({
			url: "https://edge.microsoft.com/translate/auth",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36 Edg/113.0.1774.42",
			},
		}, timeoutMs, signal, context);
		if (response.status < 200 || response.status >= 300) {
			throw new Error(this.toHttpError(response, "Bing Auth"));
		}
		const token = response.text.trim();
		if (!token) {
			throw new Error(t("error.bingAuthEmptyToken"));
		}
		return token;
	}

	private getApiBaseUrl(baseUrl: string): string {
		const trimmed = baseUrl.trim().replace(/\/+$/, "");
		if (!trimmed) {
			return "http://localhost:11434/api";
		}
		return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
	}

	private requestUrlWithTimeout(
		params: { url: string; method?: string; headers?: Record<string, string>; body?: string; contentType?: string },
		timeoutMs: number,
		signal?: AbortSignal,
		context?: TranslationExecutionContext,
	): Promise<{ status: number; text: string; json: unknown }> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new TranslationCancelledError());
				return;
			}

			let settled = false;
			const cleanup = () => {
				window.clearTimeout(timeoutId);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = (callback: () => void) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				callback();
			};
			const onAbort = () => finish(() => reject(new TranslationCancelledError()));
			const timeoutId = window.setTimeout(
				() => finish(() => reject(new TranslationTimeoutError())),
				Math.max(1, timeoutMs),
			);
			signal?.addEventListener("abort", onAbort, { once: true });

			let transport: ReturnType<typeof requestUrl>;
			try {
				transport = requestUrl({
					url: params.url,
					method: params.method,
					headers: params.headers,
					body: params.body,
					contentType: params.contentType,
					throw: false,
				});
			} catch (error) {
				finish(() => reject(error));
				return;
			}

			context?.transportSettlements.push(transport.then(() => undefined, () => undefined));
			transport.then(
				(response) => finish(() => resolve(response)),
				(error) => finish(() => reject(error)),
			);
		});
	}

	private toHttpError(response: { status: number; text: string }, service: string): string {
		const text = response.text.trim();
		if (!text) {
			return t("error.httpRequestFailed", { service, status: response.status });
		}

		try {
			const message = extractHttpErrorMessage(JSON.parse(text));
			return message
				? truncateHttpErrorBody(message)
				: t("error.httpRequestFailed", { service, status: response.status });
		} catch {
			return t("error.httpRequestFailedWithBody", {
				service,
				status: response.status,
				body: truncateHttpErrorBody(text),
			});
		}
	}

	private scheduleTranslation(
		provider: TranslationProviderId,
		request: TranslationRequest,
		run: (context: TranslationExecutionContext) => Promise<TranslationResult>,
	): Promise<TranslationResult> {
		if (request.signal?.aborted) {
			return Promise.reject(new TranslationCancelledError());
		}

		return new Promise((resolve, reject) => {
			const task: ScheduledTranslation = { request, run, resolve, reject };
			let lane = this.providerLanes.get(provider);
			if (!lane) {
				lane = {};
				this.providerLanes.set(provider, lane);
			}

			if (!lane.active) {
				this.startScheduledTranslation(provider, lane, task);
				return;
			}

			if (lane.pending) {
				this.rejectQueuedTranslation(lane.pending, new TranslationCancelledError());
			}
			lane.pending = task;
			if (request.signal) {
				const onAbort = () => {
					if (lane?.pending === task) {
						lane.pending = undefined;
						this.rejectQueuedTranslation(task, new TranslationCancelledError());
					}
				};
				task.queuedAbortListener = onAbort;
				request.signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	private startScheduledTranslation(provider: TranslationProviderId, lane: ProviderLane, task: ScheduledTranslation): void {
		lane.active = task;
		if (task.queuedAbortListener && task.request.signal) {
			task.request.signal.removeEventListener("abort", task.queuedAbortListener);
			task.queuedAbortListener = undefined;
		}

		void this.executeScheduledTranslation(provider, lane, task);
	}

	private async executeScheduledTranslation(
		provider: TranslationProviderId,
		lane: ProviderLane,
		task: ScheduledTranslation,
	): Promise<void> {
		const context: TranslationExecutionContext = { transportSettlements: [] };
		try {
			if (task.request.signal?.aborted) {
				throw new TranslationCancelledError();
			}
			const result = await task.run(context);
			if (task.request.signal?.aborted) {
				throw new TranslationCancelledError();
			}
			task.resolve(result);
		} catch (error) {
			task.reject(error);
		} finally {
			await Promise.allSettled(context.transportSettlements);
			if (lane.active === task) {
				lane.active = undefined;
			}

			const pending = lane.pending;
			lane.pending = undefined;
			if (pending) {
				this.startScheduledTranslation(provider, lane, pending);
			} else if (!lane.active) {
				this.providerLanes.delete(provider);
			}
		}
	}

	private rejectQueuedTranslation(task: ScheduledTranslation, error: TranslationCancelledError): void {
		if (task.queuedAbortListener && task.request.signal) {
			task.request.signal.removeEventListener("abort", task.queuedAbortListener);
			task.queuedAbortListener = undefined;
		}
		task.reject(error);
	}

	private getSystemPrompt(settings: PdfOllamaTranslatorSettings, request: TranslationRequest): string {
		const source = LANGUAGE_NAMES[request.sourceLanguage] ?? request.sourceLanguage;
		const target = LANGUAGE_NAMES[request.targetLanguage] ?? request.targetLanguage;
		const template = settings.customPrompt.trim() || DEFAULT_TRANSLATION_PROMPT;
		return `${template}\n\nSource language: ${source}\nTarget language: ${target}`;
	}

}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return normalized === "localhost"
		|| normalized.endsWith(".localhost")
		|| normalized === "[::1]"
		|| normalized === "::1"
		|| /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function extractHttpErrorMessage(value: unknown): string | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const error = (value as { error?: unknown }).error;
	if (typeof error === "string") {
		return error;
	}
	if (!error || typeof error !== "object") {
		return undefined;
	}
	const message = (error as { message?: unknown }).message;
	return typeof message === "string" ? message : undefined;
}

export function buildOllamaOptions(settings: PdfOllamaTranslatorSettings): Record<string, unknown> {
	return {
		top_k: settings.topK,
		top_p: settings.topP,
		repeat_penalty: settings.repeatPenalty,
		num_predict: settings.numPredict,
	};
}

export function cleanModelOutput(value: string): string {
	return value
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/^\s*(translation|translated text|çeviri|tercüme|译文|翻译)\s*[:：]\s*/i, "")
		.replace(/^```(?:text|markdown)?\s*/i, "")
		.replace(/```\s*$/i, "")
		.trim()
		.replace(/^["'“”]+|["'“”]+$/g, "")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^[ \t]*\n/gm, "")
		.trim();
}

function toGoogleLanguage(language: TranslationLanguage): string {
	return language === "zh-Hans" ? "zh-CN" : language;
}

function toBingLanguage(language: Exclude<TranslationLanguage, "auto">): string;
function toBingLanguage(language: TranslationLanguage): string {
	return language === "zh-Hans" ? "zh-Hans" : language;
}

function parseGoogleResponse(data: unknown): string {
	if (!Array.isArray(data) || !Array.isArray(data[0])) {
		return "";
	}
	const outer = data as unknown[][];
	return outer[0]
		.map((item) => (Array.isArray(item) ? String(item[0] ?? "") : ""))
		.join("")
		.trim();
}

function parseBingResponse(data: unknown): string {
	if (!Array.isArray(data)) {
		return "";
	}
	const items = data as Array<{ translations?: Array<{ text?: string }> }>;
	return items
		.flatMap((item) => {
			const translations = item.translations ?? [];
			return translations.map((translation) => translation.text ?? "");
		})
		.filter((value): value is string => Boolean(value))
		.join("\n")
		.trim();
}
