function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function dateParts(isoTimestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(isoTimestamp));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function dobVariants(isoDob) {
  const [year, month, day] = isoDob.split('-');
  return [
    isoDob,
    `${month}/${day}/${year}`,
    `${Number(month)}/${Number(day)}/${year}`,
    `${month}-${day}-${year}`
  ];
}

export function patientRowMatches(text, patient) {
  const candidate = normalize(text);
  return candidate.includes(normalize(patient.firstName))
    && candidate.includes(normalize(patient.lastName))
    && dobVariants(patient.dob).some((value) => candidate.includes(normalize(value)));
}

export function encounterDateVariants(startTime, timezone) {
  const { year, month, day } = dateParts(startTime, timezone);
  return [
    `${year}-${month}-${day}`,
    `${month}/${day}/${year}`,
    `${Number(month)}/${Number(day)}/${year}`,
    `${month}-${day}-${year}`
  ];
}

export function encounterCellsMatch(cells, encounter, timezone) {
  const dateMatches = encounterDateVariants(encounter.startTime, timezone)
    .some((variant) => normalize(cells.dateText).includes(normalize(variant)));
  if (!dateMatches) return false;
  if (encounter.appointmentType
    && normalize(cells.typeText) !== normalize(encounter.appointmentType)) return false;
  if (encounter.providerName && normalize(cells.providerText) !== normalize(encounter.providerName)) return false;
  if (encounter.prognocisEncounterId
    && normalize(cells.encounterId) !== normalize(encounter.prognocisEncounterId)) return false;
  return true;
}

export function requireOneMatch(candidates, label) {
  if (candidates.length !== 1) {
    throw new Error(`PrognoCIS returned ${candidates.length} exact ${label} matches; expected one`);
  }
  return candidates[0];
}

