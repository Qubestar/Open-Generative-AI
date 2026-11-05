import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function lockFile(dir) { return path.join(dir, '.vidmyo', 'code-animation.lock'); }
function liveLock(dir) {
  const file = lockFile(dir);
  if (!fs.existsSync(file)) return null;
  let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Animation lock is unreadable; inspect this project before resuming.'); }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.nonce !== 'string') throw new Error('Animation lock is invalid.');
  try { process.kill(value.pid, 0); return value; }
  catch (error) { if (error.code !== 'ESRCH') return value; }
  // Verify the same dead owner before removing a stale lock.
  if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === value.nonce) fs.unlinkSync(file);
  return null;
}
export function assertAnimationIdle(dir) {
  if (liveLock(dir)) throw new Error('This animation is already open for production in another Vidmyo interface.');
}
export function isAnimationLocked(dir) { return !!liveLock(dir); }
export function acquireAnimationLock(dir) {
  assertAnimationIdle(dir);
  const file = lockFile(dir), nonce = crypto.randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('This animation is already being created.'); throw error; }
  return () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).nonce === nonce) fs.unlinkSync(file); } catch {} };
}
