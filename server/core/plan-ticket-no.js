/* ========== core/plan-ticket-no ========== */
/* 计划管理优化 r6（2.2 / 2.4.1）取号与共享校验纯模块。
 *
 * 范围（Step 2）：只提供纯函数，不挂路由、不读写 DB、不实现拆分门禁。
 *   - 配电一/二/低压工作票号：YYYYMM + 一位码(6/7/9) + 3 位流水(801–999)，按月按票种独立。
 *   - 历史 11 位旧格式不进新流水；线路 67/77 与无工作票号月计划不套用本模块规则。
 *   - 不实现 classifySplitSurvey / assertCanSplit（后续 Step），不改写勘察取号，
 *     不把材料台账的「删除补缺 / 编号对齐」口径带入本模块。
 *
 * 码表依据：public/js/plan-no.js 的旧码 68 / 78 / 98 首位，压缩为 r6 的一位码 6 / 7 / 9。
 * 新旧码表必须分开——本模块不修改 plan-no.js，前端预填改新格式属 Step 4。
 *
 * 只向下依赖 core/util 的 aliveFilter（存活 = !!rec && !rec.deleted），不反向改调用方。
 */
const { aliveFilter } = require('./util');

/* ---------- 常量（内部使用，不作为契约导出） ---------- */
const DIST_TICKET_CODE = {
  '配电：配电第一种工作票': '6',
  '配电：配电第二种工作票': '7',
  '配电：低压工作票': '9'
};
const SERIAL_MIN = 801;
const SERIAL_MAX = 999;
const LIGHT_PLAN_EDIT_KEYS = ['status', 'planNote'];
const DIST_NO_RE = /^(\d{4})(\d{2})([679])(\d{3})$/;

function str(v) { return v == null ? '' : String(v).trim(); }
function fail(error, message) { return { ok: false, error, message }; }
function codeOf(ticketType) {
  const t = str(ticketType);
  return Object.prototype.hasOwnProperty.call(DIST_TICKET_CODE, t) ? DIST_TICKET_CODE[t] : '';
}
function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

/* ---------- 2.2 票种、解析 ---------- */

/** 仅配电第一种 / 第二种 / 低压为 true；线路 67/77、无工作票号的月计划为 false。 */
function isDistPowerTicketType(ticketType) {
  return hasOwn(DIST_TICKET_CODE, str(ticketType));
}

/** 解析新格式配电工作票号；旧格式 / 号段外 / 非法码走 INVALID_INPUT，不进新流水。 */
function parseDistWorkTicketNo(workTicketNo) {
  const m = DIST_NO_RE.exec(str(workTicketNo));
  if (!m) {
    return fail('INVALID_INPUT',
      '配电工作票号格式不合法：应为 YYYYMM + 一位类型码(6/7/9) + 3 位流水(801–999)，实际：' + (str(workTicketNo) || '(空)'));
  }
  const month = Number(m[2]);
  if (month < 1 || month > 12) return fail('INVALID_INPUT', '配电工作票号月份不合法：' + m[1] + m[2]);
  const serial = Number(m[4]);
  if (serial < SERIAL_MIN || serial > SERIAL_MAX) {
    return fail('INVALID_INPUT', '配电工作票号流水应在 ' + SERIAL_MIN + '–' + SERIAL_MAX + ' 之间，实际：' + m[4]);
  }
  return { ok: true, parsed: { yearMonth: m[1] + m[2], typeCode: m[3], serial } };
}

/* ---------- 2.2 校验 / 分配 ---------- */

/** 存活记录里同年月同票种的新格式最大流水；旧格式、软删、异月异码不计。 */
function maxUsedSerial(records, yearMonth, typeCode) {
  let max = SERIAL_MIN - 1; // 800：无占用时下一个号即 801
  for (const rec of (records || []).filter(aliveFilter())) {
    if (!rec) continue;
    const parsed = parseDistWorkTicketNo(rec.workTicketNo);
    if (!parsed.ok) continue;                       // 历史 11 位等旧格式不进新流水
    const p = parsed.parsed;
    if (p.yearMonth !== yearMonth || p.typeCode !== typeCode) continue;
    if (p.serial > max) max = p.serial;
  }
  return max;
}

