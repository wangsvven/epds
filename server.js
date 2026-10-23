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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 }, defParamCharset: 'utf8' });

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const PORT = process.env.PORT || 5173;

// 登录页默认背景（内置预设：草原雪山 / 冰川落日 / 层峦叠嶂）
const DEFAULT_LOGIN_BG = '/login-bg/valley.jpg';
// 旧版预设路径 → 新预设（升级时迁移，避免指向已删除的图）
const LEGACY_LOGIN_BG_MAP = {
  '/login-bg/ink-color.jpg': '/login-bg/valley.jpg',
  '/login-bg/ink-gray.jpg': '/login-bg/ice.jpg',
  '/login-bg/network.jpg': '/login-bg/ridge.jpg'
};

// ===== 数据模型 =====
// 业务私有集合统一采用逻辑删除（deleted 标记）
// 工作票自动化配置的四类数据源
const WT_COLLECTIONS = ['wtRules', 'wtTechMeasures', 'wtSafetyMeasures', 'wtHospitals'];
const ROLE_ADMIN = '超级用户';
function isAdmin(req) { return !!(req && req.user && req.user.role === ROLE_ADMIN); }

// ---------- 用户组与写权限 ----------
// 仅超级用户可维护账号；用户组决定「哪些模块可写」，未列出的模块一律只读。
const USER_GROUPS = ['超级用户', '资料员', '材料员', '班组长'];
const MODULE_NAMES = { projects: '项目列表', materials: '材料台账', plans: '计划管理', borrow: '借工管理', completion: '竣工资料', actualWorks: '工程实际施工', documents: '文档中心', users: '用户管理', settings: '全局设置' };
const ROLE_WRITE = {
  '超级用户': '*',
  '资料员': '*',
  '材料员': ['materials'],
  '班组长': ['planQuantities', 'actualWorks']
};
// 旧用户组 → 现有四组的迁移映射
const LEGACY_GROUP_MAP = { '管理员': '资料员' };
function normalizeUserGroup(g) {
  if (USER_GROUPS.includes(g)) return g;
  return LEGACY_GROUP_MAP[g] || '班组长';
}
// 班组长可填写的「工程实际施工量」字段（计划管理 · 当日计划工作量）
const PLAN_QTY_FIELDS = ['wlPole', 'wlLine1035', 'wlCable', 'wlRing', 'wlVacuum', 'wlTransformer', 'wlLine04'];
function userGroupOf(u) { return normalizeUserGroup((u && (u.userGroup || u.role)) || '班组长'); }
function writeModulesOf(u) {
  const w = ROLE_WRITE[userGroupOf(u)];
  return w === '*' ? ['*'] : (Array.isArray(w) ? w.slice() : []);
}
function canWriteModule(u, mod) {
  const w = writeModulesOf(u);
  return w.includes('*') || w.includes(mod);
}
function moduleOfPath(fp) {
  if (/^\/api\/projects(\/|$)/.test(fp)) return 'projects';
  if (/^\/api\/plans(\/|$)/.test(fp) || /^\/api\/workPlans(\/|$)/.test(fp)) return 'plans';
  if (/^\/api\/materials(\/|$)/.test(fp) || /^\/api\/materialRequisitions(\/|$)/.test(fp) || /^\/api\/materialImports(\/|$)/.test(fp) || /^\/api\/materialOutbound(\/|$)/.test(fp)) return 'materials';
  if (/^\/api\/borrowWorks(\/|$)/.test(fp)) return 'borrow';
  if (/^\/api\/completionDocuments(\/|$)/.test(fp)) return 'completion';
  if (/^\/api\/actualWorks(\/|$)/.test(fp)) return 'actualWorks';
  if (/^\/api\/documents(\/|$)/.test(fp) || /^\/api\/workticket(\/|$)/.test(fp)) return 'documents';
  if (/^\/api\/users(\/|$)/.test(fp) || /^\/api\/workers(\/|$)/.test(fp) || /^\/api\/contacts(\/|$)/.test(fp)) return 'users';
  if (/^\/api\/settings(\/|$)/.test(fp) || /^\/api\/annualPlans(\/|$)/.test(fp) || /^\/api\/substations(\/|$)/.test(fp) || /^\/api\/teams(\/|$)/.test(fp) || /^\/api\/materialCatalog(\/|$)/.test(fp) || /^\/api\/units(\/|$)/.test(fp)) return 'settings';
  return null;
}
function passwordStrong(p) {
  let n = 0;
  if (/[a-z]/.test(p)) n++;
  if (/[A-Z]/.test(p)) n++;
  if (/\d/.test(p)) n++;
  if (/[^A-Za-z0-9]/.test(p)) n++;
  return n >= 3;
}
// 业务记录可见性：仅过滤已逻辑删除的行
function aliveFilter() { return rec => !!rec && !rec.deleted; }

// ---------- 本地 JSON 存储 ----------

function seedDB() {
  const now = new Date().toISOString();
  // 全新实例：仅创建唯一超级用户与空数据结构，不含任何演示/模板业务数据
  const seeded = {
    // 企业信息：全新实例为空，由用户在「全局设置 → 网站设置」自行填写
    tenant: { name: '', shortName: '' },
    // 仅保留唯一超级用户；姓名/邮箱/电话等由用户自行维护
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
      categories: ['规范文件', '工作票模板', '检查表', '奥维地图', '危险点'],
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
    // 工作票自动化配置数据源：初始为空，由管理员/资料员维护
    wtRules: [],            // 作业内容匹配规则
    wtTechMeasures: [],     // 施工技术措施
    wtSafetyMeasures: [],   // 施工安全措施
    wtDefaultMeasures: { tech: [], safety: [], savedAt: '' }, // 默认模板快照（「载入默认」用）
    wtHospitals: [],        // 医院联系方式
    actualWorks: [],        // 工程实际施工量（日期 / 项目 / 工作类型 提交记录）
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
      loginBg: DEFAULT_LOGIN_BG,
      // 背景铺展方式：cover(填充) / contain(适应) / stretch(拉伸) / tile(平铺) / center(居中)
      loginBgMode: 'cover',
      // 背景旋转角度：0 / 90 / 180 / 270（竖图/方向错误的照片可转正）
      loginBgRotate: 0,
      // 自定义上传背景的占位元数据（LQIP 缩略图 + 平均色），用于首帧避免黑闪
      loginBgMeta: null,
      // 建管 / 实施单位：留空，由用户自行设置
      unitBuildCity: '',
      unitBuildCounty: '',
      unitExecCity: '',
      unitExecCounty: '',
      // 默认应急医院（资料库分组「默认应急医院」）
      emergencyHospital: { name: '', phone: '' },
      // 首次使用初始化向导是否已完成（企业名称等基础设置）
      initialized: false
    },
    // 版本标记：全新实例即 V2 模型，避免 migrateDB 用旧演示模型覆盖空集合
    projectsV2: true,
    materialsV2: true,
    requisitionsV2: true,
    tokens: {} // token -> username  (运行时内存)
  };
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

