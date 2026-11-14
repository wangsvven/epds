# 计划管理优化 · Step 1 核实与路径契约维护本（PLAN.md）

- 依据：蓝图《计划管理优化 PLAN》**审阅稿 r3**（2026-11-14，架构师箱 `/Users/admin/Downloads/Grokbot 意见/PLAN1.2.md`，仓库外，**不在本仓库内、不改动、不复制全文**）。
- 授权：用户 2026-11-14 **仅授权 Step 1**（核实事实、补全路径、更新规划文档）。r3 整稿与技术方案**仍待用户/Grokbot 审阅批准**；**审阅结论与后续授权未到之前不进入 Step 2**。
- 本步性质：零业务代码 / 配置 / 数据变更；未启动、未重启任何服务；未写业务数据；未跑冒烟；未 push / tag / Release / 合并。生产只读。
- 基线：`main` = `d8849e1`（tag `v2.23.0`），`git status` 干净，本地与 origin `0 / 0`。**冒烟 169 / 0 是既有盘点报告口径，本步未运行、不得写成已复现。**
- 本目录（`docs/plans/plan-mgmt-20261114/`）为 Step 1 核定的规划目录；本文件与 `契约冻结.md` 是本步唯二交付文档。

---

## 0. 核实清单 1–12 结论索引（依据均为文件:行号或实际字段形态）

| # | 结论 | 主要依据 |
|---|---|---|
| 1 | 技术栈：`package.json` 声明 Node + Express 4.19.2 / Vue3 + Element Plus（前端为 CDN 全局脚本、零构建）、exceljs 4.4.0 / multer 2.4.0 / xlsx 0.18.5，`type: commonjs`，无测试框架与 test script；前端按 `public/index.html:1739-1766` 顺序加载（`plan-no.js` 1748 → `plan-staff.js` 1749 → `views/plan-split.js` 1762 → `views/plans.js` 1763 → `views/monthPlans.js` 1764 → `main.js` 1766）；计划落 `data/db.json` 的 `workPlans[]`，DB 单例在 `server/core/db.js:140`，`saveDB()` 在 `server/core/db.js:466-468`（`fs.writeFileSync` 全量覆写，同步、非原子、无锁）；调用方式＝路由层直接改 DB 内存对象后调用一次 `saveDB()`（`server/routes/plan-split.js:150,192`、`server/routes/plans.js:612,679,719`） | `package.json`；`public/index.html:1739-1766`；`server/core/db.js:35-36,140,466-473`；`server/core/crud.js:22-46` |
| 2 | 规划目录核定：仓库内既有规划/结果类文档放 `docs/`（`docs/REFACTOR_PLAN.md`、`docs/REFACTOR_RESULT.md`），仓库根另有早期 `PROJECT_PLAN.md` / `REAL_API_CONTRACT.md`；仓库外 `_p4-backup/` 是验收记录区、不进 git。**核定 `docs/plans/plan-mgmt-20261114/`**（仓库内、新建专属子目录，与 r3 拟定路径一致）。核定在仓库内 → 允许本地提交一次，仅规划文档 | `ls docs/`；`docs/REFACTOR_PLAN.md:1-6`；`docs/REFACTOR_RESULT.md:1-6` |
| 3 | 路由注册完整面见 §2（**22 个挂载点**，不止 `server.js:36` 一处） | §2 表 |
| 4 | `saveDB()` 定义在 `server/core/db.js:466-468`；单进程同步路由 + 同步写可在**不改该文件**的前提下实现串行临界区，详见 §3 | §3 |
| 5 | 日期字面格式与 `YYYYMM` 换算见 §4 | §4 |
| 6 | **字段层面足以表达日计划，不需要新增 `planType` 日值**；既有拆分已用 `planType='周计划'` 单日记录 + 来源标记表达日计划。表达缺口与商务待确认见 §5 | §5 |
| 7 | 撤销调用点清单见 §6 | §6 |
| 8 | 创建/复制带号实况见 §7 | §7 |
| 9 | 现有拆分 API body 与 r3 2.3 逐字段差异见 §8 | §8 |
| 10 | `parentPlanId` **仅用于拆分来源**；复制**没有**「真实原始来源」字段，详见 §9 | §9 |
| 11 | 冒烟撤销相关用例清单与旧→新映射草稿见 §10 | §10 |
| 12 | 5178 / 5174 两条线状态见 §11；建议线待用户/审阅确认 | §11 |

---

## 1. 核定路径与理由（回写 r3 1.2 / 2.6）

