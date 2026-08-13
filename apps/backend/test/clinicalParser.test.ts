import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClinicalDictation } from '../src/services/clinicalParser';

const bronchitis = `Patient returns for a ten-day follow-up regarding persistent productive cough, retrosternal chest tightness, and low-grade fevers. Reports fatigue and sleep disruption due to paroxysmal coughing spells productive of thick green sputum.

On physical examination, temperature is ninety-nine point four, respiratory rate is eighteen breaths per minute, oxygen saturation is ninety-eight percent on room air. Auscultation reveals coarse rhonchi bilaterally with scattered expiratory wheezes; no localized consolidation or focal rales.

Assessment is acute bronchitis, resolving upper respiratory viral syndrome. Plan: Continue supportive care, forced hydration, prescribe benzonatate for cough suppression, advise rest, and return if symptoms worsen or fever recurs above one hundred and one.`;

const psoriasis = `Patient presents for evaluation of chronic plaque psoriasis, significantly worsened over the past three weeks. Reports severe pruritus, burning, and painful fissuring across bilateral extensor surfaces, elbows, knees, and the lumbosacral region.

On physical examination, diffuse erythematous plaques with thick, silvery-white scales are present, covering approximately 25% of total body surface area. Noticeable nail pitting and mild joint discomfort in the distal interphalangeal joints of both hands.

Assessment is a severe exacerbation of chronic plaque psoriasis with early signs of psoriatic arthritis involvement. Plan: Initiate high-potency topical corticosteroid therapy for thick plaques, prescribe a concurrent vitamin D analogue, schedule a consultation for narrowband UVB phototherapy, and order baseline laboratory panels to evaluate systemic treatment options. Follow-up scheduled in four weeks.`;

test('bronchitis dictation is separated without cross-contaminating sections', async () => {
  const { soap, extractionMode } = await parseClinicalDictation(bronchitis, { useLocalAI: false });

  assert.equal(extractionMode, 'structured-fallback');
  assert.match(soap.subjective, /productive cough/i);
  assert.doesNotMatch(soap.subjective, /physical examination/i);
  assert.match(soap.objective, /oxygen saturation/i);
  assert.match(soap.objective, /coarse rhonchi/i);
  assert.equal(soap.assessment, 'acute bronchitis, resolving upper respiratory viral syndrome.');
  assert.match(soap.plan, /benzonatate/i);
  assert.doesNotMatch(soap.plan, /psoriasis/i);
});

test('psoriasis dictation is separated into the intended SOAP fields', async () => {
  const { soap } = await parseClinicalDictation(psoriasis, { useLocalAI: false });

  assert.match(soap.subjective, /severe pruritus/i);
  assert.match(soap.objective, /erythematous plaques/i);
  assert.match(soap.objective, /25%/i);
  assert.match(soap.assessment, /severe exacerbation of chronic plaque psoriasis/i);
  assert.match(soap.plan, /narrowband UVB phototherapy/i);
  assert.match(soap.plan, /Follow-up scheduled in four weeks/i);
});
