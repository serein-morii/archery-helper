/**
 * 轻量 SQL 编辑器：textarea 承接输入，背后 pre 层做语法高亮。
 * 两侧字体/行高严格一致，滚动由 textarea 同步到高亮层。
 *
 * 使用：const ed = new SqlEditor(container, {onChange, onRun});
 *       ed.value / ed.setValue() / ed.getSelection() / ed.setReadOnly()
 */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SQL_KEYWORDS = new Set(
  `ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY
CALL CASCADE CASE CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONNECTION CONSTRAINT
CONTINUE CONVERT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR
DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC DECIMAL DECLARE DEFAULT
DELAYED DELETE DESC DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE
ELSEIF ENCLOSED ESCAPED EXISTS EXPLAIN FALSE FETCH FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM
FULLTEXT GRANT GROUP HAVING HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE
IN INDEX INFILE INNER INOUT INSENSITIVE INSERT INT INT1 INT2 INT3 INT4 INT8 INTEGER INTERVAL
INTO IS ITERATE JOIN KEY KEYS KILL LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES LOAD LOCALTIME
LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP LOW_PRIORITY MASTER_SSL_VERIFY_SERVER_CERT
MATCH MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT MINUTE_MICROSECOND MINUTE_SECOND MOD
MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NULL NUMERIC ON OPTIMIZE OPTION OPTIONALLY OR ORDER
OUT OUTER OUTFILE PRECISION PRIMARY PROCEDURE PURGE RANGE READ READS REAL REFERENCES REGEXP
RELEASE RENAME REPEAT REPLACE REQUIRE RESTRICT RETURN REVOKE RIGHT RLIKE SCHEMA SCHEMAS
SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SMALLINT SPATIAL SPECIFIC SQL
SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL
STARTING STRAIGHT_JOIN TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO TRAILING TRIGGER
TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP
VALUES VARBINARY VARCHAR VARCHARACTER VARYING WHEN WHERE WHILE WITH WRITE XOR YEAR_MONTH
ZEROFILL EXCEPT INTERSECT WINDOW OVER PARTITION ROW_NUMBER RANK DENSE_RANK LAG LEAD
COMMENT ENGINE CHARSET DEFAULT_TTL TTL DUPLICATE ATTL BATCH IGNORE_TTL_MS`
    .split(/\s+/)
    .filter(Boolean)
);

const SQL_FUNCTIONS = new Set(
  `COUNT SUM AVG MIN MAX NOW CURDATE CURTIME DATE TIME TIMESTAMP DATE_FORMAT DATE_ADD
DATE_SUB DATEDIFF UNIX_TIMESTAMP FROM_UNIXTIME CONCAT CONCAT_WS SUBSTRING SUBSTR LEFT RIGHT
LENGTH CHAR_LENGTH TRIM LTRIM RTRIM REPLACE LOWER UPPER ROUND FLOOR CEIL ABS MOD POW GREATEST
LEAST IF IFNULL NULLIF COALESCE CAST CONVERT GROUP_CONCAT JSON_EXTRACT JSON_OBJECT
JSON_ARRAY ROW_COUNT DATABASE USER VERSION FIND_IN_SET FIELD INSTR LOCATE STR_TO_DATE
LAST_INSERT_ID UUID TIMESTAMPDIFF`
    .split(/\s+/)
    .filter(Boolean)
);

function highlightSql(text) {
  // 按 注释/字符串/反引号标识/数字/单词 顺序扫描，输出 HTML
  let html = '';
  let i = 0;
  const n = text.length;
  const pushPlain = (s) => {
    html += s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  };
  while (i < n) {
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^--[^\n]*/))) {
      html += `<span class="tok-comment">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^#[^\n]*/))) {
      html += `<span class="tok-comment">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^\/\*[\s\S]*?(\*\/|$)/))) {
      html += `<span class="tok-comment">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^'(?:[^'\\]|\\.|'')*'?/))) {
      html += `<span class="tok-string">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^"(?:[^"\\]|\\.)*"?/))) {
      html += `<span class="tok-string">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^`[^`]*`?/))) {
      html += `<span class="tok-ident">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^\d+(\.\d+)?/))) {
      html += `<span class="tok-number">${m[0]}</span>`;
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_$]*/))) {
      const word = m[0];
      const up = word.toUpperCase();
      if (SQL_KEYWORDS.has(up)) {
        html += `<span class="tok-kw">${word}</span>`;
      } else if (SQL_FUNCTIONS.has(up) && text[i + word.length] === '(') {
        html += `<span class="tok-fn">${word}</span>`;
      } else {
        pushPlain(word);
      }
      i += word.length;
    } else if ((m = rest.match(/^[ \t]+/))) {
      html += m[0].replace(/\t/g, '    ');
      i += m[0].length;
    } else if (text[i] === '\n') {
      html += '\n';
      i += 1;
    } else if ((m = rest.match(/^[^\sA-Za-z0-9_'"`#\-\/]+/))) {
      html += `<span class="tok-op">${m[0].replace(/[&<>]/g, '')}</span>`;
      i += m[0].length;
    } else {
      pushPlain(text[i]);
      i += 1;
    }
  }
  // 末尾补换行，保证滚动高度一致
  return html + '\n';
}

