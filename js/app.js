import { loadConfig, saveConfig, normalizeBase, ArcheryApi, ArcheryApiError } from './api.js';
import { mountIcons, icon, el } from './icons.js';
import { SqlEditor } from './editor.js';

mountIcons();

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ======================= 全局状态 ======================= */
const state = {
  api: null,
  cfg: null,
  instances: [], // [{id, instance_name, db_type, type}]
  current: { instance: '', db: '', schema: '' },
  dbs: [], // 当前实例库列表
  dbsLoading: Promise.resolve(), // 当前实例库列表的在途加载（树点击等待库选项就绪用）
  results: [], // 结果 tab 集合
  activeResult: null,
  lastQueryLogId: null, // 最近一次执行对应的 query_log_id（收藏用）
  resultSeq: 0,
  // 各列表页
  history: { page: 1, search: '', total: 0 },
  workflow: { page: 1, search: '', total: 0 },
  theme: localStorage.getItem('archery-theme') || 'dark',
};

/* ======================= 工具 ======================= */
/** 程序内设置下拉值：combo 显示层依赖 change 事件刷新，直接赋值不生效 */
function setSelectValue(sel, value) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el || el.value === value) return;
  if (!el.querySelector(`option[value="${CSS.escape(String(value))}"]`)) return;
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 轻量 Markdown 渲染（标题/列表/加粗/行内代码），用于更新日志展示 */
function renderMarkdown(text) {
  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`(.+?)`/g, '<code>$1</code>');
  const out = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  for (const line of String(text).split('\n')) {
    if (/^### /.test(line)) {
      closeList();
      out.push(`<h4>${inline(line.slice(4))}</h4>`);
    } else if (/^## /.test(line)) {
      closeList();
      out.push(`<h3>${inline(line.slice(3))}</h3>`);
    } else if (/^# /.test(line)) {
      closeList();
      out.push(`<h2>${inline(line.slice(2))}</h2>`);
    } else if (/^- /.test(line)) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === '') {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join('');
}

function toast(text, type = 'info') {
  const t = el(`<div class="toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}">
    <span data-icon="${type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info'}"></span>
    <span>${escapeHtml(text)}</span></div>`);
  $('#toast-region').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function openModal(title, bodyNode, opts = {}) {
  $('#modal-title').textContent = title;
  const body = $('#modal-body');
  body.replaceChildren(bodyNode);
  mountIcons(body);
  $('#modal').classList.toggle('wide', !!opts.wide);
  $('#modal').showModal();
}
function closeModal() {
  $('#modal')?.close();
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('close', () => {
  const remote = $('#modal').dataset.updateRemote;
  if (remote) {
    chrome.storage.local.set({ dismissedUpdate: remote });
    delete $('#modal').dataset.updateRemote;
  }
});

function download(filename, content, mime = 'text/plain') {
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([content], { type: mime + ';charset=utf-8' }));
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/* ======================= 主题 ======================= */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $('#theme-toggle').innerHTML = `${icon(state.theme === 'dark' ? 'sun' : 'moon')}<small>主题</small>`;
}
$('#theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('archery-theme', state.theme);
  applyTheme();
});

/* ======================= 视图切换 ======================= */
$$('.rail-button[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.nav));
});
function switchView(name) {
  $$('.rail-button[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'favorites') {
    renderLocalList();
    // 静默拉取云端新增（其它设备 / 网页端手动收藏），失败不打扰
    refreshCloudFavorites({ quiet: true }).catch(() => {});
  }
  if (name === 'workflow') loadWorkflows();
}

/* ======================= 连接 ======================= */
function setConnection(ok, text) {
  const c = $('#connection');
  c.classList.toggle('ok', ok);
  c.innerHTML = `<i></i>${escapeHtml(text)}`;
}

/** 连接失败时展示原因 + 页面内登录表单 */
let pendingCandidates = null; // 未配置时待选择的 Archery 候选地址

function showAuthBanner(reason) {
  $('#auth-banner-text').textContent = reason;
  $('#banner-user').value = state.cfg?.username || '';
  $('#banner-pass').value = state.cfg?.password || '';
  $('#banner-totp').value = state.cfg?.totpSecret || '';
  $('#auth-banner').hidden = false;
  // 有候选地址时在横幅内列出供点选采用
  const candBox = $('#banner-candidates');
  if (!candBox) return;
  candBox.replaceChildren();
  if (pendingCandidates?.length) {
    const title = el('<div style="font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:4px">检测到以下 Archery 地址，点选使用：</div>');
    candBox.appendChild(title);
    for (const c of pendingCandidates) {
      const btn = el(`<button class="button small" style="margin:0 6px 6px 0">${icon('database')}<span>${escapeHtml(c.origin.replace(/^https?:\/\//, ''))}</span></button>`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          state.cfg = await saveConfig({ baseUrl: c.origin });
          toast(`已选择 ${c.origin}，正在连接…`, 'info');
          await init();
        } catch (e) {
          toast(`切换失败：${e.message}`, 'error');
          btn.disabled = false;
        }
      });
      candBox.appendChild(btn);
    }
  }
}

async function init() {
  applyTheme();
  metaIndex.load(); // 本地对象索引后台加载，供顶部搜索
  state.cfg = await loadConfig();
  // 未配置地址：在登录横幅里列出候选 Archery 地址让用户点选（可能不止一个）
  if (!state.cfg.baseUrl) {
    try {
      const { archeryCandidates } = await chrome.storage.local.get({ archeryCandidates: [] });
      if (archeryCandidates.length) {
        pendingCandidates = archeryCandidates;
      }
    } catch { /* 候选读取失败则走未配置引导 */ }
  }
  state.api = new ArcheryApi(state.cfg);
  $('#server-label').textContent = state.cfg.baseUrl.replace(/^https?:\/\//, '') || 'SQL 工作台';
  $('#user-name').textContent = state.cfg.username || '浏览器会话';
  $('#avatar').innerHTML = icon('user');
  let hasSession = false;
  try {
    hasSession = await state.api.hasSession();
  } catch (e) {
    // 地址未配置等环境问题：直接引导，不中断页面
    setConnection(false, '未配置');
    showAuthBanner(`${e.message}。`);
    return;
  }
  if (hasSession) {
    // 已有浏览器会话：直接连接，不打扰
    await connect();
    return;
  }
  // 无会话：有保存过的凭证就自动登录，失败再弹出登录表单
  if (state.cfg.username && state.cfg.password) {
    setConnection(false, '登录中…');
    try {
      await state.api.login();
      await connect();
      return;
    } catch (e) {
      if (!e.sessionKey) {
        showAuthBanner(`自动登录失败：${e.message}。请核对下方账号信息后重新登录。`);
        return;
      }
      // 2FA：交给横幅流程继续
      showAuthBanner(e.message);
      pendingTwoFa = { sessionKey: e.sessionKey };
      $('#banner-otp').hidden = false;
      $('#banner-login').textContent = '验证';
      return;
    }
  }
  setConnection(false, '未登录');
  showAuthBanner('未检测到 Archery 登录会话：请在浏览器登录 Archery 后点「重新检测」，或直接在下方输入账号密码登录。');
}

async function connect() {
  setConnection(false, '连接中…');
  try {
    const res = await state.api.userInstances();
    if (res.status !== 0) throw new ArcheryApiError(res.msg || '无法获取实例列表');
    state.instances = res.data || [];
    setConnection(true, `已连接 · ${state.instances.length} 个实例`);
    $('#auth-banner').hidden = true;
    buildInstanceSelectors();
    buildTree();
    restoreDraft();
    // 无凭证（纯浏览器会话）时，用自己最近一条查询日志取显示名
    if (!state.cfg.username) {
      state.api
        .queryLog({ limit: 1, offset: 0 })
        .then((r) => {
          const name = r.rows?.[0]?.user_display;
          if (name) {
            $('#user-name').textContent = name;
          }
        })
        .catch(() => {});
    }
  } catch (e) {
    setConnection(false, '连接失败');
    showAuthBanner(
      e.needLogin
        ? `${e.message} 可直接在下方输入账号密码登录。`
        : `连接失败：${e.message || '未知错误'}。若刚在浏览器登录过，可点「重新检测」。`
    );
    if (e.needLogin) toast(e.message, 'error');
  }
}
$('#retry-connect').addEventListener('click', connect);

/* 顶栏地址标签：点击弹出已知 Archery 地址一键切换（自动发现 + 手动保存过的） */
$('#server-label').addEventListener('click', async (e) => {
  e.stopPropagation();
  let candidates = [];
  try {
    const { archeryCandidates } = await chrome.storage.local.get({ archeryCandidates: [] });
    candidates = archeryCandidates;
  } catch { /* 读取失败按无候选处理 */ }
  if (!candidates.length) {
    return toast('暂无已知地址：在浏览器打开 Archery 自动发现，或在设置里手动填写保存', 'info');
  }
  const cur = state.cfg?.baseUrl;
  const r = e.currentTarget.getBoundingClientRect();
  showContextMenu(
    r.left,
    r.bottom + 4,
    candidates.map((c) => ({
      label: `${c.origin === cur ? '✓ ' : ''}${c.origin.replace(/^https?:\/\//, '')}${c.source === 'manual' ? '' : '（自动发现）'}`,
      icon: 'database',
      action: async () => {
        if (c.origin === cur) return;
        try {
          state.cfg = await saveConfig({ baseUrl: c.origin });
          toast(`已切换到 ${c.origin}，正在连接…`, 'info');
          await init();
        } catch (err) {
          toast(`切换失败：${err.message}`, 'error');
        }
      },
    }))
  );
});

/* 横幅内登录：账号密码 →（若需 2FA）动态验证码 → 重连 */
let pendingTwoFa = null; // {sessionKey}
$('#banner-login').addEventListener('click', async () => {
  const btn = $('#banner-login');
  const username = $('#banner-user').value.trim();
  const password = $('#banner-pass').value;
  const otpInput = $('#banner-otp');
  btn.disabled = true;
  try {
    // 第二阶段：已拿到待验证会话，提交动态码
    if (pendingTwoFa) {
      const otp = otpInput.value.trim();
      if (!/^\d{6}$/.test(otp)) {
        toast('请输入 6 位动态验证码', 'error');
        return;
      }
      btn.textContent = '验证中…';
      await state.api.verifyTwoFa(pendingTwoFa.sessionKey, otp);
      pendingTwoFa = null;
      otpInput.hidden = true;
      otpInput.value = '';
      toast('两步验证通过', 'success');
      await connect();
      return;
    }
    // 第一阶段：账号密码登录
    if (!username || !password) {
      toast('请输入用户名和密码', 'error');
      return;
    }
    btn.textContent = '登录中…';
    state.cfg = await saveConfig({
      username,
      password,
      totpSecret: $('#banner-totp').value.trim(),
    });
    state.api = new ArcheryApi(state.cfg);
    await state.api.login();
    $('#user-name').textContent = username;
    $('#avatar').innerHTML = icon('user');
    toast('登录成功', 'success');
    await connect();
  } catch (e) {
    if (e.sessionKey) {
      // 服务器要求 2FA：切换到验证码输入
      pendingTwoFa = { sessionKey: e.sessionKey };
      otpInput.hidden = false;
      otpInput.focus();
      $('#auth-banner-text').textContent = `${e.message}`;
      toast('需要两步验证，请输入当前动态码', 'info');
    } else {
      toast(`登录失败：${e.message}`, 'error');
      $('#auth-banner-text').textContent = `登录失败：${e.message}`;
    }
  } finally {
    btn.disabled = false;
    btn.textContent = pendingTwoFa ? '验证' : '登录';
  }
});
$('#banner-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#banner-login').click();
});
$('#banner-otp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#banner-login').click();
});

/* ======================= 实例/库 联动 ======================= */
const DB_TYPE_LABEL = { mysql: 'MySQL', tidb: 'TiDB', mssql: 'MsSQL', redis: 'Redis', pgsql: 'PgSQL', oracle: 'Oracle', mongo: 'Mongo', phoenix: 'Phoenix', odps: 'ODPS', clickhouse: 'ClickHouse', starrocks: 'StarRocks', adb: 'ADB' };

function buildInstanceSelectors() {
  const groups = new Map();
  for (const ins of state.instances) {
    const label = DB_TYPE_LABEL[ins.db_type] || ins.db_type;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(ins);
  }
  const opts = ['<option value="">选择实例</option>'];
  for (const [label, list] of groups) {
    opts.push(`<optgroup label="${escapeHtml(label)}">`);
    for (const ins of list) {
      opts.push(`<option value="${escapeHtml(ins.instance_name)}" data-id="${ins.id}">${escapeHtml(ins.instance_name)}</option>`);
    }
    opts.push('</optgroup>');
  }
  $('#instance-name').innerHTML = opts.join('');
  $('#audit-instance').innerHTML = opts.join('');
  $('#diff-instance-a').innerHTML = opts.join('');
  $('#diff-instance-b').innerHTML = opts.join('');
  $('#diag-instance').innerHTML = opts.join('');
}

let instanceLoadSeq = 0; // 实例切换序号：过期的库列表响应直接丢弃，防止旧响应重建下拉时清掉新选的库
async function onInstanceChange(instanceName, { fromTree = false } = {}) {
  const seq = ++instanceLoadSeq;
  state.current.instance = instanceName;
  state.current.db = '';
  state.current.schema = '';
  const dbSel = $('#db-name');
  dbSel.innerHTML = '<option value="">选择库</option>';
  dbSel.disabled = true;
  $('#schema-field').hidden = true;
  $('#schema-name').innerHTML = '<option value="">选择 schema</option>';
  state.dbs = [];
  saveDraft();
  if (!instanceName) return;
  state.dbsLoading = (async () => {
    try {
      const res = await state.api.databases(instanceName);
      if (seq !== instanceLoadSeq) return; // 已切到别的实例（或重复触发），本次响应过期
      if (res.status !== 0) throw new Error(res.msg);
      state.dbs = res.data || [];
      dbSel.innerHTML =
        '<option value="">选择库</option>' +
        state.dbs.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
      dbSel.disabled = false;
      // PgSQL 需要 schema
      const ins = state.instances.find((i) => i.instance_name === instanceName);
      if (ins?.db_type === 'pgsql') $('#schema-field').hidden = false;
    } catch (e) {
      toast(`获取数据库列表失败：${e.message}`, 'error');
    }
  })();
  await state.dbsLoading;
  if (!fromTree) highlightTreeNode(['i', instanceName]);
}

/**
 * 选中实例并等待其库列表就绪（供 树/历史回填/草稿恢复/命令面板 等联动调用）。
 * 设值后派发一次 change：combo 显示层靠 change 刷新标签（静默设值会导致
 * 界面仍显示旧实例），实例加载链也由 change 监听统一发起，全程只有一条链。
 */
async function selectInstance(name) {
  const sel = $('#instance-name');
  if (name && sel.value !== name) {
    if (!sel.querySelector(`option[value="${CSS.escape(String(name))}"]`)) return;
    sel.value = name;
    sel.dispatchEvent(new Event('change', { bubbles: true })); // 单链：监听器发起 onInstanceChange
  } else if (!name) {
    onInstanceChange('');
  }
  await state.dbsLoading;
}

$('#instance-name').addEventListener('change', (e) => onInstanceChange(e.target.value));
$('#db-name').addEventListener('change', (e) => {
  state.current.db = e.target.value;
  state.current.schema = '';
  saveDraft();
  preloadTables();
  indexDbLazy(state.current.instance, e.target.value); // 静默补充搜索索引（含字段）
  if (state.current.instance && e.target.value) {
    const ins = state.instances.find((i) => i.instance_name === state.current.instance);
    if (ins?.db_type === 'pgsql') loadSchemas();
  }
  highlightTreeNode(['i', state.current.instance, 'd', e.target.value]);
});

async function loadSchemas() {
  try {
    const res = await state.api.schemas(state.current.instance, state.current.db);
    if (res.status !== 0) throw new Error(res.msg);
    $('#schema-name').innerHTML =
      '<option value="">选择 schema</option>' +
      (res.data || []).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  } catch (e) {
    toast(`获取 schema 失败：${e.message}`, 'error');
  }
}
$('#schema-name').addEventListener('change', (e) => {
  state.current.schema = e.target.value;
  saveDraft();
});

/* ======================= 对象树 ======================= */
const tree = {
  root: null, // [{group}] 结构按需加载
};

async function buildTree() {
  const container = $('#object-tree');
  container.replaceChildren(el(`<div class="tree-empty">加载中…</div>`));
  const groups = new Map();
  for (const ins of state.instances) {
    const label = DB_TYPE_LABEL[ins.db_type] || ins.db_type;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(ins);
  }
  tree.root = [...groups.entries()].map(([label, list]) => ({
    kind: 'group',
    name: label,
    children: list.map((i) => ({ kind: 'instance', name: i.instance_name, dbType: i.db_type, id: i.id })),
  }));
  renderTree();
  $('#tree-total').textContent = `${state.instances.length} 实例`;
}

function renderTree() {
  const filter = $('#tree-search').value.trim().toLowerCase();
  const container = $('#object-tree');
  const frag = document.createDocumentFragment();

  // 索引全库搜索：搜到未展开的库 / 表（数据来自本地缓存索引）
  if (filter) {
    const idxBox = el(`<div class="tree-node idx-results"></div>`);
    if (!metaIndex.loaded || !Object.keys(metaIndex.data.dbs).length) {
      idxBox.appendChild(el(`<div class="tree-row idx-head"><span class="label">全库搜索：暂无索引</span></div>`));
      idxBox.appendChild(el(`<div class="tree-empty" style="padding:8px 12px">点上方刷新按钮 →「重构搜索索引」后，可搜到全部实例的库和表</div>`));
    } else {
      const dbHits = [];
      const tableHits = [];
      const seenDb = new Set();
      for (const entry of Object.values(metaIndex.data.dbs)) {
        if (entry.db.toLowerCase().includes(filter) && !seenDb.has(`${entry.instance}|${entry.db}`) && dbHits.length < 8) {
          seenDb.add(`${entry.instance}|${entry.db}`);
          dbHits.push(entry);
        }
        for (const tb of entry.tables || []) {
          if (tableHits.length < 30 && tb.toLowerCase().includes(filter)) {
            tableHits.push({ entry, tb });
          }
        }
      }
      idxBox.appendChild(el(`<div class="tree-row idx-head"><span class="label">全库搜索 · ${tableHits.length} 张表 / ${dbHits.length} 个库</span></div>`));
      for (const d of dbHits) {
        const row = el(`<div class="tree-row" title="${escapeHtml(`${d.instance}/${d.db}`)}">
          <span class="icon" data-icon="folder"></span>
          <span class="label"><b>${escapeHtml(d.db)}</b></span>
          <span class="sub">${escapeHtml(d.instance)}</span>
        </div>`);
        row.addEventListener('click', async () => {
          switchView('query');
          await selectInstance(d.instance);
          setSelectValue('#db-name', d.db);
        });
        idxBox.appendChild(row);
      }
      for (const { entry, tb } of tableHits) {
        const row = el(`<div class="tree-row" title="${escapeHtml(`${entry.instance}/${entry.db}.${tb}`)}">
          <span class="icon" data-icon="table"></span>
          <span class="label">${escapeHtml(tb)}</span>
          <span class="sub">${escapeHtml(entry.db)}</span>
        </div>`);
        row.addEventListener('click', () => jumpToTable(entry.instance, entry.db, tb));
        idxBox.appendChild(row);
      }
      if (!dbHits.length && !tableHits.length) {
        idxBox.appendChild(el(`<div class="tree-empty" style="padding:8px 12px">全库搜索无匹配</div>`));
      }
    }
    frag.appendChild(idxBox);
  }

  for (const group of tree.root) {
    const gNode = el(`<div class="tree-node open" data-kind="group" data-name="${escapeHtml(group.name)}"></div>`);
    const gRow = el(`<div class="tree-row expanded">
      <span class="caret" data-icon="right"></span>
      <span class="icon" data-icon="folder"></span>
      <span class="label">${escapeHtml(group.name)}</span>
      <span class="count">${group.children.length}</span>
    </div>`);
    gRow.addEventListener('click', () => {
      gNode.classList.toggle('open');
      gRow.classList.toggle('expanded');
    });
    gNode.appendChild(gRow);
    const children = document.createElement('div');
    children.className = 'tree-children';
    for (const ins of group.children) {
      if (filter && !nodeMatches(ins, filter)) continue;
      children.appendChild(instanceNode(ins));
    }
    gNode.appendChild(children);
    frag.appendChild(gNode);
  }
  container.replaceChildren(frag);
  if (!$('#object-tree').children.length) {
    container.replaceChildren(el(`<div class="tree-empty">没有匹配的对象</div>`));
  }
  mountIcons(container);
}

function nodeMatches(node, filter) {
  if (node.name.toLowerCase().includes(filter)) return true;
  return (node.children || []).some((c) => nodeMatches(c, filter));
}

function instanceNode(ins) {
  const node = el(`<div class="tree-node" data-kind="instance" data-name="${escapeHtml(ins.name)}"></div>`);
  const row = el(`<div class="tree-row">
    <span class="caret" data-icon="right"></span>
    <span class="icon" data-icon="database"></span>
    <span class="label">${escapeHtml(ins.name)}</span>
  </div>`);
  const children = document.createElement('div');
  children.className = 'tree-children';
  let loading = false;
  row.addEventListener('click', async () => {
    node.classList.toggle('open');
    row.classList.toggle('expanded');
    // 联动查询栏（selectInstance 负责 combo 标签刷新与单链加载）
    if ($('#instance-name').value !== ins.name) {
      await selectInstance(ins.name);
    }
    // 每次展开都实时拉取最新库清单（不用缓存）；进行中防重复点击
    if (node.classList.contains('open') && !loading) {
      loading = true;
      children.replaceChildren(el(`<div class="tree-empty">加载中…</div>`));
      try {
        const res = await state.api.databases(ins.name);
        if (res.status !== 0) throw new Error(res.msg);
        children.replaceChildren();
        for (const db of res.data || []) {
          children.appendChild(dbNode(ins, db));
        }
        if (!children.children.length) children.replaceChildren(el(`<div class="tree-empty">无数据库</div>`));
      } catch (e) {
        children.replaceChildren(el(`<div class="tree-empty">${escapeHtml(e.message)}</div>`));
      } finally {
        loading = false;
      }
    }
  });
  node.append(row, children);
  return node;
}

function dbNode(ins, dbName) {
  const node = el(`<div class="tree-node" data-kind="db" data-name="${escapeHtml(dbName)}"></div>`);
  const row = el(`<div class="tree-row">
    <span class="caret" data-icon="right"></span>
    <span class="icon" data-icon="folder"></span>
    <span class="label">${escapeHtml(dbName)}</span>
  </div>`);
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '导出数据字典（Markdown）',
        icon: 'download',
        action: () => exportDataDict(typeof ins === 'string' ? ins : ins.name || ins.instance_name, dbName),
      },
      {
        label: '重建该库搜索索引',
        icon: 'search',
        action: async () => {
          const insName = typeof ins === 'string' ? ins : ins.name || ins.instance_name;
          setIndexProgress(true, `索引：${insName}/${dbName}`);
          try {
            await indexDb(insName, dbName);
            setIndexProgress(false);
            toast(`已索引 ${insName}/${dbName}（顶部搜索可搜该库表名）`, 'success');
          } catch (e) {
            setIndexProgress(false);
            toast(`索引失败：${e.message}`, 'error');
          }
        },
      },
      {
        label: '复制库名',
        icon: 'copy',
        action: () => {
          navigator.clipboard.writeText(dbName);
          toast('已复制', 'success');
        },
      },
    ]);
  });
  const children = document.createElement('div');
  children.className = 'tree-children';
  let loading = false;
  row.addEventListener('click', async (e) => {
    node.classList.toggle('open');
    row.classList.toggle('expanded');
    // 联动查询栏：实例不同则单链切换；相同则等在途加载完成，保证库选项就绪
    if ($('#instance-name').value !== ins.name) {
      await selectInstance(ins.name);
    } else {
      await state.dbsLoading;
    }
    // setSelectValue 触发 change，由监听完成 state/草稿/预载表/树高亮
    if ($('#db-name').querySelector(`option[value="${CSS.escape(dbName)}"]`) && $('#db-name').value !== dbName) {
      setSelectValue('#db-name', dbName);
    }
    // 每次展开都实时拉取最新表清单（不用缓存）；进行中防重复点击
    if (node.classList.contains('open') && !loading) {
      loading = true;
      children.replaceChildren(el(`<div class="tree-empty">加载中…</div>`));
      try {
        const res = await state.api.tables(ins.name, dbName);
        if (res.status !== 0) throw new Error(res.msg);
        children.replaceChildren();
        const tables = res.data || [];
        for (const tb of tables) {
          children.appendChild(tableNode(ins, dbName, tb));
        }
        if (!tables.length) children.replaceChildren(el(`<div class="tree-empty">无表</div>`));
      } catch (e) {
        children.replaceChildren(el(`<div class="tree-empty">${escapeHtml(e.message)}</div>`));
      } finally {
        loading = false;
      }
    }
  });
  node.append(row, children);
  return node;
}

/* ---------- 右键菜单 ---------- */
let ctxMenuEl = null;
function closeContextMenu() {
  ctxMenuEl?.remove();
  ctxMenuEl = null;
}
document.addEventListener('click', closeContextMenu);
window.addEventListener('blur', closeContextMenu);
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.tree-row')) closeContextMenu();
});
function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = el(`<div class="ctx-menu"></div>`);
  for (const it of items) {
    if (it === '-') {
      menu.appendChild(el(`<div class="ctx-sep"></div>`));
      continue;
    }
    const btn = el(`<button>${icon(it.icon || 'chevron')}<span>${escapeHtml(it.label)}</span></button>`);
    btn.addEventListener('click', () => {
      closeContextMenu();
      it.action();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, innerHeight - rect.height - 8) + 'px';
  ctxMenuEl = menu;
}

function tableNode(ins, dbName, tableName) {
  const node = el(`<div class="tree-node" data-kind="table" data-name="${escapeHtml(tableName)}"></div>`);
  const row = el(`<div class="tree-row" title="${escapeHtml(tableName)}">
    <span class="icon" data-icon="table"></span>
    <span class="label">${escapeHtml(tableName)}</span>
  </div>`);
  row.addEventListener('click', () => {
    highlightTreeNode(['i', ins.name, 'd', dbName, 't', tableName]);
    describeTable(ins, dbName, tableName);
  });
  row.addEventListener('dblclick', () => {
    editor.insertText(tableName);
    toast(`已插入表名 ${tableName}`, 'success');
  });
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const insName = typeof ins === 'string' ? ins : ins.name || ins.instance_name;
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '查看表结构',
        icon: 'eye',
        action: () => describeTable(ins, dbName, tableName),
      },
      {
        label: 'SELECT *',
        icon: 'table',
        action: () => editor.insertText(`select * from \`${tableName}\` limit 100;
`),
      },
      {
        label: 'SELECT 全部字段',
        icon: 'grid',
        action: async () => {
          const cols = await getTableColumns(insName, dbName, tableName);
          if (!cols.length) return toast('未能获取字段列表', 'error');
          const colList = cols.map((c) => '  `' + c + '`').join(',\n');
          editor.insertText(`select\n${colList}\nfrom \`${tableName}\` limit 100;\n`);
        },
      },
      {
        label: 'SELECT COUNT',
        icon: 'list',
        action: () => editor.insertText(`select count(*) as cnt from \`${tableName}\`;
`),
      },
      '-',
      { label: '复制表名', icon: 'copy', action: () => { navigator.clipboard.writeText(tableName); toast('已复制', 'success'); } },
      { label: '复制库名.表名', icon: 'copy', action: () => { navigator.clipboard.writeText(`${dbName}.${tableName}`); toast('已复制', 'success'); } },
    ]);
  });
  node.appendChild(row);
  return node;
}

