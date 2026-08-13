import dotenv from 'dotenv';

dotenv.config();

type AIProvider = 'ollama' | 'anthropic';

const AI_PROVIDER = (
  process.env.AI_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY
    ? 'anthropic'
    : 'ollama')
).toLowerCase() as AIProvider;

/* ── Ollama / Irving ─────────────────────────────────────── */

const OLLAMA_BASE_URL = (
  process.env.OLLAMA_BASE_URL ||
  'http://127.0.0.1:11434'
).replace(/\/$/, '');

const LOCAL_MODEL_NAME =
  process.env.LOCAL_MODEL_NAME ||
  'irving:latest';

const LOCAL_LLM_TIMEOUT_MS =
  Number(
    process.env.LOCAL_LLM_TIMEOUT_MS ||
    120_000,
  );

const LOCAL_LLM_KEEP_ALIVE =
  process.env.LOCAL_LLM_KEEP_ALIVE ||
  '30m';

/* ── Anthropic / hosted ──────────────────────────────────── */

const ANTHROPIC_BASE_URL = (
  process.env.ANTHROPIC_BASE_URL ||
  'https://api.anthropic.com'
).replace(/\/$/, '');

const ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY?.trim() ||
  '';

const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ||
  'claude-sonnet-5';

const ANTHROPIC_TIMEOUT_MS =
  Number(
    process.env.ANTHROPIC_TIMEOUT_MS ||
    60_000,
  );

const ANTHROPIC_VERSION =
  '2023-06-01';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AskLocalLLMOptions {
  format?: 'json' | Record<string, unknown>;
  temperature?: number;
}

function withTimeout(
  milliseconds: number,
): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    milliseconds,
  );

  return {
    controller,
    clear: () => clearTimeout(timeout),
  };
}

/* ── Ollama ──────────────────────────────────────────────── */

async function readOllamaError(
  response: Response,
): Promise<string> {
  try {
    const payload =
      await response.json() as {
        error?: string;
      };

    return (
      payload.error ||
      response.statusText
    );
  } catch {
    return response.statusText;
  }
}

