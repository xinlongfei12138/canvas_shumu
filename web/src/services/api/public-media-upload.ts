import i18n from "@/i18n";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

type MediaKind = "image" | "video" | "audio";
type RelayPurpose = "standard" | "wuhen";
type PublicMediaSource = { id?: string; name?: string; type?: string; url?: string; dataUrl?: string; storageKey?: string };
type RelayResponse = { success?: boolean; key?: unknown; url?: unknown; expires_at?: unknown; error?: unknown; message?: unknown };

export type PublicMediaAsset = { key?: string; url: string; expiresAt?: number };

type UploadCacheEntry = { promise: Promise<PublicMediaAsset>; expiresAt?: number };

const uploadCache = new Map<string, UploadCacheEntry>();
const apiText = (key: string) => i18n.t("publicMediaUpload." + key);

export async function resolvePublicReferenceImage(image: ReferenceImage, config: AiConfig, signal?: AbortSignal) {
    return (await resolvePublicMedia(image, "image", config, "standard", signal)).url;
}

export function resolvePublicMedia(source: PublicMediaSource, kind: MediaKind, config: AiConfig, purpose: RelayPurpose = "standard", signal?: AbortSignal): Promise<PublicMediaAsset> {
    const publicUrl = [source.url, source.dataUrl].find(isPublicUrl);
    if (publicUrl) return Promise.resolve({ url: publicUrl });
    assertRelayConfig(config);

    // Wuhen assets are deleted after the result is stored locally, so their URLs must not be reused.
    if (purpose === "wuhen") return readMediaBlob(source, kind, signal).then((blob) => uploadBlob(blob, source.name, kind, config, purpose, signal));

    const key = [config.publicMediaUploadUrl, purpose, kind, source.storageKey || source.dataUrl || source.url || source.id].join(":");
    const cached = uploadCache.get(key);
    if (cached && (!cached.expiresAt || cached.expiresAt > Date.now())) return cached.promise;
    if (cached) uploadCache.delete(key);
    const upload = readMediaBlob(source, kind, signal).then((blob) => uploadBlob(blob, source.name, kind, config, purpose, signal));
    const entry: UploadCacheEntry = { promise: upload };
    uploadCache.set(key, entry);
    upload
        .then((asset) => {
            if (uploadCache.get(key) !== entry) return;
            entry.expiresAt = asset.expiresAt;
            if (entry.expiresAt && entry.expiresAt <= Date.now()) uploadCache.delete(key);
        })
        .catch(() => {
            if (uploadCache.get(key) === entry) uploadCache.delete(key);
        });
    return upload;
}

export async function prepareVideoRelayOutput(config: AiConfig, signal?: AbortSignal) {
    return relayRequest<{ success?: boolean; key?: unknown; upload_url?: unknown; upload_headers?: unknown; url?: unknown }>(config, "/api/video-relay/prepare", { method: "POST", signal }).then((payload) => {
        const headers = payload.upload_headers && typeof payload.upload_headers === "object" && !Array.isArray(payload.upload_headers) ? (payload.upload_headers as Record<string, string>) : null;
        if (typeof payload.key !== "string" || typeof payload.upload_url !== "string" || typeof payload.url !== "string" || !headers) throw new Error(apiText("invalidResponse"));
        return { key: payload.key, uploadUrl: payload.upload_url, uploadHeaders: headers, url: payload.url };
    });
}

export async function queryVideoRelayOutput(config: AiConfig, key: string, signal?: AbortSignal) {
    return relayRequest<{ ready?: unknown; url?: unknown; size?: unknown }>(config, "/api/video-relay/status?key=" + encodeURIComponent(key), { signal }).then((payload) => ({
        ready: payload.ready === true,
        url: typeof payload.url === "string" ? payload.url : "",
        size: Number(payload.size) || 0,
    }));
}

export async function downloadVideoRelayOutput(config: AiConfig, key: string, signal?: AbortSignal) {
    assertRelayConfig(config);
    const url = relayOrigin(config.publicMediaUploadUrl) + "/api/video-relay/download?key=" + encodeURIComponent(key);
    let response: Response;
    try {
        response = await fetch(url, { signal, headers: { Authorization: "Bearer " + config.publicMediaUploadToken.trim() } });
    } catch (error) {
        if (isAbortError(error, signal)) throw error;
        throw new Error(apiText("failed"));
    }
    if (!response.ok) {
        const responseText = await response.text();
        let message = responseText.trim();
        try {
            message = readRelayError(JSON.parse(responseText) as RelayResponse) || message;
        } catch {
            // Keep a non-JSON server error as-is.
        }
        throw new Error(message || apiText("failed"));
    }
    const blob = await response.blob();
    if (!blob.size || !matchesKind(blob.type, "video")) throw new Error(apiText("invalidMedia"));
    return blob;
}

