// Managed model packages (Kokoro TTS / Whisper ASR) for Vidmyo V2.6.
//
// Contract:
//   - A package manifest declares name, version, sha256, licence and source
//     URL. An entry that has NOT had its URL/checksum/licence verified is
//     marked `manifest-pending` and is refused at install time — checksums
//     and versions are never invented.
//   - Downloads are resumable: partial data lands in `<file>.part`, an
//     interrupted transfer continues with `Range: bytes=N-`, the finished
//     stream is SHA-256 verified, and only then atomically renamed into
//     place. A checksum mismatch deletes the poisoned part-file.
//   - verify() re-hashes the installed file against the install receipt;
//     uninstall() removes the package directory.
//
// No network access happens at import time. Tests drive everything through
// a loopback HTTP fixture server with small files.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MANIFEST_PENDING = 'manifest-pending';

// Catalog of model packages Vidmyo expects to manage. Entries stay
// `manifest-pending` until someone actually verifies the upstream URL,
// version, licence and SHA-256 against the source — nothing here is guessed.
export const BUILTIN_MODEL_CATALOG = [
  {
    name: 'kokoro-tts',
    version: null,
    sha256: null,
    license: null,
    sourceUrl: null,
    fileName: null,
    status: MANIFEST_PENDING,
    notes: 'Kokoro TTS model package. Upstream URL, exact version, licence text and SHA-256 must be verified against the source before install is allowed; nothing is pre-seeded to avoid inventing checksums.',
  },
  {
    name: 'whisper-asr',
    version: null,
    sha256: null,
    license: null,
    sourceUrl: null,
    fileName: null,
    status: MANIFEST_PENDING,
    notes: 'Whisper ASR model package. Upstream URL, exact version, licence text and SHA-256 must be verified against the source before install is allowed; nothing is pre-seeded to avoid inventing checksums.',
  },
];

/**
 * Validates a package manifest.
 * Returns { ok, pending, reasons } — reasons are exact, UI-presentable strings.
 * A `manifest-pending` entry is structurally OK as a placeholder but is never
 * installable (install() refuses it separately).
 */