/* 表字段缓存：describe 解析 CREATE TABLE 提取列名 */
const columnCache = new Map(); // key: instance/db/table -> string[]
async function getTableColumns(instanceName, dbName, tableName) {
  const key = `${instanceName}/${dbName}/${tableName}`;
  if (columnCache.has(key)) return columnCache.get(key);
  try {
    const res = await state.api.describe(instanceName, dbName, tableName);
    if (res.status !== 0) throw new Error(res.msg);
    const createSql = res.data?.rows?.[0]?.[1] || '';
    const cols = [...createSql.matchAll(/^\s*`(\w+)`/gm)].map((m) => m[1]);
    columnCache.set(key, cols);
    return cols;
  } catch (e) {
    toast(`获取 ${tableName} 字段失败：${e.message}`, 'error');
    return [];
  }
}

function highlightTreeNode(path = []) {
  $$('#object-tree .tree-row.current').forEach((r) => r.classList.remove('current'));
  if (!path.length) return;
  const kindMap = { i: 'instance', d: 'db', t: 'table' };
  let scope = $('#object-tree');
  for (let i = 0; i < path.length; i += 2) {
    const kind = kindMap[path[i]] || path[i];
    const name = path[i + 1];
    if (!kind || !name || !scope) return;
    const node = [...scope.querySelectorAll(`.tree-node[data-kind="${kind}"]`)].find((n) => n.dataset.name === name);
    if (!node) return;
    let ancestor = node;
    while (ancestor) {
      ancestor.classList.add('open');
      ancestor.querySelector(':scope > .tree-row')?.classList.add('expanded');
      ancestor = ancestor.parentElement?.closest('.tree-node');
    }
    const row = node.querySelector(':scope > .tree-row');
    if (i >= path.length - 2) row?.classList.add('current');
    scope = node.querySelector(':scope > .tree-children') || node;
  }
}

$('#tree-search').addEventListener('input', renderTree);
/* 刷新按钮：中间弹窗两个选项（刷新 / 重构索引） */
$('#refresh-tree').addEventListener('click', () => {
  const body = el(`<div>
    <div style="display:flex;flex-direction:column;gap:10px">
      <button class="button favpick" id="rp-refresh">${icon('refresh')}<span><b>刷新实例与对象</b><small>重新拉取实例列表并刷新对象树（轻量，随时可点）</small></span></button>
      ${indexBuilding
        ? `<button class="button favpick" id="rp-index-warn" style="border-color:var(--danger)">${icon('alert')}<span><b style="color:var(--danger)">索引重建中，请勿重复拉取</b><small id="rp-warn-sub">进度见数据浏览器，请等待完成</small></span></button>`
        : `<button class="button favpick" id="rp-index" style="border-color:color-mix(in srgb, var(--warn) 55%, var(--border))">${icon('alert')}<span><b style="color:var(--warn)">重构搜索索引（重资源操作）</b><small>仅为搜索框搜表名服务；会逐实例拉取库表清单、消耗服务端资源，无搜索需求不建议使用</small></span></button>`}
    </div>
  </div>`);
  body.querySelector('#rp-refresh').addEventListener('click', async () => {
    closeModal();
    await connect();
    toast('数据浏览器已刷新', 'success');
  });
  const warnBtn = body.querySelector('#rp-index-warn');
  if (warnBtn) {
    const t = $('#index-progress-text')?.textContent;
    if (t) warnBtn.querySelector('#rp-warn-sub').textContent = `当前进度：${t}`;
    warnBtn.addEventListener('click', () => toast('⚠ 索引重建进行中，请等待完成，请勿重复拉取', 'error'));
    return openModal('数据浏览器刷新', body);
  }
  body.querySelector('#rp-index').addEventListener('click', () => {
    closeModal();
    confirmRebuildIndex();
  });
  openModal('数据浏览器刷新', body);
});

/** 重构索引：范围选择器（树形到库级；部分=增量更新，全选=完全重建） */
function confirmRebuildIndex() {
  if (indexBuilding) {
    setIndexProgress(true);
    const txt = $('#index-progress-text')?.textContent || '';
    return toast(`⚠ 索引重建进行中${txt ? `（${txt}）` : ''}，请等待完成，请勿重复拉取`, 'error');
  }
  metaIndex.load().then(() => {
    // 索引里已知的 实例→库 映射（用于树形选择器展开到库级）
    const known = new Map();
    for (const e of Object.values(metaIndex.data.dbs)) {
      if (!known.has(e.instance)) known.set(e.instance, []);
      known.get(e.instance).push(e.db);
    }
    const body = el(`<div class="idx-picker">
      <div class="idxp-warn">${icon('alert')}<div>
          <b>如无「搜索框搜表名」的需求，不建议重建索引，请直接点「取消」。</b><br />
          · 索引<b>只服务于搜索框搜表名</b>，对象树浏览、查询、补全等全部功能<b>不依赖索引</b>，不建索引零影响<br />
          · 重建会<b>逐实例拉取库表清单</b>，实例多时对 Archery 服务端有明显压力<br />
          · 「全选 = 完全重建」最重，<b>请勿频繁操作</b>；日常建议只增量勾选需要的实例/库
        </div></div>
      <p class="idxp-desc">
        勾选<b>实例</b> = 更新该实例全部库；单独勾<b>库</b> = 只更新该库（其余索引保留，<b>增量更新</b>）；「全选」= <b>完全重建</b>。只拉「库 + 表」清单，不拉字段与详情。
      </p>
      <div class="idx-picker-bar">
        <div class="search-field" style="flex:1;min-width:160px;height:30px">
          <span data-icon="search"></span>
          <input id="idxp-search" placeholder="搜索类型 / 实例 / 库…" autocomplete="off" />
        </div>
        <button class="button small" id="idxp-all">${icon('check')}<span>全选（完全重建）</span></button>
        <button class="button small" id="idxp-none">清空选择</button>
      </div>
      <div class="idx-picker-bar" style="margin-top:-2px">
        <span class="idxp-summary" id="idxp-summary">未选择</span>
      </div>
      <div class="idx-picker-tree" id="idxp-tree"></div>
      <div class="setting-actions">
        <button class="button" id="idx-cancel">取消</button>
        <button class="button primary" id="idx-go" disabled>${icon('search')}<span>开始</span></button>
      </div>
    </div>`);
    const tree = body.querySelector('#idxp-tree');
    const summary = body.querySelector('#idxp-summary');
    const goBtn = body.querySelector('#idx-go');
    const insBoxes = [];
    const groupBoxes = [];
    const dbBoxes = [];

    const renderPickerTree = () => {
      // 按数据库类型分组（与对象树一致）：类型 → 实例 → 库，默认全部收起
      const groups = new Map();
      for (const ins of state.instances) {
        const label = DB_TYPE_LABEL[ins.db_type] || ins.db_type || '其他';
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label).push(ins);
      }
      for (const [gname, list] of groups) {
        const gnode = el(`<div class="idxp-group"></div>`);
        const grow = el(`<div class="idxp-row idxp-group-row" title="展开/收起">
          <span class="caret" data-icon="right"></span>
          <input type="checkbox" data-kind="group" title="勾选 = 更新该类型实例（筛选时只作用于可见项）">
          <span class="icon" data-icon="folder"></span>
          <span class="label"><b>${escapeHtml(gname)}</b></span>
          <span class="count">${list.length}</span>
        </div>`);
        const groupBox = grow.querySelector('input');
        const groupNames = list.map((i) => i.instance_name);
        groupBoxes.push({ box: groupBox, names: groupNames });
        // 勾类型 = 联动勾上该类型实例及其库；筛选状态下只作用于当前可见行（清除筛选后勾选保留，可分批筛选累积勾选）
        const applyGroup = (checked) => {
          for (const it of insBoxes) {
            if (!groupNames.includes(it.name)) continue;
            if (it.box.closest('.idxp-row')?.classList.contains('filtered-hide')) continue;
            it.box.checked = checked;
          }
          for (const d of dbBoxes) {
            if (!groupNames.includes(d.ins)) continue;
            if (d.box.closest('.idxp-row')?.classList.contains('filtered-hide')) continue;
            d.box.checked = checked;
          }
          sync();
        };
        grow.addEventListener('click', (ev) => {
          if (ev.target.closest('.caret')) {
            gnode.classList.toggle('open');
            grow.classList.toggle('expanded');
            return;
          }
          if (ev.target === groupBox) return applyGroup(groupBox.checked); // 原生已切换
          groupBox.checked = !groupBox.checked || groupBox.indeterminate;
          applyGroup(groupBox.checked);
        });
        gnode.appendChild(grow);
        const gkids = el(`<div class="idxp-children"></div>`);
        for (const ins of list) {
          const inode = el(`<div class="idxp-node"></div>`);
          const irow = el(`<div class="idxp-row idxp-ins-row">
            <span class="caret" data-icon="right" title="展开/收起"></span>
            <input type="checkbox" data-kind="ins" title="勾选 = 更新该实例全部库">
            <span class="icon" data-icon="database"></span>
            <span class="label">${escapeHtml(ins.instance_name)}</span>
          </div>`);
          const insBox = irow.querySelector('input');
          insBoxes.push({ box: insBox, name: ins.instance_name });
          const ikids = el(`<div class="idxp-children"></div>`);
          for (const db of known.get(ins.instance_name) || []) {
            const drow = el(`<div class="idxp-row idxp-db-row">
              <input type="checkbox" data-kind="db" title="勾选 = 只更新该库">
              <span class="icon" data-icon="folder"></span>
              <span class="label">${escapeHtml(db)}</span>
            </div>`);
            const dbBox = drow.querySelector('input');
            dbBoxes.push({ box: dbBox, ins: ins.instance_name, db });
            drow.addEventListener('click', (ev) => {
              if (ev.target === dbBox) return sync(); // 直接点 checkbox：原生已切换，仅同步
              dbBox.checked = !dbBox.checked;
              sync();
            });
            ikids.appendChild(drow);
          }
          if (!ikids.children.length) {
            ikids.appendChild(el(`<div class="idxp-row idxp-none">（未索引过：勾选实例将拉取其全部库）</div>`));
          }
          // 点箭头收起/展开；点行其他区域切换勾选（勾实例联动勾库；筛选状态下只联动可见库）
          const applyIns = () => {
            ikids.querySelectorAll('.idxp-db-row').forEach((row) => {
              if (!row.classList.contains('filtered-hide')) row.querySelector('input').checked = insBox.checked;
            });
            sync();
          };
          irow.addEventListener('click', (ev) => {
            if (ev.target.closest('.caret')) {
              inode.classList.toggle('open');
              irow.classList.toggle('expanded');
              return;
            }
            if (ev.target === insBox) return applyIns(); // 直接点 checkbox：原生已切换
            insBox.checked = !insBox.checked;
            applyIns();
          });
          inode.append(irow, ikids);
          gkids.appendChild(inode);
        }
        gnode.appendChild(gkids);
        tree.appendChild(gnode);
      }
      mountIcons(tree);
    };

    const sync = () => {
      const insSel = insBoxes.filter((x) => x.box.checked).map((x) => x.name);
      const dbSel = dbBoxes.filter((x) => x.box.checked);
      // 库半选时实例框显示未勾（实例勾选=拉全库，与单独勾库是不同意图）
      const n = insSel.length + dbSel.length;
      summary.textContent = n ? `已选 ${insSel.length} 个实例 + ${dbSel.length} 个库` : '未选择';
      goBtn.disabled = !n;
      goBtn.querySelector('span').textContent = isFullSelection() ? '完全重建' : `开始更新（${n} 项）`;
      // 类型框回写：全勾 = 勾选，部分勾 = 半选（indeterminate）
      for (const g of groupBoxes) {
        const items = insBoxes.filter((x) => g.names.includes(x.name));
        const all = items.length > 0 && items.every((x) => x.box.checked);
        const some = items.some((x) => x.box.checked);
        g.box.checked = all;
        g.box.indeterminate = some && !all;
      }
    };
    const isFullSelection = () => insBoxes.length > 0 && insBoxes.every((x) => x.box.checked);

    renderPickerTree();
    sync();
    // 树搜索：过滤 类型/实例/库，命中自动展开父链；清空关键字恢复默认收起
    body.querySelector('#idxp-search').addEventListener('input', (e) => {
      const kw = e.target.value.trim().toLowerCase();
      const groups = [...tree.querySelectorAll(':scope > .idxp-group')];
      const reset = (node) => {
        // 彻底还原：组自身的过滤隐藏 + 所有子行/子节点的隐藏与展开状态全部清除
        node.classList.remove('filtered-hide', 'open');
        node.querySelectorAll('.idxp-node').forEach((n) => n.classList.remove('open'));
        node.querySelectorAll('.idxp-row').forEach((r) => r.classList.remove('filtered-hide', 'expanded'));
      };
      if (!kw) {
        groups.forEach(reset);
        return;
      }
      for (const g of groups) {
        const gLabel = g.querySelector(':scope > .idxp-row .label')?.textContent.toLowerCase() || '';
        const gMatch = gLabel.includes(kw);
        let any = false;
        if (gMatch) {
          // 类型名命中：整组显示并展开
          g.querySelectorAll('.idxp-row').forEach((r) => r.classList.remove('filtered-hide'));
          any = true;
        } else {
          for (const node of g.querySelectorAll(':scope > .idxp-children > .idxp-node')) {
            const iLabel = node.querySelector(':scope > .idxp-row .label')?.textContent.toLowerCase() || '';
            const iMatch = iLabel.includes(kw);
            let dbAny = false;
            const dbRows = [...node.querySelectorAll(':scope > .idxp-children .idxp-row')];
            for (const r of dbRows) {
              const hit = r.classList.contains('idxp-db-row') && r.querySelector('.label')?.textContent.toLowerCase().includes(kw);
              r.classList.toggle('filtered-hide', !iMatch && !hit);
              if (hit) dbAny = true;
            }
            node.querySelector(':scope > .idxp-row').classList.toggle('filtered-hide', !iMatch && !dbAny);
            if (iMatch || dbAny) {
              node.classList.add('open');
              node.querySelector(':scope > .idxp-row').classList.add('expanded');
              any = true;
            } else {
              node.classList.remove('open');
              node.querySelector(':scope > .idxp-row').classList.remove('expanded');
            }
          }
        }
        g.classList.toggle('filtered-hide', !any);
        if (any) {
          g.classList.add('open');
          g.querySelector(':scope > .idxp-row').classList.add('expanded');
        }
      }
    });
    body.querySelector('#idxp-all').addEventListener('click', () => {
      [...insBoxes, ...dbBoxes].forEach((x) => (x.box.checked = true));
      sync();
      toast('⚠ 已全选：将执行完全重建（清空现有索引重新拉取全量），请勿频繁拉取全量', 'error');
    });
    body.querySelector('#idxp-none').addEventListener('click', () => {
      [...insBoxes, ...dbBoxes].forEach((x) => (x.box.checked = false));
      sync();
    });
    body.querySelector('#idx-cancel').addEventListener('click', closeModal);
    goBtn.addEventListener('click', () => {
      const insSel = insBoxes.filter((x) => x.box.checked).map((x) => x.name);
      const dbSel = dbBoxes.filter((x) => x.box.checked).map((x) => [x.ins, x.db]);
      closeModal();
      runIndexUpdate(insSel, dbSel, { wipe: isFullSelection() });
    });
    openModal('重构搜索索引 · 选择范围', body, { wide: true });
  });
}

/** 按选择更新索引：wipe=完全重建（清空后拉全部）；否则只更新选中实例/库（增量） */
async function runIndexUpdate(insSel, dbSel, { wipe = false } = {}) {
  if (indexBuilding) return toast('⚠ 索引重建进行中，请等待完成，请勿重复拉取', 'error');
  if (!state.instances.length) return toast('请先连接 Archery（等待实例列表加载）', 'error');
  setIndexProgress(true, '准备…');
  toast(wipe ? '开始完全重建索引，进度见左侧数据浏览器' : `开始更新索引（${insSel.length} 实例 + ${dbSel.length} 库），进度见左侧数据浏览器`, 'info');
  indexBuilding = true;
  try {
    await metaIndex.load();
    if (wipe) metaIndex.data.dbs = {};
    // 实例级：拉库清单展开为库对（带进度）
    const pairs = [...dbSel];
    const insList = wipe ? state.instances.map((i) => i.instance_name) : insSel;
    let insDone = 0;
    await poolRun(insList, 2, async (name) => {
      const res = await state.api.databases(name);
      insDone += 1;
      setIndexProgress(true, `拉取实例清单 ${insDone}/${insList.length}（${Math.round((insDone / insList.length) * 100)}%）：${name}`, (insDone / insList.length) * 100);
      if (res.status === 0) for (const db of res.data || []) pairs.push([name, db]);
      await new Promise((r) => setTimeout(r, 30));
    });
    // 库级：逐库拉表清单（带进度）
    let done = 0;
    await poolRun(pairs, 2, async ([instance, db]) => {
      await indexDb(instance, db, { persist: false });
      done += 1;
      setIndexProgress(true, `索引 ${done}/${pairs.length}（${Math.round((done / pairs.length) * 100)}%）：${instance}/${db}`, (done / pairs.length) * 100);
    });
    metaIndex.data.updatedAt = Date.now();
    await metaIndex.save();
    setIndexProgress(false);
    toast(`索引${wipe ? '完全重建' : '更新'}完成：${pairs.length} 个库已是最新，可搜索全部表名`, 'success');
  } catch (e) {
    setIndexProgress(false);
    toast(`索引重建失败：${e.message}`, 'error');
  } finally {
    indexBuilding = false;
  }
}

/* 侧边栏折叠与拖宽 */
const syncSidebarToggle = () => {
  $('#sidebar-toggle small').textContent = document.body.classList.contains('sidebar-collapsed') ? '展开' : '收起';
};
$('#sidebar-toggle').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-collapsed');
  syncSidebarToggle();
});
(function () {
  const resizer = $('#sidebar-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', () => {
    dragging = true;
    document.body.style.cursor = 'col-resize';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(Math.max(e.clientX - 64, 180), 480);
    document.documentElement.style.setProperty('--sidebar-w', `${w}px`);
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
  });
})();

/* ======================= 编辑器 ======================= */
/* 实时缓存开关（默认开）：编辑器每次输入都防抖保存草稿（实例/库/SQL/标签），刷新页面不丢 */
const autoCache = { on: true, timer: null };
chrome.storage.local.get({ 'sql-autocache': true }).then((o) => {
  autoCache.on = o['sql-autocache'] !== false;
  syncAutoCacheBtn();
  $('#autosave').hidden = !autoCache.on;
});
function syncAutoCacheBtn() {
  const btn = $('#sql-autocache');
  if (!btn) return;
  btn.classList.toggle('active', autoCache.on);
  btn.title = autoCache.on ? '实时缓存已开启：输入即保存，刷新页面不丢失（点击关闭）' : '实时缓存已关闭（点击开启）';
}
$('#sql-autocache').addEventListener('click', async () => {
  autoCache.on = !autoCache.on;
  await chrome.storage.local.set({ 'sql-autocache': autoCache.on });
  syncAutoCacheBtn();
  $('#autosave').hidden = !autoCache.on;
  toast(autoCache.on ? '实时缓存已开启：SQL 输入即保存' : '实时缓存已关闭：仅执行查询时保存草稿', 'info');
  if (autoCache.on) saveDraft();
});
function scheduleAutoSave() {
  if (!autoCache.on) return;
  clearTimeout(autoCache.timer);
  autoCache.timer = setTimeout(() => saveDraft(), 800);
}

const editor = new SqlEditor($('#editor'), {
  onChange: () => {
    updateEditorHint();
    scheduleAutoSave(); // 实时缓存：输入即保存（防抖）
  },
  onRun: runQuery,
  onAltRun: () => formatSql(),
  onSuggest: suggestItems,
});

/* 当前库的表名缓存（补全用） */
let currentTables = [];
async function preloadTables() {
  const { instance, db } = state.current;
  currentTables = [];
  if (!instance || !db) return;
  try {
    const res = await state.api.tables(instance, db, state.current.schema);
    if (res.status === 0) currentTables = res.data || [];
  } catch {
    /* 静默失败，右键/树仍可用 */
  }
}

/* ======================= 对象搜索索引（本地缓存，供顶部搜索搜表名） =======================
 * 结构：{ version: 2, updatedAt, dbs: { "<instance>|<db>": { instance, db, tables: [表名...], updatedAt } } }
 * 只拉「库 + 表」两级（相当于对象树全展开的快照）；字段搜索请用侧边栏「字段」模式
 * - 查询某库时静默增量更新该库（7 天过期）
 * - 连接后自动重建 / 手动全量重建（带进度） */
const META_INDEX_KEY = 'meta-index';
const META_INDEX_TTL = 7 * 24 * 3600 * 1000;
const metaIndex = {
  data: { version: 2, updatedAt: 0, dbs: {} },
  loaded: false,
  async load() {
    if (this.loaded) return;
    try {
      const o = await chrome.storage.local.get({ [META_INDEX_KEY]: null });
      const raw = o[META_INDEX_KEY];
      if (raw?.dbs) {
        // 旧版（v1，tables 为对象含字段数组）迁移为纯表名数组
        if (raw.version !== 2) {
          for (const e of Object.values(raw.dbs)) {
            e.tables = Array.isArray(e.tables) ? e.tables : Object.keys(e.tables || {});
          }
          raw.version = 2;
          this.data = raw;
          this.save(); // 迁移结果落盘，避免每次加载重复迁移
        } else {
          this.data = raw;
        }
      }
      this.loaded = true;
    } catch { /* 隐身等场景静默降级为内存索引 */ }
  },
  async save() {
    try {
      await chrome.storage.local.set({ [META_INDEX_KEY]: this.data });
    } catch { /* 超限等场景静默：内存索引仍可用 */ }
  },
  key(instance, db) { return `${instance}|${db}`; },
  entry(instance, db) { return this.data.dbs[this.key(instance, db)]; },
};

/** 建立单个库的索引（仅表清单）；persist=false 时由调用方统一落盘 */
async function indexDb(instance, db, { persist = true } = {}) {
  const t = await state.api.tables(instance, db, '');
  if (t.status !== 0) throw new Error(t.msg || '表清单获取失败');
  const tables = (t.data || []).map(String);
  metaIndex.data.dbs[metaIndex.key(instance, db)] = { instance, db, tables, updatedAt: Date.now() };
  if (persist) await metaIndex.save();
}

/** 查询库时静默增量更新（无索引或已过期才拉，不影响现有流程） */
async function indexDbLazy(instance, db) {
  if (!instance || !db) return;
  await metaIndex.load();
  const e = metaIndex.entry(instance, db);
  if (e && Date.now() - e.updatedAt < META_INDEX_TTL) return;
  try {
    await indexDb(instance, db);
  } catch { /* 静默：索引失败不影响查询 */ }
}

/** 简易并发池：limit 路并发跑完 items */
async function poolRun(items, limit, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await worker(items[i++]).catch(() => {});
    })
  );
}

/** 索引进度条（侧边栏）：visible + 文案 + 百分比 */
let indexBuilding = false; // 索引重建进行中标记（防重复拉取）
function setIndexProgress(visible, text, pct) {
  const bar = $('#index-progress');
  if (!bar) return;
  bar.hidden = !visible;
  if (text != null) $('#index-progress-text').textContent = text;
  const fill = $('#index-progress-bar');
  if (fill) fill.style.width = pct != null ? `${Math.max(0, Math.min(100, Math.round(pct)))}%` : '0%';
}


async function suggestItems({ table, prefix }) {
  if (table) {
    table = table.replace(/`/g, '');
    let cols = [];
    try {
      cols = await getTableColumns(state.current.instance, state.current.db, table);
    } catch { /* 走兜底 */ }
    if (!cols.length) {
      // 兜底：直接查 information_schema（describe 解析失败/表名含特殊字符时）
      try {
        const esc = table.replace(/'/g, "''");
        const res = await state.api.query({
          instanceName: state.current.instance,
          dbName: state.current.db,
          sqlContent: `select column_name from information_schema.columns where table_schema='${state.current.db.replace(/'/g, "''")}' and table_name='${esc}' order by ordinal_position`,
          limitNum: 300,
        });
        if (res.status === 0) {
          cols = (res.data.rows || []).map((r) => r[0]);
          columnCache.set(`${state.current.instance}/${state.current.db}/${table}`, cols);
        }
      } catch { /* 静默 */ }
    }
    return cols.map((c) => ({ label: c, kind: 'column' }));
  }
  if (!currentTables.length) await preloadTables();
  return currentTables.map((t) => ({ label: t, kind: 'table' }));
}
const auditEditor = new SqlEditor($('#audit-editor'), {});

function updateEditorHint() {
  const sel = editor.getSelection();
  const pos = editor.ta.value.slice(0, editor.ta.selectionStart).split('\n');
  $('#editor-selection').textContent = sel ? `已选中 ${sel.length} 字符，运行时仅执行选中部分` : '选中 SQL 可单独运行';
  const cursor = $('#editor-cursor');
  if (cursor) cursor.textContent = `${pos.length}:${pos[pos.length - 1].length + 1}`;
}

/* ======================= 多 SQL 标签页 ======================= */
const queryTabs = { list: [], activeId: null, seq: 0 };

function renderQueryTabs() {
  const bar = $('#query-tabs');
  bar.replaceChildren();
  for (const t of queryTabs.list) {
    const label = t.title || `查询 ${t.id}`;
    const tab = el(`<div class="result-tab ${t.id === queryTabs.activeId ? 'active' : ''}" data-id="${t.id}">
      <span>${escapeHtml(label)}</span>
      <span class="close-x">${icon('close')}</span>
    </div>`);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.close-x')) {
        closeQueryTab(t.id);
        return;
      }
      switchQueryTab(t.id);
    });
    bar.appendChild(tab);
  }
  const addBtn = el(`<div class="result-tab" title="新建查询"><span>${icon('plus')}</span></div>`);
  addBtn.addEventListener('click', () => newQueryTab());
  bar.appendChild(addBtn);
}

