#!/usr/bin/env node
'use strict';
/**
 * 提交 / 发布前的「干净版本」清理脚本
 * ---------------------------------------------------------
 * 本地开发时数据存在 data/db.json 与 data/uploads/（均已被 .gitignore / .dockerignore 排除，
 * 不会进仓库或镜像）。本脚本仅在「准备提交 GitHub / 打包分享」时手动运行，用于把本地
 * 录入的测试数据清掉，使下次启动自动 seedDB() 重建一个干净的空实例（仅 admin/admin123）。
 *
 * 约定：开发过程中不要运行本脚本，保持测试数据连续可用。
 * 用法：npm run scrub
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// 1) 尽量先停掉正在运行的本地服务（默认 5173），避免其把内存态写回磁盘覆盖本次清理
try {
  const out = execSync('lsof -ti:5173 2>/dev/null || true', { encoding: 'utf8' }).trim();
  if (out) {
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch (_) {}
    }
    console.log('• 已停止本地服务（端口 5173）');
  }
} catch (_) {
  // 无 lsof 权限或命令缺失时忽略，提示用户手动停止
  console.log('• 未能自动停止本地服务，请在运行本脚本前先停止（npm start 的进程）');
}

// 2) 删除运行时数据：下次启动将自动 seedDB() 生成干净空实例
let removed = false;
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  removed = true;
  console.log('• 已删除 data/db.json（测试数据已清除）');
}
if (fs.existsSync(UPLOADS_DIR)) {
  fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  removed = true;
  console.log('• 已清空 data/uploads/（附件已清除）');
}
if (!removed) {
  console.log('• 未发现运行时数据，已是干净状态');
}

console.log('\n✓ 已清理为干净版本。执行 git commit / docker build 时不会带入任何测试数据。');
console.log('  下次 npm start 将自动播种全新空实例（仅 admin / admin123）。');
