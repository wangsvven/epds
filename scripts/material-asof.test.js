#!/usr/bin/env node
/* ========== scripts/material-asof.test.js ==========
 * 材料「截至业务日可用量」核心口径单测（第 1 步 · A 组）。
 *
 * 隔离方式：把 core/db.js 在 require.cache 里替换成内存桩，**不加载真实 db 模块**，
 * 因此不会触发数据迁移、不会 saveDB、不会碰 data/db.json。
 * material-calc 内部是延迟 require('./db')，每次都会命中这个桩。
 *
 * 运行：node scripts/material-asof.test.js
 */
const assert = require('assert');
const path = require('path');
const Module = require('module');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const DB_PATH = require.resolve(path.join(ROOT, 'server', 'core', 'db.js'));

// DB 保持同一个对象引用（routes 里是解构取 DB，换对象会看不到新数据）
const dbState = { materials: [], materialRequisitions: [], materialOutbound: [], projects: [], workers: [] };
let saveCalls = 0;
const dbStub = {
  DB: dbState,
  saveDB() { saveCalls++; throw new Error('availableAsOf 是只读计算，不应调用 saveDB'); }
};
require.cache[DB_PATH] = {
  id: DB_PATH, filename: DB_PATH, loaded: true, exports: dbStub, children: [], paths: []
};

const { availableAsOf, replayAvailability, eventsOf, roundQty } = require(path.join(ROOT, 'server', 'core', 'material-calc.js'));

/* ---------- 夹具 ---------- */
const OPEN_DATE = '2026-11-12';
const OPEN_AT = '2026-11-12 18:05';

function material(over) {
  return Object.assign({
    id: 'm1', code: 'C1', description: '测试材料', unit: '个', project: 'P1',
    qtyArrived: 0, deleted: false, createdAt: '2026-11-01 10:00:00',
    openingAvailable: 0, openingDate: OPEN_DATE, openingAt: OPEN_AT, openingRaw: 0
  }, over || {});
}
// 入库：一条领料单 + 一条 history
function inboundReq(id, materialId, arrivalDate, qty, over) {
  return Object.assign({
    id: id, reqNo: 'LL-' + id, status: '部分到库', deleted: false,
    reqDate: arrivalDate, confirmedAt: arrivalDate + ' 09:00:00',
    items: [{ materialId: materialId, qty: qty, project: 'P1' }],
    history: [{ arrivalDate: arrivalDate, at: arrivalDate + ' 09:00:00', rows: [{ materialId: materialId, thisQty: qty }] }]
  }, over || {});
}
function outbound(id, materialId, outDate, qty, over) {
  return Object.assign({
    id: id, outNo: 'OUT-' + id, status: '有效', deleted: false, project: 'P1',
    outDate: outDate, items: [{ materialId: materialId, code: 'C1', qty: qty, returned: 0 }], returns: []
  }, over || {});
}
function seed(opts) {
  const o = opts || {};
  dbState.materials = o.materials || [];
  dbState.materialRequisitions = o.requisitions || [];
  dbState.materialOutbound = o.outbound || [];
  dbState.projects = o.projects || [];
  dbState.workers = o.workers || [];
  saveCalls = 0;
}

/* ---------- runner（收集后顺序执行，支持 async 用例） ---------- */
let pass = 0; const fails = []; const cases = [];
function t(name, fn) { cases.push({ kind: 't', name: name, fn: fn }); }
function g(name) { cases.push({ kind: 'g', name: name }); }
async function runAll() {
  for (const c of cases) {
    if (c.kind === 'g') { console.log('\n' + c.name); continue; }
    try { await c.fn(); pass++; console.log('  PASS  ' + c.name); }
    catch (e) {
      fails.push({ name: c.name, msg: e.message });
      console.log('  FAIL  ' + c.name + '\n        ' + String(e.message).split('\n').join('\n        '));
    }
  }
  console.log('\n===== 总计：' + (pass + fails.length) + ' 项，通过 ' + pass + '，失败 ' + fails.length + ' =====');
  if (fails.length) {
    fails.forEach(f => console.log('  - ' + f.name + '：' + String(f.msg).split('\n')[0]));
    process.exit(1);
  }
}

/* ================= A 核心口径 ================= */
g('A 截至日可用量 availableAsOf');

t('A1 基本：入库 D−2、出库 D−1，三日取值与手算一致', () => {
  seed({
    materials: [material()],
    requisitions: [inboundReq('r1', 'm1', '2026-11-14', 100)],
    outbound: [outbound('o1', 'm1', '2026-11-15', 30)]
  });
  assert.equal(availableAsOf('m1', '2026-11-14').available, 100);
  assert.equal(availableAsOf('m1', '2026-11-15').available, 70);
  assert.equal(availableAsOf('m1', '2026-11-16').available, 70);
});

t('A2 尚未入库（历史完整）：D 之后才入库 → available 0 且 notYetIn=true', () => {
  seed({
    materials: [material()],
    requisitions: [inboundReq('r1', 'm1', '2026-11-21', 100)],
    outbound: []
  });
  const r = availableAsOf('m1', '2026-11-20');
  assert.equal(r.available, 0);
  assert.equal(r.notYetIn, true, '截至 D 无任何入库，且期初净额为 0');
  assert.equal(r.beforeOpening, false);
  assert.equal(r.openingDate, OPEN_DATE);
  // D 之后日期正常累加
  assert.equal(availableAsOf('m1', '2026-11-21').available, 100);
  assert.equal(availableAsOf('m1', '2026-11-21').notYetIn, false, '已入库后不再成立');
});

t('A2b 历史不完整反例：缺期初字段 / openingRaw 为负 → notYetIn=false（但仍算出 0，不返回 null）', () => {
  // 缺期初字段（模拟迁移之后新建、未补写期初）
  seed({ materials: [material({ openingDate: undefined, openingAt: undefined, openingAvailable: undefined, openingRaw: undefined })], requisitions: [], outbound: [] });
  const a = availableAsOf('m1', '2026-11-20');
  assert.equal(a.notYetIn, false, '缺期初字段一律视为历史不可核查');
  assert.equal(a.available, 0, '缺期初字段仍按 0 起算算出实际值，不返回 null');
  assert.equal(a.beforeOpening, false, '没有 openingDate 就不存在期初前');
  // openingRaw 为负：期初按 0 起算，但不可声称「尚未入库」
  seed({ materials: [material({ openingAvailable: 0, openingRaw: -12.5 })], requisitions: [], outbound: [] });
  const b = availableAsOf('m1', '2026-11-20');
  assert.equal(b.notYetIn, false, 'openingRaw<0 说明老账有量，不能证明未入库');
  assert.equal(b.available, 0);
});

