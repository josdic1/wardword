import { Pool } from 'pg';
import {
  SavedNoteSchema,
  type SavedNote,
} from '@wardform/shared';

let pool: Pool | null = null;

function getPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error('DATABASE_URL is required.');
  }

  if (!pool) {
    pool = new Pool({
      connectionString,
    });
  }

  return pool;
}

export async function initializeDatabase(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS clinical_notes (
      id TEXT PRIMARY KEY,
      patient_name TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      subjective TEXT NOT NULL DEFAULT '',
      objective TEXT NOT NULL DEFAULT '',
      assessment TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL
    )
  `);

  await getPool().query(`
    CREATE INDEX IF NOT EXISTS clinical_notes_created_at_idx
    ON clinical_notes (created_at DESC)
  `);

  await getPool().query(`
    CREATE INDEX IF NOT EXISTS clinical_notes_patient_name_idx
    ON clinical_notes (LOWER(patient_name))
  `);
}

export async function listNotes(): Promise<SavedNote[]> {
  const result = await getPool().query<{
    id: string;
    patient_name: string;
    content: string;
    subjective: string;
    objective: string;
    assessment: string;
    plan: string;
    created_at: Date;
  }>(`
    SELECT
      id,
      patient_name,
      content,
      subjective,
      objective,
      assessment,
      plan,
      created_at
    FROM clinical_notes
    ORDER BY created_at DESC
  `);

  return result.rows.map((row) =>
    SavedNoteSchema.parse({
      id: row.id,
      content: row.content,
      encounter: {
        patientName: row.patient_name,
      },
      soap: {
        subjective: row.subjective,
        objective: row.objective,
        assessment: row.assessment,
        plan: row.plan,
      },
      createdAt: row.created_at.toISOString(),
    }),
  );
}

export async function saveNote(note: SavedNote): Promise<SavedNote> {
  const parsed = SavedNoteSchema.parse(note);

  await getPool().query(
    `
      INSERT INTO clinical_notes (
        id,
        patient_name,
        content,
        subjective,
        objective,
        assessment,
        plan,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      parsed.id,
      parsed.encounter.patientName,
      parsed.content,
      parsed.soap.subjective,
      parsed.soap.objective,
      parsed.soap.assessment,
      parsed.soap.plan,
      parsed.createdAt,
    ],
  );

  return parsed;
}

export async function updateNote(note: SavedNote): Promise<SavedNote> {
  const parsed = SavedNoteSchema.parse(note);

  const result = await getPool().query(
    `
      UPDATE clinical_notes
      SET
        patient_name = $2,
        content = $3,
        subjective = $4,
        objective = $5,
        assessment = $6,
        plan = $7
      WHERE id = $1
      RETURNING id
    `,
    [
      parsed.id,
      parsed.encounter.patientName,
      parsed.content,
      parsed.soap.subjective,
      parsed.soap.objective,
      parsed.soap.assessment,
      parsed.soap.plan,
    ],
  );

  if (!result.rowCount) {
    throw new Error('Clinical note not found.');
  }

  return parsed;
}
