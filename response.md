Committed the changes on feature/care1960-prognocis-writeback using Anurag Deshmukh <anuragdeshmukh61@gmail.com> as the sole author.

- ab2ec29: Support uppercase PrognoCIS login credentials
- f65e95a: Select and verify exact Wellness complaint
- 4cb47b5: Persist retry attempts across worker restarts
- 5eb5722: Add authenticated retry failure update endpoint
- 447741a: Retire exhausted jobs without blocking queue
- 432568d: Accept attested empty and placeholder narratives
- dae0509: Verify empty section saves and replay
- f0f34a1: Document retry handling and narrative compatibility
- e3da7a7: Add browser screenshot for troubleshooting reference

This response is recorded in a final status commit on the same branch.

Validation: 114 tests passed; the full live run on DISPLAY=:99 saved, verified, and acknowledged one encounter with zero failures. Cron remains paused.

The local commit skill remains untracked because skills/commit/SKILL.md explicitly says "do not commit this skill.md file". Ignored credentials, live configuration, and runtime files remain local.
