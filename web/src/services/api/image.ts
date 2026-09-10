import axios from "axios";

import i18n from "@/i18n";
import { buildApiUrl, guessCapability, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig, type ChannelModel, type ModelChannel, type ProviderModelCapabilities } from "@/stores/use-config-store";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { AUTODL_WORKFLOW_MODELS, imageApiPath, providerApiUrl, textApiPath } from "./provider-protocols";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import { resolvePublicReferenceImage } from "./public-media-upload";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };
type ChatCompletionPayload = {
    choices?: Array<{ message?: { content?: unknown }; delta?: { content?: unknown } }>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ChatCompletionStreamState = { buffer: string; text: string; error?: string };

type ImageApiResponse = {
    id?: string;
    task_id?: string;
    taskId?: string;
    status?: string;
    object?: string;
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { imageConfig: image } : {};
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality);
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageSource(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    if (typeof item.image_url === "string" && item.image_url) return item.image_url;
    if (isRecord(item.image_url) && typeof item.image_url.url === "string" && item.image_url.url) return item.image_url.url;
    if (typeof item.file_url === "string" && item.file_url) return item.file_url;
    if (typeof item.result_url === "string" && item.result_url) return item.result_url;
    if (typeof item.output_url === "string" && item.output_url) return item.output_url;
    return null;
}

function imageItemsFromPayload(payload: unknown): Array<Record<string, unknown>> {
    if (!isRecord(payload)) return [];
    if (resolveImageSource(payload) || typeof payload.file_id === "string" || typeof payload.fileId === "string") return [payload];
    const candidates = [payload.data, payload.images, payload.results, payload.output, payload.result, payload.metadata, payload.content];
    for (const value of candidates) {
        if (Array.isArray(value)) return value.flatMap((item) => isRecord(item) ? [item] : typeof item === "string" && item ? [{ url: item }] : []);
        if (typeof value === "string" && value) return [{ url: value }];
        if (isRecord(value)) {
            const nested = imageItemsFromPayload(value);
            if (nested.length) return nested;
        }
    }
    return [];
}

function parseImagePayload(payload: ImageApiResponse | unknown) {
    if (!isRecord(payload)) throw new Error(apiText("noImageReturned"));
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
    }
    if (payload.error) {
        const message = readApiErrorMessage(payload);
        if (message) throw new Error(message);
    }
    // Support data, images, and results response fields used by different APIs.
    const imageList = imageItemsFromPayload(payload);
    const images = imageList
        .map(resolveImageSource)
        .filter((value): value is string => Boolean(value))
        .map((dataUrl) => ({ id: nanoid(), dataUrl }));

    if (images.length === 0) {
        // Check whether the response contains data in an unrecognized format.
        const rawKeys = Object.keys(payload).filter((k) => k !== "code" && k !== "msg" && k !== "error");
        throw new Error(rawKeys.length > 0
            ? apiText("unknownImageResponse", { fields: rawKeys.join(", ") })
            : apiText("noImageReturned"));
    }

    return images;
}

function shafuImageModelUsesLegacyVideo(model: string) {
    const value = model.trim().toLowerCase();
    return value.includes("nano-banana") || /gpt-image2(?:-|$)/i.test(value) || /gpt-image-2(?:-|$)/i.test(value);
}

function shafuImageAspectRatio(size: string) {
    const value = size.trim();
    if (/^\d+:\d+$/.test(value)) return value;
    const dimensions = parseImageDimensions(value);
    return dimensions ? `${dimensions.width}:${dimensions.height}` : "1:1";
}

function shafuTaskId(payload: unknown) {
    if (!isRecord(payload)) return "";
    const data = isRecord(payload.data) ? payload.data : undefined;
    const error = isRecord(payload.error) ? payload.error : undefined;
    return [payload.id, payload.task_id, payload.taskId, data?.id, data?.task_id, data?.taskId, error?.task_id, error?.taskId]
        .find((value) => typeof value === "string" && value.trim()) as string || "";
}

