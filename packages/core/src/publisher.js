// Vidmyo Auto-Publisher Engine for Vidmyo V2.6
// Implements YouTube Data API v3 upload adapter with Resumable Upload protocol,
// durable state tracking (uploading -> processing -> scheduled | published),
// permanent remote video ID storage, and duplicate protection.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { vidmyoHome, testRunMarker } from './paths.js';

export const PUBLISH_STATES = {
  QUEUED: 'queued',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'published',
  ERROR: 'error',
  CANCELLED: 'cancelled',
};

export const PLATFORMS = {
  YOUTUBE: 'youtube',
  TIKTOK: 'tiktok',
  INSTAGRAM_REELS: 'instagram_reels',
};

export function defaultPublisherQueuePath() {
  return path.join(vidmyoHome(), 'publisher-queue.json');
}

export class PublishRecordStore {
  constructor(persistPath = null) {
    this.records = new Map(); // publishJobId -> Record
    this.persistPath = persistPath;
    if (this.persistPath) {
      this.load();
    }
  }

  load() {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      if (Array.isArray(data)) {
        let recovered = false;
        for (const item of data) {
          if (!item || !item.id) continue;
          // Startup reconciliation: a process crash/kill mid-upload leaves
          // the record in a non-terminal in-flight state on disk. Move
          // records that cannot make progress back to a resumable `queued`
          // state so the queue can resume through queryUploadStatus on the
          // next run instead of being stuck forever (retry() historically
          // only re-queued error/cancelled, and the duplicate guard blocks
          // re-creating the same video):
          //   - `uploading`: always recoverable — with a session URL it
          //     resumes via queryUploadStatus, without one it re-initiates.
          //   - `processing` WITHOUT remoteVideoId: cannot be polled; resume
          //     via queryUploadStatus (finished session → processing).
          //   - `processing` WITH remoteVideoId stays: it is already
          //     resumable through pollProcessingStatus (publisher:poll).
          const stuck = item.state === PUBLISH_STATES.UPLOADING
            || (item.state === PUBLISH_STATES.PROCESSING && !item.remoteVideoId);
          if (stuck) {
            item.state = PUBLISH_STATES.QUEUED;
            item.recoveredAt = new Date().toISOString();
            recovered = true;
          }
          this.records.set(item.id, item);
        }
        if (recovered) this.save();
      }
    } catch {
      // ignore malformed
    }
  }

  save() {
    if (!this.persistPath) return;
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    const tmp = `${this.persistPath}.${process.pid}.${Date.now()}.tmp`;
    const marker = testRunMarker();
    const arr = Array.from(this.records.values()).map((record) => (
      marker && record && typeof record === 'object' && !record.testRun
        ? { ...record, testRun: marker }
        : record
    ));
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
    fs.renameSync(tmp, this.persistPath);
  }

  create({
    id = `pub_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    platform = PLATFORMS.YOUTUBE,
    channelId,
    videoPath,
    videoFileHash,
    metadata = {}, // { title, description, tags, privacyStatus, scheduledPublishTime, isShorts }
  }) {
    if (!channelId || !videoFileHash) {
      throw new Error('channelId and videoFileHash are required for publish record');
    }

    // Check duplicate: prevent duplicate upload if same file hash was published to this channel.
    // ERROR and CANCELLED records never completed, so re-submitting is allowed.
    const duplicate = Array.from(this.records.values()).find(
      r => r.channelId === channelId
        && r.videoFileHash === videoFileHash
        && r.state !== PUBLISH_STATES.ERROR
        && r.state !== PUBLISH_STATES.CANCELLED
    );

    if (duplicate) {
      throw new Error(`Duplicate publication blocked: file has already been submitted to channel ${channelId} (Job: ${duplicate.id}, RemoteId: ${duplicate.remoteVideoId || 'pending'})`);
    }

    const record = {
      id,
      platform,
      channelId,
      videoPath,
      videoFileHash,
      metadata: {
        title: metadata.title || 'Untitled Video',
        description: metadata.description || '',
        tags: metadata.tags || [],
        privacyStatus: metadata.privacyStatus || 'private', // private | unlisted | public
        scheduledPublishTime: metadata.scheduledPublishTime || null,
        isShorts: Boolean(metadata.isShorts || metadata.title?.includes('#Shorts')),
      },
      state: PUBLISH_STATES.QUEUED,
      remoteVideoId: null,
      resumableUploadUrl: null,
      bytesUploaded: 0,
      totalBytes: 0,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.records.set(id, record);
    this.save();
    return record;
  }

  get(id) {
    return this.records.get(id) || null;
  }

  listQueue({ channelId = null, state = null } = {}) {
    let list = Array.from(this.records.values());
    if (channelId) list = list.filter(r => r.channelId === channelId);
    if (state) list = list.filter(r => r.state === state);
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getPendingJobs() {
    return Array.from(this.records.values()).filter(r =>
      [PUBLISH_STATES.QUEUED, PUBLISH_STATES.UPLOADING, PUBLISH_STATES.PROCESSING].includes(r.state)
    );
  }

  cancel(id) {
    const record = this.records.get(id);
    if (!record) return false;
    if ([PUBLISH_STATES.QUEUED, PUBLISH_STATES.UPLOADING].includes(record.state)) {
      // Terminal 'cancelled' state (not an error): an in-flight transport
      // request is aborted separately by YouTubePublisherAdapter.cancelUpload.
      this.updateState(id, PUBLISH_STATES.CANCELLED, { error: null });
      return true;
    }
    return false;
  }

  retry(id) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Record not found: ${id}`);
    // error/cancelled: standard manual retry. `uploading`: a record stuck in
    // an in-flight state (e.g. loaded before startup reconciliation ran, or
    // crashed without a durable load) can be re-queued — executeUploadSession
    // resumes it through queryUploadStatus without a duplicate initiate.
    if (record.state === PUBLISH_STATES.ERROR
      || record.state === PUBLISH_STATES.CANCELLED
      || record.state === PUBLISH_STATES.UPLOADING) {
      return this.updateState(id, PUBLISH_STATES.QUEUED, { error: null });
    }
    return record;
  }

  updateState(id, state, extra = {}) {
    const record = this.records.get(id);
    if (!record) throw new Error(`Publish record not found: ${id}`);
    record.state = state;
    record.updatedAt = new Date().toISOString();
    if (extra.remoteVideoId) record.remoteVideoId = extra.remoteVideoId;
    if (extra.resumableUploadUrl) record.resumableUploadUrl = extra.resumableUploadUrl;
    if (extra.bytesUploaded !== undefined) record.bytesUploaded = extra.bytesUploaded;
    if (extra.totalBytes !== undefined) record.totalBytes = extra.totalBytes;
    if (extra.error !== undefined) record.error = extra.error ? String(extra.error) : null;
    this.save();
    return record;
  }
}