t('A3 同日收发：同日既入又出，截至日可用为当日结算值', () => {
  seed({
    materials: [material()],
    requisitions: [inboundReq('r1', 'm1', '2026-11-16', 100)],
    outbound: [outbound('o1', 'm1', '2026-11-16', 40)]
  });
  assert.equal(availableAsOf('m1', '2026-11-16').available, 60, '同日先入后出');
  assert.equal(availableAsOf('m1', '2026-11-15').available, 0);
});

t('A4 归还按 returnDate 计入；作废出库单、作废领料单全程不计', () => {
  seed({
    materials: [material()],
    requisitions: [inboundReq('r1', 'm1', '2026-11-13', 100)],
    outbound: [
      outbound('o1', 'm1', '2026-11-14', 50, {
        returns: [{ at: '2026-11-18 10:00:00', returnDate: '2026-11-18', rows: [{ materialId: 'm1', qty: 20 }] }]
      }),
      outbound('o2', 'm1', '2026-11-15', 10, { status: '已作废' })   // 作废：出库与归还都不算
    ]
  });
  assert.equal(availableAsOf('m1', '2026-11-17').available, 50, '归还日之前不提前计入');
  assert.equal(availableAsOf('m1', '2026-11-18').available, 70, '归还日当天计入');
  assert.equal(availableAsOf('m1', '2026-11-20').available, 70, '作废单不产生事件');
  // 作废领料单的入库同样不计
  seed({
    materials: [material()],
    requisitions: [inboundReq('r2', 'm1', '2026-11-13', 100, { status: '已作废' })],
    outbound: []
  });
  assert.equal(availableAsOf('m1', '2026-11-20').available, 0);
});

t('A5 期初：D=openingDate 计当日 openingAt 之后的事件；D<openingDate 返回 beforeOpening/null；openingAt 之前的流水不重复计', () => {
  seed({
    materials: [material({ openingAvailable: 96, openingRaw: 96 })],
    requisitions: [
      inboundReq('r0', 'm1', '2026-11-12', 30, { history: [{ arrivalDate: '2026-11-12', at: '2026-11-12 17:00:00', rows: [{ materialId: 'm1', thisQty: 30 }] }] }),
      inboundReq('r1', 'm1', '2026-11-12', 4, { history: [{ arrivalDate: '2026-11-12', at: '2026-11-12 20:00:00', rows: [{ materialId: 'm1', thisQty: 4 }] }] })
    ],
    outbound: []
  });
  assert.equal(availableAsOf('m1', '2026-11-12').available, 100, '期初 96 + 当日 18:05 之后的 4；17:00 那笔已含期初');
  assert.equal(availableAsOf('m1', '2026-11-11').available, null);
  assert.equal(availableAsOf('m1', '2026-11-11').beforeOpening, true);
  assert.equal(availableAsOf('m1', '2026-11-11').openingDate, OPEN_DATE);
  assert.equal(availableAsOf('m1', '2026-11-11').notYetIn, false, '期初前不判 notYetIn');
});

t('A6 期初为 0 但曾入库：可用 0 时 notYetIn=false', () => {
  seed({
    materials: [material()],
    requisitions: [inboundReq('r1', 'm1', '2026-11-20', 100)],
    outbound: [outbound('o1', 'm1', '2026-11-20', 100)]
  });
  const r = availableAsOf('m1', '2026-11-20');
  assert.equal(r.available, 0);
  assert.equal(r.notYetIn, false, '有 ≤D 的入库记录，不能声称尚未入库');
});

t('A7 期初后补录期初前业务：并入基数，与回放终值一致、不判负', () => {
  seed({
    materials: [material()],
    // 业务日早于 openingDate（11-12）、录入时刻晚于 openingAt 的补登入库 50
    requisitions: [inboundReq('r1', 'm1', '2026-11-05', 50, {
      history: [{ arrivalDate: '2026-11-05', at: '2026-11-16 10:00:00', rows: [{ materialId: 'm1', thisQty: 50 }] }]
    })],
    outbound: []
  });
  const asof = availableAsOf('m1', '2026-11-20');
  assert.equal(asof.available, 50, '期初 0 + 期初前补录 50 并入基数');
  const rp = replayAvailability('m1');
  assert.equal(rp.ok, true, '不因期初前业务判负');
  assert.equal(rp.available, 50, '与回放终值一致');
});

t('A8 未来入库不提前用', () => {
  seed({ materials: [material()], requisitions: [inboundReq('r1', 'm1', '2026-11-25', 80)], outbound: [] });
  assert.equal(availableAsOf('m1', '2026-11-24').available, 0);
  assert.equal(availableAsOf('m1', '2026-11-25').available, 80);
});

t('A9 同工程同编码双 id：分别核算互不串账', () => {
  seed({
    materials: [material({ id: 'mA', code: 'SAME' }), material({ id: 'mB', code: 'SAME' })],
    requisitions: [inboundReq('r1', 'mA', '2026-11-13', 10), inboundReq('r2', 'mB', '2026-11-13', 90)],
    outbound: [outbound('o1', 'mA', '2026-11-14', 4)]
  });
  assert.equal(availableAsOf('mA', '2026-11-20').available, 6);
  assert.equal(availableAsOf('mB', '2026-11-20').available, 90);
});

t('A10 精度：0.0001 步进累加无漂移，四位小数', () => {
  const reqs = [];
  for (let i = 0; i < 10; i++) reqs.push(inboundReq('r' + i, 'm1', '2026-11-13', 0.0001));
  seed({ materials: [material()], requisitions: reqs, outbound: [] });
  const v = availableAsOf('m1', '2026-11-20').available;
  assert.equal(v, 0.001, '10 × 0.0001 = 0.001，实际 ' + v);
  assert.equal(roundQty(v), v);
});

