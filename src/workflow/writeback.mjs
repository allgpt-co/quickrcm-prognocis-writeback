import crypto from 'node:crypto';

function jobKey(jobId) {
  return crypto.createHash('sha256').update(String(jobId)).digest('hex');
}

export async function runWriteback(config, { source, destination, ledger, audit }) {
  const artifacts = await source.listAttestedArtifacts(config.automation.maxRecordsPerRun);
  const summary = {
    mode: config.automation.writeEnabled ? 'draft-write' : 'probe',
    queued: artifacts.length,
    probed: 0,
    verified: 0,
    skipped: 0,
    duplicates: 0,
    failed: 0
  };
  await audit.info('writeback_queue_loaded', {
    mode: summary.mode,
    count: artifacts.length,
    status: 'ready'
  });

  for (const artifact of artifacts) {
    const safeJobKey = jobKey(artifact.jobId);
    const started = Date.now();
    try {
      if (config.automation.writeEnabled && ledger.has(artifact.artifactHash)) {
        summary.skipped += 1;
        await audit.info('writeback_record_already_verified', {
          jobKey: safeJobKey,
          artifactHash: artifact.artifactHash,
          status: 'idempotent',
          durationMs: Date.now() - started
        });
        continue;
      }
      await source.revalidate(artifact);
      const result = await destination.process(artifact, {
        writeEnabled: config.automation.writeEnabled
      });
      if (!config.automation.writeEnabled) {
        if (result.status !== 'PROBED') throw new Error('Destination probe did not return PROBED');
        summary.probed += 1;
        await audit.info('writeback_record_probed', {
          jobKey: safeJobKey,
          artifactHash: artifact.artifactHash,
          status: 'probed',
          durationMs: Date.now() - started
        });
        continue;
      }

      if (result.status !== 'DRAFT_VERIFIED' || !result.ehrEncounterId) {
        throw new Error('PrognoCIS did not return verified-draft proof');
      }
      await source.revalidate(artifact);
      await ledger.markVerified({
        artifactHash: artifact.artifactHash,
        jobKey: safeJobKey,
        ehrEncounterId: result.ehrEncounterId
      });
      summary.verified += 1;
      if (result.duplicate) summary.duplicates += 1;
      await audit.info('writeback_record_verified', {
        jobKey: safeJobKey,
        artifactHash: artifact.artifactHash,
        status: result.duplicate ? 'idempotent' : 'written',
        durationMs: Date.now() - started
      });
    } catch (error) {
      summary.failed += 1;
      await audit.error('writeback_record_failed', {
        jobKey: safeJobKey,
        artifactHash: artifact.artifactHash,
        status: 'failed',
        errorCode: error.code ?? 'WRITEBACK_RECORD_FAILED',
        durationMs: Date.now() - started
      });
      if (error.code === 'AUTH_REQUIRED') throw error;
    }
  }
  return summary;
}
