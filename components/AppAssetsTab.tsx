/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { showNotification } from "@api/Notifications";
import ErrorBoundary from "@components/ErrorBoundary";
import { ModalContent, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { PluginNative } from "@utils/types";
import { React, RestAPI, useEffect, useRef, useState } from "@webpack/common";

import { settings } from "../index";
import { processBannerFile, readFileAsDataUrl } from "../utils/bannerProcessor";

function getNativeHelper(): PluginNative<typeof import("../native")> | undefined {
    const helpers = VencordNative.pluginHelpers as Record<string, any>;
    return helpers.BGAssetManager ?? helpers["BG Asset Manager"];
}

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/gif", "image/jpeg", "image/webp"]);
const DEFAULT_DISCORD_ICON = "https://cdn.discordapp.com/embed/avatars/0.png";

const REFRESH_ATTEMPTS = 5;
const REFRESH_INTERVAL_MS = 3000;

interface DevApplicationInfo {
    id: string;
    name: string;
    icon?: string | null;
    bot?: {
        id: string;
        username: string;
        avatar?: string | null;
        banner?: string | null;
    };
}

function getExistingIconUrl(app: DevApplicationInfo | null): string {
    if (!app) return DEFAULT_DISCORD_ICON;
    if (app.bot?.avatar) {
        const ext = app.bot.avatar.startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/avatars/${app.bot.id}/${app.bot.avatar}.${ext}?size=512`;
    }
    if (app.icon) {
        const ext = app.icon.startsWith("a_") ? "gif" : "png";
        return `https://cdn.discordapp.com/app-icons/${app.id}/${app.icon}.${ext}?size=512`;
    }
    return DEFAULT_DISCORD_ICON;
}

function getExistingBannerUrl(app: DevApplicationInfo | null): string | null {
    if (!app?.bot?.banner) return null;
    const ext = app.bot.banner.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/banners/${app.bot.id}/${app.bot.banner}.${ext}?size=1024`;
}

function notify(body: string, isError = false) {
    showNotification({
        title: "BG Asset Manager",
        body,
        color: isError ? "var(--status-danger, #f23f43)" : "var(--brand-500, #5865f2)",
        noPersist: true
    });
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function flipDomainInText(text: string): string {
    return text.replace(
        /https?:\/\/(api\.trkako\.site|pfp-api-coral\.vercel\.app)/gi,
        (_full, host: string) => {
            const nextHost = host.toLowerCase() === "api.trkako.site"
                ? "pfp-api-coral.vercel.app"
                : "api.trkako.site";
            return `https://${nextHost}`;
        }
    );
}

function extractHashFromCdnUrl(cdnUrl?: string | null): string | null {
    if (!cdnUrl) return null;
    const match = cdnUrl.match(/\/(?:banners|avatars|app-icons)\/\d+\/([^./?]+)\./i);
    return match?.[1] ? match[1].toLowerCase() : null;
}

/**
 * Forces Blink/Chromium to evict a URL from its in-memory MemoryCache and HTTP cache.
 */
async function evictAndReloadUrlsInChromium(urls: string[]) {
    if (!urls.length) return;
    const uniqueUrls = [...new Set(urls)];

    await Promise.allSettled(
        uniqueUrls.flatMap(targetUrl => [
            fetch(targetUrl, {
                method: "GET",
                cache: "reload",
                mode: "no-cors",
                headers: {
                    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
                }
            }),
            fetch(targetUrl, {
                method: "GET",
                cache: "reload",
                mode: "cors",
                headers: {
                    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
                    "X-Force-Refresh": "1"
                }
            })
        ])
    );
}

/**
 * Reloads any <link rel="stylesheet" href*="chatBG.css"> or inline <style> tags in the live DOM
 */
function forceDomThemeRefresh() {
    document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(link => {
        const href = link.getAttribute("href") || "";
        if (/chatbg\.css/i.test(href) || /themes/i.test(href)) {
            const baseHref = href.split("?")[0];
            link.setAttribute("href", `${baseHref}?v=${Date.now()}`);
        }
    });

    document.querySelectorAll("style").forEach(styleEl => {
        const text = styleEl.textContent || "";
        if (/api\.trkako\.site|pfp-api-coral\.vercel\.app/i.test(text)) {
            styleEl.textContent = flipDomainInText(text);
        }
    });
}

