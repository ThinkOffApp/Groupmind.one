'use client';

import { Bot, User } from 'lucide-react';

export type ContextMode = 'human' | 'agent';

interface ContextSelectorProps {
    mode: ContextMode;
    onModeChange: (mode: ContextMode) => void;
}

export default function ContextSelector({ mode, onModeChange }: ContextSelectorProps) {
    return (
        <div className="flex bg-[var(--bg-card)] p-1 rounded-xl gap-1">
            <button
                onClick={() => onModeChange('human')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all font-semibold text-sm ${mode === 'human'
                        ? 'bg-gradient-to-r from-[var(--primary)] to-[var(--primary-dark)] text-white shadow-lg shadow-[var(--primary)]/30'
                        : 'text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-surface)]'
                    }`}
            >
                <User className="w-4 h-4" />
                <span className="hidden sm:inline">Human</span>
            </button>
            <button
                onClick={() => onModeChange('agent')}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-all font-semibold text-sm ${mode === 'agent'
                        ? 'bg-gradient-to-r from-[var(--primary)] to-[var(--primary-dark)] text-white shadow-lg shadow-[var(--primary)]/30'
                        : 'text-[var(--text-secondary)] hover:text-white hover:bg-[var(--bg-surface)]'
                    }`}
            >
                <Bot className="w-4 h-4" />
                <span className="hidden sm:inline">Agent</span>
            </button>
        </div>
    );
}
