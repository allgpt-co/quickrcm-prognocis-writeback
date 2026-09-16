# Care1960 validation status

`npm run check` passes all 43 writer tests, including the SQL-response mapping
and synthetic browser checks below.

The API-source migration has automated coverage for field mapping, tenant and
identity validation, missing sections, HTTP authentication/body transmission,
single-POST behavior, response changes, controlled errors, timeout/redirect
handling, duplicate skipping, and CLI response validation without a browser.

Migration `0010_care1960_attested_clinical_api.sql` was executed in an isolated
PostgreSQL 16 database with all preceding platform and Care1960 migrations.
All 67 checks in its SQL suite passed. A response from the actual SQL function,
using synthetic records, is retained in `test-support/fixtures` with provenance.

The captured SQL response passes the API adapter through a local HTTP POST
with separate gateway/tenant credentials and no field overrides. The synthetic
Playwright test maps that same response, saves all three narratives, reopens
persisted values, verifies draft status, rejects conflicting text, and repeats
without writes. Patient/encounter navigation is stubbed in this section test;
matching has separate browser and unit coverage.

The endpoint and checked-in response mappings are verified against the migration.
Deployment to the intended Supabase instance, actual gateway/tenant credentials,
and a live PrognoCIS draft canary remain unverified. No deployed backend, live
EHR record, or scheduler was changed. The isolated database was removed.
