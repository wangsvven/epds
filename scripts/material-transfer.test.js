#!/usr/bin/env node
/* ========== 材料「项目间调拨」全量用例 T01–T35 ==========
 * 自包含：复制本仓库到系统临时目录（含 data 副本）→ 起独立端口 → 造数 → 跑用例 → 自清。
 * 只连本进程起的临时实例，不触碰生产库/生产端口。
 *
 * 用法：node scripts/material-transfer.test.js
 *       node scripts/material-transfer.test.js --keep   保留临时目录（排查失败）
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KEEP = process.argv.includes('--keep');
const SKIP_TOP = new Set(['node_modules', '.git', '_backup', '_shots', '.workbuddy']);

let TMP = '', BASE = '', child = '', serverLog = '';
let pass = 0, fail = 0;
const failures = [];
function ck(id, name, cond, detail) {
  if (cond) { pass++; console.log('  PASS [' + id + '] ' + name + (detail ? '  → ' + detail : '')); }
  else { fail++; failures.push(id + ' ' + name + (detail ? '｜' + detail : '')); console.log('  FAIL [' + id + '] ' + name + (detail ? '  → ' + detail : '')); }
}
const log = s => process.stdout.write(s + '\n');
const enc = encodeURIComponent;
const round = n => Math.round((Number(n) || 0) * 10000) / 10000;
const todayStr = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
function dayShift(delta) {
  const d = new Date(todayStr() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

function prepareTmp() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'erp-transfer-'));
  fs.cpSync(ROOT, TMP, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(ROOT, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (SKIP_TOP.has(top)) return false;
      if (top === 'data' && rel !== 'data') return true; // data 整体保留（下面单独拷）
      return true;
    },
  });
  // node_modules 用软链复用
  try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TMP, 'node_modules'), 'dir'); } catch (e) {}
}

async function startServer(port, cwd) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['server.js'], {
      cwd: cwd || TMP,
      env: Object.assign({}, process.env, { PORT: String(port) }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = d => { out += d.toString(); if (out.indexOf('已启动') >= 0) resolve(c); };
    c.stdout.on('data', onData);
    c.stderr.on('data', onData);
    c.on('exit', code => { if (out.indexOf('已启动') < 0) reject(new Error('服务启动失败(' + code + ')：' + out.slice(-400))); });
    setTimeout(() => { if (out.indexOf('已启动') < 0) reject(new Error('服务启动超时：' + out.slice(-400))); }, 30000);
  });
}

async function api(method, p, body, token) {
  const opt = { method, headers: {} };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, opt);
  let data = null; try { data = await r.json(); } catch (e) { data = null; }
  return { status: r.status, data };
}

/* ---------------- 造数 ---------------- */
let TOK = '', LEADER = '', CLERK = '';
const PA = 'S6测试项目A', PB = 'S6测试项目B', PC = 'S6测试项目C';

async function mkProject(name) {
  const r = await api('POST', '/api/projects', { name, status: '在建工程', category: '自有工程', completed: false }, TOK);
  return r.status === 200;
}
async function mkMat(project, code, unit, desc, qtyReq) {
  const r = await api('POST', '/api/materials', {
    project, code, unit, description: desc, qtyRequired: qtyReq || 1000, source: 'ERP采购申请', orderNo: '-',
  }, TOK);
  if (r.status !== 200) throw new Error('建材料行失败(' + project + '/' + code + ')：' + JSON.stringify(r.data));
  return r.data.id;
}
/* 走真实链路：领料单 → 确认入库（可选分两次） */
async function stockIn(matId, qty, opts) {
  const o = opts || {};
  const reqDate = o.reqDate || dayShift(-2);
  const c = await api('POST', '/api/requisitions/create', { items: [{ id: matId, qty }], reqDate }, TOK);
  if (c.status !== 200) throw new Error('建领料单失败：' + JSON.stringify(c.data));
  const reqId = c.data.data.id;
  const first = o.firstQty === undefined ? qty : o.firstQty;
  const c1 = await api('PUT', '/api/materialRequisitions/' + reqId + '/confirm', {
    arrivalDate: o.arrival1 || dayShift(-1), rows: [{ materialId: matId, thisQty: first, reason: first < qty ? '分批到货' : '' }],
  }, TOK);
  if (c1.status !== 200) throw new Error('确认入库失败：' + JSON.stringify(c1.data));
  if (first < qty) {
    const c2 = await api('PUT', '/api/materialRequisitions/' + reqId + '/confirm', {
      arrivalDate: o.arrival2 || todayStr(), rows: [{ materialId: matId, thisQty: round(qty - first), reason: '分批到货' }],
    }, TOK);
    if (c2.status !== 200) throw new Error('二次确认入库失败：' + JSON.stringify(c2.data));
  }
  return reqId;
}
async function mkPair(tag, opts) {
  const o = opts || {};
  const code = 'S6T-' + tag;
  const desc = 'S6 调拨测试材料 ' + tag;
  const unit = o.unit || '个';
  const a = await mkMat(o.fromProject || PA, code, unit, o.descA || desc, o.qtyReq || 1000);
  const b = await mkMat(o.toProject || PB, code, o.unitB || unit, o.descB || desc, 1000);
  return { a, b, code, desc };
}
async function out(matId, project, qty, receiver) {
  const r = await api('POST', '/api/materialOutbound/create', {
    project, receiver: receiver || '杨华明', outDate: todayStr(), items: [{ materialId: matId, qty }],
  }, TOK);
  return r;
}
async function transferDraft(body) {
  return api('POST', '/api/materialTransfers', body, TOK);
}
/* 生成多行契约的请求体；extra 里仍可用 fromMaterialId/toMaterialId/qty 简写覆盖首行 */
function draftBody(pair, qty, extra) {
  const o = Object.assign({
    kind: '调拨', fromProject: PA, toProject: PB,
    items: [{ fromMaterialId: pair.a, toMaterialId: pair.b, qty }],
    transferDate: dayShift(-1), reason: 'S6 用例',
  }, extra || {});
  if (extra && (extra.fromMaterialId !== undefined || extra.toMaterialId !== undefined || extra.qty !== undefined)) {
    o.items = [{
      fromMaterialId: extra.fromMaterialId || pair.a,
      toMaterialId: extra.toMaterialId || pair.b,
      qty: extra.qty === undefined ? qty : extra.qty,
    }];
    delete o.fromMaterialId; delete o.toMaterialId; delete o.qty;
  }
  return o;
}
async function effect(id) { return api('PUT', '/api/materialTransfers/' + id + '/effect', {}, TOK); }
async function ret(id, qty, date, reason, itemId) {
  let iid = itemId;
  if (!iid) {
    const g = await api('GET', '/api/materialTransfers/' + id, undefined, TOK);
    const its = (g.data && g.data.items) || [];
    iid = its.length ? its[0].id : '';
  }
  return api('PUT', '/api/materialTransfers/' + id + '/return', { itemId: iid, qty, returnDate: date || todayStr(), returnDateReason: reason || '' }, TOK);
}
async function retVoid(id, reason, itemId) { return api('PUT', '/api/materialTransfers/' + id + '/return/void', { itemId: itemId || undefined, reason: reason === undefined ? 'S6 作废' : reason }, TOK); }
async function voidIt(id, reason) { return api('PUT', '/api/materialTransfers/' + id + '/void', { reason: reason || 'S6 撤销' }, TOK); }

