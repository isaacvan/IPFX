// Infinity v2 release (owner-approved go only). Default is a DRY RUN that changes nothing; pass --apply to release.
//
//   node scripts/release-infinity-v2.mjs            # preflight only: every check, no change
//   node scripts/release-infinity-v2.mjs --apply    # preflight, then migrations, functions, hub, website
//
// What a release does, in order (stops at the first failure):
//   1. Preflight: clean branch rebased on origin/main; live functions/hub equal origin/main (no one else's unmerged deploy would be
//      overwritten); exactly the expected migrations are pending; every source-drift guard passes against the LIVE definitions.
//   2. Migrations, one file at a time (each is its own transaction), each recorded in supabase_migrations.schema_migrations.
//   3. Edge functions: trading-engine, admin-console, email-outbox, ab-classifier (verify_jwt kept as it is live).
//   4. Hub: changed files copied with a rollback folder, service restarted, health checked.
//   5. Website: fast-forward origin/main to this branch (GitHub Pages publishes it).
// Infinity v2 stays OFF after a release (infinity_v2_settings.infinity_v2_enabled=false) and copy policy v5 stays DRAFT.
// Switching them on is a separate owner step: docs/infinity-v2/GO-LIVE.md.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { pathToFileURL, fileURLToPath } from 'node:url';

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'agulweemteoeagscmppy';
const FUNCTIONS = ['trading-engine', 'admin-console', 'email-outbox', 'ab-classifier'];
const HUB_FILES = ['server.mjs', 'risk.mjs', 'candles.mjs', 'risk-journal.mjs', 'fxcm-relay.mjs'];
const HUB = 'ubuntu@130.162.185.68', HUB_KEY = path.join(os.homedir(), '.ssh', 'ipfx_hub');
const MIGRATIONS = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => /^(20261029|20261030)\d+_.*\.sql$/.test(f)).sort();
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ipfx-v2-release-'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fail = (m) => { console.error('\nSTOP: ' + m); process.exit(1); };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, shell: process.platform === 'win32' && cmd === 'npx', ...opts });
const git = (...a) => run('git', a, { cwd: ROOT }).trim();
const norm = (s) => s.replace(/\r\n/g, '\n');

// Supabase CLI from a scratch folder linked to the project (never touches the repo's tracked supabase/.temp files).
const LINK = path.join(WORK, 'link'); fs.mkdirSync(path.join(LINK, 'supabase'), { recursive: true });
fs.writeFileSync(path.join(LINK, 'supabase', 'config.toml'), `project_id = "${REF}"\n`);
run('npx', ['--no-install', 'supabase', 'link', '--project-ref', REF, '-p', '""'], { cwd: LINK });
let qn = 0;   // every statement goes through a file: no shell quoting of SQL
const sql = (q) => { const f = path.join(WORK, `q${++qn}.sql`); fs.writeFileSync(f, q); const t = run('npx', ['--no-install', 'supabase', 'db', 'query', '--linked', '-f', f, '-o', 'json'], { cwd: LINK });
  const j = JSON.parse(t.slice(t.indexOf('{'))); if (j._tag === 'Error') throw new Error(JSON.stringify(j.error)); return j.rows; };
// The CLI runs through a shell on Windows, so the file must sit on a path without spaces (the repo is in "New folder").
const sqlFile = (file) => { const copy = path.join(WORK, path.basename(file)); fs.copyFileSync(file, copy);
  const t = run('npx', ['--no-install', 'supabase', 'db', 'query', '--linked', '-f', copy, '-o', 'json'], { cwd: LINK });
  const j = JSON.parse(t.slice(t.indexOf('{'))); if (j._tag === 'Error') throw new Error(JSON.stringify(j.error)); };

// ---------- 1. preflight ----------
log(APPLY ? 'RELEASE (apply)' : 'DRY RUN (no changes)');
if (git('status', '--porcelain', '--untracked-files=no')) fail('uncommitted changes in the branch');
git('fetch', '-q', 'origin');
try { git('merge-base', '--is-ancestor', 'origin/main', 'HEAD'); } catch { fail('branch is behind origin/main: rebase, re-run the tests, then release'); }
log('branch', git('rev-parse', '--abbrev-ref', 'HEAD'), git('rev-parse', '--short', 'HEAD'), 'contains origin/main', git('rev-parse', '--short', 'origin/main'));

