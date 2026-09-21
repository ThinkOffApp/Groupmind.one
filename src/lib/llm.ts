// SPDX-License-Identifier: AGPL-3.0-only
// Server-side LLM access, pointed at a local model by default.
//
// Configuration (see .env.example):
//   LLM_BASE_URL  default http://localhost:11434/v1  (Ollama, OpenAI-compatible)
//   LLM_MODEL     default llama3.1:8b
//   LLM_API_KEY   default "local" - most local servers ignore it
//
// The hosted deployment keeps working unchanged by setting:
//   LLM_BASE_URL=https://api.anthropic.com
//   LLM_API_KEY=<anthropic key>       (ANTHROPIC_API_KEY is still honoured)
//   LLM_MODEL=claude-3-5-haiku-20241022
//
// Two wire formats are supported and chosen from the base URL, because a
// self-hoster should not have to care which one their endpoint speaks:
//   - Anthropic Messages  (base URL host contains "anthropic")
//   - OpenAI chat/completions (everything else: Ollama, llama.cpp, vLLM,
//     LM Studio, OpenAI, Groq, Together, ...)

export const DEFAULT_LLM_BASE_URL = 'http://localhost:11434/v1';
export const DEFAULT_LLM_MODEL = 'llama3.1:8b';

export interface LlmConfig {
    baseUrl: string;
    model: string;
    apiKey: string;
    isAnthropic: boolean;
}

export function getLlmConfig(): LlmConfig {
    const baseUrl = (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL).replace(/\/+$/, '');
    const isAnthropic = /anthropic/i.test(baseUrl);
    return {
        baseUrl,
        model: process.env.LLM_MODEL || (isAnthropic ? 'claude-3-5-haiku-20241022' : DEFAULT_LLM_MODEL),
        // ANTHROPIC_API_KEY stays supported so existing hosted config keeps working.
        apiKey: process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || 'local',
        isAnthropic,
    };
}

export interface CompletionRequest {
    system?: string;
    user: string;
    maxTokens?: number;
    signal?: AbortSignal;
}

export interface CompletionResult {
    ok: boolean;
    text?: string;
    /** Machine-readable reason, for callers that map it onto a status code. */
    reason?: 'no_api_key' | 'upstream_error' | 'empty_response' | 'unreachable';
    detail?: string;
}

/**
 * One-shot completion. Never throws - callers get a typed failure instead, so
 * a missing or unreachable local model degrades to "no reply" rather than a
 * 500 that looks like an app bug.
 */
export async function complete(req: CompletionRequest): Promise<CompletionResult> {
    const cfg = getLlmConfig();
    const maxTokens = req.maxTokens ?? 200;

    // A cloud endpoint with no key is a configuration error worth reporting.
    // A local endpoint legitimately needs no key.
    if (cfg.isAnthropic && (!cfg.apiKey || cfg.apiKey === 'local')) {
        return { ok: false, reason: 'no_api_key', detail: 'LLM_BASE_URL is Anthropic but no API key is set' };
    }

    const url = cfg.isAnthropic
        ? `${cfg.baseUrl}/v1/messages`
        : `${cfg.baseUrl}/chat/completions`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cfg.isAnthropic) {
        headers['x-api-key'] = cfg.apiKey;
        headers['anthropic-version'] = '2023-06-01';
    } else if (cfg.apiKey && cfg.apiKey !== 'local') {
        headers['Authorization'] = `Bearer ${cfg.apiKey}`;
    }

    const body = cfg.isAnthropic
        ? {
              model: cfg.model,
              max_tokens: maxTokens,
              ...(req.system ? { system: req.system } : {}),
              messages: [{ role: 'user', content: req.user }],
          }
        : {
              model: cfg.model,
              max_tokens: maxTokens,
              messages: [
                  ...(req.system ? [{ role: 'system', content: req.system }] : []),
                  { role: 'user', content: req.user },
              ],
          };

    let response: Response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: req.signal,
        });
    } catch (e) {
        // Most common self-host case: nothing is listening on LLM_BASE_URL yet.
        return {
            ok: false,
            reason: 'unreachable',
            detail: `could not reach ${url}: ${e instanceof Error ? e.message : String(e)}`,
        };
    }

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { ok: false, reason: 'upstream_error', detail: `${response.status} ${detail.slice(0, 500)}` };
    }

    const data = await response.json().catch(() => null);
    const text: string | undefined = cfg.isAnthropic
        ? data?.content?.[0]?.text
        : data?.choices?.[0]?.message?.content;

    if (!text) return { ok: false, reason: 'empty_response' };
    return { ok: true, text };
}