function yearMonthLabel(ym) { return ym.slice(0, 4) + '-' + ym.slice(4, 6); }

/** 与存活新格式配电号撞号（排除 excludeIds）或批内重复 → DUPLICATE；不验月份一致性。 */
function assertDistWorkTicketNoAvailable(input) {
  const b = input || {};
  const parsed = parseDistWorkTicketNo(b.workTicketNo);
  if (!parsed.ok) return parsed;
  const code = codeOf(b.ticketType);
  if (!code) return fail('UNSUPPORTED_TICKET_TYPE', '非配电票种不走新格式工作票号校验：' + (str(b.ticketType) || '(空)'));
  if (parsed.parsed.typeCode !== code) {
    return fail('INVALID_INPUT', '工作票号类型码 ' + parsed.parsed.typeCode + ' 与票种「' + str(b.ticketType) + '」不符');
  }
  const no = str(b.workTicketNo);
  const batch = new Set((Array.isArray(b.batchNos) ? b.batchNos : []).map(str));
  if (batch.has(no)) return fail('DUPLICATE', '工作票号与本次批次内其它记录重复：' + no);
  const excluded = new Set(Array.isArray(b.excludeIds) ? b.excludeIds : []);
  for (const rec of (Array.isArray(b.records) ? b.records : []).filter(aliveFilter())) {
    if (!rec) continue;
    if (excluded.has(rec.id)) continue;              // 编辑排除自身 / 拆分排除源计划首日
    const other = parseDistWorkTicketNo(rec.workTicketNo);
    if (!other.ok) continue;                        // 只与存活「新格式」配电号比较
    if (str(rec.workTicketNo) === no) return fail('DUPLICATE', '工作票号已被其它存活记录占用：' + no);
  }
  return { ok: true };
}

/** 单号分配：max(已占用, 800)+1；不补中间空号；软删当前最大可复用；>999 EXHAUSTED。
 *  excludeIds 内记录的号不视为「别人占用」（撞号断言时排除），但其新格式原号仍计入 max 基线，
 *  避免把首日保留的原号再分配给其它新日。 */
function allocateWorkTicketNo(input) {
  const b = input || {};
  if (!isDistPowerTicketType(b.ticketType)) {
    return fail('UNSUPPORTED_TICKET_TYPE', '非配电票种不分配新格式工作票号：' + (str(b.ticketType) || '(空)'));
  }
  const ym = str(b.yearMonth);
  if (!/^\d{6}$/.test(ym) || Number(ym.slice(4, 6)) < 1 || Number(ym.slice(4, 6)) > 12) {
    return fail('INVALID_INPUT', 'yearMonth 应为合法 YYYYMM，实际：' + (ym || '(空)'));
  }
  const code = codeOf(b.ticketType);
  const max = maxUsedSerial(b.records, ym, code);
  const next = max + 1;
  if (next > SERIAL_MAX) {
    return fail('EXHAUSTED',
      yearMonthLabel(ym) + ' 月「' + str(b.ticketType) + '」工作票号 ' + SERIAL_MIN + '–' + SERIAL_MAX + ' 已用完，停止取号');
  }
  return { ok: true, workTicketNo: ym + code + String(next).padStart(3, '0') };
}

/** 批量分配：与 items 等长、互不重复；任一项失败整体失败，不返回部分成功号码列表。 */
function allocateWorkTicketNos(input) {
  const b = input || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const virtual = (Array.isArray(b.records) ? b.records : []).slice();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const r = allocateWorkTicketNo({
      ticketType: it.ticketType,
      yearMonth: it.yearMonth,
      records: virtual,
      excludeIds: b.excludeIds
    });
    if (!r.ok) return r;
    out.push(r.workTicketNo);
    // 本次请求内已分配的号立即占位，保证互不重复（不落库，仅本函数内有效）
    virtual.push({ id: '__alloc_' + i, ticketType: it.ticketType, workTicketNo: r.workTicketNo });
  }
  return { ok: true, workTicketNos: out };
}

/* ---------- 2.4.1 编辑判别（与取号同模块） ---------- */

