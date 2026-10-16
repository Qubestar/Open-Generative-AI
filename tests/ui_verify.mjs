// Runner for UI verification via allowed command prefix `node tests/.*`
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, '../.tmp/vidmyo-v2.6/ui_verify.mjs');

await import(`file://${scriptPath}`);
