# 插件开发：主题 + 功能（v2）

Coomi 插件分两类：**主题插件**（`theme.json` 改颜色观感）与**功能插件**（声明式提供技能 / MCP 工具 / 人设 / 子智能体模板 / 斜杠命令）。v2 全部**声明式 JSON、零脚本**：写 `plugin.json` + 对应资源即可，启用/停用由应用负责注册与撤销。

## 插件装在哪里

本机数据目录下：

```
%APPDATA%\Coomi\plugins\<插件id>\
├── plugin.json      # 插件清单（必填，描述这个插件是谁、是什么）
├── theme.json       # 主题定义（主题插件的核心；没有它就不算主题）
├── skills\          # 可选：技能包（skills/*.md 自动注册）
└── assets\          # 可选：随插件分发的图片 / 字体 / 其他资源
```

> 每个插件**一个目录**，目录名就是插件 id。多个插件互不影响，也不允许嵌套子插件。
> 本地 zip 导入同时支持「zip 根目录直接是 plugin.json」与「只包一层外层文件夹」两种结构，程序会自动找；但不要套两层以上。
> 插件的启停状态单独记录在 `%APPDATA%\Coomi\plugins.json`（`{ "插件id": true|false }`），缺省的插件视为启用——**不用手改这个文件**。

## 1. plugin.json：插件清单

每个插件目录下必须有 `plugin.json`（缺文件或不是合法 JSON 的目录会被列表跳过，不影响其他插件）。

