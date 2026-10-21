'use strict';
/**
 * 本地自托管「电网生产ERP」复刻 — 后端
 * 技术栈：Node + Express + 本地 JSON 存储（data/db.json）
 * 模块：认证 / 项目 / 计划 / 借工 / 竣工资料 / 文档中心 / 材料台账 / 设置 / 用户
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
const multer = require('multer');
const xlsx = require('xlsx');

// 材料 Excel 导入：内存暂存，单文件上限 20MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 5173;

// ===== 母账号（超级所有者）+ 团队子空间 架构 =====
// 母账号（唯一）：role==='超级用户'，自有业务空间 SPACE_DEFAULT（不属于任何团队），最高控制权
// 团队（独立业务空间）：DB.bizTeams，团队 id 即其业务记录的 spaceId；母↔团队、团队A↔团队B 互相隔离
// 账号-团队归属：DB.teamMembers（一个账号可加入多个团队，各团队权限独立）
// 团队内角色：团队管理员（管成员/分权限，无重置权）/ 团队成员（按 permissions 操作）
const SPACE_DEFAULT = 'sp_default';
const ROLE_PARENT = '超级用户';        // 母账号
const ROLE_TEAM_ADMIN = '团队管理员';   // 团队管理员
const TEAM_PERMS = ['查看', '录入', '导出', '审批'];
// 按 SpaceID 行级隔离：所有业务私有集合都挂 spaceId；普通删除用逻辑删除 deleted；团队一键清空用物理删除
const BIZ_COLLECTIONS = ['projects', 'plans', 'workPlans', 'borrowWorks', 'completionDocuments', 'materials', 'materialRequisitions', 'materialImports', 'materialOutbound', 'workers', 'contacts'];
// 当前请求的隔离空间（由鉴权中间件解析写入 req.spaceId）：母账号自有空间 / 当前团队 id
function reqSpaceId(req) { return req ? req.spaceId : null; }
function isAdmin(req) { return !!(req && req.user && req.user.role === ROLE_PARENT); }
// 当前登录用户可见的业务记录（未删除 + 归属本空间）
function spaceFilter(req) { const sid = reqSpaceId(req); return rec => rec && !rec.deleted && rec.spaceId === sid; }
// 会话(token) → 当前团队 id（内存态；重启/缺失时回退到该账号首个归属团队）
const ACTIVE_TEAM = {};
function teamsOfUser(username) { return (DB.teamMembers || []).filter(m => m.username === username).map(m => m.teamId); }
function membershipOf(username, teamId) { return (DB.teamMembers || []).find(m => m.username === username && m.teamId === teamId) || null; }
function isTeamAdminOf(username, teamId) { const m = membershipOf(username, teamId); return !!m && m.role === ROLE_TEAM_ADMIN; }
// 删除某空间（团队）在磁盘上的业务附件：文档上传 + 各项目资料文件
function purgeSpaceFiles(spaceId) {
  let removed = 0;
  (DB.documents.files || []).forEach(f => {
    if (f.spaceId === spaceId && f.path && f.path.startsWith('uploads/')) {
      try { fs.unlinkSync(path.join(__dirname, 'data', f.path)); removed++; } catch (e) {}
    }
  });
  (DB.projects || []).forEach(p => {
    if (p.spaceId !== spaceId) return;
    (p.files || []).forEach(f => {
      if (f.path && f.path.startsWith('uploads/')) {
        try { fs.unlinkSync(path.join(__dirname, 'data', f.path)); removed++; } catch (e) {}
      }
    });
    // 清理空的项目附件目录
    try { fs.rmdirSync(path.join(__dirname, 'data', 'uploads', 'projects', p.id)); } catch (e) {}
  });
  return removed;
}

// ---------- 本地 JSON 存储 ----------

function seedDB() {
  const now = new Date().toISOString();
  // 全新实例：仅创建唯一母账号与空数据结构，不含任何演示/模板业务数据
  const seeded = {
    // 企业信息：全新实例为空，由用户在「全局设置 → 网站设置」自行填写
    tenant: { name: '', shortName: '' },
    // 仅保留唯一超级用户（母账号）；姓名/邮箱/电话等由用户自行维护
    users: [
      { id: 'u1', username: 'admin', loginName: 'admin', email: '', name: '管理员', role: '超级用户', userGroup: '超级用户', password: 'admin123', phone: '', createdAt: now }
    ],
    // ===== 业务数据：全新实例全部为空，所有数据由用户自行录入 =====
    projects: [],
    plans: [],
    workPlans: [],
    borrowWorks: [],
    completionDocuments: [],
    // 文档中心：仅保留上传所需的分类结构（系统配置，非业务数据）；文件与危险点库全部为空
    documents: {
      categories: ['规范文件', '工作票模板', '检查表', '奥维地图', '未分类'],
      hazardLibrary: [],
      files: []
    },
    materials: [],
    materialRequisitions: [],
    materialImports: [],
    materialOutbound: [],
    // 作业人员（用户管理-作业人员名单）：初始为空
    workers: [],
    // 外部通讯录（用户管理第三个标签页）：初始为空
    contacts: [],
    // ---------- 全局设置（按真实系统 5 子项，截图 2026-10-12） ----------
    // 年度计划名称：名称自带年份，仅 名称+排序
    // ===== 全局设置字典：全部为空，由用户自行维护 =====
    annualPlans: [],
    substations: [],
    // 单位维护（type = 分包单位 / 兄弟单位 / 监理单位 / 抄送单位）
    units: [],
    // 班组：showOnDeploy=当前部署展示（展示/隐藏）；inWorkerList=是否列入作业人员名单（列入/不列入）
    teams: [],
    // 材料目录：影响项目材料选择、导入匹配、作业内容解析、项目进度
    materialCatalog: [],
    settings: {
      // 企业名称 / 备案号留空，由用户在「全局设置 → 网站设置」自行填写
      companyName: '',
      icp: '',
      systemName: '电网生产ERP（本地版）',
      defaultSource: '甲供材料',
      allowSelfPurchase: true,
      // 企业欢迎页（访客登录前可见）
      welcome: { greeting: '欢迎来到我们的企业工作台', logoUrl: '' },
      // 登录页背景：预设图路径或本地上传后的接口路径（可在「全局设置 → 登录界面」更换）
      loginBg: '/login-bg/ink-color.jpg',
      // 建管 / 实施单位：留空，由用户自行设置
      unitBuildCity: '',
      unitBuildCounty: '',
      unitExecCity: '',
      unitExecCounty: ''
    },
    // 版本标记：全新实例即 V2 模型，避免 migrateDB 用旧演示模型覆盖空集合
    projectsV2: true,
    materialsV2: true,
    requisitionsV2: true,
    // 母账号自有业务空间（不属于任何团队）；团队空间见 bizTeams
    spaces: [
      { id: SPACE_DEFAULT, ownerUsername: 'admin', role: '超级用户', createdAt: nowISO(), status: 'active' }
    ],
    bizTeams: [],    // 团队（独立业务空间）：{ id, name, status, createdBy, createdAt, lastResetAt }
    teamMembers: [], // 账号-团队归属：{ id, teamId, username, role, permissions[], joinedAt }
    auditLogs: [], // 系统级操作日志（重置等高危操作留痕，重置不可清除）
    tokens: {} // token -> username  (运行时内存)
  };
  // 业务数据归属母账号自有空间（行级隔离）
  BIZ_COLLECTIONS.forEach(k => {
    if (Array.isArray(seeded[k])) seeded[k].forEach(r => { r.spaceId = SPACE_DEFAULT; if (r.deleted === undefined) r.deleted = false; });
  });
  seeded.users.forEach(u => { if (!u.spaceId) u.spaceId = SPACE_DEFAULT; });
  return seeded;
}

function loadDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const seeded = seedDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(seeded, null, 2), 'utf8');
    return seeded;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    const seeded = seedDB();
    fs.writeFileSync(DB_PATH, JSON.stringify(seeded, null, 2), 'utf8');
    return seeded;
  }
}

let DB = loadDB();

// ---------- 旧数据模型迁移 ----------
function migrateDB() {
  // 作业计划集合保障（老库无此集合时初始化）
  if (!Array.isArray(DB.workPlans)) DB.workPlans = [];
  // 出库单存量转换：旧简单记录 → 新单据结构（items/returns）
  if (Array.isArray(DB.materialOutbound)) {
    DB.materialOutbound.forEach((o, i) => {
      if (!Array.isArray(o.items)) {
        o.outNo = o.outNo || ('OUT-LEGACY-' + String(i + 1).padStart(6, '0'));
        o.receiver = o.receiver || o.recipient || '';
        o.status = o.status === '已作废' ? '已作废' : '有效';
        o.createdAt = o.createdAt || o.date || '';
        o.returns = [];
        o.compensated = 0;
        o.items = [{ materialId: '', code: '', description: o.material || '', unit: '', qty: Number(o.qty) || 0, returned: 0 }];
      }
    });
  }
  // 导入批次存量回填：行数（总/匹配/跳过）/ 调整数 / 备注（老记录只有 rows）
  if (Array.isArray(DB.materialImports)) {
    DB.materialImports.forEach(b => {
      if (b.rowsTotal === undefined) {
        b.rowsTotal = Number(b.rows) || 0;
        b.rowsMatched = Number(b.rows) || 0;
        b.rowsSkipped = 0;
        b.adjusted = 0;
        b.adjustments = [];
        if (b.remark === undefined) b.remark = '-';
      }
    });
  }
  // 作业人员：idCard/role/certType/validUntil → idNumber/identity/certTypes/validStart+validEnd
  if (Array.isArray(DB.workers)) {
    DB.workers = DB.workers.map(w => {
      if (w.idNumber === undefined) {
        return {
          id: w.id, createdAt: w.createdAt,
          name: w.name || '', idNumber: w.idCard || '', phone: w.phone || '',
          identity: w.role || '', team: w.team || '',
          certTypes: w.certType ? [w.certType] : [],
          validStart: '', validEnd: w.validUntil || '',
          status: '已准入'
        };
      }
      return w;
    });
  }
  if (!Array.isArray(DB.contacts)) DB.contacts = [];
  // 年度计划：year 并入名称，新增 sort
  if (Array.isArray(DB.annualPlans)) {
    DB.annualPlans = DB.annualPlans.map((p, i) => ({
      id: p.id, sort: p.sort ?? i,
      name: p.name || `${p.year || ''}年度计划`
    }));
  }
  // 属地供电所：新增 sort
  if (Array.isArray(DB.substations)) {
    DB.substations = DB.substations.map((s, i) => ({ id: s.id, name: s.name, sort: s.sort ?? i }));
  }
  // 班组：新增 showOnDeploy / inWorkerList / sort
  if (Array.isArray(DB.teams)) {
    DB.teams = DB.teams.map((t, i) => ({
      id: t.id, name: t.name,
      showOnDeploy: t.showOnDeploy || '展示',
      inWorkerList: t.inWorkerList || '列入',
      sort: t.sort ?? i
    }));
  }
  // 设置：补 welcome
  if (DB.settings && !DB.settings.welcome) {
    DB.settings.welcome = { greeting: '欢迎来到我们的企业工作台', logoUrl: '' };
  }
  // 设置：补登录页背景（旧实例无该字段时给默认预设，不覆盖用户已选）
  if (DB.settings && !DB.settings.loginBg) {
    DB.settings.loginBg = '/login-bg/ink-color.jpg';
  }
  // 单位维护：集合 + 作业建管/实施单位（周计划弹窗自动带出）
  if (!Array.isArray(DB.units)) DB.units = [];
  if (DB.settings && DB.settings.unitBuildCity === undefined) {
    // 建管/实施单位留空，由用户在「全局设置 - 单位维护」自行填写
    DB.settings.unitBuildCity = '';
    DB.settings.unitBuildCounty = '';
    DB.settings.unitExecCity = '';
    DB.settings.unitExecCounty = '';
  }
  // 文档中心文件：不再强制注入「危险点.xlsx / 现场勘察记录模板.docx」等系统文件。
  // 全新实例文档中心为空，所有文件由用户自行上传；仅保留既有记录。
  if (DB.documents) {
    if (!Array.isArray(DB.documents.hazardLibrary)) DB.documents.hazardLibrary = [];
    // 兼容老字段：保留 hazardSeedCleared 标记，但不再用于「清空库」
    if (DB.documents.hazardSeedCleared === undefined) DB.documents.hazardSeedCleared = false;
    if (!Array.isArray(DB.documents.files)) DB.documents.files = [];
    DB.documents.files = DB.documents.files.filter(f => f && typeof f.path === 'string' && f.path);
    // 历史 surveyTemplate 若指向的文件已不存在，则清理引用（不再自动重建）
    if (DB.documents.surveyTemplate && DB.documents.surveyTemplate.path && !fs.existsSync(path.join(__dirname, DB.documents.surveyTemplate.path))) {
      delete DB.documents.surveyTemplate;
    }
  }
  // 项目列表 V2：按原系统截图重建模型（自有工程/客户工程，年度计划/批次/作业类型/作业专业/省专业管理部门/
  // 属地供电所/班组长/子项目/开工日期/预期竣工日期/局计划进度），旧演示模型（voltage/manager）一次性迁移
  if (DB.projects && !DB.projectsV2) {
    DB.projects = [{
      id: 'p1', category: '自有工程', annualPlan: '2026年度农网改造计划', batch: '',
      name: '大桥镇鹿山村10千伏及以下改造工程', workType: '配农网工程', specialty: '运检', provincialDept: '设备部',
      substation: '大桥镇供电所', leader: '', startDate: '', endDate: '2027-10-08',
      subProjects: [],
      progress: { pole: { done: 2, total: 420 }, cable: { done: 2, total: 380 }, device: { done: 0, total: 150 } },
      completed: false, createdAt: nowISO()
    }];
    DB.projectsV2 = true;
  }
  // 注意：不再自动补播「施工一队」等示例班组，全部由用户自行维护
  // 材料明细 V2：补充来源说明/周计划口径等字段；项目名称与项目列表强制联动（不一致的旧数据重挂到首个工程）
  if (Array.isArray(DB.materials) && !DB.materialsV2) {
    const names = [];
    (DB.projects || []).forEach(p => { if (p.name) names.push(p.name); (p.subProjects || []).forEach(s => s.name && names.push(s.name)); });
    DB.materials = DB.materials.map(m => ({
      ...m,
      sourceNote: m.sourceNote || '',
      inWeeklyPlan: m.inWeeklyPlan !== false,
      modifyReason: m.modifyReason || '',
      modifiedAt: m.modifiedAt || '',
      orderNo: m.orderNo || '-',
      project: names.includes(m.project) ? m.project : (names[0] || m.project)
    }));
    DB.materialsV2 = true;
  }
  // 领料单 V2：旧占位数据（rq1/rq2 简单模型）不符合新模型（reqNo + items 明细），一次性清空
  if (!DB.requisitionsV2) {
    DB.materialRequisitions = [];
    DB.requisitionsV2 = true;
  }
  // 幂等修复：待入库领料单 → 关联材料状态锁定「已生成领料单」（回填存量数据）
  if (Array.isArray(DB.materialRequisitions) && Array.isArray(DB.materials)) {
    DB.materialRequisitions.forEach(rec => {
      // 存量「已入库」但存在异常（未全数入库）的领料单 → 状态修正为「部分到库」，支持补入库
      if (rec.status === '已入库' && Array.isArray(rec.confirmRows) && rec.confirmRows.some(c => c.abnormal)) {
        rec.status = '部分到库';
      }
      // 存量单无 history（入库历史）→ 按 confirmRows 合成一条历史记录，保证详情/Excel 均有入库记录
      if (!Array.isArray(rec.history) && Array.isArray(rec.confirmRows) && rec.confirmRows.length) {
        rec.history = [{ at: rec.confirmedAt || rec.createdAt || '', rows: rec.confirmRows.map(c => ({ materialId: c.materialId, thisQty: c.thisQty, abnormal: !!c.abnormal, reason: c.reason || '' })) }];
      }
      if (rec.status !== '待入库') return;
      (rec.items || []).forEach(it => {
        const m = DB.materials.find(x => x.id === it.materialId);
        if (m && m.requisitionId !== rec.id) { m.requisitionId = rec.id; m.status = materialStatus(m); }
      });
    });
    // 存量材料状态按最新规则自愈（到货情况优先于「已生成领料单」）
    DB.materials.forEach(m => { const s = materialStatus(m, SPACE_DEFAULT); if (m.status !== s) m.status = s; });
  }
  // ---------- 母账号 + 团队子空间 迁移 ----------
  // 0) 级联删除补漏：所属项目已被逻辑删除的材料 → 一并逻辑删除（防止删项目前的存量数据残留）
  if (Array.isArray(DB.materials) && Array.isArray(DB.projects)) {
    const deadProjectNames = new Set(DB.projects.filter(p => p.deleted).map(p => p.name));
    DB.materials.forEach(m => { if (!m.deleted && m.project && deadProjectNames.has(m.project)) m.deleted = true; });
  }
  // 1) 保证集合存在：母账号自有空间 spaces / 团队 bizTeams / 归属 teamMembers / 审计 auditLogs
  if (!Array.isArray(DB.spaces)) DB.spaces = [];
  if (!DB.spaces.some(s => s.id === SPACE_DEFAULT)) DB.spaces.push({ id: SPACE_DEFAULT, ownerUsername: 'admin', role: '超级用户', createdAt: nowISO(), status: 'active' });
  if (!Array.isArray(DB.bizTeams)) DB.bizTeams = [];
  if (!Array.isArray(DB.teamMembers)) DB.teamMembers = [];
  if (!Array.isArray(DB.auditLogs)) DB.auditLogs = [];
  // 2) 旧「每账号独立空间 sp_<username>」升级为团队：每个历史独立空间 → 团队 tm_<username>，账号任该团队管理员，业务记录 spaceId 迁移过去
  if (Array.isArray(DB.users)) {
    DB.users.forEach(u => {
      if (u.role === ROLE_PARENT) { u.spaceId = SPACE_DEFAULT; return; }
      const oldSid = u.spaceId;
      if (!oldSid || oldSid === SPACE_DEFAULT) return; // 无历史独立空间：保持无团队，后续由母账号分配
      const teamId = 'tm_' + u.username;
      if (!DB.bizTeams.some(t => t.id === teamId)) {
        DB.bizTeams.push({ id: teamId, name: (u.name || u.username) + '的团队', status: 'active', createdBy: 'admin', createdAt: nowISO() });
      }
      if (!DB.teamMembers.some(m => m.teamId === teamId && m.username === u.username)) {
        DB.teamMembers.push({ id: genId('tmb'), teamId, username: u.username, role: ROLE_TEAM_ADMIN, permissions: TEAM_PERMS.slice(), joinedAt: nowISO() });
      }
      BIZ_COLLECTIONS.forEach(k => { if (Array.isArray(DB[k])) DB[k].forEach(r => { if (r.spaceId === oldSid) r.spaceId = teamId; }); });
      if (DB.documents && Array.isArray(DB.documents.files)) DB.documents.files.forEach(f => { if (f.spaceId === oldSid) f.spaceId = teamId; });
      u.spaceId = teamId; // 兼容字段：主团队
    });
  }
  // 用户模型对齐原版截图字段：补 loginName/email/userGroup；role 归一为「用户组」（超级用户/普通用户），团队角色另存 teamMembers
  if (Array.isArray(DB.users)) {
    DB.users.forEach(u => {
      if (!u.loginName) u.loginName = u.username;
      if (u.email === undefined) u.email = '';
      const isP = u.role === ROLE_PARENT || u.username === 'admin';
      u.role = isP ? '超级用户' : '普通用户';
      if (!u.userGroup) u.userGroup = u.role;
    });
  }
  // 3) 存量业务记录补 spaceId（旧库无空间字段 → 归母账号自有空间，即演示数据）
  BIZ_COLLECTIONS.forEach(k => {
    if (!Array.isArray(DB[k])) return;
    DB[k].forEach(r => { if (!r.spaceId) { r.spaceId = SPACE_DEFAULT; r.deleted = false; } });
  });
  // 4) 材料明细存量自愈（按母账号自有空间口径）
  if (Array.isArray(DB.materials)) DB.materials.forEach(m => { if (m.spaceId === SPACE_DEFAULT) m.status = materialStatus(m, SPACE_DEFAULT); });
  // 5) 文档中心用户上传文件归属（fixed 系统文件保持全局、无 spaceId）
  if (DB.documents && Array.isArray(DB.documents.files)) {
    DB.documents.files.forEach(f => { if (!f.fixed && !f.spaceId) { f.spaceId = SPACE_DEFAULT; f.deleted = false; } });
  }
  saveDB();
}
migrateDB();

// 企业危险点库首次为空时，自动从「规范文件 危险点.xlsx」灌入，使其与文档中心的规范文件关联
// 风险大类（与作业计划「风险因素」下拉的 9 个分类一一对应）；按关键词把规范文件明细归入对应大类
const RISK_CATEGORIES = ['有限空间', '机械伤害', '起重伤害', '触电', '高处坠落', '倒塔/坍塌', '跨越风险', '物体打击', '动火作业'];
const RISK_CATEGORY_RULES = [
  ['有限空间', ['有限空间']],
  ['高处坠落', ['坠落', '登杆']],
  ['倒塔/坍塌', ['倒杆', '边坡', '坑洞', '保杆', '保线', '断线', '紧线']],
  ['物体打击', ['物体打击', '交叉作业', '外来人员']],
  ['起重伤害', ['吊车', '吊装', '竖杆']],
  ['机械伤害', ['机械', '绞磨', '电镐', '挖吊', '工器具']],
  ['触电', ['带电', '开关柜', '电缆', '接头', '双电源', '触电', '旧线', '发电机', '同杆']],
  ['跨越风险', ['跨越', '邻近']],
  ['动火作业', []]
];
function categorize(hazard) {
  const h = String(hazard || '');
  for (const [cat, keys] of RISK_CATEGORY_RULES) {
    if (keys.some(k => h.includes(k))) return cat;
  }
  return '';
}

function seedHazardLibraryFromNorm() {
  try {
    const f = path.join(__dirname, 'assets', '危险点.xlsx');
    if (!fs.existsSync(f)) return;
    const wb = xlsx.readFile(f);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false }).slice(1);
    const existing = new Set(DB.documents.hazardLibrary.map(h => h.hazard + '||' + h.measure));
    let maxSort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1);
    let n = 0;
    for (const r of rows) {
      const hazard = String(r[0] || '').trim();
      const measure = String(r[2] || '').trim();
      if (!hazard || !measure) continue;
      const key = hazard + '||' + measure;
      if (existing.has(key)) continue;
      existing.add(key);
      DB.documents.hazardLibrary.push({ id: genId('h'), hazard, measure, category: categorize(hazard), sort: ++maxSort });
      n++;
    }
    if (n) console.log(`  ➜  已从规范文件灌入企业危险点库 ${n} 条`);
  } catch (e) { console.error('  ⚠ 危险点库从规范文件灌入失败：', e.message); }
}
if (DB.documents && DB.documents.hazardLibrary) {
  // 危险点库不再自动从「assets/危险点.xlsx」灌入：全新实例保持为空，由用户手动录入或 Excel 导入
  // 仅补填老数据缺失的 category 字段
  let patched = false;
  DB.documents.hazardLibrary.forEach(h => {
    if (h.category === undefined) { h.category = categorize(h.hazard || ''); patched = true; }
  });
  if (patched) saveDB();
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), 'utf8');
}

// ---------- 工具 ----------
function genId(prefix) {
  return prefix + Math.random().toString(36).slice(2, 9);
}
function nowISO() { return new Date().toISOString(); }

// ---------- 零依赖 docx 文本提取（最小 ZIP 解压 + 解析 word/document.xml） ----------
function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function unzipEntry(buf, entryName) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16); // 中央目录偏移
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === entryName) {
      const lNameLen = buf.readUInt16LE(localOffset + 26);
      const lExtraLen = buf.readUInt16LE(localOffset + 28);
      const compSize = buf.readUInt32LE(localOffset + 18);
      const method = buf.readUInt16LE(localOffset + 8);
      const dataStart = localOffset + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      if (method === 0) return raw;
      if (method === 8) return zlib.inflateRawSync(raw);
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
function extractDocxText(buf) {
  const xml = unzipEntry(buf, 'word/document.xml');
  if (!xml) return [];
  const text = xml.toString('utf8');
  const lines = [];
  for (const para of text.split(/<\/w:p>/)) {
    const parts = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => decodeXmlEntities(m[1]));
    const line = parts.join('').replace(/\s+$/, '');
    if (line.trim()) lines.push(line.trim());
  }
  return lines;
}

// ---------- 认证 ----------
const app = express();
app.use(express.json());
const TOKENS = DB.tokens || (DB.tokens = {});

// 业务数据路径前缀：母账号审计查看团队时，仅禁止写这些业务接口（管理/字典/设置类不受限）
const BIZ_PATH_PREFIX = ['/api/projects', '/api/materials', '/api/materialRequisitions', '/api/requisitions', '/api/materialOutbound', '/api/materialImports', '/api/plans', '/api/workPlans', '/api/borrowWorks', '/api/completionDocuments', '/api/workers', '/api/contacts', '/api/documents'];
// app.use('/api') 挂载后 req.path 已去掉 /api 前缀，故一律用原始完整路径判断
function fullPath(req) { return (req.originalUrl || req.path || '').split('?')[0]; }
function isBizWrite(req) { const p = fullPath(req); return req.method !== 'GET' && BIZ_PATH_PREFIX.some(x => p === x || p.startsWith(x + '/')); }

function authMiddleware(req, res, next) {
  { const fp = fullPath(req); if (fp === '/api/login' || fp === '/api/health') return next(); }
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  const username = TOKENS[token];
  if (!token || !username) return res.status(401).json({ error: '未登录或登录失效' });
  const user = DB.users.find(u => u.username === username);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if ((user.status || 'active') === 'disabled') return res.status(403).json({ error: '账号已停用' });
  req.user = user;
  req.token = token;
  // ---- 解析当前隔离空间上下文 ----
  if (user.role === ROLE_PARENT) {
    // 母账号：默认自有空间；可切换到某团队做审计查看（只读）
    const t = ACTIVE_TEAM[token];
    if (t && DB.bizTeams.some(x => x.id === t)) { req.spaceId = t; req.parentViewingTeam = true; }
    else { if (t) delete ACTIVE_TEAM[token]; req.spaceId = SPACE_DEFAULT; req.parentViewingTeam = false; }
  } else {
    // 团队成员/管理员：当前团队（缺失回退首个归属团队），校验归属与团队状态
    let t = ACTIVE_TEAM[token];
    if (!t || !membershipOf(user.username, t)) {
      const first = teamsOfUser(user.username)[0];
      if (first) { ACTIVE_TEAM[token] = first; t = first; } else { delete ACTIVE_TEAM[token]; t = null; }
    }
    const team = t ? DB.bizTeams.find(x => x.id === t) : null;
    const membership = t ? membershipOf(user.username, t) : null;
    if (!team || team.status === 'disabled' || !membership) {
      return res.status(403).json({ error: teamsOfUser(user.username).length ? '无权访问该团队或团队已停用' : '您尚未加入任何团队，请联系母账号分配' });
    }
    req.spaceId = t; req.teamMember = membership; req.parentViewingTeam = false;
  }
  // 母账号审计查看团队时，禁止修改业务数据（仅只读）；管理/字典/设置类接口豁免
  if (req.parentViewingTeam && isBizWrite(req)) {
    return res.status(403).json({ error: '母账号对团队空间仅审计查看，不可修改业务数据' });
  }
  next();
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const id = String(username || '').trim();
  // 支持登录名或邮箱登录
  const user = DB.users.find(u => (u.username === id || u.email === id) && u.password === password);
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });
  const token = crypto.randomBytes(24).toString('hex');
  TOKENS[token] = user.username;
  // 初始化当前团队上下文：母账号=自有空间；成员=首个归属团队
  if (user.role === ROLE_PARENT) delete ACTIVE_TEAM[token];
  else { const first = teamsOfUser(user.username)[0]; if (first) ACTIVE_TEAM[token] = first; else delete ACTIVE_TEAM[token]; }
  saveDB();
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, username: user.username } });
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: DB.settings.systemName }));

// ---------- 登录页公开配置（无需登录：登录页需在鉴权前取背景图 / 系统名） ----------
app.get('/api/public-config', (req, res) => {
  res.json({
    systemName: DB.settings.systemName || '',
    companyName: DB.settings.companyName || '',
    loginBg: DB.settings.loginBg || '/login-bg/ink-color.jpg'
  });
});
// 本地上传的登录页背景（无需登录；仅允许读取 data/uploads/login-bg 目录，防目录穿越）
app.get('/api/login-bg/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name) return res.status(400).json({ error: '参数错误' });
  const file = path.join(__dirname, 'data', 'uploads', 'login-bg', name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '背景不存在' });
  res.sendFile(file);
});

app.use('/api', authMiddleware);

// 切换当前团队（会话级）：母账号可进入任意团队做审计查看；成员仅能切到已加入且未停用的团队
app.post('/api/active-team', (req, res) => {
  const teamId = String((req.body || {}).teamId || '').trim();
  const u = req.user;
  if (!teamId) { delete ACTIVE_TEAM[req.token]; saveDB(); return res.json({ ok: true, activeTeamId: null }); }
  const team = DB.bizTeams.find(x => x.id === teamId);
  if (!team) return res.status(404).json({ error: '团队不存在' });
  if (u.role !== ROLE_PARENT) {
    if (!membershipOf(u.username, teamId)) return res.status(403).json({ error: '您不属于该团队' });
    if (team.status === 'disabled') return res.status(403).json({ error: '团队已停用' });
  }
  ACTIVE_TEAM[req.token] = teamId;
  saveDB();
  res.json({ ok: true, activeTeamId: teamId });
});

app.get('/api/me', (req, res) => {
  const u = req.user;
  const isParent = u.role === ROLE_PARENT;
  const teams = isParent
    ? DB.bizTeams.filter(t => t.status !== 'deleted').map(t => ({ teamId: t.id, name: t.name, role: ROLE_TEAM_ADMIN, permissions: TEAM_PERMS.slice() }))
    : DB.teamMembers.filter(m => m.username === u.username)
        .map(m => { const t = DB.bizTeams.find(x => x.id === m.teamId); return t && t.status !== 'deleted' ? { teamId: t.id, name: t.name, role: m.role, permissions: m.permissions || [] } : null; })
        .filter(Boolean);
  const displayRole = isParent ? '母账号' : (req.teamMember ? req.teamMember.role : (u.userGroup || u.role || '普通用户'));
  res.json({
    user: {
      id: u.id, name: u.name, role: displayRole, rawRole: u.role, username: u.username,
      spaceId: req.spaceId, isAdmin: isParent, isParent, parentViewingTeam: !!req.parentViewingTeam
    },
    teams,
    activeTeamId: req.spaceId,
    isTeamAdmin: !isParent && DB.teamMembers.some(m => m.username === u.username && m.role === ROLE_TEAM_ADMIN),
    activePermissions: isParent ? TEAM_PERMS.slice() : (req.teamMember ? (req.teamMember.permissions || []) : []),
    tenant: DB.tenant, settings: DB.settings
  });
});

// ---------- 账号 + 团队（母账号 + 团队子空间） ----------
// 团队统计：成员数 / 管理员 / 业务记录数 / 文件数
function teamStats(teamId) {
  const members = (DB.teamMembers || []).filter(m => m.teamId === teamId);
  const recordCount = BIZ_COLLECTIONS.reduce((n, c) => n + (DB[c] || []).filter(r => r.spaceId === teamId && !r.deleted).length, 0);
  const fileCount = (DB.documents.files || []).filter(f => f.spaceId === teamId && !f.deleted).length;
  const admins = members.filter(m => m.role === ROLE_TEAM_ADMIN).map(m => {
    const u = DB.users.find(x => x.username === m.username);
    return { username: m.username, name: u ? u.name : m.username };
  });
  return { memberCount: members.length, admins, recordCount, fileCount };
}
// 物理清空某空间（团队）：移除全部业务记录 + 删除磁盘附件；返回 { records, files }
function physicallyClearSpace(spaceId) {
  const files = purgeSpaceFiles(spaceId); // 先按记录删磁盘附件（文档 + 项目文件 + 空目录）
  let records = 0;
  BIZ_COLLECTIONS.forEach(c => {
    if (!Array.isArray(DB[c])) return;
    const before = DB[c].length;
    DB[c] = DB[c].filter(r => r.spaceId !== spaceId);
    records += before - DB[c].length;
  });
  if (DB.documents && Array.isArray(DB.documents.files)) {
    const before = DB.documents.files.length;
    DB.documents.files = DB.documents.files.filter(f => f.spaceId !== spaceId);
    records += before - DB.documents.files.length;
  }
  return { records, files };
}
// 母账号可见全部账号；团队管理员可见其管理团队成员 + 自己；普通成员仅自己
function visibleUsers(req) {
  if (isAdmin(req)) return DB.users.slice();
  const u = req.user;
  const adminTeamIds = (DB.teamMembers || []).filter(m => m.username === u.username && m.role === ROLE_TEAM_ADMIN).map(m => m.teamId);
  if (adminTeamIds.length) {
    const names = new Set([u.username]);
    (DB.teamMembers || []).filter(m => adminTeamIds.includes(m.teamId)).forEach(m => names.add(m.username));
    return DB.users.filter(x => names.has(x.username));
  }
  return DB.users.filter(x => x.username === u.username);
}
function userTeamBadges(username) {
  return (DB.teamMembers || []).filter(m => m.username === username).map(m => {
    const t = DB.bizTeams.find(x => x.id === m.teamId);
    return { teamId: m.teamId, teamName: t ? t.name : m.teamId, role: m.role };
  });
}

app.get('/api/users', (req, res) => {
  res.json(visibleUsers(req).map(u => ({
    id: u.id, username: u.username, loginName: u.loginName || u.username, email: u.email || '',
    name: u.name, role: u.role, userGroup: u.userGroup || (u.role === ROLE_PARENT ? '超级用户' : '普通用户'), phone: u.phone || '',
    createdAt: u.createdAt, status: (u.status || 'active') === 'disabled' ? '停用' : '启用',
    isSelf: u.username === req.user.username, teams: userTeamBadges(u.username)
  })));
});

app.post('/api/users', (req, res) => {
  const b = req.body || {};
  const isParent = isAdmin(req);
  let adminTeamId = null;
  if (!isParent) {
    adminTeamId = req.spaceId;
    if (!isTeamAdminOf(req.user.username, adminTeamId)) return res.status(403).json({ error: '仅母账号或团队管理员可新增账号' });
  }
  const loginName = String(b.loginName || b.username || '').trim();
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim();
  const password = String(b.password || '').trim();
  const userGroup = b.userGroup === '超级用户' ? '超级用户' : '普通用户';
  if (!loginName) return res.status(400).json({ error: '请填写登录名' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!password) return res.status(400).json({ error: '请填写密码' });
  if (password.length < 8 || password.length > 32) return res.status(400).json({ error: '密码需为 8-32 位' });
  if (DB.users.some(u => u.username === loginName)) return res.status(400).json({ error: '该登录名已存在' });
  if (DB.users.some(u => u.email === email)) return res.status(400).json({ error: '该邮箱已被使用' });
  if (!isParent && userGroup === '超级用户') return res.status(403).json({ error: '仅母账号可创建超级用户' });
  const user = {
    id: genId('u'), username: loginName, loginName, email, name,
    phone: String(b.phone || ''), password, role: userGroup, userGroup,
    createdAt: nowISO(), status: 'active', spaceId: null
  };
  DB.users.push(user);
  // 可选归属团队（登录账号列表默认不填；团队分配在「团队管理」完成）
  let teamId = isParent ? String(b.teamId || '').trim() : (String(b.teamId || '').trim() || adminTeamId);
  if (teamId && !DB.bizTeams.some(t => t.id === teamId)) teamId = '';
  if (teamId && !isParent && !isTeamAdminOf(req.user.username, teamId)) teamId = '';
  if (teamId && !DB.teamMembers.some(m => m.teamId === teamId && m.username === loginName)) {
    const teamRole = (isParent && b.teamRole === ROLE_TEAM_ADMIN) ? ROLE_TEAM_ADMIN : '团队成员';
    const perms = Array.isArray(b.permissions) && b.permissions.length ? b.permissions.filter(p => TEAM_PERMS.includes(p))
      : (teamRole === ROLE_TEAM_ADMIN ? TEAM_PERMS.slice() : ['查看', '录入']);
    DB.teamMembers.push({ id: genId('tmb'), teamId, username: loginName, role: teamRole, permissions: perms, joinedAt: nowISO() });
    user.spaceId = teamId;
  }
  saveDB();
  res.json({ id: user.id, username: loginName, loginName, email, name, phone: user.phone, role: user.role, userGroup, status: 'active', teams: userTeamBadges(loginName) });
});

app.put('/api/users/:id', (req, res) => {
  const u = DB.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '未找到用户' });
  const b = req.body || {};
  const isParent = isAdmin(req);
  if (u.role === ROLE_PARENT && !isParent) return res.status(403).json({ error: '无权修改母账号' });
  if (!isParent) {
    const adminTeamIds = (DB.teamMembers || []).filter(m => m.username === req.user.username && m.role === ROLE_TEAM_ADMIN).map(m => m.teamId);
    const targetTeams = (DB.teamMembers || []).filter(m => m.username === u.username).map(m => m.teamId);
    if (!targetTeams.some(t => adminTeamIds.includes(t))) return res.status(403).json({ error: '仅可编辑本团队成员' });
  }
  if (b.name !== undefined) u.name = String(b.name);
  if (b.phone !== undefined) u.phone = String(b.phone || '');
  if (b.email !== undefined) u.email = String(b.email || '').trim();
  if (b.password) u.password = String(b.password);
  if (b.status && (isParent || u.username !== req.user.username)) u.status = b.status === 'disabled' ? 'disabled' : 'active';
  if (isParent && b.userGroup && u.username !== 'admin') { u.userGroup = b.userGroup === '超级用户' ? '超级用户' : '普通用户'; u.role = u.userGroup; }
  saveDB();
  res.json({ id: u.id, username: u.username, loginName: u.loginName || u.username, email: u.email || '', name: u.name, role: u.role, userGroup: u.userGroup, phone: u.phone, status: u.status, teams: userTeamBadges(u.username) });
});

app.delete('/api/users/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅母账号可删除账号' });
  const idx = DB.users.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到用户' });
  if (DB.users[idx].username === 'admin') return res.status(400).json({ error: '内置母账号不可删除' });
  const username = DB.users[idx].username;
  DB.users.splice(idx, 1);
  DB.teamMembers = (DB.teamMembers || []).filter(m => m.username !== username); // 移除其全部团队归属（业务数据归团队，不随账号删除）
  saveDB();
  res.json({ ok: true });
});

// ---------- 团队（独立业务空间）：增删改 / 一键清空 / 成员管理（重置权仅母账号） ----------
app.get('/api/biz-teams', (req, res) => {
  let arr;
  if (isAdmin(req)) arr = DB.bizTeams.filter(t => t.status !== 'deleted');
  else {
    const ids = teamsOfUser(req.user.username);
    arr = DB.bizTeams.filter(t => ids.includes(t.id) && t.status !== 'deleted');
  }
  res.json(arr.map(t => ({ ...t, ...teamStats(t.id) })));
});

app.post('/api/biz-teams', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅母账号可创建团队' });
  const name = String((req.body || {}).name || '').trim();
  if (!name) return res.status(400).json({ error: '团队名称不能为空' });
  const team = { id: genId('tm'), name, status: 'active', createdBy: req.user.username, createdAt: nowISO(), lastResetAt: '' };
  DB.bizTeams.push(team);
  // 可选：初始管理员（账号需已存在）
  (Array.isArray(req.body.admins) ? req.body.admins : []).forEach(username => {
    const un = String(username || '').trim();
    if (!un || !DB.users.some(u => u.username === un)) return;
    if (DB.teamMembers.some(m => m.teamId === team.id && m.username === un)) return;
    DB.teamMembers.push({ id: genId('tmb'), teamId: team.id, username: un, role: ROLE_TEAM_ADMIN, permissions: TEAM_PERMS.slice(), joinedAt: nowISO() });
    const usr = DB.users.find(u => u.username === un); if (usr && !usr.spaceId) usr.spaceId = team.id;
  });
  saveDB();
  res.json({ ...team, ...teamStats(team.id) });
});

app.put('/api/biz-teams/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅母账号可编辑团队' });
  const team = DB.bizTeams.find(t => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: '未找到团队' });
  const b = req.body || {};
  if (b.name) team.name = String(b.name).trim();
  if (b.status === 'disabled' || b.status === 'active') team.status = b.status;
  saveDB();
  res.json({ ...team, ...teamStats(team.id) });
});

app.delete('/api/biz-teams/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅母账号可解散团队' });
  const team = DB.bizTeams.find(t => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: '未找到团队' });
  const { records, files } = physicallyClearSpace(team.id); // 物理删除该团队全部业务数据 + 附件
  DB.bizTeams = DB.bizTeams.filter(t => t.id !== team.id);
  DB.teamMembers = (DB.teamMembers || []).filter(m => m.teamId !== team.id);
  DB.auditLogs.unshift({ id: genId('al'), at: fmtNow(), actor: req.user.name, actorUsername: req.user.username, action: '解散团队', targetSpace: team.id, targetOwner: team.name, reason: '解散团队并清空数据', deletedCount: records, fileCount: files });
  saveDB();
  res.json({ ok: true, deletedCount: records, fileCount: files });
});

app.post('/api/biz-teams/:id/reset', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅母账号可一键清空团队空间' });
  const team = DB.bizTeams.find(t => t.id === req.params.id);
  if (!team) return res.status(404).json({ error: '未找到团队' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写清空原因' });
  // 物理删除业务数据 + 附件；保留团队本身、成员关系、全局字典模板、系统日志
  const { records, files } = physicallyClearSpace(team.id);
  team.lastResetAt = nowISO();
  DB.auditLogs.unshift({ id: genId('al'), at: fmtNow(), actor: req.user.name, actorUsername: req.user.username, action: '一键清空团队空间', targetSpace: team.id, targetOwner: team.name, reason, deletedCount: records, fileCount: files });
  saveDB();
  res.json({ ok: true, teamId: team.id, deletedCount: records, fileCount: files });
});

app.get('/api/biz-teams/:id/members', (req, res) => {
  const teamId = req.params.id;
  const team = DB.bizTeams.find(t => t.id === teamId);
  if (!team) return res.status(404).json({ error: '未找到团队' });
  if (!isAdmin(req) && !membershipOf(req.user.username, teamId)) return res.status(403).json({ error: '无权查看该团队成员' });
  const members = (DB.teamMembers || []).filter(m => m.teamId === teamId).map(m => {
    const u = DB.users.find(x => x.username === m.username);
    return { id: m.id, username: m.username, name: u ? u.name : m.username, role: m.role, permissions: m.permissions || [], joinedAt: m.joinedAt, accountStatus: u ? ((u.status || 'active') === 'disabled' ? '停用' : '启用') : '已删除' };
  });
  res.json(members);
});

app.post('/api/biz-teams/:id/members', (req, res) => {
  const teamId = req.params.id;
  const team = DB.bizTeams.find(t => t.id === teamId);
  if (!team) return res.status(404).json({ error: '未找到团队' });
  const isParent = isAdmin(req);
  if (!isParent && !isTeamAdminOf(req.user.username, teamId)) return res.status(403).json({ error: '仅母账号或该团队管理员可添加成员' });
  const username = String((req.body || {}).username || '').trim();
  if (!DB.users.some(u => u.username === username)) return res.status(400).json({ error: '账号不存在' });
  if (DB.teamMembers.some(m => m.teamId === teamId && m.username === username)) return res.status(400).json({ error: '该账号已在团队中' });
  const role = (isParent && req.body.role === ROLE_TEAM_ADMIN) ? ROLE_TEAM_ADMIN : '团队成员'; // 团队管理员只能加普通成员
  const perms = Array.isArray(req.body.permissions) && req.body.permissions.length ? req.body.permissions.filter(p => TEAM_PERMS.includes(p))
    : (role === ROLE_TEAM_ADMIN ? TEAM_PERMS.slice() : ['查看', '录入']);
  const rec = { id: genId('tmb'), teamId, username, role, permissions: perms, joinedAt: nowISO() };
  DB.teamMembers.push(rec);
  const usr = DB.users.find(u => u.username === username); if (usr && !usr.spaceId) usr.spaceId = teamId;
  saveDB();
  res.json(rec);
});

app.put('/api/team-members/:id', (req, res) => {
  const m = (DB.teamMembers || []).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '未找到成员' });
  const isParent = isAdmin(req);
  if (!isParent && !isTeamAdminOf(req.user.username, m.teamId)) return res.status(403).json({ error: '仅母账号或该团队管理员可修改成员' });
  const b = req.body || {};
  // 团队管理员角色仅母账号可任命/改动（团队管理员无权重塑管理员）
  if (!isParent && (b.role === ROLE_TEAM_ADMIN || m.role === ROLE_TEAM_ADMIN)) return res.status(403).json({ error: '团队管理员角色仅母账号可设置' });
  if (isParent && b.role) m.role = b.role === ROLE_TEAM_ADMIN ? ROLE_TEAM_ADMIN : '团队成员';
  if (Array.isArray(b.permissions)) m.permissions = b.permissions.filter(p => TEAM_PERMS.includes(p));
  saveDB();
  res.json(m);
});

app.delete('/api/team-members/:id', (req, res) => {
  const m = (DB.teamMembers || []).find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: '未找到成员' });
  const isParent = isAdmin(req);
  if (!isParent && !isTeamAdminOf(req.user.username, m.teamId)) return res.status(403).json({ error: '仅母账号或该团队管理员可移除成员' });
  if (!isParent && m.role === ROLE_TEAM_ADMIN) return res.status(403).json({ error: '不能移除团队管理员' });
  DB.teamMembers = DB.teamMembers.filter(x => x.id !== req.params.id);
  saveDB();
  res.json({ ok: true });
});

// 审计日志（仅母账号）
app.get('/api/audit-logs', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅母账号可查看审计日志' });
  const logs = (DB.auditLogs || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  res.json(logs);
});

// ---------- 通用 CRUD 工厂 ----------
// opts.space：true=业务集合，写入时注入 spaceId、列表/读取按 spaceId 隔离；false=全局集合（字典/设置等）
// opts.soft：true=删除走逻辑删除（置 deleted）；false=物理删除（默认对全局字典）
function crud(collection, prefix, opts) {
  opts = opts || {};
  const space = opts.space !== false;
  const soft = opts.soft !== false ? true : false;
  const base = '/api/' + prefix;
  app.get(base, (req, res) => {
    const data = space ? DB[collection].filter(spaceFilter(req)) : DB[collection];
    res.json(data);
  });
  app.get(base + '/:id', (req, res) => {
    const item = DB[collection].find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: '未找到' });
    if (space && (item.deleted || item.spaceId !== reqSpaceId(req))) return res.status(404).json({ error: '未找到' });
    res.json(item);
  });
  app.post(base, (req, res) => {
    const item = { id: genId(prefix.slice(0, 2)), createdAt: nowISO(), ...req.body };
    if (space) { item.spaceId = reqSpaceId(req); item.deleted = false; }
    DB[collection].push(item);
    saveDB();
    res.json(item);
  });
  app.put(base + '/:id', (req, res) => {
    const idx = DB[collection].findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    const cur = DB[collection][idx];
    if (space && (cur.deleted || cur.spaceId !== reqSpaceId(req))) return res.status(404).json({ error: '未找到' });
    const merged = { ...cur, ...req.body, id: req.params.id };
    if (space) { merged.spaceId = cur.spaceId; merged.deleted = cur.deleted; }
    DB[collection][idx] = merged;
    saveDB();
    res.json(merged);
  });
  app.delete(base + '/:id', (req, res) => {
    const idx = DB[collection].findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    const cur = DB[collection][idx];
    if (space && (cur.deleted || cur.spaceId !== reqSpaceId(req))) return res.status(404).json({ error: '未找到' });
    if (soft) { cur.deleted = true; } else { DB[collection].splice(idx, 1); }
    saveDB();
    res.json({ ok: true });
  });
}

// ---------- 作业人员：导入/导出（需在通用 CRUD 之前注册，避免被 GET /:id 拦截） ----------
// 模板列（按位置）：0 姓名 / 1 身份证号 / 2 电话号码 / 3 身份 / 4 班组 / 5 证件类型 / 6 准入有效期
const WORKER_ID_RE = /^\d{17}[\dXx]$/;
const WORKER_PHONE_RE = /^1\d{10}$/;
const WORKER_IDENTITY_OPTIONS = ['技工（计入高处作业人员）', '民工', '其他技工（不计入高处作业人员）'];
const WORKER_CERT_OPTIONS = ['高压电工', '低压电工', '高处', '电力电缆作业', '电气试验', '司索工', '吊车司机', '挖机操作工'];

function parseCNDate(s) {
  const m = String(s).trim().match(/^(\d{4})[年/.\/-](\d{1,2})[月/.\/-](\d{1,2})日?$/);
  if (!m) return null;
  const d = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return isNaN(new Date(d).getTime()) ? null : d;
}

// 极简 CSV 解析（UTF-8，支持引号转义），避免 SheetJS 把长数字转 number 丢精度、把中文按 Latin-1 解码
function parseCSVBuffer(buf) {
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some(c => c !== '')) rows.push(row); }
  return rows;
}

app.post('/api/workers/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    if (/\.csv$/i.test(req.file.originalname || '')) {
      rows = parseCSVBuffer(req.file.buffer);
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }
    const errors = [];
    const parsed = [];
    rows.forEach((r, i) => {
      if (i === 0) return; // 跳过表头
      const name = String(r[0] || '').trim();
      const idNumber = String(r[1] || '').trim();
      const phone = String(r[2] || '').trim();
      const identity = String(r[3] || '').trim();
      const team = String(r[4] || '').trim();
      const certTypes = String(r[5] || '').trim();
      const validRaw = String(r[6] || '').trim();
      if (!name && !idNumber && !phone && !validRaw) return; // 空行
      if (!name) errors.push(`第${i + 1}行：姓名为空`);
      if (idNumber && !WORKER_ID_RE.test(idNumber)) errors.push(`第${i + 1}行：身份证号格式错误（需18位，末位可为X）`);
      if (phone && !WORKER_PHONE_RE.test(phone)) errors.push(`第${i + 1}行：手机号格式错误（需11位手机号）`);
      if (identity && !WORKER_IDENTITY_OPTIONS.includes(identity)) errors.push(`第${i + 1}行：身份选项无效`);
      let validStart = '', validEnd = '';
      if (validRaw) {
        // 支持「2026-10-09 - 2026-11-18」「2026年10月9日至2026年11月18日」「2026/10/9」等写法
        const parts = validRaw.split(/\s+[-–—~]\s+|\s*至\s*|\s*到\s*/).map(s => s.trim()).filter(Boolean);
        const dates = parts.map(parseCNDate);
        if (dates.length === 1 && dates[0]) { validStart = dates[0]; validEnd = dates[0]; }
        else if (dates.length >= 2 && dates[0] && dates[1]) {
          if (dates[1] < dates[0]) errors.push(`第${i + 1}行：准入有效期结束日期不得早于开始日期`);
          validStart = dates[0]; validEnd = dates[1];
        }
        else errors.push(`第${i + 1}行：准入有效期格式错误`);
      }
      parsed.push({
        name, idNumber, phone, identity, team,
        certTypes: certTypes ? certTypes.split(/[、,，;；\/\s]+/).filter(Boolean) : [],
        validStart, validEnd
      });
    });
    if (errors.length) {
      return res.status(400).json({ error: `存在格式错误，整批不导入。${errors.slice(0, 5).join('；')}${errors.length > 5 ? `……共${errors.length}处错误` : ''}` });
    }
    const added = parsed.map(p => ({
      id: genId('w'), createdAt: nowISO(),
      name: p.name, idNumber: p.idNumber, phone: p.phone,
      identity: p.identity, team: p.team, certTypes: p.certTypes,
      validStart: p.validStart, validEnd: p.validEnd, status: '已准入',
      spaceId: reqSpaceId(req), deleted: false
    }));
    DB.workers.push(...added);
    saveDB();
    res.json({ ok: true, added: added.length });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

