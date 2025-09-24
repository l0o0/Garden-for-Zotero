#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import dotenv from 'dotenv';

// 加载环境变量
dotenv.config();

const GARDEN_PATH = '../garden';

/**
 * 执行命令
 */
function exec(command, cwd = process.cwd()) {
  try {
    return execSync(command, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (error) {
    console.error(`❌ 命令失败: ${command}`);
    throw error;
  }
}

/**
 * 获取最新tag
 */
function getLatestTag() {
  const tag = exec('git describe --tags --abbrev=0', GARDEN_PATH);
  console.log(`🏷️  最新tag: ${tag}`);
  return tag;
}

/**
 * 获取tag信息
 */
function getTagInfo(tag) {
  const commitMessage = exec(`git log -1 --format="%s" ${tag}`, GARDEN_PATH);
  let changelog;
  try {
    const prevTag = execSync(`git describe --tags --abbrev=0 ${tag}^ 2>/dev/null`, {
      cwd: GARDEN_PATH,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
    changelog = exec(`git log ${prevTag}..${tag} --oneline`, GARDEN_PATH);
  } catch (error) {
    changelog = exec(`git log ${tag} --oneline -5`, GARDEN_PATH);
  }

  return { tag, commitMessage, changelog };
}

/**
 * 计算SHA512
 */
function calculateHash(filePath) {
  const fileBuffer = readFileSync(filePath);
  return createHash('sha512').update(fileBuffer).digest('hex');
}

/**
 * 更新update.json
 */
function updateManifest(tag, xpiPath) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  const hash = calculateHash(xpiPath);
  const releaseFileName = `garden_${tag}.xpi`;

  let updateData = { addons: {} };
  if (existsSync('./update.json')) {
    updateData = JSON.parse(readFileSync('./update.json', 'utf8'));
  }

  if (!updateData.addons['garden@linxzh.com']) {
    updateData.addons['garden@linxzh.com'] = { updates: [] };
  }

  const updateEntry = {
    version,
    update_link: `https://github.com/l0o0/Garden-for-Zotero/releases/download/${tag}/${releaseFileName}`,
    update_hash: `sha512:${hash}`,
    applications: {
      zotero: {
        strict_min_version: "6.999",
        strict_max_version: "8.*"
      }
    }
  };

  updateData.addons['garden@linxzh.com'].updates = [updateEntry];
  writeFileSync('./update.json', JSON.stringify(updateData, null, 2) + '\n');
  console.log(`✅ 更新update.json: ${version}`);

  return { releaseFileName, updateEntry };
}

/**
 * 使用GitHub API创建release
 */
async function createGitHubRelease(tag, tagInfo, xpiPath, releaseFileName, token) {
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  const fs = await import('fs');

  // 1. 提交变更并推送tag
  console.log('📤 提交变更...');
  const commitMsg = `Release ${tag}\n\n${tagInfo.commitMessage}\n\nChanges:\n${tagInfo.changelog}`;
  exec('git add update.json');

  // 检查是否有变更需要提交
  try {
    const status = exec('git diff --staged --quiet');
  } catch (error) {
    // 有变更需要提交
    fs.writeFileSync('.commit-msg-temp', commitMsg);
    exec('git commit -F .commit-msg-temp');
    exec('rm .commit-msg-temp');
    console.log('✅ 提交update.json变更');
  }

  // 检查tag是否已存在，如果存在则删除
  try {
    exec(`git tag -d ${tag}`);
    console.log(`⚠️  删除已存在的本地tag: ${tag}`);
  } catch (error) {
    // 忽略错误，tag可能不存在
  }

  exec(`git tag ${tag}`);
  exec(`git push origin main`);

  // 强制推送tag（覆盖远程已存在的tag）
  exec(`git push origin ${tag} --force`);

  // 2. 创建release（先检查并删除已存在的release）
  console.log('🎉 创建GitHub Release...');

  // 检查是否已存在该release，如果存在则删除
  try {
    const existingResponse = await fetch(`https://api.github.com/repos/l0o0/Garden-for-Zotero/releases/tags/${tag}`, {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (existingResponse.ok) {
      const existingRelease = await existingResponse.json();
      console.log(`⚠️  删除已存在的release: ${tag}`);

      await fetch(`https://api.github.com/repos/l0o0/Garden-for-Zotero/releases/${existingRelease.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json'
        }
      });
    }
  } catch (error) {
    // 忽略错误，release可能不存在
  }

  const releaseData = {
    tag_name: tag,
    target_commitish: 'main',
    name: `Garden ${tag}`,
    body: `## Garden ${tag}

### 📝 更新内容
${tagInfo.commitMessage}

### 🔄 变更记录
\`\`\`
${tagInfo.changelog}
\`\`\`

### 📥 安装方法
1. 下载 \`${releaseFileName}\` 文件
2. 打开 Zotero，进入 Tools → Add-ons
3. 点击右上角齿轮图标，选择 "Install Add-on From File..."
4. 选择下载的 xpi 文件安装`,
    draft: false,
    prerelease: false
  };

  const createResponse = await fetch('https://api.github.com/repos/l0o0/Garden-for-Zotero/releases', {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(releaseData)
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`创建release失败: ${createResponse.status} ${error}`);
  }

  const release = await createResponse.json();
  console.log(`✅ Release创建成功: ${release.html_url}`);

  // 3. 上传assets
  const uploadUrl = release.upload_url.replace('{?name,label}', '');

  // 上传xpi文件
  console.log('📦 上传xpi文件...');
  const xpiContent = fs.readFileSync(xpiPath);
  const xpiResponse = await fetch(`${uploadUrl}?name=${releaseFileName}`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/octet-stream'
    },
    body: xpiContent
  });

  if (!xpiResponse.ok) {
    const error = await xpiResponse.text();
    throw new Error(`上传xpi失败: ${xpiResponse.status} ${error}`);
  }

  // 上传update.json文件
  console.log('📄 上传update.json...');
  const updateContent = fs.readFileSync('./update.json');
  const updateResponse = await fetch(`${uploadUrl}?name=update.json`, {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Content-Type': 'application/json'
    },
    body: updateContent
  });

  if (!updateResponse.ok) {
    const error = await updateResponse.text();
    throw new Error(`上传update.json失败: ${updateResponse.status} ${error}`);
  }

  return release.html_url;
}

/**
 * 主函数
 */
async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  console.log('🚀 开始发布流程...');
  if (isDryRun) console.log('🔍 [预览模式]\n');

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('❌ 未找到 GITHUB_TOKEN');
    console.log('💡 请创建 .env 文件并添加 GitHub token');
    process.exit(1);
  }

  console.log(`✅ GitHub token已配置 (长度: ${token.length})`);

  // 测试token是否有效
  try {
    const testResponse = await fetch('https://api.github.com/user', {
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!testResponse.ok) {
      console.error('❌ GitHub token无效或已过期');
      console.log('💡 请检查.env文件中的GITHUB_TOKEN');
      process.exit(1);
    }
    console.log('✅ GitHub token验证通过');
  } catch (error) {
    console.error('❌ GitHub API连接失败:', error.message);
    process.exit(1);
  }

  try {
    // 1. 获取tag信息
    const tag = getLatestTag();
    const tagInfo = getTagInfo(tag);

    // 2. 检查xpi文件
    const version = tag.startsWith('v') ? tag.slice(1) : tag;
    const xpiPath = `./build/garden_${version}.xpi`;
    if (!existsSync(xpiPath)) {
      console.error(`❌ 未找到: ${xpiPath}`);
      console.log('💡 请先在源仓库构建对应版本的插件');
      process.exit(1);
    }
    console.log(`✅ 找到: ${xpiPath}`);

    // 3. 更新配置
    const { releaseFileName, updateEntry } = updateManifest(tag, xpiPath);

    if (isDryRun) {
      console.log('\n📋 预览信息:');
      console.log(`版本: ${updateEntry.version}`);
      console.log(`发布文件名: ${releaseFileName}`);
      console.log(`本地文件: ${xpiPath}`);
      console.log(`提交信息: ${tagInfo.commitMessage}`);
      console.log('\n变更记录:');
      console.log(tagInfo.changelog);
      return;
    }

    // 4. 创建GitHub Release
    const releaseUrl = await createGitHubRelease(tag, tagInfo, xpiPath, releaseFileName, token);

    console.log('\n✅ 发布完成!');
    console.log(`🔗 ${releaseUrl}`);

  } catch (error) {
    console.error('❌ 发布失败:', error.message);
    process.exit(1);
  }
}

main();