/**
 * Voice Chat Module - GroupMind
 * Ported from Muikku (thinkoff.app)
 */

// Types
export * from './types';

// Realtime Clients
export { OpenAIRealtimeClient } from './OpenAIRealtimeClient';
export { GeminiLiveClient } from './GeminiLiveClient';
export { GrokVoiceClient } from './GrokVoiceClient';

// Text Model Client
export { TextModelClient } from './TextModelClient';
export type { TextModelConfig } from './TextModelClient';

// TTS/STT Engines
export { TTSEngine } from './TTSEngine';
export { STTEngine } from './STTEngine';

// Audio
export { AudioRouter } from './AudioRouter';

// Turn Management
export { TurnManager } from './TurnManager';
export type { TurnMode } from './TurnManager';

// Orchestrator
export { MultiAIVoiceChatExtended } from './MultiAIVoiceChatExtended';
export type { ExtendedVoiceChatConfig } from './MultiAIVoiceChatExtended';

// React integration
export { useVoiceChat } from './useVoiceChat';
export type { UseVoiceChatState, UseVoiceChatActions, UseVoiceChatReturn } from './useVoiceChat';
