#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import dotenv from 'dotenv';

const REPOSITORY = 'l0o0/Garden-for-Zotero';
const ADDON_ID = 'garden@linxzh.com';
const scriptPath = fileURLToPath(import.meta.url);
const repositoryPath = path.resolve(path.dirname(scriptPath), '..');
const sourcePath = path.resolve(repositoryPath, '../garden');

function git(repository, ...args) {
  try {
    return execFileSync('git', args, {
      cwd: repository, encoding: 'utf8', stdio: 'pipe',
    }).trim();
  } catch (error) {
    throw new Error(`git ${args[0]} 失败：${error.stderr?.toString().trim() || error.message}`);
  }
}

function gitStatus(repository, ...args) {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr?.trim() || `git ${args[0]} 失败`);
  }
  return result.status;
}

export function sha512(filePath) {
  return createHash('sha512').update(readFileSync(filePath)).digest('hex');
}

export function loadReleasePlan({ sourcePath, repositoryPath, tag }) {
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`无效的版本标签：${tag}`);
  }
  const version = tag.replace(/^v/, '');
  const source = path.resolve(sourcePath);
  const repository = path.resolve(repositoryPath);
  const pkg = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (pkg.version !== version) {
    throw new Error(`源仓库版本 ${pkg.version} 与标签 ${tag} 不一致，请先创建正确的版本标签。`);
  }

  const buildPath = path.join(source, '.scaffold/release');
  const xpiPath = path.join(buildPath, `garden_${version}.xpi`);
  const buildManifestPath = path.join(buildPath, 'update.json');
  if (!existsSync(xpiPath) || !existsSync(buildManifestPath)) {
    throw new Error(`缺少生产产物：${xpiPath} 或 update.json。请在 ${source} 执行 pnpm run build:zotero:prod。`);
  }
  const buildManifest = JSON.parse(readFileSync(buildManifestPath, 'utf8'));
  const buildEntry = buildManifest.addons?.[ADDON_ID]?.updates?.find(entry => entry.version === version);
  if (!buildEntry) throw new Error(`生产 update.json 中没有 ${ADDON_ID} 的 ${version} 版本。`);
  if (buildEntry.update_hash !== `sha512:${sha512(xpiPath)}`) {
    throw new Error('XPI 的 SHA512 与生产 update.json 不一致，请重新运行生产构建。');
  }
  if (!buildEntry.applications?.zotero?.strict_min_version || !buildEntry.applications?.zotero?.strict_max_version) {
    throw new Error('生产 update.json 缺少 Zotero 兼容版本范围。');
  }

  const releaseFileName = `garden_${tag}.xpi`;
  const updateEntry = {
    ...buildEntry,
    update_link: `https://github.com/${REPOSITORY}/releases/download/${tag}/${releaseFileName}`,
  };
  const manifestPath = path.join(repository, 'update.json');
  const updateData = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { addons: {} };
  updateData.addons ??= {};
  updateData.addons[ADDON_ID] = { ...updateData.addons[ADDON_ID], updates: [updateEntry] };
  return {
    tag, version, xpiPath, releaseFileName, updateData, updateEntry,
    updateContent: JSON.stringify(updateData, null, 2) + '\n',
  };
}

export function assertReleaseWorktree(repository) {
  if (git(repository, 'branch', '--show-current') !== 'main') {
    throw new Error('请切换到发布仓库的 main 分支后再发布。');
  }
  if (gitStatus(repository, 'diff', '--cached', '--quiet') !== 0) {
    throw new Error('暂存区有未提交的更改，请先处理，避免发布提交混入其他文件。');
  }
  if (git(repository, 'status', '--porcelain', '--', 'update.json')) {
    throw new Error('update.json 有本地未提交更改，请先处理后再发布。');
  }
  for (const marker of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']) {
    if (existsSync(path.resolve(repository, git(repository, 'rev-parse', '--git-path', marker)))) {
      throw new Error('仓库有未完成的 Git 合并或变基，请先完成后再发布。');
    }
  }
}

export function getReleaseHistoryState(repository) {
  const head = git(repository, 'rev-parse', 'HEAD');
  const remote = git(repository, 'rev-parse', 'refs/remotes/origin/main');
  if (head === remote) return 'current';
  if (gitStatus(repository, 'merge-base', '--is-ancestor', remote, head) === 0) return 'ahead';
  if (gitStatus(repository, 'merge-base', '--is-ancestor', head, remote) === 0) return 'behind';
  return 'diverged';
}

function syncReleaseHistory(repository) {
  assertReleaseWorktree(repository);
  git(repository, 'fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main');
  const state = getReleaseHistoryState(repository);
  if (state === 'diverged') {
    throw new Error('main 与 origin/main 已分叉。请先 git merge origin/main 并处理冲突；本次尚未创建发布提交或标签。');
  }
  if (state === 'behind') git(repository, 'merge', '--ff-only', 'origin/main');
}

function getTagInfo(tag) {
  const commitMessage = git(sourcePath, 'log', '-1', '--format=%s', tag);
  let changelog;
  try {
    const previous = git(sourcePath, 'describe', '--tags', '--abbrev=0', `${tag}^`);
    changelog = git(sourcePath, 'log', `${previous}..${tag}`, '--oneline');
  } catch {
    changelog = git(sourcePath, 'log', tag, '--oneline', '-5');
  }
  return { commitMessage, changelog };
}

