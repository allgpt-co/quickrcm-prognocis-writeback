# Care1960 writeback scheduling

The installer now uses job `care1960-prognocis-clinical-drafts` and wrapper
`~/.hermes/scripts/care1960-prognocis-clinical-drafts.sh`. It runs:

```bash
node src/cli.mjs run --config config/writeback.json
```

No scheduler was changed during this migration. Before scheduling, configure the
actual API response and PrognoCIS selectors, validate the response, and complete
a probe and supervised draft canary. The repository lock excludes simultaneous
runs of this writer, but other jobs controlling the same Chrome need their own
schedule coordination. Do not install a second writer alongside an existing
one that controls that browser.

File input requires an upstream process to replace the captured response with
new attested data. Repeated runs of the same file skip locally verified hashes.
HTTP input sends one read-only POST to `care1960_get_attested_clinical_records`
per invocation. Timeouts are not retried automatically within an invocation.

The writer does not persist or advance the RPC's pagination cursor. A fixed
first-page body returns the same records every time; ledger deduplication alone
does not reach later pages. Start with an exact-job canary. Before scheduling
batches, provide a wrapper that reconciles each page's destination results and
then persists the final `(attested_at, scribe_job_id)` cursor. Do not advance
past failures or ambiguous saves. Keep API `p_limit` within the writer's record
limit, and plan deliberate overlapping rescans for later backfills/corrections.
The clinical endpoint is not an unsent-record queue.

Preview the installer:

```bash
./scripts/install-hermes-cron.sh --dry-run
```

Install only after runtime verification:

```bash
./scripts/install-hermes-cron.sh "15 0-20,23 * * *" local
```

The inherited default schedule is not a guarantee of coordination with other
jobs. Check the actual Hermes timezone, schedules, and script timeout before
activation. Keep the authenticated PrognoCIS Chrome profile, private configuration,
API credentials, runtime lock, audit, and verification ledger in persistent storage.

Monitor `AUTH_REQUIRED`, `CLINICAL_TEXT_CONFLICT`, `UNEXPECTED_DIALOG`,
`DRAFT_READBACK_FAILED`, and `CARE1960_*` source errors. Pause the job to reconcile
conflicts or uncertain saves. Disabling `automation.writeEnabled` stops draft
writes. Keep the ledger through restarts and deployments.
