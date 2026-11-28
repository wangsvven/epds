#!/usr/bin/env node
/* work-feed 契约单测：ids（成员/去重/无空值/分组不串）与 sub；日期窗口边界。
 * 只验契约，不断言 ids 数量与文案数字相等（两者口径不同）。 */
const assert = require('assert');
const W = require('../public/js/work-feed.js');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  PASS  ' + name); } catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + e.message); } }
const T = '2026-11-21';
const ids = m => (m.ids || []).slice().sort();

console.log('A ids 契约');

t('alert：ids = alerts 的人员 id（去重、无空值）+ sub=workers', () => {
  const m = W.alertMessage([{ id: 'w1', name: '甲', validEnd: '2026-11-20' }, { id: 'w1', name: '甲', validEnd: '2026-11-20' }, { id: null, name: '乙' }, { id: 'w2', name: '丙', validEnd: '2026-11-22' }], []);
  assert.deepStrictEqual(ids(m), ['w1', 'w2']);
  assert.strictEqual(m.sub, 'workers');
});

t('person：新增/退场分别带各自 ids 且互不串', () => {
  const ws = [
    { id: 'a', name: '甲', createdAt: '2026-11-20T17:00:00.000Z' },
    { id: 'b', name: '乙', status: '已退场', exitedAt: '2026-11-20 09:00', createdAt: '2026-11-01T00:00:00.000Z' }
  ];
  const ms = W.personMessages(ws, T);
  assert.strictEqual(ms.length, 2);
  assert.deepStrictEqual(ids(ms[0]), ['a']);
  assert.deepStrictEqual(ids(ms[1]), ['b']);
});

t('material：批次 materialIds ∪ 手工新增，去重去空', () => {
  const ims = [{ id: 'b1', importedAt: '2026-11-20 10:00', rowsTotal: 5, rows: 3, materialIds: ['m1', 'm2', 'm2', '', null] }];
  const mats = [{ id: 'm1', createdAt: '2026-11-20T01:00:00.000Z' }, { id: 'm9', createdAt: '2026-11-20T02:00:00.000Z' }];
  const m = W.materialMessages(ims, mats, T)[0];
  assert.deepStrictEqual(ids(m), ['m1', 'm2', 'm9']);
  assert.strictEqual(m.sub, 'detail');
});

t('plan：周/月分行各自 ids，不串组', () => {
  const ps = [{ id: 'p1', planType: '周计划', createdAt: '2026-11-20T03:00:00.000Z' },
    { id: 'p2', planType: '月计划', createdAt: '2026-11-20T03:00:00.000Z' },
    { id: 'p3', planType: '周计划', createdAt: '2026-11-20T04:00:00.000Z' }];
  const ms = W.planMessages(ps, T);
  const w = ms.find(x => x.text.includes('周计划')), mo = ms.find(x => x.text.includes('月计划'));
  assert.deepStrictEqual(ids(w), ['p1', 'p3']);
  assert.deepStrictEqual(ids(mo), ['p2']);
});

t('requisition / outbound / doc / borrow / project / work：ids 与 sub', () => {
  const one = [{ id: 'x1', createdAt: '2026-11-20T04:00:00.000Z' }];
  assert.deepStrictEqual(ids(W.requisitionMessages(one, T)[0]), ['x1']);
  assert.strictEqual(W.requisitionMessages(one, T)[0].sub, 'requisition');
  assert.strictEqual(W.outboundMessages(one, T)[0].sub, 'outbound-orders');
  assert.deepStrictEqual(ids(W.docMessages(one, T)[0]), ['x1']);
  assert.deepStrictEqual(ids(W.borrowMessages(one, T)[0]), ['x1']);
  assert.deepStrictEqual(ids(W.projectMessages(one, T)[0]), ['x1']);
});

t('transfer：调拨/借调同天各算一张，sub=transfer，窗口外/已删除/已撤销排除', () => {
  const ts = [
    { id: 't1', kind: '调拨', createdAt: T + ' 09:10' },
    { id: 't2', kind: '借调', createdAt: T + ' 10:20' },
    { id: 't3', kind: '调拨', createdAt: '2026-10-01 09:00' },
    { id: 't4', kind: '调拨', createdAt: T + ' 11:00', deleted: true },
    { id: 't5', kind: '调拨', createdAt: T + ' 12:00', status: '已撤销' }   // 撤销单不计入（与材料明细口径一致）
  ];
  const ms = W.transferMessages(ts, T);
  assert.strictEqual(ms.length, 1);
  assert.deepStrictEqual(ids(ms[0]), ['t1', 't2']);
  assert.strictEqual(ms[0].sub, 'transfer');
  assert.strictEqual(ms[0].kind, 'transfer');
  assert.ok(ms[0].text.indexOf('（调拨 1 · 借调 1）') > -1, ms[0].text);
});

t('createdMessages：submittedAt 回退路径也带 ids', () => {
  const m = W.workMessages([{ id: 'k1', submittedAt: '2026-11-19 08:00' }], T)[0];
  assert.deepStrictEqual(ids(m), ['k1']);
});

console.log('B 日期窗口与去重');

t('北京日边界：00:00 与 23:59 各归其日', () => {
  const ms = W.requisitionMessages([
    { id: 'e1', createdAt: '2026-11-20T16:00:00.000Z' },   // 北京 11-21 00:00
    { id: 'e2', createdAt: '2026-11-21T15:59:00.000Z' }    // 北京 11-21 23:59
  ], T);
  assert.strictEqual(ms.length, 1);
  assert.strictEqual(ms[0].day, '2026-11-21');
  assert.deepStrictEqual(ids(ms[0]), ['e1', 'e2']);
});

t('窗口外（前天之前 / 未来）不入，文案仍按原口径', () => {
  const ms = W.requisitionMessages([
    { id: 'old', createdAt: '2026-11-18T01:00:00.000Z' },  // 北京 11-18 09:00 → 窗口 [11-19,11-21] 之外
    { id: 'fut', createdAt: '2026-11-22T01:00:00.000Z' }
  ], T);
  assert.strictEqual(ms.length, 0);
});

t('同一 id 出现两次：文案计数按条数，ids 去重（两者口径不同，不断言相等）', () => {
  const ms = W.requisitionMessages([
    { id: 'r1', createdAt: '2026-11-20T04:00:00.000Z' },
    { id: 'r1', createdAt: '2026-11-20T05:00:00.000Z' }
  ], T);
  assert.ok(ms[0].text.includes('2'));
  assert.deepStrictEqual(ids(ms[0]), ['r1']);
});

console.log('\n===== 总计：' + (pass + fail) + ' 项，通过 ' + pass + '，失败 ' + fail + ' =====');
process.exit(fail ? 1 : 0);
