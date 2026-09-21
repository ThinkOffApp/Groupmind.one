/**
 * Multi-AI Voice Chat Orchestrator
 * Coordinates multiple AI participants in a real-time voice conversation
 * Phase 1: Realtime APIs only (OpenAI, Gemini)
 */

import { OpenAIRealtimeClient } from './OpenAIRealtimeClient';
import { GeminiLiveClient } from './GeminiLiveClient';
import { AudioRouter } from './AudioRouter';
import {
  Participant,
  ParticipantConfig,
  ConversationMessage,
  VoiceChatState,
  VoiceChatEvent,
  VoiceChatEventHandler,
  PARTICIPANT_COLORS,
} from './types';

export interface MultiAIVoiceChatConfig {
  openAiApiKey?: string;
  geminiApiKey?: string;
  openAiVoice?: string;
  geminiVoice?: string;
  systemPrompt?: string;
}

export class MultiAIVoiceChat {
  private audioRouter: AudioRouter;
  private openAiClient: OpenAIRealtimeClient | null = null;
  private geminiClient: GeminiLiveClient | null = null;
  private config: MultiAIVoiceChatConfig;
  
  private participants: Map<string, Participant> = new Map();
  private conversationHistory: ConversationMessage[] = [];
  private eventHandlers: Set<VoiceChatEventHandler> = new Set();
  
  private isConnected = false;
  private currentTranscripts: Map<string, string> = new Map();

  // Cross-feed control
  private crossFeedEnabled = true;