app.get('/api/workers/export', (req, res) => {
  const header = ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'];
  const rows = DB.workers.filter(spaceFilter(req)).map(w => [
    w.name || '', w.idNumber || '', w.phone || '', w.identity || '', w.team || '',
    (w.certTypes || []).join('、'),
    w.validStart ? (w.validStart + (w.validEnd ? ' - ' + w.validEnd : '')) : '',
    w.status || '已准入'
  ]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([header, ...rows]), '作业人员名单');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="workers.xlsx"');
  res.send(buf);
});

// ---------- 项目详情：资料管理（设计图纸/奥维地图/现场照片/规范图纸） ----------
// 需在通用 CRUD 之前注册：DELETE /:id 覆盖工厂版本以清理上传文件
// 项目删除：级联逻辑删除项目下全部关联业务数据（材料/计划/借工/竣工资料/领料单/出库单/资料文件）
// 须注册在通用 CRUD 工厂之前以覆盖默认删除
app.delete('/api/projects/:id', (req, res) => {
  const p = DB.projects.find(x => x.id === req.params.id);
  if (!p || p.deleted) return res.status(404).json({ error: '未找到项目' });
  if (p.spaceId !== reqSpaceId(req)) return res.status(403).json({ error: '无权删除其他空间的项目' });
  p.deleted = true;
  // 按项目名称关联的集合（materials / workPlans / materialOutbound）
  (DB.materials || []).forEach(m => { if (!m.deleted && m.spaceId === p.spaceId && m.project === p.name) m.deleted = true; });
  (DB.workPlans || []).forEach(w => { if (!w.deleted && w.spaceId === p.spaceId && w.project === p.name) w.deleted = true; });
  (DB.materialOutbound || []).forEach(o => { if (!o.deleted && o.spaceId === p.spaceId && o.project === p.name) o.deleted = true; });
  // 按项目 ID 关联的集合（borrowWorks / completionDocuments）
  (DB.borrowWorks || []).forEach(b => { if (!b.deleted && b.spaceId === p.spaceId && b.projectId === p.id) b.deleted = true; });
  (DB.completionDocuments || []).forEach(c => { if (!c.deleted && c.spaceId === p.spaceId && c.projectId === p.id) c.deleted = true; });
  // 领料单可跨项目（projects 为名称数组）：仅移除本项目；清单清空后整单逻辑删除
  (DB.materialRequisitions || []).forEach(r => {
    if (r.deleted || r.spaceId !== p.spaceId || !Array.isArray(r.projects) || !r.projects.includes(p.name)) return;
    r.projects = r.projects.filter(x => x !== p.name);
    if (!r.projects.length) r.deleted = true;
  });
  // 项目资料文件标记逻辑删除（磁盘文件保留）
  (p.files || []).forEach(f => { f.deleted = true; });
  saveDB();
  res.json({ ok: true });
});

