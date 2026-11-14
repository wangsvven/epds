/* ========== scripts/plan-ticket-no.test.js ========== */
/* Step 2 单测：core/plan-ticket-no.js 的 r6 2.2 / 2.4.1 纯函数。
 * node 直接运行：node scripts/plan-ticket-no.test.js
 * 不启服务、不连生产库、不写任何数据；独立计数，不与 scripts/smoke.js 的 169 混报。
 */
const assert = require('node:assert/strict');
const M = require('../server/core/plan-ticket-no');

const T1 = '配电：配电第一种工作票';   // 码 6
const T2 = '配电：配电第二种工作票';   // 码 7
const T3 = '配电：低压工作票';         // 码 9
const L1 = '线路：线路第一种工作票';
const L2 = '线路：线路第二种工作票';
const OLD = '20261168001';             // 历史 11 位旧格式
const N801 = '2026116801';             // 新格式 10 位：202611 + 6 + 801

let total = 0, passed = 0, failed = 0;
let group = '(未分组)';
const groups = {};
function g(name) { group = name; groups[name] = { pass: 0, fail: 0 }; }
function t(name, fn) {
  total += 1;
  try {
    fn();
    passed += 1;
    groups[group].pass += 1;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed += 1;
    groups[group].fail += 1;
    console.log('  FAIL  ' + name + ' :: ' + (e && e.message));
  }
}
const rec = (id, no, extra) => Object.assign({ id, workTicketNo: no, ticketType: T1 }, extra || {});

g('A 票种识别与号码解析');
t('A1 三种配电票种 isDistPowerTicketType = true', () => {
  [T1, T2, T3].forEach(x => assert.equal(M.isDistPowerTicketType(x), true));
});
t('A2 线路两票种 / 空票种 / 未知 = false', () => {
  [L1, L2, '', undefined, null, '带电工作票'].forEach(x => assert.equal(M.isDistPowerTicketType(x), false));
});
t('A3 parse 合法首号 801 → {yearMonth,typeCode,serial}', () => {
  const r = M.parseDistWorkTicketNo(N801);
  assert.equal(r.ok, true);
  assert.deepEqual(r.parsed, { yearMonth: '202611', typeCode: '6', serial: 801 });
});
t('A4 parse 另两票种与上界 999', () => {
  assert.equal(M.parseDistWorkTicketNo('2026117801').parsed.typeCode, '7');
  assert.equal(M.parseDistWorkTicketNo('2026119999'.slice(0, 6) + '9' + '999').parsed.typeCode, '9');
  assert.equal(M.parseDistWorkTicketNo('2026119999'.slice(0, 6) + '9' + '999').parsed.serial, 999);
});
t('A5 历史 11 位旧格式 → INVALID_INPUT', () => {
  const r = M.parseDistWorkTicketNo(OLD);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_INPUT');
});
t('A6 号段外（800 / 000 / 1000 形态）→ INVALID_INPUT', () => {
  ['2026116800', '2026116000', '2026116001'].forEach(no => {
    assert.equal(M.parseDistWorkTicketNo(no).error, 'INVALID_INPUT');
  });
});
t('A7 非法类型码与位数 → INVALID_INPUT', () => {
  ['2026118801', '2026110801', '202611680', '20261168001', '', null].forEach(no => {
    assert.equal(M.parseDistWorkTicketNo(no).error, 'INVALID_INPUT');
  });
});
t('A8 非法月份 → INVALID_INPUT', () => {
  assert.equal(M.parseDistWorkTicketNo('2026136801').error, 'INVALID_INPUT');
  assert.equal(M.parseDistWorkTicketNo('2026006801').error, 'INVALID_INPUT');
});

