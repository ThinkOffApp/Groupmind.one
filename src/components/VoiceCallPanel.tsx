// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useVoiceChat } from '@/lib/voice/useVoiceChat';
import { getVoiceSettings, VoiceSettingsModal } from './VoiceSettingsModal';
import type { ExtendedVoiceChatConfig } from '@/lib/voice/MultiAIVoiceChatExtended';
import type { Participant, ConversationMessage } from '@/lib/voice/types';

interface VoiceCallPanelProps {
    roomSlug: string;
    roomName: string;
    onTranscript?: (speaker: string, text: string) => void;
}

export function VoiceCallPanel({ roomSlug, roomName, onTranscript }: VoiceCallPanelProps) {
    const [isCallOpen, setIsCallOpen] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [isMuted, setIsMuted] = useState(false);
    const [settingsKey, setSettingsKey] = useState(0); // Force re-read settings
    const prevHistoryLenRef = useRef(0);

    const settings = useMemo(() => getVoiceSettings(), [settingsKey, isCallOpen]);

    const voiceConfig: ExtendedVoiceChatConfig = useMemo(() => ({
        openAiApiKey: settings.enabledProviders.includes('openai') ? settings.openAiApiKey : undefined,
        geminiApiKey: settings.enabledProviders.includes('google') ? settings.geminiApiKey : undefined,
        openAiVoice: settings.openAiVoice,
        geminiVoice: settings.geminiVoice,
        systemPrompt: `You are in a voice chat room called "${roomName}". Be conversational, brief, and natural. Respond in 1-3 sentences.`,
        enabledProviders: settings.enabledProviders as any[],
    }), [settings, roomName]);

    const {
        isConnected,
        isConnecting,
        error,
        participants,
        conversationHistory,
        audioLevels,
        connect,
        disconnect,
        interruptAll,
        setParticipantMuted,
    } = useVoiceChat(voiceConfig);

    // Post transcripts to chat when new messages arrive
    useEffect(() => {
        if (conversationHistory.length > prevHistoryLenRef.current && onTranscript) {
            const newMsgs = conversationHistory.slice(prevHistoryLenRef.current);
            for (const msg of newMsgs) {
                if (msg.content.trim()) {
                    onTranscript(msg.participantName, msg.content);
                }
            }
        }
        prevHistoryLenRef.current = conversationHistory.length;
    }, [conversationHistory, onTranscript]);

    const handleJoinLeave = useCallback(async () => {
        if (isConnected) {
            disconnect();
            setIsCallOpen(false);
        } else {
            // Check if any keys are configured
            const hasKeys = settings.openAiApiKey || settings.geminiApiKey;
            if (!hasKeys) {
                setShowSettings(true);
                return;
            }
            setIsCallOpen(true);
            await connect();
        }
    }, [isConnected, connect, disconnect, settings]);

    const handleMuteToggle = useCallback(() => {
        setIsMuted(prev => !prev);
        // Mute all participants — in practice we'd mute the mic
    }, []);

    const handleSettingsClose = useCallback(() => {
        setShowSettings(false);
        setSettingsKey(k => k + 1); // Reload settings
    }, []);

    return (
        <>
            <VoiceSettingsModal isOpen={showSettings} onClose={handleSettingsClose} />

            {/* Floating Call Button — always visible in room header */}
            {!isCallOpen && (
                <button
                    onClick={handleJoinLeave}
                    disabled={isConnecting}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${isConnecting
                            ? 'bg-yellow-600/20 text-yellow-400 cursor-wait'
                            : 'bg-[#55AA00]/20 text-[#99DD00] hover:bg-[#55AA00]/30 hover:text-[#FFDD00]'
                        }`}
                    title="Start voice call"
                >
                    {isConnecting ? (
                        <>
                            <span className="animate-pulse">⏳</span>
                            Connecting...
                        </>
                    ) : (
                        <>📞 Call</>
                    )}
                </button>
            )}

            {/* Voice Call Panel — slides in when active */}
            {isCallOpen && (
                <div className="bg-gray-900/95 backdrop-blur border border-white/10 rounded-xl overflow-hidden animate-in slide-in-from-bottom-4 duration-300">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/5">
                        <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-pink-400 animate-pulse' : 'bg-gray-500'}`} />
                            <span className="text-sm font-medium">
                                {isConnected ? `Voice • ${roomName}` : 'Connecting...'}
                            </span>
                        </div>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => setShowSettings(true)}
                                className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                                title="Voice settings"
                            >
                                ⚙️
                            </button>
                            <button
                                onClick={handleMuteToggle}
                                className={`p-1.5 rounded-lg transition-colors ${isMuted
                                        ? 'bg-red-500/20 text-red-400'
                                        : 'hover:bg-white/10 text-gray-400 hover:text-white'
                                    }`}
                                title={isMuted ? 'Unmute' : 'Mute'}
                            >
                                {isMuted ? '🔇' : '🎙️'}
                            </button>
                            <button
                                onClick={handleJoinLeave}
                                className="p-1.5 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                                title="Leave call"
                            >
                                📵
                            </button>
                        </div>
                    </div>

                    {/* Error */}
                    {error && (
                        <div className="px-4 py-2 bg-red-500/10 text-red-400 text-xs border-b border-red-500/20">
                            ⚠️ {error}
                        </div>
                    )}

                    {/* Participants */}
                    <div className="px-4 py-3 flex items-center gap-3 overflow-x-auto">
                        {/* Human (you) */}
                        <ParticipantAvatar
                            name="You"
                            color="#4CAF50"
                            isSpeaking={false}
                            isMuted={isMuted}
                            audioLevel={0}
                        />

                        {/* AI Participants */}
                        {participants.map(p => (
                            <ParticipantAvatar
                                key={p.id}
                                name={p.name}
                                color={p.color}
                                isSpeaking={p.isSpeaking}
                                isMuted={p.isMuted}
                                audioLevel={audioLevels.get(p.id) || 0}
                                onMuteToggle={() => setParticipantMuted(p.id, !p.isMuted)}
                            />
                        ))}

                        {participants.length === 0 && isConnected && (
                            <span className="text-xs text-gray-500 italic">No AI participants connected</span>
                        )}
                    </div>

                    {/* Live Transcript (last 3 messages) */}
                    {conversationHistory.length > 0 && (
                        <div className="px-4 pb-3 space-y-1 max-h-32 overflow-y-auto">
                            {conversationHistory.slice(-3).map((msg, i) => (
                                <TranscriptLine key={msg.id || i} message={msg} />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}

// --- Sub-components ---

function ParticipantAvatar({
    name,
    color,
    isSpeaking,
    isMuted,
    audioLevel,
    onMuteToggle,
}: {
    name: string;
    color: string;
    isSpeaking: boolean;
    isMuted: boolean;
    audioLevel: number;
    onMuteToggle?: () => void;
}) {
    const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    const ringSize = Math.min(audioLevel * 8, 4);

    return (
        <button
            onClick={onMuteToggle}
            className="flex flex-col items-center gap-1 min-w-[50px] group"
            title={`${name}${isMuted ? ' (muted)' : ''}`}
        >
            <div className="relative">
                <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold transition-all ${isMuted ? 'opacity-50' : ''
                        }`}
                    style={{
                        backgroundColor: color + '30',
                        color: color,
                        boxShadow: isSpeaking ? `0 0 0 ${2 + ringSize}px ${color}40, 0 0 ${12 + ringSize * 4}px ${color}20` : 'none',
                    }}
                >
                    {initials}
                </div>
                {isMuted && (
                    <div className="absolute -bottom-0.5 -right-0.5 bg-red-500 rounded-full w-4 h-4 flex items-center justify-center text-[8px]">
                        🔇
                    </div>
                )}
                {isSpeaking && !isMuted && (
                    <div
                        className="absolute -bottom-0.5 -right-0.5 rounded-full w-4 h-4 flex items-center justify-center text-[8px] animate-pulse"
                        style={{ backgroundColor: color }}
                    >
                        🔊
                    </div>
                )}
            </div>
            <span className="text-[10px] text-gray-400 group-hover:text-white truncate max-w-[60px]">
                {name}
            </span>
        </button>
    );
}

function TranscriptLine({ message }: { message: ConversationMessage }) {
    return (
        <div className="flex gap-2 text-xs">
            <span className="text-gray-500 font-medium shrink-0">{message.participantName}:</span>
            <span className="text-gray-300">{message.content}</span>
        </div>
    );
}
