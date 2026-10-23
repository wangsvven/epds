# 按功能区重组 · 阶段 1 方案（待确认，未动代码）

> 基线：分支 `refactor/feature-split`，tag `pre-refactor`（= b9d3580 / v2.10.3），冒烟基线 44/44 全绿。
> 本文件只描述「搬家方案」，映射表确认后从阶段 2 开始执行。

---

## 0. 事实核查：任务书与实际代码的 4 处偏差

| # | 任务书说法 | 实际代码 | 处理建议 |
|---|---|---|---|
| 1 | `server.js` 的 `renderIndexHtml()` 里有脚本清单，改脚本要同步那边 | `renderIndexHtml()` 只注入登录背景的 CSS 变量 / preload / LQIP，**不含任何 `<script>`**；脚本清单只在 `public/index.html` L996-1000（vendor 4 个 + `/app.js`） | 只改 `index.html`；`renderIndexHtml()` 原样搬走，不动 |
| 2 | materials 的逻辑用到 projects 的 `findProject` | `findProject(id, req)` 只在项目详情/文件/打包/完成 5 处调用（server.js L1088/1106/1115/1125/1149），**materials 完全没用到**；materials 的 `allSingleProjectNames()` 直接读 `DB.projects` | 后端实际**没有 routes ↔ routes 依赖**，不需要下沉；`findProject` 留 projects.js |
| 3 | 前端按 7 个 views 文件拆分 | 实际有 **20 个组件/配置**：CrudView、DocumentsView、MaterialsView + Requisitions/Imports/Outbounds（材料页签）、Dashboard、SettingsView（+annualPlanCfg/substationCfg/teamCfg）、InitView、ContactsPanel、WorkersPanel/WorkersView/AccountsPanel/UsersView、ProjectsView、PlansView+PlanDateTime、ActualConstructionView、FunnelIcon（材料表 7 处在用）、App | 按「同名视图组件」原则**补 4 个视图文件**（projects / plans / actualWorks / users）+ **2 个共享文件**（utils / auth），见 §1 |
| 4 | 目标结构未提到共享工具 | `tagType`、材料分桶 `matBucketOf`/`matPackage*`、`fmtKm`、`Auth` 被多个视图共用；`api` 也被全部视图共用 | 新增 `js/utils.js`（纯工具）与 `js/auth.js`（权限状态），否则只能塞进某个视图文件，违反「不放其他视图的东西」 |

另外一处发现：`seedHazardLibraryFromNorm()`（L552）**定义了但从未被调用**（疑似死代码）。本次按「只搬不改」原样搬到 documents.js，不删除，建议后续单独清理。

---

## 1. 模块目录说明（逐文件职责）

### 1.1 后端（现有 2883 行 → 13 个文件，启动入口不变）

| 文件 | 职责（一句话） | 是否在任务书结构内 |
|---|---|---|
| `server.js` | 只做组合根：require core、按顺序挂载各 routes、静态托管、`app.listen` | 是 |
| `server/core/app.js` | 只持有 express 实例 + `express.json()`，供各 routes 共享同一 app | **补充**（否则各 routes 要么改写成 register 函数并整体缩进，要么重复创建实例） |
| `server/core/db.js` | DATA_DIR/DB_PATH、`DB` 单例、`seedDB`/`loadDB`/`saveDB`/`migrateDB`、`WT_COLLECTIONS`（迁移与工作票共用的集合清单） | 是 |
| `server/core/auth.js` | 登录态与权限：`TOKENS`、`authMiddleware`、`fullPath`、`USER_GROUPS`/`ROLE_WRITE`/`MODULE_NAMES`/`LEGACY_GROUP_MAP`、`normalizeUserGroup`/`userGroupOf`/`writeModulesOf`/`canWriteModule`/`moduleOfPath`/`passwordStrong`/`isAdmin`/`ROLE_ADMIN` | 是 |
| `server/core/crud.js` | 通用 `crud(collection, prefix, opts)` 工厂 | 是 |
| `server/core/upload.js` | multer 实例（内存存储、20MB、文件名 utf8 修复依赖 util） | 是 |
| `server/core/util.js` | 无业务含义的纯工具：`genId`/`nowISO`/`fmtNow`/`fmtStamp`/`parseCNDate`/`parseCSVBuffer`/`repairUploadName`/`aliveFilter`/`decodeXmlEntities`/`unzipEntry`/`extractDocxText`/`crc32`/`buildStoreZip` | 是 |
| `server/routes/system.js` | 登录、健康检查、公开配置、登录页背景读取与上传、`/api/me`、用户账号、作业人员（含导入导出）、外部通讯录（含导入导出）、设置、初始化状态、五类字典的 CRUD；首页直出 `renderIndexHtml()` 与登录背景常量也归这里 | 是 |
| `server/routes/projects.js` | `/api/projects` 全部（含删除校验、资料文件、打包下载、完成）+ `/api/actualWorks` 全部 | 是 |
| `server/routes/documents.js` | `/api/documents` 全部（文件、模板替换、预览）、企业危险点库（含导入解析）、竣工资料 CRUD | 是（竣工资料并入，见决策点 D） |
| `server/routes/plans.js` | `/api/workPlans`（导入/导出/当日工作量）、`/api/plans` CRUD、借工 `/api/borrowWorks` CRUD | 是 |
| `server/routes/materials.js` | `/api/materials`、`/api/materialImports`、`/api/materialRequisitions`、`/api/materialOutbound`，材料数量/状态/引用校验、领料单、出库、导入 | 是 |
| `server/routes/workticket.js` | `/api/workticket/*` 全部：配置状态、资料库、匹配规则、技术/安全措施、医院、默认模板、CT 标准载入、危险点列表 | 是 |