const PROJECT_FILE_TYPES = {
  design: { label: '设计图纸', maxMB: 2 },
  map:    { label: '奥维地图', maxMB: 2 },
  photo:  { label: '现场照片', maxMB: 10 },
  spec:   { label: '规范图纸', maxMB: 3 }
};
function findProject(id, req) {
  const p = DB.projects.find(x => x.id === id);
  if (!p || p.deleted) return null;
  if (req && p.spaceId !== reqSpaceId(req)) return null; // 跨空间不可访问
  return p;
}
function projectFileSafeName(name) {
  return String(name).replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_').slice(-120);
}
app.post('/api/projects/:id/files', upload.single('file'), (req, res) => {
  const p = findProject(req.params.id, req);
  if (!p) return res.status(404).json({ error: '未找到项目' });
  const type = req.body.type;
  const conf = PROJECT_FILE_TYPES[type];
  if (!conf) return res.status(400).json({ error: '无效的资料类型' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  if (req.file.size > conf.maxMB * 1024 * 1024) return res.status(400).json({ error: conf.label + '单文件不超过 ' + conf.maxMB + 'MB' });
  const dir = path.join(__dirname, 'data', 'uploads', 'projects', p.id);
  fs.mkdirSync(dir, { recursive: true });
  const diskName = Date.now() + '_' + projectFileSafeName(req.file.originalname);
  fs.writeFileSync(path.join(dir, diskName), req.file.buffer);
  if (!Array.isArray(p.files)) p.files = [];
  const item = { id: genId('pf'), type, name: req.file.originalname, size: req.file.size, path: 'uploads/projects/' + p.id + '/' + diskName, uploadedAt: nowISO() };
  p.files.push(item);
  saveDB();
  res.json(item);
});
app.get('/api/projects/:id/files/:fid/download', (req, res) => {
  const p = findProject(req.params.id, req);
  const f = p && (p.files || []).find(x => x.id === req.params.fid && !x.deleted);
  const fp = f && path.join(__dirname, 'data', f.path);
  if (!f || !fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(f.name) + '"');
  fs.createReadStream(fp).pipe(res);
});
app.delete('/api/projects/:id/files/:fid', (req, res) => {
  const p = findProject(req.params.id, req);
  if (!p) return res.status(404).json({ error: '未找到项目' });
  const f = (p.files || []).find(x => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: '未找到文件' });
  f.deleted = true; // 逻辑删除（保留磁盘文件，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});
// 打包下载：单个文件直接下载，多个文件打包为 ZIP（store 方式，零依赖）
app.get('/api/projects/:id/files/pack', (req, res) => {
  const p = findProject(req.params.id, req);
  const type = req.query.type;
  if (!p || !PROJECT_FILE_TYPES[type]) return res.status(400).json({ error: '无效的资料类型' });
  const list = (p.files || []).filter(f => f.type === type && !f.deleted);
  if (!list.length) return res.status(400).json({ error: '暂无可下载的' + PROJECT_FILE_TYPES[type].label });
  if (list.length === 1) {
    const fp = path.join(__dirname, 'data', list[0].path);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: '文件不存在' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(list[0].name) + '"');
    return fs.createReadStream(fp).pipe(res);
  }
  const entries = list.map(f => {
    const fp = path.join(__dirname, 'data', f.path);
    return { name: f.name, data: fs.existsSync(fp) ? fs.readFileSync(fp) : Buffer.alloc(0) };
  });
  const zip = buildStoreZip(entries);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(p.name + '-' + PROJECT_FILE_TYPES[type].label + '.zip') + '"');
  res.send(zip);
});
// 项目删除走通用 CRUD 工厂（按 spaceId 逻辑删除，见下方 crud 注册）；此处不再单独物理删除
// 竣工：移入已竣工
app.put('/api/projects/:id/complete', (req, res) => {
  const p = findProject(req.params.id, req);
  if (!p) return res.status(404).json({ error: '未找到项目' });
  p.completed = true;
  saveDB();
  res.json(p);
});

// 零依赖 ZIP（store，不压缩）：entries = [{name, data:Buffer}]
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.table[n] = c >>> 0; }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crc32.table[(crc ^ buf[i]) & 0xff];
  return (crc ^ (-1)) >>> 0;
}
function buildStoreZip(entries) {
  const locals = [], central = [];
  let offset = 0;
  entries.forEach(e => {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(e.data.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(e.data.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, nameBuf]));
    offset += 30 + nameBuf.length + e.data.length;
  });
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