/* 双口径 + 集合/材料行快照（全走 HTTP，不读库文件） */
async function snap(ids, project, mode) {
  const [list, mats] = await Promise.all([
    api('GET', '/api/materialTransfers', undefined, TOK),
    api('GET', '/api/materials', undefined, TOK),
  ]);
  const strip = (list.data || []).map(t => [t.id, t.status, t.transferNo, t.qty, (t.returns || []).length, t.deleted ? 1 : 0]).sort();
  const mine = (mats.data || []).filter(m => ids.indexOf(m.id) >= 0).map(m => [m.id, m.qtyArrived, m.qtyRequired, m.project]).sort();
  const stock = await api('GET', '/api/materialOutbound/stock?project=' + enc(project) + '&includeZero=1', undefined, TOK);
  const agg = {};
  (stock.data || []).forEach(r => { if (ids.indexOf(r.id) >= 0) agg[r.id] = [r.available, r.transferIn, r.transferOut]; });
  const asof = await api('GET', '/api/materialOutbound/stock-asof?project=' + enc(project) + '&date=' + todayStr() + '&ids=' + ids.join(','), undefined, TOK);
  const rep = {};
  ((asof.data && asof.data.rows) || []).forEach(r => { rep[r.materialId] = r.available; });
  return JSON.stringify(mode === 'stock' ? { mine, agg, rep } : { strip, mine, agg, rep });
}
/* 聚合与回放逐行一致 */
async function dualConsistent(ids, project) {
  const stock = await api('GET', '/api/materialOutbound/stock?project=' + enc(project) + '&includeZero=1', undefined, TOK);
  const agg = {};
  (stock.data || []).forEach(r => { if (ids.indexOf(r.id) >= 0) agg[r.id] = round(r.available); });
  const asof = await api('GET', '/api/materialOutbound/stock-asof?project=' + enc(project) + '&date=' + todayStr() + '&ids=' + ids.join(','), undefined, TOK);
  const rep = {};
  ((asof.data && asof.data.rows) || []).forEach(r => { rep[r.materialId] = round(r.available); });
  const rows = ids.map(id => ({ id, agg: agg[id], rep: rep[id] }));
  const ok = rows.every(r => r.agg === r.rep && r.agg !== undefined);
  return { ok, rows };
}
async function sumAvail(ids, project) {
  const stock = await api('GET', '/api/materialOutbound/stock?project=' + enc(project) + '&includeZero=1', undefined, TOK);
  let s = 0;
  (stock.data || []).forEach(r => { if (ids.indexOf(r.id) >= 0) s += Number(r.available) || 0; });
  return round(s);
}