// 修复历史上传文件名乱码：浏览器按 UTF-8 发送 filename，旧版 multer 以 latin1 解码
function repairUploadName(s) {
  if (!s || typeof s !== 'string') return s;
  if (!/[\u00c0-\u00ff]/.test(s)) return s;
  try {
    const t = Buffer.from(s, 'latin1').toString('utf8');
    if (t === s || t.includes('\ufffd')) return s;
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t)) return t;
  } catch (e) {}
  return s;
}

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
    DB.settings.loginBg = DEFAULT_LOGIN_BG;
  }
  // 设置：旧版预设路径 → 新预设（避免升级后指向已删除的图）
  if (DB.settings && LEGACY_LOGIN_BG_MAP[DB.settings.loginBg]) {
    DB.settings.loginBg = LEGACY_LOGIN_BG_MAP[DB.settings.loginBg];
    DB.settings.loginBgMeta = null;
  }
  // 设置：补背景铺展方式与旋转角度
  if (DB.settings && !DB.settings.loginBgMode) {
    DB.settings.loginBgMode = 'cover';
  }
  if (DB.settings && DB.settings.loginBgMode && !['cover', 'contain', 'stretch', 'tile', 'center'].includes(DB.settings.loginBgMode)) {
    DB.settings.loginBgMode = 'cover';
  }
  if (DB.settings && ![0, 90, 180, 270].includes(Number(DB.settings.loginBgRotate))) {
    DB.settings.loginBgRotate = 0;
  }
  if (DB.settings && DB.settings.loginBgMeta === undefined) {
    DB.settings.loginBgMeta = null;
  }
  // 设置：默认应急医院（资料库「默认应急医院」分组，单条配置）
  if (DB.settings && !DB.settings.emergencyHospital) {
    DB.settings.emergencyHospital = { name: '', phone: '' };
  }
  // 资料库：医院联系方式补「作业地址匹配词」字段（旧记录无该字段）
  if (Array.isArray(DB.wtHospitals)) {
    DB.wtHospitals.forEach(h => {
      if (h.area === undefined) h.area = '';
      if (h.deleted === undefined) h.deleted = false;
    });
  }
  // 设置：补初始化标记（旧实例默认视为已初始化，不弹首次向导；新实例为 false）
  if (DB.settings && DB.settings.initialized === undefined) {
    DB.settings.initialized = false;
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
    // 文档资源分类：原「未分类」统一更名为「危险点」（该分类下的文件会自动解析入企业危险点库）
    if (!Array.isArray(DB.documents.categories) || !DB.documents.categories.length) {
      DB.documents.categories = ['规范文件', '工作票模板', '检查表', '奥维地图', '危险点'];
    } else {
      DB.documents.categories = DB.documents.categories.map(c => (c === '未分类' ? '危险点' : c));
      if (!DB.documents.categories.includes('危险点')) DB.documents.categories.push('危险点');
    }
    if (!Array.isArray(DB.documents.files)) DB.documents.files = [];
    DB.documents.files.forEach(f => { if (f && f.category === '未分类') f.category = '危险点'; });
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
    DB.materials.forEach(m => { const s = materialStatus(m); if (m.status !== s) m.status = s; });
  }
  // ---------- 数据模型迁移 ----------
  // 0) 级联删除补漏：所属项目已被逻辑删除的材料 → 一并逻辑删除（防止删项目前的存量数据残留）
  if (Array.isArray(DB.materials) && Array.isArray(DB.projects)) {
    const deadProjectNames = new Set(DB.projects.filter(p => p.deleted).map(p => p.name));
    DB.materials.forEach(m => { if (!m.deleted && m.project && deadProjectNames.has(m.project)) m.deleted = true; });
  }
  // 1) 清理历史多租户残留集合（业务空间 / 团队 / 成员归属 / 审计日志）
  delete DB.spaces; delete DB.bizTeams; delete DB.teamMembers; delete DB.auditLogs;
  // 2) 用户模型对齐原版截图字段：补 loginName/email/userGroup；旧用户组迁移到四组（超级用户/资料员/材料员/班组长）
  if (Array.isArray(DB.users)) {
    DB.users.forEach(u => {
      if (!u.loginName) u.loginName = u.username;
      if (u.email === undefined) u.email = '';
      const isAdm = u.role === ROLE_ADMIN || u.username === 'admin';
      if (!u.userGroup || !USER_GROUPS.includes(u.userGroup)) {
        u.userGroup = isAdm ? '超级用户' : normalizeUserGroup(u.userGroup || u.role);
      }
      u.role = u.userGroup;
    });
  }
  // 3) 工作票自动化配置集合兜底
  WT_COLLECTIONS.forEach(k => { if (!Array.isArray(DB[k])) DB[k] = []; });
  // 工程实际施工量集合兜底
  if (!Array.isArray(DB.actualWorks)) DB.actualWorks = [];
  // 默认模板快照结构兜底（施工技术/安全措施原文）
  if (!DB.wtDefaultMeasures || typeof DB.wtDefaultMeasures !== 'object') DB.wtDefaultMeasures = { tech: [], safety: [], savedAt: '' };
  if (!Array.isArray(DB.wtDefaultMeasures.tech)) DB.wtDefaultMeasures.tech = [];
  if (!Array.isArray(DB.wtDefaultMeasures.safety)) DB.wtDefaultMeasures.safety = [];
  if (DB.wtDefaultMeasures.savedAt === undefined) DB.wtDefaultMeasures.savedAt = '';
  if (DB.wtDefaultMeasures.cleared === undefined) DB.wtDefaultMeasures.cleared = false;
  // 4) 修复历史上传文件名乱码（仅修展示名，磁盘 path 保持不变）
  if (DB.documents && Array.isArray(DB.documents.files)) {
    DB.documents.files.forEach(f => { const n = repairUploadName(f.name); if (n !== f.name) f.name = n; });
  }
  if (DB.documents && DB.documents.surveyTemplate && DB.documents.surveyTemplate.name) {
    const n = repairUploadName(DB.documents.surveyTemplate.name);
    if (n !== DB.documents.surveyTemplate.name) DB.documents.surveyTemplate.name = n;
  }
  if (Array.isArray(DB.projects)) {
    DB.projects.forEach(p => (p.files || []).forEach(f => { const n = repairUploadName(f.name); if (n !== f.name) f.name = n; }));
  }
  if (Array.isArray(DB.materialImports)) {
    DB.materialImports.forEach(x => { const n = repairUploadName(x.fileName); if (n !== x.fileName) x.fileName = n; });
  }
  // 5) 导入批次 ↔ 材料关联补齐：新导入直接写 importId / materialIds；历史批次按批次号内嵌的毫秒时间戳回填
  //    （导入时批次与材料在同一秒内创建，故以「同一秒」为主匹配，退化时放宽到 ±2s）
  if (Array.isArray(DB.materialImports) && Array.isArray(DB.materials)) {
    DB.materialImports.forEach(b => {
      if (Array.isArray(b.materialIds) && b.materialIds.length) return;
      const epoch = Number(String(b.batch || '').replace(/^IMP/, ''));
      if (!isFinite(epoch) || epoch <= 0) return;
      const sec = Math.floor(epoch / 1000);
      const sameSec = m => {
        if (m.importId) return false;
        const t = Date.parse(m.createdAt || '');
        return isFinite(t) && Math.floor(t / 1000) === sec;
      };
      let hit = DB.materials.filter(sameSec);
      if (!hit.length) {
        hit = DB.materials.filter(m => {
          if (m.importId) return false;
          const t = Date.parse(m.createdAt || '');
          return isFinite(t) && Math.abs(t - epoch) <= 2000;
        });
      }
      if (!hit.length) return;
      hit.forEach(m => { m.importId = b.id; });
      b.materialIds = hit.map(m => m.id);
    });
  }
  // 6) 一致性修复（一次性）：批次已删除、但该批次材料仍存活（旧接口只删批次不删材料）→ 连带逻辑删除
  if (!DB.batchCascadeV1 && Array.isArray(DB.materialImports) && Array.isArray(DB.materials)) {
    DB.materialImports.filter(b => b.deleted).forEach(b => {
      const ids = new Set((Array.isArray(b.materialIds) && b.materialIds.length)
        ? b.materialIds
        : DB.materials.filter(m => m.importId === b.id).map(m => m.id));
      DB.materials.forEach(m => {
        if (m.deleted || !ids.has(m.id)) return;
        m.deleted = true; m.deletedAt = nowISO(); m.deletedBy = 'system:迁移修复（批次已删除）';
      });
      if (!b.deletedAt) b.deletedAt = nowISO();
    });
    DB.batchCascadeV1 = true;
  }
  saveDB();
}
migrateDB();

// 企业危险点库首次为空时，自动从「规范文件 危险点.xlsx」灌入，使其与文档中心的规范文件关联
// 风险大类（与作业计划「风险因素」下拉的 9 个分类一一对应）；按关键词把规范文件明细归入对应大类
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

// 危险点库统一导入：首个工作表 A 列危险点、C 列控制措施；按「危险点+措施」去重
function importHazardRows(rows) {
  const list = (rows || []).slice(1)
    .map(r => [String(r[0] || '').trim(), String(r[2] || '').trim()])
    .filter(([a, b]) => a || b);
  const existing = new Set(DB.documents.hazardLibrary.map(h => h.hazard + '||' + h.measure));
  let maxSort = DB.documents.hazardLibrary.reduce((m, h) => Math.max(m, h.sort || 0), -1);
  let added = 0, skipped = 0;
  for (const [hazard, measure] of list) {
    if (!hazard || !measure) { skipped++; continue; }
    const key = hazard + '||' + measure;
    if (existing.has(key)) { skipped++; continue; }
    existing.add(key);
    DB.documents.hazardLibrary.push({ id: genId('h'), hazard, measure, category: categorize(hazard), sort: ++maxSort });
    added++;
  }
  return { added, skipped, total: list.length };
}
// 解析 Excel/CSV 缓冲区并入库（文档中心「危险点」分类上传/移入时自动解析）
function parseHazardFromBuffer(buffer, name) {
  const nm = String(name || '');
  let rows;
  if (/\.csv$/i.test(nm)) rows = parseCSVBuffer(buffer);
  else if (/\.(xlsx|xls)$/i.test(nm)) {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  } else {
    return { unsupported: true, added: 0, skipped: 0, total: 0 };
  }
  const r = importHazardRows(rows);
  saveDB();
  return r;
}
function resolveDocPath(p) {
  if (!p) return null;
  if (p.startsWith('assets/')) return path.join(__dirname, p);
  if (p.startsWith('uploads/')) return path.join(__dirname, 'data', p);
  return null;
}
// 解析已上传的文档文件并入库
function parseHazardFromFile(file) {
  const abs = resolveDocPath(file && file.path);
  if (!abs || !fs.existsSync(abs)) return { error: '文件不存在，无法解析', added: 0, skipped: 0 };
  return parseHazardFromBuffer(fs.readFileSync(abs), (file && file.name) || '');
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

// app.use('/api') 挂载后 req.path 已去掉 /api 前缀，故一律用原始完整路径判断
function fullPath(req) { return (req.originalUrl || req.path || '').split('?')[0]; }

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
  // 写操作权限：未授权模块返回 403（本人改姓名/电话/密码、班组长填施工量除外）
  const method = String(req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const fp = fullPath(req);
    if (fp !== '/api/login' && fp !== '/api/health') {
      const isSelfProfile = method === 'PUT' && fp === '/api/users/' + user.id;
      const isLeaderQty = method === 'PUT' && userGroupOf(user) === '班组长' && /^\/api\/workPlans\/[^/]+\/quantities$/.test(fp);
      if (!isSelfProfile && !isLeaderQty) {
        const mod = moduleOfPath(fp);
        if (mod && !canWriteModule(user, mod)) {
          return res.status(403).json({ error: '当前用户组「' + userGroupOf(user) + '」无权修改' + (MODULE_NAMES[mod] || '该模块') + '，仅可查看' });
        }
      }
    }
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
  saveDB();
  res.json({ token, user: { id: user.id, name: user.name, role: user.role, username: user.username } });
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: DB.settings.systemName }));
// favicon：避免浏览器默认请求 /favicon.ico 触发 404 控制台错误
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---------- 登录页公开配置（无需登录：登录页需在鉴权前取背景图 / 系统名） ----------
app.get('/api/public-config', (req, res) => {
  res.json({
    systemName: DB.settings.systemName || '',
    companyName: DB.settings.companyName || '',
    loginBg: DB.settings.loginBg || DEFAULT_LOGIN_BG
  });
});
// 本地上传的登录页背景（无需登录；仅允许读取 data/uploads/login-bg 目录，防目录穿越）
app.get('/api/login-bg/:name', (req, res) => {
  const name = path.basename(String(req.params.name || ''));
  if (!name) return res.status(400).json({ error: '参数错误' });
  const file = path.join(__dirname, 'data', 'uploads', 'login-bg', name);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '背景不存在' });
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(file);
});

app.use('/api', authMiddleware);

app.get('/api/me', (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u.id, name: u.name, role: userGroupOf(u), rawRole: u.role, username: u.username,
      isAdmin: isAdmin(req),
      permissions: { group: userGroupOf(u), writeModules: writeModulesOf(u) }
    },
    tenant: DB.tenant, settings: DB.settings
  });
});

// ---------- 账号（登录账号列表） ----------
app.get('/api/users', (req, res) => {
  res.json(DB.users.map(u => ({
    id: u.id, username: u.username, loginName: u.loginName || u.username, email: u.email || '',
    name: u.name, role: u.role, userGroup: userGroupOf(u), phone: u.phone || '',
    createdAt: u.createdAt, status: (u.status || 'active') === 'disabled' ? '停用' : '启用',
    isSelf: u.username === req.user.username
  })));
});

app.post('/api/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可新增账号' });
  const b = req.body || {};
  const loginName = String(b.loginName || b.username || '').trim();
  const email = String(b.email || '').trim();
  const name = String(b.name || '').trim();
  const password = String(b.password || '').trim();
  const userGroup = USER_GROUPS.includes(b.userGroup) ? b.userGroup : '班组长';
  if (!loginName) return res.status(400).json({ error: '请填写登录名' });
  if (!email) return res.status(400).json({ error: '请填写邮箱' });
  if (!password) return res.status(400).json({ error: '请填写密码' });
  if (password.length < 8 || password.length > 32) return res.status(400).json({ error: '密码需为 8-32 位' });
  if (!passwordStrong(password)) return res.status(400).json({ error: '密码需包含大写/小写/数字/符号中的至少三类' });
  if (DB.users.some(u => u.username === loginName)) return res.status(400).json({ error: '该登录名已存在' });
  if (DB.users.some(u => u.email === email)) return res.status(400).json({ error: '该邮箱已被使用' });
  const user = {
    id: genId('u'), username: loginName, loginName, email, name,
    phone: String(b.phone || ''), password, role: userGroup, userGroup,
    createdAt: nowISO(), status: 'active'
  };
  DB.users.push(user);
  saveDB();
  res.json({ id: user.id, username: loginName, loginName, email, name, phone: user.phone, role: user.role, userGroup, status: 'active' });
});

