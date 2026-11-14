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
 *
 * 2026-11-14 Step 2 修正（用户审阅裁定，覆盖 r6 2.4.1 过宽表述）：
 *  - 修正一：编辑判别按「合并后候选记录」判断，删除「已存配电就必须按原票种校验」口径；合法换票种不是绕过。
 *  - 修正二：候选票种为线路 → skip_ticket_rule，沿用线路既有行为，本轮不新增任何线路服务端编号门禁。
 *  - 修正三：契约字符串字段类型严格性，非字符串只返回 INVALID_INPUT 失败结果，不抛异常。
 *
 * 2026-11-14 Step 2 再修正（用户最新裁定，冲突处以本提示词为准）：
 *  - 再修正一：校验值与返回保存值逐字一致——规范化（trim）后的字符串同时是 parse / 码对应 /
 *    撞号校验的输入与 validate 分支的返回值，禁止「校验 trim 值、返回原值」。
 *  - 再修正二：字段未提供（键不存在）沿用已存值；键显式给出但非字符串（含 null）一律
 *    INVALID_INPUT 失败、不沿用、不抛异常。票种为字符串时非配电字符串（含 '' / 未知票种）
 *    一律 skip_ticket_rule，不新增票种枚举门禁。
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

/* 契约字符串字段严格性（Step 2 修正三 + 再修正二）：
 * - str() 只接受字符串；null/undefined → ''；数字/数组/对象/Symbol → ''，
 *   绝不调用 String(v)，避免 {toString:null} / Object.create(null) / 抛异常的 toString 泄漏 TypeError。
 * - checkStringFields() 用于位置参数与必填入参：undefined 视为「未提供」，其余非字符串（含 null）
 *   一律 INVALID_INPUT 失败结果；绝不把显式 null 当作未提供。
 * - checkProvidedStringFields() 用于请求体 / 已存记录的对象字段：只按「键是否出现」判定，
 *   键未出现 → 不检查、交由合并语义沿用原值；键出现但值非字符串 → INVALID_INPUT。
 * - isLightPlanEdit 仍只按键集判定，不因键值类型改变分类结果。 */
function typeLabel(v) {
  if (Array.isArray(v)) return '数组';
  if (v === null) return 'null';
  return typeof v;
}
function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v.trim() : '';
}
function checkStringFields(pairs) {
  for (const [field, v] of pairs) {
    // undefined = 未提供；null / 数字 / 数组 / 对象 / Symbol 均为显式非法值
    if (v !== undefined && typeof v !== 'string') {
      return fail('INVALID_INPUT', field + ' 应为字符串，实际为 ' + typeLabel(v));
    }
  }
  return null;
}
function fail(error, message) { return { ok: false, error, message }; }
function codeOf(ticketType) {
  const t = str(ticketType);
  return Object.prototype.hasOwnProperty.call(DIST_TICKET_CODE, t) ? DIST_TICKET_CODE[t] : '';
}
function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

/* 再修正二：请求体 / 已存记录的契约字符串字段，按「键是否显式提供」判定。
 * 键不存在、或值为 undefined（等同未提供）→ 不检查、交由合并语义沿用原值；
 * 键出现且值为 null / 数字 / 数组 / 对象等非字符串 → INVALID_INPUT，不沿用、不抛异常。
 * 与 checkStringFields 的「undefined = 未提供」语义一致，不另造一套。 */
function checkProvidedStringFields(obj, keys, label) {
  for (const key of keys) {
    if (!hasOwn(obj, key)) continue;
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') {
      return fail('INVALID_INPUT', label + '.' + key + ' 应为字符串，实际为 ' + typeLabel(v));
    }
  }
  return null;
}

/* 再修正一：票种 / 票号规范化为唯一一份「校验值 == 返回保存值」。
 * parse、码对应、撞号比较与 validate 分支返回值全部引用此结果，杜绝 trim 后校验、原值返回。 */
function normTicketPair(ticketType, workTicketNo) {
  return { ticketType: str(ticketType), workTicketNo: str(workTicketNo) };
}

/* ---------- 2.2 票种、解析 ---------- */

/** 仅配电第一种 / 第二种 / 低压为 true；线路 67/77、无工作票号的月计划为 false。 */
function isDistPowerTicketType(ticketType) {
  return hasOwn(DIST_TICKET_CODE, str(ticketType));
}