function newQueryTab(sql = '') {
  // 当前内容先存回活动 tab
  if (queryTabs.activeId) {
    const cur = queryTabs.list.find((t) => t.id === queryTabs.activeId);
    if (cur) cur.sql = editor.value;
  }
  queryTabs.seq += 1;
  const tab = { id: queryTabs.seq, title: '', sql };
  queryTabs.list.push(tab);
  queryTabs.activeId = tab.id;
  editor.setValue(sql);
  renderQueryTabs();
  saveDraft();
  editor.ta.focus();
}

function switchQueryTab(id) {
  if (id === queryTabs.activeId) return;
  const cur = queryTabs.list.find((t) => t.id === queryTabs.activeId);
  if (cur) cur.sql = editor.value;
  const next = queryTabs.list.find((t) => t.id === id);
  if (!next) return;
  queryTabs.activeId = id;
  editor.setValue(next.sql);
  renderQueryTabs();
  saveDraft();
}

function closeQueryTab(id) {
  const idx = queryTabs.list.findIndex((t) => t.id === id);
  if (idx < 0) return;
  queryTabs.list.splice(idx, 1);
  if (queryTabs.activeId === id) {
    const next = queryTabs.list[idx] || queryTabs.list[idx - 1];
    if (next) {
      queryTabs.activeId = next.id;
      editor.setValue(next.sql);
    } else {
      newQueryTab();
      return;
    }
  }
  renderQueryTabs();
  saveDraft();
}

/** 以第一条语句的关键词为标签命名（仅首次） */
function refreshActiveTabTitle() {
  const t = queryTabs.list.find((x) => x.id === queryTabs.activeId);
  if (!t) return;
  const m = editor.value.trim().match(/^(\w+)/);
  const guess = m ? m[1].toUpperCase() + ' …' : '';
  if (!t.title && guess) {
    t.title = guess;
    renderQueryTabs();
  }
}

/* SQL 文件导入导出 */
$('#import-sql').addEventListener('click', () => $('#sql-file').click());
$('#sql-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  editor.setValue(await file.text(), true);
  e.target.value = '';
});
$('#download-sql').addEventListener('click', () => {
  if (!editor.value.trim()) return toast('编辑器内容为空');
  download(`query-${Date.now()}.sql`, editor.value);
});

