/**
 * Audio Router
 * Handles microphone capture, stereo mixing, and cross-feeding audio between participants
 */

import { AudioConfig, DEFAULT_AUDIO_CONFIG } from './types';

export interface AudioRouterCallbacks {
  onMicrophoneAudio: (audioData: ArrayBuffer) => void;
  onAudioLevel: (participantId: string, level: number) => void;
}

export class AudioRouter {
  private audioContext: AudioContext | null = null;
  private microphoneStream: MediaStream | null = null;
  private microphoneProcessor: ScriptProcessorNode | null = null;
  private config: AudioConfig;
  private callbacks: AudioRouterCallbacks | null = null;

  // Stereo mixer nodes
  private masterGain: GainNode | null = null;
  private participantNodes: Map<string, {
    gain: GainNode;
    panner: StereoPannerNode;
    analyser: AnalyserNode;
  }> = new Map();

  // Audio level monitoring
  private levelMonitorInterval: number | null = null;

  // Visualization
  private masterAnalyser: AnalyserNode | null = null;

  constructor(config: Partial<AudioConfig> = {}) {
    this.config = { ...DEFAULT_AUDIO_CONFIG, ...config };
  }

  /**
   * Initialize the audio router and request microphone access
   */
  async initialize(callbacks: AudioRouterCallbacks): Promise<MediaStream> {
    this.callbacks = callbacks;

    // Create audio context
    this.audioContext = new AudioContext({
      sampleRate: this.config.outputSampleRate,
    });

    // Ensure context is running (fixes "no sound" after user gesture)
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    // Request microphone access
    this.microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: this.config.inputSampleRate,
        channelCount: this.config.channelCount,
        echoCancellation: this.config.echoCancellation,
        noiseSuppression: this.config.noiseSuppression,
        autoGainControl: true,
      },
    });

    // Set up microphone processing
    this.setupMicrophoneCapture();

    // Set up master output
    this.masterGain = this.audioContext.createGain();

    // Create master analyser for visualization
    this.masterAnalyser = this.audioContext.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.5;

    // Connect: MasterGain -> Analyser -> Destination
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.audioContext.destination);

    // Start level monitoring
    this.startLevelMonitoring();

    console.log('[AudioRouter] Initialized');
    return this.microphoneStream;
  }

  private setupMicrophoneCapture() {
    if (!this.audioContext || !this.microphoneStream) return;

    // Create source from microphone
    const micSource = this.audioContext.createMediaStreamSource(this.microphoneStream);

    // Create processor for capturing PCM data
    // Note: ScriptProcessorNode is deprecated but AudioWorklet requires more setup
    const bufferSize = 4096;
    this.microphoneProcessor = this.audioContext.createScriptProcessor(
      bufferSize,
      1, // mono input
      1  // mono output
    );

    // Analyser for level monitoring
    const micAnalyser = this.audioContext.createAnalyser();
    micAnalyser.fftSize = 256;

    // Store for level monitoring
    this.participantNodes.set('user', {
      gain: this.audioContext.createGain(),
      panner: this.audioContext.createStereoPanner(),
      analyser: micAnalyser,
    });

    // Process microphone audio
    this.microphoneProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);

      // Convert Float32 to Int16 PCM
      const pcmData = this.float32ToInt16(inputData);

      // Send to callback
      if (this.callbacks?.onMicrophoneAudio) {
        this.callbacks.onMicrophoneAudio(pcmData.buffer as ArrayBuffer);
      }
    };

    // Connect: mic -> analyser -> processor -> nowhere (we don't play mic back)
    micSource.connect(micAnalyser);
    micAnalyser.connect(this.microphoneProcessor);
    this.microphoneProcessor.connect(this.audioContext.destination); // Required but silent
  }

  /**
   * Create an audio node for a participant
   */
  createParticipantNode(participantId: string, stereoPosition: number = 0): void {
    if (!this.audioContext || !this.masterGain) return;

    const gain = this.audioContext.createGain();
    const panner = this.audioContext.createStereoPanner();
    const analyser = this.audioContext.createAnalyser();

    panner.pan.value = stereoPosition;
    analyser.fftSize = 256;

    // Connect: gain -> panner -> analyser -> master
    gain.connect(panner);
    panner.connect(analyser);
    analyser.connect(this.masterGain);

    this.participantNodes.set(participantId, { gain, panner, analyser });
    console.log(`[AudioRouter] Created node for ${participantId} at position ${stereoPosition}`);
  }

  /**
   * Play audio from a participant
   */
  playAudio(participantId: string, audioData: ArrayBuffer): void {
    if (!this.audioContext) return;

    const nodes = this.participantNodes.get(participantId);
    if (!nodes) {
      console.warn(`[AudioRouter] No node for participant ${participantId}`);
      return;
    }

    // Convert PCM to AudioBuffer
    this.pcmToAudioBuffer(audioData).then((audioBuffer) => {
      const source = this.audioContext!.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(nodes.gain);
      source.start();
    }).catch((error) => {
      console.error(`[AudioRouter] Error playing audio for ${participantId}:`, error);
    });
  }

  /**
   * Connect a MediaStream (from WebRTC) to the mixer
   */
  connectStream(participantId: string, stream: MediaStream): void {
    if (!this.audioContext) return;

    const nodes = this.participantNodes.get(participantId);
    if (!nodes) {
      console.warn(`[AudioRouter] No node for participant ${participantId}`);
      return;
    }

    const source = this.audioContext.createMediaStreamSource(stream);
    source.connect(nodes.gain);
    console.log(`[AudioRouter] Connected stream for ${participantId}`);
  }

  /**
   * Set stereo position for a participant (-1 = left, 0 = center, 1 = right)
   */
  setStereoPosition(participantId: string, position: number): void {
    const nodes = this.participantNodes.get(participantId);
    if (nodes) {
      nodes.panner.pan.value = Math.max(-1, Math.min(1, position));
    }
  }

  /**
   * Set volume for a participant (0 to 1)
   */
  setVolume(participantId: string, volume: number): void {
    const nodes = this.participantNodes.get(participantId);
    if (nodes) {
      nodes.gain.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * Set master volume
   */
  setMasterVolume(volume: number): void {
    if (this.masterGain) {
      this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  /**
   * Mute/unmute a participant
   */
  setMuted(participantId: string, muted: boolean): void {
    const nodes = this.participantNodes.get(participantId);
    if (nodes) {
      nodes.gain.gain.value = muted ? 0 : 1;
    }
  }

  private startLevelMonitoring() {
    this.levelMonitorInterval = window.setInterval(() => {
      for (const [participantId, nodes] of this.participantNodes) {
        const level = this.getAudioLevel(nodes.analyser);
        if (this.callbacks?.onAudioLevel) {
          this.callbacks.onAudioLevel(participantId, level);
        }
      }
    }, 50); // 20 FPS level updates
  }

  private getAudioLevel(analyser: AnalyserNode): number {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);

    // Calculate RMS
    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      sum += dataArray[i] * dataArray[i];
    }
    const rms = Math.sqrt(sum / dataArray.length);

    // Normalize to 0-1
    return rms / 255;
  }

  private float32ToInt16(float32Array: Float32Array): Int16Array {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      int16Array[i] = sample < 0 ? sample * 32768 : sample * 32767;
    }
    return int16Array;
  }

  private async pcmToAudioBuffer(pcmData: ArrayBuffer): Promise<AudioBuffer> {
    const sampleRate = this.config.outputSampleRate;
    const int16Array = new Int16Array(pcmData);
    const float32Array = new Float32Array(int16Array.length);

    // Convert Int16 to Float32
    for (let i = 0; i < int16Array.length; i++) {
      float32Array[i] = int16Array[i] / 32768;
    }

    // Create AudioBuffer
    const audioBuffer = this.audioContext!.createBuffer(
      1,
      float32Array.length,
      sampleRate
    );
    audioBuffer.copyToChannel(float32Array, 0);

    return audioBuffer;
  }

  /**
   * Get raw PCM from a MediaStream (for cross-feeding)
   */
  captureStream(stream: MediaStream, callback: (pcmData: ArrayBuffer) => void): () => void {
    if (!this.audioContext) {
      throw new Error('AudioRouter not initialized');
    }

    const source = this.audioContext.createMediaStreamSource(stream);
    const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const pcmData = this.float32ToInt16(inputData);
      callback(pcmData.buffer as ArrayBuffer);
    };

    source.connect(processor);
    processor.connect(this.audioContext.destination);

    // Return cleanup function
    return () => {
      source.disconnect();
      processor.disconnect();
    };
  }

  /**
   * Get the microphone stream
   */
  getMicrophoneStream(): MediaStream | null {
    return this.microphoneStream;
  }

  /**
   * Cleanup and release resources
   */
  dispose(): void {
    // Stop level monitoring
    if (this.levelMonitorInterval) {
      clearInterval(this.levelMonitorInterval);
      this.levelMonitorInterval = null;
    }

    // Disconnect processor
    if (this.microphoneProcessor) {
      this.microphoneProcessor.disconnect();
      this.microphoneProcessor = null;
    }

    // Stop microphone tracks
    if (this.microphoneStream) {
      this.microphoneStream.getTracks().forEach(track => track.stop());
      this.microphoneStream = null;
    }

    // Clear participant nodes
    for (const [, nodes] of this.participantNodes) {
      nodes.gain.disconnect();
      nodes.panner.disconnect();
      nodes.analyser.disconnect();
    }
    this.participantNodes.clear();

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    console.log('[AudioRouter] Disposed');
  }

  /**
   * Get the master analyser for visualization
   */
  getMasterAnalyser(): AnalyserNode | null {
    return this.masterAnalyser;
  }
}
