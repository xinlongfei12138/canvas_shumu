import { useEffect, type ReactNode } from "react";
import { Input, Slider, Switch } from "antd";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { resolveModelRequestConfig, type AiConfig, type ProviderModelCapabilities } from "@/stores/use-config-store";
import { autoDlVideoRatios, autoDlVideoResolutions, autoDlVideoSecondsRange } from "@/services/api/provider-protocols";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "736", label: "736p" },
    { value: "768", label: "768p" },
    { value: "1080", label: "1080p" },
];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode" | "videoNegativePrompt" | "videoFaceProcessing", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    model?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", model }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const requestConfig = resolveModelRequestConfig(config, model || config.model || config.videoModel);
    const secondsRange = providerVideoSecondsRange(config, model);
    const shafu = requestConfig.apiFormat === "shafu";
    const providerSizes = requestConfig.apiFormat === "shafu" ? requestConfig.providerCapabilities?.sizes || null : null;
    const shafuLegacy = shafu && Boolean(requestConfig.providerCapabilities?.endpoints?.some((endpoint) => /\/v1\/videos\/\{task_id\}/i.test(endpoint)) && !requestConfig.providerCapabilities?.endpoints?.some((endpoint) => /\/v1\/tasks\/\{task_id\}/i.test(endpoint)));
    const providerResolutions = requestConfig.apiFormat === "autodl" ? autoDlVideoResolutions(requestConfig.model) : providerSizes ? providerSizes.map(videoSizeQuality) : null;
    const providerRatios = requestConfig.apiFormat === "autodl" ? autoDlVideoRatios(requestConfig.model) : providerSizes ? providerSizes.map(videoSizeRatio) : null;
    const visibleResolutionOptions = providerResolutions ? resolutionOptionsFromValues(providerResolutions) : resolutionOptions;
    const visibleRatioOptions = providerRatios ? videoRatioOptions.filter((item) => providerRatios.includes(item.value)) : videoRatioOptions;
    const durationOptions = shafu ? requestConfig.providerCapabilities?.durations || null : null;
    const storedResolution = parseVideoResolution(config.vquality);
    const storedRatio = inferVideoRatio(config.size || "auto");
    const resolution = providerResolutions?.includes(storedResolution) ? storedResolution : providerResolutions?.[0] || storedResolution;
    const selectedRatio = providerRatios?.includes(storedRatio) ? storedRatio : providerRatios?.[0] || storedRatio;
    const seconds = durationOptions?.length ? nearestDuration(Number(config.videoSeconds || 6), durationOptions) : clampSeconds(config.videoSeconds || "6", secondsRange);
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const dimensions = readVideoDimensions(config.size || "auto", resolution, selectedRatio);

    useEffect(() => {
        const resolutionChanged = resolution !== storedResolution;
        const ratioChanged = selectedRatio !== storedRatio;
        if (resolutionChanged) onConfigChange("vquality", resolution);
        if (resolutionChanged || ratioChanged) {
            const normalizedSize = providerSizes ? selectProviderSize(providerSizes, resolution, selectedRatio) : computeVideoSize(resolution, selectedRatio);
            if (normalizedSize !== config.size) onConfigChange("size", normalizedSize);
        }
        if (String(seconds) !== String(config.videoSeconds || "6")) onConfigChange("videoSeconds", String(seconds));
    }, [config.size, config.videoSeconds, onConfigChange, resolution, seconds, selectedRatio, storedRatio, storedResolution]);

    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", providerSizes ? selectProviderSize(providerSizes, nextResolution, ratio) : computeVideoSize(nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto") onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {visibleResolutionOptions.map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => selectResolution(item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        {providerResolutions ? null : <ResolutionInput value={resolution} theme={theme} onChange={selectResolution} />}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={Boolean(providerSizes) || selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={Boolean(providerSizes) || selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {visibleRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => applySize(resolution, item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    {durationOptions?.length ? (
                        <div className="grid grid-cols-4 gap-2.5">
                            {durationOptions.map((duration) => (
                                <OptionPill key={duration} selected={seconds === duration} theme={theme} onClick={() => onConfigChange("videoSeconds", String(duration))}>
                                    {duration}s
                                </OptionPill>
                            ))}
                        </div>
                    ) : (
                        <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                            <Slider className="min-w-0 flex-1" min={secondsRange.min} max={secondsRange.max} step={1} value={seconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                            <SecondsInput value={seconds} range={secondsRange} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                            <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                        </div>
                    )}
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2.5">
                        {videoModeOptions.map((item) => (
                            <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                {t(`settingsPanels.video.modes.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {shafuLegacy ? (
                    <>
                        <SettingGroup title={t("settingsPanels.video.negativePrompt")} color={theme.node.muted}>
                            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} value={config.videoNegativePrompt} placeholder={t("settingsPanels.video.negativePromptPlaceholder")} onChange={(event) => onConfigChange("videoNegativePrompt", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                        </SettingGroup>
                        <div className="grid gap-3 text-sm">
                            <label className="flex items-center justify-between gap-3">
                                <span>{t("settingsPanels.video.generateAudio")}</span>
                                <Switch size="small" checked={config.videoGenerateAudio === "true"} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                            </label>
                            <label className="flex items-center justify-between gap-3">
                                <span>{t("settingsPanels.video.faceProcessing")}</span>
                                <Switch size="small" checked={config.videoFaceProcessing === "true"} onChange={(checked) => onConfigChange("videoFaceProcessing", String(checked))} />
                            </label>
                        </div>
                    </>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    return `${parseVideoResolution(value)}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" ? "reference" : "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function SecondsInput({ value, range, theme, onCommit }: { value: number; range: { min: number; max: number }; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = clampSeconds(input.value, range);
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={range.min}
                max={range.max}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function providerVideoSecondsRange(config: AiConfig, model?: string) {
    const requestConfig = resolveModelRequestConfig(config, model || config.model || config.videoModel);
    if (requestConfig.apiFormat === "autodl") return autoDlVideoSecondsRange(requestConfig.model) || { min: 1, max: VIDEO_SECONDS_MAX };
    if (requestConfig.apiFormat === "shafu") {
        const durations = requestConfig.providerCapabilities?.durations;
        if (durations?.length) return { min: Math.min(...durations), max: Math.max(...durations) };
        return { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };
    }
    const lowerModel = requestConfig.model.toLowerCase();
    if (requestConfig.apiFormat === "zizidonghua" && lowerModel.includes("minimax-h3")) {
        if (lowerModel.includes("限时优惠")) return { min: 1, max: 15 };
        return { min: 5, max: lowerModel.includes("480p") ? 10 : 15 };
    }
    return { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };
}

function resolutionOptionsFromValues(values: string[]) {
    return Array.from(new Set(values)).map((value) => ({ value, label: `${value}p` }));
}

function videoSizeQuality(size: string) {
    const [width, height] = size.split("x").map(Number);
    return String(Math.min(width, height));
}

function videoSizeRatio(size: string) {
    const [width, height] = size.split("x").map(Number);
    return nearestVideoRatio(width / height);
}

function nearestVideoRatio(value: number) {
    return videoRatioOptions
        .filter((item) => item.value !== "auto")
        .reduce((best, item) => {
            const ratio = item.width / item.height;
            const bestRatio = best.width / best.height;
            return Math.abs(ratio - value) < Math.abs(bestRatio - value) ? item : best;
        }).value;
}

function selectProviderSize(sizes: string[], resolution: string, ratio: string) {
    const targetRatio = ratio === "auto" ? undefined : videoRatioValue(ratio);
    const sameQuality = sizes.filter((size) => videoSizeQuality(size) === resolution);
    const candidates = sameQuality.length ? sameQuality : sizes;
    return (targetRatio === undefined ? candidates[0] : candidates.reduce((best, size) => Math.abs(videoSizeRatioValue(size) - targetRatio) < Math.abs(videoSizeRatioValue(best) - targetRatio) ? size : best, candidates[0])) || computeVideoSize(resolution, ratio);
}

function videoSizeRatioValue(size: string) {
    const [width, height] = size.split("x").map(Number);
    return width / height;
}

function videoRatioValue(ratio: string) {
    const [width, height] = ratio.split(":").map(Number);
    return width / height;
}

function nearestDuration(value: number, durations: number[]) {
    return durations.reduce((best, duration) => Math.abs(duration - value) < Math.abs(best - value) ? duration : best, durations[0]);
}

function clampSeconds(value: string, range: { min: number; max: number }) {
    const seconds = Math.floor(Number(value) || 6);
    return Math.max(range.min, Math.min(range.max, seconds));
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