function shafuTaskStatus(payload: unknown) {
    if (!isRecord(payload)) return "";
    const data = isRecord(payload.data) ? payload.data : undefined;
    return String(payload.status || data?.status || "").trim().toLowerCase();
}

function shafuImageCompleted(status: string) {
    return ["completed", "succeeded", "success", "done"].includes(status);
}

function shafuImageFailed(status: string) {
    return ["failed", "cancelled", "canceled", "error"].includes(status);
}

async function resolveShafuImageFile(config: AiConfig, item: Record<string, unknown>, options?: RequestOptions) {
    const source = resolveImageSource(item);
    if (source) return source;
    const fileId = [item.file_id, item.fileId].find((value) => typeof value === "string" && value) as string | undefined;
    if (!fileId) return null;
    const url = providerApiUrl(config.baseUrl, `/v1/files/${encodeURIComponent(fileId)}/content`);
    const response = await axios.get<Blob>(url, { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
    return blobToDataUrl(response.data);
}

async function parseShafuImageResult(config: AiConfig, payload: unknown, options?: RequestOptions) {
    const images = imageItemsFromPayload(payload);
    const sources = await Promise.all(images.map((item) => resolveShafuImageFile(config, item, options)));
    return sources.filter((value): value is string => Boolean(value)).map((dataUrl) => ({ id: nanoid(), dataUrl }));
}

async function pollShafuImageTask(config: AiConfig, taskId: string, legacy: boolean, options?: RequestOptions) {
    const path = legacy ? `/v1/videos/${encodeURIComponent(taskId)}` : `/v1/tasks/${encodeURIComponent(taskId)}`;
    for (;;) {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, path), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = shafuTaskStatus(payload);
        if (shafuImageFailed(status)) throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (shafuImageCompleted(status)) {
            const images = await parseShafuImageResult(config, payload, options);
            if (images.length) return images;
            throw new Error(apiText("noImageReturned"));
        }
        await delay(2500, options?.signal);
    }
}

async function requestShafuLegacyImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const urls = await Promise.all(references.map((image) => resolvePublicReferenceImage(image, config, options?.signal)));
    const requests = Array.from({ length: count }, async () => {
        const payload = (await axios.post<unknown>(
            providerApiUrl(config.baseUrl, "/v1/videos"),
            {
                model: config.model,
                prompt: withSystemPrompt(config, prompt),
                aspect_ratio: shafuImageAspectRatio(config.size),
                ...(urls.length ? { images: urls } : {}),
            },
            { headers: aiHeaders(config, "application/json"), signal: options?.signal },
        )).data;
        const immediate = await parseShafuImageResult(config, payload, options);
        if (immediate.length) return immediate;
        const taskId = shafuTaskId(payload);
        if (!taskId) throw new Error(readApiErrorMessage(payload) || apiText("noImageReturned"));
        return pollShafuImageTask(config, taskId, true, options);
    });
    return (await Promise.all(requests)).flat();
}

async function requestShafuUnifiedImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    if (references.length) throw new Error(apiText("shafuUnifiedImageEditUnsupported"));
    const requestSize = resolveRequestSize(normalizeQuality(config.quality), config.size);
    const payload = (await axios.post<unknown>(
        providerApiUrl(config.baseUrl, "/v1/images/generations"),
        {
            model: config.model,
            prompt: withSystemPrompt(config, prompt),
            ...(requestSize ? { size: requestSize } : {}),
            n: count,
            response_format: "url",
        },
        { headers: { ...aiHeaders(config, "application/json"), Prefer: "respond-async", "Idempotency-Key": `canvas-${nanoid()}` }, signal: options?.signal },
    )).data;
    const immediate = await parseShafuImageResult(config, payload, options);
    if (immediate.length) return immediate;
    const taskId = shafuTaskId(payload);
    if (!taskId) throw new Error(readApiErrorMessage(payload) || apiText("noImageReturned"));
    return pollShafuImageTask(config, taskId, false, options);
}

