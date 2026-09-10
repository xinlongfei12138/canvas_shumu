import { inferVideoRatio, parseAspectRatio } from "@/lib/media-size";

export const MINIMAX_H3_MP_PRESETS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1, 1.2, 1.5, 1.8, 2] as const;

const H3_RATIOS: Record<string, { width: number; height: number; selectorLabel: string; timelineLabel: string }> = {
    "1:1": { width: 1, height: 1, selectorLabel: "1:1 (Square)", timelineLabel: "1:1 (方形)" },
    "2:3": { width: 2, height: 3, selectorLabel: "2:3 (Portrait Photo)", timelineLabel: "2:3 (竖版照片)" },
    "3:2": { width: 3, height: 2, selectorLabel: "3:2 (Photo)", timelineLabel: "3:2 (横版照片)" },
    "3:4": { width: 3, height: 4, selectorLabel: "3:4 (Portrait Standard)", timelineLabel: "3:4 (竖版标准)" },
    "4:3": { width: 4, height: 3, selectorLabel: "4:3 (Standard)", timelineLabel: "4:3 (标准)" },
    "9:16": { width: 9, height: 16, selectorLabel: "9:16 (Portrait Widescreen)", timelineLabel: "9:16 (竖屏)" },
    "16:9": { width: 16, height: 9, selectorLabel: "16:9 (Widescreen)", timelineLabel: "16:9 (宽屏)" },
    "21:9": { width: 21, height: 9, selectorLabel: "21:9 (Ultrawide)", timelineLabel: "21:9 (超宽)" },
};

const H3_DIRECTOR_TASKS = {
    t2v: "t2v — 文生视频(Text to Video)",
    i2v: "i2v — 图生视频(Image to Video)",
    fl2v: "fl2v — 首尾帧生视频(First-Last Frame)",
    r2v: "r2v — 参考主体生视频(Reference to Video)",
    v2v: "v2v — 视频转视频(Video to Video)",
    rv2v: "rv2v — 参考素材改视频(Reference Material to Video)",
} as const;

type MiniMaxH3TaskKey = keyof typeof H3_DIRECTOR_TASKS;
type ComfyMediaNames = { images: string[]; videos: string[]; audios: string[] };

export type MiniMaxH3Resolution = { ratio: string; megapixels: number; width: number; height: number; refMaxSize: number; selectorLabel: string; timelineLabel: string };

/** Match ComfyUI_MiniMaxH3_Director's ResolutionSelector formula exactly. */
export function computeMiniMaxH3Resolution(megapixels: number, ratio: string, multiple = 32): MiniMaxH3Resolution {
    const normalizedRatio = normalizeRatioKey(ratio);
    const parsed = H3_RATIOS[normalizedRatio];
    const mp = Number.isFinite(megapixels) && megapixels > 0 ? megapixels : 1;
    const scale = Math.sqrt((mp * 1024 * 1024) / (parsed.width * parsed.height));
    const width = Math.max(multiple, Math.round((parsed.width * scale) / multiple) * multiple);
    const height = Math.max(multiple, Math.round((parsed.height * scale) / multiple) * multiple);
    return { ratio: normalizedRatio, megapixels: mp, width, height, refMaxSize: Math.max(width, height), selectorLabel: parsed.selectorLabel, timelineLabel: parsed.timelineLabel };
}

/** Convert the canvas short-edge resolution into the nearest H3 megapixel preset. */
export function canvasResolutionToMiniMaxH3(resolution: string, size: string) {
    const ratio = inferVideoRatio(size) === "auto" ? "16:9" : inferVideoRatio(size);
    const parsed = parseAspectRatio(ratio) || { width: 16, height: 9 };
    const shortEdge = Math.max(1, Number(String(resolution || "720").replace(/p$/i, "")) || 720);
    const landscape = parsed.width >= parsed.height;
    const width = landscape ? (shortEdge * parsed.width) / parsed.height : shortEdge;
    const height = landscape ? shortEdge : (shortEdge * parsed.height) / parsed.width;
    const targetMegapixels = (width * height) / (1024 * 1024);
    const megapixels = MINIMAX_H3_MP_PRESETS.reduce((best, candidate) => Math.abs(candidate - targetMegapixels) < Math.abs(best - targetMegapixels) ? candidate : best, MINIMAX_H3_MP_PRESETS[0]);
    return computeMiniMaxH3Resolution(megapixels, ratio);
}

