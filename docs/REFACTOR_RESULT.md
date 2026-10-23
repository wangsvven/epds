# 按功能区重组 — 最终映射总表（阶段 5）

分支：`refactor/feature-split`（基线 tag `pre-refactor` = `b9d3580` = v2.10.3）
性质：纯结构重构，只搬不改。API 路径 / 请求与响应结构 / `db.json` 数据结构全部未变，
不引入新依赖，不引入打包器与 ES Module，启动入口仍为 `node server.js`，前端仍为零构建全局脚本。

## 1. 规模变化

| 项目 | 重构前 | 重构后 |
|---|---|---|
| `server.js` | 2883 行（全部路由与逻辑） | **50 行**（只做加载顺序、静态托管、listen） |
| 后端文件数 | 1 | 1 + core 9 + routes 6 = **16** |
| `public/app.js` | 6696 行（全部前端） | 删除，拆为 **15** 个脚本（`public/js/` 6725 行，含文件头） |
| 测试 | 无 | `scripts/smoke.js`（44 项断言，9 个功能区） |

## 2. 后端映射总表

| 新文件 | 行数 | 顶层符号 |
|---|---|---|
| `server.js` | 50 | `PORT`（挂载顺序：registerPublic → `/api` 鉴权 → registerAuthed → 5 个 routes → 静态托管 → listen） |
| `server/core/app.js` | 9 | `app`（共享 express 实例 + `express.json()`） |
| `server/core/db.js` | 433 | `DATA_DIR` `DB_PATH` `DB` `seedDB` `loadDB` `saveDB` `migrateDB` `WT_COLLECTIONS`；迁移所需数据默认值 `DEFAULT_LOGIN_BG` `LEGACY_LOGIN_BG_MAP`、`ROLE_ADMIN` `USER_GROUPS` `LEGACY_GROUP_MAP` `normalizeUserGroup` |
| `server/core/auth.js` | 84 | `TOKENS` `MODULE_NAMES` `ROLE_WRITE` `isAdmin` `userGroupOf` `writeModulesOf` `canWriteModule` `moduleOfPath` `passwordStrong` `fullPath` `authMiddleware` |
| `server/core/crud.js` | 52 | `crud()` 通用工厂 |
| `server/core/upload.js` | 9 | `upload`（multer 实例） |
| `server/core/util.js` | 152 | `aliveFilter` `repairUploadName` `genId` `nowISO` `fmtNow` `fmtStamp` `parseCNDate` `parseCSVBuffer` `decodeXmlEntities` `unzipEntry` `extractDocxText` `crc32` `buildStoreZip` |
| `server/core/material-calc.js` | 45 | `roundQty` `qtyGeneratedOf` `qtyOutstandingOf` `withGen` `materialStatus` |
| `server/core/doc-templates.js` | 43 | `resolveDocPath` `isSurveyTemplateName` `resolveSurveyTemplate` |
| `server/core/risk-category.js` | 26 | `RISK_CATEGORY_RULES` `categorize` |
| `server/routes/system.js` | 473 | `registerPublic` / `registerAuthed` / `registerPage` 三段；`WORKER_ID_RE` `WORKER_PHONE_RE` `WORKER_IDENTITY_OPTIONS` `CONTACT_HEADER_MAP` `contactDept`、`INDEX_PATH` `INDEX_TPL` `INDEX_MTIME` `PRESET_BG_META` `LOGIN_BG_MODE_CSS` `getLoginBgMeta` `renderIndexHtml` |
| `server/routes/projects.js` | 216 | `projectRefsOf` `PROJECT_FILE_TYPES` `findProject` `projectFileSafeName` `ACTUAL_WORK_TYPES` |
| `server/routes/documents.js` | 305 | `importHazardRows` `parseHazardFromBuffer` `parseHazardFromFile` `seedHazardLibraryFromNorm`（未被调用，原样保留） |
| `server/routes/plans.js` | 114 | `PLAN_QTY_FIELDS` `PLAN_TYPES` `PLAN_STATUS` `TICKET_TYPES` `VOLTAGE_LEVELS` `planItem` |
| `server/routes/materials.js` | 521 | `outboundStats` `SOURCE_TYPES` `allSingleProjectNames` `validateMaterialBody` `materialRefsOf` `reqNoNow` |
| `server/routes/workticket.js` | 568 | `WT_CONFIG_VERSION` `WT_FIXED_CATEGORIES` `wtAlive` `wtRulesOf` `CT_STANDARD_FILE` `CT_STANDARD_CACHE` `builtinStandard` `wtDefaultShape` `wtNormTitle` `wtSnapshotDefault` `wtRulePayload` `parseRuleRows` `WT_MEASURE_COLLECTIONS` `wtMeasureColl` `wtMeasurePayload` `wtPickSort` `wtBySort` `parseMeasureRows` `rowCell` `wtHospitalPayload` `parseHospitalRows` |

### 后端跨区依赖处理（均按「下沉 core」原则）

1. `seedDB` / `migrateDB` 需要 `DEFAULT_LOGIN_BG`、`LEGACY_LOGIN_BG_MAP` → 随 `db.js` 搬。
2. `migrateDB` 的用户组迁移需要 `ROLE_ADMIN` / `USER_GROUPS` / `LEGACY_GROUP_MAP` / `normalizeUserGroup` → 随 `db.js` 搬，`auth.js` 从 db 引用（单向）。
3. `migrateDB` 刷新材料 `status` 需要 `materialStatus` → 新建 `core/material-calc.js`，内部 `DB_()` 延迟取库避免循环依赖。
4. `system` 的 init-status 与 `workticket` 的 config-status 共用「现场勘察模板识别」 → 新建 `core/doc-templates.js`。
5. `documents` 的危险点导入与 `workticket` 的 load-ct-standard 共用 `categorize` → 新建 `core/risk-category.js`。