async function requestShafuImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    return shafuImageModelUsesLegacyVideo(config.model)
        ? requestShafuLegacyImages(config, prompt, references, count, options)
        : requestShafuUnifiedImages(config, prompt, references, count, options);
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
            return;
        }
        const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { window.clearTimeout(timer); reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError")); };
        const timer = window.setTimeout(done, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error(apiText("requestFailed")));
        reader.readAsDataURL(blob);
    });
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        // The value may be serialized JSON, such as error.message, or a plain-text error.
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            // Treat an empty parsed object such as "{}" as having no useful message.
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            // Detect HTML error pages.
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        // Prefer the API error from the response body.
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        // Infer the error from the HTTP status when the response body has no usable message.
        const statusMsg = readStatusError(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        // Fall back to Axios's own error message.
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return withLocalProxy(`${baseUrl}/models`);
    return withLocalProxy(`${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`);
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(apiText("geminiRejected", { reason: payload.promptFeedback.blockReason }));
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function chatContentText(content: unknown) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
        .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
        .join("");
}

function validateChatCompletionPayload(payload: ChatCompletionPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function consumeChatCompletionBlock(block: string, state: ChatCompletionStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const payload = JSON.parse(data) as ChatCompletionPayload;
    if (payload.error?.message || (typeof payload.code === "number" && payload.code !== 0)) {
        state.error = payload.error?.message || payload.msg || apiText("requestFailed");
        return;
    }
    const delta = payload.choices?.map((choice) => chatContentText(choice.delta?.content)).join("") || "";
    if (!delta) return;
    state.text += delta;
    onDelta?.(state.text);
}

function consumeChatCompletionText(state: ChatCompletionStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeChatCompletionBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeChatCompletionBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingChatCompletion(config: AiConfig, messages: ResponseInputMessage[], onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(providerApiUrl(config.baseUrl, textApiPath(config.apiFormat)), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages: withSystemMessage(config, messages), stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        const payload = (await response.json()) as ChatCompletionPayload;
        validateChatCompletionPayload(payload);
        const content = payload.choices?.map((choice) => chatContentText(choice.message?.content)).join("") || "";
        if (content) onDelta?.(content);
        return { content, toolCalls: [] };
    }
    if (!response.body) return { content: "", toolCalls: [] };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ChatCompletionStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeChatCompletionText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeChatCompletionText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: [] };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error(apiText("geminiNoImage"));
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    if (requestConfig.apiFormat === "canvasvideo" || requestConfig.apiFormat === "comfyui") throw new Error(i18n.t("providerErrors.canvasVideoCapabilityUnsupported", { capability: apiText("capabilityImage") }));
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "shafu") {
        try {
            return await requestShafuImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "autodl") throw new Error(apiText("autoDlCapabilityUnsupported", { capability: apiText("capabilityImage") }));
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    try {
        if (requestConfig.apiFormat === "volcengine") {
            const requests = Array.from({ length: n }, () => axios.post<ImageApiResponse>(
                providerApiUrl(requestConfig.baseUrl, imageApiPath(requestConfig.apiFormat)),
                {
                    model: requestConfig.model,
                    prompt: withSystemPrompt(requestConfig, prompt),
                    ...(requestSize ? { size: requestSize } : {}),
                    output_format: IMAGE_OUTPUT_FORMAT,
                    response_format: "url",
                    watermark: false,
                },
                { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal },
            ));
            return (await Promise.all(requests)).flatMap((response) => parseImagePayload(response.data));
        }
        if (requestConfig.apiFormat === "zizidonghua") {
            const response = await axios.post<ImageApiResponse>(
                providerApiUrl(requestConfig.baseUrl, imageApiPath(requestConfig.apiFormat)),
                {
                    model: requestConfig.model,
                    prompt: withSystemPrompt(requestConfig, prompt),
                    n,
                    ...(requestSize ? { size: requestSize } : {}),
                },
                { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal },
            );
            return parseImagePayload(response.data);
        }
        const response = await axios.post<ImageApiResponse>(
            aiApiUrl(requestConfig, "/images/generations"),
            {
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, prompt),
                n,
                ...(quality ? { quality } : {}),
                ...(requestSize ? { size: requestSize } : {}),
                ...(background ? { background } : {}),
                // gpt-image models reject response_format; they always return b64.
                ...(/gpt-image/.test(requestConfig.model) ? {} : { response_format: "b64_json" }),
                output_format: IMAGE_OUTPUT_FORMAT,
            },
            {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
            },
        );
        const images = await parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    if (requestConfig.apiFormat === "canvasvideo" || requestConfig.apiFormat === "comfyui") throw new Error(i18n.t("providerErrors.canvasVideoCapabilityUnsupported", { capability: apiText("capabilityImage") }));
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "shafu") {
        try {
            return await requestShafuImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "autodl") throw new Error(apiText("autoDlCapabilityUnsupported", { capability: apiText("capabilityImage") }));

    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    if (requestConfig.apiFormat === "volcengine" || requestConfig.apiFormat === "zizidonghua") {
        try {
            const referenceField = requestConfig.apiFormat === "volcengine" ? "image" : ziziImageReferenceField(requestConfig.model, references.length);
            const refs = requestConfig.apiFormat === "volcengine"
                ? await Promise.all(references.map((image) => imageToDataUrl(image)))
                : await Promise.all(references.map((image) => resolvePublicReferenceImage(image, requestConfig, options?.signal)));
            const body = {
                    model: requestConfig.model,
                    prompt: withSystemPrompt(requestConfig, requestPrompt),
                    ...(requestConfig.apiFormat === "zizidonghua" ? { n } : {}),
                    ...(requestSize ? { size: requestSize } : {}),
                    [referenceField]: refs.length === 1 && requestConfig.apiFormat === "volcengine" ? refs[0] : refs,
                    ...(requestConfig.apiFormat === "volcengine" ? { output_format: IMAGE_OUTPUT_FORMAT, response_format: "url", watermark: false } : {}),
                };
            const requests = Array.from({ length: requestConfig.apiFormat === "volcengine" ? n : 1 }, () => axios.post<ImageApiResponse>(
                providerApiUrl(requestConfig.baseUrl, imageApiPath(requestConfig.apiFormat)),
                body,
                { headers: aiHeaders(requestConfig, "application/json"), signal: options?.signal },
            ));
            return (await Promise.all(requests)).flatMap((response) => parseImagePayload(response.data));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    const formData = new FormData();
    formData.set("model", requestConfig.model);
    formData.set("prompt", withSystemPrompt(requestConfig, requestPrompt));
    formData.set("n", String(n));
    // gpt-image models reject response_format; they always return b64.
    if (!/gpt-image/.test(requestConfig.model)) {
        formData.set("response_format", "b64_json");
    }
    formData.set("output_format", IMAGE_OUTPUT_FORMAT);
    if (quality) {
        formData.set("quality", quality);
    }
    if (requestSize) {
        formData.set("size", requestSize);
    }
    if (background) {
        formData.set("background", background);
    }
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const imageField = files.length > 1 ? "image[]" : "image";
    files.forEach((file) => formData.append(imageField, file));

    try {
        const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal });
        const images = await parseImagePayload(response.data);
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    if (requestConfig.apiFormat === "canvasvideo" || requestConfig.apiFormat === "comfyui") throw new Error(i18n.t("providerErrors.canvasVideoCapabilityUnsupported", { capability: apiText("capabilityText") }));
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || apiText("noContent");
            if (text === apiText("noContent")) onDelta(text);
            return text;
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    try {
        if (requestConfig.apiFormat === "autodl") throw new Error(apiText("autoDlCapabilityUnsupported", { capability: apiText("capabilityText") }));
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || apiText("noContent");
            if (answer === apiText("noContent")) onDelta(answer);
            return answer;
        }
        if (requestConfig.apiFormat === "volcengine" || requestConfig.apiFormat === "zizidonghua" || requestConfig.apiFormat === "shafu") {
            const answer = (await requestStreamingChatCompletion(requestConfig, messages, onDelta, options)).content || apiText("noContent");
            if (answer === apiText("noContent")) onDelta(answer);
            return answer;
        }
        const answer = (await requestStreamingResponse(requestConfig, {
            model: requestConfig.model,
            input: toResponseInput(withSystemMessage(requestConfig, messages)),
            ...(requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } }),
        }, onDelta, options)).content || apiText("noContent");
        if (answer === apiText("noContent")) onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "autodl") return [...AUTODL_WORKFLOW_MODELS];
        if (config.apiFormat === "volcengine") throw new Error(apiText("providerModelListUnsupported"));
        if (config.apiFormat === "canvasvideo" || config.apiFormat === "comfyui") throw new Error(i18n.t("providerErrors.canvasVideoModelListUnsupported"));
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const url = config.apiFormat === "zizidonghua" ? providerApiUrl(config.baseUrl, "/v1/models") : buildApiUrl(config.baseUrl, "/models");
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(url, {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

export async function fetchChannelModels(channel: ModelChannel) {
    if (channel.apiFormat === "shafu") return fetchShafuModels(channel);
    if (channel.apiFormat === "openai") return fetchOpenAiModels(channel);
    return (await fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat })).map((name) => ({ name, capability: guessCapability(name) }));
}