export function validatePackageManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, pending: false, reasons: ['manifest must be a plain object'] };
  }
  const reasons = [];
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : '';
  if (!name) {
    reasons.push('name is required');
  } else if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    reasons.push(`name '${manifest.name}' must match [a-z0-9][a-z0-9._-]*`);
  }

  const pending = manifest.status === MANIFEST_PENDING;
  if (pending) {
    return reasons.length === 0
      ? { ok: true, pending: true, reasons: [] }
      : { ok: false, pending: true, reasons };
  }

  if (manifest.status !== undefined && manifest.status !== null && manifest.status !== 'ready') {
    reasons.push(`status must be 'ready' or '${MANIFEST_PENDING}' (got '${String(manifest.status)}')`);
  }
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!version) reasons.push('version is required (or mark the entry manifest-pending)');
  const sha = typeof manifest.sha256 === 'string' ? manifest.sha256.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    reasons.push('sha256 must be a 64-char hex digest (or mark the entry manifest-pending)');
  }
  const license = typeof manifest.license === 'string' ? manifest.license.trim() : '';
  if (!license) reasons.push('license is required (or mark the entry manifest-pending)');
  const sourceUrl = typeof manifest.sourceUrl === 'string' ? manifest.sourceUrl.trim() : '';
  if (!/^https?:\/\/\S+$/i.test(sourceUrl)) {
    reasons.push('sourceUrl must be an http(s) URL (or mark the entry manifest-pending)');
  }
  return { ok: reasons.length === 0, pending: false, reasons };
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export class ModelPackageManager {
  constructor({
    packagesDir,
    fetchImpl = globalThis.fetch,
    catalog = BUILTIN_MODEL_CATALOG,
  } = {}) {
    if (!packagesDir) throw new Error('packagesDir is required');
    this.packagesDir = packagesDir;
    this.fetchImpl = fetchImpl;
    this.catalog = Array.isArray(catalog) ? catalog : BUILTIN_MODEL_CATALOG;
    fs.mkdirSync(this.packagesDir, { recursive: true });
  }

  getManifest(name) {
    return this.catalog.find((m) => m && m.name === name) || null;
  }

  packageDir(name) {
    return path.join(this.packagesDir, name);
  }

  receiptPath(name) {
    return path.join(this.packageDir(name), 'receipt.json');
  }

  #readReceipt(name) {
    try {
      return JSON.parse(fs.readFileSync(this.receiptPath(name), 'utf8'));
    } catch {
      return null;
    }
  }

  #writeReceipt(manifest, fileName) {
    const receipt = {
      name: manifest.name,
      version: manifest.version,
      sha256: String(manifest.sha256).toLowerCase(),
      license: manifest.license,
      sourceUrl: manifest.sourceUrl,
      fileName,
      installedAt: new Date().toISOString(),
    };
    const target = this.receiptPath(manifest.name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
    fs.renameSync(tmp, target);
    return receipt;
  }

  /**
   * Resumable download to `partPath`.
   * - Existing `.part` bytes continue with `Range: bytes=N-` (206 append).
   * - A fresh or range-ignoring server (200) restarts the file cleanly.
   * - 416 with an existing part-file means the range is unsatisfiable —
   *   the part-file is bogus and is discarded exactly once before retry.
   * - Network errors mid-body leave the `.part` in place for the next call.
   * Returns { resumedFromBytes, bytesWritten }.
   */
  async #downloadResumable(url, partPath, { signal, isRetry = false } = {}) {
    let startByte = 0;
    if (fs.existsSync(partPath)) startByte = fs.statSync(partPath).size;
    const headers = {};
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;

    const res = await this.fetchImpl(url, { headers, signal });
    if (res.status === 416) {
      if (isRetry) throw new Error(`Download failed: HTTP 416 repeatedly for ${url}`);
      try { fs.unlinkSync(partPath); } catch { /* already gone */ }
      return this.#downloadResumable(url, partPath, { signal, isRetry: true });
    }
    if (res.status !== 200 && res.status !== 206) {
      throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
    }

    const append = res.status === 206 && startByte > 0;
    const resumedFromBytes = append ? startByte : 0;
    const fd = fs.openSync(partPath, append ? 'a' : 'w');
    try {
      if (!res.body) throw new Error(`Download failed: empty response body for ${url}`);
      for await (const chunk of res.body) {
        fs.writeSync(fd, chunk);
      }
    } finally {
      fs.closeSync(fd);
    }
    return { resumedFromBytes, bytesWritten: fs.statSync(partPath).size };
  }

  /**
   * Installs a package from its manifest (object, or name looked up in the
   * catalog). Idempotent: an already-installed, checksum-verified package is
   * returned without touching the network.
   * Throws on: manifest-pending, invalid manifest, HTTP failure,
   * checksum mismatch (poisoned part-file is deleted).
   */
  async install(manifestOrName, { signal } = {}) {
    const manifest = typeof manifestOrName === 'string' ? this.getManifest(manifestOrName) : manifestOrName;
    if (!manifest) {
      throw new Error(`Unknown model package: ${typeof manifestOrName === 'string' ? manifestOrName : '(invalid manifest)'}`);
    }
    if (manifest.status === MANIFEST_PENDING) {
      throw new Error(
        `Package '${manifest.name}' is manifest-pending: version, sha256, licence and source URL are not verified yet — refusing to install (nothing is downloaded).`,
      );
    }
    const check = validatePackageManifest(manifest);
    if (!check.ok) {
      throw new Error(`Invalid package manifest for '${manifest.name}': ${check.reasons.join('; ')}`);
    }

    const fileName = manifest.fileName
      || (() => { try { return path.basename(new URL(manifest.sourceUrl).pathname); } catch { return null; } })();
    if (!fileName || fileName === '/' || fileName === '.') {
      throw new Error(`Invalid package manifest for '${manifest.name}': cannot derive fileName from sourceUrl (set fileName explicitly)`);
    }

    const dir = this.packageDir(manifest.name);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, fileName);
    const partPath = `${finalPath}.part`;
    const expected = String(manifest.sha256).toLowerCase();

    // Idempotent fast path: already installed and verified.
    if (fs.existsSync(finalPath)) {
      const actual = sha256File(finalPath);
      if (actual === expected) {
        const receipt = this.#writeReceipt(manifest, fileName);
        return {
          name: manifest.name,
          path: finalPath,
          sha256: actual,
          bytes: fs.statSync(finalPath).size,
          alreadyInstalled: true,
          resumedFromBytes: 0,
          receipt,
        };
      }
      // Corrupted leftover — remove and re-download from scratch.
      fs.unlinkSync(finalPath);
    }

    const { resumedFromBytes } = await this.#downloadResumable(manifest.sourceUrl, partPath, { signal });

    const actual = sha256File(partPath);
    if (actual !== expected) {
      try { fs.unlinkSync(partPath); } catch { /* ignore */ }
      throw new Error(`Checksum mismatch for '${manifest.name}': expected ${expected}, got ${actual}`);
    }

    fs.renameSync(partPath, finalPath);
    const receipt = this.#writeReceipt(manifest, fileName);
    return {
      name: manifest.name,
      path: finalPath,
      sha256: actual,
      bytes: fs.statSync(finalPath).size,
      alreadyInstalled: false,
      resumedFromBytes,
      receipt,
    };
  }

  /**
   * Re-hashes the installed file against the install receipt.
   * Returns { ok, reason? , expectedSha256?, actualSha256?, path? }.
   */
  verify(name) {
    const receipt = this.#readReceipt(name);
    if (!receipt) return { ok: false, reason: 'not installed (no receipt)' };
    const filePath = path.join(this.packageDir(name), receipt.fileName);
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'installed file missing' };
    const actual = sha256File(filePath);
    const expected = String(receipt.sha256 || '').toLowerCase();
    if (actual !== expected) {
      return { ok: false, reason: 'checksum mismatch', expectedSha256: expected, actualSha256: actual, path: filePath };
    }
    return { ok: true, expectedSha256: expected, actualSha256: actual, path: filePath };
  }

  /**
   * Removes the package directory (installed file + receipt).
   * Returns { removed: boolean }.
   */
  uninstall(name) {
    const dir = this.packageDir(name);
    if (!fs.existsSync(dir)) return { removed: false };
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: true };
  }

  /**
   * Status snapshot for a package name.
   * `installable` is false for pending or unknown entries.
   */
  status(name) {
    const manifest = this.getManifest(name);
    const receipt = this.#readReceipt(name);
    const pending = manifest?.status === MANIFEST_PENDING;
    // A package installed from an explicit manifest (not the catalog) is
    // still "known": the receipt proves it was validated at install time.
    const known = Boolean(manifest) || Boolean(receipt);
    const filePath = receipt ? path.join(this.packageDir(name), receipt.fileName) : null;
    const installed = Boolean(filePath && fs.existsSync(filePath));
    const verification = receipt ? this.verify(name) : { ok: false, reason: 'not installed (no receipt)' };
    return {
      name,
      known,
      pending: Boolean(pending),
      installable: known && !pending,
      installed,
      verified: verification.ok === true && installed,
      verifyReason: verification.reason || null,
      receipt: receipt
        ? { version: receipt.version, sha256: receipt.sha256, license: receipt.license, installedAt: receipt.installedAt }
        : null,
    };
  }
}
