import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, renameSync, symlinkSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertReleaseWorktree,
  assertTagMatchesPlan,
  getReleaseHistoryState,
  loadReleasePlan,
  sha512,
} from './release.js';

const ADDON_ID = 'garden@linxzh.com';

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'garden release test '));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function releaseFixture(t) {
  const directory = temporaryDirectory(t);
  const sourcePath = path.join(directory, 'source project');
  const repositoryPath = path.join(directory, 'distribution project');
  const releaseDirectory = path.join(sourcePath, '.scaffold', 'release');
  mkdirSync(releaseDirectory, { recursive: true });
  mkdirSync(repositoryPath);
  const xpiPath = path.join(releaseDirectory, 'garden_0.2.13.xpi');
  const xpiContent = Buffer.from('production artifact for release tests\n');
  writeFileSync(xpiPath, xpiContent);
  writeJson(path.join(sourcePath, 'package.json'), { version: '0.2.13' });
  const updateEntry = {
    version: '0.2.13',
    update_link: 'https://example.test/garden_0.2.13.xpi',
    update_hash: `sha512:${createHash('sha512').update(xpiContent).digest('hex')}`,
    applications: {
      zotero: { strict_min_version: '6.999', strict_max_version: '10.*' },
    },
    update_info_url: 'https://example.test/release-notes',
  };
  const sourceManifest = { addons: { [ADDON_ID]: { updates: [updateEntry] } } };
  const manifestPath = path.join(releaseDirectory, 'update.json');
  writeJson(manifestPath, sourceManifest);
  const existingManifest = {
    addons: {
      [ADDON_ID]: { updates: [{ version: '0.2.12' }] },
      'other@example.test': { updates: [{ version: '3.1.0' }] },
    },
  };
  const repositoryManifestPath = path.join(repositoryPath, 'update.json');
  writeJson(repositoryManifestPath, existingManifest);
  return {
    sourcePath, repositoryPath, releaseDirectory, xpiPath, updateEntry,
    sourceManifest, manifestPath, existingManifest, repositoryManifestPath,
    options: { sourcePath, repositoryPath, tag: 'v0.2.13' },
  };
}

test('release planning uses the isolated production artifact and preserves compatibility', (t) => {
  const fixture = releaseFixture(t);
  const before = readFileSync(fixture.repositoryManifestPath);
  const plan = loadReleasePlan(fixture.options);
  assert.equal(plan.tag, 'v0.2.13');
  assert.equal(plan.version, '0.2.13');
  assert.equal(plan.xpiPath, fixture.xpiPath);
  assert.equal(plan.releaseFileName, 'garden_v0.2.13.xpi');
  assert.deepEqual(plan.updateEntry, {
    ...fixture.updateEntry,
    update_link: 'https://github.com/l0o0/Garden-for-Zotero/releases/download/v0.2.13/garden_v0.2.13.xpi',
  });
  assert.deepEqual(plan.updateData.addons[ADDON_ID].updates, [plan.updateEntry]);
  assert.deepEqual(plan.updateData.addons['other@example.test'], fixture.existingManifest.addons['other@example.test']);
  assert.deepEqual(JSON.parse(plan.updateContent), plan.updateData);
  assert.deepEqual(readFileSync(fixture.repositoryManifestPath), before);
});

test('release planning accepts a missing distribution manifest without creating it', (t) => {
  const fixture = releaseFixture(t);
  unlinkSync(fixture.repositoryManifestPath);
  const plan = loadReleasePlan(fixture.options);
  assert.equal(plan.updateData.addons[ADDON_ID].updates[0].version, '0.2.13');
  assert.throws(() => readFileSync(fixture.repositoryManifestPath), { code: 'ENOENT' });
});

test('release planning resolves relative source and repository paths', (t) => {
  const fixture = releaseFixture(t);
  const plan = loadReleasePlan({
    ...fixture.options,
    sourcePath: path.relative(process.cwd(), fixture.sourcePath),
    repositoryPath: path.relative(process.cwd(), fixture.repositoryPath),
  });
  assert.equal(plan.xpiPath, fixture.xpiPath);
  assert.ok(path.isAbsolute(plan.xpiPath));
});

test('release planning rejects a tag that does not match package version', (t) => {
  const fixture = releaseFixture(t);
  const before = readFileSync(fixture.repositoryManifestPath);
  assert.throws(() => loadReleasePlan({ ...fixture.options, tag: 'v0.2.12' }));
  assert.deepEqual(readFileSync(fixture.repositoryManifestPath), before);
});