/**
 * YouTube Publisher Adapter
 * Handles offline / mocked and controlled resumable upload sessions.
 */
/**
 * Creates an authentic Resumable YouTube Transport conforming to Google Data API v3.
 * Supports chunked upload with Content-Range, 308 Resume Incomplete handling,
 * token retrieval from vault, and processing status polling.
 *
 * `baseUrl` defaults to the production Google API host. Offline tests point it
 * at a local loopback mock server — no real YouTube call is ever made by tests.
 */
export function createYouTubeResumableTransport({
  getAccessToken,
  // Optional: forces a fresh token (e.g. calls the OAuth vault's refresh
  // flow rather than its cached-token fast path). Falls back to
  // getAccessToken() again if not provided — still correct as long as the
  // caller's getAccessToken performs its own proactive refresh, but a
  // dedicated refresh callback lets the transport recover reactively on a
  // 401 even when the caller only checks expiry proactively.
  refreshAccessToken = null,
  fetchImpl = fetch,
  chunkSize = 256 * 1024,
  baseUrl = 'https://www.googleapis.com',
} = {}) {
  if (typeof getAccessToken !== 'function') {
    throw new Error('getAccessToken function is required for YouTube Resumable Transport');
  }

  const doRefresh = refreshAccessToken || getAccessToken;

  // Runs `attempt(token)` once; on a 401 (expired/revoked access token) it
  // refreshes the token and retries exactly once before giving up. Quota and
  // other errors are not retried here — they propagate for the caller to
  // classify (see handleQuotaExhaustion).
  async function withTokenRetry(attempt) {
    let token = await getAccessToken();
    let res = await attempt(token);
    if (res.status === 401) {
      token = await doRefresh();
      res = await attempt(token);
    }
    return res;
  }

  return {
    chunkSize,
    async initiateResumableUpload(metadata, { signal } = {}) {
      const snippet = {
        title: metadata.title || 'Untitled',
        description: metadata.description || '',
        tags: metadata.tags || [],
      };
      const status = {
        privacyStatus: metadata.privacyStatus || 'private',
        selfDeclaredMadeForKids: false,
        ...(metadata.scheduledPublishTime ? { publishAt: metadata.scheduledPublishTime } : {}),
      };

      const res = await withTokenRetry((token) => fetchImpl(`${baseUrl}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': 'video/mp4',
        },
        body: JSON.stringify({ snippet, status }),
        signal,
      }));

      if (res.status === 401) {
        throw Object.assign(new Error('YouTube API error: authentication failed after token refresh'), { status: 401 });
      }

      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        const reason = body?.error?.errors?.[0]?.reason || 'quotaExceeded';
        const err = new Error(`YouTube API error: ${reason}`);
        err.status = 403;
        err.reason = reason;
        throw err;
      }

      if (!res.ok) {
        throw new Error(`Failed to initiate resumable upload: ${res.status} ${res.statusText}`);
      }

      const uploadUrl = res.headers.get('location') || res.headers.get('Location');
      if (!uploadUrl) {
        throw new Error('YouTube did not return a resumable upload Location header');
      }

      return { uploadUrl };
    },

    async uploadChunk(uploadUrl, chunkBuffer, startByte, totalBytes, { signal } = {}) {
      const endByte = startByte + chunkBuffer.length - 1;

      const res = await withTokenRetry((token) => fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'video/mp4',
          'Content-Range': `bytes ${startByte}-${endByte}/${totalBytes}`,
          'Content-Length': String(chunkBuffer.length),
        },
        body: chunkBuffer,
        signal,
      }));

      if (res.status === 308) {
        // Resume Incomplete - query received range
        const rangeHeader = res.headers.get('range') || res.headers.get('Range');
        let bytesReceived = startByte + chunkBuffer.length;
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) bytesReceived = parseInt(match[1], 10) + 1;
        }
        return {
          bytesReceived,
          done: false,
          videoId: null,
        };
      }

      if (res.status === 200 || res.status === 201) {
        const data = await res.json();
        return {
          bytesReceived: totalBytes,
          done: true,
          videoId: data.id,
        };
      }

      if (res.status === 401) {
        throw Object.assign(new Error('Upload chunk failed: authentication failed after token refresh'), { status: 401 });
      }

      if (res.status === 403) {
        const body = await res.json().catch(() => ({}));
        const reason = body?.error?.errors?.[0]?.reason || 'quotaExceeded';
        const err = new Error(`YouTube chunk upload quota exceeded: ${reason}`);
        err.status = 403;
        err.reason = reason;
        throw err;
      }

      throw new Error(`Upload chunk failed with status ${res.status}: ${res.statusText}`);
    },

    async checkProcessingStatus(videoId, { signal } = {}) {
      const res = await withTokenRetry((token) => fetchImpl(`${baseUrl}/youtube/v3/videos?part=processingDetails,status&id=${videoId}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
        signal,
      }));

      if (!res.ok) {
        throw new Error(`Failed to check processing status for ${videoId}: ${res.statusText}`);
      }

      const data = await res.json();
      const item = data.items?.[0];
      if (!item) {
        return { processingStatus: 'not_found' };
      }

      const status = item.status?.uploadStatus; // uploaded | processed | failed | rejected
      const processingDetails = item.processingDetails;
      if (status === 'processed' || processingDetails?.processingStatus === 'succeeded') {
        return { processingStatus: 'succeeded' };
      }
      if (status === 'failed' || status === 'rejected' || processingDetails?.processingStatus === 'failed') {
        return {
          processingStatus: 'failed',
          errorReason: processingDetails?.processingFailureReason || item.status?.rejectionReason || 'Processing failed',
        };
      }

      return { processingStatus: 'processing' };
    },

    async queryUploadStatus(uploadUrl, totalBytes, { signal } = {}) {
      const res = await withTokenRetry((token) => fetchImpl(uploadUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Range': `bytes */${totalBytes}`,
          'Content-Length': '0',
        },
        signal,
      }));

      if (res.status === 308) {
        const rangeHeader = res.headers.get('range') || res.headers.get('Range');
        let bytesReceived = 0;
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) bytesReceived = parseInt(match[1], 10) + 1;
        }
        return {
          bytesReceived,
          done: false,
          videoId: null,
        };
      }

      if (res.status === 200 || res.status === 201) {
        const data = await res.json();
        return {
          bytesReceived: totalBytes,
          done: true,
          videoId: data.id,
        };
      }

      if (res.status === 401) {
        throw Object.assign(new Error('Query upload status failed: authentication failed after token refresh'), { status: 401 });
      }

      throw new Error(`Query upload status failed with status ${res.status}: ${res.statusText}`);
    },
  };
}

