# Care1960 writeback readiness

- [ ] Apply migration `0010` to the intended Supabase instance and verify its clinical read RPC is available.
- [ ] Set the actual organization UUID; use the default mappings for migration `0010`.
- [ ] For file input, save the actual POST response in the private runtime directory.
- [ ] For HTTP input, set the clinical read endpoint, exact-job request body, and separate gateway/tenant credentials from that instance.
- [ ] Run `npm run validate:response` and confirm all three attested sections and identities validate.
- [ ] Log in to PrognoCIS in the configured Chrome session.
- [ ] Configure exact patient-ID, encounter, section, save, and draft-status selectors.
- [ ] Run `npm run validate:config`, then `npm run probe -- --max-records 1`.
- [ ] Run a supervised draft canary with the existing write acknowledgement enabled.
- [ ] Verify HPI, ROS, Physical Examination, the exact encounter, and draft status after reopening.
- [ ] Verify a repeated response creates no additional writes.
- [ ] Reconcile batch progress before scheduling: the writer does not paginate automatically.
- [ ] Check source scheduling and other browser jobs before installing a cron.

`probe` never writes to PrognoCIS. With HTTP input it still invokes the configured
POST. `care1960_get_attested_clinical_records` is read-only and does not update
appointment or export state. HTTP revalidation checks the captured response,
not current upstream state. See [the API contract](docs/CARE1960_INTEGRATION.md).