test('release planning rejects a missing production XPI even when a legacy build exists', (t) => {
  const fixture = releaseFixture(t);
  const legacyDirectory = path.join(fixture.repositoryPath, 'build');
  mkdirSync(legacyDirectory);
  writeFileSync(path.join(legacyDirectory, 'garden_0.2.13.xpi'), readFileSync(fixture.xpiPath));
  unlinkSync(fixture.xpiPath);
  const before = readFileSync(fixture.repositoryManifestPath);
  assert.throws(() => loadReleasePlan(fixture.options));
  assert.deepEqual(readFileSync(fixture.repositoryManifestPath), before);
});

test('release planning rejects a missing production update manifest', (t) => {
  const fixture = releaseFixture(t);
  unlinkSync(fixture.manifestPath);
  assert.throws(() => loadReleasePlan(fixture.options));
});

test('release planning rejects a production manifest for another version', (t) => {
  const fixture = releaseFixture(t);
  fixture.sourceManifest.addons[ADDON_ID].updates[0].version = '0.2.12';
  writeJson(fixture.manifestPath, fixture.sourceManifest);
  assert.throws(() => loadReleasePlan(fixture.options));
});

test('release planning rejects a production manifest for another add-on', (t) => {
  const fixture = releaseFixture(t);
  writeJson(fixture.manifestPath, { addons: { 'wrong@example.test': { updates: [fixture.updateEntry] } } });
  assert.throws(() => loadReleasePlan(fixture.options));
});

test('release planning rejects modified XPI bytes without writing the distribution manifest', (t) => {
  const fixture = releaseFixture(t);
  writeFileSync(fixture.xpiPath, 'different artifact bytes');
  const before = readFileSync(fixture.repositoryManifestPath);
  assert.throws(() => loadReleasePlan(fixture.options));
  assert.deepEqual(readFileSync(fixture.repositoryManifestPath), before);
});

