import { z } from 'zod';

export const EncounterMetadataSchema = z.object({
  patientName: z.string().trim(),
});

export const SoapFieldsSchema = z.object({
  subjective: z.string(),
  objective: z.string(),
  assessment: z.string(),
  plan: z.string(),
});

export const PreviewNoteRequestSchema = z.object({
  content: z.string().trim().min(1, 'Dictation is required'),
});

export const PreviewNoteResponseSchema = z.object({
  content: z.string(),
  encounter: EncounterMetadataSchema,
  soap: SoapFieldsSchema,
  extractionMode: z.enum(['local-ai', 'structured-fallback']),
});

export const SaveNoteRequestSchema = z.object({
  content: z.string().trim().min(1, 'Source dictation is required'),
  encounter: EncounterMetadataSchema,
  soap: SoapFieldsSchema,
});

export const SavedNoteSchema = z.object({
  id: z.string(),
  content: z.string(),
  encounter: EncounterMetadataSchema,
  soap: SoapFieldsSchema,
  createdAt: z.string(),
});

export type EncounterMetadata = z.infer<typeof EncounterMetadataSchema>;
export type SoapFields = z.infer<typeof SoapFieldsSchema>;
export type PreviewNoteRequest = z.infer<typeof PreviewNoteRequestSchema>;
export type PreviewNoteResponse = z.infer<typeof PreviewNoteResponseSchema>;
export type SaveNoteRequest = z.infer<typeof SaveNoteRequestSchema>;
export type SavedNote = z.infer<typeof SavedNoteSchema>;
