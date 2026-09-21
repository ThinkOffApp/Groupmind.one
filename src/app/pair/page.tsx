// SPDX-License-Identifier: AGPL-3.0-only
import { redirect } from 'next/navigation';

// groupmind.one/pair — the speakable pairing address.
//
// A user asked: "can you make the link easier? do our users have to
// type that?" The pairing flow lived only at /codewatch/app?pair=1: a path
// plus a query string nobody can say aloud or remember. This route gives it
// a word. Docs, videos and humans say "groupmind.one/pair"; the existing
// page keeps the one working implementation (deep link ?pair=1 mints the
// code straight away, after Google sign-in if needed).
export default function PairShortcut() {
    redirect('/codewatch/app?pair=1');
}
