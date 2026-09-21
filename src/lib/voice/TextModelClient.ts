// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Text Model Client
 * Handles text-only AI providers (Claude, Mistral, Grok, etc.)
 * Integrates with STT for input and TTS for output
 */

import { ParticipantProvider, VoiceChatEvent, VoiceChatEventHandler } from './types';

export interface TextModelConfig {
  provider: ParticipantProvider;
  apiKey: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
}

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export class TextModelClient {
  private config: TextModelConfig;
  private conversationHistory: Message[] = [];
  private eventHandlers: Set<VoiceChatEventHandler> = new Set();
  private isProcessing = false;

  // Callback for when response is ready
  public onResponse: ((text: string) => void) | null = null;
  public onStreamChunk: ((chunk: string) => void) | null = null;

  constructor(config: TextModelConfig) {
    this.config = config;

    // Add system prompt
    if (config.systemPrompt) {
      this.conversationHistory.push({
        role: 'system',
        content: config.systemPrompt,
      });
    }
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
   * Send a message and get a response
   */
  async send(message: string): Promise<string> {
    if (this.isProcessing) {
      console.warn(`[${this.config.provider}] Already processing a message`);
      return '';
    }

    this.isProcessing = true;

    // Add user message to history
    this.conversationHistory.push({
      role: 'user',
      content: message,
    });

    try {
      let response: string;

      switch (this.config.provider) {
        case 'anthropic':
          response = await this.sendToClaude();
          break;
        case 'mistral':
          response = await this.sendToMistral();
          break;
        case 'grok':
          response = await this.sendToGrok();
          break;
        case 'meta':
          response = await this.sendToMeta();
          break;
        case 'perplexity':
          response = await this.sendToPerplexity();
          break;
        default:
          throw new Error(`Unsupported provider: ${this.config.provider}`);
      }

      // Add assistant response to history
      this.conversationHistory.push({
        role: 'assistant',
        content: response,
      });

      // Notify listener
      if (this.onResponse) {
        this.onResponse(response);
      }

      return response;

    } catch (error) {
      console.error(`[${this.config.provider}] Error:`, error);
      this.emit({ type: 'error', data: error });
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Add context from other participants (for cross-feeding)
   */
  addContext(context: string) {
    this.conversationHistory.push({
      role: 'user',
      content: context,
    });
  }

  private async sendToClaude(): Promise<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model || 'claude-3-5-sonnet-20241022',
        max_tokens: this.config.maxTokens || 300,
        messages: this.conversationHistory.filter(m => m.role !== 'system'),
        system: this.conversationHistory.find(m => m.role === 'system')?.content,
      }),
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  }

  private async sendToMistral(): Promise<string> {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'mistral-large-latest',
        max_tokens: this.config.maxTokens || 300,
        messages: this.conversationHistory,
      }),
    });

    if (!response.ok) {
      throw new Error(`Mistral API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  private async sendToGrok(): Promise<string> {
    // Grok uses OpenAI-compatible API
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'grok-beta',
        max_tokens: this.config.maxTokens || 300,
        messages: this.conversationHistory,
      }),
    });

    if (!response.ok) {
      throw new Error(`Grok API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  private async sendToMeta(): Promise<string> {
    // Meta Llama via various providers (using Groq as example)
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'llama-3.1-70b-versatile',
        max_tokens: this.config.maxTokens || 300,
        messages: this.conversationHistory,
      }),
    });

    if (!response.ok) {
      throw new Error(`Meta/Groq API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  private async sendToPerplexity(): Promise<string> {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model || 'llama-3.1-sonar-small-128k-online',
        max_tokens: this.config.maxTokens || 300,
        messages: this.conversationHistory,
      }),
    });

    if (!response.ok) {
      throw new Error(`Perplexity API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  }

  /**
   * Clear conversation history
   */
  clearHistory() {
    const systemPrompt = this.conversationHistory.find(m => m.role === 'system');
    this.conversationHistory = systemPrompt ? [systemPrompt] : [];
  }

  /**
   * Get current conversation history
   */
  getHistory(): Message[] {
    return [...this.conversationHistory];
  }

  getIsProcessing(): boolean {
    return this.isProcessing;
  }
}
