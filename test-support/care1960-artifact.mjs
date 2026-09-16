import { artifact } from './artifact.mjs';

export function care1960Artifact(overrides = {}) {
  return artifact({
    version: 3,
    source: 'care1960-scribe',
    jobId: 'care1960-org-1:scribe-job-1',
    diagnoses: [],
    ...overrides
  });
}