app.put('/api/users/:id', (req, res) => {
  const u = DB.users.find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: '未找到用户' });
  const b = req.body || {};
  const adm = isAdmin(req);
  if (!adm && u.username !== req.user.username) return res.status(403).json({ error: '无权修改其他账号' });
  if (b.name !== undefined) u.name = String(b.name);
  if (b.phone !== undefined) u.phone = String(b.phone || '');
  if (b.email !== undefined) u.email = String(b.email || '').trim();
  if (b.password) {
    const pwd = String(b.password);
    if (pwd.length < 8 || pwd.length > 32) return res.status(400).json({ error: '密码需为 8-32 位' });
    if (!passwordStrong(pwd)) return res.status(400).json({ error: '密码需包含大写/小写/数字/符号中的至少三类' });
    u.password = pwd;
  }
  if (b.status && (adm || u.username !== req.user.username)) u.status = b.status === 'disabled' ? 'disabled' : 'active';
  if (adm && b.userGroup && u.username !== 'admin' && USER_GROUPS.includes(b.userGroup)) { u.userGroup = b.userGroup; u.role = u.userGroup; }
  saveDB();
  res.json({ id: u.id, username: u.username, loginName: u.loginName || u.username, email: u.email || '', name: u.name, role: u.role, userGroup: u.userGroup, phone: u.phone, status: u.status });
});

app.delete('/api/users/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可删除账号' });
  const idx = DB.users.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到用户' });
  if (DB.users[idx].username === 'admin') return res.status(400).json({ error: '内置超级用户不可删除' });
  DB.users.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// ---------- 通用 CRUD 工厂 ----------
// opts.biz：true=业务集合（列表/读取仅返回未逻辑删除的行）；false=全局字典（字典/设置等）
// opts.soft：true=删除走逻辑删除（置 deleted）；false=物理删除（默认对全局字典）
function crud(collection, prefix, opts) {
  opts = opts || {};
  const biz = opts.biz !== false;
  const soft = opts.soft !== false ? true : false;
  const base = '/api/' + prefix;
  app.get(base, (req, res) => {
    const data = biz ? DB[collection].filter(aliveFilter()) : DB[collection];
    res.json(data);
  });
  app.get(base + '/:id', (req, res) => {
    const item = DB[collection].find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: '未找到' });
    if (biz && item.deleted) return res.status(404).json({ error: '未找到' });
    res.json(item);
  });
  app.post(base, (req, res) => {
    const item = { id: genId(prefix.slice(0, 2)), createdAt: nowISO(), ...req.body };
    if (biz) { item.deleted = false; }
    DB[collection].push(item);
    saveDB();
    res.json(item);
  });
  app.put(base + '/:id', (req, res) => {
    const idx = DB[collection].findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    const cur = DB[collection][idx];
    if (biz && cur.deleted) return res.status(404).json({ error: '未找到' });
    const merged = { ...cur, ...req.body, id: req.params.id };
    if (biz) { merged.deleted = cur.deleted; }
    DB[collection][idx] = merged;
    saveDB();
    res.json(merged);
  });
  app.delete(base + '/:id', (req, res) => {
    const idx = DB[collection].findIndex(x => x.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: '未找到' });
    const cur = DB[collection][idx];
    if (biz && cur.deleted) return res.status(404).json({ error: '未找到' });
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
      deleted: false
    }));
    DB.workers.push(...added);
    saveDB();
    res.json({ ok: true, added: added.length });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

