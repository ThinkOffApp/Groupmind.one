// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Multi-AI Voice Chat - Extended Version
 * Supports ALL models including text-only providers with STT/TTS
 * Phase 2: Claude, Mistral, Grok, Meta, Perplexity
 */

import { OpenAIRealtimeClient } from './OpenAIRealtimeClient';
import { GeminiLiveClient } from './GeminiLiveClient';
import { GrokVoiceClient, GrokVoiceConfig } from './GrokVoiceClient';
import { TextModelClient } from './TextModelClient';
import { TTSEngine } from './TTSEngine';
import { STTEngine } from './STTEngine';
import { AudioRouter } from './AudioRouter';
import { TurnManager, TurnMode } from './TurnManager';
import {
  Participant,
  ParticipantConfig,
  ParticipantProvider,
  ConversationMessage,
  VoiceChatEvent,
  VoiceChatEventHandler,
  PARTICIPANT_COLORS,
} from './types';

export interface ExtendedVoiceChatConfig {
  // Realtime providers
  openAiApiKey?: string;
  geminiApiKey?: string;

  // Text providers
  claudeApiKey?: string;
  mistralApiKey?: string;
  grokApiKey?: string;
  metaApiKey?: string;      // Groq API key for Llama
  perplexityApiKey?: string;

  // Voice settings
  openAiVoice?: string;
  geminiVoice?: string;
  claudeVoice?: string;
  mistralVoice?: string;
  grokVoice?: string;
  metaVoice?: string;
  perplexityVoice?: string;

  // ElevenLabs TTS (server-side proxy)
  elevenLabsEndpoint?: string;  // defaults to https://xfor.bot/api/tts
  elevenLabsVoiceId?: string;   // default voice ID

  // General settings
  systemPrompt?: string;
  enabledProviders?: ParticipantProvider[];
}

// Default voices for each provider (for TTS)
const DEFAULT_VOICES: Record<ParticipantProvider, string> = {
  openai: 'alloy',
  google: 'Puck',
  anthropic: 'coral',    // Uses OpenAI TTS
  mistral: 'sage',       // Uses OpenAI TTS
  grok: 'nova',          // Uses OpenAI TTS
  meta: 'echo',          // Uses OpenAI TTS
  perplexity: 'onyx',    // Uses OpenAI TTS
};

// Default stereo positions
const DEFAULT_POSITIONS: Record<ParticipantProvider, number> = {
  openai: -0.8,
  google: 0.8,
  anthropic: -0.4,
  mistral: 0.4,
  grok: -0.6,
  meta: 0.6,
  perplexity: 0,
};

export class MultiAIVoiceChatExtended {
  private audioRouter: AudioRouter;
  private turnManager: TurnManager;
  private ttsEngine: TTSEngine;
  private sttEngine: STTEngine;

  // Realtime clients
  private openAiClient: OpenAIRealtimeClient | null = null;
  private geminiClient: GeminiLiveClient | null = null;
  private grokClient: GrokVoiceClient | null = null;

  // Text clients
  private textClients: Map<ParticipantProvider, TextModelClient> = new Map();

  private config: ExtendedVoiceChatConfig;
  private participants: Map<string, Participant> = new Map();
  private conversationHistory: ConversationMessage[] = [];
  private eventHandlers: Set<VoiceChatEventHandler> = new Set();

  private isConnected = false;
  private crossFeedEnabled = true;
  private currentTranscripts: Map<string, string> = new Map();

  // Turn management for text models
  private textModelQueue: ParticipantProvider[] = [];
  private isProcessingTextModels = false;