| 用途 | r3 原写法 | **Step 1 核定值** | 理由 |
|---|---|---|---|
| 规划目录 | `docs/plans/plan-mgmt-20261114/`（拟新增待核） | `docs/plans/plan-mgmt-20261114/`（`PLAN.md`、`契约冻结.md`） | `docs/` 是仓库内既有规划文档落点；本次需 2 个文件且需随仓库冻结，故建专属子目录。仓库外 `_p4-backup/` 不进 git，只放验收记录 |
| 取号纯模块 | `server/<待核定>/plan-ticket-no.js` | **`server/core/plan-ticket-no.js`** | `server/core/` 既有纯函数/公共模块惯例：`doc-no.js`、`plan-split.js`、`util.js`、`material-calc.js`；`core/` 只被 `routes/` 依赖 |
| Step 2 纯函数测试 | 「Step 1 核定的对应纯函数测试文件（单个）」 | **`scripts/plan-ticket-no.test.js`**（拟新增单文件） | `scripts/` 既有 `smoke.js`、`non-zt-compare.js` 等 Node 直接运行脚本；`package.json` 无测试框架/脚本，不新引入 |
| Step 3–7 验收测试 | 各步分别写「Step 1 核定的 XX 测试文件」 | **统一 `scripts/plan-mgmt-20261114.test.js`**（拟新增单文件，各步在同一文件内增补用例） | 避免每步新造一个文件、避免把目录当文件；接口/静态断言沿用 `scripts/smoke.js` 的既有写法。该脚本**不自动启动服务**，需用户下令、在核定副本与端口运行 |
| 既有冒烟 | `scripts/smoke.js`（已知候选） | **`scripts/smoke.js`**（Step 8 唯一改的冒烟文件） | 全仓唯一全量冒烟，`316499` 字节；Step 8 可另加 1 个新冒烟用例文件，但不必 |
| 规划文档补记（Step 8） | 「核定规划目录中的 PLAN.md / 契约冻结.md」 | `docs/plans/plan-mgmt-20261114/PLAN.md`、`契约冻结.md` | 同上 |
| 测试副本与端口 | 「5178 与 5174 待确认同一条线」 | 建议 **5178 线**（`/Users/admin/Workbuddy/epds-副本-编号对齐-20261113`），**结论待用户/审阅确认**；本步不启动任何进程 | 见 §11 |

r3 1.2 文件树与实况一致，另补两处只读依赖事实：`server/core/crud.js` **除 GET/PUT/DELETE 外还有 `POST`（22-27 行）**；`POST /api/workPlans/import`（`server/routes/plans.js:53`）是另一条写 `workPlans` 的通道（见 §12 登记）。

---

## 2. 路由注册完整面（回写 r3 1.2 待核项与 Step 3/6 前置）

### 2.1 加载顺序（`server.js`）

`server.js:25` `system.registerPublic()` → `server.js:27` `app.use('/api', authMiddleware)` → `server.js:29` `system.registerAuthed()` →

| 顺序 | 行号 | 模块 | 与 workPlans 有关的路由 |
|---|---|---|---|
| 1 | `server.js:31` | `routes/materials` | `GET /api/workPlans/:id/material-usage`（`server/routes/materials.js:226`） |
| 2 | `server.js:32` | `routes/projects` | 无 workPlans 挂载点 |
| 3 | `server.js:34` | `routes/borrow` | 无（仅 `crud('borrowWorks')`，`borrow.js:192`） |
| 4 | `server.js:35` | `routes/monthPlans` | `GET /api/workPlans/month-plan.xlsx`（`monthPlans.js:12`）；**须先于通用 `/:id`** |
| 5 | `server.js:36` | `routes/plan-split` | 3 个：`POST .../split/preview`（`plan-split.js:73`）、`POST .../split`（88）、`POST .../unsplit`（158）；**须先于通用 `/:id`** |
| 6 | `server.js:37` | `routes/plans` | 14 个专用端点（见 2.2）+ 末尾 `crud('plans')` / `crud('workPlans')`（`plans.js:728-730`） |
| 7 | `server.js:38-39` | `routes/documents`、`routes/workticket` | 无 workPlans 挂载点 |

`server.js:51` `app.listen(PORT)` 单进程；`docker-compose.yml` 单 service `grid-erp`（端口 `5173:5173`，`./data:/app/data`）。

### 2.2 `routes/plans.js` 全部 14 个专用端点

`53` `POST /api/workPlans/import`｜`289` `GET /api/workPlans/export`｜`337` `GET /api/workPlans/import-template`｜`346` `PUT /api/workPlans/:id/quantities`｜`368` `POST /:id/drawings`｜`390` `GET /:id/drawings/:fileId/download`｜`402` `DELETE /:id/drawings/:fileId`｜`431` `POST /:id/package`｜`478` `GET /:id/package/download`｜`488` `DELETE /:id/package`｜`554` `PUT /:id/survey`｜`624` `POST /:id/survey/generate`｜`698` `GET /:id/generated/:fileId/download`｜`708` `DELETE /:id/generated/:fileId`。

末尾 `728-730`：`['plans', 'workPlans'].forEach(c => { crud(c, c, { biz: true, soft: true }); });` → 为 `workPlans` 注册 `GET /api/workPlans`、`GET /api/workPlans/:id`、`POST /api/workPlans`、`PUT /api/workPlans/:id`、`DELETE /api/workPlans/:id`（`server/core/crud.js:12,16,22,29,40`）。

### 2.3 结论（对 Step 3 / Step 6 的影响）

- **创建**（`POST /api/workPlans`）实际经过通用 `crud()`（`core/crud.js:22-27`），注册点在 `routes/plans.js:728-730`。要加创建临界区，可在 **`server/routes/plans.js` 内、`crud()` 注册之前**新增专用 `POST /api/workPlans` 覆盖通用实现 → **不需要改 `server/core/crud.js`，也不需要改 `server.js`**。r3 Step 3 前置「若实际经过 core/crud.js，须已在 Step 1 决定是否把该只读依赖改列入本步第三文件」的答复是：**不改**（详见 §3）。
- **关闭 `/unsplit`** 只需在 `server/routes/plan-split.js:158` 内把处理函数改为 410/409 `SPLIT_IRREVERSIBLE` → **不需要改 `server.js`**；r3 Step 6 第三项条件不触发。
- 注册顺序铁律仍成立：`monthPlans`（35）、`plan-split`（36）必须先于 `plans`（37）的通用 `/:id`；`materials`（31）的 `:id/material-usage` 是两段路径，与 `/:id/split/preview` 不冲突。