/**
 * Fetches the currently served avatar and banner hashes from the active URL / API
 */
async function fetchCurrentShowingHashes(
    appId: string,
    botUserId?: string | null,
    activeCssUrls?: string[]
): Promise<{ avatarHash: string | null; bannerHash: string | null }> {
    const nativeHelper = getNativeHelper();
    if (nativeHelper?.getServedHashes) {
        const res = await nativeHelper.getServedHashes(appId, botUserId, activeCssUrls);
        if (res.ok) {
            return {
                avatarHash: res.avatarHash?.toLowerCase() ?? null,
                bannerHash: res.bannerHash?.toLowerCase() ?? null,
            };
        }
    }

    // Fallback renderer check if native helper wasn't loaded
    const targetId = botUserId || appId;
    try {
        const res = await fetch(`https://api.trkako.site/api/${encodeURIComponent(targetId)}?v=new&_t=${Date.now()}`, {
            cache: "reload"
        });
        if (res.ok) {
            const data = await res.json();
            return {
                avatarHash:
                    (data.avatar ? String(data.avatar).toLowerCase() : null) ||
                    extractHashFromCdnUrl(data.avatarUrl),
                bannerHash:
                    (data.banner ? String(data.banner).toLowerCase() : null) ||
                    extractHashFromCdnUrl(data.bannerUrl),
            };
        }
    } catch {
        // Ignore fallback errors
    }

    return { avatarHash: null, bannerHash: null };
}

/**
 * Runs up to 5 attempts (separated by 3 seconds each):
 * 1. Calls https://api.trkako.site/api/cache/refresh/<id>
 * 2. Swaps the URL domain in chatBG.css once
 * 3. Checks if the picture showing now has a different hash from oldAvatarHash / oldBannerHash
 * 4. If the hash changed, immediately stops the loop!
 */