// Live functions must equal origin/main (the other deployer may have shipped something not in main).
const live = JSON.parse(run('npx', ['--no-install', 'supabase', 'functions', 'list', '--project-ref', REF, '-o', 'json'], { cwd: LINK }));
const verifyJwt = {};
for (const fn of FUNCTIONS) {
  const meta = live.find((f) => f.slug === fn); if (!meta) fail(fn + ' is not deployed');
  verifyJwt[fn] = meta.verify_jwt;
  const dir = path.join(WORK, 'live-' + fn); fs.mkdirSync(dir);
  run('npx', ['--no-install', 'supabase', 'functions', 'download', fn, '--project-ref', REF], { cwd: dir });
  const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : files.push(p); } };
  walk(path.join(dir, 'supabase', 'functions'));
  const drift = [];
  for (const p of files) {
    const rel = path.relative(dir, p).split(path.sep).join('/');
    let base = null; try { base = git('show', 'origin/main:' + rel); } catch { /* not in main */ }
    if (base === null || norm(base).trim() !== norm(fs.readFileSync(p, 'utf8')).trim()) drift.push(rel);
  }
  if (drift.length) fail(`${fn} v${meta.version} live differs from origin/main in: ${drift.join(', ')}. Three-way merge the live code into the branch first.`);
  log(`${fn} v${meta.version}: live = origin/main`);
}
for (const f of HUB_FILES) {
  const liveSrc = run('ssh', ['-i', HUB_KEY, '-o', 'ConnectTimeout=10', HUB, `cat /opt/ipfx-hub/${f} 2>/dev/null || true`]);
  let base = ''; try { base = git('show', 'origin/main:hub/' + f); } catch { /* new file */ }
  if (norm(liveSrc).trim() !== norm(base).trim()) fail(`hub ${f} live differs from origin/main`);
}
log('hub: live = origin/main');

// Pending migrations must be exactly this release's files.
const applied = new Set(sql('select version from supabase_migrations.schema_migrations').map((r) => r.version));
const pending = MIGRATIONS.filter((f) => !applied.has(f.slice(0, 14)));
const local = new Set(fs.readdirSync(path.join(ROOT, 'supabase/migrations')).map((f) => f.slice(0, 14)));
// Older files were often applied by hand without a history row, so only files NEWER than the latest recorded version matter.
const latest = [...applied].sort().pop();
const unknownLocal = [...local].filter((v) => /^\d{14}$/.test(v) && v > latest && !applied.has(v) && !MIGRATIONS.some((f) => f.startsWith(v)));
if (unknownLocal.length) fail('unexpected unapplied migrations newer than ' + latest + ' outside this release: ' + unknownLocal.join(', '));
if (MIGRATIONS.some((f) => f.slice(0, 14) <= latest && !applied.has(f.slice(0, 14)))) fail('a release migration is older than the latest recorded migration ' + latest);
if (APPLY && pending.length === 0) log('all release migrations already applied');
log(`migrations pending: ${pending.length} of ${MIGRATIONS.length}`);

