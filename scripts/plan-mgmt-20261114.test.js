/* ========== scripts/plan-mgmt-20261114.test.js ========== */
/* 计划管理优化 Step 3 / Step 4 / Step 5A / Step 5B 共用的「进程内隔离测试」。
 * 直接运行：node scripts/plan-mgmt-20261114.test.js
 *
 * 隔离方式（不监听端口 / 不启动服务 / 不写生产数据）：
 *  - 用 Module._load 按解析后的绝对路径，只替换 server/core/app.js（路由收集器）
 *    与 server/core/db.js（内存 DB + saveDB 计数桩）。真实 core/db.js 加载即
 *    migrateDB()→saveDB() 写盘，故必须替换；本测试断言它从未进入 require.cache。
 *  - 其余依赖全部加载仓库真实模块：core/util、core/plan-ticket-no（Step 2）、
 *    core/crud、core/upload(multer)、core/doc-templates、core/survey-doc、xlsx、exceljs。
 *  - require('server/routes/plans.js') 触发真实注册；从收集器取出注册在 crud()
 *    之前的专用 POST /api/workPlans 与专用 PUT /api/workPlans/:id handler，直接以 mock req/res 调用。
 *  - 没有任何 http.createServer / app.listen 调用；真实 data/db.json 只读做 md5 前后比对。
 *
 * 不声称：跨进程全局锁、磁盘原子写 / 半写安全（r6 2.7）。
 * 独立计数，不与 scripts/smoke.js 的 169、也不与 plan-ticket-no.test.js 的 121 混报。
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_PATH = require.resolve(path.join(ROOT, 'server/core/app.js'));
const DB_PATH = require.resolve(path.join(ROOT, 'server/core/db.js'));
const PLANS_PATH = require.resolve(path.join(ROOT, 'server/routes/plans.js'));
const SPLIT_ROUTES_PATH = require.resolve(path.join(ROOT, 'server/routes/plan-split.js'));
const REAL_DB = path.join(ROOT, 'data', 'db.json');
const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const REAL_DB_MD5_BEFORE = md5(REAL_DB);

const util = require('../server/core/util');
const PTM = require('../server/core/plan-ticket-no');

// 操作当天月份：与 routes/materials.js 的 todayBizDate() 同源 bjStr（Asia/Shanghai）
const YM = util.bjStr().slice(0, 10).replace(/-/g, '').slice(0, 6);
const YM_LABEL = YM.slice(0, 4) + '-' + YM.slice(4, 6);
const T1 = '配电：配电第一种工作票';   // 码 6
const T2 = '配电：配电第二种工作票';   // 码 7
const T3 = '配电：低压工作票';         // 码 9
const L1 = '线路：线路第一种工作票';
const OLD11 = YM + '68' + '001';       // 历史 11 位旧格式
const N = (code, serial) => YM + code + String(serial).padStart(3, '0');

/* ---------- 隔离沙箱（整个测试进程只装配一次，逐用例 reset） ---------- */
const state = { listenCalled: 0, saveCalls: 0, throwNext: false };
const routes = [];
const reg = method => (p, ...handlers) => {
  routes.push({ method, path: p, handler: handlers[handlers.length - 1] });
};
const fakeApp = {
  get: reg('GET'), post: reg('POST'), put: reg('PUT'), delete: reg('DELETE'),
  use() {}, listen() { state.listenCalled += 1; }
};
const DB = { workPlans: [], plans: [] };
const dbStub = {
  DB,
  saveDB() { state.saveCalls += 1; if (state.throwNext) throw new Error('simulated disk failure'); },
  DATA_DIR: path.join(ROOT, 'data'), DB_PATH: REAL_DB,
  WT_COLLECTIONS: [], DEFAULT_LOGIN_BG: '', ROLE_ADMIN: '', USER_GROUPS: []
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = null;
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (e) { /* 走原逻辑 */ }
  if (resolved === APP_PATH) return fakeApp;
  if (resolved === DB_PATH) return dbStub;
  return origLoad.call(this, request, parent, isMain);
};
delete require.cache[PLANS_PATH];
try {
  require(PLANS_PATH);
  // Step 6：同一隔离沙箱内加载拆分路由（真实注册；不监听端口、不触真实库）
  require(SPLIT_ROUTES_PATH);
} finally {
  Module._load = origLoad;
}

const workPlanPosts = routes.filter(r => r.method === 'POST' && r.path === '/api/workPlans');
const specialized = workPlanPosts.length ? workPlanPosts[0].handler : null;
const crudPost = workPlanPosts.length > 1 ? workPlanPosts[1] : null;
// Step 5A：专用编辑 PUT 与 crud 通用 PUT 同路径，按注册顺序区分（专用在前）
const planPuts = routes.filter(r => r.method === 'PUT' && r.path === '/api/workPlans/:id');
const specializedPut = planPuts.length ? planPuts[0].handler : null;
const crudPut = planPuts.length > 1 ? planPuts[1].handler : null;

function reset(seed) {
  DB.workPlans.length = 0;                       // 保持同一数组引用（handler 闭包持有它）
  (seed || []).forEach(r => DB.workPlans.push(r));
  state.saveCalls = 0;
  state.throwNext = false;
  return (seed || []).length;
}
function invoke(body) {
  const req = { body, params: {}, query: {}, headers: {} };
  const res = {
    statusCode: 200, payload: undefined, headers: {},
    status(n) { this.statusCode = n; return this; },
    json(v) { this.payload = v; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; },
    send(v) { this.payload = v; return this; }
  };
  let thrown = null;
  try { specialized(req, res, () => { throw new Error('unexpected next()'); }); }
  catch (e) { thrown = e; }
  return {
    req, res, thrown, DB,
    count: DB.workPlans.length,
    last: DB.workPlans[DB.workPlans.length - 1]
  };
}
function call(body, seed) {
  const seedLen = reset(seed);
  const r = invoke(body);
  r.seedLen = seedLen;
  return r;
}
/* Step 5A：调用专用编辑 PUT（真实 handler，桩 req/res；params.id 走路径参数） */
function putCall(id, body, seed, opts) {
  reset(seed);
  if (opts && opts.throwNext) state.throwNext = true;
  const req = { body, params: { id }, query: {}, headers: {}, user: { name: 'ZT-5A', username: 'zt' } };
  const res = {
    statusCode: 200, payload: undefined,
    status(n) { this.statusCode = n; return this; },
    json(v) { this.payload = v; return this; },
    send(v) { this.payload = v; return this; },
    setHeader() {}
  };
  let thrown = null;
  try { specializedPut(req, res, () => { throw new Error('unexpected next()'); }); }
  catch (e) { thrown = e; }
  return { req, res, thrown, row: DB.workPlans.find(x => x.id === id), rows: DB.workPlans };
}
const autoBody = (extra) => Object.assign({
  planType: '周计划', ticketType: T1, ticketNoMode: 'auto',
  workTicketNo: 'CLIENT-PREFILL', name: 'ZT-Step3-自动'
}, extra || {});
const manualBody = (no, extra) => Object.assign({
  planType: '周计划', ticketType: T1, ticketNoMode: 'manual',
  workTicketNo: no, name: 'ZT-Step3-手填'
}, extra || {});
const rec = (id, no, extra) => Object.assign({ id, workTicketNo: no, ticketType: T1, deleted: false }, extra || {});

/* ---------- 轻量测试框架（顺序执行、支持 async） ---------- */
let total = 0, passed = 0, failed = 0;
let group = '(未分组)';
const groups = {};
const queue = [];
function g(name) { group = name; groups[name] = { pass: 0, fail: 0 }; }
function t(name, fn) { queue.push({ name, fn, group }); }

/* ========== A 装配、注册顺序与隔离性 ========== */
g('A 装配、注册顺序与隔离性（不监听端口 / 不加载真实库）');
t('A1 POST /api/workPlans 注册两份：专用在前、crud 通用在后', () => {
  assert.equal(workPlanPosts.length, 2);
  assert.ok(routes.indexOf(workPlanPosts[0]) < routes.indexOf(workPlanPosts[1]));
  assert.equal(typeof specialized, 'function');
  assert.equal(typeof crudPost.handler, 'function');
});
t('A2 取到的是专用 handler（源码含 MODE_REQUIRED，且为 crud 之前注册）', () => {
  assert.match(String(specialized), /MODE_REQUIRED/);
  assert.doesNotMatch(String(crudPost.handler), /MODE_REQUIRED/);
});
t('A3 未调用 app.listen（未监听端口、未启动服务）', () => {
  assert.equal(state.listenCalled, 0);
});
t('A4 真实 server/core/db.js 从未加载（require.cache 无该模块）', () => {
  assert.equal(require.cache[DB_PATH], undefined);
});
t('A5 真实 data/db.json 与开工时 md5 一致（进程内测试未写生产库）', () => {
  assert.equal(md5(REAL_DB), REAL_DB_MD5_BEFORE);
});