/* ======================= SQL 格式化（tokenizer 版） ======================= */
function formatSqlText(sql) {
  // ---------- 1) tokenize（word 含中文，避免中文别名被拆开） ----------
  const tokens = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const rest = sql.slice(i);
    let m;
    if ((m = rest.match(/^--[^\n]*/)) || (m = rest.match(/^#[^\n]*/)) || (m = rest.match(/^\/\*[\s\S]*?(\*\/|$)/))) {
      tokens.push({ t: 'comment', v: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^'(?:[^'\\]|\\.|'')*'?/)) || (m = rest.match(/^"(?:[^"\\]|\\.)*"?/))) {
      tokens.push({ t: 'str', v: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^`[^`]*`?/))) {
      tokens.push({ t: 'ident', v: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_\u4e00-\u9fff$][\w\u4e00-\u9fff$]*/))) {
      tokens.push({ t: 'word', v: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^\d+(\.\d+)?/))) {
      tokens.push({ t: 'num', v: m[0] });
      i += m[0].length;
    } else if ((m = rest.match(/^\s+/))) {
      i += m[0].length;
    } else if ((m = rest.match(/^(?:>=|<=|<>|!=|:=|\|\||<<|>>|->>|->|=>|!<|!>)/))) {
      // 多字符运算符必须整体成词，否则 >= 会被拆成 > 和 = 两个 token、
      // 组装时中间加空格变成 "> ="，产生语法错误
      tokens.push({ t: 'op', v: m[0] });
      i += m[0].length;
    } else {
      tokens.push({ t: 'op', v: rest[0] });
      i += 1;
    }
  }

  // ---------- 2) 组装 ----------
  const JOIN_HEAD = new Set(['LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS']);
  const CLAUSE = new Set(['SELECT', 'FROM', 'WHERE', 'HAVING', 'LIMIT', 'OFFSET', 'VALUES', 'SET', 'ON', 'AND', 'OR', 'UNION', 'EXCEPT', 'INTERSECT', 'INSERT', 'UPDATE', 'DELETE', 'EXPLAIN']);
  const TWO_WORD = { GROUP: 'BY', ORDER: 'BY', PARTITION: 'BY', UNION: 'ALL', INSERT: 'INTO' };
  const kw = (tok) => (tok && tok.t === 'word' ? tok.v.toUpperCase() : '');

  const out = [];
  let depth = 0;
  let caseDepth = 0;
  let lineLen = 0;
  let inSelectList = false;
  let noGap = false;          // 上一个 token 是 . 或函数( → 紧跟不加空格
  const parenStack = [];      // 'f'=函数括号 'q'=子查询括号

  const newline = (extra = 0) => {
    out.push('\n' + '  '.repeat(depth + caseDepth + extra));
    lineLen = 0;
    noGap = false;
  };
  const push = (v) => {
    if (lineLen > 0 && !noGap) out.push(' ');
    out.push(v);
    lineLen += v.length;
    noGap = false;
  };
  const pushRaw = (v) => {
    out.push(v);
    lineLen += v.length;
  };

  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    const w = kw(tok);
    const prev = tokens[k - 1];
    const next = tokens[k + 1];

    if (tok.t === 'comment') {
      newline();
      pushRaw(tok.v);
      newline();
      continue;
    }

    // CASE 结构
    if (w === 'CASE') {
      push('CASE');
      caseDepth += 1;
      noGap = false;
      continue;
    }
    if (w === 'END') {
      caseDepth = Math.max(0, caseDepth - 1);
      newline();
      push('END');
      continue;
    }
    if (w === 'WHEN' || w === 'ELSE') {
      newline();
      push(w);
      continue;
    }

    // JOIN 组合
    if (JOIN_HEAD.has(w) && kw(next) === 'JOIN') {
      inSelectList = false;
      newline();
      push(w + ' JOIN');
      k += 1;
      continue;
    }
    if (JOIN_HEAD.has(w) && JOIN_HEAD.has(kw(next)) && kw(tokens[k + 2]) === 'JOIN') {
      inSelectList = false;
      newline();
      push(w + ' ' + kw(next) + ' JOIN');
      k += 2;
      continue;
    }

    // 两词子句
    if (TWO_WORD[w] && kw(next) === TWO_WORD[w]) {
      if (w === 'UNION') {
        out.push('\n\n');
        lineLen = 0;
        depth = 0;
        caseDepth = 0;
        parenStack.length = 0;
      } else {
        newline();
      }
      push(w + ' ' + TWO_WORD[w]);
      inSelectList = false;
      k += 1;
      continue;
    }

    // 单词子句
    if (CLAUSE.has(w)) {
      if (w === 'AND' || w === 'OR') {
        if (parenStack.length === 0) {
          newline();
          push(w);
        } else {
          push(w);
        }
      } else {
        inSelectList = w === 'SELECT';
        newline();
        push(w);
      }
      continue;
    }

    // 标点
    if (tok.v === '.') {
      pushRaw('.');
      noGap = true;
      continue;
    }
    if (tok.v === '(') {
      const isFunc =
        prev &&
        (prev.t === 'ident' ||
          (prev.t === 'word' && !CLAUSE.has(kw(prev)) && !JOIN_HEAD.has(kw(prev)) && !TWO_WORD[kw(prev)] && !['CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'ON', 'IN', 'NOT', 'VALUES', 'USING', 'LIKE', 'BETWEEN', 'EXISTS', 'DISTINCT', 'INTERVAL'].includes(kw(prev))));
      // 配对区间内不含 SELECT → 分组括号（如 where 里的 ((a=1) or (b=2))），行内处理不换行
      let lv = 0;
      let j = k;
      let hasSelect = false;
      for (; j < tokens.length; j++) {
        if (tokens[j].v === '(') lv += 1;
        else if (tokens[j].v === ')') {
          lv -= 1;
          if (lv === 0) break;
        } else if (kw(tokens[j]) === 'SELECT' || kw(tokens[j]) === 'UNION') hasSelect = true;
      }
      if (isFunc) {
        pushRaw('('); // count( 之间不留空格
        parenStack.push('f');
      } else if (hasSelect) {
        depth += 1;
        push('('); // 子查询 ( 与前词同行，内容换行缩进
        parenStack.push('q');
        newline();
      } else {
        push('(');
        parenStack.push('g');
      }
      noGap = true;
      continue;
    }
    if (tok.v === ')') {
      const kind = parenStack.pop();
      if (kind === 'q') {
        depth = Math.max(0, depth - 1);
        newline();
        pushRaw(')');
      } else {
        pushRaw(')'); // 函数/分组右括号：与前文紧贴，不加空格
      }
      noGap = false;
      continue;
    }
    if (tok.v === ',') {
      pushRaw(',');
      if (inSelectList && depth === 0 && caseDepth === 0) newline(1);
      else {
        pushRaw(' ');
        noGap = true;
      }
      continue;
    }
    if (tok.v === ';') {
      const flat = out.join('');
      if (/;\s*$/.test(flat)) continue;
      pushRaw(';');
      out.push('\n\n');
      lineLen = 0;
      depth = 0;
      caseDepth = 0;
      inSelectList = false;
      parenStack.length = 0;
      noGap = false;
      continue;
    }

    push(tok.v);
  }

  let text = out
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\(\s*\n\s*\)/g, '()')
    .trim();
  text = text.replace(/;+$/, '').trim();
  return text ? text + ';' : '';
}
function formatSql() {
  const sel = editor.getSelection();
  if (sel) editor.insertText(formatSqlText(sel));
  else editor.setValue(formatSqlText(editor.value), true);
  toast('已格式化', 'success');
}
$('#format').addEventListener('click', formatSql);

/* ======================= 查询执行 ======================= */
/* ============ 分批流式查询 ============
 * 大 limit（>5000 或不限）时按 5000/批 分页请求，逐批追加渲染，
 * 批间留缓冲避免打挂服务端；导出使用已拉全的内存数据，天然分批安全。
 */
const BATCH_SIZE = 5000;
const MAX_BATCH_ROWS = 100000; // 10 万行安全上限
const PAGEABLE_DB = new Set(['mysql', 'tidb', 'clickhouse', 'starrocks', 'pgsql']);
let stopBatchFlag = false;

function wrapPagedSql(sql, offset) {
  const inner = sql.trim().replace(/;+\s*$/, '');
  return `select * from (${inner}) as _archery_page limit ${BATCH_SIZE} offset ${offset}`;
}

/** 把查询结果追加到已有 result（增量刷新当前视图） */
function appendBatch(result, d) {
  result.rows.push(...(d.rows || []));
  result.queryTime = d.query_time ?? result.queryTime;
  const r = activeResultData();
  if (r === result) renderResultTable(result);
  renderResultTabs();
}

async function runQuery() {
  const instance = $('#instance-name').value;
  const db = $('#db-name').value;
  const schema = $('#schema-name').value;
  // 云端收藏回填的 SQL 带同步标记，执行前移除，不让标记出现在查询日志里
  const sql = stripSyncMarks(editor.getSelection() || editor.value);
  if (!instance) return toast('请先选择实例', 'error');
  if (!db) return toast('请先选择数据库', 'error');
  if (!sql.trim()) return toast('请输入 SQL 语句', 'error');

  const limitNum = Number($('#limit-num').value);
  const ins = state.instances.find((i) => i.instance_name === instance);
  const dbType = ins?.db_type || 'mysql';
  // 支持子查询分页的库、且 limit 超过单批阈值或选择不限时，走分批
  const useBatch = PAGEABLE_DB.has(dbType) && (limitNum === 0 || limitNum > BATCH_SIZE);

  const btn = $('#execute');
  const cancelBtn = $('#cancel-query');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span>查询中…</span>';
  const started = performance.now();
  stopBatchFlag = false;
  cancelBtn.hidden = !useBatch;
  try {
    if (!useBatch) {
      const res = await state.api.query({
        instanceName: instance, dbName: db, schemaName: schema,
        sqlContent: sql, limitNum: $('#limit-num').value,
      });
      if (res.status !== 0) {
        pushResult({ kind: 'error', title: '错误', sql, target: `${instance}/${db}`, error: res.msg });
        toast(res.msg, 'error');
        return;
      }
      const d = res.data;
      refreshActiveTabTitle();
      pushResult({
        kind: 'query', title: '结果', sql: d.full_sql || sql, target: `${instance}/${db}`,
        columns: d.column_list || [], columnTypes: d.column_type || [], rows: d.rows || [],
        affected: d.affected_rows ?? d.effect_row, queryTime: d.query_time,
        maskTime: d.mask_time, lag: d.seconds_behind_master, warning: d.warning,
      });
      saveDraft();
      return;
    }

    // ---- 分批模式 ----
    let offset = 0;
    let batch = 0;
    let result = null;
    let firstD = null;
    while (true) {
      if (stopBatchFlag) {
        toast(`已停止：共加载 ${result?.rows.length ?? 0} 行`, 'info');
        break;
      }
      if (offset >= MAX_BATCH_ROWS) {
        toast(`已达安全上限 ${MAX_BATCH_ROWS} 行，如需更多请缩小查询范围`, 'error');
        break;
      }
      const res = await state.api.query({
        instanceName: instance, dbName: db, schemaName: schema,
        sqlContent: wrapPagedSql(sql, offset), limitNum: BATCH_SIZE,
      });
      if (res.status !== 0) {
        if (!result) {
          pushResult({ kind: 'error', title: '错误', sql, target: `${instance}/${db}`, error: res.msg });
        }
        toast(res.msg, 'error');
        break;
      }
      const d = res.data;
      batch += 1;
      if (!result) {
        firstD = d;
        refreshActiveTabTitle();
        result = pushResult({
          kind: 'query', title: '结果', sql: sql, target: `${instance}/${db}`,
          columns: d.column_list || [], columnTypes: d.column_type || [], rows: d.rows || [],
          affected: d.affected_rows, queryTime: d.query_time, maskTime: d.mask_time,
          lag: d.seconds_behind_master, warning: d.warning, batched: true,
          filter: '', sortKey: -1, sortDir: 1, page: 1, pageSize: 100,
        });
      } else {
        appendBatch(result, d);
      }
      const rows = d.rows || [];
      $('#result-summary').textContent =
        `分批加载中 · 已 ${result.rows.length} 行（第 ${batch} 批 ×${BATCH_SIZE}）· ${timestamp()}`;
      if (rows.length < BATCH_SIZE) break; // 没有更多数据
      offset += BATCH_SIZE;
      await new Promise((r) => setTimeout(r, 250)); // 批间缓冲
    }
    if (result) {
      result.batchInfo = `分批 ${batch} 次 × ${BATCH_SIZE}`;
      renderResultTabs();
      const r = activeResultData();
      if (r === result) renderResultTable(result);
      saveDraft();
    }
  } catch (e) {
    pushResult({ kind: 'error', title: '错误', sql, target: `${instance}/${db}`, error: e.message });
    toast(e.message, 'error');
    if (e.needLogin) setConnection(false, '需要重新登录');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('play')}<span>运行查询</span>`;
    mountIcons(btn);
    cancelBtn.hidden = true;
    $('#query-timing').textContent = `耗时 ${((performance.now() - started) / 1000).toFixed(2)} s`;
  }
}
$('#execute').addEventListener('click', runQuery);
$('#cancel-query').addEventListener('click', () => {
  stopBatchFlag = true;
});

/** EXPLAIN：按实例类型给 SQL 加前缀后执行（对应 Archery 查询页行为） */
async function runExplain() {
  const instance = $('#instance-name').value;
  const ins = state.instances.find((i) => i.instance_name === instance);
  const sql = stripSyncMarks(editor.getSelection() || editor.value);
  if (!instance || !$('#db-name').value) return toast('请先选择实例和数据库', 'error');
  if (!sql.trim()) return toast('请输入 SQL 语句', 'error');
  const type = ins?.db_type || 'mysql';
  let explainSql;
  if (['mysql', 'tidb', 'clickhouse', 'mongo'].includes(type)) {
    explainSql = `explain ${sql}`;
  } else if (type === 'oracle') {
    explainSql = `explain plan for ${sql}`;
  } else {
    return toast(`${DB_TYPE_LABEL[type] || type} 暂不支持在线查看执行计划`, 'error');
  }
  const btn = $('#explain');
  btn.disabled = true;
  try {
    const res = await state.api.query({
      instanceName: instance,
      dbName: $('#db-name').value,
      schemaName: $('#schema-name').value,
      sqlContent: explainSql,
      limitNum: $('#limit-num').value,
    });
    if (res.status !== 0) {
      pushResult({ kind: 'error', title: '错误', sql: explainSql, target: `${instance}/${$('#db-name').value}`, error: res.msg });
      return toast(res.msg, 'error');
    }
    pushResult({
      kind: 'query',
      title: '执行计划',
      isExplain: true,
      sql: res.data.full_sql || explainSql,
      target: `${instance}/${$('#db-name').value}`,
      columns: res.data.column_list || [],
      columnTypes: res.data.column_type || [],
      rows: res.data.rows || [],
      affected: res.data.affected_rows,
      queryTime: res.data.query_time,
    });
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('#explain').addEventListener('click', runExplain);

/* 结果区放大 / 还原 */
$('#expand-results').addEventListener('click', () => {
  document.body.classList.toggle('results-expanded');
});
/* 结构查看自动收起编辑器后，点击 SQL 标签栏即可回到编辑器 */
$('.query-tabbar-top').addEventListener('click', (e) => {
  if (document.body.classList.contains('results-expanded') && !e.target.closest('.result-tab')) {
    document.body.classList.remove('results-expanded');
    editor.ta.focus();
  }
});

/* ======================= 结果 tab 管理 ======================= */
function pushResult(data) {
  state.resultSeq += 1;
  const result = {
    id: state.resultSeq,
    ...data,
    filter: '',
    sortKey: -1,
    sortDir: 1,
    page: 1,
    pageSize: 100,
  };
  state.results.push(result);
  state.activeResult = result.id;
  renderResultTabs();
  renderActiveResult();
  return result;
}

function renderResultTabs() {
  const bar = $('#result-tabs');
  bar.replaceChildren();
  for (const r of state.results) {
    const label =
      r.kind === 'error' ? '错误' : r.kind === 'describe' ? r.title : `结果 ${r.id}`;
    const badge = r.kind === 'query' ? `<span class="badge">${r.rows?.length ?? 0}</span>` : '';
    const tab = el(`<div class="result-tab ${r.id === state.activeResult ? 'active' : ''} ${r.kind === 'error' ? 'is-error' : ''}"
      data-id="${r.id}" title="${escapeHtml(r.target || '')} · ${escapeHtml(r.sql || '').slice(0, 120)}">
      <span>${escapeHtml(label)}</span>${badge}
      <span class="close-x">${icon('close')}</span>
    </div>`);
    tab.addEventListener('click', (e) => {
      if (e.target.closest('.close-x')) {
        state.results = state.results.filter((x) => x.id !== r.id);
        if (state.activeResult === r.id) {
          state.activeResult = state.results.at(-1)?.id ?? null;
        }
        renderResultTabs();
        renderActiveResult();
        return;
      }
      state.activeResult = r.id;
      renderResultTabs();
      renderActiveResult();
    });
    bar.appendChild(tab);
  }
}
$('#clear-results').addEventListener('click', () => {
  state.results = [];
  state.activeResult = null;
  renderResultTabs();
  renderActiveResult();
});

function activeResultData() {
  return state.results.find((r) => r.id === state.activeResult) || null;
}

function renderActiveResult() {
  const r = activeResultData();
  const content = $('#result-content');
  const tools = $('#result-tools');
  const footer = $('#result-footer');
  if (!r) {
    tools.hidden = true;
    syncChartMode(false);
    $('#pagination').hidden = true;
    document.body.classList.remove('results-expanded');
    $('#result-summary').textContent = '准备就绪';
    content.replaceChildren(
      el(`<div class="result-placeholder">${icon('grid')}<span>执行查询后，结果会保留在这里，可切换回看与导出</span></div>`)
    );
    return;
  }
  if (r.kind === 'error') {
    tools.hidden = true;
    syncChartMode(false);
    $('#pagination').hidden = true;
    document.body.classList.remove('results-expanded');
    $('#result-summary').textContent = `${r.target || ''} · ${timestamp()}`;
    content.replaceChildren(
      el(`<div class="banner" style="margin:10px">${icon('alert')}<span>${escapeHtml(r.error)}</span></div>`)
    );
    return;
  }
  if (r.kind === 'describe') {
    tools.hidden = true;
    syncChartMode(false);
    $('#pagination').hidden = true;
    $('#result-summary').textContent = `${r.target} · ${timestamp()}`;
    renderDescribeView(r);
    return;
  }
  // 查询/错误结果恢复编辑器布局（用户手动放大的可再点放大按钮）
  document.body.classList.remove('results-expanded');

  // 普通查询结果
  tools.hidden = false;
  updateExportButtons();
  if (r.chartOpen) renderChart(r);
  else renderResultTable(r);
}

/** EXPLAIN 执行计划单元格着色：全表扫描红、走索引绿、大扫描量橙 */
function explainCellClass(colName, val) {
  if (val === null || val === undefined || val === '') return '';
  const v = String(val).toLowerCase();
  switch (colName) {
    case 'type':
      if (v === 'all') return 'ex-bad';
      if (v === 'index') return 'ex-warn';
      if (['range', 'index_merge', 'ref_or_null'].includes(v)) return 'ex-mid';
      if (['ref', 'eq_ref', 'const', 'system', 'null', 'fulltext', 'unique_subquery', 'index_subquery'].includes(v)) return 'ex-good';
      return '';
    case 'key':
      return val ? 'ex-good' : '';
    case 'rows': {
      const n = Number(val);
      if (isNaN(n)) return '';
      if (n >= 100000) return 'ex-bad';
      if (n >= 10000) return 'ex-warn';
      return '';
    }
    case 'extra':
      if (/filesort|temporary/.test(v)) return 'ex-bad';
      if (/using index( condition)?$/i.test(v)) return 'ex-good';
      if (/using join buffer/.test(v)) return 'ex-mid';
      return '';
    default:
      return '';
  }
}

function renderResultTable(r) {
  const { columns, rows } = r;
  const content = $('#result-content');
  syncChartMode(false);
  const lowerCols = columns.map((c) => String(c).toLowerCase());
  const explainMode = !!r.isExplain || (lowerCols.includes('type') && (lowerCols.includes('extra') || lowerCols.includes('key')));

  // 排序（前端全量）
  let data = rows;
  if (r.filter) {
    const f = r.filter.toLowerCase();
    data = data.map((row) => [row, row.some((c) => String(c ?? '').toLowerCase().includes(f))])
      .filter((x) => x[1])
      .map((x) => x[0]);
  }
  if (r.sortKey >= 0) {
    const k = r.sortKey;
    data = [...data].sort((a, b) => {
      const x = a[k], y = b[k];
      if (x === null) return 1;
      if (y === null) return -1;
      const nx = Number(x), ny = Number(y);
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * r.sortDir;
      return String(x).localeCompare(String(y), 'zh-CN') * r.sortDir;
    });
  }

  const total = data.length;
  const pages = Math.max(1, Math.ceil(total / r.pageSize));
  if (r.page > pages) r.page = pages;
  const pageData = data.slice((r.page - 1) * r.pageSize, r.page * r.pageSize);

  const table = document.createElement('table');
  table.className = 'result-table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  columns.forEach((col, idx) => {
    const th = document.createElement('th');
    const arrow = r.sortKey === idx ? `<span class="arrow">${r.sortDir > 0 ? '▲' : '▼'}</span>` : '';
    th.innerHTML = `${escapeHtml(col)}${arrow}`;
    th.title = r.columnTypes?.[idx] ? `类型：${r.columnTypes[idx]}` : col;
    th.addEventListener('click', () => {
      if (r.sortKey === idx) r.sortDir = -r.sortDir;
      else {
        r.sortKey = idx;
        r.sortDir = 1;
      }
      renderResultTable(r);
    });
    bindResultContextMenu(th, r, { colIndex: idx });
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const row of pageData) {
    const tr = document.createElement('tr');
    bindResultContextMenu(tr, r, { row });
    row.forEach((cell, ci) => {
      const td = document.createElement('td');
      if (cell === null || cell === undefined) {
        td.textContent = 'NULL';
        td.className = 'null';
      } else {
        td.textContent = String(cell);
        if (String(cell).length > 120) {
          td.classList.add('full');
          td.title = String(cell);
        }
      }
      const ex = explainMode ? explainCellClass(lowerCols[ci], cell) : '';
      if (ex) td.classList.add(ex);
      td.addEventListener('dblclick', () => {
        navigator.clipboard.writeText(cell === null ? 'NULL' : String(cell));
        toast('已复制单元格内容', 'success');
      });
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.replaceChildren(table);

  $('#pagination').hidden = false;
  $('#page-size').value = String(r.pageSize);
  $('#page-info').textContent = `${r.page} / ${pages}`;
  $('#prev-page').disabled = r.page <= 1;
  $('#next-page').disabled = r.page >= pages;

  const extra = [];
  if (r.batchInfo) extra.push(r.batchInfo);
  if (r.queryTime) extra.push(`查询 ${r.queryTime}s`);
  if (r.maskTime) extra.push(`脱敏 ${r.maskTime}s`);
  if (r.lag) extra.push(`主从延迟 ${r.lag}s`);
  $('#result-summary').textContent =
    `${r.target} · ${total} 行${extra.length ? ' · ' + extra.join(' · ') : ''} · ${timestamp()}`;
}

$('#page-size').addEventListener('change', (e) => {
  const r = activeResultData();
  if (!r) return;
  r.pageSize = Number(e.target.value);
  r.page = 1;
  renderResultTable(r);
});
$('#prev-page').addEventListener('click', () => {
  const r = activeResultData();
  if (!r) return;
  r.page -= 1;
  renderResultTable(r);
});
$('#next-page').addEventListener('click', () => {
  const r = activeResultData();
  if (!r) return;
  r.page += 1;
  renderResultTable(r);
});
$('#result-filter').addEventListener('input', (e) => {
  const r = activeResultData();
  if (!r) return;
  r.filter = e.target.value;
  r.page = 1;
  renderResultTable(r);
});

/* ======================= 导出（隐藏开关） =======================
 * 连点顶部头像 5 次启用导出（一次），导出完成自动隐藏。 */
let exportUnlocked = false;
let avatarClicks = 0;
let avatarClickTimer = null;
// 解锁次数每次进入页面随机（5-15），不固定规律
const EXPORT_UNLOCK_TARGET = 5 + Math.floor(Math.random() * 11);
$('#avatar').addEventListener('click', () => {
  avatarClicks += 1;
  clearTimeout(avatarClickTimer);
  avatarClickTimer = setTimeout(() => (avatarClicks = 0), 5000);
  if (avatarClicks >= EXPORT_UNLOCK_TARGET) {
    avatarClicks = 0;
    exportUnlocked = true;
    updateExportButtons();
    toast('导出已启用（本次有效）', 'success');
  }
});
function updateExportButtons() {
  const r = activeResultData();
  const show = exportUnlocked && r?.kind === 'query' && !!r.rows?.length;
  for (const id of ['export-csv', 'export-excel', 'export-json']) {
    $('#' + id).hidden = !show;
  }
}

/* ======================= 导出 ======================= */
/** Excel 2003 SpreadsheetML（.xls，Excel 原生支持多 Worksheet）：数据 sheet + 导出信息 sheet */
function buildXlsXml(columns, rows, meta) {
  const esc = (v) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/\n/g, '&#10;');
  const cellXml = (v) => {
    if (v === null || v === undefined || v === '') return '<Cell/>';
    if (typeof v === 'number' && isFinite(v)) return `<Cell><Data ss:Type="Number">${v}</Data></Cell>`;
    return `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  };
  const headCell = (v) => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(v)}</Data></Cell>`;
  const sheet = (name, trs) => `<Worksheet ss:Name="${esc(name)}"><Table>${trs}</Table></Worksheet>`;
  const dataRows =
    `<Row>${columns.map(headCell).join('')}</Row>` +
    rows.map((row) => `<Row>${row.map(cellXml).join('')}</Row>`).join('');
  const infoRows = meta.map(([k, v]) => `<Row>${headCell(k)}${cellXml(v)}</Row>`).join('');
  return (
    `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n` +
    ` <Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>\n` +
    sheet('查询结果', dataRows) +
    '\n' +
    sheet('导出信息', infoRows) +
    '\n</Workbook>'
  );
}

function exportActive(type) {
  const r = activeResultData();
  if (!r || r.kind !== 'query' || !r.rows?.length) return toast('当前没有可导出的查询结果', 'error');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `archery-${r.target.replace(/[\\/:*?"<>|]/g, '_')}-${stamp}`;
  let data = r.rows;
  if (r.filter) {
    const f = r.filter.toLowerCase();
    data = data.filter((row) => row.some((c) => String(c ?? '').toLowerCase().includes(f)));
  }
  if (r.sortKey >= 0) {
    const k = r.sortKey;
    data = [...data].sort((a, b) => {
      const x = a[k], y = b[k];
      const nx = Number(x), ny = Number(y);
      if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * r.sortDir;
      return String(x).localeCompare(String(y), 'zh-CN') * r.sortDir;
    });
  }
  if (type === 'csv') {
    const esc = (v) => (v === null || v === undefined ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [r.columns.map(esc).join(','), ...data.map((row) => row.map(esc).join(','))].join('\r\n');
    download(`${name}.csv`, '\uFEFF' + csv, 'text/csv');
  } else if (type === 'json') {
    const objs = data.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
    download(`${name}.json`, JSON.stringify(objs, null, 2), 'application/json');
  } else if (type === 'excel') {
    const meta = [
      ['SQL', r.sql || ''],
      ['实例 / 库', r.target || ''],
      ['导出行数', data.length],
      ['结果总行数', r.rows.length],
      ['列数', r.columns.length],
      ['查询耗时', r.queryTime ? `${r.queryTime}s` : '—'],
      ['导出时间', new Date().toLocaleString('zh-CN')],
      ['导出自', `Archery 助手 v${chrome.runtime.getManifest().version}`],
    ];
    download(`${name}.xls`, buildXlsXml(r.columns, data, meta), 'application/vnd.ms-excel');
  }
  toast(`已导出 ${data.length} 行`, 'success');
  exportUnlocked = false;
  updateExportButtons();
}
$('#export-csv').addEventListener('click', () => exportActive('csv'));
$('#export-excel').addEventListener('click', () => exportActive('excel'));
$('#export-json').addEventListener('click', () => exportActive('json'));

/* ======================= 结果表格右键菜单 ======================= */
function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/** 解析建表语句中的主键列 */
const pkCache = new Map();
async function getTablePk(instanceName, dbName, tableName) {
  const key = `${instanceName}/${dbName}/${tableName}`;
  if (pkCache.has(key)) return pkCache.get(key);
  let pk = [];
  try {
    const res = await state.api.describe(instanceName, dbName, tableName);
    const createSql = res.data?.rows?.[0]?.[1] || '';
    const m = createSql.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
    if (m) pk = [...m[1].matchAll(/`(\w+)`/g)].map((x) => x[1]);
  } catch { /* 忽略，退化用全部列做 WHERE */ }
  pkCache.set(key, pk);
  return pk;
}

/** 结果单元格/列头/行的右键菜单 */
function bindResultContextMenu(el2, r, { colIndex = null, row = null } = {}) {
  el2.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation(); // 阻止 document 级关闭逻辑误杀本菜单
    const items = [];
    // 行内右键时动态识别所在列
    const ci = colIndex !== null ? colIndex : e.target.closest('td')?.cellIndex ?? null;
    const useCol = ci !== null && ci < r.columns.length;
    const colIndexFinal = useCol ? ci : null;
    if (useCol) {
      const colIndex = colIndexFinal;
      const col = r.columns[colIndex];
      const vals = r.rows.map((row) => row[colIndex]);
      items.push({
        label: '导出结果为 INSERT 语句',
        icon: 'download',
        action: () => exportInserts(r),
      });
      items.push({
        label: `复制「${col}」为 IN 列表`,
        icon: 'copy',
        action: () => {
          const numeric = vals.every((v) => v === null || typeof v === 'number');
          const list = vals.map((v) => (numeric ? (v ?? 'NULL') : sqlValue(v)));
          const lines = [];
          for (let i = 0; i < list.length; i += 4) lines.push('  ' + list.slice(i, i + 4).join(', '));
          navigator.clipboard.writeText(`in (\n${lines.join(',\n')}\n)`);
          toast(`已复制 ${vals.length} 个值为 IN 列表`, 'success');
        },
      });
      items.push({
        label: `复制「${col}」整列（换行分隔）`,
        icon: 'copy',
        action: () => {
          navigator.clipboard.writeText(vals.map((v) => (v === null ? '' : String(v))).join('\n'));
          toast('已复制整列', 'success');
        },
      });
    }
    if (row !== null) {
      items.push({
        label: '生成 INSERT 语句',
        icon: 'code',
        action: () => genRowSql(r, row, 'insert'),
      });
      items.push({
        label: '生成 UPDATE 语句',
        icon: 'code',
        action: () => genRowSql(r, row, 'update'),
      });
      items.push({
        label: '复制整行（Tab 分隔）',
        icon: 'copy',
        action: () => {
          navigator.clipboard.writeText(row.map((v) => (v === null ? 'NULL' : String(v))).join('	'));
          toast('已复制整行', 'success');
        },
      });
      // JSON 格式化：对象值直接展开，字符串值尝试解析
      let cell = useCol ? row[colIndexFinal] : row.find((v) => typeof v === 'string' && /^[{[]/.test(v));
      let parsed = null;
      if (cell !== null && cell !== undefined && typeof cell === 'object') {
        parsed = cell;
      } else if (typeof cell === 'string' && /^[{[]/.test(cell)) {
        try {
          parsed = JSON.parse(cell);
        } catch { /* 非 JSON 忽略 */ }
      }
      if (parsed && typeof parsed === 'object') {
        items.push({
          label: '格式化 JSON',
          icon: 'eye',
          action: () => {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(parsed, null, 2);
            openModal('JSON 查看器', pre);
          },
        });
      }
    }
    if (items.length) showContextMenu(e.clientX, e.clientY, items);
  });
}

/** 行 → INSERT/UPDATE 语句（弹窗选表 + 预览） */
async function genRowSql(r, row, kind) {
  const targetDb = r.target.split('/')[1];
  const instanceName = r.target.split('/')[0];
  if (!currentTables.length) await preloadTables();
  if (!currentTables.length) return toast('当前库表列表未加载，无法选择表', 'error');

  const body = document.createElement('div');
  body.innerHTML = `
    <label class="setting-row"><span>目标表（${escapeHtml(instanceName)}/${escapeHtml(targetDb)}）</span>
      <select id="gensql-table" class="select" style="width:100%">
        ${currentTables.map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('')}
      </select></label>
    <div class="setting-actions">
      <button class="button small" id="gensql-cancel">取消</button>
      <button class="button small primary" id="gensql-gen">生成</button>
    </div>
    <pre id="gensql-preview" hidden></pre>
    <div class="setting-actions" id="gensql-copy-row" hidden>
      <button class="button small primary" id="gensql-copy">复制并插入编辑器</button>
    </div>`;
  openModal(kind === 'insert' ? '生成 INSERT' : '生成 UPDATE', body);

  body.querySelector('#gensql-cancel').addEventListener('click', closeModal);
  body.querySelector('#gensql-gen').addEventListener('click', async () => {
    const table = body.querySelector('#gensql-table').value;
    const cols = await getTableColumns(instanceName, targetDb, table);
    // 结果列与表字段取交集（保序按表字段）
    const pairs = cols
      .map((c) => {
        const idx = r.columns.indexOf(c);
        return idx >= 0 ? { c, v: row[idx] } : null;
      })
      .filter(Boolean);
    if (!pairs.length) {
      toast('结果列与表字段无交集，无法生成', 'error');
      return;
    }
    let sqlText;
    if (kind === 'insert') {
      sqlText = `INSERT INTO \`${table}\` (${pairs.map((p) => '\`' + p.c + '\`').join(', ')})
VALUES (${pairs.map((p) => sqlValue(p.v)).join(', ')});`;
    } else {
      const pk = await getTablePk(instanceName, targetDb, table);
      const whereCols = pk.filter((c) => pairs.some((p) => p.c === c));
      const useCols = whereCols.length ? whereCols : pairs.map((p) => p.c);
      const setPart = pairs.filter((p) => !useCols.includes(p.c));
      const setSql = (setPart.length ? setPart : pairs).map((p) => `\`${p.c}\` = ${sqlValue(p.v)}`).join(',\n  ');
      const whereSql = useCols.map((c) => {
        const p = pairs.find((x) => x.c === c);
        return `\`${c}\` = ${sqlValue(p.v)}`;
      }).join('\n  AND ');
      sqlText = `UPDATE \`${table}\`\nSET ${setSql}\nWHERE ${whereSql};`;
    }
    const pre = body.querySelector('#gensql-preview');
    pre.hidden = false;
    pre.textContent = sqlText;
    const actions = body.querySelector('#gensql-copy-row');
    actions.hidden = false;
    actions.querySelector('#gensql-copy').onclick = () => {
      editor.insertText(sqlText + '\n');
      closeModal();
      toast('已插入编辑器，请核对后走工单执行', 'success');
    };
  });
}

/* ======================= 表结构查看 ======================= */

/* ======================= 侧边栏：对象 / 字段 双模式 ======================= */
$('#mode-object').addEventListener('click', () => setSidebarMode('object'));
$('#mode-column').addEventListener('click', () => setSidebarMode('column'));
function setSidebarMode(mode) {
  const isCol = mode === 'column';
  $('#mode-object').classList.toggle('active', !isCol);
  $('#mode-column').classList.toggle('active', isCol);
  $('#object-search-wrap').hidden = isCol;
  $('#column-search-wrap').hidden = !isCol;
  $('#column-results').hidden = !isCol;
  $('#object-tree').style.display = isCol ? 'none' : '';
  $('.object-heading').style.display = isCol ? 'none' : '';
  if (isCol) $('#column-search').focus();
}

let columnSearchTimer = null;
$('#column-search').addEventListener('input', (e) => {
  clearTimeout(columnSearchTimer);
  const kw = e.target.value.trim();
  if (!kw) {
    $('#column-results').replaceChildren();
    return;
  }
  columnSearchTimer = setTimeout(() => searchColumns(kw), 350);
});

async function searchColumns(kw) {
  const { instance, db } = state.current;
  if (!instance || !db) {
    $('#column-results').replaceChildren(
      el(`<div class="tree-empty">请先在查询栏选择实例和数据库</div>`)
    );
    return;
  }
  const ins = state.instances.find((i) => i.instance_name === instance);
  if (!['mysql', 'tidb'].includes(ins?.db_type || '')) {
    $('#column-results').replaceChildren(
      el(`<div class="tree-empty">字段搜索目前支持 MySQL / TiDB</div>`)
    );
    return;
  }
  $('#column-results').replaceChildren(el(`<div class="tree-empty">搜索中…</div>`));
  try {
    const sql =
      `select table_name, column_name, column_type, column_comment ` +
      `from information_schema.columns ` +
      `where table_schema='${db.replace(/'/g, "''")}' and column_name like '%${kw.replace(/'/g, "''")}%' ` +
      `order by table_name, ordinal_position limit 200`;
    const res = await state.api.query({ instanceName: instance, dbName: db, sqlContent: sql, limitNum: 200 });
    if (res.status !== 0) throw new Error(res.msg);
    const rows = res.data.rows || [];
    const box = $('#column-results');
    box.replaceChildren();
    if (!rows.length) {
      box.replaceChildren(el(`<div class="tree-empty">没有匹配的字段</div>`));
      return;
    }
    for (const [tbl, colName, colType, comment] of rows) {
      const item = el(`<div class="column-result-item" title="点击查看建表语句">
        <div class="tbl">${escapeHtml(tbl)}</div>
        <div class="col">${escapeHtml(colName)} <span style="color:var(--text-3)">${escapeHtml(colType || '')}</span></div>
        <div class="meta">${escapeHtml(comment || '')}</div>
      </div>`);
      item.addEventListener('click', () => describeTable({ name: instance, instance_name: instance }, db, tbl));
      box.appendChild(item);
    }
    const head = el(`<div class="tree-empty" style="padding:6px">共 ${rows.length} 个匹配字段${rows.length >= 200 ? '（达上限）' : ''}</div>`);
    box.prepend(head);
  } catch (e2) {
    $('#column-results').replaceChildren(el(`<div class="tree-empty">${escapeHtml(e2.message)}</div>`));
  }
}

/* ======================= 结果图表可视化 ======================= */
const CHART_COLORS = ['#2dd4bf', '#6ea8fe', '#f16b5e', '#e5a835', '#b78af7', '#4ade80', '#f472b6', '#94a3b8'];

/** 图表数值解析：number 直取，字符串数字（含千分位）解析，其余（含 NULL/日期/文本）返回 null */
function chartToNum(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[,，\s]/g, '');
  return /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(s) && isFinite(Number(s)) ? Number(s) : null;
}

function openChart(r) {
  r.chart = r.chart || { x: 0, ys: [], type: 'bar' };
  if (!r.chart.ys.length) {
    const head = r.rows.slice(0, 50);
    r.chart.ys = r.columns
      .map((c, i) => ({ c, i }))
      // 数值列：样本里至少有一个可解析数值，且没有既非数值也非 NULL 的脏值
      .filter(({ i }) => head.some((row) => chartToNum(row[i]) !== null) && head.every((row) => chartToNum(row[i]) !== null))
      .slice(0, 3)
      .map(({ i }) => i);
    // X 轴默认取第一个非数值列（没有则保持第 0 列）
    const firstCat = r.columns.findIndex((c, i) => !r.chart.ys.includes(i));
    if (firstCat >= 0) r.chart.x = firstCat;
  }
  renderChart(r);
}

function renderChart(r) {
  const content = $('#result-content');
  const panel = document.createElement('div');
  panel.className = 'chart-panel';

  const xOpts = r.columns
    .map((c, i) => `<option value="${i}" ${i === r.chart.x ? 'selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');
  const yOpts = r.columns
    .map((c, i) => `<option value="${i}" ${r.chart.ys.includes(i) ? 'selected' : ''}>${escapeHtml(c)}</option>`)
    .join('');
  panel.innerHTML = `
    <div class="chart-controls">
      <label class="bar-field"><span>X 轴</span><select id="chart-x" class="select">${xOpts}</select></label>
      <label class="bar-field"><span>Y 轴（可多选数值列）</span><select id="chart-y" class="select" multiple style="height:64px;min-width:150px">${yOpts}</select></label>
      <label class="bar-field"><span>类型</span>
        <select id="chart-type" class="select">
          <option value="bar" ${r.chart.type === 'bar' ? 'selected' : ''}>柱状图</option>
          <option value="line" ${r.chart.type === 'line' ? 'selected' : ''}>折线图</option>
        </select></label>
    </div>
    <div class="chart-legend" id="chart-legend"></div>
    <div class="chart-svg-wrap"><svg class="chart-svg" id="chart-svg" width="900" height="420"></svg></div>`;
  content.replaceChildren(panel);

  panel.querySelector('#chart-x').addEventListener('change', (e) => {
    r.chart.x = Number(e.target.value);
    renderChart(r);
  });
  panel.querySelector('#chart-y').addEventListener('change', (e) => {
    r.chart.ys = [...e.target.selectedOptions].map((o) => Number(o.value));
    renderChart(r);
  });
  panel.querySelector('#chart-type').addEventListener('change', (e) => {
    r.chart.type = e.target.value;
    renderChart(r);
  });

  drawChart(r, panel.querySelector('#chart-svg'), panel.querySelector('#chart-legend'));
  r.chartOpen = true;
  syncChartMode(true);
}

function closeChart(r) {
  if (!r) return;
  delete r.chartOpen;
  syncChartMode(false);
  renderResultTable(r);
}

function syncChartMode(open) {
  const back = $('#chart-back');
  const toggle = $('#chart-toggle');
  if (back) back.hidden = !open;
  if (toggle) toggle.hidden = !!open;
}

function drawChart(r, svg, legend) {
  const xs = r.rows.map((row) => String(row[r.chart.x] ?? ''));
  const series = r.chart.ys
    .map((i) => ({ i, name: r.columns[i], data: r.rows.map((row) => chartToNum(row[i])) }))
    .filter((s) => s.name !== undefined);
  let idxs = xs.map((_, i) => i);
  if (idxs.length > 80) {
    const step = Math.ceil(idxs.length / 80);
    idxs = idxs.filter((_, i) => i % step === 0);
  }
  const labels = idxs.map((i) => xs[i]);
  const sData = series.map((s) => idxs.map((i) => s.data[i]));

  const W = Math.max(900, labels.length * 46);
  const H = 420;
  const padL = 56, padR = 16, padT = 18, padB = 46;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const bandW = plotW / Math.max(1, labels.length);
  // 空值（NULL/文本）不参与刻度计算
  const maxV = Math.max(1, ...sData.flat().filter((v) => v !== null));
  const yScale = (v) => padT + plotH - (v / maxV) * plotH;

  let out = `<g>`;
  for (let t = 0; t <= 4; t++) {
    const v = (maxV / 4) * t;
    const y = yScale(v);
    out += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="currentColor" opacity="0.15" stroke-width="1"/>`;
    out += `<text x="${padL - 8}" y="${y + 4}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.55">${formatTick(v)}</text>`;
  }
  labels.forEach((lb, i) => {
    const cx = padL + bandW * i + bandW / 2;
    out += `<text x="${cx}" y="${H - 24}" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.55">${escapeHtml(lb.length > 10 ? lb.slice(0, 10) + '…' : lb)}</text>`;
  });
  series.forEach((s, si) => {
    const color = CHART_COLORS[si % CHART_COLORS.length];
    if (r.chart.type === 'bar') {
      const barW = Math.max(3, (bandW * 0.7) / Math.max(1, series.length));
      sData[si].forEach((v, i) => {
        if (v === null) return; // 空值不画柱，避免误导为 0
        const x = padL + bandW * i + bandW / 2 - (series.length * barW) / 2 + si * barW;
        out += `<rect x="${x}" y="${yScale(v)}" width="${Math.max(1, barW - 1)}" height="${Math.max(0, padT + plotH - yScale(v))}" fill="${color}" rx="1.5"><title>${escapeHtml(labels[i])}: ${v}</title></rect>`;
      });
    } else {
      // 折线在空值处断开（分段），而不是落到 0
      let seg = [];
      const flush = () => {
        if (seg.length > 1) out += `<polyline points="${seg.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
        else if (seg.length === 1) out += `<circle cx="${seg[0].split(',')[0]}" cy="${seg[0].split(',')[1]}" r="2.5" fill="${color}"/>`;
        seg = [];
      };
      sData[si].forEach((v, i) => {
        if (v === null) { flush(); return; }
        const px = padL + bandW * i + bandW / 2;
        seg.push(`${px},${yScale(v)}`);
        out += `<circle cx="${px}" cy="${yScale(v)}" r="2.5" fill="${color}"><title>${escapeHtml(labels[i])}: ${v}</title></circle>`;
      });
      flush();
    }
  });
  out += `</g>`;
  svg.setAttribute('width', W);
  svg.style.color = 'var(--text-2)';
  svg.innerHTML = out;
  legend.replaceChildren(
    ...series.map((s, si) => {
      const c = CHART_COLORS[si % CHART_COLORS.length];
      const span = document.createElement('span');
      span.innerHTML = `<i style="background:${c}"></i>${escapeHtml(s.name)}`;
      return span;
    })
  );
}

function formatTick(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(Math.round(v * 100) / 100);
}

$('#chart-toggle').addEventListener('click', () => {
  const r = activeResultData();
  if (!r || r.kind !== 'query' || !r.rows?.length) return toast('当前没有可图表化的查询结果', 'error');
  openChart(r);
});
$('#chart-back').addEventListener('click', () => {
  const r = activeResultData();
  if (r) closeChart(r);
});

/* ======================= 结果集对比 ======================= */
$('#compare-toggle').addEventListener('click', () => {
  const a = activeResultData();
  if (!a || a.kind !== 'query' || !a.rows?.length) return toast('请先在一个查询结果上打开对比', 'error');
  const others = state.results.filter((x) => x !== a && x.kind === 'query' && x.rows);
  if (!others.length) return toast('没有其他查询结果可对比，先再执行一个查询', 'error');
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="setting-row"><span>选择要对比的结果（当前：${escapeHtml(a.target)} · ${a.rows.length} 行）</span>
      <select id="cmp-pick" class="select" style="width:100%">
        ${others
          .map(
            (x) =>
              `<option value="${x.id}">${escapeHtml(x.target)} · ${x.rows.length} 行 · ${escapeHtml((x.sql || '').slice(0, 40))}</option>`
          )
          .join('')}
      </select></div>
    <div class="setting-actions">
      <button class="button small" id="cmp-cancel">取消</button>
      <button class="button small primary" id="cmp-go">对比</button>
    </div>
    <div id="cmp-result"></div>`;
  openModal('结果集对比', body);
  body.querySelector('#cmp-cancel').addEventListener('click', closeModal);
  body.querySelector('#cmp-go').addEventListener('click', () => {
    const b = state.results.find((x) => x.id === Number(body.querySelector('#cmp-pick').value));
    if (b) renderCompare(a, b, body.querySelector('#cmp-result'));
  });
});

function renderCompare(a, b, box) {
  const colsSame =
    a.columns.length === b.columns.length && a.columns.every((c, i) => c === b.columns[i]);
  const keyOf = (row) => JSON.stringify(row);
  const setA = new Map(a.rows.map((row, i) => [keyOf(row), { row, i }]));
  const setB = new Map(b.rows.map((row, i) => [keyOf(row), { row, i }]));
  const onlyA = [...setA.entries()].filter(([k]) => !setB.has(k));
  const onlyB = [...setB.entries()].filter(([k]) => !setA.has(k));
  const common = setA.size - onlyA.length;

  const section = (title, count, color, rows, cols) => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;flex-direction:column;gap:6px';
    const h = document.createElement('strong');
    h.style.color = `var(--${color})`;
    h.textContent = `${title}（${count} 行）`;
    div.appendChild(h);
    if (rows.length) {
      const tbl = document.createElement('table');
      tbl.className = 'data-table';
      tbl.innerHTML =
        `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows
          .slice(0, 50)
          .map(
            ([, { row }]) =>
              `<tr>${row.map((v) => `<td class="sql-cell">${escapeHtml(v === null ? 'NULL' : String(v))}</td>`).join('')}</tr>`
          )
          .join('')}</tbody>`;
      div.appendChild(tbl);
      if (rows.length > 50) {
        const more = document.createElement('p');
        more.style.cssText = 'margin:0;color:var(--text-3);font-size:11px';
        more.textContent = `仅显示前 50 行，共 ${rows.length} 行`;
        div.appendChild(more);
      }
    }
    return div;
  };

  box.replaceChildren();
  if (!colsSame) {
    const warn = document.createElement('p');
    warn.style.cssText = 'color:var(--warn);font-size:12px;margin:0';
    warn.textContent = '注意：两个结果列不一致，按整行内容对比。';
    box.appendChild(warn);
  }
  box.append(
    section('仅 A 有', onlyA.length, 'danger', onlyA, a.columns),
    section('仅 B 有', onlyB.length, 'info', onlyB, b.columns),
    section('两边一致', common, 'success', [], a.columns)
  );
  toast(`对比完成：一致 ${common} · 仅A ${onlyA.length} · 仅B ${onlyB.length}`, 'success');
}

/** 导出全库数据字典（Markdown）：表 + 注释 + 字段清单，限 150 表 */
async function exportDataDict(instanceName, dbName) {
  const CAP = 150;
  const insObj = state.instances.find((i) => i.instance_name === instanceName);
  const dbType = insObj?.db_type || 'mysql';
  if (!['mysql', 'tidb'].includes(dbType)) return toast('数据字典目前支持 MySQL / TiDB', 'error');
  toast('正在生成数据字典…');
  try {
    const rl = await state.api.dictTableList(instanceName, dbName, dbType);
    if (rl.status !== 0) throw new Error(rl.msg);
    const raw = rl.data;
    // 兼容两种返回：{db: [[表,注释],...]} 或 [[表,注释],...]
    const entries = Array.isArray(raw) ? raw : Object.values(raw).flat();
    const tables = entries.slice(0, CAP).map((t) => (Array.isArray(t) ? { name: t[0], comment: t[1] || '' } : { name: String(t), comment: '' }));
    const truncated = entries.length > CAP;
    const parts = [
      `# 数据字典 · ${dbName}`,
      '',
      `- 实例：${instanceName}`,
      `- 生成时间：${new Date().toLocaleString('zh-CN')}`,
      `- 表数量：${tables.length}${truncated ? `（共 ${entries.length}，仅导出前 ${CAP}）` : ''}`,
      '',
    ];
    let i = 0;
    for (const t of tables) {
      i += 1;
      if (i % 10 === 0) toast(`生成中 ${i}/${tables.length}…`);
      let desc = null;
      try {
        const info = await state.api.dictTableInfo(instanceName, dbName, t.name, dbType);
        if (info.status === 0) desc = info.data.desc;
      } catch { /* 单表失败不阻塞 */ }
      parts.push(`## ${t.name}`, '');
      if (t.comment) parts.push(`> ${t.comment}`, '');
      if (desc?.column_list && desc.rows?.length) {
        parts.push(
          '| ' + desc.column_list.join(' | ') + ' |',
          '| ' + desc.column_list.map(() => '---').join(' | ') + ' |',
          ...desc.rows.map((r2) => '| ' + r2.map((v) => (v === null ? '' : String(v).replace(/\|/g, '\\|'))).join(' | ') + ' |')
        );
      } else {
        parts.push('（字段信息获取失败）');
      }
      parts.push('');
      await new Promise((r3) => setTimeout(r3, 30));
    }
    const filename = `数据字典-${dbName}-${new Date().toISOString().slice(0, 10)}.md`;
    const md = parts.join('\n');
    download(filename, md, 'text/markdown');
    toast(`已导出 ${tables.length} 张表的字典`, 'success');
    // 生成后弹窗预览，避免"下载没反应"
    const preview = el('<div class="md-view dict-preview"></div>');
    preview.innerHTML = renderMarkdown(md);
    const bar = el(`<div class="setting-actions"><button class="button small primary" id="dict-dl">${icon('download')}<span>下载 Markdown</span></button></div>`);
    bar.querySelector('#dict-dl').addEventListener('click', () => download(filename, md, 'text/markdown'));
    const wrap = document.createElement('div');
    wrap.append(bar, preview);
    openModal(`数据字典 · ${dbName}（${tables.length} 张表${truncated ? `，共 ${entries.length}` : ''}）`, wrap, { wide: true });
  } catch (e) {
    toast(`导出失败：${e.message}`, 'error');
  }
}

/** 查询结果 → 批量 INSERT 语句文件（从原 SQL 解析目标表名） */
function exportInserts(r) {
  if (!r.rows?.length) return toast('当前结果为空', 'error');
  const fromMatch = (r.sql || '').match(/\bfrom\s+`?([\w$]+)`?/i);
  const guessed = fromMatch ? fromMatch[1] : '';
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="setting-row"><span>目标表名（INSERT INTO ?）</span>
      <input id="ins-table" type="text" value="${escapeHtml(guessed)}" placeholder="表名" spellcheck="false"></label>
    <label class="setting-row"><span>每批行数（多值 VALUES 合批）</span>
      <select id="ins-batch" class="select" style="width:120px">
        <option>100</option><option selected>500</option><option>1000</option>
      </select></label>
    <p style="margin:0;color:var(--text-3);font-size:12px">共 ${r.rows.length} 行 × ${r.columns.length} 列。NULL 保持 NULL，字符串自动转义。生成的语句仅供工单使用，本插件不直接执行。</p>
    <div class="setting-actions">
      <button class="button small" id="ins-cancel">取消</button>
      <button class="button small primary" id="ins-go">生成并下载</button>
    </div>`;
  openModal('导出为 INSERT 语句', body);
  body.querySelector('#ins-cancel').addEventListener('click', closeModal);
  body.querySelector('#ins-go').addEventListener('click', () => {
    const table = body.querySelector('#ins-table').value.trim();
    if (!table) return toast('请填写目标表名', 'error');
    const batch = Number(body.querySelector('#ins-batch').value);
    const colSql = r.columns.map((c) => '`' + c + '`').join(', ');
    const parts = [`-- 由 Archery 助手生成：${r.target} · ${r.rows.length} 行 · ${new Date().toLocaleString('zh-CN')}`, ''];
    for (let i = 0; i < r.rows.length; i += batch) {
      const chunk = r.rows.slice(i, i + batch);
      const values = chunk
        .map((row) => '(' + row.map((v) => sqlValue(v)).join(', ') + ')')
        .join(',\n');
      parts.push(`INSERT INTO \`${table}\` (${colSql}) VALUES\n${values};\n`);
    }
    closeModal();
    download(`insert-${table}-${new Date().toISOString().slice(0, 10)}.sql`, parts.join('\n'), 'text/sql');
    toast(`已导出 ${r.rows.length} 行 INSERT 语句`, 'success');
  });
}

async function describeTable(ins, dbName, tableName) {
  const insName = typeof ins === 'string' ? ins : ins.name || ins.instance_name;
  const insObj = state.instances.find((i) => i.instance_name === insName);
  const dbType = insObj?.db_type || 'mysql';
  try {
    // 优先走数据字典接口：一次拿全 字段/索引/建表语句
    let dict = null;
    if (['mysql', 'tidb'].includes(dbType)) {
      try {
        const r = await state.api.dictTableInfo(insName, dbName, tableName, dbType);
        if (r.status === 0) dict = r.data;
      } catch { /* 回退 describe */ }
    }
    if (dict) {
      pushResult({
        kind: 'describe',
        title: tableName,
        target: `${insName}/${dbName}`,
        createSql: (dict.create_sql?.[0]?.[1] || '') + ';',
        dictDesc: dict.desc || null,   // {column_list, rows}
        dictIndex: dict.index || null, // {column_list, rows}
        sql: `show create table ${tableName}`,
      });
      return;
    }
    const res = await state.api.describe(insName, dbName, tableName);
    if (res.status !== 0) throw new Error(res.msg);
    const d = res.data;
    let createSql = null;
    if (d.rows?.length === 1 && typeof d.rows[0][1] === 'string' && /CREATE TABLE/i.test(d.rows[0][1] || '')) {
      createSql = `${d.rows[0][1]};`;
    }
    pushResult({
      kind: 'describe',
      title: tableName,
      target: `${insName}/${dbName}`,
      columns: d.column_list || [],
      rows: d.rows || [],
      createSql,
      sql: d.full_sql,
    });
  } catch (e) {
    pushResult({ kind: 'error', title: '错误', target: `${insName}/${dbName}`, error: `查看 ${tableName} 结构失败：${e.message}` });
  }
}

/* describe 结果渲染为 字段/建表语句/索引 三个子视图 */
function renderDescribeView(r) {
  const content = $('#result-content');
  content.replaceChildren();
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0';

  const tabs = document.createElement('div');
  tabs.className = 'result-tabs';
  // flex:none：抵消 .result-tabs 的 flex:1，避免纵向容器里页签栏被撑高把内容挤下去
  tabs.style.cssText = 'padding:8px 10px 0;flex:none';
  const views = [
    { key: 'desc', label: '字段', on: !!r.dictDesc },
    { key: 'create', label: '建表语句', on: !!r.createSql },
    { key: 'index', label: '索引', on: !!r.dictIndex?.rows?.length },
  ].filter((v) => v.on);
  let active = views[0].key;
  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-height:0;overflow:auto';

  const render = () => {
    tabs.replaceChildren(
      ...views.map((v) => {
        const b = el(`<div class="result-tab ${v.key === active ? 'active' : ''}">${v.label}</div>`);
        b.addEventListener('click', () => {
          active = v.key;
          render();
        });
        return b;
      })
    );
    body.replaceChildren();
    if (active === 'desc' && r.dictDesc) {
      const t = document.createElement('table');
      t.className = 'result-table';
      t.innerHTML =
        `<thead><tr>${(r.dictDesc.column_list || []).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${(r.dictDesc.rows || [])
          .map((row) => `<tr>${row.map((v) => `<td class="${v === null ? 'null' : ''}">${escapeHtml(v === null ? 'NULL' : String(v))}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
      body.appendChild(t);
    } else if (active === 'create') {
      const pre = document.createElement('div');
      pre.className = 'create-table-view';
      pre.textContent = r.createSql || '(未获取到)';
      body.appendChild(pre);
      const copyBtn = el(`<div style="padding:0 12px 10px"><button class="button small">${icon('copy')} 复制</button></div>`);
      copyBtn.querySelector('button').addEventListener('click', () => {
        navigator.clipboard.writeText(r.createSql || '');
        toast('已复制', 'success');
      });
      body.appendChild(copyBtn);
    } else if (active === 'index' && r.dictIndex) {
      const t = document.createElement('table');
      t.className = 'result-table';
      t.innerHTML =
        `<thead><tr>${(r.dictIndex.column_list || []).map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>` +
        `<tbody>${(r.dictIndex.rows || [])
          .map((row) => `<tr>${row.map((v) => `<td class="${v === null ? 'null' : ''}">${escapeHtml(v === null ? 'NULL' : String(v))}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
      body.appendChild(t);
    }
  };
  render();
  wrap.append(tabs, body);
  content.replaceChildren(wrap);
}

/* ======================= 收藏最近执行 ======================= */
function promptText(title, placeholder = '') {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.innerHTML = `
      <label class="setting-row"><span>${escapeHtml(title)}</span>
        <input id="prompt-input" type="text" placeholder="${escapeHtml(placeholder)}"></label>
      <div class="setting-actions">
        <button class="button small" id="prompt-cancel">取消</button>
        <button class="button small primary" id="prompt-ok">确定</button>
      </div>`;
    openModal('输入', body);
    const input = body.querySelector('#prompt-input');
    input.focus();
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    body.querySelector('#prompt-ok').addEventListener('click', () => done(input.value));
    body.querySelector('#prompt-cancel').addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value);
    });
  });
}

/* 收藏：选择存本地（分组+命名）或云端（直接命名）；结果栏「存本地」保持不变 */
/* 五角星收藏：直接打开收藏弹窗（本地保存 + 默认勾选同步云端） */
$('#save-favorite').addEventListener('click', () => {
  const r = [...state.results].reverse().find((x) => x.kind === 'query');
  const sql = r?.sql || editor.value;
  if (!sql.trim()) return toast('还没有可收藏的 SQL', 'error');
  const target = r?.target || `${$('#instance-name').value}/${$('#db-name').value}`;
  const [instance = '', db = ''] = String(target).split('/');
  openLocalSaveModal({ sql, instance, db });
});

/* ======================= 查询历史 / 收藏 ======================= */
function prepareTable(table) {
  const wrap = table.closest('.table-wrap');
  wrap?.querySelectorAll(':scope > .list-empty').forEach((n) => {
    if (n.id) n.hidden = true;
    else n.remove();
  });
  table.hidden = false;
  table.innerHTML = '';
  return wrap;
}

function renderListEmpty(table, { iconName = 'history', title, hint }) {
  const wrap = table.closest('.table-wrap') || table.parentElement;
  table.hidden = true;
  table.innerHTML = '';
  const pinned = wrap.querySelector(':scope > .list-empty[id]');
  wrap.querySelectorAll(':scope > .list-empty:not([id])').forEach((n) => n.remove());
  if (pinned) {
    pinned.hidden = false;
    return;
  }
  wrap.appendChild(
    el(`<div class="list-empty">${icon(iconName)}<b>${escapeHtml(title)}</b><small>${escapeHtml(hint)}</small></div>`)
  );
}

function renderLogTable(tableEl, rows) {
  const table = typeof tableEl === 'string' ? $(tableEl) : tableEl;
  prepareTable(table);
  if (!rows.length) {
    renderListEmpty(table, {
      iconName: 'history',
      title: '还没有查询历史',
      hint: '执行过的查询会出现在这里，可回填到编辑器再跑一次',
    });
    return;
  }
  const thead = `<thead><tr>
    <th style="width:140px">时间</th><th style="width:150px">实例 / 库</th>
    <th>SQL</th><th style="width:70px" class="num">行数</th><th style="width:70px" class="num">耗时</th>
    <th style="width:80px">人员</th>
    <th style="width:170px">操作</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.create_time)}</td>
      <td title="${escapeHtml(row.instance_name)}">${escapeHtml(row.instance_name)}<br><span style="color:var(--text-3)">${escapeHtml(row.db_name)}</span></td>
      <td class="sql-cell clamp" title="点击展开/收起完整 SQL">${escapeHtml(row.sqllog)}<button class="icon-button mini sql-copy" title="复制 SQL">${icon('copy')}</button></td>
      <td class="num">${escapeHtml(String(row.effect_row ?? ''))}</td>
      <td class="num">${escapeHtml(String(row.cost_time ?? ''))}s</td>
      <td>${escapeHtml(row.user_display)}</td>
      <td><div class="row-actions">
        <button class="button small" data-act="fill">回填</button>
        <button class="button small" data-act="run">执行</button>
        <button class="button small ${row.favorite ? 'primary' : ''}" data-act="star" title="收藏/取消">${row.favorite ? '★' : '☆'} 收藏</button>
      </div></td>`;
    tr.querySelector('.sql-cell').addEventListener('click', () => {
      tr.classList.toggle('sql-expanded');
      const cell = tr.querySelector('.sql-cell');
      cell.classList.toggle('clamp');
    });
    tr.querySelector('.sql-copy')?.addEventListener('click', (e) => { e.stopPropagation(); navigator.clipboard.writeText(row.sqllog || ''); toast('已复制 SQL', 'success'); });('click', () => fillFromLog(row));
    tr.querySelector('[data-act="run"]').addEventListener('click', () => fillFromLog(row, true));
    tr.querySelector('[data-act="star"]').addEventListener('click', async () => {
      try {
        const next = !row.favorite;
        await state.api.favorite(row.id, next, row.alias || '');
        toast(next ? '已收藏' : '已取消收藏', 'success');
        loadHistory();
      } catch (e) {
        toast(`操作失败：${e.message}`, 'error');
      }
    });
    tbody.appendChild(tr);
  }
  table.appendChild(el(thead));
  table.appendChild(tbody);
}

async function fillFromLog(row, run = false) {
  switchView('query');
  // 尽量联动实例与库
  if ($('#instance-name').querySelector(`option[value="${CSS.escape(row.instance_name)}"]`)) {
    await selectInstance(row.instance_name);
    if (row.db_name && $('#db-name').querySelector(`option[value="${CSS.escape(row.db_name)}"]`)) {
      setSelectValue('#db-name', row.db_name);
    }
  }
  editor.setValue(stripSyncMarks(row.sqllog) || row.sqllog, true);
  saveDraft();
  if (run) runQuery();
}

async function loadHistory() {
  const h = state.history;
  await loadLogPage(h, $('#history-table'), $('#history-pager'), $('#history-summary'), { starMode: false });
}

async function loadLogPage(pageState, tableEl, pagerSel, summaryEl, { starMode }) {
  const limit = 20;
  summaryEl.textContent = '加载中…';
  try {
    const res = await state.api.queryLog({
      limit,
      offset: (pageState.page - 1) * limit,
      search: pageState.search,
      star: starMode ? 'true' : '',
    });
    renderLogTable(tableEl, res.rows || []);
    pageState.total = res.total || 0;
    summaryEl.textContent = `共 ${pageState.total} 条`;
    renderPager(pagerSel, pageState.page, Math.max(1, Math.ceil(pageState.total / limit)), (p) => {
      pageState.page = p;
      loadHistory();
    });
  } catch (e) {
    summaryEl.textContent = `加载失败：${e.message}`;
    renderListEmpty(tableEl, {
      iconName: 'alert',
      title: '列表加载失败',
      hint: e.message || '请检查 Archery 地址与登录状态后重试',
    });
  }
}

/* ======================= 本地 SQL 收藏（仅存本机，支持分组） ======================= */
const localFav = {
  items: [],
  groups: [],
  async load() {
    const o = await chrome.storage.local.get({ 'local-sql': [], 'local-sql-groups': [] });
    this.items = o['local-sql'];
    this.groups = o['local-sql-groups'];
  },
  async persist() {
    await chrome.storage.local.set({ 'local-sql': this.items, 'local-sql-groups': this.groups });
  },
};

/** 分组筛选 chips（带计数），选中态存于 localGroupFilter */
let localGroupFilter = '';
function fillLocalGroupFilter() {
  const wrap = $('#local-group-chips');
  const counts = new Map();
  for (const i of localFav.items) counts.set(i.group || '', (counts.get(i.group || '') || 0) + 1);
  const chip = (value, label, count) => {
    const b = el(`<button class="fav-chip${localGroupFilter === value ? ' active' : ''}">${escapeHtml(label)}<i>${count}</i></button>`);
    b.addEventListener('click', () => {
      localGroupFilter = value;
      fillLocalGroupFilter();
      renderLocalList();
    });
    return b;
  };
  wrap.replaceChildren(chip('', '全部', localFav.items.length));
  if (counts.get('')) wrap.appendChild(chip('__none', '未分组', counts.get('')));
  for (const g of localFav.groups) if (counts.get(g)) wrap.appendChild(chip(g, g, counts.get(g)));
}

/** 保存弹窗：命名 + 选分组 / 新建分组 + 是否同步云端 */
function openLocalSaveModal({ sql, instance = '', db = '', onSaved } = {}) {
  if (!sql?.trim()) return toast('没有可保存的 SQL', 'error');
  const body = el(`<div>
    <label class="setting-row"><span>名称</span><input id="lf-name" type="text" placeholder="例如：订单表慢查询" maxlength="60" /></label>
    <label class="setting-row"><span>分组</span><select id="lf-group" class="select"></select></label>
    <label class="setting-row"><span>新建分组（可选）</span><input id="lf-newgroup" type="text" placeholder="输入新分组名，留空则用上方分组" maxlength="30" /></label>
    <div class="setting-row"><span>云端</span>
      <label class="fav-check"><input type="checkbox" id="lf-cloud" checked />同步到 Archery 收藏，跨设备可见（仅只读语句）</label>
    </div>
    <div class="setting-actions"><button class="button primary" id="lf-save">${icon('check')}<span>保存</span></button></div>
  </div>`);
  const groupSel = body.querySelector('#lf-group');
  groupSel.innerHTML = '<option value="">未分组</option>' + localFav.groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  body.querySelector('#lf-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') body.querySelector('#lf-save').click(); });
  body.querySelector('#lf-save').addEventListener('click', async () => {
    const name = body.querySelector('#lf-name').value.trim();
    if (!name) return toast('请填写名称', 'error');
    const newGroup = body.querySelector('#lf-newgroup').value.trim();
    let group = groupSel.value;
    if (newGroup) {
      group = newGroup;
      if (!localFav.groups.includes(newGroup)) localFav.groups.push(newGroup);
    }
    const item = {
      id: String(Date.now()), name, sql: stripSyncMarks(sql.trim()), instance, db, group,
      cloud: body.querySelector('#lf-cloud').checked, createdAt: Date.now(),
    };
    localFav.items.unshift(item);
    await localFav.persist();
    closeModal();
    fillLocalGroupFilter();
    renderLocalList();
    onSaved?.();
    if (item.cloud) {
      toast(`已保存「${name}」，正在同步云端…`, 'info');
      try {
        await pushItemToCloud(item);
        await localFav.persist();
        renderLocalList();
        toast(`「${name}」已同步到云端收藏`, 'success');
      } catch (e) {
        renderLocalList();
        toast(`已保存，但云端同步失败：${e.message}`, 'error');
      }
    } else {
      toast(`已保存「${name}」`, 'success');
    }
  });
  openModal('保存 SQL 收藏', body);
}

$('#local-save-editor').addEventListener('click', () => {
  openLocalSaveModal({ sql: editor.value, instance: $('#instance-name').value, db: $('#db-name').value });
});

/** 结果工具栏：保存当前结果对应的 SQL */
$('#save-local').addEventListener('click', () => {
  const r = state.results.find((x) => x.id === state.activeResult);
  if (!r?.sql) return toast('当前没有可保存的查询结果', 'error');
  const [instance = '', db = ''] = String(r.target || '').split('/');
  openLocalSaveModal({ sql: r.sql, instance, db });
});

/** 一键回填并执行 */
async function runLocalSql(item) {
  switchView('query');
  editor.setValue(item.sql);
  const instSel = $('#instance-name');
  if (item.instance && [...instSel.options].some((o) => o.value === item.instance)) {
    if (instSel.value !== item.instance) {
      await selectInstance(item.instance);
    } else {
      await state.dbsLoading;
    }
    if (item.db) {
      const dbSel = $('#db-name');
      if (dbSel.querySelector(`option[value="${CSS.escape(item.db)}"]`)) setSelectValue(dbSel, item.db);
      else toast(`库 ${item.db} 在该实例下不可见，请手动选择`, 'info');
    }
  } else if (item.instance) {
    toast(`实例 ${item.instance} 当前不可用，仅回填 SQL`, 'info');
  }
  runQuery();
}

let favSearchKw = '';
function renderLocalList() {
  const wrap = $('#local-cards');
  const filter = localGroupFilter;
  const kw = favSearchKw.trim().toLowerCase();
  const items = localFav.items
    .filter((i) => (filter === '' ? true : filter === '__none' ? !i.group : i.group === filter))
    .filter((i) => !kw || `${i.name}\n${i.sql}\n${i.group || ''}\n${i.instance || ''}`.toLowerCase().includes(kw))
    .sort((a, b) => (a.group || '').localeCompare(b.group || '', 'zh-CN') || b.createdAt - a.createdAt);
  wrap.replaceChildren();
  if (!items.length) {
    wrap.appendChild(el(`<div class="fav-empty"><span class="fav-empty-icon">${icon('star')}</span>
      <b>${localFav.items.length ? '没有匹配的收藏' : '还没有收藏'}</b>
      <small>${localFav.items.length ? '换个关键字或切换分组筛选试试' : '查询后在结果工具栏点「存本地」，或点右上角「保存编辑器 SQL」'}</small></div>`));
  }
  for (const item of items) {
    const cloudBadge = item.cloudLogId
      ? '<span class="tag teal" title="已保存到 Archery 收藏，跨设备可见">云端</span>'
      : item.cloud
        ? '<span class="tag yellow" title="已勾选云端但尚未同步成功，点「同步云端」重试">待同步</span>'
        : '';
    const card = el(`<div class="fav-card">
      <div class="fav-card-top">
        <div class="fav-card-title">
          <b>${escapeHtml(item.name)}</b>
          ${item.group ? `<span class="tag green">${escapeHtml(item.group)}</span>` : ''}
          ${cloudBadge}
        </div>
        <div class="fav-card-actions">
          <button class="button small primary" data-act="run">${icon('play')}查询</button>
          ${item.cloudLogId
            ? `<button class="button small" data-act="cloud-off" title="从 Archery 收藏移除，本地保留">${icon('star')}取消云端</button>`
            : `<button class="button small" data-act="cloud-on" title="保存到 Archery 收藏，跨设备可见">${icon('upload')}${item.cloud ? '同步云端' : '存到云端'}</button>`}
          <button class="button small" data-act="view">${icon('eye')}查看</button>
          <button class="icon-button" data-act="copy" title="复制 SQL">${icon('copy')}</button>
          <button class="button small" data-act="edit">${icon('format')}编辑</button>
          <button class="icon-button danger" data-act="del" title="删除">${icon('trash')}</button>
        </div>
      </div>
      <pre class="fav-card-sql" title="点击展开 / 收起">${escapeHtml(item.sql)}</pre>
      <div class="fav-card-meta">
        <span>${icon('database')}${escapeHtml(item.instance || '—')} · ${escapeHtml(item.db || '—')}</span>
        <span>${icon('clock')}${new Date(item.createdAt).toLocaleDateString('zh-CN')} 保存</span>
      </div>
    </div>`);
    card.querySelector('.fav-card-sql').addEventListener('click', (e) => e.currentTarget.classList.toggle('open'));
    card.querySelector('[data-act="run"]').addEventListener('click', () => runLocalSql(item));
    card.querySelector('[data-act="view"]').addEventListener('click', () => openLocalViewModal(item));
    card.querySelector('[data-act="copy"]').addEventListener('click', () => {
      navigator.clipboard.writeText(item.sql);
      toast('已复制 SQL', 'success');
    });
    card.querySelector('[data-act="edit"]').addEventListener('click', () => openLocalEditModal(item));
    card.querySelector('[data-act="cloud-on"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      item.cloud = true;
      try {
        await pushItemToCloud(item);
        await localFav.persist();
        renderLocalList();
        toast(`「${item.name}」已同步到云端收藏`, 'success');
      } catch (err) {
        await localFav.persist(); // 保留「待同步」状态，可重试
        renderLocalList();
        toast(`云端同步失败：${err.message}`, 'error');
      }
    });
    card.querySelector('[data-act="cloud-off"]')?.addEventListener('click', async () => {
      try {
        await unstarCloudItem(item);
        toast(`「${item.name}」已从云端收藏移除（本地保留）`, 'info');
      } catch (err) {
        toast(`操作失败：${err.message}`, 'error');
      }
    });
    card.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (item.cloudLogId) state.api?.favorite(item.cloudLogId, false).catch(() => {}); // 云端收藏一并取消
      localFav.items = localFav.items.filter((x) => x.id !== item.id);
      await localFav.persist();
      fillLocalGroupFilter();
      renderLocalList();
      toast(`已删除「${item.name}」`, 'info');
    });
    wrap.appendChild(card);
  }
  const synced = localFav.items.filter((i) => i.cloudLogId).length;
  $('#local-summary').textContent = `共 ${localFav.items.length} 条 · ${localFav.groups.length} 个分组${synced ? ` · ${synced} 条在云端` : ''}`;
}

/** 编辑已保存条目：改名 / 换分组 / 改 SQL / 云端开关（勾选时保存后自动重推云端并取消旧收藏） */
/** 查看收藏详情：大弹窗只读展示完整 SQL（含复制） */
function openLocalViewModal(item) {
  const body = el(`<div class="local-view">
    <div class="lv-meta">
      ${item.group ? `<span class="tag green">${escapeHtml(item.group)}</span>` : '<span class="tag gray">未分组</span>'}
      ${item.cloudLogId ? '<span class="tag teal" title="已保存到 Archery 收藏">云端</span>' : ''}
      <span class="mono">${escapeHtml(item.instance || '—')} / ${escapeHtml(item.db || '—')}</span>
      <span style="color:var(--text-3)">${new Date(item.createdAt).toLocaleString('zh-CN')} 保存</span>
      <button class="button small" id="lv-copy" style="margin-left:auto">${icon('copy')}<span>复制 SQL</span></button>
    </div>
    <pre class="lv-sql"></pre>
  </div>`);
  body.querySelector('.lv-sql').textContent = item.sql;
  body.querySelector('#lv-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(item.sql);
    toast('已复制 SQL', 'success');
  });
  openModal(`查看收藏 · ${item.name}`, body, { wide: true });
}