app.get('/api/workers/export', (req, res) => {
  const header = ['姓名', '身份证号', '电话号码', '身份', '班组', '证件类型', '准入有效期', '状态'];
  const rows = DB.workers.filter(aliveFilter()).map(w => [
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

// ---------- 外部通讯录：导入/导出（同样须在通用 CRUD 之前注册） ----------
// 字段：部门 dept / 姓名 name / 职务 post / 手机 phone / 移动短号 shortNo
// 兼容旧字段：unit → 部门、remark → 备注
const CONTACT_HEADER_MAP = {
  '部门': 'dept', '单位': 'dept', '姓名': 'name', '职务': 'post',
  '手机': 'phone', '电话': 'phone', '手机号': 'phone',
  '移动短号': 'shortNo', '短号': 'shortNo', '备注': 'remark'
};
function contactDept(c) { return c.dept || c.unit || ''; }

app.get('/api/contacts/export', (req, res) => {
  const header = ['部门', '姓名', '职务', '手机', '移动短号'];
  const rows = DB.contacts.filter(aliveFilter()).map(c => [
    contactDept(c), c.name || '', c.post || '', c.phone || '', c.shortNo || ''
  ]);
  const wb = xlsx.utils.book_new();
  // sheet 名固定为「员工」，导出文件可直接再次导入
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([header, ...rows]), '员工');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.xlsx"');
  res.send(buf);
});

app.post('/api/contacts/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    let rows;
    if (/\.csv$/i.test(req.file.originalname || '')) {
      rows = parseCSVBuffer(req.file.buffer);
    } else {
      const wb = xlsx.read(req.file.buffer, { type: 'buffer' });
      // 优先取名为「员工」的 sheet，否则取第一个
      const sheetName = wb.SheetNames.find(n => String(n).trim() === '员工') || wb.SheetNames[0];
      const ws = sheetName ? wb.Sheets[sheetName] : null;
      if (!ws) return res.status(400).json({ error: '文件中没有可读取的工作表' });
      rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }
    if (!rows.length) return res.status(400).json({ error: '文件内容为空' });

    // 识别表头行：首个含已知表头文字的行；识别不到则按位置解析（部门/姓名/职务/手机/移动短号）
    let headerIdx = -1, idxMap = null;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const cells = (rows[i] || []).map(c => String(c || '').trim());
      const hit = cells.filter(c => CONTACT_HEADER_MAP[c]);
      if (hit.length >= 2) {
        headerIdx = i; idxMap = {};
        cells.forEach((c, ci) => { const f = CONTACT_HEADER_MAP[c]; if (f && idxMap[f] === undefined) idxMap[f] = ci; });
        break;
      }
    }
    const fields = ['dept', 'name', 'post', 'phone', 'shortNo'];
    if (!idxMap) { idxMap = {}; fields.forEach((f, i) => { idxMap[f] = i; }); }

    const errors = [];
    const parsed = [];
    rows.forEach((r, i) => {
      if (i <= headerIdx) return;
      const get = f => String((idxMap[f] !== undefined && r[idxMap[f]] !== undefined) ? r[idxMap[f]] : '').trim();
      const dept = get('dept'), name = get('name'), post = get('post'), phone = get('phone'), shortNo = get('shortNo');
      if (!dept && !name && !post && !phone && !shortNo) return; // 空行
      if (!name) { errors.push(`第${i + 1}行：姓名为空`); return; }
      parsed.push({ dept, name, post, phone, shortNo });
    });
    if (errors.length) {
      return res.status(400).json({ error: `存在错误，整批不导入。${errors.slice(0, 5).join('；')}${errors.length > 5 ? `……共${errors.length}处` : ''}` });
    }
    if (!parsed.length) return res.status(400).json({ error: '未解析到有效联系人（姓名列不能为空）' });

    // 覆盖式导入：整表替换为本次导入的通讯录
    const replaced = DB.contacts.filter(c => !c.deleted).length;
    DB.contacts = [];
    const added = parsed.map(p => ({
      id: genId('c'), createdAt: nowISO(),
      dept: p.dept, name: p.name, post: p.post, phone: p.phone, shortNo: p.shortNo,
      deleted: false
    }));
    DB.contacts.push(...added);
    saveDB();
    res.json({ ok: true, imported: added.length, replaced });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 项目详情：资料管理（设计图纸/奥维地图/现场照片/规范图纸） ----------
// 需在通用 CRUD 之前注册：DELETE /:id 覆盖工厂版本以清理上传文件
// 项目删除：级联逻辑删除项目下全部关联业务数据（材料/计划/借工/竣工资料/领料单/出库单/资料文件）
// 须注册在通用 CRUD 工厂之前以覆盖默认删除
// ---------- 删除前置：依赖引用检查（项目） ----------
// 规则：只要还有其它业务数据引用/关联该项目（含其子项目名称），一律拒绝删除，由用户先清理引用数据
// 返回 [{ label, count }]；为空数组表示无引用、可安全删除
function projectRefsOf(p) {
  const names = [p.name].concat((p.subProjects || []).map(s => (s && s.name) || '')).filter(Boolean);
  const inNames = v => names.includes(String(v || ''));
  const refs = [];
  const add = (label, rows) => { if (rows.length) refs.push({ label, count: rows.length }); };
  add('材料清单', (DB.materials || []).filter(m => !m.deleted && inNames(m.project)));
  add('作业计划', (DB.workPlans || []).filter(w => !w.deleted && (inNames(w.project) || inNames(w.subProject))));
  add('月度计划', (DB.plans || []).filter(x => !x.deleted && (inNames(x.project) || inNames(x.subProject))));
  add('材料出库单', (DB.materialOutbound || []).filter(o => !o.deleted && inNames(o.project)));
  add('领料单', (DB.materialRequisitions || []).filter(r => {
    if (r.deleted) return false;
    if (Array.isArray(r.projects) && r.projects.some(n => inNames(n))) return true;
    return (r.items || []).some(it => inNames(it.project));
  }));
  add('借工记录', (DB.borrowWorks || []).filter(b => !b.deleted && (b.projectId === p.id || inNames(b.project))));
  add('竣工资料', (DB.completionDocuments || []).filter(c => !c.deleted && (c.projectId === p.id || inNames(c.project))));
  return refs;
}
app.delete('/api/projects/:id', (req, res) => {
  const p = DB.projects.find(x => x.id === req.params.id);
  if (!p || p.deleted) return res.status(404).json({ error: '未找到项目' });
  // 依赖引用校验：有引用则直接拒绝，不做级联删除
  const refs = projectRefsOf(p);
  if (refs.length) {
    return res.status(409).json({ error: '该项目已被其他数据引用，无法删除', refs });
  }
  p.deleted = true;
  // 项目自带资料文件随项目逻辑删除（磁盘文件保留）
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
// 项目删除走通用 CRUD 工厂（逻辑删除，见下方 crud 注册）；此处不再单独物理删除
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
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '已作废') return res.status(400).json({ error: '仅已作废的领料单可删除，请先作废' });
  rec.deleted = true; // 逻辑删除（保留记录，符合逻辑删除策略）
  saveDB();
  res.json({ ok: true });
});

// ---------- 出库管理（按工程出库 / 归还 / 作废补回） ----------
// 库存口径：可用库存 = 累计入库 − 净出库（净出库 = 有效单累计领取 − 累计归还；作废单自动补回）
function outboundStats(project) {
  const stats = {};
  DB.materialOutbound.forEach(o => {
    if (o.deleted || o.project !== project || o.status !== '有效') return;
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
  const stats = outboundStats(project);
  const rows = [];
  DB.materials.filter(aliveFilter()).forEach(m => {
    if (m.project !== project) return;
    const inQty = roundQty(m.qtyArrived);
    if (inQty <= 0) return;
    const st = stats[m.id] || { taken: 0, returned: 0 };
    const net = roundQty(st.taken - st.returned);
    const available = roundQty(Math.max(0, inQty - net));
    if (available <= 0) return; // 已全部出库的材料不再出现在可出库列表
    const hasRecords = DB.materialOutbound.some(o => !o.deleted && o.project === project && (o.items || []).some(it => it.materialId === m.id));
    rows.push({ id: m.id, description: m.description, code: m.code, unit: m.unit, inQty, taken: st.taken, returned: st.returned, net, available, hasRecords });
  });
  res.json(rows);
});
app.get('/api/materialOutbound/orders', (req, res) => {
  const project = String(req.query.project || '');
  const list = DB.materialOutbound.filter(o => !o.deleted && (!project || o.project === project))
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
  const stats = outboundStats(project);
  const finalItems = [];
  for (const e of items) {
    const m = DB.materials.find(x => x.id === e.materialId && !x.deleted);
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
  const seq = DB.materialOutbound.filter(o => !o.deleted && String(o.outNo || '').startsWith('OUT-' + dateTag + '-')).length + 1;
  const rec = {
    id: genId('ob'), outNo: 'OUT-' + dateTag + '-' + String(seq).padStart(6, '0'),
    project, receiver, status: '有效', createdAt: fmtNow(),
    items: finalItems, returns: [], compensated: 0,
    deleted: false
  };
  DB.materialOutbound.unshift(rec);
  saveDB();
  res.json({ ok: true, data: rec });
});
app.put('/api/materialOutbound/:id/return', (req, res) => {
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
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
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
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
  const rec = DB.materialOutbound.find(x => x.id === req.params.id && !x.deleted);
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

// 班组长专用：仅填写「当日计划工作量」7 项（工程实际施工量）
app.put('/api/workPlans/:id/quantities', (req, res) => {
  const p = (DB.workPlans || []).find(x => x.id === req.params.id && !x.deleted);
  if (!p) return res.status(404).json({ error: '未找到计划' });
  const b = req.body || {};
  PLAN_QTY_FIELDS.forEach(k => { if (b[k] !== undefined) p[k] = String(b[k] == null ? '' : b[k]).trim(); });
  p.quantitiesUpdatedAt = nowISO();
  p.quantitiesUpdatedBy = req.user.name || req.user.username;
  saveDB();
  res.json(p);
});

// 删除导入批次（仅超级用户）：批次记录逻辑删除，且该批次导入的材料一并逻辑删除（材料明细同步消失）
// 说明：领料单/出库单的物料信息均为快照（code/description/unit/project），历史单据不受影响
app.delete('/api/materialImports/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: '仅超级用户可以删除导入批次' });
  const b = DB.materialImports.find(x => x.id === req.params.id && !x.deleted);
  if (!b) return res.status(404).json({ error: '未找到该导入批次' });
  const ids = new Set((Array.isArray(b.materialIds) && b.materialIds.length)
    ? b.materialIds
    : DB.materials.filter(m => m.importId === b.id).map(m => m.id));
  if (!ids.size) return res.status(400).json({ error: '该批次未记录关联材料（历史导入数据），无法整批删除' });
  // 嵌套校验：批次内材料若已被领料单/出库单引用，整批拒绝（避免绕过单条材料的删除校验）
  const blockedRows = DB.materials.filter(m => !m.deleted && ids.has(m.id) && materialRefsOf(m).length);
  if (blockedRows.length) {
    const agg = {};
    blockedRows.forEach(m => materialRefsOf(m).forEach(r => { agg[r.label] = (agg[r.label] || 0) + r.count; }));
    return res.status(409).json({
      error: '该批次中有 ' + blockedRows.length + ' 条材料已被其他数据引用，无法删除',
      refs: Object.keys(agg).map(label => ({ label, count: agg[label] })),
      blockedMaterials: blockedRows.length
    });
  }
  let deletedMaterials = 0;
  DB.materials.forEach(m => {
    if (m.deleted || !ids.has(m.id)) return;
    m.deleted = true; m.deletedAt = nowISO(); m.deletedBy = (req.user && (req.user.name || req.user.username)) || '';
    deletedMaterials++;
  });
  b.deleted = true;
  b.deletedAt = nowISO();
  b.deletedBy = (req.user && (req.user.name || req.user.username)) || '';
  saveDB();
  res.json({ ok: true, deletedMaterials, fileName: b.fileName });
});

// 简单集合（直接 CRUD）
// 业务集合：逻辑删除（projects 自定义删除见文件端点；此处提供标准 CRUD）
['projects', 'plans', 'borrowWorks', 'completionDocuments', 'materialRequisitions', 'materialImports', 'materialOutbound', 'workers', 'contacts', 'workPlans'].forEach(c => {
  crud(c, c, { biz: true, soft: true });
});
// 全局字典/系统资源：物理删除（年度计划/供电所/班组/材料目录/单位维护）
['annualPlans', 'substations', 'materialCatalog', 'teams', 'units'].forEach(c => {
  crud(c, c, { biz: false, soft: false });
});
// 用户账号（users）走自定义端点，不在此注册

// ---------- 材料明细（工程材料清单） ----------
// 来源类型为固定枚举（与原系统一致），新增/编辑/导入均强制校验
const SOURCE_TYPES = ['ERP采购申请', '甲供材料', '库存调拨', '乙供/自购', '运检项目'];

app.get('/api/materials', (req, res) => res.json(DB.materials.filter(aliveFilter()).map(withGen)));
app.get('/api/materials/:id', (req, res) => {
  const it = DB.materials.find(x => x.id === req.params.id);
  if (!it || it.deleted) return res.status(404).json({ error: '未找到' });
  res.json(withGen(it));
});
// 已生成领料单数量 = 历史累计生成量（同空间未作废领料单中该物料的领料数量合计，含已入库的）
// 待入库/部分到库/已入库 均计入；已作废 → 不计入（作废已冲销）
function qtyGeneratedOf(m) {
  let g = 0;
  DB.materialRequisitions.forEach(r => {
    if (r.deleted || r.status === '已作废') return;
    (r.items || []).forEach(it => {
      if (it.materialId === m.id) g += Number(it.qty) || 0;
    });
  });
  return roundQty(g);
}
// 在途未入库余量 = 同空间待入库/部分到库领料单中该物料尚未入库的数量合计（用于计算可继续领料）
function qtyOutstandingOf(m) {
  let o = 0;
  DB.materialRequisitions.forEach(r => {
    if (r.deleted) return;
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
  const gen = qtyGeneratedOf(m);
  const canGen = roundQty(Math.max(0, m.qtyNotArrived - qtyOutstandingOf(m)));
  return { ...m, qtyGenerated: gen, qtyCanGen: canGen, status: materialStatus(m) };
}
function materialStatus(m) {
  if (Number(m.qtyRequired) > 0 && m.qtyArrived >= m.qtyRequired) return '全部到库';
  if (m.qtyArrived > 0) return '部分到库'; // 已有入库数量时到货情况优先（可继续领料仍按未到余量-已生成计算）
  if (qtyGeneratedOf(m) > 0) return '已生成领料单'; // 未入库但有领料单在途（剩余量仍可继续领料）
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
  item.deleted = false;
  DB.materials.push(item);
  saveDB();
  res.json(item);
});
app.put('/api/materials/:id', (req, res) => {
  const idx = DB.materials.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const old = DB.materials[idx];
  if (old.deleted) return res.status(404).json({ error: '未找到' });
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
// 材料依赖引用检查：被领料单 / 出库单引用时不允许删除
// 口径：只算未删除且未作废的单据（作废单已冲销，物料明细仍保存编码/描述/单位快照，删材料不会影响单据展示）
function materialRefsOf(m) {
  const refs = [];
  const hit = (docs) => (docs || []).filter(d => {
    if (d.deleted || d.status === '已作废') return false;
    return (d.items || []).some(it => it && it.materialId === m.id);
  });
  const reqs = hit(DB.materialRequisitions);
  if (reqs.length) refs.push({ label: '材料领料单', count: reqs.length });
  const outs = hit(DB.materialOutbound);
  if (outs.length) refs.push({ label: '材料出库单', count: outs.length });
  return refs;
}
app.delete('/api/materials/:id', (req, res) => {
  const idx = DB.materials.findIndex(x => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const cur = DB.materials[idx];
  if (cur.deleted) return res.status(404).json({ error: '未找到' });
  // 依赖引用校验：有引用则直接拒绝（不做级联删除）
  const refs = materialRefsOf(cur);
  if (refs.length) {
    return res.status(409).json({ error: '该物料已被其他数据引用，无法删除', refs });
  }
  cur.deleted = true; // 逻辑删除（业务私有数据，重置/删除走逻辑标记）
  cur.deletedAt = nowISO();
  cur.deletedBy = (req.user && (req.user.name || req.user.username)) || '';
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
    const batchId = genId('im'); // 先定批次 id，材料上直接写入 importId，保证可整批删除
    const added = parsed.map(r => {
      const item = {
        id: genId('m'), createdAt: nowISO(), importId: batchId,
        project: r.project, description: r.description,
        qtyRequired: r.qty, qtyArrived: 0, qtyNotArrived: r.qty,
        unit: r.unit, code: r.code, orderNo: r.orderNo, source: r.source,
        sourceNote: '', inWeeklyPlan: true, modifyReason: '', modifiedAt: ''
      };
      item.status = materialStatus(item);
      item.deleted = false;
      DB.materials.push(item);
      return item;
    });
    // 记录导入批次（供「导入批次」页签展示）：项目归属 / 行数（总/匹配/跳过）/ 调整数 / 备注
    const projects = [...new Set(parsed.map(r => r.project))];
    const batch = {
      id: batchId, batch: 'IMP' + Date.now(), fileName: name,
      project: projects.length === 1 ? projects[0] : projects.join('、'),
      rowsTotal: parsed.length + skippedEmpty, rowsMatched: parsed.length, rowsSkipped: skippedEmpty,
      adjusted: 0, adjustments: [],
      rows: added.length, materialIds: added.map(x => x.id),
      importedBy: req.user.name, importedAt: fmtNow(), status: '成功', remark: '-',
      deleted: false
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
  const list = Array.isArray(body.items) && body.items.length
    ? body.items.map(x => ({ id: x.id, qty: x.qty }))
    : (Array.isArray(body.ids) ? body.ids.map(id => ({ id })) : []);
  if (!list.length) return res.status(400).json({ error: '暂存清单为空，无法生成领料单' });
  const items = [];
  const skipped = [];
  const touched = [];
  for (const entry of list) {
    const m = DB.materials.find(x => x.id === entry.id && !x.deleted);
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
    deleted: false
  };
  DB.materialRequisitions.unshift(rec);
  // 同步材料状态（已生成数量按领料单动态汇总，部分生成时剩余量仍可继续领料）
  touched.forEach(m => { m.status = materialStatus(m); });
  saveDB();
  res.json({ ok: true, data: rec });
});

// 下载领料单 Excel（格式对齐原系统样例：LL-20261009-222544.xlsx）
app.get('/api/materialRequisitions/:id/download', (req, res) => {
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
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
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
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
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
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
  const rec = DB.materialRequisitions.find(x => x.id === req.params.id && !x.deleted);
  if (!rec) return res.status(404).json({ error: '未找到领料单' });
  if (rec.status !== '待入库' && rec.status !== '已入库' && rec.status !== '部分到库') return res.status(400).json({ error: '该领料单已' + rec.status + '，不能作废' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: '请填写作废原因' });
  rec.status = '已作废';
  // 按领料单明细恢复材料状态（待入库作废时 confirmRows 为空，也要解除「已生成领料单」锁定）
  (rec.items || []).forEach(it => {
    const m = DB.materials.find(x => x.id === it.materialId && !x.deleted);
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
  const docs = { ...DB.documents, files: (DB.documents.files || []).filter(f => !f.deleted) };
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
      id, category: req.body.category || '规范文件', name: req.file.originalname,
      size: req.file.size, uploader: req.user.name, uploadedAt: fmtNow(), path: rel
    };
    DB.documents.files.push(file);
    saveDB();
    // 上传到「危险点」分类：Excel/CSV 自动解析入企业危险点库（A列危险点、C列控制措施，去重）
    let hazardImport = null;
    if (file.category === '危险点') {
      try { hazardImport = parseHazardFromBuffer(req.file.buffer, file.name); }
      catch (e) { hazardImport = { error: e.message, added: 0, skipped: 0 }; }
    }
    res.json({ ...file, hazardImport });
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
  const before = DB.documents.files[idx];
  const updated = { ...before, ...req.body, id: req.params.id };
  DB.documents.files[idx] = updated;
  saveDB();
  // 移入「危险点」分类：若为 Excel/CSV，自动解析入企业危险点库
  let hazardImport = null;
  if (updated.category === '危险点' && before.category !== '危险点') {
    try { hazardImport = parseHazardFromFile(updated); }
    catch (e) { hazardImport = { error: e.message, added: 0, skipped: 0 }; }
  }
  res.json({ ...updated, hazardImport });
});

app.delete('/api/documents/files/:id', (req, res) => {
  const idx = DB.documents.files.findIndex(f => f.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  if (DB.documents.files[idx].fixed) return res.status(400).json({ error: '固定系统文件不可删除' });
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
    const { added, skipped } = importHazardRows(rows);
    saveDB();
    res.json({ ok: true, added, skipped });
  } catch (e) { res.status(500).json({ error: '导入失败：' + e.message }); }
});

// ---------- 工程实际施工量 ----------
const ACTUAL_WORK_TYPES = ['转运', '立杆', '放线和设备安装'];
app.get('/api/actualWorks', (req, res) => {
  const list = (DB.actualWorks || []).filter(r => !r.deleted)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) ||
                    String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
  res.json(list);
});
app.post('/api/actualWorks', (req, res) => {
  try {
    const b = req.body || {};
    const date = String(b.date || '').trim();
    const project = String(b.project || '').trim();
    // 工作类型 / 施工人员 均支持多选（数组），兼容旧版单值字符串
    const workTypes = (Array.isArray(b.workTypes) ? b.workTypes : (b.workType ? [b.workType] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    const workers = (Array.isArray(b.workers) ? b.workers : (b.worker ? [b.worker] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '请选择日期' });
    if (!project) return res.status(400).json({ error: '请选择项目名称（包）' });
    if (!workTypes.length || workTypes.some(t => !ACTUAL_WORK_TYPES.includes(t))) return res.status(400).json({ error: '请选择工作类型' });
    if (!workers.length) return res.status(400).json({ error: '请选择施工人员' });
    // 材料实际施工量：只保留数量 > 0 的项
    const items = Array.isArray(b.items) ? b.items.map(it => ({
      materialId: String((it && it.materialId) || ''),
      code: String((it && it.code) || ''),
      description: String((it && it.description) || '').trim(),
      unit: String((it && it.unit) || '').trim(),
      qty: Number(it && it.qty) || 0
    })).filter(it => it.description && it.qty > 0) : [];
    const row = {
      id: genId('aw'), date, project, workTypes, workers, items,
      submitter: (req.user && (req.user.name || req.user.username)) || '',
      submittedAt: fmtNow(), deleted: false
    };
    DB.actualWorks.push(row);
    saveDB();
    res.json(row);
  } catch (e) { res.status(500).json({ error: '提交失败：' + e.message }); }
});
app.put('/api/actualWorks/:id', (req, res) => {
  try {
    const row = (DB.actualWorks || []).find(r => r.id === req.params.id && !r.deleted);
    if (!row) return res.status(404).json({ error: '未找到' });
    const b = req.body || {};
    const date = String(b.date || '').trim();
    const project = String(b.project || '').trim();
    const workTypes = (Array.isArray(b.workTypes) ? b.workTypes : (b.workType ? [b.workType] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    const workers = (Array.isArray(b.workers) ? b.workers : (b.worker ? [b.worker] : []))
      .map(x => String(x || '').trim()).filter(Boolean);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: '请选择日期' });
    if (!project) return res.status(400).json({ error: '请选择项目名称（包）' });
    if (!workTypes.length || workTypes.some(t => !ACTUAL_WORK_TYPES.includes(t))) return res.status(400).json({ error: '请选择工作类型' });
    if (!workers.length) return res.status(400).json({ error: '请选择施工人员' });
    const items = Array.isArray(b.items) ? b.items.map(it => ({
      materialId: String((it && it.materialId) || ''),
      code: String((it && it.code) || ''),
      description: String((it && it.description) || '').trim(),
      unit: String((it && it.unit) || '').trim(),
      qty: Number(it && it.qty) || 0
    })).filter(it => it.description && it.qty > 0) : [];
    row.date = date; row.project = project; row.workTypes = workTypes; row.workers = workers; row.items = items;
    row.updatedAt = fmtNow();
    row.updatedBy = (req.user && (req.user.name || req.user.username)) || '';
    saveDB();
    res.json(row);
  } catch (e) { res.status(500).json({ error: '保存失败：' + e.message }); }
});
app.delete('/api/actualWorks/:id', (req, res) => {
  const idx = (DB.actualWorks || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.actualWorks.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// ---------- 工作票自动化配置：配置状态 ----------
// 6 项配置的就绪情况；安全信息与危险点库为全局口径（危险点库当前为全局库）
const WT_CONFIG_VERSION = 2;
function fmtStamp(d) {
  const p2 = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p2(d.getMonth() + 1) + '/' + p2(d.getDate()) + ' ' +
         p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
}
// 从文档中心已上传的文件中识别「现场勘察（查勘）记录模板」，自动关联为 surveyTemplate
function isSurveyTemplateName(name) {
  const n = String(name || '');
  return /(勘察|查勘)/.test(n) && /\.(docx|doc)$/i.test(n);
}
function resolveSurveyTemplate() {
  const docs = DB.documents || {};
  const cur = docs.surveyTemplate;
  if (cur && cur.name) {
    const abs = resolveDocPath(cur.path);
    if (!abs || fs.existsSync(abs)) return cur; // 已关联且文件存在
  }
  const cands = (docs.files || [])
    .filter(f => !f.deleted && f.path && isSurveyTemplateName(f.name))
    .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
  if (!cands.length) return null;
  const f = cands[0];
  const meta = {
    name: f.name, path: f.path, size: f.size || null,
    uploader: f.uploader || '', uploadedAt: f.uploadedAt || '',
    sourceFileId: f.id, autoLinked: true
  };
  DB.documents.surveyTemplate = meta;
  saveDB();
  return meta;
}

app.get('/api/workticket/config-status', (req, res) => {
  const cnt = key => (DB[key] || []).filter(r => !r.deleted).length;
  const haz = (DB.documents && DB.documents.hazardLibrary) || [];
  const survey = resolveSurveyTemplate();

  const raw = [
    { key: 'rules',     title: '作业内容匹配规则', count: cnt('wtRules') },
    { key: 'tech',      title: '施工技术措施',     count: cnt('wtTechMeasures') },
    { key: 'safety',    title: '施工安全措施',     count: cnt('wtSafetyMeasures') },
    { key: 'hospitals', title: '医院联系方式',     count: cnt('wtHospitals') },
    { key: 'hazards',   title: '企业危险点库',     count: haz.length },
    { key: 'survey',    title: '现场勘察记录模板', count: survey ? 1 : 0 }
  ];
  // 每项的就绪口径与副标题文案
  const items = raw.map(it => {
    let ready = false, desc = '';
    if (it.key === 'hazards') { ready = it.count > 0; desc = ready ? ('已建立 ' + it.count + ' 条危险点') : '尚未建立危险点库'; }
    else if (it.key === 'survey') { ready = it.count > 0; desc = ready ? '已上传并通过内容检查' : '尚未上传勘察记录模板'; }
    else { ready = it.count > 0; desc = ready ? ('已配置 ' + it.count + ' 条') : '尚未配置'; }
    return { key: it.key, title: it.title, count: it.count, ready, desc };
  });
  const ready = items.every(i => i.ready);
  // 版本指纹：随 6 项配置内容变化；时间取各来源最近一次更新时间
  const snap = { v: WT_CONFIG_VERSION, c: items.map(i => i.key + ':' + i.count) };
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
  let latest = 0;
  WT_COLLECTIONS.forEach(k => (DB[k] || []).forEach(r => {
    const t = Date.parse(r.updatedAt || r.createdAt || 0);
    if (!isNaN(t) && t > latest) latest = t;
  }));
  const stamp = latest ? new Date(latest) : new Date();

  // 危险点库按 2 列布局顺序返回：左列 rules/safety/hazards，右列 tech/hospitals/survey
  const order = ['rules', 'safety', 'hazards', 'tech', 'hospitals', 'survey'];
  const ordered = order.map(k => items.find(i => i.key === k));
  res.json({
    version: WT_CONFIG_VERSION,
    versionLabel: 'v' + WT_CONFIG_VERSION,
    updatedAt: fmtStamp(stamp),
    sha256,
    ready,
    items: ordered,
    hazardCount: haz.length
  });
});

// ---------- 资料库：作业内容匹配规则等（工作票自动化配置数据）----------
// 固定活动类别（匹配类别下拉选项，来自 CT 标准口径）
const WT_FIXED_CATEGORIES = ['开挖坑洞', '组立电杆', '制作拉线', '箱变', '环网柜', '开挖电缆沟',
  '电缆 / 敷设电缆', '电缆试验', '真空开关', '刀闸', '避雷器', '高压/低压导线', '变压器', '组装金具', '拆除、撤除'];

const wtAlive = key => (DB[key] || []).filter(r => !r.deleted);
function wtRulesOf(req) {
  return wtAlive('wtRules').slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
}
// 资料库分组（含各分组条目数）与下拉选项
app.get('/api/workticket/library', (req, res) => {
  const opt = key => wtAlive(key).map(r => ({ id: r.id, name: (r.title || r.name || r.content || '').slice(0, 80), sort: (Number(r.sort) || 0) })).filter(o => o.name);
  res.json({
    groups: [
      { key: 'rules', title: '作业内容匹配规则', count: wtAlive('wtRules').length, showCount: true },
      { key: 'tech', title: '施工技术措施原文', count: wtAlive('wtTechMeasures').length, showCount: true },
      { key: 'safety', title: '施工安全措施原文', count: wtAlive('wtSafetyMeasures').length, showCount: true },
      { key: 'hospitals', title: '医院联系方式', count: wtAlive('wtHospitals').length, showCount: true },
      { key: 'emergency', title: '默认应急医院', count: 0, showCount: false }
    ],
    categories: WT_FIXED_CATEGORIES,
    techOptions: opt('wtTechMeasures'),
    safetyOptions: opt('wtSafetyMeasures'),
    emergency: DB.settings.emergencyHospital || { name: '', phone: '' }
  });
});

// ---------- 默认模板（施工技术 / 安全措施原文 快照）----------
/* 内置标准资料：assets/ct-standard.json 随代码分发（技术 49 条 / 安全 19 条通用措施原文）。
 * 全新实例（含 Docker 空卷首次启动）库里没有任何措施数据，此时「默认模板」直接回落为内置内容，
 * 保证「载入默认」开箱可用；用户一旦用「保存为默认」自行冻结过快照（savedAt 有值），则以用户快照为准。 */
const CT_STANDARD_FILE = path.join(__dirname, 'assets', 'ct-standard.json');
let CT_STANDARD_CACHE;
function builtinStandard() {
  if (CT_STANDARD_CACHE !== undefined) return CT_STANDARD_CACHE;
  CT_STANDARD_CACHE = null;
  try {
    if (!fs.existsSync(CT_STANDARD_FILE)) return null;
    const d = JSON.parse(fs.readFileSync(CT_STANDARD_FILE, 'utf8'));
    const norm = arr => (Array.isArray(arr) ? arr : [])
      .map(x => ({ sort: Number(x.sort) || 0, title: String(x.title || '').trim(), content: String(x.content || '').trim() }))
      .filter(x => x.title && x.content);
    const tech = norm(d.techMeasures), safety = norm(d.safetyMeasures);
    if (tech.length || safety.length) CT_STANDARD_CACHE = { tech, safety };
  } catch (e) { console.error('  ⚠ 内置标准资料读取失败：', e.message); }
  return CT_STANDARD_CACHE;
}
function wtDefaultShape() {
  if (!DB.wtDefaultMeasures || typeof DB.wtDefaultMeasures !== 'object') DB.wtDefaultMeasures = {};
  if (!Array.isArray(DB.wtDefaultMeasures.tech)) DB.wtDefaultMeasures.tech = [];
  if (!Array.isArray(DB.wtDefaultMeasures.safety)) DB.wtDefaultMeasures.safety = [];
  if (DB.wtDefaultMeasures.savedAt === undefined) DB.wtDefaultMeasures.savedAt = '';
  if (DB.wtDefaultMeasures.cleared === undefined) DB.wtDefaultMeasures.cleared = false;
  // 未自行冻结过快照、且快照为空 → 回落内置标准资料（全新实例也能「载入默认」）
  if (!DB.wtDefaultMeasures.tech.length && !DB.wtDefaultMeasures.safety.length && !DB.wtDefaultMeasures.savedAt) {
    const b = builtinStandard();
    if (b) { DB.wtDefaultMeasures.tech = b.tech.slice(); DB.wtDefaultMeasures.safety = b.safety.slice(); }
  }
  return DB.wtDefaultMeasures;
}
const wtNormTitle = s => String(s || '').replace(/\s+/g, ' ').trim();
// 把当前「施工技术/安全措施原文」冻结为默认模板（按当前顺序与序号）
function wtSnapshotDefault() {
  const d = wtDefaultShape();
  const pick = key => wtAlive(key).slice()
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))
    .map(r => ({ sort: Number(r.sort) || 0, title: String(r.title || '').trim(), content: String(r.content || '').trim() }))
    .filter(x => x.title && x.content);
  d.tech = pick('wtTechMeasures');
  d.safety = pick('wtSafetyMeasures');
  d.savedAt = nowISO();
  d.cleared = false;
  saveDB();
  return d;
}
// 默认配置初始快照：默认模板为空且有措施数据时，自动把当前数据冻结为默认
// （「清除」只清空列表、不动默认模板，因此这里无需再考虑重复灌入）
(function initDefaultMeasures() {
  try {
    const d = wtDefaultShape();
    if (d.tech.length || d.safety.length) return;
    if (wtAlive('wtTechMeasures').length || wtAlive('wtSafetyMeasures').length) wtSnapshotDefault();
  } catch (e) { console.error('  ⚠ 默认模板初始化失败：', e.message); }
})();

app.get('/api/workticket/measures/default', (req, res) => {
  const d = wtDefaultShape();
  // builtin=true 表示用的是随代码分发的内置标准资料（尚未被用户「保存为默认」覆盖）
  res.json({ tech: d.tech.length, safety: d.safety.length, savedAt: d.savedAt || '', builtin: !d.savedAt });
});

// 清除全部措施原文：清空「施工技术措施原文」与「施工安全措施原文」两个列表；
// 默认模板（默认配置）不受影响，之后可用「载入默认」把这些内容重新加载回来
app.post('/api/workticket/measures/clear-all', (req, res) => {
  try {
    const tech = wtAlive('wtTechMeasures').length;
    const safety = wtAlive('wtSafetyMeasures').length;
    DB.wtTechMeasures = [];
    DB.wtSafetyMeasures = [];
    saveDB();
    res.json({ ok: true, clearedTech: tech, clearedSafety: safety, tech: 0, safety: 0 });
  } catch (e) { res.status(500).json({ error: '清除失败：' + e.message }); }
});

// 以当前数据覆盖默认模板
app.post('/api/workticket/measures/default/save', (req, res) => {
  try {
    const d = wtSnapshotDefault();
    res.json({ ok: true, tech: d.tech.length, safety: d.safety.length, savedAt: d.savedAt });
  } catch (e) { res.status(500).json({ error: '保存默认模板失败：' + e.message }); }
});

// 载入默认：把默认配置补回当前列表——完全相同的条目跳过（按「标题+内容」去重，避免同名不同内容被吞），删除过的补回
app.post('/api/workticket/measures/default/load', (req, res) => {
  try {
    const d = wtDefaultShape();
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
    const keyOf = (title, content) => norm(title) + '\u0001' + norm(content);
    const result = {};
    const merge = (kind, coll, list) => {
      const alive = wtAlive(coll);
      // 多重集匹配：按「标题+内容」统计列表里已有多少条；默认里有几条就补到几条（含完全相同的重复条目）
      const remaining = new Map();
      alive.forEach(r => { const k = keyOf(r.title, r.content); remaining.set(k, (remaining.get(k) || 0) + 1); });
      let maxSort = alive.reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
      let added = 0, skipped = 0;
      (list || []).forEach(item => {
        const title = String(item.title || '').trim();
        const content = String(item.content || '').trim();
        if (!title || !content) { skipped++; return; }
        const key = keyOf(title, content);
        const n = remaining.get(key) || 0;
        if (n > 0) { remaining.set(key, n - 1); skipped++; return; } // 已有同款，跳过
        const s = Number(item.sort) > 0 ? Number(item.sort) : ++maxSort;
        DB[coll].push({ id: genId('wt'), deleted: false, sort: s, createdAt: nowISO(), updatedAt: nowISO(), title, content });
        added++;
      });
      result[kind] = { added, skipped };
    };
    merge('tech', 'wtTechMeasures', d.tech);
    merge('safety', 'wtSafetyMeasures', d.safety);
    saveDB();
    res.json({ ok: true, result, tech: wtAlive('wtTechMeasures').length, safety: wtAlive('wtSafetyMeasures').length });
  } catch (e) { res.status(500).json({ error: '载入默认失败：' + e.message }); }
});

app.get('/api/workticket/rules', (req, res) => res.json(wtRulesOf(req)));

function wtRulePayload(b) {
  const workType = String(b.workType || '').trim();
  const category = String(b.category || '').trim();
  const keywordsRaw = String(b.keywords || '').trim();
  if (!workType) return { error: '请填写作业类型名称' };
  if (!category && !keywordsRaw) return { error: '请选择匹配类别或填写自定义匹配词' };
  if (workType.length > 120) return { error: '作业类型名称不超过 120 字' };
  if (keywordsRaw.length > 2000) return { error: '自定义匹配词不超过 2000 字' };
  // 选了固定活动类别时，以「类别」作为匹配规则；否则用自定义匹配词（逗号/顿号/换行分隔）
  const keywords = category ? [category] : keywordsRaw.split(/[,，、;；\n\r]+/).map(x => x.trim()).filter(Boolean);
  if (!keywords.length) return { error: '请填写自定义匹配词' };
  return {
    workType,
    category,
    keywordsRaw: category ? '' : keywordsRaw,
    keywords,
    techId: String(b.techId || '').trim(),
    techName: String(b.techName || '').trim(),
    safetyId: String(b.safetyId || '').trim(),
    safetyName: String(b.safetyName || '').trim()
  };
}

app.post('/api/workticket/rules', (req, res) => {
  const p = wtRulePayload(req.body || {});
  if (p.error) return res.status(400).json({ error: p.error });
  const maxSort = wtAlive('wtRules').reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  const row = { id: genId('wr'), deleted: false, sort: maxSort + 1, createdAt: nowISO(), updatedAt: nowISO(), ...p };
  DB.wtRules.push(row);
  saveDB();
  res.json(row);
});

app.put('/api/workticket/rules/:id', (req, res) => {
  const idx = (DB.wtRules || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const p = wtRulePayload({ ...DB.wtRules[idx], ...(req.body || {}) });
  if (p.error) return res.status(400).json({ error: p.error });
  DB.wtRules[idx] = { ...DB.wtRules[idx], ...p, updatedAt: nowISO() };
  saveDB();
  res.json(DB.wtRules[idx]);
});

app.delete('/api/workticket/rules/:id', (req, res) => {
  const idx = (DB.wtRules || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.wtRules.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 导入预览 / 导入：首表 A 列作业类型、B 列自定义匹配词、C 列施工技术措施、D 列安全措施
function parseRuleRows(buf, originalname) {
  let rows;
  if (/\.csv$/i.test(originalname || '')) rows = parseCSVBuffer(buf);
  else {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }
  const out = [], errors = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // 表头
    const workType = String(r[0] || '').trim();
    const keywordsRaw = String(r[1] || '').trim();
    const techName = String(r[2] || '').trim();
    const safetyName = String(r[3] || '').trim();
    if (!workType && !keywordsRaw && !techName && !safetyName) return;
    if (!workType) { errors.push('第' + (i + 1) + '行：作业类型为空'); return; }
    if (!keywordsRaw) { errors.push('第' + (i + 1) + '行：自定义匹配词为空'); return; }
    out.push({ workType, keywordsRaw, techName, safetyName });
  });
  return { rows: out, errors };
}
app.post('/api/workticket/rules/import-preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const r = parseRuleRows(req.file.buffer, req.file.originalname);
    res.json({ total: r.rows.length, rows: r.rows, errors: r.errors });
  } catch (e) { res.status(500).json({ error: '解析失败：' + e.message }); }
});
app.post('/api/workticket/rules/import', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  let sort = wtAlive('wtRules').reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  const added = [];
  rows.forEach(r => {
    const p = wtRulePayload({ workType: r.workType, keywords: r.keywordsRaw || r.keywords, techName: r.techName, safetyName: r.safetyName });
    if (p.error) return;
    const row = { id: genId('wr'), deleted: false, sort: ++sort, createdAt: nowISO(), updatedAt: nowISO(), ...p };
    DB.wtRules.push(row); added.push(row);
  });
  saveDB();
  res.json({ added: added.length });
});

// ---------- 资料库：施工技术措施原文 / 施工安全措施原文（同结构，kind = tech | safety） ----------
const WT_MEASURE_COLLECTIONS = { tech: 'wtTechMeasures', safety: 'wtSafetyMeasures' };
const wtMeasureColl = kind => WT_MEASURE_COLLECTIONS[String(kind || '')] || null;

function wtMeasurePayload(b) {
  const title = String(b.title || '').trim();
  const content = String(b.content || '').trim();
  if (!title) return { error: '请填写条文标题 / 关键字' };
  if (!content) return { error: '请填写措施原文' };
  if (title.length > 200) return { error: '条文标题 / 关键字不超过 200 字' };
  if (content.length > 20000) return { error: '措施原文不超过 20000 字' };
  return { title, content };
}
// 序号：显式填写（>=1）则采用；留空/非法则排到末尾
function wtPickSort(b, list) {
  const v = Number(b && b.sort);
  // 允许 1.1 / 2.3 这类分级序号（原系统截图即为此格式），保留两位小数
  if (Number.isFinite(v) && v > 0) return Math.round(v * 100) / 100;
  return Math.floor(list.reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0)) + 1;
}
const wtBySort = list => list.slice().sort((a, b) => ((Number(a.sort) || 0) - (Number(b.sort) || 0)) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

app.get('/api/workticket/measures/:kind', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  res.json(wtBySort(wtAlive(key)));
});

app.post('/api/workticket/measures/:kind', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const b = req.body || {};
  const p = wtMeasurePayload(b);
  if (p.error) return res.status(400).json({ error: p.error });
  const row = { id: genId('wt'), deleted: false, sort: wtPickSort(b, wtAlive(key)), createdAt: nowISO(), updatedAt: nowISO(), ...p };
  DB[key].push(row);
  saveDB();
  res.json(row);
});

app.put('/api/workticket/measures/:kind/:id', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const idx = (DB[key] || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const p = wtMeasurePayload({ ...DB[key][idx], ...b });
  if (p.error) return res.status(400).json({ error: p.error });
  const sort = b.sort === undefined || String(b.sort).trim() === '' ? DB[key][idx].sort : wtPickSort(b, wtAlive(key).filter(r => r.id !== req.params.id));
  DB[key][idx] = { ...DB[key][idx], ...p, sort, updatedAt: nowISO() };
  saveDB();
  res.json(DB[key][idx]);
});

app.delete('/api/workticket/measures/:kind/:id', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const idx = (DB[key] || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB[key].splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 导入：A 列序号（可空）、B 列条文标题 / 关键字、C 列措施原文
function parseMeasureRows(buf, originalname) {
  let rows;
  if (/\.csv$/i.test(originalname || '')) rows = parseCSVBuffer(buf);
  else {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }
  const out = [], errors = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // 表头
    const wide = r.length >= 3;
    const sortRaw = wide ? rowCell(r, 0) : '';
    const title = wide ? rowCell(r, 1) : rowCell(r, 0);
    const content = wide ? rowCell(r, 2) : rowCell(r, 1);
    if (!title && !content && !sortRaw) return;
    if (!title) { errors.push('第' + (i + 1) + '行：条文标题 / 关键字为空'); return; }
    if (!content) { errors.push('第' + (i + 1) + '行：措施原文为空'); return; }
    if (title.length > 200) { errors.push('第' + (i + 1) + '行：条文标题 / 关键字超过 200 字'); return; }
    if (content.length > 20000) { errors.push('第' + (i + 1) + '行：措施原文超过 20000 字'); return; }
    out.push({ sort: wide ? sortRaw : '', title, content });
  });
  return { rows: out, errors };
}
function rowCell(r, i) { return String(r[i] === undefined || r[i] === null ? '' : r[i]).trim(); }

app.post('/api/workticket/measures/:kind/import-preview', upload.single('file'), (req, res) => {
  if (!wtMeasureColl(req.params.kind)) return res.status(404).json({ error: '未知的措施类型' });
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const r = parseMeasureRows(req.file.buffer, req.file.originalname);
    res.json({ total: r.rows.length, rows: r.rows, errors: r.errors });
  } catch (e) { res.status(500).json({ error: '解析失败：' + e.message }); }
});
app.post('/api/workticket/measures/:kind/import', (req, res) => {
  const key = wtMeasureColl(req.params.kind);
  if (!key) return res.status(404).json({ error: '未知的措施类型' });
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  let sort = wtAlive(key).reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  let added = 0;
  rows.forEach(r => {
    const p = wtMeasurePayload({ title: r.title, content: r.content });
    if (p.error) return;
    const n = Number(r.sort);
    const s = Number.isFinite(n) && n > 0 ? Math.floor(n) : ++sort;
    DB[key].push({ id: genId('wt'), deleted: false, sort: s, createdAt: nowISO(), updatedAt: nowISO(), ...p });
    added++;
  });
  saveDB();
  res.json({ added });
});

// ---------- 资料库：医院联系方式 ----------
function wtHospitalPayload(b) {
  const area = String(b.area || '').trim();
  const name = String(b.name || '').trim();
  const address = String(b.address || '').trim();
  const phone = String(b.phone || '').trim();
  if (!area) return { error: '请填写作业地址匹配词' };
  if (!name) return { error: '请填写医院名称' };
  if (!address) return { error: '请填写医院地址' };
  if (!phone) return { error: '请填写联系电话' };
  if (area.length > 200) return { error: '作业地址匹配词不超过 200 字' };
  if (name.length > 100) return { error: '医院名称不超过 100 字' };
  if (address.length > 300) return { error: '医院地址不超过 300 字' };
  if (phone.length > 50) return { error: '联系电话不超过 50 字' };
  return { area, name, address, phone };
}

app.get('/api/workticket/hospitals', (req, res) => res.json(wtBySort(wtAlive('wtHospitals'))));

app.post('/api/workticket/hospitals', (req, res) => {
  const b = req.body || {};
  const p = wtHospitalPayload(b);
  if (p.error) return res.status(400).json({ error: p.error });
  const row = { id: genId('wt'), deleted: false, sort: wtPickSort(b, wtAlive('wtHospitals')), createdAt: nowISO(), updatedAt: nowISO(), ...p };
  DB.wtHospitals.push(row);
  saveDB();
  res.json(row);
});

app.put('/api/workticket/hospitals/:id', (req, res) => {
  const idx = (DB.wtHospitals || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  const b = req.body || {};
  const p = wtHospitalPayload({ ...DB.wtHospitals[idx], ...b });
  if (p.error) return res.status(400).json({ error: p.error });
  DB.wtHospitals[idx] = { ...DB.wtHospitals[idx], ...p, updatedAt: nowISO() };
  saveDB();
  res.json(DB.wtHospitals[idx]);
});

app.delete('/api/workticket/hospitals/:id', (req, res) => {
  const idx = (DB.wtHospitals || []).findIndex(r => r.id === req.params.id && !r.deleted);
  if (idx < 0) return res.status(404).json({ error: '未找到' });
  DB.wtHospitals.splice(idx, 1);
  saveDB();
  res.json({ ok: true });
});

// 导入：A 列作业地址匹配词、B 列医院、C 列地址、D 列电话
function parseHospitalRows(buf, originalname) {
  let rows;
  if (/\.csv$/i.test(originalname || '')) rows = parseCSVBuffer(buf);
  else {
    const wb = xlsx.read(buf, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  }
  const out = [], errors = [];
  rows.forEach((r, i) => {
    if (i === 0) return; // 表头
    const area = rowCell(r, 0), name = rowCell(r, 1), address = rowCell(r, 2), phone = rowCell(r, 3);
    if (!area && !name && !address && !phone) return;
    const p = wtHospitalPayload({ area, name, address, phone });
    if (p.error) { errors.push('第' + (i + 1) + '行：' + p.error); return; }
    out.push(p);
  });
  return { rows: out, errors };
}
app.post('/api/workticket/hospitals/import-preview', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const r = parseHospitalRows(req.file.buffer, req.file.originalname);
    res.json({ total: r.rows.length, rows: r.rows, errors: r.errors });
  } catch (e) { res.status(500).json({ error: '解析失败：' + e.message }); }
});
app.post('/api/workticket/hospitals/import', (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: '没有可导入的数据' });
  let sort = wtAlive('wtHospitals').reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
  let added = 0;
  rows.forEach(r => {
    const p = wtHospitalPayload(r);
    if (p.error) return;
    DB.wtHospitals.push({ id: genId('wt'), deleted: false, sort: ++sort, createdAt: nowISO(), updatedAt: nowISO(), ...p });
    added++;
  });
  saveDB();
  res.json({ added });
});

// ---------- 资料库：默认应急医院（单条配置，随保存即时生效） ----------
app.put('/api/workticket/emergency-hospital', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').trim();
  if (name.length > 100) return res.status(400).json({ error: '医院名称不超过 100 字' });
  if (phone.length > 50) return res.status(400).json({ error: '联系电话不超过 50 字' });
  DB.settings.emergencyHospital = { name, phone, updatedAt: nowISO() };
  saveDB();
  res.json(DB.settings.emergencyHospital);
});

// 一键载入六项 CT 标准：需要 assets/ct-standard.json（规则/技术/安全/医院四组 + 可选危险点与勘察模板）
app.post('/api/workticket/load-ct-standard', (req, res) => {
  const f = path.join(__dirname, 'assets', 'ct-standard.json');
  if (!fs.existsSync(f)) {
    return res.status(400).json({ error: '尚未内置 CT 标准资料：缺少 assets/ct-standard.json' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    let n = 0;
    const push = (key, arr, map) => {
      if (!Array.isArray(arr)) return;
      let sort = wtAlive(key).reduce((m, r) => Math.max(m, Number(r.sort) || 0), 0);
      arr.forEach(src => {
        const row = { id: genId('wt'), deleted: false, sort: ++sort, createdAt: nowISO(), updatedAt: nowISO(), ...map(src) };
        DB[key].push(row); n++;
      });
    };
    push('wtRules', data.rules, s => wtRulePayload({ workType: s.workType, keywords: s.keywords, category: s.category, techName: s.techName, safetyName: s.safetyName }));
    push('wtTechMeasures', data.techMeasures, s => ({ title: String(s.title || '').trim(), content: String(s.content || '').trim() }));
    push('wtSafetyMeasures', data.safetyMeasures, s => ({ title: String(s.title || '').trim(), content: String(s.content || '').trim() }));
    push('wtHospitals', data.hospitals, s => ({ area: String(s.area || '').trim(), name: String(s.name || '').trim(), phone: String(s.phone || '').trim(), address: String(s.address || '').trim() }));
    if (Array.isArray(data.hazards) && data.hazards.length && (!DB.documents.hazardLibrary || !DB.documents.hazardLibrary.length)) {
      data.hazards.forEach((h, i) => {
        if (!h || !h.hazard || !h.measure) return;
        DB.documents.hazardLibrary.push({ id: genId('h'), hazard: String(h.hazard), measure: String(h.measure), category: categorize(String(h.hazard)), sort: i });
      });
    }
    saveDB();
    res.json({ ok: true, loaded: n });
  } catch (e) { res.status(500).json({ error: '载入失败：' + e.message }); }
});

// 详细数据（供展开「企业危险点库」使用；只读列表）
app.get('/api/workticket/hazards', (req, res) => {
  const list = ((DB.documents && DB.documents.hazardLibrary) || [])
    .slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  res.json(list);
});

// ---------- 设置 ----------
app.get('/api/settings', (req, res) => res.json(DB.settings));
app.put('/api/settings', (req, res) => {
  DB.settings = { ...DB.settings, ...req.body };
  saveDB();
  res.json(DB.settings);
});

// 首次使用初始化向导：返回各基础设置的完成度
app.get('/api/init-status', (req, res) => {
  const myWorkers = (DB.workers || []).filter(aliveFilter());
  const workers = myWorkers.length;
  // 「班组与施工人员」完成条件：至少一位施工人员已归属班组
  const workersWithTeam = myWorkers.filter(w => !!(w.team && String(w.team).trim())).length;
  const contacts = (DB.contacts || []).filter(aliveFilter()).length;
  const haz = (DB.documents && DB.documents.hazardLibrary) || [];
  const survey = !!resolveSurveyTemplate();
  res.json({
    initialized: !!(DB.settings && DB.settings.initialized),
    companyName: (DB.settings && DB.settings.companyName) || '',
    workers,
    workersWithTeam,
    contacts,
    hazardLibrary: haz.length,
    surveyTemplate: survey
  });
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
    // 新图重置旋转角，避免沿用上一张图的旋转
    DB.settings.loginBgRotate = 0;
    // 前端通过 canvas 生成的 LQIP / 平均色（用于首帧占位，避免黑闪）
    const lqip = String((req.body && req.body.lqip) || '');
    const avg = String((req.body && req.body.avg) || '');
    DB.settings.loginBgMeta = {
      url: DB.settings.loginBg,
      lqip: /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{20,200000}$/.test(lqip) ? lqip : '',
      avg: /^#[0-9a-fA-F]{3,8}$/.test(avg) ? avg : ''
    };
    saveDB();
    res.json({ ok: true, loginBg: DB.settings.loginBg, meta: DB.settings.loginBgMeta });
  } catch (e) { res.status(500).json({ error: '上传失败：' + e.message }); }
});

// 回填/更新当前背景的占位元数据（LQIP + 平均色），用于旧上传图或前端补算
app.put('/api/settings/login-bg/meta', (req, res) => {
  try {
    const lqip = String((req.body && req.body.lqip) || '');
    const avg = String((req.body && req.body.avg) || '');
    const okLqip = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]{20,200000}$/.test(lqip) ? lqip : '';
    const okAvg = /^#[0-9a-fA-F]{3,8}$/.test(avg) ? avg : '';
    if (!okLqip && !okAvg) return res.status(400).json({ error: '缺少有效的 lqip / avg' });
    DB.settings.loginBgMeta = { url: DB.settings.loginBg, lqip: okLqip, avg: okAvg };
    saveDB();
    res.json({ ok: true, meta: DB.settings.loginBgMeta });
  } catch (e) { res.status(500).json({ error: '更新失败：' + e.message }); }
});

// 删除自定义背景：删磁盘文件并恢复为默认预设
app.delete('/api/settings/login-bg', (req, res) => {
  try {
    const cur = DB.settings.loginBg || '';
    if (cur.startsWith('/api/login-bg/')) {
      const upDir = path.join(__dirname, 'data', 'uploads', 'login-bg');
      try { fs.unlinkSync(path.join(upDir, path.basename(cur))); } catch (e) {}
    }
    DB.settings.loginBg = DEFAULT_LOGIN_BG;
    DB.settings.loginBgMode = 'cover';
    DB.settings.loginBgRotate = 0;
    DB.settings.loginBgMeta = null;
    saveDB();
    res.json({ ok: true, loginBg: DB.settings.loginBg, loginBgMode: DB.settings.loginBgMode, loginBgRotate: 0 });
  } catch (e) { res.status(500).json({ error: '删除失败：' + e.message }); }
});

// ---------- 静态前端 ----------
app.use('/assets', express.static(path.join(__dirname, 'assets')));

// 首页直出：把当前登录页背景注入 CSS 变量 --login-bg，避免前端异步取配置造成的「闪跳先默认图」
// 同时注入 LQIP 占位图（超小模糊图）与平均色底，避免图片字节未下载完时出现「黑一下」
const INDEX_PATH = path.join(__dirname, 'public', 'index.html');
let INDEX_TPL = null;
let INDEX_MTIME = 0;
// 预设背景的 LQIP + 平均色（构建期生成，见 public/login-bg/meta.json）
let PRESET_BG_META = {};
try {
  PRESET_BG_META = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'login-bg', 'meta.json'), 'utf8'));
} catch (e) { PRESET_BG_META = {}; }
const LOGIN_BG_MODE_CSS = {
  cover: 'background-size:cover;background-repeat:no-repeat;background-position:center center;',
  contain: 'background-size:contain;background-repeat:no-repeat;background-position:center center;',
  stretch: 'background-size:100% 100%;background-repeat:no-repeat;background-position:center center;',
  tile: 'background-size:auto;background-repeat:repeat;background-position:top left;',
  center: 'background-size:auto;background-repeat:no-repeat;background-position:center center;'
};
function getLoginBgMeta(url) {
  const meta = DB.settings && DB.settings.loginBgMeta;
  if (meta && meta.url === url) return meta;
  const base = path.basename(String(url || ''));
  return PRESET_BG_META[base] || null;
}
function renderIndexHtml() {
  // 模板缓存：文件被改动（mtime 变化）时自动重新读取，避免改样式后必须重启进程
  try {
    const mtime = fs.statSync(INDEX_PATH).mtimeMs;
    if (INDEX_TPL === null || mtime !== INDEX_MTIME) { INDEX_TPL = fs.readFileSync(INDEX_PATH, 'utf8'); INDEX_MTIME = mtime; }
  } catch (e) {
    if (INDEX_TPL === null) INDEX_TPL = fs.readFileSync(INDEX_PATH, 'utf8');
  }
  const raw = String((DB.settings && DB.settings.loginBg) || DEFAULT_LOGIN_BG);
  // 仅允许站内相对路径或 http(s) 地址，剥离引号/尖括号，防注入
  const safe = raw.replace(/[\\"'<>]/g, '').replace(/\s+/g, '');
  const mode = (DB.settings && LOGIN_BG_MODE_CSS[DB.settings.loginBgMode]) ? DB.settings.loginBgMode : 'cover';
  const meta = getLoginBgMeta(safe) || {};
  const avg = /^#[0-9a-fA-F]{3,8}$/.test(String(meta.avg || '')) ? meta.avg : '#e9edf2';
  const lqip = /^data:image\//.test(String(meta.lqip || '')) ? meta.lqip : '';
  // 旋转：90/270 需交换宽高并用 translate 居中，保证旋转后仍铺满视口
  const rotate = [0, 90, 180, 270].includes(Number(DB.settings && DB.settings.loginBgRotate)) ? Number(DB.settings.loginBgRotate) : 0;
  let rotateCss = '';
  if (rotate === 90 || rotate === 270) {
    rotateCss = `.login-bg-rotate{width:100vh;width:100dvh;height:100vw;height:100dvw;inset:auto;top:50%;left:50%;transform:translate(-50%,-50%) rotate(${rotate}deg);}`;
  } else if (rotate === 180) {
    rotateCss = `.login-bg-rotate{transform:rotate(180deg);}`;
  }
  // preload 让浏览器以高优先级先取图；LQIP 与平均色保证首帧不是黑屏
  const head = [
    `<link rel="preload" as="image" href="${safe}" fetchpriority="high">`,
    `<style>:root{--login-bg:url('${safe}');--login-bg-color:${avg};${lqip ? `--login-bg-lqip:url('${lqip}');` : ''}}`,
    `.login-bg-layer{${LOGIN_BG_MODE_CSS[mode] || LOGIN_BG_MODE_CSS.cover}}`,
    `${rotateCss}</style>`
  ].join('');
  return INDEX_TPL.includes('<!--LOGIN_BG-->')
    ? INDEX_TPL.replace('<!--LOGIN_BG-->', head)
    : INDEX_TPL.replace('</head>', head + '</head>');
}
app.get(['/', '/index.html'], (req, res) => {
  try { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(renderIndexHtml()); }
  catch (e) { res.status(500).type('html').send('index render error'); }
});

// 登录背景图长缓存（文件名唯一，可 immutable；预设图按天缓存）
app.use('/login-bg', express.static(path.join(__dirname, 'public', 'login-bg'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
}));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`\n  电网生产ERP（本地版）已启动`);
  console.log(`  ➜  本地访问: http://localhost:${PORT}`);
  console.log(`  ➜  默认账号: admin / admin123  (角色: 管理员)\n`);
});
