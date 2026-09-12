import i18n from "@/i18n";
import { withLocalProxy, type AiConfig, type ApiCallFormat } from "@/stores/use-config-store";

type AutoDlImageMode = "none" | "frames" | "references";

export type AutoDlWorkflowSpec = {
    id: string;
    prompt: boolean;
    durationField: "duration" | "audio_duration";
    durationMin: number;
    durationMax: number;
    imageMode: AutoDlImageMode;
    imageMin: number;
    imageMax: number;
    audioMin: number;
    audioMax: number;
    resolutions: string[];
};

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);
const resolutionLabels = (qualities: number[], square: boolean) =>
    qualities.flatMap((quality) => [`${quality}p竖`, `${quality}p横`, ...(square ? [`${quality}p(1:1)`] : [])]);

export const AUTODL_WORKFLOW_SPECS: AutoDlWorkflowSpec[] = [
    { id: "minimax_h3_b99_001", prompt: true, durationField: "duration", durationMin: 1, durationMax: 15, imageMode: "none", imageMin: 0, imageMax: 0, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([736], true) },
    { id: "minimax_h3_b99_002", prompt: true, durationField: "duration", durationMin: 1, durationMax: 15, imageMode: "frames", imageMin: 2, imageMax: 2, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([736], true) },
    { id: "minimax_h3_b99_003_12s", prompt: true, durationField: "duration", durationMin: 1, durationMax: 12, imageMode: "references", imageMin: 1, imageMax: 9, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([736], true) },
    { id: "minimax_h3_image_audio_to_video_v2_15s", prompt: true, durationField: "duration", durationMin: 1, durationMax: 15, imageMode: "references", imageMin: 0, imageMax: 9, audioMin: 0, audioMax: 3, resolutions: resolutionLabels([480, 768], false) },
    { id: "minimax_h3_lightx2v_v5_15s", prompt: true, durationField: "duration", durationMin: 1, durationMax: 15, imageMode: "references", imageMin: 1, imageMax: 9, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([480, 768], true) },
    { id: "minimax_h3_image_audio_to_video_v2", prompt: true, durationField: "duration", durationMin: 1, durationMax: 10, imageMode: "references", imageMin: 0, imageMax: 9, audioMin: 0, audioMax: 3, resolutions: resolutionLabels([480, 768, 1080], false) },
    { id: "minimax_h3_image_audio_to_video", prompt: false, durationField: "audio_duration", durationMin: 1, durationMax: 15, imageMode: "references", imageMin: 1, imageMax: 1, audioMin: 1, audioMax: 1, resolutions: resolutionLabels([480, 768, 1080], false) },
    { id: "minimax_h3_lightx2v_v5", prompt: true, durationField: "duration", durationMin: 1, durationMax: 10, imageMode: "references", imageMin: 1, imageMax: 9, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([480, 768, 1080], true) },
    { id: "minimax_h3_lightx2v_no_pic", prompt: true, durationField: "duration", durationMin: 1, durationMax: 15, imageMode: "none", imageMin: 0, imageMax: 0, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([480, 768], true) },
    { id: "minimax_h3_lightx2v", prompt: true, durationField: "duration", durationMin: 1, durationMax: 10, imageMode: "frames", imageMin: 2, imageMax: 2, audioMin: 0, audioMax: 0, resolutions: resolutionLabels([480, 768], true) },
];

export const AUTODL_WORKFLOW_MODELS = AUTODL_WORKFLOW_SPECS.map((workflow) => workflow.id);

export function getAutoDlWorkflowSpec(workflowId: string) {
    return AUTODL_WORKFLOW_SPECS.find((workflow) => workflow.id === workflowId);
}

export function providerApiUrl(baseUrl: string, path: string, options?: { bypassProxy?: boolean }) {
    const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const normalizedPath = `/${path.replace(/^\/+/, "")}`;
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const lowerPath = normalizedPath.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") && lowerPath.startsWith("/v8/") ? normalizedBaseUrl.slice(0, -3) : normalizedBaseUrl;
    const overlappingPrefix = ["/api/v3", "/api/v1", "/v8", "/v1"].find((prefix) => lowerBaseUrl.endsWith(prefix) && (lowerPath === prefix || lowerPath.startsWith(`${prefix}/`)));
    const joinedPath = overlappingPrefix ? normalizedPath.slice(overlappingPrefix.length) : normalizedPath;
    const url = `${apiBaseUrl}${joinedPath}`;
    return options?.bypassProxy ? url : withLocalProxy(url);
}

