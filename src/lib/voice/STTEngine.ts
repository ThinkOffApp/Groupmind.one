/**
 * Speech-to-Text Engine
 * Transcribes audio for text-only models
 * Supports OpenAI Whisper and browser built-in STT
 */

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message: string;
}

interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (event: Event) => void;
  onend: (event: Event) => void;
  onerror: (event: SpeechRecognitionErrorEvent) => void;
  onresult: (event: SpeechRecognitionEvent) => void;
  start(): void;
  stop(): void;
  abort(): void;
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition;
  new(): SpeechRecognition;
};

declare var webkitSpeechRecognition: {
  prototype: SpeechRecognition;
  new(): SpeechRecognition;
};

export interface STTOptions {
  language?: string;
  prompt?: string;
}

export class STTEngine {
  private openAiApiKey: string | null = null;
  private recognition: SpeechRecognition | null = null;
  private isListening = false;

  constructor() {
    // Initialize browser STT if available
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      if (this.recognition) {
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
      }
    }
  }

  setOpenAIKey(key: string) {
    this.openAiApiKey = key;
  }

  /**
   * Transcribe audio data using OpenAI Whisper
   */
  async transcribe(audioData: ArrayBuffer, options: STTOptions = {}): Promise<string> {
    if (!this.openAiApiKey) {
      throw new Error('OpenAI API key not set for transcription');
    }

    // Convert ArrayBuffer to Blob
    const blob = new Blob([audioData], { type: 'audio/wav' });
    const file = new File([blob], 'audio.wav', { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('file', file);
    formData.append('model', 'whisper-1');

    if (options.language) {
      formData.append('language', options.language);
    }
    if (options.prompt) {
      formData.append('prompt', options.prompt);
    }

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openAiApiKey}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Transcription failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.text || '';
  }

  /**
   * Start real-time browser-based speech recognition
   */
  startRealtime(onTranscript: (text: string, isFinal: boolean) => void): void {
    if (!this.recognition) {
      console.warn('[STT] Browser speech recognition not available');
      return;
    }

    if (this.isListening) return;

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interimTranscript = '';
      let finalTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      if (finalTranscript) {
        onTranscript(finalTranscript, true);
      } else if (interimTranscript) {
        onTranscript(interimTranscript, false);
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error('[STT] Recognition error:', event.error);
    };

    this.recognition.onend = () => {
      // Restart if still supposed to be listening
      if (this.isListening && this.recognition) {
        this.recognition.start();
      }
    };

    this.recognition.start();
    this.isListening = true;
    console.log('[STT] Started listening');
  }

  /**
   * Stop real-time speech recognition
   */
  stopRealtime(): void {
    this.isListening = false;
    if (this.recognition) {
      this.recognition.stop();
    }
    console.log('[STT] Stopped listening');
  }

  /**
   * Check if browser STT is available
   */
  isBrowserSTTAvailable(): boolean {
    return this.recognition !== null;
  }

  dispose() {
    this.stopRealtime();
    this.recognition = null;
  }
}