function openLocalEditModal(item) {
  const body = el(`<div>
    <label class="setting-row"><span>名称</span><input id="lfe-name" type="text" maxlength="60" value="${escapeHtml(item.name)}" /></label>
    <label class="setting-row"><span>分组</span><select id="lfe-group" class="select"></select></label>
    <label class="setting-row"><span>新建分组（可选）</span><input id="lfe-newgroup" type="text" maxlength="30" placeholder="留空则用上方分组" /></label>
    <div class="setting-row"><span>云端</span>
      <label class="fav-check"><input type="checkbox" id="lfe-cloud" ${item.cloud ? 'checked' : ''} />同步到 Archery 收藏，跨设备可见（仅只读语句）</label>
    </div>
    <label class="setting-row grow"><span>SQL</span><textarea id="lfe-sql" class="lf-sql-area"></textarea></label>
    <div class="setting-actions"><button class="button primary" id="lfe-save">${icon('check')}<span>保存修改</span></button></div>
  </div>`);
  const groupSel = body.querySelector('#lfe-group');
  groupSel.innerHTML = '<option value="">未分组</option>' + localFav.groups.map((g) => `<option value="${escapeHtml(g)}" ${g === item.group ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('');
  body.querySelector('#lfe-sql').value = item.sql;
  body.querySelector('#lfe-save').addEventListener('click', async () => {
    const name = body.querySelector('#lfe-name').value.trim();
    const sql = body.querySelector('#lfe-sql').value.trim();
    if (!name || !sql) return toast('名称和 SQL 不能为空', 'error');
    const newGroup = body.querySelector('#lfe-newgroup').value.trim();
    if (newGroup && !localFav.groups.includes(newGroup)) localFav.groups.push(newGroup);
    Object.assign(item, { name, sql: stripSyncMarks(sql), group: newGroup || groupSel.value });
    const wantCloud = body.querySelector('#lfe-cloud').checked;
    const wasCloud = !!item.cloudLogId;
    await localFav.persist();
    closeModal();
    fillLocalGroupFilter();
    try {
      if (wantCloud) {
        item.cloud = true;
        await pushItemToCloud(item); // 重推即更新云端（含分组/名称标记），旧收藏自动取消
        await localFav.persist();
        renderLocalList();
        toast('修改已保存，云端收藏已更新', 'success');
      } else if (wasCloud) {
        await unstarCloudItem(item);
        renderLocalList();
        toast('修改已保存，已从云端收藏移除（本地保留）', 'success');
      } else {
        item.cloud = false;
        await localFav.persist();
        renderLocalList();
        toast('修改已保存', 'success');
      }
    } catch (e) {
      await localFav.persist();
      renderLocalList();
      toast(`修改已保存，但云端操作失败：${e.message}`, 'error');
    }
  });
  openModal(`编辑收藏 · ${item.name}`, body, { wide: true });
}

/** 分组管理：新建 / 删除（组内条目回到未分组） */
$('#local-group-mgr').addEventListener('click', () => {
  const body = el(`<div>
    <div id="lgm-list" style="display:flex;flex-direction:column;gap:6px"></div>
    <label class="setting-row" style="margin-top:10px"><span>新建分组</span>
      <div style="display:flex;gap:8px">
        <input id="lgm-name" type="text" maxlength="30" placeholder="分组名" />
        <button class="button small" id="lgm-add">${icon('plus')}添加</button>
      </div>
    </label>
  </div>`);
  const list = body.querySelector('#lgm-list');
  const refreshList = () => {
    list.replaceChildren();
    if (!localFav.groups.length) list.appendChild(el(`<div style="color:var(--text-3);font-size:12px;padding:6px 0">还没有分组，可在下方新建</div>`));
    for (const g of localFav.groups) {
      const n = localFav.items.filter((i) => i.group === g).length;
      const row = el(`<div style="display:flex;align-items:center;gap:8px">
        <span class="tag green">${escapeHtml(g)}</span>
        <span style="color:var(--text-3);font-size:12px">${n} 条</span>
        <button class="button small danger" style="margin-left:auto" ${n ? '' : ''}>${icon('trash')}删除</button>
      </div>`);
      row.querySelector('button').addEventListener('click', async () => {
        localFav.groups = localFav.groups.filter((x) => x !== g);
        localFav.items.forEach((i) => { if (i.group === g) i.group = ''; });
        await localFav.persist();
        fillLocalGroupFilter();
        renderLocalList();
        refreshList();
        toast(`分组「${g}」已删除，组内条目移入未分组`, 'info');
      });
      list.appendChild(row);
    }
  };
  refreshList();
  body.querySelector('#lgm-add').addEventListener('click', async () => {
    const name = body.querySelector('#lgm-name').value.trim();
    if (!name) return toast('请输入分组名', 'error');
    if (localFav.groups.includes(name)) return toast('分组已存在', 'error');
    localFav.groups.push(name);
    await localFav.persist();
    body.querySelector('#lgm-name').value = '';
    fillLocalGroupFilter();
    renderLocalList();
    refreshList();
  });
  openModal('管理本地分组', body);
});

localFav.ready = localFav.load().then(() => { fillLocalGroupFilter(); });

/** 导出全部本地 SQL 为 JSON（换机迁移用） */
$('#local-export').addEventListener('click', () => {
  if (!localFav.items.length) return toast('没有可导出的本地 SQL', 'error');
  const payload = { version: 1, exportedAt: new Date().toISOString(), groups: localFav.groups, items: localFav.items };
  download(`本地SQL收藏-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
  toast(`已导出 ${localFav.items.length} 条本地 SQL`, 'success');
});