export function textApiPath(apiFormat: ApiCallFormat) {
    return apiFormat === "zizidonghua" || apiFormat === "shafu" ? "/v1/chat/completions" : "/chat/completions";
}

export function imageApiPath(apiFormat: ApiCallFormat) {
    return apiFormat === "zizidonghua" || apiFormat === "shafu" ? "/v1/images/generations" : "/images/generations";
}

export function autoDlVideoSecondsRange(model: string) {
    const spec = getAutoDlWorkflowSpec(model);
    return spec ? { min: spec.durationMin, max: spec.durationMax } : null;
}

export function autoDlVideoResolutions(model: string) {
    const spec = getAutoDlWorkflowSpec(model);
    if (!spec) return null;
    return Array.from(new Set(spec.resolutions.map((resolution) => resolution.match(/^\d+/)?.[0]).filter((value): value is string => Boolean(value))));
}

export function autoDlVideoRatios(model: string) {
    const spec = getAutoDlWorkflowSpec(model);
    if (!spec) return null;
    return ["auto", "16:9", "9:16", ...(spec.resolutions.some((resolution) => resolution.endsWith("(1:1)")) ? ["1:1"] : [])];
}

export function buildAutoDlVideoBody(config: AiConfig, prompt: string, images: string[], audios: string[]) {
    const spec = getAutoDlWorkflowSpec(config.model);
    if (!spec) throw new Error(apiText("autoDlWorkflowUnknown", { workflow: config.model }));
    if (spec.prompt && !prompt.trim()) throw new Error(apiText("videoPromptRequired"));
    validateAutoDlMediaCount("image", images.length, spec.imageMin, spec.imageMax);
    validateAutoDlMediaCount("audio", audios.length, spec.audioMin, spec.audioMax);

    const duration = Number(config.videoSeconds);
    if (!Number.isInteger(duration) || duration < spec.durationMin || duration > spec.durationMax) {
        throw new Error(apiText("autoDlDurationRange", { min: spec.durationMin, max: spec.durationMax }));
    }

    const body: Record<string, unknown> = {
        [spec.durationField]: duration,
        resolution: resolveAutoDlResolution(spec, config.vquality, config.size),
        ...(spec.prompt ? { prompt: prompt.trim() } : {}),
    };
    if (spec.imageMode === "frames") {
        body.first_frame = images[0];
        body.last_frame = images[1];
    } else if (spec.imageMode === "references") {
        images.forEach((image, index) => {
            body[`ref_image_${index}`] = image;
        });
    }
    audios.forEach((audio, index) => {
        body[`ref_audio_${index}`] = audio;
    });
    return body;
}

function validateAutoDlMediaCount(kind: "image" | "audio", count: number, min: number, max: number) {
    if (count >= min && count <= max) return;
    throw new Error(apiText(kind === "image" ? "autoDlImageCount" : "autoDlAudioCount", { min, max }));
}

function resolveAutoDlResolution(spec: AutoDlWorkflowSpec, qualityValue: string, size: string) {
    const quality = String(qualityValue || "").trim().toLowerCase().replace(/p$/, "");
    const ratio = videoRatio(size);
    if (!["auto", "16:9", "9:16", "1:1"].includes(ratio)) throw new Error(apiText("autoDlRatioUnsupported", { ratio }));
    const defaultResolution = spec.resolutions.find((item) => item.endsWith("竖")) || spec.resolutions[0];
    const selectedQuality = quality === "auto" ? defaultResolution.match(/^\d+/)?.[0] || "" : quality;
    const suffix = ratio === "1:1" ? "(1:1)" : ratio === "16:9" ? "横" : "竖";
    const resolution = `${selectedQuality}p${suffix}`;
    if (!spec.resolutions.includes(resolution)) {
        throw new Error(apiText("autoDlResolutionUnsupported", { resolution, supported: spec.resolutions.join("、") }));
    }
    return resolution;
}

function videoRatio(size: string) {
    const value = String(size || "").trim().toLowerCase();
    if (!value || value === "auto") return "auto";
    const ratioMatch = value.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    const pixelMatch = value.match(/^(\d+)x(\d+)$/);
    const match = ratioMatch || pixelMatch;
    if (!match) return value;
    const width = Number(match[1]);
    const height = Number(match[2]);
    if (Math.abs(width / height - 1) < 0.01) return "1:1";
    if (Math.abs(width / height - 16 / 9) < 0.04) return "16:9";
    if (Math.abs(width / height - 9 / 16) < 0.04) return "9:16";
    return ratioMatch ? value : `${width}:${height}`;
}
