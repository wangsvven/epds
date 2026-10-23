/* ========== js/auth ========== */
/* 当前用户权限状态 Auth（由 /api/me 填充；全局 mixin 暴露 canWrite / canAdmin）。 */
/* ---------------- 当前用户权限（由 /api/me 填充；全局 mixin 暴露 canWrite） ---------------- */
const Auth = reactive({ loaded: false, isAdmin: false, group: '班组长', writeModules: [] });
