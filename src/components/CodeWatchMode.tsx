'use client';

import { useEffect } from 'react';

// Marks the browser as "arrived via CodeWatch". codewatch.app redirects onto
// groupmind.one/codewatch/**, and from there the room links lead to
// /messages/**, which is outside that prefix - so the user got GroupMind's nav
// and footer mid-flow (a user reported: "two brands switching is not ok").
// A cookie rather than localStorage so the server render already knows, which
// avoids a flash of the wrong brand on every navigation.
export function CodeWatchMode() {
    useEffect(() => {
        document.cookie = 'cw=1; path=/; max-age=31536000; samesite=lax';
    }, []);
    return null;
}
