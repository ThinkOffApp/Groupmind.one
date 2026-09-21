// SPDX-License-Identifier: AGPL-3.0-only
// src/lib/supabase-client.ts
import { createClient } from "./supabase-browser";

export const supabase = createClient();

/**
 * Rehydrate Supabase session from localStorage if present.
 * This helps preserve the auth session across page reloads.
 */
export const rehydrateSession = async () => {
    try {
        const stored = localStorage.getItem("supabase.auth.token");
        if (stored) {
            const token = JSON.parse(stored);
            if (token?.access_token) {
                await supabase.auth.setSession({
                    access_token: token.access_token,
                    refresh_token: token.refresh_token,
                });
            }
        }
    } catch (e) {
        console.warn("Supabase session rehydration failed", e);
    }
};