// 领料单删除：仅已作废的领料单可删除（须注册在通用 CRUD 工厂之前以覆盖默认删除）
app.delete('/api/materialRequisitions/:id', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '已作废') return res.status(400).json({ error: '仅已作废的领料单可删除，请先作废' });
  rec.deleted = true; // 逻辑删除（保留记录，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});

// ---------- 出库管理（按工程出库 / 归还 / 作废补回） ----------
// 库存口径：可用库存 = 累计入库 − 净出库（净出库 = 有效单累计领取 − 累计归还；作废单自动补回）
function outboundStats(project, spaceId) {
  const stats = {};
  DB.materialOutbound.forEach(o => {
    if (o.deleted || (spaceId && o.spaceId !== spaceId) || o.project !== project || o.status !== '有效') return;
    (o.items || []).forEach(it => {
      if (!it.materialId) return;
      const s = stats[it.materialId] || (stats[it.materialId] = { taken: 0, returned: 0 });
      s.taken = roundQty(s.taken + (Number(it.qty) || 0));
      s.returned = roundQty(s.returned + (Number(it.returned) || 0));
    });
  });
  return stats;
}
app.get('/api/materialOutbound/stock', (req, res) => {
  const project = String(req.query.project || '');
  if (!project) return res.json([]);
  const sid = reqSpaceId(req);
  const stats = outboundStats(project, sid);
  const rows = [];
  DB.materials.filter(spaceFilter(req)).forEach(m => {
    if (m.project !== project) return;
    const inQty = roundQty(m.qtyArrived);
    if (inQty <= 0) return;
    const st = stats[m.id] || { taken: 0, returned: 0 };
    const net = roundQty(st.taken - st.returned);
    const available = roundQty(Math.max(0, inQty - net));
    if (available <= 0) return; // 已全部出库的材料不再出现在可出库列表
    const hasRecords = DB.materialOutbound.some(o => !o.deleted && (!sid || o.spaceId === sid) && o.project === project && (o.items || []).some(it => it.materialId === m.id));
    rows.push({ id: m.id, description: m.description, code: m.code, unit: m.unit, inQty, taken: st.taken, returned: st.returned, net, available, hasRecords });
  });
  res.json(rows);
});
app.get('/api/materialOutbound/orders', (req, res) => {
  const project = String(req.query.project || '');
  const sid = reqSpaceId(req);
  const list = DB.materialOutbound.filter(o => !o.deleted && (!sid || o.spaceId === sid) && (!project || o.project === project))
    .slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  res.json(list);
});
app.post('/api/materialOutbound/create', (req, res) => {
  const b = req.body || {};
  const project = String(b.project || '').trim();
  const receiver = String(b.receiver || '').trim();
  if (!project) return res.status(400).json({ error: '请选择工程' });
  if (!receiver) return res.status(400).json({ error: '请选择领取人' });
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) return res.status(400).json({ error: '请勾选需要出库的材料' });
  const sid = reqSpaceId(req);
  const stats = outboundStats(project, sid);
  const finalItems = [];
  for (const e of items) {
    const m = DB.materials.find(x => x.id === e.materialId && !x.deleted && (!sid || x.spaceId === sid));
    if (!m || m.project !== project) return res.status(400).json({ error: '物料不存在或不属于所选工程' });
    const qty = roundQty(Number(e.qty));
    if (!(qty > 0)) return res.status(400).json({ error: '物料「' + m.description + '」出库数量必须大于 0' });
    const st = stats[m.id] || { taken: 0, returned: 0 };
    const avail = roundQty(Math.max(0, roundQty(m.qtyArrived) - roundQty(st.taken - st.returned)));
    if (qty > avail + 1e-9) return res.status(400).json({ error: '物料「' + m.description + '」本次出库 ' + qty + ' 超过可用库存 ' + avail });
    finalItems.push({ materialId: m.id, code: m.code || '', description: m.description || '', unit: m.unit || '', qty, returned: 0 });
  }
  // 单号：OUT-YYYYMMDD-NNNNNN（按当日已有单据数递增）
  const dateTag = fmtNow().slice(0, 10).replace(/-/g, '');
  const seq = DB.materialOutbound.filter(o => !o.deleted && (!sid || o.spaceId === sid) && String(o.outNo || '').startsWith('OUT-' + dateTag + '-')).length + 1;
  const rec = {
    id: genId('ob'), outNo: 'OUT-' + dateTag + '-' + String(seq).padStart(6, '0'),
    project, receiver, status: '有效', createdAt: fmtNow(),
    items: finalItems, returns: [], compensated: 0,
    spaceId: sid, deleted: false
  };
  DB.materialOutbound.unshift(rec);
  saveDB();
  res.json({ ok: true, data: rec });
});
app.put('/api/materialOutbound/:id/return', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '有效') return res.status(400).json({ error: '该出库单已作废，不能登记归还' });
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const applied = [];
  for (const r of rows) {
    const it = (rec.items || []).find(i => i.materialId === r.materialId);
    if (!it) continue;
    const qty = roundQty(Number(r.qty));
    const remaining = roundQty(it.qty - it.returned);
    if (!(qty > 0)) continue;
    if (qty > remaining + 1e-9) return res.status(400).json({ error: '物料「' + it.description + '」本次归还 ' + qty + ' 超过剩余未归还 ' + remaining });
    it.returned = roundQty(it.returned + qty);
    applied.push({ materialId: it.materialId, qty });
  }
  if (!applied.length) return res.status(400).json({ error: '请填写有效的归还数量' });
  if (!Array.isArray(rec.returns)) rec.returns = [];
  rec.returns.push({ at: fmtNow(), rows: applied });
  saveDB();
  res.json({ ok: true, data: rec });
});
app.put('/api/materialOutbound/:id/void', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '有效') return res.status(400).json({ error: '该出库单已作废，不能重复作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '作废原因不能为空' });
  rec.status = '已作废';
  rec.voidReason = reason;
  rec.voidedAt = fmtNow();
  saveDB();
  res.json({ ok: true, data: rec });
});
// 出库单删除：仅已作废的出库单可删除（同领料单口径；须注册在通用 CRUD 工厂之前以覆盖默认删除）
app.delete('/api/materialOutbound/:id', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到出库单' });
  if (rec.status !== '已作废') return res.status(400).json({ error: '仅已作废的出库单可删除，请先作废' });
  rec.deleted = true; // 逻辑删除（保留记录，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});

// ---------- 作业计划（计划管理：周计划/月计划/已归档/已执行/已结算/已取消） ----------
const PLAN_TYPES = ['周计划', '月计划'];
const PLAN_STATUS = ['未执行', '已执行', '已归档', '已取消', '已结算'];
const TICKET_TYPES = ['第一种工作票', '第二种工作票', '电力线路第二种工作票', '电力电缆第二种工作票', '带电作业工作票', '动火工作票'];
const VOLTAGE_LEVELS = ['0.4kV', '10kV', '20kV', '35kV', '110kV', '220kV'];
function planItem(b) {
  const base = {
    id: b.id || genId('wp'),
    name: String(b.name || '').trim(),
    content: String(b.content || '').trim(),
    planType: PLAN_TYPES.includes(b.planType) ? b.planType : '周计划',
    project: String(b.project || '').trim(),
    team: String(b.team || '').trim(),
    leader: String(b.leader || '').trim(),
    startDate: String(b.startDate || '').trim(),
    endDate: String(b.endDate || '').trim(),
    ticketType: TICKET_TYPES.includes(b.ticketType) ? b.ticketType : (String(b.ticketType || '').trim() || '配电：配电第二种工作票'),
    voltage: VOLTAGE_LEVELS.includes(b.voltage) ? b.voltage : (String(b.voltage || '').trim() || '10kV'),
    station: String(b.station || '').trim(),
    chargePerson: String(b.chargePerson || '').trim(),
    status: PLAN_STATUS.includes(b.status) ? b.status : '未执行',
    createdAt: b.createdAt || nowISO()
  };
  // 保留新增周计划大表单的扩展字段（子项目/作业类型/专业/地址/风险因素/作业单位/班组/材料等）
  const extras = {};
  ['subProject', 'workType', 'specialty', 'dept', 'address', 'shadowContent', 'machine', 'riskLevel', 'gridRisk', 'riskFactors', 'majorRisk', 'controlMeasures', 'workUnit', 'chargePersons', 'staff', 'finishDate', 'planNote', 'teams', 'materials', 'buildCity', 'buildCounty', 'execCity', 'execCounty', 'substation', 'subcontractors', 'supervisor', 'ccUnits', 'staffText', 'teamLeader', 'staffCount', 'highStaff', 'gasTester', 'guardian', 'chargePerson', 'chargePersonPhone', 'arrivalPersons', 'safetyPatrol', 'wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04', 'outageRange', 'outageHours', 'surveyNo', 'workTicketNo'].forEach(k => {
    if (b[k] !== undefined) extras[k] = b[k];
  });
  return { ...extras, ...base };
}
app.post('/api/workPlans/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    const name = req.file.originalname || '';
    if (/\.csv$/i.test(name)) {
      const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
      rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    }
    const errors = [];
    const parsed = [];
    rows.forEach((r, i) => {
      if (i === 0) return; // 表头
      const pName = String(r[0] || '').trim();
      const pType = String(r[1] || '').trim();
      const start = String(r[5] || '').trim();
      const end = String(r[6] || '').trim();
      if (!pName && !pType && !start && !end) return; // 空行
      const rowNo = i + 1;
      if (!pName) { errors.push('第' + rowNo + '行：作业计划名称不能为空'); return; }
      if (!PLAN_TYPES.includes(pType)) { errors.push('第' + rowNo + '行：计划类型「' + (pType || '空') + '」无效（仅支持：周计划 / 月计划）'); return; }
      if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) { errors.push('第' + rowNo + '行：计划开始日期「' + (start || '空') + '」格式应为 YYYY-MM-DD'); return; }
      if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) { errors.push('第' + rowNo + '行：计划结束日期「' + (end || '空') + '」格式应为 YYYY-MM-DD'); return; }
      if (end < start) { errors.push('第' + rowNo + '行：计划结束日期早于开始日期'); return; }
      parsed.push(planItem({
        name: pName, planType: pType, project: r[2], team: r[3], leader: r[4],
        startDate: start, endDate: end, ticketType: r[7], voltage: r[8], station: r[9], chargePerson: r[10]
      }));
    });
    if (errors.length) {
      return res.status(400).json({ error: '导入失败，共 ' + errors.length + ' 处问题：' + errors.slice(0, 5).join('；') + (errors.length > 5 ? '（仅显示前 5 处）' : '') });
    }
    if (!parsed.length) return res.status(400).json({ error: '模板中没有可导入的数据行' });
    parsed.forEach(p => DB.workPlans.unshift(p));
    saveDB();
    res.json({ ok: true, added: parsed.length });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});