/**
 * YouTube Publisher Adapter
 * Handles controlled resumable upload sessions with fail-closed transport validation.
 *
 * Offline-only contract: the production transport is never constructed here —
 * callers must inject a transport (loopback mock in tests / explicit user
 * command in the app). `cancelUpload` aborts the in-flight HTTP request via
 * AbortController and leaves the record in the terminal `cancelled` state.
 */
export class YouTubePublisherAdapter {
  constructor({
    store = new PublishRecordStore(),
    transport = null,
  } = {}) {
    this.store = store;
    this.transport = transport;
    // publishRecordId -> AbortController for the in-flight upload session
    this._inFlight = new Map();
  }

  /**
   * Cancels an in-flight (or queued) upload: aborts the active HTTP request
   * and transitions the record to `cancelled`. Safe to call when no upload
   * is running (still marks queued records cancelled).
   * Returns true when the record transitioned to cancelled.
   */
  cancelUpload(publishRecordId) {
    const controller = this._inFlight.get(publishRecordId);
    if (controller && !controller.signal.aborted) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    return this.store.cancel(publishRecordId);
  }

  /**
   * Starts or resumes upload session for a publish record.
   * Fails closed if no transport is configured.
   */
  async executeUploadSession(publishRecordId, fileBuffer) {
    const record = this.store.get(publishRecordId);
    if (!record) throw new Error(`Publish record not found: ${publishRecordId}`);

    // Cancelled before start: nothing to do, do not resurrect the record.
    if (record.state === PUBLISH_STATES.CANCELLED) {
      return record;
    }

    // Duplicate protection: if already published or processing with a remoteVideoId, do not re-upload
    if (record.remoteVideoId && [PUBLISH_STATES.PUBLISHED, PUBLISH_STATES.SCHEDULED, PUBLISH_STATES.PROCESSING].includes(record.state)) {
      return record;
    }

    if (!this.transport) {
      this.store.updateState(publishRecordId, PUBLISH_STATES.ERROR, {
        error: 'No publisher transport configured: YouTube publishing requires authenticated transport or explicit offline mock adapter.'
      });
      throw new Error('No publisher transport configured: YouTube publishing requires authenticated transport or explicit offline mock adapter.');
    }

    const totalBytes = fileBuffer.length;
    const controller = new AbortController();
    this._inFlight.set(publishRecordId, controller);
    const signal = controller.signal;
    const isCancelled = () => this.store.get(publishRecordId)?.state === PUBLISH_STATES.CANCELLED
      || signal.aborted;

    this.store.updateState(publishRecordId, PUBLISH_STATES.UPLOADING, { totalBytes });

    try {
      // Step 1: Initiate session if not already initiated
      if (!record.resumableUploadUrl) {
        const session = await this.transport.initiateResumableUpload(record.metadata, { signal });
        if (isCancelled()) return this.store.get(publishRecordId);
        this.store.updateState(publishRecordId, PUBLISH_STATES.UPLOADING, {
          resumableUploadUrl: session.uploadUrl,
        });
      } else if (typeof this.transport.queryUploadStatus === 'function') {
        // Query remote resumable upload status to synchronize bytesReceived accurately after interruption
        try {
          const status = await this.transport.queryUploadStatus(record.resumableUploadUrl, totalBytes, { signal });
          if (isCancelled()) return this.store.get(publishRecordId);
          if (status.done && status.videoId) {
            const finalState = record.metadata?.scheduledPublishTime
              ? PUBLISH_STATES.SCHEDULED
              : PUBLISH_STATES.PROCESSING;
            return this.store.updateState(publishRecordId, finalState, {
              remoteVideoId: status.videoId,
              bytesUploaded: totalBytes,
            });
          }
          if (status.bytesReceived > (record.bytesUploaded || 0)) {
            this.store.updateState(publishRecordId, PUBLISH_STATES.UPLOADING, {
              bytesUploaded: status.bytesReceived,
            });
          }
        } catch (err) {
          if (isCancelled() || err?.name === 'AbortError') return this.store.get(publishRecordId);
          // If queryUploadStatus fails, proceed with stored bytesUploaded
        }
      }


      // Step 2: Upload chunk by chunk
      let currentUploaded = record.bytesUploaded || 0;
      let chunkDone = false;
      let finalVideoId = null;
      const chunkSize = this.transport.chunkSize || (256 * 1024);

      while (currentUploaded < totalBytes && !chunkDone) {
        if (isCancelled()) return this.store.get(publishRecordId);
        const nextSliceEnd = Math.min(totalBytes, currentUploaded + chunkSize);
        const chunk = fileBuffer.subarray(currentUploaded, nextSliceEnd);
        const chunkResult = await this.transport.uploadChunk(
          record.resumableUploadUrl,
          chunk,
          currentUploaded,
          totalBytes,
          { signal },
        );

        // A cancel that raced this chunk must win: never resurrect a
        // cancelled record back to UPLOADING.
        if (isCancelled()) return this.store.get(publishRecordId);

        currentUploaded = chunkResult.bytesReceived;
        this.store.updateState(publishRecordId, PUBLISH_STATES.UPLOADING, {
          bytesUploaded: currentUploaded,
        });

        if (chunkResult.done && chunkResult.videoId) {
          chunkDone = true;
          finalVideoId = chunkResult.videoId;
        }
      }

      if (isCancelled()) return this.store.get(publishRecordId);

      if (chunkDone && finalVideoId) {
        const finalState = record.metadata.scheduledPublishTime
          ? PUBLISH_STATES.SCHEDULED
          : PUBLISH_STATES.PROCESSING;

        this.store.updateState(publishRecordId, finalState, {
          remoteVideoId: finalVideoId,
        });
      }

      return this.store.get(publishRecordId);
    } catch (err) {
      // Abort due to cancel: record stays in terminal `cancelled` state —
      // do NOT overwrite it with `error` (illegal transition would also fire).
      if (err?.name === 'AbortError' || isCancelled()) {
        if (this.store.get(publishRecordId)?.state !== PUBLISH_STATES.CANCELLED) {
          this.store.cancel(publishRecordId);
        }
        return this.store.get(publishRecordId);
      }
      if (err.status === 403 || err.reason === 'quotaExceeded' || String(err.message).includes('quota')) {
        return this.handleQuotaExhaustion(publishRecordId);
      }
      this.store.updateState(publishRecordId, PUBLISH_STATES.ERROR, { error: err.message });
      throw err;
    } finally {
      this._inFlight.delete(publishRecordId);
    }
  }

