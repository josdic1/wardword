import {
  EncounterMetadataSchema,
  SoapFieldsSchema,
  type EncounterMetadata,
  type SoapFields,
} from '@wardform/shared';
import { z } from 'zod';

import { askLocalLLM } from './llmService';

export type ExtractionMode =
  | 'clinical-ai'
  | 'structured-fallback';

export interface ParsedClinicalDictation {
  encounter: EncounterMetadata;
  soap: SoapFields;
  extractionMode: ExtractionMode;
}

const FACT_LEDGER_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'patientName',
    'facts',
    'assessmentSummary',
  ],
  properties: {
    patientName: {
      type: 'string',
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'explicitSection'],
        properties: {
          kind: {
            type: 'string',
            enum: [
              'patient_history',
              'caregiver_history',
              'witness_history',
              'symptom',
              'mechanism',
              'finding',
              'measurement',
              'test',
              'procedure',
              'assessment',
              'plan',
            ],
          },
          text: {
            type: 'string',
          },
          explicitSection: {
            type: 'string',
            enum: [
              'subjective',
              'objective',
              'assessment',
              'plan',
              'unspecified',
            ],
          },
        },
      },
    },
    assessmentSummary: {
      type: 'string',
    },
  },
};

const FactKindSchema = z.enum([
  'patient_history',
  'caregiver_history',
  'witness_history',
  'symptom',
  'mechanism',
  'finding',
  'measurement',
  'test',
  'procedure',
  'assessment',
  'plan',
]);

const FactLedgerSchema = z.object({
  patientName: z.string(),
  facts: z.array(
    z.object({
      kind: FactKindSchema,
      text: z.string().trim().min(1),
      explicitSection: z.enum([
        'subjective',
        'objective',
        'assessment',
        'plan',
        'unspecified',
      ]),
    }),
  ),
  assessmentSummary: z.string(),
});

export type FactLedger = z.infer<typeof FactLedgerSchema>;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function trimSection(value: string): string {
  return value
    .replace(/^[\s,;:.\\-]+/, '')
    .replace(/[\s]+$/, '')
    .trim();
}

interface MarkerMatch {
  index: number;
  end: number;
}

function findMarker(
  text: string,
  regex: RegExp,
  start = 0,
): MarkerMatch | null {
  const sliced = text.slice(start);
  const match = regex.exec(sliced);

  if (!match || match.index === undefined) {
    return null;
  }

  return {
    index: start + match.index,
    end: start + match.index + match[0].length,
  };
}

/**
 * Safe fallback for explicitly structured dictation.
 *
 * It separates only content already present in the
 * transcript and never invents clinical information.
 */
export function parseStructuredDictation(
  text: string,
): SoapFields {
  const source = normalizeWhitespace(text);

  const objectiveMarker = findMarker(
    source,
    /\b(?:on\s+)?physical\s+examination\b\s*[:,]?|\bobjective\b\s*(?:is\b|:)?/i,
  );

  const assessmentSearchStart =
    objectiveMarker?.end ?? 0;

  const assessmentMarker = findMarker(
    source,
    /\bassessment\b\s*(?:is\b|:)?/i,
    assessmentSearchStart,
  );

  const planSearchStart =
    assessmentMarker?.end ??
    objectiveMarker?.end ??
    0;

  const planMarker = findMarker(
    source,
    /\bplan\b\s*(?:is\b|:)?/i,
    planSearchStart,
  );

  const firstStructuredMarker =
    objectiveMarker ??
    assessmentMarker ??
    planMarker;

  const subjectiveEnd =
    firstStructuredMarker?.index ?? source.length;

  const subjective = trimSection(
    source.slice(0, subjectiveEnd),
  );

  let objective = '';

  if (objectiveMarker) {
    const end =
      assessmentMarker?.index ??
      planMarker?.index ??
      source.length;

    objective = trimSection(
      source.slice(objectiveMarker.end, end),
    );
  }

  let assessment = '';

  if (assessmentMarker) {
    const end =
      planMarker?.index ?? source.length;

    assessment = trimSection(
      source.slice(assessmentMarker.end, end),
    );
  }

  let plan = '';

  if (planMarker) {
    plan = trimSection(
      source.slice(planMarker.end),
    );
  }

  return {
    subjective,
    objective,
    assessment,
    plan,
  };
}

/**
 * Stage 1:
 * Repair obvious speech-recognition errors while
 * preserving the clinician's actual meaning.
 */
