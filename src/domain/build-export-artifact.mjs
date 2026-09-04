import {
  clinicalTextIsPlaceholderOnly,
  clinicalArtifactHash,
  validateClinicalArtifact
} from './clinical-artifact.mjs';

const CLINICAL_HEADINGS = new Map([
  ['hpi', 'hpi'],
  ['history of present illness', 'hpi'],
  ['ros', 'ros'],
  ['review of systems', 'ros'],
  ['pe', 'physicalExamination'],
  ['physical exam', 'physicalExamination'],
  ['physical examination', 'physicalExamination']
]);

const OTHER_NOTE_HEADINGS = new Set([
  'assessment', 'plan', 'subjective', 'objective', 'chief complaint',
  'diagnoses', 'diagnosis', 'medications', 'allergies', 'procedure', 'procedures'
]);

function normalizedHeading(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function headingLine(line) {
  const markdown = line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
  if (markdown) {
    const withInline = markdown[1].match(/^([^:]+?)\s*:[ \t]*(.*)$/);
    return withInline
      ? { heading: normalizedHeading(withInline[1]), inline: withInline[2].trim(), markdown: true }
      : { heading: normalizedHeading(markdown[1]), inline: '', markdown: true };
  }
  const clinical = line.match(/^\s*(history of present illness|hpi|review of systems|ros|physical examination|physical exam|pe)\s*:[ \t]*(.*)$/i);
  if (clinical) return { heading: normalizedHeading(clinical[1]), inline: clinical[2].trim() };
  const other = line.match(/^\s*(assessment|plan|subjective|objective|chief complaint|diagnoses?|medications|allergies|procedures?)\s*:[ \t]*(.*)$/i);
  if (other) return { heading: normalizedHeading(other[1]), inline: other[2].trim() };
  return null;
}

export function parseExplicitClinicalSections(finalNote) {
  if (typeof finalNote !== 'string' || !finalNote.trim()) throw new Error('Provider-approved finalNote is required');
  const sections = { hpi: '', ros: '', physicalExamination: '' };
  const seen = new Set();
  let current = null;
  for (const rawLine of finalNote.replace(/\r\n/g, '\n').split('\n')) {
    const parsedHeading = headingLine(rawLine);
    if (parsedHeading) {
      const clinicalSection = CLINICAL_HEADINGS.get(parsedHeading.heading);
      if (clinicalSection) {
        if (seen.has(clinicalSection)) {
          throw new Error(`Provider-approved finalNote contains duplicate ${clinicalSection} headings`);
        }
        seen.add(clinicalSection);
        current = clinicalSection;
        if (parsedHeading.inline) sections[current] = parsedHeading.inline;
      } else if (OTHER_NOTE_HEADINGS.has(parsedHeading.heading) || parsedHeading.markdown) {
        current = null;
      }
      continue;
    }
    if (current) sections[current] = `${sections[current]}\n${rawLine}`.trim();
  }
  for (const [section, value] of Object.entries(sections)) {
    if (!value.trim()) throw new Error(`Provider-approved finalNote has no explicit ${section} section`);
    if (clinicalTextIsPlaceholderOnly(value)) {
      throw new Error(`Provider-approved finalNote has placeholder-only ${section} content`);
    }
  }
  return sections;
}

export function buildClinicalArtifact(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('QuickRCM clinical export source must be an object');
  }
  const withoutHash = {
    version: 2,
    source: 'quickrcm-quickscribe',
    status: source.status,
    jobId: source.jobId,
    patient: source.patient,
    encounter: source.encounter,
    attestation: source.attestation,
    sections: source.sections ?? parseExplicitClinicalSections(source.finalNote),
    diagnoses: source.diagnoses
  };
  return validateClinicalArtifact({
    ...withoutHash,
    artifactHash: clinicalArtifactHash(withoutHash)
  });
}