async function warmOllama(): Promise<void> {
  const timeout =
    withTimeout(LOCAL_LLM_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${OLLAMA_BASE_URL}/api/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },
        signal:
          timeout.controller.signal,
        body: JSON.stringify({
          model: LOCAL_MODEL_NAME,
          prompt: '',
          stream: false,
          think: false,
          keep_alive:
            LOCAL_LLM_KEEP_ALIVE,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Ollama warm-up failed: ${
          await readOllamaError(
            response,
          )
        }`,
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `Ollama warm-up exceeded ${LOCAL_LLM_TIMEOUT_MS}ms`,
      );
    }

    throw error;
  } finally {
    timeout.clear();
  }
}

async function askOllama(
  messages: LlmMessage[],
  options: AskLocalLLMOptions,
): Promise<string> {
  const timeout =
    withTimeout(LOCAL_LLM_TIMEOUT_MS);

  try {
    const body:
      Record<string, unknown> = {
        model: LOCAL_MODEL_NAME,
        messages,
        stream: false,
        think: false,
        keep_alive:
          LOCAL_LLM_KEEP_ALIVE,
        options: {
          temperature:
            options.temperature ??
            0.1,
        },
      };

    if (
      options.format !== undefined
    ) {
      body.format = options.format;
    }

    const response = await fetch(
      `${OLLAMA_BASE_URL}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
        },
        signal:
          timeout.controller.signal,
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Ollama chat failed: ${
          await readOllamaError(
            response,
          )
        }`,
      );
    }

    const data =
      await response.json() as {
        message?: {
          content?: string;
        };
      };

    const content =
      data.message?.content?.trim();

    if (!content) {
      throw new Error(
        'Ollama returned no content',
      );
    }

    return content;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `Ollama request exceeded ${LOCAL_LLM_TIMEOUT_MS}ms`,
      );
    }

    throw error;
  } finally {
    timeout.clear();
  }
}

/* ── Anthropic ───────────────────────────────────────────── */

async function readAnthropicError(
  response: Response,
): Promise<string> {
  try {
    const payload =
      await response.json() as {
        error?: {
          message?: string;
        };
      };

    return (
      payload.error?.message ||
      response.statusText
    );
  } catch {
    return response.statusText;
  }
}

async function askAnthropic(
  messages: LlmMessage[],
  options: AskLocalLLMOptions,
): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
    );
  }

  const timeout =
    withTimeout(ANTHROPIC_TIMEOUT_MS);

  try {
    const system = messages
      .filter(
        (message) =>
          message.role === 'system',
      )
      .map(
        (message) =>
          message.content,
      )
      .join('\n\n')
      .trim();

    const conversation = messages
      .filter(
        (message) =>
          message.role !== 'system',
      )
      .map((message) => ({
        role: message.role as
          | 'user'
          | 'assistant',
        content: message.content,
      }));

    const structuredSchema =
      options.format &&
      typeof options.format ===
        'object'
        ? options.format
        : null;

    const body:
      Record<string, unknown> = {
        model: ANTHROPIC_MODEL,
        max_tokens: 4096,
        messages: conversation,
      };

    if (system) {
      body.system = system;
    }

    if (structuredSchema) {
      body.tools = [
        {
          name:
            'return_structured_output',
          description:
            'Return the requested structured clinical data.',
          input_schema:
            structuredSchema,
        },
      ];

      body.tool_choice = {
        type: 'tool',
        name:
          'return_structured_output',
      };
    }

    const response = await fetch(
      `${ANTHROPIC_BASE_URL}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          'x-api-key':
            ANTHROPIC_API_KEY,
          'anthropic-version':
            ANTHROPIC_VERSION,
        },
        signal:
          timeout.controller.signal,
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Anthropic request failed: ${
          await readAnthropicError(
            response,
          )
        }`,
      );
    }

    const data =
      await response.json() as {
        content?: Array<
          | {
              type: 'text';
              text?: string;
            }
          | {
              type: 'tool_use';
              name?: string;
              input?: unknown;
            }
        >;
      };

    if (structuredSchema) {
      const toolUse =
        data.content?.find(
          (block) =>
            block.type ===
              'tool_use' &&
            block.name ===
              'return_structured_output',
        );

      if (
        !toolUse ||
        toolUse.type !==
          'tool_use' ||
        toolUse.input ===
          undefined
      ) {
        throw new Error(
          'Anthropic returned no structured output',
        );
      }

      return JSON.stringify(
        toolUse.input,
      );
    }

    const content =
      data.content
        ?.filter(
          (
            block,
          ): block is {
            type: 'text';
            text?: string;
          } =>
            block.type === 'text',
        )
        .map(
          (block) =>
            block.text || '',
        )
        .join('')
        .trim() || '';

    if (!content) {
      throw new Error(
        'Anthropic returned no content',
      );
    }

    return content;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `Anthropic request exceeded ${ANTHROPIC_TIMEOUT_MS}ms`,
      );
    }

    throw error;
  } finally {
    timeout.clear();
  }
}

/* ── Shared WardWord interface ───────────────────────────── */

export function getClinicalAIProvider():
  AIProvider {
  return AI_PROVIDER;
}

export async function warmLocalLLM():
  Promise<void> {
  if (AI_PROVIDER === 'anthropic') {
    if (!ANTHROPIC_API_KEY) {
      throw new Error(
        'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
      );
    }

    return;
  }

  await warmOllama();
}

export async function askLocalLLM(
  messages: LlmMessage[],
  options: AskLocalLLMOptions = {},
): Promise<string> {
  if (AI_PROVIDER === 'anthropic') {
    return askAnthropic(
      messages,
      options,
    );
  }

  return askOllama(
    messages,
    options,
  );
}