/* ---------- 云端收藏 ⇄ 本地 SQL 双向同步 ----------
 * 目录标记写成 SQL 语句内的中性书签注释（bookmark id=… group=… name=…），
 * 紧跟第一条语句的首个关键字之后——语句前的首行注释会被部分实例的查询校验拒绝
 * （disable_star 开启时报「SQL语句中含有 *」），语句内注释可正常通过；
 * 注释里不出现插件名，审计/查询日志中看起来只是普通的书签标记。
 * 执行查询 / EXPLAIN / 审核检测前用 stripSyncMarks 移除标记（仅上推时写入），
 * 云端收藏回填的内容自动还原为干净 SQL。
 * 兼容历史格式：首行块注释、首行 -- 行注释、语句内 archery-helper 块注释（值为 URL 编码）。 */

// 明文值：去掉会破坏注释结构的字符（块注释结束符、竖线、换行）
const SYNC_PLAIN = (v) => String(v ?? '').replace(/[*\/|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const cloudSyncMark = (item) =>
  `/* bookmark id=${item.id}${item.group ? ` group=${SYNC_PLAIN(item.group)}` : ''}${item.name ? ` name=${SYNC_PLAIN(item.name)}` : ''} */`;

/** 把标记注入 SQL 首个语句关键字之后（已有标记先移除，避免重复）；定位不到关键字返回 null */
function withCloudMark(sql, item) {
  const s = stripSyncMarks(String(sql || ''));
  const m = s.match(/(^|\n)[ \t]*(select|show|explain|desc(?:ribe)?|with)\b/i);
  if (!m) return null;
  const at = m.index + m[0].length; // 关键字结束处
  // 标记独占一行：关键字后换行放标记，原语句主体另起一行缩进
  const body = s.slice(at).replace(/^[ \t\r\n]+/, '');
  return `${s.slice(0, at)}\n    ${cloudSyncMark(item)}\n    ${body}`;
}

// 现行格式：语句内 bookmark 明文注释；历史格式：首行/语句内 archery-helper 注释（值 URL 编码）
const CLOUD_MARK_RE =
  /\/\*[ \t]*bookmark[ \t]+id=([\w.-]+)(?:[ \t]+group=([^*\n]*?))?(?:[ \t]+name=([^*\n]*?))?[ \t]*\*\//;
const CLOUD_LEGACY_LINE_RE = /^--[ \t]*archery-helper[ \t]+gid=([\w.-]+)(?:[ \t]+group=(\S+?))?(?:[ \t]+name=(\S+?))?[ \t]*(?:\r?\n|$)/;
const CLOUD_LEGACY_BLOCK_RE = /\/\*[ \t]*archery-helper[ \t]+gid=([\w.-]+)(?:[ \t]+group=(\S+?))?(?:[ \t]+name=(\S+?))?[ \t]*\*\//;
const parseCloudHead = (sql) => {
  const s = String(sql || '');
  let m = s.match(CLOUD_MARK_RE);
  if (m) return { gid: m[1], group: (m[2] || '').trim(), name: (m[3] || '').trim() };
  m = s.match(CLOUD_LEGACY_LINE_RE) || s.match(CLOUD_LEGACY_BLOCK_RE);
  if (m)
    return {
      gid: m[1],
      group: m[2] ? decodeURIComponent(m[2].trim()) : '',
      name: m[3] ? decodeURIComponent(m[3].trim()) : '',
    };
  return null;
};

/** 移除 SQL 中的同步标记（含全部历史格式）：连同注入时加的换行缩进一起还原 */
const SYNC_MARK_STRIP_RE =
  /\n?[ \t]*(?:\/\*[ \t]*(?:bookmark[ \t]+id=|archery-helper)[\s\S]*?\*\/|--[ \t]*archery-helper[^\n]*)/g;
const stripSyncMarks = (sql) => String(sql || '').replace(SYNC_MARK_STRIP_RE, '');
const isReadOnlySql = (sql) => /^\s*(select|show|explain|desc|describe|with)\b/i.test(String(sql || ''));

/** 取出 SQL 末尾的 LIMIT，供上推时传给 Archery，避免服务端把 LIMIT 1000 改写成 1 */
function extractSqlLimit(sql) {
  const s = stripSyncMarks(String(sql || '')).replace(/;+\s*$/, '').trim();
  const offsetCount = s.match(/\blimit\s+(\d+)\s*,\s*(\d+)\s*$/i);
  if (offsetCount) return offsetCount[2];
  const plain = s.match(/\blimit\s+(\d+)(?:\s+offset\s+\d+)?\s*$/i);
  if (plain) return plain[1];
  return '0';
}

/** 上推 / 更新云端收藏：执行带标记 SQL 一次 → 加星 → 自动取消旧收藏；成功后回写 cloudLogId */
async function pushItemToCloud(item) {
  if (!state.api) throw new Error('尚未连接 Archery');
  if (!isReadOnlySql(item.sql)) throw new Error('仅支持只读语句（SELECT / SHOW / EXPLAIN / DESC / WITH）');
  const ins = item.instance || $('#instance-name').value;
  const db = item.db || $('#db-name').value;
  if (!ins || !db) throw new Error('缺少实例或库：先在工作台选中，或编辑里确认来源实例未失效');
  const sqlContent = withCloudMark(item.sql, item);
  if (!sqlContent) throw new Error('SQL 中找不到可注入标记的语句关键字');
  const q = await state.api.query({
    instanceName: ins, dbName: db, schemaName: '', sqlContent,
    limitNum: extractSqlLimit(item.sql),
  });
  if (q.status !== 0) throw new Error(q.msg || '执行失败');
  // 执行日志里定位本次语句（并发查询时按标记 gid 兜底匹配）
  const lg = await state.api.queryLog({ limit: 5, offset: 0 });
  const rows = lg.rows || [];
  const hit = rows.find((r) => parseCloudHead(String(r.sqllog))?.gid === item.id) || rows[0];
  if (!hit) throw new Error('未找到执行日志');
  await state.api.favorite(hit.id, true, item.name.slice(0, 60));
  const oldId = item.cloudLogId;
  if (oldId && oldId !== hit.id) await state.api.favorite(oldId, false).catch(() => {});
  item.cloud = true;
  item.cloudLogId = hit.id;
}

/** 取消云端收藏（本地条目保留） */
async function unstarCloudItem(item) {
  if (item.cloudLogId) await state.api.favorite(item.cloudLogId, false).catch(() => {});
  item.cloud = false;
  item.cloudLogId = null;
  await localFav.persist();
  renderLocalList();
}

/** 云端 → 本地：拉取 Archery 加星日志。带标记的按 gid 识别——
 *  本地已有同 gid（其它设备重推）只更新指向的日志 id（本地内容为准）；
 *  本地没有的导入（沿用 gid，本机再编辑重推仍是同一条）；
 *  无标记的（网页端手动收藏）导入「云端收藏」分组。 */
async function refreshCloudFavorites({ quiet = false } = {}) {
  if (!state.api) return;
  await localFav.ready; // 本地数据未就绪时先等加载，避免导入结果被初始加载覆盖
  const res = await state.api.queryLog({ limit: 100, offset: 0, star: 'true' });
  const rows = res.rows || [];
  const knownCloud = new Set(localFav.items.map((i) => i.cloudLogId).filter(Boolean));
  const byGid = new Map(localFav.items.map((i) => [i.id, i]));
  let added = 0, relinked = 0;
  const imports = [];
  const now = Date.now();
  for (const row of rows) {
    if (knownCloud.has(row.id)) continue;
    const head = parseCloudHead(row.sqllog);
    if (head?.gid && byGid.has(head.gid)) {
      // 其它设备重推的同一条目：本地是源头，只把云端指向更新为最新日志
      const it = byGid.get(head.gid);
      if (it.cloudLogId && it.cloudLogId !== row.id) {
        await state.api.favorite(it.cloudLogId, false).catch(() => {});
      }
      it.cloud = true;
      it.cloudLogId = row.id;
      relinked += 1;
      continue;
    }
    if (head?.gid) {
      const g = head.group || '';
      if (g && !localFav.groups.includes(g)) localFav.groups.push(g);
      imports.push({
        id: head.gid,
        name: (head.name || row.alias || '云端收藏').slice(0, 60),
        sql: stripSyncMarks(row.sqllog),
        instance: row.instance_name || '',
        db: row.db_name || '',
        group: g,
        cloud: true,
        cloudLogId: row.id,
        createdAt: now,
      });
    } else {
      if (!localFav.groups.includes('云端收藏')) localFav.groups.push('云端收藏');
      imports.push({
        id: `c${row.id}`,
        name: (row.alias || String(row.sqllog).replace(/\s+/g, ' ').slice(0, 40) || '云端收藏').slice(0, 60),
        sql: String(row.sqllog || ''),
        instance: row.instance_name || '',
        db: row.db_name || '',
        group: '云端收藏',
        cloud: true,
        cloudLogId: row.id,
        createdAt: now,
      });
    }
    added += 1;
  }
  if (added || relinked) {
    localFav.items = [...imports, ...localFav.items];
    await localFav.persist();
    fillLocalGroupFilter();
    renderLocalList();
  }
  if (!quiet) {
    if (added || relinked) toast(`云端拉取完成：导入 ${added} 条${relinked ? `，更新 ${relinked} 条` : ''}`, 'success');
    else toast('云端收藏已是最新', 'info');
  }
}

$('#cloud-refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await refreshCloudFavorites();
  } catch (err) {
    toast(`云端拉取失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

/** 导入 JSON：按 名称+SQL+分组 去重合并，分组并入 */
$('#local-import').addEventListener('click', () => $('#local-import-file').click());
$('#local-import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const items = Array.isArray(data) ? data : data.items;
    if (!Array.isArray(items) || !items.length) throw new Error('文件里没有可导入的条目');
    const key = (i) => `${i.name}||${i.sql}||${i.group || ''}`;
    const existing = new Set(localFav.items.map(key));
    let added = 0;
    for (const it of items) {
      if (!it?.name || !it?.sql || existing.has(key(it))) continue;
      existing.add(key(it));
      localFav.items.push({
        id: String(Date.now()) + added,
        name: String(it.name), sql: String(it.sql),
        instance: it.instance || '', db: it.db || '',
        group: it.group || '', cloud: !!it.cloud, cloudLogId: it.cloudLogId || null,
        createdAt: it.createdAt || Date.now(),
      });
      added += 1;
    }
    for (const g of data.groups || []) if (g && !localFav.groups.includes(g)) localFav.groups.push(String(g));
    await localFav.persist();
    fillLocalGroupFilter();
    renderLocalList();
    toast(`导入完成：新增 ${added} 条，跳过重复 ${items.length - added} 条`, added || items.length ? 'success' : 'info');
  } catch (err) {
    toast(`导入失败：${err.message}`, 'error');
  }
});

function renderPager(container, page, pages, go) {
  container.replaceChildren();
  const mk = (text, target, disabled, current = false) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.disabled = disabled;
    if (current) b.classList.add('current');
    if (!disabled && !current) b.addEventListener('click', () => go(target));
    container.appendChild(b);
  };
  mk('‹', page - 1, page <= 1);
  const start = Math.max(1, page - 2);
  const end = Math.min(pages, start + 4);
  for (let i = start; i <= end; i++) mk(String(i), i, false, i === page);
  mk('›', page + 1, page >= pages);
}

let searchTimers = {};
function bindSearch(inputSel, pageState, reload) {
  $(inputSel).addEventListener('input', (e) => {
    clearTimeout(searchTimers[inputSel]);
    searchTimers[inputSel] = setTimeout(() => {
      pageState.search = e.target.value.trim();
      pageState.page = 1;
      reload();
    }, 350);
  });
}
bindSearch('#history-search', state.history, loadHistory);
$('#history-refresh').addEventListener('click', loadHistory);
/* 收藏搜索：本机过滤（名称 / SQL / 分组 / 实例） */
$('#fav-search').addEventListener('input', (e) => {
  favSearchKw = e.target.value;
  renderLocalList();
});

/* ======================= SQL 审核检测 ======================= */
$('#audit-instance').addEventListener('change', async (e) => {
  const dbSel = $('#audit-db');
  dbSel.innerHTML = '<option value="">选择库</option>';
  dbSel.disabled = true;
  if (!e.target.value) return;
  try {
    const res = await state.api.databases(e.target.value);
    if (res.status !== 0) throw new Error(res.msg);
    dbSel.innerHTML =
      '<option value="">选择库</option>' +
      (res.data || []).map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    dbSel.disabled = false;
  } catch (e2) {
    toast(`获取库列表失败：${e2.message}`, 'error');
  }
});

const ERRLEVEL_TAG = { 0: ['pass', '通过'], 1: ['yellow', '警告'], 2: ['red', '错误'] };
const STAGE_ZH = {
  CHECKED: '已审核', EXECUTED: '已执行', FINISHED: '已完成',
  'Execute Successfully': '执行成功', 'Audit Completed': '审核完成',
};

$('#audit-run').addEventListener('click', async () => {
  const instance = $('#audit-instance').value;
  const db = $('#audit-db').value;
  const sql = stripSyncMarks(auditEditor.value);
  if (!instance) return toast('请选择实例', 'error');
  if (!db) return toast('请选择数据库', 'error');
  if (!sql.trim()) return toast('请输入待检测的 SQL', 'error');
  const opt = $('#audit-instance').selectedOptions[0];
  const instanceId = opt?.dataset?.id;
  if (!instanceId) return toast('找不到实例 ID', 'error');

  const btn = $('#audit-run');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span>检测中…</span>';
  try {
    const res = await state.api.sqlCheck({ fullSql: sql, instanceId: Number(instanceId), dbName: db });
    const rows = res.rows || [];
    const summary = $('#audit-summary');
    summary.hidden = false;
    summary.replaceChildren(
      el(`<span class="stat pass"><b>${rows.filter((r) => r.errlevel === 0).length}</b> 通过</span>`),
      el(`<span class="stat warn"><b>${rows.filter((r) => r.errlevel === 1).length}</b> 警告</span>`),
      el(`<span class="stat err"><b>${rows.filter((r) => r.errlevel === 2).length}</b> 错误</span>`),
      el(`<span class="stat syntax">类型：${res.syntax_type === 1 ? 'DDL' : res.syntax_type === 2 ? 'DML' : '其他'}</span>`)
    );
    const table = $('#audit-table');
    table.innerHTML = '';
    table.appendChild(el(`<thead><tr><th style="width:44px">#</th><th>SQL 语句</th>
      <th style="width:90px" class="num">影响行数</th><th style="width:70px">级别</th><th>审核信息</th></tr></thead>`));
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const [cls, text] = ERRLEVEL_TAG[r.errlevel] || ['gray', '未知'];
      tbody.appendChild(el(`<tr>
        <td class="num">${r.id}</td>
        <td class="sql-cell">${escapeHtml(r.sql)}</td>
        <td class="num">${escapeHtml(String(r.affected_rows ?? ''))}</td>
        <td><span class="tag ${cls}">${text}</span></td>
        <td class="sql-cell">${escapeHtml(r.errormessage || (r.stagestatus ? STAGE_ZH[r.stagestatus] || r.stagestatus : '—'))}</td>
      </tr>`));
    }
    table.appendChild(tbody);
    toast(`检测完成：${res.error_count} 错误 / ${res.warning_count} 警告`, res.error_count > 0 ? 'error' : 'success');
    // 无错误时展示提单面板
    const panel = $('#submit-panel');
    if ((res.error_count ?? 0) === 0) {
      panel.hidden = false;
      try {
        const ctx = await state.api.submitContext();
        $('#wf-group').innerHTML =
          '<option value="">选择组</option>' +
          ctx.groups
            .map((g) => `<option value="${escapeHtml(g.groupId)}">${escapeHtml(g.groupName)}</option>`)
            .join('');
      } catch (e2) {
        toast(`获取资源组失败：${e2.message}`, 'error');
      }
    } else {
      panel.hidden = true;
    }
  } catch (e) {
    toast(`检测失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('shield')}<span>开始检测</span>`;
    mountIcons(btn);
  }
});



/* ======================= 表结构对比 ======================= */
async function bindDiffInstance(instSel, dbSel) {
  $(dbSel).innerHTML = '<option value="">选择库</option>';
  $(dbSel).disabled = true;
  const name = $(instSel).value;
  if (!name) return;
  try {
    const res = await state.api.databases(name);
    if (res.status !== 0) throw new Error(res.msg);
    $(dbSel).innerHTML =
      '<option value="">选择库</option>' +
      (res.data || []).map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');
    $(dbSel).disabled = false;
  } catch (e) {
    toast(`获取库列表失败：${e.message}`, 'error');
  }
}
$('#diff-instance-a').addEventListener('change', () => bindDiffInstance('#diff-instance-a', '#diff-db-a'));
$('#diff-instance-b').addEventListener('change', () => bindDiffInstance('#diff-instance-b', '#diff-db-b'));
async function loadDiffTableOptions(instanceSel, dbSel, tableSel) {
  const tSel = $(tableSel);
  const prev = tSel.value;
  tSel.innerHTML = '<option value="">选择表</option>';
  const instance = $(instanceSel).value;
  const db = $(dbSel).value;
  if (!instance || !db) return;
  try {
    const res = await state.api.tables(instance, db);
    if (res.status !== 0) return;
    const opts = (res.data || []).map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    tSel.innerHTML = '<option value="">选择表</option>' + opts;
    // 恢复之前选择或默认同名表
    if (prev && tSel.querySelector(`option[value="${CSS.escape(prev)}"]`)) setSelectValue(tSel, prev);
  } catch { /* 静默 */ }
}
$('#diff-db-a').addEventListener('change', () => loadDiffTableOptions('#diff-instance-a', '#diff-db-a', '#diff-table-a'));
$('#diff-db-b').addEventListener('change', () => {
  loadDiffTableOptions('#diff-instance-b', '#diff-db-b', '#diff-table-b');
  // B 侧默认同名表
  const ta = $('#diff-table-a').value;
  setTimeout(() => {
    setSelectValue('#diff-table-b', ta);
  }, 800);
});
$('#diff-table-a').addEventListener('change', () => {
  const ta = $('#diff-table-a').value;
  setSelectValue('#diff-table-b', ta);
});

/* ======================= 本地对比历史（可点击重新对比） ======================= */
const diffHistory = {
  items: [],
  async load() {
    try {
      const o = await chrome.storage.local.get({ 'diff-history': [] });
      this.items = o['diff-history'] || [];
    } catch { /* 内存态兜底 */ }
  },
  async save() {
    try {
      await chrome.storage.local.set({ 'diff-history': this.items });
    } catch { /* 静默 */ }
  },
  async record(entry) {
    const key = (e) => `${e.ia}|${e.da}|${e.ta}|${e.ib}|${e.db}|${e.tb}`;
    this.items = this.items.filter((e) => key(e) !== key(entry));
    this.items.unshift({ ...entry, at: Date.now() });
    if (this.items.length > 50) this.items.length = 50;
    await this.save();
  },
};

function renderDiffHistory() {
  const box = $('#diff-history');
  const list = $('#diff-history-list');
  if (!box || !diffHistory.items.length) {
    if (box) box.hidden = true;
    return;
  }
  box.hidden = false;
  list.replaceChildren();
  for (const e of diffHistory.items) {
    const chip = el(`<button class="diff-chip" title="${escapeHtml(`${e.ia}/${e.da}.${e.ta} ↔ ${e.ib}/${e.db}.${e.tb}`)}">
      <b>${escapeHtml(e.ta)}</b>
      <span class="dh-env">${escapeHtml(e.ia)}/${escapeHtml(e.da)} ↔ ${escapeHtml(e.ib)}/${escapeHtml(e.db)}</span>
      <span class="tag ${e.diffCount ? 'red' : 'green'}">${e.diffCount ? `差 ${e.diffCount}` : '一致'}</span>
      <span class="dh-time">${new Date(e.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
      <span class="dh-del" title="删除该条历史">${icon('close')}</span>
    </button>`);
    chip.addEventListener('click', (ev) => {
      if (ev.target.closest('.dh-del')) {
        diffHistory.items = diffHistory.items.filter((x) => x !== e);
        diffHistory.save();
        renderDiffHistory();
        return;
      }
      replayDiff(e);
    });
    list.appendChild(chip);
  }
}

/** 等待下拉出现指定 option（联动异步加载） */
function waitForOption(sel, value, timeout = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const s = $(sel);
      if (s?.querySelector(`option[value="${CSS.escape(String(value))}"]`)) return resolve(true);
      if (Date.now() - t0 > timeout) return resolve(false);
      setTimeout(tick, 120);
    };
    tick();
  });
}

/** 点击历史重放：回填两侧实例/库/表后自动对比 */
async function replayDiff(e) {
  switchView('diff');
  // A 侧
  if ($('#diff-instance-a').value !== e.ia) {
    setSelectValue('#diff-instance-a', e.ia); // change → bindDiffInstance 异步加载库
  }
  if (!(await waitForOption('#diff-db-a', e.da))) return toast(`A 侧库 ${e.da} 已不可见`, 'error');
  if ($('#diff-db-a').value !== e.da) setSelectValue('#diff-db-a', e.da); // change → 加载表
  if (!(await waitForOption('#diff-table-a', e.ta))) return toast(`A 侧表 ${e.ta} 已不可见`, 'error');
  setSelectValue('#diff-table-a', e.ta);
  // B 侧
  if ($('#diff-instance-b').value !== e.ib) {
    setSelectValue('#diff-instance-b', e.ib);
  }
  if (!(await waitForOption('#diff-db-b', e.db))) return toast(`B 侧库 ${e.db} 已不可见`, 'error');
  if ($('#diff-db-b').value !== e.db) setSelectValue('#diff-db-b', e.db);
  if (!(await waitForOption('#diff-table-b', e.tb))) return toast(`B 侧表 ${e.tb} 已不可见`, 'error');
  setSelectValue('#diff-table-b', e.tb);
  runTableDiff();
}

$('#diff-history-clear').addEventListener('click', async () => {
  diffHistory.items = [];
  await diffHistory.save();
  renderDiffHistory();
  toast('对比历史已清空', 'info');
});
diffHistory.load().then(renderDiffHistory);

/** 建表语句归一化：去除 AUTO_INCREMENT=N、多余空白，便于比对 */
function normalizeCreate(sql) {
  return String(sql || '')
    .replace(/AUTO_INCREMENT=\d+/gi, '')
    .replace(/DEFAULT\s+CHARSET=\w+/gi, '')
    .replace(/COLLATE=\w+/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*/g, '\n')
    .trim();
}

async function getCreateNormalized(instance, db, table) {
  try {
    const res = await state.api.describe(instance, db, table);
    if (res.status !== 0) return null;
    const raw = res.data?.rows?.[0]?.[1] || '';
    return { raw: raw.trim(), norm: normalizeCreate(raw) };
  } catch {
    return null;
  }
}

async function fetchDiffSides() {
  const ia = $('#diff-instance-a').value;
  const da = $('#diff-db-a').value;
  const ib = $('#diff-instance-b').value;
  const dbb = $('#diff-db-b').value;
  if (!ia || !da || !ib || !dbb) {
    toast('请先选择两侧的实例与库', 'error');
    return null;
  }
  const [ra, rb] = await Promise.all([state.api.tables(ia, da), state.api.tables(ib, dbb)]);
  if (ra.status !== 0 || rb.status !== 0) throw new Error(ra.msg || rb.msg || '读取表清单失败');
  return { ia, da, ib, db: dbb, listA: ra.data || [], listB: rb.data || [] };
}

/** 整库：仅对比表清单（2 个请求，不扫结构） */
async function runDiffList() {
  const btn = $('#diff-run');
  btn.disabled = true;
  $('#diff-summary').hidden = true;
  try {
    const s = await fetchDiffSides();
    if (!s) return;
    const setB = new Set(s.listB);
    const setA = new Set(s.listA);
    const rows = [];
    for (const t of s.listA) if (!setB.has(t)) rows.push({ table: t, status: 'only-a', a: '', b: '' });
    for (const t of s.listB) if (!setA.has(t)) rows.push({ table: t, status: 'only-b', a: '', b: '' });
    for (const t of s.listA) if (setB.has(t)) rows.push({ table: t, status: 'both', a: '', b: '' });
    rows.sort((x, y) => {
      const order = { 'only-a': 0, 'only-b': 1, both: 2, diff: 3, same: 4 };
      return order[x.status] - order[y.status] || x.table.localeCompare(y.table);
    });
    renderDiffTable(rows, s);
    const sum = $('#diff-summary');
    sum.hidden = false;
    const onlyA = rows.filter((r2) => r2.status === 'only-a').length;
    const onlyB = rows.filter((r2) => r2.status === 'only-b').length;
    const both = rows.filter((r2) => r2.status === 'both').length;
    sum.replaceChildren(
      el(`<span class="stat err"><b>${onlyA}</b> 仅 A 有</span>`),
      el(`<span class="stat"><b>${onlyB}</b> 仅 B 有</span>`),
      el(`<span class="stat warn"><b>${both}</b> 同名表（结构未比对）</span>`),
      el(`<span class="stat syntax">${escapeHtml(s.ia)}/${escapeHtml(s.da)} ↔ ${escapeHtml(s.ib)}/${escapeHtml(s.db)}</span>`)
    );
    toast(`清单对比完成：仅A ${onlyA} · 仅B ${onlyB} · 同名 ${both}`, 'success');
  } catch (e) {
    toast(`对比失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}
$('#diff-run').addEventListener('click', runDiffList);

/** 整库：深度对比全部同名表（逐表请求，用户显式触发） */
async function runDiffDeep() {
  const btn = $('#diff-deep');
  btn.disabled = true;
  $('#diff-progress').hidden = false;
  try {
    const s = await fetchDiffSides();
    if (!s) return;
    const both = s.listA.filter((t) => new Set(s.listB).has(t));
    const rows = [];
    for (const t of s.listA) if (!new Set(s.listB).has(t)) rows.push({ table: t, status: 'only-a', a: '', b: '' });
    for (const t of s.listB) if (!new Set(s.listA).has(t)) rows.push({ table: t, status: 'only-b', a: '', b: '' });
    let done = 0, diffCount = 0, sameCount = 0;
    for (const t of both) {
      done += 1;
      $('#diff-progress-text').textContent = `深度对比 ${done}/${both.length}：${t}`;
      const [ca, cb] = await Promise.all([
        getCreateNormalized(s.ia, s.da, t),
        getCreateNormalized(s.ib, s.db, t),
      ]);
      const same = ca && cb && ca.norm === cb.norm;
      if (same) sameCount += 1; else diffCount += 1;
      rows.push({ table: t, status: same ? 'same' : 'diff', a: ca?.raw || '', b: cb?.raw || '' });
      if (done % 10 === 0) {
        rows.sort((x, y) => {
          const order = { 'only-a': 0, 'only-b': 1, both: 2, diff: 3, same: 4 };
          return order[x.status] - order[y.status] || x.table.localeCompare(y.table);
        });
        renderDiffTable(rows, s);
        await new Promise((r2) => setTimeout(r2, 20));
      }
    }
    rows.sort((x, y) => {
      const order = { 'only-a': 0, 'only-b': 1, both: 2, diff: 3, same: 4 };
      return order[x.status] - order[y.status] || x.table.localeCompare(y.table);
    });
    renderDiffTable(rows, s);
    const sum = $('#diff-summary');
    sum.hidden = false;
    const onlyA = rows.filter((r2) => r2.status === 'only-a').length;
    const onlyB = rows.filter((r2) => r2.status === 'only-b').length;
    sum.replaceChildren(
      el(`<span class="stat err"><b>${onlyA + onlyB}</b> 仅单侧存在</span>`),
      el(`<span class="stat warn"><b>${diffCount}</b> 结构不同</span>`),
      el(`<span class="stat pass"><b>${sameCount}</b> 结构一致</span>`),
      el(`<span class="stat syntax">${escapeHtml(s.ia)}/${escapeHtml(s.da)} ↔ ${escapeHtml(s.ib)}/${escapeHtml(s.db)}</span>`)
    );
    toast(`深度对比完成：单侧 ${onlyA + onlyB} · 差异 ${diffCount} · 一致 ${sameCount}`, 'success');
  } catch (e) {
    toast(`深度对比失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    $('#diff-progress').hidden = true;
  }
}
$('#diff-deep').addEventListener('click', runDiffDeep);

const DIFF_STATUS = {
  'only-a': ['red', '仅 A 有'],
  'only-b': ['blue', '仅 B 有'],
  both: ['gray', '同名（未比对）'],
  diff: ['yellow', '结构不同'],
  same: ['green', '一致'],
};

function renderDiffTable(rows, env) {
  const table = $('#diff-table');
  const empty = $('#diff-empty');
  prepareTable(table);
  if (empty) empty.hidden = true;
  table.appendChild(el(`<thead><tr>
    <th>表名</th><th style="width:110px">状态</th>
    <th>A 端建表（${escapeHtml(env.ia)}/${escapeHtml(env.da)}）</th>
    <th>B 端建表（${escapeHtml(env.ib)}/${escapeHtml(env.db)}）</th>
    <th style="width:80px">操作</th>
  </tr></thead>`));
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const [cls, text] = DIFF_STATUS[row.status];
    const tr = el(`<tr>
      <td class="sql-cell">${escapeHtml(row.table)}</td>
      <td><span class="tag ${cls}">${text}</span></td>
      <td class="diff-cell-sql">${escapeHtml(row.a ? row.a.slice(0, 300) : '—')}</td>
      <td class="diff-cell-sql">${escapeHtml(row.b ? row.b.slice(0, 300) : '—')}</td>
      <td>${row.status === 'diff' ? `<button class="button small" data-act="detail">Diff</button>` : ''}</td>
    </tr>`);
    const detailBtn = tr.querySelector('[data-act="detail"]');
    if (detailBtn) {
      detailBtn.addEventListener('click', () => {
        showSideBySide(row.table, row.table, row.a, row.b, `${env.ia}/${env.da}`, `${env.ib}/${env.db}`);
      });
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
}
/* ======================= 容量与事务诊断 ======================= */
function fmtSize(kb) {
  const n = Number(kb) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024) return (n / 1024).toFixed(2) + ' MB';
  return n.toFixed(0) + ' KB';
}
function fmtNum(n) {
  return Number(n ?? 0).toLocaleString('zh-CN');
}

async function runDiag({ trxOnly = false } = {}) {
  const instance = $('#diag-instance').value;
  if (!instance) return toast('请选择实例', 'error');
  const btn = $('#diag-run');
  btn.disabled = !trxOnly;
  try {
    if (!trxOnly) {
      const res = await state.api.tablespace(instance);
      if (res.status !== 0) throw new Error(res.msg || '获取表空间失败（可能需要更高权限）');
      const rows = (res.rows || []).map((r2) => ({
        ...r2,
        total: Number(r2.total_size) || 0,
        rowsN: Number(r2.table_rows) || 0,
        data: Number(r2.data_size) || 0,
        index: Number(r2.index_size) || 0,
      }));
      rows.sort((a, b) => b.total - a.total);
      const totalSize = rows.reduce((s, r2) => s + r2.total, 0);
      const totalRows = rows.reduce((s, r2) => s + r2.rowsN, 0);
      const byDb = new Map();
      for (const r2 of rows) byDb.set(r2.table_schema, (byDb.get(r2.table_schema) || 0) + r2.total);
      const topDb = [...byDb.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      const sum = $('#diag-summary');
      sum.hidden = false;
      sum.replaceChildren(
        el(`<span class="stat pass"><b>${fmtSize(totalSize)}</b> 总大小</span>`),
        el(`<span class="stat warn"><b>${fmtNum(totalRows)}</b> 总行数</span>`),
        el(`<span class="stat"><b>${rows.length}</b> 张表</span>`),
        el(
          `<span class="stat syntax">Top 库：${topDb.map(([d, s]) => `${escapeHtml(d)} ${fmtSize(s)}`).join(' · ')}</span>`
        )
      );
      const table = $('#space-table');
      table.innerHTML = '';
      table.appendChild(el(`<thead><tr><th>库</th><th>表</th><th>引擎</th>
        <th class="num">总大小</th><th class="num">行数</th><th class="num">数据</th><th class="num">索引</th></tr></thead>`));
      const tbody = document.createElement('tbody');
      for (const r2 of rows.slice(0, 300)) {
        tbody.appendChild(el(`<tr>
          <td>${escapeHtml(r2.table_schema)}</td>
          <td class="sql-cell">${escapeHtml(r2.table_name)}</td>
          <td>${escapeHtml(r2.engine || '')}</td>
          <td class="num"><b>${fmtSize(r2.total)}</b></td>
          <td class="num">${fmtNum(r2.rowsN)}</td>
          <td class="num">${fmtSize(r2.data)}</td>
          <td class="num">${fmtSize(r2.index)}</td>
        </tr>`));
      }
      table.appendChild(tbody);
    }
    await renderTrx(instance);
  } catch (e) {
    toast(`诊断失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function renderTrx(instance) {
  const table = $('#trx-table');
  try {
    const res = await state.api.innodbTrx(instance);
    const rows = res.rows || [];
    table.innerHTML = '';
    table.appendChild(el(`<thead><tr><th style="width:170px">开始时间</th><th style="width:90px">状态</th>
      <th class="num" style="width:80px">锁定行</th><th>当前 SQL</th></tr></thead>`));
    const tbody = document.createElement('tbody');
    const now = Date.now();
    for (const t of rows) {
      const startedMs = t.trx_started ? new Date(String(t.trx_started).replace(' ', 'T') + 'Z').getTime() : NaN;
      const ageSec = isNaN(startedMs) ? null : Math.round((now - startedMs) / 1000);
      const long = ageSec !== null && ageSec > 60;
      tbody.appendChild(el(`<tr>
        <td>${escapeHtml(String(t.trx_started || ''))}${ageSec !== null ? ` <span class="tag ${long ? 'red' : 'gray'}">${ageSec}s</span>` : ''}</td>
        <td>${escapeHtml(String(t.trx_state || ''))}</td>
        <td class="num">${fmtNum(t.trx_rows_locked)}</td>
        <td class="sql-cell">${escapeHtml(String(t.trx_query || '').slice(0, 200))}</td>
      </tr>`));
    }
    table.appendChild(tbody);
    if (!rows.length) {
      table.appendChild(el(`<tbody><tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:18px">当前没有活跃 InnoDB 事务</td></tr></tbody>`));
    }
  } catch (e) {
    table.innerHTML = '';
    table.appendChild(el(`<tbody><tr><td style="color:var(--danger);padding:12px">事务查询失败：${escapeHtml(e.message)}</td></tr></tbody>`));
  }
}

$('#diag-run').addEventListener('click', () => runDiag());
$('#diag-refresh-trx').addEventListener('click', () => runDiag({ trxOnly: true }));

/* ---------- 单表字段级对比 ---------- */

/** 解析建表语句 → 字段定义表 Map<字段名, 定义行(不含首尾逗号)> */
function parseCreateColumns(createSql) {
  const cols = new Map();
  const body = String(createSql || '').replace(/\r/g, '');
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    if (!line || /^CREATE TABLE/i.test(line) || /^\)/.test(line) || /^ENGINE/i.test(line) || /^DEFAULT/i.test(line) || /^COLLATE/i.test(line) || /^COMMENT=/i.test(line) || /^AUTO_INCREMENT/i.test(line) || /^ROW_FORMAT/i.test(line)) continue;
    const m = line.match(/^`?(\w+)`?\s+(.+)$/);
    if (!m) continue;
    const kw = m[1].toUpperCase();
    if (['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FOREIGN', 'FULLTEXT', 'SPATIAL'].includes(kw)) continue;
    cols.set(m[1], m[2].trim());
  }
  return cols;
}

async function runTableDiff() {
  const ia = $('#diff-instance-a').value;
  const da = $('#diff-db-a').value;
  const ib = $('#diff-instance-b').value;
  const dbb = $('#diff-db-b').value;
  const ta = $('#diff-table-a').value;
  let tb = $('#diff-table-b').value;
  if (!ia || !da || !ib || !dbb) return toast('请先选择两侧的实例与库', 'error');
  if (!ta) return toast('请选择表 A', 'error');
  if (!tb) tb = ta; // 默认同名表
  const btn = $('#diff-table-run');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span>对比中…</span>';
  try {
    const [ca, cb] = await Promise.all([
      getCreateNormalized(ia, da, ta),
      getCreateNormalized(ib, dbb, tb),
    ]);
    if (!ca || !cb) throw new Error('任一侧建表语句获取失败（表不存在或无权限）');
    const rows = computeFieldDiff(ca.raw, cb.raw).map((r2) => ({ ...r2, status: r2.tag[1] }));
    const diffCount = rows.filter((r2) => r2.status !== 'same').length;

    const wrap = $('#diff-field-wrap');
    const table = $('#diff-field-table');
    wrap.hidden = false;
    table.innerHTML = '';
    table.appendChild(el(`<thead><tr><th>字段</th><th style="width:76px">状态</th>
      <th>A：${escapeHtml(ia)}/${escapeHtml(da)}.${escapeHtml(ta)}</th>
      <th>B：${escapeHtml(ib)}/${escapeHtml(dbb)}.${escapeHtml(tb)}</th></tr></thead>`));
    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = el(`<tr>
        <td class="sql-cell"><b>${escapeHtml(row.name)}</b></td>
        <td><span class="tag ${row.tag[0]}">${row.tag[1]}</span></td>
        <td class="sql-cell" style="${row.status === 'only-b' ? 'color:var(--text-3)' : ''}">${escapeHtml(row.a ?? '—')}</td>
        <td class="sql-cell" style="${row.status === 'only-a' ? 'color:var(--text-3)' : ''}">${escapeHtml(row.b ?? '—')}</td>
      </tr>`);
      tbody.appendChild(tr);
    }
    if (!rows.length) tbody.appendChild(el(`<tr><td colspan="4" style="text-align:center;color:var(--text-3);padding:14px">两侧均未解析出字段</td></tr>`));
    table.appendChild(tbody);
    // 底部附建表语句对比入口（吸底固定，滚动时始终可见）
    const foot = el(`<tr><td colspan="4" class="diff-foot-cell"><button class="button small" id="diff-open-side">${icon('eye')} 查看完整建表语句</button></td></tr>`);
    tbody.appendChild(foot);
    tbody.querySelector('#diff-open-side').addEventListener('click', () => showSideBySide(ta, tb, ca.raw, cb.raw, `${ia}/${da}`, `${ib}/${dbb}`));
    toast(diffCount ? `字段级差异 ${diffCount} 项（共 ${rows.length} 字段）` : '两张表字段完全一致', diffCount ? 'info' : 'success');
    // 记入本地对比历史（相同参数覆盖置顶）
    diffHistory.record({ ia, da, ta, ib, db: dbb, tb, diffCount, total: rows.length });
    renderDiffHistory();
  } catch (e) {
    toast(`单表对比失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('table')}<span>对比选中表（字段级）</span>`;
    mountIcons(btn);
  }
}
$('#diff-table-run').addEventListener('click', runTableDiff);

/** 字段级差异计算（弹窗与单表对比共用） */
function computeFieldDiff(sqlA, sqlB) {
  const colsA = parseCreateColumns(sqlA);
  const colsB = parseCreateColumns(sqlB);
  const all = [...new Set([...colsA.keys(), ...colsB.keys()])].sort();
  return all.map((name) => {
    const a = colsA.get(name);
    const b = colsB.get(name);
    let tag;
    if (a && !b) tag = ['red', '仅 A 有'];
    else if (!a && b) tag = ['blue', '仅 B 有'];
    else if (a !== b) tag = ['yellow', '定义不同'];
    else tag = ['green', '一致'];
    return { name, a, b, tag };
  });
}

/** 行级对齐：公共行对齐（LCS），同名首 token 的差异行（如同字段不同定义）也配成对 */
function diffAlignLines(a, b) {
  const ka = a.map((l) => l.trim());
  const kb = b.map((l) => l.trim());
  const n = ka.length, m = kb.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { out.push({ a: i, b: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ a: i, b: null }); i++; }
    else { out.push({ a: null, b: j }); j++; }
  }
  while (i < n) out.push({ a: i++, b: null });
  while (j < m) out.push({ a: null, b: j++ });
  // 二次配对：仅 A 行与仅 B 行首 token 相同（如 `name` 字段定义不同）→ 合并为同行差异
  const firstToken = (line) => line.trim().match(/^`([^`]+)`/)?.[1] || null;
  const bUsed = new Set();
  const matchOf = new Map();
  for (const p of out) {
    if (p.a === null || p.b !== null) continue;
    const key = firstToken(a[p.a]);
    if (!key) continue;
    const hit = out.find((q) => q.a === null && q.b !== null && !bUsed.has(q.b) && firstToken(b[q.b]) === key);
    if (hit) {
      bUsed.add(hit.b);
      matchOf.set(p.a, hit.b);
    }
  }
  if (!matchOf.size) return out;
  return out
    .filter((p) => !(p.a === null && bUsed.has(p.b)))
    .map((p) => (p.b === null && matchOf.has(p.a) ? { a: p.a, b: matchOf.get(p.a) } : p));
}

/** 对比弹窗：建表语句（单一行对齐视图）⇄ 字段表格，一键切换 */
function showSideBySide(nameA, nameB, sqlA, sqlB, envA, envB) {
  const body = document.createElement('div');
  // 切换按钮组
  const switcher = document.createElement('div');
  switcher.className = 'setting-actions';
  switcher.style.justifyContent = 'flex-start';
  const mkBtn = (label) => el(`<button class="button small">${label}</button>`);
  const btnSql = mkBtn('建表语句对比');
  const btnGrid = mkBtn('字段表格对比');
  btnSql.classList.add('primary');
  const sqlView = document.createElement('div');
  const gridView = document.createElement('div');
  gridView.hidden = true;

  const renderSql = () => {
    sqlView.replaceChildren();
    const la = String(sqlA || '').replace(/\r/g, '').split('\n');
    const lb = String(sqlB || '').replace(/\r/g, '').split('\n');
    const head = el(`<div class="du-head"><span>A · ${escapeHtml(nameA)}（${escapeHtml(envA)}，<i class="lg-a">红=仅A有</i> <i class="lg-c">黄=定义不同</i>）</span><span>B · ${escapeHtml(nameB)}（${escapeHtml(envB)}，<i class="lg-b">蓝=仅B有</i>）</span></div>`);
    const grid = el('<div class="du-grid"></div>');
    for (const p of diffAlignLines(la, lb)) {
      const changed = p.a !== null && p.b !== null && la[p.a].trim() !== lb[p.b].trim();
      const ca = el(`<div class="du-cell${p.a === null ? ' du-empty' : p.b === null ? ' du-only-a' : changed ? ' du-changed' : ''}">${p.a === null ? '' : escapeHtml(la[p.a])}</div>`);
      const cb = el(`<div class="du-cell${p.b === null ? ' du-empty' : p.a === null ? ' du-only-b' : changed ? ' du-changed' : ''}">${p.b === null ? '' : escapeHtml(lb[p.b])}</div>`);
      grid.append(ca, cb);
    }
    sqlView.append(head, grid);
  };
  const renderGrid = () => {
    gridView.replaceChildren();
    const rows = computeFieldDiff(sqlA, sqlB);
    const t = document.createElement('table');
    t.className = 'data-table';
    t.innerHTML =
      `<thead><tr><th>字段</th><th style="width:80px">状态</th><th>A：${escapeHtml(nameA)}</th><th>B：${escapeHtml(nameB)}</th></tr></thead>` +
      `<tbody>${rows
        .map(
          (r2) => `<tr><td class="sql-cell"><b>${escapeHtml(r2.name)}</b></td>
          <td><span class="tag ${r2.tag[0]}">${r2.tag[1]}</span></td>
          <td class="sql-cell">${escapeHtml(r2.a ?? '—')}</td>
          <td class="sql-cell">${escapeHtml(r2.b ?? '—')}</td></tr>`
        )
        .join('')}</tbody>`;
    gridView.appendChild(t);
  };
  renderSql();
  renderGrid();
  const activate = (which) => {
    const sqlMode = which === 'sql';
    sqlView.hidden = !sqlMode;
    gridView.hidden = sqlMode;
    btnSql.classList.toggle('primary', sqlMode);
    btnGrid.classList.toggle('primary', !sqlMode);
  };
  btnSql.addEventListener('click', () => activate('sql'));
  btnGrid.addEventListener('click', () => activate('grid'));
  switcher.append(btnSql, btnGrid);
  body.append(switcher, sqlView, gridView);
  openModal(`对比 · ${nameA} ↔ ${nameB}`, body, { wide: true });
}


/* ======================= 提交上线工单 ======================= */
$('#wf-submit-btn').addEventListener('click', async () => {
  const btn = $('#wf-submit-btn');
  const instance = $('#audit-instance').value;
  const db = $('#audit-db').value;
  const workflowName = $('#wf-name').value.trim();
  const groupId = $('#wf-group').value;
  if (!workflowName) return toast('请填写工单名称', 'error');
  if (!groupId) return toast('请选择资源组', 'error');
  const opt = $(`#audit-instance option[value="${CSS.escape(instance)}"]`);
  const instanceId = opt?.dataset?.id;
  if (!instanceId) return toast('找不到实例 ID', 'error');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span><span>提交中…</span>';
  try {
    await state.api.submitWorkflow({
      sqlContent: auditEditor.value,
      groupId,
      instanceId,
      dbName: db,
      workflowName,
      isBackup: $('#wf-backup').value === 'true',
    });
    toast('工单已提交，等待审核', 'success');
    $('#submit-panel').hidden = true;
    switchView('workflow');
    state.workflow.page = 1;
    loadWorkflows();
  } catch (e) {
    // DRF 校验错误：{errors: ...} 已在 message 中
    toast(`提交失败：${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${icon('arrow')}<span>提交工单</span>`;
    mountIcons(btn);
  }
});

/* ======================= 上线工单 ======================= */
const WF_STATUS = {
  workflow_finish: ['green', '已正常结束'],
  workflow_executing: ['blue', '执行中'],
  workflow_queuing: ['blue', '排队中'],
  workflow_timing_task: ['teal', '定时执行'],
  workflow_manreviewing: ['yellow', '等待审核人审核'],
  workflow_review_pass: ['teal', '审核通过'],
  workflow_abort: ['gray', '人工终止流程'],
  workflow_autoreviewwrong: ['red', '自动审核不通过'],
  workflow_exception: ['red', '执行有异常'],
};
const SYNTAX_NAME = { 0: '其他', 1: 'DDL', 2: 'DML', 3: 'DQL' };

async function loadWorkflows() {
  const w = state.workflow;
  const limit = 20;
  $('#wf-summary').textContent = '加载中…';
  try {
    const res = await state.api.workflowList({
      limit,
      offset: (w.page - 1) * limit,
      search: w.search,
    });
    const table = $('#wf-table');
    prepareTable(table);
    if (!(res.rows || []).length) {
      renderListEmpty(table, {
        iconName: 'flow',
        title: '还没有上线工单',
        hint: '在「检测」页审核通过后可直接提交上线工单',
      });
      w.total = res.total || 0;
      $('#wf-summary').textContent = `共 ${w.total} 条`;
      renderPager($('#wf-pager'), w.page, Math.max(1, Math.ceil(w.total / 20)), (p) => {
        w.page = p;
        loadWorkflows();
      });
      return;
    }
    table.appendChild(el(`<thead><tr><th style="width:80px">工单号</th><th>工单名称</th>
      <th style="width:52px">类型</th><th style="width:80px">发起人</th><th style="width:120px">状态</th>
      <th style="width:64px">备份</th><th style="width:140px">发起时间</th><th style="width:160px">实例 / 库</th>
      <th style="width:90px">操作</th></tr></thead>`));
    const tbody = document.createElement('tbody');
    for (const r of res.rows || []) {
      const [cls, text] = WF_STATUS[r.status] || ['gray', r.status];
      const tr = el(`<tr data-id="${r.id}">
        <td>${r.id}</td>
        <td><span class="link">${escapeHtml(r.workflow_name)}</span></td>
        <td>${SYNTAX_NAME[r.syntax_type] || r.syntax_type}</td>
        <td>${escapeHtml(r.engineer_display)}</td>
        <td><span class="tag ${cls}">${text}</span></td>
        <td>${r.is_backup ? '是' : '否'}</td>
        <td>${escapeHtml(r.create_time)}</td>
        <td title="${escapeHtml(r.group_name || '')}">${escapeHtml(r['instance__instance_name'])}<br><span style="color:var(--text-3)">${escapeHtml(r.db_name)}</span></td>
        <td><button class="button small" data-act="detail">详情</button></td>
      </tr>`);
      tr.querySelector('[data-act="detail"]').addEventListener('click', () => openWorkflowDetail(r));
      tr.querySelector('.link').addEventListener('click', () => openWorkflowDetail(r));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    w.total = res.total || 0;
    $('#wf-summary').textContent = `共 ${w.total} 条`;
    renderPager($('#wf-pager'), w.page, Math.max(1, Math.ceil(w.total / limit)), (p) => {
      w.page = p;
      loadWorkflows();
    });
  } catch (e) {
    $('#wf-summary').textContent = `加载失败：${e.message}`;
    renderListEmpty($('#wf-table'), {
      iconName: 'alert',
      title: '工单加载失败',
      hint: e.message || '请检查 Archery 地址与登录状态后重试',
    });
  }
}
bindSearch('#wf-search', state.workflow, loadWorkflows);
$('#wf-refresh').addEventListener('click', loadWorkflows);

async function openWorkflowDetail(r) {
  const box = $('#wf-detail');
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth' });
  box.replaceChildren(el(`<div class="tree-empty">加载中…</div>`));
  try {
    const [detail, backup] = await Promise.all([
      state.api.workflowDetail(r.id),
      state.api.workflowBackup(r.id).catch(() => null),
    ]);
    const [cls, text] = WF_STATUS[r.status] || ['gray', r.status];
    const head = el(`<div class="wf-detail-head">
      <h3>#${r.id} ${escapeHtml(r.workflow_name)}</h3>
      <span class="tag ${cls}">${text}</span>
      <span class="tag gray">${SYNTAX_NAME[r.syntax_type] || ''}</span>
      <span style="color:var(--text-3)">发起人 ${escapeHtml(r.engineer_display)} · ${escapeHtml(r.create_time)} · ${escapeHtml(r['instance__instance_name'])} / ${escapeHtml(r.db_name)}</span>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button class="button small" id="wf-copy-all">复制全部 SQL</button>
        ${backup?.rows?.length ? `<button class="button small" id="wf-dl-backup">${icon('rollback')} 下载回滚语句</button>` : ''}
        <button class="icon-button" id="wf-close-detail" title="收起">${icon('close')}</button>
      </span>
    </div>`);
    box.replaceChildren(head);
    const sqlList = document.createElement('div');
    sqlList.style.display = 'flex';
    sqlList.style.flexDirection = 'column';
    sqlList.style.gap = '8px';
    sqlList.style.overflow = 'auto';
    for (const item of detail.rows || []) {
      const [lvCls, lvText] = ERRLEVEL_TAG[item.errlevel] || ['gray', ''];
      const ok = /Success/i.test(item.stagestatus || '');
      sqlList.appendChild(el(`<div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:3px">
          <span class="tag ${ok ? 'green' : item.errlevel > 0 ? 'red' : 'gray'}">${ok ? '执行成功' : escapeHtml(item.stagestatus || item.stage)}</span>
          ${item.errormessage ? `<span class="tag red" title="${escapeHtml(item.errormessage)}">${escapeHtml(item.errormessage.slice(0, 80))}</span>` : ''}
          <span style="color:var(--text-3);font-size:11px">影响 ${escapeHtml(String(item.actual_affected_rows ?? item.affected_rows ?? 0))} 行</span>
        </div>
        <div class="wf-sql">${escapeHtml(item.sql)}</div>
      </div>`));
    }
    box.appendChild(sqlList);
    $('#wf-copy-all').addEventListener('click', () => {
      navigator.clipboard.writeText((detail.rows || []).map((x) => x.sql + ';').join('\n'));
      toast('已复制全部 SQL', 'success');
    });
    const dl = box.querySelector('#wf-dl-backup');
    if (dl) dl.addEventListener('click', () => {
      const sqls = (backup.rows || []).map((x) => x[0]).join('\n\n');
      download(`rollback-${r.id}.sql`, sqls);
    });
    box.querySelector('#wf-close-detail').addEventListener('click', () => (box.hidden = true));

    // 审批与执行操作（无权限时接口会明确报错）
    const actions = document.createElement('div');
    actions.className = 'wf-detail-actions';
    const mkBtn = (label, cls, fn) => {
      const b = el(`<button class="button small ${cls}">${label}</button>`);
      b.addEventListener('click', fn);
      actions.appendChild(b);
    };
    if (r.status === 'workflow_manreviewing') {
      mkBtn('审核通过', 'primary', async (e) => {
        e.target.disabled = true;
        try {
          await state.api.auditWorkflow({ workflowId: r.id, auditType: 'pass', auditRemark: '' });
          toast('已通过审核', 'success');
          loadWorkflows();
          openWorkflowDetail(r);
        } catch (err) {
          toast(`操作失败：${err.message}`, 'error');
          e.target.disabled = false;
        }
      });
      mkBtn('驳回', '', async (e) => {
        const remark = await promptText('驳回原因：');
        if (remark === null) return;
        e.target.disabled = true;
        try {
          await state.api.auditWorkflow({ workflowId: r.id, auditType: 'cancel', auditRemark: remark });
          toast('已驳回', 'success');
          loadWorkflows();
          box.hidden = true;
        } catch (err) {
          toast(`操作失败：${err.message}`, 'error');
          e.target.disabled = false;
        }
      });
    }
    if (r.status === 'workflow_review_pass') {
      mkBtn('立即执行', 'primary', async (e) => {
        if (!state.cfg.username) {
          return toast('执行操作需要账号信息：请在扩展弹窗或设置中保存一次账号密码', 'error');
        }
        e.target.disabled = true;
        try {
          await state.api.executeWorkflow({ workflowId: r.id, engineer: state.cfg.username });
          toast('已发起执行', 'success');
          loadWorkflows();
          box.hidden = true;
        } catch (err) {
          toast(`执行失败：${err.message}`, 'error');
          e.target.disabled = false;
        }
      });
    }
    if (['workflow_manreviewing', 'workflow_review_pass', 'workflow_timing_task', 'workflow_queuing'].includes(r.status)) {
      mkBtn('终止流程', '', async (e) => {
        const remark = await promptText('终止原因（必填）：');
        if (remark === null || !remark.trim()) return;
        e.target.disabled = true;
        try {
          await state.api.auditWorkflow({ workflowId: r.id, auditType: 'cancel', auditRemark: remark });
          toast('已终止', 'success');
          loadWorkflows();
          box.hidden = true;
        } catch (err) {
          toast(`操作失败：${err.message}`, 'error');
          e.target.disabled = false;
        }
      });
    }
    if (actions.children.length) box.appendChild(actions);
  } catch (e) {
    box.replaceChildren(el(`<div class="tree-empty">${escapeHtml(e.message)}</div>`));
  }
}

/* ======================= 草稿自动保存 ======================= */
let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 400);
}
function saveDraftNow() {
  const cur = queryTabs.list.find((t) => t.id === queryTabs.activeId);
  if (cur) cur.sql = editor.value;
  localStorage.setItem(
    'archery-draft',
    JSON.stringify({
      tabs: queryTabs.list.map((t) => ({ id: t.id, title: t.title, sql: t.sql })),
      activeTab: queryTabs.activeId,
      tabSeq: queryTabs.seq,
      instance: $('#instance-name').value,
      db: $('#db-name').value,
      schema: $('#schema-name').value,
      limit: $('#limit-num').value,
    })
  );
}
// 关闭/刷新页面前立即落盘，防止防抖窗口内的最后一次输入丢失
window.addEventListener('beforeunload', () => {
  if (autoCache.on) {
    clearTimeout(draftTimer);
    saveDraftNow();
  }
});
async function restoreDraft() {
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem('archery-draft') || 'null');
  } catch {
    draft = null;
  }
  if (!draft) return;
  // 恢复查询标签集（兼容旧版单草稿）
  if (Array.isArray(draft.tabs) && draft.tabs.length) {
    queryTabs.list = draft.tabs;
    queryTabs.seq = Math.max(draft.tabSeq || 0, ...draft.tabs.map((t) => t.id));
    const active = draft.tabs.find((t) => t.id === draft.activeTab) || draft.tabs[0];
    queryTabs.activeId = active.id;
    editor.setValue(active.sql || '');
    renderQueryTabs();
  } else {
    newQueryTab(draft.sql || '');
  }
  if (draft.limit) $('#limit-num').value = draft.limit;
  if (draft.instance && $('#instance-name').querySelector(`option[value="${CSS.escape(draft.instance)}"]`)) {
    await selectInstance(draft.instance);
    if (draft.db && $('#db-name').querySelector(`option[value="${CSS.escape(draft.db)}"]`)) {
      setSelectValue('#db-name', draft.db); // change 监听负责 state/草稿/预载表/树高亮
      const ins = state.instances.find((i) => i.instance_name === draft.instance);
      if (ins?.db_type === 'pgsql') {
        await loadSchemas();
        if (draft.schema && $('#schema-name').querySelector(`option[value="${CSS.escape(draft.schema)}"]`)) {
          setSelectValue('#schema-name', draft.schema);
        }
      }
    }
  }
  // 恢复完成后立刻把完整状态写回草稿：恢复过程中 onInstanceChange 的防抖保存
  // 可能已把空库写进草稿，若此时用户直接刷新会丢掉已选实例/库
  saveDraft();
}

