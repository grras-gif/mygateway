/**
 * EdgeOne Makers deployment configuration guard.
 *
 * Runs in `test:fast` and fails the build when the repository drifts back to a
 * Cloudflare deployment chain or exposes a server secret to the client bundle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

// --- Environment variable example ------------------------------------------
const envExamplePath = join(root, '.env.example');
if (!existsSync(envExamplePath)) {
  failures.push('.env.example must document the initial administrator password');
} else {
  const envExample = readFileSync(envExamplePath, 'utf8');
  const secretNames = [...envExample.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((match) => match[1]);
  if (secretNames.length !== 1 || secretNames[0] !== 'INITIAL_ADMIN_PASSWORD') {
    failures.push('.env.example may expose only INITIAL_ADMIN_PASSWORD');
  }
  if (!/^\s*INITIAL_ADMIN_PASSWORD=mygateway123\s*$/m.test(envExample)) {
    failures.push('.env.example must document the mygateway123 default');
  }
  if (/^\s*MASTER_KEY\s*=/m.test(envExample)) {
    failures.push('MASTER_KEY must remain internal and absent from .env.example');
  }
}

// --- Cloudflare chain must stay removed ------------------------------------
for (const legacyPath of ['wrangler.jsonc', 'wrangler.toml', '.dev.vars.example']) {
  if (existsSync(join(root, legacyPath))) {
    failures.push(`${legacyPath} must not exist after the EdgeOne Makers migration`);
  }
}

// --- edgeone.json ----------------------------------------------------------
const edgeonePath = join(root, 'edgeone.json');
if (!existsSync(edgeonePath)) {
  failures.push('edgeone.json must configure the EdgeOne Makers build');
} else {
  let edgeoneConfig;
  try {
    edgeoneConfig = JSON.parse(readFileSync(edgeonePath, 'utf8'));
  } catch (error) {
    failures.push(`edgeone.json is not valid JSON: ${error.message}`);
  }
  if (edgeoneConfig) {
    if (edgeoneConfig.installCommand !== 'npm install') {
      failures.push('edgeone.json installCommand must be "npm install"');
    }
    if (edgeoneConfig.buildCommand !== 'npm run build:dashboard') {
      failures.push('edgeone.json buildCommand must be "npm run build:dashboard"');
    }
    if (edgeoneConfig.outputDirectory !== 'dashboard/dist') {
      failures.push('edgeone.json outputDirectory must be "dashboard/dist"');
    }
    if (/\b(MASTER_KEY|INITIAL_ADMIN_PASSWORD|SECRET|TOKEN)\b/.test(JSON.stringify(edgeoneConfig))) {
      failures.push('edgeone.json must not contain secret values');
    }
  }
}

// --- Edge function entry ---------------------------------------------------
const edgeEntryPath = join(root, 'functions', '[[default]].ts');
if (!existsSync(edgeEntryPath)) {
  failures.push('functions/[[default]].ts must provide the edge function entry');
} else {
  const edgeEntry = readFileSync(edgeEntryPath, 'utf8');
  if (!/export\s+async\s+function\s+onRequest\s*\(/.test(edgeEntry)) {
    failures.push('functions/[[default]].ts must export an async onRequest handler');
  }
  if (!/context\.next\s*\(/.test(edgeEntry)) {
    failures.push('functions/[[default]].ts must fall through to static assets via context.next()');
  }
}

// --- package.json ----------------------------------------------------------
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageJson.cloudflare) {
  failures.push('package.json must not keep a Cloudflare Deploy Button block');
}
const scriptText = Object.values(packageJson.scripts ?? {}).join(' ');
if (/\bwrangler\b/.test(scriptText)) {
  failures.push('package.json scripts must not invoke wrangler');
}
if (/\bdb:migrate\b/.test(scriptText)) {
  failures.push('package.json scripts must not keep the D1 migration chain');
}
const deployScript = packageJson.scripts?.deploy ?? '';
if (deployScript !== 'npm run build:dashboard') {
  failures.push('deploy script must build the dashboard bundle for EdgeOne Makers');
}
for (const dependency of ['dependencies', 'devDependencies']) {
  const names = Object.keys(packageJson[dependency] ?? {});
  const cloudflarePackage = names.find((name) => name.startsWith('@cloudflare/') || name === 'wrangler');
  if (cloudflarePackage) {
    failures.push(`package.json ${dependency} must not depend on ${cloudflarePackage}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log('EdgeOne Makers deploy configuration check passed (only the initial password is user-configurable).');