app.get('/api/workPlans/export', (req, res) => {
  const type = String(req.query.type || '');
  const list = DB.workPlans.filter(p => !type || p.planType === type);
  const aoa = [['作业计划名称', '工作内容', '计划类型', '关联项目', '作业班组', '班组长', '计划开始', '计划结束', '工作票类型', '电压等级', '变电站/线路', '工作负责人', '状态']];
  list.forEach(p => aoa.push([p.name, p.content, p.planType, p.project, p.team, p.leader, p.startDate, p.endDate, p.ticketType, p.voltage, p.station, p.chargePerson, p.status]));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), '作业计划');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="workPlans_export.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// 简单集合（直接 CRUD）
// 业务私有集合：按 spaceId 行级隔离 + 逻辑删除（projects 自定义删除见下方文件端点前；此处提供标准 CRUD）
['projects', 'plans', 'borrowWorks', 'completionDocuments', 'materialRequisitions', 'materialImports', 'materialOutbound', 'workers', 'contacts', 'workPlans'].forEach(c => {
  crud(c, c, { space: true, soft: true });
});
// 全局字典/系统资源：无空间隔离、物理删除（年度计划/供电所/班组/材料目录/单位维护）
['annualPlans', 'substations', 'materialCatalog', 'teams', 'units'].forEach(c => {
  crud(c, c, { space: false, soft: false });
});
// 用户账号（users）走自定义端点（创建时原子创建绑定空间），不在此注册

