# Care1960 API to PrognoCIS architecture

```text
Private response JSON file OR one authenticated Care1960 POST
  -> Care1960ApiSource
  -> structured three-section artifact + local content hash
  -> runWriteback + verification ledger
  -> PrognocisBrowser
  -> exact patient/encounter + draft save + reopen/read-back
```

The source consumes structured API fields. It does not open a source browser tab
or parse headings from a rendered note. Configuration controls response paths;
missing required data stops the batch before the CLI opens PrognoCIS.

The workflow preserves the source contract `listAttestedArtifacts(limit)` and
`revalidate(artifact)`. Captured files are reread on revalidation. HTTP responses
are immutable snapshots for that invocation: checking them never repeats the
POST, and does not claim to check upstream freshness.

Patient matching uses first name, last name, DOB, and retained patient ID.
Encounter matching uses service date in the configured timezone, appointment
type, retained encounter ID, and provider when supplied. Ambiguous matches stop.

The destination reads the three narrative fields, rejects different existing
text, fills empty fields, and saves a draft. It does not visit diagnosis controls
or use complaint/template selection to unlock fields. A fresh reopen verifies
the sections, same encounter ID, and configured draft status. Repeat content is
recognized by the local ledger or exact destination read-back.

The local audit records controlled statuses, errors, counts, durations, and
hashes. The ledger records only verified hashes and opaque encounter proof.
Neither file stores clinical narrative text. Existing ledger files are retained.

Source input, mapping, authentication, and API limitations are documented in
[CARE1960_INTEGRATION.md](CARE1960_INTEGRATION.md).