g('B 单号分配');
t('B1 空记录 → 当月首号 801', () => {
  const r = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records: [] });
  assert.deepEqual(r, { ok: true, workTicketNo: N801 });
});
t('B2 max+1 不补中间空号（801 / 805 → 806）', () => {
  const records = [rec('a', '2026116801'), rec('b', '2026116805')];
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records }).workTicketNo, '2026116806');
});
t('B3 软删且曾是当前最大 → 下一号可复用（805 软删、801 存活 → 802）', () => {
  const records = [rec('a', '2026116801'), rec('b', '2026116805', { deleted: true })];
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records }).workTicketNo, '2026116802');
});
t('B4 历史 11 位旧号不占新流水', () => {
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records: [rec('a', OLD)] }).workTicketNo, N801);
});
t('B5 不同 yearMonth 分组独立（跨月预演各用开始月）', () => {
  const records = [rec('a', '2026116803'), rec('b', '2026126810')];
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records }).workTicketNo, '2026116804');
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202612', records }).workTicketNo, '2026126811');
});
t('B6 不同票种分组独立，同年月互不串号', () => {
  const records = [rec('a', '2026116801'), Object.assign(rec('b', '2026117801'), { ticketType: T2 })];
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records }).workTicketNo, '2026116802');
  assert.equal(M.allocateWorkTicketNo({ ticketType: T2, yearMonth: '202611', records }).workTicketNo, '2026117802');
});
t('B7 999 用尽 → EXHAUSTED，message 指明月份与票种', () => {
  const r = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records: [rec('a', '2026116999'.replace('999', '999'))] });
  // 显式使用 6+999 的合法号
  const r2 = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records: [rec('a', '2026116999'.slice(0, 6) + '6' + '999')] });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'EXHAUSTED');
  assert.match(r2.message, /2026-11/);
  assert.match(r2.message, /配电：配电第一种工作票/);
  assert.ok(r);
});
t('B8 不跨月借号（202611 满 999、202612 空 → 202612 仍 801）', () => {
  const records = [rec('a', '2026116999'.slice(0, 6) + '6' + '999')];
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202612', records }).workTicketNo, '2026126801');
});
t('B9 excludeIds 内保留原号不被再分配（801 排除 + 803 存活 → 804）', () => {
  const records = [rec('src', '2026116801'), rec('b', '2026116803')];
  const r = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records, excludeIds: ['src'] });
  assert.equal(r.workTicketNo, '2026116804');
});
t('B10 线路票种不分配 / yearMonth 非法拒绝', () => {
  assert.equal(M.allocateWorkTicketNo({ ticketType: L1, yearMonth: '202611', records: [] }).error, 'UNSUPPORTED_TICKET_TYPE');
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '2026-11', records: [] }).error, 'INVALID_INPUT');
});
t('B11 分配出的新号不与存活号撞号（可直接过断言）', () => {
  const records = [rec('a', '2026116801')];
  const r = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records });
  assert.deepEqual(M.assertDistWorkTicketNoAvailable({
    workTicketNo: r.workTicketNo, ticketType: T1, records
  }), { ok: true });
});

g('C 批量分配');
t('C1 三项等长且互不重复（801 / 802 / 803）', () => {
  const r = M.allocateWorkTicketNos({
    items: [
      { ticketType: T1, yearMonth: '202611' },
      { ticketType: T1, yearMonth: '202611' },
      { ticketType: T1, yearMonth: '202611' }
    ], records: []
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.workTicketNos, ['2026116801', '2026116802', '2026116803']);
  assert.equal(new Set(r.workTicketNos).size, 3);
});
t('C2 跨月 items 各自按开始月分组', () => {
  const r = M.allocateWorkTicketNos({
    items: [{ ticketType: T1, yearMonth: '202611' }, { ticketType: T1, yearMonth: '202612' }],
    records: [rec('a', '2026116805')]
  });
  assert.deepEqual(r.workTicketNos, ['2026116806', '2026126801']);
});
t('C3 混合票种 items 互不重复', () => {
  const r = M.allocateWorkTicketNos({
    items: [{ ticketType: T1, yearMonth: '202611' }, { ticketType: T2, yearMonth: '202611' }, { ticketType: T3, yearMonth: '202611' }],
    records: []
  });
  assert.equal(r.ok, true);
  assert.equal(new Set(r.workTicketNos).size, 3);
  assert.deepEqual(r.workTicketNos, ['2026116801', '2026117801', '2026119801']);
});
t('C4 任一项耗尽整体失败，不返回部分成功列表', () => {
  const r = M.allocateWorkTicketNos({
    items: [{ ticketType: T1, yearMonth: '202611' }, { ticketType: T1, yearMonth: '202612' }],
    records: [rec('a', '2026126999'.slice(0, 6) + '6' + '999')]
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'EXHAUSTED');
  assert.equal(r.workTicketNos, undefined);
});

g('D 撞号断言');
t('D1 与存活新格式号撞号 → DUPLICATE', () => {
  const r = M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T1, records: [rec('b', N801)] });
  assert.equal(r.error, 'DUPLICATE');
});
t('D2 excludeIds 排除自身后不误报', () => {
  const r = M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T1, records: [rec('self', N801)], excludeIds: ['self'] });
  assert.deepEqual(r, { ok: true });
});
t('D3 批内重复 → DUPLICATE', () => {
  const r = M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T1, records: [], batchNos: [N801] });
  assert.equal(r.error, 'DUPLICATE');
});
t('D4 类型码与票种不符 → INVALID_INPUT', () => {
  assert.equal(M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T2, records: [] }).error, 'INVALID_INPUT');
});
t('D5 手填号月份与当前月不同仍通过（不验月份一致性）', () => {
  const r = M.assertDistWorkTicketNoAvailable({ workTicketNo: '2026016801', ticketType: T1, records: [] });
  assert.deepEqual(r, { ok: true });
});
t('D6 非配电票种 → UNSUPPORTED_TICKET_TYPE；旧格式 → INVALID_INPUT', () => {
  assert.equal(M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: L1, records: [] }).error, 'UNSUPPORTED_TICKET_TYPE');
  assert.equal(M.assertDistWorkTicketNoAvailable({ workTicketNo: OLD, ticketType: T1, records: [] }).error, 'INVALID_INPUT');
});
t('D7 勘察号合法共用与本函数无关', () => {
  const records = [
    { id: 'a', workTicketNo: N801, surveyNo: '202611001' },
    { id: 'b', workTicketNo: '2026116802', surveyNo: '202611001' }
  ];
  const r = M.assertDistWorkTicketNoAvailable({ workTicketNo: '2026116803', ticketType: T1, records });
  assert.deepEqual(r, { ok: true });
});
t('D8 软删记录的号不算存活占用', () => {
  const r = M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T1, records: [rec('a', N801, { deleted: true })] });
  assert.deepEqual(r, { ok: true });
});