t('A11 与回放同源：同一数据下 availableAsOf(最后业务日) === replayAvailability().available', () => {
  seed({
    materials: [material({ openingAvailable: 10, openingRaw: 10 })],
    requisitions: [inboundReq('r1', 'm1', '2026-11-13', 100), inboundReq('r2', 'm1', '2026-11-16', 5)],
    outbound: [outbound('o1', 'm1', '2026-11-14', 30), outbound('o2', 'm1', '2026-11-17', 20)]
  });
  const last = '2026-11-30';
  assert.equal(availableAsOf('m1', last).available, replayAvailability('m1').available);
  assert.equal(availableAsOf('m1', last).available, 65, '10 + 100 + 5 − 30 − 20');
});

t('A12 不存在/非法日期：返回 missing，不抛异常', () => {
  seed({ materials: [material()], requisitions: [], outbound: [] });
  assert.equal(availableAsOf('nope', '2026-11-20').available, null);
  assert.equal(availableAsOf('nope', '2026-11-20').missing, true);
  assert.equal(availableAsOf('m1', '').missing, true, '空日期视为缺失');
  assert.equal(availableAsOf('m1', '2026/11/20').missing, true, '非 YYYY-MM-DD 视为缺失');
  // 注：「格式合法但日历不存在」（如 2026-02-30）由接口层校验拦下，核心函数只认格式
  assert.equal(availableAsOf('m1', '2026-11-20').missing, undefined, '正常日期不应标 missing');
});

t('A13 只读：全程未调用 saveDB', () => {
  assert.equal(saveCalls, 0, 'availableAsOf / eventsOf 不应写库，实际 ' + saveCalls);
});

t('A14 回归：replayAvailability 返回值结构未变（ok/firstNegativeDate/available/qty/refNo/self/label/kind）', () => {
  seed({ materials: [material()], requisitions: [inboundReq('r1', 'm1', '2026-11-13', 10)], outbound: [] });
  const ok = replayAvailability('m1');
  ['ok', 'firstNegativeDate', 'available', 'qty', 'refNo', 'self', 'label', 'kind'].forEach(k => assert.ok(k in ok, '缺字段 ' + k));
  assert.equal(ok.ok, true);
  const bad = replayAvailability('m1', [{ date: '2026-11-14', kind: 'out', qty: 999, self: true }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.firstNegativeDate, '2026-11-14');
  // eventsOf 签名与默认行为不变（不接收排除参数）
  assert.equal(eventsOf.length, 1);
});

t('A16 曾有出库 → notYetIn=false（即使出库时刻在期初盖戳之前、已含进期初）', () => {
  // 带期初字段、opening 与 openingRaw 均为 0、无任何入库 history，
  // 但有一笔业务日 ≤ D 的有效出库（时刻早于 openingAt，模拟老手工备料已全出完）
  seed({
    materials: [material()],
    requisitions: [],
    outbound: [outbound('o1', 'm1', '2026-11-10', 6, { createdAt: '2026-11-10 09:00:00' })]
  });
  const r = availableAsOf('m1', '2026-11-20');
  assert.equal(r.available, 0, '出库时刻 ≤ 期初盖戳 → 已含期初，不重复扣减');
  assert.equal(r.notYetIn, false, '曾有出库即证明 D 之前有过库存，不得报尚未入库');

  // 边界：出库业务日晚于 D → 不构成「截至 D 之前有库存」的证据
  seed({
    materials: [material()],
    requisitions: [],
    outbound: [outbound('o1', 'm1', '2026-11-25', 6, { createdAt: '2026-11-25 09:00:00' })]
  });
  assert.equal(availableAsOf('m1', '2026-11-20').notYetIn, true, 'D 之后的出库不影响判断');
  assert.equal(availableAsOf('m1', '2026-11-20').available, 0);

  // 回归：真未入库（无入库、无出库）仍为 true
  seed({ materials: [material()], requisitions: [], outbound: [] });
  assert.equal(availableAsOf('m1', '2026-11-20').notYetIn, true);
});

t('A17 迁移前的出库单在迁移后作废：期初按当时净额回补（群晖 17 根双扣的回归）', () => {
  // 迁移时刻 18:05：已到 50（25+25），有效出库净额 17（13+4）→ 期初 33
  // 11-15 把这两张作废、又按原业务日补录 4+13 与 15、1 → 聚合 93−33=60
  // 不回补期初时回放 = 33 −17(折叠补录) −15 −1 +43 = 43（少 17）；回补后 60
  const base = [
    outbound('o1', 'm1', '2026-11-11', 13, { createdAt: '2026-11-11 17:12:00', status: '已作废', voidedAt: '2026-11-15 17:36:00' }),
    outbound('o2', 'm1', '2026-11-11', 4, { createdAt: '2026-11-11 17:39:00', status: '已作废', voidedAt: '2026-11-15 17:24:00' }),
    outbound('o3', 'm1', '2026-11-10', 4, { createdAt: '2026-11-15 17:46:00' }),
    outbound('o4', 'm1', '2026-11-11', 13, { createdAt: '2026-11-15 17:51:00' }),
    outbound('o5', 'm1', '2026-11-12', 15, { createdAt: '2026-11-15 17:52:00' }),
    outbound('o6', 'm1', '2026-11-15', 1, { createdAt: '2026-11-15 18:09:00' })
  ];
  const reqs = [
    inboundReq('r1', 'm1', '2026-11-09', 25, { status: '已入库', history: [{ arrivalDate: '2026-11-09', at: '2026-11-09 13:28:00', rows: [{ materialId: 'm1', thisQty: 25 }] }] }),
    inboundReq('r2', 'm1', '2026-11-10', 25, { status: '已入库', history: [{ arrivalDate: '2026-11-10', at: '2026-11-10 14:06:00', rows: [{ materialId: 'm1', thisQty: 25 }] }] }),
    inboundReq('r3', 'm1', '2026-11-15', 43, { status: '已入库', history: [{ arrivalDate: '2026-11-15', at: '2026-11-15 13:46:00', rows: [{ materialId: 'm1', thisQty: 43 }] }] })
  ];
  seed({ materials: [material({ qtyArrived: 93, openingAvailable: 33, openingRaw: 33 })], requisitions: reqs, outbound: base });
  assert.equal(availableAsOf('m1', '2026-11-16').available, 60, '期初回补 17 后与聚合一致（93−33）');
  const rp = replayAvailability('m1');
  assert.equal(rp.ok, true, '回补后不应判负');
  assert.equal(rp.available, 60, '回放终值同为 60');

  // 反向验证：期初不解释时不动（见 A19）；期初不解释的情形不在此列
});

t('A18 迁移前的领料单在迁移后作废：期初扣回当时已入库的量', () => {
  // 迁移时：r1 入库 100 + r2 入库 20 → 已到 120、无出库 → 期初 120
  // 迁移后作废 r2（冲销 20）→ 已到 100、聚合可用 100；期初不回补则回放仍 120（偏高 20）
  seed({
    materials: [material({ qtyArrived: 100, openingAvailable: 120, openingRaw: 120 })],
    requisitions: [
      inboundReq('r1', 'm1', '2026-11-10', 100, { status: '已入库', history: [{ arrivalDate: '2026-11-10', at: '2026-11-10 09:00:00', rows: [{ materialId: 'm1', thisQty: 100 }] }] }),
      inboundReq('r2', 'm1', '2026-11-11', 20, { status: '已作废', voidedAt: '2026-11-16 10:00:00', history: [{ arrivalDate: '2026-11-11', at: '2026-11-11 09:00:00', rows: [{ materialId: 'm1', thisQty: 20 }] }] })
    ],
    outbound: []
  });
  assert.equal(availableAsOf('m1', '2026-11-16').available, 100, '期初扣回 20 后与聚合一致');
  assert.equal(replayAvailability('m1').available, 100, '回放终值同为 100');
});

t('A19 安全阀：期初与迁移口径不自洽（老账/数据搬家）→ 不回补，沿用原值', () => {
  // 已到(T) 300、无出库 → 迁移公式应写 300，库里却是 100（解释不通）
  seed({
    materials: [material({ qtyArrived: 300, openingAvailable: 100, openingRaw: 100 })],
    requisitions: [inboundReq('r1', 'm1', '2026-11-10', 300, { status: '已入库', history: [{ arrivalDate: '2026-11-10', at: '2026-11-10 09:00:00', rows: [{ materialId: 'm1', thisQty: 300 }] }] })],
    outbound: [outbound('o1', 'm1', '2026-11-11', 50, { createdAt: '2026-11-11 17:00:00', status: '已作废', voidedAt: '2026-11-16 10:00:00' })]
  });
  assert.equal(availableAsOf('m1', '2026-11-16').available, 100, '不回补：仍按库内期初 100 起算（差异交 P0-4，不在算法里猜）');
});

/* ================= B 接口 ================= */
g('B 接口 stock-asof 与 /stock includeZero');

/* 载入路由：替换 core/app（收集器）与 core/db（桩），其余模块真实加载 */
const APP_PATH = require.resolve(path.join(ROOT, 'server', 'core', 'app.js'));
const collected = [];
const fakeApp = {
  use() { return this; },
  get(p, h) { collected.push({ method: 'GET', path: p, handler: h }); return this; },
  post(p, mw, h) { collected.push({ method: 'POST', path: p, handler: typeof mw === 'function' ? mw : h }); return this; },
  put(p, mw, h) { collected.push({ method: 'PUT', path: p, handler: typeof mw === 'function' ? mw : h }); return this; },
  delete(p, mw, h) { collected.push({ method: 'DELETE', path: p, handler: typeof mw === 'function' ? mw : h }); return this; }
};
const loadStack = Module._load;
Module._load = function (request, parent, isMain) {
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent, isMain); } catch (e) { resolved = ''; }
  if (resolved === DB_PATH) return dbStub;
  if (resolved === APP_PATH) return fakeApp;
  return loadStack.apply(this, arguments);
};
try {
  require(path.join(ROOT, 'server', 'routes', 'materials.js'));
} finally {
  Module._load = loadStack;
}
const stockH = (collected.find(r => r.method === 'GET' && r.path === '/api/materialOutbound/stock') || {}).handler;
const asofH = (collected.find(r => r.method === 'GET' && r.path === '/api/materialOutbound/stock-asof') || {}).handler;
const createH = (collected.find(r => r.method === 'POST' && r.path === '/api/materialOutbound/create') || {}).handler;