后端**没有** routes ↔ routes 依赖，全部为 routes → core。

## 3. 前端映射总表

| 新文件 | 行数 | 顶层符号 |
|---|---|---|
| `public/js/api.js` | 39 | `api`；文件头下方补 `const { createApp, ref, reactive, computed, onMounted, onUnmounted, watch, nextTick } = Vue;`（原在 app.js 第 2 行，本文件最先加载） |
| `public/js/utils.js` | 46 | `tagType` `MAT_POLE_RE` `MAT_CABLE_RE` `MAT_DEVICE_RE` `MAT_FITTING_RE` `matBucketOf` `MAT_PKG_LABEL` `MAT_UNIT_TO_KM` `matUnitToKm` `fmtKm` |
| `public/js/auth.js` | 5 | `Auth` |
| `public/js/views/crud.js` | 167 | `CrudView` `annualPlanCfg` `substationCfg` `teamCfg` `borrowCfg` `completionCfg` |
| `public/js/views/documents.js` | 1180 | `DocumentsView` |
| `public/js/views/materials.js` | 1649 | `MaterialsView` `FunnelIcon` `Requisitions` `Imports` `Outbounds` |
| `public/js/views/dashboard.js` | 34 | `Dashboard` |
| `public/js/views/settings.js` | 357 | `SettingsView` |
| `public/js/views/init.js` | 99 | `InitView` |
| `public/js/views/contacts.js` | 156 | `ContactsPanel` |
| `public/js/views/users.js` | 530 | `WORKER_IDENTITY_OPTIONS` `WORKER_CERT_OPTIONS` `WorkersPanel` `WorkersView` `AccountsPanel` `UsersView` |
| `public/js/views/projects.js` | 749 | `ProjectsView` |
| `public/js/views/plans.js` | 1063 | `PlansView` `PlanDateTime` |
| `public/js/views/actualWorks.js` | 401 | `ACTUAL_WORK_TYPES` `ACTUAL_WORK_BUCKETS` `ActualConstructionView` |
| `public/js/main.js` | 265 | `_ico` `MENU_ICONS` `App` `app` `lp`；`createApp` + 全局 mixin + 全部 `app.component()` 注册 + `app.mount('#app')` |

### 前端机械转换（仅外壳，组件内部代码未改）

- `app.component('Requisitions'|'Imports'|'Outbounds', { … })` → `const X = { … }`，注册行移到 `main.js`
- `app.component('FunnelIcon', { … })` → `const FunnelIcon = { … }`，注册行移到 `main.js`
- `public/index.html`：`/app.js` 换成 15 个按依赖顺序的 `<script>`（`main.js` 最后）；`preload` 改为 `/js/api.js` + `/js/main.js`
- `public/app.js` 已删除

**加载顺序**：`api → utils → auth → views/crud → documents → materials → dashboard → settings →
init → contacts → users → projects → plans → actualWorks → main`

## 4. 校验与验证

| 项 | 结果 |
|---|---|
| `node --check`（16 个后端文件 + 15 个前端文件） | 全部通过 |
| 跨文件顶层声明重名检测 | 45 个顶层声明，无重名 |
| 前端与原 `app.js` 逐行多重集比对 | 有效行 6506 → 6511，差异仅为上述机械转换（4 处 `app.component(` → `const`、3 处 `});` → `};`、Vue 解构注释、4 行注册） |
| `node scripts/smoke.js`（空实例） | 每步均 **44 / 44 通过** |
| 真实库副本（`/tmp/erp-realdb`，只读浏览器验证 + 接口核对） | 全模块接口条数与源库一致：projects 5 / materials 155 / users 3 / hazard 46 / actualWorks 1 / 首页 200 且登录背景注入正确 |
| 浏览器逐视图点开（10 个菜单 + 用户管理 3 个页签） | 内容正常，`pageerror` 与 `console.error` **均为 0** |
| 手机 390px | 横向溢出 0 |

## 5. 提交记录（均在 `refactor/feature-split`，未推送）

| 提交 | 内容 |
|---|---|
| `6f6670d` | chore: 新增冒烟脚本 `scripts/smoke.js` |
| `ed69eae` | docs: 重组方案与映射表 |
| `e8c77d7` | refactor(core): 抽取 `util.js` |
| `4f1e6ed` | refactor(core): 抽取 `db.js` + `material-calc.js` |
| `b968239` | refactor(core): 抽取 `auth.js` |
| `b7ed98f` | refactor(core): 抽取 `app` / `upload` / `crud` |
| `f3c8683` | refactor(routes): 迁移 `system` |
| `710f692` | refactor(routes): 迁移 `projects` |
| `94f8421` | refactor(routes): 迁移 `documents` |
| `829d1ba` | refactor(routes): 迁移 `plans` |
| `9ff29c6` | refactor(routes): 迁移 `materials` |
| `207ea2e` | refactor(routes): 迁移 `workticket` |
| `b24e3a5` | refactor: `server.js` 精简为纯入口 |
| `4782d9e` | refactor(frontend): `public/app.js` 拆为 15 个脚本 |

## 6. 遗留事项（需另行确认，本次未做）

1. `seedHazardLibraryFromNorm()`（`server/routes/documents.js`）定义了但从未被调用，疑似死代码，按「只搬不改」原样保留，本次不动。
2. ~~金具及铁附件材料包在「工程实际施工量」中不出现，业务口径待确认。~~ **已关闭（2026-10-24 验收确认）**：金具及铁附件包不出现在「工程实际施工量」是正确的业务口径，属正常行为而非缺陷。