---

## 3. `saveDB()` 与临界区可行性（回写 r3 1.2 / 2.7 / Step 3）

- 定义：`server/core/db.js:466-468`，`function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(DB, null, 2), 'utf8'); }`；`DB_PATH = <repo>/data/db.json`（`35-36`）；DB 单例 `140`；导出 `472-476`。
- 性质：**同步**全量覆写、**非原子**（无临时文件 + rename）、**无锁/无队列**、无事务、无回滚；读（`loadDB()` `124-138`）只在启动时一次。
- 现行调用方式：路由层直接修改 DB 内存对象 → 调一次 `saveDB()`；已有「失败按相反顺序回滚内存 + 删文件」的先例（`server/routes/plans.js:652-694` 生成资料覆盖、`server/routes/plan-split.js:150,192`）。
- **结论：不改 `server/core/db.js` 可以实现「读最新存活占用 → 分配 → 更新 → 保存」的进程内串行临界区**。依据：Node 单进程事件循环 + 路由处理函数同步（无 `await` 拆开临界区）+ `saveDB()` 同步写；同一时刻不会有两个请求交错进入该同步代码块。`server.js:51` 单 `app.listen`、`docker-compose.yml` 单 service，当前部署为单进程单实例。
- 「保存失败零写入」在**业务层**可实现：先在内存构造变更／留回滚快照，`saveDB()` 抛错时按相反顺序还原内存（已有先例）。**但磁盘级不成立**：`writeFileSync` 直接覆盖，写入中途失败可能留下半文件；若要磁盘原子写（临时文件 + `rename`），**必须改 `server/core/db.js` 这一个文件**，已条件性预留于 r3 Step 3 第三项（「注册或 `saveDB()` 所在单个文件」），本步**不改**，只登记供审阅决定是否触发。
- **多进程/多实例**：当前无；若将来多实例写同一 `db.json`，进程内串行不再是全局互斥，须先修订 r3 2.7 的部署级约束（r3 已明确「不得声称全局锁」）。
- 停止条件判定：必须改的注册 / CRUD / `saveDB` / 测试文件**均已列入后续 Step 的文件清单**（`server/routes/plans.js` @ Step 3、`server/routes/plan-split.js` @ Step 5/6、`scripts/smoke.js` @ Step 8、`server/core/db.js` 条件性 @ Step 3 第三项），**不命中停止条件第 1 条**。

---

## 4. 日期字段与 `YYYYMM` 换算（回写 r3 1.2 / 2.2 / 2.6-4）

### 4.1 实际字面格式（只读抽查 `workPlans` 31 条，仅形态）

| 字段 | 字面格式 | 依据 |
|---|---|---|
| `startDate` / `endDate` | `YYYY-MM-DD HH:mm:ss`（31/31 条均为 19 字符）；历史兼容 `YYYY-MM-DD HH:mm` 在保存时补 `:00` | `public/js/views/plans.js:1232`（`normDateTime`）、`1368-1369`；`plan-date-time` emit `YYYY-MM-DD HH:mm`（`2683`） |
| `createdAt` / `updatedAt` | **UTC ISO 8601 带 `Z`**（31/31 条），如 `2026-11-10T13:44:53.858Z` | `server/core/util.js:34` `nowISO() = new Date().toISOString()`；`server/core/crud.js:23,31` |
| `PlanDateTime` | 自研组件，定义在 `public/js/views/plans.js:2478-2695`，`update:modelValue` 输出 `YYYY-MM-DD HH:mm`（`2683`），全局注册 `public/js/main.js:352` | 同上 |

### 4.2 Asia/Shanghai 业务时间的唯一来源

- 服务端：`server/core/util.js:41-57`（`BJ_OFFSET_MS = +8h`、`_clockOffsetMs` 手动校时偏移、`bjStr()` 输出 `YYYY-MM-DD HH:mm[:ss]`）；`server/routes/materials.js:20` `todayBizDate() = bjStr().slice(0,10)`；`server/routes/system.js:37-49` `serverClock()` 用 `Date.now() + getClockOffset()` 下发 `ts/date`；`server/core/db.js:481-485` 启动时把手动偏移注入 util。
- 前端：`public/js/server-time.js`（`TZ_MIN=480`，`ServerTime.now()` 按 UTC+8 取年月日，`ymd()` 输出 `YYYY-MM-DD`、`ym()` 输出 `YYYY-MM`；首屏由 `/api/public-config` 的 `serverTs` 校准，之后每 10 分钟用 `/api/server-time` 复核）。前端与服务端**同一偏移、同一时区**。

### 4.3 换算方式（只定换算事实，不改代码）

