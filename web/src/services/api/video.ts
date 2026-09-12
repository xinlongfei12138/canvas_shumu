import axios from "axios";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio } from "@/lib/media-size";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, resolveModelWorkflowJson, withLocalProxy, type AiConfig, type ProviderModelCapabilities } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import { buildAutoDlVideoBody, providerApiUrl } from "./provider-protocols";
import { resolvePublicMedia, resolvePublicReferenceImage } from "./public-media-upload";
import { canvasResolutionToMiniMaxH3, findComfyExecutionError, findComfyVideoOutput, parseComfyWorkflow, prepareComfyVideoWorkflow } from "./comfyui";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = { id: string; task_id?: string; status?: string; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };
type VideoMediaOptions = RequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };
type ShafuRequestConfig = AiConfig & { providerCapabilities?: ProviderModelCapabilities };
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
const providerText = (key: string, options?: Record<string, unknown>) => i18n.t(`providerErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoTaskProvider = "openai" | "gemini" | "volcengine" | "zizidonghua" | "autodl" | "comfyui" | "canvasvideo" | "shafu" | "plugin";
export type VideoGenerationTask = { id: string; provider: VideoTaskProvider; model: string; shafuProtocol?: "unified" | "legacy" };
type GeminiInlineData = { bytesBase64Encoded: string; mimeType: string };
type GeminiVideoOperation = {
    name?: string;
    done?: boolean;
    error?: { message?: string };
    response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> } };
};
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: Pick<AiConfig, "apiKey">, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

export async function waitForVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationResult> {
    // H3 workflows run locally and can take longer than hosted APIs, especially
    // on the first request while the model is loaded into VRAM. Keep the task
    // id resumable instead of turning a still-running ComfyUI job into a false
    // timeout after the generic five-minute window.
    const isComfyUi = task.provider === "comfyui";
    const maxAttempts = isComfyUi ? 540 : 120;
    const pollIntervalMs = isComfyUi ? 5000 : 2500;
    let transientErrors = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        let state: VideoGenerationTaskState;
        try {
            state = await pollVideoGenerationTask(config, task, options);
            transientErrors = 0;
        } catch (error) {
            if (!isComfyUi || !isRetryableComfyPollError(error) || transientErrors >= 5) throw error;
            // A tunnel/proxy can briefly drop a request while ComfyUI keeps
            // running. Retry with a bounded backoff and preserve task.id.
            transientErrors += 1;
            await delay(Math.min(15000, pollIntervalMs * transientErrors), options?.signal);
            continue;
        }
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw videoTaskFailed(state.error);
        if (attempt === maxAttempts - 1) throw new Error(apiText("videoTimeout", { provider: isComfyUi ? "ComfyUI " : "" }));
        await delay(pollIntervalMs, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: isComfyUi ? "ComfyUI " : "" }));
}

function isRetryableComfyPollError(error: unknown) {
    if (axios.isCancel(error)) return false;
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        return !status || status === 408 || status === 425 || status === 429 || status >= 500;
    }
    if (error instanceof DOMException && error.name === "AbortError") return false;
    // readAxiosError intentionally presents network failures as a short
    // localized message, so retain the task for that fallback as well.
    const message = error instanceof Error ? error.message : String(error);
    return /请求失败|任务查询失败|下载失败|network|timeout|fetch/i.test(message);
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

function videoTaskFailed(message: string) {
    const error = new Error(message);
    error.name = "VideoTaskFailed";
    return error;
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (requestConfig.apiFormat === "gemini") return createGeminiVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (requestConfig.apiFormat === "volcengine") return createVolcengineVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (requestConfig.apiFormat === "zizidonghua") return createZiziVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (requestConfig.apiFormat === "autodl") return createAutoDlVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (requestConfig.apiFormat === "comfyui") return createComfyUiVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (requestConfig.apiFormat === "canvasvideo") return createCanvasVideoTask(requestConfig, selectedModel, prompt, references, options);
    if (requestConfig.apiFormat === "shafu") return createShafuVideoTask(requestConfig, selectedModel, prompt, references, options);
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "gemini") return pollGeminiVideoTask(requestConfig, task, options);
    if (task.provider === "volcengine") return pollVolcengineVideoTask(requestConfig, task, options);
    if (task.provider === "zizidonghua") return pollZiziVideoTask(requestConfig, task, options);
    if (task.provider === "autodl") return pollAutoDlVideoTask(requestConfig, task, options);
    if (task.provider === "comfyui") return pollComfyUiVideoTask(requestConfig, task, options);
    if (task.provider === "canvasvideo") return pollCanvasVideoTask(requestConfig, task, options);
    if (task.provider === "shafu") return pollShafuVideoTask(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            videos,
            audios,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds),
                size: normalizeVideoSize(config.size, config.vquality),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: videoAspectRatio(config.size),
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
                mode: resolveVideoMode(config.videoMode, refs.length),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const geeknow = isGeeknowChannel(config);
    const images = geeknow ? [] : await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    const videos = geeknow ? [] : await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = geeknow ? [] : await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, references.length);
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    body.append("size", normalizeVideoSize(config.size, config.vquality) || "1280x720");
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("generate_audio", String(boolConfig(config.videoGenerateAudio, true)));
    body.append("watermark", String(boolConfig(config.videoWatermark, false)));
    body.append("mode", mode);
    if (geeknow && (references.length || options?.videos?.length || options?.audios?.length)) {
        const imageUrls = await Promise.all(references.map((image) => resolvePublicReferenceImage(image, config, options?.signal)));
        const videoUrls = await Promise.all((options?.videos || []).map((video) => resolvePublicMedia(video, "video", config, "standard", options?.signal).then((asset) => asset.url)));
        const audioUrls = await Promise.all((options?.audios || []).map((audio) => resolvePublicMedia(audio, "audio", config, "standard", options?.signal).then((asset) => asset.url)));
        if (mode === "frames") {
            if (imageUrls[0]) body.append("first_frame", imageUrls[0]);
            if (imageUrls[1]) body.append("last_frame", imageUrls[1]);
        } else {
            imageUrls.forEach((url) => body.append("image[]", url));
        }
        videoUrls.forEach((url) => body.append("video[]", url));
        audioUrls.forEach((url) => body.append("audio[]", url));
    } else {
        if (mode === "frames") {
            if (images[0]) body.append("first_frame", images[0], "first.png");
            if (images[1]) body.append("last_frame", images[1], "last.png");
        } else {
            images.forEach((file) => body.append("image[]", file, "ref.png"));
        }
        videos.forEach((file) => body.append("video[]", file));
        audios.forEach((file) => body.append("audio[]", file));
    }
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createVolcengineVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    if (references.length || options?.videos?.length || options?.audios?.length) throw new Error(apiText("volcengineVideoReferencesUnsupported"));
    const resolution = normalizeVideoResolution(config.vquality);
    if (!["480p", "720p", "1080p"].includes(resolution)) throw new Error(apiText("volcengineResolutionUnsupported", { resolution }));
    try {
        const payload = (await axios.post<unknown>(
            providerApiUrl(config.baseUrl, "/contents/generations/tasks"),
            {
                model: modelOptionName(model),
                content: [{ type: "text", text: prompt.trim() }],
                generate_audio: boolConfig(config.videoGenerateAudio, true),
                ratio: volcengineVideoRatio(config.size),
                duration: Number(rawVideoSeconds(config.videoSeconds)),
                resolution,
                watermark: boolConfig(config.videoWatermark, false),
            },
            { headers: aiHeaders(config, "application/json"), signal: options?.signal },
        )).data;
        const id = taskIdFromPayload(payload);
        if (!id) throw new Error(readApiErrorMessage(payload) || apiText("noVideoTaskId"));
        return { id, provider: "volcengine", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollVolcengineVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/contents/generations/tasks/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = statusFromPayload(payload);
        const url = findVideoUrl(payload);
        if (status === "succeeded" && url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (["failed", "expired", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readApiErrorMessage(payload) || apiText("videoGenerationFailed") };
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createZiziVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const videoReferences = options?.videos || [];
    const audioReferences = options?.audios || [];
    buildZiziVideoBody(config, prompt, references.map((_, index) => "https://placeholder.invalid/reference-" + index), videoReferences.map((_, index) => "https://placeholder.invalid/video-" + index), audioReferences.map((_, index) => "https://placeholder.invalid/audio-" + index));
    const videoUrls = await Promise.all(videoReferences.map((video) => resolvePublicMedia(video, "video", config, "standard", options?.signal).then((asset) => asset.url)));
    const audioUrls = await Promise.all(audioReferences.map((audio) => resolvePublicMedia(audio, "audio", config, "standard", options?.signal).then((asset) => asset.url)));
    const imageSources = await Promise.all(references.map((image) => resolvePublicReferenceImage(image, config, options?.signal)));
    const body = buildZiziVideoBody(config, prompt, imageSources, videoUrls, audioUrls);
    try {
        const payload = (await axios.post<unknown>(providerApiUrl(config.baseUrl, "/v8/videos/generations"), body, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data;
        const id = taskIdFromPayload(payload);
        if (!id) throw new Error(readApiErrorMessage(payload) || apiText("noVideoTaskId"));
        return { id, provider: "zizidonghua", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollZiziVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/v8/videos/generations/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = statusFromPayload(payload);
        const url = findVideoUrl(payload);
        if (["completed", "success", "succeeded"].includes(status) && url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (["failed", "expired", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readApiErrorMessage(payload) || apiText("videoGenerationFailed") };
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createAutoDlVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (options?.videos?.length) throw new Error(apiText("autoDlVideoReferencesUnsupported"));
    const audioReferences = options?.audios || [];
    buildAutoDlVideoBody(config, prompt, references.map((_, index) => `https://placeholder.invalid/reference-${index}`), audioReferences.map((_, index) => `https://placeholder.invalid/audio-${index}`));
    const audios = await Promise.all(audioReferences.map((audio) => referenceAudioToAutoDlValue(audio, options)));
    const images = await Promise.all(references.map((image) => resolvePublicReferenceImage(image, config, options?.signal)));
    const body = buildAutoDlVideoBody(config, prompt, images, audios);
    try {
        const payload = (await axios.post<unknown>(providerApiUrl(config.baseUrl, `/api/v1/comfyui/comfyui_workflow/${encodeURIComponent(config.model)}`), body, { headers: autoDlHeaders(config), signal: options?.signal })).data;
        const id = taskIdFromPayload(payload);
        if (!id) throw new Error(readApiErrorMessage(payload) || apiText("noVideoTaskId"));
        return { id, provider: "autodl", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

function isGeeknowChannel(config: Pick<AiConfig, "baseUrl">) {
    try {
        return new URL(config.baseUrl).hostname.toLowerCase().endsWith("geeknow.top");
    } catch {
        return config.baseUrl.toLowerCase().includes("geeknow");
    }
}

async function createComfyUiVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const workflowJson = resolveModelWorkflowJson(config, model);
    if (!workflowJson) throw new Error("ComfyUI 模型尚未绑定 API Prompt 工作流 JSON，请在模型配置中添加工作流");
    const workflow = parseComfyWorkflow(workflowJson);
    const images = await Promise.all(references.map(async (image) => uploadComfyMedia(config, dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, { ...options, bypassProxy: true }) }), "image", options)));
    const videos = await Promise.all((options?.videos || []).map(async (video) => uploadComfyMedia(config, await referenceMediaToFile(video, "reference-video.mp4", "invalidReferenceVideo", options), "video", options)));
    const audios = await Promise.all((options?.audios || []).map(async (audio) => uploadComfyMedia(config, await referenceMediaToFile(audio, "reference-audio.mp3", "invalidReferenceAudio", options), "audio", options)));
    const resolution = canvasResolutionToMiniMaxH3(config.vquality, config.size);
    const body = prepareComfyVideoWorkflow(workflow, prompt.trim(), Number(rawVideoSeconds(config.videoSeconds)), resolution, { images, videos, audios }, config.videoMode);
    try {
        const payload = (await axios.post<{ prompt_id?: string; number?: number; error?: unknown }>(providerApiUrl(config.baseUrl, "/prompt", { bypassProxy: true }), { prompt: body }, { headers: comfyHeaders(config), signal: options?.signal })).data;
        const id = payload.prompt_id || (typeof payload.number === "number" ? String(payload.number) : "");
        if (!id) throw new Error(readApiErrorMessage(payload.error) || apiText("noVideoTaskId"));
        return { id, provider: "comfyui", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollComfyUiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/history/${encodeURIComponent(task.id)}`, { bypassProxy: true }), { headers: comfyHeaders(config), signal: options?.signal })).data;
        const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[task.id] : undefined;
        if (!record) return { status: "pending" };
        const status = record && typeof record === "object" ? (record as Record<string, unknown>).status : undefined;
        const statusString = status && typeof status === "object" ? String((status as Record<string, unknown>).status_str || "") : String(status || "");
        if (/error|failed|cancel/i.test(statusString)) return { status: "failed", error: findComfyExecutionError(record) || readApiErrorMessage(record) || apiText("videoGenerationFailed") };
        const output = findComfyVideoOutput(record);
        if (!output) {
            const completed = Boolean(record && typeof record === "object" && (record as Record<string, unknown>).status && typeof (record as Record<string, unknown>).status === "object" && ((record as Record<string, unknown>).status as Record<string, unknown>).completed);
            return completed ? { status: "failed", error: "ComfyUI 任务已完成，但工作流没有输出可下载的视频" } : { status: "pending" };
        }
        const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || "", type: output.type || "output" });
        const response = await axios.get<Blob>(providerApiUrl(config.baseUrl, `/view?${params.toString()}`, { bypassProxy: true }), { headers: comfyHeaders(config), responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { status: "completed", result: { blob: normalizeComfyVideoBlob(response.data, output.filename) } };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function uploadComfyMedia(config: AiConfig, file: File, kind: "image" | "video" | "audio", options?: RequestOptions) {
    const chunkSize = 1024 * 1024;
    if (kind === "video") return uploadComfyChunkedMedia(config, file, "/minimax/director/upload_chunk", "ComfyUI 视频分片上传失败", "reference-video.mp4", options, chunkSize);
    if (kind === "audio") return uploadComfyChunkedMedia(config, file, "/minimax/director/upload_chunk", "ComfyUI 音频分片上传失败", "reference-audio.mp3", options, chunkSize);
    if (file.size > chunkSize) return uploadComfyChunkedMedia(config, file, "/minimax/director/upload_chunk", "ComfyUI 图片分片上传失败", "reference-image.png", options, chunkSize);
    const body = new FormData();
    // Small images use ComfyUI's core route. Larger images use Director's
    // generic chunk route so Cloudflare never has to proxy one large body.
    body.append("image", file, file.name || `reference.${kind}`);
    body.append("type", "input");
    body.append("overwrite", "false");
    try {
        const response = await axios.post<unknown>(providerApiUrl(config.baseUrl, "/upload/image", { bypassProxy: true }), body, { headers: comfyHeaders(config), signal: options?.signal });
        const uploaded = comfyUploadResponse(response.data);
        if (!uploaded) throw new Error("ComfyUI 上传接口未返回可用文件名");
        return uploaded;
    } catch (error) {
        throw new Error(readAxiosError(error, "ComfyUI 参考素材上传失败"));
    }
}

function normalizeComfyVideoBlob(blob: Blob, filename: string) {
    if (blob.type.startsWith("video/")) return blob;
    const extension = filename.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
    const mimeType = extension === "webm" ? "video/webm" : extension === "mov" ? "video/quicktime" : extension === "gif" ? "image/gif" : "video/mp4";
    return new Blob([blob], { type: mimeType });
}

async function uploadComfyChunkedMedia(config: AiConfig, file: File, endpoint: string, errorMessage: string, fallbackName: string, options?: RequestOptions, chunkSize = 8 * 1024 * 1024) {
    const uploadId = nanoid();
    const filename = safeComfyFilename(file.name || fallbackName);
    const totalChunks = Math.ceil(file.size / chunkSize);
    for (let index = 0; index < totalChunks; index += 1) {
        const body = new FormData();
        body.append("upload_id", uploadId);
        body.append("chunk_index", String(index));
        body.append("total_chunks", String(totalChunks));
        body.append("filename", filename);
        body.append("chunk", file.slice(index * chunkSize, Math.min((index + 1) * chunkSize, file.size)), filename + ".part");
        try {
            const response = await axios.post<unknown>(providerApiUrl(config.baseUrl, endpoint, { bypassProxy: true }), body, { headers: comfyHeaders(config), signal: options?.signal });
            const uploaded = comfyUploadResponse(response.data);
            if (uploaded) return uploaded;
        } catch (error) {
            throw new Error(readAxiosError(error, `${errorMessage}（${index + 1}/${totalChunks}）`));
        }
    }
    throw new Error(errorMessage.replace(/失败$/, "") + "未返回文件名");
}

function safeComfyFilename(value: string) {
    const basename = value.replace(/[\\/]/g, "_").replace(/[^\u4e00-\u9fffA-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
    return basename || "reference-video.mp4";
}

function comfyHeaders(config: Pick<AiConfig, "apiKey">) {
    return config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : undefined;
}

function comfyUploadedPath(upload: { name?: string; filename?: string; path?: string; file?: string; subfolder?: string }, fallback: string) {
    const path = String(upload.path || upload.file || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    const rawName = upload.name || upload.filename || (path ? path.split("/").pop() : "") || fallback;
    const name = String(rawName).replace(/^\/+|\/+$/g, "");
    const pathWithoutName = path && path.endsWith("/" + name) ? path.slice(0, -name.length - 1) : "";
    let subfolder = String(upload.subfolder || pathWithoutName).replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    for (const prefix of ["input/", "output/", "temp/"]) {
        if (subfolder.toLowerCase().startsWith(prefix)) {
            subfolder = subfolder.slice(prefix.length);
            break;
        }
    }
    return subfolder ? subfolder + "/" + name : name;
}

function comfyUploadResponse(value: unknown): string {
    const visit = (item: unknown, depth: number): string => {
        if (depth > 4 || !item) return "";
        if (typeof item === "string") return item.trim();
        if (Array.isArray(item)) {
            for (const child of item) {
                const result = visit(child, depth + 1);
                if (result) return result;
            }
            return "";
        }
        if (typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        const nameKey = ["name", "filename", "path", "file"].find((key) => typeof record[key] === "string" && record[key]);
        if (nameKey) {
            const result = comfyUploadedPath({ name: record.name as string | undefined, filename: record.filename as string | undefined, path: record.path as string | undefined, file: record.file as string | undefined, subfolder: record.subfolder as string | undefined }, "");
            if (result) return result;
        }
        for (const child of Object.values(record)) {
            const result = visit(child, depth + 1);
            if (result) return result;
        }
        return "";
    };
    const result = visit(value, 0);
    return /\.(?:png|jpe?g|webp|gif|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|m4a|flac)$/i.test(result) ? result : "";
}

async function createCanvasVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const videos = options?.videos || [];
    const audios = options?.audios || [];
    const publicImages = references.map(publicImageUrl);
    const publicVideos = videos.map((video) => publicMediaUrl(video.url));
    const publicAudios = audios.map((audio) => publicMediaUrl(audio.url));
    const publicCount = [...publicImages, ...publicVideos, ...publicAudios].filter(Boolean).length;
    const mediaCount = references.length + videos.length + audios.length;
    if (publicCount > 0 && publicCount < mediaCount) throw new Error(i18n.t("providerErrors.canvasVideoMixedReferencesUnsupported"));

    const ratio = inferVideoRatio(config.size);
    const resolution = String(config.vquality || "").trim().toLowerCase();
    const fields: CanvasVideoFields = {
        model: modelOptionName(model),
        prompt: prompt.trim(),
        seconds: Number(rawVideoSeconds(config.videoSeconds)),
        ...(ratio === "auto" ? {} : { aspect_ratio: ratio }),
        ...(resolution === "auto" || !resolution ? {} : { resolution: normalizeVideoResolution(config.vquality) }),
    };
    let body: Record<string, unknown> | FormData;
    if (publicCount === mediaCount) {
        body = buildCanvasVideoJsonBody(fields, publicImages as string[], publicVideos as string[], publicAudios as string[], config.videoMode);
    } else {
        const imageFiles = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, options) })));
        const videoFiles = await Promise.all(videos.map((video) => referenceMediaToFile(video, "reference-video.mp4", "invalidReferenceVideo", options)));
        const audioFiles = await Promise.all(audios.map((audio) => referenceMediaToFile(audio, "reference-audio.mp3", "invalidReferenceAudio", options)));
        body = buildCanvasVideoFormData(fields, imageFiles, videoFiles, audioFiles, config.videoMode);
    }

    try {
        const payload = (await axios.post<unknown>(providerApiUrl(config.baseUrl, "/v1/videos"), body, {
            headers: aiHeaders(config, body instanceof FormData ? undefined : "application/json"),
            signal: options?.signal,
        })).data;
        if (canvasVideoOk(payload) === false) throw new Error(readApiErrorMessage(payload) || apiText("videoTaskCreateFailed"));
        const id = taskIdFromPayload(payload);
        if (!id) throw new Error(readApiErrorMessage(payload) || apiText("noVideoTaskId"));
        return { id, provider: "canvasvideo", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollCanvasVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/v1/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = statusFromPayload(payload);
        const url = findVideoUrl(payload);
        if (["succeeded", "completed"].includes(status) && url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (["succeeded", "completed"].includes(status)) return { status: "failed", error: apiText("noPlayableVideo") };
        if (status === "failed" || canvasVideoOk(payload) === false) return { status: "failed", error: canvasVideoFailureMessage(payload) };
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createShafuVideoTask(config: ShafuRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (isLegacyShafuProtocol(config, model)) return createLegacyShafuVideoTask(config, model, prompt, references, options);
    return createUnifiedShafuVideoTask(config, model, prompt, references, options);
}

async function createUnifiedShafuVideoTask(config: ShafuRequestConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    const modelName = modelOptionName(model);
    const videos = options?.videos || [];
    const audios = options?.audios || [];
    const duration = Number(rawVideoSeconds(config.videoSeconds));
    const aspectRatio = videoAspectRatio(config.size);
    const size = normalizeVideoSize(config.size, config.vquality);
    const referenceMode = references.length && resolveVideoMode(config.videoMode, references.length) === "frames" ? "frame" : "image";
    validateShafuVideoRequest(config, modelName, prompt, duration, aspectRatio, referenceMode, references.length, videos.length, audios.length);
    if (references.length && config.providerCapabilities?.supportsImageInput === false) throw new Error(providerText("shafuImageInputUnsupported"));

    const { images, videoValues, audioValues } = await resolveShafuReferenceValues(references, videos, audios, options);

    const requestId = `canvas-${nanoid()}`;
    const fields = {
        model: modelName,
        prompt: prompt.trim(),
        // DOC 03 / VIDEO uses a numeric duration. A string can make the
        // NewAPI adapter fail while decoding its Alias.duration field.
        duration,
        ...(aspectRatio !== "16:9" || config.size !== "auto" ? { aspect_ratio: aspectRatio } : {}),
        ...(config.providerCapabilities?.sizes?.length && size ? { size } : {}),
        generate_audio: boolConfig(config.videoGenerateAudio, false),
        reference_mode: referenceMode,
        ...(config.videoNegativePrompt.trim() ? { negative_prompt: config.videoNegativePrompt.trim() } : {}),
        ...shafuFaceProcessingField(modelName, config.videoFaceProcessing),
        idempotency_key: requestId,
    };
    const body: Record<string, unknown> = {
        ...fields,
        ...(images.length === 1 && referenceMode === "image" ? { input_reference: images[0] } : images.length ? { images } : {}),
        ...(videoValues.length ? { reference_videos: videoValues } : {}),
        ...(audioValues.length ? { reference_audios: audioValues } : {}),
        metadata: { idempotency_key: requestId },
    };
    try {
        const payload = (await axios.post<unknown>(providerApiUrl(config.baseUrl, "/v1/videos"), body, {
            headers: { ...aiHeaders(config, "application/json"), "Idempotency-Key": requestId },
            signal: options?.signal,
        })).data;
        const id = taskIdFromPayload(payload);
        if (!id) throw new Error(readApiErrorMessage(payload) || apiText("noVideoTaskId"));
        return { id, provider: "shafu", model, shafuProtocol: "unified" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function createLegacyShafuVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const videos = options?.videos || [];
    const audios = options?.audios || [];
    const duration = Number(rawVideoSeconds(config.videoSeconds));
    const aspectRatio = videoAspectRatio(config.size);
    const hasReferences = references.length + videos.length + audios.length > 0;
    const referenceMode = hasReferences && resolveVideoMode(config.videoMode, references.length) === "frames" ? "frame" : "image";
    validateShafuVideoRequest(config, modelName, prompt, duration, aspectRatio, referenceMode, references.length, videos.length, audios.length);

    const fields = {
        model: modelName,
        prompt: prompt.trim(),
        duration,
        aspect_ratio: aspectRatio,
        generate_audio: boolConfig(config.videoGenerateAudio, false),
        reference_mode: referenceMode,
        ...(config.videoNegativePrompt.trim() ? { negative_prompt: config.videoNegativePrompt.trim() } : {}),
        ...shafuFaceProcessingField(modelName, config.videoFaceProcessing),
        idempotency_key: `canvas-${nanoid()}`,
    };

    const { images, videoValues, audioValues } = await resolveShafuReferenceValues(references, videos, audios, options);
    const body: Record<string, unknown> = {
        ...fields,
        ...(images.length ? { images } : {}),
        ...(videoValues.length ? { reference_videos: videoValues } : {}),
        ...(audioValues.length ? { reference_audios: audioValues } : {}),
    };

    try {
        const payload = (await axios.post<unknown>(providerApiUrl(config.baseUrl, "/v1/videos"), body, {
            headers: aiHeaders(config, "application/json"),
            signal: options?.signal,
        })).data;
        const id = taskIdFromPayload(payload);
        if (!id) throw new Error(readApiErrorMessage(payload) || apiText("noVideoTaskId"));
        return { id, provider: "shafu", model, shafuProtocol: "legacy" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollShafuVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.shafuProtocol === "unified" || (!task.shafuProtocol && !isLegacyShafuProtocol(config, task.model))) return pollUnifiedShafuVideoTask(config, task, options);
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/v1/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = statusFromPayload(payload);
        if (["failed", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readApiErrorMessage(payload) || apiText("videoGenerationFailed") };
        if (!["completed", "succeeded", "success"].includes(status)) return { status: "pending" };
        return { status: "completed", result: await shafuCompletedVideo(config, task, findVideoUrl(payload), options) };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function pollUnifiedShafuVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/v1/tasks/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), signal: options?.signal })).data;
        const status = statusFromPayload(payload);
        if (["failed", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readApiErrorMessage(payload) || apiText("videoGenerationFailed") };
        if (!["completed", "succeeded", "success"].includes(status)) return { status: "pending" };
        const url = findVideoUrl(payload);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        const fileId = findMediaFileId(payload);
        if (fileId) return { status: "completed", result: await videoResultFromUrl(providerApiUrl(config.baseUrl, `/v1/files/${encodeURIComponent(fileId)}/content`), options, config) };
        return { status: "failed", error: apiText("noPlayableVideo") };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function shafuCompletedVideo(config: AiConfig, task: VideoGenerationTask, resultUrl: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    if (resultUrl) {
        try {
            const response = await axios.get<Blob>(withLocalProxy(resultUrl), { responseType: "blob", signal: options?.signal });
            await assertVideoBlob(response.data);
            return { blob: response.data };
        } catch (error) {
            if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        }
    }
    try {
        const response = await axios.get<Blob>(providerApiUrl(config.baseUrl, `/v1/videos/${encodeURIComponent(task.id)}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (resultUrl) return { url: resultUrl, mimeType: "video/mp4" };
        throw error;
    }
}