  /**
   * Polls remote processing status for uploaded video (transitions PROCESSING -> PUBLISHED or ERROR).
   */
  async pollProcessingStatus(publishRecordId) {
    const record = this.store.get(publishRecordId);
    if (!record) throw new Error(`Publish record not found: ${publishRecordId}`);
    if (!record.remoteVideoId) {
      throw new Error(`Record ${publishRecordId} has no remoteVideoId to poll`);
    }

    if (this.transport && typeof this.transport.checkProcessingStatus === 'function') {
      const statusRes = await this.transport.checkProcessingStatus(record.remoteVideoId);
      if (statusRes.processingStatus === 'succeeded') {
        const nextState = record.metadata.scheduledPublishTime
          ? PUBLISH_STATES.SCHEDULED
          : PUBLISH_STATES.PUBLISHED;
        return this.store.updateState(publishRecordId, nextState);
      } else if (statusRes.processingStatus === 'failed') {
        return this.store.updateState(publishRecordId, PUBLISH_STATES.ERROR, {
          error: statusRes.errorReason || 'Video processing failed on remote platform',
        });
      }
    }
    return record;
  }

  /**
   * Handles 403 quota exhaustion, pausing publication safely until quota resets.
   */
  handleQuotaExhaustion(publishRecordId, { quotaResetTime = null } = {}) {
    return this.store.updateState(publishRecordId, PUBLISH_STATES.QUEUED, {
      error: `YouTube API quota exceeded. Paused until quota reset (${quotaResetTime || 'midnight PT'}).`,
    });
  }
}