### 1.2 前端（现有 6696 行 → 15 个文件，仍为普通 script，零构建）

| 文件 | 职责 | 是否在任务书结构内 |
|---|---|---|
| `public/js/api.js` | 只放 `api` 请求封装（含 upload、401 处理） | 是 |
| `public/js/utils.js` | 纯工具与共享常量：`tagType`、材料分桶 `MAT_*`/`matBucketOf`、`MAT_PKG_LABEL`/`MAT_UNIT_TO_KM`/`matUnitToKm`/`fmtKm` | **补充** |
| `public/js/auth.js` | `Auth` 权限状态（loaded/isAdmin/group/writeModules），只被 App 与全局 mixin 读写 | **补充** |
| `public/js/views/crud.js` | `CrudView` + 配置驱动部分：`annualPlanCfg`/`substationCfg`/`teamCfg`/`borrowCfg`/`completionCfg` | 是 |
| `public/js/views/documents.js` | `DocumentsView` | 是 |
| `public/js/views/materials.js` | `MaterialsView` + 其页签组件 `Requisitions`/`Imports`/`Outbounds` + 材料表专用 `FunnelIcon` | 是（页签组件同域并入） |
| `public/js/views/dashboard.js` | `Dashboard` | 是 |
| `public/js/views/settings.js` | `SettingsView` | 是 |
| `public/js/views/init.js` | `InitView` | 是 |
| `public/js/views/contacts.js` | `ContactsPanel` | 是 |
| `public/js/views/users.js` | `UsersView` + `AccountsPanel` + `WorkersPanel` + `WorkersView` + `WORKER_IDENTITY_OPTIONS`/`WORKER_CERT_OPTIONS` | **补充** |
| `public/js/views/projects.js` | `ProjectsView` | **补充** |
| `public/js/views/plans.js` | `PlansView` + `PlanDateTime` | **补充** |
| `public/js/views/actualWorks.js` | `ActualConstructionView` + `ACTUAL_WORK_TYPES`/`ACTUAL_WORK_BUCKETS` | **补充** |
| `public/js/main.js` | `_ico`/`MENU_ICONS`、`App` 根组件、`createApp`、全局 mixin、所有 `app.component()` 注册、`app.mount('#app')` | 是 |

`public/index.html` 只需把 L1000 的 `<script src="/app.js">` 换成 15 个按依赖顺序的 script 标签（vendor 4 个不变）。`public/app.js` 拆分完成后删除。

---

## 2. 完整映射表（旧位置 → 新位置）

### 2.1 后端

