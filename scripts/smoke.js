#!/usr/bin/env node
/* ========== 冒烟测试 ==========
 * 用临时 DATA_DIR（把项目复制到系统临时目录，data/ 为空 → 服务自动播种空实例）启动服务，
 * 逐功能区验证核心接口：健康检查 / 登录 / 各模块列表 GET / 新增 POST / 详情 GET / 权限 403。
 * 用途：重构（按功能区拆分）每一步的回归标准。
 *
 * 用法：
 *   node scripts/smoke.js               正常跑，结束后清理临时目录
 *   node scripts/smoke.js --keep        保留临时目录（排查失败用），末尾打印路径
 *   node scripts/smoke.js --port 5399   指定端口（默认自动挑空闲端口）
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { buildStoreZip } = require('../server/core/util');   // 造最小 docx 用（跟服务端同一套 zip 实现）

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const PORT_ARG = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
})();
// 复制到临时目录时跳过的顶层项（node_modules 用软链接复用，避免每次复制几十 MB）
const SKIP_TOP = new Set(['node_modules', 'data', 'uploads', '.git', '.workbuddy', '_backup', '_shots']);

const results = [];
let base = '';
let child = null;
let TMP = '';
let serverLog = '';

function log(s) { process.stdout.write(s + '\n'); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function prepareTmp() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-smoke-'));
  fs.cpSync(ROOT, TMP, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (SKIP_TOP.has(top)) return false;
      if (/\.log$/i.test(rel)) return false;
      return true;
    }
  });
  // node_modules 复用项目里的那份（只读依赖，软链接即可）
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(TMP, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true }); // 空 data → 自动 seed 空实例
  return TMP;
}

async function startServer(port) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: TMP,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { serverLog += d.toString(); });
  child.stderr.on('data', d => { serverLog += d.toString(); });
  base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null) throw new Error('服务启动即退出（exit ' + child.exitCode + '）：\n' + serverLog);
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(800) });
      if (r.ok) return;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('服务 25s 内未就绪：\n' + serverLog);
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  if (c.exitCode === null) {
    c.kill('SIGTERM');
    await new Promise(r => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { } r(); }, 2500);
      c.on('exit', () => { clearTimeout(t); r(); });
    });
  }
}

async function api(method, p, opt) {
  opt = opt || {};
  const headers = {};
  if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
  const res = await fetch(base + p, {
    method,
    headers,
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
    signal: AbortSignal.timeout(10000)
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { status: res.status, data };
}

async function step(group, name, fn) {
  try {
    const info = await fn();
    results.push({ group, name, ok: true, info: info || '' });
    log('PASS  [' + group + '] ' + name + (info ? '  → ' + info : ''));
  } catch (e) {
    results.push({ group, name, ok: false, info: e.message });
    log('FAIL  [' + group + '] ' + name + '\n      ' + String(e.message).replace(/\n/g, '\n      '));
  }
}

function need(cond, msg) { if (!cond) throw new Error(msg); }
function brief(data) { return JSON.stringify(data).slice(0, 220); }
function needOk(r, label) {
  need(r.status >= 200 && r.status < 300, (label || '') + ' 期望 2xx，实际 ' + r.status + ' ' + brief(r.data));
  return r.data;
}
async function listOk(p, token) {
  const r = await api('GET', p, { token });
  needOk(r, 'GET ' + p);
  need(Array.isArray(r.data), 'GET ' + p + ' 应返回数组，实际 ' + brief(r.data));
  return r.data;
}

(async () => {
  const t0 = Date.now();
  log('=== 电网ERP 冒烟测试（临时 DATA_DIR）===');
  try {
    prepareTmp();
    log('临时目录：' + TMP);
    const port = PORT_ARG || await freePort();
    await startServer(port);
    log('服务已就绪：' + base + '\n');
  } catch (e) {
    log('启动失败：' + e.message);
    await stopServer();
    if (TMP && !KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { } }
    process.exit(1);
  }

  /* ---------- 基础 / 静态资源 / 鉴权 ---------- */
  await step('基础', '健康检查 GET /api/health', async () => {
    const d = needOk(await api('GET', '/api/health'), 'health');
    need(d && d.ok === true, 'health.ok 应为 true：' + brief(d));
    return d.name;
  });
  await step('基础', '首页 GET /', async () => {
    const r = await fetch(base + '/');
    need(r.status === 200, 'GET / 期望 200，实际 ' + r.status);
    const html = await r.text();
    need(html.indexOf('id="app"') > -1, '首页 HTML 缺少 #app 挂载点');
    return 'HTML ' + html.length + ' 字节';
  });
  await step('基础', '离线依赖 GET /vendor/vue.global.prod.js', async () => {
    const r = await fetch(base + '/vendor/vue.global.prod.js');
    need(r.status === 200, '期望 200，实际 ' + r.status);
    const t = await r.text();
    need(t.length > 1000, 'vendor 文件内容异常（' + t.length + ' 字节）');
    return t.length + ' 字节';
  });
  await step('基础', '内置模板 GET /assets/materials_import_template.xlsx', async () => {
    const r = await fetch(base + '/assets/materials_import_template.xlsx');
    need(r.status === 200, '期望 200，实际 ' + r.status);
    return 'OK';
  });
  await step('鉴权', '未登录访问业务接口应 401', async () => {
    const r = await api('GET', '/api/projects');
    need(r.status === 401, '期望 401，实际 ' + r.status + ' ' + brief(r.data));
    return '401';
  });

  /* ---------- system：登录 / 用户 / 设置 / 人员 / 通讯录 ---------- */
  let token = '';
  let adminId = '';
  let clyToken = '';
  await step('system', '登录 POST /api/login（admin）', async () => {
    const d = needOk(await api('POST', '/api/login', { body: { username: 'admin', password: 'admin123' } }), 'login');
    need(d.token && d.user, '登录响应缺少 token/user：' + brief(d));
    token = d.token;
    adminId = d.user.id;
    return 'token ' + String(token).slice(0, 8) + '… / ' + d.user.role;
  });
  await step('system', '当前用户 GET /api/me', async () => {
    const d = needOk(await api('GET', '/api/me', { token }), 'me');
    need(d.user && d.user.username === 'admin', 'user.username 应为 admin：' + brief(d.user));
    need(d.user.isAdmin === true, 'admin 的 isAdmin 应为 true');
    return d.user.name + ' / ' + d.user.role + ' / write=' + JSON.stringify(d.user.permissions.writeModules);
  });
  await step('system', '设置 GET /api/settings', async () => {
    const d = needOk(await api('GET', '/api/settings', { token }), 'settings');
    need(d && typeof d === 'object' && 'systemName' in d, 'settings 缺少 systemName：' + brief(d));
    return 'systemName=' + d.systemName;
  });
  await step('system', '初始化状态 GET /api/init-status', async () => {
    const d = needOk(await api('GET', '/api/init-status', { token }), 'init-status');
    need('initialized' in d, '缺少 initialized：' + brief(d));
    return 'initialized=' + d.initialized;
  });
  await step('system', '账号列表 GET /api/users', async () => {
    const d = needOk(await api('GET', '/api/users', { token }), 'users');
    need(Array.isArray(d) && d.length >= 1, '应为非空数组：' + brief(d));
    need(d.some(u => u.username === 'admin'), '列表缺少 admin');
    return d.length + ' 个账号';
  });
  await step('system', '新建账号 POST /api/users（材料员）+ 列表详情校验', async () => {
    const d = needOk(await api('POST', '/api/users', {
      token, body: { loginName: 'smoke_cly', email: 'smoke_cly@example.com', name: '冒烟材料员', password: 'Smoke@2026', userGroup: '材料员' }
    }), 'users POST');
    need(d && d.id, '响应缺少 id：' + brief(d));
    const list = needOk(await api('GET', '/api/users', { token }), 'users list');
    const got = list.find(u => u.id === d.id);
    need(got, '新建账号未出现在列表');
    need(got.userGroup === '材料员', 'userGroup 应为材料员，实际 ' + got.userGroup);
    return 'id=' + d.id;
  });
  await step('system', '作业人员 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/workers', {
      token, body: { name: '张三', idNumber: '110101199001011234', phone: '13800138000', role: '技工（计入高处作业人员）', team: '冒烟班组' }
    }), 'workers POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/workers/' + d.id, { token }), 'workers detail');
    need(one.name === '张三', 'detail.name 应为 张三，实际 ' + one.name);
    return 'id=' + d.id;
  });
  await step('system', '通讯录 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/contacts', { token, body: { name: '李四', phone: '13900139000', unit: '冒烟单位' } }), 'contacts POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/contacts/' + d.id, { token }), 'contacts detail');
    need(one.name === '李四', 'detail.name 应为 李四');
    return 'id=' + d.id;
  });
  await step('system', '设置字典 年度计划/供电所/班组/单位/材料目录 新增 → 详情', async () => {
    const out = [];
    const defs = [
      ['annualPlans', { name: '2026年度计划' }],
      ['substations', { name: '冒烟供电所' }],
      ['teams', { name: '冒烟班组' }],
      ['units', { name: '冒烟分包单位', type: '分包单位' }],
      ['materialCatalog', { name: '冒烟材料目录' }]
    ];
    for (const [coll, body] of defs) {
      const c = needOk(await api('POST', '/api/' + coll, { token, body }), coll + ' POST');
      need(c && c.id, coll + ' 响应缺少 id');
      const one = needOk(await api('GET', '/api/' + coll + '/' + c.id, { token }), coll + ' detail');
      need(one.name === body.name, coll + ' detail.name 不匹配：' + one.name);
      out.push(coll);
    }
    return out.join(' / ');
  });

  /* ---------- projects ---------- */
  let projectId = '';
  await step('projects', '新增项目 POST /api/projects', async () => {
    const d = needOk(await api('POST', '/api/projects', {
      token,
      body: { name: '冒烟测试项目', batch: '2026-01', substation: '冒烟供电所', workType: '配网', projectType: '自有工程', manager: '张三', status: '进行中' }
    }), 'projects POST');
    need(d && d.id, '响应缺少 id');
    projectId = d.id;
    return 'id=' + projectId;
  });
  await step('projects', '项目列表 GET /api/projects 含新项目', async () => {
    const d = needOk(await api('GET', '/api/projects', { token }), 'projects list');
    need(Array.isArray(d) && d.some(p => p.id === projectId), '列表未包含新建项目');
    return d.length + ' 个项目';
  });
  await step('projects', '项目详情 GET /api/projects/:id', async () => {
    const d = needOk(await api('GET', '/api/projects/' + projectId, { token }), 'projects detail');
    need(d.name === '冒烟测试项目', 'name 不匹配：' + d.name);
    return d.name;
  });

  /* ---------- materials ---------- */
  let materialId = '';
  await step('materials', '新增材料 POST /api/materials', async () => {
    const d = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目', source: 'ERP采购申请', description: '预应力混凝土电杆Φ150×10M', qtyRequired: 10, qtyArrived: 0, unit: '根', code: 'S01HDG1005' }
    }), 'materials POST');
    need(d && d.id, '响应缺少 id');
    materialId = d.id;
    return 'id=' + materialId;
  });
  await step('materials', '材料列表 GET /api/materials（含派生字段）', async () => {
    const d = needOk(await api('GET', '/api/materials', { token }), 'materials list');
    const it = d.find(m => m.id === materialId);
    need(it, '列表未包含新建材料');
    need(it.status === '未到库', 'status 应为 未到库，实际 ' + it.status);
    need(it.qtyNotArrived === 10, 'qtyNotArrived 应为 10，实际 ' + it.qtyNotArrived);
    return 'status=' + it.status + ' qtyNotArrived=' + it.qtyNotArrived;
  });
  await step('materials', '材料详情 GET /api/materials/:id', async () => {
    const d = needOk(await api('GET', '/api/materials/' + materialId, { token }), 'materials detail');
    need(d.description.indexOf('电杆') > -1, 'description 不匹配：' + d.description);
    return d.description;
  });
  await step('materials', '导入批次 GET /api/materialImports', async () => listOk('/api/materialImports', token).then(d => d.length + ' 条'));
  await step('materials', '出库管理 GET /api/materialOutbound', async () => listOk('/api/materialOutbound', token).then(d => d.length + ' 条'));
  await step('materials', '出库库存 GET /api/materialOutbound/stock', async () => {
    const d = needOk(await api('GET', '/api/materialOutbound/stock', { token }), 'stock');
    need(Array.isArray(d), 'stock 应返回数组：' + brief(d));
    return d.length + ' 行';
  });
  await step('materials', '领料单 GET /api/materialRequisitions', async () => listOk('/api/materialRequisitions', token).then(d => d.length + ' 条'));

  // 单号规范化：LL-YYYYMMDD-NNNN，当天 4 位流水号从 0001 起、只增不减
  await step('materials', '领料单号格式 LL-YYYYMMDD-NNNN 与流水号递增', async () => {
    const mk = async () => {
      const d = needOk(await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: materialId, qty: 3 }] } }), 'requisition create');
      need(d && d.data && d.data.reqNo, '响应缺少 reqNo');
      return d.data.reqNo;
    };
    const re = /^LL-\d{8}-\d{4}$/;
    const n1 = await mk();
    need(re.test(n1), '单号格式应为 LL-YYYYMMDD-NNNN，实际 ' + n1);
    need(n1.endsWith('-0001'), '当日首张单号应为 ...-0001，实际 ' + n1);
    const n2 = await mk();
    need(re.test(n2), '单号格式应为 LL-YYYYMMDD-NNNN，实际 ' + n2);
    const s1 = +n1.slice(-4), s2 = +n2.slice(-4);
    need(s2 === s1 + 1, '流水号应从 ' + s1 + ' 递增到 ' + (s1 + 1) + '，实际 ' + n2);
    return n1 + ' → ' + n2;
  });
  await step('materials', '领料单下载文件名 = reqNo（新旧格式兼容）', async () => {
    const list = needOk(await api('GET', '/api/materialRequisitions', { token }), 'requisition list');
    need(list.length >= 2, '应至少 2 张领料单，实际 ' + list.length);
    const rec = list[list.length - 1];
    const res = await fetch(base + '/api/materialRequisitions/' + rec.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(res.ok, '下载应成功');
    const cd = res.headers.get('Content-Disposition') || '';
    need(cd.indexOf('"' + rec.reqNo + '.xlsx"') > -1 || cd.indexOf(rec.reqNo + '.xlsx') > -1, '文件名应为 reqNo.xlsx，实际 ' + cd);
    return rec.reqNo + '.xlsx';
  });

  /* ---------- 到货统计（聚合口径回归，纯函数与前端共用） ---------- */
  const arrivalCalc = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'arrival-calc.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ArrivalCalc;
  })();

  await step('materials', '到货统计聚合：应到/已到与材料明细逐行求和一致', async () => {
    const ms = await listOk('/api/materials', token);
    const names = [...new Set(ms.map(m => m.project))];
    const agg = arrivalCalc.aggregate(ms, names);
    const sum = k => Math.round(ms.reduce((s, m) => s + (Number(m[k]) || 0), 0) * 10000) / 10000;
    need(agg.totalRows === ms.length, '总行数应为 ' + ms.length + '，实际 ' + agg.totalRows);
    need(Math.abs(agg.requiredSum - sum('qtyRequired')) < 1e-6, '应到合计不符：' + agg.requiredSum + ' vs ' + sum('qtyRequired'));
    need(Math.abs(agg.arrivedSum - sum('qtyArrived')) < 1e-6, '已到合计不符：' + agg.arrivedSum + ' vs ' + sum('qtyArrived'));
    return `行 ${agg.totalRows} · 应到 ${agg.requiredSum} · 已到 ${agg.arrivedSum}`;
  });

  await step('materials', '到货统计：同名跨项目合并为一行且数量相加', async () => {
    const p2 = needOk(await api('POST', '/api/projects', { token, body: { name: '冒烟测试项目B', batch: '2026-01', substation: '冒烟供电所', workType: '配网', category: '自有工程' } }), 'projects POST B');
    needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '预应力混凝土电杆Φ150×10M', qtyRequired: 5, qtyArrived: 2, unit: '根', code: 'S01HDG1005' }
    }), 'materials POST B');
    const ms = await listOk('/api/materials', token);
    const agg = arrivalCalc.aggregate(ms, ['冒烟测试项目', '冒烟测试项目B']);
    need(agg.kindCount === 1, '同名物料应合并为 1 种，实际 ' + agg.kindCount);
    need(agg.rows.length === 1, '主表应 1 行，实际 ' + agg.rows.length);
    need(Math.abs(agg.requiredSum - 15) < 1e-6, '应到合计应为 15，实际 ' + agg.requiredSum);
    need(Math.abs(agg.arrivedSum - 2) < 1e-6, '已到合计应为 2，实际 ' + agg.arrivedSum);
    return `1 种 · 应到 ${agg.requiredSum} · 已到 ${agg.arrivedSum} · ${p2.name}`;
  });

  await step('materials', '到货统计：同编码不同描述分开算（各是各的）', async () => {
    needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '同编码另一描述', qtyRequired: 7, qtyArrived: 1, unit: '根', code: 'S01HDG1005' }
    }), 'materials POST C');
    const ms = await listOk('/api/materials', token);
    const agg = arrivalCalc.aggregate(ms, ['冒烟测试项目', '冒烟测试项目B']);
    need(agg.kindCount === 2, '同编码不同描述应算 2 种，实际 ' + agg.kindCount);
    need(agg.rows.length === 2, '主表应 2 行，实际 ' + agg.rows.length);
    const d1 = agg.rows.find(r => r.description === '预应力混凝土电杆Φ150×10M');
    const d2 = agg.rows.find(r => r.description === '同编码另一描述');
    need(d1 && Math.abs(d1.required - 15) < 1e-6 && Math.abs(d1.arrived - 2) < 1e-6, '原描述组应仍为 15/2，实际 ' + (d1 && d1.required + '/' + d1.arrived));
    need(d2 && Math.abs(d2.required - 7) < 1e-6 && Math.abs(d2.arrived - 1) < 1e-6, '新描述组应为 7/1，实际 ' + (d2 && d2.required + '/' + d2.arrived));
    need(d1.code === 'S01HDG1005' && d2.code === 'S01HDG1005', '两行编码应相同（仅描述不同）');
    return `2 种：${d1.required}/${d1.arrived} + ${d2.required}/${d2.arrived}`;
  });

  await step('materials', '到货统计：同名不同编码也各是各的（编码+名称成条）', async () => {
    needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '预应力混凝土电杆Φ150×10M', qtyRequired: 3, qtyArrived: 0, unit: '根', code: 'SMOKE-OTHER' }
    }), 'materials POST D');
    needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '从未到货物料', qtyRequired: 8, qtyArrived: 0, unit: '个', code: 'SMOKE-NOARR' }
    }), 'materials POST E');
    const ms = await listOk('/api/materials', token);
    const agg = arrivalCalc.aggregate(ms, ['冒烟测试项目', '冒烟测试项目B']);
    // 4 组：D1/C1(15,2)、D2/C1(7,1)、D1/SMOKE-OTHER(3,0)、D3/SMOKE-NOARR(8,0)
    need(agg.kindCount === 4, '应为 4 组（编码+名称），实际 ' + agg.kindCount);
    const d1 = agg.rows.find(r => r.description === '预应力混凝土电杆Φ150×10M');
    need(d1 && Math.abs(d1.required - 15) < 1e-6, '同名不同编码不应合并（应仍为 15），实际 ' + (d1 && d1.required));
    need(d1.code === 'S01HDG1005', '该行编码应为 S01HDG1005，实际 ' + (d1 && d1.code));
    need(Math.abs(agg.requiredSum - 33) < 1e-6, '应到合计应为 33，实际 ' + agg.requiredSum);
    need(agg.arrivedKindCount === 2, '已到货组数应为 2，实际 ' + agg.arrivedKindCount);
    need(agg.notArrivedKindCount === 2, '未到货组数应为 2，实际 ' + agg.notArrivedKindCount);
    need(agg.rows.length === agg.arrivedKindCount, '主表行数应等于已到货组数');
    const rr = arrivalCalc.recentArrivals([
      { reqNo: 'LL-20260101-0001', projects: ['冒烟测试项目'], status: '已入库', items: [{ materialId: 'a', description: '甲' }], history: [{ at: '2026-01-01 09:00', rows: [{ materialId: 'a', thisQty: 1 }] }] },
      { reqNo: 'LL-20260101-0002', projects: ['冒烟测试项目'], status: '已入库', items: [{ materialId: 'a', description: '甲' }], history: [{ at: '2026-01-02 09:00', rows: [{ materialId: 'a', thisQty: 2 }] }] },
      { reqNo: 'LL-20260101-0003', projects: ['冒烟测试项目'], status: '已作废', items: [{ materialId: 'a', description: '甲' }], history: [{ at: '2026-01-03 09:00', rows: [{ materialId: 'a', thisQty: 3 }] }] }
    ], ['冒烟测试项目'], 50);
    need(rr.length === 2, '作废单应排除，应 2 条，实际 ' + rr.length);
    need(rr[0].at > rr[1].at, '应按时间倒序，实际 ' + rr.map(x => x.at).join(' | '));
    return `组 ${agg.kindCount} / 已到 ${agg.arrivedKindCount} / 未到 ${agg.notArrivedKindCount} · D1 未与同名异码合并 · 动态 ${rr.length} 条`;
  });

  /* ---------- 计划编号（纯函数与前端共用） ---------- */
  const planNo = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'plan-no.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.PlanNo;
  })();

  await step('plans', '编号规则：勘察按月取最大流水 +1，跨月归零', async () => {
    const ym = '202610';
    const plans = [
      { surveyNo: '202610001' }, { surveyNo: '202610004' }, { surveyNo: ' 202610007 ' },
      { surveyNo: '202609009' }, { surveyNo: '202611002' }, { surveyNo: '20261001' }, { surveyNo: '' }
    ];
    need(planNo.nextSurveyNo(plans, ym) === '202610008', '当月最大 007 → 应为 202610008，实际 ' + planNo.nextSurveyNo(plans, ym));
    need(planNo.nextSurveyNo(plans, '202612') === '202612001', '跨月应归零到 001，实际 ' + planNo.nextSurveyNo(plans, '202612'));
    need(planNo.nextSurveyNo([], ym) === '202610001', '无记录时应为 001');
    return `202610 → ${planNo.nextSurveyNo(plans, ym)} · 202612 → 202612001`;
  });

  await step('plans', '编号规则：工作票按类型各走各的流水（不同类型各出 001）', async () => {
    const ym = '202610';
    const T = planNo.TICKET_TYPES;
    need(T.length === 5, '工作票类型应为 5 种，实际 ' + T.length);
    need(Object.keys(planNo.TICKET_NO_CODE).length === 5, '类型码应为 5 条');
    const plans = [
      { ticketType: T[0], workTicketNo: '20261068001' },
      { ticketType: T[0], workTicketNo: '20261068002' },
      { ticketType: T[3], workTicketNo: '20261067001' },
      { ticketType: T[1], workTicketNo: '20260978005' }   // 上个月的不算
    ];
    need(planNo.nextTicketNo(plans, ym, T[0]) === '20261068003', '配电第一种应 68003，实际 ' + planNo.nextTicketNo(plans, ym, T[0]));
    need(planNo.nextTicketNo(plans, ym, T[3]) === '20261067002', '线路第一种应独立算 67002，实际 ' + planNo.nextTicketNo(plans, ym, T[3]));
    need(planNo.nextTicketNo(plans, ym, T[1]) === '20261078001', '配电第二种当月无记录应 78001，实际 ' + planNo.nextTicketNo(plans, ym, T[1]));
    need(planNo.nextTicketNo(plans, ym, T[2]) === '20261098001', '配电低压应 98001');
    need(planNo.nextTicketNo(plans, ym, T[4]) === '20261077001', '线路第二种应 77001');
    need(planNo.nextTicketNo(plans, ym, '未映射的类型') === ym, '映射表外应只带年月');
    return T.map(t => planNo.TICKET_NO_CODE[t] + '→' + planNo.nextTicketNo(plans, ym, t)).join(' ');
  });

  await step('plans', '编号规则：格式不符的手填编号不干扰解析', async () => {
    const ym = '202610';
    const plans = [
      { surveyNo: '202610003' },
      { surveyNo: '2026100' }, { surveyNo: '2026100003' }, { surveyNo: 'ABC' }, { surveyNo: '20261000X' }, { surveyNo: null },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '20261068005' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '20261068' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '2026106800X' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '202610680005' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '' }
    ];
    need(planNo.nextSurveyNo(plans, ym) === '202610004', '勘察应为 004，实际 ' + planNo.nextSurveyNo(plans, ym));
    need(planNo.nextTicketNo(plans, ym, '配电：配电第一种工作票') === '20261068006', '工作票应为 68006，实际 ' + planNo.nextTicketNo(plans, ym, '配电：配电第一种工作票'));
    return '脏编号被忽略：勘察 → 202610004、工作票 → 20261068006';
  });

  /* ---------- plans / borrow ---------- */
  await step('plans', '计划列表 GET /api/plans', async () => listOk('/api/plans', token).then(d => d.length + ' 条'));
  await step('plans', '作业计划 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/workPlans', {
      token, body: { project: '冒烟测试项目', workType: '立杆', planStart: '2026-10-24 08:00:00', planEnd: '2026-10-24 18:00:00', status: '未开始' }
    }), 'workPlans POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/workPlans/' + d.id, { token }), 'workPlans detail');
    need(one.project === '冒烟测试项目', 'detail.project 不匹配');
    return 'id=' + d.id;
  });
  await step('plans', '施工资料图纸：上传 → 下载 → 删除（老记录无 drawings 不报错）', async () => {
    const p = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟图纸计划', planType: '周计划' } }), 'plan POST');
    need(p && p.id, '响应缺少 id');
    // 老记录（刚建、无 drawings 字段）详情不应报错
    const before = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'plan detail');
    need(!before.drawings || Array.isArray(before.drawings), 'drawings 应为数组或不存在');
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), '冒烟图纸.png');
    const upRes = await fetch(base + '/api/workPlans/' + p.id + '/drawings', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(10000)
    });
    const dw = await upRes.json();
    need(upRes.status === 200 && dw && dw.id, '图纸上传失败：' + brief(dw));
    need(/^dw/.test(dw.id), '图纸 id 前缀应为 dw，实际 ' + brief(dw.id));
    need(dw.category === '图纸' && dw.name === '冒烟图纸.png', '类别/文件名不符：' + brief({ c: dw.category, n: dw.name }));
    need(dw.size === png.length, 'size 应为 ' + png.length + '，实际 ' + brief(dw.size));
    need(String(dw.path).startsWith('uploads/plans/' + p.id + '/'), 'path 不符：' + brief(dw.path));
    need(!!dw.uploadedAt, '缺少 uploadedAt');
    // 下载能拿回原字节
    const dl = await fetch(base + '/api/workPlans/' + p.id + '/drawings/' + dw.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl.status === 200, '下载期望 200，实际 ' + dl.status);
    const got = Buffer.from(await dl.arrayBuffer());
    need(got.length === png.length && got.equals(png), '下载内容与上传不一致');
    // 删除后记录消失、文件不可再下载
    needOk(await api('DELETE', '/api/workPlans/' + p.id + '/drawings/' + dw.id, { token }), 'drawings DELETE');
    const after = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'plan detail after');
    need(!(after.drawings || []).some(x => x.id === dw.id), '删除后 drawings 仍含该记录');
    const dl2 = await fetch(base + '/api/workPlans/' + p.id + '/drawings/' + dw.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl2.status === 404, '删除后下载应 404，实际 ' + dl2.status);
    return 'id=' + dw.id + ' size=' + dw.size + ' 删除后 404';
  });
  await step('plans', '借工 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/borrowWorks', {
      token, body: { team: '冒烟班组', direction: '借出', reason: '冒烟测试', people: 2, status: '待审批' }
    }), 'borrowWorks POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/borrowWorks/' + d.id, { token }), 'borrowWorks detail');
    need(one.team === '冒烟班组', 'detail.team 不匹配');
    return 'id=' + d.id;
  });

  /* ---------- completion ---------- */
  await step('documents', '竣工资料 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/completionDocuments', {
      token, body: { name: '竣工资料-冒烟', category: '施工记录', status: '编制中' }
    }), 'completionDocuments POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/completionDocuments/' + d.id, { token }), 'completionDocuments detail');
    need(one.name === '竣工资料-冒烟', 'detail.name 不匹配');
    return 'id=' + d.id;
  });

  /* ---------- documents ---------- */
  await step('documents', '文档中心 GET /api/documents', async () => {
    const d = needOk(await api('GET', '/api/documents', { token }), 'documents');
    need(Array.isArray(d.categories) && d.categories.indexOf('危险点') > -1, 'categories 缺少「危险点」：' + brief(d.categories));
    need(Array.isArray(d.files), 'files 应为数组');
    return '分类 ' + d.categories.length + ' 个 / 文件 ' + d.files.length + ' 个';
  });
  await step('documents', '危险点 新增 → 列表校验', async () => {
    const d = needOk(await api('POST', '/api/documents/hazard', { token, body: { hazard: '冒烟危险点', measure: '冒烟控制措施' } }), 'hazard POST');
    need(d && d.id, '响应缺少 id');
    const list = needOk(await api('GET', '/api/workticket/hazards', { token }), 'hazards list');
    need(Array.isArray(list) && list.some(h => h.id === d.id), '危险点库未包含新建条目');
    return 'id=' + d.id;
  });
  // 文档预览（docx → 提取文本）：勘察记录模板走的就是这条链路，重构时曾漏导入 extractDocxText 导致 500
  await step('documents', 'docx 上传 → 预览提取文本', async () => {
    const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>现场勘察记录</w:t></w:r></w:p><w:p><w:r><w:t>冒烟勘察内容</w:t></w:r></w:p></w:body></w:document>', 'utf8');
    const docx = buildStoreZip([{ name: 'word/document.xml', data: xml }]);
    const fd = new FormData();
    fd.append('category', '工作票模板');
    fd.append('file', new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '冒烟勘察记录.docx');
    const upRes = await fetch(base + '/api/documents/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(10000) });
    const up = await upRes.json();
    need(upRes.status === 200 && up && up.id, '上传失败：' + brief(up));
    const pv = needOk(await api('GET', '/api/documents/files/' + up.id + '/preview', { token }), 'preview');
    need(pv.kind === 'docx', 'preview.kind 应为 docx，实际 ' + brief(pv.kind));
    need(Array.isArray(pv.lines) && pv.lines.includes('冒烟勘察内容'), '预览未提取到正文：' + brief(pv.lines));
    await api('DELETE', '/api/documents/files/' + up.id, { token });
    return 'kind=docx 行数=' + pv.lines.length;
  });

  /* ---------- workticket ---------- */
  await step('workticket', '配置状态 GET /api/workticket/config-status', async () => {
    const d = needOk(await api('GET', '/api/workticket/config-status', { token }), 'config-status');
    need(d && typeof d === 'object', '响应应为对象：' + brief(d));
    return Object.keys(d).slice(0, 6).join(',');
  });
  await step('workticket', '资料库 GET /api/workticket/library', async () => {
    const d = needOk(await api('GET', '/api/workticket/library', { token }), 'library');
    need(Array.isArray(d.groups) && d.groups.length === 5, 'groups 应为 5 组，实际 ' + (d.groups || []).length);
    need(Array.isArray(d.categories) && d.categories.length > 0, 'categories 不应为空');
    need(Array.isArray(d.techOptions) && Array.isArray(d.safetyOptions), 'techOptions/safetyOptions 应为数组');
    return 'groups=' + d.groups.length + ' categories=' + d.categories.length;
  });
  await step('workticket', '匹配规则 新增 → 列表校验', async () => {
    const d = needOk(await api('POST', '/api/workticket/rules', { token, body: { workType: '冒烟作业', category: '开挖坑洞' } }), 'rules POST');
    need(d && d.id, '响应缺少 id');
    const list = needOk(await api('GET', '/api/workticket/rules', { token }), 'rules list');
    need(list.some(r => r.id === d.id), '规则列表未包含新建条目');
    return 'id=' + d.id;
  });
  await step('workticket', '技术措施 列表 + 新增', async () => {
    const before = needOk(await api('GET', '/api/workticket/measures/tech', { token }), 'tech list');
    need(Array.isArray(before), 'tech 列表应为数组');
    const d = needOk(await api('POST', '/api/workticket/measures/tech', { token, body: { title: '冒烟技术措施', content: '（1）冒烟内容' } }), 'tech POST');
    need(d && d.id, '响应缺少 id');
    const after = needOk(await api('GET', '/api/workticket/measures/tech', { token }), 'tech list 2');
    need(after.length === before.length + 1, '新增后条数应 +1（' + before.length + ' → ' + after.length + '）');
    return before.length + ' → ' + after.length;
  });
  await step('workticket', '安全措施 列表 GET', async () => listOk('/api/workticket/measures/safety', token).then(d => d.length + ' 条'));
  await step('workticket', '医院联系方式 列表 GET', async () => listOk('/api/workticket/hospitals', token).then(d => d.length + ' 条'));
  await step('workticket', '默认模板 元信息 GET（内置 49/19）', async () => {
    const d = needOk(await api('GET', '/api/workticket/measures/default', { token }), 'default meta');
    need(d.tech === 49 && d.safety === 19, '内置默认应为 技术49/安全19，实际 ' + d.tech + '/' + d.safety);
    need(d.builtin === true, '空实例应为 builtin=true，实际 ' + d.builtin);
    return 'tech=' + d.tech + ' safety=' + d.safety + ' builtin=' + d.builtin;
  });
  await step('workticket', '载入默认 POST → 技术/安全各 +49/+19', async () => {
    const d = needOk(await api('POST', '/api/workticket/measures/default/load', { token }), 'default load');
    need(d.result && d.result.tech && d.result.tech.added === 49, '技术应新增 49，实际 ' + brief(d.result));
    need(d.result.safety && d.result.safety.added === 19, '安全应新增 19，实际 ' + brief(d.result));
    return 'tech+' + d.result.tech.added + ' safety+' + d.result.safety.added;
  });

  /* ---------- actualWorks ---------- */
  let awId = '';
  await step('actualWorks', '施工量列表 GET /api/actualWorks', async () => listOk('/api/actualWorks', token).then(d => d.length + ' 条'));
  await step('actualWorks', '新增施工量 POST /api/actualWorks', async () => {
    const d = needOk(await api('POST', '/api/actualWorks', {
      token,
      body: {
        date: '2026-10-24', project: '冒烟测试项目', workTypes: ['立杆'], workers: ['张三'],
        items: [{ materialId, code: 'S01HDG1005', description: '预应力混凝土电杆Φ150×10M', unit: '根', qty: 2 }]
      }
    }), 'actualWorks POST');
    need(d && d.id, '响应缺少 id');
    need(d.items && d.items.length === 1 && d.items[0].qty === 2, 'items 落库不正确：' + brief(d.items));
    awId = d.id;
    return 'id=' + awId + ' qty=2';
  });
  await step('actualWorks', '施工量列表回查（材料数量/折算字段）', async () => {
    const d = needOk(await api('GET', '/api/actualWorks', { token }), 'actualWorks list');
    const row = d.find(r => r.id === awId);
    need(row, '列表未包含新建记录');
    need(row.items[0].qty === 2, 'qty 应为 2，实际 ' + row.items[0].qty);
    need(row.submitter, 'submitter 应写入当前用户');
    return 'submitter=' + row.submitter;
  });
  await step('actualWorks', '编辑施工量 PUT /api/actualWorks/:id', async () => {
    const d = needOk(await api('PUT', '/api/actualWorks/' + awId, {
      token,
      body: {
        date: '2026-10-24', project: '冒烟测试项目', workTypes: ['立杆'], workers: ['张三'],
        items: [{ materialId, description: '预应力混凝土电杆Φ150×10M', unit: '根', qty: 3 }]
      }
    }), 'actualWorks PUT');
    need(d.items[0].qty === 3, 'PUT 后 qty 应为 3，实际 ' + d.items[0].qty);
    need(d.updatedAt, 'PUT 应写 updatedAt');
    return 'qty 2 → 3';
  });

  /* ---------- 权限（RBAC） ---------- */
  await step('权限', '材料员登录 POST /api/login（smoke_cly）', async () => {
    const d = needOk(await api('POST', '/api/login', { body: { username: 'smoke_cly', password: 'Smoke@2026' } }), 'login cly');
    need(d.token, '响应缺少 token');
    clyToken = d.token;
    return (d.user.userGroup || d.user.role) + ' 登录成功';
  });
  await step('权限', '材料员读业务接口允许 / 写项目应 403', async () => {
    const cly = clyToken;
    const g = await api('GET', '/api/projects', { token: cly });
    need(g.status === 200, 'GET /api/projects 期望 200，实际 ' + g.status);
    const p = await api('POST', '/api/projects', { token: cly, body: { name: '越权项目' } });
    need(p.status === 403, 'POST /api/projects 期望 403，实际 ' + p.status + ' ' + brief(p.data));
    const m = await api('POST', '/api/materials', {
      token: cly, body: { project: '冒烟测试项目', source: 'ERP采购申请', description: '越权材料', qtyRequired: 1, unit: '根' }
    });
    need(m.status >= 200 && m.status < 300, '材料员写材料台账应允许，实际 ' + m.status + ' ' + brief(m.data));
    return '读 200 / 写项目 403 / 写材料 2xx';
  });

  /* ---------- 汇总 ---------- */
  await stopServer();
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  log('\n=== 结果：通过 ' + pass + ' / 失败 ' + fail + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）===');
  if (fail) {
    log('失败清单：');
    results.filter(r => !r.ok).forEach(r => log('  - [' + r.group + '] ' + r.name + '：' + r.info));
  }
  if (KEEP) log('临时目录（已保留）：' + TMP);
  else { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { } }
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  log('冒烟脚本异常：' + e.stack);
  await stopServer();
  if (TMP && !KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { } }
  process.exit(1);
});
