# Coolify scheduling

The default Compose command executes one batch and exits. Coolify Scheduled
Tasks execute inside a running container, so they cannot use that stopped
container directly.

## Keep a container available for scheduled tasks

In the Compose definition stored in Coolify, replace the writeback service's
command and restart policy with:

```yaml
    command: ["sleep", "infinity"]
    restart: unless-stopped
```

Keep the existing image, entrypoint, environment, mounts, tmpfs and resource
limits. The entrypoint passes `sleep` through without launching Chromium or
performing clinical writes. Deploy this configuration to keep the container
available. Do not enable HTTP health checks or publish a domain.

Supply both JSON files through Coolify file mounts. The request file content
is `{"p_limit":1}` at `/app/.runtime/care1960-request.json`. The production
config remains private at `/app/config/writeback.json`; set its browser
`cdpEndpoint` to `http://127.0.0.1:9223` and `headless` to `true`.

## Scheduled task

- Container/service: select the deployed `writeback` container.
- Command: `/usr/local/bin/docker-entrypoint.sh run --config /app/config/writeback.json`
- Frequency matching the existing host cron: `*/2 * * * *`.
- Choose a timeout sufficient for real EHR processing, not just an empty queue.
- Review task execution logs; a successful empty queue does not verify EHR writes.

The full entrypoint must run for each task: it starts Chromium, waits for CDP,
runs the CLI, stops Chromium, and returns the CLI exit code. Plain
`node src/cli.mjs run` would not start Chromium in the idle container.

## Cutover requirements

The existing workspace host has a separate writeback cron every two minutes.
Disable only that writeback cron and wait for its current job to finish before
enabling the Coolify task. Do not disable the separate appointment polling cron.
Reconcile/migrate private ledger and retry state before processing pending
records: the old host and new Coolify volume do not share state or run locks.
Do not allow overlapping scheduled executions; each task shares a browser
profile and CDP port. The CLI lock is acquired after browser startup and is not
a complete browser-startup concurrency guard.

No schedule is created or enabled merely by committing these instructions.
Changes to this repository do not update a Compose Empty service's pasted
definition; update that definition in Coolify separately.

Reference: https://coolify.io/docs/applications/operations/scheduled-tasks
