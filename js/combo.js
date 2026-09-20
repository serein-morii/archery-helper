/**
 * 可搜索下拉组件：包裹原生 <select class="select">，
 * 显示层换成「输入框 + 搜索列表」，选择后写回 select.value 并派发 change，
 * 现有取值/联动逻辑完全不变。focusin 惰性初始化（覆盖动态生成的下拉）。
 */

function makeSearchable(select) {
  if (select._combo) return;
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  select.parentNode.insertBefore(wrap, select);
  wrap.appendChild(select);
  select._combo = true;
  select.classList.add('combo-source');

  const box = document.createElement('div');
  box.className = 'combo-box';
  box.tabIndex = 0;
  const label = document.createElement('span');
  label.className = 'combo-label';
  const arrow = document.createElement('span');
  arrow.className = 'combo-arrow';
  arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  box.append(label, arrow);

  const panel = document.createElement('div');
  panel.className = 'combo-panel';
  panel.hidden = true;
  const search = document.createElement('input');
  search.className = 'combo-search';
  search.placeholder = '输入关键字过滤…';
  const list = document.createElement('div');
  list.className = 'combo-list';
  panel.append(search, list);
  wrap.append(box, panel);

  const options = () => {
    const out = [];
    let group = '';
    for (const opt of select.options) {
      const g = opt.closest('optgroup')?.label || '';
      if (g) group = g;
      out.push({ value: opt.value, text: opt.textContent.trim(), group: g || group, disabled: opt.disabled });
    }
    return out;
  };

  const renderLabel = () => {
    const cur = select.options[select.selectedIndex];
    label.textContent = cur ? cur.textContent.trim() : '请选择';
    label.classList.toggle('placeholder', !select.value);
  };

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const markHit = (text, q) => {
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  };

  const renderList = (kw = '') => {
    const lower = kw.toLowerCase();
    let opts = options().filter(
      (o) => !o.disabled && (!lower || o.text.toLowerCase().includes(lower) || o.group.toLowerCase().includes(lower))
    );
    // 搜索时：命中位置优先、更短的排前面（staff 排在 astaff 前），平铺不显示分组标题
    if (lower) {
      opts = [...opts].sort((a, b) => {
        const ia = a.text.toLowerCase().indexOf(lower);
        const ib = b.text.toLowerCase().indexOf(lower);
        return ia - ib || a.text.length - b.text.length;
      });
    }
    list.replaceChildren();
    if (!opts.length) {
      list.appendChild(Object.assign(document.createElement('div'), { className: 'combo-empty', textContent: '无匹配项' }));
      return;
    }
    let lastGroup = null;
    for (const o of opts.slice(0, 300)) {
      if (!lower && o.group && o.group !== lastGroup) {
        list.appendChild(Object.assign(document.createElement('div'), { className: 'combo-group', textContent: o.group }));
        lastGroup = o.group;
      }
      const item = document.createElement('div');
      item.className = 'combo-item' + (o.value === select.value ? ' current' : '');
      item.innerHTML = markHit(o.text, lower);
      item.dataset.value = o.value;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        select.value = o.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        close();
      });
      list.appendChild(item);
    }
    if (opts.length > 300) {
      list.appendChild(Object.assign(document.createElement('div'), { className: 'combo-empty', textContent: `共 ${opts.length} 项，仅显示前 300，请输入关键字过滤` }));
    }
  };

  const open = () => {
    panel.hidden = false;
    search.value = '';
    renderList('');
    search.focus();
    document.addEventListener('mousedown', onDocDown, true);
  };
  const close = () => {
    panel.hidden = true;
    renderLabel();
    document.removeEventListener('mousedown', onDocDown, true);
  };
  const onDocDown = (e) => {
    if (!wrap.contains(e.target)) close();
  };

  box.addEventListener('click', () => (panel.hidden ? open() : close()));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      open();
    }
  });
  search.addEventListener('input', () => renderList(search.value.trim()));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      box.focus();
    }
  });

  const rebuild = () => {
    renderLabel();
    if (!panel.hidden) renderList(search.value.trim());
  };
  new MutationObserver(rebuild).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
  select.addEventListener('change', renderLabel);
  renderLabel();
  // 禁用态同步到显示层
  const syncDisabled = () => {
    box.classList.toggle('disabled', select.disabled);
    box.style.pointerEvents = select.disabled ? 'none' : '';
    box.style.opacity = select.disabled ? 0.5 : '';
  };
  new MutationObserver(syncDisabled).observe(select, { attributes: true, attributeFilter: ['disabled'] });
  syncDisabled();
}

function initCombos(root = document) {
  root.querySelectorAll('select.select').forEach(makeSearchable);
}
/* 覆盖动态生成的下拉（审核组、对比表等）：DOM 变更后防抖扫描 */
let comboScanTimer = null;
const comboObserver = new MutationObserver(() => {
  clearTimeout(comboScanTimer);
  comboScanTimer = setTimeout(() => initCombos(), 120);
});
comboObserver.observe(document.body, { childList: true, subtree: true });
initCombos();