// ---------- 材料明细（工程材料清单） ----------
// 来源类型为固定枚举（与原系统一致），新增/编辑/导入均强制校验
const SOURCE_TYPES = ['ERP采购申请', '甲供材料', '库存调拨', '乙供/自购', '运检项目'];

app.get('/api/materials', (req, res) => res.json(DB.materials.filter(spaceFilter(req)).map(withGen)));
app.get('/api/materials/:id', (req, res) => {
  const it = DB.materials.find(x => x.id === req.params.id);
  if (!it || it.deleted || it.spaceId !== reqSpaceId(req)) return res.status(404).json({ error: '未找到' });
  res.json(withGen(it));
});
// 已生成领料单数量 = 历史累计生成量（同空间未作废领料单中该物料的领料数量合计，含已入库的）
// 待入库/部分到库/已入库 均计入；已作废 → 不计入（作废已冲销）
function qtyGeneratedOf(m, spaceId) {
  const sid = spaceId || m.spaceId;
  let g = 0;
  DB.materialRequisitions.forEach(r => {
    if (r.deleted || r.status === '已作废' || (sid && r.spaceId !== sid)) return;
    (r.items || []).forEach(it => {
      if (it.materialId === m.id) g += Number(it.qty) || 0;
    });
  });
  return roundQty(g);
}
// 在途未入库余量 = 同空间待入库/部分到库领料单中该物料尚未入库的数量合计（用于计算可继续领料）
function qtyOutstandingOf(m, spaceId) {
  const sid = spaceId || m.spaceId;
  let o = 0;
  DB.materialRequisitions.forEach(r => {
    if (r.deleted || (sid && r.spaceId !== sid)) return;
    if (r.status !== '待入库' && r.status !== '部分到库') return;
    (r.items || []).forEach(it => {
      if (it.materialId !== m.id) return;
      const cr = (r.confirmRows || []).find(c => c.materialId === it.materialId);
      o += Math.max(0, (Number(it.qty) || 0) - (Number(cr && cr.thisQty) || 0));
    });
  });
  return roundQty(o);
}
function withGen(m) {
  const gen = qtyGeneratedOf(m, m.spaceId);
  const canGen = roundQty(Math.max(0, m.qtyNotArrived - qtyOutstandingOf(m, m.spaceId)));
  return { ...m, qtyGenerated: gen, qtyCanGen: canGen, status: materialStatus(m, m.spaceId) };
}
function materialStatus(m, spaceId) {
  if (Number(m.qtyRequired) > 0 && m.qtyArrived >= m.qtyRequired) return '全部到库';
  if (m.qtyArrived > 0) return '部分到库'; // 已有入库数量时到货情况优先（可继续领料仍按未到余量-已生成计算）
  if (qtyGeneratedOf(m, spaceId || m.spaceId) > 0) return '已生成领料单'; // 未入库但有领料单在途（剩余量仍可继续领料）
  return '未到库';
}
function roundQty(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }
// 单体工程名称 = 项目列表「工程名称」∪ 各项目下子项目名称（与项目列表联动、必须一致）
function allSingleProjectNames() {
  const names = [];
  DB.projects.forEach(p => {
    if (p.name) names.push(p.name);
    (p.subProjects || []).forEach(s => { if (s.name) names.push(s.name); });
  });
  return names;
}
function validateMaterialBody(b, { forEdit = false, oldItem = null } = {}) {
  const project = String(b.project || '').trim();
  if (!project) return '项目名称不能为空';
  if (!allSingleProjectNames().includes(project)) return '项目名称「' + project + '」与项目列表不一致，无法保存（只能选择项目列表中的工程/子项目名称）';
  const source = String(b.source || '').trim();
  if (!SOURCE_TYPES.includes(source)) return '来源类型无效，仅支持：' + SOURCE_TYPES.join(' / ');
  if (!String(b.description || '').trim()) return '物料描述不能为空';
  const qty = Number(b.qtyRequired);
  if (!isFinite(qty) || qty < 0) return '应到数量无效';
  if (forEdit && oldItem && roundQty(qty) !== roundQty(oldItem.qtyRequired) && !String(b.modifyReason || '').trim()) {
    return '修改了应到数量，必须填写「修改应到数量原因」';
  }
  return null;
}
app.post('/api/materials', (req, res) => {
  const b = req.body || {};
  const err = validateMaterialBody(b);
  if (err) return res.status(400).json({ error: err });
  const item = {
    id: genId('m'), createdAt: nowISO(),
    project: String(b.project).trim(), description: String(b.description).trim(),
    qtyRequired: roundQty(b.qtyRequired), qtyArrived: roundQty(b.qtyArrived),
    unit: String(b.unit || '').trim(), code: String(b.code || '').trim(),
    orderNo: String(b.orderNo || '').trim() || '-',
    source: String(b.source).trim(), sourceNote: String(b.sourceNote || '').trim(),
    inWeeklyPlan: b.inWeeklyPlan !== false,
    modifyReason: '', modifiedAt: ''
  };
  item.qtyNotArrived = roundQty(Math.max(0, item.qtyRequired - item.qtyArrived));
  item.status = materialStatus(item);
  item.spaceId = reqSpaceId(req); item.deleted = false;
  DB.materials.push(item);
  saveDB();
  res.json(item);
});
app.put('/api/materials/:id', (req, res) => {
  const idx = DB.materials.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const old = DB.materials[idx];
  if (old.deleted || old.spaceId !== reqSpaceId(req)) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const err = validateMaterialBody(b, { forEdit: true, oldItem: old });
  if (err) return res.status(400).json({ error: err });
  const qtyChanged = roundQty(b.qtyRequired) !== roundQty(old.qtyRequired);
  const cur = {
    ...old,
    project: String(b.project || old.project).trim(),
    description: String(b.description !== undefined ? b.description : old.description).trim(),
    qtyRequired: roundQty(b.qtyRequired !== undefined ? b.qtyRequired : old.qtyRequired),
    qtyArrived: roundQty(b.qtyArrived !== undefined ? b.qtyArrived : old.qtyArrived),
    unit: String(b.unit !== undefined ? b.unit : old.unit).trim(),
    code: String(b.code !== undefined ? b.code : old.code).trim(),
    orderNo: String(b.orderNo !== undefined ? b.orderNo : old.orderNo).trim() || '-',
    source: String(b.source || old.source).trim(),
    sourceNote: String(b.sourceNote !== undefined ? b.sourceNote : old.sourceNote).trim(),
    inWeeklyPlan: b.inWeeklyPlan !== undefined ? b.inWeeklyPlan !== false : old.inWeeklyPlan,
    modifyReason: qtyChanged ? String(b.modifyReason || '').trim() : old.modifyReason,
    modifiedAt: qtyChanged ? fmtNow() : old.modifiedAt
  };
  cur.qtyNotArrived = roundQty(Math.max(0, cur.qtyRequired - cur.qtyArrived));
  cur.status = materialStatus(cur);
  DB.materials[idx] = cur;
  saveDB();
  res.json(cur);
});
app.delete('/api/materials/:id', (req, res) => {
  const idx = DB.materials.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const cur = DB.materials[idx];
  if (cur.deleted || cur.spaceId !== reqSpaceId(req)) return res.status(404).json({ error: '未找到' });
  cur.deleted = true; // 逻辑删除（业务私有数据，重置/删除走逻辑标记）
  saveDB();
  res.json({ ok: true });
});