async function normalizeWithLocalAI(
  text: string,
): Promise<string> {
  const raw = await askLocalLLM(
    [
      {
        role: 'user',
        content: `Normalize this clinician dictation.

Your only task in this stage is transcription normalization.

Correct obvious speech-recognition or phonetic errors when the intended medical term is strongly supported by both phonetics and clinical context.

Examples of valid normalization:
"oxy small coughing spells" -> "paroxysmal coughing spells"
"occultation reveals" -> "auscultation reveals"
"course rocky bilaterally" -> "coarse rhonchi bilaterally"
"focal rails" -> "focal rales"
"hemoblastoma" -> "hemangioblastoma"

Do not:
- classify the text into SOAP sections
- diagnose
- create a plan
- invent findings
- replace vague language with a more specific finding
- change negation, laterality, measurements, medications, chronology, or meaning

If wording is ambiguous and cannot be confidently normalized, preserve it.

Return ONLY the normalized clinician dictation.
No JSON.
No headings.
No commentary.

SOURCE DICTATION:
${text}`,
      },
    ],
    {
      temperature: 0.1,
    },
  );

  const normalized = normalizeWhitespace(raw);

  if (!normalized) {
    throw new Error(
      'Clinical AI returned an empty normalized transcript',
    );
  }

  return normalized;
}

/**
 * Stage 2:
 * Extract atomic clinical facts.
 *
 * The configured clinical AI identifies facts and their semantic type.
 * Code — not the model — owns SOAP section placement.
 */
async function extractFactLedgerWithLocalAI(
  normalizedTranscript: string,
): Promise<FactLedger> {
  const raw = await askLocalLLM(
    [
      {
        role: 'user',
        content: `Extract an atomic fact ledger from this normalized clinician dictation.

Do NOT write a SOAP note.

PATIENT NAME
If a patient name is explicitly dictated, return it in patientName.
Otherwise return an empty string.

FACTS
Break the clinically relevant content into small independent facts.

Every clinically relevant source fact must appear exactly once in facts.

EXPLICIT SOAP SECTION
For every fact, also return explicitSection.

Use:
- subjective if the clinician explicitly placed the fact under Subjective
- objective if the clinician explicitly placed the fact under Objective
- assessment if the clinician explicitly placed the fact under Assessment
- plan if the clinician explicitly placed the fact under Plan
- unspecified if the clinician did not explicitly assign that fact to a SOAP section

Do not infer explicitSection from the fact's meaning.
Only preserve section ownership actually stated by the clinician.

Use only these kinds:

patient_history
- patient history, chronology, circumstances, prior events

caregiver_history
- information or actions reported about a parent, guardian, caregiver, or family member
- example: "mother used a Q-tip and pushed the wax farther into the ear"

witness_history
- information or actions reported about teachers, bystanders, witnesses, coaches, etc.

symptom
- symptoms or complaints experienced/reported by the patient
- example: muffled hearing, headache, dizziness

mechanism
- mechanism of injury or exposure
- example: struck head on desk, fingers slammed in car door

finding
- clinician-observed physical findings or observed patient behavior
- example: excess ear wax in canal, patient tugging at ear

measurement
- vital signs, dimensions, quantities, numerical measurements

test
- test or examination results
- example: eyes delayed while following pen

procedure
- something already performed during this encounter
- example: five stitches placed

assessment
- an explicitly dictated diagnosis, clinical impression, or clinician concern
- preserve uncertainty exactly

plan
- future treatment, medication, testing, referral, counseling, instructions, or follow-up

RULES
- Preserve the normalized source meaning.
- Do not invent facts.
- Do not omit clinically relevant facts.
- Do not duplicate a fact under multiple kinds.
- Do not infer relationships between separate statements.
- Do not turn treatment into a diagnosis.
- Do not make uncertain wording definite.
- Do not rewrite unusual but understandable terminology merely to sound clinical.
- Do not include patient identity as a fact; use patientName.

ASSESSMENT SUMMARY
If an explicit assessment fact exists, assessmentSummary may restate it concisely.
If no explicit assessment was dictated, create one concise problem summary using ONLY the extracted facts.
Do not add a new disease, severity, etiology, differential, or unsupported conclusion.
If a supported summary cannot be made without inventing information, return an empty string.

Return only the requested JSON structure.

NORMALIZED DICTATION:
${normalizedTranscript}`,
      },
    ],
    {
      format: FACT_LEDGER_JSON_SCHEMA,
      temperature: 0,
    },
  );

  const parsed = FactLedgerSchema.parse(
    JSON.parse(raw),
  );

  if (parsed.facts.length === 0) {
    throw new Error(
      'Clinical AI returned no clinical facts for non-empty dictation',
    );
  }

  return parsed;
}