/** 解析新格式配电工作票号；旧格式 / 号段外 / 非法码走 INVALID_INPUT，不进新流水。 */
function parseDistWorkTicketNo(workTicketNo) {
  const bad = checkStringFields([['workTicketNo', workTicketNo]]);
  if (bad) return bad;
  const no = str(workTicketNo);
  const m = DIST_NO_RE.exec(no);
  if (!m) {
    return fail('INVALID_INPUT',
      '配电工作票号格式不合法：应为 YYYYMM + 一位类型码(6/7/9) + 3 位流水(801–999)，实际：' + (no || '(空)'));
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
  for (const rec of (Array.isArray(records) ? records : []).filter(aliveFilter())) {
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
  const bad = checkStringFields([['workTicketNo', b.workTicketNo], ['ticketType', b.ticketType]]);
  if (bad) return bad;
  const norm = normTicketPair(b.ticketType, b.workTicketNo);
  const no = norm.workTicketNo;
  const typeStr = norm.ticketType;
  const parsed = parseDistWorkTicketNo(no);
  if (!parsed.ok) return parsed;
  const code = codeOf(typeStr);
  if (!code) return fail('UNSUPPORTED_TICKET_TYPE', '非配电票种不走新格式工作票号校验：' + (typeStr || '(空)'));
  if (parsed.parsed.typeCode !== code) {
    return fail('INVALID_INPUT', '工作票号类型码 ' + parsed.parsed.typeCode + ' 与票种「' + typeStr + '」不符');
  }
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
  const bad = checkStringFields([['ticketType', b.ticketType], ['yearMonth', b.yearMonth]]);
  if (bad) return bad;
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

/** 批量分配：与 items 等长、互不重复；任一项失败整体失败，不返回部分成功号码列表。
 *  每项的 ticketType / yearMonth 类型严格性由 allocateWorkTicketNo 逐项落实，不另写一套。 */
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

/** validate 分支：候选号缺/空/旧格式/码不符 → INVALID_INPUT；否则交调用方做撞号断言。
 *  返回的 ticketType / workTicketNo 即被校验通过的规范化字符串（再修正一）。 */
function validateBranch(ticketType, workTicketNo, storedId) {
  const norm = normTicketPair(ticketType, workTicketNo);
  const no = norm.workTicketNo;
  const typeStr = norm.ticketType;
  if (!no) return fail('INVALID_INPUT', '配电计划缺少工作票号，请补合规且不重复的号后再保存');
  const parsed = parseDistWorkTicketNo(no);
  if (!parsed.ok) return parsed;
  if (parsed.parsed.typeCode !== codeOf(typeStr)) {
    return fail('INVALID_INPUT', '工作票号类型码 ' + parsed.parsed.typeCode + ' 与票种「' + typeStr + '」不符');
  }
  return {
    ok: true,
    action: 'validate',
    ticketType: typeStr,   // 与 assertDistWorkTicketNoAvailable 校验的字符串逐字相同
    workTicketNo: no,      // 被校验通过的规范化字符串，供调用方保存
    excludeIds: storedId ? [storedId] : []
  };
}

/** r6 2.4.1 第 1–6 条（按 2026-11-14 修正一/二调整）：按真实请求体判别；
 *  planType 身份仍以已存记录为准，票种与票号一律按「合并后候选记录」判断。
 *  撞号（需要 records）不在本函数内，由调用方持 excludeIds 用 assertDistWorkTicketNoAvailable 完成。 */
function classifyPlanTicketEdit(input) {
  const b = input || {};
  const stored = isPlainObject(b.stored) ? b.stored : {};
  const body = b.body;

  // 1. body 非普通对象
  if (!isPlainObject(body)) return fail('INVALID_INPUT', '请求体必须是普通对象');
  // 2. 轻操作豁免（只看键集，不因键值类型改变分类；类型严格性不扩围到本分支）
  if (isLightPlanEdit(body)) return { ok: true, action: 'light' };
  // 2a. 类型严格性守卫（修正三 + 再修正二）：只按「键是否显式提供」判定，
  //     键未提供不检查（沿用已存原值）；键出现但非字符串（含显式 null）→ INVALID_INPUT。
  const CONTRACT_FIELDS = ['planType', 'ticketType', 'workTicketNo'];
  const bad = checkProvidedStringFields(stored, CONTRACT_FIELDS, 'stored')
    || checkProvidedStringFields(body, CONTRACT_FIELDS, 'body');
  if (bad) return bad;

  // 「字段已提供」统一口径：键存在且值不为 undefined；与 checkProvidedStringFields 一致，
  // 避免「类型检查放行、候选取值却用 undefined 覆盖原值」的分叉。
  const has = k => hasOwn(body, k) && body[k] !== undefined;
  const storedType = str(stored.ticketType);
  const candidateType = has('ticketType') ? str(body.ticketType) : storedType;
  // cur + body 合并语义：body 带号用请求值，否则用已存值
  const candidateNo = has('workTicketNo') ? str(body.workTicketNo) : str(stored.workTicketNo);
  const wroteTicket = has('workTicketNo') || has('ticketType');
  const planType = str(stored.planType);

  // 3. 身份以已存记录为准：显式提供 planType 时须与已存原始字符串逐字一致（不 trim/规范化）；
  //    未提供或为 undefined → 沿用已存值。显式 null/数字/数组/对象由 2a 的
  //    checkProvidedStringFields 守卫先拦（仍为 INVALID_INPUT，不因本补修沿用或放行）。
  //    本守卫位于下面全部分流（月计划 / 周计划 / 其它）之前，skip 路径同样不能绕过。
  if (has('planType') && body.planType !== stored.planType) {
    return fail('INVALID_INPUT', '请求 planType 与已存记录不一致（须逐字一致），不得借改类型绕过票号校验');
  }

  // 4. 月计划：未主动写票号/票种 → 维持无票号月计划原语义，不新增改号入口
  if (planType === '月计划') {
    if (!wroteTicket || !isDistPowerTicketType(candidateType)) return { ok: true, action: 'skip_ticket_rule' };
    return validateBranch(candidateType, candidateNo, stored.id);
  }

  // 5. 周计划（含单日周记录）：按「合并后候选记录」判断（2026-11-14 修正一 / 修正二）
  //    候选为配电 → 以候选票种校验候选号；候选为线路（或非配电）→ 退出配电专用校验，
  //    沿用线路既有行为，不新增线路服务端编号门禁。合法换票种不是绕过。
  if (planType === '周计划') {
    if (!isDistPowerTicketType(candidateType)) return { ok: true, action: 'skip_ticket_rule' };
    return validateBranch(candidateType, candidateNo, stored.id);
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