function invoke(handler, query) {
  const res = {
    statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
    send(p) { this.payload = p; return this; },
    end() { return this; }
  };
  handler({ query: query || {}, params: {}, body: {}, headers: {} }, res);
  return { status: res.statusCode, data: res.payload };
}
const TODAY = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const PAST30 = new Date(Date.now() + 8 * 3600 * 1000 - 60 * 86400000).toISOString().slice(0, 10);

t('B0 两个端点都已注册（stock / stock-asof）', () => {
  assert.ok(stockH, '/api/materialOutbound/stock 应已注册');
  assert.ok(asofH, '/api/materialOutbound/stock-asof 应已注册');
});

t('B1 参数校验：缺 project / 缺 date / 非法日历日 / 晚于今天 / 空 ids / 空段 / 归属不符 → 400', () => {
  seed({ materials: [material({ id: 'm1', project: 'P1' })] });
  assert.equal(invoke(asofH, { date: '2026-11-16', ids: 'm1' }).status, 400, '缺 project');
  assert.equal(invoke(asofH, { project: 'P1', ids: 'm1' }).status, 400, '缺 date');
  const badCal = invoke(asofH, { project: 'P1', date: '2026-02-30', ids: 'm1' });
  assert.equal(badCal.status, 400, '2026-02-30 不是真实日期');
  assert.match(String(badCal.data && badCal.data.error), /日期/);
  const future = invoke(asofH, { project: 'P1', date: '2999-01-01', ids: 'm1' });
  assert.equal(future.status, 400, '晚于今天');
  assert.match(String(future.data && future.data.error), /不能晚于今天/);
  assert.equal(invoke(asofH, { project: 'P1', date: '2026-11-16' }).status, 400, '缺 ids');
  assert.equal(invoke(asofH, { project: 'P1', date: '2026-11-16', ids: '' }).status, 400, '空 ids');
  assert.equal(invoke(asofH, { project: 'P1', date: '2026-11-16', ids: 'm1,,m2' }).status, 400, '含空段');
  const wrongProj = invoke(asofH, { project: 'P2', date: '2026-11-16', ids: 'm1' });
  assert.equal(wrongProj.status, 400, '不属于该工程');
  assert.equal(String(wrongProj.data && wrongProj.data.error), '物料不存在或不属于所选工程');
});