g('E 轻操作判别');
t('E1 {status} → true', () => assert.equal(M.isLightPlanEdit({ status: '已执行' }), true));
t('E2 {planNote} → true', () => assert.equal(M.isLightPlanEdit({ planNote: 'x' }), true));
t('E3 {status, planNote} 组合 → true（不得按真子集排除）', () => assert.equal(M.isLightPlanEdit({ status: '已取消', planNote: '' }), true));
t('E4 无键 {} → true', () => assert.equal(M.isLightPlanEdit({}), true));
t('E5 夹带 workTicketNo（同库中旧值）→ false', () => {
  assert.equal(M.isLightPlanEdit({ status: '已执行', workTicketNo: OLD }), false);
  assert.equal(M.isLightPlanEdit({ planNote: 'x', workTicketNo: N801 }), false);
});
t('E6 数组 / 字符串 / null / 数字 / undefined → false', () => {
  [[], 'x', null, 1, undefined, new Date()].forEach(v => assert.equal(M.isLightPlanEdit(v), false));
});
t('E7 其它业务键（address/content/ticketType/planType/surveyNo）→ false', () => {
  ['address', 'content', 'ticketType', 'planType', 'surveyNo'].forEach(k => {
    assert.equal(M.isLightPlanEdit({ [k]: 'x' }), false);
  });
});

