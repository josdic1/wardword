import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  PreviewNoteRequestSchema,
  SaveNoteRequestSchema,
  type SavedNote,
} from '@wardform/shared';
import {
  initializeDatabase,
  listNotes,
  saveNote,
} from './src/database';
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
const webDist = path.resolve(backendDir, '../web/dist');

app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/notes', async (_req, res) => {
  try {
    const notes = await listNotes();
    return res.json(notes);
  } catch (error) {
    console.error('Unable to load clinical notes:', error);
    return res.status(500).json({ error: 'Unable to load clinical notes.' });
  }
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

app.post('/api/notes', async (req, res) => {
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

  try {
    const saved = await saveNote(note);
    return res.status(201).json(saved);
  } catch (error) {
    console.error('Unable to save clinical note:', error);
    return res.status(500).json({ error: 'Unable to save clinical note.' });
  }
});

if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    return res.sendFile(path.join(webDist, 'index.html'));
  });
}

async function startServer(): Promise<void> {
  await initializeDatabase();
  console.log('Database: ready');

  let aiReady = false;

  if (process.env.CLINICAL_AI_DISABLED !== 'true') {
    process.stdout.write(
      'Preparing clinical AI… ',
    );

    try {
      await warmLocalLLM();
      aiReady = true;
      console.log('ready.');
    } catch (error) {
      console.log('unavailable.');
      console.warn(
        'WardWord will use the conservative structured fallback until clinical AI is available:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  app.listen(port, host, () => {
    console.log(`WardWord ready at http://localhost:${port}`);
    console.log(
      `Clinical AI: ${aiReady ? 'ready' : 'fallback mode'}`,
    );
    console.log(
      'The web app and API are served from the same origin; no API IP configuration is required.',
    );
  });
}

void startServer();
