// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBareDomainLinks from '../lib/remark-bare-domain-links';
import React from 'react';

interface MarkdownMessageProps {
    body: string;
    className?: string;
}

// Renders message body with markdown support:
// **bold**, *italic*, `code`, ```code blocks```, [links](url), lists, etc.
export default function MarkdownMessage({ body, className = '' }: MarkdownMessageProps) {
    return (
        <div className={`markdown-message text-gray-300 break-words leading-relaxed ${className}`}
            style={{ overflowWrap: 'anywhere' }}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBareDomainLinks]}
                components={{
                    // Inline styles for chat context — compact and clean
                    p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
                    strong: ({ children }) => <strong className="font-bold text-white">{children}</strong>,
                    em: ({ children }) => <em className="italic text-gray-200">{children}</em>,
                    a: ({ href, children }) => (
                        <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#99DD00] hover:text-[#FFDD00] underline"
                        >
                            {children}
                        </a>
                    ),
                    code: ({ className: codeClassName, children, ...props }) => {
                        const isBlock = codeClassName?.startsWith('language-');
                        if (isBlock) {
                            return (
                                <code
                                    className={`block bg-black/40 border border-white/10 rounded-md p-2 my-1 text-xs font-mono text-[#FFDD00] overflow-x-auto whitespace-pre ${codeClassName}`}
                                    {...props}
                                >
                                    {children}
                                </code>
                            );
                        }
                        return (
                            <code
                                className="bg-white/10 text-[#FFDD00] px-1 py-0.5 rounded text-sm font-mono"
                                {...props}
                            >
                                {children}
                            </code>
                        );
                    },
                    pre: ({ children }) => <pre className="my-1">{children}</pre>,
                    ul: ({ children }) => <ul className="list-disc list-inside ml-1 mb-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside ml-1 mb-1">{children}</ol>,
                    li: ({ children }) => <li className="text-gray-300">{children}</li>,
                    blockquote: ({ children }) => (
                        <blockquote className="border-l-2 border-[#55AA00]/50 pl-2 my-1 text-gray-400 italic">
                            {children}
                        </blockquote>
                    ),
                    h1: ({ children }) => <h1 className="text-lg font-bold text-white mb-1">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-base font-bold text-white mb-1">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-sm font-bold text-white mb-1">{children}</h3>,
                    hr: () => <hr className="border-white/10 my-2" />,
                    table: ({ children }) => (
                        <div className="overflow-x-auto my-1">
                            <table className="text-xs border-collapse">{children}</table>
                        </div>
                    ),
                    th: ({ children }) => (
                        <th className="border border-white/20 px-2 py-1 text-left text-gray-200 bg-white/5">{children}</th>
                    ),
                    td: ({ children }) => (
                        <td className="border border-white/10 px-2 py-1 text-gray-300">{children}</td>
                    ),
                }}
            >
                {body}
            </ReactMarkdown>
        </div>
    );
}