  constructor(config: ExtendedVoiceChatConfig) {
    this.config = config;
    this.audioRouter = new AudioRouter();
    this.turnManager = new TurnManager({ mode: 'round-robin' });
    this.ttsEngine = new TTSEngine();
    this.sttEngine = new STTEngine();

    // Wire TurnManager interrupt callback to our interruptAll
    this.turnManager.onInterrupt = (participantId: string) => {
      this.interruptParticipant(participantId);
    };

    // Forward TurnManager events
    this.turnManager.addEventListener((event) => {
      this.emit({ type: event.type as any, participantId: event.participantId, data: event.queuePosition });
    });

    // Set API keys for TTS/STT
    if (config.openAiApiKey) {
      this.ttsEngine.setOpenAIKey(config.openAiApiKey);
      this.sttEngine.setOpenAIKey(config.openAiApiKey);
    }
    if (config.geminiApiKey) {
      this.ttsEngine.setGeminiKey(config.geminiApiKey);
    }

    // Wire ElevenLabs TTS (server-side proxy — highest quality voices)
    const elevenLabsUrl = config.elevenLabsEndpoint || 'https://xfor.bot/api/tts';
    this.ttsEngine.setElevenLabsEndpoint(elevenLabsUrl, config.elevenLabsVoiceId);
  }

  addEventListener(handler: VoiceChatEventHandler) {
    this.eventHandlers.add(handler);
  }

  removeEventListener(handler: VoiceChatEventHandler) {
    this.eventHandlers.delete(handler);
  }

  private emit(event: Omit<VoiceChatEvent, 'timestamp'>) {
    const fullEvent: VoiceChatEvent = {
      ...event,
      timestamp: Date.now(),
    };
    this.eventHandlers.forEach(handler => handler(fullEvent));
  }

  updateVoice(participantId: ParticipantProvider, voiceId: string) {
    console.log(`[ExtendedVoiceChat] Updating voice for ${participantId} to ${voiceId}`);

    // Update data model
    const participant = this.participants.get(participantId);
    if (participant) {
      participant.voice = voiceId;
      this.participants.set(participantId, { ...participant, voice: voiceId });
    }

    // Update realtime clients
    if (participantId === 'openai' && this.openAiClient) {
      this.openAiClient.setVoice(voiceId);
    } else if (participantId === 'grok' && this.grokClient) {
      this.grokClient.setVoice(voiceId);
    }
  }

  /**
   * Connect to all configured AI participants
   */
  async connect(): Promise<void> {
    try {
      // Initialize audio router
      const micStream = await this.audioRouter.initialize({
        onMicrophoneAudio: (audioData) => this.handleMicrophoneAudio(audioData),
        onAudioLevel: (participantId, level) => this.handleAudioLevel(participantId, level),
      });

      // Add user
      this.addParticipant({
        id: 'user',
        name: 'You',
        type: 'realtime',
        provider: 'openai',
        apiKey: '',
        stereoPosition: 0,
        color: PARTICIPANT_COLORS.user,
      });



      // Connect realtime providers
      if (this.config.openAiApiKey) {
        await this.connectOpenAI(micStream);
      }
      if (this.config.geminiApiKey) {
        await this.connectGemini();
      }
      if (this.config.grokApiKey) {
        await this.connectGrok();
      }


      // Connect text providers
      if (this.config.claudeApiKey) {
        await this.connectTextModel('anthropic', this.config.claudeApiKey, 'Claude');
      }
      if (this.config.mistralApiKey) {
        await this.connectTextModel('mistral', this.config.mistralApiKey, 'Mistral');
      }

      if (this.config.metaApiKey) {
        await this.connectTextModel('meta', this.config.metaApiKey, 'Llama');
      }
      if (this.config.perplexityApiKey) {
        await this.connectTextModel('perplexity', this.config.perplexityApiKey, 'Perplexity');
      }

      // Start browser STT for text models (fallback)
      if (this.textClients.size > 0 && !this.config.openAiApiKey) {
        this.sttEngine.startRealtime((text, isFinal) => {
          if (isFinal) {
            this.handleUserTranscript(text);
          }
        });
      }

      this.isConnected = true;
      this.emit({ type: 'connected' });
      console.log('[ExtendedVoiceChat] All participants connected');

    } catch (error) {
      console.error('[ExtendedVoiceChat] Connection error:', error);
      this.emit({ type: 'error', data: error });
      throw error;
    }
  }

