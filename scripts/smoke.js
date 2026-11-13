#!/usr/bin/env node
/* ========== 冒烟测试 ==========
 * 用临时 DATA_DIR（把项目复制到系统临时目录，data/ 为空 → 服务自动播种空实例）启动服务，
 * 逐功能区验证核心接口：健康检查 / 登录 / 各模块列表 GET / 新增 POST / 详情 GET / 权限 403。
 * 用途：重构（按功能区拆分）每一步的回归标准。
 *
 * 用法：
 *   node scripts/smoke.js               正常跑，结束后清理临时目录
 *   node scripts/smoke.js --keep        保留临时目录（排查失败用），末尾打印路径
 *   node scripts/smoke.js --port 5399   指定端口（默认自动挑空闲端口）
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const xlsx = require('xlsx');                                          // 读导出 xlsx 校验表头/合并
const { buildStoreZip, unzipEntry } = require('../server/core/util');   // 造最小 docx／读产物用（跟服务端同一套 zip 实现）

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const PORT_ARG = (() => {
  const i = process.argv.indexOf('--port');
  return i > -1 ? Number(process.argv[i + 1]) : 0;
})();
// 复制到临时目录时跳过的顶层项（node_modules 用软链接复用，避免每次复制几十 MB）
const SKIP_TOP = new Set(['node_modules', 'data', 'uploads', '.git', '.workbuddy', '_backup', '_shots']);

const results = [];
let base = '';
let child = null;
let TMP = '';
let serverLog = '';

function log(s) { process.stdout.write(s + '\n'); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function prepareTmp() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-smoke-'));
  fs.cpSync(ROOT, TMP, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (SKIP_TOP.has(top)) return false;
      if (/\.log$/i.test(rel)) return false;
      return true;
    }
  });
  // node_modules 复用项目里的那份（只读依赖，软链接即可）
  const nm = path.join(ROOT, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(TMP, 'node_modules'), 'dir');
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true }); // 空 data → 自动 seed 空实例
  return TMP;
}

async function startServer(port) {
  child = spawn(process.execPath, ['server.js'], {
    cwd: TMP,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', d => { serverLog += d.toString(); });
  child.stderr.on('data', d => { serverLog += d.toString(); });
  base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null) throw new Error('服务启动即退出（exit ' + child.exitCode + '）：\n' + serverLog);
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(800) });
      if (r.ok) return;
    } catch (e) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('服务 25s 内未就绪：\n' + serverLog);
}

async function stopServer() {
  if (!child) return;
  const c = child;
  child = null;
  if (c.exitCode === null) {
    c.kill('SIGTERM');
    await new Promise(r => {
      const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { } r(); }, 2500);
      c.on('exit', () => { clearTimeout(t); r(); });
    });
  }
}

async function api(method, p, opt) {
  opt = opt || {};
  const headers = {};
  if (opt.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opt.token) headers.Authorization = 'Bearer ' + opt.token;
  const res = await fetch(base + p, {
    method,
    headers,
    body: opt.body === undefined ? undefined : JSON.stringify(opt.body),
    signal: AbortSignal.timeout(10000)
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
  return { status: res.status, data };
}

async function step(group, name, fn) {
  try {
    const info = await fn();
    results.push({ group, name, ok: true, info: info || '' });
    log('PASS  [' + group + '] ' + name + (info ? '  → ' + info : ''));
  } catch (e) {
    results.push({ group, name, ok: false, info: e.message });
    log('FAIL  [' + group + '] ' + name + '\n      ' + String(e.message).replace(/\n/g, '\n      '));
  }
}

function need(cond, msg) { if (!cond) throw new Error(msg); }
function brief(data) { return JSON.stringify(data).slice(0, 220); }
function needOk(r, label) {
  need(r.status >= 200 && r.status < 300, (label || '') + ' 期望 2xx，实际 ' + r.status + ' ' + brief(r.data));
  return r.data;
}
async function listOk(p, token) {
  const r = await api('GET', p, { token });
  needOk(r, 'GET ' + p);
  need(Array.isArray(r.data), 'GET ' + p + ' 应返回数组，实际 ' + brief(r.data));
  return r.data;
}

/* ---------- 周计划拆分：解析器纯函数断言 ----------
 * 独立成函数，供本进程与 TZ=UTC 子进程各跑一遍（防服务器 UTC 时区下 Date 换算偏移）：
 * 同样的断言、同样的快照，两侧逐字节比对。 */
function splitPureChecks(PS) {
  const snap = {};
  const J = a => JSON.stringify(a);

  // 1) 日期标题：四种写法 + 标题之后的正文
  const head = s => {
    const h = PS.matchHeading(s);
    return h ? [h.kind, String(h.y), String(h.m), String(h.d), h.label, String(s).slice(h.len).trim()].join('|') : 'null';
  };
  snap.headings = ['2026-08-03：立杆', '2026年8月3日 立杆', '8月3号：立杆', '03日 立杆'].map(head);
  need(snap.headings[0] === 'ymd|2026|8|3|2026-08-03|立杆', 'YYYY-MM-DD 标题解析错：' + snap.headings[0]);
  need(snap.headings[1] === 'ymd|2026|8|3|2026年8月3日|立杆', '中文年月日标题解析错：' + snap.headings[1]);
  need(snap.headings[2] === 'md|null|8|3|8月3号|立杆', '月日标题解析错：' + snap.headings[2]);
  need(snap.headings[3] === 'd|null|null|3|03日|立杆', '日标题解析错：' + snap.headings[3]);
  need(PS.matchHeading('立杆3根') === null, '无日期标题不应解析出标题');

  // 2) 切段：分隔符「后紧跟日期标题」才切（前瞻），不跟标题的逗号不切
  snap.segments = [
    PS.segmentContent('11日：立杆3根；12日：放线1km'),
    PS.segmentContent('11日：立杆3根，放线2km'),
    PS.segmentContent('11日：立杆3根、12日：放线'),
    PS.segmentContent('11日：A\n12日：B\n'),
    PS.segmentContent('')
  ];
  need(J(snap.segments[0]) === J(['11日：立杆3根', '12日：放线1km']), '分号后紧跟标题应切开：' + brief(snap.segments[0]));
  need(J(snap.segments[1]) === J(['11日：立杆3根，放线2km']), '逗号后不跟标题不应切：' + brief(snap.segments[1]));
  need(J(snap.segments[2]) === J(['11日：立杆3根', '12日：放线']), '顿号后紧跟标题应切开：' + brief(snap.segments[2]));
  need(snap.segments[3].length === 2 && snap.segments[3][1] === '12日：B', '按行切段错：' + brief(snap.segments[3]));
  need(snap.segments[4].length === 0, '空内容应切出 0 段');

  // 3) 日期序列 / 每日起止时刻 / 子计划名后缀
  snap.dayList = [PS.dayList('2026-11-11', '2026-11-13'), PS.dayList('2026-11-13', '2026-11-11'), PS.dayList('2026-11-11', '')];
  need(J(snap.dayList[0]) === J(['2026-11-11', '2026-11-12', '2026-11-13']), '三天序列错：' + brief(snap.dayList[0]));
  need(snap.dayList[1].length === 0 && snap.dayList[2].length === 0, '反序/非法起止应返回空数组');
  need(!PS.isRealDate(2026, 2, 30) && PS.isRealDate(2028, 2, 29), 'isRealDate 闰年/非法日期判定错');
  snap.dayRange = [
    PS.dayRange('2026-11-12', '2026-11-11 08:00:00', '2026-11-13 10:00:00'),
    PS.dayRange('2026-12-31', '2026-12-30 22:00:00', '2027-01-01 06:00:00')
  ];
  need(snap.dayRange[0].start === '2026-11-12 08:00:00' && snap.dayRange[0].end === '2026-11-12 10:00:00',
    '每天起止应沿用父计划时刻：' + brief(snap.dayRange[0]));
  need(snap.dayRange[1].end === '2027-01-01 06:00:00', '结束时刻不晚于开始时应顺延次日：' + brief(snap.dayRange[1]));
  snap.mdLabel = ['2026-11-12', '2026-01-05'].map(PS.mdLabel);
  need(J(snap.mdLabel) === J(['11月12日', '1月5日']), '子计划名后缀应为「M月D日」且不补零：' + brief(snap.mdLabel));

  // 4) 单条结构化：修饰词不进地点、电压等级不算地点、规格与数量分开
  const it = s => {
    const o = PS.parseItem(s);
    return [o.地点, o.工序, o.规格, String(o.数量), o.单位, o.unparsed ? '未解析' : '已解析'].join('|');
  };
  snap.items = [
    it('大坪街村#3台变机械开挖15米电杆坑洞5个'),
    it('10kV冒烟线01号杆电杆组立3根'),
    it('0.4kV低压线路导线展放800米'),
    it('清理现场')
  ];
  need(snap.items[0] === '大坪街村#3台变|基础开挖|15米|5|个|已解析', '地名里的「台变」不应被判成工序：' + snap.items[0]);
  need(snap.items[1] === '冒烟线01号杆|电杆组立||3|根|已解析', '电压等级应从地点剔除：' + snap.items[1]);
  need(snap.items[2] === '低压线路|导线安装||800|米|已解析', '0.4kV 地点应只留「低压线路」：' + snap.items[2]);
  need(snap.items[3] === '|||null||未解析', '抽不出工序/数量应标未解析：' + snap.items[3]);
  need(it('电杆组立3根') === '|电杆组立||3|根|已解析', '只有工序没有地点也应可解析：' + it('电杆组立3根'));

  // 5) 七类工程量：电压分流、米折千米、多工序汇总、抽不出不产生
  const mapQ = s => PS.quantitiesOf(PS.parseDayItems(s, []));
  snap.qty = [
    mapQ('电杆组立3根'),
    mapQ('电缆敷设1200米'),
    mapQ('环网柜安装1台，真空开关安装2台，变压器安装1台'),
    mapQ('10kV导线架设2.5km'),
    mapQ('0.4kV低压线路导线展放800米'),
    mapQ('清理现场')
  ];
  need(J(snap.qty[0]) === J({ wlPole: 3 }), '电杆组立应计 wlPole：' + brief(snap.qty[0]));
  need(J(snap.qty[1]) === J({ wlCable: 1.2 }), '米应折算为千米：' + brief(snap.qty[1]));
  need(J(snap.qty[2]) === J({ wlRing: 1, wlVacuum: 2, wlTransformer: 1 }), '多工序应逐条汇总：' + brief(snap.qty[2]));
  need(J(snap.qty[3]) === J({ wlLine1035: 2.5 }), '10kV 导线应计 10/35kV 档：' + brief(snap.qty[3]));
  need(J(snap.qty[4]) === J({ wlLine04: 0.8 }), '0.4kV 导线应计 0.4kV 档：' + brief(snap.qty[4]));
  need(J(snap.qty[5]) === J({}), '抽不出工序不应产生工程量：' + brief(snap.qty[5]));
  const unmItems = PS.parseDayItems('拉线制作2组', []);
  PS.quantitiesOf(unmItems);
  snap.unmapped = [unmItems[0].工序, unmItems[0].数量, unmItems[0].unparsed === true, unmItems[0].unmapped === true];
  need(J(snap.unmapped) === J(['拉线制作', 2, false, true]), '解析成功但映射不上应标 unmapped：' + brief(snap.unmapped));

  // 6) 「同上」展开 + 确认稿覆盖（数字覆盖 / 空串删除 / 未传沿用）
  const prevItems = PS.parseDayItems('电杆组立3根', []);
  snap.same = PS.parseDayItems('同上', prevItems).map(x => [x.expandedFrom, x.原文, x.工序, String(x.数量)].join('|'));
  need(J(snap.same) === J(['同上|同上|电杆组立|3']), '「同上」应整条展开为上一天条目：' + brief(snap.same));
  snap.merge = PS.mergeQuantities({ wlPole: 3, wlCable: 1.2 }, { wlPole: '5', wlCable: '', wlRing: 2 });
  need(J(snap.merge) === J({ wlPole: 5, wlRing: 2 }), '确认稿覆盖：数字覆盖/空串删除/未传沿用：' + brief(snap.merge));

  // 7) 主入口：六类校验一次性收集，不只报第一条
  const dNoHead = PS.parseDailyContent('随便写点', '2026-11-11', '2026-11-12');
  need(dNoHead.ok === false && dNoHead.days.length === 0 && /未识别到每日日期标题/.test(dNoHead.errors[0]),
    '无任何标题应给格式提示：' + brief(dNoHead.errors));
  const dMiss = PS.parseDailyContent('11日：立杆3根\n13日：放线1km', '2026-11-11', '2026-11-13');
  need(dMiss.ok === false && dMiss.errors.some(e => e === '工作内容缺少计划日期：2026-11-12'), '缺天应逐天列全：' + brief(dMiss.errors));
  const dRange = PS.parseDailyContent('10日：立杆3根\n11日：放线1km', '2026-11-11', '2026-11-12');
  need(dRange.errors.some(e => /不在计划日期范围内/.test(e)), '超范围应报错：' + brief(dRange.errors));
  const dDup = PS.parseDailyContent('11日：立杆3根\n11日：放线1km', '2026-11-11', '2026-11-12');
  need(dDup.errors.some(e => /重复/.test(e)), '重复日期应报错：' + brief(dDup.errors));
  const dEmpty = PS.parseDailyContent('11日：\n12日：放线1km', '2026-11-11', '2026-11-12');
  need(dEmpty.errors.some(e => /内容为空/.test(e)), '空内容应报错：' + brief(dEmpty.errors));

  // 8) 「DD日」跨月跨年进位 + 同行连写多天（日期与工程量逐天归属）
  const dCross = PS.parseDailyContent('30日：电杆组立3根\n31日：电缆敷设1200米\n1日：清理现场', '2026-12-30', '2027-01-01');
  snap.cross = dCross.days.map(d => d.date);
  need(dCross.ok === true && J(snap.cross) === J(['2026-12-30', '2026-12-31', '2027-01-01']), '「DD日」应跨月跨年进位：' + brief(snap.cross));
  const dCross2 = PS.parseDailyContent('29日：电杆组立3根\n30日：电缆敷设1200米\n1日：导线架设2.5km\n2日：清理现场', '2026-11-29', '2026-12-02');
  snap.cross2 = dCross2.days.map(d => d.date);
  need(dCross2.ok === true && J(snap.cross2) === J(['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']),
    '11-29→12-02 跨月推断应正确：' + brief(snap.cross2));
  const dInline = PS.parseDailyContent('11日：电杆组立3根；12日：电缆敷设1200米；13日：导线架设2.5km', '2026-11-11', '2026-11-13');
  need(dInline.ok === true && dInline.days.length === 3, '同行连写多天应切开：' + brief(dInline.errors));
  snap.inline = dInline.days.map(d => d.date + '|' + J(d.quantities));
  need(J(dInline.days.map(d => d.quantities)) === J([{ wlPole: 3 }, { wlCable: 1.2 }, { wlLine1035: 2.5 }]),
    '同行连写的工程量应逐天归属：' + brief(dInline.days.map(d => d.quantities)));

  return snap;
}