export async function deleteRelayAsset(config: AiConfig, kind: "asset" | "result", key?: string) {
    if (!key) return;
    const path = kind === "asset" ? "/api/assets/delete" : "/api/video-relay/delete";
    await relayRequest(config, path, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
}

export function assertRelayConfig(config: AiConfig) {
    if (!config.publicMediaUploadEnabled) throw new Error(apiText("disabled"));
    if (!config.publicMediaUploadUrl.trim()) throw new Error(apiText("urlRequired"));
    if (!config.publicMediaUploadToken.trim()) throw new Error(apiText("tokenRequired"));
}

async function readMediaBlob(source: PublicMediaSource, kind: MediaKind, signal?: AbortSignal) {
    throwIfAborted(signal);
    let blob: Blob | null = null;
    try {
        if (source.storageKey) blob = kind === "image" ? await getImageBlob(source.storageKey) : await getMediaBlob(source.storageKey);
    } catch {
        throw new Error(apiText("readFailed"));
    }
    if (!blob) {
        const url = source.dataUrl || source.url || "";
        if (!url) throw new Error(apiText("readFailed"));
        try {
            const response = await fetch(url, { signal });
            if (!response.ok) throw new Error();
            blob = await response.blob();
        } catch (error) {
            if (isAbortError(error, signal)) throw error;
            throw new Error(apiText("readFailed"));
        }
    }
    if (!blob.size || (!matchesKind(blob.type, kind) && !matchesKind(source.type || "", kind))) throw new Error(apiText("invalidMedia"));
    return blob;
}

async function uploadBlob(blob: Blob, name: string | undefined, kind: MediaKind, config: AiConfig, purpose: RelayPurpose, signal?: AbortSignal): Promise<PublicMediaAsset> {
    const body = new FormData();
    body.append("file", blob, name || "reference-" + kind + "." + defaultExtension(kind));
    body.append("purpose", purpose);
    const payload = await relayRequest<RelayResponse>(config, "", { method: "POST", body, signal }, true);
    if (typeof payload.url !== "string" || !isPublicUrl(payload.url)) throw new Error(apiText("missingUrl"));
    const expiresAt = typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : NaN;
    return {
        key: typeof payload.key === "string" ? payload.key : undefined,
        url: payload.url,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
    };
}

async function relayRequest<T extends object>(config: AiConfig, path: string, init: RequestInit = {}, directUpload = false): Promise<T> {
    assertRelayConfig(config);
    const url = directUpload ? config.publicMediaUploadUrl.trim() : relayOrigin(config.publicMediaUploadUrl) + path;
    let response: Response;
    try {
        response = await fetch(url, { ...init, headers: { Authorization: "Bearer " + config.publicMediaUploadToken.trim(), ...init.headers } });
    } catch (error) {
        if (isAbortError(error, init.signal as AbortSignal | undefined)) throw error;
        throw new Error(apiText("failed"));
    }
    const text = await response.text();
    let payload: RelayResponse & T;
    try {
        payload = JSON.parse(text) as RelayResponse & T;
    } catch {
        throw new Error(text.trim() || apiText("failed"));
    }
    if (!response.ok || payload.success === false) throw new Error(readRelayError(payload) || apiText("failed"));
    return payload;
}

function relayOrigin(uploadUrl: string) {
    try {
        return new URL(uploadUrl.trim()).origin;
    } catch {
        throw new Error(apiText("urlInvalid"));
    }
}

function readRelayError(payload: RelayResponse) {
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.error === "string") return payload.error;
    if (payload.error && typeof payload.error === "object" && "message" in payload.error) return String((payload.error as { message?: unknown }).message || "");
    return "";
}

function matchesKind(type: string, kind: MediaKind) {
    return type.toLowerCase().startsWith(kind + "/");
}

function defaultExtension(kind: MediaKind) {
    return kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3";
}

function isPublicUrl(value: unknown): value is string {
    return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isAbortError(error: unknown, signal?: AbortSignal) {
    return Boolean(signal?.aborted) || (error instanceof DOMException && error.name === "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}
