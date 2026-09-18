# Production runbook: Care1960 → PrognoCIS through Hermes cron

Updated: 2026-09-18. This guide describes the current checked-in worker and the
locally available Hermes CLI. It does **not** install or enable a job by itself.

## 1. Scope and execution model

Create **one** scheduled job for the complete Node worker—not separate jobs for
patient search, HPI, ROS, Physical Examination, or acknowledgement.

```text
Hermes gateway cron ticker
  → private shell wrapper, no LLM/agent loop
  → Node worker: src/cli.mjs run
  → POST eligible Care1960 attested records
  → validate tenant, attestation, patient and clinical narratives
  → match PrognoCIS patient and exact encounter
  → select exact Wellness exam complaint
  → save missing HPI, ROS and Physical Examination narratives
  → reopen and verify all three narratives and Open/unsigned status
  → persist local draft-verification proof
  → POST Care1960 acknowledgement, written_back=true
  → validate exact acknowledgement and persist its proof
```

Use Hermes **`--no-agent`** to execute the deterministic wrapper without an LLM.
This is unrelated to the worker's **`--no-acknowledge`** flag, which deliberately
withholds the Care1960 status update. See the [official script-only cron guide](https://hermes-agent.nousresearch.com/docs/guides/cron-script-only).

### Clinical boundaries

- Save **draft narratives only**: HPI, ROS and Physical Examination.
- The live configuration must use `draftSaveStrategy: "sections-only"`.
- Do not navigate to Assessment to save, or enter Assessment/Plan or diagnoses.
- Do not update structured ROS checkboxes, sign, finalize, close or submit claims.
- Different existing clinical text stops the record; do not overwrite it.
- A successful replay must not duplicate a verified write.
- Acknowledgement is permitted only after destination verification.
- Migration **0010 is already applied**. Do not rerun it for cron setup.

The first cron—PrognoCIS → Care1960 appointments—is a different integration.
Leave its API and job configuration unchanged.

## 2. Which scripts Hermes should run

| File | Purpose |
| --- | --- |
| `src/cli.mjs` | Complete validation, matching, writing, verification and acknowledgement workflow |
| `scripts/writeback-wrapper.template.sh` | Template that enters the repository and executes Node by absolute path |
| `scripts/install-hermes-cron.sh` | Creates the Hermes-home wrapper and creates/edits the scheduled job |
| `config/writeback.json` | Private, persistent production configuration |
| `.env` | Private worker credentials and write acknowledgement |
| `.runtime/care1960-request.json` | Private API filter body |
| `.runtime/writeback-audit.jsonl` | Controlled audit events and error codes |
| `.runtime/verified-drafts.jsonl` | Persistent verification/acknowledgement ledger; treat as sensitive metadata |

Default job name:

```text
care1960-prognocis-clinical-drafts
```

Installed wrapper name:

```text
care1960-prognocis-clinical-drafts.sh
```

Its actual location is `${HERMES_HOME:-$HOME/.hermes}/scripts/`. The default
production invocation is:

```bash
node src/cli.mjs run --config config/writeback.json
```

**Do not schedule our temporary canary/replay configurations or the interactive
debug commands.** Those were deliberately pinned to one job and disabled after
their runs. Use the stable production config, wrapper and ledger.

## 3. Select the real execution environment

Run setup as the OS user and in the runtime where Hermes's gateway will execute
the job. That runtime must have all of the following:

1. Repository and installed dependencies.
2. Node.js **22 or newer**.
3. Read access to the private worker `.env` and config.
4. Persistent, writable `.runtime` storage.
5. Network access to the production Supabase API and PrognoCIS.
6. Access to the authenticated, localhost-only Chrome/CDP endpoint.
7. The correct Hermes home/profile and a running gateway.

### Host paths versus container paths

The current host repository is:

```text
/quickintell/workspaces/anurag_workspace/quickrcm-prognocis-writeback
```

If Hermes runs in a container, use its **container-visible** repository path
instead. A generated wrapper with an inaccessible host path will fail.

Inspect a deployment without displaying its environment or secrets:

```bash
docker inspect -f '{{.HostConfig.NetworkMode}}' <gateway-container>
docker inspect -f '{{range .Mounts}}{{.Source}} => {{.Destination}}{{println}}{{end}}' <gateway-container>
```

`127.0.0.1:9223` inside an ordinary bridge-networked container is not the host's
Chrome. On a Linux deployment, approved host networking can give Hermes access
to the host's loopback CDP endpoint. Otherwise Chrome must be reachable on
loopback in Hermes's own runtime. Test from the actual gateway runtime—not just
an interactive terminal-tool sandbox.

**Do not expose CDP on `0.0.0.0`, publish it publicly, or weaken the worker's
localhost-only CDP validation.** It controls an authenticated clinical browser.

Persist the repository's runtime ledger, browser profile and Hermes state across
container recreation. Keep secret mounts private and owned by the execution user.

## 4. Find and verify Hermes

Where Hermes is installed on `PATH`:

```bash
hermes cron --help
hermes cron create --help
hermes gateway status
hermes cron status
hermes cron list
```

In this workspace, `hermes` was not on `PATH`; the installer found this checkout:

```bash
python3 /quickintell/workspaces/anurag_workspace/hermes_agent/hermes_agent/hermes cron --help
```

For interactive use in this host shell, you can define:

```bash
hermes() {
  python3 /quickintell/workspaces/anurag_workspace/hermes_agent/hermes_agent/hermes "$@"
}
```

This function is shell-local. The installer does not depend on it: it uses an
installed Hermes executable or its known sibling-checkout fallback. A different
deployment must provide a working executable or adapt that fallback path.

**Important:** automatic cron ticks require the Hermes gateway. A saved job
definition alone is not a running scheduler. The local implementation documents
this in `hermes_cli/cron.py`; verify it with `hermes cron status`.

If no gateway exists, arrange the appropriate service with your deployment
operator. Native installs expose `hermes gateway install` and `start`; containers
normally run `hermes gateway run` under their supervisor. Do not start a second
gateway against the same home merely to test this job.

## 5. Prepare private credentials

The **current code** in `src/runtime/config.mjs` reads these variable names:

```dotenv
SUPABASE_ANON_KEY=<production gateway anon key>
SUPABASE_TENANT_API_KEY=<registered Care1960 production tenant JWT>

# Only required when prognocis.loginPerRun=true; spelling/case are intentional:
prognosis_username=<integration username>
prognosis_password=<integration password>

# Set only after approval for live clinical draft writes:
CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES
```

Earlier API handoff notes used `CARE1960_API_KEY`, `CARE1960_BEARER_TOKEN` and
uppercase `PROGNOCIS_*`. **Those are not the names this checked-in credential
loader currently consumes.** Do not assume aliases exist. Check the loader after
upgrades and use one consistent naming scheme.

`SUPABASE_TENANT_API_KEY` is a **tenant bearer JWT**, despite its variable name.
Both source credentials must belong to the same production Supabase instance.
Never substitute a service-role key, doctor login token, local key or Postgres
credentials. This worker does not need a database connection or JWT signing secret.

Put values only in the repository's private `.env`, not frontend `.env.local`,
`VITE_*`, Git, cron prompts, shell wrappers or screenshots. Do not use `set -x`,
dump the environment, or print `.env` while diagnosing a job.

The worker loads `.env` itself with dotenv. Its wrapper does **not** need to
`source .env` or export the credentials. Already-inherited environment variables
take precedence over dotenv values, so remove unintended stale credential
overrides from the gateway service environment.

Protect files:

```bash
cd /quickintell/workspaces/anurag_workspace/quickrcm-prognocis-writeback
umask 077
mkdir -p .runtime
chmod 700 .runtime
chmod 600 .env config/writeback.json
```

With `loginPerRun=false`, keep the Chrome profile authenticated. Login credentials
are not required for the writer; login through the private desktop when necessary.

## 6. Configure the production worker—merge, do not replace

Keep the complete captured selector configuration. Merge these settings into it;
the following blocks are **not a replacement for the full config**.

```json
{
  "automation": {
    "timezone": "America/Chicago",
    "writeEnabled": false,
    "draftOnly": true,
    "maxRecordsPerRun": 1
  },
  "browser": {
    "cdpEndpoint": "http://127.0.0.1:9223",
    "headless": false
  },
  "care1960": {
    "input": "http",
    "orgId": "<actual production organization UUID>",
    "apiUrl": "https://supabase-api.quickintell.com/rest/v1/rpc/care1960_get_attested_clinical_records",
    "markWrittenBackUrl": "https://supabase-api.quickintell.com/rest/v1/rpc/care1960_mark_clinical_record_written_back",
    "requestFile": ".runtime/care1960-request.json",
    "timeoutMs": 30000,
    "recordsPath": "",
    "fields": {}
  },
  "prognocis": {
    "loginPerRun": false,
    "hpiComplaintName": "Wellness exam",
    "draftSaveStrategy": "sections-only",
    "draftStatusPattern": "^Open$",
    "editableStatusPattern": "^Open$"
  },
  "runtime": {
    "lockFile": ".runtime/writeback.lock",
    "auditFile": ".runtime/writeback-audit.jsonl",
    "ledgerFile": ".runtime/verified-drafts.jsonl"
  }
}
```

Keep the existing `userDataDir`, navigation/action timeouts, URLs, frame patterns
and selectors. Organization configuration is a tenant validation boundary; it
does not let the request choose another organization. The registered JWT controls
API authorization. `SUPABASE_ORG_ID` in `.env` is not automatically substituted
into this config by the loader.

For this narrative-only configuration, remove obsolete `saveDraftMenu`,
`saveDraftButton`, `draftSaveFrameUrlPattern` and `draftSaveUrlPattern` settings
that point to Assessment. With `sections-only`, the worker saves each narrative
in its own section, verifies Open/unsigned status, and performs read-back.

Captured controls include:

| Purpose | Selector |
| --- | --- |
| Patient-selector person icon | `img[title="Select Patient"]`—not the home-page search input |
| Encounter provider within row | `td:nth-child(3)`—Attending Provider |
| HPI menu | `#menu_HP` |
| HPI binocular complaint lookup | `#searchCompl` |
| Complaint search | `#CMP_NAME` |
| Exact complaint name within result row | `td:nth-child(1)` |
| Active HPI complaint ID | `#msCurrentComplaintId` |
| HPI notes | `#msPth_curcmp_notes` |
| HPI Save | `#ok`, scoped to the HPI frame |
| ROS menu | `#menu_RS` |
| Physical Examination menu | `#menu_PH` |

ROS and Physical Examination reuse `#msPth_Template_Notes`; **their configured
frame URL patterns must distinguish them**. Keep the captured section-specific
save response patterns. See [the detailed Wellness/HPI flow](PROGNOCIS_WELLNESS_HPI_FLOW.md).

Never guess a replacement selector after an EHR UI update. Pause, inspect and test.

## 7. Change from an exact canary to ongoing polling

An exact-job request is for supervised testing:

```json
{
  "p_scribe_job_id": "<actual approved canary job UUID>",
  "p_limit": 1
}
```

After that job is acknowledged, it should no longer be eligible. Scheduling the
same exact-job filter will repeatedly return no work and **will not process new
patients**.

For initial production polling, create the private request file with:

```json
{
  "p_limit": 1
}
```

Then:

```bash
chmod 600 .runtime/care1960-request.json
```

`p_scribe_job_id` is optional. For patient/encounter filters, use original
PrognoCIS IDs and provide the pair together. Never use a Supabase patient UUID
as an EHR identifier. Remove placeholder filter values before an HTTP request.

### Recommended starting policy: pending-record first-page polling

The API contract supplied for this deployment filters eligible records to
`written_back=false`; it need not expose that field in its fetch response.
Normal acknowledgement removes successfully completed records from eligibility.
Therefore each scheduled invocation can request the first pending page, acknowledge
its verified results, and let the next invocation see the next pending records.

For this policy, do **not** configure `care1960.cursorFile` or `p_after_*` filters.
This also avoids a high-water cursor excluding older, delayed/backfilled records.
Confirm the deployed API still honors the pending-only filter before relying on it.

`--no-acknowledge` is **not** the production wrapper's default: a fixed first
pending page can remain occupied by locally verified but unacknowledged records,
blocking later records from being fetched.

Start with a limit of 1. At five-minute intervals, capacity is at most roughly
12 newly completed records/hour, before errors and runtime delays. Increase batch
size only after approval, measured execution time and supervised batch testing.
Keep `p_limit` no greater than `maxRecordsPerRun` (both support 1–100).

### Optional cursor policy—supported by this version, not automatically enabled

The current source supports `care1960.cursorFile`. It injects
`p_after_attested_at` and `p_after_scribe_job_id`, and the CLI commits the cursor
only after a normal run with zero record failures. No-ack mode does not advance it.
The stored JSON uses `attestedAt` and `scribeJobId`. Do not hand-seed it from an
unreconciled or failed page, and do not put `p_after_*` in the request when the
durable cursor is configured.

This version still does **one source POST per invocation**, not an automatic
multi-page loop. `X-Care1960-Has-More: true` reports backlog, not a second fetch.
Plan explicit overlapping rescans for late/corrected/backfilled records before
adopting a cursor policy. Keep one stable strategy rather than switching casually.
Earlier repository guidance saying this version has no cursor support is obsolete.

## 8. Keep Chrome and the private desktop alive

The cron worker attaches to `http://127.0.0.1:9223`. It does not provision or
restart that Chrome. Chrome, its profile, the display and any noVNC service need
their own approved supervision and restart policy.

Check CDP from the actual execution runtime without printing session URLs:

```bash
node --input-type=module -e '
const r = await fetch("http://127.0.0.1:9223/json/version");
if (!r.ok) throw new Error("CDP health check failed");
const v = await r.json();
console.log(JSON.stringify({cdpReady:true,browser:v.Browser}));
'
```

The currently used headed display is `:99`; noVNC uses server-local port **6081**:

```text
http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale&path=websockify
```

Forward 6081 through approved VS Code Remote SSH or SSH forwarding. If necessary,
the SSH pattern is:

```bash
ssh -N -L 6081:127.0.0.1:6081 <user>@<clinical-automation-host>
```

Open the local link, confirm you see the writer Chrome, and log into the intended
PrognoCIS account. An HTTP 200 for `vnc.html` alone does not prove that VNC is
connected or that the correct browser window is visible.

The saved CDP profile must survive restarts. Never delete its locks/profile to
force a second Chrome instance; determine whether its owner is still running.
Do not capture screenshots/traces containing patient details or credentials.

If restarting headed Chrome is needed, use the approved deployment's browser
service. `src/browser/session.mjs` provides `resolveChromiumExecutable()` for
startup tooling, but is not itself a daemon. Do not add a per-patient Chrome
launcher to the cron wrapper; it risks profile contention and lost authentication.

## 9. Validate under the scheduler's identity before activation

Run these commands in the same repository path/runtime and as the same user that
will execute the job:

```bash
node --version
npm ci
npm run check
npm run validate:config -- --config config/writeback.json
npm run validate:response -- --config config/writeback.json --max-records 1
npm run probe -- --config config/writeback.json --max-records 1
```

Do not run `npm ci` from each cron tick; it is a deployment step. Browser tests
use synthetic fixtures, but a probe and HTTP response validation use the configured
production source. They do not write narratives or acknowledge records.

An eligible response validation reports:

```json
{"mode":"validate-response","validated":1,"ehrWrites":0}
```

`validated:0` is valid when nothing is eligible, including an already-acknowledged
canary. It does not prove a new eligible record's selectors/matching will work.

### Approve and enable the stable production config

Only after validation, destination review and an approved successful draft canary:

1. Set the private exact `CLINICAL_WRITE_ACK` value from section 5.
2. Set `automation.writeEnabled=true` in **`config/writeback.json`**.
3. Keep `automation.draftOnly=true`, `headless=false` and `maxRecordsPerRun=1`.
4. Verify the ongoing request isn't pinned to the old canary.
5. Verify the production ledger path is stable and persistent.

The interactive tests used run-specific configs/acknowledgements and disabled
writes afterward. Their success does **not** imply this stable config is enabled
or the stable `.env` contains the write acknowledgement.

Check credential/config loading without opening an EHR or calling the API:

```bash
node --input-type=module -e '
import {loadConfig} from "./src/runtime/config.mjs";
const c = await loadConfig("config/writeback.json");
if (!c.automation.writeEnabled) throw new Error("Scheduled writes are disabled");
console.log(JSON.stringify({ready:true,draftOnly:c.automation.draftOnly}));
'
```

A wrapper execution is a **real production run**, not another validation. Run
it manually only with approval for whatever eligible record the broad filter
will return. For supervised testing without upstream acknowledgement:

```bash
npm run run -- --config config/writeback.json --max-records 1 --no-acknowledge
```

A later normal run can acknowledge locally verified content without rewriting it.
Do not delete verification proof to make the automation appear active in a demo.

## 10. Configure Hermes timing and runtime limits

Merge into the actual gateway profile's `config.yaml`, not the worker's JSON:

```yaml
timezone: "America/Chicago"
cron:
  script_timeout_seconds: 1200
```

Preserve all other config keys. The local Hermes implementation also supports
`HERMES_TIMEZONE` and `HERMES_CRON_SCRIPT_TIMEOUT`; the timeout environment setting
overrides its YAML value. Set service-level environment values in the gateway's
supervisor configuration, not merely in your login shell.

The worker's timezone is for encounter-date matching; Hermes's timezone is for
the schedule. Setting one does not configure the other. Account for daylight
saving changes when choosing wall-clock schedules. A five-minute cadence is
`*/5 * * * *`.

Measure typical and worst-case runtimes. The example 1200-second ceiling is a
starting operational bound, not a throughput guarantee. A timeout can leave a
partial clinical write and a lock requiring reconciliation; it is not permission
to replay blindly. Restart/reload the gateway through its approved supervisor
after changing settings, then check `hermes cron status`.

## 11. Preview and install the repository's job

### Check for duplicates first

```bash
hermes cron list
```

Inspect both the current Care1960 name and older QuickRCM writeback job names.
Pause an obsolete reverse writer before activating its replacement. Do not pause
the forward appointments cron accidentally. Record actual job IDs from this
deployment rather than copying IDs from old documentation.

### Preview—does not alter the scheduler

```bash
cd /quickintell/workspaces/anurag_workspace/quickrcm-prognocis-writeback
bash scripts/install-hermes-cron.sh --dry-run '*/5 * * * *' local
```

Check the reported Hermes command, wrapper home, job, schedule and delivery.
They must correspond to the running gateway's user, profile and filesystem.

### Activate—this command changes the scheduler

After all preceding checks and production approval:

```bash
bash scripts/install-hermes-cron.sh '*/5 * * * *' local
```

The installer:

1. Resolves an absolute Node executable and the repository location.
2. Resolves Hermes and its scripts directory.
3. Structurally validates the live config.
4. Writes the wrapper with permissions 700.
5. Attempts to edit the named job, otherwise creates it as `--no-agent`.
6. Supplies the absolute `--workdir` and selected delivery target.
7. Prints scheduler status.

**Installation is activation; there is no guaranteed staging pause.** A due
job can execute once created. The inherited installer default is not every
five minutes, so always pass the intended expression explicitly.

The installer's config validation does not prove API authentication, browser
login, private write acknowledgement or clinical readiness. That is why the
preflight and supervised tests above are mandatory. If an edit fails for a
reason other than a missing job, the fallback create may produce a duplicate;
inspect the list after installation rather than rerunning blindly.

`local` delivery keeps scheduled output in Hermes's local cron output storage.
Use a clinically approved notification channel only for PHI-free summaries; do
not send patient data, source responses or ledgers into messaging platforms.

## 12. Manual alternative to the installer

Use this only if the installer is unsuitable for the actual deployment. **Do
not use both methods to create duplicate jobs.** Hermes requires its scripts to
resolve inside its own scripts directory; copy the wrapper rather than symlinking
to a file outside that directory. This behavior was checked in the local
`cron/scheduler.py` and is documented in the [script-only guide](https://hermes-agent.nousresearch.com/docs/guides/cron-script-only).

In the correct gateway runtime:

```bash
PROJECT_ROOT=/quickintell/workspaces/anurag_workspace/quickrcm-prognocis-writeback
NODE_BIN="$(command -v node)"
HERMES_BASE="${HERMES_HOME:-$HOME/.hermes}"
WRAPPER="$HERMES_BASE/scripts/care1960-prognocis-clinical-drafts.sh"

umask 077
mkdir -p "$HERMES_BASE/scripts"
chmod 700 "$HERMES_BASE/scripts"
sed -e "s|__PROJECT_ROOT__|$PROJECT_ROOT|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$PROJECT_ROOT/scripts/writeback-wrapper.template.sh" > "$WRAPPER"
chmod 700 "$WRAPPER"
bash -n "$WRAPPER"
```

The resulting wrapper contains only paths, no credentials:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
project_root="<absolute runtime-visible repository path>"
node_bin="<absolute node executable>"
cd -- "$project_root"
exec "$node_bin" src/cli.mjs run --config config/writeback.json
```

After approval, create one job:

```bash
hermes cron create '*/5 * * * *' \
  --name care1960-prognocis-clinical-drafts \
  --no-agent \
  --script care1960-prognocis-clinical-drafts.sh \
  --workdir "$PROJECT_ROOT" \
  --deliver local
```

For an existing job, use its actual ID:

```bash
hermes cron edit <job-id> \
  --schedule '*/5 * * * *' \
  --no-agent \
  --script care1960-prognocis-clinical-drafts.sh \
  --workdir "$PROJECT_ROOT" \
  --deliver local
```

## 13. Verify the first scheduled execution

```bash
hermes cron list
hermes cron status
```

Confirm the job is enabled, has the expected schedule and script, uses no-agent
mode, and points to the correct workdir. Inspect local output and the worker audit.
The current CLI's manual trigger is:

```bash
hermes cron run <job-id>
```

It requests execution on the **next scheduler tick**; it is not proof that the
browser already completed. Avoid triggering another run while one is active.
The lifecycle commands are also described in the [official cron reference](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).

A successful new record typically ends with:

```json
{"mode":"draft-write","queued":1,"probed":0,"verified":1,"acknowledged":1,"recovered":0,"skipped":0,"duplicates":0,"failed":0}
```

Successful audit events include `writeback_record_verified` followed by
`writeback_record_acknowledged`. A verified-but-unacknowledged record can produce
`writeback_record_acknowledgement_recovered` on a later normal run without an EHR
rewrite. A verified replay can report `duplicates:1`. An empty queue reports zero
queued records; no browser write occurs.

Do not declare success just because Hermes dispatched a script, a save response
was 200, or `verified` increased. For a normal production completion, check
acknowledgement or its validated recovery as well as `failed:0`.

Use the controlled audit privately:

```bash
tail -n 20 .runtime/writeback-audit.jsonl
```

Do not publish request/response bodies or the verification ledger. The ledger
contains retained EHR encounter/export identifiers even though it stores no note text.

## 14. Concurrency and shared Chrome

The worker uses `.runtime/writeback.lock` to exclude overlapping invocations
that share that same lock file. An active second invocation fails rather than
writing simultaneously. The lock is time-based and considered stale after six
hours; do not configure six-hour clinical runs or casually delete it.

This lock **does not coordinate** the forward appointment job, unrelated browser
jobs or manual automation that uses a different lock. Timing offsets alone do
not guarantee safety if a job runs long.

If both crons control the same Chrome, arrange a common browser mutex in **both**
wrappers or run them in a serialized orchestration. On Linux, one approved pattern
is a persistent shared `flock` file outside the Chrome profile:

```bash
# Same absolute file/path mapping must be used by both integrations.
exec flock -n /path/to/private-shared-runtime/prognocis-browser.lock \
  "$node_bin" src/cli.mjs run --config config/writeback.json
```

Ensure the lock directory exists and is private, and that both execution users
can legitimately access it. An unavailable nonblocking lock exits nonzero and
should be monitored. Do not assume unrelated jobs will honor it automatically.
The repository installer does not add this cross-integration lock for you.

## 15. Recovery and stopping safely

Pause the scheduled job before clinical reconciliation:

```bash
hermes cron pause <job-id>
```

Pausing prevents future scheduled starts; it may not cancel an already-running
worker. Check its process and destination state before making manual changes.
Setting the stable config's `writeEnabled=false` also prevents **future** normal
write invocations; a process that already loaded its config may still be running.

| Symptom | Action |
| --- | --- |
| HTTP 401/403 | Check private credential validity, tenant registration and same-instance pairing; never print tokens |
| HTTP 400 | Check request types, UUIDs, timestamps and paired EHR filters; remove literal placeholders |
| Function not found/404 | Check intended project and schema cache with backend operations; do not blindly rerun migration 0010 |
| No eligible records | Expected after acknowledgement or when nothing is attested; check a stale exact-job/time filter |
| `fetch failed` before matching | Check local CDP readiness separately from API reachability; it is not necessarily an API outage |
| `AUTH_REQUIRED` | Login privately to the intended PrognoCIS account, then probe before resuming |
| Missing provider selector | Inspect Encounter History; do not remove provider verification |
| HPI/binocular lookup missing | Wait for the HPI frame and inspect `#searchCompl`; do not type into an unverified field |
| Frame/context destroyed | Read recovery is bounded; if it still fails, inspect readiness/frames before another write |
| `CLINICAL_TEXT_CONFLICT` | Review source versus destination with the authorized clinician; do not overwrite |
| `DRAFT_READBACK_FAILED` / note mismatch | Reopen the exact encounter and inspect actual persistence; do not acknowledge |
| Unexpected dialog | Reconcile it manually and inspect the clinical state before retrying |
| Acknowledgement timeout/error | Keep verified proof; reconcile backend status before another attempt; the invocation does not automatically retry |
| Active/stale lock | Establish whether its PID is alive and whether a partial write occurred; do not delete a live lock |
| Same pending record every tick | Check withheld/failed acknowledgement, filters and reconciliation; do not reset the ledger |
| Job never fires | Check gateway/ticker, enabled state, next run, timezone, Hermes home/profile and script/workdir accessibility |

The HTTP source's revalidation checks the captured invocation snapshot, not a
fresh backend fetch. Keep the provider-attested note contract stable and pause
for corrections rather than assuming a repeated in-memory validation fetched
new clinical data.

After resolving a failure, validate and probe first. Resume only after review:

```bash
hermes cron resume <job-id>
```

To retire a job, pause it and then use `hermes cron remove <job-id>`. Keep the
clinical ledger and audit according to approved retention rules; removing the
schedule does not justify deleting proof or rolling back clinical text.

## 16. Deployment and go-live checklist

- [ ] Correct Hermes user/home/profile and gateway runtime identified.
- [ ] Node >=22 and dependencies installed; regression suite passes.
- [ ] Private credentials use the current loader's names and production instance.
- [ ] Correct tenant organization configured; no placeholder filters/selectors.
- [ ] Stable config uses HTTP fetch and exact production acknowledgement endpoint.
- [ ] `draftSaveStrategy=sections-only`; no Assessment navigation configured.
- [ ] `draftOnly=true`; only approved narrative fields/actions are configured.
- [ ] Approved canary proved HPI/ROS/Physical Examination persistence and Open status.
- [ ] Stable write acknowledgement/config explicitly approved and enabled.
- [ ] Ongoing request is not pinned to the completed test job.
- [ ] Production request limit matches the worker limit; cursor policy chosen deliberately.
- [ ] Stable runtime ledger, audit and browser profile are persistent and backed up privately.
- [ ] Chrome/CDP remains loopback-only, authenticated and supervised.
- [ ] Correct browser is visible through private noVNC when supervised access is needed.
- [ ] No duplicate reverse job and no simultaneous control of shared Chrome.
- [ ] Hermes timezone and script timeout configured in the gateway, not just a shell.
- [ ] Installer preview checked before activation; first scheduled result reviewed.
- [ ] Operator owns alerts, login expiry, clinical conflicts and acknowledgement recovery.

### Quick command sequence after all prerequisites and approval

```bash
cd /quickintell/workspaces/anurag_workspace/quickrcm-prognocis-writeback
npm run validate:config -- --config config/writeback.json
npm run validate:response -- --config config/writeback.json --max-records 1
npm run probe -- --config config/writeback.json --max-records 1

# Only after supervised canary, stable write approval, browser readiness
# and broad pending-record request setup:
bash scripts/install-hermes-cron.sh --dry-run '*/5 * * * *' local
bash scripts/install-hermes-cron.sh '*/5 * * * *' local

# Using the correct Hermes executable/profile:
hermes cron list
hermes cron status
```

No Linux `crontab -e` entry is required for this method. Do not additionally
schedule the same worker in system cron: Hermes's gateway is the scheduler.

### Implementation references

This guide's worker behavior was checked against `src/cli.mjs`,
`src/runtime/config.mjs`, `src/runtime/lock.mjs`, `src/runtime/ledger.mjs`,
`src/workflow/writeback.mjs`, `src/integrations/care1960-api.mjs` and
`src/integrations/prognocis-browser.mjs`. The installer/wrapper were read and
the installer dry-run and shell syntax checked without changing the scheduler.
Hermes command forms, timeout, timezone and script containment were checked
against the local sibling checkout and its CLI help. Recheck these after upgrades.
