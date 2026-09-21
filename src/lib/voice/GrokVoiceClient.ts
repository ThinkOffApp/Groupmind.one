// GrokVoiceClient.ts
// xAI Grok Voice Agent API WebSocket client for ThinkOff
// Supports real-time bidirectional audio streaming and event handling

import { VoiceChatEvent, VoiceChatEventHandler } from './types';

export interface GrokVoiceConfig {
  apiKey: string;
  voice?: 'Ara' | 'Rex' | 'Sal' | 'Eve' | 'Leo';
  sampleRate?: number;
  instructions?: string;
}

export class GrokVoiceClient {
  private ws: WebSocket | null = null;
  private config: GrokVoiceConfig;
  private eventHandlers: Set<VoiceChatEventHandler> = new Set();


  constructor(config: GrokVoiceConfig) {
    this.config = config;
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
    for (const handler of this.eventHandlers) handler(fullEvent);
  }

  async connect() {
    if (this.ws) this.disconnect();
    // Connect to Grok Voice Agent API
    this.ws = new WebSocket('wss://api.x.ai/v1/realtime');
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.emit({ type: 'connected', participantId: 'grok' });
      this.sendSessionConfig();
    };
    this.ws.onclose = () => {
      this.emit({ type: 'disconnected', participantId: 'grok' });
    };
    this.ws.onerror = (e) => {
      this.emit({ type: 'error', participantId: 'grok', data: { error: e } });
    };
    this.ws.onmessage = (msg) => {
      this.handleMessage(msg.data);
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;

    }
  }

  setVoice(voice: string) {
    this.config.voice = voice as any;
    this.sendSessionConfig();
  }

  private sendSessionConfig() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const configMsg = {
      type: 'session.update',
      session: {
        instructions: this.config.instructions || 'You are a helpful assistant.',
        voice: this.config.voice || 'Ara',
        turn_detection: { type: 'server_vad' },
        audio: {
          input: { format: { type: 'audio/pcm', rate: this.config.sampleRate || 24000 } },
          output: { format: { type: 'audio/pcm', rate: this.config.sampleRate || 24000 } },
        },
      },
    };
    this.ws.send(JSON.stringify(configMsg));
  }

  sendAudioChunk(base64Audio: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }));
  }

  commitAudioBuffer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
  }

  sendTextMessage(text: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      })
    );
  }

  private handleMessage(data: any) {
    let msg: any;
    try {
      msg = typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
      this.emit({ type: 'error', participantId: 'grok', data: { error: e } });
      return;
    }
    // Handle server events (audio, transcript, etc.)
    switch (msg.type) {
      case 'session.updated':
        // Handle session updated
        break;
      case 'input_audio_buffer.speech_started':
        this.emit({ type: 'speaking-started', participantId: 'user' });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.emit({ type: 'speaking-stopped', participantId: 'user' });
        break;
      case 'conversation.item.input_audio_transcription.completed':
        // This is USER speech, not Grok.
        // Ensure msg.transcript is a string.
        const userText = typeof msg.transcript === 'string' ? msg.transcript : '';
        this.emit({ type: 'transcript', participantId: 'user', text: userText, data: { isFinal: true } });
        break;
      case 'response.output_audio.delta':
        this.emit({ type: 'audio-chunk', participantId: 'grok', audio: msg.delta });
        break;
      case 'response.output_audio.done':
        this.emit({ type: 'audio-end', participantId: 'grok' });
        break;
      case 'response.output_audio_transcript.delta':
        const deltaText = typeof msg.delta === 'string' ? msg.delta : '';
        this.emit({ type: 'transcript', participantId: 'grok', text: deltaText, data: { isFinal: false } });
        break;
      case 'response.output_audio_transcript.done':
        this.emit({ type: 'transcript', participantId: 'grok', text: '', data: { isFinal: true } });
        break;
      case 'error':
        this.emit({ type: 'error', participantId: 'grok', data: { error: msg } });
        break;
      default:
        // Optionally handle other events
        break;
    }
  }
}
