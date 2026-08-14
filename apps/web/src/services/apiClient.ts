import type {
  EncounterMetadata,
  PreviewNoteResponse,
  SavedNote,
  SoapFields,
} from '@wardform/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(payload?.error || 'IRVING+ request failed.');
  }

  return payload as T;
}

export function fetchNotes(): Promise<SavedNote[]> {
  return request<SavedNote[]>('/api/notes');
}

export async function transcribeRecording(
  audio: Blob,
): Promise<string> {
  const response = await fetch('/api/transcribe', {
    method: 'POST',
    headers: {
      'Content-Type': audio.type || 'audio/webm',
    },
    body: audio,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error || 'Unable to transcribe recording.',
    );
  }

  if (
    !payload ||
    typeof payload.transcript !== 'string' ||
    !payload.transcript.trim()
  ) {
    throw new Error('Transcription returned no text.');
  }

  return payload.transcript.trim();
}

export function previewNote(content: string): Promise<PreviewNoteResponse> {
  return request<PreviewNoteResponse>('/api/notes/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

export function saveNote(
  content: string,
  encounter: EncounterMetadata,
  soap: SoapFields,
): Promise<SavedNote> {
  return request<SavedNote>('/api/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      encounter,
      soap,
    }),
  });
}

export function updateNote(
  id: string,
  content: string,
  encounter: EncounterMetadata,
  soap: SoapFields,
): Promise<SavedNote> {
  return request<SavedNote>(`/api/notes/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      encounter,
      soap,
    }),
  });
}