  private async connectGrok(): Promise<void> {
    // Only connect if grokApiKey is present
    const grokConfig: GrokVoiceConfig = {
      apiKey: this.config.grokApiKey!,
      voice: (this.config.grokVoice as any) || 'Ara',
      sampleRate: 24000,
      instructions: this.config.systemPrompt ||
        'PROTOCOL: 3-Way Human-Like Collab.\n' +
        '1. ABSOLUTE TURN-TAKING: Only ONE person speaks at a time. If OpenAI, Gemini, or User is speaking, you are SILENT.\n' +
        '2. PASS THE BATON: End every turn by asking the next person: "Gemini, what do you think?" or "User, your call?".\n' +
        '3. LISTEN & ACKNOWLEDGE: Start by acknowledging what the previous speaker said ("Good point, Gemini...").\n' +
        '4. SHORT BURSTS: 1-2 Sentences MAX. No monologue.\n' +
        '5. MUTUAL RESPECT: Treat Gemini and OpenAI as equal partners, not assistants.'
    };
    this.grokClient = new GrokVoiceClient(grokConfig);

    this.grokClient.addEventListener((event) => {
      // HANDLE USER EXCLUSIVE SPEECH
      if (event.type === 'speaking-started' && event.participantId === 'user') {
        console.log('[ExtendedVoiceChat] User started speaking (via Grok VAD) - Interrupting others');
        this.turnManager.forceInterrupt('user');
        this.emit(event);
        return;
      }
      if (event.type === 'speaking-stopped' && event.participantId === 'user') {
        this.turnManager.releaseTurn('user');
        // Enqueue AI response round after user finishes
        this.turnManager.enqueueResponseRound();
        this.emit(event);
        return;
      }

      // Handle Grok audio — gate through TurnManager
      if (event.type === 'audio-end' && event.participantId === 'grok') {
        this.turnManager.releaseTurn('grok');
        this.handleParticipantResponse('grok', 'Grok');
      }
      if (event.type === 'audio-chunk' && event.participantId === 'grok' && event.audio) {
        if (this.turnManager.shouldPlayAudio('grok')) {
          this.audioRouter.playAudio('grok', this.base64ToArrayBuffer(event.audio));
          // Emit speaking-started on first granted chunk
          const participant = this.participants.get('grok');
          if (participant && !participant.isSpeaking) {
            this.updateParticipantState('grok', { isSpeaking: true });
            this.emit({ type: 'speaking-started', participantId: 'grok' });
          }
        }
        return;
      }
      if (event.type === 'transcript' && event.participantId === 'grok' && event.text) {
        let textPart = event.text;
        if (typeof textPart !== 'string') {
          console.warn('[ExtendedVoiceChat] Grok transcript was not a string:', textPart);
          textPart = '';
        }
        const current = this.currentTranscripts.get('grok') || '';
        const safeText = textPart || '';
        this.currentTranscripts.set('grok', current + safeText);
        const safeEvent = { ...event, text: safeText };
        this.emit(safeEvent);
        return;
      }
      this.emit(event);
    });

    this.addParticipant({
      id: 'grok',
      name: 'Grok',
      type: 'realtime',
      provider: 'grok',
      apiKey: this.config.grokApiKey!,
      stereoPosition: DEFAULT_POSITIONS.grok,
      color: PARTICIPANT_COLORS.grok,
    });

    this.audioRouter.createParticipantNode('grok', DEFAULT_POSITIONS.grok);
    await this.grokClient.connect();
    this.updateParticipantState('grok', { isConnected: true });
    this.emit({ type: 'participant-joined', participantId: 'grok' });
  }