export function parseComfyWorkflow(value: string) {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("ComfyUI 工作流必须是 API Prompt JSON 对象");
    const nodes = Object.values(parsed);
    if (!nodes.some((node) => node && typeof node === "object" && !Array.isArray(node) && typeof (node as Record<string, unknown>).class_type === "string")) {
        throw new Error("ComfyUI 工作流必须使用“导出（API）”生成的 Prompt JSON");
    }
    return parsed;
}

export function prepareComfyVideoWorkflow(workflow: Record<string, unknown>, prompt: string, duration: number, resolution: MiniMaxH3Resolution, mediaNames: ComfyMediaNames, videoMode: string) {
    const cloned = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
    const result = cloned;
    const hasDirector = Object.values(result).some((node) => isClassType(node, "minimaxh3director"));
    const task = miniMaxH3Task(mediaNames, videoMode);
    if (hasDirector) selectDirectorModelChain(result, task);
    const frameRate = findDirectorFrameRate(result);
    const frameCount = minimaxFrameCount(duration, frameRate);
    rewriteDurationInputNodes(result, duration);
    rewriteDirectMediaNodes(result, mediaNames);
    Object.values(result).forEach((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const item = node as Record<string, unknown>;
        const inputs = item.inputs as Record<string, unknown> | undefined;
        if (!inputs) return;
        const classType = String(item.class_type || "").toLowerCase();
        if (classType.includes("primitivestringmultiline") || classType.includes("prompt")) {
            if ("value" in inputs) inputs.value = prompt;
            if ("global_prompt" in inputs) inputs.global_prompt = prompt;
        }
        if (classType.includes("primitive") && isDurationNode(item) && "value" in inputs) inputs.value = duration;
        if (hasDirector && classType.includes("resolutionselector")) {
            inputs.aspect_ratio = resolution.selectorLabel;
            inputs.megapixels = resolution.megapixels;
            inputs.multiple = 32;
        }
        if (hasDirector && classType.includes("minimaxh3audioconditioning")) inputs.task_type = conditioningTaskType(task);
        if (hasDirector && classType.includes("minimaxh3director")) {
            inputs.task_type = H3_DIRECTOR_TASKS[task];
            inputs.global_prompt = prompt;
            inputs.width = resolution.width;
            inputs.height = resolution.height;
            inputs.ref_max_size = resolution.refMaxSize;
            inputs.total_frames = frameCount;
            if (typeof inputs.timeline_data === "string") inputs.timeline_data = updateTimelineData(inputs.timeline_data, prompt, duration, resolution, frameRate, mediaNames, task);
        }
    });
    return result;
}

function rewriteDurationInputNodes(workflow: Record<string, unknown>, duration: number) {
    const durationNodeIds = new Set<string>();
    Object.values(workflow).forEach((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const item = node as Record<string, unknown>;
        const inputs = item.inputs as Record<string, unknown> | undefined;
        const classType = String(item.class_type || "").toLowerCase();
        if (!inputs || !classType.includes("comfymathexpression")) return;
        const expression = String(inputs.expression || "");
        if (!/(?:duration|length|frame|\b17\b|\b24\b)/i.test(expression)) return;
        Object.values(inputs).forEach((value) => {
            if (Array.isArray(value) && typeof value[0] === "string") durationNodeIds.add(value[0]);
        });
    });
    Object.entries(workflow).forEach(([id, node]) => {
        if (!durationNodeIds.has(id) || !node || typeof node !== "object" || Array.isArray(node)) return;
        const item = node as Record<string, unknown>;
        const inputs = item.inputs as Record<string, unknown> | undefined;
        if (inputs && /primitive/.test(String(item.class_type || "").toLowerCase()) && "value" in inputs) inputs.value = duration;
    });
}

