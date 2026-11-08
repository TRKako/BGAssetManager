/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { app, IpcMainInvokeEvent } from "electron";
import * as fs from "fs";
import * as path from "path";

const DOMAIN_A = "api.trkako.site";
const DOMAIN_B = "pfp-api-coral.vercel.app";

const URL_MATCH_REGEX = /https?:\/\/(?:api\.trkako\.site|pfp-api-coral\.vercel\.app)\/[^\s"')]+/gi;
const DOMAIN_SWAP_REGEX = /https?:\/\/(api\.trkako\.site|pfp-api-coral\.vercel\.app)/gi;

function getCandidateChatBgPaths(): string[] {
    const appData = process.env.APPDATA || app.getPath("appData");
    const candidates = [
        path.join(appData, "Vencord", "themes", "chatBG.css"),
        path.join(appData, "Vesktop", "themes", "chatBG.css"),
        path.join(appData, "Equicord", "themes", "chatBG.css"),
    ];
    return [...new Set(candidates)];
}

function flipUrlDomain(url: string): string {
    return url.replace(DOMAIN_SWAP_REGEX, (_full, host: string) => {
        const nextHost = host.toLowerCase() === DOMAIN_A ? DOMAIN_B : DOMAIN_A;
        return `https://${nextHost}`;
    });
}

function extractHashFromHeaders(headers: Headers): string | null {
    const directHash = headers.get("x-discord-hash")?.trim();
    if (directHash && directHash !== "null" && directHash !== "undefined") {
        return directHash.toLowerCase();
    }

    const etag = headers.get("etag");
    if (etag) {
        const match = etag.match(/"([^."]+)\.(?:png|webp|gif|jpe?g)/i);
        if (match?.[1]) return match[1].toLowerCase();
    }

    return null;
}

function extractHashFromCdnUrl(cdnUrl?: string | null): string | null {
    if (!cdnUrl) return null;
    const match = cdnUrl.match(/\/(?:banners|avatars|app-icons)\/\d+\/([^./?]+)\./i);
    return match?.[1] ? match[1].toLowerCase() : null;
}

export async function clearElectronHttpCache(event: IpcMainInvokeEvent) {
    try {
        if (event?.sender?.session) {
            await event.sender.session.clearCache();
        }
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

export async function inspectChatBgCss(_event: IpcMainInvokeEvent) {
    try {
        for (const cssPath of getCandidateChatBgPaths()) {
            if (fs.existsSync(cssPath)) {
                const content = fs.readFileSync(cssPath, "utf-8");
                const currentUrls = [...new Set(content.match(URL_MATCH_REGEX) || [])];
                const nextUrls = currentUrls.map(flipUrlDomain);
                return {
                    ok: true,
                    path: cssPath,
                    currentUrls,
                    nextUrls,
                };
            }
        }
        return { ok: false, error: "chatBG.css not found", currentUrls: [], nextUrls: [] };
    } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err), currentUrls: [], nextUrls: [] };
    }
}

export async function swapDomainsInChatBgCss(_event: IpcMainInvokeEvent) {
    try {
        for (const cssPath of getCandidateChatBgPaths()) {
            if (fs.existsSync(cssPath)) {
                const original = fs.readFileSync(cssPath, "utf-8");
                const urlsBefore = [...new Set(original.match(URL_MATCH_REGEX) || [])];

                let swappedCount = 0;
                const updated = original.replace(DOMAIN_SWAP_REGEX, (_full, host: string) => {
                    swappedCount++;
                    const nextHost = host.toLowerCase() === DOMAIN_A ? DOMAIN_B : DOMAIN_A;
                    return `https://${nextHost}`;
                });

                if (swappedCount > 0 && updated !== original) {
                    fs.writeFileSync(cssPath, updated, "utf-8");
                }

                const urlsAfter = [...new Set(updated.match(URL_MATCH_REGEX) || [])];

                return {
                    ok: true,
                    path: cssPath,
                    swappedCount,
                    urlsBefore,
                    urlsAfter,
                };
            }
        }
        return {
            ok: false,
            error: "chatBG.css not found in AppData\\Roaming\\Vencord\\themes\\chatBG.css",
            swappedCount: 0,
            urlsBefore: [],
            urlsAfter: [],
        };
    } catch (err: any) {
        return {
            ok: false,
            error: String(err?.message ?? err),
            swappedCount: 0,
            urlsBefore: [],
            urlsAfter: [],
        };
    }
}

