/**
 * Gemini Live API Client
 * Handles WebSocket connection to Google's Gemini Live API for real-time voice
 */

import {
  GeminiLiveConfig,
  DEFAULT_GEMINI_CONFIG,
  VoiceChatEvent,
  VoiceChatEventHandler,
} from './types';

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private config: GeminiLiveConfig;
  private apiKey: string;
  private eventHandlers: Set<VoiceChatEventHandler> = new Set();
  private isConnected = false;
  private audioContext: AudioContext | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private isPlaying = false;
  private currentSource: AudioBufferSourceNode | null = null;

  // Callbacks for cross-feeding
  public onAudioOutput: ((audioData: ArrayBuffer) => void) | null = null;
  public onTranscript: ((text: string, isFinal: boolean) => void) | null = null;
  public onResponseText: ((text: string) => void) | null = null;

  constructor(apiKey: string, config: Partial<GeminiLiveConfig> = {}) {
    this.apiKey = apiKey;
    this.config = { ...DEFAULT_GEMINI_CONFIG, ...config };
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

  async connect(): Promise<void> {
    try {
      // Initialize audio context for playback
      this.audioContext = new AudioContext({ sampleRate: 24000 });

      // Connect to Gemini Live WebSocket
      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${this.apiKey}`;

      this.ws = new WebSocket(wsUrl);

      return new Promise((resolve, reject) => {
        this.ws!.onopen = () => {
          console.log('[Gemini] WebSocket connected');
          this.sendSetupMessage();
          this.isConnected = true;
          this.emit({ type: 'connected', participantId: 'google' });
          resolve();
        };

        this.ws!.onerror = (error) => {
          console.error('[Gemini] WebSocket error:', error);
          this.emit({ type: 'error', data: error });
          reject(error);
        };

        this.ws!.onclose = (event) => {
          console.log('[Gemini] WebSocket closed:', event.code, event.reason);
          this.isConnected = false;
          this.emit({ type: 'disconnected', participantId: 'google' });
        };

        this.ws!.onmessage = (event) => {
          this.handleMessage(event.data);
        };
      });

    } catch (error) {
      console.error('[Gemini] Connection error:', error);
      this.emit({ type: 'error', data: error });
      throw error;
    }
  }

  private sendSetupMessage() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const setupMessage = {
      setup: {
        model: `models/${this.config.model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: this.config.generationConfig?.speechConfig || {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Puck',
              },
            },
          },
        },
        systemInstruction: {
          parts: [
            {
              text: this.config.systemInstruction ||
                'You are participating in a multi-AI voice conversation. Be concise and conversational. You may hear other AI participants - engage with them naturally.',
            },
          ],
        },
      },
    };

    console.log('[Gemini] Sending setup message:', JSON.stringify(setupMessage, null, 2));
    this.ws.send(JSON.stringify(setupMessage));
    console.log('[Gemini] Setup message sent');
  }

  private async handleMessage(data: string | Blob) {
    try {
      let jsonData: string;

      if (data instanceof Blob) {
        jsonData = await data.text();
      } else {
        jsonData = data;
      }

      const message = JSON.parse(jsonData);

      // Handle setup complete
      if (message.setupComplete) {
        console.log('[Gemini] Setup complete');
        return;
      }

      // Handle server content (model responses)
      if (message.serverContent) {
        const serverContent = message.serverContent;

        // Handle model turn (audio/text response)
        if (serverContent.modelTurn) {
          const parts = serverContent.modelTurn.parts || [];

          for (const part of parts) {
            // Handle audio data
            if (part.inlineData && part.inlineData.mimeType?.startsWith('audio/')) {
              const audioBase64 = part.inlineData.data;
              const audioData = this.base64ToArrayBuffer(audioBase64);

              this.audioQueue.push(audioData);
              this.playAudioQueue();

              // Notify for cross-feeding
              if (this.onAudioOutput) {
                this.onAudioOutput(audioData);
              }
            }

            // Handle text transcript
            if (part.text) {
              const textContent = typeof part.text === 'string' ? part.text : '';
              if (textContent && this.onResponseText) {
                this.onResponseText(textContent);
              }
              this.emit({
                type: 'transcript-update',
                participantId: 'google',
                data: textContent,
              });
            }
          }
        }

        // Handle turn complete
        if (serverContent.turnComplete) {
          console.log('[Gemini] Turn complete');
          this.emit({ type: 'speaking-ended', participantId: 'google' });
        }

        // Handle interruption
        if (serverContent.interrupted) {
          console.log('[Gemini] Response interrupted');
          this.audioQueue = [];
          this.emit({ type: 'speaking-ended', participantId: 'google' });
        }
      }

      // Handle tool calls (if any)
      if (message.toolCall) {
        console.log('[Gemini] Tool call:', message.toolCall);
      }

    } catch (error) {
      console.error('[Gemini] Error handling message:', error);
    }
  }

  private base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private async playAudioQueue() {
    if (this.isPlaying || this.audioQueue.length === 0 || !this.audioContext) {
      return;
    }

    this.isPlaying = true;
    this.emit({ type: 'speaking-started', participantId: 'google' });

    while (this.audioQueue.length > 0) {
      const audioData = this.audioQueue.shift()!;

      try {
        // Convert PCM to AudioBuffer
        const audioBuffer = await this.pcmToAudioBuffer(audioData);

        // Play the audio
        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext.destination);
        this.currentSource = source;

        await new Promise<void>((resolve) => {
          source.onended = () => {
            this.currentSource = null;
            resolve();
          };
          source.start();
        });

      } catch (error) {
        console.error('[Gemini] Error playing audio:', error);
      }
    }

    this.isPlaying = false;
    this.emit({ type: 'speaking-ended', participantId: 'google' });
  }

  private async pcmToAudioBuffer(pcmData: ArrayBuffer): Promise<AudioBuffer> {
    // Gemini outputs 24kHz 16-bit PCM mono
    const sampleRate = 24000;
    const int16Array = new Int16Array(pcmData);
    const float32Array = new Float32Array(int16Array.length);

    // Convert Int16 to Float32 (-1 to 1)
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }

    // Create AudioBuffer
    const audioBuffer = this.audioContext!.createBuffer(
      1, // mono
      float32Array.length,
      sampleRate
    );
    audioBuffer.copyToChannel(float32Array, 0);

    return audioBuffer;
  }

  /**
   * Interrupt current playback and clear queue
   */
  interrupt() {
    this.audioQueue = [];
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (e) {
        // Ignore
      }
      this.currentSource = null;
    }
  }

  /**
   * Send audio data to Gemini (microphone or cross-feed from other participants)
   * Audio should be 16-bit PCM at 16kHz mono
   */
  sendAudio(audioData: ArrayBuffer) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const base64Audio = this.arrayBufferToBase64(audioData);

    const message = {
      realtimeInput: {
        mediaChunks: [
          {
            mimeType: 'audio/pcm',
            data: base64Audio,
          },
        ],
      },
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send text input to Gemini (for cross-feeding transcripts from other participants)
   */
  sendText(text: string, participantName: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const message = {
      clientContent: {
        turns: [
          {
            role: 'user',
            parts: [
              {
                text: `[${participantName}]: ${text}`,
              },
            ],
          },
        ],
        turnComplete: true,
      },
    };

    this.ws.send(JSON.stringify(message));
  }



  /**
   * Set the voice for responses
   */
  setVoice(voiceName: string) {
    if (this.config.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig) {
      this.config.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName = voiceName;
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.audioQueue = [];
    this.isConnected = false;
    console.log('[Gemini] Disconnected');
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}