function updateTimelineData(value: string, prompt: string, duration: number, resolution: MiniMaxH3Resolution, frameRate: number, mediaNames: ComfyMediaNames, task: MiniMaxH3TaskKey) {
    try {
        const data = JSON.parse(value) as Record<string, unknown>;
        const totalFrames = minimaxFrameCount(duration, frameRate);
        const visit = (node: unknown, parentKey = ""): unknown => {
            if (Array.isArray(node)) return node.map((item) => visit(item, parentKey));
            if (!node || typeof node !== "object") return node;
            const result: Record<string, unknown> = {};
            Object.entries(node as Record<string, unknown>).forEach(([key, child]) => {
                if (key === "prompt" || key === "globalPrompt") result[key] = prompt;
                else if (["width", "storageWidth"].includes(key) && !isSourceVideoBlock(parentKey)) result[key] = resolution.width;
                else if (["height", "storageHeight"].includes(key) && !isSourceVideoBlock(parentKey)) result[key] = resolution.height;
                else if (["refMaxSize", "longEdge"].includes(key)) result[key] = resolution.refMaxSize;
                else if (key === "megapixels") result[key] = resolution.megapixels;
                else if (key === "aspectRatio") result[key] = resolution.timelineLabel;
                else if (key === "taskType") result[key] = H3_DIRECTOR_TASKS[task];
                else if (["totalFrames", "frameCount", "sourceFrameCount"].includes(key) && !isSourceVideoBlock(parentKey)) result[key] = totalFrames;
                else if (["frameRate", "fps"].includes(key)) result[key] = frameRate;
                else if (key === "durationSec") result[key] = duration;
                else result[key] = visit(child, key);
            });
            return result;
        };
        const updated = visit(data) as Record<string, unknown>;
        rewriteTimelineMedia(updated, prompt, mediaNames, totalFrames, duration, resolution, task);
        return JSON.stringify(updated);
    } catch {
        return value;
    }
}

function rewriteTimelineMedia(data: Record<string, unknown>, prompt: string, mediaNames: ComfyMediaNames, totalFrames: number, duration: number, resolution: MiniMaxH3Resolution, task: MiniMaxH3TaskKey) {
    scrubStaleTimelineMedia(data);
    const imageRefs = mediaNames.images.map((name, index) => ({ index, imageFile: name, fileName: name, type: "input", subfolder: "" }));
    const audioRefs = mediaNames.audios.map((name, index) => ({ index, audioFile: name, fileName: name, type: "input", subfolder: "" }));
    // v2v/rv2v reserve the first uploaded video as the source video. Any
    // remaining videos are ordinary reference videos for the Director.
    const sourceVideoName = task === "v2v" || task === "rv2v" ? mediaNames.videos[0] || "" : "";
    const videoRefs = mediaNames.videos.slice(sourceVideoName ? 1 : 0).map((name, index) => ({ index, videoFile: name, fileName: name, type: "input", subfolder: "" }));
    const emptyVideo = { videoFile: "", fileName: "", subfolder: "", type: "input" };
    const rewriteBlock = (block: Record<string, unknown>) => {
        block.refs = imageRefs.map((item) => ({ ...item }));
        block.refAudios = audioRefs.map((item) => ({ ...item }));
        block.refVideos = videoRefs.map((item) => ({ ...item }));
        block.referenceVideo = videoRefs[0] ? { ...videoRefs[0] } : { ...emptyVideo };
    };
    const global = data.global && typeof data.global === "object" ? data.global as Record<string, unknown> : {};
    rewriteBlock(global);
    global.taskType = H3_DIRECTOR_TASKS[task];
    global.prompt = prompt;
    data.global = global;
    data.timelineMode = task === "fl2v" || task === "v2v" || task === "rv2v" ? task : "prompt_batch";
    data.editMode = task === "v2v" || task === "rv2v" ? "global" : "segment";
    if (data.globalCommon && typeof data.globalCommon === "object") rewriteBlock(data.globalCommon as Record<string, unknown>);
    const segments = Array.isArray(data.segments) ? data.segments : [];
    segments.forEach((segment) => {
        if (!segment || typeof segment !== "object") return;
        const block = segment as Record<string, unknown>;
        rewriteBlock(block);
        block.prompt = global.prompt;
        block.taskType = H3_DIRECTOR_TASKS[task];
        block.frameCount = totalFrames;
        block.length = totalFrames;
        block.durationSec = duration;
    });
    const workspaces = data.videoWorkspaces && typeof data.videoWorkspaces === "object" ? data.videoWorkspaces as Record<string, unknown> : {};
    Object.values(workspaces).forEach((workspace) => {
        if (!workspace || typeof workspace !== "object") return;
        const block = workspace as Record<string, unknown>;
        block.totalFrames = totalFrames;
        block.frameRate = positiveNumber(block.frameRate, 24);
        const workspaceSegments = Array.isArray(block.segments) ? block.segments : [];
        workspaceSegments.forEach((segment) => {
            if (!segment || typeof segment !== "object") return;
            const item = segment as Record<string, unknown>;
            rewriteBlock(item);
            item.prompt = global.prompt;
            item.taskType = H3_DIRECTOR_TASKS[task];
            item.frameCount = totalFrames;
            item.length = totalFrames;
        });
        const sourceVideo = sourceVideoName ? sourceVideoBlock(block.video, sourceVideoName, resolution, totalFrames) : null;
        block.video = sourceVideo || clearSourceVideo(block.video);
        block.videoClips = sourceVideo ? [{ ...sourceVideo, id: sourceVideoId(block.videoClips) }] : [];
    });
    const batchWorkspaces = data.batchWorkspaces && typeof data.batchWorkspaces === "object" ? data.batchWorkspaces as Record<string, unknown> : {};
    Object.values(batchWorkspaces).forEach((workspace) => {
        if (!workspace || typeof workspace !== "object") return;
        const block = workspace as Record<string, unknown>;
        if (block.globalCommon && typeof block.globalCommon === "object") rewriteBlock(block.globalCommon as Record<string, unknown>);
        const workspaceSegments = Array.isArray(block.segments) ? block.segments : [];
        workspaceSegments.forEach((segment) => {
            if (!segment || typeof segment !== "object") return;
            const item = segment as Record<string, unknown>;
            rewriteBlock(item);
            item.prompt = global.prompt;
            item.taskType = H3_DIRECTOR_TASKS[task];
            item.frameCount = totalFrames;
            item.length = totalFrames;
        });
    });
    if (Array.isArray(data.shots)) {
        data.shots = data.shots.map((shot) => {
            if (!shot || typeof shot !== "object") return shot;
            const item = shot as Record<string, unknown>;
            item.startImage = imageRefs[0] ? { imageFile: imageRefs[0].imageFile, imageB64: "", width: resolution.width, height: resolution.height } : {};
            item.endImage = imageRefs[1] ? { imageFile: imageRefs[1].imageFile, imageB64: "", width: resolution.width, height: resolution.height } : {};
            item.prompt = global.prompt;
            item.durationSec = duration;
            return item;
        });
    }
    if (Array.isArray(data.keyframes)) {
        data.keyframes = data.keyframes.map((keyframe, index) => {
            if (!keyframe || typeof keyframe !== "object") return keyframe;
            const item = keyframe as Record<string, unknown>;
            const ref = imageRefs[index];
            item.imageFile = ref?.imageFile || "";
            item.imageB64 = "";
            item.width = ref ? resolution.width : 0;
            item.height = ref ? resolution.height : 0;
            item.prompt = global.prompt;
            item.frameCount = totalFrames;
            item.length = totalFrames;
            return item;
        });
    }
    if (task !== "fl2v") {
        data.shots = [];
        data.keyframes = [];
    }
    const sourceVideo = sourceVideoName ? sourceVideoBlock(data.video, sourceVideoName, resolution, totalFrames) : null;
    data.video = sourceVideo || clearSourceVideo(data.video);
    data.videoClips = sourceVideo ? [{ ...sourceVideo, id: sourceVideoId(data.videoClips) }] : [];
}