/* ========== B 分流与透传：原规则未被破坏 ========== */
g('B 分流与透传（先豁免、再目标；非目标沿用通用创建语义）');
t('B1 线路票种 + 缺 mode → 透传成功，不受 801 / MODE_REQUIRED 误伤', () => {
  const r = call({ planType: '周计划', ticketType: L1, workTicketNo: OLD11, name: '线路单' });
  assert.equal(r.thrown, null);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.count, 1);
  assert.equal(r.last.workTicketNo, OLD11);
  assert.equal(state.saveCalls, 1);
});
t('B2 线路票种 + mode manual + 非法号 → 仍透传（不套配电规则）', () => {
  const r = call(manualBody('NOT-A-NUMBER', { ticketType: L1 }));
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.last.workTicketNo, 'NOT-A-NUMBER');
  assert.equal(state.saveCalls, 1);
});
t('B3 月计划且无票号 + 带配电票种 + 缺 mode → 豁免成功（不 MODE_REQUIRED、不取号）', () => {
  const r = call({ planType: '月计划', ticketType: T1, name: '月计划带票种' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.count, 1);
  assert.equal(r.last.workTicketNo, undefined);
  assert.equal(state.saveCalls, 1);
});
t('B4 月计划且无票号 + 带配电票种 + mode auto → 仍先豁免，不生成号', () => {
  const r = call({ planType: '月计划', ticketType: T1, ticketNoMode: 'auto', name: '月计划auto' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.last.workTicketNo, undefined);
  assert.equal(state.saveCalls, 1);
});
t('B5 月计划且无票号 + 无票种 → 豁免成功', () => {
  const r = call({ planType: '月计划', name: '月计划无票种' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.count, 1);
});
t('B6 其它非目标（周计划、无票种）→ 透传成功', () => {
  const r = call({ planType: '周计划', name: '普通计划' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.count, 1);
});
t('B7 非目标分支不新增规范化：body 字段逐字保留，仅剥离 ticketNoMode', () => {
  const body = {
    planType: '周计划', ticketType: L1, ticketNoMode: 'auto',
    workTicketNo: '  保留原样  ', name: '  名称  ', address: '', status: '未执行'
  };
  const r = call(body);
  assert.equal(r.last.workTicketNo, '  保留原样  ');
  assert.equal(r.last.name, '  名称  ');
  assert.equal(r.last.address, '');
  assert.equal(r.last.status, '未执行');
  assert.equal(r.last.ticketType, L1);
  assert.ok(!('ticketNoMode' in r.last));
});
t('B8 全分支保留原 crud 记录形态：id/createdAt/deleted/构造顺序/HTTP/响应', () => {
  const r = call({ planType: '周计划', ticketType: L1, name: '形态核对' });
  const keys = Object.keys(r.last);
  assert.equal(keys[0], 'id');
  assert.equal(keys[1], 'createdAt');
  assert.equal(keys[keys.length - 1], 'deleted');
  assert.match(r.last.id, /^wo/);                       // genId(prefix.slice(0,2)) = genId('wo')
  assert.match(r.last.createdAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(r.last.deleted, false);
  assert.equal(r.res.statusCode, 200);                  // res.json(item) 默认 200
  assert.equal(r.res.payload, r.last);                  // 响应体即落库的同一对象
});

/* ========== C auto：分配、并发、回读、号源口径、耗尽 ========== */
g('C auto：服务端生成号、并发/逐次不重复、号源口径、EXHAUSTED');
t('C1 auto 忽略客户端预填号，保存服务端生成号（YYYYMM+码+801）', () => {
  const r = call(autoBody());
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.last.workTicketNo, N('6', 801));
  assert.notEqual(r.last.workTicketNo, 'CLIENT-PREFILL');
});
t('C2 auto 落库回读：DB 记录号 === 生成号，响应体 === 落库记录', () => {
  const r = call(autoBody());
  assert.equal(r.res.payload.workTicketNo, N('6', 801));
  assert.equal(r.last.workTicketNo, r.res.payload.workTicketNo);
  assert.equal(state.saveCalls, 1);
});
t('C3 auto 并发到达（queueMicrotask 交错）不重复', async () => {
  reset([]);
  const bodies = Array.from({ length: 6 }, () => autoBody());
  const rs = await Promise.all(bodies.map(b => new Promise(resolve =>
    queueMicrotask(() => resolve(invoke(b))))));
  const nos = rs.map(r => r.last.workTicketNo);
  assert.equal(new Set(nos).size, 6);
  assert.deepEqual(nos.slice().sort(), [801, 802, 803, 804, 805, 806].map(s => N('6', s)));
});
t('C4 同一流程逐次创建、逐次 saveDB，号严格递进（801…806）', () => {
  reset([]);
  const nos = [];
  for (let i = 0; i < 6; i++) nos.push(invoke(autoBody()).last.workTicketNo);
  assert.deepEqual(nos, [801, 802, 803, 804, 805, 806].map(s => N('6', s)));
  assert.equal(state.saveCalls, 6);
  assert.equal(DB.workPlans.length, 6);
});
t('C5 auto 分支除 workTicketNo 外不改记录（ticketType 等原样）', () => {
  const r = call(autoBody({ ticketType: T2, project: 'P-1' }));
  assert.equal(r.last.ticketType, T2);
  assert.equal(r.last.project, 'P-1');
  assert.equal(r.last.workTicketNo, N('7', 801));
  assert.ok(!('ticketNoMode' in r.last));
});
t('C6 EXHAUSTED：999 已占用 → 400 + 错误码，message 指明月份与票种，saveDB 0', () => {
  const r = call(autoBody(), [rec('seed', N('6', 999))]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'EXHAUSTED');
  assert.ok(r.res.payload.message.includes(YM_LABEL));
  assert.ok(r.res.payload.message.includes(T1));
  assert.equal(state.saveCalls, 0);
  assert.equal(r.count, r.seedLen);
});
t('C7 号源只统计存活：软删的 999 不占号 → 仍得 801', () => {
  const r = call(autoBody(), [rec('seed', N('6', 999), { deleted: true })]);
  assert.equal(r.last.workTicketNo, N('6', 801));
});
t('C8 号源只认新格式：历史 11 位不占新流水 → 得 801', () => {
  const r = call(autoBody(), [rec('seed', OLD11)]);
  assert.equal(r.last.workTicketNo, N('6', 801));
});
t('C9 不跨月借号：上月 999 占用，本月仍从 801 起', () => {
  const prevYM = YM.slice(4, 6) === '01'
    ? String(Number(YM.slice(0, 4)) - 1) + '12'
    : YM.slice(0, 4) + String(Number(YM.slice(4, 6)) - 1).padStart(2, '0');
  const r = call(autoBody(), [rec('seed', prevYM + '6' + '999')]);
  assert.equal(r.last.workTicketNo, N('6', 801));
});
t('C10 不补中间空号：仅 805 占用 → 806（max+1）', () => {
  const r = call(autoBody(), [rec('seed', N('6', 805))]);
  assert.equal(r.last.workTicketNo, N('6', 806));
});
t('C11 三种配电票种各自独立码（6 / 7 / 9）', () => {
  assert.equal(call(autoBody({ ticketType: T1 })).last.workTicketNo, N('6', 801));
  assert.equal(call(autoBody({ ticketType: T2 })).last.workTicketNo, N('7', 801));
  assert.equal(call(autoBody({ ticketType: T3 })).last.workTicketNo, N('9', 801));
});
t('C12 auto 分支剥离 ticketNoMode，不写为记录字段', () => {
  const r = call(autoBody());
  assert.ok(!('ticketNoMode' in r.last));
  assert.equal(r.req.body.ticketNoMode, 'auto');       // 不改原请求体
});

/* ========== D manual：规范化保存与校验失败 ========== */
g('D manual：校验与保存使用同一规范化值、校验失败拒绝');
t('D1 manual 合规 + 首尾空白 → 落库为规范化（trim）后的 ticketType / workTicketNo', () => {
  const r = call(manualBody('  ' + N('6', 801) + '  ', { ticketType: '  ' + T1 + '  ' }));
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.last.workTicketNo, N('6', 801));
  assert.equal(r.last.ticketType, T1);
  assert.equal(state.saveCalls, 1);
});
t('D2 落库值可被 Step 2 模块以同一规范化票种复核通过（校验值==保存值）', () => {
  const r = call(manualBody('  ' + N('6', 803) + '\t', { ticketType: ' ' + T1 }));
  const chk = PTM.assertDistWorkTicketNoAvailable({
    workTicketNo: r.last.workTicketNo, ticketType: r.last.ticketType,
    records: DB.workPlans, excludeIds: [r.last.id]
  });
  assert.equal(chk.ok, true);
  assert.equal(r.res.payload.workTicketNo, r.last.workTicketNo);
});
t('D3 manual 格式错误（历史 11 位）→ 400 INVALID_INPUT，saveDB 0', () => {
  const r = call(manualBody(OLD11));
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
  assert.equal(r.count, r.seedLen);
});
t('D4 manual 票种码不符（第一种票用 7 码）→ 400 INVALID_INPUT，saveDB 0', () => {
  const r = call(manualBody(N('7', 801)));
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
});
t('D5 manual 存活撞号 → 400 DUPLICATE，saveDB 0', () => {
  const r = call(manualBody(N('6', 801)), [rec('other', N('6', 801))]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'DUPLICATE');
  assert.equal(state.saveCalls, 0);
  assert.equal(r.count, r.seedLen);
});
t('D6 manual 号段外（800）→ 400 INVALID_INPUT，saveDB 0', () => {
  const r = call(manualBody(YM + '6' + '800'));
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
});
t('D7 manual 空号 → 400 INVALID_INPUT，saveDB 0', () => {
  const r = call(manualBody('   '));
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
});
t('D8 manual 分支剥离 ticketNoMode，且保存的是规范化后的号而非原空白串', () => {
  const r = call(manualBody(' ' + N('6', 802) + ' '));
  assert.ok(!('ticketNoMode' in r.last));
  assert.equal(r.last.workTicketNo, N('6', 802));
});

/* ========== E 缺 mode / 非法 mode ========== */
g('E 缺 mode 或 mode 为其它值 → MODE_REQUIRED（不默判 auto）');
t('E1 缺 mode → 400 MODE_REQUIRED，不落库，不覆盖预填号，不重算', () => {
  const body = { planType: '周计划', ticketType: T1, workTicketNo: 'PREFILL-XYZ', name: '缺mode' };
  const r = call(body);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'MODE_REQUIRED');
  assert.equal(r.count, 0);
  assert.equal(state.saveCalls, 0);
  assert.equal(r.req.body.workTicketNo, 'PREFILL-XYZ');
});
t('E2 非法 mode 逐项（AUTO/auto2/空串/null/0/数组/对象）→ 400 MODE_REQUIRED', () => {
  ['AUTO', 'auto2', '', null, 0, [], {}].forEach(m => {
    const r = call(autoBody({ ticketNoMode: m }));
    assert.equal(r.res.statusCode, 400, 'mode=' + JSON.stringify(m));
    assert.equal(r.res.payload.error, 'MODE_REQUIRED', 'mode=' + JSON.stringify(m));
    assert.equal(r.count, 0);
    assert.equal(state.saveCalls, 0);
  });
});
t('E3 缺 mode 时不把预填号当已校验 manual 落库（合规划号也不行）', () => {
  const r = call({ planType: '周计划', ticketType: T1, workTicketNo: N('6', 801) });
  assert.equal(r.res.payload.error, 'MODE_REQUIRED');
  assert.equal(r.count, 0);
  assert.equal(state.saveCalls, 0);
});

/* ========== F 零保存证据（主证据：saveDB 调用次数） ========== */
g('F 零保存证据：逐项直接断言 saveDB 调用次数为 0');
t('F1 六类失败逐项 saveCalls === 0（格式/码不符/撞号/缺mode/非法mode/耗尽）', () => {
  const cases = [
    ['格式错误', manualBody(OLD11), []],
    ['票种码不符', manualBody(N('7', 801)), []],
    ['存活撞号', manualBody(N('6', 801)), [rec('other', N('6', 801))]],
    ['缺失 mode', { planType: '周计划', ticketType: T1, workTicketNo: N('6', 801) }, []],
    ['非法 mode', autoBody({ ticketNoMode: 'AUTO' }), []],
    ['耗尽 EXHAUSTED', autoBody(), [rec('seed', N('6', 999))]]
  ];
  cases.forEach(([label, body, seed]) => {
    const r = call(body, seed);
    assert.equal(r.res.statusCode, 400, label);
    assert.equal(state.saveCalls, 0, label + ' 的 saveDB 调用次数必须为 0');
  });
});
t('F2 补充证据：各失败用例 DB 记录数不变、请求体未被改写', () => {
  const cases = [
    [manualBody(OLD11), []],
    [manualBody(N('6', 801)), [rec('other', N('6', 801))]],
    [autoBody(), [rec('seed', N('6', 999))]]
  ];
  cases.forEach(([body, seed]) => {
    const r = call(body, seed);
    assert.equal(r.count, r.seedLen);
    assert.equal(r.req.body.ticketNoMode, body.ticketNoMode);
  });
});
t('F3 补充证据：失败分支不新增任何 workPlans 记录（含月计划豁免分支正常落库对照）', () => {
  const bad = call(manualBody(OLD11), [rec('seed', N('6', 801))]);
  assert.equal(bad.count, 1);
  const good = call({ planType: '月计划', name: '豁免' }, [rec('seed', N('6', 801))]);
  assert.equal(good.count, 2);
  assert.equal(state.saveCalls, 1);
});

/* ========== G saveDB 抛错后的内存回滚 ========== */
g('G saveDB 抛错后内存回滚（不声称磁盘原子 / 半写安全）');
t('G1 saveDB 抛错 → 500 SAVE_FAILED，内存回滚到调用前，无孤儿记录', () => {
  reset([rec('seed', N('6', 801))]);
  state.throwNext = true;
  const r = invoke(autoBody());
  assert.equal(r.res.statusCode, 500);
  assert.equal(r.res.payload.error, 'SAVE_FAILED');
  assert.equal(r.count, 1);                       // 回到调用前的 1 条
  assert.equal(DB.workPlans[0].id, 'seed');
  assert.equal(state.saveCalls, 1);              // 确实尝试过一次保存
});
t('G2 回滚后下一次创建仍取到同一号（内存状态干净、不残留占用）', () => {
  reset([]);
  state.throwNext = true;
  invoke(autoBody());
  assert.equal(DB.workPlans.length, 0);
  state.throwNext = false;
  const r = invoke(autoBody());
  assert.equal(r.last.workTicketNo, N('6', 801));
});
t('G3 非目标透传分支同样在 saveDB 抛错时内存回滚', () => {
  reset([]);
  state.throwNext = true;
  const r = invoke({ planType: '周计划', ticketType: L1, name: '线路回滚' });
  assert.equal(r.res.statusCode, 500);
  assert.equal(r.count, 0);
});

/* ========== H 全分支剥离 ticketNoMode ========== */
g('H 全分支落库记录均不含 ticketNoMode');
t('H1 auto / manual / 月计划豁免 / 线路 / 其它非目标 五条成功分支逐项断言', () => {
  const cases = [
    autoBody(),
    manualBody(N('6', 801)),
    { planType: '月计划', ticketType: T1, ticketNoMode: 'auto', name: '月计划' },
    { planType: '周计划', ticketType: L1, ticketNoMode: 'manual', workTicketNo: OLD11 },
    { planType: '周计划', ticketNoMode: 'auto', name: '其它' }
  ];
  cases.forEach((body, i) => {
    const r = call(body);
    assert.equal(r.res.statusCode, 200, 'case ' + i);
    assert.ok(!('ticketNoMode' in r.last), 'case ' + i + ' 不应写入 ticketNoMode');
  });
});

/* ========== I 其它集合 / 通用 DELETE / 既有专用端点 / 勘察 / 导入不变 ========== */
g('I 其它集合、通用 DELETE、既有专用端点、勘察生成与导入不变');
t('I1 crud 仍为 plans / workPlans 两集合注册 GET/POST/PUT/DELETE', () => {
  ['plans', 'workPlans'].forEach(c => {
    const base = '/api/' + c;
    ['GET', 'POST', 'PUT', 'DELETE'].forEach(m => {
      const hit = routes.some(r => r.method === m && (r.path === base || r.path === base + '/:id'));
      assert.ok(hit, m + ' ' + base + ' 应仍注册');
    });
  });
});
t('I2 PUT /api/workPlans/:id 现为 2 条：Step 5A 专用在前、crud 通用在后（通用不得绕过门禁）', () => {
  // Step 3 时该路径只有 crud 注册的 1 条（本断言原文即注明「Step 5 才挂」）；
  // Step 5A 已挂专用编辑 PUT，故此处改为：恰好 2 条，专用含判别、crud 仍为 cur+body 合并且不含判别。
  const puts = routes.filter(r => r.method === 'PUT' && r.path === '/api/workPlans/:id');
  assert.equal(puts.length, 2);
  assert.match(String(puts[0].handler), /classifyPlanTicketEdit/, '第 1 条应为 Step 5A 专用 handler');
  assert.match(String(puts[1].handler), /\.\.\.cur|merged/, '第 2 条应为通用 crud 合并语义');
  assert.doesNotMatch(String(puts[1].handler), /MODE_REQUIRED|classifyPlanTicketEdit/);
});
t('I3 plans.js 中声明的全部专用端点仍逐一注册（含勘察、工量、导入、导出）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/plans.js'), 'utf8');
  const expected = [...src.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)]
    .map(m => ({ method: m[1].toUpperCase(), path: m[2] }));
  assert.ok(expected.length >= 14);
  expected.forEach(e => {
    const hit = routes.find(r => r.method === e.method && r.path === e.path);
    assert.ok(hit, e.method + ' ' + e.path + ' 应仍注册');
    assert.equal(typeof hit.handler, 'function');
  });
});
t('I4 勘察生成端点仍注册，且 handler 与本次改动无关（不含 mode 逻辑）', () => {
  const gen = routes.find(r => r.method === 'POST' && r.path === '/api/workPlans/:id/survey/generate');
  const survey = routes.find(r => r.method === 'PUT' && r.path === '/api/workPlans/:id/survey');
  assert.ok(gen && typeof gen.handler === 'function');
  assert.ok(survey && typeof survey.handler === 'function');
  assert.doesNotMatch(String(gen.handler), /ticketNoMode|MODE_REQUIRED/);
});
t('I5 导入端点 POST /api/workPlans/import 仍注册且未套 mode 逻辑（留 Step 5）', () => {
  const imp = routes.find(r => r.method === 'POST' && r.path === '/api/workPlans/import');
  assert.ok(imp && typeof imp.handler === 'function');
  assert.doesNotMatch(String(imp.handler), /ticketNoMode|MODE_REQUIRED/);
});

/* ========== J 收尾隔离性复核 ========== */
g('J 收尾：进程内隔离性复核');
t('J1 真实 data/db.json md5 与开工时一致（全程零写生产数据）', () => {
  assert.equal(md5(REAL_DB), REAL_DB_MD5_BEFORE);
});
t('J2 全程未监听端口（app.listen 调用次数 0）', () => {
  assert.equal(state.listenCalled, 0);
});
t('J3 真实 server/core/db.js 始终未进入 require.cache', () => {
  assert.equal(require.cache[DB_PATH], undefined);
});

/* ========== Step 4：K 前端预填纯函数（public/js/plan-no.js，进程内直载） ========== */
// plan-no.js 以 IIFE 挂到「window 或 this」；CommonJS 模块顶层 this === module.exports，
// Node 直载即得 PlanNo。ymOf 的 ServerTime 分支不会触发（全部用例显式传 ym）。
const planNo = require('../public/js/plan-no.js').PlanNo;
const PNO_ROOT = path.join(ROOT, 'public/js/plan-no.js');
const VIEWS_PLANS = fs.readFileSync(path.join(ROOT, 'public/js/views/plans.js'), 'utf8');
const VIEWS_MONTH = fs.readFileSync(path.join(ROOT, 'public/js/views/monthPlans.js'), 'utf8');
const PN = (code, serial) => YM + code + String(serial).padStart(3, '0');
const seedRec = (no, extra) => Object.assign({ workTicketNo: no, ticketType: T1, deleted: false }, extra || {});
// 截取某函数源码段（自「function 名(」起至下一个同层 function / async function 声明），供静态断言用
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > -1, '函数 ' + name + ' 应存在');
  let end = src.length;
  ['\n    function ', '\n    async function '].forEach(pat => {
    const j = src.indexOf(pat, i + 10);
    if (j > -1 && j < end) end = j;
  });
  return src.slice(i, end);
}

