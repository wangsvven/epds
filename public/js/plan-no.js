/* 计划编号规则（纯函数，无 Vue/无 DOM 依赖）：前端页面与冒烟脚本共用同一套算法。
   - 勘察编号 = 4 位年 + 2 位月 + 3 位流水（如 202610013），流水按月一条线，从 001 起
   - 工作票编号 = 4 位年 + 2 位月 + 2 位类型码 + 3 位流水（如 20261068001）【线路票种沿用】
   - 工作票流水按「工作票类型」各记各的：同类型共一条流水线，同码不同类型也互不相干
   - 统计范围由调用方传入的计划数组决定（前端传 GET /api/workPlans 的全部记录，不按页签/筛选/分页）
   说明：编号只做「取最大 +1」，不与已删除记录的号码比对（软删除记录不在 GET 返回中，若删除过计划，
   其占用过的流水号存在被复用的可能）。
   2026-11-14 Step 4：配电三类（配电第一种/第二种/低压）预填改走新格式
   YYYYMM + 一位类型码(6/7/9) + 3 位流水(801–999)——nextTicketNo 的旧口径保持不变
   （线路 67/77 与冒烟既有断言不受影响），新增函数与统一分流入口见文件尾部。 */
(function (root) {
  // 工作票类型（下拉/筛选共用这一份，勿在别处另写）
  const TICKET_TYPES = [
    '配电：配电第一种工作票',
    '配电：配电第二种工作票',
    '配电：低压工作票',
    '线路：线路第一种工作票',
    '线路：线路第二种工作票'
  ];
  // 类型码：与 TICKET_TYPES 一一对应
  const TICKET_NO_CODE = {
    '配电：配电第一种工作票': '68',
    '配电：配电第二种工作票': '78',
    '配电：低压工作票': '98',
    '线路：线路第一种工作票': '67',
    '线路：线路第二种工作票': '77'
  };

  const pad2 = n => String(n).padStart(2, '0');
  const pad3 = n => String(n).padStart(3, '0');

  // 年月（4 位年 + 2 位月），按给定日期取，默认取当天
  function ymOf(d) {
    const t = d instanceof Date ? d : (window.ServerTime ? window.ServerTime.now() : new Date());
    return t.getFullYear() + pad2(t.getMonth() + 1);
  }

  // 取某条记录里的编号字符串（去空白）
  function noOf(rec, key) {
    if (!rec) return '';
    const v = rec[key];
    return v == null ? '' : String(v).trim();
  }

  // 下一个勘察编号：当月已有勘察编号中最大的 3 位流水 +1（跨月自然归零到 001）
  function nextSurveyNo(plans, ym) {
    const y = String(ym || ymOf());
    const re = new RegExp('^' + y + '(\\d{3})$');
    let max = 0;
    (plans || []).forEach(p => {
      const m = noOf(p, 'surveyNo').match(re);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return y + pad3(Math.min(max + 1, 999));
  }

  // 下一个工作票编号：只看「ticketType 完全相同」的记录，取其编号中「年月 + 该类型码 + 3 位流水」的最大值 +1
  function nextTicketNo(plans, ym, ticketType) {
    const y = String(ym || ymOf());
    const code = TICKET_NO_CODE[ticketType];
    if (!code) return y;            // 映射表外的类型：兜底，只带年月（旧行为）
    const re = new RegExp('^' + y + code + '(\\d{3})$');
    let max = 0;
    (plans || []).forEach(p => {
      if (!p || p.ticketType !== ticketType) return;
      const m = noOf(p, 'workTicketNo').match(re);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return y + code + pad3(Math.min(max + 1, 999));
  }

  // ===== Step 4（r6 2.2）：配电三类新格式预填 =====
  // 一位类型码表，与 server/core/plan-ticket-no.js 的 DIST_TICKET_CODE 同口径（旧码 68/78/98 压缩为 6/7/9）
  const DIST_TICKET_CODE = {
    '配电：配电第一种工作票': '6',
    '配电：配电第二种工作票': '7',
    '配电：低压工作票': '9'
  };
  const DIST_SERIAL_MIN = 801;
  const DIST_SERIAL_MAX = 999;

  // 是否配电三类票种（trim 后查码表；非字符串一律 false，与服务端 isDistPowerTicketType 一致）
  function isDistPowerTicketType(ticketType) {
    if (typeof ticketType !== 'string') return false;
    return Object.prototype.hasOwnProperty.call(DIST_TICKET_CODE, ticketType.trim());
  }

  // 配电新格式预填：存活记录中「同年月 + 该票种一位码」的新格式号取 max+1。
  // - 旧 11 位不计入（正则锚定 10 位新格式，服务端 parseDistWorkTicketNo 同口径）
  // - 非字符串票号（数字 / 数组 / 对象 / null 等）直接跳过不计入，不做 String() 强转（2026-11-15 修正）
  // - 不补中间空号；软删记录不占号（GET 不返回，且 deleted 显式排除）
  // - 流水超 999 → 返回 null（耗尽）：由调用方明确提示，不生成 1000、不扩位、不跨月借号；
  //   预填只是手改起点，最终由服务端校验兜底（auto 服务端重算 / manual 服务端校验）
  function nextDistTicketNo(plans, ym, ticketType) {
    const code = isDistPowerTicketType(ticketType) ? DIST_TICKET_CODE[ticketType.trim()] : '';
    if (!code) return null;
    const y = String(ym || ymOf());
    const re = new RegExp('^' + y + code + '(\\d{3})$');
    let max = DIST_SERIAL_MIN - 1;   // 800：无占用时下一个号即 801（与服务端 allocateWorkTicketNo 同基线）
    (plans || []).forEach(p => {
      if (!p || p.deleted) return;
      // 2026-11-15 修正：号池逐条先判类型——非字符串票号（数字 / 数组 / 对象 / null 等）跳过不计入。
      // 与 server/core/plan-ticket-no.js 的 parseDistWorkTicketNo（非字符串 → INVALID_INPUT、不进新流水）同口径；
      // 不做 String() 强转，避免数字票号被误当新格式号占号或误判耗尽。
      if (typeof p.workTicketNo !== 'string') return;
      const m = p.workTicketNo.trim().match(re);
      if (m) max = Math.max(max, Number(m[1]));
    });
    const next = max + 1;
    return next > DIST_SERIAL_MAX ? null : y + code + pad3(next);
  }

  // 创建/预填统一入口（Step 4）：配电三类走新格式 nextDistTicketNo；
  // 线路与其余类型沿用既有 nextTicketNo 口径（含映射表外兜底），旧行为零改动。
  function prefillTicketNo(plans, ym, ticketType) {
    return isDistPowerTicketType(ticketType)
      ? nextDistTicketNo(plans, ym, ticketType)
      : nextTicketNo(plans, ym, ticketType);
  }

  root.PlanNo = {
    TICKET_TYPES, TICKET_NO_CODE,
    DIST_TICKET_CODE, DIST_SERIAL_MIN, DIST_SERIAL_MAX,
    isDistPowerTicketType, nextDistTicketNo, prefillTicketNo,
    ymOf, nextSurveyNo, nextTicketNo
  };
})(typeof window !== 'undefined' ? window : this);
