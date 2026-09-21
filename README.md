# Archery 助手（Chrome/Edge 扩展）

> 当前版本 **1.1.8**，更新日志见 [CHANGELOG.md](CHANGELOG.md)（插件内：设置 → 更新日志）。

为 [Archery](https://github.com/hhyo/Archery)（v1.9.1）打造的 SQL 工作台 Chrome/Edge 扩展。

## 功能

| 模块 | 说明 |
| --- | --- |
| SQL 工作台 | 实例/库/schema 联动选择、SQL 高亮编辑器（Ctrl+Enter 执行、选中优先、Alt+Enter 格式化）、**多查询标签页**（草稿独立保存）、多次查询结果以标签保留、前端分页/排序/筛选、结果区一键放大 |
| 分批流式查询 | limit 选择 10000 或「不限」时自动按 **5000 行/批** 分页请求（子查询 LIMIT/OFFSET 包装），逐批追加渲染、实时进度、可随时「停止加载」，批间缓冲不打挂服务端；总量 10 万行安全上限；导出直接使用已拉全的内存数据，天然分批安全。仅支持 MySQL/TiDB/ClickHouse/StarRocks/PgSQL，其余类型自动回退单次请求 |
| 执行计划 | 「运行查询」旁一键 EXPLAIN，按实例类型自动拼接语句；结果**智能着色**（全表扫描红、走索引绿、大扫描量橙） |
| 可搜索下拉 | 全部下拉框支持输入关键字过滤（实例 80+、库表数百项时秒定位），**命中位置优先、短名靠前排序，命中片段高亮** |
| 智能补全 | 联想框**跟随输入光标**定位；输入表名前缀联想当前库的表；`表名.`（含反引号写法）后联想该表全部字段（describe 解析 + information_schema 兜底）；↑↓ 选择、Tab/Enter 确认、Ctrl+Space 手动触发 |
| 数据浏览器 | 实例（按数据库类型分组）→ 库 → 表 三级对象树；**右键表**：查看表结构 / SELECT * / SELECT 全部字段 / SELECT COUNT / 复制表名；单击看建表语句、双击插入表名；结果单元格**双击复制** |
| SQL 审核检测 → 提单 | 发版 SQL 预检（goInception）：逐条语句的通过/警告/错误、影响行数；**检测无错误时可直接填写工单名/资源组提交上线工单** |
| 工单审批 | 待审核工单详情内直接**审核通过 / 驳回 / 立即执行 / 终止流程**（需相应权限，无权限时接口会明确提示） |
| 上线工单 | 工单列表（搜索/服务端分页）、明细（每条 SQL 执行状态）、复制全部 SQL、下载回滚语句 |
| 查询历史 / 收藏 | 最近查询记录，搜索、回填、直接执行；收藏为统一列表（命名、分组、一键回填执行、导入导出 JSON），每条可勾选「云端」写入 Archery 收藏（跨设备可见），无需单独同步 |
| 对象搜索索引 | 顶部搜索可搜**全库的表名**：本地缓存「库+表」索引（相当于对象树全展开的快照），连接后自动后台重建（超 7 天自动刷新），刷新按钮菜单可手动重构；库右键可单独重建；命中显示 实例/库 并一键跳转表结构。字段搜索用侧边栏「字段」模式 |
| 数据导出 | 隐藏彩蛋解锁导出（CSV / Excel（双 Sheet：数据 + 导出信息：SQL/行数/耗时等）/ JSON），触发方式就不写了，留点惊喜 |
| 查询历史/收藏 | SQL 默认收缩单行（行等高），点击单元格展开完整语句 |
| SQL 快捷生成 | 结果区**右键**：列头一键生成 `IN (...)` 列表 / 复制整列；行右键按目标表生成 INSERT / UPDATE 语句（自动识别主键，只生成不执行，走工单落地） |
| 结果增强 | 单元格右键**格式化 JSON**；**图表**可视化（X/Y 轴可选，柱状/折线，超 80 点自动抽稀）；两个结果集**对比**（仅 A / 仅 B / 一致） |
| 字段搜索 | 侧边栏切「字段」模式，按字段名搜当前库（information_schema，含类型与注释），点击直达建表语句 |
| 表结构对比 | 「对比」视图两档能力：**整库对比**（多表/少表/结构差异排行）与**单表字段级对比**；**本地对比历史**自动记录最近 50 次，点击标签一键回填重比；建表语句详情为行对齐视图，仅本侧存在的行高亮 | 「对比」视图两档能力：**整库对比**（多表/少表/结构差异排行）与**单表字段级对比**（选表 A/B，逐字段标出 仅A有/仅B有/定义不同/一致，B 侧自动跟随同名表）；建表语句详情为**横向并排**视图，仅本侧存在的行红色高亮 |
| 数据字典 | 点击表名看结构升级为三视图（**字段表格 / 建表语句 / 索引**，走 Archery 数据字典接口，含字段注释），查看时**自动收起编辑器让内容顶到可视区**（点 SQL 标签栏即可返回编辑）；**右键库 → 导出全库数据字典**（Markdown 文档，含表注释与字段清单，上限 150 表） |
| 容量与事务诊断 | 「诊断」视图：表空间 **TOP 排行**（总大小/行数/数据/索引，Top 库分布统计，找大表神器）+ **InnoDB 当前事务**列表（长事务 >60s 红标预警，可单独刷新） |

## 登录（v1.9.1 含 2FA 场景）

- **免输入**：在浏览器里登录过 Archery 即可，扩展直接复用浏览器 sessionid cookie，打开即用，**不会弹出登录框**。
- **首次使用**：在浏览器打开 Archery 页面后点开扩展弹窗，会自动识别当前站点为地址并完成配置（也可在弹窗「自动重登凭证」中手动填写）。
- **无会话时**：工作台自动弹出登录表单；若实例启用了两步验证（2FA），输入账号密码后再输入一次当前动态验证码即可（在 OTP Vault / 手机验证器中查看），会话有效期内不再打扰。
- **TOTP 密钥（可选全自动）**：在登录表单、扩展弹窗或工作台「设置」中填写 TOTP 密钥（otpauth:// 链接或 base32），插件会本地计算验证码（RFC 6238），会话过期自动重登全程无感。
- 凭证仅保存在本机 `chrome.storage.local`。

## 安装

1. Chrome/Edge 打开 `chrome://extensions`，开启「开发者模式」；
2. 「加载已解压的扩展程序」选择本目录；
3. 点击扩展图标确认「已连接」后打开工作台。

> 更换 Archery 地址：在弹窗「自动重登凭证」中修改并保存，浏览器会弹出新的域名授权确认。

## 快捷键

| 按键 | 功能 |
| --- | --- |
| `Ctrl + Enter` | 执行查询（有选中时仅执行选中部分） |
| `Alt + Enter` | 格式化 SQL |
| `Ctrl + Space` | 手动触发补全 |
| `Tab` / `Shift + Tab` | 缩进 / 反缩进；补全开启时确认候选项 |

## 技术要点

- 认证：Django session cookie + `chrome.cookies` 读取 csrftoken；会话过期自动重登。
- Django 4.x CSRF 会校验请求 Origin，扩展页面发出的 `chrome-extension://` Origin 会被拒（403），已通过 service worker 注册 `declarativeNetRequest` 会话规则改写 Origin（仅限本扩展发起的请求）。
- 2FA：`/authenticate/` 返回待验证 session → 提交 `/api/v1/user/2fa/verify/`（engineer/otp/auth_type=totp）换取正式会话。

## 目录结构

```
manifest.json        MV3 清单（storage / cookies / tabs / declarativeNetRequest）
popup.html|css|js    弹窗：登录态检测、凭证配置
main.html            工作台页面
styles.css           全部样式（深 / 浅主题）
js/api.js            API 客户端（会话/CSRF/Origin 改写/2FA/TOTP）
js/editor.js         SQL 高亮编辑器 + 自动补全
js/icons.js          SVG 图标
js/app.js            工作台逻辑
sw.js                后台：Origin 改写规则
icons/               扩展图标
```

## 已适配的 Archery v1.9.1 接口

`/authenticate/`、`/api/v1/user/2fa/verify/`、`/group/user_all_instances/`、
`/instance/instance_resource/`、`/instance/describetable/`、`/query/`、
`/query/querylog/`、`/query/favorite/`、`/sqlworkflow_list/`、
`/sqlworkflow/detail_content/`、`/sqlworkflow/backup_sql/`、`/api/v1/workflow/sqlcheck/`、
`/data_dictionary/table_list|table_info/`、`/db_diagnostic/tablesapce/`、`/db_diagnostic/innodb_trx/`、
`/api/v1/workflow/`（提单）、`/api/v1/workflow/audit/`（审批）、`/api/v1/workflow/execute/`（执行）
