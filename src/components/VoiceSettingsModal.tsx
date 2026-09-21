'use client';

import { useState, useEffect } from 'react';

interface VoiceSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const STORAGE_KEY = 'antfarm-voice-settings';

interface VoiceSettings {
    openAiApiKey: string;
    geminiApiKey: string;
    enabledProviders: string[];
    openAiVoice: string;
    geminiVoice: string;
}

const DEFAULT_SETTINGS: VoiceSettings = {
    openAiApiKey: '',
    geminiApiKey: '',
    enabledProviders: ['openai'],
    openAiVoice: 'alloy',
    geminiVoice: 'Puck',
};

export function getVoiceSettings(): VoiceSettings {
    if (typeof window === 'undefined') return DEFAULT_SETTINGS;
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export function VoiceSettingsModal({ isOpen, onClose }: VoiceSettingsModalProps) {
    const [settings, setSettings] = useState<VoiceSettings>(DEFAULT_SETTINGS);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        if (isOpen) setSettings(getVoiceSettings());
    }, [isOpen]);

    const update = (key: keyof VoiceSettings, value: any) =>
        setSettings(prev => ({ ...prev, [key]: value }));

    const toggleProvider = (p: string) => {
        setSettings(prev => ({
            ...prev,
            enabledProviders: prev.enabledProviders.includes(p)
                ? prev.enabledProviders.filter(x => x !== p)
                : [...prev.enabledProviders, p],
        }));
    };

    const save = () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        setSaved(true);
        setTimeout(() => { setSaved(false); onClose(); }, 600);
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
            <div
                className="bg-gray-900 border border-white/10 rounded-xl max-w-md w-full p-6 space-y-5"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex justify-between items-center">
                    <h2 className="text-lg font-bold">🎙️ Voice Call Settings</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
                </div>

                {/* Providers */}
                <div>
                    <label className="text-xs text-gray-400 uppercase tracking-wide mb-2 block">AI Participants</label>
                    <div className="flex gap-2 flex-wrap">
                        {['openai', 'google'].map(p => (
                            <button
                                key={p}
                                onClick={() => toggleProvider(p)}
                                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${settings.enabledProviders.includes(p)
                                    ? 'bg-[#55AA00] text-white'
                                    : 'bg-gray-800 text-gray-400 hover:text-white'
                                    }`}
                            >
                                {p === 'openai' ? '🟢 OpenAI' : '🔵 Gemini'}
                            </button>
                        ))}
                    </div>
                </div>

                {/* OpenAI Key */}
                {settings.enabledProviders.includes('openai') && (
                    <div>
                        <label className="text-xs text-gray-400 uppercase tracking-wide mb-1 block">OpenAI API Key</label>
                        <input
                            type="password"
                            value={settings.openAiApiKey}
                            onChange={e => update('openAiApiKey', e.target.value)}
                            placeholder="sk-..."
                            className="w-full px-3 py-2 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                        />
                        <div className="mt-1.5">
                            <label className="text-xs text-gray-400">Voice</label>
                            <select
                                value={settings.openAiVoice}
                                onChange={e => update('openAiVoice', e.target.value)}
                                className="ml-2 bg-gray-800 border border-white/10 rounded px-2 py-1 text-xs"
                            >
                                {['alloy', 'coral', 'sage', 'nova', 'shimmer', 'echo'].map(v => (
                                    <option key={v} value={v}>{v}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}

                {/* Gemini Key */}
                {settings.enabledProviders.includes('google') && (
                    <div>
                        <label className="text-xs text-gray-400 uppercase tracking-wide mb-1 block">Gemini API Key</label>
                        <input
                            type="password"
                            value={settings.geminiApiKey}
                            onChange={e => update('geminiApiKey', e.target.value)}
                            placeholder="AIza..."
                            className="w-full px-3 py-2 bg-black border border-white/20 rounded-lg text-sm focus:border-[#55AA00] focus:outline-none"
                        />
                        <div className="mt-1.5">
                            <label className="text-xs text-gray-400">Voice</label>
                            <select
                                value={settings.geminiVoice}
                                onChange={e => update('geminiVoice', e.target.value)}
                                className="ml-2 bg-gray-800 border border-white/10 rounded px-2 py-1 text-xs"
                            >
                                {['Puck', 'Kore', 'Charon', 'Fenrir', 'Aoede'].map(v => (
                                    <option key={v} value={v}>{v}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                )}

                <p className="text-xs text-gray-500">Keys are stored in your browser only — never sent to GroupMind servers.</p>

                {/* Save */}
                <button
                    onClick={save}
                    className={`w-full py-2.5 rounded-lg font-medium transition-all ${saved ? 'bg-[#99DD00] text-white' : 'bg-[#55AA00] hover:bg-[#99DD00] text-white'
                        }`}
                >
                    {saved ? '✓ Saved' : 'Save Settings'}
                </button>
            </div>
        </div>
    );
}
