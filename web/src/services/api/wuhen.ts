import axios from "axios";

import i18n from "@/i18n";
import { withLocalProxy, type AiConfig } from "@/stores/use-config-store";
import type { VideoGenerationResult } from "./video";
import { deleteRelayAsset, downloadVideoRelayOutput, prepareVideoRelayOutput, queryVideoRelayOutput, resolvePublicMedia } from "./public-media-upload";

type WuhenEnvelope<T> = { code?: number | string; message?: string; msg?: string; data?: T; error?: unknown };
type WuhenAccessToken = { access_token?: string; expired?: number };
type WuhenCreatedTask = { task_id?: string; id?: string };
type WuhenStatus = { task_id?: string; status?: string; progress?: number; description?: string };

export type WuhenRemovalTask = {
    id: string;
    inputKey?: string;
    outputKey: string;
    outputUrl: string;
};

export type WuhenRemovalState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

let cachedToken: { apiKey: string; baseUrl: string; token: string; expiresAt: number } | null = null;
const text = (key: string) => i18n.t("wuhen." + key);

export function assertWuhenConfig(config: AiConfig) {
    if (!config.wuhenEnabled) throw new Error(text("disabled"));
    if (!config.wuhenBaseUrl.trim()) throw new Error(text("baseUrlRequired"));
    if (!config.wuhenApiKey.trim()) throw new Error(text("apiKeyRequired"));
}

export async function createWuhenRemovalTask(config: AiConfig, source: { name?: string; type?: string; url?: string; storageKey?: string }, signal?: AbortSignal): Promise<WuhenRemovalTask> {
    assertWuhenConfig(config);
    const input = await resolvePublicMedia(source, "video", config, "wuhen", signal);
    let output: Awaited<ReturnType<typeof prepareVideoRelayOutput>> | undefined;
    try {
        output = await prepareVideoRelayOutput(config, signal);
        const token = await getAccessToken(config, signal);
        const payload = await request<WuhenCreatedTask>(config, "/video_removal", token, {
            method: "POST",
            body: {
                video_url: input.url,
                model: config.wuhenModel,
                method: "all_area",
                upload_url: output.uploadUrl,
                upload_headers: output.uploadHeaders,
            },
            signal,
        });
        const id = payload.task_id || payload.id || "";
        if (!id) throw new Error(text("taskIdMissing"));
        return { id, inputKey: input.key, outputKey: output.key, outputUrl: output.url };
    } catch (error) {
        await cleanupWuhenRelayFiles(config, { inputKey: input.key, outputKey: output?.key });
        throw error;
    }
}

export async function pollWuhenRemovalTask(config: AiConfig, task: WuhenRemovalTask, signal?: AbortSignal): Promise<WuhenRemovalState> {
    assertWuhenConfig(config);
    const token = await getAccessToken(config, signal);
    const payload = await request<WuhenStatus>(config, "/status?task_id=" + encodeURIComponent(task.id), token, { signal });
    const status = String(payload.status || "").toLowerCase();
    if (["failed", "error", "cancelled", "canceled"].includes(status)) return { status: "failed", error: payload.description || text("failed") };
    if (["success", "succeeded", "completed"].includes(status)) {
        const output = await queryVideoRelayOutput(config, task.outputKey, signal);
        if (output.ready) {
            const blob = await downloadVideoRelayOutput(config, task.outputKey, signal);
            return { status: "completed", result: { blob, mimeType: blob.type || "video/mp4" } };
        }
    }
    return { status: "pending" };
}

export async function waitForWuhenRemovalTask(config: AiConfig, task: WuhenRemovalTask, signal?: AbortSignal) {
    while (true) {
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
        const state = await pollWuhenRemovalTask(config, task, signal);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") {
            const error = new Error(state.error);
            error.name = "WuhenTaskFailed";
            throw error;
        }
        await delay(2500, signal);
    }
}

export function isWuhenTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "WuhenTaskFailed";
}

export async function cleanupWuhenRelayFiles(config: AiConfig, task: { inputKey?: string; outputKey?: string }) {
    await Promise.allSettled([deleteRelayAsset(config, "asset", task.inputKey), deleteRelayAsset(config, "result", task.outputKey)]);
}

async function getAccessToken(config: AiConfig, signal?: AbortSignal) {
    const now = Math.floor(Date.now() / 1000);
    const baseUrl = normalizeBaseUrl(config.wuhenBaseUrl);
    const apiKey = config.wuhenApiKey.trim();
    if (cachedToken && cachedToken.apiKey === apiKey && cachedToken.baseUrl === baseUrl && cachedToken.expiresAt > now + 60) return cachedToken.token;

    const payload = await request<WuhenAccessToken>(config, "/user/access_token?api_key=" + encodeURIComponent(apiKey), "", { signal, includeAuth: false });
    if (!payload.access_token) throw new Error(text("accessTokenMissing"));
    cachedToken = { apiKey, baseUrl, token: payload.access_token, expiresAt: Number(payload.expired) || now + 300 };
    return payload.access_token;
}

async function request<T>(config: AiConfig, path: string, accessToken: string, options: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal; includeAuth?: boolean; includeCommonParams?: boolean } = {}): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    const commonParams = options.includeCommonParams === false ? "" : separator + "nonce=" + encodeURIComponent(nonce()) + "&t=" + Math.floor(Date.now() / 1000);
    const url = withLocalProxy(normalizeBaseUrl(config.wuhenBaseUrl) + path + commonParams);
    try {
        const response = await axios.request<WuhenEnvelope<T>>({
            url,
            method: options.method || "GET",
            data: options.body,
            signal: options.signal,
            headers: {
                ...(options.includeAuth === false ? {} : { Authorization: "Bearer " + accessToken }),
                ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
            },
        });
        const envelope = response.data;
        if (envelope.code !== undefined && String(envelope.code) !== "0") throw new Error(readError(envelope) || text("requestFailed"));
        if (!envelope.data || typeof envelope.data !== "object") throw new Error(readError(envelope) || text("emptyResponse"));
        return envelope.data;
    } catch (error) {
        if (axios.isCancel(error)) throw new DOMException("Aborted", "AbortError");
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (axios.isAxiosError(error)) throw new Error(readError(error.response?.data) || error.message || text("requestFailed"));
        throw error instanceof Error ? error : new Error(text("requestFailed"));
    }
}

function normalizeBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, "");
}

function nonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function readError(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object") return "";
    const payload = value as { message?: unknown; msg?: unknown; error?: unknown; description?: unknown; data?: unknown };
    return readError(payload.message) || readError(payload.msg) || readError(payload.error) || readError(payload.description) || readError(payload.data);
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        const timer = window.setTimeout(done, ms);
        signal?.addEventListener("abort", abort, { once: true });
        function done() {
            signal?.removeEventListener("abort", abort);
            resolve();
        }
        function abort() {
            window.clearTimeout(timer);
            reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
        }
    });
}