| 旧行号（server.js） | 内容（符号） | 新位置 |
|---|---|---|
| 7-13 | `require('express'/'path'/'fs'/'crypto'/'zlib'/'multer'/'xlsx')` | 各文件按需 require |
| 16 | `upload`（multer 实例） | core/upload.js |
| 18-19 | `DATA_DIR`、`DB_PATH` | core/db.js |
| 20 | `PORT` | server.js |
| 23-33 | `DEFAULT_LOGIN_BG`、`LEGACY_LOGIN_BG_MAP` | routes/system.js |
| 34 | `WT_COLLECTIONS` | core/db.js |
| 35-36 | `ROLE_ADMIN`、`isAdmin()` | core/auth.js |
| 38-77 | `USER_GROUPS`、`MODULE_NAMES`、`ROLE_WRITE`、`LEGACY_GROUP_MAP`、`normalizeUserGroup`、`userGroupOf`、`writeModulesOf`、`canWriteModule`、`moduleOfPath`、`passwordStrong` | core/auth.js |
| 55 | `PLAN_QTY_FIELDS` | routes/plans.js（语义是计划工作量字段） |
| 86 | `aliveFilter()` | core/util.js |
| 88-190 | `seedDB`、`loadDB`、`DB` | core/db.js |
| 193-202 | `repairUploadName` | core/util.js |
| 204-486 | `migrateDB`（含 `migrateDB()` 内部全部历史迁移） | core/db.js（随 db 整体搬运，不拆） |
| 487-496 | `RISK_CATEGORY_RULES` | routes/documents.js |
| 498-506 | `categorize` | routes/documents.js |
| 507-524 | `importHazardRows` | routes/documents.js |
| 525-538 | `parseHazardFromBuffer` | routes/documents.js |
| 539-545 | `resolveDocPath` | routes/documents.js |
| 546-551 | `parseHazardFromFile` | routes/documents.js |
| 552-584 | `seedHazardLibraryFromNorm`（未被调用，原样保留） | routes/documents.js |
| 585-587 | `saveDB` | core/db.js |
| 589-593 | `genId`、`nowISO` | core/util.js |
| 595-637 | `decodeXmlEntities`、`unzipEntry`、`extractDocxText` | core/util.js |
| 638-639 | `app = express()`、`app.use(express.json())` | core/app.js |
| 640 | `TOKENS` | core/auth.js |
| 643-645 | `fullPath`、`authMiddleware` | core/auth.js |
| 674-684 | `POST /api/login` | routes/system.js（registerPublic） |
| 686 | `GET /api/health` | routes/system.js（registerPublic） |
| 688 | `GET /favicon.ico` | routes/system.js（registerPublic） |
| 690-706 | `GET /api/public-config`、`GET /api/login-bg/:name` | routes/system.js（registerPublic） |
| 708 | `app.use('/api', authMiddleware)` | server.js（挂载顺序） |
| 710-720 | `GET /api/me` | routes/system.js（registerAuthed） |
| 722-786 | `GET/POST/PUT/DELETE /api/users` | routes/system.js |
| 788-833 | `crud()` | core/crud.js |
| 835-948 | `WORKER_ID_RE`、`WORKER_PHONE_RE`、`WORKER_IDENTITY_OPTIONS`、`POST /api/workers/import`、`GET /api/workers/export` | routes/system.js |
| 841-847 | `parseCNDate` | core/util.js |
| 849-871 | `parseCSVBuffer` | core/util.js |
| 950-1030 | `CONTACT_HEADER_MAP`、`contactDept`、`GET /api/contacts/export`、`POST /api/contacts/import` | routes/system.js |
| 1033-1155 | `projectRefsOf`、`DELETE /api/projects/:id`、`PROJECT_FILE_TYPES`、`findProject`、`projectFileSafeName`、`POST /api/projects/:id/files`、`GET /api/projects/:id/files/:fid/download`、`DELETE /api/projects/:id/files/:fid`、`GET /api/projects/:id/files/pack`、`PUT /api/projects/:id/complete` | routes/projects.js |
| 1157-1190 | `crc32`、`buildStoreZip` | core/util.js |
| 1192-1199 | `DELETE /api/materialRequisitions/:id` | routes/materials.js |
| 1201-1315 | `outboundStats`、`GET /api/materialOutbound/stock`、`GET /api/materialOutbound/orders`、`POST /api/materialOutbound/create`、`PUT /api/materialOutbound/:id/return`、`PUT /api/materialOutbound/:id/void`、`DELETE /api/materialOutbound/:id` | routes/materials.js |
| 1317-1414 | `PLAN_TYPES`、`PLAN_STATUS`、`TICKET_TYPES`、`VOLTAGE_LEVELS`、`planItem`、`POST /api/workPlans/import`、`GET /api/workPlans/export`、`PUT /api/workPlans/:id/quantities` | routes/plans.js |
| 1416-1446 | `DELETE /api/materialImports/:id` | routes/materials.js |
| 1448-1456 | 10 个业务集合 + 5 个字典集合的 `crud()` 注册 | 按域拆到各 routes 末尾，见下方「CRUD 注册的归属」 |
| 1459-1610 | `SOURCE_TYPES`、`GET /api/materials`、`GET /api/materials/:id`、`qtyGeneratedOf`、`qtyOutstandingOf`、`withGen`、`materialStatus`、`roundQty`、`allSingleProjectNames`、`validateMaterialBody`、`POST /api/materials`、`PUT /api/materials/:id`、`materialRefsOf`、`DELETE /api/materials/:id` | routes/materials.js |
| 1612-1679 | `POST /api/materials/import` | routes/materials.js |
| 1681-1835 | `reqNoNow`、`POST /api/requisitions/create`、`GET /api/materialRequisitions/:id/download`、`PUT /api/materialRequisitions/:id/confirm`、`PUT /api/materialRequisitions/:id/void` | routes/materials.js |
| 1837-1988 | `fmtNow`、`GET/PUT /api/documents`、`POST /api/documents/files`、`POST /api/documents/template/replace`、`PUT/DELETE /api/documents/files/:id`、`GET /api/documents/files/:id/download`、`GET /api/documents/files/:id/preview` | routes/documents.js（`fmtNow` → core/util.js） |
| 1990-2054 | `POST/PUT/DELETE /api/documents/hazard`、`POST /api/documents/hazard/import` | routes/documents.js |
| 2056-2131 | `ACTUAL_WORK_TYPES`、`GET/POST/PUT/DELETE /api/actualWorks` | routes/projects.js |
| 2133-2212 | `WT_CONFIG_VERSION`、`fmtStamp`、`isSurveyTemplateName`、`resolveSurveyTemplate`、`GET /api/workticket/config-status` | routes/workticket.js（`fmtStamp` → core/util.js） |
| 2214-2239 | `WT_FIXED_CATEGORIES`、`wtAlive`、`wtRulesOf`、`GET /api/workticket/library` | routes/workticket.js |
| 2241-2333 | `CT_STANDARD_FILE`、`builtinStandard`、`wtDefaultShape`、`wtSnapshotDefault`、`initDefaultMeasures`、默认模板 4 条路由 | routes/workticket.js |
| 2335-2456 | `wtRulePayload`、规则 4 条路由、`parseRuleRows`、规则导入 2 条路由 | routes/workticket.js |
| 2458-2574 | `WT_MEASURE_COLLECTIONS`、`wtMeasureColl`、`wtMeasurePayload`、`wtPickSort`、`wtBySort`、措施 4 条路由、`parseMeasureRows`、`rowCell`、措施导入 2 条路由 | routes/workticket.js |
| 2576-2664 | `wtHospitalPayload`、医院 4 条路由、`parseHospitalRows`、医院导入 2 条路由 | routes/workticket.js |
| 2666-2715 | `PUT /api/workticket/emergency-hospital`、`POST /api/workticket/load-ct-standard`、`GET /api/workticket/hazards` | routes/workticket.js |
| 2717-2743 | `GET/PUT /api/settings`、`GET /api/init-status` | routes/system.js |
| 2745-2806 | `POST /api/settings/login-bg`、`PUT /api/settings/login-bg/meta`、`DELETE /api/settings/login-bg` | routes/system.js |
| 2808-2866 | `INDEX_PATH`、`INDEX_TPL`、`INDEX_MTIME`、`PRESET_BG_META`、`LOGIN_BG_MODE_CSS`、`getLoginBgMeta`、`renderIndexHtml` | routes/system.js |
| 2868-2872 | `GET ['/', '/index.html']` | routes/system.js（registerPublic） |
| 2874-2877 | `/login-bg` 与 `/public` 静态托管 | server.js（挂载层） |
| 2879-2881 | `app.listen(PORT, ...)` | server.js |