type OpenAiModel = {
    id?: string;
    supported_endpoint_types?: unknown;
    type?: unknown;
    modality?: unknown;
    modalities?: unknown;
};

async function fetchOpenAiModels(channel: ModelChannel): Promise<ChannelModel[]> {
    try {
        const response = await axios.get<unknown>(buildApiUrl(channel.baseUrl, "/models"), {
            headers: { Authorization: "Bearer " + channel.apiKey },
        });
        return openAiModelList(response.data)
            .filter((model) => Boolean(model.id?.trim()))
            .map((model) => {
                const name = model.id!.trim();
                const endpointTypes = modelEndpointTypes(model);
                return {
                    name,
                    capability: openAiModelCapability(model, name),
                    ...(endpointTypes.length ? { providerCapabilities: { endpoints: endpointTypes } } : {}),
                };
            })
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

function openAiModelList(payload: unknown): OpenAiModel[] {
    if (Array.isArray(payload)) return payload.filter(isOpenAiModel);
    if (!payload || typeof payload !== "object") return [];
    const root = payload as Record<string, unknown>;
    const data = root.data;
    if (Array.isArray(data)) return data.filter(isOpenAiModel);
    const nestedModels = data && typeof data === "object" ? (data as Record<string, unknown>).models : undefined;
    if (Array.isArray(nestedModels)) return nestedModels.filter(isOpenAiModel);
    if (Array.isArray(root.models)) return root.models.filter(isOpenAiModel);
    return [];
}

function isOpenAiModel(value: unknown): value is OpenAiModel {
    return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string");
}

function modelEndpointTypes(model: OpenAiModel) {
    const value = model.supported_endpoint_types;
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    return [];
}

function openAiModelCapability(model: OpenAiModel, name: string): ChannelModel["capability"] {
    const endpoints = modelEndpointTypes(model).map((endpoint) => endpoint.toLowerCase());
    if (endpoints.some((endpoint) => endpoint === "openai-video" || endpoint.includes("video"))) return "video";
    if (endpoints.some((endpoint) => endpoint === "audio" || endpoint.includes("audio") || endpoint.includes("tts"))) return "audio";
    if (endpoints.some((endpoint) => endpoint === "image" || endpoint.includes("image"))) return "image";
    const declared = [model.type, model.modality, ...(Array.isArray(model.modalities) ? model.modalities : [model.modalities])]
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase());
    if (declared.some((value) => value.includes("video"))) return "video";
    if (declared.some((value) => value.includes("audio") || value.includes("speech"))) return "audio";
    if (declared.some((value) => value.includes("image"))) return "image";
    return guessCapability(name);
}

async function fetchShafuModels(channel: ModelChannel): Promise<ChannelModel[]> {
    try {
        const response = await axios.get<unknown>(providerApiUrl(channel.baseUrl, "/v1/models"), {
            headers: { Authorization: `Bearer ${channel.apiKey}` },
        });
        // Preserve all models. SHAFU exposes image and video models from the same
        // endpoint, and older records may omit the capabilities object.
        return shafuModelList(response.data)
            .filter((model) => Boolean(model.id?.trim()))
            .map((model) => ({ name: model.id!.trim(), capability: shafuModelCapability(model), providerCapabilities: toProviderCapabilities(model.capabilities) }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

type ShafuModel = {
    id?: string;
    supported_endpoint_types?: unknown;
    capabilities?: {
        type?: string;
        endpoints?: unknown;
        sizes?: unknown;
        durations?: unknown;
        supports_image_input?: unknown;
        supports_seed?: unknown;
        async?: unknown;
    };
};

function shafuModelList(payload: unknown): ShafuModel[] {
    if (Array.isArray(payload)) return payload.filter(isShafuModel);
    if (!payload || typeof payload !== "object") return [];
    const root = payload as Record<string, unknown>;
    const data = root.data;
    if (Array.isArray(data)) return data.filter(isShafuModel);
    if (data && typeof data === "object") {
        const nested = (data as Record<string, unknown>).models;
        if (Array.isArray(nested)) return nested.filter(isShafuModel);
    }
    if (Array.isArray(root.models)) return root.models.filter(isShafuModel);
    return [];
}

function isShafuModel(value: unknown): value is ShafuModel {
    return Boolean(value && typeof value === "object" && typeof (value as Record<string, unknown>).id === "string");
}

function shafuModelCapability(model: ShafuModel): ChannelModel["capability"] {
    const capabilitiesType = typeof model.capabilities?.type === "string" ? model.capabilities.type.toLowerCase() : "";
    if (capabilitiesType === "video") return "video";
    if (capabilitiesType === "image") return "image";
    const endpoints = Array.isArray(model.supported_endpoint_types) ? model.supported_endpoint_types : [];
    if (endpoints.some((endpoint) => typeof endpoint === "string" && /video/i.test(endpoint))) return "video";
    const id = model.id || "";
    if (/^sdf?[-_.]/i.test(id) || /^sd-2\.[025](?:[-_.]|$)/i.test(id)) return "video";
    if (/(?:nano-banana|gpt-image)/i.test(id)) return "image";
    return guessCapability(id);
}

function toProviderCapabilities(value: ShafuModel["capabilities"]): ProviderModelCapabilities {
    const strings = (input: unknown) => Array.isArray(input) ? input.filter((item): item is string => typeof item === "string") : [];
    const numbers = (input: unknown) => Array.isArray(input) ? input.map(Number).filter((item) => Number.isFinite(item) && item > 0) : [];
    return {
        endpoints: strings(value?.endpoints),
        sizes: strings(value?.sizes),
        durations: numbers(value?.durations),
        ...(typeof value?.supports_image_input === "boolean" ? { supportsImageInput: value.supports_image_input } : {}),
        ...(typeof value?.supports_seed === "boolean" ? { supportsSeed: value.supports_seed } : {}),
        ...(typeof value?.async === "boolean" ? { async: value.async } : {}),
    };
}

function ziziImageReferenceField(model: string, count: number) {
    if (/^qwen-image-3\.0(?:$|-pro-(?:1k|2k)$)/i.test(model)) {
        if (count > 3) throw new Error(apiText("ziziImageReferenceLimit", { max: 3 }));
        return "image";
    }
    if (/^omni-nano-pro(?:-2k)?$/i.test(model)) return "reference_images";
    throw new Error(apiText("ziziImageReferenceSchemaUnknown", { model }));
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
