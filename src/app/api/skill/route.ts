// SPDX-License-Identifier: AGPL-3.0-only
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// AUTOMATED: Reads directly from the repo's root SKILL.md to ensure the API
// always matches the file. This prevents content divergence.
export async function GET() {
  try {
    // Root SKILL.md first: present at process.cwd() in local dev (repo root)
    // and copied there by the Dockerfile in the runtime image (the image
    // otherwise only ships public/, not the repo root). public/SKILL.md and
    // public/skill.md are legacy fallbacks for anyone who still places a copy
    // there; keep them last so the single source of truth wins.
    const candidates = [
      path.join(process.cwd(), 'SKILL.md'),
      path.join(process.cwd(), 'public', 'SKILL.md'),
      path.join(process.cwd(), 'public', 'skill.md'),
    ];
    const filePath = candidates.find((p) => fs.existsSync(p));

    if (filePath) {
      const raw = fs.readFileSync(filePath, 'utf8');
      // The address an agent should actually call: THIS instance.
      //
      // SKILL.md is written against the public deployment, so every example in
      // it names groupmind.one. Served unchanged from a self-hosted instance
      // that is actively wrong: the operator hands their agent a document whose
      // every curl points at somebody else's server, and the agent registers
      // there instead. Rewrite the origin to whatever this instance is reachable
      // at, which is what NEXT_PUBLIC_BASE_URL means, and keep the old dead
      // hostnames in the same pass.
      const selfUrl = (
        process.env.NEXT_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://groupmind.one'
      ).replace(/\/+$/, '');
      const content = raw
        .replace(
          /https?:\/\/(?:antfarm\.xfor\.bot|antfarm\.world|(?:www\.)?groupmind\.one)/gi,
          selfUrl
        )
        .replace(/^\s*-\s*\*\*GroupMind \(alias\):\*\*.*\n?/gim, '')
        .replace(/^\s*-\s*\*\*Ant Farm \(alias\):\*\*.*\n?/gim, '')
        .replace(/Ant Farm/g, 'GroupMind');
      return new NextResponse(content, {
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    } else {
      console.error('SKILL.md not found. Checked:', candidates);
      return new NextResponse('# Error: SKILL.md file missing', { status: 404 });
    }
  } catch (error) {
    console.error('Error serving SKILL.md:', error);
    return new NextResponse('# Error serving documentation', { status: 500 });
  }
}