**CRUD 注册的归属**（L1448-1456 拆到各域末尾，保持「自定义路由先于 CRUD」的顺序）：
- `projects` → routes/projects.js（在 `PUT /complete` 之后）
- `plans`、`workPlans`、`borrowWorks` → routes/plans.js
- `completionDocuments` → routes/documents.js
- `materialRequisitions`、`materialImports`、`materialOutbound` → routes/materials.js
- `workers`、`contacts`、`annualPlans`、`substations`、`materialCatalog`、`teams`、`units` → routes/system.js

### 2.2 前端

| 旧行号（public/app.js） | 内容 | 新位置 |
|---|---|---|
| 4-36 | `api` | js/api.js |
| 38-42 | `tagType` | js/utils.js |
| 45-80 | `MAT_POLE_RE`、`MAT_CABLE_RE`、`MAT_DEVICE_RE`、`MAT_FITTING_RE`、`matBucketOf`、`MAT_PKG_LABEL`、`MAT_UNIT_TO_KM`、`matUnitToKm`、`fmtKm` | js/utils.js |
| 82-83 | `Auth` | js/auth.js |
| 85-190 | `CrudView` | js/views/crud.js |
| 192-1368 | `DocumentsView` | js/views/documents.js |
| 1370-2080 | `MaterialsView` | js/views/materials.js |
| 2082-2112 | `Dashboard` | js/views/dashboard.js |
| 2114-2144 | `annualPlanCfg`、`substationCfg`、`teamCfg` | js/views/crud.js |
| 2146-2499 | `SettingsView` | js/views/settings.js |
| 2501-2597 | `InitView` | js/views/init.js |
| 2599-2749 | `ContactsPanel` | js/views/contacts.js |
| 2751-2752 | `WORKER_IDENTITY_OPTIONS`、`WORKER_CERT_OPTIONS` | js/views/users.js |
| 2754-3123 | `WorkersPanel` | js/views/users.js |
| 3125-3128 | `WorkersView` | js/views/users.js |
| 3130-3256 | `AccountsPanel` | js/views/users.js |
| 3258-3277 | `UsersView` | js/views/users.js |
| 3279-3290 | `borrowCfg` | js/views/crud.js |
| 3292-3301 | `completionCfg` | js/views/crud.js |
| 3303-4048 | `ProjectsView` | js/views/projects.js |
| 4050-4053 | `_ico`、`MENU_ICONS` | js/main.js |
| 4068-4275 | `App` | js/main.js |
| 4277-4305 | `createApp(App)`、mixin（canWrite/canAdmin）、`app.use(ElementPlus)`、`app.component('CrudView'/'ProjectsView'/'DocumentsView'/'MaterialsView'/'Dashboard'/'SettingsView'/'InitView'/'WorkersPanel'/'ContactsPanel'/'WorkersView'/'UsersView'/'AccountsPanel')` | js/main.js |
| 4291 | `FunnelIcon` 定义 | js/views/materials.js（仅材料表 7 处在用）；注册仍写 js/main.js |
| 4305-4623 | `app.component('Requisitions', {...})` 内联对象 | 改为 `const Requisitions = {...}` 放 js/views/materials.js，注册写 js/main.js |
| 4625-4744 | `app.component('Imports', {...})` | 同上 → js/views/materials.js |
| 4746-5232 | `app.component('Outbounds', {...})` | 同上 → js/views/materials.js |
| 5234-6119 | `PlansView` | js/views/plans.js |
| 6121-6292 | `PlanDateTime` | js/views/plans.js |
| 6294-6691 | `ACTUAL_WORK_TYPES`、`ACTUAL_WORK_BUCKETS`、`ActualConstructionView` | js/views/actualWorks.js |
| 6693-6696 | 三个 `app.component()` + `app.mount('#app')` | js/main.js |