  // Helper to decode base64 PCM audio to ArrayBuffer
  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private async connectOpenAI(micStream: MediaStream): Promise<void> {
    this.openAiClient = new OpenAIRealtimeClient(this.config.openAiApiKey!, {
      voice: this.config.openAiVoice || DEFAULT_VOICES.openai,
      instructions: this.config.systemPrompt ||
        'PROTOCOL: 3-Way Human-Like Collab. \n' +
        '1. ABSOLUTE TURN-TAKING: Only ONE person speaks at a time. If Gemini or User is speaking, you are SILENT. \n' +
        '2. PASS THE BATON: End every turn by asking the next person: "Gemini, what do you think?" or "User, your call?". \n' +
        '3. LISTEN & ACKNOWLEDGE: Start by acknowledging what the previous speaker said ("Good point, Gemini..."). \n' +
        '4. SHORT BURSTS: 1-2 Sentences MAX. No monologue. \n' +
        '5. MUTUAL RESPECT: Treat Gemini as an equal partner, not an assistant.',
    });

    this.openAiClient.onAudioOutput = (stream) => {
      // Gate through TurnManager
      if (!this.turnManager.shouldPlayAudio('openai')) {
        this.openAiClient?.interrupt();
        return;
      }

      // Emit speaking-started on first granted stream
      const participant = this.participants.get('openai');
      if (participant && !participant.isSpeaking) {
        this.updateParticipantState('openai', { isSpeaking: true });
        this.emit({ type: 'speaking-started', participantId: 'openai' });
      }

      this.audioRouter.connectStream('openai', stream);

      // Cross-feed to other realtime participant
      if (this.crossFeedEnabled && this.geminiClient) {
        this.audioRouter.captureStream(stream, (pcmData) => {
          this.geminiClient!.sendAudio(pcmData);
        });
      }
    };

    this.openAiClient.onTranscript = (text, isFinal) => {
      if (isFinal) {
        this.handleUserTranscript(text);
      }
    };

    this.openAiClient.onResponseText = (text) => {
      const current = this.currentTranscripts.get('openai') || '';
      this.currentTranscripts.set('openai', current + text);
    };

    this.openAiClient.addEventListener((event) => {
      if (event.type === 'speaking-ended' && event.participantId === 'openai') {
        this.updateParticipantState('openai', { isSpeaking: false });
        this.turnManager.releaseTurn('openai');
        this.handleParticipantResponse('openai', 'GPT-5.2');
      }
      this.emit(event);
    });

    this.addParticipant({
      id: 'openai',
      name: 'GPT-5.2',
      type: 'realtime',
      provider: 'openai',
      apiKey: this.config.openAiApiKey!,
      stereoPosition: DEFAULT_POSITIONS.openai,
      color: PARTICIPANT_COLORS.openai,
    });

    this.audioRouter.createParticipantNode('openai', DEFAULT_POSITIONS.openai);
    await this.openAiClient.connect(micStream);
    this.updateParticipantState('openai', { isConnected: true });
    this.emit({ type: 'participant-joined', participantId: 'openai' });
  }