function joinFacts(values: string[]): string {
  return values
    .map((value) => normalizeWhitespace(value))
    .filter(Boolean)
    .join(' ');
}

export function buildClinicalRecordFromFactLedger(
  ledger: FactLedger,
): {
  encounter: EncounterMetadata;
  soap: SoapFields;
} {
  const subjectiveKinds = new Set([
    'patient_history',
    'caregiver_history',
    'witness_history',
    'symptom',
    'mechanism',
  ]);

  const objectiveKinds = new Set([
    'finding',
    'measurement',
    'test',
    'procedure',
  ]);

  const subjective: string[] = [];
  const objective: string[] = [];
  const explicitAssessment: string[] = [];
  const plan: string[] = [];

  for (const fact of ledger.facts) {
    if (fact.explicitSection === 'subjective') {
      subjective.push(fact.text);
      continue;
    }

    if (fact.explicitSection === 'objective') {
      objective.push(fact.text);
      continue;
    }

    if (fact.explicitSection === 'assessment') {
      explicitAssessment.push(fact.text);
      continue;
    }

    if (fact.explicitSection === 'plan') {
      plan.push(fact.text);
      continue;
    }

    if (subjectiveKinds.has(fact.kind)) {
      subjective.push(fact.text);
      continue;
    }

    if (objectiveKinds.has(fact.kind)) {
      objective.push(fact.text);
      continue;
    }

    if (fact.kind === 'assessment') {
      explicitAssessment.push(fact.text);
      continue;
    }

    if (fact.kind === 'plan') {
      plan.push(fact.text);
    }
  }

  const encounter = EncounterMetadataSchema.parse({
    patientName: ledger.patientName,
  });

  const soap = SoapFieldsSchema.parse({
    subjective: joinFacts(subjective),
    objective: joinFacts(objective),
    assessment:
      joinFacts(explicitAssessment) ||
      normalizeWhitespace(ledger.assessmentSummary),
    plan: joinFacts(plan),
  });

  const hasClinicalContent = Object.values(soap).some(
    (value) => value.trim().length > 0,
  );

  if (!hasClinicalContent) {
    throw new Error(
      'Fact ledger produced an empty SOAP record',
    );
  }

  return {
    encounter,
    soap,
  };
}

async function extractClinicalRecordWithLocalAI(
  normalizedTranscript: string,
): Promise<{
  encounter: EncounterMetadata;
  soap: SoapFields;
}> {
  const ledger = await extractFactLedgerWithLocalAI(
    normalizedTranscript,
  );

  return buildClinicalRecordFromFactLedger(ledger);
}

export async function parseClinicalDictation(
  text: string,
  options: { useClinicalAI?: boolean } = {},
): Promise<ParsedClinicalDictation> {
  const source = normalizeWhitespace(text);

  if (!source) {
    return {
      encounter: {
        patientName: '',
      },
      soap: {
        subjective: '',
        objective: '',
        assessment: '',
        plan: '',
      },
      extractionMode: 'structured-fallback',
    };
  }

  let normalizedTranscript = source;

  const clinicalAIEnabled =
    options.useClinicalAI !== false &&
    process.env.CLINICAL_AI_DISABLED !== 'true';

  if (clinicalAIEnabled) {
    try {
      normalizedTranscript =
        await normalizeWithLocalAI(source);
    } catch (error) {
      console.warn(
        'Clinical AI normalization unavailable; continuing with source transcript.',
        error instanceof Error
          ? error.message
          : error,
      );
    }

    try {
      const record =
        await extractClinicalRecordWithLocalAI(
          normalizedTranscript,
        );

      return {
        encounter: record.encounter,
        soap: record.soap,
        extractionMode: 'clinical-ai',
      };
    } catch (error) {
      console.warn(
        'Clinical AI fact extraction unavailable; using structured fallback.',
        error instanceof Error
          ? error.message
          : error,
      );
    }
  }

  return {
    encounter: {
      patientName: '',
    },
    soap: parseStructuredDictation(
      normalizedTranscript,
    ),
    extractionMode: 'structured-fallback',
  };
}
