/* ========== scripts/plan-mgmt-20261114.test.js ========== */
/* 计划管理优化 Step 3 / Step 4 共用的「进程内隔离测试」。
 * 直接运行：node scripts/plan-mgmt-20261114.test.js
 *
 * 隔离方式（不监听端口 / 不启动服务 / 不写生产数据）：
 *  - 用 Module._load 按解析后的绝对路径，只替换 server/core/app.js（路由收集器）
 *    与 server/core/db.js（内存 DB + saveDB 计数桩）。真实 core/db.js 加载即
 *    migrateDB()→saveDB() 写盘，故必须替换；本测试断言它从未进入 require.cache。
 *  - 其余依赖全部加载仓库真实模块：core/util、core/plan-ticket-no（Step 2）、
 *    core/crud、core/upload(multer)、core/doc-templates、core/survey-doc、xlsx、exceljs。
 *  - require('server/routes/plans.js') 触发真实注册；从收集器取出注册在 crud()
 *    之前的专用 POST /api/workPlans handler，直接以 mock req/res 调用。
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
} finally {
  Module._load = origLoad;
}

const workPlanPosts = routes.filter(r => r.method === 'POST' && r.path === '/api/workPlans');
const specialized = workPlanPosts.length ? workPlanPosts[0].handler : null;
const crudPost = workPlanPosts.length > 1 ? workPlanPosts[1] : null;

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
t('I2 未新增专用 PUT /api/workPlans/:id（该路径仍只有通用 crud 那 1 条，Step 5 才挂）', () => {
  // core/crud.js:29 本就注册 PUT /:id（cur+body 合并语义）。本步只加专用 POST，
  // 故该路径应恰好 1 条、且为通用 crud handler（含 ...cur 合并、不含 mode 逻辑）。
  const puts = routes.filter(r => r.method === 'PUT' && r.path === '/api/workPlans/:id');
  assert.equal(puts.length, 1);
  assert.match(String(puts[0].handler), /\.\.\.cur|merged/);
  assert.doesNotMatch(String(puts[0].handler), /MODE_REQUIRED|classifyPlanTicketEdit/);
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

/* ---------- 执行与汇总 ---------- */
async function run() {
  console.log('计划管理优化 Step 3 / Step 4 · 进程内隔离测试（不监听端口 / 不启服务 / 不写生产库）');
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
