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
const { buildStoreZip, unzipEntry } = require('../server/core/util');   // 造最小 docx／读产物用（跟服务端同一套 zip 实现）

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
  await step('system', '设置 weekStart：PUT 写 0 → GET 读回 0；不传该键时既有值不被冲掉', async () => {
    // 写 weekStart=0（星期日），并带一个其它键以贴近真实保存体
    const put1 = needOk(await api('PUT', '/api/settings', { token, body: { companyName: '冒烟企业', weekStart: 0 } }), 'settings PUT 0');
    need(put1.weekStart === 0, 'PUT weekStart=0 后读回应仍为 0，实际 ' + brief(put1.weekStart));
    const g1 = needOk(await api('GET', '/api/settings', { token }), 'settings GET 0');
    need(g1.weekStart === 0, 'GET 应读回 0，实际 ' + brief(g1.weekStart));
    // 不传 weekStart，仅改 companyName → 既有 weekStart 必须保留
    const put2 = needOk(await api('PUT', '/api/settings', { token, body: { companyName: '冒烟企业改' } }), 'settings PUT 不传 weekStart');
    need(put2.weekStart === 0, '不传 weekStart 时旧值应被保留为 0，实际 ' + brief(put2.weekStart));
    const g2 = needOk(await api('GET', '/api/settings', { token }), 'settings GET 保留');
    need(g2.weekStart === 0, 'GET 应仍为 0，实际 ' + brief(g2.weekStart));
    // 还原为默认值 1，避免污染后续（临时库本就会清理，这里仅为稳妥）
    await api('PUT', '/api/settings', { token, body: { weekStart: 1 } });
    return '0 写读一致 / 不传键值保留 / 还原 1';
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

  // 领料单号解析/排序与前端共用同一份纯函数（public/js/utils.js → window.MaterialNo）
  const MaterialNo = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.MaterialNo;
  })();
  // 领料单号：当日 YYYYMMDD-NNN（3 位流水、当日有效）；旧 LL-YYYYMMDD-NNNN 前缀不同、不参与推导
  const ymd = off => { const d = new Date(Date.now() + (off || 0) * 86400000); const p = n => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); };
  const TODAY = ymd(0), YDAY = ymd(-1);
  let reqNoNew = '';
  const mkReq = async (qty) => {
    const d = needOk(await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: materialId, qty: qty || 1 }] } }), 'requisition create');
    need(d && d.data && d.data.reqNo, '响应缺少 reqNo');
    return d.data.reqNo;
  };
  const insertReq = async (reqNo) => {
    needOk(await api('POST', '/api/materialRequisitions', { token, body: { reqNo, projects: ['冒烟测试项目'], items: [], status: '待入库', createdAt: reqNo.slice(0, 8) } }), 'insert ' + reqNo);
  };
  await step('materials', '领料单号新格式：当日首单 YYYYMMDD-001（旧 LL- 单与昨日单均不计入）', async () => {
    // 先造两张干扰项：今日旧格式 LL-<今日>-0042、昨日新格式 <昨日>-005
    await insertReq('LL-' + TODAY + '-0042');
    await insertReq(YDAY + '-005');
    const n1 = await mkReq(1);
    need(/^\d{8}-\d{3}$/.test(n1), '单号格式应为 YYYYMMDD-NNN，实际 ' + n1);
    need(n1.indexOf('LL-') !== 0, '新单号不应带 LL- 前缀，实际 ' + n1);
    need(n1 === TODAY + '-001', '当日首单应为 ' + TODAY + '-001，实际 ' + n1);
    const n2 = await mkReq(1);
    need(/^\d{8}-\d{3}$/.test(n2), '单号格式应为 YYYYMMDD-NNN，实际 ' + n2);
    need(n2 === TODAY + '-002', '次单应为 ' + TODAY + '-002，实际 ' + n2);
    reqNoNew = n2;
    return n1 + ' → ' + n2 + '（已插入 LL-' + TODAY + '-0042 与 ' + YDAY + '-005 作干扰）';
  });
  await step('materials', '领料单号当日超 999 位数自然增长（不报错、不截断）', async () => {
    await insertReq(TODAY + '-999');
    const n = await mkReq(1);
    need(n === TODAY + '-1000', '应自然增长为 ' + TODAY + '-1000，实际 ' + n);
    return n;
  });
  await step('materials', '单号排序：同日 新格式 → LL-四位 → LL-六位，组内数值升序', async () => {
    const mixed = ['LL-' + TODAY + '-0002', TODAY + '-1000', 'X-无法识别', 'LL-' + TODAY + '-222544', TODAY + '-999', 'LL-' + TODAY + '-0001', TODAY + '-001'];
    const want = [TODAY + '-001', TODAY + '-999', TODAY + '-1000', 'LL-' + TODAY + '-0001', 'LL-' + TODAY + '-0002', 'LL-' + TODAY + '-222544', 'X-无法识别'];
    const got = mixed.slice().sort((a, b) => MaterialNo.cmp(a, b));
    need(JSON.stringify(got) === JSON.stringify(want), '同日混合排序不符\n      实际：' + got.join(' , ') + '\n      期望：' + want.join(' , '));
    // 跨日：昨日单号整体排在今日之前
    const cross = [TODAY + '-001', YDAY + '-005'].sort((a, b) => MaterialNo.cmp(a, b));
    need(cross[0] === YDAY + '-005', '跨日应昨日在前，实际 ' + cross.join(' , '));
    return got.join(' , ');
  });
  await step('materials', '领料单下载文件名 = reqNo（新格式与旧 LL- 格式并存）', async () => {
    const list = needOk(await api('GET', '/api/materialRequisitions', { token }), 'requisition list');
    const nw = list.find(r => r.reqNo === reqNoNew);
    const old = list.find(r => /^LL-\d{8}-\d{4}$/.test(r.reqNo || ''));
    need(nw, '列表未包含新格式单号 ' + reqNoNew);
    need(old, '列表未包含旧格式 LL- 单号');
    for (const rec of [nw, old]) {
      const res = await fetch(base + '/api/materialRequisitions/' + rec.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
      need(res.ok, '下载应成功：' + rec.reqNo);
      const cd = res.headers.get('Content-Disposition') || '';
      need(cd.indexOf(rec.reqNo + '.xlsx') > -1, '文件名应为 reqNo.xlsx，实际 ' + cd);
    }
    return nw.reqNo + '.xlsx ／ ' + old.reqNo + '.xlsx';
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
  await step('plans', '施工资料压缩包：上传 → 替换 → 校验拒绝 → 下载 → 删除（单包 ≤1MB）', async () => {
    const p = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟压缩包计划', planType: '周计划' } }), 'plan POST');
    need(p && p.id, '响应缺少 id');
    const up = async (buf, filename) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), filename);
      const res = await fetch(base + '/api/workPlans/' + p.id + '/package', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(10000)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data };
    };
    // 1) zip 上传：记录形状
    const zip1 = Buffer.from('PK\u0003\u0004smoke-zip-one');
    const r1 = await up(zip1, '冒烟资料包.zip');
    need(r1.status === 200 && r1.data && r1.data.id, 'zip 上传失败：' + r1.status + ' ' + brief(r1.data));
    const pk = r1.data;
    need(/^pk/.test(pk.id), 'id 前缀应为 pk，实际 ' + brief(pk.id));
    need(pk.category === '资料压缩包', 'category 不符：' + brief(pk.category));
    need(pk.name === '冒烟资料包.zip', 'name 不符：' + brief(pk.name));
    need(pk.size === zip1.length, 'size 应为 ' + zip1.length + '，实际 ' + brief(pk.size));
    need(String(pk.path).startsWith('uploads/plans/' + p.id + '/'), 'path 不符：' + brief(pk.path));
    need(!!pk.uploadedAt, '缺少 uploadedAt');
    const abs1 = path.join(TMP, 'data', pk.path);
    need(fs.existsSync(abs1), '首次上传的文件应落盘：' + pk.path);
    // 2) 再传 .7Z（大写后缀也要认）→ 记录被替换、旧文件删除
    const seven = Buffer.from('7z\u00bc\u00af\u0027\u001csmoke-seven');
    const r2 = await up(seven, '冒烟资料包.7Z');
    need(r2.status === 200 && r2.data && r2.data.id, '7z 上传失败：' + r2.status + ' ' + brief(r2.data));
    need(r2.data.id !== pk.id, '替换后应返回新记录');
    need(r2.data.name === '冒烟资料包.7Z', '替换后 name 不符：' + brief(r2.data.name));
    need(!fs.existsSync(abs1), '替换后旧包文件应已删除');
    const abs2 = path.join(TMP, 'data', r2.data.path);
    need(fs.existsSync(abs2), '新包文件应存在：' + r2.data.path);
    const d2 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after replace');
    need(d2.materialPackage && d2.materialPackage.id === r2.data.id, '记录未指向新包');
    // 3) 下载拿到新文件字节
    const dl = await fetch(base + '/api/workPlans/' + p.id + '/package/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl.status === 200, '下载期望 200，实际 ' + dl.status);
    const got = Buffer.from(await dl.arrayBuffer());
    need(got.length === seven.length && got.equals(seven), '下载内容与上传不一致');
    // 4) 后缀不合规 → 400，旧包记录与文件逐字节不变
    const r3 = await up(Buffer.from('not a package'), '说明.txt');
    need(r3.status === 400, '.txt 期望 400，实际 ' + r3.status + ' ' + brief(r3.data));
    const d3 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after txt');
    need(d3.materialPackage && d3.materialPackage.id === r2.data.id, '.txt 被拒后记录被改动');
    need(fs.existsSync(abs2) && fs.readFileSync(abs2).equals(seven), '.txt 被拒后旧包文件变了');
    // 5) 超过 1MB → 400，旧包同样不变
    const big = Buffer.alloc(1024 * 1024 + 1, 0x41);
    const r4 = await up(big, '超大包.zip');
    need(r4.status === 400, '>1MB 期望 400，实际 ' + r4.status + ' ' + brief(r4.data));
    const d4 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after big');
    need(d4.materialPackage && d4.materialPackage.id === r2.data.id, '>1MB 被拒后记录被改动');
    need(fs.existsSync(abs2) && fs.readFileSync(abs2).equals(seven), '>1MB 被拒后旧包文件变了');
    // 6) 删除 → 记录置 null、文件删除、下载 404；无包再删 404
    needOk(await api('DELETE', '/api/workPlans/' + p.id + '/package', { token }), 'package DELETE');
    const d5 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after delete');
    need(d5.materialPackage === null, '删除后应置 null，实际 ' + brief(d5.materialPackage));
    need(!fs.existsSync(abs2), '删除后磁盘文件应已移除');
    const dl2 = await fetch(base + '/api/workPlans/' + p.id + '/package/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl2.status === 404, '删除后下载应 404，实际 ' + dl2.status);
    const del2 = await api('DELETE', '/api/workPlans/' + p.id + '/package', { token });
    need(del2.status === 404, '无包删除应 404，实际 ' + del2.status);
    return 'zip→' + pk.id + ' / 7z 替换→' + r2.data.id + '（旧文件已删）/ 400x2 旧包不变 / 删除后 404';
  });
  await step('plans', '现场勘察记录：分组/小组往返 → createdAt 稳定 → 非法 grouping 回落 → groups 截断 → 4.3 环境描述+危险点往返 → 4.4 措施/接地线/勘察日期+逐行归属 → 404', async () => {
    const p = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟勘察计划', planType: '周计划', content: '冒烟工作内容', outageRange: '冒烟停电范围', team: '施工一队', surveyNo: '202610900' }
    }), 'plan POST');
    const before = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail');
    need(before.survey === undefined || before.survey === null, '新建计划不应已有 survey');
    const G1 = { leader: '小张', members: ['小张', '小王'], workLocation: '1 号杆', workTask: '立杆' };
    const G2 = { leader: '小李', members: ['小李'], workLocation: '2 号杆', workTask: '放线' };
    const body1 = {
      grouping: '分2个小组', surveyUnit: ' 冒烟勘察单位 ',
      team: '施工一队', surveyNo: '202610900', dualName: '10kV 冒烟线 001 号杆',
      workLocation: '冒烟工作地点', workTask: '冒烟工作内容',
      outageScope: '冒烟停电范围', retainedLive: '冒烟带电部位',
      groups: [G1, G2]
    };
    const s1 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body1 }), 'survey PUT');
    need(s1 && s1.createdAt && s1.updatedAt, '保存结果缺少 createdAt/updatedAt');
    need(s1.grouping === '分2个小组', 'grouping 未保存：' + JSON.stringify(s1.grouping));
    need(s1.surveyUnit === '冒烟勘察单位', '勘察单位应去空白：' + JSON.stringify(s1.surveyUnit));
    need(s1.team === '施工一队' && s1.surveyNo === '202610900', '部门/编号未保存（本批起落库）');
    need(s1.workLocation === '冒烟工作地点' && s1.workTask === '冒烟工作内容', '工作地点/工作内容未保存');
    need(s1.outageScope === '冒烟停电范围' && s1.retainedLive === '冒烟带电部位', '4.1/4.2 未保存');
    need(Array.isArray(s1.groups) && s1.groups.length === 2, 'groups 应为 2 条，实际 ' + brief(s1.groups));
    need(JSON.stringify(s1.groups[0]) === JSON.stringify(G1) && JSON.stringify(s1.groups[1]) === JSON.stringify(G2), 'groups 往返不一致：' + brief(s1.groups));
    // 本批不预建 4.4 及以后的空字段（hazardPoints 未传也不建）
    ['opsMeasures', 'teamMeasures', 'commonMeasures', 'ground10', 'ground04', 'surveyDate', 'recorder', 'hazardPoints']
      .forEach(k => need(s1[k] === undefined, '不应预建空字段 ' + k));
    need(s1.envDesc === '', 'envDesc 属白名单字段，未传应为空串，实际 ' + JSON.stringify(s1.envDesc));
    const createdAt = s1.createdAt;
    const d1 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after survey');
    need(d1.survey && JSON.stringify(d1.survey.groups) === JSON.stringify(s1.groups), '重读计划时 groups 不一致');
    need(d1.survey.surveyNo === '202610900' && d1.survey.workLocation === '冒烟工作地点', '重读计划时字段丢失');
    // 本批口径：编辑器存的编号是「部门+编号」的完整编号，PUT 原样往返（服务端不重复拼前缀）；
    // 3.工作任务合并成一个框后，workLocation 一律提交空串 → 落库为空（旧值一次性并入 workTask）
    const fullNo = '施工一队202610900';
    const sFull = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body1, surveyNo: fullNo, workLocation: '' } }), '完整编号往返');
    need(sFull.surveyNo === fullNo, '完整编号应原样往返，实际 ' + JSON.stringify(sFull.surveyNo));
    need(sFull.workLocation === '', 'workLocation 传空串应落库为空，实际 ' + JSON.stringify(sFull.workLocation));
    // 勘察单位改为可筛选 + 自定义输入的下拉：选项清单外的自定义值必须原样往返、不被清洗
    const customUnit = '自定义勘察单位（选项里没有）/ 二分队';
    const sUnit = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body1, surveyUnit: customUnit } }), '自定义勘察单位往返');
    need(sUnit.surveyUnit === customUnit, '自定义勘察单位应原样保存，实际 ' + JSON.stringify(sUnit.surveyUnit));
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body1 }), '勘察单位回填');
    // 二次 PUT：改分组数与内容，createdAt 不变
    const G3 = { leader: '小赵', members: [], workLocation: '3 号杆', workTask: '紧线' };
    const body2 = { ...body1, grouping: '分3个小组', surveyUnit: '改后单位', groups: [G1, G2, G3] };
    const s2 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body2 }), 'survey PUT 2');
    need(s2.createdAt === createdAt, '二次保存 createdAt 应保持不变（' + createdAt + ' → ' + s2.createdAt + '）');
    need(s2.updatedAt >= createdAt, 'updatedAt 应刷新');
    need(s2.grouping === '分3个小组' && s2.groups.length === 3 && s2.surveyUnit === '改后单位', '二次保存内容不符');
    // grouping 非法值 → 回落「不分小组」
    const s3 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, grouping: '分5个小组' } }), 'grouping 非法');
    need(s3.grouping === '不分小组', '非法 grouping 应回落「不分小组」，实际 ' + JSON.stringify(s3.grouping));
    // groups 传 4 条 → 只保留前 3 条
    const s4 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, groups: [G1, G2, G3, { leader: '多余', members: ['多余'], workLocation: '4 号杆', workTask: '多余' }] } }), 'groups 截断');
    need(s4.groups.length === 3, 'groups 应截断到 3 条，实际 ' + s4.groups.length);
    need(JSON.stringify(s4.groups) === JSON.stringify([G1, G2, G3]), '截断后应是前 3 条：' + brief(s4.groups));
    // 4.4 及以后：显式传则更新；未传则沿用已存值（界面未开启，数据不能丢）
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, envDesc: '已存环境描述', recorder: '已存记录人' } }), '写入 4.3');
    const s5 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body2 }), '不传 4.3');
    need(s5.envDesc === '', 'envDesc 未传应按空串处理（白名单字段），实际 ' + JSON.stringify(s5.envDesc));
    need(s5.recorder === '已存记录人', '未传的 4.4 字段应沿用旧值，实际 ' + brief(s5.recorder));
    // 4.3 危险点条目组：envDesc + hazardPoints 往返一致（去空白、scope 原样）
    const HP1 = { id: 'hz_a', hazardId: 'lib_1', title: ' 高空坠落风险 ', situation: ' 杆上作业 ', measure: ' 正确使用安全带 ', scope: '2小组' };
    const HP2 = { id: 'hz_b', hazardId: '', title: '自定义危险点', situation: '', measure: '自定义措施', scope: '全组' };
    const s6 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, envDesc: ' 现场有跨越，邻近 10kV 线路\n需停电 ', hazardPoints: [HP1, HP2] }
    }), '写入 4.3 危险点');
    need(s6.envDesc === '现场有跨越，邻近 10kV 线路\n需停电', 'envDesc 应去首尾空白并保留换行：' + JSON.stringify(s6.envDesc));
    need(Array.isArray(s6.hazardPoints) && s6.hazardPoints.length === 2, 'hazardPoints 应为 2 条，实际 ' + brief(s6.hazardPoints));
    need(s6.hazardPoints[0].title === '高空坠落风险' && s6.hazardPoints[0].measure === '正确使用安全带' && s6.hazardPoints[0].situation === '杆上作业',
      '危险点字段未去空白：' + brief(s6.hazardPoints[0]));
    need(s6.hazardPoints[0].hazardId === 'lib_1' && s6.hazardPoints[0].id === 'hz_a', '危险点 id/hazardId 未原样保留：' + brief(s6.hazardPoints[0]));
    need(s6.hazardPoints[0].scope === '2小组' && s6.hazardPoints[1].scope === '全组', 'scope 往返不一致：' + brief(s6.hazardPoints.map(h => h.scope)));
    // 重读计划：危险点组原样返回
    const d6 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after 4.3');
    need(JSON.stringify(d6.survey.hazardPoints) === JSON.stringify(s6.hazardPoints), '重读计划时危险点不一致：' + brief(d6.survey.hazardPoints));
    // 非法 scope → 回落「全组」；缺 id → 自动生成 hz 前缀
    const s7 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, hazardPoints: [{ title: 'A', measure: 'B', scope: '9小组' }] }
    }), '非法 scope');
    need(s7.hazardPoints[0].scope === '全组', '非法 scope 应回落「全组」，实际 ' + JSON.stringify(s7.hazardPoints[0].scope));
    need(/^hz/.test(String(s7.hazardPoints[0].id)), '缺 id 时应自动生成 hz 前缀 id，实际 ' + s7.hazardPoints[0].id);
    // 措施为空 → 400，文案指出第几条
    const badM = await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, hazardPoints: [{ title: 'A', measure: 'B' }, { title: 'C', measure: '  ' }] }
    });
    need(badM.status === 400, '措施为空应 400，实际 ' + badM.status);
    need(String((badM.data && badM.data.error) || '').indexOf('第 2 条') > -1, '400 文案应指出第 2 条，实际 ' + brief(badM.data));
    // 标题为空 → 400
    const badT = await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, hazardPoints: [{ title: '', measure: 'B' }] }
    });
    need(badT.status === 400, '标题为空应 400，实际 ' + badT.status);
    need(String((badT.data && badT.data.error) || '').indexOf('第 1 条') > -1, '400 文案应指出第 1 条，实际 ' + brief(badT.data));
    // 51 条 → 截断到 50 条
    const many = Array.from({ length: 51 }, (_, i) => ({ title: '危险点' + i, measure: '措施' + i }));
    const s8 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, hazardPoints: many } }), '超 50 条');
    need(s8.hazardPoints.length === 50, 'hazardPoints 应截断到 50 条，实际 ' + s8.hazardPoints.length);
    need(s8.hazardPoints[49].title === '危险点49', '截断后应是前 50 条，第 50 条为 ' + s8.hazardPoints[49].title);
    // 4.4 / 接地线 / 勘察日期：本批新字段往返（去首尾空白、保留换行、非法 scope 回落「全组」）
    const s9 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: {
        ...body2,
        opsMeasures: ' 运维措施A\n运维措施B ', teamMeasures: '班组措施1\n班组措施2',
        ground10: '10kV 1号杆', ground04: '0.4kV 配电箱',
        teamMeasureScopes: ['1小组', '9小组'], ground10Scopes: ['2小组'], ground04Scopes: [],
        surveyDate: '2026-10-26'
      }
    }), '写入 4.4');
    need(s9.opsMeasures === '运维措施A\n运维措施B', 'opsMeasures 应去首尾空白并保留换行：' + JSON.stringify(s9.opsMeasures));
    need(s9.teamMeasures === '班组措施1\n班组措施2' && s9.ground10 === '10kV 1号杆' && s9.ground04 === '0.4kV 配电箱',
      '4.4/接地线文本未保存：' + brief([s9.teamMeasures, s9.ground10, s9.ground04]));
    need(JSON.stringify(s9.teamMeasureScopes) === JSON.stringify(['1小组', '全组']), '非法 scope 应回落「全组」：' + brief(s9.teamMeasureScopes));
    need(JSON.stringify(s9.ground10Scopes) === JSON.stringify(['2小组']) && JSON.stringify(s9.ground04Scopes) === JSON.stringify([]),
      '接地线 scopes 往返不一致：' + brief([s9.ground10Scopes, s9.ground04Scopes]));
    need(s9.surveyDate === '2026-10-26', 'surveyDate 未保存：' + brief(s9.surveyDate));
    // 重读计划：4.4 全字段原样
    const d9 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after 4.4');
    need(d9.survey.surveyDate === '2026-10-26' && d9.survey.ground10 === '10kV 1号杆'
      && JSON.stringify(d9.survey.teamMeasureScopes) === JSON.stringify(['1小组', '全组']), '重读计划时 4.4 字段不一致');
    // 未传 scopes / 4.4 文本 → 沿用旧值
    const s10 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2 } }), '不传 4.4');
    need(JSON.stringify(s10.teamMeasureScopes) === JSON.stringify(['1小组', '全组']), '未传 scopes 应沿用旧值：' + brief(s10.teamMeasureScopes));
    need(s10.opsMeasures === '运维措施A\n运维措施B' && s10.surveyDate === '2026-10-26', '未传的 4.4 字段应沿用旧值：' + brief([s10.opsMeasures, s10.surveyDate]));
    // 勘察日期格式非法 → 400（且不破坏已存内容）
    for (const badDay of ['2026-13-01', '2026-02-30', '20261026', '2026/10/26', 'abc']) {
      const r = await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, surveyDate: badDay } });
      need(r.status === 400, '非法勘察日期 ' + badDay + ' 应 400，实际 ' + r.status);
    }
    const d10 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after bad date');
    need(d10.survey.surveyDate === '2026-10-26', '非法日期被拒后原值不应改变，实际 ' + brief(d10.survey.surveyDate));
    // scopes 超 200 条 → 截断
    const manyScopes = Array.from({ length: 205 }, () => '1小组');
    const s11 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, teamMeasureScopes: manyScopes } }), 'scopes 超 200');
    need(s11.teamMeasureScopes.length === 200, 'scopes 应截断到 200 条，实际 ' + s11.teamMeasureScopes.length);
    // 显式传空数组 → 清空
    const s12 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, teamMeasureScopes: [] } }), 'scopes 清空');
    need(Array.isArray(s12.teamMeasureScopes) && s12.teamMeasureScopes.length === 0, '显式传空数组应清空，实际 ' + brief(s12.teamMeasureScopes));
    // 本批口径：surveyNo 里存的就是「部门+编号」完整编号，原样往返、不再二次拼
    const sNo = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, surveyNo: '施工一队202610900' } }), '完整编号往返');
    need(sNo.surveyNo === '施工一队202610900', '完整编号应原样保存，实际 ' + brief(sNo.surveyNo));
    // 3.工作任务合并后 workLocation 一律置空
    const sLoc = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, workLocation: '', workTask: '合并后的工作任务' } }), 'workLocation 置空');
    need(sLoc.workLocation === '' && sLoc.workTask === '合并后的工作任务', 'workLocation 应置空、workTask 独立保存：' + brief([sLoc.workLocation, sLoc.workTask]));
    // 计划不存在 → 404
    const r404 = await api('PUT', '/api/workPlans/nope_not_exist/survey', { token, body: body1 });
    need(r404.status === 404, '计划不存在应 404，实际 ' + r404.status);
    return 'createdAt 稳定 ' + createdAt + '；分组/小组往返一致、非法分组回落、groups 截断到 3、4.3 环境描述+危险点往返、4.4 两组措施+接地线+勘察日期往返、scopes 清洗/截断、非法日期 400、必填 400、超 50 条截断、完整编号往返、workLocation 置空';
  });
  await step('plans', '周计划无「班组应采取的安全措施」字段（撤掉历史误加）→ 新建计划保存体/落库均无该键 → 4.4 班组措施固定取模板标准文案', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/plans.js'), 'utf8');
    // ① 周计划表单不再有该字段（含其 placeholder）
    need(src.indexOf('label="班组应采取的安全措施"') < 0, '周计划表单不应再有「班组应采取的安全措施」字段');
    // ② 保存体显式剔除该键：老记录带值也不回写（新增/编辑 + 复制 两条写入路径都要剔除）
    need((src.match(/delete body\.teamSafetyMeasures/g) || []).length >= 2, '计划保存/复制两条写入路径都应剔除 teamSafetyMeasures');
    // ③ 勘察带入不再读计划该字段，固定取模板标准文案
    need(!/p\.teamSafetyMeasures/.test(src), 'surveySeed 不应再读 plan.teamSafetyMeasures');
    need(/teamMeasures:\s*SV_TEAM_MEASURES_DEFAULT/.test(src), '4.4 班组措施应固定取模板标准文案');
    // ④ 接口侧：不带该键新建 → 落库对象里没有这个属性
    const pNo = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟无班组措施计划', planType: '周计划' } }), 'plan POST 无班组措施');
    need(!('teamSafetyMeasures' in pNo), '新建计划落库不应带 teamSafetyMeasures：' + JSON.stringify(pNo.teamSafetyMeasures));
    // ⑤ 存量假值：库里的旧值保留不动（不删不迁移），但不参与任何带入
    const pFake = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟假值计划', planType: '周计划', teamSafetyMeasures: '假值：不应带入' }
    }), 'plan POST 假值');
    need(pFake.teamSafetyMeasures === '假值：不应带入', '存量历史值应留在库里不动（不删不迁移）');
    return '表单无该字段、保存体剔除该键、落库无该键、带入固定标准文案、存量值保留不迁移';
  });
  await step('plans', '生成资料：无 survey → 400 → 生成勘察记录 docx（空槽保留 XXXX / 接地线并入通用风险 / 多行逐段）→ 再生成 +1 → 下载 PK → 删除后文件同消/404', async () => {
    const me = needOk(await api('GET', '/api/me', { token }), 'me');
    const recName = me.user.name;
    const p = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟生成计划', planType: '周计划', team: '施工一队', surveyNo: '202610001', teamLeader: '冒烟班组长' }
    }), 'plan POST');
    // 1) 未勘察 → 400
    const r0 = await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token });
    need(r0.status === 400, '无 survey 应 400，实际 ' + r0.status + ' ' + brief(r0.data));
    need(String((r0.data && r0.data.error) || '').indexOf('请先完成现场勘察记录') > -1, '400 文案不符：' + brief(r0.data));
    // 2) 上传勘察记录模板（17 处 XXXX 的最小 docx）→ 自动关联 surveyTemplate
    const tplXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + Array.from({ length: 17 }, () => '<w:p><w:r><w:t xml:space="preserve">XXXX</w:t></w:r></w:p>').join('')
      + '</w:body></w:document>';
    const tpl = buildStoreZip([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
      { name: 'word/document.xml', data: Buffer.from(tplXml) }
    ]);
    const fdT = new FormData();
    fdT.append('file', new Blob([tpl], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '冒烟现场勘察记录模板.docx');
    const upT = await fetch(base + '/api/documents/template/replace', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fdT, signal: AbortSignal.timeout(10000)
    });
    need(upT.status === 200, '模板上传失败：' + upT.status + ' ' + brief(await upT.text().catch(() => '')));
    // 3) 填勘察 → 生成
    const svBody = {
      grouping: '分2个小组', surveyUnit: '冒烟供电所', team: '佛荫供电所', surveyNo: '202610001',
      dualName: '10kV 冒烟线 12 号杆', workLocation: '总地点', workTask: '总内容',
      outageScope: '停电范围', retainedLive: '带电部位',
      groups: [{ workLocation: '1 号杆', workTask: '立杆' }, { workLocation: '2 号杆', workTask: '放线' }],
      envDesc: '现场有跨越，邻近 10kV 线路',
      hazardPoints: [
        { title: '高空坠落风险', situation: '杆上作业', measure: '正确使用安全带' },
        { title: '物体打击风险', situation: '', measure: '戴安全帽' }
      ],
      opsMeasures: '运维措施', teamMeasures: '班组措施1\n班组措施2',
      ground10: '12 号杆', ground04: '配变低压侧',
      teamMeasureScopes: ['1小组', '全组'], ground10Scopes: ['2小组'], ground04Scopes: ['全组'],
      surveyDate: '2026-10-19'
    };
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: svBody }), 'survey PUT');
    const gf1 = needOk(await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token }), 'generate');
    need(/^gf/.test(String(gf1.id)), 'id 前缀应为 gf，实际 ' + brief(gf1.id));
    need(gf1.category === '现场勘察记录' && gf1.name === '现场勘察记录.docx', '类别/文件名不符：' + brief(gf1));
    need(String(gf1.path).startsWith('uploads/plans/' + p.id + '/'), 'path 不符：' + brief(gf1.path));
    need(/现场勘察记录\.docx$/.test(String(gf1.path)), '磁盘名应保留原文件名：' + gf1.path);
    need(gf1.size > 0 && !!gf1.uploadedAt, 'size/uploadedAt 不符：' + brief(gf1));
    const absG = path.join(TMP, 'data', gf1.path);
    need(fs.existsSync(absG), '生成文件应落盘：' + gf1.path);
    // 4) 产物内容：空槽保留 XXXX、接地线进通用风险槽、多行逐段
    const gxml = unzipEntry(fs.readFileSync(absG), 'word/document.xml').toString('utf8');
    // 段落级文本（逐段 <w:p> 内的 w:t 拼接）——逐行成段靠它断言
    const paras = [...gxml.matchAll(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g)]
      .map(m => [...m[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => x[1]).join(''));
    const gt = paras.join('|');
    // 4a) 空槽保留模板 XXXX：本 fixture 只有槽位 13（4.5 附图与说明）为空 → 恰好 1 处
    need((gxml.match(/XXXX/g) || []).length === 1,
      '空槽应保留 XXXX（本 fixture 只 4.5 附图与说明为空，应恰 1 处），实际 ' + (gxml.match(/XXXX/g) || []).length);
    const p45 = paras.findIndex(t => t === 'XXXX');
    need(p45 > -1, '槽位13 应保留 XXXX 而非被替换为空');
    // 4b) 填了的槽位正常落值
    need(gt.indexOf('冒烟供电所') > -1, '槽位1 勘察单位缺失');
    need(gt.indexOf('佛荫供电所202610001') > -1, '槽位3 编号应为「部门+编号」拼法：' + gt.slice(0, 160));
    need(gt.indexOf('1小组：立杆') > -1 && gt.indexOf('2小组：放线') > -1, '槽位6 工作内容未按小组拼接');
    // 4b') 槽位5「工作地点」整段不输出（参考文档第 3 项只有工作内容一行）
    need(gt.indexOf('工作地点：') < 0 && gt.indexOf('1小组：1 号杆') < 0, '槽位5 工作地点整段不应输出：' + gt.slice(0, 200));
    // 4c) 多行逐段：4.3 环境描述与两条危险点各自独立成段
    const pe = paras.indexOf('现场有跨越，邻近 10kV 线路');
    need(pe > -1, '槽位9 环境描述缺失');
    need(paras[pe + 1] === '（1）高空坠落风险：杆上作业' && paras[pe + 2] === '（2）物体打击风险',
      '槽位9 应逐行独立成段，实际 ' + brief(paras.slice(pe, pe + 3)));
    // 4d) 班组措施槽只有措施本身（2 行逐段），不再混入接地线
    const pt = paras.indexOf('班组措施1');
    need(pt > -1 && paras[pt + 1] === '班组措施2', '槽位11 班组措施应逐行成段：' + brief(paras.slice(pt, pt + 2)));
    need(gt.indexOf('10kV接地线：') < 0 && gt.indexOf('接地线：') < 0, '槽位11 不应再出现「xx接地线：」行');
    // 4e) 通用风险槽：危险点（1）（2）+ 末条（3）装设接地线的安全措施，10kV/0.4kV 各一段「分别在…验明…」
    const pg = paras.indexOf('（3）装设接地线的安全措施');
    need(pg > -1, '槽位12 接地线条目缺失（2 条危险点时应为（3））：' + brief(paras.filter(t => t.indexOf('装设接地线') > -1)));
    need(paras[pg + 1] === '分别在' && paras[pg + 2] === '12 号杆（2小组）'
      && paras[pg + 3] === '验明确无电压后装设10kV接地线各一组。',
      '接地线 10kV 段结构不符：' + brief(paras.slice(pg, pg + 4)));
    need(paras[pg + 4] === '分别在' && paras[pg + 5] === '配变低压侧'
      && paras[pg + 6] === '验明确无电压后装设0.4kV接地线各一组。',
      '接地线 0.4kV 段结构不符：' + brief(paras.slice(pg + 4, pg + 7)));
    need(gt.indexOf('（1）高空坠落风险的安全措施：正确使用安全带') > -1, '槽位12 通用措施未组装');
    // 4g) 日期与记录人
    need(gt.indexOf('|2026|10|19') > -1, '槽位15-17 勘察日期应为 2026/10/19 三个数字槽：' + gt.slice(-60));
    need(gt.indexOf('|冒烟班组长') > -1, '槽位14 记录人应默认取计划班组长（冒烟班组长），实际 ' + gt.slice(-40));
    need(gt.indexOf('|' + recName) < 0, '槽位14 不应再用当前登录用户（' + recName + '）');
    // 4b) 槽位5「工作地点」整段不输出：改计划地址后产物里也不应出现该行；槽位6 仍按小组拼工作内容
    needOk(await api('PUT', '/api/workPlans/' + p.id, { token, body: { address: '冒烟作业地址' } }), 'plan address PUT');
    needOk(await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token }), 'generate after address');
    const gtA = [...unzipEntry(fs.readFileSync(absG), 'word/document.xml').toString('utf8')
      .matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('|');
    need(gtA.indexOf('冒烟作业地址') < 0, '槽位5 工作地点整段不应输出（计划地址也不应出现）：' + gtA.slice(0, 160));
    need(gtA.indexOf('1小组：立杆') > -1 && gtA.indexOf('2小组：放线') > -1, '槽位6 工作内容仍应按小组拼接');
    // 5) 改一处内容再生成 → 原地覆盖同一份，不新增勘察单
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: Object.assign({}, svBody, { envDesc: '现场有跨越，邻近 10kV 线路（改）', opsMeasures: '' })
    }), 'survey PUT 2');
    const gf2 = needOk(await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token }), 'generate 2');
    need(gf2.id === gf1.id, '再次生成应复用同一条记录，实际 ' + brief(gf1.id) + ' → ' + brief(gf2.id));
    need(gf2.updated === true, '再次生成应回 updated=true，实际 ' + brief(gf2.updated));
    const d = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after generate');
    need(Array.isArray(d.generatedFiles) && d.generatedFiles.length === 1,
      '再次生成后应仍只有 1 条（覆盖不新增），实际 ' + brief(d.generatedFiles && d.generatedFiles.length));
    need(d.generatedFiles[0].path === gf1.path, '覆盖生成不应更换磁盘路径：' + brief(d.generatedFiles[0].path));
    const gxml2 = unzipEntry(fs.readFileSync(absG), 'word/document.xml').toString('utf8');
    // 槽位10 运维措施清空后：替换为空白而不是保留 XXXX（全长仍只 4.5 那 1 处 XXXX）
    need((gxml2.match(/XXXX/g) || []).length === 1,
      '槽位10 空值应替换为空白（XXXX 总数仍应为 1），实际 ' + (gxml2.match(/XXXX/g) || []).length);
    need(gxml2.indexOf('运维措施') < 0, '槽位10 清空后不应残留旧值');
    need(gxml2.indexOf('现场有跨越，邻近 10kV 线路（改）') > -1, '覆盖生成后产物未反映最新内容');
    need(gxml2.indexOf('现场有跨越，邻近 10kV 线路') === gxml2.indexOf('现场有跨越，邻近 10kV 线路（改）'), '旧内容应被覆盖而非追加');
    // 6) 下载拿到 docx（PK 头）
    const dl = await fetch(base + '/api/workPlans/' + p.id + '/generated/' + gf1.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl.status === 200, '下载期望 200，实际 ' + dl.status);
    const buf = Buffer.from(await dl.arrayBuffer());
    need(buf[0] === 0x50 && buf[1] === 0x4b, '下载内容不是 docx（缺 PK 头）');
    // 7) 删除：记录与文件同消，再下载 404
    needOk(await api('DELETE', '/api/workPlans/' + p.id + '/generated/' + gf1.id, { token }), 'generated DELETE');
    need(!fs.existsSync(absG), '删除后磁盘文件应同时删除');
    const d2 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after delete');
    need(d2.generatedFiles.length === 0, '删除后应没有生成记录：' + brief(d2.generatedFiles.map(x => x.id)));
    const dl2 = await fetch(base + '/api/workPlans/' + p.id + '/generated/' + gf1.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl2.status === 404, '删除后下载应 404，实际 ' + dl2.status);
    return '空槽保留 XXXX（仅 4.5 1 处）/ 运维空值置空 / 工作地点整段不输出 / 编号拼法 / 工作内容按小组拼 / 4.3 与通用风险逐行成段 / 接地线并入通用风险（N+1 编号 + 分别在/逐行/验明…）/ 日期 2026-10-19 / 记录人 ' + recName + ' / 重复生成原地覆盖（1 条）/ 删除后清空';
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