g('K 前端预填纯函数（配电新格式：按月按票种、max+1、旧11位不计、耗尽 null）');
t('K1 nextDistTicketNo 基线：空记录 → 三票种各自 801（一位码 6/7/9）', () => {
  assert.equal(planNo.nextDistTicketNo([], YM, T1), PN('6', 801));
  assert.equal(planNo.nextDistTicketNo([], YM, T2), PN('7', 801));
  assert.equal(planNo.nextDistTicketNo([], YM, T3), PN('9', 801));
});
t('K2 同月同票种取 max+1：仅 805 占用 → 806（不补中间空号）', () => {
  assert.equal(planNo.nextDistTicketNo([seedRec(PN('6', 805))], YM, T1), PN('6', 806));
});
t('K3 票种独立：码 6 与码 7 各记各的，互不相干', () => {
  const seeds = [seedRec(PN('6', 999)), seedRec(PN('7', 803), { ticketType: T2 })];
  assert.equal(planNo.nextDistTicketNo(seeds, YM, T1), null);      // 码 6 耗尽
  assert.equal(planNo.nextDistTicketNo(seeds, YM, T2), PN('7', 804));
});
t('K4 业务月独立（不跨月借号）：上月 999 不占本月 → 801', () => {
  const prevYM = YM.slice(4, 6) === '01'
    ? String(Number(YM.slice(0, 4)) - 1) + '12'
    : YM.slice(0, 4) + String(Number(YM.slice(4, 6)) - 1).padStart(2, '0');
  assert.equal(planNo.nextDistTicketNo([seedRec(prevYM + '6' + '999')], YM, T1), PN('6', 801));
});
t('K5 历史 11 位旧格式不计入新流水 → 仍得 801', () => {
  assert.equal(planNo.nextDistTicketNo([seedRec(OLD11)], YM, T1), PN('6', 801));
});
t('K6 软删记录不占号：deleted 的 999 → 801', () => {
  assert.equal(planNo.nextDistTicketNo([seedRec(PN('6', 999), { deleted: true })], YM, T1), PN('6', 801));
});
t('K7 801–999 占满 → 返回 null（不生成 1000、不扩位）', () => {
  assert.equal(planNo.nextDistTicketNo([seedRec(PN('6', 999))], YM, T1), null);
});
t('K8 isDistPowerTicketType：配电三 true；线路/未知/空/非字符串 false', () => {
  [T1, T2, T3].forEach(x => assert.equal(planNo.isDistPowerTicketType(x), true, x));
  [L1, '未映射的类型', '', null, 123, undefined].forEach(x => assert.equal(planNo.isDistPowerTicketType(x), false, String(x)));
});
t('K8b isDistPowerTicketType 口径 = trim 后查码表（与手填空白一致）', () => {
  assert.equal(planNo.isDistPowerTicketType('  ' + T1 + '  '), true);
});
t('K9 prefillTicketNo 统一分流：配电走新格式；线路沿用既有 nextTicketNo', () => {
  assert.equal(planNo.prefillTicketNo([], YM, T1), PN('6', 801));
  assert.equal(planNo.prefillTicketNo([], YM, L1), planNo.nextTicketNo([], YM, L1));
  assert.equal(planNo.prefillTicketNo([], YM, L1), YM + '67' + '001');
});
t('K10 nextTicketNo 旧行为零改动：配电一号仍为 11 位旧口径（冒烟既有断言不受影响）', () => {
  const seeds = [seedRec(YM + '68' + '001'), seedRec(YM + '68' + '002')];
  assert.equal(planNo.nextTicketNo(seeds, YM, T1), YM + '68' + '003');
  assert.equal(planNo.nextTicketNo([], YM, '未映射的类型'), YM);
});
t('K11 号源口径：记录票号首尾空白不影响匹配（noOf 已 trim）', () => {
  assert.equal(planNo.nextDistTicketNo([seedRec('  ' + PN('6', 805) + '  ')], YM, T1), PN('6', 806));
});

/* ========== Step 4：L views/plans.js 静态断言（mode 上报 / 预填 / 脏标记 / 手填保留） ========== */
g('L views/plans.js 静态断言（mode 上报覆盖两入口、预填分流、手填保留）');
t('L1 共用 submit 的 POST 分支上报 mode：未手改 = auto、脏标记 = manual', () => {
  const src = fnSrc(VIEWS_PLANS, 'submit');
  assert.match(src, /body\.ticketNoMode = dlg\.ticketNoDirty \? 'manual' : 'auto'/);
  assert.match(src, /api\.post\('\/api\/workPlans', body\)/);
});
t('L2 编辑走 PUT：分支内 delete body.ticketNoMode（不报创建 mode）', () => {
  const src = fnSrc(VIEWS_PLANS, 'submit');
  const putBranch = src.slice(src.indexOf('if (dlg.editingId)'));
  assert.match(putBranch, /delete body\.ticketNoMode/);
  assert.match(putBranch, /api\.put\('\/api\/workPlans\/' \+ dlg\.editingId, body\)/);
});
t('L3 复制入口在自身入口上报 auto（沿用既有直接 POST，未重构）', () => {
  const src = fnSrc(VIEWS_PLANS, 'copyPlan');
  assert.match(src, /body\.ticketNoMode = 'auto'/);
  const modeAt = src.indexOf("body.ticketNoMode = 'auto'");
  const postAt = src.indexOf("await api.post('/api/workPlans', body)");
  assert.ok(modeAt > -1 && postAt > modeAt, 'mode 赋值须在 POST 之前');
  assert.match(src, /delete body\.id; delete body\.createdAt/);          // 既有字段清理原样
  assert.doesNotMatch(src, /dlg\.visible|openAdd/);                     // 不走表单预填
});
t('L4 openAdd 预填走统一分流入口 prefillTicketNo（勘察仍 nextSurveyNo）', () => {
  const src = fnSrc(VIEWS_PLANS, 'openAdd');
  assert.match(src, /PlanNo\.prefillTicketNo\(list\.value, ym, dlg\.form\.ticketType\)/);
  assert.match(src, /PlanNo\.nextSurveyNo\(list\.value, ym\)/);
  assert.doesNotMatch(src, /PlanNo\.nextTicketNo/);
  assert.match(src, /dlg\.ticketNoDirty = false/);
});
t('L5 openAdd 耗尽分支：置空 + 明确提示（不生成 1000、不扩位、不跨月借号）', () => {
  const src = fnSrc(VIEWS_PLANS, 'openAdd');
  assert.match(src, /dlg\.form\.workTicketNo == null/);
  assert.match(src, /dlg\.form\.workTicketNo = ''/);
  assert.match(src, /warnTicketNoExhausted\(ym, dlg\.form\.ticketType\)/);
  const warn = fnSrc(VIEWS_PLANS, 'warnTicketNoExhausted');
  assert.match(warn, /801–999 已用尽/);
  assert.match(warn, /不自动扩位、不跨月借号/);
});
t('L6 onTicketTypeChange：编辑态仍提前返回；创建态重预填并重置脏标记（不再因 dirty 跳过）', () => {
  const src = fnSrc(VIEWS_PLANS, 'onTicketTypeChange');
  assert.match(src, /if \(dlg\.editingId\) return/);
  assert.doesNotMatch(src, /dlg\.ticketNoDirty\) return/);
  assert.match(src, /PlanNo\.prefillTicketNo\(list\.value, ym, type\)/);
  assert.match(src, /dlg\.ticketNoDirty = false/);
});
t('L7 手填保留：工作票编号输入框仍可编辑（onTicketNoInput 置脏标记，无 disabled）', () => {
  assert.match(VIEWS_PLANS, /<el-input v-model="dlg\.form\.workTicketNo" placeholder="自动生成，可手动修改" @input="onTicketNoInput" \/>/);
  const src = fnSrc(VIEWS_PLANS, 'onTicketNoInput');
  assert.match(src, /dlg\.ticketNoDirty = true/);
});
t('L8 月生周同通道：makeWeekFromMonth 仍经 openAdd 进共用 submit（无直连 POST）', () => {
  const src = fnSrc(VIEWS_PLANS, 'makeWeekFromMonth');
  assert.match(src, /await openAdd\(/);
  assert.doesNotMatch(src, /api\.post/);
});
t('L9 错误提示走服务端明确 message：submit 与 copyPlan 的 catch 优先 e.data.message', () => {
  const submitSrc = fnSrc(VIEWS_PLANS, 'submit');
  const copySrc = fnSrc(VIEWS_PLANS, 'copyPlan');
  assert.match(submitSrc, /\(e\.data && e\.data\.message\) \|\| e\.message/);
  assert.match(copySrc, /\(e\.data && e\.data\.message\) \|\| e\.message/);
});
t('L10 monthPlans.js 零改动约束：全程不含 ticketNoMode（Step 4 未触碰该文件）', () => {
  assert.doesNotMatch(VIEWS_MONTH, /ticketNoMode/);
});

/* ========== Step 4：M 前端预填值与服务端分配的一致性（同一 seed 直比） ========== */
g('M 前端预填值与服务端 Step 3 分配/校验一致（同 seed 直比）');
t('M1 预填号 === 服务端 auto 首次分配号（空库均 801；占用 805 后均 806）', () => {
  reset([]);
  assert.equal(planNo.nextDistTicketNo([], YM, T1), invoke(autoBody()).last.workTicketNo);
  reset([rec('seed', PN('6', 805))]);
  assert.equal(planNo.nextDistTicketNo([rec('seed', PN('6', 805))], YM, T1),
    invoke(autoBody()).last.workTicketNo);
});
t('M2 前端判耗尽（null）时，服务端 auto 同样 400 EXHAUSTED 且零保存', () => {
  const seeds = [rec('seed', PN('6', 999))];
  assert.equal(planNo.nextDistTicketNo(seeds.map(r => ({ ...r })), YM, T1), null);
  const r = call(autoBody(), seeds);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'EXHAUSTED');
  assert.equal(state.saveCalls, 0);
});
t('M3 用预填函数生成的号走 manual → 200 且落库逐字同号（校验值==保存值）', () => {
  reset([]);
  const pre = planNo.nextDistTicketNo([], YM, T1);
  const r = invoke(manualBody(pre));
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.last.workTicketNo, pre);
  assert.equal(state.saveCalls, 1);
});

/* ========== Step 4 修正（2026-11-15）：N 配电号池读取——非字符串票号不计入 ========== */
g('N 配电号池读取：非字符串票号跳过不计入（与 Step 2 同口径）');
t('N1 数字票号不计入：不占号、不抛异常；同值字符串仍照常计入（805→806）', () => {
  const numeric = Number(PN('6', 801));
  assert.doesNotThrow(() => planNo.nextDistTicketNo([{ workTicketNo: numeric }], YM, T1));
  assert.equal(planNo.nextDistTicketNo([{ workTicketNo: numeric }], YM, T1), PN('6', 801));
  assert.equal(planNo.nextDistTicketNo([{ workTicketNo: PN('6', 801) }], YM, T1), PN('6', 802));
});
t('N2 数字 999 不误判耗尽：仍取 801（修正前 String 强转会把 2026xx6999 当占号 → null）', () => {
  assert.equal(planNo.nextDistTicketNo([{ workTicketNo: Number(PN('6', 999)) }], YM, T1), PN('6', 801));
});
t('N3 数组 / 对象 / null / 布尔 / undefined 票号逐项跳过且不抛异常', () => {
  [[PN('6', 805)], { a: 1 }, null, true, undefined].forEach(v => {
    assert.doesNotThrow(() => planNo.nextDistTicketNo([{ workTicketNo: v }], YM, T1), String(v));
    assert.equal(planNo.nextDistTicketNo([{ workTicketNo: v }], YM, T1), PN('6', 801), String(v));
  });
});
t('N4 前后端对照（数字票号）：前端 801；后端 parse 失败 INVALID_INPUT、allocate 801——结论一致', () => {
  const numeric = Number(PN('6', 801));
  const front = planNo.nextDistTicketNo([{ workTicketNo: numeric }], YM, T1);
  const parsed = PTM.parseDistWorkTicketNo(numeric);
  const alloc = PTM.allocateWorkTicketNo({ ticketType: T1, yearMonth: YM, records: [{ workTicketNo: numeric }] });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'INVALID_INPUT');
  assert.equal(alloc.ok, true);
  assert.equal(alloc.workTicketNo, PN('6', 801));
  assert.equal(front, alloc.workTicketNo);
});
t('N5 前后端对照（数组票号）：前端 801；后端 parse 失败、allocate 801——结论一致', () => {
  const arr = [PN('6', 804)];
  const front = planNo.nextDistTicketNo([{ workTicketNo: arr }], YM, T1);
  assert.equal(PTM.parseDistWorkTicketNo(arr).ok, false);
  const alloc = PTM.allocateWorkTicketNo({ ticketType: T1, yearMonth: YM, records: [{ workTicketNo: arr }] });
  assert.equal(alloc.ok, true);
  assert.equal(front, alloc.workTicketNo);
});
t('N6 畸形值集合逐项对照：前端「是否计入」与后端 parse「通过/失败」一一对应', () => {
  [123, [PN('6', 801)], {}, null, true].forEach(v => {
    const frontCounted = planNo.nextDistTicketNo([{ workTicketNo: v }], YM, T1) !== PN('6', 801);
    assert.equal(frontCounted, PTM.parseDistWorkTicketNo(v).ok, JSON.stringify(v));
  });
});
t('N7 线路 / 勘察预填算法逐字未变（本次只改配电号池读取）', () => {
  assert.equal(planNo.nextTicketNo([{ workTicketNo: YM + '67' + '002', ticketType: L1 }], YM, L1), YM + '67' + '003');
  assert.equal(planNo.nextTicketNo([], YM, '未映射的类型'), YM);
  assert.equal(planNo.nextSurveyNo([{ surveyNo: YM + '004' }], YM), YM + '005');
  assert.equal(planNo.nextSurveyNo([], YM), YM + '001');
});

/* ========== Step 4 修正：O views/plans.js 行为测试（真实 setup() 函数 + 桩网络/UI） ========== */
/* 做法：vm 上下文按浏览器顺序加载真实 utils.js / plan-no.js / plan-staff.js / views/plans.js，
 * 只桩掉 Vue（极简响应式）、ElementPlus（消息/弹窗）、api（记录请求载荷）、ServerTime（固定 2026-11-15）。
 * 断言对象是真实 setup() 返回的 openAdd / submit / copyPlan / onTicketTypeChange / onTicketNoInput 的行为，
 * 不是源码正则。vm 上下文内无 http / 无端口 / 无真实库。 */
const YM_FRONT = '202611';   // 桩 ServerTime = 2026-11-15 09:30（本机时区）
const FORM_MIN = {
  name: 'ZT-Step4修正-行为', startDate: '2026-11-20 08:00:00', endDate: '2026-11-20 18:00:00',
  team: '施工一班', staffText: '张三|13800000000', teamLeader: '李四'
};
const COPY_ROW = {
  id: 'wp-old', name: 'ZT复制源', planType: '周计划', ticketType: T1,
  workTicketNo: PN('6', 801), surveyNo: YM + '001', status: '未执行',
  startDate: '2026-11-20 08:00:00', endDate: '2026-11-20 18:00:00',
  team: '施工一班', staffText: '张三|13800000000', teamLeader: '李四',
  createdAt: '2026-11-01T00:00:00.000Z'
};
function plansHarness() {
  const calls = { post: [], put: [], get: [], error: [], warning: [], success: [] };
  const sb = { console, setTimeout, clearTimeout, encodeURIComponent };
  vm.createContext(sb);
  vm.runInContext('globalThis.window = globalThis;', sb);
  sb.addEventListener = () => {}; sb.removeEventListener = () => {};
  sb.document = {
    querySelectorAll: () => [], getElementById: () => null,
    createElement: () => ({ click() {}, remove() {}, style: {} }), body: { appendChild() {} }
  };
  sb.Vue = {
    ref: v => ({ value: v }),
    reactive: o => o,
    computed: fn => ({ get value() { return fn(); } }),
    onMounted: () => {}, onUnmounted: () => {}, nextTick: fn => (fn ? fn() : undefined), watch: () => {}
  };
  sb.ServerTime = { now: () => new Date(2026, 10, 15, 9, 30, 0), ymd: () => '2026-11-15' };
  sb.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  sb.api = {
    async get(u) { calls.get.push(u); return []; },
    async post(u, b) { calls.post.push({ url: u, body: b }); if (sb.__postError) throw sb.__postError; return Object.assign({ id: 'wp-new' }, b); },
    async put(u, b) { calls.put.push({ url: u, body: b }); return Object.assign({}, b); },
    async del() { return {}; }, async upload() { return {}; }, async download() { return {}; }
  };
  sb.ElementPlus = {
    ElMessage: {
      success: m => calls.success.push(m), error: m => calls.error.push(m),
      warning: m => calls.warning.push(m), info: m => (calls.info = m)
    },
    ElMessageBox: {
      confirm: () => Promise.resolve(), alert: () => Promise.resolve(), prompt: () => Promise.resolve({ value: '' })
    }
  };
  ['public/js/utils.js', 'public/js/plan-no.js', 'public/js/plan-staff.js'].forEach(rel => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sb, { filename: rel });
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/views/plans.js'), 'utf8') + '\n;globalThis.__PlansView = PlansView;',
    sb, { filename: 'views/plans.js' });
  return { view: sb.__PlansView.setup(), calls, sb };
}

