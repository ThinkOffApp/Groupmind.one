// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * React Hook for Multi-AI Voice Chat (GroupMind version)
 * Adapted from Muikku's useVoiceChat for Next.js
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { MultiAIVoiceChatExtended, ExtendedVoiceChatConfig } from './MultiAIVoiceChatExtended';
import {
    Participant,
    ConversationMessage,
    VoiceChatEvent,
} from './types';

export interface UseVoiceChatState {
    isConnected: boolean;
    isConnecting: boolean;
    error: string | null;
    participants: Participant[];
    conversationHistory: ConversationMessage[];
    audioLevels: Map<string, number>;
}

export interface UseVoiceChatActions {
    connect: () => Promise<void>;
    disconnect: () => void;
    sendMessage: (text: string) => void;
    interruptAll: () => void;
    setParticipantMuted: (participantId: string, muted: boolean) => void;
    setParticipantVolume: (participantId: string, volume: number) => void;
}

export interface UseVoiceChatReturn extends UseVoiceChatState, UseVoiceChatActions { }

export function useVoiceChat(config: ExtendedVoiceChatConfig): UseVoiceChatReturn {
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [participants, setParticipants] = useState<Participant[]>([]);
    const [conversationHistory, setConversationHistory] = useState<ConversationMessage[]>([]);
    const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map());

    const voiceChatRef = useRef<MultiAIVoiceChatExtended | null>(null);

    useEffect(() => {
        voiceChatRef.current = new MultiAIVoiceChatExtended(config);

        const handleEvent = (event: VoiceChatEvent) => {
            switch (event.type) {
                case 'connected':
                    setIsConnected(true);
                    setIsConnecting(false);
                    break;

                case 'disconnected':
                    setIsConnected(false);
                    setParticipants([]);
                    break;

                case 'error':
                    setError(typeof event.data === 'string' ? event.data : (event.data as any)?.message || 'Voice chat error');
                    setIsConnecting(false);
                    break;

                case 'participant-joined':
                case 'participant-left':
                case 'speaking-started':
                case 'speaking-ended':
                    if (voiceChatRef.current) {
                        setParticipants(voiceChatRef.current.getParticipants());
                    }
                    break;

                case 'transcript-update':
                    if (voiceChatRef.current) {
                        setConversationHistory(voiceChatRef.current.getHistory());
                    }
                    break;

                case 'audio-level':
                    if (event.participantId && typeof event.data === 'number') {
                        setAudioLevels(prev => {
                            const newMap = new Map(prev);
                            newMap.set(event.participantId!, event.data as number);
                            return newMap;
                        });
                    }
                    break;
            }
        };

        voiceChatRef.current.addEventListener(handleEvent);

        return () => {
            if (voiceChatRef.current) {
                voiceChatRef.current.removeEventListener(handleEvent);
                voiceChatRef.current.disconnect();
            }
        };
    }, [config.openAiApiKey, config.geminiApiKey]);

    const connect = useCallback(async () => {
        if (!voiceChatRef.current || isConnecting) return;
        setIsConnecting(true);
        setError(null);
        try {
            await voiceChatRef.current.connect();
            setParticipants(voiceChatRef.current.getParticipants());
        } catch (err: any) {
            setError(err?.message || 'Failed to connect');
            setIsConnecting(false);
        }
    }, [isConnecting]);

    const disconnect = useCallback(() => {
        voiceChatRef.current?.disconnect();
    }, []);

    const sendMessage = useCallback((text: string) => {
        if (voiceChatRef.current && isConnected) {
            voiceChatRef.current.sendTextMessage(text);
        }
    }, [isConnected]);

    const interruptAll = useCallback(() => {
        if (voiceChatRef.current && isConnected) {
            voiceChatRef.current.interruptAll();
        }
    }, [isConnected]);

    const setParticipantMuted = useCallback((participantId: string, muted: boolean) => {
        if (voiceChatRef.current && isConnected) {
            voiceChatRef.current.setParticipantMuted(participantId, muted);
            setParticipants(voiceChatRef.current.getParticipants());
        }
    }, [isConnected]);

    const setParticipantVolume = useCallback((participantId: string, volume: number) => {
        if (voiceChatRef.current && isConnected) {
            voiceChatRef.current.setParticipantVolume(participantId, volume);
        }
    }, [isConnected]);

    return {
        isConnected,
        isConnecting,
        error,
        participants,
        conversationHistory,
        audioLevels,
        connect,
        disconnect,
        sendMessage,
        interruptAll,
        setParticipantMuted,
        setParticipantVolume,
    };
}