function scrubStaleTimelineMedia(value: unknown) {
    if (Array.isArray(value)) {
        value.forEach(scrubStaleTimelineMedia);
        return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    Object.entries(record).forEach(([key, child]) => {
        if (["refs", "refAudios", "ref_audios", "refVideos", "ref_videos", "videoClips"].includes(key)) {
            record[key] = [];
            return;
        }
        if (["referenceVideo", "reference_video"].includes(key)) {
            record[key] = { videoFile: "", fileName: "", subfolder: "", type: "input" };
            return;
        }
        if (["imageFile", "image_file", "imageB64", "image_b64", "audioFile", "audio_file", "videoFile", "video_file"].includes(key)) {
            record[key] = "";
            return;
        }
        scrubStaleTimelineMedia(child);
    });
}

function rewriteDirectMediaNodes(workflow: Record<string, unknown>, mediaNames: ComfyMediaNames) {
    let imageIndex = 0;
    let videoIndex = 0;
    let audioIndex = 0;
    Object.values(workflow).forEach((node) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) return;
        const item = node as Record<string, unknown>;
        const inputs = item.inputs as Record<string, unknown> | undefined;
        if (!inputs) return;
        const classType = String(item.class_type || "").toLowerCase();
        if (classType.includes("loadimage") && ("image" in inputs || "image_file" in inputs || "filename" in inputs)) {
            const key = "image" in inputs ? "image" : "image_file" in inputs ? "image_file" : "filename";
            inputs[key] = mediaNames.images[imageIndex++] || "";
        }
        if ((classType.includes("loadaudio") || classType.includes("loadsound")) && ("audio" in inputs || "audio_file" in inputs || "audio_name" in inputs || "filename" in inputs)) {
            const key = "audio" in inputs ? "audio" : "audio_file" in inputs ? "audio_file" : "audio_name" in inputs ? "audio_name" : "filename";
            inputs[key] = mediaNames.audios[audioIndex++] || "";
        }
        if ((classType.includes("loadvideo") || classType.includes("videoload")) && ("file" in inputs || "video" in inputs || "video_file" in inputs || "video_name" in inputs || "filename" in inputs)) {
            const key = "file" in inputs ? "file" : "video" in inputs ? "video" : "video_file" in inputs ? "video_file" : "video_name" in inputs ? "video_name" : "filename";
            inputs[key] = mediaNames.videos[videoIndex++] || "";
        }
    });
}