```json
{
  "id": "example-theme",
  "name": "示例主题",
  "version": "1.0.0",
  "description": "深色护眼示例主题：低亮度、低饱和、减少蓝光，长时间使用更舒服。",
  "type": "theme",
  "themeName": "深色护眼",
  "permissions": []
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 插件唯一标识，**只能包含字母、数字、下划线（`_`）和连字符（`-`）**；它同时是安装目录名，不能含路径分隔符。全局唯一，避免和别人重名（建议用 `github用户名-插件名`）。 |
| `name` | | 展示名。缺省＝id。 |
| `version` | | 版本号，建议 `1.0.0` 语义化版本。缺省＝`0.0.0`。 |
| `description` | | 一句话介绍，显示在插件列表里。 |
| `type` | | 插件类型。`theme`＝主题插件；v2 功能插件可留空（按声明字段判断）。 |
| `themeName` | | 主题的显示名（例如「深色护眼」）。插件列表会据此显示「应用主题」按钮。缺省＝空。 |
| `permissions` | | 权限声明（字符串数组，例如 `theme.apply`）。v2 只做展示与骨架，真正的沙箱强制执行在后续版本。 |
| `skills` | | 技能包：数组或目录 `skills/*.md`。每项 `{ id, name, description, content? }`；启用时自动注册进技能中心（SkillRouter 可路由）。 |
| `mcp` | | 工具扩展：数组 `{ name, command, args?, env?, transport?, url? }`。启用时写入 MCP 配置（键名 `plugin:<插件id>:<name>`）并重载，工具立即可用。 |
| `persona` | | 人设提示词（字符串）。启用时注入系统提示词身份层；Composer 会显示「插件人设已生效」。 |
| `subagents` | | 子智能体模板：数组 `{ id, name, description, systemPrompt }`。启用后出现在侧边栏「子智能体」的新建区，点击即按该模板创建。 |
| `slash` | | 斜杠命令：数组 `{ command, description, template }`。输入 `/command` 弹出菜单，选中把 template 填入输入框（`{{cursor}}` = 光标落点）。 |
| `views` | | 页面：数组 `{ id, title, icon?, order?, entry }`。启用后**左侧导航栏多出一个入口**，点开就是插件自己的页面（见第 3 节）。 |

> id 校验失败（例如包含 `..`、中文、空格）会直接**拒绝安装**，这是防路径穿越的安全底线。

## 2.1 views：给插件加一个页面（v2.1）

`entry` 是**插件目录内的相对路径**，必须是 `.html` / `.htm`（绝对路径、`..`、盘符一律拒绝）：

```json
{
  "id": "my-notes",
  "name": "我的笔记",
  "views": [
    { "id": "notes", "title": "笔记", "icon": "file", "order": 60, "entry": "views/notes.html" }
  ]
}
```

- `title` 显示在左侧导航（悬停提示）与页面标题上；`icon` 是内置图标名（`file / globe / star / book / activity / image / grid / puzzle`，认不出用默认方块）；`order` 越小越靠前（核心四个页面永远在最前）。
- **沙箱**：页面跑在独立 origin 的 iframe 里（`allow-scripts`，不给 `allow-same-origin`），拿不到主界面的 DOM、localStorage 与 Tauri IPC —— 也就拿不到引擎端口与令牌。
- **读引擎数据**：页面通过 `postMessage` 让宿主代发**只读 GET**（`/api/` 开头，`/api/admin` 除外）：

```js
const id = String(Math.random())
window.addEventListener('message', (event) => {
  if (event.data?.type === 'coomi:response' && event.data.id === id) {
    console.log(event.data.ok, event.data.data)
  }
})
parent.postMessage({ type: 'coomi:request', id, path: '/api/runtime/health' }, '*')
```

- 停用或卸载插件，入口与页面**立即撤销**（注册表由桌面端在启停时写入）。

## 2. theme.json：怎么写主题

`theme.json` 是一个 JSON 对象：**键是 CSS 变量名（带 `--` 前缀），值是该变量的覆盖值**。只写你想改的那几项，没写的沿用应用内置主题——它是在内置主题之上做覆盖，不是整体替换。

```json
{
  "--surface": "#211f1c",
  "--ink": "#e8e2d8"
}
```

给主题起什么名字写在 plugin.json 的 `themeName` 里，theme.json 本身不含名字。

### 2.1 可以用的 CSS 变量（颜色）

**背景 / 表面（改这些就是换「底色」）：**

| 变量 | 内置浅色的值 | 内置深色的值 | 作用 |
| --- | --- | --- | --- |
| `--canvas` | #f6f7fa | #131315 | 应用画布背景 |
| `--canvas-side` | #ffffff | #0e0e10 | 侧边栏 / 顶栏背景 |
| `--surface` | #ffffff | #1d1d21 | 主面板表面 |
| `--surface-muted` | #f1f3f7 | #17171a | 次级表面（输入区、页脚） |
| `--surface-sunken` | #e9ecf2 | #26262b | 下沉表面（输入框、代码块底） |
| `--surface-raised` | #ffffff | #26262b | 凸起表面（卡片、浮层下的面板） |
| `--surface-overlay` | #ffffff | #2c2c33 | 浮层表面（弹窗、菜单、抽屉） |

**文字颜色：**

| 变量 | 内置浅色的值 | 内置深色的值 | 作用 |
| --- | --- | --- | --- |
| `--ink` | #14161a | #f4f4f5 | 主文字 |
| `--ink-2` | rgba(20,22,26,.82) | #b8b8b8 | 次级文字（标题旁的小字） |
| `--ink-3` | rgba(20,22,26,.58) | #8b8b8b | 弱文字 / 说明 |
| `--ink-4` | rgba(20,22,26,.38) | #6a6a6a | 占位符 / 禁用文字 |
| `--ink-inverse` | #ffffff | #151c13 | 反色文字（主按钮上的字） |

> ⚠️ 注意：`--text-13`、`--text-14` 这类 `--text-*` 是**字号** token，不是颜色；文字颜色以 `--ink*` 为准。主题只需覆盖颜色，不要动字号。

**线条 / 分隔：** `--line`、`--line-soft`、`--line-strong`

**控件与交互：** `--control-bg`、`--control-bg-2`、`--hover`（悬停）、`--active`（按下）、`--selected`（选中）

**强调色（一般建议保留内置值，只调背景和文字）：** `--primary`、`--primary-hover`、`--accent`、`--ok`、`--warn`、`--danger` 以及各自的 hover/soft 变体

**会话区（想让消息气泡更协调时改）：** `--bubble-user`（我的消息气泡）、`--bubble-user-line`、`--bubble-user-ink`、`--msg-card`、`--msg-card-line`

**工具 / 文件类型色（可选）：** `--tool-read`、`--tool-write`、`--tool-edit`、`--tool-search`、`--tool-fetch`、`--tool-run`

### 2.2 深色护眼示例色板

暖色调、低亮度、低饱和、低蓝光分量，长时间看屏幕不那么刺眼：

```json
{
  "--canvas": "#1b1917",
  "--canvas-side": "#171513",
  "--surface": "#211f1c",
  "--surface-muted": "#1a1816",
  "--surface-sunken": "#262320",
  "--surface-raised": "#262320",
  "--surface-overlay": "#2b2824",
  "--hover": "rgba(255, 235, 220, 0.06)",
  "--active": "rgba(255, 235, 220, 0.10)",
  "--selected": "rgba(255, 235, 220, 0.08)",
  "--line": "#3a352f",
  "--line-soft": "rgba(255, 240, 225, 0.08)",
  "--line-strong": "#524a40",
  "--control-bg": "#262321",
  "--control-bg-2": "#1d1b19",
  "--ink": "#e8e2d8",
  "--ink-2": "#c9c2b4",
  "--ink-3": "#9a9388",
  "--ink-4": "#736d64",
  "--ink-inverse": "#17130f",
  "--code-bg": "#24211d",
  "--code-fg": "#e0d9cb",
  "--bubble-user": "#2c3a2e",
  "--bubble-user-line": "#3c4d3f",
  "--bubble-user-ink": "#e6efe6",
  "--msg-card": "#241f1a",
  "--msg-card-line": "#373129",
  "--row-active": "#2a2723",
  "--row-active-line": "#39352f",
  "--neutral-btn": "#37332d",
  "--neutral-btn-hover": "#423d36",
  "--neutral-btn-ink": "#efe9de"
}
```

做完后把「plugin.json + theme.json」放进一个文件夹（目录名＝插件 id），就能直接安装试用。现成的完整示例在仓库 `docs/plugins/example-theme/` 下。

## 3. assets（可选）

`assets/` 目录原样随插件复制到安装目录，可以放主题要用的图片（例如背景纹理）。v1.5 起，theme.json 的 `background.image` 可以直接引用插件目录里的图片（建议写绝对路径，见第 9 节），前端会把它渲染成应用背景层；更早版本则只做约定目录，不强制加载。

## 4. 怎么安装 / 管理

1. 点左侧导航栏的 **插件** 图标打开插件中心；
2. **「已安装」页签**：点「安装文件夹」选择插件目录，或点「本地 zip」直接选一个 .zip 文件导入；在 **「市场」页签** 可粘贴 zip / 清单 URL 远程安装；
3. 列表里出现插件后：**开关**＝启用 / 停用（启用即注册其技能/工具/人设/子智能体/斜杠，停用即全部撤销），**应用主题**＝切换界面主题，**卸载**＝删除插件；
4. 主题立即生效，无需重启应用（技能中心 / MCP 工具会在重载后出现）。

装完插件文件实际落在 `%APPDATA%\Coomi\plugins\<id>\`，卸载只是删除目录 + 状态记录，不会动你的数据。

## 5. 发布

本地自装之外，v2 支持**远程安装**：把插件打成 zip（根目录含 `plugin.json`）放到任意 URL，使用者在插件中心「市场」粘贴该 URL 即可安装；也可以提供一个清单 JSON（`{ plugins: [{ id, name, version, description, zipUrl }] }`）让市场列出多个插件。发布前请保证：插件 id 全局唯一（建议用自己的 github 用户名开头）、version 递增、theme.json 只覆盖上表变量。

## 6. 常见问题

- **列表里看不到插件？** 目录下没有 `plugin.json`、或它不是合法 JSON、或 `id` 含非法字符——请对照第 1、2 节修正。
- **提示「插件已安装」？** 安装目录已经存在同 id 插件。先卸载，或换一个 id。
- **主题只生效一半？** 检查是不是改到了字号变量（`--text-*`），或引用了上表之外的变量名（拼写 / 大小写要一致）。

## 7. v2 功能插件：一个完整示例

```json
{
  "id": "my-toolkit",
  "name": "我的工具箱",
  "version": "1.0.0",
  "description": "技能 + 工具 + 人设 + 子智能体 + 斜杠 全能力示例",
  "themeName": "工具箱护眼",
  "permissions": ["theme.apply"],
  "persona": "你是一位严谨的桌面助手，回答先给结论再给理由。",
  "skills": [
    { "id": "code-review", "name": "代码审查", "description": "按规范审查代码差异", "content": "逐行审查差异，指出风险与改进点。" }
  ],
  "mcp": [
    { "name": "filesystem", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "env": {} }
  ],
  "subagents": [
    { "id": "reviewer", "name": "审查员", "description": "专职代码审查", "systemPrompt": "你是资深代码审查员，只做审查不修改。" }
  ],
  "slash": [
    { "command": "/review", "description": "发起一次代码审查", "template": "请按审查规范检查以下代码：\n{{cursor}}" }
  ]
}
```

### 7.1 各能力生效规则

- **skills**：启用 → 技能复制进 `home/skills/` 并即时重建索引；停用/卸载 → 删除对应目录。
- **mcp**：启用 → 追加到 MCP 配置（键名 `plugin:<id>:<name>`）并后台重载；停用/卸载 → 按前缀撤销并重载。
- **persona**：启用 → 追加进系统提示词；停用/卸载 → 不再注入（残留也不注入）。
- **subagents**：启用 → 模板进入侧边栏「子智能体」新建区，点击经 `POST /api/plugins/subagents/spawn` 按模板创建。
- **slash**：启用 → 输入 `/` 弹出菜单；`{{cursor}}` 是模板里的光标落点。
- **theme.json**：与 v1 一致，键是 CSS 变量名（`--surface-*`、`--ink*`…），只覆盖想改的项。

## 8. 常见问题（v2 补充）

- **功能插件装了没生效？** 检查是否已**启用**（列表开关）；技能/工具需要重载后才出现（市场安装与启用都会触发）。
- **MCP 报「找不到命令」？** 确认 `command` 在 PATH 里（`npx` 用全路径或确保 node 已装）。
- **子智能体模板点了没反应？** 需要引擎 `POST /api/plugins/subagents/spawn` 可用（0.9.9-rc4+）。
- **市场安装失败？** zip 必须**根目录**含 `plugin.json`（不要套一层外层文件夹）；URL 需能直连下载。

## 9. theme.json v1.5：背景层与自定义样式（界面自定义）

v1.5 起，theme.json 在 colors / radii / fonts 之外新增两个可选字段：**background**（一个 fixed 的整窗背景层）与 **css**（自定义样式片段）。两者都可以脱离颜色令牌单独使用——一个「只要背景图、不改任何颜色」的主题完全合法。

### 9.1 `background`：背景层

```json
{
  "background": {
    "image": "C:\\Users\\you\\AppData\\Roaming\\Coomi\\plugins\\my-theme\\assets\\bg.png",
    "gradient": "linear-gradient(180deg, rgba(11,15,20,0.9), rgba(11,15,20,0.55))",
    "fit": "cover",
    "opacity": 0.85,
    "blur": 12
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `image` | 本地图片路径（建议插件目录内的**绝对路径**，如 `%APPDATA%\Coomi\plugins\<插件id>\assets\bg.png`）。桌面端引擎会把它经 `convertFileSrc` 转成 `asset://` 供 WebView 加载；`http(s)://`、`data:` 等 URL 也接受。 |
| `gradient` | CSS 渐变串（`linear-gradient(...)` / `radial-gradient(...)` 等任意合法 CSS 渐变值）。 |
| `fit` | 铺放方式：`cover`（默认，等比铺满、可能裁边）/ `contain`（完整放入、可能留白）。 |
| `opacity` | 整层透明度 0–1（默认 1）。 |
| `blur` | 高斯模糊半径（px，上限 100）。全屏模糊是 GPU 大开销，别给大数值。 |

`image` 与 `gradient` 二选一即可；同时给时两者叠加（渐变在下、图片在上）。背景层固定铺满视口（`fixed inset-0`、`pointer-events: none`），不参与滚动、不挡任何点击与输入。想让它更透出界面，可以在 `css` 里把 `--canvas` 覆盖成半透明，例如 `:root { --canvas: color-mix(in srgb, var(--canvas) 88%, transparent); }`。

### 9.2 `css`：自定义样式片段

```json
{
  "css": [
    ":root { --canvas: color-mix(in srgb, var(--canvas) 90%, transparent); }",
    "[data-shell-part='rail'] { background: transparent; }",
    "[data-msg-index] .bg-bubble-user { border-radius: 14px; }"
  ]
}
```

- `css` 是**字符串数组**，每个元素是一条独立的 CSS 片段，按顺序注入 `<style data-plugin-css>`（使用 `textContent` 写入，内容不会被当作 HTML 解析；引擎还会剥掉 `</style` 作双保险）。
- 片段里可以用 v1.5 之前的所有 CSS 变量（见第 2 节），也可以为整个应用写任意**纯样式**规则。
- 主题切换 / 卸载时，背景层与全部自定义样式会一起移除，应用内置样式原样恢复。

### 9.3 安全边界（v1.5）

- **纯样式、零脚本**：`background` 与 `css` 只产生样式，引擎不解析、不执行任何 JavaScript；CSS 里的 `url(...)` 会被浏览器按 CSS 规则发起请求，所以**只应引用插件自己目录里的资源**（`assets/`），不要依赖外部地址。
- **只读**：样式只能改观感（颜色 / 尺寸 / 布局），接触不到你的会话内容 / 文件 / 网络数据——它们不在 DOM 里。
- **资源路径**：`image` 使用本地文件路径时，仅能加载 WebView 可访问的位置；插件目录之外的路径能否读取由系统的 asset 权限决定。
- **性能**：`blur` 上限 100px（引擎强制）；全屏大图 + 大模糊的组合可能拖慢低配机器，发布前请自测。

### 9.4 可用锚点（data-* 属性清单）

自定义样式挂在哪，以应用现有的 `data-*` 属性为准（比 class 稳定，class 可能随样式重构变化）。以下为当前版本可确认的锚点：

| 锚点 | 位置 |
| --- | --- |
| `data-tauri-drag-region` | 标题栏（含 `.glass-topbar` 毛玻璃） |
| `data-shell-part="rail"` | 左侧一级导航栏 |
| `data-shell-part="list"` | 会话列表（`data-list-variant` 区分 inline / drawer） |
| `data-shell-part="dock"` / `"dockbar"` / `"dockpane"` | 右侧栏根 / 图标条 / 预览面板 |
| `data-nav-key` | 导航项（chat / skills / artifacts / settings） |
| `data-plugins-entry` / `data-help-entry` | 侧栏「插件」「帮助」入口按钮 |
| `data-plugins-center` | 插件中心面板 |
| `data-main-col` / `data-content-layer` / `data-view` | 主内容列 / 内容层 / 当前页面 |
| `data-chat-col` | 会话主列（输入区 textarea 的宿主） |
| `data-msg-scroller` | 消息滚动容器 |
| `data-msg-index` / `data-msg-id` | 单条消息（消息气泡类 `.bg-bubble-user` 在其中） |
| `data-msg-meta` / `data-msg-time` | 消息元信息（模型名 / 时间） |
| `data-dock-tab` | 右侧栏页签内容（files / context / artifacts / tasks / stats / preview） |
| `data-resize-handle` | 面板分割条 |

> 菜单、悬浮层、弹窗由组件库临时挂 `data-state="open"` 之类的瞬态属性，不做稳定样式锚点；需要动它们的观感，请优先走颜色 / 圆角令牌。

## 10. theme.json v1.6：mascot 形象挂点

v1.6 起新增可选字段 **`mascot`**：把应用里几处固定出现品牌图的地方换上插件自己的形象（logo / 助手头像 / 输入框吉祥物）。它跟 `background` / `css` 一样可以独立使用——只换形象、不改任何颜色的主题完全合法。所有路径都建议写插件目录内图片的**绝对路径**（同 `background.image`：桌面端经 `convertFileSrc` 转 `asset://` 加载；`http(s)://` 等 URL 也接受）。

```json
{
  "mascot": {
    "logo": "C:\\Users\\you\\AppData\\Roaming\\Coomi\\plugins\\my-theme\\assets\\mascot-logo.png",
    "avatar": "C:\\Users\\you\\AppData\\Roaming\\Coomi\\plugins\\my-theme\\assets\\mascot-avatar.png",
    "composer": "C:\\Users\\you\\AppData\\Roaming\\Coomi\\plugins\\my-theme\\assets\\mascot-composer.png"
  }
}
```

| 字段 | 挂点 | 说明 |
| --- | --- | --- |
| `logo` | `[data-theme-mascot="logo"]` | 左侧导航栏顶部 logo 与空态 hero 大标题上方的 logo，替换挂点 <img> 的 src；原 src 缓存进 `dataset.themeOrig`，卸载 / 恢复主题时原样回来。 |
| `avatar` | `[data-theme-mascot="avatar"]` | 消息列表每条助手消息左侧的默认头像（v1.6 起新增，默认用内置 logo）。 |
| `composer` | `[data-theme-composer-mascot]` | 输入框右侧的挂点：引擎向该容器注入一张 <img>（空挂点零尺寸不占位、不遮输入、点击穿透），图片最大 64px。 |

### 10.1 行为与边界（v1.6）

- **替换 vs 注入**：`logo` / `avatar` 是「把挂点 <img> 的 src 换成插件图」；`composer` 是「向挂点容器注入一张 img」。主题切换 / 卸载时全部恢复 / 移除，内置形象原样回来。
- **随时生效**：切换页面、会话或挂点重新挂载时，已生效主题的 mascot 会自动补挂到新挂点上（前端引擎有挂点观察器补偿），无需重新应用主题。
- **纯资源、零脚本**：mascot 只加载图片、不执行任何代码（`url(...)` 类资源仍只应引用插件自己目录里的 `assets/`）。


## 11. theme.json v1.7：parts 部件外观（发送键 / 输入框 / 工具栏 / 侧栏 / 气泡）

v1.7 起新增可选字段 **`parts`**：定制几个具体部件的细节外观。与 design tokens（CSS 变量）不同，parts 管的是**部件级**的观感与显隐：发送键的文案 / 图标 / 位置 / 主色、输入框的占位文案 / 圆角 / 最小高度、工具栏按钮的显隐、侧栏 logo 圆角与导航图标颜色、消息气泡的圆角与阴影。所有字段都可选，没写的保持内置外观；卸载 / 切换主题时全部还原。

```json
{
  "parts": {
    "composer": {
      "sendButton": {
        "label": "发送",
        "icon": "C:\\Users\\you\\AppData\\Roaming\\Coomi\\plugins\\my-theme\\assets\\send.png",
        "position": "left",
        "accent": true
      },
      "input": { "placeholder": "问我任何问题…", "radius": 14, "minHeight": 64 },
      "toolbar": { "showAttach": false, "showModel": false, "showSearch": true }
    },
    "rail": { "logoRadius": 6, "iconColor": "#9fb3c8" },
    "bubbles": {
      "user": { "radius": 12, "shadow": "0 2px 8px rgba(0,0,0,0.18)" },
      "assistant": { "radius": 12, "shadow": "0 1px 6px rgba(0,0,0,0.10)" }
    }
  }
}
```

### 11.1 字段说明

**`composer.sendButton`（发送键）**

| 字段 | 说明 |
| --- | --- |
| `label` | 按钮文案。缺省是纯图标按钮（没有文字）；给了文案后按钮变宽并显示文字。 |
| `icon` | 自定义发送图标：本地图片路径（同 `background.image` / `mascot`：桌面端经 `convertFileSrc` 转 `asset://`；`http(s)://` 等 URL 也接受），替换默认的 ↑ 图标。生成中仍是「停止」方块，不受影响。 |
| `position` | 按钮位置：`"left"` 挪到输入行最左侧；缺省在工具栏右下角。 |
| `accent` | `true` 时发送键常驻主色（primary）样式；缺省随「有没有输入」走（空输入是灰色禁用钮）。 |

**`composer.input`（输入框）**

| 字段 | 说明 |
| --- | --- |
| `placeholder` | 占位文案，替换内置的「描述你的任务，Enter 发送 / Shift+Enter 换行」。 |
| `radius` | 输入框与容器的圆角（px）。 |
| `minHeight` | 输入框与容器的最小高度（px）。 |

**`composer.toolbar`（工具栏按钮显隐，缺省全部显示）**

| 字段 | 说明 |
| --- | --- |
| `showAttach` | 附件按钮显隐。 |
| `showModel` | 模型选择按钮显隐。 |
| `showSearch` | 技能按钮显隐。 |

**`rail`（左侧导航栏）**

| 字段 | 说明 |
| --- | --- |
| `logoRadius` | logo 圆角（px 或任意 CSS 值），覆盖内置 `rounded-xl`。 |
| `iconColor` | 导航图标颜色（任意 CSS 颜色值），经 CSS 变量 `--rail-icon` 下发；不写则用内置 `ink-3`。 |

**`bubbles`（消息气泡）**

| 字段 | 说明 |
| --- | --- |
| `user.radius` / `assistant.radius` | 气泡圆角（px）。用户气泡内置是 `18px`（右上角 6px）；助手正文容器内置无圆角。 |
| `user.shadow` / `assistant.shadow` | 气泡阴影（任意合法 CSS `box-shadow` 值），内联覆盖。 |

### 11.2 下发通道与边界（v1.7）

- **下发通道**：引擎把 parts 摊平成 `<html>` 上的 `data-theme-part-*` 自定义属性（如 `data-theme-part-composer-send-label`、`data-theme-part-bubbles-user-radius`），React 组件经 `useThemeParts()` 订阅读取；主题切换 / 卸载时引擎移除全部属性并广播变更，组件自动还原内置外观。
- **优先级**：parts 的内联样式覆盖对应组件的内置 class（圆角 / 阴影 / 颜色）；不写的字段不产生任何属性，保持内置。
- **与 `css` 的关系**：parts 是「组件级配置」，`css` 是「任意样式规则」；两者可以混用，`css` 里用 `!important` 或更具体的选择器可以再压过 parts。
- **纯配置、零脚本**：parts 只改观感与显隐，不执行任何代码；`icon` 等资源路径仍只应引用插件自己目录里的 `assets/`。

