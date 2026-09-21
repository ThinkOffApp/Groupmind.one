// remark plugin: linkify bare domains (console.cloud.google.com/x) that
// remark-gfm autolink literals ignore — GFM only fires on URLs starting with
// a scheme (https://) or www. Agents and humans both paste protocol-less
// domains, which rendered as dead text (reported by a user).
//
// Safety: operates only on mdast `text` nodes, never touches existing links,
// code spans/blocks, or raw HTML, and emits plain mdast link nodes — no
// rehype-raw, no HTML injection path. Links render through MarkdownMessage's
// existing `a` override (target=_blank rel=noopener noreferrer).
//
// Runs after remark-gfm in the plugin chain, so scheme/www URLs are already
// link nodes and are skipped by the walker.

import type { Link, Parent, Root, Text } from 'mdast';

// Conservative TLD whitelist: common web TLDs the room actually posts.
// Filename-like TLDs (.sh, .so, .ms, .json...) are deliberately excluded so
// code references (post_room.sh, libnative.so) never linkify.
const TLD = '(?:com|net|org|io|ai|app|dev|one|co|me|cloud|site|tech|xyz|run|page|tools|fi|info|pro|gg|tv)';

// Bare domain, optional port, optional path/query. Negative lookbehind blocks
// matches inside emails (user@gmail.com), URLs, and longer dotted strings.
const BARE_DOMAIN = new RegExp(
    '(?<![@\\w/.-])' +
    '((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+' + TLD + '\\b' +
    '(?::\\d{1,5})?' +
    '(?:\\/[A-Za-z0-9\\-._~:/?#[\\]@!$&\'()*+,;=%]*)?)',
    'gi'
);

// Punctuation that belongs to the sentence, not the URL.
const TRAILING_PUNCT = /[.,;:!?)\]}"']+$/;

// Split a plain-text string into text/link nodes at every bare domain.
export function splitBareDomains(value: string): (Text | Link)[] {
    const out: (Text | Link)[] = [];
    let last = 0;
    BARE_DOMAIN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BARE_DOMAIN.exec(value))) {
        let url = m[1];
        const trailing = url.match(TRAILING_PUNCT);
        if (trailing) url = url.slice(0, -trailing[0].length);
        if (!url) continue;
        const start = m.index;
        const end = start + url.length;
        if (start > last) out.push({ type: 'text', value: value.slice(last, start) });
        out.push({
            type: 'link',
            url: 'https://' + url,
            title: null,
            children: [{ type: 'text', value: url }],
        });
        last = end;
    }
    if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
    return out;
}

function walk(parent: Parent): void {
    for (let i = 0; i < parent.children.length; i++) {
        const child = parent.children[i];
        // Never rewrite inside existing links (scheme/www autolinks, markdown links).
        if (child.type === 'link' || child.type === 'linkReference') continue;
        if (child.type === 'text') {
            const parts = splitBareDomains((child as Text).value);
            if (parts.some((p) => p.type === 'link')) {
                parent.children.splice(i, 1, ...parts);
                i += parts.length - 1;
            }
        } else if ('children' in child) {
            walk(child as Parent);
        }
    }
}

export default function remarkBareDomainLinks() {
    return (tree: Root) => {
        walk(tree);
    };
}
