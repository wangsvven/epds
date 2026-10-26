/* ========== core/db ========== */
/* 本地 JSON 存储：db.json 读写、空实例种子、旧数据模型迁移；DB 单例只在此文件持有。 */
const fs = require('fs');
const path = require('path');
const { nowISO, repairUploadName } = require('./util');
// 材料到库状态计算（旧库迁移时刷新 status 用；该模块内部延迟取 DB，不会与本文件形成循环依赖）
const { materialStatus } = require('./material-calc');

// ===== 数据模型 =====
// 业务私有集合统一采用逻辑删除（deleted 标记）
// 工作票自动化配置的四类数据源
const WT_COLLECTIONS = ['wtRules', 'wtTechMeasures', 'wtSafetyMeasures', 'wtHospitals'];

// 数据模型枚举（旧数据迁移「用户组」时用；权限判断在 core/auth.js）
const ROLE_ADMIN = '超级用户';
const USER_GROUPS = ['超级用户', '资料员', '材料员', '班组长'];
// 旧用户组 → 现有四组的迁移映射
const LEGACY_GROUP_MAP = { '管理员': '资料员' };
function normalizeUserGroup(g) {
  if (USER_GROUPS.includes(g)) return g;
  return LEGACY_GROUP_MAP[g] || '班组长';
}

// 登录页默认背景（内置预设：草原雪山 / 冰川落日 / 层峦叠嶂）：空实例种子与设置迁移都要用
const DEFAULT_LOGIN_BG = '/login-bg/valley.jpg';
// 旧版预设路径 → 新预设（升级时迁移，避免指向已删除的图）
const LEGACY_LOGIN_BG_MAP = {
  '/login-bg/ink-color.jpg': '/login-bg/valley.jpg',
  '/login-bg/ink-gray.jpg': '/login-bg/ice.jpg',
  '/login-bg/network.jpg': '/login-bg/ridge.jpg'
};

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

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
    // 注意：path 是相对 data/ 的路径（如 uploads/xxx.docx），基准必须同为 ROOT/data
    //（与 core/doc-templates.js 的 resolveDocPath 一致）；用 __dirname 会落到 server/core 下误判不存在
    if (DB.documents.surveyTemplate && DB.documents.surveyTemplate.path && !fs.existsSync(path.join(DATA_DIR, DB.documents.surveyTemplate.path))) {
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
    // 同名项目可能「一存一删」：仅当该名称下已无存活项目时才级联删除，避免误删存活项目的材料
    const aliveProjectNames = new Set(DB.projects.filter(p => !p.deleted).map(p => p.name));
    DB.materials.forEach(m => { if (!m.deleted && m.project && deadProjectNames.has(m.project) && !aliveProjectNames.has(m.project)) m.deleted = true; });
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

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), 'utf8');
}

// 先导出再执行迁移：migrateDB 会调用 core/material-calc 的 materialStatus，
// 它用 require('./db').DB 延迟取库，必须能拿到已导出的 DB 单例。
module.exports = {
  DATA_DIR, DB_PATH, DB, seedDB, loadDB, saveDB, migrateDB, WT_COLLECTIONS,
  DEFAULT_LOGIN_BG, LEGACY_LOGIN_BG_MAP,
  ROLE_ADMIN, USER_GROUPS, LEGACY_GROUP_MAP, normalizeUserGroup
};

migrateDB();