async function executeRefreshAndSwapUntilHashChanges(
    appId: string,
    options: {
        botUserId?: string | null;
        oldAvatarHash: string | null;
        oldBannerHash: string | null;
        uploadedIcon: boolean;
        uploadedBanner: boolean;
        onProgress?: (step: number, total: number) => void;
    }
): Promise<{ changed: boolean; attemptsUsed: number }> {
    const {
        botUserId,
        oldAvatarHash,
        oldBannerHash,
        uploadedIcon,
        uploadedBanner,
        onProgress
    } = options;

    const nativeHelper = getNativeHelper();
    const ids = [...new Set([appId, botUserId].filter(Boolean) as string[])];

    const fallbackUrls: string[] = [];
    for (const id of ids) {
        fallbackUrls.push(
            `https://api.trkako.site/api/banner/${id}/4096&v=new`,
            `https://pfp-api-coral.vercel.app/api/banner/${id}/4096&v=new`,
            `https://api.trkako.site/api/banner/${id}/4096?v=new`,
            `https://pfp-api-coral.vercel.app/api/banner/${id}/4096?v=new`,
            `https://api.trkako.site/api/pfp/${id}/4096&v=new`,
            `https://pfp-api-coral.vercel.app/api/pfp/${id}/4096&v=new`,
            `https://api.trkako.site/api/pfp/${id}/4096?v=new`,
            `https://pfp-api-coral.vercel.app/api/pfp/${id}/4096?v=new`
        );
    }

    for (let attempt = 1; attempt <= REFRESH_ATTEMPTS; attempt++) {
        onProgress?.(attempt, REFRESH_ATTEMPTS);

        // 1. Send https://api.trkako.site/api/cache/refresh/<id> (and vercel) + clear Electron HTTP cache
        if (nativeHelper?.refreshAppCache) {
            await nativeHelper.refreshAppCache(appId, botUserId);
        } else {
            const q = new URLSearchParams({ t: String(Date.now()) }).toString();
            await Promise.allSettled(
                ids.flatMap(id => [
                    fetch(`https://api.trkako.site/api/cache/refresh/${encodeURIComponent(id)}?${q}`, { cache: "reload" }),
                    fetch(`https://pfp-api-coral.vercel.app/api/cache/refresh/${encodeURIComponent(id)}?${q}`, { cache: "reload" })
                ])
            );
        }

        // 2. Evict the INACTIVE domain URLs in Chromium before swapping chatBG.css to them
        let nextUrlsToEvict = fallbackUrls;
        let previousUrlsToEvict = fallbackUrls;

        if (nativeHelper?.inspectChatBgCss) {
            const inspected = await nativeHelper.inspectChatBgCss();
            if (inspected.ok && inspected.nextUrls.length > 0) {
                nextUrlsToEvict = [...new Set([...inspected.nextUrls, ...fallbackUrls])];
                previousUrlsToEvict = [...new Set([...inspected.currentUrls, ...fallbackUrls])];
            }
        }

        if (nativeHelper?.clearElectronHttpCache) {
            await nativeHelper.clearElectronHttpCache();
        }
        await evictAndReloadUrlsInChromium(nextUrlsToEvict);

        // 3. Swap the URL domain on \AppData\Roaming\Vencord\themes\chatBG.css ONCE for this attempt
        let activeUrlsAfterSwap: string[] = [];
        if (nativeHelper?.swapDomainsInChatBgCss) {
            const swapRes = await nativeHelper.swapDomainsInChatBgCss();
            if (swapRes.ok) {
                activeUrlsAfterSwap = swapRes.urlsAfter;
            }
        }

        // 4. Reload the stylesheet in the DOM so the swapped URL displays immediately
        forceDomThemeRefresh();

        // 5. Evict the now-detached previous domain URLs from Chromium MemoryCache
        await evictAndReloadUrlsInChromium(previousUrlsToEvict);

        // 6. Check if the picture currently showing has a different hash from oldAvatarHash / oldBannerHash
        const currentHashes = await fetchCurrentShowingHashes(appId, botUserId, activeUrlsAfterSwap);

        const iconChanged =
            !uploadedIcon ||
            (Boolean(currentHashes.avatarHash) && currentHashes.avatarHash !== oldAvatarHash);

        const bannerChanged =
            !uploadedBanner ||
            (Boolean(currentHashes.bannerHash) && currentHashes.bannerHash !== oldBannerHash);

        if (iconChanged && bannerChanged) {
            // Hash changed! Stop calling /api/cache/refresh and stop swapping chatBG.css!
            return { changed: true, attemptsUsed: attempt };
        }

        // 7. Hash has not changed yet — wait 3 seconds before the next attempt (up to 5 attempts)
        if (attempt < REFRESH_ATTEMPTS) {
            await sleep(REFRESH_INTERVAL_MS);
        }
    }

    return { changed: false, attemptsUsed: REFRESH_ATTEMPTS };
}

function ChangeAppIdModal({
    slotNumber,
    initialId,
    onSave,
    modalProps
}: {
    slotNumber: 1 | 2;
    initialId: string;
    onSave: (newId: string) => void;
    modalProps: any;
}) {
    const [value, setValue] = useState(initialId === "0000000000000000000" ? "" : initialId);

    const handleSave = () => {
        const cleaned = value.replace(/\D/g, "").trim() || "0000000000000000000";
        onSave(cleaned);
        modalProps.onClose();
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalContent>
                <div className="vc-bgam-modal-body">
                    <div className="vc-bgam-modal-title">
                        CHANGE APPLICATION {slotNumber} ID
                    </div>
                    <input
                        type="text"
                        inputMode="numeric"
                        className="vc-bgam-modal-input"
                        placeholder="example: 1234567891234567890"
                        value={value}
                        onChange={e => setValue(e.target.value.replace(/\D/g, ""))}
                        onKeyDown={e => {
                            if (e.key === "Enter") handleSave();
                        }}
                        autoFocus
                    />
                    <button
                        type="button"
                        className="vc-bgam-btn vc-bgam-btn-primary"
                        onClick={handleSave}
                    >
                        Save
                    </button>
                </div>
            </ModalContent>
        </ModalRoot>
    );
}

