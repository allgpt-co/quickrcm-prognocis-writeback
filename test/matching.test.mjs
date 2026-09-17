import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encounterCellsMatch,
  patientRowMatches,
  requireOneMatch
} from '../src/domain/matching.mjs';
import { artifact } from '../test-support/artifact.mjs';

test('patient identity requires first name, last name, and exact DOB', () => {
  const patient = artifact().patient;
  assert.equal(patientRowMatches('Sample Patient DOB 01/02/1980', patient), true);
  assert.equal(patientRowMatches('Sample Patient', patient), false);
  assert.equal(patientRowMatches('Sample Patient DOB 01/03/1980', patient), false);
});

test('encounter match requires exact local date, type, provider, and retained ID', () => {
  const encounter = artifact().encounter;
  const exact = {
    dateText: '09/04/2026',
    typeText: 'Follow Up',
    providerText: 'Dr Example',
    encounterId: 'ehr-encounter-9'
  };
  assert.equal(encounterCellsMatch(exact, encounter, 'America/Chicago'), true);
  assert.equal(encounterCellsMatch({ ...exact, typeText: 'Follow Up Extended' }, encounter, 'America/Chicago'), false);
  assert.equal(encounterCellsMatch({ ...exact, providerText: 'Dr Other' }, encounter, 'America/Chicago'), false);
  assert.equal(encounterCellsMatch({ ...exact, encounterId: 'ehr-encounter-10' }, encounter, 'America/Chicago'), false);
});

test('encounter match treats appointment type and retained ID as optional filters', () => {
  const encounter = {
    ...artifact().encounter,
    appointmentType: null,
    providerName: null,
    prognocisEncounterId: null
  };
  const candidate = {
    dateText: '09/04/2026',
    typeText: 'Any appointment name',
    providerText: 'Any provider',
    encounterId: 'ehr-encounter-from-prognocis'
  };
  assert.equal(encounterCellsMatch(candidate, encounter, 'America/Chicago'), true);
  assert.equal(encounterCellsMatch({ ...candidate, dateText: '09/05/2026' }, encounter, 'America/Chicago'), false);
});

test('exact matching fails closed on zero or multiple candidates', () => {
  assert.equal(requireOneMatch(['only'], 'encounter'), 'only');
  assert.throws(() => requireOneMatch([], 'encounter'), /0 exact encounter matches/i);
  assert.throws(() => requireOneMatch(['one', 'two'], 'encounter'), /2 exact encounter matches/i);
});