// ---------- 材料导入（真实模板：采购申请） ----------
// 模板列（按位置）：0 项目名称（单体工程名称）/ 1 短文本(物料描述) / 2 申请数量 / 3 计量单位 / 4 物料编码 / 5 采购订单号 / 6 来源类型
// 硬校验：① 项目名称必须与项目列表一致  ② 来源类型必须是固定枚举，任一行不合法则整份拒绝导入
app.post('/api/materials/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    const name = req.file.originalname || '';
    if (/\.csv$/i.test(name)) {
      const text = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
      rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    }
    const validNames = allSingleProjectNames();
    const errors = [];
    const parsed = [];
    let skippedEmpty = 0;
    rows.forEach((r, i) => {
      if (i === 0) return; // 跳过表头
      const project = String(r[0] || '').trim();
      const description = String(r[1] || '').trim();
      const qtyRaw = String(r[2] === undefined || r[2] === null ? '' : r[2]).trim();
      const source = String(r[6] || '').trim();
      if (!project && !description && !qtyRaw) { skippedEmpty++; return; } // 空行
      const rowNo = i + 1;
      if (!validNames.includes(project)) { errors.push('第' + rowNo + '行：项目名称「' + (project || '空') + '」与项目列表不一致'); return; }
      if (!SOURCE_TYPES.includes(source)) { errors.push('第' + rowNo + '行：来源类型「' + (source || '空') + '」无效（仅支持：' + SOURCE_TYPES.join(' / ') + '）'); return; }
      const qty = Number(qtyRaw);
      if (!qtyRaw || !isFinite(qty) || qty < 0) { errors.push('第' + rowNo + '行：申请数量「' + (qtyRaw || '空') + '」无效'); return; }
      parsed.push({ project, description, qty: roundQty(qty), unit: String(r[3] || '').trim(), code: String(r[4] || '').trim(), orderNo: String(r[5] || '').trim() || '-', source });
    });
    if (errors.length) {
      return res.status(400).json({ error: '导入失败，共 ' + errors.length + ' 处不一致：' + errors.slice(0, 5).join('；') + (errors.length > 5 ? '（仅显示前 5 处）' : '') });
    }
    if (!parsed.length) return res.status(400).json({ error: '模板中没有可导入的数据行' });
    const added = parsed.map(r => {
      const item = {
        id: genId('m'), createdAt: nowISO(),
        project: r.project, description: r.description,
        qtyRequired: r.qty, qtyArrived: 0, qtyNotArrived: r.qty,
        unit: r.unit, code: r.code, orderNo: r.orderNo, source: r.source,
        sourceNote: '', inWeeklyPlan: true, modifyReason: '', modifiedAt: ''
      };
      item.status = materialStatus(item);
      item.spaceId = reqSpaceId(req); item.deleted = false;
      DB.materials.push(item);
      return item;
    });
    // 记录导入批次（供「导入批次」页签展示）：项目归属 / 行数（总/匹配/跳过）/ 调整数 / 备注
    const projects = [...new Set(parsed.map(r => r.project))];
    const batch = {
      id: genId('im'), batch: 'IMP' + Date.now(), fileName: name,
      project: projects.length === 1 ? projects[0] : projects.join('、'),
      rowsTotal: parsed.length + skippedEmpty, rowsMatched: parsed.length, rowsSkipped: skippedEmpty,
      adjusted: 0, adjustments: [],
      rows: added.length, importedBy: req.user.name, importedAt: fmtNow(), status: '成功', remark: '-',
      spaceId: reqSpaceId(req), deleted: false
    };
    DB.materialImports.push(batch);
    saveDB();
    res.json({ ok: true, added: added.length, batch: batch.batch, data: added });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 领料单（暂存清单 → 生成领料单 → 下载 Excel → 确认入库 / 作废） ----------
// 单号规则 LL-YYYYMMDD-HHMMSS，与原系统一致
function reqNoNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return 'LL-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
// 从暂存的物料生成领料单；领料数量可任意填写（默认=可继续领料），但不能大于可继续领料
// 请求体：{ items: [{ id, qty }] }（兼容旧 { ids: [...] } = 按可继续领料全量生成）
app.post('/api/requisitions/create', (req, res) => {
  const body = req.body || {};
  const sid = reqSpaceId(req);
  const list = Array.isArray(body.items) && body.items.length
    ? body.items.map(x => ({ id: x.id, qty: x.qty }))
    : (Array.isArray(body.ids) ? body.ids.map(id => ({ id })) : []);
  if (!list.length) return res.status(400).json({ error: '暂存清单为空，无法生成领料单' });
  const items = [];
  const skipped = [];
  const touched = [];
  for (const entry of list) {
    const m = DB.materials.find(x => x.id === entry.id && !x.deleted && (!sid || x.spaceId === sid));
    if (!m) continue;
    const canGen = withGen(m).qtyCanGen;
    // 已全部到库 / 可继续领料为 0 的材料不允许再生成领料单
    if ((m.qtyNotArrived <= 0 && Number(m.qtyRequired) > 0) || canGen <= 0) { skipped.push(m.code || m.description || entry.id); continue; }
    let qty = entry.qty === undefined || entry.qty === '' || entry.qty === null ? canGen : Number(entry.qty);
    if (!isFinite(qty) || qty <= 0) return res.status(400).json({ error: '物料「' + (m.description || m.code) + '」领料数量无效，必须大于 0' });
    qty = roundQty(qty);
    if (qty > canGen) return res.status(400).json({ error: '物料「' + (m.description || m.code) + '」领料数量 ' + qty + ' 不能大于可继续领料 ' + canGen });
    touched.push(m);
    items.push({
      materialId: m.id, code: m.code || '-', description: m.description || '',
      unit: m.unit || '', qty, arrivedBefore: roundQty(m.qtyArrived), orderNo: m.orderNo || '-', project: m.project || ''
    });
  }
  if (!items.length) return res.status(400).json({ error: skipped.length ? '所选物料均已全部到库或无可继续领料数量，无法生成领料单' : '所选物料已不存在，无法生成领料单' });
  const rec = {
    id: genId('rq'), reqNo: reqNoNow(),
    projects: [...new Set(items.map(i => i.project))],
    items, createdAt: fmtNow(), status: '待入库', confirmRows: null,
    spaceId: sid, deleted: false
  };
  DB.materialRequisitions.unshift(rec);
  // 同步材料状态（已生成数量按领料单动态汇总，部分生成时剩余量仍可继续领料）
  touched.forEach(m => { m.status = materialStatus(m); });
  saveDB();
  res.json({ ok: true, data: rec });
});

// 下载领料单 Excel（格式对齐原系统样例：LL-20261009-222544.xlsx）
app.get('/api/materialRequisitions/:id/download', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  const aoa = [];
  aoa.push(['国网富顺县供电公司过渡仓代保管物资领料单', '', '', '', '', '', '']);
  aoa.push(['项目部门：', '', '', '', '', '', '']);
  aoa.push(['序号', '物料编码', '物料描述', '计量单位', '数量', '项目名称', '备注']);
  rec.items.forEach((it, i) => {
    aoa.push([String(i + 1), it.code, it.description, it.unit, it.qty, it.project, it.orderNo === '-' ? '' : it.orderNo]);
  });
  for (let i = 0; i < 5; i++) aoa.push(['', '', '', '', '', '', '']);
  aoa.push(['项目部门负责人：                                    项目部门分管领导：                                            领料人：                                      库管员：    ', '', '', '', '', '', '']);
  aoa.push(['说明：备注栏填写原订单号。', '', '', '', '', '', '']);
  const ws = xlsx.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [
    { s: { c: 0, r: 0 }, e: { c: 6, r: 0 } },
    { s: { c: 0, r: 1 }, e: { c: 6, r: 1 } },
    { s: { c: 0, r: aoa.length - 2 }, e: { c: 6, r: aoa.length - 2 } },
    { s: { c: 0, r: aoa.length - 1 }, e: { c: 6, r: aoa.length - 1 } }
  ];
  ws['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 26 }, { wch: 10 }, { wch: 10 }, { wch: 34 }, { wch: 14 }];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="' + rec.reqNo + '.xlsx"');
  res.send(buf);
});

// 确认入库 / 补入库：无异常 → 本次入库=剩余未入库数量；有异常 → 按行传入实际本次入库数量与异常原因
// 待入库首录入库；「部分到库」（存在异常缺库）的领料单可再次补入库，confirmRows 按物料累计入库数量
app.put('/api/materialRequisitions/:id/confirm', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '待入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单已' + rec.status + '，不能重复入库' });
  const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
  const results = (rec.confirmRows || []).map(x => ({ ...x })); // 已累计的入库记录
  const opRows = []; // 本次操作的逐条记录（写入 history，供详情展示与 Excel 下载）
  for (const it of rec.items) {
    const prev = results.find(x => x.materialId === it.materialId);
    const done = prev ? (Number(prev.thisQty) || 0) : 0;
    const remaining = roundQty(Math.max(0, it.qty - done));
    const r = rows.find(x => x.materialId === it.materialId) || {};
    let qty = r.thisQty === undefined || r.thisQty === '' ? remaining : Number(r.thisQty);
    if (!isFinite(qty) || qty < 0) return res.status(400).json({ error: '物料「' + it.description + '」本次入库数量无效' });
    if (qty > remaining) return res.status(400).json({ error: '物料「' + it.description + '」本次入库数量不能大于未入库数量（剩余 ' + remaining + '）' });
    qty = roundQty(qty);
    const reason = String(r.reason || '').trim();
    const cum = roundQty(done + qty);
    // 仍有未入库数量即视为异常，须有异常原因（本次填写或沿用上次）
    const abnormal = cum < it.qty - 1e-9;
    if (abnormal && !reason && !(prev && prev.reason)) return res.status(400).json({ error: '物料「' + it.description + '」仍有未入库数量，必须填写异常原因' });
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
    if (m && qty > 0) {
      m.qtyArrived = roundQty(m.qtyArrived + qty);
      m.qtyNotArrived = roundQty(Math.max(0, m.qtyRequired - m.qtyArrived));
      m.requisitionId = null; // 本次领料流程结束（已入库），状态回归按数量计算
      m.status = materialStatus(m);
      if (abnormal) { m.abnormalNote = reason || (prev && prev.reason) || ''; m.modifiedAt = fmtNow(); }
    }
    if (prev) { prev.thisQty = cum; prev.abnormal = abnormal; prev.reason = abnormal ? (reason || prev.reason) : ''; }
    else results.push({ materialId: it.materialId, thisQty: cum, abnormal, reason });
    opRows.push({ materialId: it.materialId, thisQty: qty, abnormal, reason });
  }
  // 全部物料累计入库数量均达到领料数量 → 已入库；否则部分到库（可继续补入库）
  const allFull = rec.items.every(it => {
    const cr = results.find(x => x.materialId === it.materialId);
    return cr && (Number(cr.thisQty) || 0) >= it.qty - 1e-9;
  });
  rec.status = allFull ? '已入库' : '部分到库';
  rec.confirmRows = results;
  rec.confirmedAt = fmtNow();
  // 每次入库/补入库操作均记录历史（详情展开逐条展示 + Excel 领料单附带入库记录）
  if (!Array.isArray(rec.history)) rec.history = [];
  rec.history.push({ at: rec.confirmedAt, rows: opRows });
  saveDB();
  res.json({ ok: true, data: rec });
});

