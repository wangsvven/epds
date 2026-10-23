/* ========== core/auth ========== */
/* 身份与权限：登录态校验（token）、用户组与模块写权限判断、密码强度校验。 */
const { DB, ROLE_ADMIN, normalizeUserGroup } = require('./db');

const TOKENS = DB.tokens || (DB.tokens = {});

// 仅超级用户可维护账号；用户组决定「哪些模块可写」，未列出的模块一律只读。
const MODULE_NAMES = { projects: '项目列表', materials: '材料台账', plans: '计划管理', borrow: '借工管理', completion: '竣工资料', actualWorks: '工程实际施工', documents: '文档中心', users: '用户管理', settings: '全局设置' };
const ROLE_WRITE = {
  '超级用户': '*',
  '资料员': '*',
  '材料员': ['materials'],
  '班组长': ['planQuantities', 'actualWorks']
};

function isAdmin(req) { return !!(req && req.user && req.user.role === ROLE_ADMIN); }
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

module.exports = {
  TOKENS, MODULE_NAMES, ROLE_WRITE,
  isAdmin, userGroupOf, writeModulesOf, canWriteModule, moduleOfPath, passwordStrong,
  fullPath, authMiddleware
};