export async function refreshAppCache(
    event: IpcMainInvokeEvent,
    appId: string,
    botUserId?: string | null
) {
    try {
        const idsToRefresh = [...new Set([appId, botUserId].map(id => id?.trim()).filter(Boolean) as string[])];
        const query = new URLSearchParams({ t: String(Date.now()) }).toString();

        const requests: Promise<Response>[] = [];
        for (const id of idsToRefresh) {
            const cleanId = encodeURIComponent(id);
            requests.push(
                fetch(`https://${DOMAIN_A}/api/cache/refresh/${cleanId}?${query}`, {
                    method: "GET",
                    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
                }),
                fetch(`https://${DOMAIN_B}/api/cache/refresh/${cleanId}?${query}`, {
                    method: "GET",
                    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
                })
            );
        }

        const results = await Promise.allSettled(requests);
        const anyOk = results.some(r => r.status === "fulfilled" && r.value.ok);

        if (event?.sender?.session) {
            await event.sender.session.clearCache();
        }

        return { ok: anyOk, status: anyOk ? 200 : 500 };
    } catch (err: any) {
        return { ok: false, status: 0, text: String(err?.message ?? err) };
    }
}

/**
 * Checks the currently served avatarHash and bannerHash from the active URLs in chatBG.css
 * (and falls back to /api/:id?v=new on the active domain).
 */
export async function getServedHashes(
    _event: IpcMainInvokeEvent,
    appId: string,
    botUserId?: string | null,
    activeCssUrls?: string[]
) {
    const ids = [...new Set([appId, botUserId].map(id => id?.trim()).filter(Boolean) as string[])];
    let avatarHash: string | null = null;
    let bannerHash: string | null = null;

    let urlsToCheck = Array.isArray(activeCssUrls) && activeCssUrls.length > 0 ? activeCssUrls : [];
    if (urlsToCheck.length === 0) {
        const inspected = await inspectChatBgCss(_event);
        if (inspected.ok) {
            urlsToCheck = inspected.currentUrls;
        }
    }

    const matchingUrls = urlsToCheck.filter(u => ids.some(id => u.includes(id)));
    let activeDomain = DOMAIN_A;
    if (matchingUrls.some(u => u.toLowerCase().includes(DOMAIN_B))) {
        activeDomain = DOMAIN_B;
    }

    // 1. Check the exact image URLs present in chatBG.css first
    for (const targetUrl of matchingUrls) {
        try {
            const res = await fetch(targetUrl, {
                method: "GET",
                headers: {
                    "Cache-Control": "no-cache",
                    Pragma: "no-cache",
                    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                },
            });
            if (res.ok) {
                const headerHash = extractHashFromHeaders(res.headers);
                if (headerHash) {
                    if (/\/banner\//i.test(targetUrl)) {
                        bannerHash = headerHash;
                    } else if (/\/pfp\//i.test(targetUrl)) {
                        avatarHash = headerHash;
                    }
                }
            }
        } catch {
            // Ignore individual URL errors and fall back to JSON check below
        }
    }

    // 2. Also check /api/:id?v=new on the active domain for any missing hash
    for (const id of ids) {
        if (avatarHash && bannerHash) break;
        try {
            const res = await fetch(`https://${activeDomain}/api/${encodeURIComponent(id)}?v=new&_t=${Date.now()}`, {
                method: "GET",
                headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
            });
            if (res.ok) {
                const data: any = await res.json();
                if (!avatarHash) {
                    avatarHash =
                        (data.avatar ? String(data.avatar).toLowerCase() : null) ||
                        extractHashFromCdnUrl(data.avatarUrl);
                }
                if (!bannerHash) {
                    bannerHash =
                        (data.banner ? String(data.banner).toLowerCase() : null) ||
                        extractHashFromCdnUrl(data.bannerUrl);
                }
            }
        } catch {
            // Ignore transient fetch errors
        }
    }

    return {
        ok: Boolean(avatarHash || bannerHash),
        avatarHash,
        bannerHash,
        activeDomain,
    };
}