- **操作当天（新建 / 复制取号年月）**：服务端 `todayBizDate()`（`bjStr().slice(0,10)`）→ `slice(0,7).replace('-','')` = `YYYYMM`；前端等价 `ServerTime.ym().replace('-','')`。已定规则要求服务端重算，故以服务端 `todayBizDate()` 为准。
- **各日开始日期（拆分新增日取号年月）**：`POST .../split` 的 `days[].date` 是 `YYYY-MM-DD`（`server/routes/plan-split.js:98-100` 正则校验）；`dayRange()` 生成子计划 `startDate = 'YYYY-MM-DD HH:mm:ss'`（`server/core/plan-split.js:330-343`）。取 `date.slice(0,7).replace('-','')` 或 `startDate.slice(0,7).replace('-','')` 即 `YYYYMM`。**这些字面日期本就是 Asia/Shanghai 业务日期，不需要 UTC↔本地时区换算**；不要对 `createdAt`（UTC ISO）取年月当作业务年月。
- 现有 `public/js/plan-no.js` 的取号入口用 `PlanNo.ymOf(ServerTime.now())`（`public/js/views/plans.js:1325,1553`）→ `YYYYMM`，与上述前端口径一致。

---

## 5. 单日周计划记录能否表达日计划（回写 r3 2.6-1 / 本步停止条件第 2 条）

**字段核实结论：足以承载日计划内容，不需要新增 `planType` 日值。**

依据：

1. `workPlans[]` 可承载日计划所需的全部内容字段：`name`、`startDate/endDate`、`content` / `shadowContent`、7 项 `wl*` 工量（`server/routes/plans.js:21`、`server/core/plan-split.js:14`）、`status`、`surveyNo/workTicketNo`、`survey` / `generatedFiles`、来源标识 `parentPlanId` / `splitBatchId` / `splitSnapshot`。字段存在性抽查：31 条 `workPlans` 共 89 种字段，`planType` 取值只有 `周计划`(30) / `月计划`(1)，**无日计划枚举、无任何代码读取 `planType='日计划'`**。
2. **既有用法就是这么做的**：`POST .../split` 用 `clone(before)` 生成子记录（`server/routes/plan-split.js:128-142`），**不修改 `planType`**，即子计划仍是 `planType='周计划'`；冒烟 `scripts/smoke.js:3444` 明确断言 `c1.planType === '周计划'`。子计划按内容日期单日生成、名称加「（M月D日）」（`132`, `server/core/plan-split.js:84-88`）。
3. 列表/日历分派只按 `planType` + `status`（`public/js/views/plans.js:172-176,217`），`canSplit()` 靠 `parentPlanId` / `splitBatchId` 排除（`342-347`），不依赖新类型值。

**表达缺口（事实登记，不替用户定规则）**：无法凭 `planType` 区分「日计划」与「普通单日周计划」；日计划会进入「周计划管理」页签与未来 21 天日历；子计划 `endDate` 因 `dayRange()` 沿用父结束时刻可能落在次日 `00:00`（`server/core/plan-split.js:330-343`），「单日」是按内容日期而非 `dateOf(endDate) > dateOf(startDate)` 判定；来源语义目前由 `parentPlanId` / `splitBatchId` 承担，而非类型。

**门禁状态**：本步结论**不是**「不足以表达、需要新 `planType`」，故**不命中停止条件第 2 条**。但 r3 2.6 第 1 项「单日周计划记录是否足以**正式**表达日计划」是**商务待确认**，未锁定前不得写死实现、不得自行新增 `planType` 日值；若用户日后裁定不足并要求新类型，须另行确认并修订契约。本步同样不进入 Step 2（授权边界）。

---

## 6. 撤销调用点清单（回写 r3 2.4 / Step 6/7）

| # | 类别 | 位置 | 说明 |
|---|---|---|---|
| 1 | 前端按钮 | `public/js/views/plans.js:1686` | `<el-button v-if="row.splitBatchId" ... @click="planAct(row,'unsplit')">撤销拆分</el-button>`（未排除 `parentPlanId`，子计划也会显示） |
| 2 | 前端分发 | `public/js/views/plans.js:336` | `else if (cmd === 'unsplit') unsplit(row)` |
| 3 | 前端函数 | `public/js/views/plans.js:364-384` | `unsplit(row)`：确认框 → `api.post('/api/workPlans/' + row.id + '/unsplit', {})`（`372`）；409 时把 `blocks` 弹明细（`376-382`） |
| 4 | 前端守卫（已拆父计划） | `public/js/views/plans.js:349-357` | `splitBadge(row)` 按 `splitBatchId` / `parentPlanId` 显示「已拆分 · 共 N 天」/「拆分自周计划」 |
| 5 | 前端「改起止须先撤销」拦截 | `public/js/views/plans.js:1373-1381` | `submit()` 内：`origRow.splitBatchId` 且 `startDate/endDate` 与 `dlg.editSnapshot` 不同 → 警告「该计划已拆分，修改起止时间需先撤销拆分」并 return |
| 6 | 服务端 API | `server/routes/plan-split.js:158-194` | `POST /api/workPlans/:id/unsplit`：前置 `splitBatchId` / `splitSnapshot`（162-163）→ 四类拦截（168-179）→ 恢复快照、删两标记、软删子计划、一次 `saveDB()`（184-193） |
| 7 | 服务端「已拆不可再拆」提示 | `server/routes/plan-split.js:66` | `precheckSplit` 的 409「该计划已拆分，如需调整请先撤销拆分」 |
| 8 | 注册 | `server.js:36` | `require('./server/routes/plan-split')`（须先于 `plans.js:37`） |
| 9 | 冒烟 | `scripts/smoke.js:3554-3631`、`3633-3690` | 见 §10 |

结论：关闭撤销涉及的**业务文件只有 2 个**——`server/routes/plan-split.js`（API，Step 6）与 `public/js/views/plans.js`（入口 + 改期拦截 + 复制清理，Step 7）；**不需要改 `server.js`**。

---

