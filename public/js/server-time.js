/* ========== js/server-time ========== */
/* 服务器时间基准：北京时间（UTC+8），唯一时间源。
 * 目的：计划时间、编号年月、到货日期、默认值等一律以服务器时间为准，客户端本机时间改错或时区错乱都不影响。
 *
 * 用法：把代码里的 new Date()（取「现在」的地方）换成 ServerTime.now()。
 * ServerTime.now() 返回 Date 子类：
 *   - 毫秒值 = 真实 UTC 毫秒（可直接传接口 / 参与运算）
 *   - getFullYear / getMonth / getDate / getDay / getHours / getMinutes / getSeconds 一律按 UTC+8 计算
 *   - isNaN(new Date(x)) 之类不受影响，instanceof Date 仍为 true
 * 因此即使客户端时区不是东八区，取到的「今天 / 几点」也是北京时间。
 *
 * 校准时机：首屏用 /api/public-config 下发的 serverTs 校准；之后每 10 分钟、以及标签页重新可见时用
 * /api/server-time 复核一次（补上时钟漂移）。校准完成后派发 server-time-synced 事件。
 */
(function () {
  var TZ_MIN = 480;                 // 北京时间相对 UTC 的分钟数
  var offset = 0;                   // 服务器时间 - 本机时间（毫秒）
  var synced = false;
  var timer = null;

  // 必须用 class 继承：Date 不能通过 Date.call(this) 初始化内部槽
  class ServerDate extends Date {
    _bj() { return new Date(this.getTime() + TZ_MIN * 60000); }
    getFullYear() { return this._bj().getUTCFullYear(); }
    getMonth() { return this._bj().getUTCMonth(); }
    getDate() { return this._bj().getUTCDate(); }
    getDay() { return this._bj().getUTCDay(); }
    getHours() { return this._bj().getUTCHours(); }
    getMinutes() { return this._bj().getUTCMinutes(); }
    getSeconds() { return this._bj().getUTCSeconds(); }
    getTimezoneOffset() { return -TZ_MIN; }
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function applyTs(ts) {
    var v = Number(ts);
    if (!isFinite(v) || v <= 0) return false;
    offset = v - Date.now();
    synced = true;
    try { window.dispatchEvent(new CustomEvent('server-time-synced', { detail: { offset: offset } })); } catch (e) {}
    return true;
  }

  // dayOffset：按「天」偏移（±n），返回仍是 ServerDate，跨时区也按北京时间算
  function now(dayOffset) { return new ServerDate(Date.now() + offset + (Number(dayOffset) || 0) * 86400000); }
  function ms() { return Date.now() + offset; }
  function ymd(d) { var t = d || now(); return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()); }
  function ym(d) { var t = d || now(); return t.getFullYear() + '-' + pad(t.getMonth() + 1); }
  function ymdhm(d) { var t = d || now(); return ymd(t) + ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes()); }
  function ymdhms(d) { var t = d || now(); return ymdhm(t) + ':' + pad(t.getSeconds()); }
  function year() { return now().getFullYear(); }

  // 拉一次服务器时间并校准（失败静默，仍按上一次校准值走）
  function sync() {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    return fetch('/api/server-time', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && applyTs(j.ts)) ? j : null; })
      .catch(function () { return null; });
  }
  // 起定期复核（幂等）
  function start() {
    if (timer) return;
    timer = setInterval(function () { if (document.visibilityState !== 'hidden') sync(); }, 10 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') sync(); });
  }

  window.ServerTime = {
    now: now, ms: ms, ymd: ymd, ym: ym, ymdhm: ymdhm, ymdhms: ymdhms, year: year,
    sync: sync, start: start, applyTs: applyTs,
    get synced() { return synced; },
    get offset() { return offset; },
    tzOffsetMinutes: TZ_MIN,
    timeZone: 'Asia/Shanghai',
    timeZoneLabel: '北京时间（UTC+8）'
  };
})();
