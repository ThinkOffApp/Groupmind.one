// SPDX-License-Identifier: AGPL-3.0-only
/**
 * OpenAI Realtime API Client
 * Handles WebRTC connection to OpenAI's realtime voice API
 */

import {
  OpenAIRealtimeConfig,
  DEFAULT_OPENAI_CONFIG,
  VoiceChatEvent,
  VoiceChatEventHandler
} from './types';

export class OpenAIRealtimeClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private config: OpenAIRealtimeConfig;
  private apiKey: string;
  private eventHandlers: Set<VoiceChatEventHandler> = new Set();
  private isConnected = false;

  // Audio output stream for cross-feeding to other participants
  private outputStream: MediaStream | null = null;
  public onAudioOutput: ((stream: MediaStream) => void) | null = null;
  public onTranscript: ((text: string, isFinal: boolean) => void) | null = null;
  public onResponseText: ((text: string) => void) | null = null;

  constructor(apiKey: string, config: Partial<OpenAIRealtimeConfig> = {}) {
    this.apiKey = apiKey;
    this.config = { ...DEFAULT_OPENAI_CONFIG, ...config };
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

  async connect(mediaStream: MediaStream): Promise<void> {


    try {
      // 1. Get ephemeral token from OpenAI
      const tokenResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          voice: this.config.voice,
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error(`Failed to get session token: ${tokenResponse.statusText}`);
      }

      const sessionData = await tokenResponse.json();
      const ephemeralKey = sessionData.client_secret?.value;

      if (!ephemeralKey) {
        throw new Error('No ephemeral key received from OpenAI');
      }

      // 2. Create WebRTC peer connection
      this.pc = new RTCPeerConnection();

      // 3. Set up audio element for playback
      this.audioElement = document.createElement('audio');
      this.audioElement.autoplay = true;

      // 4. Handle incoming audio track from OpenAI
      this.pc.ontrack = (event) => {
        console.log('[OpenAI] Received audio track');
        this.audioElement!.srcObject = event.streams[0];
        this.outputStream = event.streams[0];

        // Notify listeners about output stream for cross-feeding
        if (this.onAudioOutput) {
          this.onAudioOutput(event.streams[0]);
        }

        this.emit({ type: 'speaking-started', participantId: 'openai' });
      };

      // 5. Add local audio track (microphone)
      mediaStream.getTracks().forEach(track => {
        this.pc!.addTrack(track, mediaStream);
      });

      // 6. Set up data channel for events
      this.dc = this.pc.createDataChannel('oai-events');
      this.setupDataChannel();

      // 7. Create and set local description (SDP offer)
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // 8. Send offer to OpenAI and get answer
      const sdpResponse = await fetch(
        `https://api.openai.com/v1/realtime?model=${this.config.model}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ephemeralKey}`,
            'Content-Type': 'application/sdp',
          },
          body: offer.sdp,
        }
      );

      if (!sdpResponse.ok) {
        throw new Error(`SDP exchange failed: ${sdpResponse.statusText}`);
      }

      const answerSdp = await sdpResponse.text();
      await this.pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });

      this.isConnected = true;
      this.emit({ type: 'connected', participantId: 'openai' });
      console.log('[OpenAI] Connected to Realtime API');

      // 9. Send session configuration
      this.sendSessionConfig();

    } catch (error) {
      console.error('[OpenAI] Connection error:', error);
      this.emit({ type: 'error', data: error });
      throw error;
    }
  }

  private setupDataChannel() {
    if (!this.dc) return;

    this.dc.onopen = () => {
      console.log('[OpenAI] Data channel opened');
    };

    this.dc.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleServerEvent(message);
      } catch (e) {
        console.error('[OpenAI] Failed to parse message:', e);
      }
    };

    this.dc.onerror = (error) => {
      console.error('[OpenAI] Data channel error:', error);
    };
  }

  private handleServerEvent(event: Record<string, unknown>) {
    const eventType = event.type as string;

    switch (eventType) {
      case 'session.created':
        console.log('[OpenAI] Session created');
        break;

      case 'session.updated':
        console.log('[OpenAI] Session updated');
        break;

      case 'input_audio_buffer.speech_started':
        console.log('[OpenAI] User speech started');
        this.emit({ type: 'speaking-started', participantId: 'user' });
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('[OpenAI] User speech stopped');
        this.emit({ type: 'speaking-ended', participantId: 'user' });
        break;

      case 'conversation.item.input_audio_transcription.completed':
        const transcriptRaw = (event as { transcript?: unknown }).transcript;
        const transcript = typeof transcriptRaw === 'string' ? transcriptRaw : '';
        if (transcript && this.onTranscript) {
          this.onTranscript(transcript, true);
        }
        break;

      case 'response.audio_transcript.delta':
        const deltaRaw = (event as { delta?: unknown }).delta;
        const delta = typeof deltaRaw === 'string' ? deltaRaw : '';
        if (delta && this.onResponseText) {
          this.onResponseText(delta);
        }
        break;

      case 'response.audio_transcript.done':
        const fullTranscriptRaw = (event as { transcript?: unknown }).transcript;
        const fullTranscript = typeof fullTranscriptRaw === 'string' ? fullTranscriptRaw : '';
        if (fullTranscript) {
          this.emit({
            type: 'transcript-update',
            participantId: 'openai',
            data: fullTranscript
          });
        }
        break;

      case 'response.audio.started':
        this.emit({ type: 'speaking-started', participantId: 'openai' });
        break;

      case 'response.audio.done':
        this.emit({ type: 'speaking-ended', participantId: 'openai' });
        break;

      case 'error':
        console.error('[OpenAI] Server error:', event);
        this.emit({ type: 'error', data: event });
        break;

      default:
        // Log unhandled events for debugging
        if (eventType && !eventType.startsWith('response.audio.delta')) {
          console.log('[OpenAI] Event:', eventType);
        }
    }
  }

  setVoice(voice: string) {
    this.config.voice = voice;
    this.sendSessionConfig();
  }

  private sendSessionConfig() {
    if (!this.dc || this.dc.readyState !== 'open') {
      // Retry after a short delay if channel not ready
      setTimeout(() => this.sendSessionConfig(), 100);
      return;
    }

    const config = {
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: this.config.instructions ||
          'You are participating in a multi-AI voice conversation. Be concise and conversational. You may hear other AI participants - engage with them naturally.',
        voice: this.config.voice,
        input_audio_format: this.config.inputAudioFormat,
        output_audio_format: this.config.outputAudioFormat,
        input_audio_transcription: this.config.inputAudioTranscription,
        turn_detection: {
          type: 'server_vad',
          threshold: 0.8, // Higher threshold to avoid triggering on background noise/other AI
          prefix_padding_ms: 300,
          silence_duration_ms: 1000, // Wait longer before deciding speech ended
        },
      },
    };

    this.dc.send(JSON.stringify(config));
    console.log('[OpenAI] Session config sent');
  }

  /**
   * Send audio data to OpenAI (for cross-feeding from other participants)
   */
  sendAudio(audioData: ArrayBuffer) {
    if (!this.dc || this.dc.readyState !== 'open') return;

    // Convert to base64
    const base64 = btoa(
      String.fromCharCode(...new Uint8Array(audioData))
    );

    const message = {
      type: 'input_audio_buffer.append',
      audio: base64,
    };

    this.dc.send(JSON.stringify(message));
  }

  /**
   * Send a text message to inject into the conversation
   */
  sendText(text: string, participantName: string) {
    if (!this.dc || this.dc.readyState !== 'open') return;

    const message = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: `[${participantName}]: ${text}`,
          },
        ],
      },
    };

    this.dc.send(JSON.stringify(message));

    // Trigger response
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /**
   * Commit the audio buffer and trigger a response
   */
  commitAudioAndRespond() {
    if (!this.dc || this.dc.readyState !== 'open') return;

    this.dc.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.dc.send(JSON.stringify({ type: 'response.create' }));
  }

  /**
   * Interrupt the current response
   */
  interrupt() {
    if (!this.dc || this.dc.readyState !== 'open') return;

    this.dc.send(JSON.stringify({ type: 'response.cancel' }));
  }

  /**
   * Get the output audio stream for cross-feeding
   */
  getOutputStream(): MediaStream | null {
    return this.outputStream;
  }

  /**
   * Mute/unmute the audio output
   */
  setMuted(muted: boolean) {
    if (this.audioElement) {
      this.audioElement.muted = muted;
    }
  }

  /**
   * Set output volume (0-1)
   */
  setVolume(volume: number) {
    if (this.audioElement) {
      this.audioElement.volume = Math.max(0, Math.min(1, volume));
    }
  }

  disconnect() {
    if (this.dc) {
      this.dc.close();
      this.dc = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }

    this.outputStream = null;
    this.isConnected = false;
    this.emit({ type: 'disconnected', participantId: 'openai' });
    console.log('[OpenAI] Disconnected');
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}
