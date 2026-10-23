/* ========== core/crud ========== */
/* 通用增删改查骨架：列表 / 详情 / 新增 / 更新 / 删除（可选逻辑删除与业务集合过滤）。 */
const app = require('./app');
const { DB, saveDB } = require('./db');
const { genId, nowISO, aliveFilter } = require('./util');

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

module.exports = { crud };