// 作废（待入库/已入库/部分到库均可作废；已入库的会冲销其已入库数量，材料状态按扣减后重新汇总）
app.put('/api/materialRequisitions/:id/void', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '待入库' && rec.status !== '已入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单已' + rec.status + '，不能作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写作废原因' });
  rec.status = '已作废';
  // 按领料单明细恢复材料状态（待入库作废时 confirmRows 为空，也要解除「已生成领料单」锁定）
  (rec.items || []).forEach(it => {
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted && (!reqSpaceId(req) || x.spaceId === reqSpaceId(req)));
    if (!m) return;
    const cr = (rec.confirmRows || []).find(c => c.materialId === it.materialId);
    const deduct = cr ? (Number(cr.thisQty) || 0) : 0;
    if (deduct > 0) {
      m.qtyArrived = roundQty(Math.max(0, m.qtyArrived - deduct));
      m.qtyNotArrived = roundQty(Math.max(0, m.qtyRequired - m.qtyArrived));
    }
    m.requisitionId = null;
    m.status = materialStatus(m);
  });
  rec.voidedAt = fmtNow();
  rec.voidReason = reason;
  rec.voidDeduct = roundQty((rec.confirmRows || []).reduce((s, r) => s + (Number(r.thisQty) || 0), 0));
  saveDB();
  res.json({ ok: true, data: rec });
});

// ---------- 文档中心 ----------
function fmtNow() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

app.get('/api/documents', (req, res) => {
  const sid = reqSpaceId(req);
  // 隔离：仅返回当前空间的用户文件 + 全局固定文件（固定模板、演示记录等）
  const docs = { ...DB.documents, files: (DB.documents.files || []).filter(f => !f.deleted && (f.fixed || !f.spaceId || f.spaceId === sid)) };
  res.json(docs);
});

// 更新文档中心顶层元数据（分类列表 / 固定模板名称、上传人、时间；不改动 path）
app.put('/api/documents', (req, res) => {
  try {
    const b = req.body || {};
    if (Array.isArray(b.categories)) DB.documents.categories = b.categories;
    if (b.surveyTemplate && typeof b.surveyTemplate === 'object') {
      DB.documents.surveyTemplate = { ...DB.documents.surveyTemplate, ...b.surveyTemplate, path: DB.documents.surveyTemplate.path };
    }
    saveDB();
    res.json(DB.documents);
  } catch (e) { res.status(500).json({ error: '更新失败：' + e.message }); }
});

// 上传真实文件（单文件 ≤20MB）→ data/uploads/
app.post('/api/documents/files', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    if (req.file.size > 20 * 1024 * 1024) return res.status(400).json({ error: '单文件不超过 20MB' });
    const upDir = path.join(__dirname, 'data', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
    const id = genId('f');
    const safe = (req.file.originalname || 'file').replace(/[\\/:*?"<>|]/g, '_');
    const rel = 'uploads/' + id + '_' + safe;
    fs.writeFileSync(path.join(__dirname, 'data', rel), req.file.buffer);
    const file = {
      id, category: req.body.category || '未分类', name: req.file.originalname,
      size: req.file.size, uploader: req.user.name, uploadedAt: fmtNow(), path: rel,
      spaceId: reqSpaceId(req)
    };
    DB.documents.files.push(file);
    saveDB();
    res.json(file);
  } catch (e) { res.status(500).json({ error: '上传失败：' + e.message }); }
});

// 替换固定系统文件：现场勘察记录模板.docx（固定文件不可移动/删除，只能替换）
app.post('/api/documents/template/replace', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    if (req.file.size > 20 * 1024 * 1024) return res.status(400).json({ error: '单文件不超过 20MB' });
    const name = req.file.originalname || '';
    if (!/\.docx$/i.test(name)) return res.status(400).json({ error: '仅支持替换为 .docx 文件' });
    const upDir = path.join(__dirname, 'data', 'uploads');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
    // 清理上一次替换产生的旧文件
    const old = DB.documents.surveyTemplate && DB.documents.surveyTemplate.path;
    if (old && old.startsWith('uploads/')) { try { fs.unlinkSync(path.join(__dirname, 'data', old)); } catch (e) {} }
    const rel = 'uploads/st_' + Date.now() + '_' + name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(__dirname, 'data', rel), req.file.buffer);
    const meta = { name, uploader: req.user.name, uploadedAt: fmtNow(), path: rel, size: req.file.size };
    DB.documents.surveyTemplate = { ...DB.documents.surveyTemplate, ...meta };
    const idx = DB.documents.files.findIndex(f => f.id === 'st1');
    if (idx >= 0) DB.documents.files[idx] = { ...DB.documents.files[idx], ...meta };
    saveDB();
    res.json(DB.documents.surveyTemplate);
  } catch (e) { res.status(500).json({ error: '替换失败：' + e.message }); }
});

// 移动到（改分类）/ 改名
app.put('/api/documents/files/:id', (req, res) => {
  const idx = DB.documents.files.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  if (DB.documents.files[idx].fixed) return res.status(400).json({ error: '固定系统文件不可移动' });
  if (!DB.documents.files[idx].fixed && DB.documents.files[idx].spaceId && DB.documents.files[idx].spaceId !== reqSpaceId(req)) return res.status(403).json({ error: '无权操作其他空间的文件' });
  DB.documents.files[idx] = { ...DB.documents.files[idx], ...req.body, id: req.params.id };
  saveDB();
  res.json(DB.documents.files[idx]);
});

app.delete('/api/documents/files/:id', (req, res) => {
  const idx = DB.documents.files.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  if (DB.documents.files[idx].fixed) return res.status(400).json({ error: '固定系统文件不可删除' });
  if (DB.documents.files[idx].spaceId && DB.documents.files[idx].spaceId !== reqSpaceId(req)) return res.status(403).json({ error: '无权操作其他空间的文件' });
  const f = DB.documents.files[idx];
  if (f.path && f.path.startsWith('uploads/')) {
    try { fs.unlinkSync(path.join(__dirname, 'data', f.path)); } catch (e) {}
  }
  DB.documents.files.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 下载：真实文件直接下发；演示记录下发占位内容
app.get('/api/documents/files/:id/download', (req, res) => {
  const f = DB.documents.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '未找到' });
  let p = null;
  if (f.path && f.path.startsWith('assets/')) p = path.join(__dirname, f.path);
  if (f.path && f.path.startsWith('uploads/')) p = path.join(__dirname, 'data', f.path);
  if (p && fs.existsSync(p)) {
    return res.download(p, f.name);
  }
  const content = Buffer.from(`${f.name}\n分类：${f.category}\n上传人：${f.uploader}\n上传时间：${f.uploadedAt}\n（本地演示版未存储该文件的真实内容）`, 'utf8');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.send(content);
});

// 预览：xlsx→表格；docx→提取文本；pdf→浏览器打开链接；其他→不支持
app.get('/api/documents/files/:id/preview', (req, res) => {
  const f = DB.documents.files.find(x => x.id === req.params.id);
  if (!f) return res.status(404).json({ error: '未找到' });
  let p = null;
  if (f.path && f.path.startsWith('assets/')) p = path.join(__dirname, f.path);
  if (f.path && f.path.startsWith('uploads/')) p = path.join(__dirname, 'data', f.path);
  if (!p || !fs.existsSync(p)) {
    return res.json({ kind: 'unsupported', name: f.name, message: '该文件为演示登记记录，未存储真实内容，请下载后查看。' });
  }
  const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  try {
    if (['xlsx', 'xls'].includes(ext.toLowerCase())) {
      const wb = xlsx.readFile(p);
      const sheets = wb.SheetNames.map(n => {
        const rows = xlsx.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '', raw: false });
        return { name: n, rows };
      });
      return res.json({ kind: 'xlsx', name: f.name, sheets });
    }
    if (ext.toLowerCase() === 'docx') {
      const lines = extractDocxText(fs.readFileSync(p));
      return res.json({ kind: 'docx', name: f.name, lines });
    }
    if (ext.toLowerCase() === 'pdf') {
      return res.json({ kind: 'pdf', name: f.name, url: '/api/documents/files/' + f.id + '/download' });
    }
    return res.json({ kind: 'unsupported', name: f.name, message: '该文件类型暂不支持预览，请下载后查看。' });
  } catch (e) { res.status(500).json({ error: '预览失败：' + e.message }); }
});

// ---------- 企业危险点库（对齐截图：危险点/控制措施/排序） ----------
app.post('/api/documents/hazard', (req, res) => {
  const b = req.body || {};
  const hazard = String(b.hazard || '').trim();
  const measure = String(b.measure || '').trim();
  if (!hazard) return res.status(400).json({ error: '请填写危险点' });
  if (!measure) return res.status(400).json({ error: '请填写控制措施' });
  if (hazard.length > 1000) return res.status(400).json({ error: '危险点不超过 1000 字' });
  if (measure.length > 4000) return res.status(400).json({ error: '控制措施不超过 4000 字' });
  let sort = (b.sort === '' || b.sort === null || b.sort === undefined) ? null : Number(b.sort);
  if (sort === null || isNaN(sort)) {
    sort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1) + 1;
  }
  const category = b.category ? String(b.category).trim() : categorize(hazard);
  const h = { id: genId('h'), hazard, measure, category, sort };
  DB.documents.hazardLibrary.push(h);
  saveDB();
  res.json(h);
});

app.put('/api/documents/hazard/:id', (req, res) => {
  const idx = DB.documents.hazardLibrary.findIndex(h => h.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const hazard = String(b.hazard ?? DB.documents.hazardLibrary[idx].hazard).trim();
  const measure = String(b.measure ?? DB.documents.hazardLibrary[idx].measure).trim();
  if (!hazard) return res.status(400).json({ error: '请填写危险点' });
  if (!measure) return res.status(400).json({ error: '请填写控制措施' });
  let sort = (b.sort === '' || b.sort === null || b.sort === undefined) ? DB.documents.hazardLibrary[idx].sort : Number(b.sort);
  if (isNaN(sort)) sort = DB.documents.hazardLibrary[idx].sort;
  const category = b.category === undefined ? undefined : String(b.category || '').trim();
  DB.documents.hazardLibrary[idx] = { ...DB.documents.hazardLibrary[idx], hazard, measure, sort, ...(category === undefined ? {} : { category }) };
  saveDB();
  res.json(DB.documents.hazardLibrary[idx]);
});

app.delete('/api/documents/hazard/:id', (req, res) => {
  const idx = DB.documents.hazardLibrary.findIndex(h => h.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.documents.hazardLibrary.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 危险点导入：首个工作表 A列危险点、C列控制措施；最多 1000 行、2MB；相同危险点和措施自动跳过
app.post('/api/documents/hazard/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: '文件超过 2MB 限制' });
    let rows;
    if (/\.csv$/i.test(req.file.originalname || '')) {
      rows = parseCSVBuffer(req.file.buffer);
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
    }
    const data = rows.slice(1)
      .map(r => [String(r[0] || '').trim(), String(r[2] || '').trim()])
      .filter(([a, b]) => a || b);
    if (data.length > 1000) return res.status(400).json({ error: '超过最多 1000 行的限制' });
    const existing = new Set(DB.documents.hazardLibrary.map(h => h.hazard + '||' + h.measure));
    let maxSort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1);
    let added = 0, skipped = 0;
    for (const [hazard, measure] of data) {
      if (!hazard || !measure) { skipped++; continue; }
      const key = hazard + '||' + measure;
      if (existing.has(key)) { skipped++; continue; }
      existing.add(key);
      DB.documents.hazardLibrary.push({ id: genId('h'), hazard, measure, category: categorize(hazard), sort: ++maxSort });
      added++;
    }
    saveDB();
    res.json({ ok: true, added, skipped });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 设置 ----------
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => {
  DB.settings = { ...DB.settings, ...req.body };
  saveDB();
  res.json(DB.settings);
});

// ---------- 登录页背景：本地上传（管理员）→ data/uploads/login-bg/ ----------
app.post('/api/settings/login-bg', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const name = req.file.originalname || '';
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(name)) return res.status(400).json({ error: '仅支持 JPG / PNG / WebP / GIF 图片' });
    if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: '图片不超过 10MB' });
    const upDir = path.join(__dirname, 'data', 'uploads', 'login-bg');
    if (!fs.existsSync(upDir)) fs.mkdirSync(upDir, { recursive: true });
    // 清理上一次上传的背景文件（预设图在 public/ 内，不受影响）
    const old = DB.settings.loginBg;
    if (old && old.startsWith('/api/login-bg/')) {
      try { fs.unlinkSync(path.join(upDir, path.basename(old))); } catch (e) {}
    }
    const diskName = 'bg_' + Date.now() + '_' + name.replace(/[\\/:*?"<>|]/g, '_');
    fs.writeFileSync(path.join(upDir, diskName), req.file.buffer);
    DB.settings.loginBg = '/api/login-bg/' + diskName;
    saveDB();
    res.json({ ok: true, loginBg: DB.settings.loginBg });
  } catch (e) { res.status(500).json({ error: '上传失败：' + e.message }); }
});

// ---------- 静态前端 ----------
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  电网生产ERP（本地版）已启动`);
  console.log(`  ➜  本地访问: http://localhost:${PORT}`);
  console.log(`  ➜  默认账号: admin / admin123  (角色: 管理员)\n`);
});