function clearSourceVideo(value: unknown) {
    const video = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return { ...video, fileName: "", videoFile: "", frames: [], frameMap: [], sourceFrameCount: 0, width: 0, height: 0, storageWidth: 0, storageHeight: 0 };
}

function sourceVideoBlock(value: unknown, filename: string, resolution: MiniMaxH3Resolution, totalFrames: number) {
    const video = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const width = positiveNumber(video.width, resolution.width);
    const height = positiveNumber(video.height, resolution.height);
    return {
        ...video,
        fileName: filename,
        videoFile: filename,
        subfolder: "",
        type: "input",
        frames: [],
        frameMap: [],
        sourceFrameCount: positiveNumber(video.sourceFrameCount, totalFrames),
        width,
        height,
        storageWidth: positiveNumber(video.storageWidth, width),
        storageHeight: positiveNumber(video.storageHeight, height),
    };
}

function sourceVideoId(value: unknown) {
    if (Array.isArray(value)) {
        const existing = value.find((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") as Record<string, unknown> | undefined;
        if (existing?.id) return existing.id;
    }
    return "comfy-source-video";
}

function isSourceVideoBlock(key: string) {
    return key === "video" || key === "videoClips";
}

function miniMaxH3Task(mediaNames: ComfyMediaNames, videoMode: string): MiniMaxH3TaskKey {
    if (mediaNames.videos.length) return mediaNames.videos.length > 1 || mediaNames.images.length || mediaNames.audios.length ? "rv2v" : "v2v";
    if (videoMode === "frames" && !mediaNames.videos.length && !mediaNames.audios.length) {
        if (mediaNames.images.length === 2) return "fl2v";
        if (mediaNames.images.length === 1) return "i2v";
    }
    return mediaNames.images.length || mediaNames.videos.length || mediaNames.audios.length ? "r2v" : "t2v";
}

/** Pick the model-preparation branch that matches the task selected for this submission. */
function selectDirectorModelChain(workflow: Record<string, unknown>, task: MiniMaxH3TaskKey) {
    const unets = Object.entries(workflow).filter(([, node]) => isClassType(node, "unetloader"));
    if (!unets.length) return;
    const desired = ["r2v", "v2v", "rv2v"].includes(task) ? /ref2va/i : /fl2va/i;
    const selected = unets.find(([, node]) => {
        const inputs = node && typeof node === "object" ? (node as Record<string, unknown>).inputs : undefined;
        return inputs && typeof inputs === "object" && desired.test(String((inputs as Record<string, unknown>).unet_name || ""));
    }) || unets[0];
    const terminal = modelPreparationTerminal(workflow, selected[0]);
    if (!terminal) return;
    Object.values(workflow).forEach((node) => {
        if (!isClassType(node, "minimaxh3director")) return;
        const inputs = (node as Record<string, unknown>).inputs;
        if (inputs && typeof inputs === "object") (inputs as Record<string, unknown>).model = [terminal, 0];
    });
}

function modelPreparationTerminal(workflow: Record<string, unknown>, startId: string) {
    let current = startId;
    const visited = new Set<string>();
    while (!visited.has(current)) {
        visited.add(current);
        const next = Object.entries(workflow).find(([id, node]) => id !== current && isModelPreparationNode(node) && nodeReferences(node, current));
        if (!next) break;
        current = next[0];
    }
    return current;
}

function isModelPreparationNode(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return /reservedvram|memoryefficient|loraloader|modelattention|modelpatch|setnode/i.test(String((value as Record<string, unknown>).class_type || ""));
}

function nodeReferences(value: unknown, nodeId: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const inputs = (value as Record<string, unknown>).inputs;
    if (!inputs || typeof inputs !== "object") return false;
    return Object.values(inputs as Record<string, unknown>).some((input) => Array.isArray(input) && input[0] === nodeId);
}

function conditioningTaskType(task: MiniMaxH3TaskKey) {
    // MiniMaxH3AudioConditioningT8 accepts T2VA/I2VA/FL2VA/L2VA/Ref2VA/Hybrid.
    // Director v2v and rv2v both feed their source video through reference
    // conditioning, so the standalone T8 node must use Ref2VA for both.
    return task === "t2v" ? "T2VA" : task === "i2v" ? "I2VA" : task === "fl2v" ? "FL2VA" : "Ref2VA";
}

function isClassType(value: unknown, className: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return String((value as Record<string, unknown>).class_type || "").toLowerCase().includes(className);
}

function isDurationNode(node: Record<string, unknown>) {
    const meta = node._meta && typeof node._meta === "object" ? node._meta as Record<string, unknown> : {};
    return /duration|seconds|时长/i.test(String(meta.title || ""));
}

function promptFromTimeline(data: Record<string, unknown>, global: Record<string, unknown>) {
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const segment = segments.find((value) => value && typeof value === "object") as Record<string, unknown> | undefined;
    return String(global.prompt || segment?.prompt || "");
}

function findDirectorFrameRate(workflow: Record<string, unknown>) {
    for (const node of Object.values(workflow)) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;
        const item = node as Record<string, unknown>;
        if (String(item.class_type || "").toLowerCase().includes("minimaxh3director")) {
            const inputs = item.inputs as Record<string, unknown> | undefined;
            return positiveNumber(inputs?.frame_rate, 24);
        }
    }
    return 24;
}

function minimaxFrameCount(duration: number, frameRate: number) {
    const raw = Math.max(5, Math.round(Math.max(0.1, duration) * positiveNumber(frameRate, 24)));
    return raw + ((5 - (raw % 17) + 17) % 17);
}

function positiveNumber(value: unknown, fallback: number) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeRatioKey(value: string) {
    const match = String(value || "").match(/^(1:1|2:3|3:2|3:4|4:3|9:16|16:9|21:9)/);
    return match?.[1] || "16:9";
}

export function findComfyVideoOutput(payload: unknown) {
    const found: Array<{ filename: string; subfolder?: string; type?: string; priority: number }> = [];
    const visit = (value: unknown, parentKey = "") => {
        if (Array.isArray(value)) return value.forEach((item) => visit(item, parentKey));
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (record.type !== "input" && typeof record.filename === "string" && /\.(?:mp4|webm|mov|gif)(?:[?#].*)?$/i.test(record.filename)) {
            const extension = record.filename.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1]?.toLowerCase();
            const extensionPriority = extension === "mp4" ? 0 : extension === "webm" ? 1 : extension === "mov" ? 2 : 3;
            const containerPriority = parentKey === "videos" || parentKey === "video" ? 0 : parentKey === "gifs" || parentKey === "gif" ? 1 : 2;
            found.push({ filename: record.filename, subfolder: typeof record.subfolder === "string" ? record.subfolder : "", type: typeof record.type === "string" ? record.type : "output", priority: containerPriority * 10 + extensionPriority });
        }
        Object.entries(record).forEach(([key, child]) => visit(child, key));
    };
    const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    // ComfyUI history contains both inputs and outputs. Only outputs are valid
    // generation results; falling back to the whole record can return a
    // reference video that was uploaded to input.
    visit(root.outputs && typeof root.outputs === "object" ? root.outputs : {});
    found.sort((left, right) => left.priority - right.priority);
    const output = found[0];
    return output ? { filename: output.filename, subfolder: output.subfolder, type: output.type } : null;
}

export function findComfyExecutionError(payload: unknown) {
    const messages = payload && typeof payload === "object" ? (payload as Record<string, unknown>).status : undefined;
    const entries = messages && typeof messages === "object" ? (messages as Record<string, unknown>).messages : undefined;
    if (!Array.isArray(entries)) return "";
    for (const entry of [...entries].reverse()) {
        if (!Array.isArray(entry)) continue;
        const kind = String(entry[0] || "");
        const detail = entry[1] && typeof entry[1] === "object" ? entry[1] as Record<string, unknown> : {};
        if (kind === "execution_interrupted") return `ComfyUI 执行已中断${detail.node_type ? `（${detail.node_type}）` : ""}`;
        if (kind === "execution_error") {
            const message = String(detail.exception_message || detail.message || detail.exception_type || "ComfyUI 节点执行失败");
            return detail.node_type ? `${message}（${detail.node_type}）` : message;
        }
    }
    return "";
}
