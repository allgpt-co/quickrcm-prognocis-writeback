import { validateClinicalArtifact } from '../domain/clinical-artifact.mjs';

function endpoint(baseUrl, endpointPath) {
  if (typeof endpointPath !== 'string' || !endpointPath.startsWith('/')) {
    throw new Error('QuickRCM endpoint paths must start with /');
  }
  return new URL(endpointPath, baseUrl);
}

export class QuickRcmClient {
  constructor(config, apiKey, fetchImpl = globalThis.fetch) {
    this.config = config;
    this.baseUrl = new URL(config.baseUrl);
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('QUICKRCM_API_KEY is required');
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.apiKey = apiKey.trim();
    this.fetch = fetchImpl;
  }

  async request(method, url, body) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response;
    try {
      response = await this.fetch(url.href, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    } catch (error) {
      const result = new Error(`QuickRCM ${method} request failed`);
      result.code = error.name === 'AbortError' ? 'QUICKRCM_TIMEOUT' : 'QUICKRCM_NETWORK_ERROR';
      throw result;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const error = new Error(`QuickRCM ${method} returned HTTP ${response.status}`);
      error.code = 'QUICKRCM_HTTP_ERROR';
      throw error;
    }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
      const error = new Error(`QuickRCM ${method} response was not JSON`);
      error.code = 'QUICKRCM_INVALID_RESPONSE';
      throw error;
    }
    return response.json();
  }

  async getAttestedQueue(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Queue limit must be an integer from 1 to 100');
    }
    const url = endpoint(this.baseUrl, this.config.queuePath);
    url.searchParams.set('status', 'ATTESTED');
    url.searchParams.set('limit', String(limit));
    const payload = await this.request('GET', url);
    if (payload?.version !== 2 || payload?.destination !== 'prognocis' || !Array.isArray(payload.items)) {
      throw new Error('QuickRCM write-back queue returned an invalid envelope');
    }
    return payload.items.map(validateClinicalArtifact);
  }

  async acknowledgeVerifiedDraft(artifact, ehrEncounterId) {
    const validated = validateClinicalArtifact(artifact);
    if (typeof ehrEncounterId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(ehrEncounterId.trim())) {
      throw new Error('An opaque PrognoCIS encounter ID is required for acknowledgement');
    }
    const ackPath = this.config.ackPath.replace('{jobId}', encodeURIComponent(validated.jobId));
    if (ackPath === this.config.ackPath) throw new Error('quickRcm.ackPath must contain {jobId}');
    const payload = await this.request('POST', endpoint(this.baseUrl, ackPath), {
      destination: 'prognocis',
      status: 'DRAFT_VERIFIED',
      artifactHash: validated.artifactHash,
      ehrEncounterId: ehrEncounterId.trim()
    });
    if (payload?.status !== 'DRAFT_VERIFIED') {
      throw new Error('QuickRCM did not confirm the exact verified-draft acknowledgement');
    }
    return payload;
  }
}