function AppSlotSection({
    slotNumber,
    appId,
    onChangeAppId
}: {
    slotNumber: 1 | 2;
    appId: string;
    onChangeAppId: (newId: string) => void;
}) {
    const [checkingOwner, setCheckingOwner] = useState(false);
    const [isOwned, setIsOwned] = useState(false);
    const [appInfo, setAppInfo] = useState<DevApplicationInfo | null>(null);

    const [draftIcon, setDraftIcon] = useState<string | null>(null);
    const [draftBanner, setDraftBanner] = useState<string | null>(null);
    const [processingBanner, setProcessingBanner] = useState(false);
    const [saving, setSaving] = useState(false);
    const [syncStepText, setSyncStepText] = useState<string | null>(null);

    const iconInputRef = useRef<HTMLInputElement | null>(null);
    const bannerInputRef = useRef<HTMLInputElement | null>(null);

    const verifyOwnershipAndLoadApp = async (targetAppId: string) => {
        setDraftIcon(null);
        setDraftBanner(null);

        if (!targetAppId || targetAppId === "0000000000000000000" || !/^\d{15,22}$/.test(targetAppId)) {
            setIsOwned(false);
            setAppInfo(null);
            return;
        }

        setCheckingOwner(true);
        try {
            const res = await RestAPI.get({
                url: `/applications/${targetAppId}`
            });

            if (res?.ok && res.body?.id) {
                setAppInfo(res.body as DevApplicationInfo);
                setIsOwned(true);
            } else {
                setAppInfo(null);
                setIsOwned(false);
            }
        } catch {
            setAppInfo(null);
            setIsOwned(false);
        } finally {
            setCheckingOwner(false);
        }
    };

    useEffect(() => {
        verifyOwnershipAndLoadApp(appId);
    }, [appId]);

    const validateFile = (file: File): boolean => {
        if (!ALLOWED_MIME_TYPES.has(file.type) && !/\.(png|gif|jpe?g|webp)$/i.test(file.name)) {
            notify("Unsupported file type. Allowed: PNG, GIF, JPG, WEBP.", true);
            return false;
        }
        if (file.size > MAX_FILE_SIZE_BYTES) {
            notify("File exceeds 10MB max size.", true);
            return false;
        }
        return true;
    };

    const handleIconFile = async (file?: File | null) => {
        if (!file || !isOwned) return;
        if (!validateFile(file)) return;

        try {
            const dataUrl = await readFileAsDataUrl(file);
            setDraftIcon(dataUrl);
            notify(`App ${slotNumber}: Icon loaded as draft.`);
        } catch (err) {
            notify(`Failed to read icon file: ${String(err)}`, true);
        }
    };

    const handleBannerFile = async (file?: File | null) => {
        if (!file || !isOwned) return;
        if (!validateFile(file)) return;

        setProcessingBanner(true);
        try {
            const transformedDataUrl = await processBannerFile(file);
            setDraftBanner(transformedDataUrl);
            notify(`App ${slotNumber}: Banner converted to 17:6 draft! Click Save to upload.`);
        } catch (err) {
            notify(`Failed to process banner to 17:6: ${String(err)}`, true);
        } finally {
            setProcessingBanner(false);
        }
    };

    const handleSaveUploads = async () => {
        if (!isOwned || (!draftIcon && !draftBanner) || saving) return;

        const uploadedIcon = Boolean(draftIcon);
        const uploadedBanner = Boolean(draftBanner);

        setSaving(true);
        setSyncStepText("Checking current hash...");

        try {
            const initialBotUserId = appInfo?.bot?.id ?? appId;

            // Step 1: Get the current hash of the current picture BEFORE uploading the new one
            const preUploadServed = await fetchCurrentShowingHashes(appId, initialBotUserId);
            const oldAvatarHash =
                preUploadServed.avatarHash ??
                (appInfo?.bot?.avatar ? appInfo.bot.avatar.toLowerCase() : null);
            const oldBannerHash =
                preUploadServed.bannerHash ??
                (appInfo?.bot?.banner ? appInfo.bot.banner.toLowerCase() : null);

            // Step 2: Upload the new picture to Discord
            setSyncStepText("Uploading to Discord...");
            const botPayload: Record<string, string> = {};
            if (draftIcon) botPayload.avatar = draftIcon;
            if (draftBanner) botPayload.banner = draftBanner;

            const patchRes = await RestAPI.patch({
                url: `/applications/${appId}/bot`,
                body: botPayload
            });

            const botUserId: string | null = patchRes?.body?.id ?? initialBotUserId;

            if (patchRes?.ok && patchRes.body) {
                setAppInfo(prev => prev ? {
                    ...prev,
                    bot: {
                        ...prev.bot,
                        ...patchRes.body
                    }
                } : prev);
            }

            setDraftIcon(null);
            setDraftBanner(null);

            notify(`App ${slotNumber} uploaded! Refreshing cache & checking hash...`);

            // Step 3: Refresh cache + swap chatBG.css + check if hash changed (stops as soon as hash changes!)
            const result = await executeRefreshAndSwapUntilHashChanges(appId, {
                botUserId,
                oldAvatarHash,
                oldBannerHash,
                uploadedIcon,
                uploadedBanner,
                onProgress: (step, total) => {
                    setSyncStepText(`Checking hash (${step}/${total})...`);
                }
            });

            if (result.changed) {
                notify(
                    `App ${slotNumber} updated & verified on attempt ${result.attemptsUsed}/${REFRESH_ATTEMPTS}!`
                );
            } else {
                notify(
                    `App ${slotNumber} uploaded, but hash did not change after ${REFRESH_ATTEMPTS} attempts.`
                );
            }
        } catch (err: any) {
            const errMsg = err?.body?.message || err?.message || String(err);
            notify(`Failed to upload App ${slotNumber} assets: ${errMsg}`, true);
        } finally {
            setSaving(false);
            setSyncStepText(null);
        }
    };

    const openChangeIdModal = () => {
        openModal(modalProps => (
            <ChangeAppIdModal
                slotNumber={slotNumber}
                initialId={appId}
                onSave={onChangeAppId}
                modalProps={modalProps}
            />
        ));
    };

    const displayedIcon = draftIcon ?? getExistingIconUrl(appInfo);
    const displayedBanner = draftBanner ?? getExistingBannerUrl(appInfo);
    const hasDrafts = Boolean(draftIcon || draftBanner);

    return (
        <div className="vc-bgam-card">
            <div className="vc-bgam-header-row">
                <div className="vc-bgam-id-group">
                    <span className="vc-bgam-id-label">
                        APP {slotNumber} ID: {appId || "0000000000000000000"}
                    </span>
                    <button
                        type="button"
                        className="vc-bgam-btn vc-bgam-btn-secondary"
                        onClick={openChangeIdModal}
                    >
                        Change
                    </button>
                </div>

                <div>
                    {checkingOwner ? (
                        <span className="vc-bgam-status-pill vc-bgam-status-checking">
                            Checking ownership...
                        </span>
                    ) : isOwned && appInfo ? (
                        <span className="vc-bgam-status-pill vc-bgam-status-owned">
                            Owned: {appInfo.bot?.username || appInfo.name}
                        </span>
                    ) : (
                        <span className="vc-bgam-status-pill vc-bgam-status-unowned">
                            Not owned / Invalid ID (Uploads disabled)
                        </span>
                    )}
                </div>
            </div>

            {/* ICON ROW */}
            <div className={`vc-bgam-row ${!isOwned ? "vc-bgam-row-disabled" : ""}`}>
                <div className="vc-bgam-meta">
                    <div className="vc-bgam-meta-title">Icon</div>
                    <div className="vc-bgam-meta-line">Aspect Ratio: 1:1</div>
                    <div className="vc-bgam-meta-line">File Types: PNG, GIF, JPG, WEBP</div>
                    <div className="vc-bgam-meta-line">Max Size: 10MB</div>
                </div>

                <div>
                    <input
                        ref={iconInputRef}
                        type="file"
                        accept=".png,.gif,.jpg,.jpeg,.webp,image/png,image/gif,image/jpeg,image/webp"
                        style={{ display: "none" }}
                        onChange={e => {
                            handleIconFile(e.target.files?.[0]);
                            e.currentTarget.value = "";
                        }}
                    />
                    <div
                        className="vc-bgam-icon-box"
                        onClick={() => isOwned && iconInputRef.current?.click()}
                        onDragOver={e => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                        onDrop={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleIconFile(e.dataTransfer.files?.[0]);
                        }}
                    >
                        <img
                            src={displayedIcon}
                            alt={`App ${slotNumber} Icon`}
                            className="vc-bgam-icon-img"
                        />
                        {draftIcon && <span className="vc-bgam-draft-badge">DRAFT</span>}
                        <div className="vc-bgam-upload-overlay">
                            Drag or click to upload
                        </div>
                    </div>
                </div>
            </div>

            {/* BANNER ROW */}
            <div className={`vc-bgam-row ${!isOwned ? "vc-bgam-row-disabled" : ""}`}>
                <div className="vc-bgam-meta">
                    <div className="vc-bgam-meta-title">Banner</div>
                    <div className="vc-bgam-meta-line">Aspect Ratio: 17:6</div>
                    <div className="vc-bgam-meta-line">File Types: PNG, GIF, JPG, WEBP</div>
                    <div className="vc-bgam-meta-line">Max Size: 10MB</div>
                </div>

                <div>
                    <input
                        ref={bannerInputRef}
                        type="file"
                        accept=".png,.gif,.jpg,.jpeg,.webp,image/png,image/gif,image/jpeg,image/webp"
                        style={{ display: "none" }}
                        onChange={e => {
                            handleBannerFile(e.target.files?.[0]);
                            e.currentTarget.value = "";
                        }}
                    />
                    <div
                        className="vc-bgam-banner-box"
                        onClick={() => isOwned && !processingBanner && bannerInputRef.current?.click()}
                        onDragOver={e => {
                            e.preventDefault();
                            e.stopPropagation();
                        }}
                        onDrop={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleBannerFile(e.dataTransfer.files?.[0]);
                        }}
                    >
                        {processingBanner ? (
                            <span className="vc-bgam-placeholder-text">
                                Transforming banner to 17:6...
                            </span>
                        ) : displayedBanner ? (
                            <img
                                src={displayedBanner}
                                alt={`App ${slotNumber} Banner`}
                                className="vc-bgam-banner-img"
                            />
                        ) : (
                            <span className="vc-bgam-placeholder-text">
                                Drag or click to upload
                            </span>
                        )}
                        {draftBanner && <span className="vc-bgam-draft-badge">17:6 DRAFT</span>}
                        <div className="vc-bgam-upload-overlay">
                            Drag or click to upload (Auto 17:6)
                        </div>
                    </div>
                </div>
            </div>

            <div className="vc-bgam-footer">
                {hasDrafts && (
                    <button
                        type="button"
                        className="vc-bgam-btn vc-bgam-btn-secondary"
                        disabled={saving}
                        onClick={() => {
                            setDraftIcon(null);
                            setDraftBanner(null);
                        }}
                    >
                        Discard Draft
                    </button>
                )}
                <button
                    type="button"
                    className="vc-bgam-btn vc-bgam-btn-primary"
                    disabled={!isOwned || !hasDrafts || saving || processingBanner}
                    onClick={handleSaveUploads}
                >
                    {saving ? (syncStepText || "Saving & Syncing...") : "Save"}
                </button>
            </div>
        </div>
    );
}

function AppAssetsTab() {
    const { app1Id, app2Id } = settings.use(["app1Id", "app2Id"]);

    return (
        <div className="vc-bgam-root">
            <AppSlotSection
                slotNumber={1}
                appId={app1Id}
                onChangeAppId={newId => {
                    settings.store.app1Id = newId;
                }}
            />

            <hr className="vc-bgam-divider" />

            <AppSlotSection
                slotNumber={2}
                appId={app2Id}
                onChangeAppId={newId => {
                    settings.store.app2Id = newId;
                }}
            />
        </div>
    );
}

export default ErrorBoundary.wrap(AppAssetsTab);