g('O views/plans.js 行为：mode 上报 / 编辑不变 / 错误后保留表单（真实函数调用）');
t('O1 新建未手改 → 真实 submit 载荷 ticketNoMode=auto，预填号为配电新格式', async () => {
  const h = plansHarness();
  await h.view.openAdd();
  Object.assign(h.view.dlg.form, FORM_MIN);
  await h.view.submit();
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.calls.post[0].url, '/api/workPlans');
  assert.equal(h.calls.post[0].body.ticketNoMode, 'auto');
  assert.equal(h.calls.put.length, 0);
  assert.match(h.calls.post[0].body.workTicketNo, new RegExp('^' + YM_FRONT + '6\\d{3}$'));
  assert.equal(h.calls.post[0].body.surveyNo, YM_FRONT + '001');
});
t('O2 新建手改票号（真实输入处理器置脏）→ 载荷 ticketNoMode=manual 且保留手填号', async () => {
  const h = plansHarness();
  await h.view.openAdd();
  Object.assign(h.view.dlg.form, FORM_MIN);
  h.view.dlg.form.workTicketNo = PN('6', 805);
  h.view.onTicketNoInput();
  await h.view.submit();
  assert.equal(h.calls.post[0].body.ticketNoMode, 'manual');
  assert.equal(h.calls.post[0].body.workTicketNo, PN('6', 805));
});
t('O3 月生周预填直提 → 真实 submit 载荷 ticketNoMode=auto（openAdd 同通道）', async () => {
  const h = plansHarness();
  await h.view.makeWeekFromMonth({
    project: 'P-1', projectName: 'ZT月计划工程', team: '施工一班', leader: '李四', voltage: '10kV',
    workType: '配农网工程', maintContent: '检修内容', maintDevice: '10kV线路',
    outageStart: '2026-11-21 08:00', outageEnd: '2026-11-21 18:00'
  });
  const f = h.view.dlg.form;
  assert.equal(f.planType, '周计划');
  f.teamLeader = '李四'; f.staffText = '张三|13800000000';
  await h.view.submit();
  assert.equal(h.calls.post.length, 1);
  assert.equal(h.calls.post[0].body.ticketNoMode, 'auto');
});
t('O4 月生周预填后手改再提 → ticketNoMode=manual', async () => {
  const h = plansHarness();
  await h.view.makeWeekFromMonth({
    project: 'P-1', projectName: 'ZT月计划工程', team: '施工一班', leader: '李四', voltage: '10kV',
    workType: '配农网工程', maintContent: '检修内容', maintDevice: '10kV线路',
    outageStart: '2026-11-21 08:00', outageEnd: '2026-11-21 18:00'
  });
  const f = h.view.dlg.form;
  f.teamLeader = '李四'; f.staffText = '张三|13800000000';
  f.workTicketNo = PN('6', 807);
  h.view.onTicketNoInput();
  await h.view.submit();
  assert.equal(h.calls.post[0].body.ticketNoMode, 'manual');
  assert.equal(h.calls.post[0].body.workTicketNo, PN('6', 807));
});
t('O5 复制入口（真实 copyPlan）→ 载荷 ticketNoMode=auto，不走表单', async () => {
  const h = plansHarness();
  h.view.list.value = [COPY_ROW];
  await h.view.copyPlan(COPY_ROW);
  assert.equal(h.calls.post.length, 1);
  const body = h.calls.post[0].body;
  assert.equal(body.ticketNoMode, 'auto');
  assert.equal(body.name, 'ZT复制源（副本）');
  assert.equal(body.id, undefined);
  assert.equal(h.view.dlg.visible, false);
  assert.equal(h.calls.put.length, 0);
});
t('O6 编辑态：切票种不改写双号；真实 submit 走 PUT 且载荷不含 ticketNoMode', async () => {
  const h = plansHarness();
  h.view.list.value = [COPY_ROW];
  h.view.dlg.editingId = COPY_ROW.id;
  h.view.dlg.form = Object.assign({}, COPY_ROW);
  h.view.dlg.editSnapshot = {
    staffText: COPY_ROW.staffText, chargePerson: '', chargePersonPhone: '',
    startDate: COPY_ROW.startDate, endDate: COPY_ROW.endDate
  };
  h.view.onTicketTypeChange(L1);                      // 编辑态切换票种
  assert.equal(h.view.dlg.form.workTicketNo, PN('6', 801));
  assert.equal(h.view.dlg.form.surveyNo, COPY_ROW.surveyNo);
  h.view.dlg.form.ticketType = L1;
  await h.view.submit();
  assert.equal(h.calls.post.length, 0);
  assert.equal(h.calls.put.length, 1);
  const body = h.calls.put[0].body;
  assert.ok(!('ticketNoMode' in body), '编辑 PUT 载荷不得含 ticketNoMode');
  assert.equal(body.workTicketNo, PN('6', 801));
  assert.equal(body.surveyNo, COPY_ROW.surveyNo);
});
t('O7 提交收到服务端错误（撞号 / 耗尽）后：表单内容保留、不关闭，提示为服务端明确文案', async () => {
  const cases = [
    ['DUPLICATE', '工作票号已被其它存活记录占用：' + PN('6', 801)],
    ['EXHAUSTED', YM_LABEL + ' 月「' + T1 + '」工作票号 801–999 已用完，停止取号']
  ];
  for (const [code, message] of cases) {
    const h = plansHarness();
    await h.view.openAdd();
    Object.assign(h.view.dlg.form, FORM_MIN);
    const keepNo = h.view.dlg.form.workTicketNo;
    h.sb.__postError = Object.assign(new Error(code), { status: 400, data: { ok: false, error: code, message } });
    await h.view.submit();
    assert.equal(h.view.dlg.visible, true, code + ' 后表单不得关闭');
    assert.equal(h.view.dlg.form.name, FORM_MIN.name, code + ' 后名称应保留');
    assert.equal(h.view.dlg.form.workTicketNo, keepNo, code + ' 后票号应保留');
    assert.equal(h.view.dlg.form.startDate, FORM_MIN.startDate, code + ' 后开始时间应保留');
    assert.equal(h.view.dlg.form.teamLeader, FORM_MIN.teamLeader, code + ' 后班组长应保留');
    assert.equal(h.calls.error[0], message, code + ' 应显示服务端明确文案');
    assert.equal(h.calls.put.length, 0);
  }
});

/* ========== Step 5A：P 专用编辑 PUT（真实 handler：判别四分支 / 零保存 / 回滚） ========== */
g('P 专用编辑 PUT /api/workPlans/:id（Step 5A：判别分支 / 规范化 / 零保存 / 回滚）');
const S_ID = 'wp-5a-1';
const seedPlan = extra => Object.assign({
  id: S_ID, planType: '周计划', ticketType: T1, workTicketNo: OLD11,
  name: 'ZT-5A-存量', status: '未执行', address: '旧地址', deleted: false,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z'
}, extra || {});
const MONTH22 = {
  subProject: 'P-1', workType: '配农网工程', specialty: '配电', dept: '运检部', address: '新地址',
  shadowContent: '', machine: '', riskLevel: '中风险', gridRisk: '四星', riskFactors: '无',
  majorRisk: '无', controlMeasures: '措施', workUnit: '施工一班', chargePersons: ['张三'],
  staff: '李四', finishDate: '2026-11-30', planNote: '备注', teams: ['施工一班'],
  materials: [], buildCity: '市', buildCounty: '县', execCity: '市'
};