function validateShafuVideoRequest(config: ShafuRequestConfig, model: string, prompt: string, duration: number, aspectRatio: string, referenceMode: "frame" | "image", imageCount: number, videoCount: number, audioCount: number) {
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    const fixedSeedance = /^(?:sd|sdf)-(?:480p|720p|1080p)$/i.test(model);
    if (fixedSeedance && (!Number.isInteger(duration) || duration < 4 || duration > 15)) throw new Error(providerText("shafuDurationRange"));
    if (fixedSeedance && !["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(aspectRatio)) throw new Error(providerText("shafuRatioUnsupported", { ratio: aspectRatio }));
    const supportedDurations = config.providerCapabilities?.durations || [];
    if (!fixedSeedance && supportedDurations.length && !supportedDurations.includes(duration)) throw new Error(providerText("shafuDurationUnsupported", { duration, supported: supportedDurations.join("、") }));
    if (!Number.isInteger(duration) || duration <= 0) throw new Error(providerText("shafuDurationUnsupported", { duration, supported: supportedDurations.length ? supportedDurations.join("、") : "服务器支持的整数时长" }));
    if (referenceMode === "frame") {
        if (imageCount < 1 || imageCount > 2) throw new Error(i18n.t("providerErrors.shafuFrameImageCount"));
        if (videoCount || audioCount) throw new Error(i18n.t("providerErrors.shafuFrameMediaUnsupported"));
        return;
    }
    if (imageCount > 9) throw new Error(i18n.t("providerErrors.shafuImageCount"));
    if (videoCount > 3) throw new Error(i18n.t("providerErrors.shafuVideoCount"));
    if (audioCount > 3) throw new Error(i18n.t("providerErrors.shafuAudioCount"));
}

function isLegacyShafuProtocol(config: ShafuRequestConfig, model = config.model) {
    const endpoints = config.providerCapabilities?.endpoints || [];
    // The documented /v1/videos flow is the compatibility path for models whose
    // account metadata does not advertise the newer /v1/tasks endpoint.
    // The server-side Seedance 2.5 variants are also compatible with this flow.
    return /2[._-]?5/i.test(model) || !endpoints.some((endpoint) => /\/v1\/tasks\/\{task_id\}/i.test(endpoint));
}

function findMediaFileId(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    for (const key of ["file_id", "fileId"]) {
        if (typeof root[key] === "string" && root[key]) return root[key] as string;
    }
    for (const key of ["result", "data", "content"]) {
        const value = root[key];
        const id = findMediaFileId(value);
        if (id) return id;
    }
    return "";
}

function validateShafuImage(file: File) {
    if (file.size > 24 * 1024 * 1024) throw new Error(i18n.t("providerErrors.shafuImageTooLarge", { name: file.name }));
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type.toLowerCase())) throw new Error(i18n.t("providerErrors.shafuImageFormatUnsupported", { name: file.name }));
}