**加载顺序（index.html）**：
`api.js → utils.js → auth.js → views/crud.js → views/documents.js → views/materials.js → views/dashboard.js → views/settings.js → views/init.js → views/contacts.js → views/users.js → views/projects.js → views/plans.js → views/actualWorks.js → main.js`
（`main.js` 必须最后，因为 `createApp` + 全局组件注册 + mount 都在这里；各 views 只声明组件对象，不碰 app。）

---

## 3. 4 个决策点（2026-10-24 01:55 已确认）

| # | 决策点 | 结论 |
|---|---|---|
| A | 目标结构缺 `core/app.js`（共享 express 实例） | **新增 `server/core/app.js`**：持有 express 实例 + `express.json()`；各 routes 里 `const app = require('../core/app')`，业务代码不改 |
| B | 前端缺 6 个文件（`utils.js`、`auth.js`、`views/{projects,plans,actualWorks,users}.js`） | **补建**，最终前端 15 个文件 |
| C | 危险点解析（`categorize`/`importHazardRows`/`parseHazard*`/`RISK_CATEGORY_RULES`）归属 | **documents.js**（与 `/api/documents/hazard*` 同域，避免 routes ↔ routes 依赖） |
| D | 「竣工资料」接口归属 | **documents.js**（只注册 `completionDocuments` 的 CRUD） |

---

## 4. 执行顺序与每步验证（阶段 2-5）

