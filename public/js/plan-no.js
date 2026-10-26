/* 计划编号规则（纯函数，无 Vue/无 DOM 依赖）：前端页面与冒烟脚本共用同一套算法。
   - 勘察编号 = 4 位年 + 2 位月 + 3 位流水（如 202610013），流水按月一条线，从 001 起
   - 工作票编号 = 4 位年 + 2 位月 + 2 位类型码 + 3 位流水（如 20261068001）
   - 工作票流水按「工作票类型」各记各的：同类型共一条流水线，同码不同类型也互不相干
   - 统计范围由调用方传入的计划数组决定（前端传 GET /api/workPlans 的全部记录，不按页签/筛选/分页）
   说明：编号只做「取最大 +1」，不与已删除记录的号码比对（软删除记录不在 GET 返回中，若删除过计划，
   其占用过的流水号存在被复用的可能）。 */
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
    const t = d instanceof Date ? d : new Date();
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

  root.PlanNo = { TICKET_TYPES, TICKET_NO_CODE, ymOf, nextSurveyNo, nextTicketNo };
})(typeof window !== 'undefined' ? window : this);