## 7. 创建 / 复制的带号实况（回写 r3 2.5 / Step 3/4）

- 表单初值：`public/js/views/plans.js:98`（`emptyForm()` 含 `surveyNo: ''`、`workTicketNo: ''`）。
- 新增：`openAdd()` 在 `1326-1327` 用 `PlanNo.nextSurveyNo(list.value, ym)` / `nextTicketNo(list.value, ym, ticketType)` 预填两个编号；`onTicketTypeChange()`（`1550-1553`）仅「新增 + 未手改」重算工单号；`onTicketNoInput()`（`1555`）置 `ticketNoDirty`，编辑模式不重算（`1333`）。
- 提交：`submit()` 把整份表单 `const body = { ...f, name: ... }`（`1418`）POST 到 `/api/workPlans`（`1427`），**因此旧客户端创建请求实际带 `surveyNo` 与 `workTicketNo` 两个编号字段**（另删 `teamSafetyMeasures`，`1421`）。
- 复制：`copyPlan()`（`268-280`）`JSON.parse(JSON.stringify(row))` **整份深拷贝**，只 `delete id / createdAt / teamSafetyMeasures`、改 `name`（+「（副本）」）与 `status='未执行'`，再在 `276-277` 重算两个编号；**`survey`、`splitBatchId`、`splitSnapshot`、`parentPlanId`、`generatedFiles` 等全部原样带入新单**（r3 2.5 的「复制会带 survey 与拆分标记」属实）。
- **`ticketNoMode` 全仓 0 命中**（`public/`、`server/`、`scripts/` 检索 `ticketNoMode|copiedFrom|sourcePlanId|originalPlanId|copySource|sourceId` 均无；`workPlans` 字段抽查 `ticketNoMode` 0 条）。
- **未带 `ticketNoMode` 时的现状行为**：`POST /api/workPlans` 走通用 `crud()`，`server/core/crud.js:22-27` 直接 `{ id, createdAt, ...req.body }` 落库并 `saveDB()` —— **服务端不生成、不重算、不校验、不拒绝任何编号**，客户端预填号（或手改号）原样入库。这是 r3 2.3 拟定 `auto` 缺省重算必须替换的现状（本步不改）。
- 另一写入面（登记，不处理）：`POST /api/workPlans/import`（`server/routes/plans.js:53`）的导入白名单 `48` 也含 `surveyNo` / `workTicketNo`；r3 Step 3 只覆盖 `POST /api/workPlans`，导入路径是否纳入 `auto` 重算尚未在蓝图内说明，见 §12。

---

## 8. 现有拆分 API body 与 r3 2.3 拟定形态逐字段比对（回写 r3 2.3）

现行形态（依据 `server/routes/plan-split.js:73-155,158-194`；前端 `public/js/views/plan-split.js:99-119,136-159`）：

| 端点 | 现行请求 | 现行响应 |
|---|---|---|
| `POST /api/workPlans/:id/split/preview` | `{}`，重新解析时 `{ content: string }`（`preview()` `99-104`、`reparse()` `133`） | `{ ok, errors: string[], days: [{ date, start, end, content, items, quantities }] }`（`73-85`） |
| `POST /api/workPlans/:id/split` | `{ days: [{ date, content, quantities }] }`（`92-104`；前端 `submit()` `140-149`） | `{ ok: true, batchId, parentId, children: [{ id, name, startDate, endDate }] }`（`151-154`）；校验失败 400 `{ error, errors }`（`107`）；已拆 409（`66`） |
| `POST /api/workPlans/:id/unsplit` | `{}` | `{ ok: true, removed }`（`193`）；409 `{ error, blocks }`（`181`） |

r3 2.3 拟定：`SplitPreviewRequest {}`；`SplitPreviewResponse { previewVersion, sourcePlanId, firstDayPlanId, days: PreviewSplitDay[] }`，`PreviewSplitDay { date, isFirstDay, workTicketNo, surveyNo, dailyContent?, quantities? }`；`SplitCommitRequest { previewVersion }`；`SplitCommitOk { ok, splitBatchId, firstDayPlanId, createdPlanIds }`；`SplitBlocked { ok:false, error, message }`（`SURVEY_EXISTS / SURVEY_ANOMALOUS / ALREADY_SPLIT / PREVIEW_STALE / EXHAUSTED`）；`PREVIEW_STALE` 409；重复确认 200 幂等；`unsplit` 关闭为 410/409 `SPLIT_IRREVERSIBLE`。

**差异列表（供 Grokbot 审阅，不自行改蓝图口径）**：