  private async connectGemini(): Promise<void> {
    this.geminiClient = new GeminiLiveClient(this.config.geminiApiKey!, {
      systemInstruction: this.config.systemPrompt ||
        'PROTOCOL: 3-Way Human-Like Collab. \n' +
        '1. ABSOLUTE TURN-TAKING: Only ONE person speaks at a time. If user or GPT is speaking, you are SILENT. \n' +
        '2. PASS THE BATON: End every turn by asking the next person: "GPT, thoughts?" or "User, do you agree?". \n' +
        '3. LISTEN & ACKNOWLEDGE: Start by acknowledging what the previous speaker said ("Exactly, GPT..."). \n' +
        '4. SHORT BURSTS: 1-2 Sentences MAX. No monologue. \n' +
        '5. MUTUAL RESPECT: Treat GPT as an equal partner, not an assistant.',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.geminiVoice || DEFAULT_VOICES.google,
            },
          },
        },
      },
    });

    this.geminiClient.onAudioOutput = (audioData) => {
      // Gate through TurnManager
      if (!this.turnManager.shouldPlayAudio('google')) {
        this.geminiClient?.interrupt();
        return;
      }

      // Emit speaking-started on first granted chunk
      const participant = this.participants.get('google');
      if (participant && !participant.isSpeaking) {
        this.updateParticipantState('google', { isSpeaking: true });
        this.emit({ type: 'speaking-started', participantId: 'google' });
      }

      this.audioRouter.playAudio('google', audioData);

      if (this.crossFeedEnabled && this.openAiClient) {
        this.openAiClient.sendAudio(audioData);
      }
    };

    this.geminiClient.onResponseText = (text) => {
      const current = this.currentTranscripts.get('google') || '';
      this.currentTranscripts.set('google', current + text);
    };

    this.geminiClient.addEventListener((event) => {
      if (event.type === 'speaking-ended' && event.participantId === 'google') {
        this.updateParticipantState('google', { isSpeaking: false });
        this.turnManager.releaseTurn('google');
        this.handleParticipantResponse('google', 'Gemini');
      }
      this.emit(event);
    });

    this.addParticipant({
      id: 'google',
      name: 'Gemini',
      type: 'realtime',
      provider: 'google',
      apiKey: this.config.geminiApiKey!,
      stereoPosition: DEFAULT_POSITIONS.google,
      color: PARTICIPANT_COLORS.google,
    });

    this.audioRouter.createParticipantNode('google', DEFAULT_POSITIONS.google);
    await this.geminiClient.connect();
    this.updateParticipantState('google', { isConnected: true });
    this.emit({ type: 'participant-joined', participantId: 'google' });
  }

  private async connectTextModel(
    provider: ParticipantProvider,
    apiKey: string,
    name: string
  ): Promise<void> {
    const client = new TextModelClient({
      provider,
      apiKey,
      systemPrompt: this.config.systemPrompt ||
        'ROLE: We are a team of humans working together. \n' +
        '1. BE BRIEF: 1-2 sentences max. \n' +
        '2. COLLABORATE: Build on what others say. \n' +
        '3. NO LECTURES: Keep it casual and fast.',
      maxTokens: 150, // Keep responses short for voice
    });

    client.onResponse = (text) => {
      this.handleTextModelResponse(provider, name, text);
    };

    this.textClients.set(provider, client);

    const voiceKey = `${provider}Voice` as keyof ExtendedVoiceChatConfig;
    const voice = (this.config[voiceKey] as string) || DEFAULT_VOICES[provider];

    this.addParticipant({
      id: provider,
      name,
      type: 'text',
      provider,
      apiKey,
      voice,
      stereoPosition: DEFAULT_POSITIONS[provider],
      color: PARTICIPANT_COLORS[provider],
    });

    this.audioRouter.createParticipantNode(provider, DEFAULT_POSITIONS[provider]);
    this.updateParticipantState(provider, { isConnected: true });
    this.emit({ type: 'participant-joined', participantId: provider });

    console.log(`[ExtendedVoiceChat] ${name} connected (text model)`);
  }

  private handleMicrophoneAudio(audioData: ArrayBuffer) {
    // Send to realtime providers
    if (this.geminiClient) {
      this.geminiClient.sendAudio(audioData);
    }
    // OpenAI receives via WebRTC track automatically
    if (this.grokClient) {
      // Convert PCM ArrayBuffer to base64
      const base64Audio = this.arrayBufferToBase64(audioData);
      this.grokClient.sendAudioChunk(base64Audio);
    }

  }

  // Helper to encode ArrayBuffer PCM to base64
  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }


  private async handleUserTranscript(text: string) {
    if (!text.trim()) return;

    console.log(`[ExtendedVoiceChat] User said: "${text}"`);
    this.addToHistory('user', 'You', text);

    // Send to all text models
    this.textModelQueue = Array.from(this.textClients.keys());
    this.processTextModelQueue(text);
  }

  private async processTextModelQueue(userMessage: string) {
    if (this.isProcessingTextModels || this.textModelQueue.length === 0) return;

    this.isProcessingTextModels = true;

    while (this.textModelQueue.length > 0) {
      const provider = this.textModelQueue.shift()!;
      const client = this.textClients.get(provider);

      if (client) {
        try {
          // Build context from recent conversation
          const context = this.buildContextForTextModel(provider);
          await client.send(context + userMessage);

          // Small delay between models to avoid overlap
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`[ExtendedVoiceChat] ${provider} error:`, error);
        }
      }
    }

    this.isProcessingTextModels = false;
  }

  private buildContextForTextModel(forProvider: ParticipantProvider): string {
    // Get recent messages from other participants
    const recent = this.conversationHistory.slice(-6);
    const context = recent
      .filter(m => m.participantId !== forProvider)
      .map(m => `[${m.participantName}]: ${m.content}`)
      .join('\n');

    return context ? context + '\n\n' : '';
  }

  private async handleTextModelResponse(
    provider: ParticipantProvider,
    name: string,
    text: string
  ) {
    console.log(`[ExtendedVoiceChat] ${name} responded: "${text}"`);

    this.addToHistory(provider, name, text);

    // Wait for turn from TurnManager
    const granted = this.turnManager.requestTurn(provider);
    if (!granted) {
      // Queued — wait for turn-granted event
      await new Promise<void>((resolve) => {
        const handler = (event: { type: string; participantId: string }) => {
          if (event.type === 'turn-granted' && event.participantId === provider) {
            this.turnManager.removeEventListener(handler);
            resolve();
          }
        };
        this.turnManager.addEventListener(handler);
      });
    }

    this.emit({ type: 'speaking-started', participantId: provider });

    // Convert to speech using TTS
    const participant = this.participants.get(provider);
    const voice = participant?.voice || DEFAULT_VOICES[provider];

    try {
      const audioData = await this.ttsEngine.synthesize(text, { voice });

      if (audioData.byteLength > 0) {
        // Play through audio router
        this.audioRouter.playAudio(provider, audioData);

        // Cross-feed to realtime models
        if (this.crossFeedEnabled) {
          if (this.openAiClient) {
            this.openAiClient.sendText(text, name);
          }
          if (this.geminiClient) {
            this.geminiClient.sendText(text, name);
          }

          // Cross-feed to other text models
          for (const [otherId, otherClient] of this.textClients) {
            if (otherId !== provider) {
              otherClient.addContext(`[${name}]: ${text}`);
            }
          }
        }
      }
    } catch (error) {
      console.error(`[ExtendedVoiceChat] TTS error for ${name}:`, error);
    }

    this.emit({ type: 'speaking-ended', participantId: provider });
    this.turnManager.releaseTurn(provider);
  }

  private handleParticipantResponse(participantId: string, name: string) {
    let transcript = this.currentTranscripts.get(participantId);
    if (typeof transcript !== 'string') {
      if (transcript) console.warn('[ExtendedVoiceChat] Transcript was not a string:', transcript);
      transcript = '';
    }
    if (transcript && transcript.trim().length > 0) {
      this.addToHistory(participantId, name, transcript);

      // Cross-feed to text models
      if (this.crossFeedEnabled) {
        for (const [, client] of this.textClients) {
          client.addContext(`[${name}]: ${transcript}`);
        }

        // Cross-feed to other realtime model
        if (participantId === 'openai' && this.geminiClient) {
          this.geminiClient.sendText(transcript, name);
        } else if (participantId === 'google' && this.openAiClient) {
          this.openAiClient.sendText(transcript, name);
        }
      }

      this.currentTranscripts.set(participantId, '');
    }
  }

  private handleAudioLevel(participantId: string, level: number) {
    const participant = this.participants.get(participantId);
    if (participant) {
      const isSpeaking = level > 0.1;
      if (participant.isSpeaking !== isSpeaking) {
        this.updateParticipantState(participantId, { isSpeaking });
      }
    }
    this.emit({ type: 'audio-level', participantId, data: level });
  }

  private addParticipant(config: ParticipantConfig) {
    const participant: Participant = {
      id: config.id,
      name: config.name,
      type: config.type,
      provider: config.provider,
      voice: config.voice,
      stereoPosition: config.stereoPosition ?? 0,
      color: config.color || PARTICIPANT_COLORS[config.provider] || '#888888',
      isConnected: false,
      isSpeaking: false,
      isMuted: false,
    };
    this.participants.set(config.id, participant);

    // Register with TurnManager for turn-taking (skip 'user')
    if (config.id !== 'user') {
      this.turnManager.addParticipant(config.id);
    }
  }

  private updateParticipantState(id: string, updates: Partial<Participant>) {
    const participant = this.participants.get(id);
    if (participant) {
      Object.assign(participant, updates);
    }
  }

  private addToHistory(participantId: string, participantName: string, content: string) {
    if (typeof content !== 'string') {
      console.error('[ExtendedVoiceChat] addToHistory received non-string content:', content);
      content = String(content); // Fallback to string representation, though likely [object Object]
      if (content === '[object Object]') return; // Drop it completely
    }
    const message: ConversationMessage = {
      id: `${Date.now()}-${participantId}`,
      participantId,
      participantName,
      role: participantId === 'user' ? 'user' : 'assistant',
      content,
      timestamp: Date.now(),
    };
    this.conversationHistory.push(message);
    this.emit({ type: 'transcript-update', participantId, data: content });
  }

  // Public methods

  setCrossFeedEnabled(enabled: boolean) {
    this.crossFeedEnabled = enabled;
  }

  setTurnMode(mode: TurnMode) {
    this.turnManager.setMode(mode);
  }

  getTurnMode(): TurnMode {
    return this.turnManager.getMode();
  }

  getCurrentSpeaker(): string | null {
    return this.turnManager.getCurrentSpeaker();
  }

  getTurnQueue(): string[] {
    return this.turnManager.getQueue();
  }

  setParticipantMuted(participantId: string, muted: boolean) {
    this.audioRouter.setMuted(participantId, muted);
    this.updateParticipantState(participantId, { isMuted: muted });
  }

  setParticipantVolume(participantId: string, volume: number) {
    this.audioRouter.setVolume(participantId, volume);
  }

  sendTextMessage(text: string) {
    this.handleUserTranscript(text);

    // Also send to realtime models
    if (this.openAiClient) {
      this.openAiClient.sendText(text, 'You');
    }
    if (this.geminiClient) {
      this.geminiClient.sendText(text, 'You');
    }
  }

  /** Interrupt a specific participant's output */
  private interruptParticipant(participantId: string) {
    if (participantId === 'openai' && this.openAiClient) this.openAiClient.interrupt();
    if (participantId === 'google' && this.geminiClient) this.geminiClient.interrupt();
    // Grok relies on VAD, no explicit interrupt
    if (['anthropic', 'mistral', 'meta', 'perplexity'].includes(participantId)) this.ttsEngine.stop();
  }

  interruptAll(exceptParticipantId?: string) {
    if (this.openAiClient && exceptParticipantId !== 'openai') this.openAiClient.interrupt();
    if (this.geminiClient && exceptParticipantId !== 'google') this.geminiClient.interrupt();
    if (this.grokClient && exceptParticipantId !== 'grok') {
      // Grok VAD handles it; no explicit interrupt available
    }
    if (exceptParticipantId !== 'tts') this.ttsEngine.stop();
    this.textModelQueue = [];
  }

  getParticipants(): Participant[] {
    return Array.from(this.participants.values());
  }

  getHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  disconnect() {

    if (this.openAiClient) {
      this.openAiClient.disconnect();
      this.openAiClient = null;
    }
    if (this.geminiClient) {
      this.geminiClient.disconnect();
      this.geminiClient = null;
    }
    if (this.grokClient) {
      this.grokClient.disconnect();
      this.grokClient = null;
    }

    this.textClients.clear();
    this.audioRouter.dispose();
    this.turnManager.dispose();
    this.ttsEngine.dispose();
    this.sttEngine.dispose();

    this.participants.clear();
    this.conversationHistory = [];
    this.isConnected = false;

    this.emit({ type: 'disconnected' });
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }

  getAudioAnalyser(): AnalyserNode | null {
    return this.audioRouter.getMasterAnalyser();
  }
}
