import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  PreviewNoteRequestSchema,
  SaveNoteRequestSchema,
  SavedNoteSchema,
  type SavedNote,
} from '@wardform/shared';
import { parseClinicalDictation } from './src/services/clinicalParser';
import { warmLocalLLM } from './src/services/llmService';
import { transcribeAudio } from './src/services/transcriptionService';

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

function resolveBackendDir(): string {
  const currentDir = __dirname;
  if (fs.existsSync(path.join(currentDir, 'package.json'))) return currentDir;
  return path.resolve(currentDir, '..');
}

const backendDir = resolveBackendDir();
const dataFile = process.env.DATA_FILE || path.join(backendDir, 'notes.json');
const webDist = path.resolve(backendDir, '../web/dist');

app.use(express.json({ limit: '1mb' }));

function loadNotes(): SavedNote[] {
  if (!fs.existsSync(dataFile)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const result = SavedNoteSchema.array().safeParse(parsed);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

let notes = loadNotes();

function persistNotes(): void {
  const tempFile = `${dataFile}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(notes, null, 2));
  fs.renameSync(tempFile, dataFile);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/notes', (_req, res) => {
  res.json(notes);
});

app.post(
  '/api/transcribe',
  express.raw({
    type: 'audio/*',
    limit: '25mb',
  }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({
          error: 'Audio recording is required.',
        });
      }

      const transcript = await transcribeAudio(
        req.body,
        req.get('content-type') || 'audio/webm',
      );

      return res.json({
        transcript,
      });
    } catch (error) {
      console.error('Audio transcription failed:', error);

      return res.status(500).json({
        error: 'Unable to transcribe this recording.',
      });
    }
  },
);

app.post('/api/notes/preview', async (req, res) => {
  const request = PreviewNoteRequestSchema.safeParse(req.body);
  if (!request.success) {
    return res.status(400).json({ error: 'Dictation is required.' });
  }

  try {
    const result = await parseClinicalDictation(request.data.content);
    return res.json({
      content: request.data.content,
      encounter: result.encounter,
      soap: result.soap,
      extractionMode: result.extractionMode,
    });
  } catch (error) {
    console.error('SOAP preview failed:', error);
    return res.status(500).json({ error: 'Unable to structure this dictation.' });
  }
});

app.post('/api/notes', (req, res) => {
  const request = SaveNoteRequestSchema.safeParse(req.body);
  if (!request.success) {
    return res.status(400).json({ error: 'A reviewed SOAP note is required.' });
  }

  const note: SavedNote = {
    id: crypto.randomUUID(),
    content: request.data.content,
    encounter: request.data.encounter,
    soap: request.data.soap,
    createdAt: new Date().toISOString(),
  };

  notes = [note, ...notes];
  persistNotes();
  return res.status(201).json(note);
});

if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(webDist, 'index.html'));
  });
}

async function startServer(): Promise<void> {
  let aiReady = false;

  if (process.env.LOCAL_LLM_DISABLED !== 'true') {
    process.stdout.write(
      `Preparing local clinical AI (${process.env.LOCAL_MODEL_NAME || 'qwen3-josh:latest'})… `,
    );

    try {
      await warmLocalLLM();
      aiReady = true;
      console.log('ready.');
    } catch (error) {
      console.log('unavailable.');
      console.warn(
        'WardForm will use the conservative structured fallback until Ollama is available:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  app.listen(port, host, () => {
    console.log(`WardForm ready at http://localhost:${port}`);
    console.log(
      `Clinical AI: ${aiReady ? 'ready' : 'fallback mode'}`,
    );
    console.log(
      'The web app and API are served from the same origin; no API IP configuration is required.',
    );
  });
}

void startServer();