/* ======================= 命令面板（Ctrl+K） ======================= */
const palette = { open: false, items: [], index: 0 };

/** 从索引命中跳转：切实例/库后查看表结构 */
async function jumpToTable(instance, db, table) {
  switchView('query');
  const insSel = $('#instance-name');
  if (instance && [...insSel.options].some((o) => o.value === instance) && insSel.value !== instance) {
    setSelectValue(insSel, instance);
    await onInstanceChange(instance);
  }
  const dbSel = $('#db-name');
  if (db && [...dbSel.options].some((o) => o.value === db) && dbSel.value !== db) {
    setSelectValue(dbSel, db);
    preloadTables();
  }
  describeTable(instance, db, table);
}

function paletteActions() {
  return [
    { group: '功能', icon: 'code', label: 'SQL 工作台', sub: '查询', run: () => switchView('query') },
    { group: '功能', icon: 'history', label: '查询历史', run: () => switchView('history') },
    { group: '功能', icon: 'star', label: 'SQL 收藏', run: () => switchView('favorites') },
    { group: '功能', icon: 'shield', label: 'SQL 审核检测', run: () => switchView('audit') },
    { group: '功能', icon: 'flow', label: '上线工单', run: () => switchView('workflow') },
    { group: '功能', icon: 'rollback', label: '表结构对比', run: () => switchView('diff') },
    { group: '功能', icon: 'alert', label: '容量与事务诊断', run: () => switchView('diag') },
    { group: '功能', icon: 'sun', label: '切换深浅主题', run: () => $('#theme-toggle').click() },
    { group: '功能', icon: 'settings', label: '设置', run: () => $('#settings-open').click() },
    { group: '功能', icon: 'refresh', label: '重新连接', run: () => connect() },
    indexBuilding
      ? { group: '功能', icon: 'alert', label: '索引重建中，请勿重复拉取', sub: '进度见数据浏览器', run: () => { setIndexProgress(true); toast(`索引重建进行中（${$('#index-progress-text')?.textContent || '进行中'}），请勿重复拉取`, 'error'); } }
      : { group: '功能', icon: 'search', label: '重构搜索索引', sub: '重资源操作，无搜索需求不建议使用', run: () => confirmRebuildIndex() },
  ];
}