| # | 项 | 现行 | r3 2.3 拟定 | 差异性质 |
|---|---|---|---|---|
| D1 | 预览请求 | 允许 `{ content }` 重解析 | `SplitPreviewRequest {}`（空，注明待比对） | 现行 `content` 无对应字段；拟定未说明「重新解析全部」如何传参 |
| D2 | 预览响应顶层 | `ok / errors / days` | `previewVersion / sourcePlanId / firstDayPlanId / days` | 新增 4 个顶层字段；`ok/errors` 在 `SplitBlocked` 中改形态 |
| D3 | `days[]` 字段 | `date, start, end, content, items, quantities` | `date, isFirstDay, workTicketNo, surveyNo, dailyContent?, quantities?` | 删 `start/end/items`；新增 `isFirstDay/workTicketNo/surveyNo`；`content`→`dailyContent`（命名不同） |
| D4 | **确认请求** | `{ days: [...] }`（逐日确认稿由前端提交） | `{ previewVersion }`（不带 days） | **最大差异**：现行服务端不保存预览状态、无版本；拟定仅凭指纹复原逐日结果，需明确预览态存放位置（内存/记录/纯函数重算），r3 未给实现约束 |
| D5 | 确认响应 | `{ ok, batchId, parentId, children[4 字段] }` | `{ ok, splitBatchId, firstDayPlanId, createdPlanIds }` | 字段重命名 + `children` 结构变 id 数组 |
| D6 | 错误形态 | 400/409 `{ error, errors[] / blocks[] }` | `{ ok:false, error: enum, message }` | 新增 5 个错误码；现行 `blocks` 明细无对应 |
| D7 | 重复确认 | `splitBatchId` 命中 → 409「该计划已拆分」（`66`） | 判定为同一已完成拆分 → 200 返回已有结果（幂等） | 语义反转 |
| D8 | 拦截门禁 | 仅 `precheckSplit` 5 条（存在/周计划/非子/未拆/未执行/跨天，`62-70`） | 追加 `classifySplitSurvey`（有勘察/异常 survey）、已拆原记录、`EXHAUSTED`、`PREVIEW_STALE` | 预览与确认都要新增拦截 |
| D9 | 勘察/票号 | 子计划 `clone(before)` 沿用父 `surveyNo` 与 `workTicketNo`；父有 survey 则克隆对象（`143-145`） | 首日留原工单号、其余取新号；各日共用原勘察号；因有 survey 不可拆故不复制勘察对象 | 成功路径的写号与克隆逻辑需重写 |
| D10 | `unsplit` | `{ ok, removed }`，恢复快照 + 删标记 + 软删子计划 | 关闭（410/409 `SPLIT_IRREVERSIBLE`），不读快照、不删历史关系 | 语义反转 |
| D11 | `ticketNoMode` | 不存在于任何 body | 创建请求带 `ticketNoMode?: 'auto'\|'manual'`（缺省 `auto`） | 新增字段，见 §7 |

---

## 9. `parentPlanId` 用途与「真实原始来源」（回写 r3 2.5 / 2.6-5）

- `parentPlanId` 全仓只出现在：`server/routes/plan-split.js:65`（子计划不能再拆）、`137`（子记录写入）、`166`（撤销时找子）；`public/js/views/plans.js:345`（`canSplit` 排除）、`351-353`（`splitBadge` 显示源）；`scripts/smoke.js:3444` 等断言。**无其它模块读取，仅用于拆分来源标识。**
- 只读字段抽查（`workPlans` 31 条）：`parentPlanId` 2 条、`splitBatchId` 3 条、`splitSnapshot` 1 条；`copiedFrom` / `sourcePlanId` / `originalPlanId` / `copySource` / `sourceId` **均 0 条**。全仓源码亦 0 命中。
- 复制没有「真实原始来源」字段：`copyPlan()`（`268-280`）只改 `name`（「（副本）」后缀）、`status` 与两个编号，不写任何来源字段。
- **结论**：`parentPlanId` 目前**仅用于拆分来源**；复制无独立来源字段，也无需为新造字段找空位（r3 2.5「未核实前不新造字段、不复用 `parentPlanId` 表达复制来源」的约束可据此冻结为：本轮不新造）。「复制出的新计划是否需要记录真实原始来源」属蓝图未列的商务问题，仅登记（§12），不在本步定规则。

---

## 10. 冒烟撤销相关用例清单与旧→新映射草稿（回写 r3 1.3 / Step 8 前置）

### 10.1 现行用例清单（`scripts/smoke.js`，本步只读）

| 类别 | 位置 | 内容 |
|---|---|---|
| A 撤销主步 | `3554-3631` `await step('plans','撤销拆分：四类拦截（状态/编辑/工程量/勘察）+ 通过后恢复快照并删子计划')` | A 组 `3582-3589` 四类拦截 409 + `blocks` 文案；B 组 `3602-3611` 成功撤销（`un.ok/removed`、恢复 `endDate/content/wlPole`、清除 `splitBatchId/splitSnapshot`、子计划 404、列表只剩父）；C 组 `3627-3629` 另建勘察拦截 |
| B 前端静态步 | `3633-3690` `await step('结构','周计划拆分前端接线与列表样式…')` | `3644-3645` `canSplit` 排除规则；`3646` 拆分按钮；**`3647` 断言「撤销拆分」按钮存在**；`3678-3680` 断言「拆分/撤销拆分」单独占操作列第三行；**`3687` 断言「已拆分父计划改期应被拦截」** |
| C 相邻受影响断言 | `3364-3380` 预览不落库；`3407-3477` 拆分执行（`3433-3438` 快照/父勘察不动、`3444-3449` 子计划 `planType/parentPlanId/splitBatchId/survey.splitBatchId`）；`3474` 校验失败不得落库 | 与新语义（不写快照、不复制 survey、首日留原工单号、其余新号）相关 |
| D 其它 | `scripts/smoke.js:1535,1547,1567` 编号规则 3 步 | 新格式（801 起、一位码）将影响其断言，Step 8 需一并核对（登记，不属撤销映射） |

### 10.2 「旧用例 → 新拒绝语义用例」映射草稿（**仅草稿，本步不改 `scripts/smoke.js`**）

