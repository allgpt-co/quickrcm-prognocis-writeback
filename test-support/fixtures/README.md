# Care1960 migration 0010 response

`care1960-0010-response.json` was captured by executing
`care1960_get_attested_clinical_records` in an isolated PostgreSQL 16 database
on 2026-09-16. All patient identities and clinical text are synthetic.

Source: the sibling `1960pacare/Supabase_Applications/care1960` repository,
`supabase/migrations/0010_care1960_attested_clinical_api.sql`. Setup applied the
six platform migrations and Care1960 migrations 0001–0010 with synthetic
Auth/Storage compatibility tables. All 67 checks in
`supabase/tests/0010_care1960_attested_clinical_api.test.sql` passed.

The capture used that SQL test's synthetic seed through `END SYNTHETIC SEED`,
then the `authenticated` role with its synthetic organization/key claims and
this query:

```sql
select public.care1960_get_attested_clinical_records(
  p_scribe_job_id => '50000000-0000-4000-8000-000000000082',
  p_limit => 1
);
```

The seed transaction was rolled back and the temporary database removed. No
deployed Supabase instance or real EHR was used. The fixture preserves the
returned array, microsecond timestamps, and extra attestation provenance fields.

The API test consumes this fixture through a local HTTP POST. The destination
test maps this same fixture through the source adapter and writes/reopens the
three narrative fields in a synthetic browser page. Patient/encounter navigation
is tested separately; these tests do not establish a live PrognoCIS canary.