| 步骤 | 动作 | 验证 | 提交信息 |
|---|---|---|---|
| 2-1 | 抽 `core/util.js`（纯工具，无依赖） | 冒烟 44/44 | `refactor(core): 抽取 util.js` |
| 2-2 | 抽 `core/db.js`（DATA_DIR/DB/seedDB/loadDB/saveDB/migrateDB/WT_COLLECTIONS） | 冒烟 44/44 | `refactor(core): 抽取 db.js` |
| 2-3 | 抽 `core/auth.js` | 冒烟 44/44 | `refactor(core): 抽取 auth.js` |
| 2-4 | 抽 `core/upload.js` + `core/crud.js` + `core/app.js` | 冒烟 44/44 | `refactor(core): 抽取 upload/crud/app` |
| 3-1 | `routes/system.js`（含 renderIndexHtml、登录背景） | 冒烟 44/44 + 首页 200 | `refactor(routes): 迁移 system` |
| 3-2 | `routes/projects.js`（含 actualWorks） | 冒烟 44/44 | `refactor(routes): 迁移 projects` |
| 3-3 | `routes/documents.js`（含危险点、竣工资料） | 冒烟 44/44 | `refactor(routes): 迁移 documents` |
| 3-4 | `routes/plans.js`（含借工） | 冒烟 44/44 | `refactor(routes): 迁移 plans` |
| 3-5 | `routes/materials.js` | 冒烟 44/44 | `refactor(routes): 迁移 materials` |
| 3-6 | `routes/workticket.js`（最大 480 行，单独处理） | 冒烟 44/44 | `refactor(routes): 迁移 workticket` |
| 4-1 | `js/api.js` + `js/utils.js` + `js/auth.js` + `js/main.js` 骨架（此时其余组件仍在 app.js，先让 main.js 引用全局组件） | 页面能登录、菜单能切 | `refactor(frontend): 抽出 api/utils/auth/main` |
| 4-2 | 逐组件搬：crud → dashboard → settings → init → contacts → users → documents → materials → projects → plans → actualWorks | 每搬 2-3 个跑一次页面点检 + 冒烟 | 按文件分批 `refactor(frontend): 拆分 views/xxx` |
| 4-3 | 删除 `public/app.js`，index.html 换 script 清单 | 逐视图点开：登录→工作台→项目→材料→计划→借工→竣工→施工量→文档→设置→用户 | 同上，最后一批 |
| 5 | 全量冒烟 + 逐视图人工核对 + README 目录结构 + 最终映射总表 | 44/44 + 人工清单 | `docs: 更新目录结构与重构映射总表` |

每个步骤固定动作：搬代码（整块剪切，不改内部）→ 更新 require / 全局引用 → `node scripts/smoke.js`（必须 44/44）→ 本步映射表 → commit。

---

## 5. 风险与规避

| 风险 | 说明 | 规避 |
|---|---|---|
| 全局 const 重名 | 拆分后所有文件共享同一全局词法作用域，同名 `const` 会直接 `SyntaxError` | 每个符号只在一个文件声明；搬完用 `node --check` + 页面 console 检查 |
| script 顺序 | 组件对象在 `createApp` 之前就要存在 | 严格按 §2.2 顺序；`main.js` 永远最后 |
| `app` 实例 | 现有路由直接调用模块级 `app.get` | 统一从 `core/app.js` 取同一实例（决策 A） |
| DB 单例 | `DB` 是全局可变对象 | 只由 `core/db.js` 持有并导出；`DB` 从未被重新赋值（已核查），解构引用安全；routes 禁止自行 `loadDB()` |
| 路由注册顺序 | 自定义路由必须先于 CRUD 的 `/:id`；`/api/workers/export` 不能被 `/:id` 截走 | 每个 routes 文件内部保持原顺序；CRUD 注册统一放该文件末尾 |
| multer 单例 | `upload` 被 8 处路由共用 | `core/upload.js` 单例导出 |
| 循环依赖 | 例如 documents ↔ workticket | 决策 C 让危险点解析留在 documents，避免环 |
| 启动期副作用 | `initDefaultMeasures()` IIFE、`PRESET_BG_META` 读文件、`INDEX_TPL` 缓存 | 随所在模块的顶层代码一起搬，保证 require 时执行一次；server.js 的 require 顺序 = 原执行顺序 |

---

## 6. 本轮不做的事

- 不改任何业务逻辑、变量语义、接口路径、db.json 结构、前端模板字符串（一个字符都不动）。
- 不引入依赖 / 打包器 / ES Module / 测试框架。
- 不动 Dockerfile、docker-compose*.yml、`public/vendor/`、`assets/`。
- 不 `git push`、不拉取/比对远程；所有提交只在本地 `refactor/feature-split` 分支。
