import crypto from 'crypto';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

type TranscriptionProvider =
  | 'local'
  | 'openai';

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY?.trim() ||
  '';

const TRANSCRIPTION_PROVIDER = (
  process.env.TRANSCRIPTION_PROVIDER ||
  (OPENAI_API_KEY ? 'openai' : 'local')
).toLowerCase() as TranscriptionProvider;

/* ── Hosted OpenAI transcription ─────────────────────────── */

const OPENAI_BASE_URL = (
  process.env.OPENAI_BASE_URL ||
  'https://api.openai.com'
).replace(/\/$/, '');

const OPENAI_TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL ||
  'gpt-4o-mini-transcribe';

const OPENAI_TRANSCRIPTION_TIMEOUT_MS =
  Number(
    process.env.OPENAI_TRANSCRIPTION_TIMEOUT_MS ||
    120_000,
  );

function normalizeMimeType(
  mimeType?: string,
): string {
  return (
    mimeType
      ?.split(';')[0]
      ?.trim()
      .toLowerCase() ||
    'audio/webm'
  );
}

function extensionForMimeType(
  mimeType: string,
): string {
  switch (mimeType) {
    case 'audio/mp4':
    case 'audio/m4a':
      return 'mp4';

    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';

    case 'audio/ogg':
      return 'ogg';

    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';

    case 'audio/flac':
      return 'flac';

    case 'audio/webm':
    default:
      return 'webm';
  }
}

async function transcribeWithOpenAI(
  audio: Buffer,
  mimeType?: string,
): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is required for hosted transcription',
    );
  }

  const normalizedMimeType =
    normalizeMimeType(mimeType);

  const extension =
    extensionForMimeType(
      normalizedMimeType,
    );

  const form = new FormData();

  form.append(
    'file',
    new Blob(
      [Uint8Array.from(audio)],
      {
        type: normalizedMimeType,
      },
    ),
    `recording.${extension}`,
  );

  form.append(
    'model',
    OPENAI_TRANSCRIPTION_MODEL,
  );

  form.append(
    'language',
    'en',
  );

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    OPENAI_TRANSCRIPTION_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${OPENAI_BASE_URL}/v1/audio/transcriptions`,
      {
        method: 'POST',
        headers: {
          Authorization:
            `Bearer ${OPENAI_API_KEY}`,
        },
        body: form,
        signal: controller.signal,
      },
    );

    const payload =
      await response.json() as {
        text?: string;
        usage?: {
          type?: string;
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          input_token_details?: {
            audio_tokens?: number;
            text_tokens?: number;
          };
        };
        error?: {
          message?: string;
        };
      };

    if (!response.ok) {
      throw new Error(
        `OpenAI transcription failed: ${
          payload.error?.message ||
          response.statusText
        }`,
      );
    }

    if (payload.usage) {
      console.log('[usage] OpenAI transcription', {
        model: OPENAI_TRANSCRIPTION_MODEL,
        inputTokens: payload.usage.input_tokens ?? 0,
        audioTokens:
          payload.usage.input_token_details?.audio_tokens ?? 0,
        outputTokens: payload.usage.output_tokens ?? 0,
        totalTokens: payload.usage.total_tokens ?? 0,
      });
    }

    const transcript =
      payload.text
        ?.replace(/\s+/g, ' ')
        .trim() || '';

    if (!transcript) {
      throw new Error(
        'OpenAI returned an empty transcript',
      );
    }

    return transcript;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      throw new Error(
        `OpenAI transcription exceeded ${OPENAI_TRANSCRIPTION_TIMEOUT_MS}ms`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Local whisper.cpp transcription ─────────────────────── */

function resolveWhisperModel(): string {
  const candidates = [
    process.env.WHISPER_MODEL,
    path.resolve(
      __dirname,
      '../../models/ggml-small.en.bin',
    ),
    path.resolve(
      __dirname,
      '../../../models/ggml-small.en.bin',
    ),
  ].filter(
    (value): value is string =>
      Boolean(value),
  );

  const model =
    candidates.find((candidate) =>
      existsSync(candidate),
    );

  if (!model) {
    throw new Error(
      'Whisper model not found. Expected apps/backend/models/ggml-small.en.bin',
    );
  }

  return model;
}

const WHISPER_CLI =
  process.env.WHISPER_CLI ||
  'whisper-cli';

const FFMPEG =
  process.env.FFMPEG ||
  'ffmpeg';

function run(
  command: string,
  args: string[],
): Promise<void> {
  return new Promise(
    (resolve, reject) => {
      const child = spawn(
        command,
        args,
        {
          stdio: [
            'ignore',
            'pipe',
            'pipe',
          ],
        },
      );

      let stderr = '';

      child.stderr.on(
        'data',
        (chunk) => {
          stderr += chunk.toString();
        },
      );

      child.on(
        'error',
        reject,
      );

      child.on(
        'close',
        (code) => {
          if (code === 0) {
            resolve();
            return;
          }

          reject(
            new Error(
              `${command} failed with exit code ${code}: ${stderr.trim()}`,
            ),
          );
        },
      );
    },
  );
}

async function transcribeLocally(
  audio: Buffer,
): Promise<string> {
  const whisperModel =
    resolveWhisperModel();

  await fs.access(whisperModel);

  const workDir =
    await fs.mkdtemp(
      path.join(
        os.tmpdir(),
        'wardword-',
      ),
    );

  const id =
    crypto.randomUUID();

  const sourcePath =
    path.join(
      workDir,
      `${id}.audio`,
    );

  const wavPath =
    path.join(
      workDir,
      `${id}.wav`,
    );

  const outputBase =
    path.join(
      workDir,
      `${id}-transcript`,
    );

  const outputText =
    `${outputBase}.txt`;

  try {
    await fs.writeFile(
      sourcePath,
      audio,
    );

    await run(
      FFMPEG,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        sourcePath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ],
    );

    await run(
      WHISPER_CLI,
      [
        '--model',
        whisperModel,
        '--file',
        wavPath,
        '--language',
        'en',
        '--no-timestamps',
        '--output-txt',
        '--output-file',
        outputBase,
      ],
    );

    const transcript = (
      await fs.readFile(
        outputText,
        'utf8',
      )
    )
      .replace(/\s+/g, ' ')
      .trim();

    if (!transcript) {
      throw new Error(
        'Whisper returned an empty transcript',
      );
    }

    return transcript;
  } finally {
    await fs.rm(
      workDir,
      {
        recursive: true,
        force: true,
      },
    );
  }
}

/* ── Shared WardWord transcription interface ─────────────── */

export function getTranscriptionProvider():
  TranscriptionProvider {
  return TRANSCRIPTION_PROVIDER;
}

export async function transcribeAudio(
  audio: Buffer,
  mimeType?: string,
): Promise<string> {
  if (!audio.length) {
    throw new Error(
      'Audio recording is empty',
    );
  }

  if (
    TRANSCRIPTION_PROVIDER ===
    'openai'
  ) {
    return transcribeWithOpenAI(
      audio,
      mimeType,
    );
  }

  return transcribeLocally(
    audio,
  );
}
