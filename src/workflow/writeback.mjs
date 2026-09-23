import crypto from 'node:crypto';

function jobKey(jobId) {
  return crypto.createHash('sha256').update(String(jobId)).digest('hex');
}

export async function runWriteback(config, { source, destination, ledger, retryLedger, audit }, { acknowledgeSource = true } = {}) {
  if (typeof acknowledgeSource !== 'boolean') throw new Error('acknowledgeSource must be a boolean');
  const retryEnabled = config.automation.writeEnabled && acknowledgeSource
    && config.care1960?.input === 'http' && config.automation.maxRetries !== undefined;
  const maxAttempts = 1 + config.automation.maxRetries;
  if (retryEnabled && (!retryLedger || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) {
    throw new Error('Bounded retries require a persistent retry ledger and a valid retry limit');
  }
  const artifacts = await source.listAttestedArtifacts(config.automation.maxRecordsPerRun);
  const summary = {
    mode: config.automation.writeEnabled ? (acknowledgeSource ? 'draft-write' : 'draft-write-no-ack') : 'probe',
    queued: artifacts.length,
    probed: 0,
    verified: 0,
    acknowledged: 0,
    recovered: 0,
    skipped: 0,
    duplicates: 0,
    failed: 0,
    retryFailed: 0
  };
  await audit.info('writeback_queue_loaded', {
    mode: summary.mode,
    count: artifacts.length,
    status: 'ready'
  });

  for (const artifact of artifacts) {
    const safeJobKey = jobKey(artifact.jobId);
    const started = Date.now();
    let attempted = false;
    const retireFailedRecord = async () => {
      await source.revalidate(artifact);
      // Persist the failure flag first. Never remove a failed record from the
      // source queue until its retry-failed response has been validated.
      const flagged = await source.markRetryFailed(artifact);
      const acknowledged = await source.markWrittenBack(artifact);
      if (flagged.clinicalExportId !== acknowledged.clinicalExportId) {
        throw Object.assign(new Error('Failure flag and acknowledgement refer to different exports'), {
          code: 'CARE1960_RETRY_FAILED_EXPORT_MISMATCH'
        });
      }
      await retryLedger.markRetired(safeJobKey);
      await audit.error('writeback_record_retry_exhausted', {
        jobKey: safeJobKey, artifactHash: artifact.artifactHash,
        status: 'retry-failed', count: retryLedger.get(safeJobKey).attempts,
        durationMs: Date.now() - started
      });
      summary.retryFailed += 1;
    };
    try {
      if (retryEnabled && retryLedger.get(safeJobKey).retired) {
        summary.skipped += 1;
        await audit.info('writeback_record_already_retired', {
          jobKey: safeJobKey, artifactHash: artifact.artifactHash, status: 'retry-failed'
        });
        continue;
      }
      if (config.automation.writeEnabled && ledger.isAcknowledged(artifact.artifactHash)) {
        summary.skipped += 1;
        await audit.info('writeback_record_already_acknowledged', {
          jobKey: safeJobKey,
          artifactHash: artifact.artifactHash,
          status: 'idempotent',
          durationMs: Date.now() - started
        });
        continue;
      }
      if (config.automation.writeEnabled && ledger.has(artifact.artifactHash)) {
        await source.revalidate(artifact);
        if (!acknowledgeSource) {
          summary.skipped += 1;
          await audit.info('writeback_record_acknowledgement_withheld', {
            jobKey: safeJobKey, artifactHash: artifact.artifactHash,
            status: 'verified-unacknowledged', durationMs: Date.now() - started
          });
          continue;
        }
        const acknowledgement = await source.markWrittenBack(artifact);
        await ledger.markAcknowledged({
          artifactHash: artifact.artifactHash,
          jobKey: safeJobKey,
          clinicalExportId: acknowledgement.clinicalExportId,
          writtenBackAt: acknowledgement.writtenBackAt
        });
        summary.acknowledged += 1;
        summary.recovered += 1;
        await audit.info('writeback_record_acknowledgement_recovered', {
          jobKey: safeJobKey,
          artifactHash: artifact.artifactHash,
          status: 'acknowledged',
          durationMs: Date.now() - started
        });
        continue;
      }
      await source.revalidate(artifact);
      if (retryEnabled && retryLedger.get(safeJobKey).attempts >= maxAttempts) {
        await retireFailedRecord();
        continue;
      }
      // Browser startup failures must not spend a record's clinical retry budget.
      // This also lets exhausted records finish their RPCs without opening Chrome.
      await destination.prepare?.();
      if (retryEnabled) {
        const attempt = await retryLedger.beginAttempt(safeJobKey, maxAttempts);
        attempted = true;
        await audit.info('writeback_record_attempt_started', {
          jobKey: safeJobKey, artifactHash: artifact.artifactHash, status: 'attempt', count: attempt
        });
      }
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
      if (!acknowledgeSource) {
        await audit.info('writeback_record_acknowledgement_withheld', {
          jobKey: safeJobKey, artifactHash: artifact.artifactHash,
          status: 'verified-unacknowledged', durationMs: Date.now() - started
        });
        continue;
      }
      const acknowledgement = await source.markWrittenBack(artifact);
      await ledger.markAcknowledged({
        artifactHash: artifact.artifactHash,
        jobKey: safeJobKey,
        clinicalExportId: acknowledgement.clinicalExportId,
        writtenBackAt: acknowledgement.writtenBackAt
      });
      summary.acknowledged += 1;
      await audit.info('writeback_record_acknowledged', {
        jobKey: safeJobKey,
        artifactHash: artifact.artifactHash,
        status: 'acknowledged',
        durationMs: Date.now() - started
      });
    } catch (error) {
      await audit.error('writeback_record_failed', {
        jobKey: safeJobKey,
        artifactHash: artifact.artifactHash,
        status: 'failed',
        errorCode: error.code ?? 'WRITEBACK_RECORD_FAILED',
        durationMs: Date.now() - started
      });
      if (['AUTH_REQUIRED', 'CARE1960_AUTH_REQUIRED'].includes(error.code)) {
        if (attempted && !ledger.has(artifact.artifactHash)) await retryLedger.cancelAttempt(safeJobKey);
        throw error;
      }
      if (attempted && !ledger.has(artifact.artifactHash)
        && retryLedger.get(safeJobKey).attempts >= maxAttempts) {
        try {
          await retireFailedRecord();
          continue;
        } catch (retirementError) {
          await audit.error('writeback_record_retirement_pending', {
            jobKey: safeJobKey, artifactHash: artifact.artifactHash, status: 'pending',
            errorCode: retirementError.code ?? 'WRITEBACK_RETIREMENT_FAILED'
          });
        }
      }
      summary.failed += 1;
    }
  }
  return summary;
}
