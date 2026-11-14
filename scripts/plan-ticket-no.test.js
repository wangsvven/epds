/* ========== scripts/plan-ticket-no.test.js ========== */
/* Step 2 单测：core/plan-ticket-no.js 的 r6 2.2 / 2.4.1 纯函数。
 * node 直接运行：node scripts/plan-ticket-no.test.js
 * 不启服务、不连生产库、不写任何数据；独立计数，不与 scripts/smoke.js 的 169 混报。
 * 2026-11-14 Step 2 修正：F12 改按候选口径；新增 G 换票种、H 类型严格性、I 源号最大值回归。
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
const N802 = '2026116802';            // 新格式：202611 + 6 + 802
const N7 = '2026117801';               // 新格式第二种：202611 + 7 + 801
const N9 = '2026119801';               // 新格式低压：202611 + 9 + 801
const LINE_OLD = '20261167001';        // 线路旧 11 位（67 + 001）

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
t('F12 已存配电改票种为线路 → 按候选口径退出配电校验（skip_ticket_rule）', () => {
  // 旧断言（已废止）：assert.equal(r.action, 'validate'); assert.equal(r.ticketType, T1);
  // 修正一/二：候选票种为线路 → 退出配电专用校验，合法换票种不是绕过；不再按已存原票种校验
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: L1, address: 'x' } });
  assert.deepEqual(r, { ok: true, action: 'skip_ticket_rule' });
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

g('G 换票种：合并后候选口径（修正一 / 修正二）');
t('G1 配电第一种 → 第二种 + 7 码号：按候选种校验并返回候选种', () => {
  const r = M.classifyPlanTicketEdit({
    stored: storedWeek(), body: { ticketType: T2, workTicketNo: N7 }
  });
  assert.equal(r.ok, true);
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T2);
  assert.equal(r.workTicketNo, N7);
  assert.deepEqual(r.excludeIds, ['w1']);
});
t('G2 配电第一种 → 第二种但仍用 6 码旧号 → INVALID_INPUT', () => {
  const r = M.classifyPlanTicketEdit({
    stored: storedWeek(), body: { ticketType: T2, workTicketNo: N801 }
  });
  assert.equal(r.error, 'INVALID_INPUT');
  assert.match(r.message, /类型码 6/);
});
t('G3 只换票种不带号：候选号按合并语义取已存 6 码号 → INVALID_INPUT', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: T2 } });
  assert.equal(r.error, 'INVALID_INPUT');
});
t('G4 配电 → 线路第二种 → skip_ticket_rule', () => {
  assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: L2 } }),
    { ok: true, action: 'skip_ticket_rule' });
});
t('G5 配电 → 线路且带 11 位线路旧号：仍 skip，绝不校验线路号', () => {
  assert.deepEqual(M.classifyPlanTicketEdit({
    stored: storedWeek(), body: { ticketType: L1, workTicketNo: LINE_OLD }
  }), { ok: true, action: 'skip_ticket_rule' });
});
t('G6 线路 → 配电（不带号）：线路旧号对配电 parse 失败 → INVALID_INPUT', () => {
  const stored = { id: 'l1', planType: '周计划', ticketType: L1, workTicketNo: LINE_OLD };
  assert.equal(M.classifyPlanTicketEdit({ stored, body: { ticketType: T1, address: 'x' } }).error, 'INVALID_INPUT');
});
t('G7 线路 → 配电 + 合规配电号 → validate（此向原有，不变）', () => {
  const stored = { id: 'l1', planType: '周计划', ticketType: L1, workTicketNo: LINE_OLD };
  const r = M.classifyPlanTicketEdit({ stored, body: { ticketType: T1, workTicketNo: N801 } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T1);
  assert.equal(r.workTicketNo, N801);
});
t('G8 候选为配电且候选号显式为空 → INVALID_INPUT（按候选取值，不按已存原号）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { workTicketNo: '' } });
  assert.equal(r.error, 'INVALID_INPUT');
});
t('G9 合法换票种链路：classify → assert 用候选种校验通过（排除自身）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: T2, workTicketNo: N7 } });
  assert.deepEqual(M.assertDistWorkTicketNoAvailable({
    workTicketNo: r.workTicketNo, ticketType: r.ticketType,
    records: [rec('w1', N7, { ticketType: T2 })], excludeIds: r.excludeIds
  }), { ok: true });
});
t('G10 合法换票种链路：候选号撞别人 → DUPLICATE', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: T2, workTicketNo: N7 } });
  assert.equal(M.assertDistWorkTicketNoAvailable({
    workTicketNo: r.workTicketNo, ticketType: r.ticketType,
    records: [rec('other', N7, { ticketType: T2 })]
  }).error, 'DUPLICATE');
});
t('G11 不变项：请求 planType 与已存不同仍 INVALID_INPUT', () => {
  assert.equal(M.classifyPlanTicketEdit({
    stored: storedWeek(), body: { planType: '月计划', ticketType: T2, workTicketNo: N7 }
  }).error, 'INVALID_INPUT');
});
t('G12 不变项：轻操作不受候选口径影响', () => {
  assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { status: '已执行' } }),
    { ok: true, action: 'light' });
});

g('H 契约字符串字段类型严格性（修正三：只失败、不抛异常）');
const BAD = [
  ['数字', 123], ['数组', ['2026116801']], ['对象', { a: 1 }],
  ['toString:null', { toString: null }], ['无原型对象', Object.create(null)],
  ['Symbol', Symbol('s')], ['布尔', true]
];
const expectFail = (name, fn) => t(name, () => {
  const r = fn();
  assert.equal(r.ok, false, '应返回失败结果');
  assert.equal(r.error, 'INVALID_INPUT');
  assert.equal(typeof r.message, 'string');
});
t('H1 parseDistWorkTicketNo 各类非字符串 → INVALID_INPUT 且不抛', () => {
  BAD.forEach(([label, v]) => {
    let r;
    assert.doesNotThrow(() => { r = M.parseDistWorkTicketNo(v); }, 'parse ' + label + ' 不应抛异常');
    assert.equal(r.error, 'INVALID_INPUT', label);
  });
});
t('H2 抛异常的 toString/valueOf 对象：四个函数均不抛且返回失败', () => {
  const evil = { toString() { throw new Error('bad'); }, valueOf() { throw new Error('bad2'); } };
  const calls = [
    () => M.parseDistWorkTicketNo(evil),
    () => M.allocateWorkTicketNo({ ticketType: evil, yearMonth: '202611', records: [] }),
    () => M.allocateWorkTicketNos({ items: [{ ticketType: evil, yearMonth: '202611' }], records: [] }),
    () => M.assertDistWorkTicketNoAvailable({ workTicketNo: evil, ticketType: T1, records: [] }),
    () => M.classifyPlanTicketEdit({ stored: storedWeek(), body: { planType: evil } })
  ];
  calls.forEach((fn, i) => {
    let r;
    assert.doesNotThrow(() => { r = fn(); }, '调用 ' + i + ' 不应抛异常');
    assert.equal(r.error, 'INVALID_INPUT', '调用 ' + i);
  });
  assert.equal(M.isDistPowerTicketType(evil), false, 'isDistPowerTicketType 对异常对象返回 false 且不抛');
});
expectFail('H3 allocateWorkTicketNo: ticketType 非字符串 → INVALID_INPUT',
  () => M.allocateWorkTicketNo({ ticketType: ['配电：配电第一种工作票'], yearMonth: '202611', records: [] }));
expectFail('H4 allocateWorkTicketNo: yearMonth 数字 → INVALID_INPUT',
  () => M.allocateWorkTicketNo({ ticketType: T1, yearMonth: 202611, records: [] }));
expectFail('H5 allocateWorkTicketNo: yearMonth 数组/对象 → INVALID_INPUT',
  () => M.allocateWorkTicketNo({ ticketType: T1, yearMonth: ['202611'], records: [] }));
expectFail('H6 allocateWorkTicketNos: 任一项 ticketType 异常 → 整体失败、不给部分结果',
  () => M.allocateWorkTicketNos({
    items: [{ ticketType: T1, yearMonth: '202611' }, { ticketType: 7, yearMonth: '202611' }], records: []
  }));
t('H7 allocateWorkTicketNos 整体失败时不返回号码列表', () => {
  const r = M.allocateWorkTicketNos({
    items: [{ ticketType: T1, yearMonth: '202611' }, { ticketType: T1, yearMonth: { bad: 1 } }], records: []
  });
  assert.equal(r.ok, false);
  assert.equal(r.workTicketNos, undefined);
});
expectFail('H8 assertDistWorkTicketNoAvailable: workTicketNo 数组 → INVALID_INPUT',
  () => M.assertDistWorkTicketNoAvailable({ workTicketNo: [N801], ticketType: T1, records: [] }));
expectFail('H9 assertDistWorkTicketNoAvailable: ticketType 对象 → INVALID_INPUT',
  () => M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: { x: 1 }, records: [] }));
expectFail('H10 classifyPlanTicketEdit: body.planType 数组 → INVALID_INPUT（审阅问题 3）',
  () => M.classifyPlanTicketEdit({ stored: storedWeek(), body: { planType: ['周计划'], address: 'x' } }));
expectFail('H11 classifyPlanTicketEdit: body.ticketType 数组 → INVALID_INPUT',
  () => M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: [T2], workTicketNo: N7 } }));
expectFail('H12 classifyPlanTicketEdit: body.workTicketNo 数组 → INVALID_INPUT',
  () => M.classifyPlanTicketEdit({ stored: storedWeek(), body: { workTicketNo: [N801] } }));
expectFail('H13 classifyPlanTicketEdit: stored 身份/票号字段异常 → INVALID_INPUT',
  () => M.classifyPlanTicketEdit({
    stored: { id: 'w1', planType: '周计划', ticketType: T1, workTicketNo: [N801] }, body: { address: 'x' }
  }));
t('H14 身份字段数组不再被字符串化放行（合并落库仍是数组）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { planType: ['周计划'], workTicketNo: N801 } });
  assert.equal(r.ok, false);
  assert.equal(r.action, undefined);
});
t('H15 轻操作分类不因键值类型改变（只按键集）', () => {
  assert.equal(M.isLightPlanEdit({ status: ['已执行'] }), true);
  assert.equal(M.isLightPlanEdit({ planNote: { x: 1 } }), true);
  assert.equal(M.isLightPlanEdit({ status: 1, planNote: null }), true);
  assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { status: ['已执行'] } }),
    { ok: true, action: 'light' });
});
t('H16 records / batchNos / excludeIds 内含异常值不抛异常', () => {
  const evil = { toString: null };
  assert.doesNotThrow(() => M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records: [null, { workTicketNo: evil }, evil] }));
  assert.doesNotThrow(() => M.assertDistWorkTicketNoAvailable({
    workTicketNo: N801, ticketType: T1, records: [{ workTicketNo: evil }], batchNos: [evil], excludeIds: [evil]
  }));
});
t('H17 合法字符串入参全部照常工作（严格性不误伤）', () => {
  assert.equal(M.parseDistWorkTicketNo(N801).ok, true);
  assert.equal(M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records: [] }).workTicketNo, N801);
  assert.equal(M.assertDistWorkTicketNoAvailable({ workTicketNo: N802, ticketType: T1, records: [] }).ok, true);
  assert.equal(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { address: 'x' } }).action, 'validate');
});

g('I 源号最大值回归（拆分源计划 / 首日保留 + excludeIds）');
t('I1 源计划号计入 max 基线、保留号不被再分配、新分配为真实占用 max+1', () => {
  const records = [
    Object.assign(rec('src', '2026116801'), { splitBatchId: 'sp1', parentPlanId: '' }),  // 首日保留原号
    Object.assign(rec('day2', '2026116805'), { splitBatchId: 'sp1', parentPlanId: 'src' }),
    rec('other', '2026116806')
  ];
  const r = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records, excludeIds: ['src'] });
  assert.equal(r.workTicketNo, '2026116807', '真实 max=806 → 807');
  assert.notEqual(r.workTicketNo, '2026116801', '首日保留号不得再分配');
});
t('I2 源计划号是当前最大时，excludeIds 后仍按 max+1 不回补空号', () => {
  const records = [
    Object.assign(rec('src', '2026116810'), { splitBatchId: 'sp1', parentPlanId: '' }),
    rec('other', '2026116802')
  ];
  const r = M.allocateWorkTicketNo({ ticketType: T1, yearMonth: '202611', records, excludeIds: ['src'] });
  assert.equal(r.workTicketNo, '2026116811');
});
t('I3 撞号断言：excludeIds 排除源计划自身号不误报，不排除则 DUPLICATE', () => {
  const records = [Object.assign(rec('src', N801), { splitBatchId: 'sp1' })];
  assert.deepEqual(M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T1, records, excludeIds: ['src'] }), { ok: true });
  assert.equal(M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: T1, records }).error, 'DUPLICATE');
});
t('I4 批量分配配合 excludeIds：首日保留号不被再分配、各新日互不重复', () => {
  const records = [
    Object.assign(rec('src', N801), { splitBatchId: 'sp1', parentPlanId: '' }),
    rec('other', '2026116803')
  ];
  const r = M.allocateWorkTicketNos({
    items: [{ ticketType: T1, yearMonth: '202611' }, { ticketType: T1, yearMonth: '202611' }],
    records, excludeIds: ['src']
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.workTicketNos, ['2026116804', '2026116805']);
  assert.ok(!r.workTicketNos.includes(N801));
});

g('J 再修正一：校验值与返回保存值逐字一致');
t('J1 票号带首尾空白 → 决策返回 trim 后的值', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { workTicketNo: '  2026116801  ' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.workTicketNo, N801);
  assert.equal(r.ticketType, T1);
});
t('J2 票种带首尾空白 → 决策返回 trim 后的票种', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: '  ' + T1 + '  ' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T1);
});
t('J3 票号与票种同时带空白（tab/换行）→ 返回值全部规范化', () => {
  const r = M.classifyPlanTicketEdit({
    stored: storedWeek(),
    body: { ticketType: '\t' + T2 + '\n', workTicketNo: '  2026117801\t' }
  });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T2);
  assert.equal(r.workTicketNo, N7);
});
t('J4 多组空白组合：不存在「校验值 ≠ 返回保存值」的路径', () => {
  const pairs = [
    [N801, T1, '  2026116801  ', ' ' + T1 + ' '],
    [N802, T1, '\n2026116802\t', T1],
    [N7, T2, ' 2026117801 ', ' ' + T2 + '  '],
    [N9, T3, '  2026119801  ', '  ' + T3 + '\t']
  ];
  pairs.forEach(([wantNo, wantType, rawNo, rawType]) => {
    const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: rawType, workTicketNo: rawNo } });
    assert.equal(r.action, 'validate');
    assert.equal(r.workTicketNo, wantNo, '返回值应为被校验通过的规范化号');
    assert.equal(r.ticketType, wantType, '返回值应为被校验通过的规范化票种');
    // 返回值本身已规范化：再次 trim 幂等，且与 parse / assert 校验的是同一个字符串
    assert.equal(r.workTicketNo, r.workTicketNo.trim());
    assert.equal(r.ticketType, r.ticketType.trim());
    assert.equal(M.parseDistWorkTicketNo(r.workTicketNo).ok, true);
    assert.deepEqual(M.assertDistWorkTicketNoAvailable({
      workTicketNo: r.workTicketNo, ticketType: r.ticketType, records: [], excludeIds: r.excludeIds
    }), { ok: true });
  });
});
t('J5 stored 沿用的原值带空白 → 返回值仍是规范化后的值', () => {
  const stored = { id: 'w1', planType: '周计划', ticketType: '  ' + T1 + ' ', workTicketNo: ' 2026116802 ' };
  const r = M.classifyPlanTicketEdit({ stored, body: { address: 'x' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.workTicketNo, N802);
  assert.equal(r.ticketType, T1);
});
t('J6 assert 侧同样以规范化值校验：带空白票号不误判 DUPLICATE', () => {
  const r = M.assertDistWorkTicketNoAvailable({
    workTicketNo: '  2026116801  ', ticketType: T1, records: [rec('b', N801)]
  });
  assert.equal(r.error, 'DUPLICATE');
  assert.deepEqual(M.assertDistWorkTicketNoAvailable({
    workTicketNo: ' 2026116801 ', ticketType: ' ' + T1 + ' ', records: []
  }), { ok: true });
});

g('K 再修正二：未提供沿用原值 / 显式非字符串安全失败');
t('K1 字段未提供 → 沿用已存原值（合并语义不变）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { address: 'x' } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T1);
  assert.equal(r.workTicketNo, N801);
});
t('K2 仅未提供票种、显式给出票号 → 沿用已存票种', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { workTicketNo: N802 } });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T1);
  assert.equal(r.workTicketNo, N802);
});
t('K3 ticketType: null → INVALID_INPUT（不得当作未提供或 skip）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: null } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_INPUT');
  assert.match(r.message, /ticketType/);
});
t('K4 候选配电 + 候选号显式 null → INVALID_INPUT（不是沿用、不是缺号沿用）', () => {
  const r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { workTicketNo: null } });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'INVALID_INPUT');
  assert.match(r.message, /workTicketNo/);
});
t('K5 ticketType 显式数字/数组/对象 → 全部安全失败、不抛异常', () => {
  [7, [T2], { a: 1 }, { toString: null }, Symbol('s'), true].forEach(v => {
    let r;
    assert.doesNotThrow(() => { r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: v } }); }, 'ticketType 不应抛');
    assert.equal(r.error, 'INVALID_INPUT');
  });
});
t('K6 workTicketNo 显式数字/数组/对象 → 全部安全失败、不抛异常', () => {
  [123, [N801], { a: 1 }, { toString: null }, Symbol('s'), false].forEach(v => {
    let r;
    assert.doesNotThrow(() => { r = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { workTicketNo: v } }); }, 'workTicketNo 不应抛');
    assert.equal(r.error, 'INVALID_INPUT');
  });
});
t('K7 ticketType: 空字符串 → skip_ticket_rule（不报 INVALID_INPUT）', () => {
  assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: '' } }),
    { ok: true, action: 'skip_ticket_rule' });
});
t('K8 ticketType: 未知票种字符串 → skip_ticket_rule（不新增票种枚举门禁）', () => {
  ['未知票种', '带电作业工作票', '随便写的'].forEach(v => {
    assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: v } }),
      { ok: true, action: 'skip_ticket_rule' }, v);
  });
});
t('K9 对照分明：null 失败、空字符串 skip（不得混同）', () => {
  const a = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: null } });
  const b = M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: '' } });
  assert.equal(a.error, 'INVALID_INPUT');
  assert.equal(b.action, 'skip_ticket_rule');
  assert.notDeepEqual(a, b);
});
t('K10 parse / assert / allocate 显式 null → INVALID_INPUT 且不抛异常', () => {
  const calls = [
    () => M.parseDistWorkTicketNo(null),
    () => M.assertDistWorkTicketNoAvailable({ workTicketNo: null, ticketType: T1, records: [] }),
    () => M.assertDistWorkTicketNoAvailable({ workTicketNo: N801, ticketType: null, records: [] }),
    () => M.allocateWorkTicketNo({ ticketType: null, yearMonth: '202611', records: [] }),
    () => M.allocateWorkTicketNo({ ticketType: T1, yearMonth: null, records: [] })
  ];
  calls.forEach((fn, i) => {
    let r;
    assert.doesNotThrow(() => { r = fn(); }, '调用 ' + i + ' 不应抛异常');
    assert.equal(r.error, 'INVALID_INPUT', '调用 ' + i);
  });
});
t('K11 值为 undefined 等同未提供 → 沿用原值、不抛异常', () => {
  const r = M.classifyPlanTicketEdit({
    stored: storedWeek(), body: { ticketType: undefined, workTicketNo: undefined, address: 'x' }
  });
  assert.equal(r.action, 'validate');
  assert.equal(r.ticketType, T1);
  assert.equal(r.workTicketNo, N801);
});
t('K12 stored 字段显式 null → 安全失败不抛异常', () => {
  const stored = { id: 'w1', planType: '周计划', ticketType: T1, workTicketNo: null };
  let r;
  assert.doesNotThrow(() => { r = M.classifyPlanTicketEdit({ stored, body: { address: 'x' } }); });
  assert.equal(r.error, 'INVALID_INPUT');
});
t('K13 轻操作分类不受影响（仍只按键集）', () => {
  assert.equal(M.isLightPlanEdit({ status: null }), true);
  assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { planNote: 123 } }),
    { ok: true, action: 'light' });
});
t('K14 线路 / 空 / 未知票种字符串一律 skip，不新增服务端门禁', () => {
  [L1, L2, '', '未知票种'].forEach(v => {
    assert.deepEqual(M.classifyPlanTicketEdit({ stored: storedWeek(), body: { ticketType: v, workTicketNo: LINE_OLD } }),
      { ok: true, action: 'skip_ticket_rule' }, v);
  });
});

console.log('\n===== 分组结果 =====');
Object.keys(groups).forEach(k => console.log('  ' + k + '：' + groups[k].pass + ' 通过 / ' + groups[k].fail + ' 失败'));
console.log('===== 总计：' + total + ' 项，通过 ' + passed + '，失败 ' + failed + ' =====');
if (failed) process.exit(1);
