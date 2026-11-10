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
const xlsx = require('xlsx');                                          // 读导出 xlsx 校验表头/合并
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
  await step('基础', '服务器时间基准 GET /api/server-time（北京时间 UTC+8）', async () => {
    const r = await fetch(base + '/api/server-time');
    need(r.status === 200, '状态码 ' + r.status);
    need(/no-store/i.test(r.headers.get('cache-control') || ''), '缺少 no-store 缓存头');
    const d = await r.json();
    need(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.now || ''), 'now 格式不符：' + d.now);
    need(d.tzOffsetMinutes === 480 && d.timeZone === 'Asia/Shanghai', '时区参数不符：' + brief(d));
    need(Math.abs(Date.now() - Number(d.ts)) < 5 * 60 * 1000, 'ts 与本机偏差过大：' + d.ts);
    const t = new Date(Number(d.ts) + 480 * 60000);
    const p2 = n => String(n).padStart(2, '0');
    const expect = t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes());
    need(d.now.slice(0, 16) === expect, 'now 与 ts 换算不一致：' + d.now + ' vs ' + expect);
    const pc = needOk(await api('GET', '/api/public-config'), 'public-config');
    need(Number(pc.serverTs) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(pc.serverDate || ''), 'public-config 缺少 serverTs/serverDate');
    return d.now + ' · ' + d.timeZone;
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
      token, body: { name: '张三', idNumber: '510301199001010053', phone: '13800138000', role: '技工（计入高处作业人员）', team: '冒烟班组' }
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
  // 领料单号定版格式：LL-YYYYMMDD-NNNN（4 位当日流水，从 0001 起）；无前缀写法只作为历史测试期格式参与排序解析
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
  await step('materials', '领料单号定版：当日首单 LL-YYYYMMDD-0001（4 位流水，无前缀/昨日单均不计入推导）', async () => {
    // 干扰项：历史无前缀写法（不匹配 LL-<今日>- 前缀）、昨日 LL- 单（日期不同）
    await insertReq(TODAY + '-005');
    await insertReq('LL-' + YDAY + '-005');
    const n1 = await mkReq(1);
    need(/^LL-\d{8}-\d{4}$/.test(n1), '单号格式应为 LL-YYYYMMDD-NNNN，实际 ' + n1);
    need(n1 === 'LL-' + TODAY + '-0001', '当日首单应为 LL-' + TODAY + '-0001，实际 ' + n1);
    const n2 = await mkReq(1);
    need(n2 === 'LL-' + TODAY + '-0002', '次单应为 LL-' + TODAY + '-0002，实际 ' + n2);
    reqNoNew = n2;
    return n1 + ' → ' + n2 + '（已插入 ' + TODAY + '-005 与 LL-' + YDAY + '-005 作干扰）';
  });
  await step('materials', '领料单号当日超 9999 位数自然增长（不报错、不截断）', async () => {
    await insertReq('LL-' + TODAY + '-9999');
    const n = await mkReq(1);
    need(n === 'LL-' + TODAY + '-10000', '应自然增长为 LL-' + TODAY + '-10000，实际 ' + n);
    return n;
  });
  await step('materials', '单号排序：日期升序 → 流水组（数值）→ 6 位时间组 → 无法识别', async () => {
    const D = TODAY;
    // 流水组：0001(1) 0002(2) 003(3) 999(1000) 1000；时间组：222544；再加无前缀写法与脏号
    const mixed = ['LL-' + D + '-0002', D + '-1000', 'X-无法识别', 'LL-' + D + '-222544', D + '-999', 'LL-' + D + '-0001', D + '-003'];
    const want = ['LL-' + D + '-0001', 'LL-' + D + '-0002', D + '-003', D + '-999', D + '-1000', 'LL-' + D + '-222544', 'X-无法识别'];
    const got = mixed.slice().sort((a, b) => MaterialNo.cmp(a, b));
    need(JSON.stringify(got) === JSON.stringify(want), '同日混合排序不符\n      实际：' + got.join(' , ') + '\n      期望：' + want.join(' , '));
    // 跨日：昨日单号整体排在今日之前
    const cross = ['LL-' + D + '-001', 'LL-' + YDAY + '-005'].sort((a, b) => MaterialNo.cmp(a, b));
    need(cross[0] === 'LL-' + YDAY + '-005', '跨日应昨日在前，实际 ' + cross.join(' , '));
    return got.join(' , ');
  });
  await step('materials', '历史重编脚本：同日 LL-四位 + LL-六位混合 → 按 createdAt 重编且二次运行不变', async () => {
    const os = require('os');
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqno-mig-'));
    const sample = {
      materialRequisitions: [
        { id: 'b2', reqNo: 'LL-20261024-0002', createdAt: '2026-10-24 13:08', status: '已作废', deleted: false, items: [] },
        { id: 't1', reqNo: 'LL-20261024-123004', createdAt: '2026-10-24 12:30', status: '已作废', deleted: false, items: [] },
        { id: 'a1', reqNo: 'LL-20261024-0001', createdAt: '2026-10-24 13:07', status: '已入库', deleted: false, items: [] },
        { id: 'd1', reqNo: 'LL-20261024-122908', createdAt: '2026-10-24 12:29', status: '已作废', deleted: true, items: [] },
        { id: 'x1', reqNo: '20261028-001', createdAt: '2026-10-28 15:54', status: '待入库', deleted: false, items: [] },
        { id: 'bad', reqNo: '临时单', createdAt: '2026-10-24 09:00', status: '待入库', deleted: false, items: [] }
      ]
    };
    fs.writeFileSync(path.join(tdir, 'db.json'), JSON.stringify(sample, null, 2), 'utf8');
    const scriptPath = path.join(ROOT, 'scripts', 'migrate-reqno-20261028.js');
    const run = () => require('child_process').spawnSync(process.execPath, [scriptPath, '--data', tdir, '--apply'], { encoding: 'utf8' });
    const r1 = run();
    need(r1.status === 0, '首次迁移应成功退出，实际 status=' + r1.status + ' ' + (r1.stderr || ''));
    const after = JSON.parse(fs.readFileSync(path.join(tdir, 'db.json'), 'utf8'));
    const byId = {}; after.materialRequisitions.forEach(r => { byId[r.id] = r; });
    const expect = { d1: 'LL-20261024-001', t1: 'LL-20261024-002', a1: 'LL-20261024-003', b2: 'LL-20261024-004', x1: 'LL-20261028-001', bad: '临时单' };
    Object.keys(expect).forEach(k => need(byId[k] && byId[k].reqNo === expect[k], '记录 ' + k + ' 新号应为 ' + expect[k] + '，实际 ' + (byId[k] && byId[k].reqNo)));
    need(byId.d1.deleted === true && byId.d1.status === '已作废', '已删除记录的状态/删除标记不应被改动');
    need(after.materialRequisitions.length === sample.materialRequisitions.length, '记录数不应变化');
    // 二次运行：应为幂等（无改动）
    const before2 = fs.readFileSync(path.join(tdir, 'db.json'), 'utf8');
    const r2 = run();
    need(r2.status === 0, '二次迁移应成功退出');
    const after2 = fs.readFileSync(path.join(tdir, 'db.json'), 'utf8');
    need(after2 === before2, '二次运行不应改动文件（幂等）');
    need((r2.stdout || '').indexOf('无需写盘') > -1, '二次运行应报告无需写盘，实际：' + (r2.stdout || '').slice(-80));
    fs.rmSync(tdir, { recursive: true, force: true });
    return '5 条重编 + 1 条脏号跳过；二次运行无变化';
  });
  await step('materials', '领料单下载文件名 = reqNo（定版格式）', async () => {
    const list = needOk(await api('GET', '/api/materialRequisitions', { token }), 'requisition list');
    const nw = list.find(r => r.reqNo === reqNoNew);
    need(nw, '列表未包含新生成单号 ' + reqNoNew);
    const res = await fetch(base + '/api/materialRequisitions/' + nw.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(res.ok, '下载应成功：' + nw.reqNo);
    const cd = res.headers.get('Content-Disposition') || '';
    need(cd.indexOf(nw.reqNo + '.xlsx') > -1, '文件名应为 reqNo.xlsx，实际 ' + cd);
    return nw.reqNo + '.xlsx';
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

  /* ---------- 月计划判重口径（纯函数与前端共用） ---------- */
  const monthCalc = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'monthPlans.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.MonthPlanCalc;
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
  await step('plans', '月计划 CRUD 与状态流转（22 字段往返，流转只改 status）', async () => {
    const body = {
      planType: '月计划', status: '未执行', name: '10kV冒烟线01号杆', areaStation: '冒烟供电所',
      opsUnit: '冒烟运维中心', maintUnit: '冒烟检修单位', project: '冒烟工程', projectName: '冒烟工程项目',
      maintDevice: '10kV冒烟线01号杆', voltage: '10kV', deviceType: '配网主线',
      outageStart: '2026-11-11 08:00:00', outageEnd: '2026-11-11 16:00:00',
      workTime: '11月11日-11月11日08:30-15:30', workType: '配农网工程',
      maintContent: '更换绝缘子', affectArea: '冒烟村 1-3 组', transformerCount: '12', outageHouseholds: 96,
      importantUsers: '无', gridRisk: '三级', riskLevel: 'IV', outageCount2m: '1', outageCountYear: '4',
      planNote: '冒烟备注', leader: '小王',
      startDate: '2026-11-11 08:00:00', endDate: '2026-11-11 16:00:00'
    };
    const d = needOk(await api('POST', '/api/workPlans', { token, body }), 'workPlans POST 月计划');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/workPlans/' + d.id, { token }), '月计划详情');
    need(one.planType === '月计划', 'planType 未保存：' + one.planType);
    ['opsUnit', 'maintUnit', 'project', 'projectName', 'maintDevice', 'voltage', 'deviceType', 'outageStart', 'outageEnd',
      'workTime', 'workType', 'maintContent', 'affectArea', 'transformerCount', 'importantUsers', 'gridRisk', 'riskLevel',
      'outageCount2m', 'outageCountYear', 'planNote', 'leader'].forEach(k => {
      need(String(one[k]) === String(body[k]), k + ' 未保存：' + one[k]);
    });
    for (const st of ['已执行', '已结算', '未执行']) {
      needOk(await api('PUT', '/api/workPlans/' + d.id, { token, body: { status: st } }), '状态流转 → ' + st);
      const cur = needOk(await api('GET', '/api/workPlans/' + d.id, { token }), '流转后详情');
      need(cur.status === st, '状态应为 ' + st + '，实为 ' + cur.status);
      need(cur.maintDevice === body.maintDevice && cur.outageStart === body.outageStart, '状态流转改动了其他字段');
    }
    needOk(await api('DELETE', '/api/workPlans/' + d.id, { token }), '删除月计划');
    return '22 字段往返 + 新增 → 已执行 → 已结算 → 未执行 → 删除';
  });

  await step('plans', '月计划表单联动：工作时间同月/跨月生成 + 停电时户数', async () => {
    const same = monthCalc.genWorkTime('2026-11-11 08:00:00', '2026-11-11 16:00:00');
    need(same === '11月11日-11月11日08:30-15:30', '同月生成错：' + same);
    const cross = monthCalc.genWorkTime('2026-10-31 22:00:00', '2026-11-01 06:00:00');
    need(cross === '10月31日-11月1日22:30-05:30', '跨月生成错：' + cross);
    const months = (cross.match(/(\d+)月/g) || []).map(x => Number(x.replace('月', '')));
    need(months.length === 2 && months.every(m => m >= 1 && m <= 12), '跨月拼出非法月份：' + cross + ' → ' + months.join(','));
    need(monthCalc.hours('2026-11-11 08:00', '2026-11-11 16:00') === 8, '时长应为 8 小时');
    need(monthCalc.households(12, '2026-11-11 08:00', '2026-11-11 16:00') === 96, '时户数应为 96');
    need(monthCalc.households(3, '2026-11-11 08:00', '2026-11-11 11:30') === 11, '3×3.5 → 11（四舍五入）');
    need(monthCalc.households('', '2026-11-11 08:00', '2026-11-11 16:00') === '', '配变数为空应存空');
    return same + ' / ' + cross + ' / 96';
  });

  await step('plans', '月计划模板：停电时间文本解析 + 导出（主网/配网两张子表、20 列）', async () => {
    const p1 = monthCalc.parseOutageText('11月1日00:00-11月30日02:00', '2026');
    need(p1 && p1.start === '2026-11-01 00:00:00' && p1.end === '2026-11-30 02:00:00', '连续停电解析错：' + JSON.stringify(p1));
    const p2 = monthCalc.parseOutageText('11月11日08:00-16:00', '2026');
    need(p2 && p2.start === '2026-11-11 08:00:00' && p2.end === '2026-11-11 16:00:00', '同日解析错：' + JSON.stringify(p2));
    const p3 = monthCalc.parseOutageText('11月1日-11月30日19:27-21:27（白停夜送）', '2026');
    need(p3 && p3.start === '2026-11-01 19:27:00' && p3.end === '2026-11-30 21:27:00', '白停夜送解析错：' + JSON.stringify(p3));
    need(monthCalc.parseOutageText('乱写一段', '2026') === null, '无法识别时应返回 null');

    const body = {
      planType: '月计划', status: '未执行', name: '模板导出线', maintDevice: '10kV模板线01号杆',
      deviceType: '配网支线', voltage: '10kV', workType: '配农网工程',
      outageStart: '2026-11-03 00:00:00', outageEnd: '2026-11-05 02:00:00',
      workTime: '11月3日-11月5日00:30-01:30', transformerCount: '5', outageHouseholds: '10', planNote: '模板回归'
    };
    const created = needOk(await api('POST', '/api/workPlans', { token, body }), '模板导出用月计划 POST');
    try {
      const res = await fetch(base + '/api/workPlans/month-plan.xlsx?ids=' + created.id + '&year=2026&month=11',
        { headers: { Authorization: 'Bearer ' + token } });
      need(res.ok, '导出接口应 200，实际 ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      need(buf.slice(0, 2).toString() === 'PK', '导出文件应为 xlsx（zip 头）');
      const wb = xlsx.read(buf, { type: 'buffer' });
      need(wb.SheetNames.join(',') === '主网,配网', '子表应为 主网/配网，实际 ' + wb.SheetNames.join(','));
      const aoa = xlsx.utils.sheet_to_json(wb.Sheets['配网'], { header: 1, defval: '', raw: false });
      need(String(aoa[0][0]).includes('配电设备检修计划（配网）'), '标题行不对：' + aoa[0][0]);
      const head = (aoa[1] || []).map(v => String(v));
      need(head[0] === '序号' && head[7] === '计划停电时间' && head[9] === '检修类型' && head[19] === '备注',
        '表头 20 列不对：' + head.join('|'));
      need(String(aoa[2][0]).includes('总体上按时间排序'), '说明行缺失：' + aoa[2][0]);
      need(String(aoa[3][0]) === '1' && String(aoa[3][7]) === '11月3日00:00-11月5日02:00',
        '数据行不对：' + JSON.stringify((aoa[3] || []).slice(0, 8)));
      return '标题/20列表头/说明行/数据行 OK → ' + aoa[3][7];
    } finally {
      await api('DELETE', '/api/workPlans/' + created.id, { token });
    }
  });

  await step('plans', '月计划必填校验（4 项必填 + 结束不得早于开始）', async () => {
    const empty = monthCalc.validate({});
    need(empty.maintDevice === '请填写检修设备', '检修设备必填未拦下');
    need(empty.workType === '请选择检修类型', '检修类型必填未拦下');
    need(empty.outageStart === '请选择计划停电开始时间', '停电开始必填未拦下');
    need(empty.outageEnd === '请选择计划停电结束时间', '停电结束必填未拦下');
    const back = monthCalc.validate({
      maintDevice: 'X', workType: '配农网工程',
      outageStart: '2026-11-11 16:00:00', outageEnd: '2026-11-11 08:00:00'
    });
    need(back.outageEnd === '计划停电结束时间不能早于开始时间', '结束早于开始未拦下：' + back.outageEnd);
    const same = monthCalc.validate({
      maintDevice: 'X', workType: '配农网工程',
      outageStart: '2026-11-11 16:00:00', outageEnd: '2026-11-11 16:00:00'
    });
    need(same.outageEnd === '', '结束等于开始应允许（≥），实为：' + same.outageEnd);
    const pass = monthCalc.validate({
      maintDevice: 'X', workType: '配农网工程',
      outageStart: '2026-11-11 08:00:00', outageEnd: '2026-11-11 16:00:00'
    });
    need(Object.values(pass).every(v => !v), '合法表单不应报错');
    return '4 项必填 + 时序校验 OK';
  });

  await step('plans', '月计划导入判重口径（设备+停电开始；含已入库与文件内自重复）', async () => {
    const existing = [
      { maintDevice: 'A', outageStart: '2026-11-01 08:00:00' },
      { maintDevice: 'B', outageStart: '2026-11-02 09:00:00' },
      { maintDevice: 'E', outageStart: '2027-02-01 08:00:00' }
    ];
    const parsed = [
      { maintDevice: 'A', outageStart: '2026-11-01 08:00:00', __row: 2 },
      { maintDevice: 'C', outageStart: '2026-11-03 08:00:00', __row: 3 },
      { maintDevice: 'C', outageStart: '2026-11-03 08:00:00', __row: 4 },
      { maintDevice: 'A', outageStart: '2026-11-01 09:00:00', __row: 5 },
      { maintDevice: 'E', outageStart: '2027-02-01 08:00:00', __row: 6 }
    ];
    monthCalc.judge(parsed, existing, '2026');
    need(parsed[0].verdict === '疑似重复（与已入库第 1 条撞键）', '已入库撞键判定错：' + parsed[0].verdict);
    need(parsed[1].verdict === '新增', '首条不应判重：' + parsed[1].verdict);
    need(parsed[2].verdict === '疑似重复（与本文件第 3 行重复）', '文件内自重复判定错：' + parsed[2].verdict);
    need(parsed[3].verdict === '新增', '停电开始不同不应判重：' + parsed[3].verdict);
    need(parsed[4].verdict === '新增', '跨导入年份不应判重：' + parsed[4].verdict);
    return '已入库 1 / 新增 3 / 自重复 1';
  });

  await step('plans', '周计划导入模板下载 GET /api/workPlans/import-template', async () => {
    const r = await fetch(base + '/api/workPlans/import-template', { headers: { Authorization: 'Bearer ' + token } });
    need(r.status === 200, '状态码 ' + r.status);
    need(/spreadsheetml\.sheet/.test(r.headers.get('content-type') || ''), 'Content-Type 非 xlsx');
    const buf = Buffer.from(await r.arrayBuffer());
    const local = fs.readFileSync(path.join(ROOT, 'assets', 'plan-import-template.xlsx'));
    need(buf.length === local.length, '长度 ' + buf.length + ' ≠ 入仓原件 ' + local.length);
    need(buf.slice(0, 2).toString() === 'PK', '不是 xlsx（zip）文件');
    return buf.length + 'B';
  });
  await step('plans', '周计划导出 GET /api/workPlans/export（48 列 / 两行表头 / 41 合并 / 下拉选项）', async () => {
    const r = await fetch(base + '/api/workPlans/export', { headers: { Authorization: 'Bearer ' + token } });
    need(r.status === 200, '状态码 ' + r.status);
    need(/spreadsheetml\.sheet/.test(r.headers.get('content-type') || ''), 'Content-Type 非 xlsx');
    const buf = Buffer.from(await r.arrayBuffer());
    const wb = xlsx.read(buf, { type: 'buffer' });
    need(wb.SheetNames.length === 1 && wb.SheetNames[0] === 'Sheet1', 'sheet 名应为 Sheet1，实为 ' + wb.SheetNames.join(','));
    const ws = wb.Sheets.Sheet1;
    need(ws['!ref'] && xlsx.utils.decode_range(ws['!ref']).e.c + 1 === 48, '列数应为 48，实为 ' + (ws['!ref'] ? xlsx.utils.decode_range(ws['!ref']).e.c + 1 : '空'));
    need(Array.isArray(ws['!merges']) && ws['!merges'].length === 41, '合并区域应为 41 个，实为 ' + (ws['!merges'] ? ws['!merges'].length : 0));
    need(String(ws.A1.v) === '序号' && String(ws.AN1.v) === '当日计划工作量' && String(ws.AN2.v) === '杆塔（基）', '表头文字不符');
    const rows = xlsx.utils.decode_range(ws['!ref']).e.r + 1;
    const sheetXml = (unzipEntry(buf, 'xl/worksheets/sheet1.xml') || Buffer.from('')).toString();
    const dvCount = (sheetXml.match(/<dataValidation /g) || []).length;
    need(dvCount === 7, '下拉校验应为 7 处（与原表一致），实为 ' + dvCount);
    need(/sqref="H3:H1048576"/.test(sheetXml) && /35kV,10kV,0\.4kV/.test(sheetXml), '电压等级下拉与原表不一致');
    // 口径：scope 页签过滤（临时库无月计划 → scope=month 应为 0 条，未带 scope 至少 1 条）
    const r3 = await fetch(base + '/api/workPlans/export?scope=month', { headers: { Authorization: 'Bearer ' + token } });
    const wb3 = xlsx.read(Buffer.from(await r3.arrayBuffer()), { type: 'buffer' });
    const rows3 = xlsx.utils.decode_range(wb3.Sheets.Sheet1['!ref']).e.r + 1;
    need(rows3 === 2, 'scope=month 应为 0 条数据行，实为 ' + (rows3 - 2));
    need(rows - 2 >= 1, '不带 scope 时应导出全部，实为 ' + (rows - 2));
    return '48 列 / 41 合并 / ' + rows + ' 行 / 下拉 ' + dvCount + ' 处 / scope 过滤 OK / ' + buf.length + 'B';
  });
  await step('plans', '周计划导出 → 回灌判重 + 48 列单行表头模板落位', async () => {
    // 先造一条字段齐全的计划，保证往返有可比对的数据
    const mk = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟回灌计划', planType: '周计划', workType: '配农网工程', team: '施工一队', startDate: '2026-11-02 08:00:00', endDate: '2026-11-03 18:00:00', staffText: '张三/13800000000', voltage: '10kV' }
    }), 'plan POST');
    need(mk && mk.id, '响应缺少 id');
    const r = await fetch(base + '/api/workPlans/export?scope=week', { headers: { Authorization: 'Bearer ' + token } });
    const buf = Buffer.from(await r.arrayBuffer());
    const total = xlsx.utils.decode_range(xlsx.read(buf, { type: 'buffer' }).Sheets.Sheet1['!ref']).e.r + 1;
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'roundtrip.xlsx');
    const up = await fetch(base + '/api/workPlans/import?planType=' + encodeURIComponent('周计划'), { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(15000) });
    const d = await up.json();
    need(up.status === 200 && d && d.ok, '往返导入失败：' + brief(d));
    // 判重后回灌行应全部跳过，且不改动已有记录
    need(d.added === 0 && d.skipped === total - 2,
      '判重应跳过全部 ' + (total - 2) + ' 条回灌行：' + brief(d));
    const again = needOk(await api('GET', '/api/workPlans', { token }), 'list');
    const hit = (Array.isArray(again) ? again : (again.data || [])).filter(p => p.name === '冒烟回灌计划' && !p.deleted);
    need(hit.length === 1 && hit[0].id === mk.id, '判重后不应新增同名计划，实为 ' + hit.length + ' 条');
    const a = hit[0];
    need(a && a.team === '施工一队' && a.startDate === '2026-11-02 08:00:00' && a.staffText === '张三/13800000000',
      '判重跳过后原记录字段被改动：' + brief(a));
    // 内置导入模板已改为 48 列单行表头（与导出逐列同名同序），按表头名称取列验证不错位
    const tplWb = xlsx.read(fs.readFileSync(path.join(ROOT, 'assets', 'plan-import-template.xlsx')), { type: 'buffer' });
    const ts = tplWb.Sheets[tplWb.SheetNames[0]];
    const rng = xlsx.utils.decode_range(ts['!ref']);
    const findCol = nm => {
      for (let R = 0; R <= 1; R++) for (let C = 0; C <= rng.e.c; C++) {
        const c = ts[xlsx.utils.encode_cell({ r: R, c: C })];
        if (c && String(c.v).trim() === nm) return C;
      }
      return -1;
    };
    const put = (nm, v) => {
      const C = findCol(nm);
      need(C >= 0, '模板缺少列：' + nm);
      ts[xlsx.utils.encode_cell({ r: 2, c: C })] = { t: 's', v: String(v) };
    };
    put('作业计划名称', '冒烟模板列位计划'); put('作业类型', '配农网工程');
    put('计划开始时间', '2026-11-09 08'); put('计划结束时间', '2026-11-09 18');   // 只写到小时也应接受
    put('杆塔（基）', '9'); put('停电范围', '模板停电范围');
    put('作业实施（施工）人员（不包含工作负责人）', '甲/13000000001；乙/13000000002');
    put('作业人员（共多少人）', '9');   // 与名单人数冲突时，应以名单为准（导入按名单重算）
    ts['!ref'] = xlsx.utils.encode_range({ s: rng.s, e: { r: 2, c: rng.e.c } });   // 模板原本只有两行表头，写入行后要扩范围
    const tplOut = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(tplOut, ts, tplWb.SheetNames[0]);
    const tplBuf = xlsx.write(tplOut, { type: 'buffer', bookType: 'xlsx' });
    const fd2 = new FormData();
    fd2.append('file', new Blob([tplBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'tpl.xlsx');
    const up2 = await fetch(base + '/api/workPlans/import', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd2, signal: AbortSignal.timeout(15000) });
    const d2 = await up2.json();
    need(up2.status === 200 && d2 && d2.ok, '模板导入失败：' + brief(d2));
    const got = needOk(await api('GET', '/api/workPlans', { token }), 'list');
    const tp = (Array.isArray(got) ? got : (got.data || [])).find(p => p.name === '冒烟模板列位计划');
    need(tp && tp.wlPole === '9' && tp.outageRange === '模板停电范围',
      '48 列模板列位错位：' + brief(tp && { wlPole: tp.wlPole, outageRange: tp.outageRange }));
    need(tp.startDate === '2026-11-09 08:00:00' && tp.endDate === '2026-11-09 18:00:00',
      '只写到小时的时间未补全：' + brief({ s: tp.startDate, e: tp.endDate }));
    need(tp.staffCount === '2', '人数应按施工人员名单重算为 2，实为 ' + tp.staffCount);
    return '判重跳过回灌 ' + d.skipped + ' 条；48 列单行表头模板落位正确';
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
  await step('plans', '周计划无「班组应采取的安全措施」字段（撤掉历史误加）→ 新建计划保存体/落库均无该键 → 4.4 班组措施：二票留空、其余取模板标准文案', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/plans.js'), 'utf8');
    // ① 周计划表单不再有该字段（含其 placeholder）
    need(src.indexOf('label="班组应采取的安全措施"') < 0, '周计划表单不应再有「班组应采取的安全措施」字段');
    // ② 保存体显式剔除该键：老记录带值也不回写（新增/编辑 + 复制 两条写入路径都要剔除）
    need((src.match(/delete body\.teamSafetyMeasures/g) || []).length >= 2, '计划保存/复制两条写入路径都应剔除 teamSafetyMeasures');
    // ③ 勘察带入不再读计划该字段，固定取模板标准文案
    need(!/p\.teamSafetyMeasures/.test(src), 'surveySeed 不应再读 plan.teamSafetyMeasures');
    // 二票：4.4 班组措施留空（不分小组=待填写、分组=每条选小组）；其余票种仍固定取模板标准文案
    need(/teamMeasures:\s*isP2\s*\?\s*''\s*:\s*SV_TEAM_MEASURES_DEFAULT/.test(src), '4.4 班组措施：二票留空、其余取模板标准文案');
    // 二票：4.4 运维措施按规则带入「无」
    need(/opsMeasures:\s*isP2\s*\?\s*SURVEY_P2_OPS_MEASURES/.test(src), '4.4 运维措施：二票规则带入「无」');
    // 线路第二种工作票：沿用二票全部规则（4.1/4.2/4.3/4.4 + 隐藏两种接地线），但不分小组
    need(src.indexOf("const TICKET_LINE_SECOND = '线路：线路第二种工作票'") > -1, '应定义线路第二种工作票常量');
    need(/const isP2 = isSecondLikeTicket\(/.test(src), '二票默认值应覆盖配电二票与线路二票');
    need(/const svSecondTicket = computed\(\(\) => isSecondLikeTicket\(/.test(src), '接地线隐藏规则应覆盖两种二票');
    const noGroupExpr = (src.match(/const svNoGroup = computed\([\s\S]*?\);/) || [''])[0];
    need(/TICKET_LINE_SECOND/.test(noGroupExpr), '线路第二票应不分小组');
    need(/TICKET_LINE_FIRST/.test(noGroupExpr), '线路第一票仍不分小组');
    need(noGroupExpr.indexOf('TICKET_SECOND') === -1, '配电二票应保留分组能力（不得加入 svNoGroup）');
    // ④ 接口侧：不带该键新建 → 落库对象里没有这个属性
    const pNo = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟无班组措施计划', planType: '周计划' } }), 'plan POST 无班组措施');
    need(!('teamSafetyMeasures' in pNo), '新建计划落库不应带 teamSafetyMeasures：' + JSON.stringify(pNo.teamSafetyMeasures));
    // ⑤ 存量假值：库里的旧值保留不动（不删不迁移），但不参与任何带入
    const pFake = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟假值计划', planType: '周计划', teamSafetyMeasures: '假值：不应带入' }
    }), 'plan POST 假值');
    need(pFake.teamSafetyMeasures === '假值：不应带入', '存量历史值应留在库里不动（不删不迁移）');
    return '表单无该字段、保存体剔除该键、落库无该键、二票（配电+线路）4.4 班组留空/运维「无」、线路二票不分小组而配电二票仍可分组、其余沿用标准文案、存量值保留不迁移';
  });
  await step('ui', '表格横向滚动：表头与内容共用同一滚动容器（无 JS 异步追赶）', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    need(css.indexOf('.el-table > .el-table__inner-wrapper { overflow-x:auto !important; overflow-y:hidden !important; }') > -1,
      '应由 .el-table__inner-wrapper 统一承担横向滚动');
    const block = (css.match(/\/\* ===== 表格横向滚动[\s\S]*?\.el-pagination \{ font-weight: 400; \}/) || [''])[0];
    need(/\.el-scrollbar__wrap \{ overflow:visible !important; \}/.test(block)
      && /\.el-table__header-wrapper,/.test(block) && /\.el-table__body-wrapper,/.test(block),
      'header/body/scrollbar wrap 应改为 overflow:visible');
    need(/display:none !important;/.test(block), '失效的 EP 自定义滚动条应隐藏');
    need(css.indexOf('.el-table__body-wrapper, .el-table__header-wrapper { overflow:hidden !important; }') === -1,
      '不得残留移动端「两层 wrapper 各滚各的」旧补丁（会让表头重新慢一拍）');
    return 'inner-wrapper 统一滚动 + 三层 visible + 自定义滚动条隐藏，表头与内容天然同步';
  });
  await step('ui', '材料台账：暂存清单领料总数实时联动 / Tab 跳过移除 / 领料单项目与物料简称完整显示', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/materials.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const vm = require('vm');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/utils.js'), 'utf8'), sandbox);
    const MatName = sandbox.window.MatName;
    need(MatName && typeof MatName.short === 'function', 'utils.js 应暴露 window.MatName.short');
    need(MatName.short('直角挂板Z-7') === '直角挂板', '物料简称应去掉型号：直角挂板Z-7 → 直角挂板');
    need(MatName.short('预应力混凝土电杆(Z)Φ190×12M×GY（法兰）') === '预应力混凝土电杆', '电杆规格应整段去掉');
    need(MatName.short('低压JP柜50kVA（双回、无补偿）') === '低压JP柜', '名称内嵌拉丁前缀应保留、参数应去掉');
    need(MatName.short('10kV氧化锌避雷器HY5WS-17/50（脱扣式）') === '10kV氧化锌避雷器', '量词前缀应保留、型号应去掉');
    need(MatName.short('中砂') === '中砂', '无型号物料应原样返回');
    need(JSON.stringify(MatName.list([
      { description: '直角挂板Z-7' }, { description: '直角挂板Z-10' }, { description: '镀锌钢绞线GJ-35' }
    ])) === JSON.stringify(['直角挂板', '镀锌钢绞线']), '多物料简称应按明细顺序去重');
    // 暂存清单：总数 computed + 统计条展示 + Tab 直连
    need(/const stagingTotalQty = computed\(\(\) => stagingRows\.value\.reduce/.test(src), '领料总数应由 stagingRows + stagingQty 实时计算');
    need(src.indexOf('领料总数 <b>{{ fmtQty(stagingTotalQty) }}</b>') > -1, '统计条应在「项目」旁展示领料总数');
    need(/@keydown="onStagingTab"/.test(src) && /function onStagingTab\(e\)/.test(src)
      && /class="stg-qty-input"/.test(src), 'Tab 应由数量输入框互相跳转（跳过移除按钮）');
    need(/tabindex="-1" @click="removeStaging/.test(src), '移除按钮应退出 Tab 顺序（iOS 键盘「下一项」同样跳过）');
    need(/e\.shiftKey/.test(src) && /% boxes\.length/.test(src), 'Tab 应支持末行回首行与 Shift+Tab 反向');
    // 领料单列表：涉及项目完整折行 + 新增物料描述列
    const projCols = src.match(/<el-table-column label="涉及项目"[^>]*/g) || [];
    const mainProj = projCols.find(x => x.indexOf('class-name="rq-wrapcell"') > -1) || '';
    need(mainProj.indexOf('show-overflow-tooltip') === -1 && mainProj.indexOf('min-width="200"') > -1,
      '领料单主表「涉及项目」应完整折行、不得省略（关联领料单弹窗仍保留 tooltip）');
    need(/<el-table-column label="物料描述" min-width="160" class-name="rq-wrapcell">/.test(src)
      && /v-for="\(n, i\) in matNames\(row\)"/.test(src), '应在涉及项目旁新增物料描述列并调用简称函数');
    need(/\.rq-main \.rq-wrapcell \.cell \{ white-space:normal; overflow:visible/.test(css), '折行列应有 white-space:normal CSS');
    need(/\.stg-chips \{ display:flex; flex-wrap:wrap/.test(css), '暂存统计条应在窄屏换行');
    return '总数 computed 联动 + Tab 循环跳转（移除退出 Tab 序）+ 5 组简称用例 + 去重 + 项目折行 + 物料描述列';
  });
  await step('ui', '移动端：顶栏图标化、筛选栏两列网格、弹窗限高可滚动', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
    need(/position:sticky; top:0;/.test(css), '移动端顶栏应固定（键盘弹出 / 页面平移时不被裁走）');
    need(/\.app-header \.logout-btn \{ width:32px; height:32px;/.test(css)
      && /\.app-header \.logout-text \{ display:none; \}/.test(css), '移动端「退出登录」应收成图标按钮');
    need(/<span class="logout-text">退出登录<\/span>/.test(main)
      && /aria-label="退出登录"/.test(main), '顶栏应保留桌面文字与无障碍标签');
    need(/\.wv-filters \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\); grid-auto-flow:row dense;/.test(css),
      '移动端筛选栏应为两列网格 + dense（不再一个控件独占一行）');
    need(css.indexOf('.wv-filters .el-button { width:100%; }') === -1,
      '不得残留「筛选控件全部占满整行」的旧规则');
    need(/\.el-dialog__body \{ flex:1 1 auto; min-height:0; overflow-y:auto;/.test(css),
      '移动端弹窗 body 应自身滚动（长表单不再撑破视口）');
    need(/max-height:calc\(100dvh - 6vh\)/.test(css), '移动端弹窗应按 dvh 限高，键盘弹出时自动收缩');
    need(/\.el-dialog__footer \{ flex:0 0 auto; border-top/.test(css), '弹窗固定底栏应与滚动内容做分隔');
    return '顶栏图标化 + sticky、筛选栏 2 列 dense、弹窗 dvh 限高 + body 滚动 + 固定底栏';
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
  await step('plans', '借工 新增 → 详情（新模型字段）', async () => {
    const d = needOk(await api('POST', '/api/borrowWorks', {
      token, body: { unit: '冒烟供电所', direction: '我方借出', workContent: '冒烟测试', techCount: 2, signStatus: '未签单' }
    }), 'borrowWorks POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/borrowWorks/' + d.id, { token }), 'borrowWorks detail');
    need(one.unit === '冒烟供电所' && one.direction === '我方借出' && one.techCount === 2, 'detail 新字段不匹配');
    return 'id=' + d.id + ' unit=' + one.unit + ' tech=' + one.techCount;
  });
  await step('ui', '单位余额：默认汇总全部明细、10 列平表、克制视觉', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/borrow.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const bal = src.slice(src.indexOf('<div class="bw-bal">'), src.indexOf('<!-- 新增/编辑弹窗 -->'));
    need(bal.indexOf('<div class="bw-bal">') === 0, '应存在单位余额容器');
    need((bal.match(/<el-table-column/g) || []).length === 10, '单位余额应仍是 10 列平表（不引入分组表头）');
    need(bal.indexOf('el-table-column-group') === -1, '不得引入分组表头');
    need(!/class="bw-bal-table"[^>]*stripe/.test(bal), '余额表不应有斑马纹');
    // 口径修正：默认全部明细，只有切到 signed 才按已签单过滤；切到余额页重新拉数据
    need(/const balanceScope = ref\('all'\)/.test(src), '余额统计口径默认应为「全部明细」');
    need(/balanceScope\.value !== 'signed' \|\| r\.signStatus === '已签单'/.test(src), '仅 signed 口径才按已签单过滤');
    need(/function setBalanceScope\(/.test(src) && /setBalanceScope\('all'\)/.test(bal) && /setBalanceScope\('signed'\)/.test(bal), '应提供全部/仅已签单切换');
    need(/watch\(tab,[\s\S]{0,80}v === 'balance'/.test(src), '切到余额页应重新加载明细，保证同步');
    need(!/list\.value\.filter\(r => r && \(r\.signStatus === '已签单'\)\)/.test(src), '不得再写死只统计已签单');
    need(/diffCls\(row\.dTech\)/.test(bal) && /diffCls\(row\.dWorker\)/.test(bal) && /diffCls\(row\.dVehicle\)/.test(bal), '三列差额都应带语义色');
    need(/function diffText\(v\)\s*\{[^}]*'\+' \+ n/.test(src), '差额正数应显示 + 号');
    need(/bw-bal-empty/.test(bal) && /\.bw-diff\.is-neg/.test(css) && /\.bw-diff\.is-zero/.test(css), '空态与差额正/负/零样式应存在');
    need(/bw-h-start/.test(bal) && /bw-g-start/.test(bal), '借入/差额组首应有分隔线');
    need(!/\.bw-diff \{[^}]*border-radius:999px/.test(css), '差额不得回到彩色胶囊标签');
    need(!/th\.bw-h-diff \{ background/.test(css), '表头不得回到三色底块');
    return '默认全量汇总 + 口径切换 + 切页刷新 + 10 列平表 + 纯数字语义色 + 无胶囊/三色表头';
  });
  await step('plans', '借工 校验：非法计数/枚举 → 400', async () => {
    const r1 = await api('POST', '/api/borrowWorks', { token, body: { unit: 'X', direction: '我方借出', techCount: -1 } });
    const r2 = await api('POST', '/api/borrowWorks', { token, body: { unit: 'X', direction: '乱写' } });
    const r3 = await api('POST', '/api/borrowWorks', { token, body: { unit: 'X', direction: '我方借出', signStatus: '乱写' } });
    need(r1.status === 400 && r2.status === 400 && r3.status === 400, '期望 400，实际 ' + [r1.status, r2.status, r3.status].join('/'));
    return '计数-1 400 / 方向非法 400 / 签单状态非法 400';
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
  await step('workticket', '默认模板 元信息 GET（内置 规则15/技术49/安全19）', async () => {
    const d = needOk(await api('GET', '/api/workticket/measures/default', { token }), 'default meta');
    need(d.tech === 49 && d.safety === 19, '内置默认应为 技术49/安全19，实际 ' + d.tech + '/' + d.safety);
    need(d.rules === 15, '内置默认应含 15 条作业内容匹配规则，实际 ' + d.rules);
    need(d.builtin === true, '空实例应为 builtin=true，实际 ' + d.builtin);
    return 'rules=' + d.rules + ' tech=' + d.tech + ' safety=' + d.safety + ' builtin=' + d.builtin;
  });
  await step('workticket', '载入默认 POST → 规则+15 / 技术+49 / 安全+19，且规则按标题反查措施 id', async () => {
    const d = needOk(await api('POST', '/api/workticket/measures/default/load', { token }), 'default load');
    need(d.result && d.result.tech && d.result.tech.added === 49, '技术应新增 49，实际 ' + brief(d.result));
    need(d.result.safety && d.result.safety.added === 19, '安全应新增 19，实际 ' + brief(d.result));
    need(d.result.rules && d.result.rules.added === 15, '匹配规则应新增 15，实际 ' + brief(d.result));
    const rl = needOk(await api('GET', '/api/workticket/rules', { token }), 'rules list after load');
    // 前面已新增 1 条「冒烟作业」规则，载入默认后应为 15 + 1
    need(rl.length === 16, '载入默认后规则应为 16 条，实际 ' + rl.length);
    const builtin = rl.filter(r => r.workType !== '冒烟作业');
    need(builtin.length === 15, '内置规则应为 15 条，实际 ' + builtin.length);
    const bad = builtin.filter(r => {
      const cnt = v => String(v || '').split(/[;；]+/).map(x => x.trim()).filter(Boolean).length;
      const ids = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).length;
      return cnt(r.techName) !== ids(r.techId) || cnt(r.safetyName) !== ids(r.safetyId);
    });
    need(!bad.length, '规则的措施标题应全部反查到本实例 id：' + brief(bad.map(r => r.workType)));
    return 'rules+' + d.result.rules.added + ' tech+' + d.result.tech.added + ' safety+' + d.result.safety.added + ' 关联全命中';
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

  /* ---------- 拆分出去的两个专用端点：运行时回归 ---------- */
  await step('plans', '独立路由回归：月计划 xlsx 导出 / 借工单生成 + 下载', async () => {
    const hdr = { Authorization: 'Bearer ' + token };
    const xr = await fetch(base + '/api/workPlans/month-plan.xlsx', { headers: hdr });
    need(xr.status === 200, '月计划 xlsx 导出应 200，实际 ' + xr.status);
    const buf = Buffer.from(await xr.arrayBuffer());
    need(buf.slice(0, 2).toString() === 'PK', '导出内容应为 xlsx（PK 头），实际 ' + buf.slice(0, 2).toString());
    const list = needOk(await api('GET', '/api/borrowWorks', { token }), 'borrowWorks list');
    const b = list[0];
    need(b && b.id, '应有可生成借工单的借工记录');
    const gen = await api('POST', '/api/borrowWorks/' + b.id + '/borrowForm/generate', { token });
    need(gen.status === 200, '借工单生成应 200，实际 ' + gen.status + ' ' + brief(gen.data));
    const dl = await fetch(base + '/api/borrowWorks/' + b.id + '/generated/' + gen.data.id + '/download', { headers: hdr });
    need(dl.status === 200, '生成的借工单应可下载，实际 ' + dl.status);
    return 'xlsx PK 头 ' + buf.length + ' 字节 / 借工单生成 + 下载 200';
  });

  /* ---------- 结构（按功能区分模块，防回退） ---------- */
  await step('结构', '后端按功能区独立文件 + 单向依赖 + 挂载顺序', async () => {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const entry = read('server.js');
    const plans = read('server/routes/plans.js');
    const borrow = read('server/routes/borrow.js');
    const month = read('server/routes/monthPlans.js');
    const util = read('server/core/util.js');
    const routeFiles = fs.readdirSync(path.join(ROOT, 'server/routes')).filter(x => x.endsWith('.js'));

    const entryLines = entry.trimEnd().split('\n').length;
    need(entryLines < 60, 'server.js 应保持纯入口（<60 行）');
    need(routeFiles.indexOf('borrow.js') > -1 && routeFiles.indexOf('monthPlans.js') > -1,
      '借工与月计划应有独立 routes 文件');
    need(/app\.get\('\/api\/workPlans\/month-plan\.xlsx'/.test(month), '月计划 xlsx 导出应归属 monthPlans.js');
    need(/crud\('borrowWorks', 'borrowWorks'/.test(borrow), 'borrowWorks 通用 CRUD 应归属 borrow.js');
    need(/app\.post\('\/api\/borrowWorks\/:id\/evidences'/.test(borrow), '借工佐证端点应归属 borrow.js');
    need(!/app\.(get|post|put|delete)\('\/api\/borrowWorks/.test(plans) &&
      !/app\.get\('\/api\/workPlans\/month-plan\.xlsx'/.test(plans),
      'plans.js 不得再混装借工或月计划导出端点');
    need(!/\['plans',\s*'borrowWorks'/.test(plans), 'plans.js 通用 CRUD 不得再包含 borrowWorks');
    need(/function safeFileName/.test(util) && /const INLINE_MIME/.test(util),
      '附件落盘/预览共用工具应下沉 core/util');
    need(plans.indexOf('function planFileSafeName') === -1 && borrow.indexOf('const DRAWING_INLINE_MIME') === -1,
      'routes 不得重复定义已下沉的共用工具');

    const at = f => entry.indexOf("require('./server/routes/" + f + "')");
    need(at('borrow') > -1 && at('monthPlans') > -1 && at('plans') > -1, '三个模块都应在 server.js 中注册');
    need(at('borrow') < at('plans') && at('monthPlans') < at('plans'),
      '借工/月计划专用路由必须先于 plans.js 加载（静态路径不能被 /:id 抢先匹配）');
    routeFiles.forEach(f => {
      const src = read('server/routes/' + f);
      need(!/require\(['"][^'"]*routes\//.test(src), f + ' 不得依赖其它 routes（依赖方向只能是 routes → core）');
    });
    return routeFiles.length + ' 个 routes 文件 / 入口 ' + entryLines +
      ' 行 / 专用路由早于通用 CRUD / 无 routes↔routes';
  });

  await step('结构', 'SOURCE_TYPES 前后端两处定义逐项相等（防漂移）', async () => {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const pick = (src, label) => {
      const m = src.match(/const SOURCE_TYPES = \[([^\]]*)\]/);
      need(!!m, label + ' 未找到 SOURCE_TYPES 定义');
      return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    const back = read('server/routes/materials.js');
    const front = read('public/js/views/materials.js');
    const b = pick(back, '后端'), f = pick(front, '前端');
    need(b.length === 5, '后端 SOURCE_TYPES 应为 5 项，实为 ' + b.length);
    need(JSON.stringify(b) === JSON.stringify(f),
      '前后端 SOURCE_TYPES 不一致：' + JSON.stringify(b) + ' vs ' + JSON.stringify(f));
    need(/smoke\.js/.test(back) && /smoke\.js/.test(front), '两处定义附近应有互指本断言的注释');
    return b.join(' / ');
  });

  await step('结构', '身份证权重/校验码映射：core 与表单两处逐项相等（防漂移）', async () => {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const pick = (src, name, label) => {
      const m = src.match(new RegExp('const ' + name + ' = \\[([^\\]]*)\\]'));
      need(!!m, label + ' 未找到 ' + name);
      return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    const core = read('server/core/util.js');
    const view = read('public/js/views/users.js');
    const a1 = pick(core, 'WORKER_ID_WEIGHTS', 'core'), b1 = pick(view, 'WORKER_ID_WEIGHTS', '表单');
    const a2 = pick(core, 'WORKER_ID_CHECK', 'core'), b2 = pick(view, 'WORKER_ID_CHECK', '表单');
    need(a1.length === 17 && a2.length === 11, 'core 常量长度应为 17 / 11，实为 ' + a1.length + ' / ' + a2.length);
    need(JSON.stringify(a1) === JSON.stringify(b1), 'WORKER_ID_WEIGHTS 两处不一致：' + JSON.stringify(a1) + ' vs ' + JSON.stringify(b1));
    need(JSON.stringify(a2) === JSON.stringify(b2), 'WORKER_ID_CHECK 两处不一致：' + JSON.stringify(a2) + ' vs ' + JSON.stringify(b2));
    need(/smoke\.js/.test(core) && /smoke\.js/.test(view), '两处定义附近应有互指本断言的注释');
    return '权重 17 项 / 映射 11 项逐项相等';
  });

  await step('users', '身份证校验纯函数：真实日历/闰年/MOD 11-2 校验码/未来日期/小写 x', async () => {
    const { validateWorkerId } = require(path.join(ROOT, 'server/core/util.js'));
    const TODAY = '2026-11-08';
    need(validateWorkerId('510301199001010010', TODAY).ok === true, '合法身份证应通过');
    const badCheck = validateWorkerId('510301199001010019', TODAY);
    need(badCheck.ok === false && /校验码/.test(badCheck.error), '校验码错应拒绝');
    const badDay = validateWorkerId('51030119900230001X', TODAY);
    need(badDay.ok === false && /出生日期/.test(badDay.error), '2 月 30 日应拒绝');
    const future = validateWorkerId('510301209001010017', TODAY);
    need(future.ok === false && /出生日期/.test(future.error), '未来生日应拒绝');
    need(validateWorkerId('51030119900101007x', TODAY).ok === true, '末位小写 x 应通过');
    need(validateWorkerId('510301200002290013', TODAY).ok === true, '闰年 2000-02-29 应通过');
    need(validateWorkerId('510301199902290013', TODAY).ok === false, '平年 1999-02-29 应拒绝');
    return '合法/校验码错/2月30日/未来日期/小写x/闰年/平年 7 个样本';
  });

  const WID = { A: '510301199001010010', B: '510301199001010029', C: '510301199001010037', D: '510301199001010045' };
  let workerMixBuf = null;
  let workerSuspectNo = null;
  const workerUpload = async (path, decisions) => {
    const fd = new FormData();
    fd.append('file', new Blob([workerMixBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'mix.xlsx');
    if (decisions) fd.append('decisions', JSON.stringify(decisions));
    const r = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  await step('users', '作业人员导入预览：六类分类 + 字段级差异，不写库', async () => {
    const mk = async (name, idNumber, phone, extra) => needOk(await api('POST', '/api/workers', {
      token, body: { name, idNumber, phone, ...(extra || {}) }
    }), 'worker POST');
    await mk('冒烟甲', WID.A, '13800000001', { identity: '民工', team: '一队', status: '待定' });
    await mk('冒烟乙', WID.B, '13800000002');
    await mk('冒烟丁', WID.D, '13800000004');
    await mk('冒烟无证', '', '13800000003');
    const before = needOk(await api('GET', '/api/workers', { token }), 'workers before');
    const rows = [
      ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'],
      ['冒烟新人', WID.C, '13800000011', '', '', '', '', ''],
      ['冒烟甲', WID.A, '13900000001', '', '', '', '', ''],
      ['冒烟乙', WID.B, '13800000002', '', '', '', '', ''],
      ['冒烟无证', '', '13800000003', '', '', '', '', ''],
      ['冒烟异名', WID.D, '13800000004', '', '', '', '', ''],
      ['冒烟新人复', WID.C, '13800000011', '', '', '', '', '']
    ];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '作业人员名单');
    workerMixBuf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const pv = await workerUpload('/api/workers/import/preview');
    need(pv.status === 200 && pv.data && pv.data.ok, '预览失败：' + brief(pv.data));
    const s = pv.data.summary || {};
    need(['新增', '更新', '无变化', '疑似重复', '冲突', '文件内重复'].every(k => s[k] === 1),
      '六类应各 1 条：' + brief(s));
    const upd = (pv.data.rows || []).find(r => r.kind === '更新');
    need(upd && Array.isArray(upd.diffs) && upd.diffs.length === 1 && upd.diffs[0].field === '电话号码',
      '更新行差异应只含电话号码：' + brief(upd && upd.diffs));
    workerSuspectNo = (pv.data.rows || []).find(r => r.kind === '疑似重复').rowNo;
    const after = needOk(await api('GET', '/api/workers', { token }), 'workers after');
    need(after.length === before.length, '预览不得写库：' + before.length + ' → ' + after.length);
    return '六类各 1 / 更新差异只含电话号码 / 预览不写库 / 疑似行号 ' + workerSuspectNo;
  });

  await step('users', '作业人员导入确认：有值更新 / 疑似决策 / 重复导入幂等', async () => {
    const first = await workerUpload('/api/workers/import/confirm', []);
    need(first.status === 200 && first.data.added === 1 && first.data.updated === 1 &&
      first.data.unchanged === 1 && first.data.skipped === 4,
      '首次确认计数不符：' + brief(first.data));
    const list1 = needOk(await api('GET', '/api/workers', { token }), 'workers 1');
    const a1 = list1.find(w => w.idNumber === WID.A);
    need(a1 && a1.phone === '13900000001' && a1.status === '待定',
      '有值更新应只改电话、状态留空保持待定：' + brief(a1 && { phone: a1.phone, status: a1.status }));
    need(list1.filter(w => w.name === '冒烟无证').length === 1,
      '疑似行未勾选时不应新增同名无证件人员');
    const second = await workerUpload('/api/workers/import/confirm', [workerSuspectNo]);
    need(second.status === 200 && second.data.added === 1 && second.data.updated === 0,
      '勾选疑似行后应新增 1 条：' + brief(second.data));
    const third = await workerUpload('/api/workers/import/confirm', []);
    need(third.status === 200 && third.data.added === 0 && third.data.updated === 0,
      '同一文件第三次导入应全为无变化/跳过：' + brief(third.data));
    return '新增1/更新1/无变化1/跳过4 → 勾选疑似新增1 → 再次导入 added=0 updated=0';
  });

  /* ---------- 通讯录导入快照/恢复：常驻回归（增补，step 自带数据与文件清理） ---------- */
  await step('system', '通讯录快照/恢复：落盘+清单、回滚、可逆、5 份上限、非法参数 400', async () => {
    const bkDir = path.join(TMP, 'data', 'backups', 'contacts');
    const SNAP_RE = /^contacts-\d{14}(?:-\d+)?\.json$/;
    const bkFiles = () => fs.existsSync(bkDir) ? fs.readdirSync(bkDir).filter(n => SNAP_RE.test(n)) : [];
    const preFiles = bkFiles();                 // step 开始前已有的快照（正常为空）
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-smoke-snap-'));
    const dbPath = path.join(TMP, 'data', 'db.json');
    const initialContacts = JSON.parse(fs.readFileSync(dbPath, 'utf8')).contacts || [];
    const alive0 = await listOk('/api/contacts', token);
    let firstSnap = '';

    // 覆盖式导入是现行快照机制的触发口：优先「员工」sheet，按表头名解析 6 列
    const rows = [
      ['部门', '姓名', '职务', '手机', '移动短号', '备注'],
      ['冒烟部门甲', '冒烟联系人甲', '主任', '13700000001', '6001', '冒烟备注甲'],
      ['冒烟部门乙', '冒烟联系人乙', '专责', '13700000002', '6002', '冒烟备注乙']
    ];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '员工');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const doImport = async name => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
      fd.append('mode', 'replace'); // 主批后单步直导已废除，快照机制由两段式的确认端点触发
      const r = await fetch(base + '/api/contacts/import/confirm', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        signal: AbortSignal.timeout(15000)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const restore = file => api('POST', '/api/contacts/restore-snapshot', { token, body: { file } });
    const snaps = () => listOk('/api/contacts/import-snapshots', token);
    // 上限测试会清掉最早那份，私有副本保证收尾仍能把通讯录还原到 step 开始前
    const putBackInitial = async () => {
      if (!firstSnap) return;
      fs.mkdirSync(bkDir, { recursive: true });
      const target = path.join(bkDir, firstSnap);
      // 快照名按秒生成且上限会清理最旧份：同名文件可能已被后续写入复用（内容不再是初始快照），
      // 所以每次都用 step 私有副本覆盖回去，保证恢复端点读到的一定是导入前数组。
      fs.copyFileSync(path.join(privateDir, firstSnap), target);
      needOk(await restore(firstSnap), '收尾还原初始通讯录');
    };

    try {
      /* 1. 触发快照：文件落盘 + 清单含该份 + 条数与导入前一致 */
      const imp = await doImport('contacts-snapshot-smoke.xlsx');
      need(imp.status === 200 && imp.data.imported === 2, '覆盖式导入失败：' + brief(imp.data));
      firstSnap = String(imp.data.snapshot || '');
      need(SNAP_RE.test(firstSnap), '响应应带合法快照文件名：' + brief(imp.data));
      const snapAbs = path.join(bkDir, firstSnap);
      need(fs.existsSync(snapAbs), '快照文件未落盘：' + snapAbs);
      const snapData = JSON.parse(fs.readFileSync(snapAbs, 'utf8'));
      need(Array.isArray(snapData) && snapData.length === initialContacts.length,
        '快照应原样保存导入前 ' + initialContacts.length + ' 条（含逻辑删除），实为 ' + (snapData || []).length);
      fs.copyFileSync(snapAbs, path.join(privateDir, firstSnap));
      const l1 = await snaps();
      const hit = l1.find(x => x.file === firstSnap);
      need(hit && hit.count === initialContacts.length && hit.createdAt,
        '清单应含该快照且条数/时间正确：' + brief(hit));
      need(l1.every(x => x.file && x.createdAt && typeof x.count === 'number'), '清单字段应为 file/createdAt/count');
      need(l1.every((x, i) => !i || l1[i - 1].createdAt >= x.createdAt), '清单应按时间倒序');
      need((await listOk('/api/contacts', token)).length === 2, '导入后通讯录应为 2 条');

      /* 2. 修改后恢复 → 数据回到快照时状态 */
      const rs1 = needOk(await restore(firstSnap), '恢复快照');
      need(rs1.restored === initialContacts.length, '恢复条数应为 ' + initialContacts.length + '：' + brief(rs1));
      need(JSON.stringify(await listOk('/api/contacts', token)) === JSON.stringify(alive0),
        '恢复后通讯录应逐字段回到导入前状态');

      /* 3. 恢复本身可逆：恢复前再快照，可再恢复回去 */
      need(SNAP_RE.test(String(rs1.snapshot || '')) && rs1.snapshot !== firstSnap &&
        fs.existsSync(path.join(bkDir, rs1.snapshot)), '恢复前应再生成一份新快照：' + brief(rs1));
      need((await snaps()).some(x => x.file === rs1.snapshot), '清单应含恢复前新快照');
      needOk(await restore(rs1.snapshot), '再恢复回去');
      need((await listOk('/api/contacts', token)).length === 2, '再恢复应回到导入后的 2 条');

      /* 4. 份数上限：连续生成超过 5 份后目录与清单都只剩最近 5 份 */
      for (let i = 0; i < 7; i++) {
        const r = await doImport('contacts-limit-' + i + '.xlsx');
        need(r.status === 200, '第 ' + (i + 1) + ' 次上限测试导入失败：' + brief(r.data));
      }
      need(bkFiles().length === 5, '快照目录应只保留最近 5 份，实为 ' + bkFiles().length);
      need((await snaps()).length === 5, '清单端点也应只返回 5 份');

      /* 5. 安全：清单外文件名与路径穿越样式 → 400，且数据不变 */
      need((await restore('contacts-19990101000000.json')).status === 400, '清单外文件名应 400');
      need((await restore('../db.json')).status === 400, '路径穿越样式应 400');
      need((await restore('..%2fcontacts-19990101000000.json')).status === 400, '编码路径穿越样式应 400');
      need((await listOk('/api/contacts', token)).length === 2, '非法恢复请求不得改动通讯录');

      /* 收尾：走恢复端点把数据还原，不改库结构、不改快照机制 */
      await putBackInitial();
      const aliveFinal = await listOk('/api/contacts', token);
      need(JSON.stringify(aliveFinal) === JSON.stringify(alive0),
        '收尾应把通讯录还原到 step 开始前状态：' + brief(aliveFinal));
      return '落盘/清单/回滚/可逆/5 份上限/3 类非法参数 400 + 数据与快照文件清理';
    } finally {
      // 成功或失败都尽力还原数据；只删本 step 新增的快照，保留 step 前已有文件
      try { await putBackInitial(); } catch (e) { /* 不掩盖主体的错误 */ }
      bkFiles().forEach(f => {
        if (!preFiles.includes(f)) { try { fs.unlinkSync(path.join(bkDir, f)); } catch (e) { } }
      });
      if (!preFiles.length && fs.existsSync(bkDir) && bkFiles().length === 0) {
        try { fs.rmSync(bkDir, { recursive: true, force: true }); } catch (e) { }
      }
      try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch (e) { }
    }
  });

  /* ---------- 通讯录导入改造：常驻回归（主批新增） ---------- */
  await step('system', '通讯录导入校验与预览：手机格式/文件内判重/双模式分类', async () => {
    const cH = ['部门', '姓名', '职务', '手机', '移动短号', '备注'];
    const cMk = rows => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '员工');
      return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const cPreview = async (rows, mode) => {
      const fd = new FormData();
      fd.append('file', new Blob([cMk(rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'c.xlsx');
      fd.append('mode', mode || 'merge');
      const r = await fetch(base + '/api/contacts/import/preview', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        signal: AbortSignal.timeout(15000)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const errText = r => JSON.stringify(r.data || {});

    const badPhone = await cPreview([cH, ['部门甲', '冒烟校验甲', '', '1380000001', '', '']]);
    need(badPhone.status === 400 && /第2行/.test(errText(badPhone)) && /手机号/.test(errText(badPhone)),
      '10 位手机号应整批拒并指行：' + brief(badPhone.data));
    const dupSame = await cPreview([cH, ['部门甲', '同名', '', '13800000001', '', ''], ['部门乙', '同名', '', '13800000001', '', '']]);
    need(dupSame.status === 400 && /第2行与第3行/.test(errText(dupSame)),
      '文件内同名同号应拒且报错含两行行号：' + brief(dupSame.data));
    const dupPhone = await cPreview([cH, ['部门甲', '甲', '', '13800000002', '', ''], ['部门乙', '乙', '', '13800000002', '', '']]);
    need(dupPhone.status === 400 && /第2行与第3行/.test(errText(dupPhone)) && /姓名不同/.test(errText(dupPhone)),
      '文件内同号异名应拒且报错含两行行号：' + brief(dupPhone.data));
    const sameNameDiff = await cPreview([cH, ['部门甲', '同名', '', '13800000003', '', ''], ['部门乙', '同名', '', '13800000004', '', '']]);
    need(sameNameDiff.status === 200, '同名不同号不应报错、应正常进分类：' + brief(sameNameDiff.data));

    const mix = await cPreview([
      cH,
      ['冒烟部门', '冒烟新人甲', '', '13700000011', '', ''],
      ['冒烟单位', '李四', '新职务', '13900139000', '', ''],
      ['冒烟部门', '李四', '', '13700000012', '', '']
    ], 'merge');
    need(mix.status === 200, '增量预览失败：' + brief(mix.data));
    const s = mix.data.summary || {};
    need(s['新增'] === 1 && s['更新'] === 1 && s['同名待确认'] === 1,
      '增量分类应为 新增1/更新1/同名待确认1：' + brief(s));
    const upd = (mix.data.rows || []).find(r => r.kind === '更新');
    need(upd && upd.diffs.length === 1 && upd.diffs[0].field === '职务',
      '更新差异应只列职务：' + brief(upd));
    const noChange = await cPreview([cH, ['冒烟单位', '李四', '', '13900139000', '', '']], 'merge');
    need(noChange.status === 200 && noChange.data.summary['无变化'] === 1,
      '同名同号且无字段变化应为无变化：' + brief(noChange.data));
    const conflict = await cPreview([cH, ['冒烟部门', '冒烟异名', '', '13900139000', '', '']], 'merge');
    need(conflict.status === 200 && conflict.data.summary['冲突'] === 1,
      '同号异名应为冲突：' + brief(conflict.data));
    const rep = await cPreview([cH, ['冒烟部门', '冒烟新人乙', '', '13700000021', '', '']], 'replace');
    need(rep.status === 200 && rep.data.summary['将删除'] === 1 && (rep.data.deleteList || []).some(x => x.name === '李四'),
      '覆盖预览应列出将删除名单：' + brief(rep.data));
    return '4 类行校验 + 增量五类分类 + 覆盖将删除名单（预览全程不写库）';
  });

  await step('system', '通讯录导入确认：增量有值更新/不删人、覆盖整表、快照回滚', async () => {
    const cH = ['部门', '姓名', '职务', '手机', '移动短号', '备注'];
    const cMk = rows => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '员工');
      return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const bkDir = path.join(TMP, 'data', 'backups', 'contacts');
    const SNAP_RE = /^contacts-\d{14}(?:-\d+)?\.json$/;
    const bkFiles = () => fs.existsSync(bkDir) ? fs.readdirSync(bkDir).filter(n => SNAP_RE.test(n)) : [];
    const preFiles = bkFiles();
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-smoke-cimp-'));
    const dbPath = path.join(TMP, 'data', 'db.json');
    const initial = JSON.parse(fs.readFileSync(dbPath, 'utf8')).contacts || [];
    let firstSnap = '';
    const confirmBuf = async (buf, mode, decisions, name) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name || 'c.xlsx');
      fd.append('mode', mode || 'merge');
      fd.append('decisions', JSON.stringify(decisions || []));
      const r = await fetch(base + '/api/contacts/import/confirm', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        signal: AbortSignal.timeout(15000)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const restore = file => api('POST', '/api/contacts/restore-snapshot', { token, body: { file } });
    // 快照名按秒生成且上限会清理最早份：用私有副本覆盖回目标文件名再恢复，保证回到初始数组
    const putBack = async () => {
      if (!firstSnap) return;
      fs.mkdirSync(bkDir, { recursive: true });
      fs.copyFileSync(path.join(privateDir, firstSnap), path.join(bkDir, firstSnap));
      needOk(await restore(firstSnap), '收尾还原初始通讯录');
    };
    try {
      // 1) 导出回灌（覆盖）：生成初始快照，同时验证 imported 口径
      const exp = await fetch(base + '/api/contacts/export', { headers: { Authorization: 'Bearer ' + token } });
      const expBuf = Buffer.from(await exp.arrayBuffer());
      const r0 = await confirmBuf(expBuf, 'replace', [], 'export.xlsx');
      need(r0.status === 200 && r0.data.added === 1 && r0.data.imported === 1,
        '导出回灌覆盖应 imported=1：' + brief(r0.data));
      firstSnap = String(r0.data.snapshot || '');
      need(SNAP_RE.test(firstSnap) && fs.existsSync(path.join(bkDir, firstSnap)), '覆盖前快照应生成');
      fs.copyFileSync(path.join(bkDir, firstSnap), path.join(privateDir, firstSnap));
      const list0 = await listOk('/api/contacts', token);

      // 2) 增量新增 2 人
      const r1 = await confirmBuf(cMk([
        cH,
        ['部门甲', '增量甲', '专责', '13700000031', '', '备注甲'],
        ['部门乙', '增量乙', '主任', '13700000032', '', '备注乙']
      ]), 'merge');
      need(r1.status === 200 && r1.data.added === 2 && r1.data.updated === 0,
        '增量应新增 2 人：' + brief(r1.data));
      const before = await listOk('/api/contacts', token);
      const jia = before.find(c => c.name === '增量甲'), yi = before.find(c => c.name === '增量乙');
      need(jia && yi, '新增后应能查到两人');

      // 3) 增量有值更新：只改甲的职务，文件外的人（乙 / 李四）完全不动
      const r2 = await confirmBuf(cMk([cH, ['部门甲', '增量甲', '班长', '13700000031', '', '备注甲']]), 'merge');
      need(r2.status === 200 && r2.data.added === 0 && r2.data.updated === 1,
        '增量应只更新 1 人：' + brief(r2.data));
      const after = await listOk('/api/contacts', token);
      const jia2 = after.find(c => c.id === jia.id), yi2 = after.find(c => c.id === yi.id);
      const li2 = after.find(c => c.name === '李四');
      need(jia2 && jia2.post === '班长' && jia2.id === jia.id && jia2.createdAt === jia.createdAt,
        '更新者应保留 id/createdAt 且职务变更：' + brief(jia2));
      need(yi2 && JSON.stringify(yi2) === JSON.stringify(yi), '文件外联系人应完全不变');
      need(li2 && JSON.stringify(li2) === JSON.stringify(list0.find(c => c.name === '李四')),
        '文件外的库内原联系人应完全不变');

      // 4) 同名待确认：默认新增 / 库内两个同名时指明目标更新号码
      const r3 = await confirmBuf(cMk([cH, ['部门丙', '增量甲', '', '13900000099', '', '']]), 'merge',
        [{ rowNo: 2, action: 'add' }]);
      need(r3.status === 200 && r3.data.added === 1, '同名默认新增应 added=1：' + brief(r3.data));
      const r4 = await confirmBuf(cMk([cH, ['部门丙', '增量甲', '', '13900000098', '', '']]), 'merge',
        [{ rowNo: 2, action: 'update', targetId: jia.id }]);
      need(r4.status === 200 && r4.data.updated === 1 && r4.data.added === 0,
        '指明目标更新号码应 updated=1 且不新增：' + brief(r4.data));
      const after4 = await listOk('/api/contacts', token);
      const jia4 = after4.find(c => c.id === jia.id);
      need(jia4 && jia4.phone === '13900000098' && jia4.createdAt === jia.createdAt,
        '更新号码后 id/createdAt 不变、手机应为新号码：' + brief(jia4));

      // 5) 导出回灌增量：全部无变化
      const exp2 = await fetch(base + '/api/contacts/export', { headers: { Authorization: 'Bearer ' + token } });
      const r5 = await confirmBuf(Buffer.from(await exp2.arrayBuffer()), 'merge', [], 'export2.xlsx');
      need(r5.status === 200 && r5.data.added === 0 && r5.data.updated === 0,
        '导出回灌增量应全部无变化：' + brief(r5.data));

      // 6) 覆盖模式：整表与文件一致、deleted 计数、快照生成
      const r6 = await confirmBuf(cMk([
        cH, ['部门X', '覆盖甲', '', '13700000041', '', ''], ['部门Y', '覆盖乙', '', '13700000042', '', '']
      ]), 'replace');
      need(r6.status === 200 && r6.data.added === 2 && r6.data.deleted === after4.length &&
        SNAP_RE.test(String(r6.data.snapshot || '')), '覆盖应 added=2 / deleted 为导入前人数 / 生成快照：' + brief(r6.data));
      const list6 = await listOk('/api/contacts', token);
      need(list6.length === 2 && list6.every(c => /^覆盖/.test(c.name)), '覆盖后整表应与文件一致');

      // 7) 恢复初始快照：新增与更新全部回滚
      await putBack();
      const cur = JSON.parse(fs.readFileSync(dbPath, 'utf8')).contacts || [];
      need(JSON.stringify(cur) === JSON.stringify(initial), '恢复快照后 contacts 应逐字段回到初始状态');
      return '导出回灌 / 增量有值更新 / 文件外不动 / 同名决策 / 覆盖整表 / 快照回滚 + 清理';
    } finally {
      try { await putBack(); } catch (e) { /* 不掩盖主体错误 */ }
      bkFiles().forEach(f => {
        if (!preFiles.includes(f)) { try { fs.unlinkSync(path.join(bkDir, f)); } catch (e) { } }
      });
      if (!preFiles.length && fs.existsSync(bkDir) && bkFiles().length === 0) {
        try { fs.rmSync(bkDir, { recursive: true, force: true }); } catch (e) { }
      }
      try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch (e) { }
    }
  });

  await step('users', '准入到期预警派生状态：日期边界/自动转待定/公告栏排序（前端共用纯函数）', async () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
    const sb = { window: {} };
    vm.createContext(sb);
    vm.runInContext(code, sb);
    const WS = sb.window.WorkerStatus;
    need(WS && typeof WS.of === 'function' && typeof WS.alerts === 'function', 'utils.js 应导出 WorkerStatus.of / alerts');
    const T = '2026-11-09';
    const d = off => new Date(Date.parse(T + 'T00:00:00Z') + off * 86400000).toISOString().slice(0, 10);
    const mk = (status, end, extra) => Object.assign({
      id: 'x', name: 'n', status, validStart: '2026-01-01', validEnd: end
    }, extra || {});

    const s30 = WS.of(mk('已准入', d(30)), T);
    need(s30.days === 30 && s30.warn === true && s30.highlight === true && s30.derived === '已准入',
      '结束日=今天+30 应预警：' + brief(s30));
    const s31 = WS.of(mk('已准入', d(31)), T);
    need(s31.days === 31 && s31.warn === false && s31.highlight === false,
      '结束日=今天+31 不应预警：' + brief(s31));
    const s0 = WS.of(mk('已准入', T), T);
    need(s0.days === 0 && s0.warn === true && s0.admitted === true,
      '结束日=今天应剩 0 天且仍预警：' + brief(s0));
    const sNeg = WS.of(mk('已准入', d(-1)), T);
    need(sNeg.derived === '待定' && sNeg.overdue === true && sNeg.overdueDays === 1 && sNeg.admitted === false,
      '昨天到期应自动转待定、超期 1 天：' + brief(sNeg));
    const sEmpty = WS.of(mk('已准入', ''), T);
    need(sEmpty.days === null && sEmpty.derived === '已准入' && sEmpty.highlight === false,
      '有效期为空按存储状态、不触发转换：' + brief(sEmpty));
    const sPending = WS.of(mk('待定', d(10)), T);
    need(sPending.derived === '待定' && sPending.highlight === false && sPending.admitted === false,
      '存储待定 + 未来有效期仍待定且不预警：' + brief(sPending));

    const al = WS.alerts([
      mk('已准入', d(10), { id: 'b', name: 'B' }),
      mk('已准入', d(-3), { id: 'a', name: 'A' }),
      mk('已准入', d(2), { id: 'c', name: 'C' }),
      mk('已准入', d(31), { id: 'd', name: 'D' }),
      mk('待定', d(1), { id: 'e', name: 'E' })
    ], T);
    need(al.length === 3 && al[0].id === 'a' && al[1].id === 'c' && al[2].id === 'b',
      '公告栏应超期在前、其余按到期日升序，排除 +31 与存储待定：' + brief(al));
    need(al[0].overdueDays === 3 && al[1].days === 2 && al[2].days === 10,
      '公告栏超期天数 / 剩余天数应正确：' + brief(al));
    return '+30/+31/今天/昨天/空有效期/存储待定 6 个边界 + 公告栏排序';
  });

  await step('feed', '工作动态预警聚合：技工优先点名 / 等 N 人拼装 + 3 天窗口与日期标签纯函数', async () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'work-feed.js'), 'utf8');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(code, sb);
    const F = sb.window.WorkFeed;
    need(F && typeof F.alertMessage === 'function' && typeof F.build === 'function' &&
      typeof F.inWindow === 'function', 'work-feed.js 应导出 alertMessage / build / inWindow');

    const T = '2026-11-09';
    const alerts = [
      { id: 'a', name: '民工甲', validEnd: '2026-11-10' },
      { id: 'b', name: '技工乙', validEnd: '2026-11-20' },
      { id: 'c', name: '民工丙', validEnd: '2026-11-11' },
      { id: 'd', name: '技工丁', validEnd: '2026-11-19' },
      { id: 'e', name: '其他技工戊', validEnd: '2026-11-12' }
    ];
    const workers = [
      { id: 'a', identity: '民工' }, { id: 'b', identity: '技工（计入高处作业人员）' },
      { id: 'c', identity: '民工' }, { id: 'd', identity: '技工（计入高处作业人员）' },
      { id: 'e', identity: '其他技工（不计入高处作业人员）' }
    ];
    const m5 = F.alertMessage(alerts, workers);
    need(m5 && m5.text === '技工丁、技工乙、民工甲 等5人准入有效期已到期或即将到期，请及时续期',
      '5 人应只点名前 3 名（精确技工优先、同组按到期日升序），N=总人数 5：' + brief(m5));
    need(m5.kind === 'alert' && m5.nav === 'users' && m5.usersTab === 'workers',
      '预警条目应落在作业人员名单页：' + brief(m5));
    const m3 = F.alertMessage(alerts.slice(0, 3), workers);
    need(m3 && m3.text === '技工乙、民工甲、民工丙准入有效期已到期或即将到期，请及时续期' && !/等/.test(m3.text),
      '≤3 人应全列且不带「等」：' + brief(m3));
    const m1 = F.alertMessage([alerts[0]], workers);
    need(m1 && m1.text === '民工甲准入有效期已到期或即将到期，请及时续期' && !/等/.test(m1.text),
      '1 人应是单人句式：' + brief(m1));
    need(F.alertMessage([], workers) === null, '0 人不应产出预警条目');

    need(F.bjDay('2026-11-07T16:00:00.000Z') === '2026-11-08', 'UTC ISO 应转北京自然日：' + F.bjDay('2026-11-07T16:00:00.000Z'));
    need(F.bjDay('2026-11-09 08:13') === '2026-11-09', '北京时间字符串前 10 位即自然日');
    need(F.dayLabel(T, T) === '今日' && F.dayLabel('2026-11-08', T) === '昨日' &&
      F.dayLabel('2026-11-07', T) === '11-07', '日期标签 今日 / 昨日 / MM-DD');
    need(F.inWindow(T, T) && F.inWindow('2026-11-08', T) && F.inWindow('2026-11-07', T) &&
      !F.inWindow('2026-11-06', T) && !F.inWindow('2026-11-10', T) && !F.inWindow('', T),
      '3 天窗口应含今天/昨天/前天，排除第 4 天前、未来与空值');
    return '点名排序 5/3/1/0 四种句式 + ISO/北京时间转换 + 日期标签 + 窗口边界';
  });

  await step('feed', '四类动态来源：3 天窗口边界 / 同日多批次合并 / 排序 / 退场口径', async () => {
    const vm = require('vm');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'work-feed.js'), 'utf8'), sb);
    const F = sb.window.WorkFeed;
    const T = '2026-11-09';
    const iso = d => d + 'T04:00:00.000Z';      // 对应北京时间当天 12:00
    const workers = [
      { id: 'p1', name: '甲', identity: '技工（计入高处作业人员）', status: '已退场', exitedAt: '2026-11-09 08:00' },
      { id: 'p2', name: '乙', identity: '民工', status: '已退场', exitedAt: '2026-11-09 09:00' },
      { id: 'p3', name: '丙', identity: '民工', status: '已退场', exitedAt: '2026-11-08 10:00' },
      { id: 'p4', name: '丁', identity: '民工', status: '已退场', exitedAt: '2026-11-06 10:00' },
      { id: 'p5', name: '戊', identity: '民工', status: '已退场' },
      { id: 'p6', name: '己', identity: '民工', status: '已准入', exitedAt: '2026-11-09 11:00' },
      { id: 'w1', name: '预警甲', identity: '技工（计入高处作业人员）', status: '已准入', validEnd: '2026-11-10' }
    ];
    const imports = [
      { id: 'i1', importedAt: '2026-11-09 08:10', rowsTotal: 10, materialIds: ['a', 'b', 'c'] },
      { id: 'i2', importedAt: '2026-11-09 09:10', rowsTotal: 20, materialIds: ['d', 'e', 'f', 'g'] },
      { id: 'i3', importedAt: '2026-11-08 08:10', rowsTotal: 5, materialIds: ['h', 'i'] },
      { id: 'i4', importedAt: '2026-11-06 08:10', rowsTotal: 99, materialIds: ['x'] }
    ];
    const materials = [
      { id: 'm0', createdAt: iso('2026-11-07') },
      { id: 'm1', createdAt: iso(T), importId: 'i1' },
      { id: 'm2', createdAt: iso('2026-11-06') }
    ];
    const plans = [
      { id: 'q1', createdAt: iso(T), planType: '周计划' },
      { id: 'q2', createdAt: iso(T), planType: '周计划' },
      { id: 'q3', createdAt: iso(T), planType: '月计划' },
      { id: 'q4', createdAt: iso('2026-11-06'), planType: '周计划' },
      { id: 'q5', createdAt: iso(T), planType: '其他' }
    ];
    const borrow = [{ id: 'b1', createdAt: iso(T) }, { id: 'b2', createdAt: iso('2026-11-06') }];
    const alerts = [{ id: 'w1', name: '预警甲', validEnd: '2026-11-10' }];
    const out = F.build({ workers, alerts, imports, materials, plans, borrow, today: T });
    const texts = out.messages.map(m => m.text);
    need(out.alertCount === 1 && out.messages[0].kind === 'alert', '预警应置顶且徽标人数=1：' + brief(out.messages.slice(0, 2)));
    const expect = [
      '今日甲、乙已退场',
      '今日录入材料 30 条，新增 7 条',
      '今日新增周计划 2 条',
      '今日新增月计划 1 条',
      '今日新增借工记录 1 条',
      '昨日丙已退场',
      '昨日录入材料 5 条，新增 2 条',
      '11-07新增材料 1 条'
    ];
    need(JSON.stringify(texts.slice(1)) === JSON.stringify(expect),
      '动态文案 / 排序 / 窗口 / 同日合并应完全匹配：' + brief(texts.slice(1)));
    need(!/丁|戊|己/.test(texts.join('|')), '窗口外、无 exitedAt、已恢复准入的人员都不应出现');
    need(!/99 条|11-06/.test(texts.join('|')), '第 4 天前的批次 / 计划 / 借工不应出现');
    return '8 条动态（今日 5 / 昨日 2 / 前天 1）+ 3 天窗口 + 同日两批合并 10+20→30、3+4→7';
  });

  await step('users', '退场能力：exitedAt 落库/清空 + 已退场派生不可选 + 导入状态枚举', async () => {
    const vm = require('vm');
    const sys = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'system.js'), 'utf8');
    need(/const WORKER_STATUS = \['已准入', '待定'\]/.test(sys), '后端导入状态白名单应恰为两值（不含「已退场」）');
    const sb = { window: {} };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8'), sb);
    const WS = sb.window.WorkerStatus;
    const s = WS.of({ status: '已退场', validEnd: '2026-12-31' }, '2026-11-09');
    need(s.derived === '已退场' && s.admitted === false && !s.warn && !s.highlight,
      '已退场应派生为已退场、不可选、不预警：' + brief(s));
    need(WS.alerts([{ id: 'x', name: 'x', status: '已退场', validEnd: '2026-11-10' }], '2026-11-09').length === 0,
      '已退场不计入准入预警');

    const legacy = (await listOk('/api/workers', token)).find(w => !('exitedAt' in w));
    need(legacy, '应存在无 exitedAt 的存量记录');
    const t1 = '2026-11-09 21:00:00';
    needOk(await api('PUT', '/api/workers/' + legacy.id, { token, body: { status: '已退场', exitedAt: t1 } }), '退场 PUT');
    const g1 = needOk(await api('GET', '/api/workers/' + legacy.id, { token }), '退场后 GET');
    need(g1.status === '已退场' && g1.exitedAt === t1, '退场后 exitedAt 应落库：' + brief(g1));
    needOk(await api('PUT', '/api/workers/' + legacy.id, { token, body: { status: '已准入', exitedAt: null } }), '恢复准入 PUT');
    const g2 = needOk(await api('GET', '/api/workers/' + legacy.id, { token }), '恢复后 GET');
    need(g2.status === '已准入' && g2.exitedAt === null, '恢复准入后 exitedAt 应清空：' + brief(g2));
    const others = await listOk('/api/workers', token);
    need(others.some(w => !('exitedAt' in w)), '其余存量无 exitedAt 记录仍可正常读取');
    return '退场写入 / 恢复清空 / 派生不可选 / 导入枚举对齐 / 存量无字段不报错';
  });

  await step('feed', '工作动态九类来源：项目/领料/出库/作业/资料 + 新增人员 / 窗口与同天合并', async () => {
    const vm = require('vm');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'work-feed.js'), 'utf8'), sb);
    const F = sb.window.WorkFeed;
    const T = '2026-11-10';
    const iso = d => d + 'T04:00:00.000Z';       // 对应北京时间当天 12:00
    const out = F.build({
      today: T, alerts: [],
      workers: [
        { id: 'u1', name: '新甲', status: '待定', createdAt: iso(T) },
        { id: 'u2', name: '新乙', status: '已准入', createdAt: iso(T) },
        { id: 'u3', name: '老丙', status: '已准入', createdAt: iso('2026-11-01') },   // 窗口外
        { id: 'u4', name: '走丁', status: '已退场', exitedAt: '2026-11-09 09:00', createdAt: iso('2026-10-01') }
      ],
      imports: [], materials: [],
      plans: [{ id: 'q1', planType: '周计划', createdAt: iso(T) }],
      projects: [{ id: 'j1', createdAt: iso(T) }, { id: 'j2', createdAt: iso(T) }, { id: 'j3', createdAt: iso('2026-10-30') }],
      requisitions: [{ id: 'r1', createdAt: iso(T) }, { id: 'r2', createdAt: iso(T) }, { id: 'r3', createdAt: iso(T) }],
      outbound: [{ id: 'o1', createdAt: iso('2026-11-09') }],
      works: [{ id: 'k1', createdAt: iso(T) }],
      docs: [{ id: 'd1', createdAt: iso(T) }],
      borrow: []
    });
    const texts = out.messages.map(m => m.text);
    [
      '今日新增作业人员 2 人', '今日新增项目 2 个', '今日新增领料单 3 张',
      '今日新增周计划 1 条', '今日新增实际工作量记录 1 条', '今日新增竣工资料 1 份',
      '昨日新增出库单 1 张', '昨日走丁已退场'
    ].forEach(t => need(texts.indexOf(t) > -1, '缺少「' + t + '」，实际：' + brief(texts)));
    need(!/老丙/.test(texts.join('|')) && !/10-30/.test(texts.join('|')), '窗口外的项目 / 新增人员不应出现');
    need(!/新增作业人员 3/.test(texts.join('|')), '窗口外的新增人员不应计数');
    const kinds = out.messages.map(m => m.kind);
    ['project', 'requisition', 'outbound', 'work', 'doc'].forEach(k =>
      need(kinds.indexOf(k) > -1, '九类来源缺 kind=' + k + '：' + brief(kinds)));
    return '8 条（新增人员/项目/领料/计划/作业/资料 + 昨日出库/退场）+ 窗口过滤';
  });

  await step('结构', '首页工作动态：来源模块加载顺序 + 十类标签 + 卡片形态静态断言', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    const iU = html.indexOf('<script src="/js/utils.js"></script>');
    const iF = html.indexOf('<script src="/js/work-feed.js"></script>');
    const iD = html.indexOf('<script src="/js/views/dashboard.js"></script>');
    need(iU > -1 && iF > iU && iD > iF, 'work-feed.js 必须在 utils 之后、dashboard 之前加载');
    ['alert', 'person', 'material', 'plan', 'borrow', 'project', 'requisition', 'outbound', 'work', 'doc'].forEach(function (k) {
      need(html.includes('.fd-tag-' + k + ' {'), '缺少标签样式 .fd-tag-' + k);
      need(html.includes('html.dark .fd-tag-' + k + ' {'), '缺少深色模式样式 .fd-tag-' + k);
    });
    need(html.includes('max-height: 186px') && html.includes('max-height: 176px'), '一屏 5 条（桌面 / 移动端）滚动高度');
    need(html.includes('flex: 0 0 33.3333%'), '卡片应保持约 1/3 宽');
    need(dash.includes('工作动态') && dash.includes('近 3 天无新增记录') && dash.includes('WorkFeed.build'), '标题 / 空态 / 聚合入口');
    need(/const pick = async/.test(dash), '各接口应独立容错，不得再用 Promise.all 一处失败整块清空');
    need(dash.includes("projects: p") && dash.includes("requisitions: r") && dash.includes("outbound: outs"),
      '九类来源应全部接入 build()');
    need(dash.includes('/api/materialOutbound') && dash.includes('/api/actualWorks') && dash.includes('/api/completionDocuments'),
      '应取领料 / 出库 / 作业 / 资料接口');
    need(!dash.includes('__pendingFocusWorker = {'), '预警点击不得再直开编辑弹窗');
    return '脚本顺序 / 十类浅深两套 / 5 条滚动 / 1/3 宽 / 标题空态 / 按源容错 / 九类接线';
  });

  await step('users', '导入白名单两值 + 已退场导出映射为待定（导出回导入闭环）', async () => {
    const mkBuf = rows => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '作业人员名单');
      return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const HEAD = ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'];
    const saved = workerMixBuf;
    const before = (await listOk('/api/workers', token)).length;

    // 1) 含「已退场」的文件整批拒绝，报错文案回到两值，且不写库
    workerMixBuf = mkBuf([HEAD,
      ['冒烟退场行', '510301199001010010', '13800000099', '', '', '', '', '已退场']]);
    const bad = await workerUpload('/api/workers/import/preview');
    need(bad.status === 400 && /仅支持：已准入 \/ 待定/.test(String((bad.data || {}).error || '')),
      '含已退场行应整批拒绝且报错回到两值：' + brief(bad.data));
    need((await listOk('/api/workers', token)).length === before, '被拒文件不得写库');

    // 2) 纯已准入 / 待定文件预览如常
    workerMixBuf = mkBuf([HEAD,
      ['冒烟白名单甲', '510301199001010002', '13800000091', '', '', '', '', '已准入'],
      ['冒烟白名单乙', '510301199001010029', '13800000092', '', '', '', '', '待定']]);
    const good = await workerUpload('/api/workers/import/preview');
    need(good.status === 200 && good.data && good.data.ok, '纯两值文件应正常预览：' + brief(good.data));

    // 3) 库内含已退场人员时导出：该行写「待定」，其余原值、库内值不变
    needOk(await api('POST', '/api/workers', { token, body: {
      name: '冒烟已退场导出', idNumber: '510301199001010002', phone: '13800000088',
      status: '已退场', exitedAt: '2026-11-09 21:00:00'
    } }), 'POST 已退场人员');
    const er = await fetch(base + '/api/workers/export', { headers: { Authorization: 'Bearer ' + token } });
    need(er.ok, '导出 GET 应 2xx，实际 ' + er.status);
    const buf = Buffer.from(await er.arrayBuffer());
    const ewb = xlsx.read(buf, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(ewb.Sheets[ewb.SheetNames[0]], { header: 1 });
    const ni = rows[0].indexOf('姓名'), si = rows[0].indexOf('状态');
    const exitedRow = rows.slice(1).find(r => r[ni] === '冒烟已退场导出');
    need(exitedRow && exitedRow[si] === '待定', '已退场行导出状态应为「待定」：' + brief(exitedRow));
    const statuses = rows.slice(1).map(r => r[si]);
    need(!statuses.includes('已退场') && statuses.includes('待定') && statuses.includes('已准入'),
      '导出文件不应出现「已退场」且其余行保持原值：' + brief([...new Set(statuses)]));
    const dbRow = (await listOk('/api/workers', token)).find(w => w.name === '冒烟已退场导出');
    need(dbRow && dbRow.status === '已退场', '导出映射不得改库内值：' + brief(dbRow));

    // 4) 这份导出文件直接回导入：不因状态被拒
    workerMixBuf = buf;
    const loop = await workerUpload('/api/workers/import/preview');
    need(loop.status === 200 && loop.data && loop.data.ok,
      '导出文件回导入应正常走完（不因状态被拒）：' + brief(loop.data));
    workerMixBuf = saved;
    return '已退场行整批拒绝 + 两值文件放行 + 导出写待定/其余原值/库内不变 + 导出回导入 200';
  });

  await step('结构', '名单状态筛选与已退场灰徽标静态防回归（两套模板一致）', async () => {
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'users.js'), 'utf8');
    need(/const WORKER_STATUS_FILTER_OPTIONS = \['已准入', '待定', '已退场'\]/.test(js), '状态下拉应为三档且只作显示');
    need(/filters\.status && wst\(w\)\.derived !== filters\.status/.test(js), '筛选谓词必须按 WorkerStatus 派生状态判定');
    need(/function resetFilters\(\)[^\n]*filters\.status = ''/.test(js), '重置必须清空状态筛选');
    const selects = js.match(/v-model="filters\.status"/g) || [];
    need(selects.length === 2, '两套名单模板应各有一个状态下拉，实际 ' + selects.length);
    need(/s\.derived === '已退场' \? 'info' : 'warning'/.test(js), '已退场徽标应为 info 灰、待定仍 warning');
    return '下拉三档 / 派生谓词 / 重置清空 / 两模板各一 / info 徽标';
  });

  await step('plans', '人员防冲突纯函数：parseStaff / overlaps 相接边界 / findConflicts 占用方口径', async () => {
    const vm = require('vm');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'plan-staff.js'), 'utf8'), sb);
    const F = sb.window.PlanStaff;
    need(F && typeof F.parseStaff === 'function' && typeof F.findConflicts === 'function',
      'plan-staff.js 应导出 parseStaff / participantsOf / overlaps / findConflicts');

    const ps = F.parseStaff('张三/13800138000；李四/；王五/139/001');
    need(ps.length === 3 && ps[0].name === '张三' && ps[0].phone === '13800138000' &&
      ps[1].name === '李四' && ps[1].phone === '' &&
      ps[2].name === '王五/139' && ps[2].phone === '001',
      '分号分条目 / 最后一个斜杠分姓名电话 / 电话可空：' + brief(ps));
    need(F.parseStaff('').length === 0 && F.parseStaff(null).length === 0, '空名单应返回空数组');
    need(F.keyOf(' 张三 ', ' 138 ') === '张三|138', '比对键应去空白：' + F.keyOf(' 张三 ', ' 138 '));
    const parts = F.participantsOf({ staffText: '张三/13800138000；李四/', chargePerson: '张三', chargePersonPhone: '13800138000' });
    need(JSON.stringify(parts) === JSON.stringify(['张三|13800138000', '李四|']), '参与人键应含实施人员+负责人且去重：' + brief(parts));
    need(F.participantsOf({ staffText: '', chargePerson: '', chargePersonPhone: '139' }).length === 0, '负责人姓名为空不加键');

    const T = '2026-11-10';
    need(F.overlaps(T + ' 09:00:00', T + ' 12:00:00', T + ' 11:00:00', T + ' 14:00:00'), '重叠应判定冲突');
    need(!F.overlaps(T + ' 09:00:00', T + ' 12:00:00', T + ' 12:00:00', T + ' 14:00:00'), '首尾恰好相接不算冲突');
    need(!F.overlaps(T + ' 12:00:00', T + ' 14:00:00', T + ' 09:00', T + ' 12:00:00'), '相接（HH:mm / HH:mm:ss 混写）也不算冲突');
    need(!F.overlaps(T + ' 09:00:00', T + ' 12:00:00', '', T + ' 14:00:00'), '任一时间缺失返回 false');

    const A = { id: 'A', name: '计划A', planType: '周计划', status: '未执行',
      startDate: T + ' 09:00:00', endDate: T + ' 12:00:00',
      staffText: '张三/13800138000；李四/', chargePerson: '王五', chargePersonPhone: '13900000001' };
    const others = [
      A,
      { ...A, id: 'B', name: '月计划B', planType: '月计划' },
      { ...A, id: 'C', name: '已执行C', status: '已执行' },
      { ...A, id: 'D', name: '已取消D', status: '已取消' },
      { ...A, id: 'E', name: '不重叠E', startDate: T + ' 12:00:00', endDate: T + ' 14:00:00' },
      { ...A, id: 'F', name: '无状态F', status: '' }
    ];
    const cf = F.findConflicts(others, '', T + ' 10:00:00', T + ' 11:00:00');
    need(Object.keys(cf).length === 3 && cf['张三|13800138000'].length === 1 &&
      cf['张三|13800138000'][0].name === '计划A' && cf['李四|'] && cf['王五|13900000001'],
      '只计周计划+未执行+重叠；月计划/已执行/已取消/无状态/相接均排除：' + brief(Object.keys(cf)));
    need(Object.keys(F.findConflicts(others, 'A', T + ' 10:00:00', T + ' 11:00:00')).length === 0,
      'selfId 应排除自身计划');
    need(Object.keys(F.findConflicts(others, '', '', T + ' 11:00:00')).length === 0, '起止任一为空时不产生冲突');
    return '解析 3 项/空值/最后斜杠 + 相接边界（含混写）+ 占用方类型/状态/自排除/时间窗';
  });

  await step('结构', '计划管理优化批：日历页签与口径 / 高处全等 / 无班组排除 / 冲突接线静态防回归', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const p = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'plans.js'), 'utf8');
    const iS = html.indexOf('<script src="/js/plan-staff.js"></script>');
    const iP = html.indexOf('<script src="/js/views/plans.js"></script>');
    need(iS > -1 && iS < iP, 'plan-staff.js 必须先于 views/plans.js 加载');
    need(/p\.planType === '周计划'/.test(p) &&
      /!\['已归档', '已取消', '已执行', '已结算'\]\.includes\(p\.status\)/.test(p) &&
      /const upcoming = computed/.test(p), '日历 upcoming 应限周计划且排除归档/取消/执行/结算');
    // 日计划日历是周计划管理的东西：月计划/已归档/已执行/已结算/已取消五个页签一律不渲染
    need(/v-if="tab === 'week'"/.test(p) && !/v-if="tab !== 'month'"/.test(p),
      '日计划日历卡应只在 tab==="week" 显示，不得再用 tab !== "month"');
    need(/日计划日历只在「周计划管理」页签显示/.test(p), '日历卡上方注释应写明显示范围');
    need(/=== '技工（计入高处作业人员）'/.test(p) &&
      !/\.includes\('计入高处作业人员'\)/.test(p), 'highStaff 应全等匹配，不得用子串 includes');
    need(/WorkerStatus\.of\(w, ServerTime\.ymd\(\)\)\.admitted && String\(w\.team \|\| ''\)\.trim\(\)/.test(p) &&
      !/w\.team \|\| '未分组'/.test(p), 'groupedTeams 应先滤掉无班组人员且不再兜「未分组」');
    need(/findConflicts\(/.test(p) && /staffConflict\(/.test(p) && /ElMessageBox\.alert/.test(p),
      '视图层应调用 findConflicts / staffConflict 并有保存兜底弹窗');
    need(/<el-checkbox[^>]*:disabled="staffConflict\(w\)\.length > 0"/.test(p) &&
      !/staffConflictText|staffConflictTitle/.test(p) && !/已参与：/.test(p) && !/:title="staffConflict/.test(p),
      '选人弹窗对冲突人员只置灰，不得渲染「已参与」标注或悬停提示（2026-11-10 裁定）');
    const op = p.slice(p.indexOf('function openStaffPick'), p.indexOf('function toggleIdentity'));
    need(op.indexOf('请先填写计划开始时间') > -1 && op.indexOf('请先填写计划结束时间') > -1 &&
      op.indexOf('请先填写计划开始时间') < op.indexOf('staffPick.visible = true') &&
      op.indexOf('请先填写计划结束时间') < op.indexOf('staffPick.visible = true'),
      '选人弹窗必须在填完计划开始/结束时间后才允许打开（空时间先提示）');
    return '脚本顺序 / 日历仅周计划页签 + 四状态+类型 / 高处全等 / 无班组过滤 / 冲突接线 / 冲突只置灰无标注 / 选人先校验时间';
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
