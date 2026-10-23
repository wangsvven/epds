/* ========== views/documents ========== */
/* 文档中心视图 DocumentsView（文档资源分类与文件、危险点库、工作票自动化配置资料库）。 */
/* ---------------- 文档中心（对齐原系统截图 2026-10-12） ---------------- */
const DocumentsView = {
  setup() {
    const docs = reactive({ categories: [], files: [] });
    const docTab = ref('resources');
    const activeCat = ref('规范文件');
    const filePage = ref(1);
    const filePageSize = ref(20);
    const uploadInput = ref(null);
    const previewVisible = ref(false);
    const previewData = reactive({ kind: '', name: '', lines: [], sheets: [], message: '', url: '' });
    const previewPage = ref(1);
    // xlsx 预览：仅首个工作表，首行作表头，100 条/页
    const previewSheet = computed(() => (previewData.sheets && previewData.sheets[0]) || null);
    const previewHeader = computed(() => (previewSheet.value && previewSheet.value.rows[0]) || []);
    const previewRows = computed(() => (previewSheet.value && previewSheet.value.rows.slice(1)) || []);
    const previewPaged = computed(() => previewRows.value.slice((previewPage.value - 1) * 100, previewPage.value * 100));
    function fmtCell(v) { return (v === '' || v === null || v === undefined) ? '–' : v; }

    async function load() {
      try {
        const d = await api.get('/api/documents');
        docs.categories = d.categories || []; docs.files = d.files || [];
        if (!docs.categories.includes(activeCat.value)) activeCat.value = docs.categories[0] || '';
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    const catFiles = computed(() => docs.files.filter(f => f.category === activeCat.value));
    function catCount(c) { return docs.files.filter(f => f.category === c).length; }

    /* ---- 工作票自动化配置：配置状态 ---- */
    const wt = reactive({ loading: false, ready: false, versionLabel: 'v2', updatedAt: '', sha256: '', items: [], hazardCount: 0 });
    const wtHazardOpen = ref(false);
    const wtHazards = ref([]);
    // 企业危险点库：全量列表 + 搜索 + 分页 + 新增/编辑
    const hazLoading = ref(false);
    const hazSearch = ref('');
    const hazKeyword = ref('');
    const hazPage = ref(1);
    const hazPageSize = ref(10);
    const hazDlg = reactive({ visible: false, editing: false, busy: false, id: '', hazard: '', measure: '', sort: null });
    const hazView = reactive({ visible: false, hazard: '', measure: '' });
    const hazImportInput = ref(null);
    function openHazView(row) { Object.assign(hazView, { visible: true, hazard: row.hazard || '', measure: row.measure || '' }); }
    const hazFiltered = computed(() => {
      const k = hazKeyword.value.trim();
      if (!k) return wtHazards.value;
      return wtHazards.value.filter(h => (h.hazard || '').includes(k) || (h.measure || '').includes(k));
    });
    const hazPaged = computed(() => hazFiltered.value.slice((hazPage.value - 1) * hazPageSize.value, hazPage.value * hazPageSize.value));
    async function loadHazards() {
      hazLoading.value = true;
      try { wtHazards.value = await api.get('/api/workticket/hazards'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { hazLoading.value = false; }
    }
    function applyHazSearch() { hazKeyword.value = hazSearch.value; hazPage.value = 1; }
    function reloadHazards() { hazSearch.value = ''; hazKeyword.value = ''; hazPage.value = 1; loadHazards(); }
    function openHazAdd() {
      Object.assign(hazDlg, { visible: true, editing: false, busy: false, id: '', hazard: '', measure: '', sort: null });
    }
    function openHazEdit(row) {
      Object.assign(hazDlg, { visible: true, editing: true, busy: false, id: row.id, hazard: row.hazard || '', measure: row.measure || '', sort: row.sort ?? null });
    }
    async function submitHaz() {
      if (!hazDlg.hazard.trim()) { ElementPlus.ElMessage.warning('请填写危险点'); return; }
      if (!hazDlg.measure.trim()) { ElementPlus.ElMessage.warning('请填写控制措施'); return; }
      hazDlg.busy = true;
      try {
        const payload = { hazard: hazDlg.hazard.trim(), measure: hazDlg.measure.trim(), sort: hazDlg.sort };
        if (hazDlg.editing) await api.put('/api/documents/hazard/' + hazDlg.id, payload);
        else await api.post('/api/documents/hazard', payload);
        ElementPlus.ElMessage.success('已保存');
        hazDlg.visible = false;
        await loadHazards(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { hazDlg.busy = false; }
    }
    async function removeHaz(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除危险点「' + (row.hazard || '').slice(0, 20) + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/documents/hazard/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadHazards(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function triggerHazImport() { if (hazImportInput.value) hazImportInput.value.click(); }
    async function onHazImport(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/documents/hazard/import', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '导入失败');
        ElementPlus.ElMessage.success('导入完成：新增 ' + data.added + ' 条，跳过 ' + data.skipped + ' 条');
        await loadHazards(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadWt() {
      wt.loading = true;
      try {
        const st = await api.get('/api/workticket/config-status');
        Object.assign(wt, st);
        if (wtHazardOpen.value) await loadHazards();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { wt.loading = false; }
    }
    /* ---- 资料库（作业内容匹配规则 / 技术措施 / 安全措施 / 医院联系方式 / 默认应急医院） ---- */
    const lib = reactive({ groups: [], categories: [], techOptions: [], safetyOptions: [] });
    /* 各分组可独立展开（互不影响） */
    const libOpen = reactive({ rules: false, tech: false, safety: false, hospitals: false, emergency: false });
    const rules = ref([]);
    const ruleDlg = reactive({ visible: false, editing: false, busy: false, id: '', workType: '', category: '', keywords: '', techId: '', techName: '', techIds: [], safetyId: '', safetyName: '', safetyIds: [] });
    const ruleImportInput = ref(null);
    const rulePreview = reactive({ visible: false, busy: false, rows: [], errors: [] });
    /* 施工技术 / 安全措施原文（同结构，kind = tech | safety） */
    const measures = reactive({ tech: [], safety: [] });
    /* 默认模板（载入默认 / 清除） */
    const defaultMea = reactive({ tech: 0, safety: 0, savedAt: '', builtin: false, busy: false });
    async function loadDefaultMeta() {
      try {
        const d = await api.get('/api/workticket/measures/default');
        defaultMea.tech = d.tech || 0; defaultMea.safety = d.safety || 0;
        defaultMea.savedAt = d.savedAt || ''; defaultMea.builtin = !!d.builtin;
      } catch (e) { /* 忽略 */ }
    }
    const defaultMeaTip = computed(() => {
      if (!defaultMea.tech && !defaultMea.safety) return '暂无默认模板';
      return `默认模板：技术 ${defaultMea.tech} 条 · 安全 ${defaultMea.safety} 条（${defaultMea.builtin ? '内置标准资料' : '已保存快照'}）`;
    });
    // 清除：清空「施工技术措施原文」「施工安全措施原文」两个列表（默认配置保留，可用「载入默认」恢复）
    const cntOfGroup = key => { const g = (lib.groups || []).find(x => x.key === key); return g ? (g.count || 0) : 0; };
    async function clearAllMeasures() {
      const tN = cntOfGroup('tech'), sN = cntOfGroup('safety');
      if (!tN && !sN) { ElementPlus.ElMessage.info('当前没有可清除的措施原文'); return; }
      try {
        await ElementPlus.ElMessageBox.confirm(
          `确定清除「施工技术措施原文」与「施工安全措施原文」的全部内容（技术 ${tN} 条 / 安全 ${sN} 条）？清除后可通过「载入默认」重新载入。`,
          '清除措施原文', { type: 'warning', confirmButtonText: '确定清除', cancelButtonText: '取消', confirmButtonClass: 'el-button--danger' });
      } catch (e) { return; }
      defaultMea.busy = true;
      try {
        const d = await api.post('/api/workticket/measures/clear-all');
        ElementPlus.ElMessage.success(`已清除：技术 ${d.clearedTech} 条 / 安全 ${d.clearedSafety} 条`);
        await loadMeasures('tech'); await loadMeasures('safety'); await loadLib(); await loadWt();
        meaPage.tech = 1; meaPage.safety = 1;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { defaultMea.busy = false; }
    }
    /* 措施原文分页：默认每页 10 条，可切换 10/20/50 */
    const MEA_PAGE_SIZE = 10;
    const meaPage = reactive({ tech: 1, safety: 1 });
    const meaPageSize = reactive({ tech: 10, safety: 10 });
    const meaTotal = kind => (measures[kind] || []).length;
    const meaPaged = kind => {
      const list = measures[kind] || [];
      const size = meaPageSize[kind] || MEA_PAGE_SIZE;
      const start = (meaPage[kind] - 1) * size;
      return list.slice(start, start + size);
    };
    function meaSetPageSize(kind, n) { meaPageSize[kind] = n; meaPage[kind] = 1; }
    watch(() => [measures.tech.length, measures.safety.length, meaPageSize.tech, meaPageSize.safety], () => {
      ['tech', 'safety'].forEach(k => {
        const size = meaPageSize[k] || MEA_PAGE_SIZE;
        const maxP = Math.max(1, Math.ceil((measures[k] || []).length / size));
        if (meaPage[k] > maxP) meaPage[k] = maxP;
      });
    });
    async function loadDefaultMeasures() {
      if (!defaultMea.tech && !defaultMea.safety) await loadDefaultMeta();
      if (!defaultMea.tech && !defaultMea.safety) { ElementPlus.ElMessage.warning('默认模板为空：既无内置标准资料，也未保存过默认配置'); return; }
      defaultMea.busy = true;
      try {
        const d = await api.post('/api/workticket/measures/default/load');
        const r = d.result || {};
        const t = r.tech || { added: 0, skipped: 0 }, s = r.safety || { added: 0, skipped: 0 };
        const added = (t.added || 0) + (s.added || 0);
        ElementPlus.ElMessage.success(added
          ? `已载入默认：技术新增 ${t.added} / 跳过 ${t.skipped}，安全新增 ${s.added} / 跳过 ${s.skipped}`
          : '默认内容已全部存在，无需载入');
        await loadMeasures('tech'); await loadMeasures('safety'); await loadLib(); await loadWt(); await loadDefaultMeta();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { defaultMea.busy = false; }
    }
    const meaDlg = reactive({ visible: false, editing: false, busy: false, kind: 'tech', id: '', sort: '', title: '', content: '' });
    /* 措施原文全文查看（二级页面） */
    const meaView = reactive({ visible: false, kind: 'tech', title: '', sort: '', content: '' });
    function openMeaView(kind, row) {
      Object.assign(meaView, {
        visible: true, kind,
        title: row.title || '',
        sort: row.sort === undefined || row.sort === null ? '' : String(row.sort),
        content: row.content || ''
      });
    }
    /* 措施原文解析：原文中的表格以「制表符 Tab」分列（Excel 粘贴即带 Tab），
       连续 ≥2 行且每行 ≥2 个非空单元格即识别为表格；散文里的 Tab 只是行首缩进（仅 1 个非空格），不会误判。 */
    const meaViewBlocks = computed(() => {
      const lines = String(meaView.content || '').split(/\r?\n/);
      const splitTab = line => {
        const raw = line.split('\t').map(s => s.trim());
        while (raw.length && raw[raw.length - 1] === '') raw.pop(); // 去掉行尾空列
        return raw;
      };
      const nonEmpty = cells => cells.filter(c => c !== '').length;
      // 值单元格：含数字且不含中文（"800" / "450/600" / "＜1" / "1.9（2.2）" 视为值；"120及以下" 不是）
      const valueLike = c => /[\d０-９]/.test(c) && !/[\u4e00-\u9fa5]/.test(c);
      const blocks = [];
      let textBuf = [];
      const flushText = () => {
        if (!textBuf.length) return;
        const t = textBuf.join('\n');
        if (t.trim()) blocks.push({ type: 'text', text: t });
        textBuf = [];
      };
      let i = 0;
      while (i < lines.length) {
        if (nonEmpty(splitTab(lines[i])) < 2) { textBuf.push(lines[i]); i++; continue; }
        // 收集连续的可表格化行
        let j = i;
        const rows = [];
        while (j < lines.length) {
          const c = splitTab(lines[j]);
          if (nonEmpty(c) < 2) break;
          rows.push(c); j++;
        }
        if (rows.length >= 2) {
          flushText();
          const cols = Math.max(...rows.map(r => r.length));
          const grid = rows.map(r => { const c = r.slice(); while (c.length < cols) c.push(''); return c; });
          // 首行全为文字、且后续行含数值 → 视作表头
          const header = !grid[0].some(valueLike) && grid.slice(1).some(r => r.some(valueLike));
          blocks.push({ type: 'table', header, cols, headCells: rows[0].slice(), rows: grid });
          i = j;
        } else {
          textBuf.push(lines[i]); i++;
        }
      }
      flushText();
      return blocks;
    });
    const measureLabel = kind => (kind === 'safety' ? '施工安全措施原文' : '施工技术措施原文');
    /* 医院联系方式 */
    const hospitals = ref([]);
    const hosDlg = reactive({ visible: false, editing: false, busy: false, id: '', area: '', name: '', address: '', phone: '' });
    /* 默认应急医院（单条配置，失焦即保存） */
    const emergency = reactive({ name: '', phone: '', saving: false, pending: false });
    /* 通用导入预览（技术/安全措施原文、医院联系方式共用） */
    const impPreview = reactive({ visible: false, busy: false, kind: '', rows: [], errors: [] });
    const impInput = ref(null);

    async function loadLib() {
      try {
        const d = await api.get('/api/workticket/library');
        lib.groups = d.groups || []; lib.categories = d.categories || [];
        lib.techOptions = d.techOptions || []; lib.safetyOptions = d.safetyOptions || [];
        const em = d.emergency || {};
        emergency.name = em.name || ''; emergency.phone = em.phone || '';
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadRules() {
      try { rules.value = await api.get('/api/workticket/rules'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadMeasures(kind) {
      try { measures[kind] = await api.get('/api/workticket/measures/' + kind); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function loadHospitals() {
      try { hospitals.value = await api.get('/api/workticket/hospitals'); }
      catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function toggleLib(key) {
      libOpen[key] = !libOpen[key];
      if (!libOpen[key]) return;
      if (key === 'rules') await loadRules();
      else if (key === 'tech' || key === 'safety') await loadMeasures(key);
      else if (key === 'hospitals') await loadHospitals();
    }
    /* ---- 施工技术 / 安全措施原文 ---- */
    function openMeaAdd(kind) {
      Object.assign(meaDlg, { visible: true, editing: false, busy: false, kind, id: '', sort: '', title: '', content: '' });
    }
    function openMeaEdit(kind, row) {
      Object.assign(meaDlg, {
        visible: true, editing: true, busy: false, kind, id: row.id,
        sort: row.sort === undefined || row.sort === null ? '' : String(row.sort),
        title: row.title || '', content: row.content || ''
      });
    }
    // 措施原文输入框：按 Tab 插入制表符（避免跳焦点），便于手工录入「Tab 分列」的表格
    function meaInsertTab(e) {
      const el = e && e.target;
      if (!el || el.tagName !== 'TEXTAREA') return;
      const start = el.selectionStart, end = el.selectionEnd, val = el.value;
      el.value = val.slice(0, start) + '\t' + val.slice(end);
      el.selectionStart = el.selectionEnd = start + 1;
      el.dispatchEvent(new Event('input', { bubbles: true })); // 同步 v-model
    }
    async function submitMea() {
      if (!String(meaDlg.title || '').trim()) { ElementPlus.ElMessage.warning('请填写条文标题 / 关键字'); return; }
      if (!String(meaDlg.content || '').trim()) { ElementPlus.ElMessage.warning('请填写措施原文'); return; }
      meaDlg.busy = true;
      try {
        const payload = { sort: String(meaDlg.sort || '').trim(), title: meaDlg.title, content: meaDlg.content };
        if (meaDlg.editing) await api.put('/api/workticket/measures/' + meaDlg.kind + '/' + meaDlg.id, payload);
        else await api.post('/api/workticket/measures/' + meaDlg.kind, payload);
        ElementPlus.ElMessage.success('已保存');
        meaDlg.visible = false;
        await loadMeasures(meaDlg.kind); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { meaDlg.busy = false; }
    }
    async function removeMea(kind, row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除「' + (row.title || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/workticket/measures/' + kind + '/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadMeasures(kind); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    /* ---- 医院联系方式 ---- */
    function openHosAdd() {
      Object.assign(hosDlg, { visible: true, editing: false, busy: false, id: '', area: '', name: '', address: '', phone: '' });
    }
    function openHosEdit(row) {
      Object.assign(hosDlg, {
        visible: true, editing: true, busy: false, id: row.id,
        area: row.area || '', name: row.name || '', address: row.address || '', phone: row.phone || ''
      });
    }
    async function submitHos() {
      if (!hosDlg.area.trim()) { ElementPlus.ElMessage.warning('请填写作业地址匹配词'); return; }
      if (!hosDlg.name.trim()) { ElementPlus.ElMessage.warning('请填写医院名称'); return; }
      if (!hosDlg.address.trim()) { ElementPlus.ElMessage.warning('请填写医院地址'); return; }
      if (!hosDlg.phone.trim()) { ElementPlus.ElMessage.warning('请填写联系电话'); return; }
      hosDlg.busy = true;
      try {
        const payload = { area: hosDlg.area, name: hosDlg.name, address: hosDlg.address, phone: hosDlg.phone };
        if (hosDlg.editing) await api.put('/api/workticket/hospitals/' + hosDlg.id, payload);
        else await api.post('/api/workticket/hospitals', payload);
        ElementPlus.ElMessage.success('已保存');
        hosDlg.visible = false;
        await loadHospitals(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { hosDlg.busy = false; }
    }
    async function removeHos(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除「' + (row.name || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/workticket/hospitals/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadHospitals(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function saveEmergency() {
      // 连续切换输入框时逐个排队，避免前一次保存未返回而丢失后一次输入
      if (emergency.saving) { emergency.pending = true; return; }
      emergency.saving = true;
      let ok = false;
      do {
        emergency.pending = false;
        try {
          await api.put('/api/workticket/emergency-hospital', { name: emergency.name, phone: emergency.phone });
          ok = true;
        } catch (e) { ElementPlus.ElMessage.error(e.message); break; }
      } while (emergency.pending);
      emergency.saving = false;
      if (ok) ElementPlus.ElMessage.success('已保存');
    }

    /* ---- 通用导入预览（措施原文 / 医院联系方式） ---- */
    function triggerImp(kind) {
      impPreview.kind = kind;
      if (impInput.value) impInput.value.click();
    }
    function impUrl(kind, tail) {
      return kind === 'hospitals' ? '/api/workticket/hospitals/' + tail : '/api/workticket/measures/' + kind + '/' + tail;
    }
    async function onImp(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch(impUrl(impPreview.kind, 'import-preview'), {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '解析失败');
        impPreview.rows = data.rows || []; impPreview.errors = data.errors || [];
        impPreview.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function confirmImp() {
      if (!impPreview.rows.length) { ElementPlus.ElMessage.warning('没有可导入的数据'); return; }
      impPreview.busy = true;
      try {
        const r = await api.post(impUrl(impPreview.kind, 'import'), { rows: impPreview.rows });
        ElementPlus.ElMessage.success('已导入 ' + (r.added || 0) + ' 条');
        impPreview.visible = false;
        const kind = impPreview.kind;
        if (kind === 'hospitals') await loadHospitals(); else await loadMeasures(kind);
        await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { impPreview.busy = false; }
    }

    // 规则里「关联措施」用多选：id ↔ 名称互转（兼容历史单值/分号拼接数据）
    function ruleOptions(kind) { return (kind === 'tech' ? lib.techOptions : lib.safetyOptions) || []; }
    function ruleIdsOfKind(kind, row) {
      const opts = ruleOptions(kind);
      const idStr = kind === 'tech' ? (row.techId || '') : (row.safetyId || '');
      const nameStr = kind === 'tech' ? (row.techName || '') : (row.safetyName || '');
      let ids = String(idStr).split(/[,，;；]/).map(s => s.trim()).filter(Boolean);
      const names = String(nameStr).split(/[；;]/).map(s => s.trim()).filter(Boolean);
      if (!ids.length || ids.length !== names.length) {
        ids = names.map(n => { const o = opts.find(x => x.name === n); return o ? o.id : ''; }).filter(Boolean);
      }
      return ids;
    }
    function ruleNamesOfKind(kind, ids) {
      const opts = ruleOptions(kind);
      return (ids || []).map(id => { const o = opts.find(x => x.id === id); return o ? o.name : ''; }).filter(Boolean);
    }
    function openRuleAdd() {
      Object.assign(ruleDlg, { visible: true, editing: false, busy: false, id: '', workType: '', category: '', keywords: '', techId: '', techName: '', techIds: [], safetyId: '', safetyName: '', safetyIds: [] });
    }
    function openRuleEdit(row) {
      Object.assign(ruleDlg, {
        visible: true, editing: true, busy: false, id: row.id,
        workType: row.workType || '', category: row.category || '',
        keywords: row.keywordsRaw || (row.keywords || []).join('、'),
        techId: row.techId || '', techName: row.techName || '',
        techIds: ruleIdsOfKind('tech', row),
        safetyId: row.safetyId || '', safetyName: row.safetyName || '',
        safetyIds: ruleIdsOfKind('safety', row)
      });
    }
    async function submitRule() {
      if (!ruleDlg.workType.trim()) { ElementPlus.ElMessage.warning('请填写作业类型名称'); return; }
      if (!ruleDlg.category && !ruleDlg.keywords.trim()) { ElementPlus.ElMessage.warning('请选择匹配类别或填写自定义匹配词'); return; }
      ruleDlg.busy = true;
      try {
        const techNames = ruleNamesOfKind('tech', ruleDlg.techIds);
        const safetyNames = ruleNamesOfKind('safety', ruleDlg.safetyIds);
        const payload = {
          workType: ruleDlg.workType.trim(), category: ruleDlg.category || '',
          keywords: ruleDlg.keywords.trim(),
          techId: (ruleDlg.techIds || []).join(','), techName: techNames.join('；'),
          safetyId: (ruleDlg.safetyIds || []).join(','), safetyName: safetyNames.join('；')
        };
        if (ruleDlg.editing) await api.put('/api/workticket/rules/' + ruleDlg.id, payload);
        else await api.post('/api/workticket/rules', payload);
        ElementPlus.ElMessage.success('已保存');
        ruleDlg.visible = false;
        await loadRules(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { ruleDlg.busy = false; }
    }
    async function removeRule(row) {
      try { await ElementPlus.ElMessageBox.confirm('确认删除规则「' + (row.workType || '') + '」？', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' }); }
      catch (e) { return; }
      try {
        await api.del('/api/workticket/rules/' + row.id);
        ElementPlus.ElMessage.success('已删除');
        await loadRules(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function triggerRuleImport() { if (ruleImportInput.value) ruleImportInput.value.click(); }
    async function onRuleImport(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/workticket/rules/import-preview', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '解析失败');
        rulePreview.rows = data.rows || []; rulePreview.errors = data.errors || [];
        rulePreview.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    async function confirmRuleImport() {
      if (!rulePreview.rows.length) { ElementPlus.ElMessage.warning('没有可导入的数据'); return; }
      rulePreview.busy = true;
      try {
        const r = await api.post('/api/workticket/rules/import', { rows: rulePreview.rows });
        ElementPlus.ElMessage.success('已导入 ' + (r.added || 0) + ' 条');
        rulePreview.visible = false;
        await loadRules(); await loadLib(); await loadWt();
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
      finally { rulePreview.busy = false; }
    }
    async function toggleWtHazards() {
      wtHazardOpen.value = !wtHazardOpen.value;
      if (wtHazardOpen.value) await loadHazards();
    }
    watch(docTab, v => { if (v === 'automation') loadWt(); });
    const pagedFiles = computed(() => catFiles.value.slice((filePage.value - 1) * filePageSize.value, filePage.value * filePageSize.value));
    /* ---- 文件上传 / 下载 / 预览 / 删除 / 移动 ---- */
    function triggerUpload() { if (uploadInput.value) uploadInput.value.click(); }
    async function onUpload(ev) {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      if (file.size > 20 * 1024 * 1024) { ElementPlus.ElMessage.error('单文件不超过 20MB'); return; }
      const fd = new FormData();
      fd.append('file', file);
      fd.append('category', activeCat.value);
      try {
        const res = await fetch('/api/documents/files', {
          method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }, body: fd
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '上传失败');
        load();
        const hi = data.hazardImport;
        if (hi && hi.error) {
          ElementPlus.ElMessage.warning('上传成功，但危险点解析失败：' + hi.error);
        } else if (hi && hi.unsupported) {
          ElementPlus.ElMessage.success('上传成功（非 Excel/CSV 文件，未解析入库）');
        } else if (hi) {
          ElementPlus.ElMessage.success(`上传成功，已解析入危险点库：新增 ${hi.added} 条，跳过 ${hi.skipped} 条`);
          loadHazards(); loadWt();
        } else {
          ElementPlus.ElMessage.success('上传成功');
        }
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function download(f) {
      fetch('/api/documents/files/' + f.id + '/download', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('erp_token') }
      })
        .then(r => { if (!r.ok) throw new Error('下载失败'); return r.blob(); })
        .then(blob => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = f.name;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        })
        .catch(e => ElementPlus.ElMessage.error(e.message));
    }
    async function preview(f) {
      try {
        const d = await api.get('/api/documents/files/' + f.id + '/preview');
        Object.assign(previewData, { kind: d.kind, name: d.name, lines: d.lines || [], sheets: d.sheets || [], message: d.message || '', url: d.url || '' });
        previewPage.value = 1;
        previewVisible.value = true;
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }
    function printPreview() {
      const p = previewData;
      let bodyHtml = '';
      if (p.kind === 'docx') {
        bodyHtml = p.lines.map(l => `<p style="margin:4px 0;white-space:pre-wrap">${l.replace(/</g, '&lt;')}</p>`).join('');
      } else if (p.kind === 'xlsx') {
        const s = p.sheets[0];
        if (s && s.rows.length) {
          const header = s.rows[0];
          const body = s.rows.slice(1);
          bodyHtml = `<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;font-size:12px"><thead><tr>${header.map(c => `<th>${String(c ?? '').replace(/</g, '&lt;')}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${header.map((_, ci) => `<td>${String(r[ci] ?? '').replace(/</g, '&lt;') || '–'}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        }
      } else {
        bodyHtml = `<p>${(p.message || '').replace(/</g, '&lt;')}</p>`;
      }
      const w = window.open('', '_blank');
      if (!w) { ElementPlus.ElMessage.error('浏览器拦截了打印窗口'); return; }
      w.document.write(`<html><head><meta charset="utf-8"><title>${p.name}</title></head><body style="font-family:SimSun,serif;padding:24px"><h2 style="text-align:center">${p.name}</h2>${bodyHtml}</body></html>`);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 300);
    }
    async function removeFile(f) {
      try {
        await ElementPlus.ElMessageBox.confirm(`确认删除「${f.name}」？`, '提示', { type: 'warning' });
        await api.del('/api/documents/files/' + f.id);
        ElementPlus.ElMessage.success('已删除'); load();
      } catch (e) { if (e !== 'cancel') ElementPlus.ElMessage.error(e.message || '已取消'); }
    }
    async function moveFile(f, cat) {
      try {
        const data = await api.put('/api/documents/files/' + f.id, { category: cat });
        const hi = data && data.hazardImport;
        if (hi && hi.error) {
          ElementPlus.ElMessage.warning(`已移动到「${cat}」，但危险点解析失败：${hi.error}`);
        } else if (hi && hi.unsupported) {
          ElementPlus.ElMessage.success(`已移动到「${cat}」（非 Excel/CSV 文件，未解析入库）`);
        } else if (hi) {
          ElementPlus.ElMessage.success(`已移动到「${cat}」，已解析入危险点库：新增 ${hi.added} 条，跳过 ${hi.skipped} 条`);
        } else {
          ElementPlus.ElMessage.success(`已移动到「${cat}」`);
        }
        load();
        if (cat === '危险点') { loadHazards(); loadWt(); }
      } catch (e) { ElementPlus.ElMessage.error(e.message); }
    }

    onMounted(() => { load(); loadWt(); loadLib(); loadDefaultMeta(); });
    return {
      docs, docTab, activeCat, catCount,
      wt, wtHazardOpen, wtHazards, loadWt, toggleWtHazards,
      lib, libOpen, rules, ruleDlg, ruleImportInput, rulePreview,
      loadLib, loadRules, toggleLib, openRuleAdd, openRuleEdit, submitRule, removeRule,
      measures, meaDlg, measureLabel, openMeaAdd, openMeaEdit, submitMea, removeMea, meaView, openMeaView, meaViewBlocks, meaInsertTab,
      defaultMea, loadDefaultMeta, clearAllMeasures, loadDefaultMeasures, defaultMeaTip,
      meaPaged, meaTotal, meaPage, meaPageSize, meaSetPageSize, MEA_PAGE_SIZE,
      hospitals, hosDlg, openHosAdd, openHosEdit, submitHos, removeHos,
      emergency, saveEmergency,
      impPreview, impInput, triggerImp, onImp, confirmImp,
      triggerRuleImport, onRuleImport, confirmRuleImport,
      hazLoading, hazSearch, hazPage, hazPageSize, hazFiltered, hazPaged, hazDlg, hazView, hazImportInput,
      loadHazards, applyHazSearch, reloadHazards, openHazAdd, openHazEdit, submitHaz, removeHaz, openHazView,
      triggerHazImport, onHazImport,
      filePage, filePageSize, catFiles, pagedFiles,
      uploadInput, previewVisible, previewData,
      previewPage, previewSheet, previewHeader, previewRows, previewPaged, fmtCell,
      load, triggerUpload, onUpload, download, preview, printPreview,
      removeFile, moveFile
    };
  },
  template: `
  <div>
    <div class="doc-card">
      <div class="doc-title">文档中心</div>
      <el-tabs v-model="docTab" class="doc-tabs">
        <el-tab-pane label="文档资源" name="resources">
          <div class="doc-hint">支持上传任意文件，单文件不超过 20MB。xlsx、xls、docx 可预览，PDF 可在浏览器中打开。</div>
          <div v-if="activeCat === '危险点'" class="doc-hint" style="color:var(--brand)">
            上传到此分类的 Excel / CSV 会自动解析入「企业危险点库」：首个工作表 A 列为危险点、C 列为控制措施，相同条目自动跳过；也可把已有文件「移动到」本分类触发解析。
          </div>

          <el-tabs v-model="activeCat" class="doc-cats">
            <el-tab-pane v-for="c in docs.categories" :key="c" :label="c + ' (' + catCount(c) + ')'" :name="c" />
          </el-tabs>

          <div class="doc-upload">
            <el-button v-if="canWrite('documents')" type="primary" @click="triggerUpload">上传文件到「{{ activeCat }}」</el-button>
            <input ref="uploadInput" type="file" style="display:none" @change="onUpload" />
          </div>

          <el-table class="flat-table doc-file-table" :data="pagedFiles" empty-text="暂无数据" style="width:100%">
            <el-table-column label="文件名" min-width="260" show-overflow-tooltip>
              <template #default="{row}"><span class="doc-fname">{{ row.name }}</span></template>
            </el-table-column>
            <el-table-column prop="uploader" label="上传人" width="110">
              <template #default="{row}"><span class="doc-meta">{{ row.uploader }}</span></template>
            </el-table-column>
            <el-table-column prop="uploadedAt" label="上传时间" width="152">
              <template #default="{row}"><span class="doc-meta">{{ row.uploadedAt }}</span></template>
            </el-table-column>
            <el-table-column label="移动到" width="152">
              <template #default="{row}">
                <el-select class="doc-move" :model-value="row.category" size="small" :disabled="!!row.fixed || !canWrite('documents')" @change="v=>moveFile(row,v)">
                  <el-option v-for="c in docs.categories" :key="c" :label="c" :value="c" />
                </el-select>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="168">
              <template #default="{row}">
                <el-button link type="primary" size="small" @click="download(row)">下载</el-button>
                <el-button link type="primary" size="small" @click="preview(row)">预览</el-button>
                <el-tooltip v-if="row.fixed" content="固定系统文件不可删除" placement="top">
                  <el-button link type="info" size="small" disabled>删除</el-button>
                </el-tooltip>
                <el-button v-else-if="canWrite('documents')" link type="danger" size="small" @click="removeFile(row)">删除</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <div class="doc-empty">
                <svg class="doc-empty-icon" viewBox="0 0 64 56" width="56" height="49" fill="none" aria-hidden="true"><path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/><circle cx="51.5" cy="11.5" r="7.5" fill="#fff" stroke="currentColor" stroke-width="1.6"/><circle cx="48" cy="11.5" r="1.1" fill="var(--text-3)"/><circle cx="51.5" cy="11.5" r="1.1" fill="var(--text-3)"/><circle cx="55" cy="11.5" r="1.1" fill="var(--text-3)"/></svg>
                <div class="doc-empty-text">暂无数据</div>
              </div>
            </template>
          </el-table>

          <div v-if="catFiles.length" class="doc-pager">
            <span style="color:var(--text-2);font-size:13px">共 {{ catFiles.length }} 条</span>
            <el-pagination background layout="prev, pager, next" :total="catFiles.length" :page-size="filePageSize" :current-page="filePage" @current-change="p=>filePage=p" />
            <el-select :model-value="filePageSize" size="small" style="width:104px" @change="n=>{filePageSize=n;filePage=1}">
              <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
            </el-select>
          </div>

        </el-tab-pane>

        <el-tab-pane label="工作票自动化配置" name="automation">
          <div class="wt-card" v-loading="wt.loading">
            <div class="wt-head">
              <span class="wt-title">配置状态</span>
              <span class="wt-state" :class="wt.ready ? 'ok' : 'pending'">{{ wt.ready ? '可用于工作票自动化' : '配置未完成' }}</span>
            </div>
            <div class="wt-grid">
              <div v-for="it in wt.items" :key="it.key" class="wt-item">
                <span class="wt-chip" :class="it.ready ? 'ok' : 'no'">{{ it.ready ? '已就绪' : '未配置' }}</span>
                <div class="wt-item-main">
                  <div class="wt-item-title">{{ it.title }}</div>
                  <div class="wt-item-sub">{{ it.desc }}</div>
                </div>
              </div>
            </div>
          </div>

          <!-- 资料库 -->
          <div class="lib-card">
            <div class="lib-head">
              <span class="lib-title">资料库</span>
              <div class="lib-head-actions">
                <el-button v-if="canWrite('documents')" link type="danger" @click="clearAllMeasures">清除</el-button>
                <el-button v-if="canWrite('documents')" size="small" type="primary" :loading="defaultMea.busy"
                  :title="defaultMeaTip" @click="loadDefaultMeasures">载入默认</el-button>
              </div>
            </div>

            <div class="lib-list">
              <div v-for="g in lib.groups" :key="g.key" class="lib-group">
                <div class="lib-group-head" @click="toggleLib(g.key)">
                  <span class="lib-group-title">{{ g.title }}<span v-if="g.showCount !== false" class="lib-count">（{{ g.count }}）</span></span>
                  <span class="lib-arrow" :class="{ open: libOpen[g.key] }"></span>
                </div>

                <div v-if="libOpen[g.key]" class="lib-group-body">
                  <!-- 作业内容匹配规则 -->
                  <template v-if="g.key === 'rules'">
                    <div class="lib-sub">
                      <div class="lib-sub-head">
                        <span class="lib-sub-title">作业内容匹配规则（{{ rules.length }}）</span>
                        <div class="lib-sub-actions">
                          <el-button v-if="canWrite('documents')" @click="triggerRuleImport">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:5px;vertical-align:-2px" aria-hidden="true">
                              <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                              <path d="M4 17v2.5h16V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                            </svg>导入预览
                          </el-button>
                          <el-button v-if="canWrite('documents')" @click="openRuleAdd">＋ 新增</el-button>
                          <input ref="ruleImportInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onRuleImport" />
                        </div>
                      </div>

                      <el-table class="flat-table" :data="rules" empty-text="暂无数据" style="width:100%">
                        <el-table-column prop="workType" label="作业类型" min-width="130" show-overflow-tooltip />
                        <el-table-column label="规则" min-width="170">
                          <template #default="{row}">
                            <span v-if="row.category" class="lib-cat">{{ row.category }}</span>
                            <span v-if="row.keywordsRaw">{{ row.keywordsRaw }}</span>
                            <span v-if="!row.category && !row.keywordsRaw">—</span>
                          </template>
                        </el-table-column>
                        <el-table-column label="施工技术措施" min-width="220">
                          <template #default="{row}"><span class="rule-names">{{ row.techName || '—' }}</span></template>
                        </el-table-column>
                        <el-table-column label="安全措施" min-width="220">
                          <template #default="{row}"><span class="rule-names">{{ row.safetyName || '—' }}</span></template>
                        </el-table-column>
                        <el-table-column label="操作" width="110">
                          <template #default="{row}">
                            <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openRuleEdit(row)">编辑</el-button>
                            <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeRule(row)">删除</el-button>
                          </template>
                        </el-table-column>
                        <template #empty>
                          <div class="doc-empty">
                            <svg class="doc-empty-icon" viewBox="0 0 64 56" width="52" height="45" fill="none" aria-hidden="true">
                              <path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                              <path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                            <div class="doc-empty-text">暂无数据</div>
                          </div>
                        </template>
                      </el-table>
                    </div>
                  </template>

                  <!-- 施工技术措施原文 / 施工安全措施原文 -->
                  <template v-else-if="g.key === 'tech' || g.key === 'safety'">
                    <div class="lib-sub">
                      <div class="lib-sub-head">
                        <span class="lib-sub-title">{{ measureLabel(g.key) }}（{{ (measures[g.key] || []).length }}）</span>
                        <div class="lib-sub-actions">
                          <el-button v-if="canWrite('documents')" @click="triggerImp(g.key)">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:5px;vertical-align:-2px" aria-hidden="true">
                              <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                              <path d="M4 17v2.5h16V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                            </svg>导入预览
                          </el-button>
                          <el-button v-if="canWrite('documents')" @click="openMeaAdd(g.key)">＋ 新增</el-button>
                        </div>
                      </div>

                      <el-table class="flat-table" :data="meaPaged(g.key)" empty-text="暂无数据" style="width:100%">
                        <el-table-column prop="sort" label="序号" width="90" />
                        <el-table-column prop="title" label="条文" min-width="200" show-overflow-tooltip />
                        <el-table-column label="措施原文预览" min-width="340">
                          <template #default="{row}">
                            <div class="mea-preview" :class="{ empty: !row.content }">{{ row.content || '—' }}</div>
                            <a v-if="row.content" class="mea-more" @click="openMeaView(g.key, row)">查看原文</a>
                          </template>
                        </el-table-column>
                        <el-table-column label="操作" width="110">
                          <template #default="{row}">
                            <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openMeaEdit(g.key, row)">编辑</el-button>
                            <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeMea(g.key, row)">删除</el-button>
                          </template>
                        </el-table-column>
                        <template #empty>
                          <div class="doc-empty">
                            <svg class="doc-empty-icon" viewBox="0 0 64 56" width="52" height="45" fill="none" aria-hidden="true">
                              <path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                              <path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                            <div class="doc-empty-text">暂无数据</div>
                          </div>
                        </template>
                      </el-table>
                      <div v-if="meaTotal(g.key)" class="mea-pager">
                        <span class="mea-total">共 {{ meaTotal(g.key) }} 条</span>
                        <el-pagination background layout="prev, pager, next"
                          :total="meaTotal(g.key)" :page-size="meaPageSize[g.key]" :current-page="meaPage[g.key]"
                          @current-change="p=>meaPage[g.key]=p" />
                        <el-select :model-value="meaPageSize[g.key]" size="small" style="width:104px" @change="n=>meaSetPageSize(g.key,n)">
                          <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
                        </el-select>
                      </div>
                    </div>
                  </template>

                  <!-- 医院联系方式 -->
                  <template v-else-if="g.key === 'hospitals'">
                    <div class="lib-sub">
                      <div class="lib-sub-head">
                        <span class="lib-sub-title">医院联系方式（{{ hospitals.length }}）</span>
                        <div class="lib-sub-actions">
                          <el-button v-if="canWrite('documents')" @click="triggerImp(g.key)">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" style="margin-right:5px;vertical-align:-2px" aria-hidden="true">
                              <path d="M12 3v11m0 0 4-4m-4 4-4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
                              <path d="M4 17v2.5h16V17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                            </svg>导入预览
                          </el-button>
                          <el-button v-if="canWrite('documents')" @click="openHosAdd">＋ 新增</el-button>
                        </div>
                      </div>

                      <el-table class="flat-table" :data="hospitals" empty-text="暂无数据" style="width:100%">
                        <el-table-column prop="area" label="作业地址匹配词" min-width="160" show-overflow-tooltip />
                        <el-table-column prop="name" label="医院" min-width="150" show-overflow-tooltip />
                        <el-table-column prop="address" label="地址" min-width="240" show-overflow-tooltip />
                        <el-table-column prop="phone" label="电话" min-width="130" />
                        <el-table-column label="操作" width="110">
                          <template #default="{row}">
                            <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openHosEdit(row)">编辑</el-button>
                            <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeHos(row)">删除</el-button>
                          </template>
                        </el-table-column>
                        <template #empty>
                          <div class="doc-empty">
                            <svg class="doc-empty-icon" viewBox="0 0 64 56" width="52" height="45" fill="none" aria-hidden="true">
                              <path d="M7 15a4 4 0 0 1 4-4h11.5l3.8 4.6H53a4 4 0 0 1 4 4V43a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                              <path d="M7 23.5h50" stroke="currentColor" stroke-width="1.6"/>
                            </svg>
                            <div class="doc-empty-text">暂无数据</div>
                          </div>
                        </template>
                      </el-table>
                    </div>
                  </template>

                  <!-- 默认应急医院 -->
                  <template v-else-if="g.key === 'emergency'">
                    <div class="lib-emergency">
                      <el-input v-model="emergency.name" class="em-input" maxlength="100" placeholder="医院名称" :disabled="!canWrite('documents')"
                        @blur="saveEmergency" @keyup.enter="saveEmergency" />
                      <el-input v-model="emergency.phone" class="em-input" maxlength="50" placeholder="联系电话" :disabled="!canWrite('documents')"
                        @blur="saveEmergency" @keyup.enter="saveEmergency" />
                    </div>
                  </template>

                </div>
              </div>
            </div>
          </div>

          <div class="wt-collapse">
            <div class="wt-collapse-head" @click="toggleWtHazards()">
              <span class="wt-arrow" :class="{ open: wtHazardOpen }"></span>
              <span>企业危险点库（{{ wt.hazardCount }} 条）</span>
            </div>
            <div v-if="wtHazardOpen" class="wt-collapse-body">
              <div class="hz-hint">可直接新增、编辑、删除和排序。Excel 仅用于追加导入：首个工作表 A 列危险点、C 列控制措施，最多 1000 行、2MB；相同危险点和措施自动跳过。</div>

              <div class="hz-toolbar">
                <div class="hz-search">
                  <el-input v-model="hazSearch" placeholder="搜索危险点或措施" clearable
                    @keyup.enter="applyHazSearch" @clear="applyHazSearch" />
                  <el-button class="hz-icon-btn" title="搜索" @click="applyHazSearch">
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" aria-hidden="true">
                      <circle cx="11" cy="11" r="6.2" stroke="currentColor" stroke-width="1.8"/>
                      <path d="M15.6 15.6 20 20" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                    </svg>
                  </el-button>
                </div>
                <el-button @click="reloadHazards">重新读取</el-button>
                <el-button v-if="canWrite('documents')" type="primary" @click="openHazAdd">新增危险点</el-button>
                <el-button v-if="canWrite('documents')" @click="triggerHazImport">导入 Excel</el-button>
                <input ref="hazImportInput" type="file" accept=".xlsx,.xls,.csv" style="display:none" @change="onHazImport" />
              </div>

              <el-table class="flat-table" :data="hazPaged" v-loading="hazLoading" empty-text="暂无数据" style="width:100%">
                <el-table-column prop="sort" label="排序" width="72" align="center" />
                <el-table-column prop="hazard" label="危险点" min-width="180">
                  <template #default="{row}">
                    <span class="hz-hazard">{{ row.hazard || '-' }}</span>
                  </template>
                </el-table-column>
                <el-table-column prop="measure" label="控制措施" min-width="400">
                  <template #default="{row}">
                    <div class="hz-measure" @click="openHazView(row)">{{ row.measure || '-' }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="操作" width="168">
                  <template #default="{row}">
                    <el-button link type="primary" size="small" @click="openHazView(row)">查看</el-button>
                    <el-button v-if="canWrite('documents')" link type="primary" size="small" @click="openHazEdit(row)">编辑</el-button>
                    <el-button v-if="canWrite('documents')" link type="danger" size="small" @click="removeHaz(row)">删除</el-button>
                  </template>
                </el-table-column>
              </el-table>

              <div class="hz-pager">
                <span class="hz-total">共 {{ hazFiltered.length }} 条</span>
                <el-pagination background layout="prev, pager, next" :total="hazFiltered.length"
                  :page-size="hazPageSize" :current-page="hazPage" @current-change="p=>hazPage=p" />
                <el-select :model-value="hazPageSize" size="small" style="width:104px" @change="n=>{hazPageSize=n;hazPage=1}">
                  <el-option v-for="n in [10,20,50]" :key="n" :label="n + ' 条/页'" :value="n" />
                </el-select>
              </div>
            </div>
          </div>

          <div class="wv-alert wt-alert">
            <span class="wv-alert-icon">i</span>
            <div class="wv-alert-main">
              <div class="wv-alert-text">工作票自动化配置独立于企业初始化。配置完成后，超级用户或资料员可使用自动化，材料员与班组长仅可查看。</div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <!-- 新增/编辑配置行（作业内容匹配规则） -->
    <el-dialog :title="ruleDlg.editing ? '编辑配置行' : '新增配置行'" v-model="ruleDlg.visible" width="620px" label-position="top">
      <el-form :model="ruleDlg" label-position="top">
        <el-form-item label="作业类型名称" required>
          <el-input v-model="ruleDlg.workType" maxlength="120" />
        </el-form-item>
        <el-form-item label="匹配类别">
          <el-select v-model="ruleDlg.category" clearable filterable style="width:100%"
            placeholder="选择固定活动类别；留空可设置自定义匹配词">
            <el-option v-for="c in lib.categories" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="!ruleDlg.category" label="自定义匹配词（逗号或换行分隔）" required>
          <el-input v-model="ruleDlg.keywords" type="textarea" :rows="4" maxlength="2000" />
        </el-form-item>
        <el-form-item label="关联施工技术措施">
          <el-select v-model="ruleDlg.techIds" multiple filterable clearable style="width:100%" class="rule-measure-select" placeholder="选填，可多选">
            <el-option v-for="o in lib.techOptions" :key="o.id" :label="(o.sort ? o.sort + ' · ' : '') + o.name" :value="o.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="关联施工安全措施">
          <el-select v-model="ruleDlg.safetyIds" multiple filterable clearable style="width:100%" class="rule-measure-select" placeholder="选填，可多选">
            <el-option v-for="o in lib.safetyOptions" :key="o.id" :label="(o.sort ? o.sort + ' · ' : '') + o.name" :value="o.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="ruleDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="ruleDlg.busy" @click="submitRule">确定</el-button>
      </template>
    </el-dialog>

    <!-- 导入预览 -->
    <el-dialog title="导入预览" v-model="rulePreview.visible" width="900px" top="6vh">
      <div class="lib-preview-tip">共解析到 <b>{{ rulePreview.rows.length }}</b> 条（A 列作业类型、B 列自定义匹配词、C 列施工技术措施、D 列安全措施）。确认后追加导入，不会覆盖已有数据。</div>
      <div v-if="rulePreview.errors.length" class="lib-preview-err">
        <div v-for="(e, i) in rulePreview.errors.slice(0, 8)" :key="i">{{ e }}</div>
        <div v-if="rulePreview.errors.length > 8">……共 {{ rulePreview.errors.length }} 处问题</div>
      </div>
      <el-table :data="rulePreview.rows" border size="small" max-height="420" empty-text="没有可导入的数据">
        <el-table-column prop="workType" label="作业类型" min-width="160" show-overflow-tooltip />
        <el-table-column prop="keywordsRaw" label="自定义匹配词" min-width="220" show-overflow-tooltip />
        <el-table-column label="施工技术措施" min-width="180" show-overflow-tooltip><template #default="{row}">{{ row.techName || '—' }}</template></el-table-column>
        <el-table-column label="安全措施" min-width="180" show-overflow-tooltip><template #default="{row}">{{ row.safetyName || '—' }}</template></el-table-column>
      </el-table>
      <template #footer>
        <el-button @click="rulePreview.visible=false">取消</el-button>
        <el-button type="primary" :loading="rulePreview.busy" :disabled="!rulePreview.rows.length" @click="confirmRuleImport">确认导入</el-button>
      </template>
    </el-dialog>

    <input ref="impInput" type="file" accept=".xlsx,.xls,.csv" data-imp="1" style="display:none" @change="onImp" />

    <!-- 新增/编辑配置行（施工技术 / 安全措施原文） -->
    <el-dialog :title="meaDlg.editing ? '编辑配置行' : '新增配置行'" v-model="meaDlg.visible" width="620px" label-position="top" class="cfg-row-dlg">
      <el-form :model="meaDlg" label-position="top">
        <el-form-item label="序号">
          <el-input v-model="meaDlg.sort" maxlength="9" />
        </el-form-item>
        <el-form-item label="条文标题 / 关键字" required>
          <el-input v-model="meaDlg.title" type="textarea" :rows="3" maxlength="200" />
        </el-form-item>
        <el-form-item label="措施原文" required>
          <div style="width:100%" @keydown.tab.prevent="meaInsertTab">
            <el-input v-model="meaDlg.content" type="textarea" :rows="8" maxlength="20000" show-word-limit />
          </div>
          <div class="mea-input-hint">
            表格请用 <b>Tab 键</b>分列（或直接从 Excel 复制粘贴）：<b>一行一条记录</b>、至少两行、每行不少于两列，即可在「查看原文」中显示为表格；第一行可作表头。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="meaDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="meaDlg.busy" @click="submitMea">确定</el-button>
      </template>
    </el-dialog>

    <!-- 措施原文全文（二级页面） -->
    <el-dialog :title="'措施原文 · ' + (meaView.title || '未命名条文')" v-model="meaView.visible" width="620px" top="8vh" class="mea-view-dlg">
      <div class="mea-view-body">
        <template v-for="(b, bi) in meaViewBlocks" :key="bi">
          <div v-if="b.type === 'text'" class="mea-view-text">{{ b.text }}</div>
          <div v-else class="mea-view-tablewrap">
            <table class="mea-view-table">
              <thead v-if="b.header">
                <tr>
                  <th v-for="(c, ci) in b.headCells" :key="ci" class="mea-cell-head"
                    :colspan="(ci === b.headCells.length - 1 && b.headCells.length < b.cols) ? (b.cols - b.headCells.length + 1) : 1">{{ c }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, ri) in (b.header ? b.rows.slice(1) : b.rows)" :key="ri">
                  <th scope="row" class="mea-cell-label" :class="{ 'is-blank': r[0] === '' }">{{ r[0] }}</th>
                  <td v-for="(c, ci) in r.slice(1)" :key="ci" class="mea-cell-num">{{ c }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </div>
    </el-dialog>

    <!-- 新增/编辑配置行（医院联系方式） -->
    <el-dialog :title="hosDlg.editing ? '编辑配置行' : '新增配置行'" v-model="hosDlg.visible" width="620px" label-position="top" class="cfg-row-dlg">
      <el-form :model="hosDlg" label-position="top">
        <el-form-item label="作业地址匹配词" required>
          <el-input v-model="hosDlg.area" maxlength="200" />
        </el-form-item>
        <el-form-item label="医院名称" required>
          <el-input v-model="hosDlg.name" maxlength="100" />
        </el-form-item>
        <el-form-item label="医院地址" required>
          <el-input v-model="hosDlg.address" type="textarea" :rows="2" maxlength="300" />
        </el-form-item>
        <el-form-item label="联系电话" required>
          <el-input v-model="hosDlg.phone" maxlength="50" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hosDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="hosDlg.busy" @click="submitHos">确定</el-button>
      </template>
    </el-dialog>

    <!-- 导入预览（措施原文 / 医院联系方式） -->
    <el-dialog title="导入预览" v-model="impPreview.visible" width="900px" top="6vh">
      <div class="lib-preview-tip">
        共解析到 <b>{{ impPreview.rows.length }}</b> 条（
        <template v-if="impPreview.kind === 'hospitals'">A 列作业地址匹配词、B 列医院、C 列地址、D 列电话</template>
        <template v-else>A 列序号（可空）、B 列条文标题 / 关键字、C 列措施原文</template>
        ）。确认后追加导入，不会覆盖已有数据。
      </div>
      <div v-if="impPreview.errors.length" class="lib-preview-err">
        <div v-for="(e, i) in impPreview.errors.slice(0, 8)" :key="i">{{ e }}</div>
        <div v-if="impPreview.errors.length > 8">……共 {{ impPreview.errors.length }} 处问题</div>
      </div>
      <el-table :data="impPreview.rows" border size="small" max-height="420" empty-text="没有可导入的数据">
        <template v-if="impPreview.kind === 'hospitals'">
          <el-table-column prop="area" label="作业地址匹配词" min-width="150" show-overflow-tooltip />
          <el-table-column prop="name" label="医院" min-width="140" show-overflow-tooltip />
          <el-table-column prop="address" label="地址" min-width="200" show-overflow-tooltip />
          <el-table-column prop="phone" label="电话" min-width="120" />
        </template>
        <template v-else>
          <el-table-column prop="sort" label="序号" width="80" />
          <el-table-column prop="title" label="条文" min-width="180" show-overflow-tooltip />
          <el-table-column prop="content" label="措施原文" min-width="300" show-overflow-tooltip />
        </template>
      </el-table>
      <template #footer>
        <el-button @click="impPreview.visible=false">取消</el-button>
        <el-button type="primary" :loading="impPreview.busy" :disabled="!impPreview.rows.length" @click="confirmImp">确认导入</el-button>
      </template>
    </el-dialog>

    <!-- 新增/编辑危险点 -->
    <el-dialog :title="hazDlg.editing ? '编辑危险点' : '新增危险点'" v-model="hazDlg.visible" width="640px" label-position="top">
      <el-form :model="hazDlg" label-position="top">
        <el-form-item label="危险点" required>
          <el-input v-model="hazDlg.hazard" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="如：双电源杆" />
        </el-form-item>
        <el-form-item label="控制措施" required>
          <el-input v-model="hazDlg.measure" type="textarea" :rows="6" maxlength="4000" show-word-limit placeholder="如：工作前确认同杆的双电源均已停电。" />
        </el-form-item>
        <el-form-item label="排序（小的在前；留空则排在末尾）">
          <el-input-number v-model="hazDlg.sort" :min="0" style="width:180px" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hazDlg.visible=false">取消</el-button>
        <el-button type="primary" :loading="hazDlg.busy" @click="submitHaz">确定</el-button>
      </template>
    </el-dialog>

    <!-- 查看危险点全文 -->
    <el-dialog v-model="hazView.visible" title="危险点详情" width="720px" top="8vh">
      <div class="hz-view">
        <div class="hz-view-label">危险点</div>
        <div class="hz-view-hazard">{{ hazView.hazard || '-' }}</div>
        <div class="hz-view-label">控制措施</div>
        <div class="hz-view-measure">{{ hazView.measure || '-' }}</div>
      </div>
      <template #footer>
        <el-button @click="hazView.visible=false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 预览 -->
    <el-dialog :title="'预览 - ' + previewData.name" v-model="previewVisible" width="1080px" top="5vh">
      <div v-if="previewData.kind==='docx'" style="max-height:66vh;overflow:auto;font-family:SimSun,serif;font-size:14px;line-height:1.9;border:1px solid var(--line);padding:16px 24px;background:var(--surface)">
        <p v-for="(l,i) in previewData.lines" :key="i" style="margin:2px 0;white-space:pre-wrap">{{ l }}</p>
      </div>
      <div v-else-if="previewData.kind==='xlsx' && previewSheet" style="display:flex;flex-direction:column;max-height:70vh">
        <div style="flex:1 1 auto;min-height:0;overflow:auto">
          <el-table :data="previewPaged" border size="small" max-height="520">
            <el-table-column v-for="(c,ci) in previewHeader.length" :key="ci" :label="String(previewHeader[ci] || ('列' + (ci+1)))"
              :width="ci < 2 ? 170 : undefined" :min-width="ci < 2 ? undefined : 300">
              <template #default="{row}">{{ fmtCell(row[ci]) }}</template>
            </el-table-column>
          </el-table>
        </div>
        <div style="flex:0 0 auto;display:flex;justify-content:flex-end;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 2px 2px">
          <span style="color:var(--text-2);font-size:13px">共 {{ previewRows.length }} 条</span>
          <el-pagination background layout="prev, pager, next" :total="previewRows.length" :page-size="100" :current-page="previewPage" @current-change="p=>previewPage=p" />
          <span style="color:var(--text-2);font-size:13px">100 条/页</span>
        </div>
      </div>
      <div v-else-if="previewData.kind==='pdf'" style="text-align:center;padding:40px 0">
        <p style="color:var(--text-2);margin-bottom:14px">PDF 文件可在浏览器中直接打开</p>
        <el-button type="primary" @click="window.open(previewData.url,'_blank')">在浏览器中打开</el-button>
      </div>
      <div v-else style="text-align:center;padding:40px 0;color:var(--text-3)">{{ previewData.message || '该文件类型暂不支持预览' }}</div>
      <template #footer>
        <el-button @click="previewVisible=false">关闭</el-button>
        <el-button type="primary" @click="printPreview">打印</el-button>
      </template>
    </el-dialog>
  </div>`
};