/** 非 null、非数组的普通对象；{} 是普通对象。 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 业务键 = body 自有可枚举键，全部计入；键集 ⊆ {status, planNote} 为 true。
 *  含 {}、{status}、{planNote}、二者组合；夹带任何其它键（含 workTicketNo）为 false。
 *  不看任何客户端标记 / mode / 按钮名。 */
function isLightPlanEdit(body) {
  if (!isPlainObject(body)) return false;
  return Object.keys(body).every(k => LIGHT_PLAN_EDIT_KEYS.indexOf(k) > -1);
}

/** validate 分支：候选号缺/空/旧格式/码不符 → INVALID_INPUT；否则交调用方做撞号断言。 */
function validateBranch(ticketType, workTicketNo, storedId) {
  const no = str(workTicketNo);
  if (!no) return fail('INVALID_INPUT', '配电计划缺少工作票号，请补合规且不重复的号后再保存');
  const parsed = parseDistWorkTicketNo(no);
  if (!parsed.ok) return parsed;
  if (parsed.parsed.typeCode !== codeOf(ticketType)) {
    return fail('INVALID_INPUT', '工作票号类型码 ' + parsed.parsed.typeCode + ' 与票种「' + str(ticketType) + '」不符');
  }
  return {
    ok: true,
    action: 'validate',
    ticketType: str(ticketType),
    workTicketNo: no,
    excludeIds: storedId ? [storedId] : []
  };
}

/** r6 2.4.1 第 1–6 条：按真实请求体判别；身份以已存 planType/ticketType 为准。
 *  撞号（需要 records）不在本函数内，由调用方用 assertDistWorkTicketNoAvailable 完成。 */
function classifyPlanTicketEdit(input) {
  const b = input || {};
  const stored = isPlainObject(b.stored) ? b.stored : {};
  const body = b.body;

  // 1. body 非普通对象
  if (!isPlainObject(body)) return fail('INVALID_INPUT', '请求体必须是普通对象');
  // 2. 轻操作豁免（只读状态/备注，不因旧号或缺号受阻）
  if (isLightPlanEdit(body)) return { ok: true, action: 'light' };

  const has = k => hasOwn(body, k);
  const storedType = str(stored.ticketType);
  const candidateType = has('ticketType') ? str(body.ticketType) : storedType;
  // cur + body 合并语义：body 带号用请求值，否则用已存值
  const candidateNo = has('workTicketNo') ? str(body.workTicketNo) : str(stored.workTicketNo);
  const wroteTicket = has('workTicketNo') || has('ticketType');
  const planType = str(stored.planType);

  // 3. 身份以已存记录为准；请求 planType 与已存不同一律拒绝，不调用 saveDB
  if (has('planType') && str(body.planType) !== planType) {
    return fail('INVALID_INPUT', '请求 planType 与已存记录不一致，不得借改类型绕过票号校验');
  }

  // 4. 月计划：未主动写票号/票种 → 维持无票号月计划原语义，不新增改号入口
  if (planType === '月计划') {
    if (!wroteTicket || !isDistPowerTicketType(candidateType)) return { ok: true, action: 'skip_ticket_rule' };
    return validateBranch(candidateType, candidateNo, stored.id);
  }

  // 5. 周计划（含单日周记录）：已存配电不得靠改 ticketType 躲开
  if (planType === '周计划') {
    const mustValidate = isDistPowerTicketType(storedType) || isDistPowerTicketType(candidateType);
    if (!mustValidate) return { ok: true, action: 'skip_ticket_rule' };
    // 已存配电时以已存票种为身份基准；已存非配电而请求配电时用候选票种
    const ticketType = isDistPowerTicketType(storedType) ? storedType : candidateType;
    return validateBranch(ticketType, candidateNo, stored.id);
  }

  // 6. 其它未核 planType：不新开规则；主动写入配电票种/号才校验
  if (!wroteTicket || !isDistPowerTicketType(candidateType)) return { ok: true, action: 'skip_ticket_rule' };
  return validateBranch(candidateType, candidateNo, stored.id);
}

module.exports = {
  isDistPowerTicketType,
  parseDistWorkTicketNo,
  allocateWorkTicketNo,
  allocateWorkTicketNos,
  assertDistWorkTicketNoAvailable,
  isPlainObject,
  isLightPlanEdit,
  classifyPlanTicketEdit
};