| 旧 | 新（等价替代，只增不减） |
|---|---|
| `3582-3589` 四类拦截 409 + blocks | 改为「`/unsplit` 一律 410/409 `SPLIT_IRREVERSIBLE`、无 `blocks` 分支」；另补「四类历史子计划改动仍在、关系不被清理」断言，保留对旧拦截路径不再被走通的覆盖 |
| `3602-3611` 成功撤销全组断言 | 反转为「撤销被拒绝 + 恢复效果全部不发生」：父 `endDate/content/wlPole` 仍为拆分后首日值、`splitBatchId`/`splitSnapshot` 仍在、子计划仍可 GET 且仍在列表 |
| `3627-3629` 另建勘察拦截 | 改为「子计划另建勘察后 `/unsplit` 仍被拒绝，勘察对象保留」 |
| `3647` 撤销按钮存在断言 | 反向断言：`plans.js` 不得再出现 `撤销拆分` 按钮、`planAct(...,'unsplit')` 分发与 `api.post(.../unsplit)` 调用 |
| `3678-3680` 操作列第三行 | 改为「第三行仅剩拆分按钮」，保留布局/390 宽覆盖 |
| `3687` 改期拦截断言 | 反向断言：不得出现「该计划已拆分，修改起止时间需先撤销拆分」；并补「已拆父计划可提交新的起止时间」的静态/接口用例 |
| `3644-3645` `canSplit` 排除 | 保留并改为新语义：非周计划 / 非未执行 / 子计划 / **已拆原记录（来源首日标识与子来源区分）** 均不可再拆 |
| `3433-3438` 快照与勘察克隆 | 改为「新拆分不写 `splitSnapshot`、不复制 `survey`；首日留原工单号、其余按各日开始月份新取；各日 `surveyNo` 共用原号且不被判为唯一性失败」 |
| `3364-3380` 预览不落库 | 保留并扩「预览不占号、返回 `previewVersion`」 |
| `3474` 校验失败不得落库 | 保留（等价） |
| 新增覆盖（r3 1.3 / 第 3 节） | `auto`/`manual` 未锁定拒绝、复制自动号（操作当天月份）、预览不占号、过期 409 零写入、重复确认不重生、双并发、保存失败零写入、跨月月底、999 `EXHAUSTED` 明确提示且整次不落库、共用勘察号合法、预览与确认均拦截已有/异常勘察、只打开未保存可拆、已拆原记录不可再拆、撤销关闭且历史关系仍在不可恢复、复制不继承拆分限制但保留 survey 仍拦截、390 宽 |

> **169 / 0 不得写成「本步已复现」**；本步未运行冒烟，替代后条数只增不减由 Step 8 落地并留映射定稿。

---

## 11. 测试副本与端口（回写 r3 1.2 / 2.6-3；只查不启）

| 线 | 目录 | 归属 / 分支 | 运行状态（只读 `lsof`） |
|---|---|---|---|
| **5178** | `/Users/admin/Workbuddy/epds-副本-编号对齐-20261113`（存在） | **整项目复制**，无 `.git`、无独立分支；`package.json` 仍 `2.22.0`；`node_modules` 软链主仓；`data/` 为真实库副本。`public/js/views/plans.js`、`server/routes/plan-split.js`、`scripts/smoke.js` 与主仓 HEAD **逐字节相同**（`cmp` 同） | **未监听**（已停）；本步未启动 |
| **5174** | `/Users/admin/Workbuddy/epds-副本测试-20261111`（存在；进程 PID `11505` 的 cwd 即此目录） | 无 `.git`；`package.json` `2.21.0`；历史 P4「业务日期改造」验收线（见 `.workbuddy/memory/2026-11-11.md:76,86,96,111,129`）；另有主仓 worktree `/Users/admin/Workbuddy/_p4-worktree-fix` @ `d14d78b [feat/biz-dates]`，**未运行** | **正在监听 5174（PID 11505）**；本步未启动、未重启、未触碰 |
| 5173 | 生产 `/Users/admin/WorkBuddy/复刻/epds` | `main` @ `d8849e1` (v2.23.0) | **未监听**（用户已停）；生产只读 |

**建议（待用户/审阅确认，本步不启动任何进程）**：后续验收统一走 **5178 线**——它是按当前 HEAD 同步的整项目真实库副本、当前未运行、可按需重建 `data/`；5174 是 2.21.0 历史线且已有进程在跑，不宜与本轮混用、也不应重启。主仓 `git worktree list` 另有 `_p4-worktree-fix`（`feat/biz-dates` @ `d14d78b`），属早期遗留、不在本轮范围。若审阅选择 5174 线，须先明确如何处置既有 PID 11505 与旧版本差异，本步不涉及。

---

## 12. 与 r3 记载的差异、清单外登记（不自行改蓝图口径；停止条件判定）