async function github(token, endpoint, options = {}) {
  return fetch(`https://api.github.com/repos/${REPOSITORY}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
}

async function checkGitHub(token, tag) {
  const repository = await github(token, '');
  if (!repository.ok) {
    throw new Error(`GitHub 仓库访问失败（HTTP ${repository.status}），请检查 GITHUB_TOKEN 的有效期及仓库权限。`);
  }
  if ((await repository.json()).permissions?.push === false) {
    throw new Error('GITHUB_TOKEN 没有发布仓库的写入权限。');
  }
  const existing = await github(token, `/releases/tags/${encodeURIComponent(tag)}`);
  if (existing.ok) throw new Error(`Release ${tag} 已存在，本脚本不会删除或覆盖，请使用新版本号。`);
  if (existing.status !== 404) throw new Error(`检查已有 Release 失败（HTTP ${existing.status}）。`);
}

export function assertTagMatchesPlan(repository, tag, updateData) {
  if (gitStatus(repository, 'merge-base', '--is-ancestor', `${tag}^{commit}`, 'HEAD') !== 0
    || !isDeepStrictEqual(JSON.parse(git(repository, 'show', `${tag}:update.json`)), updateData)) {
    throw new Error(`已有标签 ${tag} 与本次发布内容不一致；请检查先前失败的发布或使用新版本号，不会强制覆盖标签。`);
  }
}

function checkTags(plan) {
  const localRef = git(repositoryPath, 'tag', '--list', plan.tag);
  if (localRef) assertTagMatchesPlan(repositoryPath, plan.tag, plan.updateData);
  const remoteRef = git(repositoryPath, 'ls-remote', '--refs', '--tags', 'origin',
    `refs/tags/${plan.tag}`).split(/\s+/)[0];
  if (remoteRef && (!localRef || remoteRef !== git(repositoryPath, 'rev-parse', `refs/tags/${plan.tag}`))) {
    throw new Error(`远端标签 ${plan.tag} 与本地标签不同，请先检查并同步标签，不会强制覆盖。`);
  }
  return Boolean(localRef);
}

async function createGitHubRelease(plan, tagInfo, token) {
  const releaseData = {
    tag_name: plan.tag,
    target_commitish: git(repositoryPath, 'rev-parse', 'HEAD'),
    name: `Garden ${plan.tag}`,
    body: `## Garden ${plan.tag}\n\n### 📝 更新内容\n${tagInfo.commitMessage}\n\n### 🔄 变更记录\n\`\`\`\n${tagInfo.changelog}\n\`\`\`\n\n### 📥 安装方法\n1. 下载 \`${plan.releaseFileName}\` 文件\n2. 打开 Zotero，进入 Tools → Add-ons\n3. 点击右上角齿轮图标，选择 "Install Add-on From File..."\n4. 选择下载的 xpi 文件安装`,
    draft: false,
    prerelease: plan.version.includes('-'),
  };
  const response = await github(token, '/releases', { method: 'POST', body: JSON.stringify(releaseData) });
  if (!response.ok) throw new Error(`创建 Release 失败（HTTP ${response.status}）。`);
  const release = await response.json();
  const uploadUrl = release.upload_url.replace('{?name,label}', '');
  const assets = [
    [plan.releaseFileName, readFileSync(plan.xpiPath), 'application/octet-stream'],
    ['update.json', plan.updateContent, 'application/json'],
  ];
  for (const [name, content, contentType] of assets) {
    console.log(`📦 上传 ${name}...`);
    const upload = await fetch(`${uploadUrl}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body: content,
    });
    if (!upload.ok) {
      throw new Error(`上传 ${name} 失败（HTTP ${upload.status}）。Release 已创建，请检查 ${release.html_url} 的附件。`);
    }
  }
  return release.html_url;
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log(isDryRun ? '🔍 发布预览（只读，不访问网络）' : '🚀 开始发布流程...');
  const tag = git(sourcePath, 'describe', '--tags', '--abbrev=0');
  let plan = loadReleasePlan({ sourcePath, repositoryPath, tag });
  const tagInfo = getTagInfo(tag);
  assertReleaseWorktree(repositoryPath);

  if (isDryRun) {
    console.log(`版本: ${plan.version}\n发布文件名: ${plan.releaseFileName}\n本地文件: ${plan.xpiPath}`);
    console.log(`Zotero: ${plan.updateEntry.applications.zotero.strict_min_version} — ${plan.updateEntry.applications.zotero.strict_max_version}`);
    console.log(`Git 状态（本地缓存）: ${getReleaseHistoryState(repositoryPath)}`);
    console.log(`提交信息: ${tagInfo.commitMessage}\n\n变更记录:\n${tagInfo.changelog}`);
    console.log('正式发布时会重新获取远端状态、验证 token、检查版本冲突。');
    return;
  }

  dotenv.config({ path: path.join(repositoryPath, '.env') });
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('未找到 GITHUB_TOKEN，请在发布仓库的 .env 中配置。');
  await checkGitHub(token, tag);
  syncReleaseHistory(repositoryPath);
  plan = loadReleasePlan({ sourcePath, repositoryPath, tag });
  const hasLocalTag = checkTags(plan);

  writeFileSync(path.join(repositoryPath, 'update.json'), plan.updateContent);
  if (gitStatus(repositoryPath, 'diff', '--quiet', 'HEAD', '--', 'update.json') !== 0) {
    git(repositoryPath, 'add', '--', 'update.json');
    git(repositoryPath, 'commit', '--only', '-m',
      `Release ${tag}\n\n${tagInfo.commitMessage}\n\nChanges:\n${tagInfo.changelog}`, '--', 'update.json');
  }
  if (!hasLocalTag) git(repositoryPath, 'tag', tag);
  // 同时推送分支和标签；拒绝强推，避免只有一半成功。
  git(repositoryPath, 'push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`);
  const releaseUrl = await createGitHubRelease(plan, tagInfo, token);
  console.log(`\n✅ 发布完成!\n🔗 ${releaseUrl}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(scriptPath)) {
  main().catch(error => {
    console.error(`❌ 发布失败: ${error.message}`);
    process.exitCode = 1;
  });
}