/** 根据关键字收集候选（功能/实例/库/表/历史） */
function paletteCandidates(kw) {
  const lower = kw.toLowerCase();
  const match = (t) => !kw || t.toLowerCase().includes(lower);
  const out = [...paletteActions()];
  // 实例
  for (const ins of state.instances) {
    if (match(ins.instance_name)) {
      out.push({
        group: '实例',
        icon: 'database',
        label: ins.instance_name,
        sub: ins.db_type,
        mono: true,
        run: () => {
          switchView('query');
          selectInstance(ins.instance_name);
        },
      });
    }
  }
  // 当前实例的库
  for (const db of state.dbs) {
    if (match(db)) {
      out.push({
        group: '库（当前实例）',
        icon: 'folder',
        label: db,
        mono: true,
        sub: state.current.instance,
        run: () => {
          switchView('query');
          if ($('#db-name').querySelector(`option[value="${CSS.escape(db)}"]`)) {
            setSelectValue('#db-name', db); // change 监听负责 state/草稿/预载表/树高亮
          }
        },
      });
    }
  }
  // 当前库的表（已加载）
  for (const t of currentTables) {
    if (match(t)) {
      out.push({
        group: '表（当前库）',
        icon: 'table',
        label: t,
        mono: true,
        sub: '查看结构',
        run: () => {
          switchView('query');
          describeTable(state.current.instance, state.current.db, t);
        },
      });
    }
  }
  // 索引搜索：全库的表名（关键字 ≥2 字才遍历索引，限量输出；字段搜索走侧边栏「字段」模式）
  if (kw.length >= 2) {
    const hits = [];
    const seen = new Set();
    for (const entry of Object.values(metaIndex.data.dbs)) {
      if (hits.length >= 15) break;
      const env = `${entry.instance}/${entry.db}`;
      for (const tb of entry.tables || []) {
        if (match(tb) && !seen.has(env + tb) && hits.length < 15) {
          seen.add(env + tb);
          hits.push({
            group: '表（索引）',
            icon: 'table',
            label: tb,
            mono: true,
            sub: env,
            run: () => jumpToTable(entry.instance, entry.db, tb),
          });
        }
      }
    }
    out.push(...hits);
  }
  // 本地最近执行（草稿 tab + 最近结果 SQL）
  const recent = [
    ...queryTabs.list.map((t) => ({ sql: t.sql, sub: t.title || `查询 ${t.id}` })),
    ...[...state.results].reverse().filter((r) => r.kind === 'query').map((r) => ({ sql: r.sql, sub: r.target })),
  ];
  const seen = new Set();
  for (const item of recent) {
    if (!item.sql || seen.has(item.sql)) continue;
    seen.add(item.sql);
    if (match(item.sql)) {
      out.push({
        group: '最近 SQL',
        icon: 'code',
        label: item.sql.replace(/\s+/g, ' ').slice(0, 60),
        mono: true,
        sub: item.sub,
        run: () => {
          switchView('query');
          editor.setValue(item.sql, true);
        },
      });
    }
    if (out.filter((x) => x.group === '最近 SQL').length >= 6) break;
  }
  const matched = out.filter((x) => match(x.label));
  // 搜索时按「匹配位置优先、更短的名字优先」全局排序（输入 staff 时 staff 排在 astaff 前），平铺不显示分组标题
  palette.flat = !!lower;
  if (lower) {
    matched.sort((a, b) => {
      const ra = a.label.toLowerCase().indexOf(lower);
      const rb = b.label.toLowerCase().indexOf(lower);
      return ra - rb || a.label.length - b.label.length;
    });
  }
  return matched.slice(0, 40);
}

function renderPalette() {
  const list = $('#palette-list');
  list.replaceChildren();
  let lastGroup = null;
  if (!palette.items.length) {
    list.appendChild(el(`<div class="palette-empty">没有匹配的结果</div>`));
    return;
  }
  palette.items.forEach((item, idx) => {
    if (!palette.flat && item.group !== lastGroup) {
      list.appendChild(el(`<div class="palette-group">${escapeHtml(item.group)}</div>`));
      lastGroup = item.group;
    }
    // 命中片段高亮（搜索时）
    const q = palette.query || '';
    let labelHtml = escapeHtml(item.label);
    if (q) {
      const hi = item.label.toLowerCase().indexOf(q.toLowerCase());
      if (hi >= 0) {
        labelHtml =
          escapeHtml(item.label.slice(0, hi)) +
          '<mark>' + escapeHtml(item.label.slice(hi, hi + q.length)) + '</mark>' +
          escapeHtml(item.label.slice(hi + q.length));
      }
    }
    const div = el(`<div class="palette-item ${idx === palette.index ? 'active' : ''}">
      ${icon(item.icon || 'chevron')}
      <span class="${item.mono ? 'mono' : ''}">${labelHtml}</span>
      ${item.sub ? `<span class="sub">${escapeHtml(item.sub)}</span>` : ''}
    </div>`);
    div.addEventListener('click', () => paletteRun(idx));
    div.addEventListener('mousemove', () => {
      if (palette.index !== idx) {
        palette.index = idx;
        renderPalette();
      }
    });
    list.appendChild(div);
  });
  const active = list.children[[...list.children].findIndex((c) => c.classList?.contains('active'))];
  active?.scrollIntoView({ block: 'nearest' });
}

function paletteRun(idx) {
  const item = palette.items[idx];
  closePalette();
  item?.run?.();
}

function openPalette() {
  palette.open = true;
  palette.query = '';
  palette.items = paletteCandidates('');
  palette.index = 0;
  $('#palette').hidden = false;
  renderPalette();
  const input = $('#palette-input');
  input.value = '';
  input.focus();
}
function closePalette() {
  palette.open = false;
  $('#palette').hidden = true;
}

$('#palette-input').addEventListener('input', (e) => {
  palette.query = e.target.value.trim();
  palette.items = paletteCandidates(palette.query);
  palette.index = 0;
  renderPalette();
});
/* 顶栏搜索框：点击唤起命令面板（与 Ctrl+K 同入口） */
$('#header-search').addEventListener('click', openPalette);
$('#palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    palette.index = (palette.index + 1) % Math.max(1, palette.items.length);
    renderPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    palette.index = (palette.index - 1 + palette.items.length) % Math.max(1, palette.items.length);
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    paletteRun(palette.index);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  }
});
$('#palette').addEventListener('mousedown', (e) => {
  if (e.target.id === 'palette') closePalette();
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    palette.open ? closePalette() : openPalette();
  }
});

/* ======================= 设置 / 快捷键 ======================= */
$('#settings-open').addEventListener('click', async () => {
  const cfg = await loadConfig();
  const body = document.createElement('div');
  body.innerHTML = `
    <label class="setting-row"><span>服务器地址（修改后需重新授权并登录）</span>
      <input id="set-url" type="text" value="${escapeHtml(cfg.baseUrl)}" spellcheck="false"></label>
    <label class="setting-row"><span>用户名</span>
      <input id="set-user" type="text" value="${escapeHtml(cfg.username)}" autocomplete="off"></label>
    <label class="setting-row"><span>密码</span>
      <input id="set-pass" type="password" value="${escapeHtml(cfg.password)}" autocomplete="new-password"></label>
    <label class="setting-row"><span>OTP 密钥（如有）</span>
      <input id="set-totp" type="password" value="${escapeHtml(cfg.totpSecret || '')}" placeholder="otpauth:// 链接或 base32，两步验证自动登录" autocomplete="off" spellcheck="false"></label>
    <div class="setting-actions">
      <button class="button primary full" id="set-save">保存并重连</button>
    </div>
    <div class="setting-foot">
      <span class="setting-ver-status" id="set-ver-status">当前版本 v${escapeHtml(chrome.runtime.getManifest().version)}</span>
      <div class="setting-foot-tools">
        <button class="button small" id="set-check-ver">检测版本</button>
        <button class="button small" id="set-changelog">更新日志</button>
        <button class="button small" id="set-shortcut">快捷键</button>
      </div>
    </div>`;
  openModal('设置', body);
  body.querySelector('#set-save').addEventListener('click', async () => {
    const baseUrl = normalizeBase(body.querySelector('#set-url').value);
    if (!/^https?:\/\/.+/.test(baseUrl)) return toast('地址格式不正确', 'error');
    const u = new URL(baseUrl);
    const patterns = [`${u.protocol}//${u.host}/*`, `${u.protocol}//${u.hostname}/*`];
    let has = false;
    for (const p of patterns) {
      if (await chrome.permissions.contains({ origins: [p] })) {
        has = true;
        break;
      }
    }
    if (!has) {
      const ok = await chrome.permissions.request({ origins: [`${u.protocol}//${u.hostname}/*`] });
      if (!ok) return toast('未授权访问新地址', 'error');
    }
    await saveConfig({
      baseUrl,
      username: body.querySelector('#set-user').value.trim(),
      password: body.querySelector('#set-pass').value,
      totpSecret: body.querySelector('#set-totp').value.trim(),
    });
    closeModal();
    location.reload();
  });
  body.querySelector('#set-check-ver').addEventListener('click', async () => {
    const btn = body.querySelector('#set-check-ver');
    const status = body.querySelector('#set-ver-status');
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = '检测中…';
    status.textContent = '正在对照 GitHub 仓库…';
    status.className = 'setting-ver-status';
    try {
      const r = await checkRemoteVersion({ force: true });
      if (r.status === 'newer') {
        openUpdateModal(r.remote);
      } else if (r.status === 'current') {
        status.textContent = `已是最新版本 v${r.local}`;
        status.classList.add('ok');
      } else {
        status.textContent = `检测失败：${r.error || '无法访问 GitHub'}`;
        status.classList.add('err');
      }
    } catch (e) {
      status.textContent = `检测失败：${e.message || '未知错误'}`;
      status.classList.add('err');
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });
  body.querySelector('#set-changelog').addEventListener('click', () => openChangelogModal());
  body.querySelector('#set-shortcut').addEventListener('click', () => {
    const g = document.createElement('div');
    g.className = 'shortcut-grid';
    g.innerHTML = `
      <span><kbd>Ctrl</kbd> + <kbd>K</kbd></span><span>命令面板（功能 / 实例 / 库 / 表 / 最近 SQL）</span>
      <span><kbd>Ctrl</kbd> + <kbd>Enter</kbd></span><span>执行当前查询（有选中时仅执行选中部分）</span>
      <span><kbd>Alt</kbd> + <kbd>Enter</kbd></span><span>格式化 SQL（选中部分优先）</span>
      <span><kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd></span><span>缩进 / 反缩进当前行或选中块</span>`;
    openModal('快捷键', g);
  });
});

/* ======================= 启动 ======================= */
const GITHUB_REPO = 'serein-morii/archery-helper';
const GITHUB_MANIFEST = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/manifest.json`;
const GITHUB_CHANGELOG = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/CHANGELOG.md`;
const GITHUB_PAGE = `https://github.com/${GITHUB_REPO}`;
const GITHUB_ZIP = `https://github.com/${GITHUB_REPO}/archive/refs/heads/main.zip`;
const VERSION_CHECK_TTL = 6 * 60 * 60 * 1000;

function cmpVer(a, b) {
  const pa = String(a || '').split('.').map((n) => Number(n) || 0);
  const pb = String(b || '').split('.').map((n) => Number(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function changelogSection(md, version) {
  const lines = String(md || '').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## ${version}`));
  if (start < 0) return String(md || '').split('\n').slice(0, 40).join('\n');
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((l) => /^## /.test(l));
  return [lines[start], ...(endRel < 0 ? rest : rest.slice(0, endRel))].join('\n').trim();
}

async function openUpdateModal(remote) {
  const local = chrome.runtime.getManifest().version;
  const body = el(`<div class="update-modal">
    <p class="update-lead">当前 <b>v${escapeHtml(local)}</b> → 仓库 <b>v${escapeHtml(remote)}</b></p>
    <div class="md-view" id="update-notes"><p>正在读取更新说明…</p></div>
    <p class="submit-panel-note">开发者模式加载的扩展不能自己覆盖安装目录。先下载压缩包，解压后覆盖原文件夹，再点「重新加载」。</p>
    <div class="setting-actions">
      <button class="button small" id="upd-github">打开仓库</button>
      <button class="button small" id="upd-reload">重新加载扩展</button>
      <button class="button small primary" id="upd-download">${icon('download')}<span>下载更新包</span></button>
    </div>
  </div>`);
  $('#modal').dataset.updateRemote = remote;
  openModal(`发现新版本 ${remote}`, body);
  fetch(GITHUB_CHANGELOG, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    .then((r) => {
      if (!r.ok) throw new Error();
      return r.text();
    })
    .then((md) => {
      const notes = body.querySelector('#update-notes');
      if (notes) notes.innerHTML = renderMarkdown(changelogSection(md, remote));
    })
    .catch(() => {
      const notes = body.querySelector('#update-notes');
      if (notes) notes.innerHTML = '<p>更新说明读取失败，可打开仓库查看 CHANGELOG。</p>';
    });
  body.querySelector('#upd-github').addEventListener('click', () => window.open(GITHUB_PAGE, '_blank'));
  body.querySelector('#upd-reload').addEventListener('click', () => chrome.runtime.reload());
  body.querySelector('#upd-download').addEventListener('click', async () => {
    const btn = body.querySelector('#upd-download');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span><span>下载中…</span>';
    try {
      const res = await fetch(GITHUB_ZIP, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `archery-helper-${remote}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已开始下载，解压覆盖原文件夹后点「重新加载扩展」', 'success');
    } catch (e) {
      toast(`下载失败：${e.message}`, 'error');
      window.open(GITHUB_ZIP, '_blank');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `${icon('download')}<span>下载更新包</span>`;
      mountIcons(btn);
    }
  });
}

function markVersionBadge(local, remote) {
  const badge = $('#app-version');
  if (!badge) return;
  badge.classList.add('has-update');
  badge.title = `发现新版本 ${remote}，点击更新`;
  badge.replaceChildren(document.createTextNode(local), el('<i>新</i>'));
  if (!badge.dataset.updateBound) {
    badge.dataset.updateBound = '1';
    badge.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ver = badge.dataset.remote;
      if (ver) openUpdateModal(ver);
    });
  }
  badge.dataset.remote = remote;
}

async function fetchRemoteManifestVersion() {
  const res = await fetch(GITHUB_MANIFEST, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const remote = json.version;
  if (!remote) throw new Error('仓库 manifest 没有 version');
  await chrome.storage.local.set({ versionCheck: { version: remote, at: Date.now() } });
  return remote;
}

async function checkRemoteVersion({ force = false } = {}) {
  try {
    const local = chrome.runtime.getManifest().version;
    let remote;
    if (!force) {
      const { versionCheck } = await chrome.storage.local.get('versionCheck');
      remote = versionCheck?.version;
      const stale = !versionCheck || Date.now() - (versionCheck.at || 0) > VERSION_CHECK_TTL;
      if (stale) remote = await fetchRemoteManifestVersion();
    } else {
      remote = await fetchRemoteManifestVersion();
    }
    if (!remote) return { status: 'error', local, error: '未读到远程版本' };
    if (cmpVer(remote, local) > 0) {
      markVersionBadge(local, remote);
      return { status: 'newer', local, remote };
    }
    return { status: 'current', local, remote };
  } catch (e) {
    return { status: 'error', local, error: e.message || '无法访问 GitHub' };
  }
}

async function openChangelogModal() {
  try {
    const md = await (await fetch(chrome.runtime.getURL('CHANGELOG.md'))).text();
    openModal(`更新日志 · v${chrome.runtime.getManifest().version}`, el(`<div class="md-view">${renderMarkdown(md)}</div>`));
  } catch (e) {
    toast('更新日志读取失败', 'error');
  }
}

/** 首次安装后第一次打开工作台时展示更新日志；已有用户重新加载不弹 */
async function maybeShowWelcomeChangelog() {
  try {
    const { welcomeChangelog } = await chrome.storage.local.get('welcomeChangelog');
    if (!welcomeChangelog) return false;
    await chrome.storage.local.set({ welcomeChangelog: false });
    await openChangelogModal();
    return true;
  } catch {
    return false;
  }
}

(async function fillVersion() {
  const v = chrome.runtime.getManifest().version;
  const badge = document.querySelector('#app-version');
  if (badge) badge.textContent = v;
  const foot = document.querySelector('#footer-target');
  if (foot) foot.textContent = `v${v}`;
  const welcomed = await maybeShowWelcomeChangelog();
  const r = await checkRemoteVersion();
  if (welcomed || r.status !== 'newer') return;
  const { dismissedUpdate } = await chrome.storage.local.get('dismissedUpdate');
  if (dismissedUpdate !== r.remote) openUpdateModal(r.remote);
})();
if (!queryTabs.list.length) newQueryTab();
renderResultTabs();
renderActiveResult();
init();