t('P1 注册两份 PUT /api/workPlans/:id：专用在前、crud 在后，且晚于 quantities/survey', () => {
  assert.equal(planPuts.length, 2);
  assert.equal(typeof specializedPut, 'function');
  assert.equal(typeof crudPut, 'function');
  const iQty = routes.findIndex(r => r.method === 'PUT' && r.path === '/api/workPlans/:id/quantities');
  const iSurvey = routes.findIndex(r => r.method === 'PUT' && r.path === '/api/workPlans/:id/survey');
  const iSpec = routes.indexOf(planPuts[0]);
  const iCrud = routes.indexOf(planPuts[1]);
  assert.ok(iQty > -1 && iSurvey > -1, '两条更具体的专用 PUT 应存在');
  assert.ok(iSpec > iQty && iSpec > iSurvey, '专用编辑 PUT 须注册在 quantities / survey 之后');
  assert.ok(iSpec < iCrud, '专用编辑 PUT 须注册在 crud 之前，通用 PUT 不得绕过门禁');
});
t('P2 取到的是专用 handler（判别走 classifyPlanTicketEdit、保存走 commitPlanUpdate 回滚），crud 不含', () => {
  assert.match(String(specializedPut), /classifyPlanTicketEdit/);
  assert.match(String(specializedPut), /commitPlanUpdate/);
  assert.doesNotMatch(String(crudPut), /classifyPlanTicketEdit/);
  assert.doesNotMatch(String(crudPut), /commitPlanUpdate/);
  // 回滚分支的 SAVE_FAILED 在被调函数内，行为已在 P22 直接验证
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/plans.js'), 'utf8');
  assert.match(src, /error: 'SAVE_FAILED'/);
});
t('P3 轻操作 {status}：旧号配电记录保存成功，票号/票种/勘察号逐字不变', () => {
  const seed = seedPlan({ surveyNo: YM + '001' });
  const r = putCall(S_ID, { status: '已执行' }, [seed]);
  assert.equal(r.thrown, null);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.status, '已执行');
  assert.equal(r.row.workTicketNo, OLD11);
  assert.equal(r.row.ticketType, T1);
  assert.equal(r.row.surveyNo, YM + '001');
  assert.equal(state.saveCalls, 1);
});
t('P4 轻操作 {planNote}：缺号配电记录也保存成功（不因缺号失败、不补号）', () => {
  const seed = seedPlan({ workTicketNo: undefined });
  delete seed.workTicketNo;
  const r = putCall(S_ID, { planNote: '备注只改这里' }, [seed]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.planNote, '备注只改这里');
  assert.equal(r.row.workTicketNo, undefined);
  assert.equal(state.saveCalls, 1);
});
t('P5 轻操作 {status, planNote} 组合：旧号记录仍豁免，两字段同时生效', () => {
  const r = putCall(S_ID, { status: '已取消', planNote: '组合轻操作' }, [seedPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.status, '已取消');
  assert.equal(r.row.planNote, '组合轻操作');
  assert.equal(r.row.workTicketNo, OLD11);
  assert.equal(state.saveCalls, 1);
});
t('P6 轻操作夹带票号（即使与旧值相同）→ 非轻操作，旧号被拒且零保存', () => {
  const r = putCall(S_ID, { status: '已执行', workTicketNo: OLD11 }, [seedPlan()]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
  assert.equal(r.row.status, '未执行');
});
t('P7 轻操作夹带客户端标记 ticketNoMode → 不因「预删标记」被豁免（判非轻操作、零保存）', () => {
  const r = putCall(S_ID, { status: '已执行', ticketNoMode: 'auto' }, [seedPlan()]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(state.saveCalls, 0);
  assert.equal(r.row.status, '未执行');
});
t('P8 仅改 address（旧号配电）→ 合并校验不通过：400 且零保存，记录逐字未变', () => {
  const before = JSON.stringify(seedPlan());
  const r = putCall(S_ID, { address: '新地址' }, [seedPlan()]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
  assert.equal(JSON.stringify(r.row), before);
});
t('P9 仅改 content（缺号配电）→ 400「缺少工作票号」，零保存', () => {
  const seed = seedPlan();
  delete seed.workTicketNo;
  const r = putCall(S_ID, { content: '新内容' }, [seed]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.match(r.res.payload.message, /缺少工作票号/);
  assert.equal(state.saveCalls, 0);
});
t('P10 完整表单改成合规唯一号 → 200，保存号即合规新号，单次保存', () => {
  const no = N('6', 805);
  const r = putCall(S_ID, {
    name: 'ZT-5A-改名', startDate: '2026-11-20 08:00:00', endDate: '2026-11-20 18:00:00',
    team: '施工一班', staffText: '张三|13800000000', ticketType: T1, workTicketNo: no, address: '新地址'
  }, [seedPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.workTicketNo, no);
  assert.equal(r.row.ticketType, T1);
  assert.equal(r.row.address, '新地址');
  assert.equal(state.saveCalls, 1);
  assert.equal(r.res.payload, r.row, '响应形态与通用 PUT 一致：返回合并后的记录本体');
});
t('P11 内存保存路径一致性：校验值与保存值逐字一致（票种/票号两端空白一律 trim 后落库）', () => {
  const raw = N('6', 806);
  const r = putCall(S_ID, { ticketType: '  ' + T1 + '  ', workTicketNo: '  ' + raw + '  ' }, [seedPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.ticketType, T1, '落库票种应为规范化值（无首尾空白）');
  assert.equal(r.row.workTicketNo, raw, '落库票号应为规范化值，与校验值逐字相同');
  assert.equal(state.saveCalls, 1);
});
t('P12 请求未提供票种/票号 → 沿用已存值（合规记录仅改 address 仍可保存）', () => {
  const no = N('6', 805);
  const r = putCall(S_ID, { address: '只改地址' }, [seedPlan({ workTicketNo: no })]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.workTicketNo, no);
  assert.equal(r.row.ticketType, T1);
  assert.equal(r.row.address, '只改地址');
});
t('P13 请求显式 undefined（等同未提供）→ 同样沿用已存值并保存成功', () => {
  const no = N('6', 805);
  const r = putCall(S_ID, { workTicketNo: undefined, ticketType: undefined, address: 'undefined 沿用' },
    [seedPlan({ workTicketNo: no })]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.workTicketNo, no);
  assert.equal(r.row.ticketType, T1);
  assert.equal(r.row.address, 'undefined 沿用');
});
t('P14 无号配电周计划未补号 → 400 且零保存（不静默补号）', () => {
  const seed = seedPlan();
  delete seed.workTicketNo;
  const r = putCall(S_ID, { address: '未补号' }, [seed]);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.message, /缺少工作票号/);
  assert.equal(state.saveCalls, 0);
});
t('P15 月计划 22 键保存（不含两号与 ticketType）→ 不被迫改号、不被拒绝', () => {
  assert.equal(Object.keys(MONTH22).length, 22);
  assert.ok(!('workTicketNo' in MONTH22) && !('ticketType' in MONTH22) && !('surveyNo' in MONTH22));
  const seed = seedPlan({ planType: '月计划', workTicketNo: OLD11, surveyNo: YM + '002' });
  const r = putCall(S_ID, Object.assign({}, MONTH22), [seed]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.workTicketNo, OLD11);
  assert.equal(r.row.ticketType, T1);
  assert.equal(r.row.surveyNo, YM + '002');
  assert.equal(state.saveCalls, 1);
});
t('P16 月计划主动写非法配电号 → 整单拒绝、零保存', () => {
  const seed = seedPlan({ planType: '月计划', workTicketNo: '' });
  const r = putCall(S_ID, { ticketType: T1, workTicketNo: OLD11 }, [seed]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
  assert.equal(r.row.workTicketNo, '');
});
t('P17 伪造 planType（已存周计划改为月计划）→ 拒绝、零保存', () => {
  const r = putCall(S_ID, { planType: '月计划', status: '已执行' }, [seedPlan()]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.match(r.res.payload.message, /planType 与已存记录不一致/);
  assert.equal(state.saveCalls, 0);
});
t('P18 改成其它存活记录已占用的号 → 400 DUPLICATE、零保存，自身记录未变', () => {
  const mine = N('6', 805);
  const other = N('6', 806);
  const seed = [seedPlan({ workTicketNo: mine }), seedPlan({ id: 'wp-5a-2', workTicketNo: other })];
  const r = putCall(S_ID, { workTicketNo: other }, seed);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'DUPLICATE');
  assert.equal(state.saveCalls, 0);
  assert.equal(r.row.workTicketNo, mine);
});
t('P19 保留自身原号（excludeIds 含已存自身）不算撞号 → 200', () => {
  const mine = N('6', 805);
  const r = putCall(S_ID, { workTicketNo: mine, address: '改地址保留原号' }, [seedPlan({ workTicketNo: mine })]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.workTicketNo, mine);
});
t('P20 换票种 配电→线路 → skip 分支，不自动改号/清空号（票种改线路、号原样保留）', () => {
  const no = N('6', 805);
  const r = putCall(S_ID, { ticketType: L1 }, [seedPlan({ workTicketNo: no })]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.ticketType, L1);
  assert.equal(r.row.workTicketNo, no);
  assert.equal(state.saveCalls, 1);
});
t('P21 skip 分支不新增规范化：线路号原样落库（不 trim、不改写）', () => {
  const seed = seedPlan({ ticketType: L1, workTicketNo: OLD11 });
  const r = putCall(S_ID, { workTicketNo: '  LINE-007  ' }, [seed]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.workTicketNo, '  LINE-007  ');
});
t('P22 saveDB 抛错 → 500 SAVE_FAILED、内存记录还原到操作前、不自动重试', () => {
  const before = JSON.stringify(seedPlan({ workTicketNo: N('6', 805) }));
  const r = putCall(S_ID, { address: '会写失败' }, [seedPlan({ workTicketNo: N('6', 805) })], { throwNext: true });
  assert.equal(r.thrown, null, 'saveDB 抛错应由 handler 捕获，不向调用栈外抛');
  assert.equal(r.res.statusCode, 500);
  assert.equal(r.res.payload.error, 'SAVE_FAILED');
  assert.equal(state.saveCalls, 1, '失败后不得自动重试');
  assert.equal(JSON.stringify(DB.workPlans[0]), before, '内存记录须逐字还原，无部分写入残留');
  assert.equal(DB.workPlans.length, 1);
});
t('P23 404 形态与通用 PUT 一致：不存在 / 已删除均 {error:"未找到"}，零保存', () => {
  const miss = putCall('nope', { status: '已执行' }, []);
  assert.equal(miss.res.statusCode, 404);
  assert.equal(miss.res.payload.error, '未找到');
  const del = putCall(S_ID, { status: '已执行' }, [seedPlan({ deleted: true })]);
  assert.equal(del.res.statusCode, 404);
  assert.equal(del.res.payload.error, '未找到');
  assert.equal(state.saveCalls, 0);
});
t('P24 Step 3 专用 POST 行为不变（仍先于 crud、auto 分支仍取号成功）', () => {
  const r = call(autoBody());
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.count, 1);
  assert.equal(r.last.workTicketNo, N('6', 801));
  assert.equal(state.saveCalls, 1);
});

t('P25 显式非字符串票号/票种（数字/数组/null）→ 400 INVALID_INPUT、零保存', () => {
  const cases = [123, ['x'], null];
  for (const bad of cases) {
    const r = putCall(S_ID, { address: '改地址', workTicketNo: bad }, [seedPlan({ workTicketNo: N('6', 805) })]);
    assert.equal(r.res.statusCode, 400, '票号 ' + JSON.stringify(bad) + ' 应 400');
    assert.equal(r.res.payload.error, 'INVALID_INPUT');
    assert.equal(state.saveCalls, 0);
    const r2 = putCall(S_ID, { address: '改地址', ticketType: bad }, [seedPlan({ workTicketNo: N('6', 805) })]);
    assert.equal(r2.res.statusCode, 400, '票种 ' + JSON.stringify(bad) + ' 应 400');
    assert.equal(state.saveCalls, 0);
  }
});
t('P26 等价保留：id 取路径参数、createdAt 不变、updatedAt 刷新（不采信 body 里的 id/updatedAt）', () => {
  const seed = seedPlan({ workTicketNo: N('6', 805) });
  const r = putCall(S_ID, { id: 'evil-id', updatedAt: '2000-01-01T00:00:00.000Z', status: '已执行' }, [seed]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.id, S_ID, 'id 必须取路径参数');
  assert.equal(r.row.createdAt, seed.createdAt, 'createdAt 不得被更新');
  assert.notEqual(r.row.updatedAt, '2000-01-01T00:00:00.000Z', 'updatedAt 应由服务端刷新');
  assert.match(r.row.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.row.deleted, false, 'deleted 以已存为准');
});

t('P27 skip 分支显式 undefined 票号/票种 → 沿用已存值，不得把已存票号抹成 undefined', () => {
  const seed = seedPlan({ ticketType: L1, workTicketNo: 'LINE-OLD-001' });
  const r = putCall(S_ID, { ticketType: undefined, workTicketNo: undefined, address: '改地址' }, [seed]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.row.ticketType, L1);
  assert.equal(r.row.workTicketNo, 'LINE-OLD-001');
  assert.equal(r.row.address, '改地址');
  assert.ok(Object.prototype.hasOwnProperty.call(r.row, 'workTicketNo'), '字段必须仍在，不得被抹除');
});

/* Step 5B：导入 handler（upload.single 中间件在收集器里只保留末段 handler，直接以桩 req.file 调用） */
const importHandler = (routes.find(r => r.method === 'POST' && r.path === '/api/workPlans/import') || {}).handler;
function importCall(file, seed, planType, opts) {
  reset(seed);
  if (opts && opts.throwNext) state.throwNext = true;
  const req = {
    file: { buffer: file, originalname: (opts && opts.filename) || 'zt-import.csv' },
    query: { planType: planType || '周计划' }, params: {}, body: {}, headers: {}
  };
  const res = {
    statusCode: 200, payload: undefined,
    status(n) { this.statusCode = n; return this; },
    json(v) { this.payload = v; return this; },
    send(v) { this.payload = v; return this; },
    setHeader() {}
  };
  let thrown = null;
  try { importHandler(req, res, () => { throw new Error('unexpected next()'); }); }
  catch (e) { thrown = e; }
  return { res, thrown, rows: DB.workPlans.slice(), count: DB.workPlans.length };
}

/* ========== Step 5B：Q 导入整批校验（可选票号列 / 整批拒绝 / 判重之前 / 回滚） ========== */
g('Q 导入整批校验（Step 5B：第 49 列票号 / 别名冲突 / 整批拒绝 / 判重之前 / 回滚）');
const csv = lines => Buffer.from('\uFEFF' + lines.join('\n'), 'utf8');
const H_BASE = ['作业计划名称', '计划开始时间', '计划结束时间', '工作票类型'];
const H_NO = H_BASE.concat(['工作票号']);
const NO801 = N('6', 801);
const NO802 = N('6', 802);

t('Q1 文件无票号列（历史 48 列模板）→ 解析照旧，但配电周计划缺号整批拒绝、零保存', () => {
  const buf = csv([H_BASE.join(','), ['ZT导入无列', '2026-11-20', '2026-11-21', T1].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.thrown, null);
  assert.equal(r.res.statusCode, 400, '无列不再是豁免：配电周计划缺号必须整批拒绝');
  assert.match(r.res.payload.error, /缺少工作票号/);
  assert.equal(r.count, 0);
  assert.equal(state.saveCalls, 0);
});
t('Q1b 无票号列 + 无号月计划 → 仍豁免通过（旧模板月计划可导入，不补号）', () => {
  const buf = csv([H_BASE.join(','), ['ZT导入旧模板月计划', '2026-11-20', '2026-11-21', T1].join(',')]);
  const r = importCall(buf, [], '月计划');
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.added, 1);
  assert.equal(r.rows[0].workTicketNo, undefined);
  assert.equal(state.saveCalls, 1);
});
t('Q1c 无票号列 + 线路票种 → 不受本校验影响（不扩围）', () => {
  const buf = csv([H_BASE.join(','), ['ZT导入旧模板线路', '2026-11-20', '2026-11-21', L1].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.added, 1);
  assert.equal(r.rows[0].workTicketNo, undefined);
});
t('Q2 文件带票号列 + 合规新格式号 → 保存该号，单次保存', () => {
  const buf = csv([H_NO.join(','), ['ZT导入有号', '2026-11-20', '2026-11-21', T1, NO801].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.count, 1);
  assert.equal(r.rows[0].workTicketNo, NO801);
  assert.equal(state.saveCalls, 1);
});
t('Q3 旧 11 位号 → 整批拒绝 400、零保存（不静默改号）', () => {
  const buf = csv([H_NO.join(','), ['ZT导入旧号', '2026-11-20', '2026-11-21', T1, OLD11].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /格式不合法/);
  assert.equal(r.count, 0);
  assert.equal(state.saveCalls, 0);
});
t('Q4 配电周计划空号（有列但该行空）→ 400 缺少工作票号、零保存', () => {
  const buf = csv([H_NO.join(','), ['ZT导入空号', '2026-11-20', '2026-11-21', T1, ''].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /缺少工作票号/);
  assert.equal(state.saveCalls, 0);
});
t('Q5 号段外（流水 800）→ 400、零保存', () => {
  const bad = YM + '6' + '800';
  const buf = csv([H_NO.join(','), ['ZT导入号段外', '2026-11-20', '2026-11-21', T1, bad].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /801–999/);
  assert.equal(state.saveCalls, 0);
});
t('Q6 票种码与票种不符（第一种票填 7 码）→ 400、零保存', () => {
  const buf = csv([H_NO.join(','), ['ZT导入码不符', '2026-11-20', '2026-11-21', T1, YM + '7' + '801'].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /类型码/);
  assert.equal(state.saveCalls, 0);
});
t('Q7 与库内存活记录撞号 → 400、零保存、库不变', () => {
  const seed = [{ id: 'wp-q7', planType: '周计划', ticketType: T1, workTicketNo: NO801, deleted: false, name: '既有' }];
  const buf = csv([H_NO.join(','), ['ZT导入撞号', '2026-11-20', '2026-11-21', T1, NO801].join(',')]);
  const r = importCall(buf, seed);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /已被其它存活记录占用/);
  assert.equal(r.count, 1, '库内记录数不变');
  assert.equal(state.saveCalls, 0);
});
t('Q8 批内重复（两行同号）→ 400、零保存', () => {
  const buf = csv([H_NO.join(','),
    ['ZT导入批重1', '2026-11-20', '2026-11-21', T1, NO802].join(','),
    ['ZT导入批重2', '2026-11-22', '2026-11-23', T1, NO802].join(',')
  ]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /批次内其它记录重复/);
  assert.equal(state.saveCalls, 0);
});
t('Q9 非法号 + 业务键重复行 → 整批拒绝（不得先按业务键跳过再校验）', () => {
  const seed = [{ id: 'wp-q9', planType: '周计划', project: '', ticketType: T1, deleted: false,
    name: 'ZT导入重复', startDate: '2026-11-20 00:00:00' }];
  const buf = csv([H_NO.join(','), ['ZT导入重复', '2026-11-20', '2026-11-21', T1, OLD11].join(',')]);
  const r = importCall(buf, seed);
  assert.equal(r.res.statusCode, 400, '必须整批拒绝，而不是跳过该行返回成功');
  assert.match(r.res.payload.error, /格式不合法/);
  assert.equal(r.count, 1);
  assert.equal(state.saveCalls, 0);
});
t('Q10 合法批次：业务键重复行被跳过、其余写入，单次保存', () => {
  // 被跳过的行仍须先通过号码校验（校验在判重之前），故夹具里该行带的是未被占用的合规号
  const seed = [{ id: 'wp-q10', planType: '周计划', project: '', ticketType: T1, deleted: false,
    name: 'ZT导入已有', startDate: '2026-11-20 00:00:00' }];
  const buf = csv([H_NO.join(','),
    ['ZT导入已有', '2026-11-20', '2026-11-21', T1, NO801].join(','),
    ['ZT导入新增', '2026-11-22', '2026-11-23', T1, NO802].join(',')
  ]);
  const r = importCall(buf, seed);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.added, 1);
  assert.equal(r.res.payload.skipped, 1);
  assert.equal(r.count, 2);
  assert.equal(state.saveCalls, 1);
});
t('Q10b 业务键重复行带的号已被库内同键记录占用 → 仍整批拒绝（校验先于判重，不因会被跳过而放行）', () => {
  const seed = [{ id: 'wp-q10b', planType: '周计划', project: '', ticketType: T1, deleted: false,
    name: 'ZT导入已有', startDate: '2026-11-20 00:00:00', workTicketNo: NO801 }];
  const buf = csv([H_NO.join(','), ['ZT导入已有', '2026-11-20', '2026-11-21', T1, NO801].join(',')]);
  const r = importCall(buf, seed);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /已被其它存活记录占用/);
  assert.equal(state.saveCalls, 0);
});
t('Q11 无号月计划行先豁免（有列但空号）→ 通过、不补号', () => {
  const buf = csv([H_NO.join(','), ['ZT导入月计划', '2026-11-20', '2026-11-21', T1, ''].join(',')]);
  const r = importCall(buf, [], '月计划');
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.rows[0].workTicketNo, undefined);
  assert.equal(state.saveCalls, 1);
});
t('Q12 线路行不被本校验拦截（非法号原样保存）→ 通过，不扩围', () => {
  const buf = csv([H_NO.join(','), ['ZT导入线路', '2026-11-20', '2026-11-21', L1, 'LINE-X'].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.rows[0].workTicketNo, 'LINE-X');
});
t('Q13 月计划主动写非法配电号 → 整单拒绝、零保存', () => {
  const buf = csv([H_NO.join(','), ['ZT导入月写号', '2026-11-20', '2026-11-21', T1, OLD11].join(',')]);
  const r = importCall(buf, [], '月计划');
  assert.equal(r.res.statusCode, 400);
  assert.equal(state.saveCalls, 0);
});
t('Q14 导入 saveDB 抛错 → 500 SAVE_FAILED、内存还原、不重试', () => {
  const buf = csv([H_NO.join(','), ['ZT导入回滚', '2026-11-20', '2026-11-21', T1, NO801].join(',')]);
  const r = importCall(buf, [], '周计划', { throwNext: true });
  assert.equal(r.res.statusCode, 500);
  assert.equal(r.res.payload.error, 'SAVE_FAILED');
  assert.equal(state.saveCalls, 1, '失败后不得自动重试');
  assert.equal(r.count, 0, 'unshift 进来的记录须整段移除');
});
t('Q15 真实 xlsx 文件（有票号列）同样读取并校验', () => {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    H_NO, ['ZT导入xlsx', '2026-11-20', '2026-11-21', T1, NO802]
  ]), 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const r = importCall(buf, [], '周计划', { filename: 'zt-import.xlsx' });
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.rows[0].workTicketNo, NO802);
});
t('Q16 其它导入规则不变：缺名称仍 400；作业内容/地址仍按表头名落库（补合规号后）', () => {
  const H = H_BASE.concat(['工作票号', '作业内容', '作业地址']);
  const bad = csv([H.join(','), ['', '2026-11-20', '2026-11-21', T1, NO801, '', ''].join(',')]);
  const rb = importCall(bad, []);
  assert.equal(rb.res.statusCode, 400);
  assert.match(rb.res.payload.error, /作业计划名称不能为空/);
  assert.equal(state.saveCalls, 0);
  const ok = csv([H.join(','), ['ZT导入映射', '2026-11-20', '2026-11-21', T1, NO801, '检修内容', '某作业地址'].join(',')]);
  const ro = importCall(ok, []);
  assert.equal(ro.res.statusCode, 200);
  assert.equal(ro.rows[0].content, '检修内容');
  assert.equal(ro.rows[0].address, '某作业地址');
});

t('Q17 模板资产：第 49 列为「工作票号」，A1:AV1 原 48 列表头与行数逐字未变，说明按分层口径', () => {
  const tplPath = path.join(ROOT, 'assets/plan-import-template.xlsx');
  const tplWb = XLSX.read(fs.readFileSync(tplPath), { type: 'buffer' });
  assert.deepEqual(tplWb.SheetNames, ['最新版', '填写说明']);
  const ws = tplWb.Sheets['最新版'];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  assert.equal(aoa[0].length, 49, '模板应为 49 列');
  assert.equal(aoa[0][48], '工作票号');
  assert.equal(aoa[0][47], '时户数', '第 48 列仍是时户数（未位移）');
  assert.equal(aoa[0][0], '序号');
  assert.equal(aoa.length, 1, '仍为单行表头，未新增样例行');
  assert.match(String(ws['!ref']), /^A1:AW1$/);
  const note = XLSX.utils.sheet_to_json(tplWb.Sheets['填写说明'], { header: 1, defval: '' })
    .map(r => String((r && r[0]) || '')).join('\n');
  assert.match(note, /本模板共 49 列/);
  assert.match(note, /配电周计划须填写/);
  assert.match(note, /无号月计划豁免/);
  assert.match(note, /月计划主动填写配电号时仍须合规/);
  assert.doesNotMatch(note, /配电计划须填写/, '不得写成笼统的「配电计划须填写」');
});
t('Q18 导出：第 49 列「工作票号」，号码原值直出，既有列位/合并不变', async () => {
  const seed = [
    seedRec('202611680003', { id: 'wp-q18', planType: '周计划', name: 'ZT导出旧号样本', startDate: '2026-11-20 08:00:00', endDate: '2026-11-21 18:00:00', createdAt: '2026-11-01T00:00:00.000Z' })
  ];
  const r = await exportCall(seed);
  assert.equal(r.statusCode, 200);
  assert.ok(Buffer.isBuffer(r.payload));
  const ws = XLSX.read(r.payload, { type: 'buffer' }).Sheets.Sheet1;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  assert.equal(aoa[0].length, 49, '导出应为 49 列');
  assert.equal(aoa[0][48], '工作票号');
  assert.equal(aoa[0][0], '序号');
  assert.equal(aoa[0][39], '当日计划工作量', 'AN 列未位移');
  assert.equal(aoa[1][39], '杆塔（基）');
  assert.equal(aoa[2][48], '202611680003', '号码须原值直出（旧格式也不清洗、不格式化）');
  assert.equal((ws['!merges'] || []).length, 41, '合并区仍为 41 个');
});
t('Q19 独立空库回导成功：导出 → 解析 → 空库导入，号码逐字保留', async () => {
  const seed = [
    seedRec(N('6', 801), { id: 'wp-q19a', planType: '周计划', name: 'ZT回导甲', startDate: '2026-11-20 08:00:00', endDate: '2026-11-21 18:00:00', createdAt: '2026-11-01T00:00:00.000Z' }),
    seedRec(N('6', 802), { id: 'wp-q19b', planType: '周计划', name: 'ZT回导乙', startDate: '2026-11-22 08:00:00', endDate: '2026-11-23 18:00:00', createdAt: '2026-11-02T00:00:00.000Z' })
  ];
  const ex = await exportCall(seed);
  const r = importCall(ex.payload, [], '周计划', { filename: 'roundtrip.xlsx' });
  assert.equal(r.res.statusCode, 200, '空库回导应成功：' + JSON.stringify(r.res.payload));
  assert.equal(r.res.payload.added, 2);
  assert.deepEqual(r.rows.map(x => x.workTicketNo).sort(), [N('6', 801), N('6', 802)]);
  assert.equal(state.saveCalls, 1);
});
t('Q20 同库回导撞号拒绝：同一导出文件回灌自身库 → 400 DUPLICATE、零保存', async () => {
  const seed = [
    seedRec(N('6', 801), { id: 'wp-q20', planType: '周计划', name: 'ZT回导自身', startDate: '2026-11-20 08:00:00', endDate: '2026-11-21 18:00:00', createdAt: '2026-11-01T00:00:00.000Z' })
  ];
  const ex = await exportCall(seed);
  const r = importCall(ex.payload, seed, '周计划', { filename: 'roundtrip.xlsx' });
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /已被其它存活记录占用/);
  assert.equal(state.saveCalls, 0);
  assert.equal(r.count, 1);
});
t('Q21 导入规范化保存：单元格带首尾空白 → 保存值 = 校验值（去空白后逐字相同）', () => {
  const buf = csv([H_NO.join(','), ['ZT导入空白', '2026-11-20', '2026-11-21', T1, '   ' + NO801 + '   '].join(',')]);
  const r = importCall(buf, []);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.rows[0].workTicketNo, NO801, '落库值应为去空白后的合规号');
  assert.equal(r.rows[0].name, 'ZT导入空白');
});
t('Q22 别名列并存：两列同值通过；两列冲突 → 400 报出两值、零保存（不静默择一）', () => {
  const H_DUAL = H_BASE.concat(['工作票号', '工作票编号']);
  const same = csv([H_DUAL.join(','), ['ZT双列同值', '2026-11-20', '2026-11-21', T1, NO801, NO801].join(',')]);
  const r1 = importCall(same, []);
  assert.equal(r1.res.statusCode, 200);
  assert.equal(r1.rows[0].workTicketNo, NO801);
  const diff = csv([H_DUAL.join(','), ['ZT双列冲突', '2026-11-22', '2026-11-23', T1, NO801, NO802].join(',')]);
  const r2 = importCall(diff, []);
  assert.equal(r2.res.statusCode, 400);
  assert.match(r2.res.payload.error, /工作票编号/);
  assert.ok(r2.res.payload.error.indexOf(NO801) > -1 && r2.res.payload.error.indexOf(NO802) > -1, '应报出两列的值');
  assert.match(r2.res.payload.error, /第2行/);
  assert.equal(r2.count, 0);
  assert.equal(state.saveCalls, 0);
});

/* 旧格式（无「作业计划名称/计划开始时间」表头 → 走老分支）：字段按位置映射，票号走同一提取 */
const OLD_HEAD = ['名称', '类型', '项目', '班组', '负责人', '开始', '结束', '票种', '电压', '变电站', '负责人2'];
function oldCsv(head, name, no, planType, noAlias) {
  const row = [name, planType || '周计划', 'P-OLD', '班组A', '张三', '2026-11-20', '2026-11-21', T1, '10kV', '站A', '李四'];
  const extras = head.length - 11;
  if (extras >= 1) row.push(no == null ? '' : String(no));
  if (extras >= 2) row.push(noAlias == null ? '' : String(noAlias));
  return csv([head.join(','), row.join(',')]);
}
t('Q23 旧布局 + 配电票种 + 无票号 → 仍进整批校验：400 缺号、零保存（不再「不参与校验」）', () => {
  const r = importCall(oldCsv(OLD_HEAD, 'ZT旧布局缺号', ''), []);
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /缺少工作票号/);
  assert.equal(r.count, 0);
  assert.equal(state.saveCalls, 0);
});
t('Q24 旧布局带「工作票号」表头 → 共用提取生效：空库导入成功、号码逐字保留、原字段映射不变', () => {
  const r = importCall(oldCsv(OLD_HEAD.concat(['工作票号']), 'ZT旧布局带号', NO801), []);
  assert.equal(r.res.statusCode, 200, '旧布局也应承接同一提取并通过校验：' + JSON.stringify(r.res.payload));
  assert.equal(r.res.payload.added, 1);
  assert.equal(r.rows[0].workTicketNo, NO801);
  assert.equal(r.rows[0].project, 'P-OLD', '其它字段映射不改');
  assert.equal(r.rows[0].team, '班组A');
  assert.equal(r.rows[0].planType, '周计划');
});
t('Q25 旧布局：同号回灌 → 400 DUPLICATE 零保存；带空白号 → 保存值 = 校验值', () => {
  const head = OLD_HEAD.concat(['工作票号']);
  const seed = [seedRec(NO801, { id: 'wp-q25', planType: '周计划', name: 'ZT旧布局既有', project: 'P-OLD' })];
  const dup = importCall(oldCsv(head, 'ZT旧布局回灌', NO801), seed);
  assert.equal(dup.res.statusCode, 400);
  assert.match(dup.res.payload.error, /已被其它存活记录占用/);
  assert.equal(state.saveCalls, 0);
  assert.equal(dup.count, 1);
  const ok = importCall(oldCsv(head, 'ZT旧布局空白', '   ' + NO801 + '   '), []);
  assert.equal(ok.res.statusCode, 200);
  assert.equal(ok.rows[0].workTicketNo, NO801, '落库值应为去空白后的合规号');
});

t('Q26 旧布局月计划主动填非法号 → 400 整批拒绝、零保存、库不变', () => {
  const buf = oldCsv(OLD_HEAD.concat(['工作票号']), 'ZT旧布局月计划非法号', OLD11, '月计划');
  const r = importCall(buf, [], '月计划');
  assert.equal(r.res.statusCode, 400, '月计划主动写配电号仍须校验');
  assert.match(r.res.payload.error, /格式不合法/);
  assert.equal(state.saveCalls, 0);
  assert.equal(r.count, 0);
});
t('Q27 旧布局月计划双列票号冲突 → 400、零保存、库不变，且报出行号与两个值', () => {
  const buf = oldCsv(OLD_HEAD.concat(['工作票号', '工作票编号']), 'ZT旧布局月计划双列冲突', NO801, '月计划', NO802);
  const r = importCall(buf, [], '月计划');
  assert.equal(r.res.statusCode, 400);
  assert.match(r.res.payload.error, /第2行/, '应报出行号');
  assert.match(r.res.payload.error, /工作票编号/, '应指明冲突列');
  assert.ok(r.res.payload.error.indexOf(NO801) > -1 && r.res.payload.error.indexOf(NO802) > -1, '应同时报出两个值');
  assert.equal(state.saveCalls, 0);
  assert.equal(r.count, 0);
});

const XLSX = require('xlsx');
const exportHandler = (routes.find(r => r.method === 'GET' && r.path === '/api/workPlans/export') || {}).handler;
async function exportCall(seed, query) {
  reset(seed);
  const req = { query: query || {}, params: {}, headers: {} };
  const res = {
    statusCode: 200, payload: undefined, headers: {},
    status(n) { this.statusCode = n; return this; },
    json(v) { this.payload = v; return this; },
    send(v) { this.payload = v; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
  await exportHandler(req, res, () => { throw new Error('unexpected next()'); });
  return res;
}

// Step 6：拆分路由（同一隔离沙箱注册）
const splitPreviewH = (routes.find(r => r.method === 'POST' && r.path === '/api/workPlans/:id/split/preview') || {}).handler;
const splitCommitH = (routes.find(r => r.method === 'POST' && r.path === '/api/workPlans/:id/split') || {}).handler;
const splitUndoH = (routes.find(r => r.method === 'POST' && r.path === '/api/workPlans/:id/unsplit') || {}).handler;
const PSM = require(SPLIT_ROUTES_PATH);

/* ========== Step 6：R 拆分预览（勘察门禁 / 互斥 / 拟号 / 版本 / 不落库） ========== */
g('R 拆分预览（Step 6：勘察门禁 / 互斥三路径 / 拟号 / 版本摘要 / 不落库）');
const SP_Y = Number(YM.slice(0, 4)), SP_M = Number(YM.slice(4, 6));
const SP_CM = YM.slice(0, 4) + '-' + YM.slice(4, 6);
const SP_NM = (SP_M === 12 ? SP_Y + 1 : SP_Y) + '-' + String(SP_M === 12 ? 1 : SP_M + 1).padStart(2, '0');
const SP_D1 = SP_CM + '-20';
const SP_D2 = SP_CM + '-21';
const SP_ID = 'wp-sp1';
const spPlan = extra => Object.assign({
  id: SP_ID, planType: '周计划', status: '未执行',
  startDate: SP_D1 + ' 08:00:00', endDate: SP_D2 + ' 18:00:00',
  content: '20日：电杆组立3根\n21日：电缆敷设1200米',
  ticketType: T1, workTicketNo: N('6', 801), surveyNo: '202611003', deleted: false
}, extra || {});
const spDays = () => ([
  { date: SP_D1, content: '电杆组立3根', quantities: {} },
  { date: SP_D2, content: '电缆敷设1200米', quantities: {} }
]);
function splitCall(handler, id, body, seed, noReset) {
  if (!noReset) reset(seed);
  const req = { body, params: { id }, query: {}, headers: {} };
  const res = {
    statusCode: 200, payload: undefined,
    status(n) { this.statusCode = n; return this; }, json(v) { this.payload = v; return this; },
    send(v) { this.payload = v; return this; }, setHeader() {}
  };
  let thrown = null;
  try { handler(req, res, () => { throw new Error('unexpected next()'); }); }
  catch (e) { thrown = e; }
  return { res, thrown };
}
const prevCall = (body, seed) => splitCall(splitPreviewH, SP_ID, body, seed);

t('R1 三个拆分端点均注册（preview → split → unsplit 顺序）', () => {
  assert.equal(typeof splitPreviewH, 'function');
  assert.equal(typeof splitCommitH, 'function');
  assert.equal(typeof splitUndoH, 'function');
  const iP = routes.findIndex(r => r.path === '/api/workPlans/:id/split/preview');
  const iS = routes.findIndex(r => r.path === '/api/workPlans/:id/split');
  const iU = routes.findIndex(r => r.path === '/api/workPlans/:id/unsplit');
  assert.ok(iP > -1 && iS > iP && iU > iS);
});
t('R2 content 与 days 同时提供 → 400 INVALID_INPUT、零保存', () => {
  const r = prevCall({ content: '20日：x', days: spDays() }, [spPlan()]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
});
t('R3 仅 days → 以提交的日期/内容/工量为准', () => {
  const days = spDays();
  days[0].quantities = { wlPole: '7' };
  const r = prevCall({ days }, [spPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.days.length, 2);
  assert.equal(r.res.payload.days[0].content, '电杆组立3根');
  assert.equal(r.res.payload.days[0].quantities.wlPole, 7);
  assert.equal(state.saveCalls, 0);
});
t('R4 仅 content → 按文本解析（既有规则）', () => {
  const r = prevCall({ content: '20日：电杆组立3根\n21日：电杆组立4根' }, [spPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.days.length, 2);
  assert.equal(r.res.payload.days[1].content, '电杆组立4根');
});
t('R5 两者皆无 → 按源计划既有内容解析', () => {
  const r = prevCall({}, [spPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.days.length, 2);
  assert.equal(r.res.payload.days[0].content, '电杆组立3根');
});
t('R6 days 为 null / 非数组 → 400 INVALID_INPUT，不得退回源内容解析', () => {
  [null, 'x', {}, 3].forEach(v => {
    const r = prevCall({ days: v }, [spPlan()]);
    assert.equal(r.res.statusCode, 400, 'days=' + JSON.stringify(v) + ' 应 400');
    assert.equal(r.res.payload.error, 'INVALID_INPUT');
    assert.equal(state.saveCalls, 0);
  });
});
t('R7 缺日 → 400 拆分校验未通过（沿用既有校验）', () => {
  const r = prevCall({ days: [spDays()[0]] }, [spPlan()]);
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, '拆分校验未通过');
  assert.ok(r.res.payload.errors.some(e => /缺少计划日期/.test(e)));
  assert.equal(state.saveCalls, 0);
});
t('R8 重复日 → 400；R9 越界 → 400', () => {
  const dup = spDays().concat([{ date: SP_D1, content: '重复', quantities: {} }]);
  const r8 = prevCall({ days: dup }, [spPlan()]);
  assert.equal(r8.res.statusCode, 400);
  assert.ok(r8.res.payload.errors.some(e => /重复/.test(e)));
  const out = spDays().concat([{ date: '2030-01-01', content: '越界', quantities: {} }]);
  const r9 = prevCall({ days: out }, [spPlan()]);
  assert.equal(r9.res.statusCode, 400);
  assert.ok(r9.res.payload.errors.some(e => /不在计划日期范围内/.test(e)));
  assert.equal(state.saveCalls, 0);
});
t('R10 survey 为非空对象 → 409 SURVEY_EXISTS、零保存', () => {
  const r = prevCall({}, [spPlan({ survey: { surveyNo: '202611003', team: '甲' } })]);
  assert.equal(r.res.statusCode, 409);
  assert.equal(r.res.payload.error, 'SURVEY_EXISTS');
  assert.equal(state.saveCalls, 0);
});
t('R11 survey 为 {} / null / false / 0 / 空串 / 数组 / 字符串 → SURVEY_ANOMALOUS', () => {
  [{}, null, false, 0, '', [], 'x'].forEach(v => {
    const r = prevCall({}, [spPlan({ survey: v })]);
    assert.equal(r.res.statusCode, 409, 'survey=' + JSON.stringify(v) + ' 应 409');
    assert.equal(r.res.payload.error, 'SURVEY_ANOMALOUS', 'survey=' + JSON.stringify(v));
    assert.equal(state.saveCalls, 0);
  });
});
t('R12 survey 缺失或 undefined → 允许预览', () => {
  assert.equal(prevCall({}, [spPlan()]).res.statusCode, 200);
  assert.equal(prevCall({}, [spPlan({ survey: undefined })]).res.statusCode, 200);
});
t('R13 已拆原记录 / 子记录 → 409 ALREADY_SPLIT、零保存', () => {
  const a = prevCall({}, [spPlan({ splitBatchId: 'sp1' })]);
  assert.equal(a.res.statusCode, 409);
  assert.equal(a.res.payload.error, 'ALREADY_SPLIT');
  const b = prevCall({}, [spPlan({ parentPlanId: 'wp-parent', splitBatchId: 'sp1', survey: { a: 1 } })]);
  assert.equal(b.res.statusCode, 409);
  assert.equal(b.res.payload.error, 'ALREADY_SPLIT', '子记录优先报已拆，而非勘察门禁');
  assert.equal(state.saveCalls, 0);
});
t('R14 首日保留源原号（旧格式原样）；非首日配电取新号', () => {
  const r = prevCall({}, [spPlan({ workTicketNo: OLD11 })]);
  assert.equal(r.res.statusCode, 200);
  assert.equal(r.res.payload.days[0].workTicketNo, OLD11, '旧格式也原样保留，不强制改号');
  assert.equal(r.res.payload.days[1].workTicketNo, N('6', 801), '旧号不计入号池，后日从 801 起');
});
t('R15 源号仍占号：源 6801 时后日拟号为 6802（不把 6801 再拟给后日）', () => {
  const r = prevCall({}, [spPlan({ workTicketNo: N('6', 801) })]);
  assert.equal(r.res.payload.days[0].workTicketNo, N('6', 801));
  assert.equal(r.res.payload.days[1].workTicketNo, N('6', 802));
});
t('R16 跨月：非首日按各自日期所在月独立计池', () => {
  const lastDay = new Date(Date.UTC(SP_Y, SP_M, 0)).getUTCDate();
  const dMid = SP_CM + '-' + String(lastDay - 1).padStart(2, '0');
  const dLast = SP_CM + '-' + String(lastDay).padStart(2, '0');
  const dNext = SP_NM + '-01';
  const p = spPlan({ startDate: dMid + ' 08:00:00', endDate: dNext + ' 18:00:00', workTicketNo: N('6', 801) });
  const days = [{ date: dMid, content: '甲', quantities: {} }, { date: dLast, content: '乙', quantities: {} }, { date: dNext, content: '丙', quantities: {} }];
  const r = prevCall({ days }, [p]);
  assert.equal(r.res.statusCode, 200, JSON.stringify(r.res.payload));
  assert.equal(r.res.payload.days[1].workTicketNo.slice(0, 6), YM, '当月日取当月池');
  assert.equal(r.res.payload.days[1].workTicketNo, N('6', 802));
  assert.equal(r.res.payload.days[2].workTicketNo.slice(0, 6), SP_NM.replace('-', ''), '次月日取次月池');
  assert.equal(r.res.payload.days[2].workTicketNo.slice(6), '6801');
});
t('R17 各日 surveyNo 均为源计划原勘察号（不为子记录新取）', () => {
  const r = prevCall({}, [spPlan({ surveyNo: '202611007' })]);
  assert.deepEqual(r.res.payload.days.map(d => d.surveyNo), ['202611007', '202611007']);
});
t('R18 确定性 + 不占号：两次预览拟号与版本一致、库不变、零 saveDB', () => {
  const seed = [spPlan()];
  const a = prevCall({}, seed);
  const n1 = DB.workPlans.length;
  const b = prevCall({}, seed);
  assert.equal(a.res.payload.previewVersion, b.res.payload.previewVersion);
  assert.deepEqual(a.res.payload.days.map(d => d.workTicketNo), b.res.payload.days.map(d => d.workTicketNo));
  assert.equal(DB.workPlans.length, n1, '预览不得写库/占号');
  assert.equal(state.saveCalls, 0);
});
t('R19 版本遮盖：源 content / 源工量 / 任一日内容 / 票种 变化 → previewVersion 必变', () => {
  const days = spDays();
  const base = prevCall({ days }, [spPlan()]).res.payload.previewVersion;
  const vContent = prevCall({ days }, [spPlan({ content: '20日：源内容改了\n21日：电缆敷设1200米' })]).res.payload.previewVersion;
  assert.notEqual(vContent, base, 'days 不变但源 content 变 → 版本须变（源值单独绑定）');
  const vQty = prevCall({ days }, [spPlan({ wlPole: '9' })]).res.payload.previewVersion;
  assert.notEqual(vQty, base, '源工量变 → 版本须变');
  const days2 = spDays(); days2[1].content = '电缆敷设1300米';
  const vDay = prevCall({ days: days2 }, [spPlan()]).res.payload.previewVersion;
  assert.notEqual(vDay, base, '任一日内容变 → 版本须变');
  const vType = prevCall({ days }, [spPlan({ ticketType: T2, workTicketNo: N('7', 801) })]).res.payload.previewVersion;
  assert.notEqual(vType, base, '票种真改（T1→T2）→ 版本须变');
  // 单元级隔离：days 与拟号完全相同，仅 ticketType 不同 → 版本仍须变（证明源摘要单独绑定）
  const fixedDays = [
    { date: SP_D1, content: '甲', quantities: {}, workTicketNo: N('6', 801), surveyNo: 's1' },
    { date: SP_D2, content: '乙', quantities: {}, workTicketNo: N('6', 802), surveyNo: 's1' }
  ];
  const common = {
    id: SP_ID, startDate: SP_D1 + ' 08:00:00', endDate: SP_D2 + ' 18:00:00', content: 'c',
    ticketType: T1, surveyNo: 's1', workTicketNo: N('6', 801), surveyDecision: 'allow', days: fixedDays
  };
  const u1 = PSM.computeSplitPreviewVersion(common);
  const u2 = PSM.computeSplitPreviewVersion(Object.assign({}, common, { ticketType: T2 }));
  assert.notEqual(u1, u2, '仅 ticketType 变（days/拟号逐字相同）→ 版本须变');
});
t('R21 某月某票种 801–999 占满 → 400 EXHAUSTED（指明月与票种）、零保存', () => {
  const fill = [];
  for (let s = 801; s <= 999; s++) fill.push({ id: 'f' + s, planType: '周计划', ticketType: T1, workTicketNo: N('6', s), deleted: false });
  const r = prevCall({}, [spPlan({ workTicketNo: N('6', 801) })].concat(fill));
  assert.equal(r.res.statusCode, 400);
  assert.equal(r.res.payload.error, 'EXHAUSTED');
  assert.ok(r.res.payload.message.indexOf(YM_LABEL) > -1, '应指明月份：' + r.res.payload.message);
  assert.ok(r.res.payload.message.indexOf(T1) > -1, '应指明票种');
  assert.equal(state.saveCalls, 0);
});
const confirmPayload = pv => ({
  previewVersion: pv.previewVersion,
  days: (pv.days || []).map(d => ({ date: d.date, content: d.content, quantities: d.quantities }))
});
t('R22 确认拆分（新语义）：首日旧号保留、后日取新号、勘察不复制、撤销返回 410', () => {
  const seed = [spPlan({ workTicketNo: OLD11 })];
  const pv = prevCall({}, seed).res.payload;
  const c = splitCall(splitCommitH, SP_ID, confirmPayload(pv), [spPlan({ workTicketNo: OLD11 })]);
  assert.equal(c.res.statusCode, 200, JSON.stringify(c.res.payload));
  const parent = DB.workPlans.find(x => x.id === SP_ID);
  assert.equal(parent.workTicketNo, OLD11, '首日保留源原号（旧格式也不强制改号）');
  const child = DB.workPlans.find(x => x.parentPlanId === SP_ID);
  assert.equal(child.workTicketNo, N('6', 801), '后日按配电新格式取号');
  assert.equal(child.survey, undefined, '不复制勘察对象');
  assert.equal(child.surveyNo, parent.surveyNo, '各日共用源勘察号');
  const u = splitCall(splitUndoH, SP_ID, {}, null, true);
  assert.equal(u.res.statusCode, 410);
  assert.equal(u.res.payload.error, 'SPLIT_IRREVERSIBLE');
});
t('R23 新实现契约：assertCanSplit 唯一实现、仅首日写 splitCommitVersion、不再写快照、core 未改', () => {
  const src = fs.readFileSync(SPLIT_ROUTES_PATH, 'utf8');
  assert.equal((src.match(/function assertCanSplit/g) || []).length, 1, 'assertCanSplit 应唯一实现');
  assert.match(src, /splitCommitVersion = version/);
  assert.doesNotMatch(src, /p\.splitSnapshot\s*=/, '不再写拆分快照');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'server/core/plan-split.js'), 'utf8');
  assert.doesNotMatch(coreSrc, /splitCommitVersion|classifySplitSurvey|assertCanSplit/, '本包未改 core helper');
});
t('R20 前端改稿保留：重新预览发送当前 days（而非旧 content），改稿不丢', async () => {
  const h = splitViewHarness();
  h.view.days.value = [
    { date: SP_D1, content: '用户改过的第一天', quantities: { wlPole: '7' } },
    { date: SP_D2, content: '电缆敷设1200米', quantities: {} }
  ];
  await h.view.reparse();
  assert.equal(h.calls.post.length, 1);
  const body = h.calls.post[0].b;
  assert.ok(Array.isArray(body.days), '必须发送 days');
  assert.equal(body.content, undefined, '不得再发送旧 content');
  assert.equal(body.days[0].content, '用户改过的第一天');
  assert.equal(body.days[0].quantities.wlPole, 7);
  assert.equal(body.days.length, 2);
});

// Step 6 前端沙箱：真实 views/plan-split.js + 桩 Vue/api/ElementPlus（不触网、不挂载 DOM）
// opts.throwError → api.post 抛该错误；opts.response → 返回该响应体
function splitViewHarness(opts) {
  const o = opts || {};
  const calls = { post: [], warn: [] };
  const sb = { console, setTimeout, clearTimeout, JSON };
  vm.createContext(sb);
  vm.runInContext('globalThis.window = globalThis;', sb);
  sb.Vue = {
    ref: v => ({ value: v }),
    computed: fn => ({ get value() { return fn(); } }),
    watch: () => {}, onMounted: () => {}, onUnmounted: () => {}, nextTick: fn => (fn ? fn() : undefined)
  };
  sb.api = {
    async post(u, b) {
      calls.post.push({ u, b });
      if (o.throwError) throw o.throwError;
      if (o.response) return o.response;
      return { ok: true, previewVersion: 'v1:stub', sourcePlanId: 'wp-sp1', firstDayPlanId: 'wp-sp1', days: (b && b.days) || [] };
    }
  };
  sb.ElementPlus = { ElMessage: { success() {}, error() {}, warning(m) { calls.warn.push(m); }, info() {} } };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/views/plan-split.js'), 'utf8')
    + '\n;globalThis.__PS = PlanSplitDlg;', sb, { filename: 'views/plan-split.js' });
  const view = sb.__PS.setup({ modelValue: true, plan: { id: 'wp-sp1' } }, { emit() {} });
  return { view, calls };
}

/* ========== Step 6 修正：S 失败路径 / 排序 / decision / 确认禁用 ========== */
g('S Step 6 修正（失败保留改稿 / 日期归一 / decision 键 / 确认按钮禁用）');
const editedDays = () => ([
  { date: SP_D1, content: '用户改过的第一天', quantities: { wlPole: '7' } },
  { date: SP_D2, content: '电缆敷设1200米', quantities: {} }
]);
t('S1 预览 400 + errors[]：逐条展示具体错误，保留用户编辑稿', async () => {
  const err = Object.assign(new Error('拆分校验未通过'), {
    status: 400, data: { error: '拆分校验未通过', errors: ['日期 ' + SP_D2 + ' 内容为空'] }
  });
  const h = splitViewHarness({ throwError: err });
  h.view.days.value = editedDays();
  await h.view.reparse();
  assert.deepEqual(h.view.errors.value, ['日期 ' + SP_D2 + ' 内容为空'], '应展示服务端 errors 条目');
  assert.equal(h.view.days.value.length, 2, '不得清空编辑稿');
  assert.equal(h.view.days.value[0].content, '用户改过的第一天');
  assert.equal(h.view.days.value[0].quantities.wlPole, '7', '工量改动不得丢失');
});
t('S2 预览 200 + ok:false：展示 errors 且保留编辑稿（不被空 days 覆盖）', async () => {
  const h = splitViewHarness({ response: { ok: false, errors: ['未识别到每日日期标题，请使用"03日：…"格式'], days: [] } });
  h.view.days.value = editedDays();
  await h.view.reparse();
  assert.equal(h.view.errors.value.length, 1);
  assert.match(h.view.errors.value[0], /未识别到每日日期标题/);
  assert.equal(h.view.days.value.length, 2);
  assert.equal(h.view.days.value[1].content, '电缆敷设1200米');
});
t('S3 预览 409 门禁：展示服务端 message，保留编辑稿', async () => {
  const err = Object.assign(new Error('SURVEY_EXISTS'), {
    status: 409, data: { ok: false, error: 'SURVEY_EXISTS', message: '该计划已有勘察记录，不能拆分；如需调整请先处理勘察记录' }
  });
  const h = splitViewHarness({ throwError: err });
  h.view.days.value = editedDays();
  await h.view.reparse();
  assert.match(h.view.errors.value[0], /已有勘察记录/);
  assert.equal(h.view.days.value.length, 2);
});
t('S4 确认按钮临时禁用：模板禁用 + submit 不调用旧确认接口 /split', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/views/plan-split.js'), 'utf8');
  assert.match(src, /CONFIRM_DISABLED/, '应有临时禁用开关');
  assert.match(src, /:disabled="!canSubmit \|\| CONFIRM_DISABLED"/, '确认按钮须绑定禁用');
  const h = splitViewHarness();
  h.view.days.value = editedDays();
  assert.equal(h.view.CONFIRM_DISABLED, true);
  await h.view.submit();
  assert.equal(h.calls.post.filter(c => /\/split$/.test(c.u)).length, 0, '不得调用旧确认接口');
  assert.equal(h.calls.warn.length, 1, '应提示确认暂未开放');
});
t('S5 日期乱序输入 → 统一升序后再标首日与拟号', () => {
  const content = SP_D2 + '：电缆敷设1200米\n' + SP_D1 + '：电杆组立3根';
  const r = prevCall({ content }, [spPlan()]);
  assert.equal(r.res.statusCode, 200);
  assert.deepEqual(r.res.payload.days.map(d => d.date), [SP_D1, SP_D2], '应按日期升序');
  assert.equal(r.res.payload.days[0].isFirstDay, true);
  assert.equal(r.res.payload.days[0].workTicketNo, N('6', 801), '首日保留源原号');
  assert.equal(r.res.payload.days[1].workTicketNo, N('6', 802), '拟号按日期顺序分配');
});
t('S6 顺序归一：同一批内容乱序/正序书写 → 产出同一 previewVersion', () => {
  const reversed = SP_D2 + '：电缆敷设1200米\n' + SP_D1 + '：电杆组立3根';
  const ordered = SP_D1 + '：电杆组立3根\n' + SP_D2 + '：电缆敷设1200米';
  const a = prevCall({ content: reversed }, [spPlan()]);
  const b = prevCall({ content: ordered }, [spPlan()]);
  assert.deepEqual(a.res.payload.days.map(d => d.date), b.res.payload.days.map(d => d.date));
  assert.equal(a.res.payload.previewVersion, b.res.payload.previewVersion, '归一化顺序后摘要应一致');
});
t('S7 勘察分类键为 decision（allow / block_surveyed / block_anomalous），不残留 status', () => {
  assert.deepEqual(PSM.classifySplitSurvey(undefined), { decision: 'allow' });
  assert.equal(PSM.classifySplitSurvey({ surveyNo: 'x' }).decision, 'block_surveyed');
  [{}, null, false, 0, '', [], 'x'].forEach(v => {
    const c = PSM.classifySplitSurvey(v);
    assert.equal(c.decision, 'block_anomalous', JSON.stringify(v));
    assert.ok(!('status' in c), '不得再返回 status 键');
  });
});
t('S8 单日计划仍按现行前置拒绝（至少两日的门禁入口未变）', () => {
  const r = prevCall({}, [spPlan({ endDate: SP_D1 + ' 18:00:00' })]);
  assert.equal(r.res.statusCode, 400);
  assert.match(String(r.res.payload.error), /单日计划无需拆分/);
  assert.equal(state.saveCalls, 0);
});

/* ========== Step 7：T 确认拆分（版本复核 / 精确重放 / 取号 / 回滚 / 关闭撤销） ========== */
g('T 确认拆分（Step 7：版本复核 / 精确重放 / 取号与回滚 / unsplit 410）');
t('T1 首次确认成功：首日旧号保留、后日新号、勘察不复制、仅首日写 splitCommitVersion', () => {
  const seed = () => [spPlan({ workTicketNo: OLD11 })];
  const pv = prevCall({}, seed()).res.payload;
  const c = splitCall(splitCommitH, SP_ID, confirmPayload(pv), seed());
  assert.equal(c.res.statusCode, 200, JSON.stringify(c.res.payload));
  const parent = DB.workPlans.find(x => x.id === SP_ID);
  assert.equal(parent.splitCommitVersion, pv.previewVersion);
  assert.equal(parent.splitSnapshot, undefined, '不再写拆分快照');
  const kids = DB.workPlans.filter(x => x.parentPlanId === SP_ID);
  assert.equal(kids.length, 1);
  assert.equal(kids[0].splitCommitVersion, undefined, '仅首日（父）带版本');
  assert.equal(kids[0].workTicketNo, N('6', 801));
  assert.equal(kids[0].survey, undefined);
  assert.equal(c.res.payload.firstDayPlanId, SP_ID);
  assert.deepEqual(c.res.payload.createdPlanIds, kids.map(k => k.id));
  assert.equal(c.res.payload.children, undefined, '不再返回旧 children 字段');
  assert.equal(state.saveCalls, 1);
});
t('T2 源值或 days 改动 → 409 PREVIEW_STALE、零保存', () => {
  const seed = () => [spPlan()];
  const pv = prevCall({}, seed()).res.payload;
  const body = confirmPayload(pv);
  body.days[1].content = '确认前又改过';
  const c = splitCall(splitCommitH, SP_ID, body, seed());
  assert.equal(c.res.statusCode, 409);
  assert.equal(c.res.payload.error, 'PREVIEW_STALE');
  assert.equal(state.saveCalls, 0);
  const body2 = confirmPayload(pv);
  const c2 = splitCall(splitCommitH, SP_ID, body2, [spPlan({ content: '源内容改了\n第二行' })]);
  assert.equal(c2.res.statusCode, 409);
  assert.equal(c2.res.payload.error, 'PREVIEW_STALE');
  assert.equal(state.saveCalls, 0);
});
t('T3 缺 previewVersion / 仅 content → 400 INVALID_INPUT、零保存', () => {
  const a = splitCall(splitCommitH, SP_ID, { days: spDays() }, [spPlan()]);
  assert.equal(a.res.statusCode, 400);
  assert.equal(a.res.payload.error, 'INVALID_INPUT');
  const b = splitCall(splitCommitH, SP_ID, { content: '20日：x', previewVersion: 'v1:a:b:c' }, [spPlan()]);
  assert.equal(b.res.statusCode, 400);
  assert.equal(b.res.payload.error, 'INVALID_INPUT');
  assert.equal(state.saveCalls, 0);
});
t('T4 确认时 days 非法（缺日）→ 400 拆分校验未通过、零保存', () => {
  const c = splitCall(splitCommitH, SP_ID, { previewVersion: 'v1:a:b:c', days: [spDays()[0]] }, [spPlan()]);
  assert.equal(c.res.statusCode, 400);
  assert.equal(c.res.payload.error, '拆分校验未通过');
  assert.ok(c.res.payload.errors.some(e => /缺少计划日期/.test(e)));
  assert.equal(state.saveCalls, 0);
});
t('T5 精确重放：同版本同 days → 200 replay，同一 batchId/createdPlanIds，不保存', () => {
  const seed = () => [spPlan()];
  const pv = prevCall({}, seed()).res.payload;
  const body = confirmPayload(pv);
  const c1 = splitCall(splitCommitH, SP_ID, body, seed());
  assert.equal(c1.res.statusCode, 200);
  const save1 = state.saveCalls;
  const c2 = splitCall(splitCommitH, SP_ID, body, null, true);
  assert.equal(c2.res.statusCode, 200);
  assert.equal(c2.res.payload.replay, true);
  assert.equal(c2.res.payload.batchId, c1.res.payload.batchId);
  assert.deepEqual(c2.res.payload.createdPlanIds, c1.res.payload.createdPlanIds);
  assert.equal(state.saveCalls, save1, '重放不得再次保存');
});
t('T6 已拆 + 版本相同但 days 摘要不同 → 409 ALREADY_SPLIT、不保存', () => {
  const seed = () => [spPlan()];
  const pv = prevCall({}, seed()).res.payload;
  splitCall(splitCommitH, SP_ID, confirmPayload(pv), seed());
  const save1 = state.saveCalls;
  const body = confirmPayload(pv);
  body.days[0].content = '篡改内容';
  const c = splitCall(splitCommitH, SP_ID, body, null, true);
  assert.equal(c.res.statusCode, 409);
  assert.equal(c.res.payload.error, 'ALREADY_SPLIT');
  assert.equal(state.saveCalls, save1);
});
t('T7 重放列表：含软删子记录、排除无关同父记录、顺序稳定', () => {
  const seed = () => [spPlan()];
  const pv = prevCall({}, seed()).res.payload;
  const body = confirmPayload(pv);
  const c1 = splitCall(splitCommitH, SP_ID, body, seed());
  const kidId = c1.res.payload.createdPlanIds[0];
  const kid = DB.workPlans.find(x => x.id === kidId);
  kid.deleted = true;                                        // 软删后仍应出现在重放列表
  DB.workPlans.push({ id: 'unrelated', parentPlanId: SP_ID, splitBatchId: 'other', deleted: false });
  const c2 = splitCall(splitCommitH, SP_ID, body, null, true);
  assert.equal(c2.res.statusCode, 200);
  assert.equal(c2.res.payload.replay, true);
  assert.deepEqual(c2.res.payload.createdPlanIds, [kidId]);
});
t('T8 源号占池：源 6801 时后日确认得 6802（不把源号再分给后日）', () => {
  const seed = () => [spPlan({ workTicketNo: N('6', 801) })];
  const pv = prevCall({}, seed()).res.payload;
  const c = splitCall(splitCommitH, SP_ID, confirmPayload(pv), seed());
  assert.equal(c.res.statusCode, 200);
  const kids = DB.workPlans.filter(x => x.parentPlanId === SP_ID);
  assert.equal(kids[0].workTicketNo, N('6', 802));
});
t('T9 跨月确认：非首日按各自月份取号', () => {
  const lastDay = new Date(Date.UTC(SP_Y, SP_M, 0)).getUTCDate();
  const dMid = SP_CM + '-' + String(lastDay - 1).padStart(2, '0');
  const dLast = SP_CM + '-' + String(lastDay).padStart(2, '0');
  const dNext = SP_NM + '-01';
  const mk = () => spPlan({ startDate: dMid + ' 08:00:00', endDate: dNext + ' 18:00:00', workTicketNo: N('6', 801) });
  const days = [{ date: dMid, content: '甲', quantities: {} }, { date: dLast, content: '乙', quantities: {} }, { date: dNext, content: '丙', quantities: {} }];
  const pv = prevCall({ days }, [mk()]).res.payload;
  const c = splitCall(splitCommitH, SP_ID, confirmPayload(pv), [mk()]);
  assert.equal(c.res.statusCode, 200, JSON.stringify(c.res.payload));
  const kids = DB.workPlans.filter(x => x.parentPlanId === SP_ID).sort((a, b) => (a.startDate < b.startDate ? -1 : 1));
  assert.equal(kids[0].workTicketNo, N('6', 802));
  assert.equal(kids[1].workTicketNo.slice(0, 6), SP_NM.replace('-', ''));
  assert.equal(kids[1].workTicketNo.slice(6), '6801');
});
t('T10 任一日耗尽 → 400 EXHAUSTED、整次零保存', () => {
  const fill = [];
  for (let s = 801; s <= 999; s++) fill.push({ id: 'f' + s, planType: '周计划', ticketType: T1, workTicketNo: N('6', s), deleted: false });
  const seed = [spPlan({ workTicketNo: N('6', 801) })].concat(fill);
  const c = splitCall(splitCommitH, SP_ID, { previewVersion: 'v1:a:b:c', days: spDays() }, seed);
  assert.equal(c.res.statusCode, 400);
  assert.equal(c.res.payload.error, 'EXHAUSTED');
  assert.ok(c.res.payload.message.indexOf(YM_LABEL) > -1);
  assert.equal(state.saveCalls, 0);
});
t('T11 saveDB 抛错 → 500 SAVE_FAILED，父记录还原、无子记录残留、仅一次保存尝试', () => {
  const seed = () => [spPlan({ workTicketNo: N('6', 801) })];
  const pv = prevCall({}, seed()).res.payload;
  reset(seed());
  state.throwNext = true;
  const c = splitCall(splitCommitH, SP_ID, confirmPayload(pv), null, true);
  assert.equal(c.res.statusCode, 500);
  assert.equal(c.res.payload.error, 'SAVE_FAILED');
  assert.equal(state.saveCalls, 1, '失败后不得重试');
  const parent = DB.workPlans.find(x => x.id === SP_ID);
  assert.equal(parent.splitBatchId, undefined, '父记录拆分标记须还原');
  assert.equal(parent.endDate, SP_D2 + ' 18:00:00', '父记录结束时间须还原');
  assert.equal(DB.workPlans.filter(x => x.parentPlanId === SP_ID).length, 0, '不得残留子记录');
});
t('T13 确认同样受勘察门禁：非空 survey → SURVEY_EXISTS；{} → SURVEY_ANOMALOUS，零保存', () => {
  const a = splitCall(splitCommitH, SP_ID, { previewVersion: 'v1:a:b:c', days: spDays() }, [spPlan({ survey: { a: 1 } })]);
  assert.equal(a.res.statusCode, 409);
  assert.equal(a.res.payload.error, 'SURVEY_EXISTS');
  const b = splitCall(splitCommitH, SP_ID, { previewVersion: 'v1:a:b:c', days: spDays() }, [spPlan({ survey: {} })]);
  assert.equal(b.res.statusCode, 409);
  assert.equal(b.res.payload.error, 'SURVEY_ANOMALOUS');
  assert.equal(state.saveCalls, 0);
});
t('T14 unsplit 明确拒绝：410 SPLIT_IRREVERSIBLE，快照/掩码/子记录均未动', () => {
  const parent = spPlan({ splitBatchId: 'sp-old', splitCommitVersion: 'v1:a:b:c', splitSnapshot: { endDate: '2026-11-30 10:00:00' } });
  const kid = { id: 'k1', parentPlanId: SP_ID, splitBatchId: 'sp-old', deleted: false };
  const u = splitCall(splitUndoH, SP_ID, {}, [parent, kid]);
  assert.equal(u.res.statusCode, 410);
  assert.equal(u.res.payload.error, 'SPLIT_IRREVERSIBLE');
  const after = DB.workPlans.find(x => x.id === SP_ID);
  assert.equal(after.splitBatchId, 'sp-old');
  assert.deepEqual(after.splitSnapshot, { endDate: '2026-11-30 10:00:00' });
  assert.equal(DB.workPlans.find(x => x.id === 'k1').deleted, false);
  assert.equal(state.saveCalls, 0);
});

/* ---------- 执行与汇总 ---------- */
async function run() {
  console.log('计划管理优化 Step 3 / 4 / 5A / 5B · 进程内隔离测试（不监听端口 / 不启服务 / 不写生产库）');
  console.log('操作当天月份 YYYYMM = ' + YM + '（' + YM_LABEL + '，与 todayBizDate 同源 bjStr）\n');
  for (const x of queue) {
    total += 1;
    try {
      await x.fn();
      passed += 1;
      groups[x.group].pass += 1;
      console.log('  PASS  ' + x.name);
    } catch (e) {
      failed += 1;
      groups[x.group].fail += 1;
      console.log('  FAIL  ' + x.name + ' :: ' + (e && e.message));
    }
  }
  console.log('\n===== 分组结果 =====');
  Object.keys(groups).forEach(k => {
    console.log('  ' + k + '：' + groups[k].pass + ' 通过 / ' + groups[k].fail + ' 失败');
  });
  console.log('===== 总计：' + total + ' 项，通过 ' + passed + '，失败 ' + failed + ' =====');
  if (failed) process.exitCode = 1;
}
if (require.main === module) run();
module.exports = { createHarness: null, PTM, YM, T1, T2, T3, L1, N };