  constructor(config: MultiAIVoiceChatConfig) {
    this.config = config;
    this.audioRouter = new AudioRouter();
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

  /**
   * Connect to all configured AI participants
   */
  async connect(): Promise<void> {
    try {
      // Initialize audio router and get microphone
      const micStream = await this.audioRouter.initialize({
        onMicrophoneAudio: (audioData) => this.handleMicrophoneAudio(audioData),
        onAudioLevel: (participantId, level) => this.handleAudioLevel(participantId, level),
      });

      // Add user as participant
      this.addParticipant({
        id: 'user',
        name: 'You',
        type: 'realtime',
        provider: 'openai', // Placeholder
        apiKey: '',
        stereoPosition: 0,
        color: PARTICIPANT_COLORS.user,
      });

      // Connect to OpenAI if API key provided
      if (this.config.openAiApiKey) {
        await this.connectOpenAI(micStream);
      }

      // Connect to Gemini if API key provided
      if (this.config.geminiApiKey) {
        await this.connectGemini();
      }

      this.isConnected = true;
      this.emit({ type: 'connected' });
      console.log('[MultiAIVoiceChat] All participants connected');

    } catch (error) {
      console.error('[MultiAIVoiceChat] Connection error:', error);
      this.emit({ type: 'error', data: error });
      throw error;
    }
  }

  private async connectOpenAI(micStream: MediaStream): Promise<void> {
    this.openAiClient = new OpenAIRealtimeClient(this.config.openAiApiKey!, {
      voice: this.config.openAiVoice || 'alloy',
      instructions: this.config.systemPrompt,
    });

    // Set up audio output handling
    this.openAiClient.onAudioOutput = (stream) => {
      this.audioRouter.connectStream('openai', stream);
      
      // Cross-feed to Gemini
      if (this.crossFeedEnabled && this.geminiClient) {
        this.audioRouter.captureStream(stream, (pcmData) => {
          this.geminiClient!.sendAudio(pcmData);
        });
      }
    };

    // Set up transcript handling
    this.openAiClient.onTranscript = (text, isFinal) => {
      if (isFinal) {
        this.addToHistory('user', 'You', text);
      }
    };

    this.openAiClient.onResponseText = (text) => {
      const current = this.currentTranscripts.get('openai') || '';
      this.currentTranscripts.set('openai', current + text);
    };

    // Listen for events
    this.openAiClient.addEventListener((event) => {
      if (event.type === 'speaking-ended' && event.participantId === 'openai') {
        const transcript = this.currentTranscripts.get('openai') || '';
        if (transcript) {
          this.addToHistory('openai', 'GPT-5.2', transcript);
          
          // Cross-feed transcript to Gemini
          if (this.crossFeedEnabled && this.geminiClient) {
            this.geminiClient.sendText(transcript, 'GPT-5.2');
          }
          
          this.currentTranscripts.set('openai', '');
        }
      }
      this.emit(event);
    });

    // Add participant
    this.addParticipant({
      id: 'openai',
      name: 'GPT-5.2',
      type: 'realtime',
      provider: 'openai',
      apiKey: this.config.openAiApiKey!,
      stereoPosition: -0.7, // Left
      color: PARTICIPANT_COLORS.openai,
    });

    // Create audio node
    this.audioRouter.createParticipantNode('openai', -0.7);

    // Connect
    await this.openAiClient.connect(micStream);
    this.updateParticipantState('openai', { isConnected: true });
    
    this.emit({ type: 'participant-joined', participantId: 'openai' });
    console.log('[MultiAIVoiceChat] OpenAI connected');
  }

  private async connectGemini(): Promise<void> {
    this.geminiClient = new GeminiLiveClient(this.config.geminiApiKey!, {
      systemInstruction: this.config.systemPrompt,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: this.config.geminiVoice || 'Puck',
            },
          },
        },
      },
    });

    // Set up audio output handling
    this.geminiClient.onAudioOutput = (audioData) => {
      this.audioRouter.playAudio('google', audioData);
      
      // Cross-feed to OpenAI
      if (this.crossFeedEnabled && this.openAiClient) {
        this.openAiClient.sendAudio(audioData);
      }
    };

    this.geminiClient.onResponseText = (text) => {
      const current = this.currentTranscripts.get('google') || '';
      this.currentTranscripts.set('google', current + text);
    };

    // Listen for events
    this.geminiClient.addEventListener((event) => {
      if (event.type === 'speaking-ended' && event.participantId === 'google') {
        const transcript = this.currentTranscripts.get('google') || '';
        if (transcript) {
          this.addToHistory('google', 'Gemini', transcript);
          
          // Cross-feed transcript to OpenAI
          if (this.crossFeedEnabled && this.openAiClient) {
            this.openAiClient.sendText(transcript, 'Gemini');
          }
          
          this.currentTranscripts.set('google', '');
        }
      }
      this.emit(event);
    });

    // Add participant
    this.addParticipant({
      id: 'google',
      name: 'Gemini',
      type: 'realtime',
      provider: 'google',
      apiKey: this.config.geminiApiKey!,
      stereoPosition: 0.7, // Right
      color: PARTICIPANT_COLORS.google,
    });

    // Create audio node
    this.audioRouter.createParticipantNode('google', 0.7);

    // Connect
    await this.geminiClient.connect();
    this.updateParticipantState('google', { isConnected: true });
    
    this.emit({ type: 'participant-joined', participantId: 'google' });
    console.log('[MultiAIVoiceChat] Gemini connected');
  }

  private handleMicrophoneAudio(audioData: ArrayBuffer) {
    // Send to OpenAI (via WebRTC, already connected)
    // OpenAI receives mic audio automatically through WebRTC track
    
    // Send to Gemini via WebSocket
    if (this.geminiClient) {
      this.geminiClient.sendAudio(audioData);
    }
  }

  private handleAudioLevel(participantId: string, level: number) {
    const participant = this.participants.get(participantId);
    if (participant) {
      const isSpeaking = level > 0.1;
      if (participant.isSpeaking !== isSpeaking) {
        this.updateParticipantState(participantId, { isSpeaking });
        this.emit({
          type: isSpeaking ? 'speaking-started' : 'speaking-ended',
          participantId,
        });
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
  }

  private updateParticipantState(id: string, updates: Partial<Participant>) {
    const participant = this.participants.get(id);
    if (participant) {
      Object.assign(participant, updates);
    }
  }

  private addToHistory(participantId: string, participantName: string, content: string) {
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

  /**
   * Enable/disable cross-feeding (AIs hearing each other)
   */
  setCrossFeedEnabled(enabled: boolean) {
    this.crossFeedEnabled = enabled;
    console.log(`[MultiAIVoiceChat] Cross-feed ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Mute/unmute a participant
   */
  setParticipantMuted(participantId: string, muted: boolean) {
    this.audioRouter.setMuted(participantId, muted);
    this.updateParticipantState(participantId, { isMuted: muted });
    
    if (participantId === 'openai' && this.openAiClient) {
      this.openAiClient.setMuted(muted);
    }
  }

  /**
   * Set volume for a participant
   */
  setParticipantVolume(participantId: string, volume: number) {
    this.audioRouter.setVolume(participantId, volume);
  }

  /**
   * Set stereo position for a participant
   */
  setParticipantPosition(participantId: string, position: number) {
    this.audioRouter.setStereoPosition(participantId, position);
    this.updateParticipantState(participantId, { stereoPosition: position });
  }

  /**
   * Send a text message to all participants
   */
  sendTextMessage(text: string) {
    // Add to history as user
    this.addToHistory('user', 'You', text);
    
    // Send to all AI participants
    if (this.openAiClient) {
      this.openAiClient.sendText(text, 'You');
    }
    if (this.geminiClient) {
      this.geminiClient.sendText(text, 'You');
    }
  }

  /**
   * Interrupt all AI responses
   */
  interruptAll() {
    if (this.openAiClient) {
      this.openAiClient.interrupt();
    }
    if (this.geminiClient) {
      this.geminiClient.interrupt();
    }
  }

  /**
   * Get current state
   */
  getState(): VoiceChatState {
    return {
      isConnected: this.isConnected,
      isConnecting: false,
      error: null,
      participants: new Map(this.participants),
      currentSpeaker: null,
      conversationHistory: [...this.conversationHistory],
      transcript: '',
    };
  }

  /**
   * Get all participants
   */
  getParticipants(): Participant[] {
    return Array.from(this.participants.values());
  }

  /**
   * Get conversation history
   */
  getHistory(): ConversationMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * Disconnect all participants
   */
  disconnect() {
    if (this.openAiClient) {
      this.openAiClient.disconnect();
      this.openAiClient = null;
    }

    if (this.geminiClient) {
      this.geminiClient.disconnect();
      this.geminiClient = null;
    }

    this.audioRouter.dispose();
    this.participants.clear();
    this.conversationHistory = [];
    this.currentTranscripts.clear();
    this.isConnected = false;

    this.emit({ type: 'disconnected' });
    console.log('[MultiAIVoiceChat] Disconnected');
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}