async function runSmoke() {
  const t0 = Date.now();
  log('=== 电网ERP 冒烟测试（临时 DATA_DIR）===');
  try {
    prepareTmp();
    log('临时目录：' + TMP);
    const port = PORT_ARG || await freePort();
    await startServer(port);
    log('服务已就绪：' + base + '\n');
  } catch (e) {
    log('启动失败：' + e.message);
    await stopServer();
    if (TMP && !KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { } }
    process.exit(1);
  }

  /* ---------- 基础 / 静态资源 / 鉴权 ---------- */
  await step('基础', '健康检查 GET /api/health', async () => {
    const d = needOk(await api('GET', '/api/health'), 'health');
    need(d && d.ok === true, 'health.ok 应为 true：' + brief(d));
    return d.name;
  });
  await step('基础', '服务器时间基准 GET /api/server-time（北京时间 UTC+8）', async () => {
    const r = await fetch(base + '/api/server-time');
    need(r.status === 200, '状态码 ' + r.status);
    need(/no-store/i.test(r.headers.get('cache-control') || ''), '缺少 no-store 缓存头');
    const d = await r.json();
    need(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.now || ''), 'now 格式不符：' + d.now);
    need(d.tzOffsetMinutes === 480 && d.timeZone === 'Asia/Shanghai', '时区参数不符：' + brief(d));
    need(Math.abs(Date.now() - Number(d.ts)) < 5 * 60 * 1000, 'ts 与本机偏差过大：' + d.ts);
    const t = new Date(Number(d.ts) + 480 * 60000);
    const p2 = n => String(n).padStart(2, '0');
    const expect = t.getUTCFullYear() + '-' + p2(t.getUTCMonth() + 1) + '-' + p2(t.getUTCDate()) + ' ' + p2(t.getUTCHours()) + ':' + p2(t.getUTCMinutes());
    need(d.now.slice(0, 16) === expect, 'now 与 ts 换算不一致：' + d.now + ' vs ' + expect);
    const pc = needOk(await api('GET', '/api/public-config'), 'public-config');
    need(Number(pc.serverTs) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(pc.serverDate || ''), 'public-config 缺少 serverTs/serverDate');
    return d.now + ' · ' + d.timeZone;
  });
  await step('基础', '首页 GET /', async () => {
    const r = await fetch(base + '/');
    need(r.status === 200, 'GET / 期望 200，实际 ' + r.status);
    const html = await r.text();
    need(html.indexOf('id="app"') > -1, '首页 HTML 缺少 #app 挂载点');
    return 'HTML ' + html.length + ' 字节';
  });
  await step('基础', '离线依赖 GET /vendor/vue.global.prod.js', async () => {
    const r = await fetch(base + '/vendor/vue.global.prod.js');
    need(r.status === 200, '期望 200，实际 ' + r.status);
    const t = await r.text();
    need(t.length > 1000, 'vendor 文件内容异常（' + t.length + ' 字节）');
    return t.length + ' 字节';
  });
  await step('基础', '内置模板 GET /assets/materials_import_template.xlsx', async () => {
    const r = await fetch(base + '/assets/materials_import_template.xlsx');
    need(r.status === 200, '期望 200，实际 ' + r.status);
    return 'OK';
  });
  await step('鉴权', '未登录访问业务接口应 401', async () => {
    const r = await api('GET', '/api/projects');
    need(r.status === 401, '期望 401，实际 ' + r.status + ' ' + brief(r.data));
    return '401';
  });

  /* ---------- system：登录 / 用户 / 设置 / 人员 / 通讯录 ---------- */
  let token = '';
  let adminId = '';
  let clyToken = '';
  await step('system', '登录 POST /api/login（admin）', async () => {
    const d = needOk(await api('POST', '/api/login', { body: { username: 'admin', password: 'admin123' } }), 'login');
    need(d.token && d.user, '登录响应缺少 token/user：' + brief(d));
    token = d.token;
    adminId = d.user.id;
    return 'token ' + String(token).slice(0, 8) + '… / ' + d.user.role;
  });
  await step('system', '当前用户 GET /api/me', async () => {
    const d = needOk(await api('GET', '/api/me', { token }), 'me');
    need(d.user && d.user.username === 'admin', 'user.username 应为 admin：' + brief(d.user));
    need(d.user.isAdmin === true, 'admin 的 isAdmin 应为 true');
    return d.user.name + ' / ' + d.user.role + ' / write=' + JSON.stringify(d.user.permissions.writeModules);
  });
  await step('system', '设置 GET /api/settings', async () => {
    const d = needOk(await api('GET', '/api/settings', { token }), 'settings');
    need(d && typeof d === 'object' && 'systemName' in d, 'settings 缺少 systemName：' + brief(d));
    return 'systemName=' + d.systemName;
  });
  await step('system', '设置 weekStart：PUT 写 0 → GET 读回 0；不传该键时既有值不被冲掉', async () => {
    // 写 weekStart=0（星期日），并带一个其它键以贴近真实保存体
    const put1 = needOk(await api('PUT', '/api/settings', { token, body: { companyName: '冒烟企业', weekStart: 0 } }), 'settings PUT 0');
    need(put1.weekStart === 0, 'PUT weekStart=0 后读回应仍为 0，实际 ' + brief(put1.weekStart));
    const g1 = needOk(await api('GET', '/api/settings', { token }), 'settings GET 0');
    need(g1.weekStart === 0, 'GET 应读回 0，实际 ' + brief(g1.weekStart));
    // 不传 weekStart，仅改 companyName → 既有 weekStart 必须保留
    const put2 = needOk(await api('PUT', '/api/settings', { token, body: { companyName: '冒烟企业改' } }), 'settings PUT 不传 weekStart');
    need(put2.weekStart === 0, '不传 weekStart 时旧值应被保留为 0，实际 ' + brief(put2.weekStart));
    const g2 = needOk(await api('GET', '/api/settings', { token }), 'settings GET 保留');
    need(g2.weekStart === 0, 'GET 应仍为 0，实际 ' + brief(g2.weekStart));
    // 还原为默认值 1，避免污染后续（临时库本就会清理，这里仅为稳妥）
    await api('PUT', '/api/settings', { token, body: { weekStart: 1 } });
    return '0 写读一致 / 不传键值保留 / 还原 1';
  });
  await step('system', '初始化状态 GET /api/init-status', async () => {
    const d = needOk(await api('GET', '/api/init-status', { token }), 'init-status');
    need('initialized' in d, '缺少 initialized：' + brief(d));
    return 'initialized=' + d.initialized;
  });
  await step('system', '账号列表 GET /api/users', async () => {
    const d = needOk(await api('GET', '/api/users', { token }), 'users');
    need(Array.isArray(d) && d.length >= 1, '应为非空数组：' + brief(d));
    need(d.some(u => u.username === 'admin'), '列表缺少 admin');
    return d.length + ' 个账号';
  });
  await step('system', '新建账号 POST /api/users（材料员）+ 列表详情校验', async () => {
    const d = needOk(await api('POST', '/api/users', {
      token, body: { loginName: 'smoke_cly', email: 'smoke_cly@example.com', name: '冒烟材料员', password: 'Smoke@2026', userGroup: '材料员' }
    }), 'users POST');
    need(d && d.id, '响应缺少 id：' + brief(d));
    const list = needOk(await api('GET', '/api/users', { token }), 'users list');
    const got = list.find(u => u.id === d.id);
    need(got, '新建账号未出现在列表');
    need(got.userGroup === '材料员', 'userGroup 应为材料员，实际 ' + got.userGroup);
    return 'id=' + d.id;
  });
  await step('system', '作业人员 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/workers', {
      token, body: { name: '张三', idNumber: '510301199001010053', phone: '13800138000', role: '技工（计入高处作业人员）', team: '冒烟班组' }
    }), 'workers POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/workers/' + d.id, { token }), 'workers detail');
    need(one.name === '张三', 'detail.name 应为 张三，实际 ' + one.name);
    return 'id=' + d.id;
  });
  await step('system', '通讯录 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/contacts', { token, body: { name: '李四', phone: '13900139000', unit: '冒烟单位' } }), 'contacts POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/contacts/' + d.id, { token }), 'contacts detail');
    need(one.name === '李四', 'detail.name 应为 李四');
    return 'id=' + d.id;
  });
  await step('system', '设置字典 年度计划/供电所/班组/单位/材料目录 新增 → 详情', async () => {
    const out = [];
    const defs = [
      ['annualPlans', { name: '2026年度计划' }],
      ['substations', { name: '冒烟供电所' }],
      ['teams', { name: '冒烟班组' }],
      ['units', { name: '冒烟分包单位', type: '分包单位' }],
      ['materialCatalog', { name: '冒烟材料目录' }]
    ];
    for (const [coll, body] of defs) {
      const c = needOk(await api('POST', '/api/' + coll, { token, body }), coll + ' POST');
      need(c && c.id, coll + ' 响应缺少 id');
      const one = needOk(await api('GET', '/api/' + coll + '/' + c.id, { token }), coll + ' detail');
      need(one.name === body.name, coll + ' detail.name 不匹配：' + one.name);
      out.push(coll);
    }
    return out.join(' / ');
  });

  /* ---------- projects ---------- */
  let projectId = '';
  await step('projects', '新增项目 POST /api/projects', async () => {
    const d = needOk(await api('POST', '/api/projects', {
      token,
      body: { name: '冒烟测试项目', batch: '2026-01', substation: '冒烟供电所', workType: '配网', projectType: '自有工程', manager: '张三', status: '进行中' }
    }), 'projects POST');
    need(d && d.id, '响应缺少 id');
    projectId = d.id;
    return 'id=' + projectId;
  });
  await step('projects', '项目列表 GET /api/projects 含新项目', async () => {
    const d = needOk(await api('GET', '/api/projects', { token }), 'projects list');
    need(Array.isArray(d) && d.some(p => p.id === projectId), '列表未包含新建项目');
    return d.length + ' 个项目';
  });
  await step('projects', '项目详情 GET /api/projects/:id', async () => {
    const d = needOk(await api('GET', '/api/projects/' + projectId, { token }), 'projects detail');
    need(d.name === '冒烟测试项目', 'name 不匹配：' + d.name);
    return d.name;
  });

  /* ---------- materials ---------- */
  let materialId = '';
  await step('materials', '新增材料 POST /api/materials', async () => {
    const d = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目', source: 'ERP采购申请', description: '预应力混凝土电杆Φ150×10M', qtyRequired: 10, qtyArrived: 0, unit: '根', code: 'S01HDG1005' }
    }), 'materials POST');
    need(d && d.id, '响应缺少 id');
    materialId = d.id;
    return 'id=' + materialId;
  });
  await step('materials', '材料列表 GET /api/materials（含派生字段）', async () => {
    const d = needOk(await api('GET', '/api/materials', { token }), 'materials list');
    const it = d.find(m => m.id === materialId);
    need(it, '列表未包含新建材料');
    need(it.status === '未到库', 'status 应为 未到库，实际 ' + it.status);
    need(it.qtyNotArrived === 10, 'qtyNotArrived 应为 10，实际 ' + it.qtyNotArrived);
    return 'status=' + it.status + ' qtyNotArrived=' + it.qtyNotArrived;
  });
  await step('materials', '材料详情 GET /api/materials/:id', async () => {
    const d = needOk(await api('GET', '/api/materials/' + materialId, { token }), 'materials detail');
    need(d.description.indexOf('电杆') > -1, 'description 不匹配：' + d.description);
    return d.description;
  });
  await step('materials', '导入批次 GET /api/materialImports', async () => listOk('/api/materialImports', token).then(d => d.length + ' 条'));
  await step('materials', '出库管理 GET /api/materialOutbound', async () => listOk('/api/materialOutbound', token).then(d => d.length + ' 条'));
  await step('materials', '出库库存 GET /api/materialOutbound/stock', async () => {
    const d = needOk(await api('GET', '/api/materialOutbound/stock', { token }), 'stock');
    need(Array.isArray(d), 'stock 应返回数组：' + brief(d));
    return d.length + ' 行';
  });
  await step('materials', '领料单 GET /api/materialRequisitions', async () => listOk('/api/materialRequisitions', token).then(d => d.length + ' 条'));

  // 领料单号解析/排序与前端共用同一份纯函数（public/js/utils.js → window.MaterialNo）
  const MaterialNo = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.MaterialNo;
  })();
  // 领料单号定版格式：LL-YYYYMMDD-NNNN（4 位当日流水，从 0001 起）；无前缀写法只作为历史测试期格式参与排序解析
  const ymd = off => { const d = new Date(Date.now() + (off || 0) * 86400000); const p = n => String(n).padStart(2, '0'); return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()); };
  const TODAY = ymd(0), YDAY = ymd(-1);
  let reqNoNew = '';
  const mkReq = async (qty) => {
    const d = needOk(await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: materialId, qty: qty || 1 }] } }), 'requisition create');
    need(d && d.data && d.data.reqNo, '响应缺少 reqNo');
    return d.data.reqNo;
  };
  const insertReq = async (reqNo) => {
    needOk(await api('POST', '/api/materialRequisitions', { token, body: { reqNo, projects: ['冒烟测试项目'], items: [], status: '待入库', createdAt: reqNo.slice(0, 8) } }), 'insert ' + reqNo);
  };
  // 已到只能由入库产生（P0-1）：为任意材料生成领料单并确认入库
  const mkReqOf = async (mid, qty) => {
    const d = needOk(await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: mid, qty }] } }), 'requisition create');
    return d.data.id;
  };
  const arriveVia = async (mid, qty) => {
    const rid = await mkReqOf(mid, qty);
    needOk(await api('PUT', '/api/materialRequisitions/' + rid + '/confirm', { token, body: { rows: [{ materialId: mid, thisQty: qty }] } }), 'requisition confirm');
    return rid;
  };
  await step('materials', '领料单号定版：当日首单 LL-YYYYMMDD-0001（4 位流水，无前缀/昨日单均不计入推导）', async () => {
    // 干扰项：历史无前缀写法（不匹配 LL-<今日>- 前缀）、昨日 LL- 单（日期不同）
    await insertReq(TODAY + '-005');
    await insertReq('LL-' + YDAY + '-005');
    const n1 = await mkReq(1);
    need(/^LL-\d{8}-\d{4}$/.test(n1), '单号格式应为 LL-YYYYMMDD-NNNN，实际 ' + n1);
    need(n1 === 'LL-' + TODAY + '-0001', '当日首单应为 LL-' + TODAY + '-0001，实际 ' + n1);
    const n2 = await mkReq(1);
    need(n2 === 'LL-' + TODAY + '-0002', '次单应为 LL-' + TODAY + '-0002，实际 ' + n2);
    reqNoNew = n2;
    return n1 + ' → ' + n2 + '（已插入 ' + TODAY + '-005 与 LL-' + YDAY + '-005 作干扰）';
  });
  await step('materials', '领料单号删除补缺：作废不腾号、删号回收、大号不干扰（V4 a/b/c）', async () => {
    const mkRec = async () => {
      const d = needOk(await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: materialId, qty: 1 }] } }), 'requisition create');
      return d.data;
    };
    const listAll = async () => {
      const r = needOk(await api('GET', '/api/materialRequisitions', { token }), 'GET reqs');
      return (Array.isArray(r) ? r : (r.data || []));
    };
    const byNo = async (no) => (await listAll()).find(x => x.reqNo === no && !x.deleted);
    const doVoid = async (id) => needOk(await api('PUT', '/api/materialRequisitions/' + id + '/void', { token, body: { reason: 'ZT 编号补缺' } }), 'void');
    const doDel = async (id) => needOk(await api('DELETE', '/api/materialRequisitions/' + id, { token }), 'delete');

    // 干扰：插一个超大号，新口径下不应把补号抬到 10000
    await insertReq('LL-' + TODAY + '-9999');

    // (c) 删 0001 → 新建得 0001
    const r1 = await byNo('LL-' + TODAY + '-0001');
    need(!!r1, '前置：当日 0001 应存在');
    await doVoid(r1.id); await doDel(r1.id);
    const g1 = await mkRec();
    need(g1.reqNo === 'LL-' + TODAY + '-0001', '(c) 删 0001 后新建应得 0001，实际 ' + g1.reqNo);

    // (b) 0002 作废但不删 → 新建跳过 0002 得 0003
    const r2 = await byNo('LL-' + TODAY + '-0002');
    need(!!r2, '前置：当日 0002 应存在');
    await doVoid(r2.id);
    const g2 = await mkRec();
    need(g2.reqNo === 'LL-' + TODAY + '-0003', '(b) 0002 作废未删，新建应得 0003，实际 ' + g2.reqNo);

    // (a) 再删 0002 → 新建补回 0002
    await doDel(r2.id);
    const g3 = await mkRec();
    need(g3.reqNo === 'LL-' + TODAY + '-0002', '(a) 删 0002 后新建应补 0002，实际 ' + g3.reqNo);

    return '删0001→补0001 · 0002作废→0003 · 删0002→补0002 · 9999 不干扰';
  });
  await step('materials', '单号排序：日期升序 → 流水组（数值）→ 6 位时间组 → 无法识别', async () => {
    const D = TODAY;
    // 流水组：0001(1) 0002(2) 003(3) 999(1000) 1000；时间组：222544；再加无前缀写法与脏号
    const mixed = ['LL-' + D + '-0002', D + '-1000', 'X-无法识别', 'LL-' + D + '-222544', D + '-999', 'LL-' + D + '-0001', D + '-003'];
    const want = ['LL-' + D + '-0001', 'LL-' + D + '-0002', D + '-003', D + '-999', D + '-1000', 'LL-' + D + '-222544', 'X-无法识别'];
    const got = mixed.slice().sort((a, b) => MaterialNo.cmp(a, b));
    need(JSON.stringify(got) === JSON.stringify(want), '同日混合排序不符\n      实际：' + got.join(' , ') + '\n      期望：' + want.join(' , '));
    // 跨日：昨日单号整体排在今日之前
    const cross = ['LL-' + D + '-001', 'LL-' + YDAY + '-005'].sort((a, b) => MaterialNo.cmp(a, b));
    need(cross[0] === 'LL-' + YDAY + '-005', '跨日应昨日在前，实际 ' + cross.join(' , '));
    return got.join(' , ');
  });
  await step('materials', '历史重编脚本：同日 LL-四位 + LL-六位混合 → 按 createdAt 重编且二次运行不变', async () => {
    const os = require('os');
    const tdir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqno-mig-'));
    const sample = {
      materialRequisitions: [
        { id: 'b2', reqNo: 'LL-20261024-0002', createdAt: '2026-10-24 13:08', status: '已作废', deleted: false, items: [] },
        { id: 't1', reqNo: 'LL-20261024-123004', createdAt: '2026-10-24 12:30', status: '已作废', deleted: false, items: [] },
        { id: 'a1', reqNo: 'LL-20261024-0001', createdAt: '2026-10-24 13:07', status: '已入库', deleted: false, items: [] },
        { id: 'd1', reqNo: 'LL-20261024-122908', createdAt: '2026-10-24 12:29', status: '已作废', deleted: true, items: [] },
        { id: 'x1', reqNo: '20261028-001', createdAt: '2026-10-28 15:54', status: '待入库', deleted: false, items: [] },
        { id: 'bad', reqNo: '临时单', createdAt: '2026-10-24 09:00', status: '待入库', deleted: false, items: [] }
      ]
    };
    fs.writeFileSync(path.join(tdir, 'db.json'), JSON.stringify(sample, null, 2), 'utf8');
    const scriptPath = path.join(ROOT, 'scripts', 'migrate-reqno-20261028.js');
    const run = () => require('child_process').spawnSync(process.execPath, [scriptPath, '--data', tdir, '--apply'], { encoding: 'utf8' });
    const r1 = run();
    need(r1.status === 0, '首次迁移应成功退出，实际 status=' + r1.status + ' ' + (r1.stderr || ''));
    const after = JSON.parse(fs.readFileSync(path.join(tdir, 'db.json'), 'utf8'));
    const byId = {}; after.materialRequisitions.forEach(r => { byId[r.id] = r; });
    const expect = { d1: 'LL-20261024-001', t1: 'LL-20261024-002', a1: 'LL-20261024-003', b2: 'LL-20261024-004', x1: 'LL-20261028-001', bad: '临时单' };
    Object.keys(expect).forEach(k => need(byId[k] && byId[k].reqNo === expect[k], '记录 ' + k + ' 新号应为 ' + expect[k] + '，实际 ' + (byId[k] && byId[k].reqNo)));
    need(byId.d1.deleted === true && byId.d1.status === '已作废', '已删除记录的状态/删除标记不应被改动');
    need(after.materialRequisitions.length === sample.materialRequisitions.length, '记录数不应变化');
    // 二次运行：应为幂等（无改动）
    const before2 = fs.readFileSync(path.join(tdir, 'db.json'), 'utf8');
    const r2 = run();
    need(r2.status === 0, '二次迁移应成功退出');
    const after2 = fs.readFileSync(path.join(tdir, 'db.json'), 'utf8');
    need(after2 === before2, '二次运行不应改动文件（幂等）');
    need((r2.stdout || '').indexOf('无需写盘') > -1, '二次运行应报告无需写盘，实际：' + (r2.stdout || '').slice(-80));
    fs.rmSync(tdir, { recursive: true, force: true });
    return '5 条重编 + 1 条脏号跳过；二次运行无变化';
  });
  await step('materials', '领料单下载文件名 = reqNo（定版格式）', async () => {
    const list = needOk(await api('GET', '/api/materialRequisitions', { token }), 'requisition list');
    const nw = list.find(r => r.reqNo === reqNoNew);
    need(nw, '列表未包含新生成单号 ' + reqNoNew);
    const res = await fetch(base + '/api/materialRequisitions/' + nw.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(res.ok, '下载应成功：' + nw.reqNo);
    const cd = res.headers.get('Content-Disposition') || '';
    need(cd.indexOf(nw.reqNo + '.xlsx') > -1, '文件名应为 reqNo.xlsx，实际 ' + cd);
    return nw.reqNo + '.xlsx';
  });

  /* ---------- 到货统计（聚合口径回归，纯函数与前端共用） ---------- */
  const arrivalCalc = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'arrival-calc.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.ArrivalCalc;
  })();

  await step('materials', '到货统计聚合：应到/已到与材料明细逐行求和一致', async () => {
    const ms = await listOk('/api/materials', token);
    const names = [...new Set(ms.map(m => m.project))];
    const agg = arrivalCalc.aggregate(ms, names);
    const sum = k => Math.round(ms.reduce((s, m) => s + (Number(m[k]) || 0), 0) * 10000) / 10000;
    need(agg.totalRows === ms.length, '总行数应为 ' + ms.length + '，实际 ' + agg.totalRows);
    need(Math.abs(agg.requiredSum - sum('qtyRequired')) < 1e-6, '应到合计不符：' + agg.requiredSum + ' vs ' + sum('qtyRequired'));
    need(Math.abs(agg.arrivedSum - sum('qtyArrived')) < 1e-6, '已到合计不符：' + agg.arrivedSum + ' vs ' + sum('qtyArrived'));
    return `行 ${agg.totalRows} · 应到 ${agg.requiredSum} · 已到 ${agg.arrivedSum}`;
  });

  await step('materials', '到货统计：同名跨项目合并为一行且数量相加', async () => {
    const p2 =     needOk(await api('POST', '/api/projects', { token, body: { name: '冒烟测试项目B', batch: '2026-01', substation: '冒烟供电所', workType: '配网', category: '自有工程' } }), 'projects POST B');
    const mb = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '预应力混凝土电杆Φ150×10M', qtyRequired: 5, unit: '根', code: 'S01HDG1005' }
    }), 'materials POST B');
    await arriveVia(mb.id, 2); // 已到 2：只能由确认入库产生
    const ms = await listOk('/api/materials', token);
    const agg = arrivalCalc.aggregate(ms, ['冒烟测试项目', '冒烟测试项目B']);
    need(agg.kindCount === 1, '同名物料应合并为 1 种，实际 ' + agg.kindCount);
    need(agg.rows.length === 1, '主表应 1 行，实际 ' + agg.rows.length);
    need(Math.abs(agg.requiredSum - 15) < 1e-6, '应到合计应为 15，实际 ' + agg.requiredSum);
    need(Math.abs(agg.arrivedSum - 2) < 1e-6, '已到合计应为 2，实际 ' + agg.arrivedSum);
    return `1 种 · 应到 ${agg.requiredSum} · 已到 ${agg.arrivedSum} · ${p2.name}`;
  });

  await step('materials', '到货统计：同编码不同描述分开算（各是各的）', async () => {
    const mc = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '同编码另一描述', qtyRequired: 7, unit: '根', code: 'S01HDG1005' }
    }), 'materials POST C');
    await arriveVia(mc.id, 1); // 已到 1：只能由确认入库产生
    const ms = await listOk('/api/materials', token);
    const agg = arrivalCalc.aggregate(ms, ['冒烟测试项目', '冒烟测试项目B']);
    need(agg.kindCount === 2, '同编码不同描述应算 2 种，实际 ' + agg.kindCount);
    need(agg.rows.length === 2, '主表应 2 行，实际 ' + agg.rows.length);
    const d1 = agg.rows.find(r => r.description === '预应力混凝土电杆Φ150×10M');
    const d2 = agg.rows.find(r => r.description === '同编码另一描述');
    need(d1 && Math.abs(d1.required - 15) < 1e-6 && Math.abs(d1.arrived - 2) < 1e-6, '原描述组应仍为 15/2，实际 ' + (d1 && d1.required + '/' + d1.arrived));
    need(d2 && Math.abs(d2.required - 7) < 1e-6 && Math.abs(d2.arrived - 1) < 1e-6, '新描述组应为 7/1，实际 ' + (d2 && d2.required + '/' + d2.arrived));
    need(d1.code === 'S01HDG1005' && d2.code === 'S01HDG1005', '两行编码应相同（仅描述不同）');
    return `2 种：${d1.required}/${d1.arrived} + ${d2.required}/${d2.arrived}`;
  });

  await step('materials', '到货统计：同名不同编码也各是各的（编码+名称成条）', async () => {
    needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '预应力混凝土电杆Φ150×10M', qtyRequired: 3, qtyArrived: 0, unit: '根', code: 'SMOKE-OTHER' }
    }), 'materials POST D');
    needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: '从未到货物料', qtyRequired: 8, qtyArrived: 0, unit: '个', code: 'SMOKE-NOARR' }
    }), 'materials POST E');
    const ms = await listOk('/api/materials', token);
    const agg = arrivalCalc.aggregate(ms, ['冒烟测试项目', '冒烟测试项目B']);
    // 4 组：D1/C1(15,2)、D2/C1(7,1)、D1/SMOKE-OTHER(3,0)、D3/SMOKE-NOARR(8,0)
    need(agg.kindCount === 4, '应为 4 组（编码+名称），实际 ' + agg.kindCount);
    const d1 = agg.rows.find(r => r.description === '预应力混凝土电杆Φ150×10M');
    need(d1 && Math.abs(d1.required - 15) < 1e-6, '同名不同编码不应合并（应仍为 15），实际 ' + (d1 && d1.required));
    need(d1.code === 'S01HDG1005', '该行编码应为 S01HDG1005，实际 ' + (d1 && d1.code));
    need(Math.abs(agg.requiredSum - 33) < 1e-6, '应到合计应为 33，实际 ' + agg.requiredSum);
    need(agg.arrivedKindCount === 2, '已到货组数应为 2，实际 ' + agg.arrivedKindCount);
    need(agg.notArrivedKindCount === 2, '未到货组数应为 2，实际 ' + agg.notArrivedKindCount);
    need(agg.rows.length === agg.arrivedKindCount, '主表行数应等于已到货组数');
    const rr = arrivalCalc.recentArrivals([
      { reqNo: 'LL-20260101-0001', projects: ['冒烟测试项目'], status: '已入库', items: [{ materialId: 'a', description: '甲' }], history: [{ at: '2026-01-01 09:00', rows: [{ materialId: 'a', thisQty: 1 }] }] },
      { reqNo: 'LL-20260101-0002', projects: ['冒烟测试项目'], status: '已入库', items: [{ materialId: 'a', description: '甲' }], history: [{ at: '2026-01-02 09:00', rows: [{ materialId: 'a', thisQty: 2 }] }] },
      { reqNo: 'LL-20260101-0003', projects: ['冒烟测试项目'], status: '已作废', items: [{ materialId: 'a', description: '甲' }], history: [{ at: '2026-01-03 09:00', rows: [{ materialId: 'a', thisQty: 3 }] }] }
    ], ['冒烟测试项目'], 50);
    need(rr.length === 2, '作废单应排除，应 2 条，实际 ' + rr.length);
    need(rr[0].at > rr[1].at, '应按时间倒序，实际 ' + rr.map(x => x.at).join(' | '));
    return `组 ${agg.kindCount} / 已到 ${agg.arrivedKindCount} / 未到 ${agg.notArrivedKindCount} · D1 未与同名异码合并 · 动态 ${rr.length} 条`;
  });

  /* ---------- 材料台账修复批一：P0-1 已到只能由入库产生 / P0-2 作废防冲穿库存 ---------- */
  const MP_C = '冒烟测试项目C';
  let p01DId = '';
  await step('materials', 'P0-1-A 只填应到：已到恒 0 / 未到库 / 不进可出库库存', async () => {
    needOk(await api('POST', '/api/projects', { token, body: { name: MP_C, batch: '2026-11', substation: '冒烟供电所', workType: '配网', category: '自有工程' } }), 'projects POST C');
    const d = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P01A 未到货物料', qtyRequired: 4, unit: '根', code: 'ZT-P01A' }
    }), 'materials POST P01A');
    need(d.qtyArrived === 0, '已到应为 0，实际 ' + d.qtyArrived);
    need(d.status === '未到库', '状态应为 未到库，实际 ' + d.status);
    const stock = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(MP_C), { token }), 'stock P01A');
    need(!stock.some(x => x.id === d.id), '未到货材料不应出现在可出库库存');
    return 'id=' + d.id + ' · 已到 0 · 未到库 · 库存不出现';
  });

  await step('materials', 'P0-1-B 新增携带已到 → 400「只能通过确认入库产生」且不落库', async () => {
    const before = (await listOk('/api/materials', token)).length;
    const r = await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P01B 手工已到', qtyRequired: 10, qtyArrived: 99, unit: '根', code: 'ZT-P01B' }
    });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(r.data.error === '已到数量不能手工填写，只能通过确认入库产生', '文案不符：' + r.data.error);
    const after = await listOk('/api/materials', token);
    need(after.length === before, '拒绝后材料数不应变化：' + before + ' → ' + after.length);
    need(!after.some(m => m.code === 'ZT-P01B'), '被拒材料不应落库');
    const stock = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(MP_C), { token }), 'stock P01B');
    need(!stock.some(x => x.code === 'ZT-P01B'), '不应凭空产生库存');
    return '400 · 未落库 · 无库存';
  });

  await step('materials', 'P0-1-C 应到 ≤ 0 → 400「应到数量必须大于 0」', async () => {
    for (const q of [0, -3]) {
      const r = await api('POST', '/api/materials', {
        token,
        body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P01C 应到非法', qtyRequired: q, unit: '个', code: 'ZT-P01C' }
      });
      need(r.status === 400, 'qtyRequired=' + q + ' 应 400，实际 ' + r.status);
      need(/应到数量必须大于 0/.test(r.data.error), 'qtyRequired=' + q + ' 文案不符：' + r.data.error);
    }
    return '0 与 -3 均 400';
  });

  await step('materials', 'P0-1-D 确认入库 6 → 已到 6 / 部分到库 / 库存 6（唯一入口）', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P01D 入库主料', qtyRequired: 10, unit: '根', code: 'ZT-P01D' }
    }), 'materials POST P01D');
    p01DId = m.id;
    await arriveVia(m.id, 6);
    const cur = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material detail P01D');
    need(cur.qtyArrived === 6, '已到应为 6，实际 ' + cur.qtyArrived);
    need(cur.qtyNotArrived === 4, '未到应为 4，实际 ' + cur.qtyNotArrived);
    need(cur.status === '部分到库', '状态应为 部分到库，实际 ' + cur.status);
    const stock = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(MP_C), { token }), 'stock P01D');
    const s = stock.find(x => x.id === m.id);
    need(s && s.available === 6, '可用库存应为 6，实际 ' + (s && s.available));
    return '已到 6 · 未到 4 · 部分到库 · 可用 6';
  });

  await step('materials', 'P0-1-E 确认入库超量 → 400（既有校验保持）', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P01E 超量入库', qtyRequired: 5, unit: '根', code: 'ZT-P01E' }
    }), 'materials POST P01E');
    const rid = await mkReqOf(m.id, 4);
    const r = await api('PUT', '/api/materialRequisitions/' + rid + '/confirm', { token, body: { rows: [{ materialId: m.id, thisQty: 5 }] } });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(/不能大于未入库数量/.test(r.data.error), '文案不符：' + r.data.error);
    const cur = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material detail P01E');
    need(cur.qtyArrived === 0, '超量被拒后已到应仍为 0，实际 ' + cur.qtyArrived);
    return '4 的领料单入库 5 → 400 · 已到仍 0';
  });

  await step('materials', 'P0-1-F 编辑：改已到 → 400 且已到不变；应到低于已到 → 400', async () => {
    const cur = needOk(await api('GET', '/api/materials/' + p01DId, { token }), 'material detail F');
    const r1 = await api('PUT', '/api/materials/' + p01DId, { token, body: Object.assign({}, cur, { qtyArrived: 7 }) });
    need(r1.status === 400, '改已到应 400，实际 ' + r1.status + ' ' + brief(r1.data));
    need(r1.data.error === '已到数量不能手工修改，只能通过确认入库产生', '文案不符：' + r1.data.error);
    const r2 = await api('PUT', '/api/materials/' + p01DId, { token, body: Object.assign({}, cur, { qtyRequired: 5, modifyReason: '冒烟：下调应到' }) });
    need(r2.status === 400, '应到低于已到应 400，实际 ' + r2.status + ' ' + brief(r2.data));
    need(/已到 6 大于应到 5/.test(r2.data.error), '文案不符：' + r2.data.error);
    const after = needOk(await api('GET', '/api/materials/' + p01DId, { token }), 'material detail F after');
    need(after.qtyArrived === 6, '已到应保持 6，实际 ' + after.qtyArrived);
    need(after.qtyRequired === 10, '应到应保持 10，实际 ' + after.qtyRequired);
    return '改已到 400 · 应到 5 低于已到 6 → 400 · 原值不变';
  });

  await step('materials', 'P0-1-G 导入：应到落库、已到恒 0', async () => {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([
      ['项目名称', '物料描述', '申请数量', '计量单位', '物料编码', '采购订单号', '来源类型'],
      [MP_C, 'ZT测试-P01G 导入物料', 3, '个', 'ZT-P01G', 'PO-ZT-1', '甲供材料']
    ]);
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'zt-p01g.xlsx');
    const res = await fetch(base + '/api/materials/import', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const data = await res.json();
    need(res.ok, '导入应成功：' + res.status + ' ' + brief(data));
    need(data.added === 1, '应导入 1 条，实际 ' + data.added);
    const it = data.data[0];
    need(it.qtyRequired === 3 && it.qtyArrived === 0, '应到 3 / 已到 0，实际 ' + it.qtyRequired + '/' + it.qtyArrived);
    need(it.status === '未到库', '状态应为 未到库，实际 ' + it.status);
    const stock = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(MP_C), { token }), 'stock P01G');
    need(!stock.some(x => x.id === it.id), '导入材料未到货不应进库存');
    return '应到 3 · 已到 0 · 未到库';
  });

  /* ---------- P2 材料导入试校验 ---------- */
  const mkImportFile = (rows, fname) => {
    const wb2 = xlsx.utils.book_new();
    const ws2 = xlsx.utils.aoa_to_sheet([['项目名称', '物料描述', '申请数量', '计量单位', '物料编码', '采购订单号', '来源类型'], ...rows]);
    xlsx.utils.book_append_sheet(wb2, ws2, 'Sheet1');
    const buf2 = xlsx.write(wb2, { type: 'buffer', bookType: 'xlsx' });
    const fd2 = new FormData();
    fd2.append('file', new Blob([buf2]), fname);
    return fd2;
  };
  await step('materials', 'P2 试校验：四类行一次列全、库与批次零变化；正式导入同文件整批拒绝', async () => {
    const before = {
      mats: (await listOk('/api/materials', token)).length,
      batches: (await listOk('/api/materialImports', token)).length
    };
    const rows4 = [
      [MP_C, 'ZT测试-P2 正常行', 2, '个', 'ZT-P2-OK', 'PO-ZT', '甲供材料'],
      ['不存在项目ZT', 'ZT测试-P2 未知项目', 1, '个', 'ZT-P2-PJ', 'PO-ZT', '甲供材料'],
      [MP_C, 'ZT测试-P2 缺数量', '', '个', 'ZT-P2-QT', 'PO-ZT', '甲供材料'],
      [MP_C, 'ZT测试-P2 负数', -3, '个', 'ZT-P2-NG', 'PO-ZT', '甲供材料']
    ];
    const pv = await fetch(base + '/api/materials/import/preview', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: mkImportFile(rows4, 'zt-p2.xlsx')
    });
    const pvd = await pv.json();
    need(pv.ok, '试校验接口应 200：' + pv.status + ' ' + brief(pvd));
    need(pvd.ok === false && pvd.canImport === false, '含错文件应 ok=false / canImport=false：' + brief(pvd));
    need(pvd.errorCount === 3 && Array.isArray(pvd.errors) && pvd.errors.length === 3,
      '应一次列全 3 行错误，实际 ' + pvd.errorCount);
    need(pvd.errors.map(e => e.row).join(',') === '3,4,5', '错误行号应为 3,4,5，实际 ' + pvd.errors.map(e => e.row).join(','));
    need(pvd.errors.every(e => e.message && /^第\d+行：/.test(e.message)), '错误项应含「第N行：原因」：' + brief(pvd.errors));
    need(/项目列表不一致/.test(pvd.errors[0].message) && /申请数量/.test(pvd.errors[1].message) && /申请数量/.test(pvd.errors[2].message),
      '错误原因不符：' + brief(pvd.errors.map(e => e.message)));
    need(pvd.validRows === 1, '合法行应为 1，实际 ' + pvd.validRows);
    const after1 = {
      mats: (await listOk('/api/materials', token)).length,
      batches: (await listOk('/api/materialImports', token)).length
    };
    need(after1.mats === before.mats && after1.batches === before.batches, '试校验不应写库：' + brief({ before, after1 }));
    const up = await fetch(base + '/api/materials/import', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: mkImportFile(rows4, 'zt-p2.xlsx')
    });
    const upd = await up.json();
    need(up.status === 400 && /共 3 处不一致/.test(upd.error), '正式导入应整批拒绝：' + up.status + ' ' + brief(upd));
    need(/第3行：/.test(upd.error) && /项目列表不一致/.test(upd.error), '正式导入错误口径应与试校验一致：' + upd.error);
    const after2 = {
      mats: (await listOk('/api/materials', token)).length,
      batches: (await listOk('/api/materialImports', token)).length
    };
    need(after2.mats === before.mats && after2.batches === before.batches, '整批拒绝不应落库：' + brief({ before, after2 }));
    const up2 = await fetch(base + '/api/materials/import', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token },
      body: mkImportFile([[MP_C, 'ZT测试-P2 全对行', 1, '个', 'ZT-P2-ALLOK', 'PO-ZT', '甲供材料']], 'zt-p2-ok.xlsx')
    });
    const d2 = await up2.json();
    need(up2.status === 200 && d2.added === 1, '全对文件应导入成功：' + up2.status + ' ' + brief(d2));
    return '3 错行全列（行 3/4/5） · 零写 · 整批拒绝 · 全对导入成功';
  });

  await step('materials', 'P2.1 前端：导入弹窗有「试校验」与错误清单、正式导入仍走原接口', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/\/api\/materials\/import\/preview/.test(src), '前端应调用试校验接口');
    need(/试校验/.test(src), '弹窗应有「试校验」按钮');
    need(/v-for="\(e, i\) in idlg\.errors"/.test(src), '应逐条展示错误清单');
    need(/\/api\/materials\/import['"]/.test(src), '正式导入仍走原接口');
    return '试校验按钮 + 错误清单 + 正式导入原接口';
  });

  // P0-3 起效后出库必须填已准入工人：先落一名固定工人供 P0-2/P0-3 各出库用例使用
  let smokeWorker = null;
  let srvToday = '';
  const dayOff = (dstr, off) => new Date(Date.parse(dstr + 'T00:00:00Z') + off * 86400000).toISOString().slice(0, 10);
  await step('materials', 'P0-3 前置：落一名已准入工人（出库领取人的合法来源）+ 服务器北京日期', async () => {
    const st = needOk(await api('GET', '/api/server-time'), 'server-time');
    srvToday = String(st.now || '').slice(0, 10);
    need(/^\d{4}-\d{2}-\d{2}$/.test(srvToday), '服务器日期格式不符：' + st.now);
    smokeWorker = needOk(await api('POST', '/api/workers', {
      token, body: { name: '冒烟领料人', status: '已准入', validStart: '2020-01-01', validEnd: '2099-12-31', identity: '技工（计入高处作业人员）', team: '冒烟班组' }
    }), 'workers POST 冒烟领料人');
    need(smokeWorker && smokeWorker.id, '工人响应缺少 id');
    return '工人 id=' + smokeWorker.id + ' · 服务器日期 ' + srvToday;
  });

  let p02MatId = '', p02ReqId = '', p02OutId = '';
  await step('materials', 'P0-2-A 有效出库占用 3.5 时作废领料单 → 拒、refs 含单号与净 3.5、库存不变', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P02A 占用主料', qtyRequired: 10, unit: '根', code: 'ZT-P02A' }
    }), 'materials POST P02A');
    p02MatId = m.id;
    p02ReqId = await arriveVia(m.id, 6);
    const ob = needOk(await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, receiver: '冒烟领料人', items: [{ materialId: m.id, qty: 3.5 }] }
    }), 'outbound create P02A');
    p02OutId = ob.data.id;
    const outNo = ob.data.outNo;
    const r = await api('PUT', '/api/materialRequisitions/' + p02ReqId + '/void', { token, body: { reason: 'ZT测试-冲穿校验' } });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(r.data.error === '作废后可用库存将为负，请先归还或作废占用的出库单', '文案不符：' + r.data.error);
    const refs = r.data.refs;
    need(Array.isArray(refs) && refs.length === 1, 'refs 应 1 条，实际 ' + brief(refs));
    const x = refs[0];
    ['outNo', 'outboundId', 'materialId', 'code', 'description', 'qty', 'returned', 'net', 'availableAfter', 'receiver']
      .forEach(k => need(k in x, 'refs 缺字段 ' + k));
    need(x.outNo === outNo && x.outboundId === p02OutId, 'refs 出库单号/ID 不符：' + x.outNo + '/' + x.outboundId);
    need(x.qty === 3.5 && x.returned === 0 && x.net === 3.5, 'qty/returned/net 不符：' + JSON.stringify([x.qty, x.returned, x.net]));
    need(x.availableAfter === -3.5, 'availableAfter 应为 -3.5，实际 ' + x.availableAfter);
    need(x.receiver === '冒烟领料人', 'receiver 不符：' + x.receiver);
    const reqs = await listOk('/api/materialRequisitions', token);
    need(reqs.find(y => y.id === p02ReqId).status === '已入库', '领料单状态应保持 已入库');
    const cur = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material detail P02A');
    need(cur.qtyArrived === 6, '已到应仍 6，实际 ' + cur.qtyArrived);
    const stock = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(MP_C), { token }), 'stock P02A');
    const s = stock.find(z => z.id === m.id);
    need(s && s.available === 2.5, '库存仍应显示 2.5，实际 ' + (s && s.available));
    return '3.5 占用 → 400 · refs ' + outNo + ' 净 3.5 · 已到 6 · 可用 2.5';
  });

  await step('materials', 'P0-2-B 先作废出库单 → 再作废领料单成功', async () => {
    needOk(await api('PUT', '/api/materialOutbound/' + p02OutId + '/void', { token, body: { reason: 'ZT测试-解除占用' } }), 'outbound void');
    needOk(await api('PUT', '/api/materialRequisitions/' + p02ReqId + '/void', { token, body: { reason: 'ZT测试-作废领料单' } }), 'requisition void');
    const cur = needOk(await api('GET', '/api/materials/' + p02MatId, { token }), 'material detail P02B');
    need(cur.qtyArrived === 0, '作废后已到应 0，实际 ' + cur.qtyArrived);
    const stock = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(MP_C), { token }), 'stock P02B');
    need(!stock.some(z => z.id === p02MatId), '库存不应再有该材料');
    return '出库作废 → 领料作废成功 · 已到 0';
  });

  await step('materials', 'P0-2-C 归还至净 0 → 作废领料单成功', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P02C 归还后作废', qtyRequired: 5, unit: '根', code: 'ZT-P02C' }
    }), 'materials POST P02C');
    const rid = await arriveVia(m.id, 2);
    const ob = needOk(await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, receiver: '冒烟领料人', items: [{ materialId: m.id, qty: 2 }] }
    }), 'outbound create P02C');
    needOk(await api('PUT', '/api/materialOutbound/' + ob.data.id + '/return', { token, body: { rows: [{ materialId: m.id, qty: 2 }] } }), 'outbound return P02C');
    needOk(await api('PUT', '/api/materialRequisitions/' + rid + '/void', { token, body: { reason: 'ZT测试-归还后作废' } }), 'requisition void P02C');
    const cur = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material detail P02C');
    need(cur.qtyArrived === 0, '已到应 0，实际 ' + cur.qtyArrived);
    return '净 0 → 作废成功 · 已到 0';
  });

  await step('materials', 'P0-2-D 无出库 → 作废成功、已到正确冲减', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P02D 无出库作废', qtyRequired: 5, unit: '根', code: 'ZT-P02D' }
    }), 'materials POST P02D');
    const rid = await arriveVia(m.id, 3);
    needOk(await api('PUT', '/api/materialRequisitions/' + rid + '/void', { token, body: { reason: 'ZT测试-无出库作废' } }), 'requisition void P02D');
    const cur = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material detail P02D');
    need(cur.qtyArrived === 0 && cur.qtyNotArrived === 5 && cur.status === '未到库',
      '冲减后应 已到 0 / 未到 5 / 未到库，实际 ' + cur.qtyArrived + '/' + cur.qtyNotArrived + '/' + cur.status);
    return '已到 3 → 0 · 未到 5 · 未到库';
  });

  await step('materials', 'P0-2-E 待入库单作废不受影响（voidDeduct=0）', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P02E 待入库作废', qtyRequired: 5, unit: '根', code: 'ZT-P02E' }
    }), 'materials POST P02E');
    const rid = await mkReqOf(m.id, 3);
    const r = needOk(await api('PUT', '/api/materialRequisitions/' + rid + '/void', { token, body: { reason: 'ZT测试-待入库作废' } }), 'requisition void P02E');
    need(r.data.status === '已作废', '状态应为 已作废，实际 ' + r.data.status);
    need(r.data.voidDeduct === 0, 'voidDeduct 应为 0，实际 ' + r.data.voidDeduct);
    const cur = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material detail P02E');
    need(cur.qtyArrived === 0, '已到应仍 0，实际 ' + cur.qtyArrived);
    return '作废成功 · voidDeduct=0 · 已到仍 0';
  });

  await step('materials', 'P0-2-F 空作废原因 → 400（既有行为保持）', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P02F 空原因', qtyRequired: 5, unit: '根', code: 'ZT-P02F' }
    }), 'materials POST P02F');
    const rid = await mkReqOf(m.id, 1);
    const r = await api('PUT', '/api/materialRequisitions/' + rid + '/void', { token, body: { reason: '   ' } });
    need(r.status === 400, '应 400，实际 ' + r.status);
    need(r.data.error === '请填写作废原因', '文案不符：' + r.data.error);
    const reqs = await listOk('/api/materialRequisitions', token);
    need(reqs.find(y => y.id === rid).status === '待入库', '领料单应仍为 待入库');
    return '400 · 状态未变';
  });

  // P0-1.4 前端静态断言（UI 交互不在冒烟内模拟）
  await step('materials', 'P0-1.4 前端：已到改只读展示（新增显示 0）、应到 min 大于 0', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/label="已到数量"[\s\S]{0,160}:model-value="fmtQty\(form\.qtyArrived \|\| 0\)" readonly/.test(src),
      '已到应改为只读展示（新增显示 0）');
    need(!/v-model="form\.qtyArrived"/.test(src), '已到不应再有可编辑输入');
    need(/v-model="form\.qtyRequired" :min="0\.0001"/.test(src), '应到 min 应为 0.0001（> 0 口径）');
    return '已到只读 · 应到 min>0';
  });

  // P0-2-G 前端静态断言（真实界面另由浏览器实测覆盖）
  await step('materials', 'P0-2-G 前端：作废被拒列出出库单号与净出库', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/const refs = e && e\.data && e\.data\.refs;[\s\S]{0,400}r\.outNo[\s\S]{0,160}fmtQty\(r\.net\)/.test(src),
      '作废失败应列出出库单号与净出库');
    return '作废失败列出单号+净出库';
  });

  /* ---------- P0-3 出库领取人服务端校验 ---------- */
  let p03MatId = '';
  await step('materials', 'P0-3 前置：可出库材料（应到 20 / 入库 10）', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token, body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P03 领取人校验主料', qtyRequired: 20, unit: '根', code: 'ZT-P03' }
    }), 'materials POST P03');
    p03MatId = m.id;
    await arriveVia(m.id, 10);
    return 'id=' + p03MatId + ' · 可用 10';
  });

  await step('materials', 'P0-3-A 已准入工人带 workerId 出库成功、receiver 为姓名快照', async () => {
    const r = needOk(await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, receiver: '前端乱写的名字', items: [{ materialId: p03MatId, qty: 1 }] }
    }), 'outbound create P03A');
    need(r.data.receiver === '冒烟领料人', 'receiver 应取工人姓名快照，实际 ' + r.data.receiver);
    return '成功 · receiver=冒烟领料人（忽略前端姓名）';
  });

  await step('materials', 'P0-3-B 不存在的姓名 → 400 不建单', async () => {
    const before = (await listOk('/api/materialOutbound', token)).length;
    const r = await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, receiver: '查无此工人', items: [{ materialId: p03MatId, qty: 1 }] }
    });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(r.data.error === '领取人「查无此工人」不在已准入工人名单', '文案不符：' + r.data.error);
    const after = (await listOk('/api/materialOutbound', token)).length;
    need(after === before, '被拒后出库单数不应变化：' + before + ' → ' + after);
    return '400 · 未建单';
  });

  await step('materials', 'P0-3-C 用户库人员/项目班组长不算已准入工人 → 400', async () => {
    // 建一个班组长账号（用户库），其姓名不在作业人员名单里
    needOk(await api('POST', '/api/users', {
      token, body: { loginName: 'smoke_lead', email: 'smoke_lead@example.com', name: '冒烟班组长甲', password: 'Smoke@2026', userGroup: '班组长' }
    }), 'users POST 冒烟班组长甲');
    const r = await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, receiver: '冒烟班组长甲', items: [{ materialId: p03MatId, qty: 1 }] }
    });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(/不在已准入工人名单/.test(r.data.error), '文案不符：' + r.data.error);
    return '400 · 用户库人员不算数';
  });

  await step('materials', 'P0-3-D 空领取人 → 400「请选择领取人」', async () => {
    const r = await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, items: [{ materialId: p03MatId, qty: 1 }] }
    });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(r.data.error === '请选择领取人', '文案不符：' + r.data.error);
    return '400 · 请选择领取人';
  });

  await step('materials', 'P0-3-E 超期/待定/已退场/已删除 → 400；截止日当天 → 允许（服务器北京日期）', async () => {
    const mk = async (name, body) => needOk(await api('POST', '/api/workers', {
      token, body: Object.assign({ name, status: '已准入', identity: '技工（计入高处作业人员）' }, body)
    }), 'workers POST ' + name);
    const overdue = await mk('ZT超期工人', { validEnd: dayOff(srvToday, -1) });
    const pending = await mk('ZT待定工人', { status: '待定', validEnd: '2099-12-31' });
    const exited = await mk('ZT退场工人', { status: '已退场', validEnd: '2099-12-31' });
    const deleted = await mk('ZT已删工人', { validEnd: '2099-12-31' });
    needOk(await api('DELETE', '/api/workers/' + deleted.id, { token }), 'workers DELETE');
    const todayEnd = await mk('ZT截止日工人', { validEnd: srvToday });
    const tryOut = (body) => api('POST', '/api/materialOutbound/create', {
      token, body: Object.assign({ project: MP_C, items: [{ materialId: p03MatId, qty: 0.5 }] }, body)
    });
    for (const [label, wid] of [['超期', overdue.id], ['待定', pending.id], ['已退场', exited.id], ['已删除', deleted.id]]) {
      const r = await tryOut({ workerId: wid });
      need(r.status === 400, label + ' 应 400，实际 ' + r.status + ' ' + brief(r.data));
      need(/不在已准入工人名单/.test(r.data.error), label + ' 文案不符：' + r.data.error);
    }
    const ok = needOk(await tryOut({ workerId: todayEnd.id }), 'outbound create 截止日');
    need(ok.data.receiver === 'ZT截止日工人', '截止日当天应允许，receiver=' + ok.data.receiver);
    return '超期/待定/已退场/已删除 各 400 · 截止日当天允许';
  });

  await step('materials', 'P0-3-F 归还不接受改领取人', async () => {
    const ob = needOk(await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p03MatId, qty: 1 }] }
    }), 'outbound create P03F');
    const r = needOk(await api('PUT', '/api/materialOutbound/' + ob.data.id + '/return', {
      token, body: { rows: [{ materialId: p03MatId, qty: 1 }], receiver: '别人', workerId: 'someone-else' }
    }), 'outbound return P03F');
    need(r.data.receiver === '冒烟领料人', '归还后领取人应不变，实际 ' + r.data.receiver);
    return '归还后 receiver 仍为 冒烟领料人';
  });

  await step('materials', 'P0-3 重名：只传姓名 → 400，带 workerId → 成功', async () => {
    const mk = async () => needOk(await api('POST', '/api/workers', {
      token, body: { name: 'ZT重名工人', status: '已准入', validEnd: '2099-12-31', identity: '技工（计入高处作业人员）' }
    }), 'workers POST ZT重名工人');
    await mk();
    const b = await mk();
    const r1 = await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, receiver: 'ZT重名工人', items: [{ materialId: p03MatId, qty: 0.5 }] }
    });
    need(r1.status === 400, '重名只传姓名应 400，实际 ' + r1.status + ' ' + brief(r1.data));
    need(/同名的已准入人员，请改用名单选择/.test(r1.data.error), '文案不符：' + r1.data.error);
    const r2 = needOk(await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, workerId: b.id, items: [{ materialId: p03MatId, qty: 0.5 }] }
    }), 'outbound create 重名 workerId');
    need(r2.data.receiver === 'ZT重名工人', 'receiver 不符：' + r2.data.receiver);
    return '重名 400 · workerId 成功';
  });

  await step('materials', 'P0-3 防漂移：服务端已准入判定与前端 WorkerStatus.of 同口径', async () => {
    const WS = require('../server/core/worker-status');
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const fe = sandbox.window.WorkerStatus.of;
    const samples = [
      { label: '已准入有效期内', w: { status: '已准入', validEnd: '2099-12-31' } },
      { label: '超期派生待定', w: { status: '已准入', validEnd: dayOff(srvToday, -1) } },
      { label: '待定', w: { status: '待定', validEnd: '2099-12-31' } },
      { label: '已退场', w: { status: '已退场', validEnd: '2099-12-31' } },
      { label: '有效期为空', w: { status: '已准入', validEnd: '' } },
      { label: '截止日当天', w: { status: '已准入', validEnd: srvToday } }
    ];
    samples.forEach(s => {
      const a = WS.workerStatusOf(s.w, srvToday), b = fe(s.w, srvToday);
      need(a.derived === b.derived && a.admitted === b.admitted && a.days === b.days,
        s.label + ' 前后端口径不一致：服务端 ' + a.derived + '/' + a.days + '，前端 ' + b.derived + '/' + b.days);
    });
    need(WS.isWorkerAdmitted({ status: '已准入', validEnd: '2099-12-31', deleted: true }, srvToday) === false,
      '已删除工人不应算已准入');
    need(WS.isWorkerAdmitted({ status: '已准入', validEnd: srvToday }, srvToday) === true,
      '截止日当天应算已准入');
    need(WS.isWorkerAdmitted({ status: '已准入', validEnd: dayOff(srvToday, -1) }, srvToday) === false,
      '超期工人不应算已准入');
    return samples.length + ' 组样例前后端一致 + 已删除拒绝 + 截止日允许';
  });

  await step('materials', 'P0-3.1 前端：领取人下拉带 id、提交 workerId + 姓名', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/workers\.value = arr\.filter\([\s\S]{0,200}\.map\(w => \(\{ id: w\.id, name: w\.name/.test(src),
      '领取人下拉应保留 id + 姓名');
    need(/v-model="dlg\.workerId"[\s\S]{0,140}:key="w\.id"[\s\S]{0,100}:value="w\.id"/.test(src),
      '下拉应绑定 workerId（值为工人 id）');
    need(/workerId: w\.id, receiver: w\.name/.test(src), '提交应传 workerId 并以姓名作兼容字段');
    need(!/v-model="dlg\.receiver"/.test(src), '领取人不应再直接绑定姓名');
    return '下拉 id+姓名 · 提交 workerId · 姓名兼容';
  });

  /* ---------- P1 出库可选关联（计划 / 作业日 / 工序 / 来源领料单） ---------- */
  let p1MatId = '', p1ReqId = '', p1PlanId = '', p1OutId = '', p1ReqNo = '', p1PlanBId = '';
  await step('materials', 'P1-A 带来源领料单 + 计划出库 → 成功；GET/反查/material-usage 全部可见', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P1A 关联出库主料', qtyRequired: 10, unit: '根', code: 'ZT-P1A' }
    }), 'materials POST P1A');
    p1MatId = m.id;
    p1ReqId = await arriveVia(m.id, 6); // 已到 6
    const reqs = await listOk('/api/materialRequisitions', token);
    p1ReqNo = (reqs.find(x => x.id === p1ReqId) || {}).reqNo || '';
    p1PlanId = needOk(await api('POST', '/api/workPlans', {
      token,
      body: { name: 'ZT测试-P1A 关联计划', planType: '周计划', project: MP_C, startDate: '2026-11-01 08:00:00', endDate: '2026-11-30 18:00:00', status: '未执行' }
    }), 'workPlans POST P1A').id;
    const ob = needOk(await api('POST', '/api/materialOutbound/create', {
      token,
      body: {
        project: MP_C, workerId: smokeWorker.id,
        workPlanId: p1PlanId, workDate: '2026-11-15', processName: '立杆',
        items: [{ materialId: m.id, qty: 3, requisitionId: p1ReqId }]
      }
    }), 'outbound create P1A');
    p1OutId = ob.data.id;
    need(ob.data.workPlanId === p1PlanId && ob.data.workDate === '2026-11-15' && ob.data.processName === '立杆',
      '单头关联字段不符：' + brief({ p: ob.data.workPlanId, d: ob.data.workDate, n: ob.data.processName }));
    need(ob.data.workPlanName === 'ZT测试-P1A 关联计划', '创建响应应带计划名称，实际 ' + ob.data.workPlanName);
    need(ob.data.items[0].requisitionId === p1ReqId && ob.data.items[0].reqNo === p1ReqNo,
      '明细应带来源领料单与单号：' + brief(ob.data.items[0]));
    const orders = needOk(await api('GET', '/api/materialOutbound/orders?project=' + encodeURIComponent(MP_C), { token }), 'orders P1A');
    const row = orders.find(o => o.id === p1OutId);
    need(row && row.workPlanName === 'ZT测试-P1A 关联计划' && row.items[0].reqNo === p1ReqNo,
      'GET 列表应带计划名称与领料单号：' + brief(row && { n: row.workPlanName, r: row.items[0] }));
    const rev = needOk(await api('GET', '/api/materialRequisitions/' + p1ReqId + '/outbounds', { token }), 'req outbounds P1A');
    need(rev.some(o => o.id === p1OutId && o.status === '有效'), '领料单反查应含该出库单');
    const usage = needOk(await api('GET', '/api/workPlans/' + p1PlanId + '/material-usage', { token }), 'usage P1A');
    const u = usage.find(x => x.code === 'ZT-P1A');
    need(u && u.net === 3 && u.outCount === 1, 'material-usage 净额应 3，实际 ' + brief(u));
    return '出库 3 · 单号 ' + p1ReqNo + ' · 计划可见 · usage 净额 3';
  });

  await step('materials', 'P1-C 来源领料单不属本项目 / 已作废 → 400', async () => {
    const mB = needOk(await api('POST', '/api/materials', {
      token,
      body: { project: '冒烟测试项目B', source: '甲供材料', description: 'ZT测试-P1C 他项目料', qtyRequired: 5, unit: '根', code: 'ZT-P1C' }
    }), 'materials POST P1C');
    const reqB = await arriveVia(mB.id, 2);
    const r1 = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p1MatId, qty: 1, requisitionId: reqB }] }
    });
    need(r1.status === 400, '他项目领料单应 400，实际 ' + r1.status + ' ' + brief(r1.data));
    need(/不属于所选工程/.test(r1.data.error), '文案不符：' + r1.data.error);
    const r2 = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p1MatId, qty: 1, requisitionId: p02ReqId }] }
    });
    need(r2.status === 400, '已作废领料单应 400，实际 ' + r2.status + ' ' + brief(r2.data));
    need(/已作废/.test(r2.data.error), '文案不符：' + r2.data.error);
    return '他项目 400 · 已作废 400';
  });

  await step('materials', 'P1-D 超出该单剩余可出 → 400 且提示剩余数（总可用更大也不挪用）', async () => {
    await arriveVia(p1MatId, 4); // 已到 10，总可用 7（该单剩余仍 3）
    const r = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p1MatId, qty: 5, requisitionId: p1ReqId }] }
    });
    need(r.status === 400, '超剩余可出应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(/超过该领料单剩余可出 3/.test(r.data.error), '文案应含剩余 3：' + r.data.error);
    const ok2 = needOk(await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p1MatId, qty: 3, requisitionId: p1ReqId }] }
    }), 'outbound create P1D 恰好用完');
    need(ok2.data.items[0].requisitionId === p1ReqId, '恰好等于剩余可出应成功');
    const r3 = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p1MatId, qty: 0.5, requisitionId: p1ReqId }] }
    });
    need(r3.status === 400 && /剩余可出 0/.test(r3.data.error), '用尽后再出应 400 剩余 0：' + brief(r3.data));
    return '总可用 7 · 该单剩余 3 → 5 拒 / 3 成功 / 再用尽拒';
  });

  await step('materials', 'P1-E 计划属他项目 / 作业日超范围 → 400', async () => {
    const planB = needOk(await api('POST', '/api/workPlans', {
      token,
      body: { name: 'ZT测试-P1E 他项目计划', planType: '周计划', project: '冒烟测试项目B', startDate: '2026-11-01 08:00:00', endDate: '2026-11-30 18:00:00', status: '未执行' }
    }), 'workPlans POST P1E').id;
    p1PlanBId = planB;
    const r1 = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, workPlanId: planB, items: [{ materialId: p1MatId, qty: 1 }] }
    });
    need(r1.status === 400, '他项目计划应 400，实际 ' + r1.status + ' ' + brief(r1.data));
    need(/不属于所选工程/.test(r1.data.error), '文案不符：' + r1.data.error);
    const r2 = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, workPlanId: p1PlanId, workDate: '2026-12-15', items: [{ materialId: p1MatId, qty: 1 }] }
    });
    need(r2.status === 400 && /晚于计划结束日期/.test(r2.data.error), '作业日晚于结束应 400：' + brief(r2.data));
    const r3 = await api('POST', '/api/materialOutbound/create', {
      token,
      body: { project: MP_C, workerId: smokeWorker.id, workPlanId: p1PlanId, workDate: '2026-10-15', items: [{ materialId: p1MatId, qty: 1 }] }
    });
    need(r3.status === 400 && /早于计划开始日期/.test(r3.data.error), '作业日早于开始应 400：' + brief(r3.data));
    return '他项目计划 400 · 越界前/后各 400';
  });

  await step('materials', 'P1-F 归还 1 → usage 回落 2；作废 → 0，反查仍含作废单', async () => {
    needOk(await api('PUT', '/api/materialOutbound/' + p1OutId + '/return', {
      token, body: { rows: [{ materialId: p1MatId, qty: 1 }] }
    }), 'outbound return P1F');
    let usage = needOk(await api('GET', '/api/workPlans/' + p1PlanId + '/material-usage', { token }), 'usage P1F 1');
    let u = usage.find(x => x.code === 'ZT-P1A');
    need(u && u.net === 2, '归还 1 后净额应 2，实际 ' + brief(u));
    needOk(await api('PUT', '/api/materialOutbound/' + p1OutId + '/void', { token, body: { reason: 'ZT测试-P1F 作废' } }), 'outbound void P1F');
    usage = needOk(await api('GET', '/api/workPlans/' + p1PlanId + '/material-usage', { token }), 'usage P1F 2');
    u = usage.find(x => x.code === 'ZT-P1A');
    need(!u || u.net === 0, '作废后净额应 0，实际 ' + brief(u));
    const rev = needOk(await api('GET', '/api/materialRequisitions/' + p1ReqId + '/outbounds', { token }), 'req outbounds P1F');
    need(rev.some(o => o.id === p1OutId && o.status === '已作废'), '反查应含已作废单并带状态');
    return '归还 → 净 2 · 作废 → 净 0 · 反查含作废';
  });

  await step('materials', 'P1 可选性回归：不带任何关联字段出库 → 照旧成功且字段为空', async () => {
    const ob = needOk(await api('POST', '/api/materialOutbound/create', {
      token, body: { project: MP_C, workerId: smokeWorker.id, items: [{ materialId: p1MatId, qty: 1 }] }
    }), 'outbound create P1 plain');
    need(!ob.data.workPlanId && !ob.data.workDate && !ob.data.processName, '未传时单头关联应为空：' + brief(ob.data));
    need(ob.data.items[0].requisitionId === '' && ob.data.items[0].reqNo === '', '未传来源领料单时应为空：' + brief(ob.data.items[0]));
    return '空关联成功 · 字段为空';
  });

  // P1 用例自建的计划用完即软删：这些计划的日期带时分，回灌判重键（planType+project+name+startDate）
  // 与导出的日期列往返不一致，会污染后面的「周计划导出 → 回灌判重」用例（既有行为，本批不改）
  await step('materials', 'P1 收尾：软删本段自建计划，避免污染计划导出回灌判重', async () => {
    for (const id of [p1PlanId, p1PlanBId]) {
      if (!id) continue;
      needOk(await api('DELETE', '/api/workPlans/' + id, { token }), 'plan delete ' + id);
    }
    const list = await listOk('/api/workPlans', token);
    need(!list.some(p => p.id === p1PlanId) && !list.some(p => p.id === p1PlanBId), '软删后计划不应再出现在列表');
    return '2 条测试计划已软删';
  });

  await step('materials', 'P1.1 前端：出库弹窗三个可选输入 + 明细行无来源领料单 + 详情只读展示', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/v-model="dlg\.workPlanId"[\s\S]{0,200}planOptions/.test(src), '弹窗应有计划下拉并绑定候选');
    need(/v-model="dlg\.workDate"[\s\S]{0,120}value-format="YYYY-MM-DD"/.test(src), '弹窗应有作业日（YYYY-MM-DD）');
    need(/v-model="dlg\.processName"/.test(src), '弹窗应有工序输入');
    need(!/v-model="row\.requisitionId"/.test(src) && !/reqOptionsOf/.test(src), '明细行不应再有来源领料单下拉');
    need(!/requisitionId: r\.requisitionId \|\| ''/.test(src), '提交不应再组装行级 requisitionId');
    need(/关联计划：\{\{ od\.rec\.workPlanName/.test(src) && /作业日：\{\{ od\.rec\.workDate/.test(src), '出库单详情应只读展示关联字段');
    need(!/label="来源领料单"/.test(src), '出库单详情不应再有「来源领料单」列');
    need((src.match(/<col style="width:/g) || []).length === 7, '详情明细表应为七列固定比例');
    need(/text-align:right">出库</.test(src) && /text-align:right">归还</.test(src) && /text-align:right">未归还</.test(src), '详情数量列表头应为精简后的 出库/归还/未归还');
    need(/table-layout:fixed/.test(src), '详情明细表应为固定布局（不横向滚动）');
    return '计划/作业日/工序 + 行级来源领料单已撤 + 详情只读 · 七列固定布局';
  });

  /* ---------- P3 小项组 ---------- */
  await step('materials', 'P3-1 inWeeklyPlan 默认不计入：新增 / 导入缺省 false，显式勾选 true，编辑不改原值', async () => {
    const m1 = needOk(await api('POST', '/api/materials', {
      token, body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P31 默认不计入', qtyRequired: 2, unit: '个', code: 'ZT-P31-A' }
    }), 'materials POST P31 缺省');
    need(m1.inWeeklyPlan === false, '新增缺省应 false，实际 ' + m1.inWeeklyPlan);
    const m2 = needOk(await api('POST', '/api/materials', {
      token, body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P31 显式计入', qtyRequired: 2, unit: '个', code: 'ZT-P31-B', inWeeklyPlan: true }
    }), 'materials POST P31 显式');
    need(m2.inWeeklyPlan === true, '显式勾选应 true，实际 ' + m2.inWeeklyPlan);
    const edited = needOk(await api('PUT', '/api/materials/' + m2.id, {
      token, body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P31 显式计入（改名）', qtyRequired: 2, unit: '个', code: 'ZT-P31-B' }
    }), 'materials PUT P31');
    need(edited.inWeeklyPlan === true, '编辑不应把已计入改回 false，实际 ' + edited.inWeeklyPlan);
    return '缺省 false · 显式 true · 编辑保留';
  });

  await step('materials', 'P3-2/P3-3 前端：勾选自动填可用库存、取消清空、未填拦截；暂存框精度 4', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/outQty\[r\.id\] = Number\(r\.available\) \|\| 0/.test(src), '勾选应自动填该行可用库存');
    need(/prev\.forEach\(id => \{ if \(!now\[id\]\) delete outQty\[id\]/.test(src), '取消勾选应清空该行数量');
    need(/请填写出库数量/.test(src), '未填数量应提示「请填写出库数量」');
    need(/stagingQty\[row\.id\][\s\S]{0,120}:precision="4"/.test(src), '暂存数量框应支持 4 位小数');
    return '自动填量 · 取消清空 · 未填拦截 · 暂存 precision=4';
  });

  await step('materials', 'P3-3 暂存小数：0.5 生成领料单成功并落库 0.5', async () => {
    const m = needOk(await api('POST', '/api/materials', {
      token, body: { project: MP_C, source: '甲供材料', description: 'ZT测试-P33 暂存小数', qtyRequired: 2, unit: '根', code: 'ZT-P33' }
    }), 'materials POST P33');
    const d = needOk(await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 0.5 }] } }), 'requisition create P33');
    const row = (d.data.items || []).find(x => x.materialId === m.id);
    need(row && row.qty === 0.5, '领料数量应落 0.5，实际 ' + (row && row.qty));
    return '0.5 生成成功 · 落库 0.5';
  });

  await step('materials', 'P3-4 领料单导出标题按项目动态生成（substation → 企业名称 → 兜底）', async () => {
    const mkProj = async (name, substation) => needOk(await api('POST', '/api/projects', {
      token, body: { name, batch: '2026-11', substation, workType: '配网', category: '自有工程' }
    }), 'projects POST ' + name);
    const p1 = await mkProj('ZT测试-P34 有供电所', 'ZT测试供电所甲');
    const p0 = await mkProj('ZT测试-P34 无供电所', '');
    const settings = needOk(await api('GET', '/api/settings', { token }), 'settings');
    const comp = String((settings && settings.companyName) || '').trim();
    const mk = async (proj, code) => {
      const m = needOk(await api('POST', '/api/materials', {
        token, body: { project: proj, source: '甲供材料', description: 'ZT测试-P34 物料', qtyRequired: 2, unit: '个', code, orderNo: 'PO-ZT-P34' }
      }), 'materials POST ' + code);
      const rid = await mkReqOf(m.id, 1);
      return rid;
    };
    const readTitle = async (rid) => {
      const r = await fetch(base + '/api/materialRequisitions/' + rid + '/download', { headers: { Authorization: 'Bearer ' + token } });
      const buf = Buffer.from(await r.arrayBuffer());
      const wb2 = xlsx.read(buf, { type: 'buffer' });
      const ws2 = wb2.Sheets[wb2.SheetNames[0]];
      // 表头行按内容定位（P4-6 在标题与表头之间插了「领料日期」行，不能写死行号）
      const aoa = xlsx.utils.sheet_to_json(ws2, { header: 1, blankrows: false, defval: '' });
      const hi = aoa.findIndex(x => String(x[0]) === '序号');
      const remark = (hi >= 0 && aoa[hi + 1]) ? String(aoa[hi + 1][6] || '') : '';
      return {
        title: String((ws2.A1 || {}).v || ''),
        head: hi >= 0 ? aoa[hi].join('|') : '',
        remark: remark   // 备注列（第 7 列）应仍为采购订单号
      };
    };
    const t1 = await readTitle(await mk(p1.name, 'ZT-P34-A'));
    need(t1.title === 'ZT测试供电所甲过渡仓代保管物资领料单', '标题应含项目 substation：' + t1.title);
    need(!/国网富顺县供电公司/.test(t1.title), '标题不应再含写死单位：' + t1.title);
    need(t1.remark === 'PO-ZT-P34', '备注栏应仍为采购订单号，实际 ' + t1.remark);
    const t0 = await readTitle(await mk(p0.name, 'ZT-P34-B'));
    const exp0 = (comp ? comp + '过渡仓代保管物资领料单' : '物资领料单');
    need(t0.title === exp0, '无 substation 应回落企业名称「' + exp0 + '」，实际 ' + t0.title);
    return 'substation 优先 · 回落企业名称 · 备注仍为订单号';
  });

  await step('materials', 'P3-5 时间展示统一：带 Z 转北京时间、无时区按北京时间，无 8 小时偏差', async () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const f = sandbox.window.fmtBizTime;
    need(typeof f === 'function', 'window.fmtBizTime 未导出');
    const cases = [
      ['2026-10-22T08:49:15.045Z', '2026-10-22 16:49:15'],
      ['2026-11-11 09:37', '2026-11-11 09:37:00'],
      ['2026-11-11T09:37', '2026-11-11 09:37:00'],
      ['2026-11-11T09:37:00+08:00', '2026-11-11 09:37:00'],
      ['2026-11-11', '2026-11-11 00:00:00'],
      ['', '']
    ];
    cases.forEach(([inp, exp]) => {
      const got = f(inp);
      need(got === exp, '「' + inp + '」应为 ' + exp + '，实际 ' + got);
    });
    // 同一列表口径一致：带 Z 与无时区两类时间都输出 19 位
    need(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(f('2026-10-22T08:49:15.045Z')), '带 Z 应输出 19 位');
    return '6 组样本一致（无 8 小时偏差）';
  });

  await step('materials', 'P3-6 已入库单再次确认 → 400「该领料单已入库，不能重复入库」', async () => {
    const r = await api('PUT', '/api/materialRequisitions/' + p1ReqId + '/confirm', { token, body: { rows: [] } });
    need(r.status === 400, '应 400，实际 ' + r.status + ' ' + brief(r.data));
    need(r.data.error === '该领料单已入库，不能重复入库', '文案不符：' + r.data.error);
    const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'materials.js'), 'utf8');
    need(!/'该领料单已' \+/.test(src), '不应再有「已」+状态 的重复拼接');
    return '文案正确 · 无「已已」拼接';
  });

  await step('materials', 'P3-7 项目重复 id 只读诊断：非超管 403；无重复 id 的副本返回空', async () => {
    const lg = needOk(await api('POST', '/api/login', { body: { username: 'smoke_cly', password: 'Smoke@2026' } }), 'login cly');
    const r = await api('GET', '/api/projects/audit/duplicate-ids', { token: lg.token });
    need(r.status === 403, '非超管应 403，实际 ' + r.status + ' ' + brief(r.data));
    need(/仅超级用户/.test(r.data.error), '文案不符：' + r.data.error);
    const res = needOk(await api('GET', '/api/projects/audit/duplicate-ids', { token }), 'audit duplicate-ids');
    need(res && Array.isArray(res.data), '响应应为 { data: [] }：' + brief(res));
    need(res.data.length === 0, '本副本无重复 id，应返回空：' + brief(res.data.map(x => x.id)));
    need(res.total === 0, 'total 应为 0，实际 ' + res.total);
    return '403（非超管） · 干净副本返回空';
  });

  /* ---------- P0-4 存量不一致只读检测（接口与权限） ---------- */
  await step('materials', 'P0-4 权限：非超管 GET 检测 → 403（与删除导入批次同口径）', async () => {
    const lg = needOk(await api('POST', '/api/login', { body: { username: 'smoke_cly', password: 'Smoke@2026' } }), 'login cly');
    const r = await api('GET', '/api/materials/audit/inconsistencies?project=' + encodeURIComponent(MP_C), { token: lg.token });
    need(r.status === 403, '应 403，实际 ' + r.status + ' ' + brief(r.data));
    need(/仅超级用户/.test(r.data.error), '文案不符：' + r.data.error);
    return '403 · 仅超级用户';
  });

  await step('materials', 'P0-4-B 干净项目 → 该项目下结果为空', async () => {
    const cleanProject = 'ZT测试-干净检测项目';
    needOk(await api('POST', '/api/projects', { token, body: { name: cleanProject, batch: '2026-11', substation: '冒烟供电所', workType: '配网', category: '自有工程' } }), 'projects POST clean');
    const m = needOk(await api('POST', '/api/materials', {
      token, body: { project: cleanProject, source: '甲供材料', description: 'ZT测试-干净物料', qtyRequired: 5, unit: '个', code: 'ZT-CLEAN-01', orderNo: 'PO-ZT-CLEAN' }
    }), 'materials POST clean');
    const rows = needOk(await api('GET', '/api/materials/audit/inconsistencies?project=' + encodeURIComponent(cleanProject), { token }), 'audit clean');
    need(Array.isArray(rows), '检测应返回数组：' + brief(rows));
    need(rows.length === 0, '干净项目不应有检出，实际 ' + brief(rows));
    // 该项目只有这一条材料，且未到货、无出库、无领料
    const one = needOk(await api('GET', '/api/materials/' + m.id, { token }), 'material clean');
    need(one.qtyArrived === 0, '干净物料已到应为 0');
    return '0 条检出';
  });

  /* ---------- 计划编号（纯函数与前端共用） ---------- */
  const planNo = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'plan-no.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.PlanNo;
  })();

  /* ---------- 月计划判重口径（纯函数与前端共用） ---------- */
  const monthCalc = (() => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'monthPlans.js'), 'utf8');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox.window.MonthPlanCalc;
  })();

  await step('plans', '编号规则：勘察按月取最大流水 +1，跨月归零', async () => {
    const ym = '202610';
    const plans = [
      { surveyNo: '202610001' }, { surveyNo: '202610004' }, { surveyNo: ' 202610007 ' },
      { surveyNo: '202609009' }, { surveyNo: '202611002' }, { surveyNo: '20261001' }, { surveyNo: '' }
    ];
    need(planNo.nextSurveyNo(plans, ym) === '202610008', '当月最大 007 → 应为 202610008，实际 ' + planNo.nextSurveyNo(plans, ym));
    need(planNo.nextSurveyNo(plans, '202612') === '202612001', '跨月应归零到 001，实际 ' + planNo.nextSurveyNo(plans, '202612'));
    need(planNo.nextSurveyNo([], ym) === '202610001', '无记录时应为 001');
    return `202610 → ${planNo.nextSurveyNo(plans, ym)} · 202612 → 202612001`;
  });

  await step('plans', '编号规则：工作票按类型各走各的流水（不同类型各出 001）', async () => {
    const ym = '202610';
    const T = planNo.TICKET_TYPES;
    need(T.length === 5, '工作票类型应为 5 种，实际 ' + T.length);
    need(Object.keys(planNo.TICKET_NO_CODE).length === 5, '类型码应为 5 条');
    const plans = [
      { ticketType: T[0], workTicketNo: '20261068001' },
      { ticketType: T[0], workTicketNo: '20261068002' },
      { ticketType: T[3], workTicketNo: '20261067001' },
      { ticketType: T[1], workTicketNo: '20260978005' }   // 上个月的不算
    ];
    need(planNo.nextTicketNo(plans, ym, T[0]) === '20261068003', '配电第一种应 68003，实际 ' + planNo.nextTicketNo(plans, ym, T[0]));
    need(planNo.nextTicketNo(plans, ym, T[3]) === '20261067002', '线路第一种应独立算 67002，实际 ' + planNo.nextTicketNo(plans, ym, T[3]));
    need(planNo.nextTicketNo(plans, ym, T[1]) === '20261078001', '配电第二种当月无记录应 78001，实际 ' + planNo.nextTicketNo(plans, ym, T[1]));
    need(planNo.nextTicketNo(plans, ym, T[2]) === '20261098001', '配电低压应 98001');
    need(planNo.nextTicketNo(plans, ym, T[4]) === '20261077001', '线路第二种应 77001');
    need(planNo.nextTicketNo(plans, ym, '未映射的类型') === ym, '映射表外应只带年月');
    return T.map(t => planNo.TICKET_NO_CODE[t] + '→' + planNo.nextTicketNo(plans, ym, t)).join(' ');
  });

  await step('plans', '编号规则：格式不符的手填编号不干扰解析', async () => {
    const ym = '202610';
    const plans = [
      { surveyNo: '202610003' },
      { surveyNo: '2026100' }, { surveyNo: '2026100003' }, { surveyNo: 'ABC' }, { surveyNo: '20261000X' }, { surveyNo: null },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '20261068005' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '20261068' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '2026106800X' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '202610680005' },
      { ticketType: '配电：配电第一种工作票', workTicketNo: '' }
    ];
    need(planNo.nextSurveyNo(plans, ym) === '202610004', '勘察应为 004，实际 ' + planNo.nextSurveyNo(plans, ym));
    need(planNo.nextTicketNo(plans, ym, '配电：配电第一种工作票') === '20261068006', '工作票应为 68006，实际 ' + planNo.nextTicketNo(plans, ym, '配电：配电第一种工作票'));
    return '脏编号被忽略：勘察 → 202610004、工作票 → 20261068006';
  });

  /* ---------- plans / borrow ---------- */
  await step('plans', '计划列表 GET /api/plans', async () => listOk('/api/plans', token).then(d => d.length + ' 条'));
  await step('plans', '作业计划 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/workPlans', {
      token, body: { project: '冒烟测试项目', workType: '立杆', planStart: '2026-10-24 08:00:00', planEnd: '2026-10-24 18:00:00', status: '未开始' }
    }), 'workPlans POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/workPlans/' + d.id, { token }), 'workPlans detail');
    need(one.project === '冒烟测试项目', 'detail.project 不匹配');
    return 'id=' + d.id;
  });
  await step('plans', '月计划 CRUD 与状态流转（22 字段往返，流转只改 status）', async () => {
    const body = {
      planType: '月计划', status: '未执行', name: '10kV冒烟线01号杆', areaStation: '冒烟供电所',
      opsUnit: '冒烟运维中心', maintUnit: '冒烟检修单位', project: '冒烟工程', projectName: '冒烟工程项目',
      maintDevice: '10kV冒烟线01号杆', voltage: '10kV', deviceType: '配网主线',
      outageStart: '2026-11-11 08:00:00', outageEnd: '2026-11-11 16:00:00',
      workTime: '11月11日-11月11日08:30-15:30', workType: '配农网工程',
      maintContent: '更换绝缘子', affectArea: '冒烟村 1-3 组', transformerCount: '12', outageHouseholds: 96,
      importantUsers: '无', gridRisk: '三级', riskLevel: 'IV', outageCount2m: '1', outageCountYear: '4',
      planNote: '冒烟备注', leader: '小王',
      startDate: '2026-11-11 08:00:00', endDate: '2026-11-11 16:00:00'
    };
    const d = needOk(await api('POST', '/api/workPlans', { token, body }), 'workPlans POST 月计划');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/workPlans/' + d.id, { token }), '月计划详情');
    need(one.planType === '月计划', 'planType 未保存：' + one.planType);
    ['opsUnit', 'maintUnit', 'project', 'projectName', 'maintDevice', 'voltage', 'deviceType', 'outageStart', 'outageEnd',
      'workTime', 'workType', 'maintContent', 'affectArea', 'transformerCount', 'importantUsers', 'gridRisk', 'riskLevel',
      'outageCount2m', 'outageCountYear', 'planNote', 'leader'].forEach(k => {
      need(String(one[k]) === String(body[k]), k + ' 未保存：' + one[k]);
    });
    for (const st of ['已执行', '已结算', '未执行']) {
      needOk(await api('PUT', '/api/workPlans/' + d.id, { token, body: { status: st } }), '状态流转 → ' + st);
      const cur = needOk(await api('GET', '/api/workPlans/' + d.id, { token }), '流转后详情');
      need(cur.status === st, '状态应为 ' + st + '，实为 ' + cur.status);
      need(cur.maintDevice === body.maintDevice && cur.outageStart === body.outageStart, '状态流转改动了其他字段');
    }
    needOk(await api('DELETE', '/api/workPlans/' + d.id, { token }), '删除月计划');
    return '22 字段往返 + 新增 → 已执行 → 已结算 → 未执行 → 删除';
  });

  await step('plans', '月计划表单联动：工作时间同月/跨月生成 + 停电时户数', async () => {
    const same = monthCalc.genWorkTime('2026-11-11 08:00:00', '2026-11-11 16:00:00');
    need(same === '11月11日-11月11日08:30-15:30', '同月生成错：' + same);
    const cross = monthCalc.genWorkTime('2026-10-31 22:00:00', '2026-11-01 06:00:00');
    need(cross === '10月31日-11月1日22:30-05:30', '跨月生成错：' + cross);
    const months = (cross.match(/(\d+)月/g) || []).map(x => Number(x.replace('月', '')));
    need(months.length === 2 && months.every(m => m >= 1 && m <= 12), '跨月拼出非法月份：' + cross + ' → ' + months.join(','));
    need(monthCalc.hours('2026-11-11 08:00', '2026-11-11 16:00') === 8, '时长应为 8 小时');
    need(monthCalc.households(12, '2026-11-11 08:00', '2026-11-11 16:00') === 96, '时户数应为 96');
    need(monthCalc.households(3, '2026-11-11 08:00', '2026-11-11 11:30') === 11, '3×3.5 → 11（四舍五入）');
    need(monthCalc.households('', '2026-11-11 08:00', '2026-11-11 16:00') === '', '配变数为空应存空');
    return same + ' / ' + cross + ' / 96';
  });

  await step('plans', '月计划模板：停电时间文本解析 + 导出（主网/配网两张子表、20 列）', async () => {
    const p1 = monthCalc.parseOutageText('11月1日00:00-11月30日02:00', '2026');
    need(p1 && p1.start === '2026-11-01 00:00:00' && p1.end === '2026-11-30 02:00:00', '连续停电解析错：' + JSON.stringify(p1));
    const p2 = monthCalc.parseOutageText('11月11日08:00-16:00', '2026');
    need(p2 && p2.start === '2026-11-11 08:00:00' && p2.end === '2026-11-11 16:00:00', '同日解析错：' + JSON.stringify(p2));
    const p3 = monthCalc.parseOutageText('11月1日-11月30日19:27-21:27（白停夜送）', '2026');
    need(p3 && p3.start === '2026-11-01 19:27:00' && p3.end === '2026-11-30 21:27:00', '白停夜送解析错：' + JSON.stringify(p3));
    need(monthCalc.parseOutageText('乱写一段', '2026') === null, '无法识别时应返回 null');

    const body = {
      planType: '月计划', status: '未执行', name: '模板导出线', maintDevice: '10kV模板线01号杆',
      deviceType: '配网支线', voltage: '10kV', workType: '配农网工程',
      outageStart: '2026-11-03 00:00:00', outageEnd: '2026-11-05 02:00:00',
      workTime: '11月3日-11月5日00:30-01:30', transformerCount: '5', outageHouseholds: '10', planNote: '模板回归'
    };
    const created = needOk(await api('POST', '/api/workPlans', { token, body }), '模板导出用月计划 POST');
    try {
      const res = await fetch(base + '/api/workPlans/month-plan.xlsx?ids=' + created.id + '&year=2026&month=11',
        { headers: { Authorization: 'Bearer ' + token } });
      need(res.ok, '导出接口应 200，实际 ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      need(buf.slice(0, 2).toString() === 'PK', '导出文件应为 xlsx（zip 头）');
      const wb = xlsx.read(buf, { type: 'buffer' });
      need(wb.SheetNames.join(',') === '主网,配网', '子表应为 主网/配网，实际 ' + wb.SheetNames.join(','));
      const aoa = xlsx.utils.sheet_to_json(wb.Sheets['配网'], { header: 1, defval: '', raw: false });
      need(String(aoa[0][0]).includes('配电设备检修计划（配网）'), '标题行不对：' + aoa[0][0]);
      const head = (aoa[1] || []).map(v => String(v));
      need(head[0] === '序号' && head[7] === '计划停电时间' && head[9] === '检修类型' && head[19] === '备注',
        '表头 20 列不对：' + head.join('|'));
      need(String(aoa[2][0]).includes('总体上按时间排序'), '说明行缺失：' + aoa[2][0]);
      need(String(aoa[3][0]) === '1' && String(aoa[3][7]) === '11月3日00:00-11月5日02:00',
        '数据行不对：' + JSON.stringify((aoa[3] || []).slice(0, 8)));
      return '标题/20列表头/说明行/数据行 OK → ' + aoa[3][7];
    } finally {
      await api('DELETE', '/api/workPlans/' + created.id, { token });
    }
  });

  await step('plans', '月计划必填校验（4 项必填 + 结束不得早于开始）', async () => {
    const empty = monthCalc.validate({});
    need(empty.maintDevice === '请填写检修设备', '检修设备必填未拦下');
    need(empty.workType === '请选择检修类型', '检修类型必填未拦下');
    need(empty.outageStart === '请选择计划停电开始时间', '停电开始必填未拦下');
    need(empty.outageEnd === '请选择计划停电结束时间', '停电结束必填未拦下');
    const back = monthCalc.validate({
      maintDevice: 'X', workType: '配农网工程',
      outageStart: '2026-11-11 16:00:00', outageEnd: '2026-11-11 08:00:00'
    });
    need(back.outageEnd === '计划停电结束时间不能早于开始时间', '结束早于开始未拦下：' + back.outageEnd);
    const same = monthCalc.validate({
      maintDevice: 'X', workType: '配农网工程',
      outageStart: '2026-11-11 16:00:00', outageEnd: '2026-11-11 16:00:00'
    });
    need(same.outageEnd === '', '结束等于开始应允许（≥），实为：' + same.outageEnd);
    const pass = monthCalc.validate({
      maintDevice: 'X', workType: '配农网工程',
      outageStart: '2026-11-11 08:00:00', outageEnd: '2026-11-11 16:00:00'
    });
    need(Object.values(pass).every(v => !v), '合法表单不应报错');
    return '4 项必填 + 时序校验 OK';
  });

  await step('plans', '月计划导入判重口径（设备+停电开始；含已入库与文件内自重复）', async () => {
    const existing = [
      { maintDevice: 'A', outageStart: '2026-11-01 08:00:00' },
      { maintDevice: 'B', outageStart: '2026-11-02 09:00:00' },
      { maintDevice: 'E', outageStart: '2027-02-01 08:00:00' }
    ];
    const parsed = [
      { maintDevice: 'A', outageStart: '2026-11-01 08:00:00', __row: 2 },
      { maintDevice: 'C', outageStart: '2026-11-03 08:00:00', __row: 3 },
      { maintDevice: 'C', outageStart: '2026-11-03 08:00:00', __row: 4 },
      { maintDevice: 'A', outageStart: '2026-11-01 09:00:00', __row: 5 },
      { maintDevice: 'E', outageStart: '2027-02-01 08:00:00', __row: 6 }
    ];
    monthCalc.judge(parsed, existing, '2026');
    need(parsed[0].verdict === '疑似重复（与已入库第 1 条撞键）', '已入库撞键判定错：' + parsed[0].verdict);
    need(parsed[1].verdict === '新增', '首条不应判重：' + parsed[1].verdict);
    need(parsed[2].verdict === '疑似重复（与本文件第 3 行重复）', '文件内自重复判定错：' + parsed[2].verdict);
    need(parsed[3].verdict === '新增', '停电开始不同不应判重：' + parsed[3].verdict);
    need(parsed[4].verdict === '新增', '跨导入年份不应判重：' + parsed[4].verdict);
    return '已入库 1 / 新增 3 / 自重复 1';
  });

  await step('plans', '周计划导入模板下载 GET /api/workPlans/import-template', async () => {
    const r = await fetch(base + '/api/workPlans/import-template', { headers: { Authorization: 'Bearer ' + token } });
    need(r.status === 200, '状态码 ' + r.status);
    need(/spreadsheetml\.sheet/.test(r.headers.get('content-type') || ''), 'Content-Type 非 xlsx');
    const buf = Buffer.from(await r.arrayBuffer());
    const local = fs.readFileSync(path.join(ROOT, 'assets', 'plan-import-template.xlsx'));
    need(buf.length === local.length, '长度 ' + buf.length + ' ≠ 入仓原件 ' + local.length);
    need(buf.slice(0, 2).toString() === 'PK', '不是 xlsx（zip）文件');
    return buf.length + 'B';
  });
  await step('plans', '周计划导出 GET /api/workPlans/export（48 列 / 两行表头 / 41 合并 / 下拉选项）', async () => {
    const r = await fetch(base + '/api/workPlans/export', { headers: { Authorization: 'Bearer ' + token } });
    need(r.status === 200, '状态码 ' + r.status);
    need(/spreadsheetml\.sheet/.test(r.headers.get('content-type') || ''), 'Content-Type 非 xlsx');
    const buf = Buffer.from(await r.arrayBuffer());
    const wb = xlsx.read(buf, { type: 'buffer' });
    need(wb.SheetNames.length === 1 && wb.SheetNames[0] === 'Sheet1', 'sheet 名应为 Sheet1，实为 ' + wb.SheetNames.join(','));
    const ws = wb.Sheets.Sheet1;
    need(ws['!ref'] && xlsx.utils.decode_range(ws['!ref']).e.c + 1 === 48, '列数应为 48，实为 ' + (ws['!ref'] ? xlsx.utils.decode_range(ws['!ref']).e.c + 1 : '空'));
    need(Array.isArray(ws['!merges']) && ws['!merges'].length === 41, '合并区域应为 41 个，实为 ' + (ws['!merges'] ? ws['!merges'].length : 0));
    need(String(ws.A1.v) === '序号' && String(ws.AN1.v) === '当日计划工作量' && String(ws.AN2.v) === '杆塔（基）', '表头文字不符');
    const rows = xlsx.utils.decode_range(ws['!ref']).e.r + 1;
    const sheetXml = (unzipEntry(buf, 'xl/worksheets/sheet1.xml') || Buffer.from('')).toString();
    const dvCount = (sheetXml.match(/<dataValidation /g) || []).length;
    need(dvCount === 7, '下拉校验应为 7 处（与原表一致），实为 ' + dvCount);
    need(/sqref="H3:H1048576"/.test(sheetXml) && /35kV,10kV,0\.4kV/.test(sheetXml), '电压等级下拉与原表不一致');
    // 口径：scope 页签过滤（临时库无月计划 → scope=month 应为 0 条，未带 scope 至少 1 条）
    const r3 = await fetch(base + '/api/workPlans/export?scope=month', { headers: { Authorization: 'Bearer ' + token } });
    const wb3 = xlsx.read(Buffer.from(await r3.arrayBuffer()), { type: 'buffer' });
    const rows3 = xlsx.utils.decode_range(wb3.Sheets.Sheet1['!ref']).e.r + 1;
    need(rows3 === 2, 'scope=month 应为 0 条数据行，实为 ' + (rows3 - 2));
    need(rows - 2 >= 1, '不带 scope 时应导出全部，实为 ' + (rows - 2));
    return '48 列 / 41 合并 / ' + rows + ' 行 / 下拉 ' + dvCount + ' 处 / scope 过滤 OK / ' + buf.length + 'B';
  });
  await step('plans', '周计划导出 → 回灌判重 + 48 列单行表头模板落位', async () => {
    // 先造一条字段齐全的计划，保证往返有可比对的数据
    const mk = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟回灌计划', planType: '周计划', workType: '配农网工程', team: '施工一队', startDate: '2026-11-02 08:00:00', endDate: '2026-11-03 18:00:00', staffText: '张三/13800000000', voltage: '10kV' }
    }), 'plan POST');
    need(mk && mk.id, '响应缺少 id');
    const r = await fetch(base + '/api/workPlans/export?scope=week', { headers: { Authorization: 'Bearer ' + token } });
    const buf = Buffer.from(await r.arrayBuffer());
    const total = xlsx.utils.decode_range(xlsx.read(buf, { type: 'buffer' }).Sheets.Sheet1['!ref']).e.r + 1;
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'roundtrip.xlsx');
    const up = await fetch(base + '/api/workPlans/import?planType=' + encodeURIComponent('周计划'), { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(15000) });
    const d = await up.json();
    need(up.status === 200 && d && d.ok, '往返导入失败：' + brief(d));
    // 判重后回灌行应全部跳过，且不改动已有记录
    need(d.added === 0 && d.skipped === total - 2,
      '判重应跳过全部 ' + (total - 2) + ' 条回灌行：' + brief(d));
    const again = needOk(await api('GET', '/api/workPlans', { token }), 'list');
    const hit = (Array.isArray(again) ? again : (again.data || [])).filter(p => p.name === '冒烟回灌计划' && !p.deleted);
    need(hit.length === 1 && hit[0].id === mk.id, '判重后不应新增同名计划，实为 ' + hit.length + ' 条');
    const a = hit[0];
    need(a && a.team === '施工一队' && a.startDate === '2026-11-02 08:00:00' && a.staffText === '张三/13800000000',
      '判重跳过后原记录字段被改动：' + brief(a));
    // 内置导入模板已改为 48 列单行表头（与导出逐列同名同序），按表头名称取列验证不错位
    const tplWb = xlsx.read(fs.readFileSync(path.join(ROOT, 'assets', 'plan-import-template.xlsx')), { type: 'buffer' });
    const ts = tplWb.Sheets[tplWb.SheetNames[0]];
    const rng = xlsx.utils.decode_range(ts['!ref']);
    const findCol = nm => {
      for (let R = 0; R <= 1; R++) for (let C = 0; C <= rng.e.c; C++) {
        const c = ts[xlsx.utils.encode_cell({ r: R, c: C })];
        if (c && String(c.v).trim() === nm) return C;
      }
      return -1;
    };
    const put = (nm, v) => {
      const C = findCol(nm);
      need(C >= 0, '模板缺少列：' + nm);
      ts[xlsx.utils.encode_cell({ r: 2, c: C })] = { t: 's', v: String(v) };
    };
    put('作业计划名称', '冒烟模板列位计划'); put('作业类型', '配农网工程');
    put('计划开始时间', '2026-11-09 08'); put('计划结束时间', '2026-11-09 18');   // 只写到小时也应接受
    put('杆塔（基）', '9'); put('停电范围', '模板停电范围');
    put('作业实施（施工）人员（不包含工作负责人）', '甲/13000000001；乙/13000000002');
    put('作业人员（共多少人）', '9');   // 与名单人数冲突时，应以名单为准（导入按名单重算）
    ts['!ref'] = xlsx.utils.encode_range({ s: rng.s, e: { r: 2, c: rng.e.c } });   // 模板原本只有两行表头，写入行后要扩范围
    const tplOut = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(tplOut, ts, tplWb.SheetNames[0]);
    const tplBuf = xlsx.write(tplOut, { type: 'buffer', bookType: 'xlsx' });
    const fd2 = new FormData();
    fd2.append('file', new Blob([tplBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'tpl.xlsx');
    const up2 = await fetch(base + '/api/workPlans/import', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd2, signal: AbortSignal.timeout(15000) });
    const d2 = await up2.json();
    need(up2.status === 200 && d2 && d2.ok, '模板导入失败：' + brief(d2));
    const got = needOk(await api('GET', '/api/workPlans', { token }), 'list');
    const tp = (Array.isArray(got) ? got : (got.data || [])).find(p => p.name === '冒烟模板列位计划');
    need(tp && tp.wlPole === '9' && tp.outageRange === '模板停电范围',
      '48 列模板列位错位：' + brief(tp && { wlPole: tp.wlPole, outageRange: tp.outageRange }));
    need(tp.startDate === '2026-11-09 08:00:00' && tp.endDate === '2026-11-09 18:00:00',
      '只写到小时的时间未补全：' + brief({ s: tp.startDate, e: tp.endDate }));
    need(tp.staffCount === '2', '人数应按施工人员名单重算为 2，实为 ' + tp.staffCount);
    return '判重跳过回灌 ' + d.skipped + ' 条；48 列单行表头模板落位正确';
  });
  await step('plans', '施工资料图纸：上传 → 下载 → 删除（老记录无 drawings 不报错）', async () => {
    const p = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟图纸计划', planType: '周计划' } }), 'plan POST');
    need(p && p.id, '响应缺少 id');
    // 老记录（刚建、无 drawings 字段）详情不应报错
    const before = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'plan detail');
    need(!before.drawings || Array.isArray(before.drawings), 'drawings 应为数组或不存在');
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([png], { type: 'image/png' }), '冒烟图纸.png');
    const upRes = await fetch(base + '/api/workPlans/' + p.id + '/drawings', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(10000)
    });
    const dw = await upRes.json();
    need(upRes.status === 200 && dw && dw.id, '图纸上传失败：' + brief(dw));
    need(/^dw/.test(dw.id), '图纸 id 前缀应为 dw，实际 ' + brief(dw.id));
    need(dw.category === '图纸' && dw.name === '冒烟图纸.png', '类别/文件名不符：' + brief({ c: dw.category, n: dw.name }));
    need(dw.size === png.length, 'size 应为 ' + png.length + '，实际 ' + brief(dw.size));
    need(String(dw.path).startsWith('uploads/plans/' + p.id + '/'), 'path 不符：' + brief(dw.path));
    need(!!dw.uploadedAt, '缺少 uploadedAt');
    // 下载能拿回原字节
    const dl = await fetch(base + '/api/workPlans/' + p.id + '/drawings/' + dw.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl.status === 200, '下载期望 200，实际 ' + dl.status);
    const got = Buffer.from(await dl.arrayBuffer());
    need(got.length === png.length && got.equals(png), '下载内容与上传不一致');
    // 删除后记录消失、文件不可再下载
    needOk(await api('DELETE', '/api/workPlans/' + p.id + '/drawings/' + dw.id, { token }), 'drawings DELETE');
    const after = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'plan detail after');
    need(!(after.drawings || []).some(x => x.id === dw.id), '删除后 drawings 仍含该记录');
    const dl2 = await fetch(base + '/api/workPlans/' + p.id + '/drawings/' + dw.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl2.status === 404, '删除后下载应 404，实际 ' + dl2.status);
    return 'id=' + dw.id + ' size=' + dw.size + ' 删除后 404';
  });
  await step('plans', '施工资料压缩包：上传 → 替换 → 校验拒绝 → 下载 → 删除（单包 ≤1MB）', async () => {
    const p = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟压缩包计划', planType: '周计划' } }), 'plan POST');
    need(p && p.id, '响应缺少 id');
    const up = async (buf, filename) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf]), filename);
      const res = await fetch(base + '/api/workPlans/' + p.id + '/package', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(10000)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data };
    };
    // 1) zip 上传：记录形状
    const zip1 = Buffer.from('PK\u0003\u0004smoke-zip-one');
    const r1 = await up(zip1, '冒烟资料包.zip');
    need(r1.status === 200 && r1.data && r1.data.id, 'zip 上传失败：' + r1.status + ' ' + brief(r1.data));
    const pk = r1.data;
    need(/^pk/.test(pk.id), 'id 前缀应为 pk，实际 ' + brief(pk.id));
    need(pk.category === '资料压缩包', 'category 不符：' + brief(pk.category));
    need(pk.name === '冒烟资料包.zip', 'name 不符：' + brief(pk.name));
    need(pk.size === zip1.length, 'size 应为 ' + zip1.length + '，实际 ' + brief(pk.size));
    need(String(pk.path).startsWith('uploads/plans/' + p.id + '/'), 'path 不符：' + brief(pk.path));
    need(!!pk.uploadedAt, '缺少 uploadedAt');
    const abs1 = path.join(TMP, 'data', pk.path);
    need(fs.existsSync(abs1), '首次上传的文件应落盘：' + pk.path);
    // 2) 再传 .7Z（大写后缀也要认）→ 记录被替换、旧文件删除
    const seven = Buffer.from('7z\u00bc\u00af\u0027\u001csmoke-seven');
    const r2 = await up(seven, '冒烟资料包.7Z');
    need(r2.status === 200 && r2.data && r2.data.id, '7z 上传失败：' + r2.status + ' ' + brief(r2.data));
    need(r2.data.id !== pk.id, '替换后应返回新记录');
    need(r2.data.name === '冒烟资料包.7Z', '替换后 name 不符：' + brief(r2.data.name));
    need(!fs.existsSync(abs1), '替换后旧包文件应已删除');
    const abs2 = path.join(TMP, 'data', r2.data.path);
    need(fs.existsSync(abs2), '新包文件应存在：' + r2.data.path);
    const d2 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after replace');
    need(d2.materialPackage && d2.materialPackage.id === r2.data.id, '记录未指向新包');
    // 3) 下载拿到新文件字节
    const dl = await fetch(base + '/api/workPlans/' + p.id + '/package/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl.status === 200, '下载期望 200，实际 ' + dl.status);
    const got = Buffer.from(await dl.arrayBuffer());
    need(got.length === seven.length && got.equals(seven), '下载内容与上传不一致');
    // 4) 后缀不合规 → 400，旧包记录与文件逐字节不变
    const r3 = await up(Buffer.from('not a package'), '说明.txt');
    need(r3.status === 400, '.txt 期望 400，实际 ' + r3.status + ' ' + brief(r3.data));
    const d3 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after txt');
    need(d3.materialPackage && d3.materialPackage.id === r2.data.id, '.txt 被拒后记录被改动');
    need(fs.existsSync(abs2) && fs.readFileSync(abs2).equals(seven), '.txt 被拒后旧包文件变了');
    // 5) 超过 1MB → 400，旧包同样不变
    const big = Buffer.alloc(1024 * 1024 + 1, 0x41);
    const r4 = await up(big, '超大包.zip');
    need(r4.status === 400, '>1MB 期望 400，实际 ' + r4.status + ' ' + brief(r4.data));
    const d4 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after big');
    need(d4.materialPackage && d4.materialPackage.id === r2.data.id, '>1MB 被拒后记录被改动');
    need(fs.existsSync(abs2) && fs.readFileSync(abs2).equals(seven), '>1MB 被拒后旧包文件变了');
    // 6) 删除 → 记录置 null、文件删除、下载 404；无包再删 404
    needOk(await api('DELETE', '/api/workPlans/' + p.id + '/package', { token }), 'package DELETE');
    const d5 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after delete');
    need(d5.materialPackage === null, '删除后应置 null，实际 ' + brief(d5.materialPackage));
    need(!fs.existsSync(abs2), '删除后磁盘文件应已移除');
    const dl2 = await fetch(base + '/api/workPlans/' + p.id + '/package/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl2.status === 404, '删除后下载应 404，实际 ' + dl2.status);
    const del2 = await api('DELETE', '/api/workPlans/' + p.id + '/package', { token });
    need(del2.status === 404, '无包删除应 404，实际 ' + del2.status);
    return 'zip→' + pk.id + ' / 7z 替换→' + r2.data.id + '（旧文件已删）/ 400x2 旧包不变 / 删除后 404';
  });
  await step('plans', '现场勘察记录：分组/小组往返 → createdAt 稳定 → 非法 grouping 回落 → groups 截断 → 4.3 环境描述+危险点往返 → 4.4 措施/接地线/勘察日期+逐行归属 → 404', async () => {
    const p = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟勘察计划', planType: '周计划', content: '冒烟工作内容', outageRange: '冒烟停电范围', team: '施工一队', surveyNo: '202610900' }
    }), 'plan POST');
    const before = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail');
    need(before.survey === undefined || before.survey === null, '新建计划不应已有 survey');
    const G1 = { leader: '小张', members: ['小张', '小王'], workLocation: '1 号杆', workTask: '立杆' };
    const G2 = { leader: '小李', members: ['小李'], workLocation: '2 号杆', workTask: '放线' };
    const body1 = {
      grouping: '分2个小组', surveyUnit: ' 冒烟勘察单位 ',
      team: '施工一队', surveyNo: '202610900', dualName: '10kV 冒烟线 001 号杆',
      workLocation: '冒烟工作地点', workTask: '冒烟工作内容',
      outageScope: '冒烟停电范围', retainedLive: '冒烟带电部位',
      groups: [G1, G2]
    };
    const s1 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body1 }), 'survey PUT');
    need(s1 && s1.createdAt && s1.updatedAt, '保存结果缺少 createdAt/updatedAt');
    need(s1.grouping === '分2个小组', 'grouping 未保存：' + JSON.stringify(s1.grouping));
    need(s1.surveyUnit === '冒烟勘察单位', '勘察单位应去空白：' + JSON.stringify(s1.surveyUnit));
    need(s1.team === '施工一队' && s1.surveyNo === '202610900', '部门/编号未保存（本批起落库）');
    need(s1.workLocation === '冒烟工作地点' && s1.workTask === '冒烟工作内容', '工作地点/工作内容未保存');
    need(s1.outageScope === '冒烟停电范围' && s1.retainedLive === '冒烟带电部位', '4.1/4.2 未保存');
    need(Array.isArray(s1.groups) && s1.groups.length === 2, 'groups 应为 2 条，实际 ' + brief(s1.groups));
    need(JSON.stringify(s1.groups[0]) === JSON.stringify(G1) && JSON.stringify(s1.groups[1]) === JSON.stringify(G2), 'groups 往返不一致：' + brief(s1.groups));
    // 本批不预建 4.4 及以后的空字段（hazardPoints 未传也不建）
    ['opsMeasures', 'teamMeasures', 'commonMeasures', 'ground10', 'ground04', 'surveyDate', 'recorder', 'hazardPoints']
      .forEach(k => need(s1[k] === undefined, '不应预建空字段 ' + k));
    need(s1.envDesc === '', 'envDesc 属白名单字段，未传应为空串，实际 ' + JSON.stringify(s1.envDesc));
    const createdAt = s1.createdAt;
    const d1 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after survey');
    need(d1.survey && JSON.stringify(d1.survey.groups) === JSON.stringify(s1.groups), '重读计划时 groups 不一致');
    need(d1.survey.surveyNo === '202610900' && d1.survey.workLocation === '冒烟工作地点', '重读计划时字段丢失');
    // 本批口径：编辑器存的编号是「部门+编号」的完整编号，PUT 原样往返（服务端不重复拼前缀）；
    // 3.工作任务合并成一个框后，workLocation 一律提交空串 → 落库为空（旧值一次性并入 workTask）
    const fullNo = '施工一队202610900';
    const sFull = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body1, surveyNo: fullNo, workLocation: '' } }), '完整编号往返');
    need(sFull.surveyNo === fullNo, '完整编号应原样往返，实际 ' + JSON.stringify(sFull.surveyNo));
    need(sFull.workLocation === '', 'workLocation 传空串应落库为空，实际 ' + JSON.stringify(sFull.workLocation));
    // 勘察单位改为可筛选 + 自定义输入的下拉：选项清单外的自定义值必须原样往返、不被清洗
    const customUnit = '自定义勘察单位（选项里没有）/ 二分队';
    const sUnit = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body1, surveyUnit: customUnit } }), '自定义勘察单位往返');
    need(sUnit.surveyUnit === customUnit, '自定义勘察单位应原样保存，实际 ' + JSON.stringify(sUnit.surveyUnit));
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body1 }), '勘察单位回填');
    // 二次 PUT：改分组数与内容，createdAt 不变
    const G3 = { leader: '小赵', members: [], workLocation: '3 号杆', workTask: '紧线' };
    const body2 = { ...body1, grouping: '分3个小组', surveyUnit: '改后单位', groups: [G1, G2, G3] };
    const s2 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body2 }), 'survey PUT 2');
    need(s2.createdAt === createdAt, '二次保存 createdAt 应保持不变（' + createdAt + ' → ' + s2.createdAt + '）');
    need(s2.updatedAt >= createdAt, 'updatedAt 应刷新');
    need(s2.grouping === '分3个小组' && s2.groups.length === 3 && s2.surveyUnit === '改后单位', '二次保存内容不符');
    // grouping 非法值 → 回落「不分小组」
    const s3 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, grouping: '分5个小组' } }), 'grouping 非法');
    need(s3.grouping === '不分小组', '非法 grouping 应回落「不分小组」，实际 ' + JSON.stringify(s3.grouping));
    // groups 传 4 条 → 只保留前 3 条
    const s4 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, groups: [G1, G2, G3, { leader: '多余', members: ['多余'], workLocation: '4 号杆', workTask: '多余' }] } }), 'groups 截断');
    need(s4.groups.length === 3, 'groups 应截断到 3 条，实际 ' + s4.groups.length);
    need(JSON.stringify(s4.groups) === JSON.stringify([G1, G2, G3]), '截断后应是前 3 条：' + brief(s4.groups));
    // 4.4 及以后：显式传则更新；未传则沿用已存值（界面未开启，数据不能丢）
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, envDesc: '已存环境描述', recorder: '已存记录人' } }), '写入 4.3');
    const s5 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: body2 }), '不传 4.3');
    need(s5.envDesc === '', 'envDesc 未传应按空串处理（白名单字段），实际 ' + JSON.stringify(s5.envDesc));
    need(s5.recorder === '已存记录人', '未传的 4.4 字段应沿用旧值，实际 ' + brief(s5.recorder));
    // 4.3 危险点条目组：envDesc + hazardPoints 往返一致（去空白、scope 原样）
    const HP1 = { id: 'hz_a', hazardId: 'lib_1', title: ' 高空坠落风险 ', situation: ' 杆上作业 ', measure: ' 正确使用安全带 ', scope: '2小组' };
    const HP2 = { id: 'hz_b', hazardId: '', title: '自定义危险点', situation: '', measure: '自定义措施', scope: '全组' };
    const s6 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, envDesc: ' 现场有跨越，邻近 10kV 线路\n需停电 ', hazardPoints: [HP1, HP2] }
    }), '写入 4.3 危险点');
    need(s6.envDesc === '现场有跨越，邻近 10kV 线路\n需停电', 'envDesc 应去首尾空白并保留换行：' + JSON.stringify(s6.envDesc));
    need(Array.isArray(s6.hazardPoints) && s6.hazardPoints.length === 2, 'hazardPoints 应为 2 条，实际 ' + brief(s6.hazardPoints));
    need(s6.hazardPoints[0].title === '高空坠落风险' && s6.hazardPoints[0].measure === '正确使用安全带' && s6.hazardPoints[0].situation === '杆上作业',
      '危险点字段未去空白：' + brief(s6.hazardPoints[0]));
    need(s6.hazardPoints[0].hazardId === 'lib_1' && s6.hazardPoints[0].id === 'hz_a', '危险点 id/hazardId 未原样保留：' + brief(s6.hazardPoints[0]));
    need(s6.hazardPoints[0].scope === '2小组' && s6.hazardPoints[1].scope === '全组', 'scope 往返不一致：' + brief(s6.hazardPoints.map(h => h.scope)));
    // 重读计划：危险点组原样返回
    const d6 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after 4.3');
    need(JSON.stringify(d6.survey.hazardPoints) === JSON.stringify(s6.hazardPoints), '重读计划时危险点不一致：' + brief(d6.survey.hazardPoints));
    // 非法 scope → 回落「全组」；缺 id → 自动生成 hz 前缀
    const s7 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, hazardPoints: [{ title: 'A', measure: 'B', scope: '9小组' }] }
    }), '非法 scope');
    need(s7.hazardPoints[0].scope === '全组', '非法 scope 应回落「全组」，实际 ' + JSON.stringify(s7.hazardPoints[0].scope));
    need(/^hz/.test(String(s7.hazardPoints[0].id)), '缺 id 时应自动生成 hz 前缀 id，实际 ' + s7.hazardPoints[0].id);
    // 措施为空 → 400，文案指出第几条
    const badM = await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, hazardPoints: [{ title: 'A', measure: 'B' }, { title: 'C', measure: '  ' }] }
    });
    need(badM.status === 400, '措施为空应 400，实际 ' + badM.status);
    need(String((badM.data && badM.data.error) || '').indexOf('第 2 条') > -1, '400 文案应指出第 2 条，实际 ' + brief(badM.data));
    // 标题为空 → 400
    const badT = await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: { ...body2, hazardPoints: [{ title: '', measure: 'B' }] }
    });
    need(badT.status === 400, '标题为空应 400，实际 ' + badT.status);
    need(String((badT.data && badT.data.error) || '').indexOf('第 1 条') > -1, '400 文案应指出第 1 条，实际 ' + brief(badT.data));
    // 51 条 → 截断到 50 条
    const many = Array.from({ length: 51 }, (_, i) => ({ title: '危险点' + i, measure: '措施' + i }));
    const s8 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, hazardPoints: many } }), '超 50 条');
    need(s8.hazardPoints.length === 50, 'hazardPoints 应截断到 50 条，实际 ' + s8.hazardPoints.length);
    need(s8.hazardPoints[49].title === '危险点49', '截断后应是前 50 条，第 50 条为 ' + s8.hazardPoints[49].title);
    // 4.4 / 接地线 / 勘察日期：本批新字段往返（去首尾空白、保留换行、非法 scope 回落「全组」）
    const s9 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: {
        ...body2,
        opsMeasures: ' 运维措施A\n运维措施B ', teamMeasures: '班组措施1\n班组措施2',
        ground10: '10kV 1号杆', ground04: '0.4kV 配电箱',
        teamMeasureScopes: ['1小组', '9小组'], ground10Scopes: ['2小组'], ground04Scopes: [],
        surveyDate: '2026-10-26'
      }
    }), '写入 4.4');
    need(s9.opsMeasures === '运维措施A\n运维措施B', 'opsMeasures 应去首尾空白并保留换行：' + JSON.stringify(s9.opsMeasures));
    need(s9.teamMeasures === '班组措施1\n班组措施2' && s9.ground10 === '10kV 1号杆' && s9.ground04 === '0.4kV 配电箱',
      '4.4/接地线文本未保存：' + brief([s9.teamMeasures, s9.ground10, s9.ground04]));
    need(JSON.stringify(s9.teamMeasureScopes) === JSON.stringify(['1小组', '全组']), '非法 scope 应回落「全组」：' + brief(s9.teamMeasureScopes));
    need(JSON.stringify(s9.ground10Scopes) === JSON.stringify(['2小组']) && JSON.stringify(s9.ground04Scopes) === JSON.stringify([]),
      '接地线 scopes 往返不一致：' + brief([s9.ground10Scopes, s9.ground04Scopes]));
    need(s9.surveyDate === '2026-10-26', 'surveyDate 未保存：' + brief(s9.surveyDate));
    // 重读计划：4.4 全字段原样
    const d9 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after 4.4');
    need(d9.survey.surveyDate === '2026-10-26' && d9.survey.ground10 === '10kV 1号杆'
      && JSON.stringify(d9.survey.teamMeasureScopes) === JSON.stringify(['1小组', '全组']), '重读计划时 4.4 字段不一致');
    // 未传 scopes / 4.4 文本 → 沿用旧值
    const s10 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2 } }), '不传 4.4');
    need(JSON.stringify(s10.teamMeasureScopes) === JSON.stringify(['1小组', '全组']), '未传 scopes 应沿用旧值：' + brief(s10.teamMeasureScopes));
    need(s10.opsMeasures === '运维措施A\n运维措施B' && s10.surveyDate === '2026-10-26', '未传的 4.4 字段应沿用旧值：' + brief([s10.opsMeasures, s10.surveyDate]));
    // 勘察日期格式非法 → 400（且不破坏已存内容）
    for (const badDay of ['2026-13-01', '2026-02-30', '20261026', '2026/10/26', 'abc']) {
      const r = await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, surveyDate: badDay } });
      need(r.status === 400, '非法勘察日期 ' + badDay + ' 应 400，实际 ' + r.status);
    }
    const d10 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after bad date');
    need(d10.survey.surveyDate === '2026-10-26', '非法日期被拒后原值不应改变，实际 ' + brief(d10.survey.surveyDate));
    // scopes 超 200 条 → 截断
    const manyScopes = Array.from({ length: 205 }, () => '1小组');
    const s11 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, teamMeasureScopes: manyScopes } }), 'scopes 超 200');
    need(s11.teamMeasureScopes.length === 200, 'scopes 应截断到 200 条，实际 ' + s11.teamMeasureScopes.length);
    // 显式传空数组 → 清空
    const s12 = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, teamMeasureScopes: [] } }), 'scopes 清空');
    need(Array.isArray(s12.teamMeasureScopes) && s12.teamMeasureScopes.length === 0, '显式传空数组应清空，实际 ' + brief(s12.teamMeasureScopes));
    // 本批口径：surveyNo 里存的就是「部门+编号」完整编号，原样往返、不再二次拼
    const sNo = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, surveyNo: '施工一队202610900' } }), '完整编号往返');
    need(sNo.surveyNo === '施工一队202610900', '完整编号应原样保存，实际 ' + brief(sNo.surveyNo));
    // 3.工作任务合并后 workLocation 一律置空
    const sLoc = needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: { ...body2, workLocation: '', workTask: '合并后的工作任务' } }), 'workLocation 置空');
    need(sLoc.workLocation === '' && sLoc.workTask === '合并后的工作任务', 'workLocation 应置空、workTask 独立保存：' + brief([sLoc.workLocation, sLoc.workTask]));
    // 计划不存在 → 404
    const r404 = await api('PUT', '/api/workPlans/nope_not_exist/survey', { token, body: body1 });
    need(r404.status === 404, '计划不存在应 404，实际 ' + r404.status);
    return 'createdAt 稳定 ' + createdAt + '；分组/小组往返一致、非法分组回落、groups 截断到 3、4.3 环境描述+危险点往返、4.4 两组措施+接地线+勘察日期往返、scopes 清洗/截断、非法日期 400、必填 400、超 50 条截断、完整编号往返、workLocation 置空';
  });
  await step('plans', '周计划无「班组应采取的安全措施」字段（撤掉历史误加）→ 新建计划保存体/落库均无该键 → 4.4 班组措施：二票留空、其余取模板标准文案', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/plans.js'), 'utf8');
    // ① 周计划表单不再有该字段（含其 placeholder）
    need(src.indexOf('label="班组应采取的安全措施"') < 0, '周计划表单不应再有「班组应采取的安全措施」字段');
    // ② 保存体显式剔除该键：老记录带值也不回写（新增/编辑 + 复制 两条写入路径都要剔除）
    need((src.match(/delete body\.teamSafetyMeasures/g) || []).length >= 2, '计划保存/复制两条写入路径都应剔除 teamSafetyMeasures');
    // ③ 勘察带入不再读计划该字段，固定取模板标准文案
    need(!/p\.teamSafetyMeasures/.test(src), 'surveySeed 不应再读 plan.teamSafetyMeasures');
    // 二票：4.4 班组措施留空（不分小组=待填写、分组=每条选小组）；其余票种仍固定取模板标准文案
    need(/teamMeasures:\s*isP2\s*\?\s*''\s*:\s*SV_TEAM_MEASURES_DEFAULT/.test(src), '4.4 班组措施：二票留空、其余取模板标准文案');
    // 二票：4.4 运维措施按规则带入「无」
    need(/opsMeasures:\s*isP2\s*\?\s*SURVEY_P2_OPS_MEASURES/.test(src), '4.4 运维措施：二票规则带入「无」');
    // 线路第二种工作票：沿用二票全部规则（4.1/4.2/4.3/4.4 + 隐藏两种接地线），但不分小组
    need(src.indexOf("const TICKET_LINE_SECOND = '线路：线路第二种工作票'") > -1, '应定义线路第二种工作票常量');
    need(/const isP2 = isSecondLikeTicket\(/.test(src), '二票默认值应覆盖配电二票与线路二票');
    need(/const svSecondTicket = computed\(\(\) => isSecondLikeTicket\(/.test(src), '接地线隐藏规则应覆盖两种二票');
    const noGroupExpr = (src.match(/const svNoGroup = computed\([\s\S]*?\);/) || [''])[0];
    need(/TICKET_LINE_SECOND/.test(noGroupExpr), '线路第二票应不分小组');
    need(/TICKET_LINE_FIRST/.test(noGroupExpr), '线路第一票仍不分小组');
    need(noGroupExpr.indexOf('TICKET_SECOND') === -1, '配电二票应保留分组能力（不得加入 svNoGroup）');
    // ④ 接口侧：不带该键新建 → 落库对象里没有这个属性
    const pNo = needOk(await api('POST', '/api/workPlans', { token, body: { name: '冒烟无班组措施计划', planType: '周计划' } }), 'plan POST 无班组措施');
    need(!('teamSafetyMeasures' in pNo), '新建计划落库不应带 teamSafetyMeasures：' + JSON.stringify(pNo.teamSafetyMeasures));
    // ⑤ 存量假值：库里的旧值保留不动（不删不迁移），但不参与任何带入
    const pFake = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟假值计划', planType: '周计划', teamSafetyMeasures: '假值：不应带入' }
    }), 'plan POST 假值');
    need(pFake.teamSafetyMeasures === '假值：不应带入', '存量历史值应留在库里不动（不删不迁移）');
    return '表单无该字段、保存体剔除该键、落库无该键、二票（配电+线路）4.4 班组留空/运维「无」、线路二票不分小组而配电二票仍可分组、其余沿用标准文案、存量值保留不迁移';
  });
  await step('ui', '表格横向滚动：表头与内容共用同一滚动容器（无 JS 异步追赶）', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    need(css.indexOf('.el-table > .el-table__inner-wrapper { overflow-x:auto !important; overflow-y:hidden !important; }') > -1,
      '应由 .el-table__inner-wrapper 统一承担横向滚动');
    const block = (css.match(/\/\* ===== 表格横向滚动[\s\S]*?\.el-pagination \{ font-weight: 400; \}/) || [''])[0];
    need(/\.el-scrollbar__wrap \{ overflow:visible !important; \}/.test(block)
      && /\.el-table__header-wrapper,/.test(block) && /\.el-table__body-wrapper,/.test(block),
      'header/body/scrollbar wrap 应改为 overflow:visible');
    need(/display:none !important;/.test(block), '失效的 EP 自定义滚动条应隐藏');
    need(css.indexOf('.el-table__body-wrapper, .el-table__header-wrapper { overflow:hidden !important; }') === -1,
      '不得残留移动端「两层 wrapper 各滚各的」旧补丁（会让表头重新慢一拍）');
    return 'inner-wrapper 统一滚动 + 三层 visible + 自定义滚动条隐藏，表头与内容天然同步';
  });
  await step('ui', '材料台账：暂存清单领料总数实时联动 / Tab 跳过移除 / 领料单项目与物料简称完整显示', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/materials.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const vm = require('vm');
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/utils.js'), 'utf8'), sandbox);
    const MatName = sandbox.window.MatName;
    need(MatName && typeof MatName.short === 'function', 'utils.js 应暴露 window.MatName.short');
    need(MatName.short('直角挂板Z-7') === '直角挂板', '物料简称应去掉型号：直角挂板Z-7 → 直角挂板');
    need(MatName.short('预应力混凝土电杆(Z)Φ190×12M×GY（法兰）') === '预应力混凝土电杆', '电杆规格应整段去掉');
    need(MatName.short('低压JP柜50kVA（双回、无补偿）') === '低压JP柜', '名称内嵌拉丁前缀应保留、参数应去掉');
    need(MatName.short('10kV氧化锌避雷器HY5WS-17/50（脱扣式）') === '10kV氧化锌避雷器', '量词前缀应保留、型号应去掉');
    need(MatName.short('中砂') === '中砂', '无型号物料应原样返回');
    need(JSON.stringify(MatName.list([
      { description: '直角挂板Z-7' }, { description: '直角挂板Z-10' }, { description: '镀锌钢绞线GJ-35' }
    ])) === JSON.stringify(['直角挂板', '镀锌钢绞线']), '多物料简称应按明细顺序去重');
    // 暂存清单：总数 computed + 统计条展示 + Tab 直连
    need(/const stagingTotalQty = computed\(\(\) => stagingRows\.value\.reduce/.test(src), '领料总数应由 stagingRows + stagingQty 实时计算');
    need(src.indexOf('领料总数 <b>{{ fmtQty(stagingTotalQty) }}</b>') > -1, '统计条应在「项目」旁展示领料总数');
    need(/@keydown="onStagingTab"/.test(src) && /function onStagingTab\(e\)/.test(src)
      && /class="stg-qty-input"/.test(src), 'Tab 应由数量输入框互相跳转（跳过移除按钮）');
    need(/tabindex="-1" @click="removeStaging/.test(src), '移除按钮应退出 Tab 顺序（iOS 键盘「下一项」同样跳过）');
    need(/e\.shiftKey/.test(src) && /% boxes\.length/.test(src), 'Tab 应支持末行回首行与 Shift+Tab 反向');
    // 领料单列表：涉及项目完整折行 + 新增物料描述列
    const projCols = src.match(/<el-table-column label="涉及项目"[^>]*/g) || [];
    const mainProj = projCols.find(x => x.indexOf('class-name="rq-wrapcell"') > -1) || '';
    need(mainProj.indexOf('show-overflow-tooltip') === -1 && mainProj.indexOf('min-width="200"') > -1,
      '领料单主表「涉及项目」应完整折行、不得省略（关联领料单弹窗仍保留 tooltip）');
    need(/<el-table-column label="物料描述" min-width="160" class-name="rq-wrapcell">/.test(src)
      && /v-for="\(n, i\) in matNames\(row\)"/.test(src), '应在涉及项目旁新增物料描述列并调用简称函数');
    need(/\.rq-main \.rq-wrapcell \.cell \{ white-space:normal; overflow:visible/.test(css), '折行列应有 white-space:normal CSS');
    need(/\.stg-chips \{ display:flex; flex-wrap:wrap/.test(css), '暂存统计条应在窄屏换行');
    // 暂存清单「清空」只清内容、不关弹窗（2026-11-13 定版）；「关闭」按钮才关闭
    const clearFn = (src.match(/async function clearStaging\(\) \{[\s\S]*?\n    \}/) || [''])[0];
    need(/staging\.value = \[\]; stagingPage\.value = 1;/.test(clearFn) && !/stagingVisible\.value = false/.test(clearFn),
      '暂存清单「清空」应只清内容、弹窗保持打开：' + brief(clearFn));
    need(/<el-button @click="stagingVisible=false">关 闭<\/el-button>/.test(src), '暂存清单仍由「关闭」按钮关闭');
    // 确认入库弹窗：不再选到货日期，一律由服务端按确认当天记（服务端缺省见 P4-1-A）
    const cDlg = (src.match(/<el-dialog v-model="dlg\.visible"[\s\S]*?<\/el-dialog>/) || [''])[0];
    need(cDlg && cDlg.indexOf('dlg.arrivalDate') === -1 && cDlg.indexOf('到货日期（整单一个') === -1,
      '确认入库弹窗不应再有「到货日期」字段块');
    need(/api\.put\('\/api\/materialRequisitions\/' \+ dlg\.rec\.id \+ '\/confirm', \{ rows \}\)/.test(src),
      '确认入库不应再传 arrivalDate / arrivalReason（交服务端缺省）');
    return '总数 computed 联动 + Tab 循环跳转（移除退出 Tab 序）+ 5 组简称用例 + 去重 + 项目折行 + 物料描述列 + 清空不关窗 + 确认入库无到货日期';
  });
  await step('ui', '移动端：顶栏图标化、筛选栏两列网格、弹窗限高可滚动', async () => {
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const main = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
    need(/position:sticky; top:0;/.test(css), '移动端顶栏应固定（键盘弹出 / 页面平移时不被裁走）');
    need(/\.app-header \.logout-btn \{ width:32px; height:32px;/.test(css)
      && /\.app-header \.logout-text \{ display:none; \}/.test(css), '移动端「退出登录」应收成图标按钮');
    need(/<span class="logout-text">退出登录<\/span>/.test(main)
      && /aria-label="退出登录"/.test(main), '顶栏应保留桌面文字与无障碍标签');
    need(/\.wv-filters \{ display:grid; grid-template-columns:repeat\(2,minmax\(0,1fr\)\); grid-auto-flow:row dense;/.test(css),
      '移动端筛选栏应为两列网格 + dense（不再一个控件独占一行）');
    need(css.indexOf('.wv-filters .el-button { width:100%; }') === -1,
      '不得残留「筛选控件全部占满整行」的旧规则');
    need(/\.el-dialog__body \{ flex:1 1 auto; min-height:0; overflow-y:auto;/.test(css),
      '移动端弹窗 body 应自身滚动（长表单不再撑破视口）');
    need(/max-height:calc\(100dvh - 6vh\)/.test(css), '移动端弹窗应按 dvh 限高，键盘弹出时自动收缩');
    need(/\.el-dialog__footer \{ flex:0 0 auto; border-top/.test(css), '弹窗固定底栏应与滚动内容做分隔');
    return '顶栏图标化 + sticky、筛选栏 2 列 dense、弹窗 dvh 限高 + body 滚动 + 固定底栏';
  });
  await step('plans', '生成资料：无 survey → 400 → 生成勘察记录 docx（空槽保留 XXXX / 接地线并入通用风险 / 多行逐段）→ 再生成 +1 → 下载 PK → 删除后文件同消/404', async () => {
    const me = needOk(await api('GET', '/api/me', { token }), 'me');
    const recName = me.user.name;
    const p = needOk(await api('POST', '/api/workPlans', {
      token, body: { name: '冒烟生成计划', planType: '周计划', team: '施工一队', surveyNo: '202610001', teamLeader: '冒烟班组长' }
    }), 'plan POST');
    // 1) 未勘察 → 400
    const r0 = await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token });
    need(r0.status === 400, '无 survey 应 400，实际 ' + r0.status + ' ' + brief(r0.data));
    need(String((r0.data && r0.data.error) || '').indexOf('请先完成现场勘察记录') > -1, '400 文案不符：' + brief(r0.data));
    // 2) 上传勘察记录模板（17 处 XXXX 的最小 docx）→ 自动关联 surveyTemplate
    const tplXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
      + Array.from({ length: 17 }, () => '<w:p><w:r><w:t xml:space="preserve">XXXX</w:t></w:r></w:p>').join('')
      + '</w:body></w:document>';
    const tpl = buildStoreZip([
      { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>') },
      { name: 'word/document.xml', data: Buffer.from(tplXml) }
    ]);
    const fdT = new FormData();
    fdT.append('file', new Blob([tpl], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '冒烟现场勘察记录模板.docx');
    const upT = await fetch(base + '/api/documents/template/replace', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fdT, signal: AbortSignal.timeout(10000)
    });
    need(upT.status === 200, '模板上传失败：' + upT.status + ' ' + brief(await upT.text().catch(() => '')));
    // 3) 填勘察 → 生成
    const svBody = {
      grouping: '分2个小组', surveyUnit: '冒烟供电所', team: '佛荫供电所', surveyNo: '202610001',
      dualName: '10kV 冒烟线 12 号杆', workLocation: '总地点', workTask: '总内容',
      outageScope: '停电范围', retainedLive: '带电部位',
      groups: [{ workLocation: '1 号杆', workTask: '立杆' }, { workLocation: '2 号杆', workTask: '放线' }],
      envDesc: '现场有跨越，邻近 10kV 线路',
      hazardPoints: [
        { title: '高空坠落风险', situation: '杆上作业', measure: '正确使用安全带' },
        { title: '物体打击风险', situation: '', measure: '戴安全帽' }
      ],
      opsMeasures: '运维措施', teamMeasures: '班组措施1\n班组措施2',
      ground10: '12 号杆', ground04: '配变低压侧',
      teamMeasureScopes: ['1小组', '全组'], ground10Scopes: ['2小组'], ground04Scopes: ['全组'],
      surveyDate: '2026-10-19'
    };
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', { token, body: svBody }), 'survey PUT');
    const gf1 = needOk(await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token }), 'generate');
    need(/^gf/.test(String(gf1.id)), 'id 前缀应为 gf，实际 ' + brief(gf1.id));
    need(gf1.category === '现场勘察记录' && gf1.name === '现场勘察记录.docx', '类别/文件名不符：' + brief(gf1));
    need(String(gf1.path).startsWith('uploads/plans/' + p.id + '/'), 'path 不符：' + brief(gf1.path));
    need(/现场勘察记录\.docx$/.test(String(gf1.path)), '磁盘名应保留原文件名：' + gf1.path);
    need(gf1.size > 0 && !!gf1.uploadedAt, 'size/uploadedAt 不符：' + brief(gf1));
    const absG = path.join(TMP, 'data', gf1.path);
    need(fs.existsSync(absG), '生成文件应落盘：' + gf1.path);
    // 4) 产物内容：空槽保留 XXXX、接地线进通用风险槽、多行逐段
    const gxml = unzipEntry(fs.readFileSync(absG), 'word/document.xml').toString('utf8');
    // 段落级文本（逐段 <w:p> 内的 w:t 拼接）——逐行成段靠它断言
    const paras = [...gxml.matchAll(/<w:p(?: [^>]*)?>[\s\S]*?<\/w:p>/g)]
      .map(m => [...m[0].matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g)].map(x => x[1]).join(''));
    const gt = paras.join('|');
    // 4a) 空槽保留模板 XXXX：本 fixture 只有槽位 13（4.5 附图与说明）为空 → 恰好 1 处
    need((gxml.match(/XXXX/g) || []).length === 1,
      '空槽应保留 XXXX（本 fixture 只 4.5 附图与说明为空，应恰 1 处），实际 ' + (gxml.match(/XXXX/g) || []).length);
    const p45 = paras.findIndex(t => t === 'XXXX');
    need(p45 > -1, '槽位13 应保留 XXXX 而非被替换为空');
    // 4b) 填了的槽位正常落值
    need(gt.indexOf('冒烟供电所') > -1, '槽位1 勘察单位缺失');
    need(gt.indexOf('佛荫供电所202610001') > -1, '槽位3 编号应为「部门+编号」拼法：' + gt.slice(0, 160));
    need(gt.indexOf('1小组：立杆') > -1 && gt.indexOf('2小组：放线') > -1, '槽位6 工作内容未按小组拼接');
    // 4b') 槽位5「工作地点」整段不输出（参考文档第 3 项只有工作内容一行）
    need(gt.indexOf('工作地点：') < 0 && gt.indexOf('1小组：1 号杆') < 0, '槽位5 工作地点整段不应输出：' + gt.slice(0, 200));
    // 4c) 多行逐段：4.3 环境描述与两条危险点各自独立成段
    const pe = paras.indexOf('现场有跨越，邻近 10kV 线路');
    need(pe > -1, '槽位9 环境描述缺失');
    need(paras[pe + 1] === '（1）高空坠落风险：杆上作业' && paras[pe + 2] === '（2）物体打击风险',
      '槽位9 应逐行独立成段，实际 ' + brief(paras.slice(pe, pe + 3)));
    // 4d) 班组措施槽只有措施本身（2 行逐段），不再混入接地线
    const pt = paras.indexOf('班组措施1');
    need(pt > -1 && paras[pt + 1] === '班组措施2', '槽位11 班组措施应逐行成段：' + brief(paras.slice(pt, pt + 2)));
    need(gt.indexOf('10kV接地线：') < 0 && gt.indexOf('接地线：') < 0, '槽位11 不应再出现「xx接地线：」行');
    // 4e) 通用风险槽：危险点（1）（2）+ 末条（3）装设接地线的安全措施，10kV/0.4kV 各一段「分别在…验明…」
    const pg = paras.indexOf('（3）装设接地线的安全措施');
    need(pg > -1, '槽位12 接地线条目缺失（2 条危险点时应为（3））：' + brief(paras.filter(t => t.indexOf('装设接地线') > -1)));
    need(paras[pg + 1] === '分别在' && paras[pg + 2] === '12 号杆（2小组）'
      && paras[pg + 3] === '验明确无电压后装设10kV接地线各一组。',
      '接地线 10kV 段结构不符：' + brief(paras.slice(pg, pg + 4)));
    need(paras[pg + 4] === '分别在' && paras[pg + 5] === '配变低压侧'
      && paras[pg + 6] === '验明确无电压后装设0.4kV接地线各一组。',
      '接地线 0.4kV 段结构不符：' + brief(paras.slice(pg + 4, pg + 7)));
    need(gt.indexOf('（1）高空坠落风险的安全措施：正确使用安全带') > -1, '槽位12 通用措施未组装');
    // 4g) 日期与记录人
    need(gt.indexOf('|2026|10|19') > -1, '槽位15-17 勘察日期应为 2026/10/19 三个数字槽：' + gt.slice(-60));
    need(gt.indexOf('|冒烟班组长') > -1, '槽位14 记录人应默认取计划班组长（冒烟班组长），实际 ' + gt.slice(-40));
    need(gt.indexOf('|' + recName) < 0, '槽位14 不应再用当前登录用户（' + recName + '）');
    // 4b) 槽位5「工作地点」整段不输出：改计划地址后产物里也不应出现该行；槽位6 仍按小组拼工作内容
    needOk(await api('PUT', '/api/workPlans/' + p.id, { token, body: { address: '冒烟作业地址' } }), 'plan address PUT');
    needOk(await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token }), 'generate after address');
    const gtA = [...unzipEntry(fs.readFileSync(absG), 'word/document.xml').toString('utf8')
      .matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => m[1]).join('|');
    need(gtA.indexOf('冒烟作业地址') < 0, '槽位5 工作地点整段不应输出（计划地址也不应出现）：' + gtA.slice(0, 160));
    need(gtA.indexOf('1小组：立杆') > -1 && gtA.indexOf('2小组：放线') > -1, '槽位6 工作内容仍应按小组拼接');
    // 5) 改一处内容再生成 → 原地覆盖同一份，不新增勘察单
    needOk(await api('PUT', '/api/workPlans/' + p.id + '/survey', {
      token, body: Object.assign({}, svBody, { envDesc: '现场有跨越，邻近 10kV 线路（改）', opsMeasures: '' })
    }), 'survey PUT 2');
    const gf2 = needOk(await api('POST', '/api/workPlans/' + p.id + '/survey/generate', { token }), 'generate 2');
    need(gf2.id === gf1.id, '再次生成应复用同一条记录，实际 ' + brief(gf1.id) + ' → ' + brief(gf2.id));
    need(gf2.updated === true, '再次生成应回 updated=true，实际 ' + brief(gf2.updated));
    const d = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after generate');
    need(Array.isArray(d.generatedFiles) && d.generatedFiles.length === 1,
      '再次生成后应仍只有 1 条（覆盖不新增），实际 ' + brief(d.generatedFiles && d.generatedFiles.length));
    need(d.generatedFiles[0].path === gf1.path, '覆盖生成不应更换磁盘路径：' + brief(d.generatedFiles[0].path));
    const gxml2 = unzipEntry(fs.readFileSync(absG), 'word/document.xml').toString('utf8');
    // 槽位10 运维措施清空后：替换为空白而不是保留 XXXX（全长仍只 4.5 那 1 处 XXXX）
    need((gxml2.match(/XXXX/g) || []).length === 1,
      '槽位10 空值应替换为空白（XXXX 总数仍应为 1），实际 ' + (gxml2.match(/XXXX/g) || []).length);
    need(gxml2.indexOf('运维措施') < 0, '槽位10 清空后不应残留旧值');
    need(gxml2.indexOf('现场有跨越，邻近 10kV 线路（改）') > -1, '覆盖生成后产物未反映最新内容');
    need(gxml2.indexOf('现场有跨越，邻近 10kV 线路') === gxml2.indexOf('现场有跨越，邻近 10kV 线路（改）'), '旧内容应被覆盖而非追加');
    // 6) 下载拿到 docx（PK 头）
    const dl = await fetch(base + '/api/workPlans/' + p.id + '/generated/' + gf1.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl.status === 200, '下载期望 200，实际 ' + dl.status);
    const buf = Buffer.from(await dl.arrayBuffer());
    need(buf[0] === 0x50 && buf[1] === 0x4b, '下载内容不是 docx（缺 PK 头）');
    // 7) 删除：记录与文件同消，再下载 404
    needOk(await api('DELETE', '/api/workPlans/' + p.id + '/generated/' + gf1.id, { token }), 'generated DELETE');
    need(!fs.existsSync(absG), '删除后磁盘文件应同时删除');
    const d2 = needOk(await api('GET', '/api/workPlans/' + p.id, { token }), 'detail after delete');
    need(d2.generatedFiles.length === 0, '删除后应没有生成记录：' + brief(d2.generatedFiles.map(x => x.id)));
    const dl2 = await fetch(base + '/api/workPlans/' + p.id + '/generated/' + gf1.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(dl2.status === 404, '删除后下载应 404，实际 ' + dl2.status);
    return '空槽保留 XXXX（仅 4.5 1 处）/ 运维空值置空 / 工作地点整段不输出 / 编号拼法 / 工作内容按小组拼 / 4.3 与通用风险逐行成段 / 接地线并入通用风险（N+1 编号 + 分别在/逐行/验明…）/ 日期 2026-10-19 / 记录人 ' + recName + ' / 重复生成原地覆盖（1 条）/ 删除后清空';
  });
  await step('plans', '借工 新增 → 详情（新模型字段）', async () => {
    const d = needOk(await api('POST', '/api/borrowWorks', {
      token, body: { unit: '冒烟供电所', direction: '我方借出', workContent: '冒烟测试', techCount: 2, signStatus: '未签单' }
    }), 'borrowWorks POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/borrowWorks/' + d.id, { token }), 'borrowWorks detail');
    need(one.unit === '冒烟供电所' && one.direction === '我方借出' && one.techCount === 2, 'detail 新字段不匹配');
    return 'id=' + d.id + ' unit=' + one.unit + ' tech=' + one.techCount;
  });
  await step('ui', '单位余额：默认汇总全部明细、10 列平表、克制视觉', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/views/borrow.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const bal = src.slice(src.indexOf('<div class="bw-bal">'), src.indexOf('<!-- 新增/编辑弹窗 -->'));
    need(bal.indexOf('<div class="bw-bal">') === 0, '应存在单位余额容器');
    need((bal.match(/<el-table-column/g) || []).length === 10, '单位余额应仍是 10 列平表（不引入分组表头）');
    need(bal.indexOf('el-table-column-group') === -1, '不得引入分组表头');
    need(!/class="bw-bal-table"[^>]*stripe/.test(bal), '余额表不应有斑马纹');
    // 口径修正：默认全部明细，只有切到 signed 才按已签单过滤；切到余额页重新拉数据
    need(/const balanceScope = ref\('all'\)/.test(src), '余额统计口径默认应为「全部明细」');
    need(/balanceScope\.value !== 'signed' \|\| r\.signStatus === '已签单'/.test(src), '仅 signed 口径才按已签单过滤');
    need(/function setBalanceScope\(/.test(src) && /setBalanceScope\('all'\)/.test(bal) && /setBalanceScope\('signed'\)/.test(bal), '应提供全部/仅已签单切换');
    need(/watch\(tab,[\s\S]{0,80}v === 'balance'/.test(src), '切到余额页应重新加载明细，保证同步');
    need(!/list\.value\.filter\(r => r && \(r\.signStatus === '已签单'\)\)/.test(src), '不得再写死只统计已签单');
    need(/diffCls\(row\.dTech\)/.test(bal) && /diffCls\(row\.dWorker\)/.test(bal) && /diffCls\(row\.dVehicle\)/.test(bal), '三列差额都应带语义色');
    need(/function diffText\(v\)\s*\{[^}]*'\+' \+ n/.test(src), '差额正数应显示 + 号');
    need(/bw-bal-empty/.test(bal) && /\.bw-diff\.is-neg/.test(css) && /\.bw-diff\.is-zero/.test(css), '空态与差额正/负/零样式应存在');
    need(/bw-h-start/.test(bal) && /bw-g-start/.test(bal), '借入/差额组首应有分隔线');
    need(!/\.bw-diff \{[^}]*border-radius:999px/.test(css), '差额不得回到彩色胶囊标签');
    need(!/th\.bw-h-diff \{ background/.test(css), '表头不得回到三色底块');
    return '默认全量汇总 + 口径切换 + 切页刷新 + 10 列平表 + 纯数字语义色 + 无胶囊/三色表头';
  });
  await step('plans', '借工 校验：非法计数/枚举 → 400', async () => {
    const r1 = await api('POST', '/api/borrowWorks', { token, body: { unit: 'X', direction: '我方借出', techCount: -1 } });
    const r2 = await api('POST', '/api/borrowWorks', { token, body: { unit: 'X', direction: '乱写' } });
    const r3 = await api('POST', '/api/borrowWorks', { token, body: { unit: 'X', direction: '我方借出', signStatus: '乱写' } });
    need(r1.status === 400 && r2.status === 400 && r3.status === 400, '期望 400，实际 ' + [r1.status, r2.status, r3.status].join('/'));
    return '计数-1 400 / 方向非法 400 / 签单状态非法 400';
  });

  /* ---------- completion ---------- */
  await step('documents', '竣工资料 新增 → 详情', async () => {
    const d = needOk(await api('POST', '/api/completionDocuments', {
      token, body: { name: '竣工资料-冒烟', category: '施工记录', status: '编制中' }
    }), 'completionDocuments POST');
    need(d && d.id, '响应缺少 id');
    const one = needOk(await api('GET', '/api/completionDocuments/' + d.id, { token }), 'completionDocuments detail');
    need(one.name === '竣工资料-冒烟', 'detail.name 不匹配');
    return 'id=' + d.id;
  });

  /* ---------- documents ---------- */
  await step('documents', '文档中心 GET /api/documents', async () => {
    const d = needOk(await api('GET', '/api/documents', { token }), 'documents');
    need(Array.isArray(d.categories) && d.categories.indexOf('危险点') > -1, 'categories 缺少「危险点」：' + brief(d.categories));
    need(Array.isArray(d.files), 'files 应为数组');
    return '分类 ' + d.categories.length + ' 个 / 文件 ' + d.files.length + ' 个';
  });
  await step('documents', '危险点 新增 → 列表校验', async () => {
    const d = needOk(await api('POST', '/api/documents/hazard', { token, body: { hazard: '冒烟危险点', measure: '冒烟控制措施' } }), 'hazard POST');
    need(d && d.id, '响应缺少 id');
    const list = needOk(await api('GET', '/api/workticket/hazards', { token }), 'hazards list');
    need(Array.isArray(list) && list.some(h => h.id === d.id), '危险点库未包含新建条目');
    return 'id=' + d.id;
  });
  // 文档预览（docx → 提取文本）：勘察记录模板走的就是这条链路，重构时曾漏导入 extractDocxText 导致 500
  await step('documents', 'docx 上传 → 预览提取文本', async () => {
    const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>现场勘察记录</w:t></w:r></w:p><w:p><w:r><w:t>冒烟勘察内容</w:t></w:r></w:p></w:body></w:document>', 'utf8');
    const docx = buildStoreZip([{ name: 'word/document.xml', data: xml }]);
    const fd = new FormData();
    fd.append('category', '工作票模板');
    fd.append('file', new Blob([docx], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), '冒烟勘察记录.docx');
    const upRes = await fetch(base + '/api/documents/files', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd, signal: AbortSignal.timeout(10000) });
    const up = await upRes.json();
    need(upRes.status === 200 && up && up.id, '上传失败：' + brief(up));
    const pv = needOk(await api('GET', '/api/documents/files/' + up.id + '/preview', { token }), 'preview');
    need(pv.kind === 'docx', 'preview.kind 应为 docx，实际 ' + brief(pv.kind));
    need(Array.isArray(pv.lines) && pv.lines.includes('冒烟勘察内容'), '预览未提取到正文：' + brief(pv.lines));
    await api('DELETE', '/api/documents/files/' + up.id, { token });
    return 'kind=docx 行数=' + pv.lines.length;
  });

  /* ---------- workticket ---------- */
  await step('workticket', '配置状态 GET /api/workticket/config-status', async () => {
    const d = needOk(await api('GET', '/api/workticket/config-status', { token }), 'config-status');
    need(d && typeof d === 'object', '响应应为对象：' + brief(d));
    return Object.keys(d).slice(0, 6).join(',');
  });
  await step('workticket', '资料库 GET /api/workticket/library', async () => {
    const d = needOk(await api('GET', '/api/workticket/library', { token }), 'library');
    need(Array.isArray(d.groups) && d.groups.length === 5, 'groups 应为 5 组，实际 ' + (d.groups || []).length);
    need(Array.isArray(d.categories) && d.categories.length > 0, 'categories 不应为空');
    need(Array.isArray(d.techOptions) && Array.isArray(d.safetyOptions), 'techOptions/safetyOptions 应为数组');
    return 'groups=' + d.groups.length + ' categories=' + d.categories.length;
  });
  await step('workticket', '匹配规则 新增 → 列表校验', async () => {
    const d = needOk(await api('POST', '/api/workticket/rules', { token, body: { workType: '冒烟作业', category: '开挖坑洞' } }), 'rules POST');
    need(d && d.id, '响应缺少 id');
    const list = needOk(await api('GET', '/api/workticket/rules', { token }), 'rules list');
    need(list.some(r => r.id === d.id), '规则列表未包含新建条目');
    return 'id=' + d.id;
  });
  await step('workticket', '技术措施 列表 + 新增', async () => {
    const before = needOk(await api('GET', '/api/workticket/measures/tech', { token }), 'tech list');
    need(Array.isArray(before), 'tech 列表应为数组');
    const d = needOk(await api('POST', '/api/workticket/measures/tech', { token, body: { title: '冒烟技术措施', content: '（1）冒烟内容' } }), 'tech POST');
    need(d && d.id, '响应缺少 id');
    const after = needOk(await api('GET', '/api/workticket/measures/tech', { token }), 'tech list 2');
    need(after.length === before.length + 1, '新增后条数应 +1（' + before.length + ' → ' + after.length + '）');
    return before.length + ' → ' + after.length;
  });
  await step('workticket', '安全措施 列表 GET', async () => listOk('/api/workticket/measures/safety', token).then(d => d.length + ' 条'));
  await step('workticket', '医院联系方式 列表 GET', async () => listOk('/api/workticket/hospitals', token).then(d => d.length + ' 条'));
  await step('workticket', '默认模板 元信息 GET（内置 规则15/技术49/安全19）', async () => {
    const d = needOk(await api('GET', '/api/workticket/measures/default', { token }), 'default meta');
    need(d.tech === 49 && d.safety === 19, '内置默认应为 技术49/安全19，实际 ' + d.tech + '/' + d.safety);
    need(d.rules === 15, '内置默认应含 15 条作业内容匹配规则，实际 ' + d.rules);
    need(d.builtin === true, '空实例应为 builtin=true，实际 ' + d.builtin);
    return 'rules=' + d.rules + ' tech=' + d.tech + ' safety=' + d.safety + ' builtin=' + d.builtin;
  });
  await step('workticket', '载入默认 POST → 规则+15 / 技术+49 / 安全+19，且规则按标题反查措施 id', async () => {
    const d = needOk(await api('POST', '/api/workticket/measures/default/load', { token }), 'default load');
    need(d.result && d.result.tech && d.result.tech.added === 49, '技术应新增 49，实际 ' + brief(d.result));
    need(d.result.safety && d.result.safety.added === 19, '安全应新增 19，实际 ' + brief(d.result));
    need(d.result.rules && d.result.rules.added === 15, '匹配规则应新增 15，实际 ' + brief(d.result));
    const rl = needOk(await api('GET', '/api/workticket/rules', { token }), 'rules list after load');
    // 前面已新增 1 条「冒烟作业」规则，载入默认后应为 15 + 1
    need(rl.length === 16, '载入默认后规则应为 16 条，实际 ' + rl.length);
    const builtin = rl.filter(r => r.workType !== '冒烟作业');
    need(builtin.length === 15, '内置规则应为 15 条，实际 ' + builtin.length);
    const bad = builtin.filter(r => {
      const cnt = v => String(v || '').split(/[;；]+/).map(x => x.trim()).filter(Boolean).length;
      const ids = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean).length;
      return cnt(r.techName) !== ids(r.techId) || cnt(r.safetyName) !== ids(r.safetyId);
    });
    need(!bad.length, '规则的措施标题应全部反查到本实例 id：' + brief(bad.map(r => r.workType)));
    return 'rules+' + d.result.rules.added + ' tech+' + d.result.tech.added + ' safety+' + d.result.safety.added + ' 关联全命中';
  });

  /* ---------- actualWorks ---------- */
  let awId = '';
  await step('actualWorks', '施工量列表 GET /api/actualWorks', async () => listOk('/api/actualWorks', token).then(d => d.length + ' 条'));
  await step('actualWorks', '新增施工量 POST /api/actualWorks', async () => {
    const d = needOk(await api('POST', '/api/actualWorks', {
      token,
      body: {
        date: '2026-10-24', project: '冒烟测试项目', workTypes: ['立杆'], workers: ['张三'],
        items: [{ materialId, code: 'S01HDG1005', description: '预应力混凝土电杆Φ150×10M', unit: '根', qty: 2 }]
      }
    }), 'actualWorks POST');
    need(d && d.id, '响应缺少 id');
    need(d.items && d.items.length === 1 && d.items[0].qty === 2, 'items 落库不正确：' + brief(d.items));
    awId = d.id;
    return 'id=' + awId + ' qty=2';
  });
  await step('actualWorks', '施工量列表回查（材料数量/折算字段）', async () => {
    const d = needOk(await api('GET', '/api/actualWorks', { token }), 'actualWorks list');
    const row = d.find(r => r.id === awId);
    need(row, '列表未包含新建记录');
    need(row.items[0].qty === 2, 'qty 应为 2，实际 ' + row.items[0].qty);
    need(row.submitter, 'submitter 应写入当前用户');
    return 'submitter=' + row.submitter;
  });
  await step('actualWorks', '编辑施工量 PUT /api/actualWorks/:id', async () => {
    const d = needOk(await api('PUT', '/api/actualWorks/' + awId, {
      token,
      body: {
        date: '2026-10-24', project: '冒烟测试项目', workTypes: ['立杆'], workers: ['张三'],
        items: [{ materialId, description: '预应力混凝土电杆Φ150×10M', unit: '根', qty: 3 }]
      }
    }), 'actualWorks PUT');
    need(d.items[0].qty === 3, 'PUT 后 qty 应为 3，实际 ' + d.items[0].qty);
    need(d.updatedAt, 'PUT 应写 updatedAt');
    return 'qty 2 → 3';
  });

  /* ---------- 权限（RBAC） ---------- */
  await step('权限', '材料员登录 POST /api/login（smoke_cly）', async () => {
    const d = needOk(await api('POST', '/api/login', { body: { username: 'smoke_cly', password: 'Smoke@2026' } }), 'login cly');
    need(d.token, '响应缺少 token');
    clyToken = d.token;
    return (d.user.userGroup || d.user.role) + ' 登录成功';
  });
  await step('权限', '材料员读业务接口允许 / 写项目应 403', async () => {
    const cly = clyToken;
    const g = await api('GET', '/api/projects', { token: cly });
    need(g.status === 200, 'GET /api/projects 期望 200，实际 ' + g.status);
    const p = await api('POST', '/api/projects', { token: cly, body: { name: '越权项目' } });
    need(p.status === 403, 'POST /api/projects 期望 403，实际 ' + p.status + ' ' + brief(p.data));
    const m = await api('POST', '/api/materials', {
      token: cly, body: { project: '冒烟测试项目', source: 'ERP采购申请', description: '越权材料', qtyRequired: 1, unit: '根' }
    });
    need(m.status >= 200 && m.status < 300, '材料员写材料台账应允许，实际 ' + m.status + ' ' + brief(m.data));
    return '读 200 / 写项目 403 / 写材料 2xx';
  });

  /* ---------- 拆分出去的两个专用端点：运行时回归 ---------- */
  await step('plans', '独立路由回归：月计划 xlsx 导出 / 借工单生成 + 下载', async () => {
    const hdr = { Authorization: 'Bearer ' + token };
    const xr = await fetch(base + '/api/workPlans/month-plan.xlsx', { headers: hdr });
    need(xr.status === 200, '月计划 xlsx 导出应 200，实际 ' + xr.status);
    const buf = Buffer.from(await xr.arrayBuffer());
    need(buf.slice(0, 2).toString() === 'PK', '导出内容应为 xlsx（PK 头），实际 ' + buf.slice(0, 2).toString());
    const list = needOk(await api('GET', '/api/borrowWorks', { token }), 'borrowWorks list');
    const b = list[0];
    need(b && b.id, '应有可生成借工单的借工记录');
    const gen = await api('POST', '/api/borrowWorks/' + b.id + '/borrowForm/generate', { token });
    need(gen.status === 200, '借工单生成应 200，实际 ' + gen.status + ' ' + brief(gen.data));
    const dl = await fetch(base + '/api/borrowWorks/' + b.id + '/generated/' + gen.data.id + '/download', { headers: hdr });
    need(dl.status === 200, '生成的借工单应可下载，实际 ' + dl.status);
    return 'xlsx PK 头 ' + buf.length + ' 字节 / 借工单生成 + 下载 200';
  });

  /* ---------- 结构（按功能区分模块，防回退） ---------- */
  await step('结构', '后端按功能区独立文件 + 单向依赖 + 挂载顺序', async () => {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const entry = read('server.js');
    const plans = read('server/routes/plans.js');
    const borrow = read('server/routes/borrow.js');
    const month = read('server/routes/monthPlans.js');
    const util = read('server/core/util.js');
    const routeFiles = fs.readdirSync(path.join(ROOT, 'server/routes')).filter(x => x.endsWith('.js'));

    const entryLines = entry.trimEnd().split('\n').length;
    need(entryLines < 60, 'server.js 应保持纯入口（<60 行）');
    need(routeFiles.indexOf('borrow.js') > -1 && routeFiles.indexOf('monthPlans.js') > -1,
      '借工与月计划应有独立 routes 文件');
    need(/app\.get\('\/api\/workPlans\/month-plan\.xlsx'/.test(month), '月计划 xlsx 导出应归属 monthPlans.js');
    need(/crud\('borrowWorks', 'borrowWorks'/.test(borrow), 'borrowWorks 通用 CRUD 应归属 borrow.js');
    need(/app\.post\('\/api\/borrowWorks\/:id\/evidences'/.test(borrow), '借工佐证端点应归属 borrow.js');
    need(!/app\.(get|post|put|delete)\('\/api\/borrowWorks/.test(plans) &&
      !/app\.get\('\/api\/workPlans\/month-plan\.xlsx'/.test(plans),
      'plans.js 不得再混装借工或月计划导出端点');
    need(!/\['plans',\s*'borrowWorks'/.test(plans), 'plans.js 通用 CRUD 不得再包含 borrowWorks');
    need(/function safeFileName/.test(util) && /const INLINE_MIME/.test(util),
      '附件落盘/预览共用工具应下沉 core/util');
    need(plans.indexOf('function planFileSafeName') === -1 && borrow.indexOf('const DRAWING_INLINE_MIME') === -1,
      'routes 不得重复定义已下沉的共用工具');

    const at = f => entry.indexOf("require('./server/routes/" + f + "')");
    need(at('borrow') > -1 && at('monthPlans') > -1 && at('plans') > -1, '三个模块都应在 server.js 中注册');
    need(at('borrow') < at('plans') && at('monthPlans') < at('plans'),
      '借工/月计划专用路由必须先于 plans.js 加载（静态路径不能被 /:id 抢先匹配）');
    routeFiles.forEach(f => {
      const src = read('server/routes/' + f);
      need(!/require\(['"][^'"]*routes\//.test(src), f + ' 不得依赖其它 routes（依赖方向只能是 routes → core）');
    });
    return routeFiles.length + ' 个 routes 文件 / 入口 ' + entryLines +
      ' 行 / 专用路由早于通用 CRUD / 无 routes↔routes';
  });

  await step('结构', 'SOURCE_TYPES 前后端两处定义逐项相等（防漂移）', async () => {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const pick = (src, label) => {
      const m = src.match(/const SOURCE_TYPES = \[([^\]]*)\]/);
      need(!!m, label + ' 未找到 SOURCE_TYPES 定义');
      return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    const back = read('server/routes/materials.js');
    const front = read('public/js/views/materials.js');
    const b = pick(back, '后端'), f = pick(front, '前端');
    need(b.length === 5, '后端 SOURCE_TYPES 应为 5 项，实为 ' + b.length);
    need(JSON.stringify(b) === JSON.stringify(f),
      '前后端 SOURCE_TYPES 不一致：' + JSON.stringify(b) + ' vs ' + JSON.stringify(f));
    need(/smoke\.js/.test(back) && /smoke\.js/.test(front), '两处定义附近应有互指本断言的注释');
    return b.join(' / ');
  });

  await step('结构', '身份证权重/校验码映射：core 与表单两处逐项相等（防漂移）', async () => {
    const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
    const pick = (src, name, label) => {
      const m = src.match(new RegExp('const ' + name + ' = \\[([^\\]]*)\\]'));
      need(!!m, label + ' 未找到 ' + name);
      return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    };
    const core = read('server/core/util.js');
    const view = read('public/js/views/users.js');
    const a1 = pick(core, 'WORKER_ID_WEIGHTS', 'core'), b1 = pick(view, 'WORKER_ID_WEIGHTS', '表单');
    const a2 = pick(core, 'WORKER_ID_CHECK', 'core'), b2 = pick(view, 'WORKER_ID_CHECK', '表单');
    need(a1.length === 17 && a2.length === 11, 'core 常量长度应为 17 / 11，实为 ' + a1.length + ' / ' + a2.length);
    need(JSON.stringify(a1) === JSON.stringify(b1), 'WORKER_ID_WEIGHTS 两处不一致：' + JSON.stringify(a1) + ' vs ' + JSON.stringify(b1));
    need(JSON.stringify(a2) === JSON.stringify(b2), 'WORKER_ID_CHECK 两处不一致：' + JSON.stringify(a2) + ' vs ' + JSON.stringify(b2));
    need(/smoke\.js/.test(core) && /smoke\.js/.test(view), '两处定义附近应有互指本断言的注释');
    return '权重 17 项 / 映射 11 项逐项相等';
  });

  await step('users', '身份证校验纯函数：真实日历/闰年/MOD 11-2 校验码/未来日期/小写 x', async () => {
    const { validateWorkerId } = require(path.join(ROOT, 'server/core/util.js'));
    const TODAY = '2026-11-08';
    need(validateWorkerId('510301199001010010', TODAY).ok === true, '合法身份证应通过');
    const badCheck = validateWorkerId('510301199001010019', TODAY);
    need(badCheck.ok === false && /校验码/.test(badCheck.error), '校验码错应拒绝');
    const badDay = validateWorkerId('51030119900230001X', TODAY);
    need(badDay.ok === false && /出生日期/.test(badDay.error), '2 月 30 日应拒绝');
    const future = validateWorkerId('510301209001010017', TODAY);
    need(future.ok === false && /出生日期/.test(future.error), '未来生日应拒绝');
    need(validateWorkerId('51030119900101007x', TODAY).ok === true, '末位小写 x 应通过');
    need(validateWorkerId('510301200002290013', TODAY).ok === true, '闰年 2000-02-29 应通过');
    need(validateWorkerId('510301199902290013', TODAY).ok === false, '平年 1999-02-29 应拒绝');
    return '合法/校验码错/2月30日/未来日期/小写x/闰年/平年 7 个样本';
  });

  const WID = { A: '510301199001010010', B: '510301199001010029', C: '510301199001010037', D: '510301199001010045' };
  let workerMixBuf = null;
  let workerSuspectNo = null;
  const workerUpload = async (path, decisions) => {
    const fd = new FormData();
    fd.append('file', new Blob([workerMixBuf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'mix.xlsx');
    if (decisions) fd.append('decisions', JSON.stringify(decisions));
    const r = await fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };

  await step('users', '作业人员导入预览：六类分类 + 字段级差异，不写库', async () => {
    const mk = async (name, idNumber, phone, extra) => needOk(await api('POST', '/api/workers', {
      token, body: { name, idNumber, phone, ...(extra || {}) }
    }), 'worker POST');
    await mk('冒烟甲', WID.A, '13800000001', { identity: '民工', team: '一队', status: '待定' });
    await mk('冒烟乙', WID.B, '13800000002');
    await mk('冒烟丁', WID.D, '13800000004');
    await mk('冒烟无证', '', '13800000003');
    const before = needOk(await api('GET', '/api/workers', { token }), 'workers before');
    const rows = [
      ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'],
      ['冒烟新人', WID.C, '13800000011', '', '', '', '', ''],
      ['冒烟甲', WID.A, '13900000001', '', '', '', '', ''],
      ['冒烟乙', WID.B, '13800000002', '', '', '', '', ''],
      ['冒烟无证', '', '13800000003', '', '', '', '', ''],
      ['冒烟异名', WID.D, '13800000004', '', '', '', '', ''],
      ['冒烟新人复', WID.C, '13800000011', '', '', '', '', '']
    ];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '作业人员名单');
    workerMixBuf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const pv = await workerUpload('/api/workers/import/preview');
    need(pv.status === 200 && pv.data && pv.data.ok, '预览失败：' + brief(pv.data));
    const s = pv.data.summary || {};
    need(['新增', '更新', '无变化', '疑似重复', '冲突', '文件内重复'].every(k => s[k] === 1),
      '六类应各 1 条：' + brief(s));
    const upd = (pv.data.rows || []).find(r => r.kind === '更新');
    need(upd && Array.isArray(upd.diffs) && upd.diffs.length === 1 && upd.diffs[0].field === '电话号码',
      '更新行差异应只含电话号码：' + brief(upd && upd.diffs));
    workerSuspectNo = (pv.data.rows || []).find(r => r.kind === '疑似重复').rowNo;
    const after = needOk(await api('GET', '/api/workers', { token }), 'workers after');
    need(after.length === before.length, '预览不得写库：' + before.length + ' → ' + after.length);
    return '六类各 1 / 更新差异只含电话号码 / 预览不写库 / 疑似行号 ' + workerSuspectNo;
  });

  await step('users', '作业人员导入确认：有值更新 / 疑似决策 / 重复导入幂等', async () => {
    const first = await workerUpload('/api/workers/import/confirm', []);
    need(first.status === 200 && first.data.added === 1 && first.data.updated === 1 &&
      first.data.unchanged === 1 && first.data.skipped === 4,
      '首次确认计数不符：' + brief(first.data));
    const list1 = needOk(await api('GET', '/api/workers', { token }), 'workers 1');
    const a1 = list1.find(w => w.idNumber === WID.A);
    need(a1 && a1.phone === '13900000001' && a1.status === '待定',
      '有值更新应只改电话、状态留空保持待定：' + brief(a1 && { phone: a1.phone, status: a1.status }));
    need(list1.filter(w => w.name === '冒烟无证').length === 1,
      '疑似行未勾选时不应新增同名无证件人员');
    const second = await workerUpload('/api/workers/import/confirm', [workerSuspectNo]);
    need(second.status === 200 && second.data.added === 1 && second.data.updated === 0,
      '勾选疑似行后应新增 1 条：' + brief(second.data));
    const third = await workerUpload('/api/workers/import/confirm', []);
    need(third.status === 200 && third.data.added === 0 && third.data.updated === 0,
      '同一文件第三次导入应全为无变化/跳过：' + brief(third.data));
    return '新增1/更新1/无变化1/跳过4 → 勾选疑似新增1 → 再次导入 added=0 updated=0';
  });

  /* ---------- 通讯录导入快照/恢复：常驻回归（增补，step 自带数据与文件清理） ---------- */
  await step('system', '通讯录快照/恢复：落盘+清单、回滚、可逆、5 份上限、非法参数 400', async () => {
    const bkDir = path.join(TMP, 'data', 'backups', 'contacts');
    const SNAP_RE = /^contacts-\d{14}(?:-\d+)?\.json$/;
    const bkFiles = () => fs.existsSync(bkDir) ? fs.readdirSync(bkDir).filter(n => SNAP_RE.test(n)) : [];
    const preFiles = bkFiles();                 // step 开始前已有的快照（正常为空）
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-smoke-snap-'));
    const dbPath = path.join(TMP, 'data', 'db.json');
    const initialContacts = JSON.parse(fs.readFileSync(dbPath, 'utf8')).contacts || [];
    const alive0 = await listOk('/api/contacts', token);
    let firstSnap = '';

    // 覆盖式导入是现行快照机制的触发口：优先「员工」sheet，按表头名解析 6 列
    const rows = [
      ['部门', '姓名', '职务', '手机', '移动短号', '备注'],
      ['冒烟部门甲', '冒烟联系人甲', '主任', '13700000001', '6001', '冒烟备注甲'],
      ['冒烟部门乙', '冒烟联系人乙', '专责', '13700000002', '6002', '冒烟备注乙']
    ];
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '员工');
    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const doImport = async name => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name);
      fd.append('mode', 'replace'); // 主批后单步直导已废除，快照机制由两段式的确认端点触发
      const r = await fetch(base + '/api/contacts/import/confirm', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        signal: AbortSignal.timeout(15000)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const restore = file => api('POST', '/api/contacts/restore-snapshot', { token, body: { file } });
    const snaps = () => listOk('/api/contacts/import-snapshots', token);
    // 上限测试会清掉最早那份，私有副本保证收尾仍能把通讯录还原到 step 开始前
    const putBackInitial = async () => {
      if (!firstSnap) return;
      fs.mkdirSync(bkDir, { recursive: true });
      const target = path.join(bkDir, firstSnap);
      // 快照名按秒生成且上限会清理最旧份：同名文件可能已被后续写入复用（内容不再是初始快照），
      // 所以每次都用 step 私有副本覆盖回去，保证恢复端点读到的一定是导入前数组。
      fs.copyFileSync(path.join(privateDir, firstSnap), target);
      needOk(await restore(firstSnap), '收尾还原初始通讯录');
    };

    try {
      /* 1. 触发快照：文件落盘 + 清单含该份 + 条数与导入前一致 */
      const imp = await doImport('contacts-snapshot-smoke.xlsx');
      need(imp.status === 200 && imp.data.imported === 2, '覆盖式导入失败：' + brief(imp.data));
      firstSnap = String(imp.data.snapshot || '');
      need(SNAP_RE.test(firstSnap), '响应应带合法快照文件名：' + brief(imp.data));
      const snapAbs = path.join(bkDir, firstSnap);
      need(fs.existsSync(snapAbs), '快照文件未落盘：' + snapAbs);
      const snapData = JSON.parse(fs.readFileSync(snapAbs, 'utf8'));
      need(Array.isArray(snapData) && snapData.length === initialContacts.length,
        '快照应原样保存导入前 ' + initialContacts.length + ' 条（含逻辑删除），实为 ' + (snapData || []).length);
      fs.copyFileSync(snapAbs, path.join(privateDir, firstSnap));
      const l1 = await snaps();
      const hit = l1.find(x => x.file === firstSnap);
      need(hit && hit.count === initialContacts.length && hit.createdAt,
        '清单应含该快照且条数/时间正确：' + brief(hit));
      need(l1.every(x => x.file && x.createdAt && typeof x.count === 'number'), '清单字段应为 file/createdAt/count');
      need(l1.every((x, i) => !i || l1[i - 1].createdAt >= x.createdAt), '清单应按时间倒序');
      need((await listOk('/api/contacts', token)).length === 2, '导入后通讯录应为 2 条');

      /* 2. 修改后恢复 → 数据回到快照时状态 */
      const rs1 = needOk(await restore(firstSnap), '恢复快照');
      need(rs1.restored === initialContacts.length, '恢复条数应为 ' + initialContacts.length + '：' + brief(rs1));
      need(JSON.stringify(await listOk('/api/contacts', token)) === JSON.stringify(alive0),
        '恢复后通讯录应逐字段回到导入前状态');

      /* 3. 恢复本身可逆：恢复前再快照，可再恢复回去 */
      need(SNAP_RE.test(String(rs1.snapshot || '')) && rs1.snapshot !== firstSnap &&
        fs.existsSync(path.join(bkDir, rs1.snapshot)), '恢复前应再生成一份新快照：' + brief(rs1));
      need((await snaps()).some(x => x.file === rs1.snapshot), '清单应含恢复前新快照');
      needOk(await restore(rs1.snapshot), '再恢复回去');
      need((await listOk('/api/contacts', token)).length === 2, '再恢复应回到导入后的 2 条');

      /* 4. 份数上限：连续生成超过 5 份后目录与清单都只剩最近 5 份 */
      for (let i = 0; i < 7; i++) {
        const r = await doImport('contacts-limit-' + i + '.xlsx');
        need(r.status === 200, '第 ' + (i + 1) + ' 次上限测试导入失败：' + brief(r.data));
      }
      need(bkFiles().length === 5, '快照目录应只保留最近 5 份，实为 ' + bkFiles().length);
      need((await snaps()).length === 5, '清单端点也应只返回 5 份');

      /* 5. 安全：清单外文件名与路径穿越样式 → 400，且数据不变 */
      need((await restore('contacts-19990101000000.json')).status === 400, '清单外文件名应 400');
      need((await restore('../db.json')).status === 400, '路径穿越样式应 400');
      need((await restore('..%2fcontacts-19990101000000.json')).status === 400, '编码路径穿越样式应 400');
      need((await listOk('/api/contacts', token)).length === 2, '非法恢复请求不得改动通讯录');

      /* 收尾：走恢复端点把数据还原，不改库结构、不改快照机制 */
      await putBackInitial();
      const aliveFinal = await listOk('/api/contacts', token);
      need(JSON.stringify(aliveFinal) === JSON.stringify(alive0),
        '收尾应把通讯录还原到 step 开始前状态：' + brief(aliveFinal));
      return '落盘/清单/回滚/可逆/5 份上限/3 类非法参数 400 + 数据与快照文件清理';
    } finally {
      // 成功或失败都尽力还原数据；只删本 step 新增的快照，保留 step 前已有文件
      try { await putBackInitial(); } catch (e) { /* 不掩盖主体的错误 */ }
      bkFiles().forEach(f => {
        if (!preFiles.includes(f)) { try { fs.unlinkSync(path.join(bkDir, f)); } catch (e) { } }
      });
      if (!preFiles.length && fs.existsSync(bkDir) && bkFiles().length === 0) {
        try { fs.rmSync(bkDir, { recursive: true, force: true }); } catch (e) { }
      }
      try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch (e) { }
    }
  });

  /* ---------- 通讯录导入改造：常驻回归（主批新增） ---------- */
  await step('system', '通讯录导入校验与预览：手机格式/文件内判重/双模式分类', async () => {
    const cH = ['部门', '姓名', '职务', '手机', '移动短号', '备注'];
    const cMk = rows => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '员工');
      return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const cPreview = async (rows, mode) => {
      const fd = new FormData();
      fd.append('file', new Blob([cMk(rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'c.xlsx');
      fd.append('mode', mode || 'merge');
      const r = await fetch(base + '/api/contacts/import/preview', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        signal: AbortSignal.timeout(15000)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const errText = r => JSON.stringify(r.data || {});

    const badPhone = await cPreview([cH, ['部门甲', '冒烟校验甲', '', '1380000001', '', '']]);
    need(badPhone.status === 400 && /第2行/.test(errText(badPhone)) && /手机号/.test(errText(badPhone)),
      '10 位手机号应整批拒并指行：' + brief(badPhone.data));
    const dupSame = await cPreview([cH, ['部门甲', '同名', '', '13800000001', '', ''], ['部门乙', '同名', '', '13800000001', '', '']]);
    need(dupSame.status === 400 && /第2行与第3行/.test(errText(dupSame)),
      '文件内同名同号应拒且报错含两行行号：' + brief(dupSame.data));
    const dupPhone = await cPreview([cH, ['部门甲', '甲', '', '13800000002', '', ''], ['部门乙', '乙', '', '13800000002', '', '']]);
    need(dupPhone.status === 400 && /第2行与第3行/.test(errText(dupPhone)) && /姓名不同/.test(errText(dupPhone)),
      '文件内同号异名应拒且报错含两行行号：' + brief(dupPhone.data));
    const sameNameDiff = await cPreview([cH, ['部门甲', '同名', '', '13800000003', '', ''], ['部门乙', '同名', '', '13800000004', '', '']]);
    need(sameNameDiff.status === 200, '同名不同号不应报错、应正常进分类：' + brief(sameNameDiff.data));

    const mix = await cPreview([
      cH,
      ['冒烟部门', '冒烟新人甲', '', '13700000011', '', ''],
      ['冒烟单位', '李四', '新职务', '13900139000', '', ''],
      ['冒烟部门', '李四', '', '13700000012', '', '']
    ], 'merge');
    need(mix.status === 200, '增量预览失败：' + brief(mix.data));
    const s = mix.data.summary || {};
    need(s['新增'] === 1 && s['更新'] === 1 && s['同名待确认'] === 1,
      '增量分类应为 新增1/更新1/同名待确认1：' + brief(s));
    const upd = (mix.data.rows || []).find(r => r.kind === '更新');
    need(upd && upd.diffs.length === 1 && upd.diffs[0].field === '职务',
      '更新差异应只列职务：' + brief(upd));
    const noChange = await cPreview([cH, ['冒烟单位', '李四', '', '13900139000', '', '']], 'merge');
    need(noChange.status === 200 && noChange.data.summary['无变化'] === 1,
      '同名同号且无字段变化应为无变化：' + brief(noChange.data));
    const conflict = await cPreview([cH, ['冒烟部门', '冒烟异名', '', '13900139000', '', '']], 'merge');
    need(conflict.status === 200 && conflict.data.summary['冲突'] === 1,
      '同号异名应为冲突：' + brief(conflict.data));
    const rep = await cPreview([cH, ['冒烟部门', '冒烟新人乙', '', '13700000021', '', '']], 'replace');
    need(rep.status === 200 && rep.data.summary['将删除'] === 1 && (rep.data.deleteList || []).some(x => x.name === '李四'),
      '覆盖预览应列出将删除名单：' + brief(rep.data));
    return '4 类行校验 + 增量五类分类 + 覆盖将删除名单（预览全程不写库）';
  });

  await step('system', '通讯录导入确认：增量有值更新/不删人、覆盖整表、快照回滚', async () => {
    const cH = ['部门', '姓名', '职务', '手机', '移动短号', '备注'];
    const cMk = rows => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '员工');
      return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const bkDir = path.join(TMP, 'data', 'backups', 'contacts');
    const SNAP_RE = /^contacts-\d{14}(?:-\d+)?\.json$/;
    const bkFiles = () => fs.existsSync(bkDir) ? fs.readdirSync(bkDir).filter(n => SNAP_RE.test(n)) : [];
    const preFiles = bkFiles();
    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-smoke-cimp-'));
    const dbPath = path.join(TMP, 'data', 'db.json');
    const initial = JSON.parse(fs.readFileSync(dbPath, 'utf8')).contacts || [];
    let firstSnap = '';
    const confirmBuf = async (buf, mode, decisions, name) => {
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name || 'c.xlsx');
      fd.append('mode', mode || 'merge');
      fd.append('decisions', JSON.stringify(decisions || []));
      const r = await fetch(base + '/api/contacts/import/confirm', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd,
        signal: AbortSignal.timeout(15000)
      });
      return { status: r.status, data: await r.json().catch(() => ({})) };
    };
    const restore = file => api('POST', '/api/contacts/restore-snapshot', { token, body: { file } });
    // 快照名按秒生成且上限会清理最早份：用私有副本覆盖回目标文件名再恢复，保证回到初始数组
    const putBack = async () => {
      if (!firstSnap) return;
      fs.mkdirSync(bkDir, { recursive: true });
      fs.copyFileSync(path.join(privateDir, firstSnap), path.join(bkDir, firstSnap));
      needOk(await restore(firstSnap), '收尾还原初始通讯录');
    };
    try {
      // 1) 导出回灌（覆盖）：生成初始快照，同时验证 imported 口径
      const exp = await fetch(base + '/api/contacts/export', { headers: { Authorization: 'Bearer ' + token } });
      const expBuf = Buffer.from(await exp.arrayBuffer());
      const r0 = await confirmBuf(expBuf, 'replace', [], 'export.xlsx');
      need(r0.status === 200 && r0.data.added === 1 && r0.data.imported === 1,
        '导出回灌覆盖应 imported=1：' + brief(r0.data));
      firstSnap = String(r0.data.snapshot || '');
      need(SNAP_RE.test(firstSnap) && fs.existsSync(path.join(bkDir, firstSnap)), '覆盖前快照应生成');
      fs.copyFileSync(path.join(bkDir, firstSnap), path.join(privateDir, firstSnap));
      const list0 = await listOk('/api/contacts', token);

      // 2) 增量新增 2 人
      const r1 = await confirmBuf(cMk([
        cH,
        ['部门甲', '增量甲', '专责', '13700000031', '', '备注甲'],
        ['部门乙', '增量乙', '主任', '13700000032', '', '备注乙']
      ]), 'merge');
      need(r1.status === 200 && r1.data.added === 2 && r1.data.updated === 0,
        '增量应新增 2 人：' + brief(r1.data));
      const before = await listOk('/api/contacts', token);
      const jia = before.find(c => c.name === '增量甲'), yi = before.find(c => c.name === '增量乙');
      need(jia && yi, '新增后应能查到两人');

      // 3) 增量有值更新：只改甲的职务，文件外的人（乙 / 李四）完全不动
      const r2 = await confirmBuf(cMk([cH, ['部门甲', '增量甲', '班长', '13700000031', '', '备注甲']]), 'merge');
      need(r2.status === 200 && r2.data.added === 0 && r2.data.updated === 1,
        '增量应只更新 1 人：' + brief(r2.data));
      const after = await listOk('/api/contacts', token);
      const jia2 = after.find(c => c.id === jia.id), yi2 = after.find(c => c.id === yi.id);
      const li2 = after.find(c => c.name === '李四');
      need(jia2 && jia2.post === '班长' && jia2.id === jia.id && jia2.createdAt === jia.createdAt,
        '更新者应保留 id/createdAt 且职务变更：' + brief(jia2));
      need(yi2 && JSON.stringify(yi2) === JSON.stringify(yi), '文件外联系人应完全不变');
      need(li2 && JSON.stringify(li2) === JSON.stringify(list0.find(c => c.name === '李四')),
        '文件外的库内原联系人应完全不变');

      // 4) 同名待确认：默认新增 / 库内两个同名时指明目标更新号码
      const r3 = await confirmBuf(cMk([cH, ['部门丙', '增量甲', '', '13900000099', '', '']]), 'merge',
        [{ rowNo: 2, action: 'add' }]);
      need(r3.status === 200 && r3.data.added === 1, '同名默认新增应 added=1：' + brief(r3.data));
      const r4 = await confirmBuf(cMk([cH, ['部门丙', '增量甲', '', '13900000098', '', '']]), 'merge',
        [{ rowNo: 2, action: 'update', targetId: jia.id }]);
      need(r4.status === 200 && r4.data.updated === 1 && r4.data.added === 0,
        '指明目标更新号码应 updated=1 且不新增：' + brief(r4.data));
      const after4 = await listOk('/api/contacts', token);
      const jia4 = after4.find(c => c.id === jia.id);
      need(jia4 && jia4.phone === '13900000098' && jia4.createdAt === jia.createdAt,
        '更新号码后 id/createdAt 不变、手机应为新号码：' + brief(jia4));

      // 5) 导出回灌增量：全部无变化
      const exp2 = await fetch(base + '/api/contacts/export', { headers: { Authorization: 'Bearer ' + token } });
      const r5 = await confirmBuf(Buffer.from(await exp2.arrayBuffer()), 'merge', [], 'export2.xlsx');
      need(r5.status === 200 && r5.data.added === 0 && r5.data.updated === 0,
        '导出回灌增量应全部无变化：' + brief(r5.data));

      // 6) 覆盖模式：整表与文件一致、deleted 计数、快照生成
      const r6 = await confirmBuf(cMk([
        cH, ['部门X', '覆盖甲', '', '13700000041', '', ''], ['部门Y', '覆盖乙', '', '13700000042', '', '']
      ]), 'replace');
      need(r6.status === 200 && r6.data.added === 2 && r6.data.deleted === after4.length &&
        SNAP_RE.test(String(r6.data.snapshot || '')), '覆盖应 added=2 / deleted 为导入前人数 / 生成快照：' + brief(r6.data));
      const list6 = await listOk('/api/contacts', token);
      need(list6.length === 2 && list6.every(c => /^覆盖/.test(c.name)), '覆盖后整表应与文件一致');

      // 7) 恢复初始快照：新增与更新全部回滚
      await putBack();
      const cur = JSON.parse(fs.readFileSync(dbPath, 'utf8')).contacts || [];
      need(JSON.stringify(cur) === JSON.stringify(initial), '恢复快照后 contacts 应逐字段回到初始状态');
      return '导出回灌 / 增量有值更新 / 文件外不动 / 同名决策 / 覆盖整表 / 快照回滚 + 清理';
    } finally {
      try { await putBack(); } catch (e) { /* 不掩盖主体错误 */ }
      bkFiles().forEach(f => {
        if (!preFiles.includes(f)) { try { fs.unlinkSync(path.join(bkDir, f)); } catch (e) { } }
      });
      if (!preFiles.length && fs.existsSync(bkDir) && bkFiles().length === 0) {
        try { fs.rmSync(bkDir, { recursive: true, force: true }); } catch (e) { }
      }
      try { fs.rmSync(privateDir, { recursive: true, force: true }); } catch (e) { }
    }
  });

  await step('users', '准入到期预警派生状态：日期边界/自动转待定/公告栏排序（前端共用纯函数）', async () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');
    const sb = { window: {} };
    vm.createContext(sb);
    vm.runInContext(code, sb);
    const WS = sb.window.WorkerStatus;
    need(WS && typeof WS.of === 'function' && typeof WS.alerts === 'function', 'utils.js 应导出 WorkerStatus.of / alerts');
    const T = '2026-11-09';
    const d = off => new Date(Date.parse(T + 'T00:00:00Z') + off * 86400000).toISOString().slice(0, 10);
    const mk = (status, end, extra) => Object.assign({
      id: 'x', name: 'n', status, validStart: '2026-01-01', validEnd: end
    }, extra || {});

    const s30 = WS.of(mk('已准入', d(30)), T);
    need(s30.days === 30 && s30.warn === true && s30.highlight === true && s30.derived === '已准入',
      '结束日=今天+30 应预警：' + brief(s30));
    const s31 = WS.of(mk('已准入', d(31)), T);
    need(s31.days === 31 && s31.warn === false && s31.highlight === false,
      '结束日=今天+31 不应预警：' + brief(s31));
    const s0 = WS.of(mk('已准入', T), T);
    need(s0.days === 0 && s0.warn === true && s0.admitted === true,
      '结束日=今天应剩 0 天且仍预警：' + brief(s0));
    const sNeg = WS.of(mk('已准入', d(-1)), T);
    need(sNeg.derived === '待定' && sNeg.overdue === true && sNeg.overdueDays === 1 && sNeg.admitted === false,
      '昨天到期应自动转待定、超期 1 天：' + brief(sNeg));
    const sEmpty = WS.of(mk('已准入', ''), T);
    need(sEmpty.days === null && sEmpty.derived === '已准入' && sEmpty.highlight === false,
      '有效期为空按存储状态、不触发转换：' + brief(sEmpty));
    const sPending = WS.of(mk('待定', d(10)), T);
    need(sPending.derived === '待定' && sPending.highlight === false && sPending.admitted === false,
      '存储待定 + 未来有效期仍待定且不预警：' + brief(sPending));

    const al = WS.alerts([
      mk('已准入', d(10), { id: 'b', name: 'B' }),
      mk('已准入', d(-3), { id: 'a', name: 'A' }),
      mk('已准入', d(2), { id: 'c', name: 'C' }),
      mk('已准入', d(31), { id: 'd', name: 'D' }),
      mk('待定', d(1), { id: 'e', name: 'E' })
    ], T);
    need(al.length === 3 && al[0].id === 'a' && al[1].id === 'c' && al[2].id === 'b',
      '公告栏应超期在前、其余按到期日升序，排除 +31 与存储待定：' + brief(al));
    need(al[0].overdueDays === 3 && al[1].days === 2 && al[2].days === 10,
      '公告栏超期天数 / 剩余天数应正确：' + brief(al));
    return '+30/+31/今天/昨天/空有效期/存储待定 6 个边界 + 公告栏排序';
  });

  await step('feed', '工作动态预警聚合：技工优先点名 / 等 N 人拼装 + 3 天窗口与日期标签纯函数', async () => {
    const vm = require('vm');
    const code = fs.readFileSync(path.join(ROOT, 'public', 'js', 'work-feed.js'), 'utf8');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(code, sb);
    const F = sb.window.WorkFeed;
    need(F && typeof F.alertMessage === 'function' && typeof F.build === 'function' &&
      typeof F.inWindow === 'function', 'work-feed.js 应导出 alertMessage / build / inWindow');

    const T = '2026-11-09';
    const alerts = [
      { id: 'a', name: '民工甲', validEnd: '2026-11-10' },
      { id: 'b', name: '技工乙', validEnd: '2026-11-20' },
      { id: 'c', name: '民工丙', validEnd: '2026-11-11' },
      { id: 'd', name: '技工丁', validEnd: '2026-11-19' },
      { id: 'e', name: '其他技工戊', validEnd: '2026-11-12' }
    ];
    const workers = [
      { id: 'a', identity: '民工' }, { id: 'b', identity: '技工（计入高处作业人员）' },
      { id: 'c', identity: '民工' }, { id: 'd', identity: '技工（计入高处作业人员）' },
      { id: 'e', identity: '其他技工（不计入高处作业人员）' }
    ];
    const m5 = F.alertMessage(alerts, workers);
    need(m5 && m5.text === '技工丁、技工乙、民工甲 等5人准入有效期已到期或即将到期，请及时续期',
      '5 人应只点名前 3 名（精确技工优先、同组按到期日升序），N=总人数 5：' + brief(m5));
    need(m5.kind === 'alert' && m5.nav === 'users' && m5.usersTab === 'workers',
      '预警条目应落在作业人员名单页：' + brief(m5));
    const m3 = F.alertMessage(alerts.slice(0, 3), workers);
    need(m3 && m3.text === '技工乙、民工甲、民工丙准入有效期已到期或即将到期，请及时续期' && !/等/.test(m3.text),
      '≤3 人应全列且不带「等」：' + brief(m3));
    const m1 = F.alertMessage([alerts[0]], workers);
    need(m1 && m1.text === '民工甲准入有效期已到期或即将到期，请及时续期' && !/等/.test(m1.text),
      '1 人应是单人句式：' + brief(m1));
    need(F.alertMessage([], workers) === null, '0 人不应产出预警条目');

    need(F.bjDay('2026-11-07T16:00:00.000Z') === '2026-11-08', 'UTC ISO 应转北京自然日：' + F.bjDay('2026-11-07T16:00:00.000Z'));
    need(F.bjDay('2026-11-09 08:13') === '2026-11-09', '北京时间字符串前 10 位即自然日');
    need(F.dayLabel(T, T) === '今日' && F.dayLabel('2026-11-08', T) === '昨日' &&
      F.dayLabel('2026-11-07', T) === '11-07', '日期标签 今日 / 昨日 / MM-DD');
    need(F.inWindow(T, T) && F.inWindow('2026-11-08', T) && F.inWindow('2026-11-07', T) &&
      !F.inWindow('2026-11-06', T) && !F.inWindow('2026-11-10', T) && !F.inWindow('', T),
      '3 天窗口应含今天/昨天/前天，排除第 4 天前、未来与空值');
    return '点名排序 5/3/1/0 四种句式 + ISO/北京时间转换 + 日期标签 + 窗口边界';
  });

  await step('feed', '四类动态来源：3 天窗口边界 / 同日多批次合并 / 排序 / 退场口径', async () => {
    const vm = require('vm');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'work-feed.js'), 'utf8'), sb);
    const F = sb.window.WorkFeed;
    const T = '2026-11-09';
    const iso = d => d + 'T04:00:00.000Z';      // 对应北京时间当天 12:00
    const workers = [
      { id: 'p1', name: '甲', identity: '技工（计入高处作业人员）', status: '已退场', exitedAt: '2026-11-09 08:00' },
      { id: 'p2', name: '乙', identity: '民工', status: '已退场', exitedAt: '2026-11-09 09:00' },
      { id: 'p3', name: '丙', identity: '民工', status: '已退场', exitedAt: '2026-11-08 10:00' },
      { id: 'p4', name: '丁', identity: '民工', status: '已退场', exitedAt: '2026-11-06 10:00' },
      { id: 'p5', name: '戊', identity: '民工', status: '已退场' },
      { id: 'p6', name: '己', identity: '民工', status: '已准入', exitedAt: '2026-11-09 11:00' },
      { id: 'w1', name: '预警甲', identity: '技工（计入高处作业人员）', status: '已准入', validEnd: '2026-11-10' }
    ];
    const imports = [
      { id: 'i1', importedAt: '2026-11-09 08:10', rowsTotal: 10, materialIds: ['a', 'b', 'c'] },
      { id: 'i2', importedAt: '2026-11-09 09:10', rowsTotal: 20, materialIds: ['d', 'e', 'f', 'g'] },
      { id: 'i3', importedAt: '2026-11-08 08:10', rowsTotal: 5, materialIds: ['h', 'i'] },
      { id: 'i4', importedAt: '2026-11-06 08:10', rowsTotal: 99, materialIds: ['x'] }
    ];
    const materials = [
      { id: 'm0', createdAt: iso('2026-11-07') },
      { id: 'm1', createdAt: iso(T), importId: 'i1' },
      { id: 'm2', createdAt: iso('2026-11-06') }
    ];
    const plans = [
      { id: 'q1', createdAt: iso(T), planType: '周计划' },
      { id: 'q2', createdAt: iso(T), planType: '周计划' },
      { id: 'q3', createdAt: iso(T), planType: '月计划' },
      { id: 'q4', createdAt: iso('2026-11-06'), planType: '周计划' },
      { id: 'q5', createdAt: iso(T), planType: '其他' }
    ];
    const borrow = [{ id: 'b1', createdAt: iso(T) }, { id: 'b2', createdAt: iso('2026-11-06') }];
    const alerts = [{ id: 'w1', name: '预警甲', validEnd: '2026-11-10' }];
    const out = F.build({ workers, alerts, imports, materials, plans, borrow, today: T });
    const texts = out.messages.map(m => m.text);
    need(out.alertCount === 1 && out.messages[0].kind === 'alert', '预警应置顶且徽标人数=1：' + brief(out.messages.slice(0, 2)));
    const expect = [
      '今日甲、乙已退场',
      '今日录入材料 30 条，新增 7 条',
      '今日新增周计划 2 条',
      '今日新增月计划 1 条',
      '今日新增借工记录 1 条',
      '昨日丙已退场',
      '昨日录入材料 5 条，新增 2 条',
      '11-07新增材料 1 条'
    ];
    need(JSON.stringify(texts.slice(1)) === JSON.stringify(expect),
      '动态文案 / 排序 / 窗口 / 同日合并应完全匹配：' + brief(texts.slice(1)));
    need(!/丁|戊|己/.test(texts.join('|')), '窗口外、无 exitedAt、已恢复准入的人员都不应出现');
    need(!/99 条|11-06/.test(texts.join('|')), '第 4 天前的批次 / 计划 / 借工不应出现');
    return '8 条动态（今日 5 / 昨日 2 / 前天 1）+ 3 天窗口 + 同日两批合并 10+20→30、3+4→7';
  });

  await step('users', '退场能力：exitedAt 落库/清空 + 已退场派生不可选 + 导入状态枚举', async () => {
    const vm = require('vm');
    const sys = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'system.js'), 'utf8');
    need(/const WORKER_STATUS = \['已准入', '待定'\]/.test(sys), '后端导入状态白名单应恰为两值（不含「已退场」）');
    const sb = { window: {} };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8'), sb);
    const WS = sb.window.WorkerStatus;
    const s = WS.of({ status: '已退场', validEnd: '2026-12-31' }, '2026-11-09');
    need(s.derived === '已退场' && s.admitted === false && !s.warn && !s.highlight,
      '已退场应派生为已退场、不可选、不预警：' + brief(s));
    need(WS.alerts([{ id: 'x', name: 'x', status: '已退场', validEnd: '2026-11-10' }], '2026-11-09').length === 0,
      '已退场不计入准入预警');

    const legacy = (await listOk('/api/workers', token)).find(w => !('exitedAt' in w));
    need(legacy, '应存在无 exitedAt 的存量记录');
    const t1 = '2026-11-09 21:00:00';
    needOk(await api('PUT', '/api/workers/' + legacy.id, { token, body: { status: '已退场', exitedAt: t1 } }), '退场 PUT');
    const g1 = needOk(await api('GET', '/api/workers/' + legacy.id, { token }), '退场后 GET');
    need(g1.status === '已退场' && g1.exitedAt === t1, '退场后 exitedAt 应落库：' + brief(g1));
    needOk(await api('PUT', '/api/workers/' + legacy.id, { token, body: { status: '已准入', exitedAt: null } }), '恢复准入 PUT');
    const g2 = needOk(await api('GET', '/api/workers/' + legacy.id, { token }), '恢复后 GET');
    need(g2.status === '已准入' && g2.exitedAt === null, '恢复准入后 exitedAt 应清空：' + brief(g2));
    const others = await listOk('/api/workers', token);
    need(others.some(w => !('exitedAt' in w)), '其余存量无 exitedAt 记录仍可正常读取');
    return '退场写入 / 恢复清空 / 派生不可选 / 导入枚举对齐 / 存量无字段不报错';
  });

  await step('feed', '工作动态九类来源：项目/领料/出库/作业/资料 + 新增人员 / 窗口与同天合并', async () => {
    const vm = require('vm');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'work-feed.js'), 'utf8'), sb);
    const F = sb.window.WorkFeed;
    const T = '2026-11-10';
    const iso = d => d + 'T04:00:00.000Z';       // 对应北京时间当天 12:00
    const out = F.build({
      today: T, alerts: [],
      workers: [
        { id: 'u1', name: '新甲', status: '待定', createdAt: iso(T) },
        { id: 'u2', name: '新乙', status: '已准入', createdAt: iso(T) },
        { id: 'u3', name: '老丙', status: '已准入', createdAt: iso('2026-11-01') },   // 窗口外
        { id: 'u4', name: '走丁', status: '已退场', exitedAt: '2026-11-09 09:00', createdAt: iso('2026-10-01') }
      ],
      imports: [], materials: [],
      plans: [{ id: 'q1', planType: '周计划', createdAt: iso(T) }],
      projects: [{ id: 'j1', createdAt: iso(T) }, { id: 'j2', createdAt: iso(T) }, { id: 'j3', createdAt: iso('2026-10-30') }],
      requisitions: [{ id: 'r1', createdAt: iso(T) }, { id: 'r2', createdAt: iso(T) }, { id: 'r3', createdAt: iso(T) }],
      outbound: [{ id: 'o1', createdAt: iso('2026-11-09') }],
      works: [{ id: 'k1', createdAt: iso(T) }],
      docs: [{ id: 'd1', createdAt: iso(T) }],
      borrow: []
    });
    const texts = out.messages.map(m => m.text);
    [
      '今日新增作业人员 2 人', '今日新增项目 2 个', '今日新增领料单 3 张',
      '今日新增周计划 1 条', '今日新增实际工作量记录 1 条', '今日新增竣工资料 1 份',
      '昨日新增出库单 1 张', '昨日走丁已退场'
    ].forEach(t => need(texts.indexOf(t) > -1, '缺少「' + t + '」，实际：' + brief(texts)));
    need(!/老丙/.test(texts.join('|')) && !/10-30/.test(texts.join('|')), '窗口外的项目 / 新增人员不应出现');
    need(!/新增作业人员 3/.test(texts.join('|')), '窗口外的新增人员不应计数');
    const kinds = out.messages.map(m => m.kind);
    ['project', 'requisition', 'outbound', 'work', 'doc'].forEach(k =>
      need(kinds.indexOf(k) > -1, '九类来源缺 kind=' + k + '：' + brief(kinds)));
    return '8 条（新增人员/项目/领料/计划/作业/资料 + 昨日出库/退场）+ 窗口过滤';
  });

  await step('结构', '首页工作动态：来源模块加载顺序 + 十类标签 + 卡片形态静态断言', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const dash = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'dashboard.js'), 'utf8');
    const iU = html.indexOf('<script src="/js/utils.js"></script>');
    const iF = html.indexOf('<script src="/js/work-feed.js"></script>');
    const iD = html.indexOf('<script src="/js/views/dashboard.js"></script>');
    need(iU > -1 && iF > iU && iD > iF, 'work-feed.js 必须在 utils 之后、dashboard 之前加载');
    ['alert', 'person', 'material', 'plan', 'borrow', 'project', 'requisition', 'outbound', 'work', 'doc'].forEach(function (k) {
      need(html.includes('.fd-tag-' + k + ' {'), '缺少标签样式 .fd-tag-' + k);
      need(html.includes('html.dark .fd-tag-' + k + ' {'), '缺少深色模式样式 .fd-tag-' + k);
    });
    need(html.includes('max-height: 186px') && html.includes('max-height: 176px'), '一屏 5 条（桌面 / 移动端）滚动高度');
    need(html.includes('flex: 0 0 33.3333%'), '卡片应保持约 1/3 宽');
    need(dash.includes('工作动态') && dash.includes('近 3 天无新增记录') && dash.includes('WorkFeed.build'), '标题 / 空态 / 聚合入口');
    need(/const pick = async/.test(dash), '各接口应独立容错，不得再用 Promise.all 一处失败整块清空');
    need(dash.includes("projects: p") && dash.includes("requisitions: r") && dash.includes("outbound: outs"),
      '九类来源应全部接入 build()');
    need(dash.includes('/api/materialOutbound') && dash.includes('/api/actualWorks') && dash.includes('/api/completionDocuments'),
      '应取领料 / 出库 / 作业 / 资料接口');
    need(!dash.includes('__pendingFocusWorker = {'), '预警点击不得再直开编辑弹窗');
    return '脚本顺序 / 十类浅深两套 / 5 条滚动 / 1/3 宽 / 标题空态 / 按源容错 / 九类接线';
  });

  await step('users', '导入白名单两值 + 已退场导出映射为待定（导出回导入闭环）', async () => {
    const mkBuf = rows => {
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), '作业人员名单');
      return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    };
    const HEAD = ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'];
    const saved = workerMixBuf;
    const before = (await listOk('/api/workers', token)).length;

    // 1) 含「已退场」的文件整批拒绝，报错文案回到两值，且不写库
    workerMixBuf = mkBuf([HEAD,
      ['冒烟退场行', '510301199001010010', '13800000099', '', '', '', '', '已退场']]);
    const bad = await workerUpload('/api/workers/import/preview');
    need(bad.status === 400 && /仅支持：已准入 \/ 待定/.test(String((bad.data || {}).error || '')),
      '含已退场行应整批拒绝且报错回到两值：' + brief(bad.data));
    need((await listOk('/api/workers', token)).length === before, '被拒文件不得写库');

    // 2) 纯已准入 / 待定文件预览如常
    workerMixBuf = mkBuf([HEAD,
      ['冒烟白名单甲', '510301199001010002', '13800000091', '', '', '', '', '已准入'],
      ['冒烟白名单乙', '510301199001010029', '13800000092', '', '', '', '', '待定']]);
    const good = await workerUpload('/api/workers/import/preview');
    need(good.status === 200 && good.data && good.data.ok, '纯两值文件应正常预览：' + brief(good.data));

    // 3) 库内含已退场人员时导出：该行写「待定」，其余原值、库内值不变
    needOk(await api('POST', '/api/workers', { token, body: {
      name: '冒烟已退场导出', idNumber: '510301199001010002', phone: '13800000088',
      status: '已退场', exitedAt: '2026-11-09 21:00:00'
    } }), 'POST 已退场人员');
    const er = await fetch(base + '/api/workers/export', { headers: { Authorization: 'Bearer ' + token } });
    need(er.ok, '导出 GET 应 2xx，实际 ' + er.status);
    const buf = Buffer.from(await er.arrayBuffer());
    const ewb = xlsx.read(buf, { type: 'buffer' });
    const rows = xlsx.utils.sheet_to_json(ewb.Sheets[ewb.SheetNames[0]], { header: 1 });
    const ni = rows[0].indexOf('姓名'), si = rows[0].indexOf('状态');
    const exitedRow = rows.slice(1).find(r => r[ni] === '冒烟已退场导出');
    need(exitedRow && exitedRow[si] === '待定', '已退场行导出状态应为「待定」：' + brief(exitedRow));
    const statuses = rows.slice(1).map(r => r[si]);
    need(!statuses.includes('已退场') && statuses.includes('待定') && statuses.includes('已准入'),
      '导出文件不应出现「已退场」且其余行保持原值：' + brief([...new Set(statuses)]));
    const dbRow = (await listOk('/api/workers', token)).find(w => w.name === '冒烟已退场导出');
    need(dbRow && dbRow.status === '已退场', '导出映射不得改库内值：' + brief(dbRow));

    // 4) 这份导出文件直接回导入：不因状态被拒
    workerMixBuf = buf;
    const loop = await workerUpload('/api/workers/import/preview');
    need(loop.status === 200 && loop.data && loop.data.ok,
      '导出文件回导入应正常走完（不因状态被拒）：' + brief(loop.data));
    workerMixBuf = saved;
    return '已退场行整批拒绝 + 两值文件放行 + 导出写待定/其余原值/库内不变 + 导出回导入 200';
  });

  await step('结构', '名单状态筛选与已退场灰徽标静态防回归（两套模板一致）', async () => {
    const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'users.js'), 'utf8');
    need(/const WORKER_STATUS_FILTER_OPTIONS = \['已准入', '待定', '已退场'\]/.test(js), '状态下拉应为三档且只作显示');
    need(/filters\.status && wst\(w\)\.derived !== filters\.status/.test(js), '筛选谓词必须按 WorkerStatus 派生状态判定');
    need(/function resetFilters\(\)[^\n]*filters\.status = ''/.test(js), '重置必须清空状态筛选');
    const selects = js.match(/v-model="filters\.status"/g) || [];
    need(selects.length === 2, '两套名单模板应各有一个状态下拉，实际 ' + selects.length);
    need(/s\.derived === '已退场' \? 'info' : 'warning'/.test(js), '已退场徽标应为 info 灰、待定仍 warning');
    return '下拉三档 / 派生谓词 / 重置清空 / 两模板各一 / info 徽标';
  });

  await step('plans', '人员防冲突纯函数：parseStaff / overlaps 相接边界 / findConflicts 占用方口径', async () => {
    const vm = require('vm');
    const sb = { window: {}, module: { exports: {} } };
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'js', 'plan-staff.js'), 'utf8'), sb);
    const F = sb.window.PlanStaff;
    need(F && typeof F.parseStaff === 'function' && typeof F.findConflicts === 'function',
      'plan-staff.js 应导出 parseStaff / participantsOf / overlaps / findConflicts');

    const ps = F.parseStaff('张三/13800138000；李四/；王五/139/001');
    need(ps.length === 3 && ps[0].name === '张三' && ps[0].phone === '13800138000' &&
      ps[1].name === '李四' && ps[1].phone === '' &&
      ps[2].name === '王五/139' && ps[2].phone === '001',
      '分号分条目 / 最后一个斜杠分姓名电话 / 电话可空：' + brief(ps));
    need(F.parseStaff('').length === 0 && F.parseStaff(null).length === 0, '空名单应返回空数组');
    need(F.keyOf(' 张三 ', ' 138 ') === '张三|138', '比对键应去空白：' + F.keyOf(' 张三 ', ' 138 '));
    const parts = F.participantsOf({ staffText: '张三/13800138000；李四/', chargePerson: '张三', chargePersonPhone: '13800138000' });
    need(JSON.stringify(parts) === JSON.stringify(['张三|13800138000', '李四|']), '参与人键应含实施人员+负责人且去重：' + brief(parts));
    need(F.participantsOf({ staffText: '', chargePerson: '', chargePersonPhone: '139' }).length === 0, '负责人姓名为空不加键');

    const T = '2026-11-10';
    need(F.overlaps(T + ' 09:00:00', T + ' 12:00:00', T + ' 11:00:00', T + ' 14:00:00'), '重叠应判定冲突');
    need(!F.overlaps(T + ' 09:00:00', T + ' 12:00:00', T + ' 12:00:00', T + ' 14:00:00'), '首尾恰好相接不算冲突');
    need(!F.overlaps(T + ' 12:00:00', T + ' 14:00:00', T + ' 09:00', T + ' 12:00:00'), '相接（HH:mm / HH:mm:ss 混写）也不算冲突');
    need(!F.overlaps(T + ' 09:00:00', T + ' 12:00:00', '', T + ' 14:00:00'), '任一时间缺失返回 false');

    const A = { id: 'A', name: '计划A', planType: '周计划', status: '未执行',
      startDate: T + ' 09:00:00', endDate: T + ' 12:00:00',
      staffText: '张三/13800138000；李四/', chargePerson: '王五', chargePersonPhone: '13900000001' };
    const others = [
      A,
      { ...A, id: 'B', name: '月计划B', planType: '月计划' },
      { ...A, id: 'C', name: '已执行C', status: '已执行' },
      { ...A, id: 'D', name: '已取消D', status: '已取消' },
      { ...A, id: 'E', name: '不重叠E', startDate: T + ' 12:00:00', endDate: T + ' 14:00:00' },
      { ...A, id: 'F', name: '无状态F', status: '' }
    ];
    const cf = F.findConflicts(others, '', T + ' 10:00:00', T + ' 11:00:00');
    need(Object.keys(cf).length === 3 && cf['张三|13800138000'].length === 1 &&
      cf['张三|13800138000'][0].name === '计划A' && cf['李四|'] && cf['王五|13900000001'],
      '只计周计划+未执行+重叠；月计划/已执行/已取消/无状态/相接均排除：' + brief(Object.keys(cf)));
    need(Object.keys(F.findConflicts(others, 'A', T + ' 10:00:00', T + ' 11:00:00')).length === 0,
      'selfId 应排除自身计划');
    need(Object.keys(F.findConflicts(others, '', '', T + ' 11:00:00')).length === 0, '起止任一为空时不产生冲突');
    return '解析 3 项/空值/最后斜杠 + 相接边界（含混写）+ 占用方类型/状态/自排除/时间窗';
  });

  await step('结构', '计划管理优化批：日历页签与口径 / 高处全等 / 无班组排除 / 冲突接线静态防回归', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const p = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'plans.js'), 'utf8');
    const iS = html.indexOf('<script src="/js/plan-staff.js"></script>');
    const iP = html.indexOf('<script src="/js/views/plans.js"></script>');
    need(iS > -1 && iS < iP, 'plan-staff.js 必须先于 views/plans.js 加载');
    need(/p\.planType === '周计划'/.test(p) &&
      /!\['已归档', '已取消', '已执行', '已结算'\]\.includes\(p\.status\)/.test(p) &&
      /const upcoming = computed/.test(p), '日历 upcoming 应限周计划且排除归档/取消/执行/结算');
    // 日计划日历是周计划管理的东西：月计划/已归档/已执行/已结算/已取消五个页签一律不渲染
    need(/v-if="tab === 'week'"/.test(p) && !/v-if="tab !== 'month'"/.test(p),
      '日计划日历卡应只在 tab==="week" 显示，不得再用 tab !== "month"');
    need(/日计划日历只在「周计划管理」页签显示/.test(p), '日历卡上方注释应写明显示范围');
    need(/=== '技工（计入高处作业人员）'/.test(p) &&
      !/\.includes\('计入高处作业人员'\)/.test(p), 'highStaff 应全等匹配，不得用子串 includes');
    need(/WorkerStatus\.of\(w, ServerTime\.ymd\(\)\)\.admitted && String\(w\.team \|\| ''\)\.trim\(\)/.test(p) &&
      !/w\.team \|\| '未分组'/.test(p), 'groupedTeams 应先滤掉无班组人员且不再兜「未分组」');
    need(/findConflicts\(/.test(p) && /staffConflict\(/.test(p) && /ElMessageBox\.alert/.test(p),
      '视图层应调用 findConflicts / staffConflict 并有保存兜底弹窗');
    need(/<el-checkbox[^>]*:disabled="staffConflict\(w\)\.length > 0"/.test(p) &&
      !/staffConflictText|staffConflictTitle/.test(p) && !/已参与：/.test(p) && !/:title="staffConflict/.test(p),
      '选人弹窗对冲突人员只置灰，不得渲染「已参与」标注或悬停提示（2026-11-10 裁定）');
    const op = p.slice(p.indexOf('function openStaffPick'), p.indexOf('function toggleIdentity'));
    need(op.indexOf('请先填写计划开始时间') > -1 && op.indexOf('请先填写计划结束时间') > -1 &&
      op.indexOf('请先填写计划开始时间') < op.indexOf('staffPick.visible = true') &&
      op.indexOf('请先填写计划结束时间') < op.indexOf('staffPick.visible = true'),
      '选人弹窗必须在填完计划开始/结束时间后才允许打开（空时间先提示）');
    return '脚本顺序 / 日历仅周计划页签 + 四状态+类型 / 高处全等 / 无班组过滤 / 冲突接线 / 冲突只置灰无标注 / 选人先校验时间';
  });

  /* ---------- 周计划拆分 ---------- */
  await step('plans', '拆分解析器纯函数：日期标题/切段/跨月/条目结构/七类工程量/校验收集', async () => {
    const PS = require('../server/core/plan-split');
    const snap = splitPureChecks(PS);
    return '标题 4 形态 / 切段 5 例 / 日期 3 例 / 条目 4 例 / 工程量 6 例 / 校验 5 类 / 快照 ' + JSON.stringify(snap).length + ' 字节';
  });

  await step('plans', '拆分时间回归：同一组断言在 TZ=UTC 子进程复跑，结果一致', async () => {
    const PS = require('../server/core/plan-split');
    const here = JSON.stringify(splitPureChecks(PS));
    const script = 'const m=require(' + JSON.stringify(path.join(ROOT, 'scripts', 'smoke.js')) + ');' +
      'const PS=require(' + JSON.stringify(path.join(ROOT, 'server', 'core', 'plan-split.js')) + ');' +
      'process.stdout.write(JSON.stringify(m.splitPureChecks(PS)));';
    const out = await new Promise((resolve, reject) => {
      const cp = spawn(process.execPath, ['-e', script], {
        cwd: ROOT, env: { ...process.env, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let o = '', e = '';
      cp.stdout.on('data', d => { o += d; });
      cp.stderr.on('data', d => { e += d; });
      cp.on('error', reject);
      cp.on('exit', code => code === 0 ? resolve(o)
        : reject(new Error('TZ=UTC 子进程退出 ' + code + '：' + String(e).slice(0, 400))));
    });
    need(out === here, 'TZ=UTC 下与本地结果不一致：\n  本地（TZ=' + (process.env.TZ || '系统默认') + '）' +
      here.slice(0, 260) + '\n  UTC ' + out.slice(0, 260));
    return 'TZ=' + (process.env.TZ || '系统默认') + ' 与 TZ=UTC 快照逐字节一致（' + here.length + ' 字节）';
  });

  await step('plans', '拆分预览：单日/月计划/已执行 拒绝 + 时刻沿用 + 不落库 + 缺天逐天列全', async () => {
    const mk = async (body, label) => needOk(await api('POST', '/api/workPlans', { token, body }), label || 'plan POST').id;
    const base = { planType: '周计划', status: '未执行', startDate: '2026-11-11 08:00:00', endDate: '2026-11-12 10:00:00' };

    const twoId = await mk({ ...base, name: '冒烟预览两日', content: '11日：电杆组立3根；12日：电缆敷设1200米' });
    const pv = needOk(await api('POST', '/api/workPlans/' + twoId + '/split/preview', { token, body: {} }), 'preview');
    need(pv.ok === true && pv.days.length === 2, '预览应通过且切出 2 天：' + brief(pv));
    need(pv.days[0].start === '2026-11-11 08:00:00' && pv.days[0].end === '2026-11-11 10:00:00',
      '第一天起止应沿用父计划时刻：' + brief(pv.days[0]));
    need(pv.days[1].start === '2026-11-12 08:00:00' && pv.days[1].end === '2026-11-12 10:00:00',
      '第二天起止时刻错：' + brief(pv.days[1]));
    need(JSON.stringify(pv.days[0].quantities) === JSON.stringify({ wlPole: 3 }) &&
      JSON.stringify(pv.days[1].quantities) === JSON.stringify({ wlCable: 1.2 }),
      '预览工程量应按天归属：' + brief(pv.days.map(d => d.quantities)));
    const keep1 = needOk(await api('GET', '/api/workPlans/' + twoId, { token }), '预览后详情');
    need(!keep1.splitBatchId && !keep1.splitSnapshot && keep1.endDate === '2026-11-12 10:00:00',
      '预览不得落库：' + brief({ b: keep1.splitBatchId, s: !!keep1.splitSnapshot, e: keep1.endDate }));

    const oneId = await mk({ ...base, name: '冒烟预览单日', endDate: '2026-11-11 10:00:00', content: '11日：立杆3根' });
    const r1 = await api('POST', '/api/workPlans/' + oneId + '/split/preview', { token, body: {} });
    need(r1.status === 400 && /单日计划无需拆分/.test(r1.data.error), '单日计划应 400：' + r1.status + ' ' + brief(r1.data));

    const monId = await mk({ ...base, planType: '月计划', name: '冒烟预览月计划' });
    const r2 = await api('POST', '/api/workPlans/' + monId + '/split/preview', { token, body: {} });
    need(r2.status === 400 && /仅周计划支持拆分/.test(r2.data.error), '非周计划应 400：' + r2.status + ' ' + brief(r2.data));

    const doneId = await mk({ ...base, status: '已执行', name: '冒烟预览已执行' });
    const r3 = await api('POST', '/api/workPlans/' + doneId + '/split/preview', { token, body: {} });
    need(r3.status === 400 && /未执行/.test(r3.data.error), '已执行应 400：' + r3.status + ' ' + brief(r3.data));

    const badId = await mk({ ...base, name: '冒烟预览缺天', endDate: '2026-11-13 10:00:00', content: '11日：电杆组立3根' });
    const r4 = needOk(await api('POST', '/api/workPlans/' + badId + '/split/preview', { token, body: {} }), 'preview 缺天');
    need(r4.ok === false && r4.errors.indexOf('工作内容缺少计划日期：2026-11-12') > -1 &&
      r4.errors.indexOf('工作内容缺少计划日期：2026-11-13') > -1, '缺天应逐天列全：' + brief(r4.errors));
    const r5 = needOk(await api('POST', '/api/workPlans/' + badId + '/split/preview', { token, body: { content: '随便写点内容' } }), 'preview 无标题');
    need(r5.ok === false && /未识别到每日日期标题/.test(r5.errors[0]), '无标题应给格式提示：' + brief(r5.errors));
    const r6 = needOk(await api('POST', '/api/workPlans/' + badId + '/split/preview', { token, body: { content: '10日：A；11日：B；12日：C' } }), 'preview 超范围');
    need(r6.ok === false && r6.errors.some(e => /不在计划日期范围内/.test(e)), '超范围应报错：' + brief(r6.errors));

    for (const id of [twoId, oneId, monId, doneId, badId]) await api('DELETE', '/api/workPlans/' + id, { token });
    return '时刻沿用 08:00/10:00 + 按天工程量 + 预览不落库 + 三类 400 + 缺天逐天列全 + 无标题提示 + 超范围';
  });

  await step('plans', '拆分执行：父收缩首日 + 子计划命名/状态/编号沿用 + 勘察克隆 + 幂等与子计划再拆', async () => {
    const survey = {
      surveyNo: '202611001', team: '冒烟班组', dualName: '10kV冒烟线', workTask: '立杆', envDesc: '晴',
      surveyDate: '2026-11-10', grouping: '不分小组', groups: [],
      hazardPoints: [{ id: 'hz_seed_a', title: '高处坠落', measure: '系安全带', scope: '全组' },
        { id: 'hz_seed_b', title: '触电', measure: '验电接地', scope: '全组' }],
      createdAt: '2026-11-10 09:00:00', updatedAt: '2026-11-10 09:00:00'
    };
    const parent = needOk(await api('POST', '/api/workPlans', { token, body: {
      planType: '周计划', name: '冒烟拆分三日计划', status: '未执行',
      startDate: '2026-11-11 08:00:00', endDate: '2026-11-13 10:00:00',
      content: '11日：电杆组立3根；12日：电缆敷设1200米；13日：导线架设2.5km',
      surveyNo: '202611001', workTicketNo: '202611680001', team: '冒烟班组', leader: '张三',
      wlPole: '9', wlCable: '9', generatedFiles: [{ id: 'gf1', name: '旧生成物.docx' }], survey
    } }), 'POST 拆分父计划');
    const sp = needOk(await api('POST', '/api/workPlans/' + parent.id + '/split', { token, body: { days: [
      { date: '2026-11-11', content: '电杆组立3根', quantities: { wlPole: 3 } },
      { date: '2026-11-12', content: '电缆敷设1200米', quantities: { wlCable: 1.2 } },
      { date: '2026-11-13', content: '导线架设2.5km', quantities: { wlLine1035: 2.5 } }
    ] } }), 'split');
    need(sp.ok === true && sp.children.length === 2 && !!sp.batchId, '应生成 2 条子计划：' + brief(sp));

    const p = needOk(await api('GET', '/api/workPlans/' + parent.id, { token }), '父计划详情');
    need(p.endDate === '2026-11-11 10:00:00', '父计划应收缩为第一天：' + p.endDate);
    need(p.content === '电杆组立3根' && p.wlPole === '3' && p.wlCable === '',
      '父计划内容与工程量应换成第一天：' + brief({ c: p.content, w: p.wlPole, c2: p.wlCable }));
    need(p.splitBatchId === sp.batchId && p.splitSnapshot && p.splitSnapshot.endDate === '2026-11-13 10:00:00',
      '父计划快照应保留原起止：' + brief(p.splitSnapshot));
    need(p.splitSnapshot.content.indexOf('12日') > -1 && p.splitSnapshot.wlPole === '9',
      '快照应保留原内容与工程量：' + brief({ c: p.splitSnapshot.content, w: p.splitSnapshot.wlPole }));
    need(!p.survey.splitBatchId && p.survey.updatedAt === '2026-11-10 09:00:00' && p.survey.hazardPoints[0].id === 'hz_seed_a',
      '父计划勘察不应被拆分改动：' + brief({ b: p.survey.splitBatchId, u: p.survey.updatedAt }));

    const c1 = needOk(await api('GET', '/api/workPlans/' + sp.children[0].id, { token }), '子计划1详情');
    need(c1.name === '冒烟拆分三日计划（11月12日）', '子计划名应为原名 + （M月D日）：' + c1.name);
    need(c1.startDate === '2026-11-12 08:00:00' && c1.endDate === '2026-11-12 10:00:00',
      '子计划起止应为当天 + 父计划时刻：' + c1.startDate + ' ~ ' + c1.endDate);
    need(c1.planType === '周计划' && c1.status === '未执行' && c1.parentPlanId === parent.id && c1.splitBatchId === sp.batchId,
      '子计划类型/状态/父引用不符：' + brief({ t: c1.planType, s: c1.status, p: c1.parentPlanId }));
    need(c1.surveyNo === '202611001' && c1.workTicketNo === '202611680001', '子计划应沿用父计划勘察/工作票编号，不生成子编号');
    need(!c1.splitSnapshot && !c1.generatedFiles, '子计划不应继承快照与生成物：' + brief({ s: !!c1.splitSnapshot, g: !!c1.generatedFiles }));
    need(c1.survey && c1.survey.splitBatchId === sp.batchId && c1.survey.hazardPoints.length === 2,
      '子计划勘察应为克隆且带本批标记：' + brief(c1.survey && { b: c1.survey.splitBatchId, n: (c1.survey.hazardPoints || []).length }));
    const hIds = c1.survey.hazardPoints.map(h => h.id);
    need(hIds.every(id => id !== 'hz_seed_a' && id !== 'hz_seed_b') && hIds[0] !== hIds[1],
      '克隆勘察的危险点应重发 id：' + brief(hIds));
    need(c1.survey.createdAt !== '2026-11-10 09:00:00' && c1.survey.updatedAt === c1.survey.createdAt,
      '克隆勘察时间戳应刷新为拆分时刻：' + brief({ c: c1.survey.createdAt, u: c1.survey.updatedAt }));

    const again = await api('POST', '/api/workPlans/' + parent.id + '/split', { token, body: { days: [] } });
    need(again.status === 409 && /已拆分/.test(again.data.error), '已拆分的父计划再拆应 409：' + again.status + ' ' + brief(again.data));
    const sub = await api('POST', '/api/workPlans/' + sp.children[0].id + '/split', { token, body: { days: [] } });
    need(sub.status === 400 && /子计划不能再次拆分/.test(sub.data.error), '子计划再拆应 400：' + sub.status + ' ' + brief(sub.data));

    // 提交天数与计划天数不一致时服务端重跑校验（不落库）
    const guard = needOk(await api('POST', '/api/workPlans', { token, body: {
      planType: '周计划', name: '冒烟拆分校验', status: '未执行',
      startDate: '2026-11-11 08:00:00', endDate: '2026-11-12 10:00:00', content: '11日：立杆3根；12日：放线'
    } }), 'POST 校验计划');
    const g1 = await api('POST', '/api/workPlans/' + guard.id + '/split', { token, body: { days: [{ date: '2026-11-11', content: '立杆3根' }] } });
    need(g1.status === 400 && g1.data.errors.indexOf('工作内容缺少计划日期：2026-11-12') > -1,
      '缺天应 400 并逐天列全：' + g1.status + ' ' + brief(g1.data));
    const g2 = await api('POST', '/api/workPlans/' + guard.id + '/split', { token, body: { days: [{ date: '2026-11-11', content: '  ' }, { date: '2026-11-12', content: '放线' }] } });
    need(g2.status === 400 && g2.data.errors.some(e => /内容为空/.test(e)), '空内容应 400：' + g2.status + ' ' + brief(g2.data));
    const g3 = await api('POST', '/api/workPlans/' + guard.id + '/split', { token, body: { days: [{ date: '2026-11-10', content: 'x' }, { date: '2026-11-12', content: '放线' }] } });
    need(g3.status === 400 && g3.data.errors.some(e => /不在计划日期范围内/.test(e)), '超范围应 400：' + g3.status + ' ' + brief(g3.data));
    const still = needOk(await api('GET', '/api/workPlans/' + guard.id, { token }), '校验后详情');
    need(!still.splitBatchId && still.endDate === '2026-11-12 10:00:00', '校验失败不得落库：' + brief(still.endDate));
    await api('DELETE', '/api/workPlans/' + guard.id, { token });
    return '父收缩为 08:00–10:00 首日 / 子计划（11月12日）未执行 + 编号沿用 / 勘察克隆重发 id / 再拆 409 与 400 / 三类提交校验 400 不落库';
  });

  await step('plans', '拆分用例矩阵：七天/两天字段沿用/跨月/只有工序无地点/单日拒/幂等总数不变', async () => {
    const mk = async (body, label) => needOk(await api('POST', '/api/workPlans', { token, body }), label || 'plan POST').id;
    const pvOf = async id => needOk(await api('POST', '/api/workPlans/' + id + '/split/preview', { token, body: {} }), 'preview');
    const daysOf = pv => pv.days.map(d => ({ date: d.date, content: d.content, quantities: d.quantities }));

    // ① 七天完整 → 父 + 6 子，各日内容一一对应
    const seven = await mk({ planType: '周计划', name: '冒烟七天计划', status: '未执行',
      startDate: '2026-11-01 08:00:00', endDate: '2026-11-07 10:00:00',
      content: '1日：电杆组立3根\n2日：电缆敷设1200米\n3日：导线架设2.5km\n4日：环网柜安装1台\n5日：真空开关安装2台\n6日：变压器安装1台\n7日：清理现场' });
    const pv7 = await pvOf(seven);
    need(pv7.ok === true && pv7.days.length === 7, '七天应切出 7 行：' + brief(pv7.errors));
    const sp7 = needOk(await api('POST', '/api/workPlans/' + seven + '/split', { token, body: { days: daysOf(pv7) } }), 'split 7 天');
    need(sp7.children.length === 6, '七天应生成 6 条子计划：' + sp7.children.length);
    const kids = [];
    for (const c of sp7.children) kids.push(needOk(await api('GET', '/api/workPlans/' + c.id, { token }), '七天子计划'));
    need(kids.map(k => k.startDate.slice(0, 10)).join(',') === '2026-11-02,2026-11-03,2026-11-04,2026-11-05,2026-11-06,2026-11-07',
      '子计划应逐日递增：' + brief(kids.map(k => k.startDate)));
    need(kids[0].content === '电缆敷设1200米' && kids[5].content === '清理现场',
      '子计划内容应去掉日期前缀并逐日对应：' + brief(kids.map(k => k.content)));
    need(kids.map(k => k.name).join('|') === '冒烟七天计划（11月2日）|冒烟七天计划（11月3日）|冒烟七天计划（11月4日）|冒烟七天计划（11月5日）|冒烟七天计划（11月6日）|冒烟七天计划（11月7日）',
      '七天子计划命名错：' + brief(kids.map(k => k.name)));

    // ② 两天每天一行 → 父 1 + 子 1，票种/班组/负责人/作业人员/地址/双编号逐项沿用
    const two = await mk({ planType: '周计划', name: '冒烟字段沿用计划', status: '未执行',
      startDate: '2026-11-20 08:00:00', endDate: '2026-11-21 10:00:00',
      content: '20日：电杆组立3根；21日：电缆敷设1200米',
      ticketType: '配电：配电第一种工作票', team: '冒烟班组', chargePerson: '李四', chargePersonPhone: '13900000009',
      staffText: '张三/13800138000；李四/13900000009', station: '冒烟变电站', voltage: '10kV',
      planNote: '沿用备注', surveyNo: '202611003', workTicketNo: '202611680003' });
    const pv2 = await pvOf(two);
    need(pv2.ok === true && pv2.days.length === 2, '两天应切出 2 行：' + brief(pv2.errors));
    const sp2 = needOk(await api('POST', '/api/workPlans/' + two + '/split', { token, body: { days: daysOf(pv2) } }), 'split 2 天');
    need(sp2.children.length === 1, '两天应生成 1 条子计划：' + sp2.children.length);
    const k2 = needOk(await api('GET', '/api/workPlans/' + sp2.children[0].id, { token }), '两天子计划');
    const keepFields = {
      ticketType: '配电：配电第一种工作票', team: '冒烟班组', chargePerson: '李四', chargePersonPhone: '13900000009',
      staffText: '张三/13800138000；李四/13900000009', station: '冒烟变电站', voltage: '10kV',
      planNote: '沿用备注', surveyNo: '202611003', workTicketNo: '202611680003'
    };
    Object.keys(keepFields).forEach(f =>
      need(String(k2[f]) === keepFields[f], '子计划应沿用父计划字段 ' + f + '：' + k2[f]));
    need(k2.content === '电缆敷设1200米' && k2.name === '冒烟字段沿用计划（11月21日）', '子计划内容/名称错：' + brief({ c: k2.content, n: k2.name }));

    // ③ 跨月 11-29→12-02：月份按段落顺序推断
    const cross = await mk({ planType: '周计划', name: '冒烟跨月计划', status: '未执行',
      startDate: '2026-11-29 08:00:00', endDate: '2026-12-02 10:00:00',
      content: '29日：电杆组立3根；30日：电缆敷设1200米；1日：导线架设2.5km；2日：清理现场' });
    const pvc = await pvOf(cross);
    need(pvc.ok === true && pvc.days.map(d => d.date).join(',') === '2026-11-29,2026-11-30,2026-12-01,2026-12-02',
      '跨月推断应为 11-29→12-02：' + brief(pvc.days.map(d => d.date)));

    // ④ 只有工序没有地点（内容本身无地点）也能拆
    const noLoc = await mk({ planType: '周计划', name: '冒烟无地点计划', status: '未执行',
      startDate: '2026-11-25 08:00:00', endDate: '2026-11-26 10:00:00',
      content: '25日：电杆组立3根\n26日：电缆敷设1200米' });
    const pv4 = await pvOf(noLoc);
    need(pv4.ok === true && pv4.days.length === 2 && pv4.days[0].items[0]['地点'] === '' && pv4.days[0].items[0].unparsed !== true,
      '无地点条目应可解析（地点留空、不算未解析）：' + brief(pv4.days[0] && pv4.days[0].items));

    // ⑤ 单日计划 split（不只是 preview）也拒
    const one = await mk({ planType: '周计划', name: '冒烟单日拆分', status: '未执行',
      startDate: '2026-11-11 08:00:00', endDate: '2026-11-11 10:00:00', content: '11日：电杆组立3根' });
    const r1 = await api('POST', '/api/workPlans/' + one + '/split', { token, body: { days: [{ date: '2026-11-11', content: '电杆组立3根' }] } });
    need(r1.status === 400 && /单日计划无需拆分/.test(r1.data.error), '单日计划 split 应 400：' + r1.status + ' ' + brief(r1.data));

    // ⑥ 幂等：同一计划连调两次 split → 第二次 409，workPlans 总数不变
    const before = (await listOk('/api/workPlans', token)).length;
    const again = await api('POST', '/api/workPlans/' + two + '/split', { token, body: { days: daysOf(pv2) } });
    const after = (await listOk('/api/workPlans', token)).length;
    need(again.status === 409 && before === after, '重复拆分应 409 且总数不变：' + again.status + ' ' + before + '→' + after);

    for (const id of [seven, two, cross, noLoc, one]) await api('DELETE', '/api/workPlans/' + id, { token });
    return '七天父+6子逐日对应 / 两天 10 字段沿用 + 内容去前缀 / 跨月 11-29→12-02 / 无地点可解析 / 单日 400 / 幂等 409 总数不变';
  });

  await step('plans', '撤销拆分：四类拦截（状态/编辑/工程量/勘察）+ 通过后恢复快照并删子计划', async () => {
    const surveySeed = {
      surveyNo: '202611002', team: '冒烟班组', dualName: '10kV冒烟线', workTask: '立杆', envDesc: '晴',
      surveyDate: '2026-11-10', grouping: '不分小组', groups: [], hazardPoints: [],
      createdAt: '2026-11-10 09:00:00', updatedAt: '2026-11-10 09:00:00'
    };
    // A：5 天 → 4 条子计划，各触发一类拦截
    const aId = needOk(await api('POST', '/api/workPlans', { token, body: {
      planType: '周计划', name: '冒烟撤销拦截计划', status: '未执行',
      startDate: '2026-11-11 08:00:00', endDate: '2026-11-15 10:00:00',
      content: '11日：电杆组立3根；12日：电缆敷设1200米；13日：导线架设2.5km；14日：环网柜安装1台；15日：清理现场',
      survey: surveySeed
    } }), 'POST 撤销拦截计划').id;
    const sp = needOk(await api('POST', '/api/workPlans/' + aId + '/split', { token, body: { days: [
      { date: '2026-11-11', content: '电杆组立3根' },
      { date: '2026-11-12', content: '电缆敷设1200米' },
      { date: '2026-11-13', content: '导线架设2.5km' },
      { date: '2026-11-14', content: '环网柜安装1台' },
      { date: '2026-11-15', content: '清理现场' }
    ] } }), 'split 5 天');
    need(sp.children.length === 4, '应拆出 4 条子计划：' + brief(sp.children));
    const [c1, c2, c3, c4] = sp.children.map(c => c.id);

    needOk(await api('PUT', '/api/workPlans/' + c1, { token, body: { status: '已执行' } }), '子计划改状态');
    needOk(await api('PUT', '/api/workPlans/' + c2, { token, body: { content: '拆分后改过的工作内容' } }), '子计划改内容');
    needOk(await api('PUT', '/api/workPlans/' + c3 + '/quantities', { token, body: { wlPole: '8' } }), '子计划改工程量');
    needOk(await api('PUT', '/api/workPlans/' + c4 + '/survey', { token, body: { surveyUnit: '冒烟勘察单位' } }), '子计划改勘察');

    const blocked = await api('POST', '/api/workPlans/' + aId + '/unsplit', { token });
    need(blocked.status === 409 && Array.isArray(blocked.data.blocks) && blocked.data.blocks.length === 4,
      '四条子计划应各报一条拦截：' + blocked.status + ' ' + brief(blocked.data));
    const all = blocked.data.blocks.join('\n');
    need(/状态为「已执行」/.test(all), '缺少「状态非未执行」拦截：' + all);
    need(/拆分后被编辑过/.test(all), '缺少「拆分后被编辑」拦截：' + all);
    need(/修改过工程量/.test(all), '缺少「修改过工程量」拦截：' + all);
    need(/勘察记录被编辑过/.test(all), '缺少「勘察被编辑」拦截：' + all);

    // B：未改动的两天计划 → 撤销应恢复快照并逻辑删除子计划
    const bId = needOk(await api('POST', '/api/workPlans', { token, body: {
      planType: '周计划', name: '冒烟可撤销计划', status: '未执行',
      startDate: '2026-12-01 08:00:00', endDate: '2026-12-02 10:00:00',
      content: '1日：电杆组立3根；2日：电缆敷设1200米', wlPole: '7', survey: surveySeed
    } }), 'POST 可撤销计划').id;
    const sp2 = needOk(await api('POST', '/api/workPlans/' + bId + '/split', { token, body: { days: [
      { date: '2026-12-01', content: '电杆组立3根', quantities: { wlPole: 3 } },
      { date: '2026-12-02', content: '电缆敷设1200米', quantities: { wlCable: 1.2 } }
    ] } }), 'split 2 天');
    const childId = sp2.children[0].id;
    const un = needOk(await api('POST', '/api/workPlans/' + bId + '/unsplit', { token }), 'unsplit');
    need(un.ok === true && un.removed === 1, '撤销应删除 1 条子计划：' + brief(un));
    const back = needOk(await api('GET', '/api/workPlans/' + bId, { token }), '撤销后父计划');
    need(back.endDate === '2026-12-02 10:00:00' && back.content === '1日：电杆组立3根；2日：电缆敷设1200米' && back.wlPole === '7',
      '撤销后应恢复拆分前起止/内容/工程量：' + brief({ e: back.endDate, c: back.content, w: back.wlPole }));
    need(!back.splitBatchId && !back.splitSnapshot, '撤销后应清除批次与快照');
    const gone = await api('GET', '/api/workPlans/' + childId, { token });
    need(gone.status === 404, '撤销后子计划应不可见（逻辑删除）：' + gone.status);
    const listed = (await listOk('/api/workPlans', token)).map(x => x.id);
    need(listed.indexOf(bId) > -1 && listed.indexOf(childId) < 0, '列表应只剩父计划');

    // C：拆分时父计划没有勘察 → 子计划另建勘察后，撤销应报「已有独立勘察记录」
    const cId = needOk(await api('POST', '/api/workPlans', { token, body: {
      planType: '周计划', name: '冒烟无勘察计划', status: '未执行',
      startDate: '2026-12-05 08:00:00', endDate: '2026-12-06 10:00:00',
      content: '5日：电杆组立3根；6日：电缆敷设1200米'
    } }), 'POST 无勘察计划').id;
    const sp3 = needOk(await api('POST', '/api/workPlans/' + cId + '/split', { token, body: { days: [
      { date: '2026-12-05', content: '电杆组立3根' },
      { date: '2026-12-06', content: '电缆敷设1200米' }
    ] } }), 'split 无勘察');
    const noSv = needOk(await api('GET', '/api/workPlans/' + sp3.children[0].id, { token }), '子计划（无勘察）');
    need(!noSv.survey, '父计划无勘察时子计划不应凭空生成勘察：' + JSON.stringify(noSv.survey || null));
    needOk(await api('PUT', '/api/workPlans/' + sp3.children[0].id + '/survey',
      { token, body: { surveyUnit: '冒烟单位', surveyDate: '2026-11-10' } }), '子计划新建勘察');
    const b3 = await api('POST', '/api/workPlans/' + cId + '/unsplit', { token });
    need(b3.status === 409 && (b3.data.blocks || []).some(x => /已有独立勘察记录/.test(x)),
      '子计划另建勘察后撤销应报「已有独立勘察记录」：' + b3.status + ' ' + brief(b3.data));
    return '四类拦截各 1 条（状态/编辑/工程量/勘察）+ 另建勘察 1 条 + 正常撤销恢复快照、删 1 条子计划并逻辑删除';
  });

  await step('结构', '周计划拆分前端接线与列表样式：脚本顺序/组件注册/入口守卫/徽标/改期拦截/窄屏卡片/操作列平铺/莫兰迪五色/全黑字', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const p = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'plans.js'), 'utf8');
    const d = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'plan-split.js'), 'utf8');
    const m = fs.readFileSync(path.join(ROOT, 'public', 'js', 'main.js'), 'utf8');
    const iSplit = html.indexOf('<script src="/js/views/plan-split.js"></script>');
    const iPlans = html.indexOf('<script src="/js/views/plans.js"></script>');
    need(iSplit > -1 && iSplit < iPlans, 'views/plan-split.js 必须先于 views/plans.js 加载：' + iSplit + ' / ' + iPlans);
    need(/app\.component\('PlanSplitDlg', PlanSplitDlg\)/.test(m), 'main.js 应注册 PlanSplitDlg 组件');
    need(/window\.PlanSplitDlg = PlanSplitDlg/.test(d), 'plan-split.js 应挂到 window.PlanSplitDlg');
    need(/\.plan-split-badge/.test(html) && /\.psp-card \{/.test(html), 'index.html 缺少拆分徽标或窄屏卡片样式');
    need(/planType !== '周计划'[\s\S]{0,120}status !== '未执行'[\s\S]{0,160}parentPlanId \|\| row\.splitBatchId/.test(p),
      'canSplit 应排除非周计划/非未执行/子计划/已拆分');
    need(/v-if="canSplit\(row\)"[^>]*>拆分<\/el-button>/.test(p), '「拆分」应按 canSplit 直接平铺显示');
    need(/v-if="row\.splitBatchId"[^>]*>撤销拆分<\/el-button>/.test(p), '「撤销拆分」应只对已拆分父计划显示');
    need(!/plan-act-more/.test(p) && !/<el-dropdown/.test(p), '操作列应全部平铺，不再收进「更多」下拉');
    need(/TICKET_TONE[\s\S]{0,600}tk-a5/.test(p), 'plans.js 应定义五种工作票 → 行底色映射');
    ['tk-a1', 'tk-a2', 'tk-a3', 'tk-a4', 'tk-a5'].forEach(c =>
      need(new RegExp('\\.' + c + ' \\{').test(html), 'index.html 缺少票种底色 ' + c));
    need(/tr\[class\*="tk-a"\] > td\.el-table__cell/.test(html) && /--tk-edge/.test(html),
      'index.html 应按票种给行铺底色与左侧色条');
    need(/tr\[class\*="tk-a"\] > td\.el-table__cell \{ background-color:var\(--tk-bg\)/.test(html)
      && !/tr\[class\*="tk-a"\][^{]*\{[^}]*linear-gradient/.test(html),
      '票种底色应为纯色浅底，不使用渐变');
    need(['#E9ECF0', '#EFF4F6', '#F7F7F9', '#FBF9FA', '#FFFBFB'].every(c => html.includes(c))
      && !/#F8DFDB|#FAE5CE|#F7EFC4|#E1EFDD|#DAEBF3/.test(html),
      '票种底色应为 Dopely 色板极淡版（接近白，不再用红橙黄绿青）');
    need(/#E9ECF0; --tk-bg-hover:#E2E5EB/.test(html) && /#FFFBFB; --tk-bg-hover:#FFF9F9/.test(html),
      '悬停色只比底色略深（20% 原色），不得回跳到较浓的上一档');
    need(/\.plan-table th\.el-table__cell,[\s\S]{0,400}color:#000 !important/.test(html)
      && /\.plans-view \{ color:#000; \}/.test(html)
      && /html\.dark \.plan-table th\.el-table__cell,/.test(html),
      '周计划表格与视图文字应统统黑色（深色主题保留浅字）');
    need(/background:#6E7F9A;color:#fff/.test(p) && !/#3370ff/.test(p),
      '日历徽标应改用色板蓝灰底白字');
    need(!/isOngoing|plan-ongoing|is-now/.test(p) && !/\.plan-idx\.is-now/.test(html),
      '序号应统一素化：无进行中黄标 / 无 is-now 类 / 无 plan-ongoing 死类');
    need(/<span class="plan-idx">\{\{ \(page - 1\) \* pageSize/.test(p)
      && /\.plan-idx \{ font-variant-numeric:tabular-nums; \}/.test(html),
      '序号应只是纯数字文本，样式仅 tabular-nums（无底色/圆角）');
    need(/tr\[class\*="tk-a"\] > td\.plan-act-col \{ box-shadow:inset 3px 0 0 var\(--tk-edge\)/.test(html)
      && !/td\.el-table__cell:first-child \{ box-shadow/.test(html),
      '票种色条应移到操作列左缘，序号列不再有色条');
    need(['#BEC5D2', '#CEDEE5', '#E7E8EC', '#F3EDEF', '#FFF2F2'].every(c => html.includes(c)),
      '色条颜色应为同色系 45% 原色（与底色同源、只比底色深）');
    need(/<span v-if="canSplit\(row\) \|\| row\.splitBatchId" class="plan-act-line">/.test(p)
      && /v-if="canSplit\(row\)"[^>]*>拆分<\/el-button>/.test(p),
      '「拆分/撤销拆分」应单独占操作列第三行（参考图布局）');
    need(/label="作业计划名称" min-width="240"/.test(p) && /label="操作" width="170"/.test(p)
      && /label="工作负责人联系电话" width="126"/.test(p),
      '列宽按参考图重分配：名称加宽、其余收紧、总宽不溢出');
    need(/th\.el-table__cell > \.cell,[\s\S]{0,120}padding-left:6px/.test(html),
      '单元格左右内边距应收紧到 6px，保证 12 列表头与日期不被省略');
    need(/plan-split-dlg/.test(p) && /@done="onSplitDone"/.test(p), 'plans.js 应挂载拆分弹窗并在完成后刷新');
    need(/该计划已拆分，修改起止时间需先撤销拆分/.test(p), '已拆分父计划改期应被拦截');
    need(/syncNarrow[\s\S]{0,120}innerWidth <= 768/.test(d) && /psp-card/.test(d), '≤768px 应切换为逐天卡片布局');
    need(/qtyTouched/.test(d) && /rebuildContent/.test(d), '重新解析应保留用户改过的工程量');
    return '顺序/组件注册/入口守卫/徽标/弹窗挂载/改期拦截/窄屏卡片/工程量覆盖保留/操作列平铺/莫兰迪五色/统统黑字';
  });

  await step('结构', '材料台账·出库管理四框：默认值/选项内容/三框联动过滤工程候选', async () => {
    const body = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(/const f1 = ref\('在建工程'\)/.test(body), '框1 默认应为「在建工程」');
    need(/const f2 = ref\('全部工程类型'\)/.test(body), '框2 默认应为「全部工程类型」（空值会退化成「请选择」）');
    need(/const f3 = ref\(''\)/.test(body), '框3 默认应为空（全部导入状态）');
    need(/<el-option label="已竣工工程" value="已竣工工程" \/>/.test(body), '框1 应有「已竣工工程」选项');
    need(/label="全部工程类型" value="全部工程类型"[\s\S]{0,120}label="自有工程"[\s\S]{0,120}label="客户工程"/.test(body),
      '框2 选项应为 全部工程类型 / 自有工程 / 客户工程');
    need(/label="全部导入状态"[\s\S]{0,120}label="已导入"[\s\S]{0,120}label="未导入"/.test(body),
      '框3 选项应为 全部导入状态 / 已导入 / 未导入');
    need(/function projectPass\(p\)[\s\S]{0,400}p\.completed[\s\S]{0,200}p\.category[\s\S]{0,200}importStateOf/.test(body),
      '三框应按 completed / category / 导入情况联动过滤');
    need(/const projects = computed\(\(\) => \{[\s\S]{0,300}projectPass\(p\)/.test(body),
      '框4 候选应由 projectPass 过滤后的项目名单生成');
    need(/watch\(\[f1, f2, f3\][\s\S]{0,200}indexOf\(project\.value\) < 0[\s\S]{0,80}project\.value = ''/.test(body),
      '框1~3 变化后已选工程不在候选内应自动清空');
    need(/async function loadImportMap\(\) \{[\s\S]{0,80}if \(importMap\.value\) return;/.test(body)
      && /if \(m\.importId\) o\.imported\+\+/.test(body)
      && /@visible-change="v => v && loadImportMap\(\)"/.test(body),
      '导入状态应有懒加载统计（带 importId 的材料行），展开下拉才请求');
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    need(/class="ob-filters"/.test(body)
      && /\.ob-filters \{ display:grid !important; grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(html),
      '≤768px 四框应改两列网格，避免被压成「在..」「全..」');
    // 「全部导入状态」是空值占位：只把文字颜色改回常规色，与相邻下拉一致（选项/筛选/默认值不变）
    need(/class="ob-imp-state" placeholder="全部导入状态"/.test(body)
      && /\.ob-filters \.ob-imp-state \.el-select__placeholder\.is-transparent \{ color:var\(--el-text-color-regular\)/.test(html),
      '「全部导入状态」文字应按常规色显示（与旁边下拉一致）');
    // 出库单页签：默认只列已出库（有效），作废单靠状态筛选切出；未选工程时按全部工程取数
    need(/const oStatus = ref\('全部'\)/.test(body), '出库单页签默认应为「全部」（全量显示）');
    need(/label="已出库（有效）" value="已出库（有效）"[\s\S]{0,160}label="全部" value="全部"[\s\S]{0,160}label="已作废" value="已作废"/.test(body),
      '单据状态筛选选项应为 已出库（有效）/ 全部 / 已作废');
    need(/oStatus\.value === '已出库（有效）'\) arr = arr\.filter\(o => o\.status === '有效'\)/.test(body)
      && /oStatus\.value === '已作废'\) arr = arr\.filter\(o => o\.status === '已作废'\)/.test(body),
      '默认口径应过滤为有效单，「已作废」只列作废单');
    need(/\/api\/materialOutbound\/orders' \+ \(project\.value \? '\?project='/.test(body),
      '未选工程时应取「全部工程」的出库单');
    need(body.indexOf('description="请先选择工程。"') === -1, '出库单页签不应再被「请先选择工程」挡住');
    // 两个列表整体升序（领料单前端排序、出库单后端排序，同一套单号语义）
    need(/\.slice\(\)\.sort\(\(a, b\) => cmpReqNo\(a\.reqNo, b\.reqNo\)\)/.test(body), '领料单列表应按单号升序排序完整结果集');
    need(/function byDocNoAsc\(a, b\)/.test(fs.readFileSync(path.join(ROOT, 'server', 'routes', 'materials.js'), 'utf8')), '出库单列表应按单号升序排序（后端 byDocNoAsc）');
    return '默认 在建工程/全部工程类型/全部导入状态/选择工程 + 三个下拉选项 + completed·category·importId 联动 + 候选随筛 + 自动清空 + 懒加载 + 窄屏两列 + 导入状态常规色 + 出库单默认全部 + 两列表升序';
  });

  /* ---------- P0-4 存量不一致：脏数据夹具 + 只读性（放最后，需重启临时服务） ---------- */
  await step('materials', 'P0-4-A 存量脏数据：八类全命中 + 检测前后数据零变化', async () => {
    const MP_AUD = 'ZT测试-存量脏数据';
    const port = Number(new URL(base).port);
    // 1) 停服 → 直接改临时库（模拟历史遗留脏数据；这些形态新接口已无法造出）→ 重启
    await stopServer();
    const dbFile = path.join(TMP, 'data', 'db.json');
    const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    const mkMat = (id, over) => Object.assign({
      id, createdAt: '2026-11-11T00:00:00.000Z', project: MP_AUD,
      description: 'ZT测试-存量-' + id, qtyRequired: 5, qtyArrived: 0, qtyNotArrived: 5,
      unit: '根', code: 'ZT-AUD-' + id, orderNo: 'PO-ZT-AUD-' + id,
      source: '甲供材料', sourceNote: '', inWeeklyPlan: true,
      modifyReason: '', modifiedAt: '', status: '未到库', deleted: false
    }, over || {});
    db.materials.push(
      mkMat('a1', { qtyArrived: 6 }),                                        // 已到 6 但无入库记录 + 已到 > 应到
      mkMat('a2', { qtyRequired: 0, qtyNotArrived: 0 }),                     // 应到 0
      mkMat('a3'),                                                           // 无到货却已出库 → 负可用 / 库存隐藏
      mkMat('a4', { qtyRequired: 4, qtyArrived: 4, qtyNotArrived: 0 }),      // 出库占满 → 库存隐藏
      mkMat('a5'),                                                           // 作废领料单 + 有效出库
      mkMat('a7', { code: 'ZT-DUP-PO', orderNo: 'PO-ZT-DUP' }),              // 同编码同订单两行
      mkMat('a8', { code: 'ZT-DUP-PO', orderNo: 'PO-ZT-DUP' })
    );
    db.materialRequisitions.push({
      id: 'ztaudr1', reqNo: 'LL-ZTAUDIT-0001', projects: [MP_AUD],
      items: [{ materialId: 'a5', code: 'ZT-AUD-a5', description: 'ZT测试-存量-a5', unit: '根', qty: 3 }],
      status: '已作废', createdAt: '2026-11-11 09:00', confirmRows: null, voidDeduct: 0, deleted: false
    });
    const mkOut = (id, no, mid, qty, recv) => ({
      id, outNo: no, project: MP_AUD, receiver: recv, status: '有效', createdAt: '2026-11-11 10:00',
      items: [{ materialId: mid, code: 'ZT-AUD-' + mid, description: 'ZT测试-存量-' + mid, unit: '根', qty, returned: 0 }],
      returns: [], compensated: 0, deleted: false
    });
    db.materialOutbound.push(
      mkOut('ztaudo1', 'OUT-ZTAUDIT-0001', 'a3', 2, '查无此人甲'),
      mkOut('ztaudo2', 'OUT-ZTAUDIT-0002', 'a4', 4, '查无此人乙'),
      mkOut('ztaudo3', 'OUT-ZTAUDIT-0003', 'a5', 3, '查无此人丙')
    );
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
    await startServer(port);
    if ((await api('GET', '/api/me', { token })).status === 401) {
      token = needOk(await api('POST', '/api/login', { body: { username: 'admin', password: 'admin123' } }), 'relogin').token;
    }
    // 2) 只读性：检测前后 db.json 逐字节一致
    const before = fs.readFileSync(dbFile);
    const rows = needOk(await api('GET', '/api/materials/audit/inconsistencies?project=' + encodeURIComponent(MP_AUD), { token }), 'audit dirty');
    const rowsAll = needOk(await api('GET', '/api/materials/audit/inconsistencies', { token }), 'audit all');
    const after = fs.readFileSync(dbFile);
    need(before.equals(after), '检测接口应为纯只读：db.json 在检测前后发生变化');
    need(rowsAll.length >= rows.length, '全库检测条数应不少于单项目检测');
    // 3) 八类全命中
    const types = new Set(rows.map(r => r.type));
    ['arrived_without_inbound', 'arrived_gt_required', 'required_not_positive', 'voided_req_with_active_out',
      'negative_available', 'stock_hidden_but_outbound_active', 'receiver_not_admitted', 'duplicate_code_po']
      .forEach(t => need(types.has(t), '未命中类型 ' + t + '（实际：' + Array.from(types).join(',') + '）'));
    // 4) 关键字段与数值
    const one = (t, mid) => rows.find(r => r.type === t && r.materialId === mid);
    const a1 = one('arrived_without_inbound', 'a1');
    need(a1 && a1.qty.arrived === 6 && a1.qty.inboundSum === 0 && a1.qty.diff === 6,
      'a1 差额应为 6：' + brief(a1));
    need(one('arrived_gt_required', 'a1'), 'a1 应命中 已到 > 应到');
    need(one('required_not_positive', 'a2'), 'a2 应命中 应到 ≤ 0');
    const v5 = one('voided_req_with_active_out', 'a5');
    need(v5 && v5.docNos.indexOf('LL-ZTAUDIT-0001') > -1 && v5.docNos.indexOf('OUT-ZTAUDIT-0003') > -1,
      'a5 应同时列作废领料单号与有效出库单号：' + brief(v5));
    const n3 = one('negative_available', 'a3');
    need(n3 && n3.qty.available === -2, 'a3 可用应为 -2：' + brief(n3));
    need(one('stock_hidden_but_outbound_active', 'a4'), 'a4 应命中 库存隐藏但出库有效');
    const rn = rows.filter(r => r.type === 'receiver_not_admitted');
    need(rn.length === 3 && rn.every(r => r.receiver && r.docNos.length),
      '领取人未准入应 3 条且带出库单号：' + brief(rn));
    const dup = one('duplicate_code_po', 'a7');
    need(dup && dup.qty.count === 2 && dup.qty.rows.length === 2 && dup.qty.rows.every(x => x.id && 'qtyRequired' in x),
      '同编码同订单应 1 组 2 行并列出各行 id/应到：' + brief(dup));
    need(rows.every(r => r.type && r.project && 'materialId' in r && 'docNos' in r && 'qty' in r && r.advice),
      '每条结果都应含 type/项目/材料/相关单号/关键数量/处置建议');
    return '八类命中 · 检测前后 db.json 字节一致 · ' + rows.length + ' 条';
  });

  /* ========== P4 业务日期与按日回放（第一批 + 第二批） ==========
   * 业务日期口径：reqDate（领料）/ arrivalDate（整单到货，写 history）/ outDate（出库）/ returnDate（归还）。
   * 单号按业务日取号；新单 legacy:false；回放是新单库存先后的唯一口径；存量单（legacy:true）作废只走 P0-2。 */
  const { MIGRATIONS } = require(path.join(ROOT, 'server', 'core', 'migrations.js'));
  const P4_MIG = MIGRATIONS.find(m => m.id === '20261111-material-biz-dates');
  const P4PJ = 'ZT测试-业务日期冒烟';
  const p4Tag = d => String(d).replace(/-/g, '');
  const p4D4 = dayOff(srvToday, -4);
  const p4D31 = dayOff(srvToday, -31);
  const p4Future = dayOff(srvToday, 3);
  let p4Seq = 0;
  const p4Mat = async (code, qty) => {
    p4Seq++;
    return needOk(await api('POST', '/api/materials', {
      token, body: { project: P4PJ, source: '甲供材料', description: 'ZT测试-P4-' + code + '-' + p4Seq, qtyRequired: qty, unit: '只', code: 'ZT-P4-' + code + p4Seq }
    }), 'materials POST P4-' + code);
  };
  const p4Req = async (matId, qty, reqDate, extra) => needOk(await api('POST', '/api/requisitions/create', {
    token, body: Object.assign({ items: [{ id: matId, qty }] }, reqDate ? { reqDate } : {}, extra || {})
  }), 'P4 create req').data;
  const p4Confirm = (reqId, matId, qty, arrivalDate, reason) => {
    const row = { materialId: matId, thisQty: qty };
    if (reason) row.reason = reason;
    return api('PUT', '/api/materialRequisitions/' + reqId + '/confirm', {
      token, body: Object.assign({ rows: [row] }, arrivalDate ? { arrivalDate } : {})
    });
  };
  const p4Out = (matId, qty, extra) => api('POST', '/api/materialOutbound/create', {
    token, body: Object.assign({ project: P4PJ, workerId: smokeWorker.id, items: [{ materialId: matId, qty }] }, extra || {})
  });
  const p4Stock = async id => {
    const rows = needOk(await api('GET', '/api/materialOutbound/stock?project=' + encodeURIComponent(P4PJ), { token }), 'P4 stock');
    const r = (rows || []).find(x => x.id === id);
    return r ? Number(r.available) : 0;
  };
  const p4Ref = {};
  // P4 段自建工程（材料只能挂项目列表里的工程名）
  {
    const projs = needOk(await api('GET', '/api/projects', { token }), 'GET projects');
    if (!(projs || []).some(p => p.name === P4PJ && !p.deleted)) {
      needOk(await api('POST', '/api/projects', {
        token, body: { name: P4PJ, batch: '2026-11', substation: 'ZT设施所', workType: '配网', category: '自有工程' }
      }), 'POST P4 project');
    }
  }

  await step('materials', 'P4-1-A 省略日期默认今天 + 单号用今天 + 录入时间另存', async () => {
    const m = await p4Mat('A', 100);
    const r = await p4Req(m.id, 5, '');
    need(r.reqDate === srvToday, 'reqDate 应默认今天：' + r.reqDate);
    need(r.reqNo.indexOf('LL-' + p4Tag(srvToday) + '-') === 0, '领料单号应用今天：' + r.reqNo);
    need(r.legacy === false, '新领料单 legacy 应为 false');
    need(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.createdAt), 'createdAt 应是录入时分串：' + r.createdAt);
    const c = await p4Confirm(r.id, m.id, 5, '');
    needOk(c, 'P4-1-A confirm');
    need(c.data.data.history[0].arrivalDate === srvToday, 'arrivalDate 应默认今天：' + c.data.data.history[0].arrivalDate);
    need(c.data.data.history[0].at !== c.data.data.history[0].arrivalDate, 'history.at 不应被写成业务日');
    const o = await p4Out(m.id, 2, {});
    needOk(o, 'P4-1-A out');
    need(o.data.data.outDate === srvToday, 'outDate 应默认今天：' + o.data.data.outDate);
    need(o.data.data.outNo.indexOf('OUT-' + p4Tag(srvToday) + '-') === 0, '出库单号应用今天');
    need(o.data.data.legacy === false, '出库新单 legacy 应为 false');
    p4Ref.reqNo = r.reqNo; p4Ref.outNo = o.data.data.outNo;
    return r.reqNo + ' / ' + o.data.data.outNo;
  });

  await step('materials', 'P4-1-B 分两次整单到货两个日期 + 行级日期忽略', async () => {
    const m = await p4Mat('B', 100);
    const r = await p4Req(m.id, 10, p4D4);
    need(r.reqNo.indexOf('LL-' + p4Tag(p4D4) + '-') === 0, '领料单应按开单日取号：' + r.reqNo);
    const c1 = await api('PUT', '/api/materialRequisitions/' + r.id + '/confirm', {
      token, body: { rows: [{ materialId: m.id, thisQty: 6, arrivalDate: p4D31, reason: 'ZT分两批到货' }], arrivalDate: p4D4 }
    });
    needOk(c1, 'P4-1-B confirm1');
    const c2 = await p4Confirm(r.id, m.id, 4, srvToday);
    needOk(c2, 'P4-1-B confirm2');
    const h = c2.data.data.history;
    need(c2.data.data.status === '已入库' && h.length === 2, '两次确认后应已入库且有两条 history：' + brief(h));
    need(h[0].arrivalDate === p4D4 && h[1].arrivalDate === srvToday, '两条整单到货日应为 ' + p4D4 + ' / ' + srvToday + '：' + brief(h.map(x => x.arrivalDate)));
    need(h.every(x => String(x.at).slice(0, 10) === srvToday), '两条 at 都应是今天录入时间：' + brief(h.map(x => x.at)));
    need(h.every(x => (x.rows || []).every(y => y.arrivalDate === undefined)), '行级日期不应落库（整单口径）');
    p4Ref.bReqId = r.id;
    return h.map(x => x.arrivalDate).join(' / ');
  });

  await step('materials', 'P4-1-C 到货早于开单日 / 未来日期 / 非法格式 → 400 且不落库', async () => {
    const m = await p4Mat('C', 100);
    const r = await p4Req(m.id, 5, p4D4);
    const bad = await p4Confirm(r.id, m.id, 5, dayOff(p4D4, -1));
    need(bad.status === 400 && /到货日期不能早于领料日期/.test(String(bad.data.error)), '到货早于开单应 400：' + brief(bad.data));
    need((await p4Stock(m.id)) === 0, '拒绝后已到应仍为 0');
    need((await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], reqDate: p4Future } })).status === 400, '未来领料日期应 400');
    need((await p4Confirm(r.id, m.id, 1, p4Future)).status === 400, '未来到货日期应 400');
    need((await api('POST', '/api/materialOutbound/create', { token, body: { project: P4PJ, workerId: smokeWorker.id, items: [{ materialId: m.id, qty: 1 }], outDate: p4Future } })).status === 400, '未来出库日期应 400');
    need((await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], reqDate: '2026/11/07' } })).status === 400, '非 YYYY-MM-DD 应 400');
    return '四类拒绝且未落库';
  });

  await step('materials', 'P4-1-D 出库日默认作业日 / 未来作业日回落今天并带提示', async () => {
    const m = await p4Mat('D', 100);
    const r = await p4Req(m.id, 20, p4D4);
    needOk(await p4Confirm(r.id, m.id, 20, p4D4), 'P4-1-D confirm');
    const o = await p4Out(m.id, 3, { workDate: p4D4 });
    needOk(o, 'P4-1-D out');
    need(o.data.data.outDate === p4D4 && o.data.data.workDate === p4D4, '出库日应默认等于作业日：' + brief({ out: o.data.data.outDate, work: o.data.data.workDate }));
    need(o.data.data.outNo.indexOf('OUT-' + p4Tag(p4D4) + '-') === 0, '出库单号应走出库日：' + o.data.data.outNo);
    need(String(o.data.data.createdAt).slice(0, 10) === srvToday, 'createdAt 应仍是今天');
    const o2 = await p4Out(m.id, 1, { workDate: p4Future });
    needOk(o2, 'P4-1-D 未来作业日出库');
    need(o2.data.data.outDate === srvToday, '未来作业日应回落今天：' + o2.data.data.outDate);
    need(o2.data.data.workDate === p4Future, '作业日本身应保留未来日期');
    need(o2.data.outDateFallback === true && /今天/.test(String(o2.data.outDateHint)), '回落时应带 outDateFallback + 提示：' + brief({ f: o2.data.outDateFallback, h: o2.data.outDateHint }));
    return o.data.data.outNo + ' · 回落提示：' + o2.data.outDateHint;
  });

  await step('materials', 'P4-1-E 出库早于到货由回放拒绝（临时门槛已删）', async () => {
    const m = await p4Mat('E', 100);
    const r = await p4Req(m.id, 10, p4D4);
    needOk(await p4Confirm(r.id, m.id, 10, p4D4), 'P4-1-E confirm');
    const bad = await p4Out(m.id, 3, { outDate: dayOff(p4D4, -1) });
    need(bad.status === 400 && /可用库存将为负/.test(String(bad.data.error)), '应 400 且是回放文案：' + brief(bad.data));
    need(bad.data.date === dayOff(p4D4, -1), '应指出负库存日期：' + bad.data.date);
    need((await p4Stock(m.id)) === 10, '库存应不变');
    const okSameDay = await p4Out(m.id, 3, { outDate: p4D4 });
    needOk(okSameDay, 'P4-1-E 同日先入后出应通过');
    const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'materials.js'), 'utf8');
    need(!/earliestArrivalOf/.test(src) && !/不能早于物料/.test(src), '代码里不应再有「最早到货日」专用门槛');
    return '回放拒绝 · 同日放行 · 门槛已删';
  });

  await step('materials', 'P4-1-F/G 超 30 天补录：无原因 400、有原因 200 且原因落库', async () => {
    const m = await p4Mat('F', 100);
    need((await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], reqDate: p4D31 } })).status === 400, '领料日超 30 天无原因应 400');
    const r = await p4Req(m.id, 5, p4D31, { reqDateReason: 'ZT补录原因' });
    need(r.reqDate === p4D31 && r.reqDateReason === 'ZT补录原因', '原因应落库：' + brief(r));
    need(r.reqNo.indexOf('LL-' + p4Tag(p4D31) + '-') === 0, '单号应走该业务日：' + r.reqNo);
    need((await p4Confirm(r.id, m.id, 5, p4D31)).status === 400, '到货日超 30 天无原因应 400');
    const c = await api('PUT', '/api/materialRequisitions/' + r.id + '/confirm', { token, body: { rows: [{ materialId: m.id, thisQty: 5 }], arrivalDate: p4D31, arrivalReason: 'ZT补录到货' } });
    needOk(c, 'P4-1-G confirm');
    need(c.data.data.history[0].arrivalDate === p4D31 && c.data.data.history[0].arrivalReason === 'ZT补录到货', '到货日与原因应落库');
    return r.reqNo + ' · 原因已落库';
  });

  await step('materials', 'P4-2 按业务日取号：接着该日流水、作废不回收、未来不占号', async () => {
    const m = await p4Mat('G', 100);
    const all = needOk(await api('GET', '/api/materialRequisitions', { token }), 'GET reqs');
    const seqOf = (no, pre) => (String(no).indexOf(pre) === 0 && /^\d+$/.test(String(no).slice(pre.length)) ? parseInt(String(no).slice(pre.length), 10) : 0);
    const pre = 'LL-' + p4Tag(p4D4) + '-';
    const max0 = (all || []).reduce((s, x) => Math.max(s, seqOf(x.reqNo, pre)), 0);
    const r1 = await p4Req(m.id, 3, p4D4);
    need(seqOf(r1.reqNo, pre) === max0 + 1, '应接着该日最大流水 +1：' + r1.reqNo + '（原最大 ' + max0 + '）');
    needOk(await api('PUT', '/api/materialRequisitions/' + r1.id + '/void', { token, body: { reason: 'ZT P4-2 作废' } }), 'P4-2 作废');
    const r2 = await p4Req(m.id, 2, p4D4);
    need(seqOf(r2.reqNo, pre) === max0 + 2, '作废号不应回收：' + r2.reqNo);
    const outs = needOk(await api('GET', '/api/materialOutbound/orders', { token }), 'GET outs');
    const preO = 'OUT-' + p4Tag(p4D4) + '-';
    const maxO = (outs || []).reduce((s, x) => Math.max(s, seqOf(x.outNo, preO)), 0);
    needOk(await p4Confirm(r2.id, m.id, 2, p4D4), 'P4-2 confirm（给取号用例备库存）');
    const o = await p4Out(m.id, 1, { outDate: p4D4 });
    needOk(o, 'P4-2 out');
    need(seqOf(o.data.data.outNo, preO) === maxO + 1, '出库应按出库日取号：' + o.data.data.outNo);
    const cnt = (await api('GET', '/api/materialRequisitions', { token })).data.length;
    need((await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], reqDate: p4Future } })).status === 400, '未来日期应 400');
    need((await api('GET', '/api/materialRequisitions', { token })).data.length === cnt, '未来日期不应占号落库');
    return r2.reqNo + ' · ' + o.data.data.outNo;
  });

  await step('materials', 'P4-3 作废后按原开单日重开：双向 correctedFrom / correctedBy；不存在则拒', async () => {
    const m = await p4Mat('H', 100);
    const r1 = await p4Req(m.id, 5, srvToday);
    needOk(await p4Confirm(r1.id, m.id, 5, srvToday), 'P4-3 confirm');
    needOk(await api('PUT', '/api/materialRequisitions/' + r1.id + '/void', { token, body: { reason: 'ZT P4-3 重开' } }), 'P4-3 作废');
    const r2 = await p4Req(m.id, 3, srvToday, { correctedFrom: r1.id });
    need(r2.correctedFrom === r1.id && r2.correctedFromNo === r1.reqNo, '新单应带 correctedFrom：' + brief({ a: r2.correctedFrom, b: r2.correctedFromNo }));
    need(r2.legacy === false, '重开新单仍应是新单');
    const list = needOk(await api('GET', '/api/materialRequisitions', { token }), 'GET reqs');
    const old = (list || []).find(x => x.id === r1.id);
    need(old.correctedBy === r2.id && old.correctedByNo === r2.reqNo, '原单应回写 correctedBy：' + brief({ a: old.correctedBy }));
    need(old.reqNo === r1.reqNo && old.status === '已作废', '原单号不变且已作废');
    const cnt = (list || []).length;
    const bad = await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], correctedFrom: 'rq_not_exist_zz' } });
    need(bad.status === 400 && /不存在/.test(String(bad.data.error)), 'correctedFrom 不存在应 400：' + brief(bad.data));
    need((await api('GET', '/api/materialRequisitions', { token })).data.length === cnt, '不存在的重开来源不应建单');
    // 原单未作废不能重开
    const r3 = await p4Req(m.id, 1, srvToday);
    const notVoid = await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], correctedFrom: r3.id } });
    need(notVoid.status === 400 && /尚未作废/.test(String(notVoid.data.error)), '原单未作废不能重开：' + brief(notVoid.data));
    // 同一原单已有仍有效的重开单时拒绝
    const dup = await api('POST', '/api/requisitions/create', { token, body: { items: [{ id: m.id, qty: 1 }], correctedFrom: r1.id } });
    need(dup.status === 400 && /已有重开单/.test(String(dup.data.error)), '已有有效重开单时再次重开应 400：' + brief(dup.data));
    // 把重开单也作废后允许再次重开，反向关联更新为最新一张
    needOk(await api('PUT', '/api/materialRequisitions/' + r2.id + '/void', { token, body: { reason: 'ZT P4-3 作废重开单' } }), 'P4-3 作废重开单');
    const r4 = await p4Req(m.id, 2, srvToday, { correctedFrom: r1.id });
    const old2 = (needOk(await api('GET', '/api/materialRequisitions', { token }), 'GET reqs2') || []).find(x => x.id === r1.id);
    need(old2.correctedBy === r4.id && old2.correctedByNo === r4.reqNo, '重开单已作废后允许再重开，关联更新为最新：' + brief({ a: old2.correctedByNo }));
    // 本批：后端能力保留，前端入口已撤销（反向断言）
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(!/openReopen\(|reopenOut\(|>重 开<|>重开</.test(src), '前端不应再有重开按钮/入口');
    need(!/重开领料单|重开出库单/.test(src), '前端不应再有重开弹窗');
    return r1.reqNo + ' → ' + r2.reqNo + ' → ' + r4.reqNo + '；前端入口已撤';
  });

  await step('materials', 'P4-4-B/C 回放：补录压垮中间日拒绝、每天不为负放行', async () => {
    const m = await p4Mat('I', 100);
    const r = await p4Req(m.id, 10, p4D4);
    needOk(await p4Confirm(r.id, m.id, 10, p4D4), 'P4-4 confirm');
    const o8 = await p4Out(m.id, 10, { outDate: dayOff(p4D4, 1) });
    needOk(o8, 'P4-4 8 日出库 10');
    const bad = await p4Out(m.id, 1, { outDate: p4D4 });
    need(bad.status === 400 && bad.data.date === dayOff(p4D4, 1), '补录 1 应被 8 日负库存拒绝：' + brief(bad.data));
    need((await p4Stock(m.id)) === 0, '当前可用应为 0');
    // 正向：另一材料 7 日入库 10、8 日出库 3 → 当天可用 7
    const m2 = await p4Mat('I2', 100);
    const r2 = await p4Req(m2.id, 10, p4D4);
    needOk(await p4Confirm(r2.id, m2.id, 10, p4D4), 'P4-4 confirm2');
    const o3 = await p4Out(m2.id, 3, { outDate: dayOff(p4D4, 1) });
    needOk(o3, 'P4-4-C 8 日出库 3');
    need((await p4Stock(m2.id)) === 7, '当前可用应为 7');
    const bad2 = await p4Out(m2.id, 10, { outDate: p4D4 });
    need(bad2.status === 400 && bad2.data.date === dayOff(p4D4, 1), '7 日再出 10 应压垮 8 日：' + brief(bad2.data));
    return '中间日负 → 拒 · 逐日不为负 → 放行';
  });

  await step('materials', 'P4-4-F 作废新单入库走回放：中间日为负则拒，先作出库后放行', async () => {
    const m = await p4Mat('J', 100);
    const r1 = await p4Req(m.id, 10, p4D4);
    needOk(await p4Confirm(r1.id, m.id, 10, p4D4), 'P4-4-F confirm1');
    const o = await p4Out(m.id, 8, { outDate: dayOff(p4D4, 1) });
    needOk(o, 'P4-4-F 出库 8');
    const r2 = await p4Req(m.id, 10, dayOff(p4D4, 2));
    needOk(await p4Confirm(r2.id, m.id, 10, dayOff(p4D4, 2)), 'P4-4-F confirm2');
    need((await p4Stock(m.id)) === 12, '当前可用应 12（P0-2 能过）');
    const bad = await api('PUT', '/api/materialRequisitions/' + r1.id + '/void', { token, body: { reason: 'ZT P4-4-F' } });
    need(bad.status === 400 && bad.data.date === dayOff(p4D4, 1), '应被中间日负库存拒绝：' + brief(bad.data));
    const still = (await api('GET', '/api/materialRequisitions', { token })).data.find(x => x.id === r1.id);
    need(still.status !== '已作废', '领料单不应被作废');
    needOk(await api('PUT', '/api/materialOutbound/' + o.data.data.id + '/void', { token, body: { reason: 'ZT P4-4-F 出库' } }), 'P4-4-F 作废出库');
    const ok2 = await api('PUT', '/api/materialRequisitions/' + r1.id + '/void', { token, body: { reason: 'ZT P4-4-F 再来' } });
    needOk(ok2, '先作出库后应可作废');
    return '回放拒 · 作出库后成功';
  });

  await step('materials', 'P4-5 迁移：按单号回填 / 两次一致 / 不碰 legacy:false 新单', async () => {
    const dbPath = path.join(TMP, 'data', 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const t = raw.materialRequisitions.find(r => r.reqNo === p4Ref.reqNo);
    const o = raw.materialOutbound.find(x => x.outNo === p4Ref.outNo);
    const fresh = raw.materialRequisitions.find(r => r.id === p4Ref.bReqId);
    need(t && o && fresh, '临时库里找不到本段单据');
    const keep = { reqDate: t.reqDate, legacy: t.legacy, arr: (t.history || []).map(h => h.arrivalDate), outDate: o.outDate, workDate: o.workDate, outLegacy: o.legacy, fresh: { reqDate: fresh.reqDate, legacy: fresh.legacy } };
    // 剥掉业务日期字段，模拟迁移前存量
    delete t.reqDate; delete t.legacy; (t.history || []).forEach(h => { delete h.arrivalDate; });
    delete o.outDate; delete o.legacy;
    const a = JSON.parse(JSON.stringify(raw)); P4_MIG.run(a);
    const b = JSON.parse(JSON.stringify(a)); P4_MIG.run(b);
    const pa = a.materialRequisitions.find(r => r.reqNo === p4Ref.reqNo);
    need(pa.reqDate === keep.reqDate, 'reqDate 应回填为 ' + keep.reqDate + '，实际 ' + pa.reqDate);
    need(pa.legacy === true, '存量领料单应打 legacy=true');
    need((pa.history || []).every((h, i) => h.arrivalDate === keep.arr[i]), 'history.arrivalDate 应按 at 回填：' + brief((pa.history || []).map(h => h.arrivalDate)));
    need((pa.history || []).every((h, i) => h.at === (t.history[i] || {}).at), 'history.at 不得被改');
    const oa = a.materialOutbound.find(x => x.outNo === p4Ref.outNo);
    need(oa.outDate === keep.outDate, 'outDate 应按单号回填：' + oa.outDate);
    need(oa.workDate === keep.workDate, 'workDate 不得被 outDate 覆盖');
    need(oa.legacy === true, '存量出库单应打 legacy=true');
    const same = JSON.stringify({ r: a.materialRequisitions, o: a.materialOutbound }) === JSON.stringify({ r: b.materialRequisitions, o: b.materialOutbound });
    need(same, '连续两次执行结果应逐字节一致（幂等）');
    need(P4_MIG.needs(a) === false, '迁移后 needs 应为 false');
    const fa = a.materialRequisitions.find(r => r.id === p4Ref.bReqId);
    need(fa.legacy === false && fa.reqDate === keep.fresh.reqDate, 'legacy:false 新单不得被改打成存量');
    need(a.materialRequisitions.length === raw.materialRequisitions.length && a.materialOutbound.length === raw.materialOutbound.length, '迁移行数应不变');
    return '回填正确 · 两次一致 · 新单未被改标';
  });

  await step('materials', 'P4-4-G 存量单作废只走 P0-2：不被历史某日负库存锁死', async () => {
    const m = await p4Mat('K', 100);
    const r1 = await p4Req(m.id, 10, p4D4);
    needOk(await p4Confirm(r1.id, m.id, 10, p4D4), 'P4-4-G confirm1');
    const o = await p4Out(m.id, 8, { outDate: dayOff(p4D4, 1) });
    needOk(o, 'P4-4-G 出库 8');
    const r2 = await p4Req(m.id, 10, dayOff(p4D4, 2));
    needOk(await p4Confirm(r2.id, m.id, 10, dayOff(p4D4, 2)), 'P4-4-G confirm2');
    // 把它标成存量：停服 → 改库 → 起服（模拟迁移前的单）
    const port = Number(String(base).split(':').pop());
    await stopServer();
    const db2 = JSON.parse(fs.readFileSync(path.join(TMP, 'data', 'db.json'), 'utf8'));
    db2.materialRequisitions.find(x => x.id === r1.id).legacy = true;
    fs.writeFileSync(path.join(TMP, 'data', 'db.json'), JSON.stringify(db2, null, 2), 'utf8');
    await startServer(port);
    const v = await api('PUT', '/api/materialRequisitions/' + r1.id + '/void', { token, body: { reason: 'ZT P4-4-G 存量' } });
    needOk(v, '存量单作废应成功（回放跳过）');
    need(v.data && v.data.data && v.data.data.status === '已作废', '存量单应已作废');
    const v2 = await api('PUT', '/api/materialRequisitions/' + r2.id + '/void', { token, body: { reason: 'ZT P4-4-G 存量2' } });
    need(v2.status === 400 && /作废后可用库存将为负/.test(String(v2.data.error)), '存量单遇有效出库占用仍应 400：' + brief(v2.data));
    return '存量作废成功 · P0-2 仍拦有效占用';
  });

  await step('materials', 'P4-4-H 期初余额：老账历史负数不再卡新单', async () => {
    const m = await p4Mat('L', 100);
    const r1 = await p4Req(m.id, 10, p4D4);
    needOk(await p4Confirm(r1.id, m.id, 10, p4D4), 'P4-4-H confirm1');
    const o = await p4Out(m.id, 8, { outDate: dayOff(p4D4, 1) });
    needOk(o, 'P4-4-H 出库 8');
    const r2 = await p4Req(m.id, 10, dayOff(p4D4, 2));
    needOk(await p4Confirm(r2.id, m.id, 10, dayOff(p4D4, 2)), 'P4-4-H confirm2');
    // 造期初：三张单的创建时间压到当天 00:10，期初截止 00:20、余额 12 → 老账（含 8 日负）全部含在期初
    const port = Number(String(base).split(':').pop());
    const early = srvToday + ' 00:10', cut = srvToday + ' 00:20';
    await stopServer();
    const p4db = path.join(TMP, 'data', 'db.json');
    const db2 = JSON.parse(fs.readFileSync(p4db, 'utf8'));
    const mm = db2.materials.find(x => x.id === m.id);
    mm.openingAvailable = 12; mm.openingDate = srvToday; mm.openingAt = cut;
    db2.materialRequisitions.filter(x => x.id === r1.id || x.id === r2.id).forEach(x => {
      x.legacy = true; x.createdAt = early; x.confirmedAt = early;
      (x.history || []).forEach(h => { h.at = early; });
    });
    const oo = db2.materialOutbound.find(x => x.id === o.data.data.id);
    oo.legacy = true; oo.createdAt = early;
    fs.writeFileSync(p4db, JSON.stringify(db2, null, 2), 'utf8');
    await startServer(port);
    // 期初 12：再出 12 恰好放行（老账 8 日的负不再参与），再出 1 拒
    const ok1 = await p4Out(m.id, 12, { outDate: srvToday });
    needOk(ok1, '期初 12 应可出 12（老账负数被期初吸收）');
    const bad = await p4Out(m.id, 1, { outDate: srvToday });
    need(bad.status === 400 && bad.data.date === srvToday, '期初用尽后再出 1 应被拒：' + brief(bad.data));
    return '期初 12 → 出 12 放行 · 再出 1 拒';
  });

  await step('materials', 'P4-6-A 到货统计按到货日而不是录入日（纯函数）', async () => {
    const AC = require(path.join(ROOT, 'public', 'js', 'arrival-calc.js')).ArrivalCalc;
    need(AC && typeof AC.recentArrivals === 'function', 'arrival-calc 未导出 recentArrivals');
    const reqs = [{
      reqNo: 'LL-X-1', projects: ['P'], items: [{ materialId: 'm1', code: 'C1', description: 'D1', unit: '只', project: 'P' }],
      history: [
        { at: '2026-11-11 09:00', arrivalDate: p4D4, rows: [{ materialId: 'm1', thisQty: 6 }] },
        { at: '2026-11-11 10:00', arrivalDate: dayOff(p4D4, 2), rows: [{ materialId: 'm1', thisQty: 4 }] }
      ]
    }];
    const ev = AC.recentArrivals(reqs, ['P'], 10);
    need(ev.length === 2, '应有两条入库事件：' + ev.length);
    need(ev[0].arrivalDate === dayOff(p4D4, 2) && ev[0].at === '2026-11-11 10:00', '应按到货日倒序且保留录入时间：' + brief(ev[0]));
    need(ev[1].arrivalDate === p4D4, '第二条到货日应为 ' + p4D4 + '：' + brief(ev[1]));
    const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'views', 'arrivalStats.js'), 'utf8');
    need(/e\.arrivalDate \|\| e\.at/.test(src), '到货统计页应按 arrivalDate 双读');
    return '按到货日倒序 · 录入时间保留';
  });

  await step('materials', 'P4-6-B 导出含领料日期与按次入库历史', async () => {
    const m = await p4Mat('N', 100);
    const r = await p4Req(m.id, 10, p4D4);
    needOk(await api('PUT', '/api/materialRequisitions/' + r.id + '/confirm', {
      token, body: { rows: [{ materialId: m.id, thisQty: 6, reason: 'ZT分两批' }], arrivalDate: p4D4 }
    }), 'P4-6-B confirm1');
    needOk(await api('PUT', '/api/materialRequisitions/' + r.id + '/confirm', {
      token, body: { rows: [{ materialId: m.id, thisQty: 4 }], arrivalDate: dayOff(p4D4, 2) }
    }), 'P4-6-B confirm2');
    const res = await fetch(base + '/api/materialRequisitions/' + r.id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    need(res.status === 200, '导出应 200，实际 ' + res.status);
    need(/filename="LL-/.test(String(res.headers.get('content-disposition'))), '文件名仍应是单号');
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = xlsx.read(buf, { type: 'buffer' });
    const aoa = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false, defval: '' });
    const flat = aoa.map(x => x.join('|')).join('\n');
    need(/领料日期：/.test(flat) && flat.indexOf(p4D4) > -1, '表内应有领料日期 ' + p4D4);
    const idx = aoa.findIndex(x => String(x[0]).indexOf('入库记录') === 0);
    need(idx > 0, '应有入库记录块');
    const hist = aoa.slice(idx).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(String(x[0])));
    need(hist.length === 2, '应有两条按次入库记录：' + brief(hist));
    need(hist[0][0] === p4D4 && Number(hist[0][2]) === 6, '第一次到货日/数量不符：' + brief(hist[0]));
    need(hist[1][0] === dayOff(p4D4, 2) && Number(hist[1][2]) === 4, '第二次到货日/数量不符：' + brief(hist[1]));
    need(String(hist[0][3]).indexOf(srvToday) === 0, '入库记录应带录入时间：' + brief(hist[0]));
    return '领料日期 + 两行到货历史（' + hist.map(x => x[0]).join(' / ') + '）';
  });

  await step('materials', 'P4-6-C 出库列表按出库日升序（补录单在前、今天在后）', async () => {
    const m = await p4Mat('O', 100);
    const r = await p4Req(m.id, 20, p4D4);
    needOk(await p4Confirm(r.id, m.id, 20, p4D4), 'P4-6-C confirm');
    const oOld = await p4Out(m.id, 1, { outDate: p4D4 });
    needOk(oOld, 'P4-6-C 补录 ' + p4D4 + ' 出库');
    const oNew = await p4Out(m.id, 1, {});
    needOk(oNew, 'P4-6-C 今天出库');
    const list = needOk(await api('GET', '/api/materialOutbound/orders?project=' + encodeURIComponent(P4PJ), { token }), 'orders');
    const ids = (list || []).map(x => x.id);
    const iNew = ids.indexOf(oNew.data.data.id), iOld = ids.indexOf(oOld.data.data.id);
    need(iNew >= 0 && iOld >= 0 && iOld < iNew, '补录单应排在今天的单之前（整体升序）：' + brief(ids.slice(0, 5)));
    // 整列表按单号升序：日期段 + 流水段非降
    const nos = (list || []).map(x => x.outNo);
    const sorted = nos.slice().sort((a, b) => MaterialNo.cmp(a, b));
    need(JSON.stringify(nos) === JSON.stringify(sorted), '出库单列表整体应按单号升序：' + brief(nos.slice(0, 6)));
    return 'outDate 升序 · 补录在前、今天在后 · 整表按单号升序';
  });

  // 退回更正后：原来与「入库/出库更正」绑定的冒烟用例随业务代码一并退出，
  // 改为断言「更正入口不存在」（静态源码 + 动态路由），防止旧能力被带回。
  await step('materials', 'R-更正入口已关闭（路由/按钮/连带更正均不存在）', async () => {
    const srv = fs.readFileSync(path.join(TMP, 'server', 'routes', 'materials.js'), 'utf8');
    const view = fs.readFileSync(path.join(TMP, 'public', 'js', 'views', 'materials.js'), 'utf8');
    need(!/\/receipts\/:entryId\/correct/.test(srv), '服务端不应注册入库更正路由');
    need(!/\/entries\/:entryId\/correct/.test(srv), '服务端不应注册出库更正路由');
    need(!/outboundCorrections|receiptCorrections/.test(srv), '服务端不应保留连带更正');
    need(!/openOutCorrect|submitOutCorrect|openCorrect|submitCorrect/.test(view), '前端不应有更正弹窗入口');
    const r1 = await api('POST', '/api/materialRequisitions/rq-none/receipts/none/correct', { body: { reason: 'ZT测试' }, token });
    need(r1.status >= 400 && r1.status < 500, 'POST 入库更正应 4xx，实际 ' + r1.status);
    const r2 = await api('POST', '/api/materialOutbound/none/entries/none/correct', { body: { reason: 'ZT测试' }, token });
    need(r2.status >= 400 && r2.status < 500, 'POST 出库更正应 4xx，实际 ' + r2.status);
    return '更正路由/按钮/连带更正均不存在，POST 均 4xx';
  });

  /* ---------- 汇总 ---------- */
  await stopServer();
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  log('\n=== 结果：通过 ' + pass + ' / 失败 ' + fail + '（' + ((Date.now() - t0) / 1000).toFixed(1) + 's）===');
  if (fail) {
    log('失败清单：');
    results.filter(r => !r.ok).forEach(r => log('  - [' + r.group + '] ' + r.name + '：' + r.info));
  }
  if (KEEP) log('临时目录（已保留）：' + TMP);
  else { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { } }
  process.exit(fail ? 1 : 0);
}

if (require.main === module) {
  runSmoke().catch(async (e) => {
    log('冒烟脚本异常：' + e.stack);
    await stopServer();
    if (TMP && !KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (err) { } }
    process.exit(1);
  });
}

// 供 TZ=UTC 子进程 require（只导出纯函数断言，不触发服务启动）
module.exports = { splitPureChecks };
