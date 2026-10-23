'use strict';
/**
 * 本地自托管「电网生产ERP」复刻 — 后端入口
 * 技术栈：Node + Express + 本地 JSON 存储（data/db.json）
 * 结构：server/core（db / auth / crud / upload / util …）+ server/routes（system / materials /
 *      projects / plans / documents / workticket）；本文件只负责加载顺序、静态托管与监听。
 */
const express = require('express');
const path = require('path');

const app = require('./server/core/app');
require('./server/core/db'); // 触发数据库加载、种子与旧数据迁移（必须在任何路由注册之前）
const { authMiddleware } = require('./server/core/auth');

const PORT = process.env.PORT || 5173;
const system = require('./server/routes/system');

/* 挂载顺序（不可随意调整）：
 * 1) 免鉴权接口（登录 / 健康检查 / 公开配置 / 登录背景图）
 * 2) /api 鉴权中间件
 * 3) 各业务模块（「具体路由 → 通用 CRUD」的先后顺序由各模块文件自行保证）
 * 4) 静态托管与首页直出
 */
system.registerPublic();

app.use('/api', authMiddleware);

system.registerAuthed();

require('./server/routes/materials');
require('./server/routes/projects');
require('./server/routes/plans');
require('./server/routes/documents');
require('./server/routes/workticket');

// ---------- 静态前端 ----------
app.use('/assets', express.static(path.join(__dirname, 'assets')));

system.registerPage();
// 登录背景图长缓存（文件名唯一，可 immutable；预设图按天缓存）
app.use('/login-bg', express.static(path.join(__dirname, 'public', 'login-bg'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
}));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  电网生产ERP（本地版）已启动`);
  console.log(`  ➜  本地访问: http://localhost:${PORT}`);
  console.log(`  ➜  默认账号: admin / admin123  (角色: 管理员)\n`);
});
