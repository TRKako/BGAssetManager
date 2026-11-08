/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { applyPalette, GIFEncoder, quantize } from "gifenc";
import { decompressFrames, parseGIF } from "gifuct-js";

const TARGET_ASPECT = 17 / 6;

function createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
}

function flipHorizontal(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(source, 0, 0, w, h);
    return c;
}

function flipVertical(source: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
    const c = createCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.translate(0, h);
    ctx.scale(1, -1);
    ctx.drawImage(source, 0, 0, w, h);
    return c;
}

/**
 * Exact TypeScript/Canvas port of process_frame(frame) from the Python script.
 * Pads an image to 17:6 using tiled mirror-flipped bars on the sides or top/bottom.
 */
export function processFrameTo17By6(source: CanvasImageSource, origW: number, origH: number): HTMLCanvasElement {
    const origAspect = origW / origH;

    if (Math.abs(origAspect - TARGET_ASPECT) < 1e-5) {
        const same = createCanvas(origW, origH);
        same.getContext("2d")!.drawImage(source, 0, 0);
        return same;
    }

    if (origAspect > TARGET_ASPECT) {
        const newW = origW;
        const newH = Math.round(origW / TARGET_ASPECT);
        const padTotal = newH - origH;
        const padTop = Math.floor(padTotal / 2);
        const padBottom = padTotal - padTop;

        const canvas = createCanvas(newW, newH);
        const ctx = canvas.getContext("2d")!;

        ctx.drawImage(source, 0, padTop);

        const flippedV = flipVertical(source, origW, origH);

        // create_top_bar
        let yTop = padTop;
        while (yTop > 0) {
            const h = Math.min(origH, yTop);
            yTop -= h;
            ctx.drawImage(flippedV, 0, origH - h, origW, h, 0, yTop, origW, h);
        }

        // create_bottom_bar
        let yBot = 0;
        while (yBot < padBottom) {
            const h = Math.min(origH, padBottom - yBot);
            ctx.drawImage(flippedV, 0, 0, origW, h, 0, padTop + origH + yBot, origW, h);
            yBot += h;
        }

        return canvas;
    } else {
        const newH = origH;
        const newW = Math.round(origH * TARGET_ASPECT);
        const padTotal = newW - origW;
        const padLeft = Math.floor(padTotal / 2);
        const padRight = padTotal - padLeft;

        const canvas = createCanvas(newW, newH);
        const ctx = canvas.getContext("2d")!;

        ctx.drawImage(source, padLeft, 0);

        const flippedH = flipHorizontal(source, origW, origH);

        // create_left_bar
        let xLeft = padLeft;
        while (xLeft > 0) {
            const w = Math.min(origW, xLeft);
            xLeft -= w;
            ctx.drawImage(flippedH, origW - w, 0, w, origH, xLeft, 0, w, origH);
        }

        // create_right_bar
        let xRight = 0;
        while (xRight < padRight) {
            const w = Math.min(origW, padRight - xRight);
            ctx.drawImage(flippedH, 0, 0, w, origH, padLeft + origW + xRight, 0, w, origH);
            xRight += w;
        }

        return canvas;
    }
}

function uint8ToBase64DataUrl(bytes: Uint8Array, mimeType: string): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
}

async function processAnimatedGif(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const parsedGif = parseGIF(buffer);
    const frames = decompressFrames(parsedGif, true);

    if (!frames || frames.length <= 1) {
        return processStaticImage(file);
    }

    const origW = parsedGif.lsd.width;
    const origH = parsedGif.lsd.height;

    const compCanvas = createCanvas(origW, origH);
    const compCtx = compCanvas.getContext("2d")!;

    const patchCanvas = createCanvas(origW, origH);
    const patchCtx = patchCanvas.getContext("2d")!;

    const encoder = GIFEncoder();

    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const { width, height, top, left } = frame.dims;

        const prevImageData = frame.disposalType === 3
            ? compCtx.getImageData(0, 0, origW, origH)
            : null;

        patchCanvas.width = width;
        patchCanvas.height = height;
        const patchData = new ImageData(new Uint8ClampedArray(frame.patch), width, height);
        patchCtx.putImageData(patchData, 0, 0);

        compCtx.drawImage(patchCanvas, left, top);

        const outCanvas = processFrameTo17By6(compCanvas, origW, origH);
        const outCtx = outCanvas.getContext("2d")!;
        const outImageData = outCtx.getImageData(0, 0, outCanvas.width, outCanvas.height);

        const palette = quantize(outImageData.data, 256, { format: "rgba4444" });
        const index = applyPalette(outImageData.data, palette, "rgba4444");

        const delayMs = Math.max(20, frame.delay || 100);

        encoder.writeFrame(index, outCanvas.width, outCanvas.height, {
            palette,
            delay: delayMs,
            repeat: i === 0 ? 0 : undefined,
        });

        if (frame.disposalType === 2) {
            compCtx.clearRect(left, top, width, height);
        } else if (frame.disposalType === 3 && prevImageData) {
            compCtx.putImageData(prevImageData, 0, 0);
        }
    }

    encoder.finish();
    const bytes = encoder.bytesView();
    return uint8ToBase64DataUrl(bytes, "image/gif");
}

async function processStaticImage(file: File): Promise<string> {
    const dataUrl = await readFileAsDataUrl(file);
    const img = await loadImage(dataUrl);

    const origW = img.naturalWidth || img.width;
    const origH = img.naturalHeight || img.height;

    const processedCanvas = processFrameTo17By6(img, origW, origH);

    const isJpeg = file.type === "image/jpeg" || /\.jpe?g$/i.test(file.name);
    if (isJpeg) {
        const rgbCanvas = createCanvas(processedCanvas.width, processedCanvas.height);
        const rgbCtx = rgbCanvas.getContext("2d")!;
        rgbCtx.fillStyle = "#000000";
        rgbCtx.fillRect(0, 0, rgbCanvas.width, rgbCanvas.height);
        rgbCtx.drawImage(processedCanvas, 0, 0);
        return rgbCanvas.toDataURL("image/jpeg", 0.95);
    }

    return processedCanvas.toDataURL("image/png");
}

export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = e => reject(e);
        img.src = src;
    });
}

export async function processBannerFile(file: File): Promise<string> {
    const isGif = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
    if (isGif) {
        return processAnimatedGif(file);
    }
    return processStaticImage(file);
}