/* ================= 用例 ================= */
(async () => {
  prepareTmp();
  const port = await freePort();
  BASE = 'http://127.0.0.1:' + port;
  child = await startServer(port);
  log('临时实例：' + TMP + '  端口 ' + port + '  PID ' + child.pid);

  const lg = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
  TOK = lg.data.token;
  await api('POST', '/api/users', { loginName: 's6leader', username: 's6leader', email: 's6leader@test.local', name: 'S6班组长', role: '班组长', userGroup: '班组长', password: 'Test1234!' }, TOK);
  await api('POST', '/api/users', { loginName: 's6clerk', username: 's6clerk', email: 's6clerk@test.local', name: 'S6材料员', role: '材料员', userGroup: '材料员', password: 'Test1234!' }, TOK);
  const l1 = await api('POST', '/api/login', { username: 's6leader', password: 'Test1234!' });
  const l2 = await api('POST', '/api/login', { username: 's6clerk', password: 'Test1234!' });
  LEADER = l1.data && l1.data.token; CLERK = l2.data && l2.data.token;

  for (const n of [PA, PB, PC]) await mkProject(n);
  log('项目与账号就绪');

  /* ---------- T01 双口径同源 + 守恒 ---------- */
  {
    const p = await mkPair('T01');
    await stockIn(p.a, 100);
    const before = await sumAvail([p.a], PA) + await sumAvail([p.b], PB);
    const d = await transferDraft(draftBody(p, 30));
    const e = await effect(d.data.data.id);
    ck('T01', '调拨生效成功', e.status === 200, e.status + ' ' + (e.data && e.data.error));
    const dual = await dualConsistent([p.a], PA);
    ck('T01', '调出侧聚合可用 = 回放可用', dual.ok, JSON.stringify(dual.rows));
    const dual2 = await dualConsistent([p.b], PB);
    ck('T01', '调入侧聚合可用 = 回放可用', dual2.ok, JSON.stringify(dual2.rows));
    const after = await sumAvail([p.a], PA) + await sumAvail([p.b], PB);
    ck('T01', '全系统 Σ可用 生效前后守恒', round(before) === round(after), before + ' → ' + after);
    ck('T01', '调出侧 −30 / 调入侧 +30', (await sumAvail([p.a], PA)) === 70 && (await sumAvail([p.b], PB)) === 30, '');
  }

  /* ---------- T02 采购统计不污染 ---------- */
  {
    const p = await mkPair('T02');
    await stockIn(p.a, 50);
    const m0 = (await api('GET', '/api/materials/' + p.a, undefined, TOK)).data;
    const d = await transferDraft(draftBody(p, 10));
    await effect(d.data.data.id);
    await ret(d.data.data.id, 2); // 非借调会拒，忽略
    const m1 = (await api('GET', '/api/materials/' + p.a, undefined, TOK)).data;
    ck('T02', 'qtyArrived / qtyRequired 零变化', m0.qtyArrived === m1.qtyArrived && m0.qtyRequired === m1.qtyRequired, m1.qtyArrived + '/' + m1.qtyRequired);
    const stat = await api('GET', '/api/materials/' + p.a, undefined, TOK);
    ck('T02', '到库状态不变', m0.status === stat.data.status, stat.data.status);
  }

  /* ---------- T03 可调上限（超 0.0001 被拒） ---------- */
  {
    const p = await mkPair('T03');
    await stockIn(p.a, 20);
    const d1 = await transferDraft(draftBody(p, 20));
    const e1 = await effect(d1.data.data.id);
    ck('T03', '可用全量可生效', e1.status === 200, e1.status + ' ' + (e1.data && e1.data.error));
    const p2 = await mkPair('T03b');
    await stockIn(p2.a, 20);
    const before = await snap([p2.a, p2.b], PA);
    const d2 = await transferDraft(draftBody(p2, 20.0001));
    const e2 = await effect(d2.data.data.id);
    ck('T03', '超可用 0.0001 被拒', e2.status === 400 && /可用不足/.test(e2.data.error), e2.status + ' ' + (e2.data && e2.data.error));
    await api('DELETE', '/api/materialTransfers/' + d2.data.data.id, undefined, TOK);
    const after = await snap([p2.a, p2.b], PA);
    ck('T03', '失败不变：集合与材料行快照一致', before === after, '');
  }

  /* ---------- T04 未到货不参与 ---------- */
  {
    const p = await mkPair('T04');
    // 只建领料单不确认到货 → 在途 30
    await api('POST', '/api/requisitions/create', { items: [{ id: p.a, qty: 30 }], reqDate: todayStr() }, TOK);
    const before = await snap([p.a, p.b], PA);
    const d = await transferDraft(draftBody(p, 30));
    const e = await effect(d.data.data.id);
    ck('T04', '仅有在途未到货时按未到货量调拨被拒（入库量 0 明确拦截）', e.status === 400 && /入库量为 0/.test(e.data.error || ''), e.status + ' ' + (e.data && e.data.error));
    await api('DELETE', '/api/materialTransfers/' + d.data.data.id, undefined, TOK);
    ck('T04', '失败不变', before === (await snap([p.a, p.b], PA)), '');
  }

  /* ---------- T05 分批到货后分次调拨（真实走确认到货链路） ---------- */
  {
    const p = await mkPair('T05');
    const reqId = await stockIn(p.a, 100, { reqDate: dayShift(-6), firstQty: 40, arrival1: dayShift(-3), arrival2: dayShift(-1) }); // 先 40 后 60
    const d1 = await transferDraft(draftBody(p, 40));
    const e1 = await effect(d1.data.data.id);
    ck('T05', '第一次到货后即可调拨已到部分 40', e1.status === 200, e1.status + ' ' + (e1.data && e1.data.error));
    const d2 = await transferDraft(draftBody(p, 60));
    const e2 = await effect(d2.data.data.id);
    ck('T05', '第二次到货后可再调 60', e2.status === 200, e2.status + ' ' + (e2.data && e2.data.error));
    const m = (await api('GET', '/api/materials/' + p.a, undefined, TOK)).data;
    ck('T05', '两次确认入库累计 100', round(m.qtyArrived) === 100, String(m.qtyArrived));
    ck('T05', '调出后调出侧可用归零', (await sumAvail([p.a], PA)) === 0, String(await sumAvail([p.a], PA)));
    const req = (await api('GET', '/api/materialRequisitions/' + reqId, undefined, TOK)).data;
    ck('T05', '领料单两次入库历史各一条', (req.history || []).length >= 2, 'history=' + (req.history || []).length);
  }

  /* ---------- T06 部分调拨后剩余再调 ---------- */
  {
    const p = await mkPair('T06');
    await stockIn(p.a, 100);
    const d1 = await transferDraft(draftBody(p, 30));
    await effect(d1.data.data.id);
    const d2 = await transferDraft(draftBody(p, 40));
    const e2 = await effect(d2.data.data.id);
    ck('T06', '剩余可继续调 40', e2.status === 200, e2.status + ' ' + (e2.data && e2.data.error));
    ck('T06', '两侧余量正确（30 / 70）', (await sumAvail([p.a], PA)) === 30 && (await sumAvail([p.b], PB)) === 70, '');
  }

  /* ---------- T07 同项目禁止 / 父子项目可调 ---------- */
  {
    const p = await mkPair('T07');
    const before = await snap([p.a, p.b], PA);
    const d = await transferDraft(draftBody(p, 1, { toProject: PA, toMaterialId: p.b }));
    ck('T07', 'from=to 字面同名被拒', d.status === 400 && /不能相同/.test(d.data.error), d.status + ' ' + (d.data && d.data.error));
    ck('T07', '失败不变', before === (await snap([p.a, p.b], PA)), '');
    // 父子项目名：S6测试项目A 与 S6测试项目A-子
    const subName = PA + '-子';
    await mkProject(subName);
    const sub = await mkMat(subName, p.code, '个', p.desc, 100);
    const d2 = await transferDraft({ kind: '调拨', fromProject: PA, toProject: subName, items: [{ fromMaterialId: p.a, toMaterialId: sub, qty: 1 }], transferDate: dayShift(-1), reason: '父子' });
    ck('T07', '父/子项目名之间可调', d2.status === 200, d2.status + ' ' + (d2.data && d2.data.error));
  }

  /* ---------- T08 双侧对齐（单位/编码/描述/无此行） ---------- */
  {
    const p = await mkPair('T08');
    const badUnit = await mkMat(PB, p.code, '根', p.desc, 100);
    const badCode = await mkMat(PB, 'S6T-OTHER', '个', p.desc, 100);
    const badDesc = await mkMat(PB, p.code, '个', p.desc + '（不同规格）', 100);
    const before = await snap([p.a, p.b], PA);
    let r = await transferDraft(draftBody(p, 1, { toMaterialId: badUnit }));
    ck('T08', '单位不一致被拒', r.status === 400 && /单位不一致/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    r = await transferDraft(draftBody(p, 1, { toMaterialId: badCode }));
    ck('T08', '编码不一致被拒', r.status === 400 && /编码不一致/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    r = await transferDraft(draftBody(p, 1, { toMaterialId: badDesc }));
    ck('T08', '描述不一致被拒且并列两侧原文', r.status === 400 && /描述不一致/.test(r.data.error) && /不同规格/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    r = await transferDraft(draftBody(p, 1, { toMaterialId: 'no-such' }));
    ck('T08', '调入侧无此行被拒', r.status === 400 && /不存在/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    ck('T08', '失败不变', before === (await snap([p.a, p.b], PA)), '');
  }

  /* ---------- T09 草稿零效应 / 已生效不可编辑删除 ---------- */
  {
    const p = await mkPair('T09');
    await stockIn(p.a, 50);
    const before = await snap([p.a, p.b], PA, 'stock');
    const d = await transferDraft(draftBody(p, 10));
    const id = d.data.data.id;
    ck('T09', '草稿无单号', d.data.data.transferNo === '' && d.data.data.status === '草稿', '');
    await api('PUT', '/api/materialTransfers/' + id, { qty: 12 }, TOK);
    ck('T09', '草稿可编辑且零库存效应', before === (await snap([p.a, p.b], PA, 'stock')), '');
    await api('DELETE', '/api/materialTransfers/' + id, undefined, TOK);
    ck('T09', '草稿可删除（库存仍不变）', before === (await snap([p.a, p.b], PA, 'stock')), '');
    const d2 = await transferDraft(draftBody(p, 10));
    await effect(d2.data.data.id);
    let r = await api('PUT', '/api/materialTransfers/' + d2.data.data.id, { qty: 1 }, TOK);
    ck('T09', '编辑已生效被拒', r.status === 400 && /只有草稿/.test(r.data.error), r.status);
    r = await api('DELETE', '/api/materialTransfers/' + d2.data.data.id, undefined, TOK);
    ck('T09', '删除已生效被拒', r.status === 400 && /只有草稿/.test(r.data.error), r.status);
  }

  /* ---------- T10 生效时重验（草稿期间库存被占走） ---------- */
  {
    const p = await mkPair('T10');
    await stockIn(p.a, 50, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const d = await transferDraft(draftBody(p, 50));
    const d2 = await transferDraft(draftBody(p, 50, { transferDate: dayShift(-2) }));
    const e2 = await effect(d2.data.data.id);   // 先占走
    ck('T10', '前置：另一笔先占走全部库存', e2.status === 200, e2.status + ' ' + (e2.data && e2.data.error));
    const before = await snap([p.a, p.b], PA);
    const e = await effect(d.data.data.id);
    ck('T10', '库存被占走后生效被拒（可用为 0 明确拦截）', e.status === 400 && /(可用为 0|可用不足)/.test(e.data.error || ''), e.status + ' ' + (e.data && e.data.error));
    ck('T10', '失败不变：草稿保留', before === (await snap([p.a, p.b], PA)), '');
    const still = (await api('GET', '/api/materialTransfers/' + d.data.data.id, undefined, TOK)).data;
    ck('T10', '草稿状态未变且无单号', still.status === '草稿' && still.transferNo === '', still.status);
  }

  /* ---------- T11 回放全历史中间日为负 ---------- */
  {
    const p = await mkPair('T11');
    // 11-21 到货 100，11-22 出库 50；再补录 11-20 的调拨 30（早于到货）→ 中间日为负
    await stockIn(p.a, 100, { reqDate: dayShift(-5), arrival1: dayShift(-1) });
    await out(p.a, PA, 50);
    const d = await transferDraft(draftBody(p, 30, { transferDate: dayShift(-3) })); // 早于到货日
    const before = await snap([p.a, p.b], PA);
    const e = await effect(d.data.data.id);
    ck('T11', '补录更早日期致中间日为负被拒', e.status === 400 && /负/.test(e.data.error || ''), e.status + ' ' + (e.data && e.data.error));
    ck('T11', '错误含日期与可用量', !!e.data.date && e.data.available !== undefined, 'date=' + e.data.date + ' avail=' + e.data.available);
    ck('T11', '失败不变（库存与集合未变）', before === (await snap([p.a, p.b], PA)), '');
    await api('DELETE', '/api/materialTransfers/' + d.data.data.id, undefined, TOK);
  }

  /* ---------- T12 期初边界 ---------- */
  {
    // 有期初字段的行需迁移写入，接口层无法构造（PUT 不放行 opening* 字段）；
    // 这里验证「无期初字段的行不触发期初边界」，有期初行的计算层口径由 S1（openingAdjustOf 未改）保证。
    const p = await mkPair('T12');
    await stockIn(p.a, 50, { reqDate: dayShift(-12), arrival1: dayShift(-11) });
    const mat = (await api('GET', '/api/materials/' + p.a, undefined, TOK)).data;
    ck('T12', '前置：新建行无期初字段', !mat.openingDate, 'openingDate=' + JSON.stringify(mat.openingDate));
    const d = await transferDraft(draftBody(p, 5, { transferDate: dayShift(-10) }));
    const e = await effect(d.data.data.id);
    ck('T12', '无期初字段的行不触发期初边界', e.status === 200, e.status + ' ' + (e.data && e.data.error));
  }

  /* ---------- T13 / T14 / T15 借调补回 ---------- */
  {
    const p = await mkPair('T13');
    await stockIn(p.a, 100);
    const d = await transferDraft(draftBody(p, 100, { kind: '借调' }));
    await effect(d.data.data.id);
    const id = d.data.data.id;
    let r = await ret(id, 40, dayShift(-1));
    ck('T13', '第一次补回成功且逐笔挂单', r.status === 200 && ((r.data.data.items || [])[0].returns || []).length === 1, r.status);
    r = await ret(id, 40, todayStr());
    const after2 = (r.data && r.data.data) || {};
    ck('T13', '第二次补回后未还 20', r.status === 200 && round(after2.outstandingQty) === 20, '未还=' + after2.outstandingQty);
    ck('T13', '每笔含日期/数量/经办', ((after2.items || [])[0] || { returns: [] }).returns.every(x => x.returnDate && x.qty !== undefined && x.by !== undefined), '');
    ck('T14', '累计未还 = 20（只计未作废）', round(after2.returnedQty) === 80, String(after2.returnedQty));
    let r2 = await ret(id, 21, todayStr());
    ck('T14', '单次补回超未还被拒', r2.status === 400 && /超过未还余额/.test(r2.data.error), r2.status + ' ' + (r2.data && r2.data.error));
    r2 = await ret(id, 20, todayStr());
    ck('T15', '补满自动结清', r2.status === 200 && r2.data.data.status === '已结清' && !!r2.data.data.settledAt, r2.data.data.status);
    r2 = await ret(id, 1, todayStr());
    ck('T15', '已结清后再补回被拒', r2.status === 400, r2.status);
    r2 = await voidIt(id, '结清后撤销');
    ck('T15', '已结清撤销被拒', r2.status === 400, r2.status);
  }

  /* ---------- T16 补回日期序 + 补回被调入侧消耗拦截（独立链路） ---------- */
  {
    const p = await mkPair('T16');
    await stockIn(p.a, 100, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const d = await transferDraft(draftBody(p, 100, { kind: '借调', transferDate: dayShift(-5) }));
    await effect(d.data.data.id);
    const id = d.data.data.id;
    await ret(id, 30, dayShift(-3));
    let r = await ret(id, 10, dayShift(-4));
    ck('T16', '补回日期早于该行上一笔被拒', r.status === 400 && /上一笔补回日期/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));

    // 独立链路：补回被调入侧消耗拦截 —— 调入侧把借调料领用耗尽后补回被拒；新货到货后可补
    const p2 = await mkPair('T16b');
    await stockIn(p2.a, 100);
    const d2 = await transferDraft(draftBody(p2, 100, { kind: '借调' }));
    await effect(d2.data.data.id);
    const id2 = d2.data.data.id;
    // 调入侧把 100 全部领用出库
    const o = await out(p2.b, PB, 100);
    ck('T16', '前置：调入侧借调料可被领用出库', o.status === 200, o.status + ' ' + (o.data && o.data.error));
    const before = await snap([p2.a, p2.b], PB);
    let r2 = await ret(id2, 100, todayStr());
    ck('T16', '调入侧已消耗时补回被拒', r2.status === 400 && /负|不足/.test(r2.data.error || ''), r2.status + ' ' + (r2.data && r2.data.error));
    ck('T16', '失败不变', before === (await snap([p2.a, p2.b], PB)), '');
    // 调入侧新货到货后同笔补回可成功
    await stockIn(p2.b, 100);
    r2 = await ret(id2, 100, todayStr());
    ck('T16', '调入侧新货到货后同笔补回成功', r2.status === 200, r2.status + ' ' + (r2.data && r2.data.error));
  }

  /* ---------- T17 撤销被占用拒绝（含 refs） ---------- */
  {
    const p = await mkPair('T17');
    await stockIn(p.a, 50);
    const d = await transferDraft(draftBody(p, 50));
    await effect(d.data.data.id);
    const o = await out(p.b, PB, 50);
    ck('T17', '前置：调入侧已领用', o.status === 200, o.status + ' ' + (o.data && o.data.error));
    const before = await snap([p.a, p.b], PB);
    const r = await voidIt(d.data.data.id, '试图撤销');
    ck('T17', '撤销被后续出库占用拒绝', r.status === 400, r.status + ' ' + (r.data && r.data.error));
    const refs = (r.data && r.data.refs) || [];
    ck('T17', 'refs 含出库单号', refs.length > 0 && refs.some(x => x.type === 'outbound' && x.outNo), JSON.stringify(refs).slice(0, 120));
    ck('T17', '失败不变', before === (await snap([p.a, p.b], PB)), '');
    const still = (await api('GET', '/api/materialTransfers/' + d.data.data.id, undefined, TOK)).data;
    ck('T17', '单据仍为已生效', still.status === '已生效', still.status);
  }

  /* ---------- T18 撤销限制 ---------- */
  {
    const p = await mkPair('T18');
    await stockIn(p.a, 100);
    const d = await transferDraft(draftBody(p, 100, { kind: '借调' }));
    await effect(d.data.data.id);
    const id = d.data.data.id;
    await ret(id, 30);
    let r = await voidIt(id, '有补回');
    ck('T18', '存在未作废补回时整单撤销被拒', r.status === 400 && /已有补回/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    await retVoid(id, '作废该笔');
    r = await voidIt(id, '全部作废后撤销');
    ck('T18', '补回全作废后整单撤销成功', r.status === 200 && r.data.data.status === '已撤销', r.status + ' ' + (r.data && r.data.error));
    const sum = await sumAvail([p.a], PA);
    ck('T18', '撤销后调出侧可用恢复 100', sum === 100, String(sum));
  }

  /* ---------- T19 已撤销终态 ---------- */
  {
    const p = await mkPair('T19');
    await stockIn(p.a, 50);
    const d = await transferDraft(draftBody(p, 10));
    await effect(d.data.data.id);
    await voidIt(d.data.data.id, '撤销');
    const id = d.data.data.id;
    const r1 = await voidIt(id, '再撤销');
    ck('T19', '已撤销后再次撤销被拒', r1.status === 400, r1.status);
    const r2 = await effect(id);
    ck('T19', '已撤销后不能再生效', r2.status === 400, r2.status);
    const r3 = await api('DELETE', '/api/materialTransfers/' + id, undefined, TOK);
    ck('T19', '已撤销可删除（与领料单「作废→删除」一致）', r3.status === 200, r3.status);
    const r4 = await ret(id, 1);
    ck('T19', '删除后不可补回（单据已不存在）', r4.status === 404, r4.status);
  }

  /* ---------- T21 权限 ---------- */
  {
    const p = await mkPair('T21');
    const before = await snap([p.a, p.b], PA);
    const r1 = await api('POST', '/api/materialTransfers', draftBody(p, 1), LEADER);
    ck('T21', '班组长写被 403', r1.status === 403, r1.status);
    const r2 = await api('POST', '/api/materialTransfers', draftBody(p, 1), CLERK);
    ck('T21', '材料员可写', r2.status === 200, r2.status + ' ' + (r2.data && r2.data.error));
    if (r2.data && r2.data.data) await api('DELETE', '/api/materialTransfers/' + r2.data.data.id, undefined, CLERK);
    const r3 = await api('GET', '/api/materialTransfers', undefined, LEADER);
    ck('T21', '班组长可读', r3.status === 200 && Array.isArray(r3.data), r3.status);
    const r4 = await api('GET', '/api/materialTransfers');
    ck('T21', '未登录 401', r4.status === 401, r4.status);
    ck('T21', '失败不变', before === (await snap([p.a, p.b], PA)), '');
  }

  /* ---------- T22 重复提交 / T23 并发竞争 / T24 过期操作 ---------- */
  {
    const p = await mkPair('T22');
    await stockIn(p.a, 50);
    const d = await transferDraft(draftBody(p, 10));
    const e1 = await effect(d.data.data.id);
    const e2 = await effect(d.data.data.id);
    ck('T22', '同一生效请求连发两次，第二次被拒', e1.status === 200 && e2.status === 400, e1.status + '/' + e2.status);
    const avail = await sumAvail([p.a], PA);
    ck('T22', '库存只动一次（50−10=40）', avail === 40, String(avail));

    const q = await mkPair('T23');
    await stockIn(q.a, 50);
    const c1 = await transferDraft(draftBody(q, 50));
    const c2 = await transferDraft(draftBody(q, 50, { transferDate: dayShift(-2) }));
    const f1 = await effect(c1.data.data.id);
    const f2 = await effect(c2.data.data.id);
    ck('T23', '两笔草稿竞争同一库存：先到先得', f1.status === 200 && f2.status === 400, f1.status + '/' + f2.status);
    await api('DELETE', '/api/materialTransfers/' + c2.data.data.id, undefined, TOK);

    const s = await mkPair('T24');
    await stockIn(s.a, 20);
    const d2 = await transferDraft(draftBody(s, 5));
    await effect(d2.data.data.id);
    const r = await api('PUT', '/api/materialTransfers/' + d2.data.data.id, { qty: 1 }, TOK);
    ck('T24', '状态已变更后过期操作被拒', r.status === 400 && /只有草稿/.test(r.data.error), r.status);
  }

  /* ---------- T26 / T27 作废补回 ---------- */
  {
    const p = await mkPair('T26');
    await stockIn(p.a, 100, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const d = await transferDraft(draftBody(p, 100, { kind: '借调', transferDate: dayShift(-5) }));
    await effect(d.data.data.id);
    const id = d.data.data.id;
    await ret(id, 40, dayShift(-2));
    await ret(id, 60, dayShift(-1));
    const closed = (await api('GET', '/api/materialTransfers/' + id, undefined, TOK)).data;
    ck('T26', '前置：已结清', closed.status === '已结清', closed.status);
    let r = await retVoid(id, '');
    ck('T26', '空原因不可作废', r.status === 400 && /作废原因/.test(r.data.error), r.status);
    r = await retVoid(id, '录错数量');
    const rr = (r.data && r.data.data) || {};
    ck('T26', '作废最近一笔后未还恢复 60 且退回已生效', r.status === 200 && round(rr.outstandingQty) === 60 && rr.status === '已生效', (r.status) + ' ' + rr.status + '/未还' + rr.outstandingQty);
    const last = (((rr.items || [])[0] || {}).returns || []).slice(-1)[0] || {};
    ck('T26', '该笔留痕：voided + 原因', last.voided === true && !!last.voidReason, JSON.stringify(last).slice(0, 100));
    r = await ret(id, 60, todayStr());
    const rr2 = (r.data && r.data.data) || {};
    ck('T26', '作废后按正确数量重新补回可再结清', r.status === 200 && rr2.status === '已结清', r.status + ' ' + rr2.status);

    // T27 限制
    const q = await mkPair('T27');
    await stockIn(q.a, 50);
    const d2 = await transferDraft(draftBody(q, 50, { kind: '借调' }));
    await effect(d2.data.data.id);
    const id2 = d2.data.data.id;
    let r2 = await retVoid(id2, '没有补回');
    ck('T27', '无补回笔时作废被拒', r2.status === 400 && /没有可作废/.test(r2.data.error), r2.status + ' ' + (r2.data && r2.data.error));
    await ret(id2, 20);
    // 调出侧可用 = 50 − 50 + 20 = 20，把这 20 领用出去后作废补回将致负库存
    const oo = await out(q.a, PA, 20);
    ck('T27', '前置：调出侧领用 20（用尽可用）', oo.status === 200, oo.status + ' ' + (oo.data && oo.data.error));
    const before = await snap([q.a, q.b], PA);
    r2 = await retVoid(id2, '回放守卫');
    ck('T27', '回放守卫拒绝作废（致负库存）', r2.status === 400, r2.status + ' ' + (r2.data && r2.data.error));
    ck('T27', '失败不变', before === (await snap([q.a, q.b], PA)), '');
  }

  /* ---------- T28 audit 不误报（纯调入行） ---------- */
  {
    const p = await mkPair('T28');
    await stockIn(p.a, 30);
    const d = await transferDraft(draftBody(p, 30));
    await effect(d.data.data.id);
    const o = await out(p.b, PB, 10);
    ck('T28', '前置：纯调入行可出库', o.status === 200, o.status + ' ' + (o.data && o.data.error));
    const audit = await api('GET', '/api/materials/audit/inconsistencies', undefined, TOK);
    const rows = (audit.data || []).filter(x => x.materialId === p.b);
    const neg = rows.filter(x => x.type === 'negative_available');
    const hid = rows.filter(x => x.type === 'stock_hidden_but_outbound_active');
    ck('T28', '纯调入后出库不误报 negative_available', neg.length === 0, '命中 ' + neg.length);
    ck('T28', '不误报 stock_hidden（剩 20 > 0）', hid.length === 0, '命中 ' + hid.length);
  }

  /* ---------- T29 领料作废 refs 含调拨单 ---------- */
  {
    const p = await mkPair('T29');
    const reqId = await stockIn(p.a, 100);
    const d = await transferDraft(draftBody(p, 30));
    await effect(d.data.data.id);
    const before = await snap([p.a, p.b], PA);
    const r = await api('PUT', '/api/materialRequisitions/' + reqId + '/void', { reason: 'S6' }, TOK);
    ck('T29', '作废被调拨占用拦截', r.status === 400, r.status + ' ' + (r.data && r.data.error));
    const refs = (r.data && r.data.refs) || [];
    ck('T29', 'refs 含调拨单（type=transfer）', refs.some(x => x.type === 'transfer' && x.transferNo), JSON.stringify(refs).slice(0, 140));
    ck('T29', '失败不变', before === (await snap([p.a, p.b], PA)), '');
  }

  /* ---------- T30 at 口径（补录生效日早于期初/到货，不被折入跳过） ---------- */
  {
    const p = await mkPair('T30');
    // 到货在昨天，调拨业务日补录到前天（早于到货）
    await stockIn(p.a, 50, { reqDate: dayShift(-9), arrival1: dayShift(-6) });
    const d = await transferDraft(draftBody(p, 10, { transferDate: dayShift(-4) }));
    const e = await effect(d.data.data.id);
    ck('T30', '补录生效日早于到货日仍可生效（at 用真实落库时间）', e.status === 200, e.status + ' ' + (e.data && e.data.error));
    const dual = await dualConsistent([p.a], PA);
    ck('T30', '回放可用与聚合可用一致', dual.ok, JSON.stringify(dual.rows));
  }

  /* ---------- T31 项目名来源 ---------- */
  {
    const p = await mkPair('T31');
    const before = await snap([p.a, p.b], PA);
    const r = await transferDraft(draftBody(p, 1, { fromProject: PC }));
    ck('T31', '项目名与行归属不一致被拒', r.status === 400 && /归属不一致/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    ck('T31', '失败不变', before === (await snap([p.a, p.b], PA)), '');
  }

  /* ---------- T32 描述归一化 ---------- */
  {
    const code = 'S6T-T32';
    const a = await mkMat(PA, code, '个', 'S6 归一化 测试', 100);
    const b = await mkMat(PB, code, '个', 'S6   归一化   测试', 100);
    const d = await transferDraft({ kind: '调拨', fromProject: PA, toProject: PB, items: [{ fromMaterialId: a, toMaterialId: b, qty: 1 }], transferDate: dayShift(-1), reason: '归一化' });
    ck('T32', '仅连续空白差异可通过', d.status === 200, d.status + ' ' + (d.data && d.data.error));
    if (d.status === 200) await api('DELETE', '/api/materialTransfers/' + d.data.data.id, undefined, TOK);
  }

  /* ---------- T33 对调拨单调用补回被拒 ---------- */
  {
    const p = await mkPair('T33');
    await stockIn(p.a, 30);
    const d = await transferDraft(draftBody(p, 10));
    await effect(d.data.data.id);
    const before = await snap([p.a, p.b], PA);
    const r = await ret(d.data.data.id, 1);
    ck('T33', '对 kind=调拨 的记录调用补回被拒', r.status === 400 && /只有借调单/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    ck('T33', '失败不变', before === (await snap([p.a, p.b], PA)), '');
  }

  /* ---------- T34 已撤销保留占用 DB- 号 ---------- */
  {
    const p = await mkPair('T34');
    await stockIn(p.a, 50);
    const d1 = await transferDraft(draftBody(p, 5));
    const e1 = await effect(d1.data.data.id);
    const no1 = e1.data.data.transferNo;
    await voidIt(d1.data.data.id, '撤销保留号');
    const after = (await api('GET', '/api/materialTransfers/' + d1.data.data.id, undefined, TOK)).data;
    ck('T34', '已撤销保留原号', after.transferNo === no1 && after.status === '已撤销', after.transferNo);
    const d2 = await transferDraft(draftBody(p, 5));
    const e2 = await effect(d2.data.data.id);
    const no2 = e2.data.data.transferNo;
    const seq1 = parseInt(String(no1).split('-').pop(), 10);
    const seq2 = parseInt(String(no2).split('-').pop(), 10);
    ck('T34', '同日下一笔顺延（作废不腾号）', seq2 === seq1 + 1, no1 + ' → ' + no2);
  }

  /* ---------- T35 /stock-asof 生效日前后 ---------- */
  {
    const p = await mkPair('T35');
    await stockIn(p.a, 40, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const day = dayShift(-2);
    const d = await transferDraft(draftBody(p, 15, { transferDate: day }));
    await effect(d.data.data.id);
    const before = await api('GET', '/api/materialOutbound/stock-asof?project=' + enc(PB) + '&date=' + dayShift(-3) + '&ids=' + p.b, undefined, TOK);
    const on = await api('GET', '/api/materialOutbound/stock-asof?project=' + enc(PB) + '&date=' + day + '&ids=' + p.b, undefined, TOK);
    const b0 = ((before.data && before.data.rows) || [])[0];
    const o0 = ((on.data && on.data.rows) || [])[0];
    ck('T35', '生效日之前不含该笔', b0 && round(b0.available) === 0, JSON.stringify(b0));
    ck('T35', '生效日当日含该笔 = 15', o0 && round(o0.available) === 15, JSON.stringify(o0));
  }

  /* ---------- 追加：缺 transferDate 的异常记录不抛错 ---------- */
  {
    const p = await mkPair('X1');
    const d = await transferDraft(draftBody(p, 1));
    // 通过 API 无法造出缺 transferDate 的已生效记录（OP-4 必写），故直接验证计算层健壮性：
    // 用一个不含 transferDate 的请求体尝试新建 → 必须被结构校验拒绝（不落库、不抛错）
    const r = await api('POST', '/api/materialTransfers', { kind: '调拨', fromProject: PA, toProject: PB, items: [{ fromMaterialId: p.a, toMaterialId: p.b, qty: 1 }], reason: '缺日期' }, TOK);
    ck('X1', '缺 transferDate 的新建被结构校验拒绝', r.status === 400 && /调拨日期/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
    await api('DELETE', '/api/materialTransfers/' + d.data.data.id, undefined, TOK);
  }

  /* ---------- T20 保存失败一致性（独立故障实例，文件开关控制 saveDB 抛错） ---------- */
  {
    const TMP2 = TMP + '-fault';
    try {
      fs.cpSync(TMP, TMP2, { recursive: true, filter: (s) => !s.split(path.sep).includes('node_modules') });
      try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(TMP2, 'node_modules'), 'dir'); } catch (e) {}
      const dbFile = path.join(TMP2, 'server', 'core', 'db.js');
      const dbSrc = fs.readFileSync(dbFile, 'utf8');
      const beforeSave = "function saveDB() {\n  fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), 'utf8');\n}";
      const afterSave = "function saveDB() {\n  if (fs.existsSync(require('path').join(__dirname, '..', '..', '.fault-save'))) throw new Error('模拟写盘失败（T20）');\n  fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), 'utf8');\n}";
      if (dbSrc.indexOf(beforeSave) < 0) throw new Error('T20：db.js 未匹配到 saveDB 原文');
      fs.writeFileSync(dbFile, dbSrc.replace(beforeSave, afterSave), 'utf8');

      const port2 = await freePort();
      const c2 = await startServer(port2, TMP2);
      const oldBase = BASE; const oldTok = TOK;
      BASE = 'http://127.0.0.1:' + port2;
      const faultFlag = path.join(TMP2, '.fault-save');
      try {
        const lg2 = await api('POST', '/api/login', { username: 'admin', password: 'admin123' });
        TOK = lg2.data.token;
        const p = await mkPair('T20');
        await stockIn(p.a, 100, { reqDate: dayShift(-9), arrival1: dayShift(-8) });
        // 准备：一张草稿、一张已生效借调（已补回一笔）、一张无补回的已生效调拨
        const dDraft = (await transferDraft(draftBody(p, 5))).data.data;
        const dLoan = (await transferDraft(draftBody(p, 20, { kind: '借调', transferDate: dayShift(-6) }))).data.data;
        const dPlain = (await transferDraft(draftBody(p, 6))).data.data;
        await effect(dLoan.id);
        await effect(dPlain.id);
        await ret(dLoan.id, 4, dayShift(-1));

        const md5 = () => require('crypto').createHash('md5').update(fs.readFileSync(path.join(TMP2, 'data', 'db.json'))).digest('hex');
        const listOf = async () => JSON.stringify((await api('GET', '/api/materialTransfers', undefined, TOK)).data.map(x => [x.id, x.status, x.transferNo, (x.returns || []).length]));
        const before = await listOf();
        const md5Before = md5();

        fs.writeFileSync(faultFlag, '1', 'utf8');

        let r = await effect(dDraft.id);
        ck('T20', '生效时 saveDB 抛错 → 500', r.status === 500 && /保存失败/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
        r = await ret(dLoan.id, 3, todayStr());
        ck('T20', '补回时 saveDB 抛错 → 500', r.status === 500 && /保存失败/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
        r = await retVoid(dLoan.id, '故障测试');
        ck('T20', '作废补回时 saveDB 抛错 → 500', r.status === 500 && /保存失败/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));
        r = await voidIt(dPlain.id, '故障测试');
        ck('T20', '撤销时 saveDB 抛错 → 500', r.status === 500 && /保存失败/.test(r.data.error), r.status + ' ' + (r.data && r.data.error));

        const after = await listOf();
        const md5After = md5();
        ck('T20', '失败不变：内存集合逐项一致', before === after, before === after ? '一致' : '有差异');
        ck('T20', '失败不变：磁盘 db.json 未被改写', md5Before === md5After, md5Before.slice(0, 8) + ' → ' + md5After.slice(0, 8));
        ck('T20', '草稿仍为草稿、借调仍已生效、调拨仍已生效', after.indexOf('"草稿"') >= 0 && after.indexOf('"已生效"') >= 0, '');

        try { fs.unlinkSync(faultFlag); } catch (e) {}
        r = await effect(dDraft.id);
        ck('T20', '故障解除后同一操作可正常成功', r.status === 200, r.status + ' ' + (r.data && r.data.error));
      } finally {
        BASE = oldBase; TOK = oldTok;
        try { c2.kill(); } catch (e) {}
        await new Promise(r2 => setTimeout(r2, 400));
      }
    } catch (e) {
      ck('T20', '故障实例可正常启动并注入', false, e && e.message);
    } finally {
      try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (e) {}
    }
  }

  /* ---------- M1–M4：多行明细契约（PLAN v2.2 新增） ---------- */
  {
    // M1 一张单三行材料，整单生效
    const tag = 'M1';
    const ps = [];
    for (let i = 1; i <= 3; i++) ps.push(await mkPair(tag + '-' + i));
    for (const p of ps) await stockIn(p.a, 50, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const beforeA = [];
    const beforeB = [];
    for (const p of ps) { beforeA.push(await sumAvail([p.a], PA)); beforeB.push(await sumAvail([p.b], PB)); }
    const body = {
      kind: '调拨', fromProject: PA, toProject: PB,
      items: ps.map(p => ({ fromMaterialId: p.a, toMaterialId: p.b, qty: 10 })),
      transferDate: dayShift(-1), reason: '多行调拨',
    };
    const d = await transferDraft(body);
    ck('M1', '多行草稿创建成功且含 3 行', d.status === 200 && (d.data.data.items || []).length === 3, d.status + ' 行数=' + ((d.data.data || {}).items || []).length);
    const e = await effect(d.data.data.id);
    ck('M1', '整单生效成功并取号', e.status === 200 && /^DB-\d{8}-\d{4}$/.test((e.data.data || {}).transferNo || ''), e.status + ' ' + (e.data && e.data.error));
    let rowOk = true;
    for (let i = 0; i < ps.length; i++) {
      const a = await sumAvail([ps[i].a], PA), b = await sumAvail([ps[i].b], PB);
      if (round(a) !== round(beforeA[i] - 10) || round(b) !== round(beforeB[i] + 10)) rowOk = false;
    }
    ck('M1', '三行调出侧各 −10、调入侧各 +10', rowOk, '');
    const det1 = (await api('GET', '/api/materialTransfers/' + d.data.data.id, undefined, TOK)).data;
    ck('M1', '详情返回 3 行明细与派生量', (det1.items || []).length === 3 && det1.items.every(it => it.qty === 10), '');

    // M2 多行借调：按行补回，最后一行补满才结清
    const tag2 = 'M2';
    const qs = [];
    for (let i = 1; i <= 3; i++) qs.push(await mkPair(tag2 + '-' + i));
    for (const p of qs) await stockIn(p.a, 50, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const d2 = await transferDraft({
      kind: '借调', fromProject: PA, toProject: PB,
      items: qs.map(p => ({ fromMaterialId: p.a, toMaterialId: p.b, qty: 20 })),
      transferDate: dayShift(-5), reason: '多行借调',
    });
    const id2 = d2.data.data.id;
    await effect(id2);
    const items2 = (await api('GET', '/api/materialTransfers/' + id2, undefined, TOK)).data.items;
    ck('M2', '多行借调生效后三行未还各 20', items2.length === 3 && items2.every(it => round(it.outstandingQty) === 20), JSON.stringify(items2.map(it => it.outstandingQty)));
    let r = await ret(id2, 20, dayShift(-3), '', items2[0].id);
    ck('M2', '补第 1 行 20 → 该行未还 0', r.status === 200 && round((r.data.data.items || [])[0].outstandingQty) === 0, r.status);
    ck('M2', '仍有两行未还 → 整单仍为已生效', r.data.data.status === '已生效' && round(r.data.data.outstandingQty) === 40, r.data.data.status + '/未还' + r.data.data.outstandingQty);
    r = await ret(id2, 20, dayShift(-3), '', items2[1].id);
    ck('M2', '补第 2 行后仍未结清', r.status === 200 && r.data.data.status === '已生效' && round(r.data.data.outstandingQty) === 20, r.data.data.status + '/未还' + r.data.data.outstandingQty);
    r = await ret(id2, 20, dayShift(-3), '', items2[2].id);
    ck('M2', '三行补满 → 整单已结清', r.status === 200 && r.data.data.status === '已结清' && round(r.data.data.outstandingQty) === 0, r.data.data.status);
    // 行级作废补回：作废第 3 行那笔 → 整单退回已生效、该行未还 20
    r = await retVoid(id2, '行级作废', items2[2].id);
    const it3 = ((r.data && r.data.data && r.data.data.items) || [])[2] || {};
    ck('M2', '行级作废补回后退回已生效且该行未还 20', r.status === 200 && r.data.data.status === '已生效' && round(it3.outstandingQty) === 20, r.status + ' ' + r.data.data.status + '/' + it3.outstandingQty);
    ck('M2', '只影响该行，其他两行仍为已补满', round(((r.data.data.items || [])[0] || {}).outstandingQty) === 0 && round(((r.data.data.items || [])[1] || {}).outstandingQty) === 0, '');

    // M3 行内重复（同一调出材料行出现两次）被拒
    const tag3 = 'M3';
    const m3 = await mkPair(tag3);
    await stockIn(m3.a, 50, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const before3 = await snap([m3.a, m3.b], PA, 'stock');
    const r3 = await transferDraft({
      kind: '调拨', fromProject: PA, toProject: PB,
      items: [{ fromMaterialId: m3.a, toMaterialId: m3.b, qty: 5 }, { fromMaterialId: m3.a, toMaterialId: m3.b, qty: 5 }],
      transferDate: dayShift(-1), reason: '重复行',
    });
    ck('M3', '同一调出材料行重复出现被拒', r3.status === 400 && /只能出现一次/.test(r3.data.error), r3.status + ' ' + (r3.data && r3.data.error));
    ck('M3', '失败不变', before3 === (await snap([m3.a, m3.b], PA, 'stock')), '');

    // M4 多行整单撤销
    const tag4 = 'M4';
    const xs = [];
    for (let i = 1; i <= 2; i++) xs.push(await mkPair(tag4 + '-' + i));
    for (const p of xs) await stockIn(p.a, 40, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const d4 = await transferDraft({
      kind: '调拨', fromProject: PA, toProject: PB,
      items: xs.map(p => ({ fromMaterialId: p.a, toMaterialId: p.b, qty: 15 })),
      transferDate: dayShift(-1), reason: '多行撤销',
    });
    await effect(d4.data.data.id);
    const midA = [await sumAvail([xs[0].a], PA), await sumAvail([xs[1].a], PA)];
    const r4 = await voidIt(d4.data.data.id, '多行撤销');
    const afterA = [await sumAvail([xs[0].a], PA), await sumAvail([xs[1].a], PA)];
    ck('M4', '多行整单撤销成功', r4.status === 200 && r4.data.data.status === '已撤销', r4.status + ' ' + (r4.data && r4.data.error));
    ck('M4', '撤销后两侧各行可用全部恢复 +15', round(afterA[0] - midA[0]) === 15 && round(afterA[1] - midA[1]) === 15, midA.join('/') + ' → ' + afterA.join('/'));

    // M5 口径守卫：入库量为 0 但可用 > 0（纯调入行）仍可再调出 —— 规则按「可用量」判定，不按字面 qtyArrived
    const mx5 = await mkPair('M5');
    await stockIn(mx5.a, 40, { reqDate: dayShift(-8), arrival1: dayShift(-6) });
    const dx5a = await transferDraft({
      kind: '调拨', fromProject: PA, toProject: PB,
      items: [{ fromMaterialId: mx5.a, toMaterialId: mx5.b, qty: 30 }],
      transferDate: dayShift(-2), reason: 'M5 造纯调入行',
    });
    const ex5a = await effect(dx5a.data.data.id);
    const bx5Row = (await api('GET', '/api/materials/' + mx5.b, undefined, TOK)).data;
    ck('M5', '前置：调入 30 成功，调入行入库量仍为 0', ex5a.status === 200 && round(bx5Row.qtyArrived) === 0, ex5a.status + ' 入库量=' + bx5Row.qtyArrived);
    const bx5Avail = await sumAvail([mx5.b], PB);
    ck('M5', '前置：纯调入行可用 = 30', round(bx5Avail) === 30, '可用=' + bx5Avail);
    const cx5 = await mkMat(PA, mx5.code, '个', mx5.desc, 1000);
    const dx5b = await transferDraft({
      kind: '调拨', fromProject: PB, toProject: PA,
      items: [{ fromMaterialId: mx5.b, toMaterialId: cx5, qty: 10 }],
      transferDate: dayShift(-1), reason: 'M5 纯调入行再调出',
    });
    const ex5b = await effect(dx5b.data.data.id);
    ck('M5', '入库量 0 但可用 30 的纯调入行仍可再调出 10', ex5b.status === 200, ex5b.status + ' ' + (ex5b.data && ex5b.data.error));

  }

  /* ---------- 汇总 ---------- */
  log('');
  log('===== 通过 ' + pass + ' / 失败 ' + fail + ' =====');
  if (failures.length) { log('失败项：'); failures.forEach(f => log('  - ' + f)); }

  child.kill();
  await new Promise(r => setTimeout(r, 500));
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} }
  else log('临时目录保留：' + TMP);
  if (fail) process.exitCode = 1;
})().catch(async e => {
  console.error('测试异常：', e && e.message ? e.message : e);
  if (child) { try { child.kill(); } catch (x) {} }
  if (TMP && !KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} }
  process.exit(2);
});