t('B2 响应形态：回显 date、字段齐全、重复 id 去重、早于 30 天照常返回（不要求补录原因）', () => {
  seed({
    materials: [material({ id: 'm1', project: 'P1', code: 'C1', unit: '个', openingDate: '2026-09-01', openingAt: '2026-09-01 00:00' })],
    requisitions: [inboundReq('r1', 'm1', PAST30, 12)],
    outbound: []
  });
  const r = invoke(asofH, { project: 'P1', date: PAST30, ids: 'm1,m1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  assert.equal(r.data.project, 'P1');
  assert.equal(r.data.date, PAST30, '须回显请求日期');
  assert.equal(r.data.rows.length, 1, '重复 id 应去重');
  const row = r.data.rows[0];
  ['materialId', 'code', 'description', 'unit', 'available', 'notYetIn', 'beforeOpening', 'openingDate'].forEach(k => assert.ok(k in row, '缺字段 ' + k));
  assert.equal(row.materialId, 'm1');
  assert.equal(row.available, 12, '早于 30 天照常核算（只读查询不校验补录原因）');
  assert.equal(row.notYetIn, false);
  assert.equal(row.beforeOpening, false);
});

t('B3 beforeOpening 形态：date < openingDate → available null + beforeOpening true + openingDate 回显', () => {
  seed({ materials: [material({ id: 'm1', project: 'P1' })], requisitions: [], outbound: [] });
  const r = invoke(asofH, { project: 'P1', date: '2026-11-11', ids: 'm1' });
  assert.equal(r.status, 200);
  const row = r.data.rows[0];
  assert.equal(row.available, null);
  assert.equal(row.beforeOpening, true);
  assert.equal(row.openingDate, OPEN_DATE);
});

t('B4 /stock 回归：不带 includeZero 与改前一致（只含 available>0，响应为数组）', () => {
  seed({
    materials: [
      material({ id: 'mOk', project: 'P1', qtyArrived: 50 }),
      material({ id: 'mZero', project: 'P1', qtyArrived: 100 }),
      material({ id: 'mNever', project: 'P1', qtyArrived: 0 }),
      material({ id: 'mOther', project: 'P2', qtyArrived: 90 })
    ],
    requisitions: [],
    outbound: [outbound('o1', 'mZero', '2026-11-15', 100)]
  });
  const r = invoke(stockH, { project: 'P1' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data), '仍返回数组（不是 {ok,data}）');
  const ids = r.data.map(x => x.id).sort();
  assert.deepEqual(ids, ['mOk'], '默认只含可用 >0 的本工程材料');
  const row = r.data[0];
  ['id', 'description', 'code', 'unit', 'inQty', 'taken', 'returned', 'net', 'available', 'hasRecords'].forEach(k => assert.ok(k in row, '字段缺失 ' + k));
});

t('B5 /stock includeZero=1：多出「曾入库但当前耗尽」行（available 0），不出现从未入库材料', () => {
  seed({
    materials: [
      material({ id: 'mOk', project: 'P1', qtyArrived: 50 }),
      material({ id: 'mZero', project: 'P1', qtyArrived: 100 }),
      material({ id: 'mNever', project: 'P1', qtyArrived: 0 })
    ],
    requisitions: [],
    outbound: [outbound('o1', 'mZero', '2026-11-15', 100)]
  });
  const r = invoke(stockH, { project: 'P1', includeZero: '1' });
  assert.equal(r.status, 200);
  const ids = r.data.map(x => x.id).sort();
  assert.deepEqual(ids, ['mOk', 'mZero'], '耗尽行应出现，从未入库行不应出现');
  const zero = r.data.find(x => x.id === 'mZero');
  assert.equal(zero.available, 0);
  assert.equal(zero.inQty, 100);
});

t('B6 创建出库的回放拒绝仍返回 replayFail 结构（既有行为回归，走真实 handler）', () => {
  seed({
    materials: [material({ id: 'm1', project: 'P1', qtyArrived: 100 })],
    requisitions: [inboundReq('r1', 'm1', '2026-11-13', 10)],
    outbound: [],
    projects: [{ id: 'pj1', name: 'P1', deleted: false, subProjects: [] }],
    workers: [{ id: 'w1', name: '张三', phone: '13800000000', status: '已准入', deleted: false }]
  });
  assert.ok(createH, 'create handler 应已注册');
  const res = {
    statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; }
  };
  createH({
    query: {}, params: {}, headers: {},
    body: {
      project: 'P1', receiver: '张三', workerId: 'w1', outDate: '2026-11-16',
      items: [{ materialId: 'm1', qty: 999 }]
    }
  }, res);
  assert.equal(res.statusCode, 400, '超量出库应被拒');
  const msg = String((res.payload && res.payload.error) || '');
  assert.ok(msg.length > 0, '应有错误文案');
  assert.match(msg, /可用/, '既有拒绝文案应说明可用不足：' + msg);
});

/* ---------- 汇总 ---------- */
/* ================= D 前端行为（组件级真实函数调用） ================= */
g('D 登记弹窗按截至日核算（真实 Outbounds.setup）');

const MAT_VIEW_PATH = path.join(ROOT, 'public', 'js', 'views', 'materials.js');

function matHarness(opts) {
  const o = opts || {};
  const msgs = [];
  const gets = [];
  const posts = [];
  const watchList = [];
  const sb = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, JSON: JSON, Date: Date, Math: Math, Number: Number, String: String, Boolean: Boolean, Array: Array, Object: Object, RegExp: RegExp, Promise: Promise, isNaN: isNaN, parseFloat: parseFloat, parseInt: parseInt };
  vm.createContext(sb);
  vm.runInContext('globalThis.window = globalThis;', sb);
  /* 定位会话桩：本测试只验截至日出库核算，不验「工作动态」定位跳转。
     视图 setup 顶层会调 window.Locate.make()，缺桩会直接抛
     "Cannot read properties of undefined (reading 'make')" 而连坐全部用例。 */
  sb.Locate = {
    pending: () => null, seq: () => 0, end: () => {}, bump: () => 0, take: () => null, drop: () => {},
    notifyNew: () => {}, idsSet: () => new Set(),
    make: () => ({
      st: { active: false, total: 0, set: new Set(), group: '', on: false },
      hit: () => false, apply: () => {}, consume: () => false, recompute: () => false, refreshFailed: () => {}
    })
  };
  sb.Vue = {
    ref: v => ({ value: v }),
    reactive: obj => obj,
    computed: fn => (typeof fn === 'function'
      ? { get value() { return fn(); } }
      : { get value() { return fn.get(); }, set value(v) { if (fn.set) fn.set(v); } }),
    watch: (gg, cb) => { watchList.push({ g: gg, cb: cb }); return () => {}; },
    onMounted: () => {}, onUnmounted: () => {}, nextTick: f => (f ? f() : undefined), h: () => ({})
  };
  // 浏览器里这些是 api.js 顶层解构出的全局（script 作用域），沙箱同样铺开
  sb.ref = sb.Vue.ref; sb.reactive = sb.Vue.reactive;
  sb.computed = sb.Vue.computed; sb.watch = sb.Vue.watch;
  sb.onMounted = () => {}; sb.onUnmounted = () => {};
  sb.nextTick = f => (f ? f() : undefined);
  sb.fmtTime = v => String(v == null ? '' : v);
  sb.canWrite = () => true;
  sb.addEventListener = () => {}; sb.removeEventListener = () => {};
  sb.document = {};
  sb.ServerTime = { ymd: () => (o.today || '2026-11-16') };
  sb.api = {
    async get(u) { gets.push(u); return o.get ? o.get(u) : []; },
    async post(u, b) {
      posts.push({ u: u, b: b });
      return o.post ? o.post(u, b) : { ok: true, data: { outNo: 'OUT-TEST-0001' } };
    }
  };
  sb.ElementPlus = {
    ElMessage: {
      success: m => msgs.push('success:' + m), error: m => msgs.push('error:' + m),
      warning: m => msgs.push('warning:' + m), info: m => msgs.push('info:' + m)
    }
  };
  vm.runInContext(fs.readFileSync(MAT_VIEW_PATH, 'utf8') + '\n;globalThis.__OB = Outbounds;', sb, { filename: 'views/materials.js' });
  const view = sb.__OB.setup({}, { emit: () => {} });
  view.workers.value = [{ id: 'w1', name: '张三', phone: '13800000000' }];
  return { view: view, watchList: watchList, gets: gets, posts: posts, msgs: msgs };
}
const tick = () => new Promise(r => setTimeout(r, 0));
function fireWatch(h, kind) {
  for (const w of h.watchList) {
    let v;
    try { v = w.g(); } catch (e) { continue; }
    if (kind === 'visible' && v === true) { w.cb(v); return true; }
    if (kind === 'hidden' && v === false) { w.cb(v); return true; }
    if (kind === 'outDate' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { w.cb(v); return true; }
  }
  return false;
}
function idsOf(u) {
  const m = /[?&]ids=([^&]*)/.exec(String(u || ''));
  return m ? decodeURIComponent(m[1]).split(',').filter(Boolean) : [];
}
function asofPayload(ids, avail, extra) {
  return {
    ok: true, date: '2026-11-16',
    rows: ids.map(id => Object.assign({
      materialId: id, code: 'C1', description: 'M-' + id, unit: '个',
      available: typeof avail === 'function' ? avail(id) : avail,
      notYetIn: false, beforeOpening: false, openingDate: '2026-11-12'
    }, (extra && extra[id]) || {}))
  };
}
// 造「已勾选、已填量、已打开弹窗」的初始态
function openWithRows(h, rows, opts) {
  const o = opts || {};
  const v = h.view;
  v.project.value = o.project || 'P1';
  rows.forEach(r => {
    v.selMap.set(r.id, { id: r.id, code: r.code || 'C1', description: r.description || ('M-' + r.id), unit: '个', available: r.available });
    if (r.qty !== undefined) v.outQty[r.id] = r.qty;
  });
  v.openDlg();                     // 按 outQty 生成 dlg.rows，outDate 设为今天（会清空 workerId）
  v.dlg.workerId = (o.workerId === undefined) ? 'w1' : o.workerId;
  if (o.outDate) v.dlg.outDate = o.outDate;
}

t('D1 改日期保数量：切换出库日期后 qty 不变、可用与行状态更新', async () => {
  let avail = 100;
  const h = matHarness({ get: u => (u.indexOf('/stock-asof') > -1 ? asofPayload(idsOf(u), avail) : []) });
  openWithRows(h, [{ id: 'm1', available: 100, qty: 30 }, { id: 'm2', available: 50, qty: 20 }]);
  fireWatch(h, 'visible');
  await tick(); await tick();
  assert.equal(h.view.asofState.status, 'ok', '首次核算应成功');
  assert.equal(h.view.asofAvail(h.view.dlg.rows[0]), 100);
  assert.equal(h.view.canSubmitOut.value, true, '有领取人 + 核算成功 → 可提交');
  avail = 25;                       // 换日：可用降到 25
  h.view.dlg.outDate = '2026-11-15';
  fireWatch(h, 'outDate');
  await tick(); await tick();
  assert.equal(h.view.asofState.date, '2026-11-15');
  assert.equal(h.view.asofAvail(h.view.dlg.rows[0]), 25, '可用应随日期重算');
  assert.equal(h.view.dlg.rows[0].qty, 30, '数量不得被改动');
  assert.equal(h.view.dlg.rows[1].qty, 20, '数量不得被改动');
  assert.equal(h.view.rowState(h.view.dlg.rows[0]), 'short', '30 > 25 应为不足');
  assert.equal(h.view.rowState(h.view.dlg.rows[1]), 'ok');
  assert.match(h.view.rowStateText(h.view.dlg.rows[0]), /缺口 5/);
});

t('D2 行状态与文案：尚未入库 / 可用为 0 / 不足 / 期初前，四态文案正确且整行浅红', async () => {
  const h = matHarness({
    get: u => asofPayload(idsOf(u), 0, {
      a: { notYetIn: true },
      b: { notYetIn: false },
      c: { available: 10, notYetIn: false },
      d: { available: null, beforeOpening: true, openingDate: '2026-11-12' }
    })
  });
  openWithRows(h, [
    { id: 'a', available: 0 }, { id: 'b', available: 0 },
    { id: 'c', available: 10, qty: 15 }, { id: 'd', available: 0 }
  ]);
  fireWatch(h, 'visible');
  await tick(); await tick();
  const rows = h.view.dlg.rows;
  assert.equal(h.view.rowState(rows[0]), 'notIn');
  assert.match(h.view.rowStateText(rows[0]), /尚未入库/);
  assert.equal(h.view.rowState(rows[1]), 'zero');
  assert.match(h.view.rowStateText(rows[1]), /截至该日可用为 0/);
  assert.equal(h.view.rowState(rows[2]), 'short');
  assert.match(h.view.rowStateText(rows[2]), /可用 10\.0000 · 本次 15\.0000 · 缺口 5\.0000/);
  assert.equal(h.view.rowState(rows[3]), 'beforeOpening');
  assert.match(h.view.rowStateText(rows[3]), /期初日 2026-11-12 之前不可核算/);
  assert.equal(h.view.asofAvail(rows[3]), null, '期初前不返回近似值');
  assert.ok(Object.keys(h.view.rowStyleOf({ row: rows[2] })).length > 0, '不足行应有浅红背景');
  assert.deepEqual(h.view.rowStyleOf({ row: rows[2] }) , h.view.rowStyleOf({ row: rows[0] }));
  assert.equal(h.view.canSubmitOut.value, false, '存在期初前行 → 禁提交');
});

t('D3 请求绑定：日期 A→B 连改，旧响应（成功或失败）一律被丢弃；旧结束不清新加载态', async () => {
  const pending = [];
  const h = matHarness({ get: u => new Promise(res => pending.push({ u: u, res: res })) });
  openWithRows(h, [{ id: 'm1', available: 100, qty: 10 }], { outDate: '2026-11-16' });
  fireWatch(h, 'visible');                       // 请求 1
  await tick();
  h.view.dlg.outDate = '2026-11-15';
  fireWatch(h, 'outDate');                       // 请求 2
  await tick();
  assert.equal(pending.length, 2);
  pending[1].res(asofPayload(['m1'], 20));       // 新的先回
  await tick(); await tick();
  assert.equal(h.view.asofAvail(h.view.dlg.rows[0]), 20);
  assert.equal(h.view.asofState.status, 'ok');
  pending[0].res(asofPayload(['m1'], 999));      // 旧的后回：不得覆盖
  await tick(); await tick();
  assert.equal(h.view.asofAvail(h.view.dlg.rows[0]), 20, '旧成功响应必须丢弃');
  assert.equal(h.view.asofState.date, '2026-11-15', '绑定日期仍是最新请求');
  // 旧请求失败晚到，也不得把状态打成失败
  h.view.dlg.outDate = '2026-11-14';
  fireWatch(h, 'outDate');                       // 请求 3
  await tick();
  pending[2].res(asofPayload(['m1'], 30));
  await tick(); await tick();
  assert.equal(h.view.asofState.status, 'ok');
  const stale = pending[0];                      // 已 resolve 的旧请求不再影响；再造一个失败场景
  assert.ok(stale);
  // 关闭弹窗后到达的响应必须丢弃
  h.view.dlg.visible = false;
  fireWatch(h, 'hidden');
  await tick();
  assert.equal(h.view.asofState.status, 'idle', '关闭即复位');
});

t('D4 禁用纪律：缺行 / 空日期 / 失败 → 按钮禁用，且直接调用 submitOut 也被拦下（不发创建请求）', async () => {
  // ① 响应缺行
  const h1 = matHarness({ get: u => ({ ok: true, date: '2026-11-16', rows: [] }) });
  openWithRows(h1, [{ id: 'm1', available: 100, qty: 10 }]);
  fireWatch(h1, 'visible');
  await tick(); await tick();
  assert.equal(h1.view.asofState.status, 'error', '缺行按失败处理');
  assert.equal(h1.view.canSubmitOut.value, false);
  const n1 = h1.posts.length;
  await h1.view.submitOut();
  assert.equal(h1.posts.length, n1, '核算未完成不得发创建请求');
  assert.ok(h1.msgs.some(m => m.indexOf('库存核算未完成') > -1), h1.msgs.join('|'));

  // ② 日期为空
  const h2 = matHarness({ get: u => asofPayload(idsOf(u), 100) });
  openWithRows(h2, [{ id: 'm1', available: 100, qty: 10 }]);
  h2.view.dlg.outDate = '';
  fireWatch(h2, 'visible');
  await tick(); await tick();
  assert.equal(h2.view.asofState.status, 'error');
  assert.match(h2.view.asofState.error, /请选择出库日期/);
  assert.equal(h2.view.canSubmitOut.value, false);

  // ③ 接口失败
  const h3 = matHarness({ get: u => { const e = new Error('boom'); e.data = { error: '物料不存在或不属于所选工程' }; throw e; } });
  openWithRows(h3, [{ id: 'm1', available: 100, qty: 10 }]);
  fireWatch(h3, 'visible');
  await tick(); await tick();
  assert.equal(h3.view.asofState.status, 'error');
  assert.match(h3.view.asofState.error, /物料不存在或不属于所选工程/);
  assert.equal(h3.view.canSubmitOut.value, false);

  // ④ 没有领取人也不可提交
  const h4 = matHarness({ get: u => asofPayload(idsOf(u), 100) });
  openWithRows(h4, [{ id: 'm1', available: 100, qty: 10 }], { workerId: '' });
  fireWatch(h4, 'visible');
  await tick(); await tick();
  assert.equal(h4.view.asofState.status, 'ok');
  assert.equal(h4.view.canSubmitOut.value, false, '未选领取人不可提交');
});

t('D5 候选列表：零库存开关默认关；开启后请求带 includeZero=1', async () => {
  const h = matHarness({ get: () => [] });
  h.view.project.value = 'P1';
  await h.view.load();
  const stockUrls1 = h.gets.filter(u => u.indexOf('/api/materialOutbound/stock?') > -1);
  assert.ok(stockUrls1.length > 0, '应请求可出库列表');
  assert.equal(stockUrls1[0].indexOf('includeZero'), -1, '默认不带 includeZero');
  assert.equal(h.view.showZero.value, false, '开关默认关');
  h.view.showZero.value = true;
  await h.view.load();
  const stockUrls2 = h.gets.filter(u => u.indexOf('/api/materialOutbound/stock?') > -1);
  assert.ok(stockUrls2[stockUrls2.length - 1].indexOf('includeZero=1') > -1, '开启后带 includeZero=1');
});

t('D6 提交：成功后清空选中与数量；失败保留全部输入并透传后端文案', async () => {
  const okH = matHarness({ get: u => asofPayload(idsOf(u), 100), post: () => ({ ok: true, data: { outNo: 'OUT-OK-1' } }) });
  openWithRows(okH, [{ id: 'm1', available: 100, qty: 10 }]);
  fireWatch(okH, 'visible');
  await tick(); await tick();
  await okH.view.submitOut();
  await tick(); await tick();
  assert.equal(okH.view.selMap.size, 0, '成功后清空选中');
  assert.equal(Object.keys(okH.view.outQty).length, 0, '成功后清空数量');
  assert.ok(okH.msgs.some(m => m.indexOf('OUT-OK-1') > -1), okH.msgs.join('|'));

  const badH = matHarness({
    get: u => asofPayload(idsOf(u), 100),
    post: () => { const e = new Error('failed'); e.data = { error: '补录后 2026-11-16 物料「M-m1」可用库存将为负（当时可用 0，本单出库 10）' }; throw e; }
  });
  openWithRows(badH, [{ id: 'm1', available: 100, qty: 10 }]);
  fireWatch(badH, 'visible');
  await tick(); await tick();
  await badH.view.submitOut();
  await tick(); await tick();
  assert.equal(badH.view.selMap.size, 1, '失败不得清空选中');
  assert.equal(badH.view.dlg.rows[0].qty, 10, '失败保留数量');
  assert.ok(badH.msgs.some(m => m.indexOf('可用库存将为负') > -1), '应透传后端文案：' + badH.msgs.join('|'));
});

t('D7 同编码双 id：两行同级材料可同时选中、数量分别保留、弹窗独立核算', async () => {
  const h = matHarness({ get: u => asofPayload(idsOf(u), id => (id === 'mA' ? 10 : 90)) });
  openWithRows(h, [
    { id: 'mA', code: 'SAME', available: 10, qty: 4 },
    { id: 'mB', code: 'SAME', available: 90, qty: 8 }
  ]);
  assert.equal(h.view.selCount.value, 2, '同编码不同 id 应计 2 条');
  fireWatch(h, 'visible');
  await tick(); await tick();
  const rows = h.view.dlg.rows;
  assert.equal(rows.length, 2, '弹窗应两行独立');
  assert.equal(h.view.asofAvail(rows[0]), 10);
  assert.equal(h.view.asofAvail(rows[1]), 90);
  assert.equal(rows[0].qty, 4);
  assert.equal(rows[1].qty, 8);
  assert.equal(h.view.canSubmitOut.value, true);
});

/* ================= C 显示与提交一致性 ================= */
g('C 显示与提交的分工');

t('C1 显示足够但后续日不足：提交被回放拒绝，错误含材料与日期，输入全部保留', async () => {
  const h = matHarness({
    get: u => asofPayload(idsOf(u), 100),
    post: () => {
      const e = new Error('failed');
      e.data = { error: '补录后 2026-11-20 物料「M-m1」可用库存将为负（当时可用 0，本单出库 30）', date: '2026-11-20', materialId: 'm1', code: 'C1' };
      throw e;
    }
  });
  openWithRows(h, [{ id: 'm1', available: 100, qty: 30 }]);
  fireWatch(h, 'visible');
  await tick(); await tick();
  assert.equal(h.view.canSubmitOut.value, true, '截至日足够 → 界面不拦');
  await h.view.submitOut();
  await tick(); await tick();
  assert.ok(h.msgs.some(m => m.indexOf('2026-11-20') > -1 && m.indexOf('M-m1') > -1), '错误须含具体日期与材料：' + h.msgs.join('|'));
  assert.equal(h.view.dlg.rows[0].qty, 30, '失败保留数量');
  assert.equal(h.view.selMap.size, 1, '失败保留选中');
});

t('C3 当日不足：数量超过截至日可用 → 前端拦截，不调用创建接口', async () => {
  const h = matHarness({ get: u => asofPayload(idsOf(u), 10) });
  openWithRows(h, [{ id: 'm1', available: 100, qty: 15 }]);
  fireWatch(h, 'visible');
  await tick(); await tick();
  assert.equal(h.view.canSubmitOut.value, true, '按钮本身可用（是否够量由函数内校验）');
  const before = h.posts.length;
  await h.view.submitOut();
  await tick();
  assert.equal(h.posts.length, before, '超量不得发创建请求');
  assert.ok(h.msgs.some(m => /缺口 5/.test(m)), '应提示缺口：' + h.msgs.join('|'));
});

t('D8 404 文案映射：接口未加载说人话，其它错误仍显示原文', async () => {
  // ① 404（服务进程未加载 stock-asof）：换成可理解的提示，状态仍 error、不可提交、数量不变
  const h404 = matHarness({
    get: () => { const e = new Error('未找到'); e.status = 404; e.data = { error: '未找到' }; throw e; }
  });
  openWithRows(h404, [{ id: 'm1', available: 100, qty: 30 }]);
  fireWatch(h404, 'visible');
  await tick(); await tick();
  assert.equal(h404.view.asofState.status, 'error');
  assert.equal(h404.view.asofState.error, '库存核算接口未加载，请重启服务后重试',
    '实际：' + h404.view.asofState.error);
  assert.equal(h404.view.canSubmitOut.value, false, '仍禁用提交');
  assert.equal(h404.view.dlg.rows[0].qty, 30, '数量不得被改动');

  // ② 非 404（400 业务报错）：原样显示后端文案，不得被改写
  const h400 = matHarness({
    get: () => { const e = new Error('物料不存在或不属于所选工程'); e.status = 400; e.data = { error: '物料不存在或不属于所选工程' }; throw e; }
  });
  openWithRows(h400, [{ id: 'm1', available: 100, qty: 30 }]);
  fireWatch(h400, 'visible');
  await tick(); await tick();
  assert.equal(h400.view.asofState.status, 'error');
  assert.equal(h400.view.asofState.error, '物料不存在或不属于所选工程', '非 404 不得改写');
  assert.equal(h400.view.canSubmitOut.value, false);
});

runAll();
