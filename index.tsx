/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { ImageIcon } from "@components/Icons";
import SettingsPlugin from "@plugins/_core/settings";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";

import AppAssetsTab from "./components/AppAssetsTab";

export const settings = definePluginSettings({
    app1Id: {
        type: OptionType.STRING,
        description: "Application 1 ID",
        default: "0000000000000000000",
    },
    app2Id: {
        type: OptionType.STRING,
        description: "Application 2 ID",
        default: "0000000000000000000",
    },
});

const TAB_KEY = "vencord_bg_asset_manager";
const TAB_TITLE = "BG Asset Manager";

const customSectionFactory = () => ({
    section: TAB_KEY,
    label: TAB_TITLE,
    element: AppAssetsTab,
    className: "vc-bg-asset-manager-tab"
});

export default definePlugin({
    name: "BG Asset Manager",
    description: "Manage two Discord Developer Applications' Icon and 17:6 mirrored Banner directly from Vencord settings.",
    authors: [Devs.Ven],
    settings,

    start() {
        const sPlugin = SettingsPlugin as any;

        if (Array.isArray(sPlugin.customEntries)) {
            const exists = sPlugin.customEntries.some((e: any) => e.key === TAB_KEY);
            if (!exists) {
                sPlugin.customEntries.push({
                    key: TAB_KEY,
                    title: TAB_TITLE,
                    Component: AppAssetsTab,
                    Icon: ImageIcon
                });
            }
        }

        if (Array.isArray(sPlugin.customSections)) {
            if (!sPlugin.customSections.includes(customSectionFactory)) {
                sPlugin.customSections.push(customSectionFactory);
            }
        }
    },

    stop() {
        const sPlugin = SettingsPlugin as any;

        if (Array.isArray(sPlugin.customEntries)) {
            const idx = sPlugin.customEntries.findIndex((e: any) => e.key === TAB_KEY);
            if (idx !== -1) sPlugin.customEntries.splice(idx, 1);
        }

        if (Array.isArray(sPlugin.customSections)) {
            const idx = sPlugin.customSections.indexOf(customSectionFactory);
            if (idx !== -1) sPlugin.customSections.splice(idx, 1);
        }
    }
});
