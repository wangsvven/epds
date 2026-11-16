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

/* ---------- runner ---------- */
let pass = 0; const fails = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fails.push({ name: name, msg: e.message }); console.log('  FAIL  ' + name + '\n        ' + String(e.message).split('\n').join('\n        ')); }
}
function g(name) { console.log('\n' + name); }

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

/* ---------- 汇总 ---------- */
console.log('\n===== 总计：' + (pass + fails.length) + ' 项，通过 ' + pass + '，失败 ' + fails.length + ' =====');
if (fails.length) {
  fails.forEach(f => console.log('  - ' + f.name + '：' + String(f.msg).split('\n')[0]));
  process.exit(1);
}