| # | 事项 | 事实 | 处置 |
|---|---|---|---|
| E1 | r3 2.2「工量沿用既有『当日工作量 8 项』格式」 | 实际 `PLAN_QTY_FIELDS`（`server/routes/plans.js:21`）与 `QTY_FIELDS`（`server/core/plan-split.js:14`）均为 **7 项** `wlPole…wlLine04`；`outageHours`（时户数）是另一校验字段（`public/js/views/plans.js:1387`） | **口径差异，逐条列明**；交 Grokbot 审阅，本步不改蓝图、不写死 schema |
| E2 | r3 1.2「`server/core/crud.js` 通用 GET/PUT/DELETE」 | 该文件还有 `POST`（`22-27`），`workPlans` 创建即经此 | 已回写 §2；不改文件 |
| E3 | r3 1.2 待核「注册完整面」 | 实测 **22 个** workPlans 相关挂载点，`materials.js:226` 的 `:id/material-usage` 在 `plan-split` **之前**加载 | 已回写 §2 |
| E4 | r3 Step 3 前置「若实际经过 core/crud.js」 | 确实经过，但可在 `routes/plans.js` 内以专用 POST 覆盖，**不必改 `core/crud.js`** | 已回写 §2.3 / §3；Step 3 第三项改为「不触发」 |
| E5 | r3 Step 6 第三项「关闭 API 须改单个注册文件」 | 只需改 `server/routes/plan-split.js:158` 处理函数，**不必改 `server.js`** | 已回写 §2.3；Step 6 第三项不触发 |
| E6 | r3 1.3「5173/5175/5178 已停」 | 5173、5178 未监听；**5174 正在运行**（PID 11505，2.21.0 历史线） | 已回写 §11；未启动/重启任何服务 |
| E7 | 5178 副本 `package.json` 为 `2.22.0`，主仓 `2.23.0` | 三个关键业务文件与主仓 HEAD 逐字节相同；升版只改 `package.json`，故版本号落后但业务代码一致 | 登记；后续验收前若需版本一致须另行授权同步，本步不做 |
| E8 | `POST /api/workPlans/import`（`routes/plans.js:53`）也写 `workPlans`，白名单 `48` 含 `surveyNo/workTicketNo` | r3 Step 3 只覆盖 `POST /api/workPlans` | **清单外发现，仅登记**；不顺手处理、不扩大核实面 |
| E9 | 生成资料覆盖失败的内存回滚先例（`routes/plans.js:652-694`） | 可用于 §3 的「保存失败零写入」实现参考 | 登记为技术依据 |
| E10 | r3 1.3「附件 12 列 / 22 列自相矛盾」 | 本步清单未含月计划列数核实，**未核实** | 保持 r3 结论（12 列定版不改），不扩大核实面 |

**停止条件判定**：① 必须修改的注册 / CRUD / `saveDB` / 测试文件均已列入后续 Step 文件清单（含条件性位置）→ 未命中；② 第 6 项结论为「字段足以表达、不需新 `planType`」→ 未命中；③ 上表 E1 为字段数口径差异、其余为路径/条件性修正，**未构成与 r3 的重大事实出入**（蓝图本就标注「待 Step 1 核实」，且明确不得写死）→ 未命中。差异已逐条列明，未自行修改 r3 口径。

**门禁声明**：审阅结论与用户后续授权未到之前，**不进入 Step 2**；手填（`manual`）权限与历史重复工单号策略、日计划类型两项商务未锁定前，相关步骤只许失败关闭（详见 `契约冻结.md`）。

---

## 13. 后续各 Step 文件列表修正清单（汇总，供 MetaMuse 出提示词）

| Step | r3 原占位 | **修正为** | 为什么 |
|---|---|---|---|
| Step 2 | `server/<待核定>/plan-ticket-no.js` | `server/core/plan-ticket-no.js` | core/ 为纯函数模块既有惯例 |
| Step 2 | 「核定的纯函数测试文件」 | `scripts/plan-ticket-no.test.js`（新增单文件） | scripts/ 既有 Node 直跑惯例，无测试框架 |
| Step 3 | 第 2 项「核定的创建取号测试文件」 | `scripts/plan-mgmt-20261114.test.js`（新增单文件，Step 3–7 共用） | 路径核定、避免占位符 |
| Step 3 | 第 3 项「注册或 saveDB 所在单个文件」 | **默认不触发**；仅当审阅要求磁盘原子写时才列 `server/core/db.js` | 单进程同步临界区可不改这些文件（§3） |
| Step 4 | 第 3 项「核定的前端编号/复制测试文件」 | `scripts/plan-mgmt-20261114.test.js` | 同上；静态断言沿用 smoke.js 写法 |
| Step 5 | 第 3 项「核定的预览测试文件」 | `scripts/plan-mgmt-20261114.test.js` | 同上 |
| Step 6 | 第 2 项「核定的确认/并发/过期/幂等/失败/撤销关闭测试文件」 | `scripts/plan-mgmt-20261114.test.js` | 同上 |
| Step 6 | 第 3 项「关闭 API 必须改的单个注册文件」 | **不触发**（只需 `server/routes/plan-split.js`） | §2.3 |
| Step 7 | 第 3 项「核定的前端拆分/复制测试文件」 | `scripts/plan-mgmt-20261114.test.js` | 同上 |
| Step 8 | 「Step 1 核定的冒烟文件」 | `scripts/smoke.js`（+ 可选 1 个新冒烟用例文件） | 全仓唯一全量冒烟 |
| Step 8 | 「核定规划目录中的 PLAN.md / 契约冻结.md」 | `docs/plans/plan-mgmt-20261114/PLAN.md`、`契约冻结.md` | 规划目录核定在仓库内 |
| 全局 | 「核定副本与端口」 | 建议 5178 线（目录见 §11），**待用户/审阅确认** | §11；本步不启动 |

`plan-staff.js`、`monthPlans.js`、`server/routes/monthPlans.js`、`server/routes/workticket.js`、`server/core/survey-doc.js`、`server/core/crud.js`（默认）、生产 `data/db.json`、夹具与 R1–R8 相关文件仍不在任何 Step 的修改列表中（r3 3 末尾约束不变）。