export class SqlEditor {
  /**
   * @param {HTMLElement} container
   * @param {{onChange?:Function, onRun?:Function, onAltRun?:Function,
   *          onSuggest?:Function}} opts
   * onSuggest({prefix, table}) 返回 Promise<Array<{label, kind}>>，
   * 触发时机：输入词前缀（≥2 字符）、`表名.` 后、或 Ctrl+Space。
   */
  constructor(container, opts = {}) {
    this.opts = opts;
    container.classList.add('sqled');
    container.innerHTML = `
      <div class="sqled-gutter" aria-hidden="true"><div class="sqled-lines">1</div></div>
      <div class="sqled-stack">
        <pre class="sqled-hl" aria-hidden="true"><code></code></pre>
        <textarea class="sqled-input" spellcheck="false" autocomplete="off"
          autocapitalize="off" wrap="off"></textarea>
        <div class="sqled-suggest" role="listbox"></div>
      </div>`;
    this.gutter = container.querySelector('.sqled-lines');
    this.hl = container.querySelector('.sqled-hl code');
    this.hlBox = container.querySelector('.sqled-hl');
    this.ta = container.querySelector('.sqled-input');
    this.suggestBox = container.querySelector('.sqled-suggest');

    // 补全状态
    this.sugItems = []; // 过滤后的候选
    this.sugIndex = -1;
    this.sugToken = ''; // 待替换的原始文本（含表名前缀）
    this.sugFrom = 0; // 替换起点（光标 - sugToken 长度）

    this.ta.addEventListener('input', () => {
      this.render();
      this.scheduleSuggest();
    });
    this.ta.addEventListener('scroll', () => this.syncScroll());
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.ta.addEventListener('click', () => this.opts.onChange?.());
    this.ta.addEventListener('selectionchange', () => this.opts.onChange?.());
    document.addEventListener('selectionchange', () => {
      if (document.activeElement === this.ta) this.opts.onChange?.();
    });
    document.addEventListener('click', (e) => {
      if (!this.suggestBox.contains(e.target)) this.closeSuggest();
    });
    // 首次渲染不触发 onChange：构造期间外层的 editor 常量尚未赋值
    this.render(false);
  }

  /* ---------------- 自动补全 ---------------- */

  /** 解析光标处补全上下文：{table, prefix, raw}；兼容 `反引号表`、db.table.col 前缀 */
  suggestContext() {
    const pos = this.ta.selectionStart;
    const before = this.ta.value.slice(0, pos);
    // `table`.`col` / `table`.col / table.col（最后一段可为空，用于输入 . 的瞬间）
    let m = before.match(/`([\w$]+)`\.(?:`?([\w$]*)`?)?$/) || before.match(/\b([\w$]+)\.(?:`?([\w$]*)`?)?$/);
    if (m && before.slice(0, m.index).endsWith('.')) {
      // db.table. 的情况：回退一格只取 table.col
      const re2 = /`?([\w$]+)`?\.(?:`?([\w$]*)`?)?$/;
      m = before.match(re2);
    }
    if (!m) {
      const w = before.match(/[\w$]{1,}$/);
      if (!w) return null;
      return { table: null, prefix: w[0], raw: w[0], from: pos - w[0].length };
    }
    const prefix = m[2] ?? '';
    const raw = m[0];
    return { table: m[1], prefix, raw, from: pos - raw.length };
  }