// Source-drift rehearsal: every guarded block, run against the live function definitions in a local PGlite database.
if (pending.length) {
  const deps = process.env.DEMO_TEST_DEPS || 'C:/Users/paula/AppData/Local/Temp/ipfx-demo-validation';
  const { PGlite } = await import(pathToFileURL(deps + '/node_modules/@electric-sql/pglite/dist/index.js').href);
  const blocks = [];
  for (const f of pending) for (const m of fs.readFileSync(path.join(ROOT, 'supabase/migrations', f), 'utf8').matchAll(/do \$(\w*)\$[\s\S]*?end \$\1\$\s*;/gi))
    if (/pg_get_functiondef/.test(m[0])) blocks.push([f, m[0]]);
  // every 'public.name(args)' a guarded block reads (some blocks loop over a list of signatures)
  const sigs = [...new Set(blocks.flatMap(([, b]) => [...b.matchAll(/'public\.(\w+\([^')]*\))'/g)].map((x) => x[1])))];
  const defs = sigs.length ? sql(`select pg_get_functiondef(p.oid) def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.oid::regprocedure::text in (${sigs.map((s) => `'${s}'`).join(',')})`) : [];
  if (defs.length !== sigs.length) fail(`live database is missing ${sigs.length - defs.length} function(s) the migrations patch`);
  const db = new PGlite();
  await db.exec(`set check_function_bodies=off; create role anon; create role authenticated; create role service_role;
    create table public.infinity_v2_legacy_definitions(signature text primary key, definition text);`);
  for (const d of defs) await db.exec(d.def);
  for (const [f, b] of blocks) { await db.exec('begin'); try { await db.exec(b); } catch (e) { fail(`${f}: ${e.message}`); } await db.exec('rollback'); }
  await db.close();
  log(`drift rehearsal: ${blocks.length}/${blocks.length} guarded blocks pass against live definitions`);
}
if (!APPLY) { log('DRY RUN complete: every check passed, nothing was changed. Run with --apply on the owner\'s go.'); process.exit(0); }

// ---------- 2. migrations ----------
for (const f of pending) {
  log('migration', f);
  try { sqlFile(path.join(ROOT, 'supabase/migrations', f)); } catch (e) { fail(`${f} failed and was rolled back by its transaction: ${e.message}`); }
  sql(`insert into supabase_migrations.schema_migrations(version,name) values('${f.slice(0, 14)}','${f.slice(15, -4)}') on conflict do nothing`);
}
const flag = sql('select infinity_v2_enabled, integration_ready from public.infinity_v2_settings where singleton')[0];
log('settings after migrations:', JSON.stringify(flag));
if (flag.infinity_v2_enabled) fail('Infinity v2 is ENABLED after migrations: it must stay off until the owner switches it on');

// ---------- 3. functions ----------
for (const fn of FUNCTIONS) {
  const args = ['--no-install', 'supabase', 'functions', 'deploy', fn, '--project-ref', REF, '--use-api'];
  if (!verifyJwt[fn]) args.push('--no-verify-jwt');
  log('deploy', fn); run('npx', args, { cwd: ROOT });
}

// ---------- 4. hub ----------
const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
const changedHub = HUB_FILES.filter((f) => { try { return norm(git('show', 'HEAD:hub/' + f)) !== norm(git('show', 'origin/main:hub/' + f)); } catch { return true; } });
if (changedHub.length) {
  for (const f of changedHub) run('scp', ['-i', HUB_KEY, '-q', path.join(ROOT, 'hub', f), `${HUB}:/tmp/${f}`]);
  run('ssh', ['-i', HUB_KEY, HUB, `set -e; sudo mkdir -p /opt/ipfx-hub/rollback-${stamp}; sudo cp /opt/ipfx-hub/*.mjs /opt/ipfx-hub/rollback-${stamp}/; ` +
    changedHub.map((f) => `sudo cp /tmp/${f} /opt/ipfx-hub/${f}; sudo chown --reference=/opt/ipfx-hub/server.mjs /opt/ipfx-hub/${f};`).join(' ') + ' sudo systemctl restart ipfx-hub; sleep 4; systemctl is-active ipfx-hub']);
  const h = JSON.parse(run('curl', ['-s', '-m', '15', 'https://hub.ipfxcapital.com/health']));
  log(`hub: ${changedHub.join(', ')} deployed (rollback-${stamp}); quotes ${h.quotes}, ingest age ${h.ingestAgeMs} ms`);
}

// ---------- 5. website ----------
git('push', 'origin', 'HEAD:main');
log('website: origin/main fast-forwarded to', git('rev-parse', '--short', 'HEAD'), '(GitHub Pages publishes in about a minute)');
log('RELEASE COMPLETE. Infinity v2 is deployed and OFF. Next: docs/infinity-v2/GO-LIVE.md (switch-on).');
