/* ========== core/app ========== */
/* 共享 express 实例：只创建 app 并挂载 JSON 解析，供 server.js 与各 routes 注册路由。 */
const express = require('express');

const app = express();
app.use(express.json());

module.exports = app;
