# 电网生产ERP 运行时 API 契约（逆向得到）

> 来源：用账号 `602981262@qq.com` 登录后抓包（2026-10-12）。
> 登录租户：**某建设工程有限公司（示例租户）**（tenantSlug `bylhjs`，tenantId `16e27ea4-950c-402d-bac0-35405a2f1e5d`）。
> 说明：本文件记录的是**运行时真实契约**（模块路由 + 字段名），用于本系统的字段与接口约定参考。

## 技术栈（从 chunk 反出）
- 前端：**Next.js（App Router）** + React（非 Vue）。
- 后端：**腾讯云开发 CloudBase**（JWT 鉴权）。
- 登录：`POST /api/auth/cloudbase/session`，Header `x-cloudbase-auth: 1` + `Origin/Referer` 同源，Body `{"username","password"}` → 返回 `cb_access_token`（HttpOnly JWT，30 天）。
- 业务数据：Next.js API 路由 `/api/cloudbase/saas/<module>`，带登录 cookie 调用。

## 真实菜单 / 路由（从前端 chunk 反出，含中文标签）
| 路由 | 菜单标签 | 备注 |
|------|----------|------|
| /saas | 用户中心 | home |
| /saas/projects | 项目列表 | |
| /saas/erp-materials | 材料台账 | |
| /saas/plans | 计划管理 | 含周/月/日 |
| /saas/weekly-plans | （周计划，归计划管理） | |
| /saas/monthly-plans | （月计划，归计划管理） | |
| /saas/daily-work | 工程实际施工量 | |
| /saas/borrow-work | 借工管理 | |
| /saas/completion-documents | 竣工资料（开发中） | **官方标注开发中** |
| /saas/documents | 文档中心 | |
| /saas/settings | 全局设置 | |
| /saas/users | 用户管理 | 含 /saas/personnel |

## 已验证可取的实时字段 schema（GET 返回 200）
### projects  → `/api/cloudbase/saas/projects`  (data.list[])
`id, tenant_id, package_parent_id, name_package, name_package_abbrev, annual_plan_id, batch, substation_id, manager_id, sub_project_name, start_date, expected_completion_date, project_type, work_type, work_specialty, province_department, subcontractor_unit_id, contract_number, reported_plan_wire_hv_m, reported_plan_wire_lv_m, reported_plan_wire_cable_m, completed_at, created_at, annual_plans, substations, profiles`

### erp-materials → `/api/cloudbase/saas/erp-materials`  (data.rows[]，实测 53 行)
`id, tenant_id, project_id, import_batch_id, source_file_name, source_row_number, source_type, source_note, counts_for_progress, project_name_source, material_code, material_description, system_type_name, system_material_name, system_unit, unit, expected_quantity, purchase_order_no, created_at, arrived_quantity, remaining_quantity, arrival_status`
- `arrival_status` 取值：`全部到库` / `部分到库` / `未到库`（由系统按数量自动算）
- 数据来自 Excel 导入（`source_file_name`/`source_row_number`/`import_batch_id`），印证"导入批次"机制。

### weekly-plans → `/api/cloudbase/saas/weekly-plans`  (data.list[])
`id, tenant_id, week_start_date, plan_name, work_type, plan_start_at, plan_end_at, work_content, project_id, project_ids[], status, is_staged, updated_at, created_at`

### daily-work → `/api/cloudbase/saas/daily-work`  (data.reports[])
`id, tenant_id, report_date, work_types[], project_id, worker_ids[], submitted_by, ...`

### personnel-directory → `/api/cloudbase/saas/personnel-directory`（或 `?tenantId=`）  (data.personnel[])
`id, tenant_id, name, id_number, phone, role, team, certificate_types[], admission_valid_from, admission_valid_to, ...`
- 与「作业人员名单导入模板.xlsx」完全吻合：`name / id_number(身份证) / phone / role(技工·高处作业人员) / team(施工一队) / certificate_types / admission_valid_from~to`。

### context → `/api/cloudbase/saas/context`  (data.list[0])
`tenantId, tenantSlug, tenantName, membershipRole, businessRole, profileId, expiresOn, setupRequired, setupCompletedAt`

### project-options → `/api/cloudbase/saas/project-options`
`annualPlans[], substations[], subcontractors[], managers[]`（下拉选项）

### settings → `/api/cloudbase/saas/settings`
`annualPlans[], substations[], managers[], ...`

## 取不到 / 需特殊参数的模块（GET 返回 404）
- `borrow-work`、`documents`、`completion-documents`(官方开发中)、`monthly-plans`、`users`：plain GET 返回 404，疑似需要特定查询参数或走不同访问方式（部分可能仍在开发）。
- `personnel-directory` 用 `?tenantId=`；不加也可取（返回当前租户全部人员）。

## 本系统 → 参考字段 对照
| 本系统字段 | 参考字段 |
|---|---|
| projects.name | projects.name_package |
| projects.code | （无；可映射 contract_number） |
| projects.type | projects.project_type |
| materials.description | erp-materials.material_description |
| materials.qtyRequired | erp-materials.expected_quantity |
| materials.qtyArrived | erp-materials.arrived_quantity |
| materials.qtyNotArrived | erp-materials.remaining_quantity |
| materials.status | erp-materials.arrival_status |
| materials.code | erp-materials.material_code |
| materials.orderNo | erp-materials.purchase_order_no |
| materials.unit | erp-materials.unit |
| materials.source | erp-materials.source_type |
| workers.idNumber | personnel-directory.id_number |
| workers.role | personnel-directory.role |
| workers.team | personnel-directory.team |
| workers.certType | personnel-directory.certificate_types |
| workers.validFrom | personnel-directory.admission_valid_from |
| workers.validTo | personnel-directory.admission_valid_to |

## 结论
- 原始源码拿不到（只有压缩后的运行产物）。
- 但**运行时契约（路由 + 字段名 + 真实数据样例）已完整反出**，足以把本系统的 schema 做到字段级一致。
- 后端逻辑仍由我们自己实现（CloudBase 服务端不在浏览器内），但 API 字段已对齐。
