// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Text-to-Speech Engine
 * Converts text responses from text-only models (Claude, Mistral, etc.) to speech
 * Supports ElevenLabs, OpenAI TTS, Gemini TTS, and browser built-in TTS
 */



export interface TTSOptions {
  voice?: string;
  speed?: number;
  pitch?: number;
}

export class TTSEngine {
  private openAiApiKey: string | null = null;
  private geminiApiKey: string | null = null;
  private elevenLabsEndpoint: string | null = null; // Server-side proxy URL
  private elevenLabsVoiceId: string | null = null;
  private audioContext: AudioContext | null = null;
  private currentAudio: HTMLAudioElement | null = null;

  constructor() {
    this.audioContext = new AudioContext({ sampleRate: 24000 });
  }

  setOpenAIKey(key: string) {
    this.openAiApiKey = key;
  }

  setGeminiKey(key: string) {
    this.geminiApiKey = key;
  }

  setElevenLabsEndpoint(endpoint: string, defaultVoiceId?: string) {
    this.elevenLabsEndpoint = endpoint;
    this.elevenLabsVoiceId = defaultVoiceId || null;
  }

  /**
   * Convert text to speech using the best available provider
   */
  async synthesize(text: string, options: TTSOptions = {}): Promise<ArrayBuffer> {
    // Try ElevenLabs first (highest quality voices)
    if (this.elevenLabsEndpoint) {
      try {
        return await this.synthesizeElevenLabs(text, options);
      } catch (error) {
        console.warn('[TTS] ElevenLabs failed, trying fallback:', error);
      }
    }

    // Try OpenAI (great quality, fast)
    if (this.openAiApiKey) {
      try {
        return await this.synthesizeOpenAI(text, options);
      } catch (error) {
        console.warn('[TTS] OpenAI failed, trying fallback:', error);
      }
    }

    // Try Gemini TTS
    if (this.geminiApiKey) {
      try {
        return await this.synthesizeGemini(text, options);
      } catch (error) {
        console.warn('[TTS] Gemini failed, trying fallback:', error);
      }
    }

    // Fallback to browser TTS (returns empty buffer, plays directly)
    await this.synthesizeBrowser(text, options);
    return new ArrayBuffer(0);
  }

  /**
   * Synthesize using ElevenLabs via server-side proxy
   * Proxy lives at xfor.bot/api/tts to keep the API key server-side
   */
  async synthesizeElevenLabs(text: string, options: TTSOptions = {}): Promise<ArrayBuffer> {
    if (!this.elevenLabsEndpoint) {
      throw new Error('ElevenLabs endpoint not configured');
    }

    const voiceId = options.voice || this.elevenLabsVoiceId || undefined;

    const response = await fetch(this.elevenLabsEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice_id: voiceId,
        output_format: 'pcm_24000', // Match our audio pipeline sample rate
        model_id: 'eleven_turbo_v2_5',
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${errorBody}`);
    }

    return await response.arrayBuffer();
  }

  /**
   * Synthesize using OpenAI TTS API
   */
  async synthesizeOpenAI(text: string, options: TTSOptions = {}): Promise<ArrayBuffer> {
    if (!this.openAiApiKey) {
      throw new Error('OpenAI API key not set');
    }

    const voice = options.voice || 'alloy';
    const speed = options.speed || 1.0;

    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openAiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        input: text,
        voice: voice,
        speed: speed,
        response_format: 'pcm', // Raw PCM for low latency
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI TTS failed: ${response.statusText}`);
    }

    return await response.arrayBuffer();
  }

  /**
   * Synthesize using Gemini TTS API
   */
  async synthesizeGemini(text: string, options: TTSOptions = {}): Promise<ArrayBuffer> {
    if (!this.geminiApiKey) {
      throw new Error('Gemini API key not set');
    }

    const voice = options.voice || 'Puck';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: text }],
            },
          ],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: voice,
                },
              },
            },
          },
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Gemini TTS failed: ${response.statusText}`);
    }

    const data = await response.json();

    // Extract audio from response
    const audioPart = data.candidates?.[0]?.content?.parts?.find(
      (part: { inlineData?: { mimeType: string; data: string } }) =>
        part.inlineData?.mimeType?.startsWith('audio/')
    );

    if (!audioPart?.inlineData?.data) {
      throw new Error('No audio data in Gemini response');
    }

    // Decode base64 to ArrayBuffer
    const binaryString = atob(audioPart.inlineData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes.buffer;
  }

  /**
   * Synthesize using browser built-in TTS (Web Speech API)
   * Note: This plays directly and doesn't return audio data
   */
  async synthesizeBrowser(text: string, options: TTSOptions = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!('speechSynthesis' in window)) {
        reject(new Error('Browser TTS not supported'));
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = options.speed || 1.0;
      utterance.pitch = options.pitch || 1.0;

      // Try to find a good voice
      const voices = speechSynthesis.getVoices();
      const preferredVoice = voices.find(v =>
        v.name.toLowerCase().includes(options.voice?.toLowerCase() || 'google') ||
        v.name.toLowerCase().includes('natural')
      );
      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utterance.onend = () => resolve();
      utterance.onerror = (e) => reject(e);

      speechSynthesis.speak(utterance);
    });
  }

  /**
   * Play audio buffer through speakers
   */
  async playAudio(audioData: ArrayBuffer, stereoPosition: number = 0): Promise<void> {
    if (!this.audioContext) {
      throw new Error('AudioContext not initialized');
    }

    // Resume context if suspended
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Convert PCM to AudioBuffer
    const audioBuffer = await this.pcmToAudioBuffer(audioData);

    // Create source and connect with panning
    const source = this.audioContext.createBufferSource();
    const panner = this.audioContext.createStereoPanner();

    source.buffer = audioBuffer;
    panner.pan.value = stereoPosition;

    source.connect(panner);
    panner.connect(this.audioContext.destination);

    return new Promise((resolve) => {
      source.onended = () => resolve();
      source.start();
    });
  }

  private async pcmToAudioBuffer(pcmData: ArrayBuffer): Promise<AudioBuffer> {
    const sampleRate = 24000; // OpenAI/Gemini output rate
    const int16Array = new Int16Array(pcmData);
    const float32Array = new Float32Array(int16Array.length);

    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }

    const audioBuffer = this.audioContext!.createBuffer(
      1,
      float32Array.length,
      sampleRate
    );
    audioBuffer.copyToChannel(float32Array, 0);

    return audioBuffer;
  }

  /**
   * Stop any currently playing audio
   */
  stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    speechSynthesis.cancel();
  }

  dispose() {
    this.stop();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