g('F 编辑判别 classifyPlanTicketEdit');
const storedWeek = (extra) => Object.assign({ id: 'w1', planType: '周计划', ticketType: T1, workTicketNo: N801 }, extra || {});
t('F1 body 非普通对象 → INVALID_INPUT', () => {
  [null, [], 'x', 1].forEach(body => {
    const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body });
    assert.equal(r.error, 'INVALID_INPUT');
  });
});
t('F2 轻操作在旧号记录上仍 light（不因旧号受阻、不改号）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek({ workTicketNo: OLD }), body: { status: '已执行' } });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'light');
});
t('F3 配电周计划只改 address 未带号 + 已存合规号 → validate + excludeIds', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { address: '新地址' } });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'validate');
  assert.equal(r.workTicketNo, N801);
  assert.equal(r.ticketType, T1);
  assert.deepEqual(r.excludeIds, ['w1']);
});
t('F4 同上但已存 11 位旧号 → INVALID_INPUT（合并后失败）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek({ workTicketNo: OLD }), body: { address: '新地址' } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_INPUT');
});
t('F5 配电周计划缺号 → INVALID_INPUT（须补合规号）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek({ workTicketNo: '' }), body: { content: 'x' } });
  assert.equal(r.error, 'INVALID_INPUT');
});
t('F6 月计划未主动写票号/票种 → skip_ticket_rule', () => {
  const stored = { id: 'm1', planType: '月计划', name: '月计划A' };
  const r = M.classifyPlanTicketEdit({ stored, body: { maintDevice: '设备', planNote: 'x' } });
  assert.deepEqual(r, { ok: true, action: 'skip_ticket_rule' });
});
t('F7 月计划主动写合规配电号 → validate', () => {
  const stored = { id: 'm1', planType: '月计划' };
  const r = M.classifyPlanTicketEdit({ stored, body: { ticketType: T1, workTicketNo: N801 } });
  assert.equal(r.action, 'validate');
  assert.equal(r.workTicketNo, N801);
});
t('F8 月计划主动写旧格式号 → INVALID_INPUT', () => {
  const stored = { id: 'm1', planType: '月计划', ticketType: T1 };
  assert.equal(M.classifyPlanTicketEdit({ stored, body: { workTicketNo: OLD } }).error, 'INVALID_INPUT');
});
t('F9 月计划主动写非配电票种 → skip_ticket_rule', () => {
  const stored = { id: 'm1', planType: '月计划' };
  assert.equal(M.classifyPlanTicketEdit({ stored, body: { ticketType: L1 } }).action, 'skip_ticket_rule');
});
t('F10 请求 planType 与已存不同 → INVALID_INPUT（防伪造身份绕过）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek({ workTicketNo: OLD }), body: { planType: '月计划', address: 'x' } });
  assert.equal(r.error, 'INVALID_INPUT');
});
t('F11 线路记录改普通字段 → skip_ticket_rule', () => {
  const stored = { id: 'l1', planType: '周计划', ticketType: L1, workTicketNo: OLD };
  assert.equal(M.classifyPlanTicketEdit({ stored, body: { content: 'x' } }).action, 'skip_ticket_rule');
});
t('F12 已存配电改 ticketType 为线路仍须校验（不得靠改票种躲开）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: L1, address: 'x' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T1);
});
t('F13 已存线路但请求主动写配电票种 → 走校验', () => {
  const stored = { id: 'l1', planType: '周计划', ticketType: L1, workTicketNo: '' };
  const r = M.classifyPlanTicketEdit({ stored, body: { ticketType: T2, workTicketNo: '2026117801' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T2);
});
t('F14 所有成功分支均含 ok:true', () => {
  const cases = [
    M.classifyPlanTicketEdit({ stored: storedWeek(), body: { status: '已执行' } }),
    M.classifyPlanTicketEdit({ stored: { id: 'm', planType: '月计划' }, body: { name: 'x' } }),
    M.classifyPlanTicketEdit({ stored: storedWeek(), body: { address: 'x' } })
  ];
  cases.forEach(r => assert.equal(r.ok, true));
});
t('F15 勘察号不参与编辑判别（共号不判失败）', () => {
  const r = M.classifyPlanTicketEdit({
    stored: storedWeek({ surveyNo: '202611001' }),
    body: { surveyNo: '202611001', address: 'x' }
  });
  assert.equal(r.action, 'validate');
});
t('F16 其它未核 planType 未主动写配电票种/号 → skip_ticket_rule', () => {
  const stored = { id: 'x1', planType: '', ticketType: L1, workTicketNo: OLD };
  assert.equal(M.classifyPlanTicketEdit({ stored, body: { content: 'x' } }).action, 'skip_ticket_rule');
});
t('F17 其它未核 planType 主动写配电号 → validate', () => {
  const stored = { id: 'x1', planType: '其它' };
  const r = M.classifyPlanTicketEdit({ stored, body: { ticketType: T3, workTicketNo: '2026119801' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T3);
});
t('F18 isPlainObject：{} / 普通对象 / 无原型对象为 true，数组与 Date 为 false', () => {
  assert.equal(M.isPlainObject({}), true);
  assert.equal(M.isPlainObject({ a: 1 }), true);
  assert.equal(M.isPlainObject(Object.create(null)), true);
  assert.equal(M.isPlainObject([]), false);
  assert.equal(M.isPlainObject(new Date()), false);
});

console.log('\n===== 分组结果 =====');
Object.keys(groups).forEach(k => console.log('  ' + k + '：' + groups[k].pass + ' 通过 / ' + groups[k].fail + ' 失败'));
console.log('===== 总计：' + total + ' 项，通过 ' + passed + '，失败 ' + failed + ' =====');
if (failed) process.exit(1);
