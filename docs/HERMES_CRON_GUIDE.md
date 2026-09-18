# Care1960 writeback scheduling

Use the [full production Hermes cron runbook](HERMES_PRODUCTION_CRON_RUNBOOK.md)
for prerequisites, exact commands, configuration, activation and recovery.

The scheduled job is `care1960-prognocis-clinical-drafts`. Its private wrapper
runs the complete worker:

```bash
node src/cli.mjs run --config config/writeback.json
```

Preview without changing the scheduler:

```bash
bash scripts/install-hermes-cron.sh --dry-run '*/5 * * * *' local
```

Only after the runbook's checks and production approval, activate:

```bash
bash scripts/install-hermes-cron.sh '*/5 * * * *' local
```

Installation activates the job. Hermes's gateway must be running in the correct
user/profile/runtime, with access to the persistent private config, credentials,
ledger and authenticated localhost Chrome/CDP endpoint. No separate Linux
crontab entry is needed.

The current API contract returns eligible pending records without requiring a
`written_back` field in the fetch response. Normal runs acknowledge only verified
drafts, removing completed records from eligibility. For initial pending-only
polling, use a broad request such as `{"p_limit":1}` and no cursor; do not leave
the request pinned to an already-completed canary.

This worker also supports a durable `care1960.cursorFile`, committed after a
successful normal run. It still performs one source POST per invocation, not
automatic multi-page fetching. See the full runbook before choosing a cursor
policy or planning late-record rescans. Earlier guidance saying cursor support
was absent is obsolete.

Keep `automation.draftOnly=true`, use the captured narrative-only selectors and
`sections-only` saves, and never sign/finalize or navigate Assessment in this
deployment. `--no-acknowledge` is for supervised testing, not the production
wrapper's default. Preserve the ledger and reconcile failures rather than
deleting proof or overwriting different clinical text.

The worker lock excludes this writer's overlapping runs, not other jobs sharing
Chrome. Arrange shared-browser coordination as described in the full runbook.
No scheduler was installed or enabled while creating this documentation.
