// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Multi-AI Voice Chat Types
 * Types for real-time voice conversations with multiple AI models
 */

// Participant types
export type ParticipantType = 'realtime' | 'text';
export type ParticipantProvider = 'openai' | 'google' | 'anthropic' | 'mistral' | 'grok' | 'meta' | 'perplexity';

export interface Participant {
  id: string;
  name: string;
  type: ParticipantType;
  provider: ParticipantProvider;
  voice?: string;           // TTS voice name for text models
  stereoPosition: number;   // -1 (left) to 1 (right)
  color: string;            // UI color for this participant
  isConnected: boolean;
  isSpeaking: boolean;
  isMuted: boolean;
}

export interface ParticipantConfig {
  id: string;
  name: string;
  type: ParticipantType;
  provider: ParticipantProvider;
  apiKey: string;
  voice?: string;
  stereoPosition?: number;
  color?: string;
  systemPrompt?: string;
}

// Audio configuration
export interface AudioConfig {
  inputSampleRate: number;    // Mic input (usually 16000)
  outputSampleRate: number;   // Speaker output (usually 24000)
  channelCount: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
};

// Message types for conversation history
export interface ConversationMessage {
  id: string;
  participantId: string;
  participantName: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  audioData?: ArrayBuffer;
}

// Voice chat state
export interface VoiceChatState {
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  participants: Map<string, Participant>;
  currentSpeaker: string | null;
  conversationHistory: ConversationMessage[];
  transcript: string;
}

// Events emitted by the voice chat system
export type VoiceChatEventType =
  | 'connected'
  | 'disconnected'
  | 'error'
  | 'participant-joined'
  | 'participant-left'
  | 'speaking-started'
  | 'speaking-ended'
  | 'speaking-stopped'
  | 'transcript-update'
  | 'transcript'
  | 'audio-level'
  | 'audio-chunk'
  | 'audio-end'
  | 'turn-granted'
  | 'turn-queued'
  | 'turn-released'
  | 'turn-timeout';

export interface VoiceChatEvent {
  type: VoiceChatEventType;
  participantId?: string;
  data?: unknown;
  text?: string;
  audio?: string;
  timestamp: number;
}

export type VoiceChatEventHandler = (event: VoiceChatEvent) => void;

// OpenAI Realtime specific types
export interface OpenAIRealtimeConfig {
  model: string;
  voice: string;
  instructions?: string;
  inputAudioFormat?: string;
  outputAudioFormat?: string;
  inputAudioTranscription?: {
    model: string;
  };
  turnDetection?: {
    type: 'server_vad';
    threshold?: number;
    prefix_padding_ms?: number;
    silence_duration_ms?: number;
  };
}

export const DEFAULT_OPENAI_CONFIG: OpenAIRealtimeConfig = {
  model: 'gpt-4o-realtime-preview-2024-12-17',
  voice: 'alloy',
  inputAudioFormat: 'pcm16',
  outputAudioFormat: 'pcm16',
  inputAudioTranscription: {
    model: 'whisper-1',
  },
  turnDetection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500,
  },
};

// Gemini Live specific types
export interface GeminiLiveConfig {
  model: string;
  systemInstruction?: string;
  generationConfig?: {
    responseModalities: string[];
    speechConfig?: {
      voiceConfig?: {
        prebuiltVoiceConfig?: {
          voiceName: string;
        };
      };
    };
  };
}

export const DEFAULT_GEMINI_CONFIG: GeminiLiveConfig = {
  model: 'gemini-2.0-flash-exp',
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: 'Puck',
        },
      },
    },
  },
};

// TTS configuration for text models
export interface TTSConfig {
  provider: 'openai' | 'google' | 'browser';
  voice: string;
  speed?: number;
  pitch?: number;
}

// Predefined voices for different providers
export const VOICE_PRESETS: Record<string, TTSConfig> = {
  // OpenAI TTS voices
  'openai-alloy': { provider: 'openai', voice: 'alloy' },
  'openai-coral': { provider: 'openai', voice: 'coral' },
  'openai-sage': { provider: 'openai', voice: 'sage' },
  'openai-nova': { provider: 'openai', voice: 'nova' },

  // Gemini TTS voices
  'gemini-puck': { provider: 'google', voice: 'Puck' },
  'gemini-kore': { provider: 'google', voice: 'Kore' },
  'gemini-charon': { provider: 'google', voice: 'Charon' },
  'gemini-fenrir': { provider: 'google', voice: 'Fenrir' },
  'gemini-aoede': { provider: 'google', voice: 'Aoede' },
};

// Default participant colors
export const PARTICIPANT_COLORS: Record<string, string> = {
  user: '#4CAF50',      // Green
  openai: '#10A37F',    // OpenAI green
  google: '#4285F4',    // Google orange
  anthropic: '#D4A574', // Claude tan
  mistral: '#FF7000',   // Mistral orange
  grok: '#1DA1F2',      // X/Twitter orange
  meta: '#0668E1',      // Meta orange
  perplexity: '#20808D', // Perplexity teal
};
