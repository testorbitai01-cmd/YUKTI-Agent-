import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** yukti-agent/ — works from server/ (tsx) and from dist-server/server/ (compiled). */
export const SERVICE_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
})();

const envFile = path.join(SERVICE_ROOT, '.env');
if (fs.existsSync(envFile) && process.env.NODE_ENV !== 'test') process.loadEnvFile(envFile);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  HOST: z.string().default('0.0.0.0'),
  TESTORBIT_API_URL: z.url().default('http://localhost:4000'),
  APP_ORIGIN: z.url().optional(),
  MCP_BASE_URL: z.url().optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid YUKTI configuration:');
  for (const issue of parsed.error.issues) console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const raw = parsed.data;

export const config = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  testorbitApiUrl: raw.TESTORBIT_API_URL.replace(/\/+$/, ''),
  appOrigin: new URL(raw.APP_ORIGIN ?? `http://localhost:${raw.NODE_ENV === 'production' ? raw.PORT : 5174}`).origin,
  /** Where the agent engine sends MCP JSON-RPC (default: this process). */
  mcpBaseUrl: (raw.MCP_BASE_URL ?? `http://127.0.0.1:${raw.PORT}`).replace(/\/+$/, ''),
  clientDistDir: path.join(SERVICE_ROOT, 'dist'),
  version: '1.0.0',
};