function shafuFaceProcessingField(model: string, enabled: string) {
    return /^sd-720p-933$/i.test(model.trim()) ? {} : { face_processing: boolConfig(enabled, false) };
}

async function resolveShafuReferenceValues(references: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[], options?: RequestOptions) {
    const images = await Promise.all(references.map(async (image) => {
        const publicUrl = publicImageUrl(image);
        if (publicUrl) return publicUrl;
        const dataUrl = await imageToDataUrl(image, options);
        validateShafuImage(dataUrlToFile({ ...image, dataUrl }));
        return dataUrl;
    }));
    const videoValues = await Promise.all(videos.map((video) => shafuMediaValue(video, "reference-video.mp4", "invalidReferenceVideo", options)));
    const audioValues = await Promise.all(audios.map((audio) => shafuMediaValue(audio, "reference-audio.mp3", "invalidReferenceAudio", options)));
    return { images, videoValues, audioValues };
}

async function shafuMediaValue(item: ReferenceVideo | ReferenceAudio, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    if (isPublicMediaUrl(item.url)) return item.url;
    return readFileAsDataUrl(await referenceMediaToFile(item, fallbackName, errorKey, options));
}

async function pollAutoDlVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<unknown>(providerApiUrl(config.baseUrl, `/api/v1/comfyui/comfyui_workflow/result/${encodeURIComponent(task.id)}`), { headers: autoDlHeaders(config, false), signal: options?.signal })).data;
        const status = statusFromPayload(payload);
        const url = findAutoDlVideoUrl(payload);
        if (["success", "completed", "succeeded"].includes(status) && url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (["failed", "expired", "cancelled", "canceled"].includes(status)) return { status: "failed", error: readApiErrorMessage(payload) || apiText("videoGenerationFailed") };
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        return { status: "pending" };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function videoResultFromUrl(url: string, options?: RequestOptions, config?: Pick<AiConfig, "apiKey">): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(withLocalProxy(url), { headers: config ? aiHeaders(config) : undefined, responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        return { url, mimeType: "video/mp4" };
    }
}

function validateUnifiedShafuSpec(capabilities: ProviderModelCapabilities | undefined, duration: number, size: string | null) {
    if (capabilities?.durations?.length && !capabilities.durations.includes(duration)) throw new Error(providerText("shafuDurationUnsupported", { duration, supported: capabilities.durations.join("、") }));
    if (size && capabilities?.sizes?.length && !capabilities.sizes.includes(size)) throw new Error(providerText("shafuSizeUnsupported", { size, supported: capabilities.sizes.join("、") }));
}

async function createGeminiVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    const images = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", "invalidReferenceVideo", options)));
    const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", "invalidReferenceAudio", options)));
    const mode = resolveVideoMode(config.videoMode, images.length);
    const instance: Record<string, unknown> = { prompt };
    if (mode === "frames") {
        if (images[0]) instance.image = parseDataUrlInline(images[0]);
        if (images[1]) instance.lastFrame = parseDataUrlInline(images[1]);
    } else {
        instance.referenceImages = images.map((dataUrl) => ({ image: parseDataUrlInline(dataUrl), referenceType: "asset" }));
    }
    if (videos[0]) instance.video = await fileToGeminiInline(videos[0]);
    if (audios[0]) instance.audio = await fileToGeminiInline(audios[0]);
    try {
        const created = unwrapEnvelope((await axios.post<ApiEnvelope<GeminiVideoOperation>>(geminiVideoUrl(config, model, "predictLongRunning"), {
            instances: [instance],
            parameters: {
                aspectRatio: videoAspectRatio(config.size),
                durationSeconds: Number(normalizeVideoSeconds(config.videoSeconds)) || 8,
                resolution: normalizeVideoResolution(config.vquality),
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                addWatermark: boolConfig(config.videoWatermark, false),
            },
        }, { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("noVideoTask"));
        if (!created.name) throw new Error(apiText("noVideoTaskId"));
        return { id: created.name, provider: "gemini", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollGeminiVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapEnvelope((await axios.get<ApiEnvelope<GeminiVideoOperation>>(geminiOperationUrl(config, task.id), { headers: geminiVideoHeaders(config), signal: options?.signal })).data, apiText("videoTaskQueryFailed"));
        if (state.error) return { status: "failed", error: readApiErrorMessage(state.error.message) || apiText("videoGenerationFailed") };
        if (!state.done) return { status: "pending" };
        const uri = state.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
        if (!uri) return { status: "failed", error: apiText("noPlayableVideo") };
        const url = uri.includes("key=") ? uri : `${uri}${uri.includes("?") ? "&" : "?"}key=${config.apiKey}`;
        return { status: "completed", result: await videoResultFromUrl(url, options) };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (config.apiFormat !== "comfyui" && !config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
}

function geminiVideoBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiVideoUrl(config: Pick<AiConfig, "baseUrl">, model: string, action: string) {
    return withLocalProxy(`${geminiVideoBaseUrl(config)}/models/${encodeURIComponent(modelOptionName(model).replace(/^models\//, ""))}:${action}`);
}

function geminiOperationUrl(config: Pick<AiConfig, "baseUrl">, name: string) {
    return withLocalProxy(`${geminiVideoBaseUrl(config)}/${name.replace(/^\//, "")}`);
}

function geminiVideoHeaders(config: Pick<AiConfig, "apiKey">) {
    return { "x-goog-api-key": config.apiKey, "Content-Type": "application/json" };
}

function videoAspectRatio(size: string) {
    const ratio = inferVideoRatio(size);
    return ratio === "auto" ? "16:9" : ratio;
}

function parseDataUrlInline(dataUrl: string, fallbackType = "image/png"): GeminiInlineData {
    const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return { bytesBase64Encoded: match?.[2] || "", mimeType: match?.[1] || fallbackType };
}

async function fileToGeminiInline(file: File): Promise<GeminiInlineData> {
    return parseDataUrlInline(await readFileAsDataUrl(file), file.type || "application/octet-stream");
}

async function referenceMediaToFile(item: { name: string; type?: string; url?: string; storageKey?: string }, fallbackName: string, errorKey: "invalidReferenceVideo" | "invalidReferenceAudio", options?: RequestOptions) {
    let blob = item.storageKey ? await getMediaBlob(item.storageKey) : null;
    if (!blob) {
        const url = item.storageKey ? await resolveMediaUrl(item.storageKey, item.url || "") : item.url || "";
        if (!url) throw new Error(apiText(errorKey));
        try {
            blob = await (await fetch(url, { signal: options?.signal })).blob();
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") throw error;
            throw new Error(apiText(errorKey));
        }
    }
    if (!blob.size) throw new Error(apiText(errorKey));
    return new File([blob], item.name || fallbackName, { type: item.type || blob.type || "application/octet-stream" });
}

async function referenceAudioToAutoDlValue(audio: ReferenceAudio, options?: RequestOptions) {
    if (isPublicMediaUrl(audio.url)) return audio.url;
    const file = await referenceMediaToFile(audio, "reference-audio.mp3", "invalidReferenceAudio", options);
    const mimeType = autoDlAudioMimeType(file);
    if (!mimeType) throw new Error(i18n.t("providerErrors.autoDlReferenceAudioFormatUnsupported", { format: file.type || i18n.t("providerErrors.unknownMediaFormat") }));
    return readFileAsDataUrl(file.type === mimeType ? file : new File([file], file.name, { type: mimeType }));
}

function autoDlAudioMimeType(file: File) {
    const type = file.type.toLowerCase();
    const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (type === "audio/mpeg" || extension === "mp3") return "audio/mpeg";
    if (["audio/wav", "audio/x-wav"].includes(type) || extension === "wav") return "audio/wav";
    if (["audio/mp4", "audio/m4a", "audio/x-m4a"].includes(type) || extension === "m4a" || extension === "mp4") return "audio/mp4";
    if (["audio/flac", "audio/x-flac"].includes(type) || extension === "flac") return "audio/flac";
    return "";
}

function publicImageUrl(image: ReferenceImage) {
    return [image.url, image.dataUrl].find((value) => isPublicMediaUrl(value || ""));
}

function publicMediaUrl(value?: string) {
    return isPublicMediaUrl(value || "") ? value : undefined;
}

type CanvasVideoFields = { model: string; prompt: string; aspect_ratio?: string; seconds: number; resolution?: string };

function buildCanvasVideoJsonBody(fields: CanvasVideoFields, images: string[], videos: string[], audios: string[], videoMode?: string) {
    const body: Record<string, unknown> = { ...fields };
    const mode = resolveVideoMode(videoMode, images.length);
    if (mode === "frames") {
        if (images[0]) body.first_frame_url = images[0];
        if (images[1]) body.last_frame_url = images[1];
    } else if (images.length) {
        body.reference_image_urls = images;
    }
    if (videos.length) body.reference_videos = videos;
    if (audios.length) body.reference_audios = audios;
    return body;
}

function buildCanvasVideoFormData(fields: CanvasVideoFields, images: File[], videos: File[], audios: File[], videoMode?: string) {
    const body = new FormData();
    Object.entries(fields).forEach(([key, value]) => {
        if (value !== undefined) body.append(key, String(value));
    });
    const mode = resolveVideoMode(videoMode, images.length);
    if (mode === "frames") {
        if (images[0]) body.append("first_frame_image", images[0]);
        if (images[1]) body.append("last_frame_image", images[1]);
    } else {
        images.forEach((file) => body.append("reference_images", file));
    }
    videos.forEach((file) => body.append("reference_videos", file));
    audios.forEach((file) => body.append("reference_audios", file));
    return body;
}

function buildZiziVideoBody(config: AiConfig, prompt: string, images: string[], videos: string[], audios: string[]) {
    const model = config.model.trim();
    const lowerModel = model.toLowerCase();
    const duration = Number(rawVideoSeconds(config.videoSeconds));
    if (lowerModel.includes("限时优惠")) return buildZiziPromoH3Body(config, prompt, images, videos, audios, duration);
    if (!prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    if (audios.length) throw new Error(apiText("ziziAudioModelSchemaUnknown", { model }));

    const h3 = lowerModel.includes("minimax-h3");
    if (h3) {
        const max = lowerModel.includes("480p") ? 10 : 15;
        if (!Number.isInteger(duration) || duration < 5 || duration > max) throw new Error(apiText("ziziDurationRange", { min: 5, max }));
        if (videos.length && !lowerModel.includes("-video")) throw new Error(apiText("ziziVideoReferenceModelRequired"));
    }
    const mode = resolveVideoMode(config.videoMode, images.length);
    const referenceImages = images.map((image, index) => ziziImageReference(image, mode === "frames" ? (index === 0 ? "first_frame" : "last_frame") : "reference_image"));
    const body: Record<string, unknown> = {
        model,
        prompt: prompt.trim(),
        duration,
        resolution: normalizeVideoSize(config.size, config.vquality) || undefined,
        aspect_ratio: videoAspectRatio(config.size),
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
        ...(videos.length ? { reference_videos: videos.map((url) => ({ url, role: "reference_video" })) } : {}),
    };
    if (h3) {
        body.mode = referenceImages.length || videos.length ? (mode === "frames" && !videos.length ? "fl2v" : "ref2v") : "t2v";
        body.generate_audio = boolConfig(config.videoGenerateAudio, true);
        delete body.resolution;
    }
    return body;
}

function buildZiziPromoH3Body(config: AiConfig, prompt: string, images: string[], videos: string[], audios: string[], duration: number) {
    const model = config.model.trim();
    const lowerModel = model.toLowerCase();
    if (!Number.isInteger(duration) || duration < 1 || duration > 15) throw new Error(apiText("ziziDurationRange", { min: 1, max: 15 }));
    if (videos.length) throw new Error(apiText("ziziPromoVideoUnsupported"));
    const lipSync = lowerModel.includes("对口型");
    if (!lipSync && !prompt.trim()) throw new Error(apiText("videoPromptRequired"));

    let imageRoles: Array<"first_frame" | "last_frame" | "reference_image"> = [];
    let imageMin = 0;
    let imageMax = 0;
    let audioMin = 0;
    let audioMax = 0;
    if (lowerModel.includes("首尾帧")) {
        imageMin = 1; imageMax = 2; imageRoles = ["first_frame", "last_frame"];
    } else if (lowerModel.includes("多参考图生")) {
        imageMin = 1; imageMax = 9; imageRoles = Array(9).fill("reference_image");
    } else if (lowerModel.includes("多图多音频")) {
        imageMin = 1; imageMax = 9; audioMin = 1; audioMax = 3; imageRoles = Array(9).fill("reference_image");
    } else if (lipSync) {
        imageMin = 1; imageMax = 1; audioMin = 1; audioMax = 1; imageRoles = ["reference_image"];
    } else if (!lowerModel.includes("文生")) {
        throw new Error(apiText("ziziVideoModelSchemaUnknown", { model }));
    }
    validateMediaCount(images.length, imageMin, imageMax, "ziziImageCount");
    validateMediaCount(audios.length, audioMin, audioMax, "ziziAudioCount");
    const ratio = ziziPromoRatio(config.size);
    return {
        model,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        duration,
        ...(ratio ? { aspect_ratio: ratio } : {}),
        ...(images.length ? { reference_images: images.map((image, index) => ziziImageReference(image, imageRoles[index] || "reference_image")) } : {}),
        ...(audios.length ? { reference_audios: audios.map((url) => ({ url })) } : {}),
    };
}

function validateMediaCount(count: number, min: number, max: number, key: "ziziImageCount" | "ziziAudioCount") {
    if (count >= min && count <= max) return;
    throw new Error(apiText(key, { min, max }));
}

function ziziImageReference(value: string, role: "first_frame" | "last_frame" | "reference_image") {
    if (/^https?:\/\//i.test(value)) return { url: value, role };
    const match = value.match(/^data:[^;]+;base64,(.+)$/);
    if (match?.[1]) return { base64: match[1], role };
    throw new Error(apiText("referenceImageReadFailed"));
}

function ziziPromoRatio(size: string) {
    const ratio = inferVideoRatio(size);
    if (ratio === "auto") return undefined;
    if (ratio === "1:1") throw new Error(apiText("ziziPromoRatioUnsupported"));
    const parts = ratio.split(":").map(Number);
    return parts[0] > parts[1] ? "horizontal" : "vertical";
}

function volcengineVideoRatio(size: string) {
    const ratio = inferVideoRatio(size);
    return ratio === "auto" ? undefined : ratio;
}

function rawVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, seconds));
}

function autoDlHeaders(config: Pick<AiConfig, "apiKey">, json = true) {
    return { Authorization: config.apiKey, ...(json ? { "Content-Type": "application/json" } : {}) };
}

function taskIdFromPayload(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : undefined;
    return [root.id, root.task_id, root.taskId, data?.id, data?.task_id, data?.taskId].find((value) => typeof value === "string" && value) as string | undefined || "";
}

function statusFromPayload(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : undefined;
    const status = [root.status, data?.status].find((value) => typeof value === "string");
    return String(status || "").toLowerCase();
}

function findVideoUrl(payload: unknown): string {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    for (const key of ["video_url", "result_url", "url"]) {
        const value = root[key];
        if (typeof value === "string" && value) return value;
    }
    for (const key of ["content", "data", "result", "metadata"]) {
        const value = root[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                const url = findVideoUrl(item);
                if (url) return url;
            }
        } else {
            const url = findVideoUrl(value);
            if (url) return url;
        }
    }
    return "";
}

function findAutoDlVideoUrl(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    const root = payload as Record<string, unknown>;
    const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : undefined;
    const results = Array.isArray(data?.results) ? data.results : Array.isArray(root.results) ? root.results : [];
    const video = results.find((item) => item && typeof item === "object" && ((item as Record<string, unknown>).type === "video" || (item as Record<string, unknown>).file_type === "mp4")) as Record<string, unknown> | undefined;
    return typeof video?.url === "string" ? video.url : "";
}

function canvasVideoFailureMessage(payload: unknown) {
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : {};
    const refunded = root.refunded && typeof root.refunded === "object" ? root.refunded as Record<string, unknown> : {};
    const message = readApiErrorMessage(data.error) || readApiErrorMessage(data.upstream_error) || readApiErrorMessage(root.error) || readApiErrorMessage(root.message) || apiText("videoGenerationFailed");
    const cents = Number(refunded.refunded_cents);
    return Number.isFinite(cents) && cents > 0 && !/退|refund/i.test(message)
        ? i18n.t("providerErrors.canvasVideoRefunded", { message, amount: (cents / 100).toFixed(2) })
        : message;
}

function canvasVideoOk(payload: unknown) {
    return payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).ok === "boolean"
        ? (payload as Record<string, unknown>).ok as boolean
        : undefined;
}

function normalizeVideoSeconds(value: string) {
    return clampVideoSeconds(value);
}

function resolveVideoMode(mode: string | undefined, imageCount: number) {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function normalizeVideoSize(value: string, resolution?: string) {
    if (value === "auto") return null;
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value || "16:9");
    if (ratio === "auto") return null;
    return computeVideoSize(resolution || "720", ratio);
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown; upstream_error?: unknown; data?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.upstream_error) ||
        readApiErrorMessage(payload.detail) ||
        readApiErrorMessage(payload.data) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
