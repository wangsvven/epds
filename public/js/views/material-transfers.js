/* ========== views/material-transfers ========== */
/* 材料「项目间调拨」面板（PLAN v2.2：一张单多行明细）
 * 列表（调入/调出/借调未还三视角）+ 多行草稿建单/编辑 + 生效/按行补回/按行作废补回/整单撤销 + 详情。
 * 弹窗明细表列：物料描述 / 应到 / 入库量 / 单位 / 可用 / 本次调拨 / 调拨后剩余。
 * 接口与报错文案以 server/routes/material-transfers.js 为准；前端只做第一道校验，最终判定在后端。
 * 写操作全部「提交中禁用 + saving 守卫」防重复提交；样式内联，不新增全局 CSS。 */
const MaterialTransfers = {
  props: {
    project: { type: String, default: '' },
  },
  setup(props) {
    const { ref, reactive, computed, onMounted, onUnmounted, watch } = Vue;

    const today = () => (typeof ServerTime !== 'undefined' && ServerTime && ServerTime.ymd ? ServerTime.ymd() : new Date().toISOString().slice(0, 10));
    const fmt = n => { const v = Number(n) || 0; return String(Math.round(v * 10000) / 10000); };
    const normDesc = s => String(s == null ? '' : s).trim().replace(/\s+/g, ' ');
    const enc = encodeURIComponent;

    /* ---------- 窄屏 ---------- */
    const narrow = ref(window.innerWidth <= 480);
    function onResize() { narrow.value = window.innerWidth <= 480; }
    onMounted(() => window.addEventListener('resize', onResize));
    onUnmounted(() => window.removeEventListener('resize', onResize));
    const dlgWidth = computed(() => (narrow.value ? '96%' : '1080px'));
    /* ---------- 版式统一：卡片分区 + 结构化抬头（详情 / 新建共用） ----------
       设计取舍：不再「标签一行、值一行」平铺，而是
       ① 抬头卡：单号（等宽字体、主字号）+ 种类/状态色块 + 业务日期，再给项目流向；
       ② 明细卡：标题 + 口径提示 + 表格，底部合计与规则同一行；
       ③ 业务卡：两列栅格 + 全宽原因。
       全部用主题变量，深色模式自动跟随；窄屏一律降为单列。 */
    /* 借调多「已补回 / 未还 / 操作」三列，桌面上比普通调拨更宽；窄屏一律 96% */
    const detWidth = computed(() => (narrow.value ? '96%' : ((det.row && det.row.kind === '借调') ? 'min(1040px, 94vw)' : 'min(920px, 94vw)')));
    /* 卡块 = 描边 + 圆角 + 「灰标题栏 + 内容区」。
       为什么用标题栏而不是整卡底色：弹窗底色本身是 --surface，浅色下 --surface-2 与它几乎同色，
       整卡底色读不出来；改用 --surface-3 的标题栏，浅色/深色都能形成清晰分区。 */
    const dlgCardStyle = computed(() => ({
      border: '1px solid rgba(140,160,190,.22)', borderRadius: '10px', overflow: 'hidden',
      background: 'var(--surface)', marginBottom: '12px',
    }));
    const cardHeadStyle = computed(() => ({
      display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
      padding: narrow.value ? '8px 11px' : '9px 14px',
      background: 'var(--surface-3)', borderBottom: '1px solid rgba(140,160,190,.18)',
    }));
    const cardBodyStyle = computed(() => ({ padding: narrow.value ? '11px 12px' : '13px 14px' }));
    const secTitleStyle = { fontSize: '12.5px', fontWeight: 600, color: 'var(--text-1)', letterSpacing: '.02em', lineHeight: '18px' };
    const hintStyle = { fontSize: '11.5px', color: 'var(--text-3)', lineHeight: '16px' };
    const fieldLabelStyle = { display: 'block', fontSize: '12px', color: 'var(--text-3)', lineHeight: '16px', marginBottom: '4px' };
    const fieldValueStyle = { fontSize: '13.5px', color: 'var(--text-1)', lineHeight: '21px', wordBreak: 'break-word' };
    /* 抬头：项目流向（调出 → 调入），桌面左右分列、箭头居中；窄屏上下堆叠 */
    const flowGrid = computed(() => (narrow.value
      ? { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '12px' }
      : { display: 'flex', alignItems: 'flex-end', gap: '14px', marginTop: '12px' }));
    const flowRightStyle = computed(() => (narrow.value ? { minWidth: 0 } : { flex: '1 1 0', minWidth: 0, textAlign: 'right' }));
    /* 抬头底部键值：桌面三列（经办人 / 创建 / 生效），窄屏单列 */
    const metaGrid = computed(() => (narrow.value
      ? { display: 'grid', gridTemplateColumns: '1fr', gap: '8px', marginTop: '12px', paddingTop: '10px', borderTop: '1px dashed rgba(140,160,190,.25)' }
      : { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: '10px 18px', marginTop: '12px', paddingTop: '10px', borderTop: '1px dashed rgba(140,160,190,.25)' }));
    /* 新建：两列栅格 / 项目流向（调出 → 调入） */
    const pairGrid = computed(() => (narrow.value
      ? { display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }
      : { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 20px' }));
    const projGrid = computed(() => (narrow.value
      ? { display: 'grid', gridTemplateColumns: '1fr', gap: '10px', marginTop: '12px' }
      : { display: 'grid', gridTemplateColumns: '1fr 18px 1fr', gap: '10px', alignItems: 'end', marginTop: '12px' }));
    /* 对比量的「后值」：浅底色块，让 100 → 70 的落点一眼可读（不改变文案，测试口径不变） */
    function afterChip(color) {
      return 'display:inline-block;min-width:30px;padding:1px 7px;border-radius:5px;font-weight:600;'
        + 'background:' + color + '16;color:' + color + ';';
    }
    /* 状态色（色块用 chipStyle 上色） */
    function statusColor(s) {
      return s === '已生效' ? '#2f9e63' : s === '草稿' ? '#e6932c' : s === '已撤销' ? '#f56c6c' : '#5a6b8c';
    }
    const voidBandStyle = {
      marginTop: '10px', padding: '6px 10px', borderRadius: '6px', fontSize: '12px', lineHeight: '18px',
      color: '#c45656', background: 'rgba(245,108,108,.09)',
    };

    /* ---------- 布局样式 ---------- */
    const barStyle = { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '14px' };
    const barRightStyle = { marginLeft: 'auto', display: 'flex', gap: '8px' };
    const fRowStyle = computed(() => (narrow.value
      ? { marginBottom: '10px' }
      : { display: 'grid', gridTemplateColumns: '84px 1fr', gap: '10px', alignItems: 'start', marginBottom: '10px' }));
    const fLabelStyle = computed(() => (narrow.value
      ? { display: 'block', fontSize: '12px', color: 'var(--text-2)', marginBottom: '4px' }
      : { fontSize: '13px', color: 'var(--text-2)', paddingTop: '6px' }));
    const roStyle = { fontSize: '13px', color: 'var(--text-1)', paddingTop: '6px', wordBreak: 'break-all' };
    const footStyle = { marginTop: '10px', color: 'var(--text-2)', fontSize: '13px', textAlign: 'right' };
    const opsStyle = { display: 'flex', gap: '2px', flexWrap: 'wrap' };
    const secStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '6px 0 8px' };

    /* ---------- 弹窗版式 ---------- */
    const dlg2Width = computed(() => (narrow.value ? '96%' : 'min(1080px, 94vw)'));
    /* 窄屏卡片式明细 */
    const cardStyle = computed(() => (row) => ({
      border: '1px solid var(--border, rgba(140,160,190,.28))', borderRadius: '8px', padding: '10px 12px',
      background: row.blocked ? 'rgba(245,108,108,.06)' : 'transparent',
    }));
    const issueStyle = { color: '#e6932c', fontSize: '12px', marginTop: '3px', lineHeight: '1.4' };
    const blockRowStyle = { background: 'rgba(245,108,108,.06)' };
    const tipStyle = (kind) => ({
      fontSize: '12px', lineHeight: '18px', padding: '5px 10px', borderRadius: '6px', marginTop: '8px',
      color: kind === 'error' ? '#f56c6c' : 'var(--text-2)',
      background: kind === 'error' ? 'rgba(245,108,108,.08)' : 'rgba(120,140,180,.08)',
    });

    /* ---------- 基础数据 ---------- */
    const materials = ref([]);
    const projectNames = ref([]);
    const rows = ref([]);
    const loading = ref(false);

    const filters = reactive({ project: props.project || '', direction: 'all', kind: '', status: '', outstandingOnly: false });
    watch(() => props.project, v => { if (v) { filters.project = v; load(); } });

    const STATUS_TAG = { '草稿': 'info', '已生效': 'success', '已结清': 'info', '已撤销': 'danger' };
    const statusTag = s => (STATUS_TAG[s] === undefined ? 'info' : STATUS_TAG[s]);

    const matById = id => materials.value.find(m => m.id === id) || null;
    function directionText(r) {
      if (!filters.project) return (r.fromProject || '') + ' → ' + (r.toProject || '');
      return r.toProject === filters.project ? ('来自 ' + (r.fromProject || '')) : ('调往 ' + (r.toProject || ''));
    }
    /* 列表材料列：首行描述 + 「等 N 种」 */
    function matBrief(r) {
      const its = r.items || [];
      if (!its.length) return '—';
      const first = its[0].description || its[0].code || '';
      return its.length > 1 ? (first + ' 等 ' + its.length + ' 种') : first;
    }
    function totalQtyOf(r) {
      return (r.items || []).reduce((s, it) => s + (Number(it.qty) || 0), 0);
    }

    async function loadBase() {
      try {
        const ps = await api.get('/api/projects');
        const list = Array.isArray(ps) ? ps : (ps && ps.data) || [];
        const names = list.filter(p => p && !p.deleted).map(p => String(p.name || p.projectName || '').trim()).filter(Boolean);
        const ms = await api.get('/api/materials');
        materials.value = (Array.isArray(ms) ? ms : []).filter(m => m && !m.deleted);
        const fromMats = materials.value.map(m => String(m.project || '').trim()).filter(Boolean);
        projectNames.value = [...new Set(names.concat(fromMats))].sort();
      } catch (e) {
        ElementPlus.ElMessage.error(e.message || '加载基础数据失败');
      }
    }

    async function load() {
      loading.value = true;
      try {
        const q = [];
        if (filters.project) q.push('project=' + enc(filters.project));
        if (filters.direction && filters.direction !== 'all') q.push('direction=' + filters.direction);
        if (filters.kind) q.push('kind=' + enc(filters.kind));
        if (filters.status) q.push('status=' + enc(filters.status));
        if (filters.outstandingOnly) q.push('outstandingOnly=1');
        const r = await api.get('/api/materialTransfers' + (q.length ? '?' + q.join('&') : ''));
        rows.value = Array.isArray(r) ? r : (r && r.data) || [];
        if (loc && loc.st.active) loc.recompute();
      } catch (e) {
        ElementPlus.ElMessage.error(e.message || '加载调拨记录失败');
        if (loc) loc.refreshFailed();
      } finally {
        loading.value = false;
      }
    }
    /* ---------- 按材料聚焦（材料明细「调拨单」跨组件跳转） ---------- */
    const matFilter = ref(null);
    function clearMatFilter() { matFilter.value = null; }
    const tFiltered = computed(() => {
      const arr = rows.value;
      if (!matFilter.value) return arr;
      const id = matFilter.value.id;
      return arr.filter(t => t.status !== '已撤销'   // 与材料明细口径一致：撤销单不计入该材料的调拨痕迹
        && (t.items || []).some(it => it.fromMaterialId === id || it.toMaterialId === id));
    });
    function focusMaterial(e) {
      const d = (e && e.detail) || {};
      if (!d.id) return;
      if (d.project) filters.project = d.project;
      // 方向回到「全部」：该材料可能既是调出方也是调入方，限方向会漏单
      filters.direction = 'all';
      matFilter.value = { id: d.id, description: d.description, code: d.code };
      load();
    }
    window.addEventListener('transfers-focus-material', focusMaterial);

    /* ----- 首页「工作动态」定位（调拨动态）：绕开业务筛选与材料聚焦，收窄 + 高亮 ----- */
    const loc = window.Locate.make({
      nav: 'materials', sub: 'transfer',
      base: () => rows.value,
      snap: () => ({ p: filters.project, d: filters.direction, k: filters.kind, s: filters.status, o: filters.outstandingOnly, mf: matFilter.value }),
      restore: (sn) => {
        filters.project = sn.p; filters.direction = sn.d; filters.kind = sn.k;
        filters.status = sn.s; filters.outstandingOnly = sn.o; matFilter.value = sn.mf;
      }
    });
    const locActive = computed(() => loc.st.active);
    const locRowClass = ({ row }) => (loc.hit(row) ? 'loc-row' : '');
    /* 定位期间只显示命中的单（按 rows 全量，不受方向/种类/状态筛选限制） */
    const tView = computed(() => ((loc.st.active && loc.st.total) ? rows.value.filter(loc.hit) : tFiltered.value));
    onUnmounted(() => { window.removeEventListener('transfers-focus-material', focusMaterial); loc.dispose(); });

    function resetFilters() {
      filters.direction = 'all'; filters.kind = ''; filters.status = ''; filters.outstandingOnly = false;
      load();
    }

    /* 小色块（与材料台账 chip 同款） */
    function chipStyle(color) {
      return 'display:inline-block;padding:2px 10px;border-radius:3px;font-size:12px;line-height:20px;background:' + color + '1f;color:' + color + ';';
    }

    /* ---------- 错误呈现 ---------- */
    function refLabel(r) {
      if (!r) return '';
      if (r.type === 'outbound') return '出库单 ' + (r.outNo || '') + '（净 ' + fmt(r.net) + '）';
      if (r.type === 'transfer') return '调拨单 ' + (r.transferNo || '') + '（净 ' + fmt(r.net) + '）';
      if (r.type === 'requisition') return '领料单 ' + (r.reqNo || '');
      return r.outNo || r.reqNo || r.transferNo || '相关单据';
    }
    function errText(e) {
      const d = (e && e.data) || {};
      let msg = d.error || (e && e.message) || '操作失败';
      if (d.date) msg += '（' + d.date + ' 当时可用 ' + fmt(d.available) + '，本次 ' + fmt(d.qty) + '）';
      if (Array.isArray(d.refs) && d.refs.length) msg += '；占用：' + d.refs.map(refLabel).join('、');
      return msg;
    }
    const operatorName = computed(() => {
      const a = (typeof Auth !== 'undefined') ? Auth : null;
      return (a && (a.displayName || a.name)) || '当前登录账号';
    });

    /* ---------- 草稿表单（多行） ---------- */
    const dlg = reactive({ visible: false, saving: false, editingId: '' });
    const form = reactive({
      kind: '调拨', fromProject: '', toProject: '',
      lines: [],                       // [{ key, fromMaterialId, toMaterialId, qty }]
      transferDate: today(), transferDateReason: '', reason: '',
    });
    let lineSeq = 0;
    const newLine = () => ({ key: 'L' + (++lineSeq), fromMaterialId: '', toMaterialId: '', qty: null });

    /* 调出项目下的材料行（下拉候选） */
    const fromRows = computed(() => materials.value.filter(m => String(m.project || '') === String(form.fromProject || '')));
    /* 调出侧可用量表（进入弹窗/切换调出项目时拉 /stock） */
    /* 可用量表就绪：仅当已按当前调出项目加载完，才允许选择材料（避免把"未加载"误读成"无可用"） */
    const stockMap = reactive({});
    const stockState = reactive({ loading: false, project: '', error: '' });
    async function fetchStock() {
      const proj = String(form.fromProject || '');
      Object.keys(stockMap).forEach(k => delete stockMap[k]);
      stockState.project = proj; stockState.error = '';
      if (!proj) return;
      stockState.loading = true;
      try {
        const list = await api.get('/api/materialOutbound/stock?project=' + enc(proj) + '&includeZero=1');
        (Array.isArray(list) ? list : []).forEach(r => {
          stockMap[r.id] = { available: Number(r.available) || 0, inQty: Number(r.inQty) || 0 };
        });
      } catch (e) {
        stockState.error = e.message || '可用量加载失败';
      } finally {
        stockState.loading = false;
      }
    }
    /* 调入侧可用量（选完调入项目后拉一次，用于「调入前后」对比） */
    const toStockMap = reactive({});
    const toState = reactive({ loading: false, project: '', error: '' });
    async function fetchToStock() {
      const proj = String(form.toProject || '');
      Object.keys(toStockMap).forEach(k => delete toStockMap[k]);
      toState.project = proj; toState.error = ''; toState.loading = false;
      if (!proj) return;
      toState.loading = true;
      try {
        const list = await api.get('/api/materialOutbound/stock?project=' + enc(proj) + '&includeZero=1');
        (Array.isArray(list) ? list : []).forEach(r => {
          toStockMap[r.id] = { available: Number(r.available) || 0, inQty: Number(r.inQty) || 0 };
        });
      } catch (e) {
        toState.error = e.message || '调入侧可用量加载失败';
      } finally {
        toState.loading = false;
      }
    }
    function toAvailOf(id) { const x = toStockMap[id]; return x ? Number(x.available) || 0 : 0; }

    /* 调入侧候选：同项目 + 同编码 + 同单位 + 描述归一化一致 */
    function toCandidatesOf(fromMat) {
      if (!fromMat || !form.toProject) return [];
      return materials.value.filter(m => String(m.project || '') === String(form.toProject)
        && String(m.code || '') === String(fromMat.code || '')
        && String(m.unit || '') === String(fromMat.unit || '')
        && normDesc(m.description) === normDesc(fromMat.description));
    }
    /* 取当前可用 / 实时入库量（/stock 为准；该行不在返回里说明从未入库） */
    function availOf(id) { const s = stockMap[id]; return s ? Number(s.available) || 0 : 0; }
    function inQtyOf(mat) {
      if (!mat) return null;
      const s = stockMap[mat.id];
      return s ? Number(s.inQty) || 0 : (Number(mat.qtyArrived) || 0);
    }
    /* 可用量表是否已按当前调出项目加载完（未完成前不允许选材料） */
    const stockReady = computed(() => !stockState.loading && String(stockState.project || '') === String(form.fromProject || ''));
    /* 调出候选：只列「可用 > 0」的材料行 —— 入库量为 0（或已全部用尽）的行不可调拨 */
    const fromCandidates = computed(() => {
      if (!stockReady.value) return [];
      return fromRows.value.filter(m => availOf(m.id) > 0);
    });
    /* 某一行的下拉选项：候选 + 该行已选中的行（草稿编辑时库存可能已被消耗，仍需显示原选择） */
    function optsOf(ln) {
      const list = fromCandidates.value.slice();
      const cur = ln && ln.fromMaterialId ? matById(ln.fromMaterialId) : null;
      if (cur && !list.some(x => x.id === cur.id)) list.unshift(cur);
      return list;
    }
    /* 每行的展示行：调出材料、调入候选、可用、调拨后剩余、阻断原因 */
    const lineViews = computed(() => form.lines.map((ln, i) => {
      const fromMat = matById(ln.fromMaterialId);
      const cands = toCandidatesOf(fromMat);
      const toMat = ln.toMaterialId ? matById(ln.toMaterialId) : (cands.length === 1 ? cands[0] : null);
      const avail = fromMat ? availOf(fromMat.id) : null;
      const arrived = fromMat ? inQtyOf(fromMat) : null;
      const qty = Number(ln.qty) || 0;
      const remain = avail === null ? null : Math.round((avail - qty) * 10000) / 10000;
      /* 调入侧对比：该材料行在调入项目当前的可用 → 调入后 */
      const toAvail = toMat ? toAvailOf(toMat.id) : null;
      const toAfter = toAvail === null ? null : Math.round((toAvail + qty) * 10000) / 10000;
      /* blocked：该行当前不可调拨（入库量为 0 / 可用为 0） */
      let blocked = false, blockText = '';
      if (fromMat && avail !== null && avail <= 0) {
        blocked = true;
        blockText = (arrived <= 0) ? '入库量为 0，不可调拨' : '可用为 0（已全部出库或调出），不可调拨';
      }
      let issue = '';
      if (blocked) issue = blockText;
      else if (fromMat && !cands.length) issue = '调入项目无同编码/单位/描述一致的材料行，请先在台账建行';
      else if (fromMat && cands.length > 1 && !ln.toMaterialId) issue = '调入侧有 ' + cands.length + ' 条同编码材料行，请指定';
      else if (avail !== null && qty > avail + 1e-9) issue = '超过可用 ' + fmt(avail);
      return { key: ln.key, idx: i, fromMat, toMat, cands, avail, arrived, qty, remain, toAvail, toAfter, blocked, issue };
    }));
    const hasIssue = computed(() => lineViews.value.some(v => !!v.issue));
    /* 同一调出材料行重复 */
    const hasDup = computed(() => {
      const ids = form.lines.map(l => l.fromMaterialId).filter(Boolean);
      return new Set(ids).size !== ids.length;
    });
    const sumQty = computed(() => lineViews.value.reduce((s, v) => s + (Number(v.qty) || 0), 0));
    const sameProject = computed(() => !!form.fromProject && form.fromProject === form.toProject);
    /* 硬阻断（决定保存按钮是否可点；不因「还没填」而禁用） */
    const hardIssue = computed(() => {
      if (sameProject.value) return '调出项目与调入项目不能相同';
      if (hasDup.value) return '同一调出材料行只能出现一次';
      const b = lineViews.value.find(v => v.blocked);
      if (b) return '第 ' + (b.idx + 1) + ' 行：' + b.issue;
      const over = lineViews.value.find(v => v.avail !== null && v.qty > v.avail + 1e-9);
      if (over) return '第 ' + (over.idx + 1) + ' 行：超过可用 ' + fmt(over.avail);
      return '';
    });

    function resetForm() {
      form.kind = '调拨';
      form.fromProject = filters.project || '';
      form.toProject = '';
      form.lines = [];
      form.transferDate = today(); form.transferDateReason = ''; form.reason = '';
    }
    function openCreate() {
      dlg.editingId = '';
      resetForm();
      addLine();
      dlg.visible = true;
      fetchStock(); fetchToStock();
    }
    function openEdit(r) {
      if (r.status !== '草稿') return;
      dlg.editingId = r.id;
      form.kind = r.kind; form.fromProject = r.fromProject; form.toProject = r.toProject;
      form.transferDate = r.transferDate; form.transferDateReason = r.transferDateReason || ''; form.reason = r.reason || '';
      form.lines = (r.items || []).map(it => ({ key: 'L' + (++lineSeq), fromMaterialId: it.fromMaterialId, toMaterialId: it.toMaterialId, qty: Number(it.qty) }));
      if (!form.lines.length) addLine();
      dlg.visible = true;
      fetchStock(); fetchToStock();
    }
    function addLine() { form.lines.push(newLine()); }
    function removeLine(key) {
      form.lines = form.lines.filter(l => l.key !== key);
      if (!form.lines.length) addLine();
    }
    /* 更换该行的调出材料（清空本行已选与数量） */
    function clearLine(i) {
      const ln = form.lines[i];
      if (!ln) return;
      ln.fromMaterialId = ''; ln.toMaterialId = ''; ln.qty = null;
    }
    /* 选调出材料后：唯一调入候选自动填；清空旧的调入选择 */
    function onPickFrom(ln) {
      const fromMat = matById(ln.fromMaterialId);
      const cands = toCandidatesOf(fromMat);
      ln.toMaterialId = cands.length === 1 ? cands[0].id : '';
    }
    watch(() => form.toProject, () => { form.lines.forEach(l => { l.toMaterialId = ''; }); fetchToStock(); });
    watch(() => form.fromProject, () => { fetchStock(); form.lines.forEach(l => { l.fromMaterialId = ''; l.toMaterialId = ''; l.qty = null; }); });

    function formError() {
      if (!form.kind) return '请选择类型';
      if (!form.fromProject) return '请选择调出项目';
      if (!form.toProject) return '请选择调入项目';
      if (form.fromProject === form.toProject) return '调出项目与调入项目不能相同';
      if (!form.lines.length) return '请至少添加一行调拨材料';
      for (let i = 0; i < lineViews.value.length; i++) {
        const v = lineViews.value[i];
        if (!v.fromMat) return '第 ' + (i + 1) + ' 行：请选择调出材料';
        if (!v.toMat) return '第 ' + (i + 1) + ' 行：' + (v.issue || '请选择调入材料');
        if (!(v.qty > 0)) return '第 ' + (i + 1) + ' 行：数量必须大于 0';
        if (v.avail !== null && v.qty > v.avail + 1e-9) return '第 ' + (i + 1) + ' 行：' + v.issue;
      }
      const ids = form.lines.map(l => l.fromMaterialId);
      if (new Set(ids).size !== ids.length) return '同一张单里同一调出材料行只能出现一次';
      if (!form.transferDate) return '请选择业务日期';
      if (!String(form.reason || '').trim()) return '请填写调拨原因';
      return '';
    }

    async function submitDraft() {
      if (dlg.saving) return;
      const err = formError();
      if (err) { ElementPlus.ElMessage.error(err); return; }
      dlg.saving = true;
      try {
        const body = {
          kind: form.kind, fromProject: form.fromProject, toProject: form.toProject,
          items: lineViews.value.map(v => ({ fromMaterialId: v.fromMat.id, toMaterialId: v.toMat.id, qty: Number(v.qty) })),
          transferDate: form.transferDate, transferDateReason: form.transferDateReason || '',
          reason: String(form.reason || '').trim(),
        };
        if (dlg.editingId) await api.put('/api/materialTransfers/' + dlg.editingId, body);
        else await api.post('/api/materialTransfers', body);
        ElementPlus.ElMessage.success(dlg.editingId ? '已保存' : '草稿已保存');
        dlg.visible = false;
        await load();
      } catch (e) {
        ElementPlus.ElMessageBox.alert(errText(e), '无法保存', { type: 'error', confirmButtonText: '知道了' });
      } finally {
        dlg.saving = false;
      }
    }

    async function removeDraft(r) {
      try {
        const label = r.status === '已撤销' ? '已撤销单据' : '草稿';
      await ElementPlus.ElMessageBox.confirm('确认删除' + label + '「' + (r.transferNo || '（未编号）') + '」？删除后不再出现在列表。', '提示', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' });
      } catch (e) { return; }
      try {
        await api.del('/api/materialTransfers/' + r.id);
        ElementPlus.ElMessage.success('已删除');
        await load();
      } catch (e) { ElementPlus.ElMessage.error(errText(e)); }
    }

    /* ---------- 生效 / 补回 / 作废补回 / 撤销 ---------- */
    const act = reactive({
      visible: false, saving: false, type: '', row: null, itemId: '',
      reason: '', qty: null, returnDate: today(), returnDateReason: '',
    });
    const actTitle = computed(() => ({ void: '撤销调拨', 'return': '借调补回', 'returnVoid': '作废补回' })[act.type] || '');
    /* 可补回的行（未还 > 0） */
    const returnableItems = computed(() => ((act.row && act.row.items) || []).filter(it => Number(it.outstandingQty) > 0));
    const actItem = computed(() => ((act.row && act.row.items) || []).find(it => it.id === act.itemId) || null);
    /* 该行最近一笔未作废补回（用于作废补回说明） */
    const actLastReturn = computed(() => {
      const it = actItem.value;
      if (!it) return null;
      const rs = it.returns || [];
      for (let i = rs.length - 1; i >= 0; i--) { if (rs[i] && !rs[i].voided) return rs[i]; }
      return null;
    });

    async function effect(r) {
      const n = (r.items || []).length;
      try {
        await ElementPlus.ElMessageBox.confirm(
          '确认让调拨单生效？共 ' + n + ' 行材料，生效后调出侧按行减少、调入侧按行增加，并生成正式单号。',
          '生效确认', { type: 'warning', confirmButtonText: '确定生效', cancelButtonText: '取消' }
        );
      } catch (e) { return; }
      try {
        await api.put('/api/materialTransfers/' + r.id + '/effect', {});
        ElementPlus.ElMessage.success('已生效');
        await load();
      } catch (e) {
        ElementPlus.ElMessageBox.alert(errText(e), '无法生效', { type: 'error', confirmButtonText: '知道了' });
      }
    }

    function openAct(type, r, item) {
      act.type = type; act.row = r; act.reason = '';
      act.returnDate = today(); act.returnDateReason = '';
      if (type === 'return') {
        const list = (r.items || []).filter(it => Number(it.outstandingQty) > 0);
        const first = item && Number(item.outstandingQty) > 0 ? item : list[0];
        act.itemId = first ? first.id : '';
        act.qty = first ? Math.max(0, Number(first.outstandingQty) || 0) : null;
      } else if (type === 'returnVoid') {
        act.itemId = item ? item.id : '';
      } else {
        act.itemId = '';
      }
      act.visible = true;
    }
    watch(() => act.itemId, () => {
      if (act.type !== 'return') return;
      const it = actItem.value;
      act.qty = it ? Math.max(0, Number(it.outstandingQty) || 0) : null;
    });

    async function submitAct() {
      if (act.saving) return;
      const r = act.row;
      if (!r) return;
      if (act.type === 'return') {
        if (!act.itemId) { ElementPlus.ElMessage.error('请选择要补回的明细行'); return; }
        if (!(Number(act.qty) > 0)) { ElementPlus.ElMessage.error('补回数量必须大于 0'); return; }
        const it = actItem.value;
        if (it && Number(act.qty) > Number(it.outstandingQty) + 1e-9) {
          ElementPlus.ElMessage.error('补回数量不能超过该行未还余额 ' + fmt(it.outstandingQty)); return;
        }
        if (!act.returnDate) { ElementPlus.ElMessage.error('请选择补回日期'); return; }
      } else if (!String(act.reason || '').trim()) {
        ElementPlus.ElMessage.error(act.type === 'void' ? '请填写撤销原因' : '请填写作废原因');
        return;
      }
      act.saving = true;
      try {
        if (act.type === 'void') {
          await api.put('/api/materialTransfers/' + r.id + '/void', { reason: String(act.reason).trim() });
        } else if (act.type === 'return') {
          await api.put('/api/materialTransfers/' + r.id + '/return', {
            itemId: act.itemId, qty: Number(act.qty), returnDate: act.returnDate, returnDateReason: act.returnDateReason || '',
          });
        } else {
          await api.put('/api/materialTransfers/' + r.id + '/return/void', { itemId: act.itemId || undefined, reason: String(act.reason).trim() });
        }
        ElementPlus.ElMessage.success(act.type === 'void' ? '已撤销' : (act.type === 'return' ? '补回已登记' : '该笔补回已作废'));
        act.visible = false;
        await load();
        if (det.visible && det.row && det.row.id === r.id) await openDetail(r.id);
      } catch (e) {
        ElementPlus.ElMessageBox.alert(errText(e), '操作未完成', { type: 'error', confirmButtonText: '知道了' });
      } finally {
        act.saving = false;
      }
    }

    /* ---------- 详情 ---------- */
    const det = reactive({ visible: false, row: null });
    async function openDetail(id) {
      try {
        const r = await api.get('/api/materialTransfers/' + id);
        det.row = r;
        det.visible = true;
      } catch (e) { ElementPlus.ElMessage.error(errText(e)); }
    }
    function hasOpenReturn(it) {
      return (it.returns || []).some(r => r && !r.voided);
    }

    onMounted(async () => {
      await loadBase(); await load();
      if (loc.consume()) return;                 // 首页动态定位优先，不被材料聚焦覆盖
      if (window.__mtFocusMaterial) {
        const d = window.__mtFocusMaterial; delete window.__mtFocusMaterial;
        focusMaterial({ detail: d });
      }
    });

    return {
      narrow, dlgWidth, dlg2Width, detWidth, dlgCardStyle, cardHeadStyle, cardBodyStyle, secTitleStyle, hintStyle, fieldLabelStyle, fieldValueStyle,
      flowGrid, flowRightStyle, metaGrid, pairGrid, projGrid, statusColor, afterChip, voidBandStyle, issueStyle, blockRowStyle, tipStyle, cardStyle,
      materials, projectNames, rows, loading, filters,
      barStyle, barRightStyle, fRowStyle, fLabelStyle, roStyle, footStyle, opsStyle, secStyle,
      statusTag, directionText, matBrief, totalQtyOf, load, resetFilters, fmt, operatorName, chipStyle,
      matFilter, tFiltered, tView, clearMatFilter, toStockMap, toState, toAvailOf, loc, locActive, locRowClass,
      dlg, form, fromRows, stockMap, stockState, stockReady, fromCandidates, optsOf, availOf, inQtyOf,
      lineViews, hasIssue, hardIssue, hasDup, sumQty, sameProject,
      openCreate, openEdit, addLine, removeLine, clearLine, onPickFrom, submitDraft, removeDraft,
      act, actTitle, returnableItems, actItem, actLastReturn, openAct, submitAct, effect,
      det, openDetail, hasOpenReturn, errText, refLabel,
    };
  },
  template: `
  <div>
    <div :style="barStyle">
      <el-select v-model="filters.project" placeholder="全部项目" clearable filterable style="width:230px" :disabled="locActive" @change="load">
        <el-option v-for="p in projectNames" :key="p" :label="p" :value="p" />
      </el-select>
      <el-select v-model="filters.direction" style="width:118px" :disabled="locActive" @change="load">
        <el-option label="全部方向" value="all" /><el-option label="调入" value="in" /><el-option label="调出" value="out" />
      </el-select>
      <el-select v-model="filters.kind" placeholder="全部种类" clearable style="width:110px" :disabled="locActive" @change="load">
        <el-option label="调拨" value="调拨" /><el-option label="借调" value="借调" />
      </el-select>
      <el-select v-model="filters.status" placeholder="全部状态" clearable style="width:118px" :disabled="locActive" @change="load">
        <el-option label="草稿" value="草稿" /><el-option label="已生效" value="已生效" />
        <el-option label="已结清" value="已结清" /><el-option label="已撤销" value="已撤销" />
      </el-select>
      <el-checkbox v-model="filters.outstandingOnly" :disabled="locActive" @change="load">仅看借调未还</el-checkbox>
      <el-button :disabled="locActive" @click="resetFilters">重置</el-button>
      <el-tag v-if="matFilter && !locActive" closable type="info" data-testid="mt-mat-filter" @close="clearMatFilter">材料：{{ matFilter.description }}</el-tag>
      <div :style="barRightStyle">
        <el-button @click="load">刷新</el-button>
        <el-button v-if="canWrite('materials')" type="primary" data-testid="mt-create" @click="openCreate">新建调拨</el-button>
      </div>
    </div>

    <loc-banner :st="loc.st" @clear="loc.clear" @pick="loc.pick" />
    <el-table :data="tView" row-key="id" v-loading="loading" border style="width:100%" empty-text="暂无调拨记录"
      :row-class-name="locRowClass">
      <el-table-column label="单号" width="150">
        <template #default="{row}"><span style="font-variant-numeric:tabular-nums">{{ row.transferNo || '草稿' }}</span></template>
      </el-table-column>
      <el-table-column label="材料" min-width="230">
        <template #default="{row}">
          <div style="font-weight:600">{{ matBrief(row) }}</div>
          <div style="color:var(--text-3);font-size:12px;margin-top:2px">{{ (row.items || []).length }} 行明细 · 合计 {{ fmt(totalQtyOf(row)) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="种类" width="76">
        <template #default="{row}"><span :style="chipStyle(row.kind === '借调' ? '#e6932c' : '#3370ff')">{{ row.kind }}</span></template>
      </el-table-column>
      <el-table-column v-if="!narrow" label="方向 / 项目" min-width="230">
        <template #default="{row}"><span style="color:var(--text-2)">{{ directionText(row) }}</span></template>
      </el-table-column>
      <el-table-column v-if="!narrow" label="未还" width="86" align="right">
        <template #default="{row}"><span v-if="row.kind === '借调'">{{ fmt(row.outstandingQty) }}</span><span v-else style="color:var(--text-3)">—</span></template>
      </el-table-column>
      <el-table-column label="状态" width="92">
        <template #default="{row}"><el-tag :type="statusTag(row.status)" size="small" disable-transitions>{{ row.status }}</el-tag></template>
      </el-table-column>
      <el-table-column v-if="!narrow" label="业务日期" width="110">
        <template #default="{row}">{{ row.transferDate }}</template>
      </el-table-column>
      <el-table-column label="操作" :width="narrow ? 86 : 240" fixed="right">
        <template #default="{row}">
          <div class="mat-acts">
            <el-button link type="primary" size="small" @click="openDetail(row.id)">详情</el-button>
            <el-button v-if="row.status === '草稿' && canWrite('materials')" link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button v-if="row.status === '草稿' && canWrite('materials')" link type="primary" size="small" @click="effect(row)">生效</el-button>
            <el-button v-if="(row.status === '草稿' || row.status === '已撤销') && canWrite('materials')" link type="danger" size="small" @click="removeDraft(row)">删除</el-button>
            <el-button v-if="row.kind === '借调' && row.status === '已生效' && canWrite('materials')" link type="primary" size="small" @click="openAct('return', row)">补回</el-button>
            <el-button v-if="row.status === '已生效' && canWrite('materials')" link type="danger" size="small" @click="openAct('void', row)">撤销</el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
    <div :style="footStyle">共 {{ tView.length }} 条</div>

    <!-- 新建 / 编辑草稿（卡块：信息 / 明细 / 业务） -->
    <el-dialog v-model="dlg.visible" :title="dlg.editingId ? '编辑调拨草稿' : '新建调拨草稿'" :width="dlg2Width"
      :close-on-click-modal="false" append-to-body top="5vh" style="border-radius:12px">
      <div>
        <!-- ① 调拨信息 -->
        <div :style="dlgCardStyle">
          <div :style="cardHeadStyle">
            <span :style="secTitleStyle">调拨信息</span>
            <span :style="Object.assign({}, hintStyle, { marginLeft: 'auto' })">带 <span style="color:#f56c6c">*</span> 为必填</span>
          </div>
          <div :style="cardBodyStyle">
            <div :style="pairGrid">
              <div style="min-width:0">
                <label :style="fieldLabelStyle">类型 <span style="color:#f56c6c">*</span></label>
                <el-radio-group v-model="form.kind">
                  <el-radio-button label="调拨" /><el-radio-button label="借调" />
                </el-radio-group>
                <div :style="Object.assign({}, hintStyle, { marginTop: '6px' })">
                  {{ form.kind === '借调'
                    ? '临时借用，后续用「补回」归还；未还满前一直挂未还量'
                    : '料归对方所有，不再归还；建错只能作废重开' }}
                </div>
              </div>
              <div style="min-width:0">
                <label :style="fieldLabelStyle">经办人</label>
                <div :style="fieldValueStyle">{{ operatorName }}</div>
              </div>
            </div>

            <!-- 项目流向：一出一进并排，中间箭头表明方向 -->
            <div :style="projGrid">
              <div style="min-width:0">
                <label :style="fieldLabelStyle">调出项目 <span style="color:#f56c6c">*</span></label>
                <el-select v-model="form.fromProject" data-testid="mt-from-project" placeholder="选择调出项目" filterable style="width:100%">
                  <el-option v-for="p in projectNames" :key="p" :label="p" :value="p" />
                </el-select>
              </div>
              <div v-if="!narrow" style="display:flex;align-items:center;justify-content:center;height:32px;color:var(--text-3);font-size:15px">→</div>
              <div style="min-width:0">
                <label :style="fieldLabelStyle">调入项目 <span style="color:#f56c6c">*</span></label>
                <el-select v-model="form.toProject" data-testid="mt-to-project" placeholder="选择调入项目" filterable style="width:100%">
                  <el-option v-for="p in projectNames" :key="p" :label="p" :value="p" />
                </el-select>
              </div>
            </div>
            <div v-if="sameProject" :style="tipStyle('error')">调出项目与调入项目不能相同，请重新选择</div>
          </div>
        </div>

        <!-- ② 调拨材料明细 -->
        <div :style="dlgCardStyle">
          <div :style="cardHeadStyle">
            <span :style="secTitleStyle">调拨材料明细</span>
            <span :style="hintStyle">
              <template v-if="!form.fromProject">请先选择调出项目</template>
              <template v-else-if="stockState.error"><span style="color:#f56c6c">{{ stockState.error }}</span></template>
              <template v-else-if="stockState.loading">可用量加载中…</template>
              <template v-else>可选 {{ fromCandidates.length }} 种有库存材料</template>
            </span>
            <el-button size="small" type="primary" plain data-testid="mt-add-line" :disabled="!form.fromProject"
              style="margin-left:auto" @click="addLine">+ 添加材料</el-button>
          </div>
          <div :style="cardBodyStyle">
            <el-table v-if="!narrow" :data="lineViews" row-key="key" class="mat-table dlg-table" style="width:100%" empty-text="请点击「添加材料」"
              :row-style="({ row }) => (row.blocked ? blockRowStyle : {})">
              <el-table-column label="物料描述" min-width="236">
                <template #default="{row, $index}">
                  <el-select v-if="!row.fromMat" :model-value="form.lines[$index].fromMaterialId" data-testid="mt-line-from" filterable size="small"
                    placeholder="选择调出材料" style="width:100%" :disabled="!form.fromProject || !stockReady"
                    @update:model-value="v => { form.lines[$index].fromMaterialId = v; onPickFrom(form.lines[$index]); }">
                    <el-option v-for="m in optsOf(form.lines[$index])" :key="m.id" :value="m.id" :label="m.description">
                      <span style="float:left">{{ m.description }}</span>
                      <span style="float:right;color:var(--text-3);font-size:12px">{{ m.code || '无编码' }} · 可用 {{ fmt(availOf(m.id)) }}</span>
                    </el-option>
                  </el-select>
                  <div v-else>
                    <div style="display:flex;align-items:flex-start;gap:8px">
                      <span style="font-weight:600;flex:1;line-height:1.35">{{ row.fromMat.description }}</span>
                      <el-button link type="primary" size="small" tabindex="-1" style="flex:none" @click="clearLine($index)">更换</el-button>
                    </div>
                    <div v-if="row.blocked" style="margin-top:3px">
                      <el-tag type="danger" size="small" disable-transitions>不可调拨</el-tag>
                    </div>
                  </div>
                  <div v-if="row.issue" :style="issueStyle">{{ row.issue }}</div>
                </template>
              </el-table-column>
              <el-table-column label="数量" width="72" align="right">
                <template #default="{row}"><span class="mat-num" style="color:var(--text-2)">{{ row.fromMat ? fmt(row.fromMat.qtyRequired) : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="入库量" width="78" align="right">
                <template #default="{row}">
                  <span class="mat-num" :style="{ color: (row.fromMat && row.arrived <= 0) ? '#f56c6c' : 'var(--text-1)', fontWeight: (row.fromMat && row.arrived <= 0) ? 600 : 400 }">
                    {{ row.fromMat ? fmt(row.arrived) : '—' }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="单位" width="56" align="center">
                <template #default="{row}"><span class="mat-sub">{{ row.fromMat ? (row.fromMat.unit || '—') : '—' }}</span></template>
              </el-table-column>
              <el-table-column label="物料编码" width="112">
                <template #default="{row}">
                  <span class="mat-code" :class="{ 'is-empty': !row.fromMat || !row.fromMat.code }">{{ row.fromMat ? (row.fromMat.code || '—') : '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="可用" width="76" align="right">
                <template #default="{row}">
                  <span class="mat-num" :style="{ fontWeight: 600, color: (row.avail !== null && row.avail <= 0) ? '#f56c6c' : 'var(--text-1)' }">
                    {{ row.avail === null ? '—' : fmt(row.avail) }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="本次调拨" width="104">
                <template #default="{row, $index}">
                  <el-input-number v-if="row.fromMat && !row.blocked" :model-value="form.lines[$index].qty" data-testid="mt-line-qty"
                    :min="0" :controls="false" size="small" style="width:100%" placeholder="0"
                    @update:model-value="v => { form.lines[$index].qty = v; }" />
                  <span v-else style="color:var(--text-3);font-size:12px">{{ row.fromMat ? '不可调拨' : '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="调拨后剩余" width="94" align="right">
                <template #default="{row}">
                  <span class="mat-num" :style="{ fontWeight: 600, color: row.remain === null ? 'var(--text-3)' : (row.remain < 0 ? '#f56c6c' : (row.remain === 0 ? 'var(--text-3)' : 'var(--text-1)')) }">
                    {{ row.remain === null ? '—' : fmt(row.remain) }}
                  </span>
                </template>
              </el-table-column>
              <el-table-column label="调入前后" width="134" align="center">
                <template #default="{row}">
                  <span v-if="row.toMat && row.toAvail !== null" class="mat-num">
                    <span style="color:var(--text-2)">{{ fmt(row.toAvail) }}</span>
                    <span style="color:var(--text-3);margin:0 4px">→</span>
                    <span style="font-weight:600;color:var(--ok-text)">{{ fmt(row.toAfter) }}</span>
                  </span>
                  <span v-else style="color:var(--text-3)">{{ !row.fromMat ? '—' : (row.cands && row.cands.length > 1 ? '待指定' : '—') }}</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="54" align="center">
                <template #default="{row}">
                  <el-button link type="danger" size="small" tabindex="-1" @click="removeLine(row.key)">移除</el-button>
                </template>
              </el-table-column>
            </el-table>

            <!-- 窄屏：卡片式明细 -->
            <div v-if="narrow" style="display:flex;flex-direction:column;gap:8px">
              <div v-for="(row, i) in lineViews" :key="row.key" class="mt-card mat-table" :style="cardStyle(row)">
                <div style="display:flex;gap:8px;align-items:flex-start">
                  <div style="flex:1;min-width:0">
                    <el-select v-if="!row.fromMat" :model-value="form.lines[i].fromMaterialId" data-testid="mt-line-from" filterable size="small"
                      placeholder="选择调出材料" style="width:100%" :disabled="!form.fromProject || !stockReady"
                      @update:model-value="v => { form.lines[i].fromMaterialId = v; onPickFrom(form.lines[i]); }">
                      <el-option v-for="m in optsOf(form.lines[i])" :key="m.id" :value="m.id" :label="m.description">
                        <span style="float:left">{{ m.description }}</span>
                        <span style="float:right;color:var(--text-3);font-size:12px">{{ m.code || '无编码' }} · 可用 {{ fmt(availOf(m.id)) }}</span>
                      </el-option>
                    </el-select>
                    <template v-else>
                      <div style="font-weight:600;line-height:1.35">{{ row.fromMat.description }}</div>
                      <div style="color:var(--text-3);font-size:12px;margin-top:2px;display:flex;align-items:center;gap:6px">
                        <span>{{ row.fromMat.code || '无编码' }} · {{ row.fromMat.unit || '无单位' }}</span>
                        <el-tag v-if="row.blocked" type="danger" size="small" disable-transitions>不可调拨</el-tag>
                      </div>
                    </template>
                    <div v-if="row.issue" :style="issueStyle">{{ row.issue }}</div>
                  </div>
                  <el-button v-if="row.fromMat" link type="primary" size="small" tabindex="-1" style="flex:none" @click="clearLine(i)">更换</el-button>
                  <el-button link type="danger" size="small" tabindex="-1" style="flex:none" @click="removeLine(row.key)">移除</el-button>
                </div>
                <div v-if="row.fromMat" style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">
                  <span class="mat-num" style="font-size:12px;color:var(--text-2)">数量 {{ fmt(row.fromMat.qtyRequired) }}</span>
                  <span class="mat-num" style="font-size:12px;color:var(--text-2)">入库 {{ fmt(row.arrived) }}</span>
                  <span class="mat-num" style="font-size:12px;color:var(--text-2)">可用 {{ fmt(row.avail) }}</span>
                  <span class="mat-num" :style="{ fontSize: '12px', color: (row.remain !== null && row.remain < 0) ? '#f56c6c' : 'var(--text-3)' }">
                    剩余 {{ row.remain === null ? '—' : fmt(row.remain) }}
                  </span>
                  <span v-if="row.toMat && row.toAvail !== null" class="mat-num" style="font-size:12px;color:var(--text-3)">
                    调入 {{ fmt(row.toAvail) }} → <b style="color:var(--ok-text)">{{ fmt(row.toAfter) }}</b>
                  </span>
                  <div style="margin-left:auto;width:112px">
                    <el-input-number v-if="!row.blocked" :model-value="form.lines[i].qty" data-testid="mt-line-qty"
                      :min="0" :controls="false" size="small" style="width:100%" placeholder="0"
                      @update:model-value="v => { form.lines[i].qty = v; }" />
                    <span v-else style="font-size:12px;color:var(--text-3)">—</span>
                  </div>
                </div>
              </div>
              <div v-if="!lineViews.length" style="font-size:12px;color:var(--text-3);text-align:center;padding:14px">请点击「添加材料」</div>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:10px;padding-top:9px;border-top:1px dashed rgba(140,160,190,.25)">
              <span :style="hintStyle">仅「可用 &gt; 0」的材料可调拨；「调入前后」为调入项目该材料的可用量变化</span>
              <span :style="hintStyle">共 <b style="color:var(--text-1)">{{ lineViews.length }}</b> 行 · 合计
                <b class="mat-num" style="color:var(--text-1);font-size:13px">{{ fmt(sumQty) }}</b></span>
            </div>
          </div>
        </div>

        <!-- ③ 业务信息 -->
        <div :style="dlgCardStyle">
          <div :style="cardHeadStyle">
            <span :style="secTitleStyle">业务信息</span>
          </div>
          <div :style="cardBodyStyle">
            <div :style="pairGrid">
              <div style="min-width:0">
                <label :style="fieldLabelStyle">业务日期</label>
                <el-date-picker v-model="form.transferDate" data-testid="mt-date" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" style="width:100%" />
              </div>
              <div style="min-width:0">
                <label :style="fieldLabelStyle">补录原因</label>
                <el-input v-model="form.transferDateReason" placeholder="业务日期超过 30 天时必填" />
              </div>
            </div>
            <div style="margin-top:12px">
              <label :style="fieldLabelStyle">调拨原因 <span style="color:#f56c6c">*</span></label>
              <el-input v-model="form.reason" data-testid="mt-reason" type="textarea" :rows="2" placeholder="说明本次调拨的业务背景" />
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <div style="display:flex;align-items:center;gap:12px;border-top:1px solid rgba(140,160,190,.18);padding-top:12px;margin-top:2px">
          <span v-if="hardIssue" style="color:#f56c6c;font-size:12px;flex:1;text-align:left">{{ hardIssue }}</span>
          <span v-else style="flex:1"></span>
          <el-button @click="dlg.visible = false">取消</el-button>
          <el-button type="primary" data-testid="mt-save" :loading="dlg.saving" :disabled="dlg.saving || !!hardIssue" @click="submitDraft">保存草稿</el-button>
        </div>
      </template>
    </el-dialog>

    <!-- 补回 / 作废补回 / 撤销 -->
    <el-dialog v-model="act.visible" :title="actTitle" :width="dlgWidth" :close-on-click-modal="false" append-to-body>
      <div v-if="act.row">
        <div :style="fRowStyle"><label :style="fLabelStyle">单号</label><div :style="roStyle">{{ act.row.transferNo || '（未编号）' }} · {{ act.row.kind }} · {{ act.row.status }}</div></div>
        <template v-if="act.type === 'return'">
          <div :style="fRowStyle">
            <label :style="fLabelStyle">补回哪一行</label>
            <el-select v-model="act.itemId" data-testid="mt-act-item" placeholder="选择明细行" style="width:100%">
              <el-option v-for="it in returnableItems" :key="it.id"
                :label="it.description + ' · 未还 ' + fmt(it.outstandingQty) + ' ' + (it.unit || '')" :value="it.id" />
            </el-select>
          </div>
          <div :style="fRowStyle">
            <label :style="fLabelStyle">补回数量</label>
            <el-input-number v-model="act.qty" data-testid="mt-act-qty" :min="0" :max="actItem ? Number(actItem.outstandingQty) : 0" :precision="4" :controls="false" style="width:100%" />
          </div>
          <div :style="fRowStyle">
            <label :style="fLabelStyle">补回日期</label>
            <el-date-picker v-model="act.returnDate" type="date" value-format="YYYY-MM-DD" placeholder="YYYY-MM-DD" style="width:100%" />
          </div>
          <div :style="fRowStyle">
            <label :style="fLabelStyle">补录原因</label>
            <el-input v-model="act.returnDateReason" placeholder="日期超过 30 天时必填" />
          </div>
        </template>
        <template v-else>
          <div v-if="act.type === 'returnVoid'" :style="fRowStyle">
            <label :style="fLabelStyle">作废哪一行</label>
            <el-select v-model="act.itemId" placeholder="选择明细行（默认最近一笔）" clearable style="width:100%">
              <el-option v-for="it in (act.row.items || []).filter(x => hasOpenReturn(x))" :key="it.id"
                :label="it.description + ' · 未还 ' + fmt(it.outstandingQty) + ' ' + (it.unit || '')" :value="it.id" />
            </el-select>
          </div>
          <div v-if="act.type === 'returnVoid' && actLastReturn" :style="fRowStyle">
            <label :style="fLabelStyle">将作废</label>
            <div :style="roStyle">{{ actLastReturn.returnDate }} · 补回 {{ fmt(actLastReturn.qty) }}</div>
          </div>
          <div :style="fRowStyle">
            <label :style="fLabelStyle">{{ act.type === 'void' ? '撤销原因' : '作废原因' }}</label>
            <el-input v-model="act.reason" data-testid="mt-act-reason" type="textarea" :rows="2" placeholder="必填" />
          </div>
        </template>
      </div>
      <template #footer>
        <el-button @click="act.visible = false">取消</el-button>
        <el-button type="primary" data-testid="mt-act-ok" :loading="act.saving" :disabled="act.saving" @click="submitAct">确定</el-button>
      </template>
    </el-dialog>

    <!-- 详情 -->
    <el-dialog v-model="det.visible" title="调拨详情" :width="detWidth" append-to-body top="6vh" style="border-radius:12px">
      <div v-if="det.row">
        <!-- 抬头上半：单号 / 种类 / 状态 -->
        <div :style="dlgCardStyle">
          <div :style="cardHeadStyle">
            <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:15.5px;font-weight:600;letter-spacing:.01em;color:var(--text-1)">
              {{ det.row.transferNo || '（未编号）' }}
            </span>
            <span :style="chipStyle(det.row.kind === '借调' ? '#e6932c' : '#3370ff')">{{ det.row.kind }}</span>
            <span :style="chipStyle(statusColor(det.row.status))">{{ det.row.status }}</span>
            <span v-if="!narrow" :style="Object.assign({}, hintStyle, { marginLeft: 'auto' })">业务日期 {{ det.row.transferDate }}</span>
          </div>
          <div :style="cardBodyStyle">
            <div :style="flowGrid">
              <div style="flex:1 1 0;min-width:0">
                <div :style="hintStyle">调出项目</div>
                <div :style="Object.assign({}, fieldValueStyle, { fontWeight: 600, marginTop: '2px' })">{{ det.row.fromProject }}</div>
              </div>
              <div v-if="!narrow" style="flex:none;color:var(--text-3);font-size:16px;line-height:22px;padding-bottom:1px">→</div>
              <div v-else style="color:var(--text-3);font-size:12px;line-height:12px">↓</div>
              <div :style="flowRightStyle">
                <div :style="hintStyle">调入项目</div>
                <div :style="Object.assign({}, fieldValueStyle, { fontWeight: 600, marginTop: '2px' })">{{ det.row.toProject }}</div>
              </div>
            </div>

            <div :style="metaGrid">
              <div v-if="narrow" style="min-width:0">
                <div :style="hintStyle">业务日期</div>
                <div :style="fieldValueStyle">{{ det.row.transferDate }}</div>
              </div>
              <div style="min-width:0">
                <div :style="hintStyle">经办人</div>
                <div :style="fieldValueStyle">{{ det.row.operator }}（{{ det.row.operatorAccount }}）</div>
              </div>
              <div style="min-width:0">
                <div :style="hintStyle">创建时间</div>
                <div :style="fieldValueStyle">{{ det.row.createdAt || '—' }}</div>
              </div>
              <div style="min-width:0">
                <div :style="hintStyle">生效时间</div>
                <div :style="fieldValueStyle">{{ det.row.effectedAt || '—' }}</div>
              </div>
            </div>

            <div v-if="det.row.reason" style="margin-top:10px;padding-top:9px;border-top:1px dashed rgba(140,160,190,.25)">
              <div :style="hintStyle">调拨原因</div>
              <div :style="fieldValueStyle">{{ det.row.reason }}</div>
            </div>

            <div v-if="det.row.kind === '借调'" style="display:flex;gap:18px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px dashed rgba(140,160,190,.25)">
              <span :style="hintStyle">已补回 <b class="mat-num" style="font-size:13.5px;color:var(--text-1)">{{ fmt(det.row.returnedQty) }}</b></span>
              <span :style="hintStyle">未还 <b class="mat-num" :style="{ fontSize: '13.5px', color: Number(det.row.outstandingQty) > 0 ? '#e6932c' : 'var(--text-1)' }">{{ fmt(det.row.outstandingQty) }}</b></span>
            </div>

            <div v-if="det.row.voidedAt" :style="voidBandStyle">
              已撤销 · {{ det.row.voidedAt }}<span v-if="det.row.voidReason"> · {{ det.row.voidReason }}</span>
            </div>
          </div>
        </div>

        <!-- 明细 -->
        <div :style="dlgCardStyle">
          <div :style="cardHeadStyle">
            <span :style="secTitleStyle">调拨明细</span>
            <span :style="hintStyle">{{ (det.row.items || []).length }} 行</span>
            <span :style="Object.assign({}, hintStyle, { marginLeft: 'auto' })">调出前后 / 调入前后按业务日核算，不含本单及其补回</span>
          </div>
          <div :style="cardBodyStyle">
            <el-table v-if="!narrow" :data="(det.row.items) || []" class="mat-table dlg-table" style="width:100%">
              <el-table-column label="物料描述" min-width="210"><template #default="{row}">{{ row.description }}</template></el-table-column>
              <el-table-column label="编码" width="116"><template #default="{row}"><span class="mat-code">{{ row.code || '—' }}</span></template></el-table-column>
              <el-table-column label="单位" width="54" align="center"><template #default="{row}"><span class="mat-sub">{{ row.unit || '—' }}</span></template></el-table-column>
              <el-table-column label="调拨量" width="78" align="right"><template #default="{row}"><span class="mat-num" style="font-weight:600">{{ fmt(row.qty) }}</span></template></el-table-column>
              <el-table-column label="调出前后" width="132" align="center">
                <template #default="{row}">
                  <span v-if="row.compare && row.compare.fromBefore !== null" class="mat-num">
                    <span style="color:var(--text-2)">{{ fmt(row.compare.fromBefore) }}</span>
                    <span style="color:var(--text-3);margin:0 4px">→</span>
                    <span :style="afterChip('#e6932c')">{{ fmt(row.compare.fromAfter) }}</span>
                  </span>
                  <span v-else style="color:var(--text-3)" :title="row.compare && row.compare.voided ? '单据已撤销，无库存影响' : ''">{{ row.compare && row.compare.voided ? '已撤销' : '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column label="调入前后" width="132" align="center">
                <template #default="{row}">
                  <span v-if="row.compare && row.compare.toBefore !== null" class="mat-num">
                    <span style="color:var(--text-2)">{{ fmt(row.compare.toBefore) }}</span>
                    <span style="color:var(--text-3);margin:0 4px">→</span>
                    <span :style="afterChip('#2f9e63')">{{ fmt(row.compare.toAfter) }}</span>
                  </span>
                  <span v-else style="color:var(--text-3)" :title="row.compare && row.compare.voided ? '单据已撤销，无库存影响' : ''">{{ row.compare && row.compare.voided ? '已撤销' : '—' }}</span>
                </template>
              </el-table-column>
              <el-table-column v-if="det.row.kind === '借调'" label="已补回" width="80" align="right"><template #default="{row}"><span class="mat-num">{{ fmt(row.returnedQty) }}</span></template></el-table-column>
              <el-table-column v-if="det.row.kind === '借调'" label="未还" width="80" align="right"><template #default="{row}"><span class="mat-num" style="color:#e6932c;font-weight:600">{{ fmt(row.outstandingQty) }}</span></template></el-table-column>
              <el-table-column v-if="canWrite('materials') && det.row.kind === '借调' && (det.row.status === '已生效' || det.row.status === '已结清')" label="操作" width="90" align="center">
                <template #default="{row}">
                  <el-button v-if="hasOpenReturn(row)" link type="danger" size="small" data-testid="mt-return-void" @click="openAct('returnVoid', det.row, row)">作废补回</el-button>
                  <span v-else style="color:var(--text-3);font-size:12px">—</span>
                </template>
              </el-table-column>
            </el-table>

            <!-- 窄屏：卡片式明细 -->
            <div v-else style="display:flex;flex-direction:column;gap:8px">
              <div v-for="(row, i) in (det.row.items || [])" :key="row.id || i"
                class="mt-card mat-table" :style="{ border: '1px solid rgba(140,160,190,.22)', borderRadius: '8px', padding: '10px 12px', background: 'var(--surface)' }">
                <div style="font-weight:600;line-height:1.4">{{ row.description }}</div>
                <div style="color:var(--text-3);font-size:12px;margin-top:2px">{{ row.code || '—' }} · {{ row.unit || '—' }}</div>
                <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--text-2)">
                  <span>调拨量 <b class="mat-num" style="color:var(--text-1)">{{ fmt(row.qty) }}</b></span>
                  <span v-if="row.compare && row.compare.fromBefore !== null">调出
                    <b class="mat-num" style="color:var(--text-2)">{{ fmt(row.compare.fromBefore) }}</b>
                    <span style="color:var(--text-3);margin:0 3px">→</span>
                    <b class="mat-num" style="color:#e6932c">{{ fmt(row.compare.fromAfter) }}</b>
                  </span>
                  <span v-else style="color:var(--text-3)">{{ row.compare && row.compare.voided ? '已撤销' : '—' }}</span>
                  <span v-if="row.compare && row.compare.toBefore !== null">调入
                    <b class="mat-num" style="color:var(--text-2)">{{ fmt(row.compare.toBefore) }}</b>
                    <span style="color:var(--text-3);margin:0 3px">→</span>
                    <b class="mat-num" style="color:var(--ok-text)">{{ fmt(row.compare.toAfter) }}</b>
                  </span>
                </div>
                <div v-if="det.row.kind === '借调'" style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:12px;color:var(--text-2)">
                  <span>已补回 <b class="mat-num" style="color:var(--text-1)">{{ fmt(row.returnedQty) }}</b></span>
                  <span>未还 <b class="mat-num" style="color:#e6932c">{{ fmt(row.outstandingQty) }}</b></span>
                  <el-button v-if="canWrite('materials') && (det.row.status === '已生效' || det.row.status === '已结清') && hasOpenReturn(row)"
                    link type="danger" size="small" data-testid="mt-return-void" @click="openAct('returnVoid', det.row, row)">作废补回</el-button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 补回记录（借调） -->
        <div v-if="det.row.kind === '借调'" :style="dlgCardStyle">
          <div :style="cardHeadStyle">
            <span :style="secTitleStyle">补回记录</span>
          </div>
          <div :style="cardBodyStyle">
            <el-table v-if="!narrow" :data="(det.row.items || []).filter(x => (x.returns || []).length)" class="mat-table dlg-table" style="width:100%" empty-text="暂无补回">
              <el-table-column label="物料" min-width="180"><template #default="{row}">{{ row.description }}</template></el-table-column>
              <el-table-column label="补回明细" min-width="320">
                <template #default="{row}">
                  <div v-for="(r, i) in row.returns" :key="i" style="line-height:1.8">
                    <span style="font-variant-numeric:tabular-nums">{{ r.returnDate }}</span>
                    <span class="mat-num" style="margin-left:8px;font-weight:600">{{ fmt(r.qty) }}</span>
                    <span style="margin-left:8px;color:var(--text-3)">{{ r.by || '—' }}</span>
                    <el-tag v-if="r.voided" type="danger" size="small" style="margin-left:8px" disable-transitions>已作废</el-tag>
                    <span v-if="r.voided && r.voidReason" style="color:var(--text-3);font-size:12px;margin-left:6px">{{ r.voidReason }}</span>
                  </div>
                </template>
              </el-table-column>
            </el-table>
            <!-- 窄屏：补回记录改列表（表格在 390 宽会横向溢出） -->
            <div v-else style="display:flex;flex-direction:column;gap:8px">
              <div v-for="(row, i) in (det.row.items || []).filter(x => (x.returns || []).length)" :key="row.id || i"
                style="border:1px solid rgba(140,160,190,.22);border-radius:8px;padding:9px 11px">
                <div style="font-weight:600;line-height:1.4">{{ row.description }}</div>
                <div v-for="(r, k) in row.returns" :key="k" style="margin-top:5px;font-size:12px;color:var(--text-2);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  <span style="font-variant-numeric:tabular-nums">{{ r.returnDate }}</span>
                  <b class="mat-num" style="color:var(--text-1)">{{ fmt(r.qty) }}</b>
                  <span style="color:var(--text-3)">{{ r.by || '—' }}</span>
                  <el-tag v-if="r.voided" type="danger" size="small" disable-transitions>已作废</el-tag>
                  <span v-if="r.voided && r.voidReason" style="color:var(--text-3)">{{ r.voidReason }}</span>
                </div>
              </div>
              <div v-if="!(det.row.items || []).filter(x => (x.returns || []).length).length"
                style="font-size:12px;color:var(--text-3);text-align:center;padding:10px">暂无补回</div>
            </div>
          </div>
        </div>
      </div>

      <template #footer>
        <div style="display:flex;justify-content:flex-end;border-top:1px solid rgba(140,160,190,.18);padding-top:12px">
          <el-button @click="det.visible = false">关闭</el-button>
        </div>
      </template>
    </el-dialog>
  `,
};

if (typeof window !== 'undefined') window.MaterialTransfers = MaterialTransfers;