test('sha512 hashes the file content', (t) => {
  const directory = temporaryDirectory(t);
  const file = path.join(directory, 'hash input');
  writeFileSync(file, 'abc');
  assert.equal(sha512(file), 'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
});

function git(repositoryPath, ...args) {
  return execFileSync('git', args, { cwd: repositoryPath, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function commit(repositoryPath, message) {
  git(repositoryPath, 'add', '--all');
  git(repositoryPath, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message);
  return git(repositoryPath, 'rev-parse', 'HEAD');
}

function gitFixture(t) {
  const repositoryPath = temporaryDirectory(t);
  git(repositoryPath, 'init', '-b', 'main');
  git(repositoryPath, 'config', 'user.name', 'Release Test');
  git(repositoryPath, 'config', 'user.email', 'release-test@example.test');
  writeJson(path.join(repositoryPath, 'update.json'), { addons: {} });
  writeFileSync(path.join(repositoryPath, 'README.md'), 'Release fixture\n');
  const base = commit(repositoryPath, 'Initial release');
  git(repositoryPath, 'update-ref', 'refs/remotes/origin/main', base);
  return { repositoryPath, base };
}

test('worktree preflight accepts main with unrelated unstaged changes and untracked files', (t) => {
  const { repositoryPath } = gitFixture(t);
  writeFileSync(path.join(repositoryPath, 'README.md'), 'Uncommitted documentation\n');
  writeFileSync(path.join(repositoryPath, 'notes.txt'), 'Untracked personal notes\n');
  assert.doesNotThrow(() => assertReleaseWorktree(repositoryPath));
});

test('worktree preflight rejects a different branch', (t) => {
  const { repositoryPath } = gitFixture(t);
  git(repositoryPath, 'checkout', '-b', 'feature');
  assert.throws(() => assertReleaseWorktree(repositoryPath));
});

test('worktree preflight rejects staged changes to avoid accidentally committing them', (t) => {
  const { repositoryPath } = gitFixture(t);
  writeFileSync(path.join(repositoryPath, 'README.md'), 'Staged documentation\n');
  git(repositoryPath, 'add', 'README.md');
  assert.throws(() => assertReleaseWorktree(repositoryPath));
});

test('worktree preflight rejects a locally modified update manifest', (t) => {
  const { repositoryPath } = gitFixture(t);
  writeJson(path.join(repositoryPath, 'update.json'), { addons: {}, local: true });
  assert.throws(() => assertReleaseWorktree(repositoryPath));
});

test('history preflight distinguishes current, ahead, behind, and diverged branches', (t) => {
  const { repositoryPath, base } = gitFixture(t);
  assert.equal(getReleaseHistoryState(repositoryPath), 'current');

  writeFileSync(path.join(repositoryPath, 'local.txt'), 'Local release\n');
  const localCommit = commit(repositoryPath, 'Local release');
  assert.equal(getReleaseHistoryState(repositoryPath), 'ahead');

  git(repositoryPath, 'update-ref', 'refs/remotes/origin/main', localCommit);
  git(repositoryPath, 'reset', '--hard', base);
  assert.equal(getReleaseHistoryState(repositoryPath), 'behind');

  writeFileSync(path.join(repositoryPath, 'remote.txt'), 'Independent release\n');
  commit(repositoryPath, 'Independent release');
  assert.equal(getReleaseHistoryState(repositoryPath), 'diverged');
});

// Add these names to the existing imports:
// node:child_process: spawnSync
// node:fs: copyFileSync, renameSync, symlinkSync
// Add: import { fileURLToPath } from 'node:url';

test('full dry-run CLI is read-only, offline, token-independent, and independent of cwd', (t) => {
  const fixture = releaseFixture(t);
  const root = path.dirname(fixture.sourcePath);
  const sourcePath = path.join(root, 'garden');
  const repositoryPath = path.join(root, 'garden_for_zotero');
  renameSync(fixture.sourcePath, sourcePath);
  renameSync(fixture.repositoryPath, repositoryPath);

  mkdirSync(path.join(repositoryPath, 'scripts'));
  copyFileSync(fileURLToPath(new URL('./release.js', import.meta.url)), path.join(repositoryPath, 'scripts', 'release.js'));
  writeJson(path.join(repositoryPath, 'package.json'), { type: 'module' });
  writeFileSync(path.join(repositoryPath, '.gitignore'), 'node_modules\n');
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(repositoryPath, 'node_modules'), 'dir');

  for (const directory of [sourcePath, repositoryPath]) {
    git(directory, 'init', '-b', 'main');
    git(directory, 'config', 'user.name', 'Release Test');
    git(directory, 'config', 'user.email', 'release-test@example.test');
    const head = commit(directory, 'Initial release fixture');
    git(directory, 'update-ref', 'refs/remotes/origin/main', head);
  }
  git(sourcePath, 'tag', 'v0.2.13');

  const preload = path.join(root, 'no-network.mjs');
  writeFileSync(preload, "globalThis.fetch = () => { throw new Error('Unexpected network request during dry-run'); };\n");
  const manifestPath = path.join(repositoryPath, 'update.json');
  const beforeManifest = readFileSync(manifestPath);
  const beforeHead = git(repositoryPath, 'rev-parse', 'HEAD');
  const beforeTags = git(repositoryPath, 'tag', '--list');
  const beforeStatus = git(repositoryPath, 'status', '--porcelain');
  const result = spawnSync(process.execPath, [
    '--import', preload, path.join(repositoryPath, 'scripts', 'release.js'), '--dry-run',
  ], {
    cwd: root,
    env: { ...process.env, GITHUB_TOKEN: 'invalid-token-for-offline-test', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /0\.2\.13/);
  assert.match(result.stdout, /garden_v0\.2\.13\.xpi/);
  assert.match(result.stdout, /10\.\*/);
  assert.deepEqual(readFileSync(manifestPath), beforeManifest);
  assert.equal(git(repositoryPath, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(repositoryPath, 'tag', '--list'), beforeTags);
  assert.equal(git(repositoryPath, 'status', '--porcelain'), beforeStatus);
});


test('an existing release tag may precede a later script or documentation commit', (t) => {
  const { repositoryPath } = gitFixture(t);
  git(repositoryPath, 'tag', 'v0.2.13');
  writeFileSync(path.join(repositoryPath, 'README.md'), 'Fix release documentation\n');
  commit(repositoryPath, 'Fix release documentation');
  assert.doesNotThrow(() => assertTagMatchesPlan(repositoryPath, 'v0.2.13', { addons: {} }));
});

test('existing tags reject different manifest content or unrelated history', (t) => {
  const { repositoryPath } = gitFixture(t);
  git(repositoryPath, 'tag', 'v0.2.13');
  assert.throws(() => assertTagMatchesPlan(repositoryPath, 'v0.2.13', { addons: { changed: {} } }));

  git(repositoryPath, 'checkout', '-b', 'unmerged-release');
  writeFileSync(path.join(repositoryPath, 'README.md'), 'Unmerged release change\n');
  commit(repositoryPath, 'Unmerged release');
  git(repositoryPath, 'tag', 'v0.2.14');
  git(repositoryPath, 'checkout', 'main');
  assert.throws(() => assertTagMatchesPlan(repositoryPath, 'v0.2.14', { addons: {} }));
});