  /** 光标像素坐标（等宽字体按行列计算），相对 sqled-stack */
  caretCoords() {
    const ta = this.ta;
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || 21;
    if (!this._cw) {
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;font:${cs.font};white-space:pre`;
      probe.textContent = 'M'.repeat(20);
      document.body.appendChild(probe);
      this._cw = probe.getBoundingClientRect().width / 20;
      probe.remove();
    }
    const before = ta.value.slice(0, ta.selectionStart);
    const lines = before.split('\n');
    const row = lines.length; // 光标所在行（1-based）
    const col = lines[lines.length - 1].length;
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padT = parseFloat(cs.paddingTop) || 0;
    return {
      x: padL + col * this._cw - ta.scrollLeft,
      y: padT + row * lineHeight - ta.scrollTop,
      lineHeight,
    };
  }

  scheduleSuggest() {
    if (!this.opts.onSuggest) return;
    clearTimeout(this._sugTimer);
    this._sugTimer = setTimeout(() => this.runSuggest(), 90);
  }

  async runSuggest(force = false) {
    const ctx = this.suggestContext();
    if (!ctx || (!ctx.table && ctx.prefix.length < 2 && !force)) {
      this.closeSuggest();
      return;
    }
    let items = [];
    try {
      items = (await this.opts.onSuggest(ctx)) || [];
    } catch {
      items = [];
    }
    const lower = ctx.prefix.toLowerCase();
    // 包含匹配；排序：命中位置越靠前越优，同位置更短的排前面（staff 排在 astaff 前）
    const filtered = items
      .map((it) => ({ it, i: it.label.toLowerCase().indexOf(lower) }))
      .filter((x) => x.i >= 0 && x.it.label.toLowerCase() !== lower)
      .sort((a, b) => a.i - b.i || a.it.label.length - b.it.label.length)
      .slice(0, 12)
      .map((x) => x.it);
    if (!filtered.length) {
      this.closeSuggest();
      return;
    }
    this.sugItems = filtered;
    this.sugToken = ctx.raw;
    this.sugFrom = ctx.from;
    this.sugIndex = 0;
    this.renderSuggest();
  }

  renderSuggest() {
    const box = this.suggestBox;
    box.replaceChildren();
    this.sugItems.forEach((it, idx) => {
      const row = document.createElement('div');
      row.className = 'item' + (idx === this.sugIndex ? ' active' : '');
      const dot = document.createElement('span');
      dot.textContent = it.kind === 'column' ? '◇' : '▪';
      const label = document.createElement('span');
      // 命中片段高亮（基于当前触发前缀）
      const q = (this.sugToken || '').toLowerCase();
      const plain = it.label;
      const hi = q ? plain.toLowerCase().indexOf(q) : -1;
      if (hi >= 0) {
        label.innerHTML =
          escapeHtml(plain.slice(0, hi)) +
          '<mark>' + escapeHtml(plain.slice(hi, hi + q.length)) + '</mark>' +
          escapeHtml(plain.slice(hi + q.length));
      } else {
        label.textContent = plain;
      }
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = it.kind === 'column' ? '字段' : it.kind === 'table' ? '表' : '';
      row.append(dot, label, kind);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.applySuggest(idx);
      });
      box.appendChild(row);
    });
    box.classList.add('open');
    // 跟随光标定位（等宽字体行列计算），空间不足时放光标上方
    const stack = box.parentElement;
    const sw = stack.clientWidth;
    const sh = stack.clientHeight;
    const c = this.caretCoords();
    const bw = Math.max(200, Math.min(320, box.offsetWidth || 240));
    const bh = Math.min(208, box.offsetHeight || 100);
    let left = Math.max(4, Math.min(c.x, sw - bw - 8));
    let top = c.y + 4;
    if (top + bh > sh - 4) top = Math.max(4, c.y - c.lineHeight - bh - 2);
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.bottom = 'auto';
  }

  closeSuggest() {
    this.suggestBox?.classList.remove('open');
    this.sugItems = [];
    this.sugIndex = -1;
  }

  applySuggest(idx) {
    const it = this.sugItems[idx];
    if (!it) return;
    const pos = this.ta.selectionStart;
    this.ta.setRangeText(it.label, this.sugFrom, pos, 'end');
    this.closeSuggest();
    this.render();
  }

  moveSuggest(delta) {
    if (!this.sugItems.length) return;
    this.sugIndex = (this.sugIndex + delta + this.sugItems.length) % this.sugItems.length;
    this.renderSuggest();
    const active = this.suggestBox.children[this.sugIndex];
    active?.scrollIntoView({ block: 'nearest' });
  }

  get value() {
    return this.ta.value;
  }

  setValue(v, focus = false) {
    this.ta.value = v ?? '';
    this.render();
    if (focus) this.ta.focus();
  }

  setReadOnly(ro) {
    this.ta.readOnly = ro;
    this.ta.classList.toggle('readonly', ro);
  }

  getSelection() {
    const { selectionStart: s, selectionEnd: e } = this.ta;
    return s !== e ? this.ta.value.slice(s, e) : '';
  }

  insertText(text) {
    const ta = this.ta;
    const { selectionStart: s, selectionEnd: e } = ta;
    ta.setRangeText(text, s, e, 'end');
    this.render();
    ta.focus();
  }

  render(notify = true) {
    const v = this.ta.value;
    this.hl.innerHTML = highlightSql(v);
    const lineCount = v.split('\n').length;
    if (lineCount !== this._lines) {
      this._lines = lineCount;
      this.gutter.textContent = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');
    }
    this.syncScroll();
    if (notify) this.opts.onChange?.();
  }

  syncScroll() {
    const { scrollTop, scrollLeft } = this.ta;
    this.hlBox.scrollTop = scrollTop;
    this.hlBox.scrollLeft = scrollLeft;
    this.gutter.parentElement.scrollTop = scrollTop;
  }

  onKey(e) {
    const ta = this.ta;
    // 补全打开时的键盘导航优先
    if (this.sugItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSuggest(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSuggest(-1);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        this.applySuggest(this.sugIndex);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSuggest();
        return;
      }
    }
    if (e.key === ' ' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.runSuggest(true);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = ta;
      if (s !== en) {
        // 整段缩进
        const before = ta.value.lastIndexOf('\n', s - 1) + 1;
        const seg = ta.value.slice(before, en);
        const out = e.shiftKey
          ? seg.replace(/^ {1,2}/gm, '')
          : seg.replace(/^/gm, '  ');
        ta.setRangeText(out, before, en, 'end');
      } else {
        ta.setRangeText('  ', s, en, 'end');
      }
      this.render();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.opts.onRun?.();
    } else if (e.key === 'Enter' && e.altKey) {
      e.preventDefault();
      this.opts.onAltRun?.();
    }
  }
}
