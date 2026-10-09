/** 设置页搜索：静态索引 + 过滤 + 高亮 + 键盘导航。
 *
 *  为什么是「静态索引」：设置页两百多个格子全是写死在 JSX 里的静态数据（标签 / 说明文案），
 *  没有全文检索的必要 —— 用 useMemo 按关键词把命中的条目算出来，未命中的分组整组收起。
 *  命中项的关键词高亮复用现有 accent（--primary 系列令牌），键盘 ↑/↓ 在命中项间移动、
 *  Enter 聚焦该项、Esc 清空 —— 全部集中在这个文件里，SettingsView 只负责把条目
 *  包进 SearchableCell（普通格子）/ Searchable（自定义卡片与数据面板）。
 *
 *  为什么索引在组件外：它是纯静态表，写在组件里等于每次渲染都重建一份，
 *  依赖它的 useMemo 引用永远在变（连带所有订阅者一起重渲染）。 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ComponentProps, type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react'
import { Cell, Section } from '../components/ui/Card'
import { cn } from '../lib/cn'
import type { Capabilities } from '../stores/capabilities'

/** 分组表：左列导航（SettingsView 的 GroupNav 也用这份，搬到这里避免两处漂移）。 */
export const GROUPS = [
  { key: 'general', label: '通用' },
  { key: 'appearance', label: '外观' },
  { key: 'models', label: '模型与厂商' },
  { key: 'workspace', label: '工作区' },
  { key: 'ai', label: 'AI 能力' },
  { key: 'life', label: '数字生命体' },
  { key: 'engine', label: '引擎与诊断' },
  { key: 'about', label: '关于' },
] as const

/** 分组 key 的联合类型（表在上面，类型跟着表走）。 */
export type GroupKey = (typeof GROUPS)[number]['key']

/** 分组的检索文案：Section 的标题 + 描述（任务里的「描述」指的就是它们）。
 *  与 SettingsView 里 Section 的 title/description 保持一致，搜索「分组标题」也能命中整组。 */
const GROUP_META: Record<GroupKey, { title: string; description: string }> = {
  general: { title: '通用', description: '启动行为、发送行为与危险操作的确认策略。' },
  appearance: { title: '外观', description: '主题、字号、密度与消息栏宽度。' },
  models: { title: '模型与 Provider', description: 'OpenAI 兼容接口；当前使用的 Provider 决定对话走哪条链路。' },
  workspace: { title: '工作区', description: '新会话默认落在哪个目录。' },
  ai: { title: 'AI 能力', description: '每一项都能单独开关；关闭立即生效，情感类默认关闭以免影响输出风格。' },
  life: { title: '数字生命体', description: '常驻伙伴的主动问候与免打扰策略。' },
  engine: { title: '引擎与诊断', description: '后台引擎进程的状态与维护。' },
  about: { title: '关于', description: '版本、许可与项目信息。' },
}

/** 一条可检索的设置项。 */
export interface SearchEntry {
  /** 全局唯一键：过滤、键盘导航、滚动定位、聚焦都靠它。 */
  key: string
  group: GroupKey
  /** 标题（参与匹配与高亮）。 */
  label: string
  /** 提示文案（参与匹配与高亮；界面实际显示的动态文案由视图用 hint 覆盖）。 */
  hint: string
  /** 额外检索词：选项文案、别名等，不参与高亮。 */
  keywords?: string[]
}

/** 设置项静态索引（模块级常量）。动态 hint 的条目这里只放一句「可检索的摘要」，
 *  界面显示的动态文案由 SettingsView 通过 SearchableCell 的 hint 覆盖参数传入。 */
export const E = {
  // ── 通用 ──
  generalStartup: { key: 'g.startup', group: 'general', label: '启动时打开的页面', hint: '下次启动默认进入这个页面', keywords: ['默认页'] },
  generalInsertMode: { key: 'g.insertMode', group: 'general', label: '发送时插话模式', hint: '插队：生成中按 Enter 打断当前轮并立刻发送；排队：本轮跑完再按顺序执行（不打断、不丢内容）', keywords: ['插队', '排队'] },
  generalConfirmDanger: { key: 'g.confirmDanger', group: 'general', label: '危险操作二次确认', hint: '删除对话、卸载技能、清理缓存前先问一次', keywords: ['确认', '删除'] },
  generalSafeMode: { key: 'g.safeMode', group: 'general', label: '安全模式', hint: '界面卡死 / 一卡一顿时打开：关掉动效、富预览、语法高亮与虚拟化，只画纯文本', keywords: ['精简模式', '自救', '纯文本'] },
  generalPermission: { key: 'g.permission', group: 'general', label: '任务放行程度', hint: '危险操作与删除类操作由谁确认：每次询问 / 自动放行 / 完全放行', keywords: ['权限', '审批'] },
  generalCloseToTray: { key: 'g.closeToTray', group: 'general', label: '关闭窗口时最小化到托盘', hint: '后台继续运行引擎与正在跑的任务；从托盘图标可以再打开或退出', keywords: ['托盘'] },
  generalAutostart: { key: 'g.autostart', group: 'general', label: '开机自动启动', hint: '登录后在后台启动 CoomiPlus（不弹出窗口，直接进托盘）', keywords: ['自启', '开机'] },
  generalCheckUpdatesOnStartup: { key: 'g.checkUpdatesOnStartup', group: 'general', label: '启动时检查更新', hint: '启动后静默检查一次新版本，发现更新才提示（默认开）', keywords: ['更新', '升级', '自动检查'] },

  // ── 外观 ──
  appearanceFont: { key: 'a.font', group: 'appearance', label: '字体', hint: '默认内置 HarmonyOS Sans SC；系统字体更省内存', keywords: ['HarmonyOS', '系统字体'] },
  appearanceTheme: { key: 'a.theme', group: 'appearance', label: '主题', hint: '跟随系统会随 Windows 深浅色切换', keywords: ['浅色', '深色', '暗色'] },
  appearancePluginTheme: { key: 'a.pluginTheme', group: 'appearance', label: '插件主题', hint: '插件提供的整套配色与圆角令牌；切换立即生效，选「默认」恢复内置主题。', keywords: ['主题插件'] },
  appearanceFontSize: { key: 'a.fontSize', group: 'appearance', label: '界面字号', hint: '全局缩放，中英文一起变；改完立即生效并记住', keywords: ['字体大小', '缩放'] },
  appearanceDensity: { key: 'a.density', group: 'appearance', label: '界面密度', hint: '控制页面留白与行高', keywords: ['紧凑', '舒适'] },
  appearanceMessageWidth: { key: 'a.messageWidth', group: 'appearance', label: '消息栏宽度', hint: '对话正文的宽度：固定档或自适应，另有实时预览', keywords: ['消息宽度', '自适应', '阅读上限'] },
  appearanceMotion: { key: 'a.motion', group: 'appearance', label: '界面动效', hint: '关闭后所有过渡与动画立即完成', keywords: ['动画', '过渡'] },
  appearanceRotateCopy: { key: 'a.rotateCopy', group: 'appearance', label: '空态文案轮换', hint: '新对话首屏那句标题每 14 秒上下翻页换一组（默认开）', keywords: ['空态', '轮换'] },
  appearancePerf: { key: 'a.perf', group: 'appearance', label: '性能模式', hint: '机器吃紧或要省电时打开：关毛玻璃与点阵动效、长会话更早虚拟化（省电档）', keywords: ['省电', '性能'] },

  // ── 模型与 Provider ──
  modelsThinking: { key: 'm.thinking', group: 'models', label: '思考强度', hint: '推理深度：自动 / 低 / 中 / 高 / 极高 / 极限', keywords: ['推理', 'effort'] },
  modelsMaxToolRounds: { key: 'm.maxToolRounds', group: 'models', label: '单轮最大工具调用次数', hint: '复杂任务可调高；过高会让一轮跑很久。', keywords: ['工具', '轮次'] },
  modelsAddProvider: { key: 'm.addProvider', group: 'models', label: '添加厂商', hint: '选接口类型 → 填地址与 API Key → 获取模型', keywords: ['新增', '接口', 'OpenAI 兼容'] },
  modelsProviders: { key: 'm.providers', group: 'models', label: '厂商列表', hint: '已配置的 OpenAI 兼容接口，可编辑 / 删除；激活的厂商决定对话链路', keywords: ['Provider', '模型', '厂商'] },
  modelsEmpty: { key: 'm.empty', group: 'models', label: '还没有 Provider', hint: '添加一个 OpenAI 兼容接口即可开始对话', keywords: ['空', '未配置'] },

  // ── 工作区 ──
  workspaceDefaultCwd: { key: 'w.defaultCwd', group: 'workspace', label: '默认工作目录', hint: '新会话默认落在哪个目录', keywords: ['工作目录', 'cwd'] },
  workspaceOpenInExplorer: { key: 'w.openInExplorer', group: 'workspace', label: '在资源管理器中打开', hint: '当前默认工作目录的实际位置', keywords: ['资源管理器', '文件夹'] },
  workspaceRecentCwd: { key: 'w.recentCwd', group: 'workspace', label: '最近使用过的目录', hint: '之前打开过的目录（可一键切回）', keywords: ['历史', '最近'] },

  // ── AI 能力（循环开关之外的静态项）──
  aiLocalTrace: { key: 'ai.localTrace', group: 'ai', label: '本地留痕', hint: '每轮任务在本机落一行 trajectory.jsonl（默认开，只存本机、不上传）', keywords: ['轨迹', '留痕', 'jsonl'] },
  aiTraceMax: { key: 'ai.traceMax', group: 'ai', label: '留痕体积上限', hint: '控制 trajectory.jsonl 的体积上限（MB）；0 = 不限', keywords: ['体积', '轨迹', '上限'] },
  aiCompressionThreshold: { key: 'ai.compressionThreshold', group: 'ai', label: '压缩触发阈值', hint: '上下文占用超过该比例时压缩（0.5–0.95）', keywords: ['压缩', '比例'] },
  aiSubagentConcurrency: { key: 'ai.subagentConcurrency', group: 'ai', label: '子代理并发上限', hint: '0–5；设 0 等同关闭子代理', keywords: ['并发', '子代理'] },
  aiAskUserTimeout: { key: 'ai.askUserTimeout', group: 'ai', label: '提问等待超时', hint: '等待回答超过这个时长就自动跳过，不让整轮对话干等（一直等 / 5 / 15 / 60 分钟）', keywords: ['超时', '等待', '跳过'] },
  aiRetryCount: { key: 'ai.retryCount', group: 'ai', label: '自动恢复重试次数', hint: '0 = 关闭自动重试；1–254 = 自动重试次数；无限 = 一直自动重试直到成功或非瞬时错误', keywords: ['重试', '自动恢复', '429', '无限', '255'] },
  aiRetryDelay: { key: 'ai.retryDelay', group: 'ai', label: '重试间隔上限（秒）', hint: '429 限流等瞬时错误的重试等待上限（30–120 秒）', keywords: ['重试间隔', '退避', '延迟'] },
  aiCompactionPanel: { key: 'ai.compactionPanel', group: 'ai', label: '上下文压缩（自动压缩小节）', hint: '自动压缩何时触发、压完留多少（触发比例 / 下限 / 保留区 / 消息条数）', keywords: ['自动压缩', '压缩', '保留区'] },
  aiLessons: { key: 'ai.lessons', group: 'ai', label: '经验库', hint: '长期记忆开关下真正被引擎记住的那些失败经验（可查看 / 可删）', keywords: ['经验', '失败', '记忆'] },
  aiTrajectory: { key: 'ai.trajectory', group: 'ai', label: '任务轨迹', hint: '每轮任务的成败 / 失败类型 / 轮次 / 最后的工具 / 耗时', keywords: ['回放', '轨迹', 'jsonl'] },

  // ── 数字生命体 ──
  lifeEnabled: { key: 'l.enabled', group: 'life', label: '启用数字生命体', hint: '拥有情绪、羁绊与长期记忆的常驻伙伴', keywords: ['生命体', '启用'] },
  lifeDailyMode: { key: 'l.dailyMode', group: 'life', label: '每日主动上限', hint: '控制一天最多主动找你几次', keywords: ['主动', '问候'] },
  lifeDailyCustom: { key: 'l.dailyCustom', group: 'life', label: '自定义条数', hint: '每天 1–100 条', keywords: ['自定义', '条数'] },
  lifeQuietWindow: { key: 'l.quietWindow', group: 'life', label: '免打扰时段', hint: '这段时间内不会主动打扰你', keywords: ['免打扰', '勿扰', '时段'] },
  lifeGlobal: { key: 'l.global', group: 'life', label: '用在所有对话', hint: '关闭时只有常驻会话使用数字生命体人格', keywords: ['全局', '人格'] },

  // ── 引擎与诊断 ──
  engineStatus: { key: 'e.status', group: 'engine', label: '运行状态', hint: '后台引擎进程：运行中 / 启动中 / 已停止 / 异常', keywords: ['状态', '进程', '端口'] },
  engineCrashRecovery: { key: 'e.crashRecovery', group: 'engine', label: '崩溃后恢复方式', hint: '引擎崩溃并重启后：一键继续（提示后手动）或自动继续', keywords: ['崩溃', '恢复', '继续'] },
  engineVersion: { key: 'e.version', group: 'engine', label: '引擎版本', hint: '后台引擎进程的版本号', keywords: ['版本'] },
  engineDataDir: { key: 'e.dataDir', group: 'engine', label: '数据目录', hint: '会话与配置存放的位置', keywords: ['目录', '数据'] },
  engineLog: { key: 'e.engineLog', group: 'engine', label: '引擎日志', hint: '查看引擎运行日志的末尾 300 行（只读）', keywords: ['日志', 'log'] },
  engineCrashLog: { key: 'e.crashLog', group: 'engine', label: '崩溃日志', hint: '引擎崩溃时的日志文件', keywords: ['崩溃', '日志'] },
  engineMaintenance: { key: 'e.maintenance', group: 'engine', label: '维护', hint: '备份会话与配置，或清理缓存（不影响会话）', keywords: ['备份', '清理', '缓存'] },
  engineMirror: { key: 'e.mirror', group: 'engine', label: '下载与镜像', hint: 'git 克隆、Release 与源码包下载的镜像源（npmmirror / 清华 TUNA / 阿里云 / 中科大）', keywords: ['镜像', '下载', '源'] },
  engineStorage: { key: 'e.storage', group: 'engine', label: '存储位置', hint: '会话、日志与留痕等文件的存储位置，可查看与迁移', keywords: ['存储', '迁移', '位置'] },
  engineDeveloper: { key: 'e.developer', group: 'engine', label: '开发者面板', hint: '引擎指标、能力开关与会话上下文的原始数据；只读，方便贴进问题反馈。', keywords: ['开发者', '调试', '指标'] },

  // ── 关于 ──
  aboutHero: { key: 'ab.hero', group: 'about', label: '关于 CoomiPlus', hint: '本地优先的智能体桌面端：引擎与数据都在你的机器上，模型通过你自己的 Provider 接入。' },
  aboutClientVersion: { key: 'ab.clientVersion', group: 'about', label: '客户端版本', hint: '当前安装的版本', keywords: ['版本'] },
  aboutEngineVersion: { key: 'ab.engineVersion', group: 'about', label: '引擎版本', hint: '后台引擎进程的版本号', keywords: ['版本'] },
  aboutCheckUpdate: { key: 'ab.checkUpdate', group: 'about', label: '检查更新', hint: '只查询版本信息，不上传任何本地数据；有新版可一键更新或手动下载', keywords: ['更新', '升级', '下载'] },
  aboutUpdateProgress: { key: 'ab.updateProgress', group: 'about', label: '更新进度', hint: '下载 → 校验 → 安装的实时进度与速度', keywords: ['进度', '下载', '安装'] },
  aboutAuthor: { key: 'ab.author', group: 'about', label: '制作人', hint: '星奈_Star', keywords: ['作者'] },
  aboutUpdateDetails: { key: 'ab.updateDetails', group: 'about', label: '更新详情', hint: '当前版本 / 最新版本 / 安装包大小 / 发布时间与更新说明', keywords: ['版本', '说明'] },
  aboutOpenSource: { key: 'ab.openSource', group: 'about', label: '开源说明', hint: 'CoomiPlus Desktop 目前是 Beta 测试版，源代码暂不开放；正式版发布后我们会把源代码开源出来。', keywords: ['开源', '源码'] },
  aboutDataDir: { key: 'ab.dataDir', group: 'about', label: '数据目录', hint: '会话与配置存放的位置', keywords: ['目录', '数据'] },
  aboutLog: { key: 'ab.log', group: 'about', label: '运行日志', hint: '引擎运行日志文件的位置', keywords: ['日志', 'log'] },
  aboutPrivacy: { key: 'ab.privacy', group: 'about', label: '隐私与使用说明', hint: '三步看完：这是什么、数据与隐私、权限与风险；内容有更新时会在启动时再提示一次', keywords: ['隐私', '说明', '新手'] },
  aboutFonts: { key: 'ab.fonts', group: 'about', label: '字体与许可', hint: '内置 HarmonyOS Sans SC（华为，免费商用），许可随包分发', keywords: ['字体', '许可', '版权'] },
  aboutFooter: { key: 'ab.footer', group: 'about', label: '数据安全', hint: '数据不出本机：会话、记忆、密钥都存本地；记忆与上下文可随时清空', keywords: ['隐私', '安全', '数据'] },
} satisfies Record<string, SearchEntry>

/** 「AI 能力」组的 19 个能力开关：capKey 是 capabilities 里的键，label/hint 与开关一致。
 *   SettingsView 的循环用它渲染，避免标签文案在两处各写一份。 */
export const AI_TOGGLE_ENTRIES: Array<SearchEntry & { capKey: keyof Capabilities }> = [
  { key: 'ai.memory', capKey: 'memory', group: 'ai', label: '长期记忆', hint: '跨会话记住事实与偏好，相关时自动注入', keywords: ['记忆'] },
  { key: 'ai.memoryWrite', capKey: 'memoryWrite', group: 'ai', label: '记忆写入', hint: '关闭后只读不写，不再记录新记忆', keywords: ['记忆', '写入'] },
  { key: 'ai.memoryAutoInject', capKey: 'memoryAutoInject', group: 'ai', label: '自动注入', hint: '关闭后 AI 仍可主动检索记忆', keywords: ['记忆', '注入', '检索'] },
  { key: 'ai.memoryVector', capKey: 'memoryVector', group: 'ai', label: '向量检索', hint: '关闭后退回关键词匹配', keywords: ['记忆', '检索', '向量'] },
  { key: 'ai.compression', capKey: 'compression', group: 'ai', label: '上下文压缩', hint: '接近上限时自动压缩历史', keywords: ['压缩', '历史'] },
  { key: 'ai.autoPinMilestones', capKey: 'autoPinMilestones', group: 'ai', label: '自动钉住里程碑', hint: '关键结论不参与压缩', keywords: ['里程碑', '压缩'] },
  { key: 'ai.promptLayering', capKey: 'promptLayering', group: 'ai', label: '提示词分层', hint: '按层组装系统提示，各自独立预算', keywords: ['提示词', '分层'] },
  { key: 'ai.skillOnDemand', capKey: 'skillOnDemand', group: 'ai', label: '技能按需注入', hint: '只在相关时注入技能，避免瞎用', keywords: ['技能', '注入'] },
  { key: 'ai.toolEnhance', capKey: 'toolEnhance', group: 'ai', label: '工具质量增强', hint: '参数校验 / 失败重试 / 结果裁剪 / 缓存', keywords: ['工具', '重试'] },
  { key: 'ai.trustGate', capKey: 'trustGate', group: 'ai', label: '信任驱动放行', hint: '连续成功自动升级放行，失败回落询问', keywords: ['信任', '放行'] },
  { key: 'ai.emotionTone', capKey: 'emotionTone', group: 'ai', label: '情绪语气适配', hint: '让回复语气随情绪与羁绊变化（默认关）', keywords: ['情绪', '语气'] },
  { key: 'ai.persona', capKey: 'persona', group: 'ai', label: '人格注入', hint: '把人格描述写进系统提示（默认关）', keywords: ['人格'] },
  { key: 'ai.subagents', capKey: 'subagents', group: 'ai', label: '子代理', hint: '允许主 AI 派发一对一子代理任务', keywords: ['子代理', 'agent'] },
  { key: 'ai.notifyGuard', capKey: 'notifyGuard', group: 'ai', label: '后台通知护栏', hint: '尊重免打扰时段与每日上限', keywords: ['通知', '免打扰'] },
  { key: 'ai.backgroundNotify', capKey: 'backgroundNotify', group: 'ai', label: '后台完成提醒', hint: '窗口不在前台时，一轮回复结束后提醒你', keywords: ['通知', '提醒'] },
  { key: 'ai.askUser', capKey: 'askUser', group: 'ai', label: '反问澄清', hint: '信息不足时让 AI 先问一句，而不是自己猜着做', keywords: ['反问', '澄清', '提问'] },
  { key: 'ai.showArtifacts', capKey: 'showArtifacts', group: 'ai', label: '生成物卡片', hint: '一轮结束后在回复下方列出本轮产出的文件（点开预览，右键另存）；关掉只是不显示这排卡片', keywords: ['产物', '卡片', '文件'] },
  { key: 'ai.allowSaveAsRequest', capKey: 'allowSaveAsRequest', group: 'ai', label: '允许另存为', hint: '产物卡片与预览面板里出现「另存为…」，点击会弹系统保存对话框（默认关，避免打断）', keywords: ['另存为', '保存'] },
  { key: 'ai.metrics', capKey: 'metrics', group: 'ai', label: '开发者度量', hint: '本地记录质量指标（不上传）', keywords: ['度量', '指标'] },
]

/* 全部可检索条目的扁平表（**懒建**）。
 *
 *  为什么不是模块级常量：扁平表由「两条 filter + 三次展开」拼出来，
 *  写在模块顶层就意味着 **import 这个模块的那一帧**要把它算完 ——
 *  而设置页整块是路由级懒加载的（App.tsx 的 lazy），切到设置页时这一帧
 *  正是首帧，用户等的就是这一帧。绝大多数时候没人会搜索它。
 *
 *  为什么也不拆成单独的 chunk：这里建的是一张一百来条的**引用**表（不复制文案，
 *  只是把 E 与 AI_TOGGLE_ENTRIES 的条目收集起来），开销远小于设置页那 200+ 个格子的渲染 ——
 *  真正的大头是渲染本身（每个格子还包一层 motion 变体项），那已经由 firstFrame 与
 *  「只挂当前分组」挡住了。把它挪到首帧之后，抵不上多一次模块边界的代价。
 *
 *  顺序刻意排成「渲染顺序」：非 AI 组 → AI 能力开关循环 → AI 组其它静态项 → AI 组数据面板，
 *  这样 ↑/↓ 键盘导航的循环顺序与页面上的视觉顺序一致。
 * 只建一次（结果缓存），引用恒定 —— 依赖它的 useMemo 才不会每次渲染都失效。 */
let indexCache: SearchEntry[] | null = null

/** 取扁平索引：**第一次调用时才建**，之后一直复用同一份（引用恒定）。
 *  只有用户真的敲了检索词才会走到这里（见 useSettingsSearchState 的 flatMatches）。 */
export function settingsIndex(): SearchEntry[] {
  if (indexCache) return indexCache
  indexCache = [
    ...Object.values(E).filter((e) => e.group !== 'ai'),
    ...AI_TOGGLE_ENTRIES,
    ...Object.values(E).filter((e) => e.group === 'ai'),
  ]
  return indexCache
}

/** 检索词归一：去首尾空白 + 小写（中文不受影响，英文大小写不敏感）。 */
function normalize(q: string): string {
  return q.trim().toLowerCase()
}

/** 大小写不敏感的包含判断：空检索词一律不命中。 */
function includesCI(haystack: string, needle: string): boolean {
  const n = normalize(needle)
  return n !== '' && haystack.toLowerCase().includes(n)
}

/** 条目是否命中查询：标题 / 提示文案 / 额外检索词，三路任意一路命中即可。 */
function hitTest(entry: SearchEntry, query: string): boolean {
  if (!normalize(query)) return true
  return (
    includesCI(entry.label, query) ||
    includesCI(entry.hint, query) ||
    (entry.keywords?.some((k) => includesCI(k, query)) ?? false)
  )
}

/** 命中关键词高亮：把 text 里所有命中片段包进 <mark>，样式用现有 accent（primary 系）。
 *  查询为空时原样返回文本，不做任何包装。 */
export function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const q = normalize(query)
  if (!q) return text
  const lower = text.toLowerCase()
  const parts: ReactNode[] = []
  let from = 0
  let markNo = 0
  while (from < text.length) {
    const idx = lower.indexOf(q, from)
    if (idx < 0) {
      parts.push(text.slice(from))
      break
    }
    if (idx > from) parts.push(text.slice(from, idx))
    parts.push(
      <mark key={'hl' + markNo++} className='rounded-[3px] bg-primary-soft px-0.5 text-primary'>
        {text.slice(idx, idx + q.length)}
      </mark>,
    )
    // 跳到命中片段之后，避免同一处被重复包（重叠匹配只高亮第一次）。
    from = idx + q.length
  }
  return parts
}

/* ── 搜索上下文：查询词（150ms 防抖）+ 命中结果 + 键盘导航状态 ── */

export interface SettingsSearchApi {
  /** 输入框原文（未防抖，立即回显给用户）。 */
  raw: string
  setRaw: (v: string) => void
  /** 防抖后的查询词（过滤 / 高亮都用它）。 */
  query: string
  /** 有命中的分组（含「仅标题/描述命中」的整组）。 */
  groupHits: ReadonlySet<GroupKey>
  /** 仅因为分组标题/描述命中而整组显示的组：组内条目不做逐条过滤。 */
  groupTitleHits: ReadonlySet<GroupKey>
  /** 键盘导航当前选中的命中项 key（无命中时 null）。 */
  activeKey: string | null
  /** ↑/↓ 移动选中（循环）。 */
  moveActive: (delta: 1 | -1) => void
  /** Enter：滚动到该项并把焦点交给它内部的第一个可交互控件。 */
  activate: () => void
  /** Esc：清空搜索。 */
  clear: () => void
  /** 搜索框的按键处理（↑/↓/Enter/Esc 集中在这）。 */
  onInputKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>) => void
  /** 命中的格子把 DOM 节点登记进来（供滚动定位 / 聚焦），key 为空时注销。 */
  registerRef: (key: string, el: HTMLElement | null) => void
  /** 有搜索词且一个都没命中（含分组标题/描述）。 */
  noResults: boolean
}

const SettingsSearchContext = createContext<SettingsSearchApi | null>(null)

export function useSettingsSearch(): SettingsSearchApi {
  const api = useContext(SettingsSearchContext)
  if (!api) throw new Error('useSettingsSearch 必须在 <SettingsSearchProvider> 内使用')
  return api
}

/** 搜索状态（全部逻辑在这一个 hook 里）：SettingsView 调用它拿到结果，
 *  再把同一个对象塞进 SettingsSearchProvider，供整棵子树（Searchable / SearchableCell）消费。
 *  为什么不让 Provider 自己持有状态：SettingsView 自己也要读 query / groupHits
 *  （Section 可见性、搜索框），而 SettingsView 是 Provider 的父级，读不到自己的 context。 */
export function useSettingsSearchState(): SettingsSearchApi {
  const [raw, setRaw] = useState('')
  const [query, setQuery] = useState('')
  // 150ms 防抖：索引与过滤都是静态数据，敲到一半的查询不值得重算渲染。
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(raw), 150)
    return () => window.clearTimeout(timer)
  }, [raw])

  /* 命中列表：只有防抖后的查询词变了才重算。
     **空查询词直接短路，连索引都不建** —— 平时（不搜索）这份表一次都不会被拼出来，
     这就是「懒建」落地的地方；useMemo 保证同一次查询词下不重复过滤。 */
  const flatMatches = useMemo(() => {
    if (!normalize(query)) return []
    return settingsIndex().filter((e) => hitTest(e, query))
  }, [query])

  const { groupHits, groupTitleHits } = useMemo(() => {
    const q = query
    const titleHits = new Set<GroupKey>()
    const hits = new Set<GroupKey>()
    if (normalize(q)) {
      for (const g of GROUPS) {
        const meta = GROUP_META[g.key]
        // 分组标题 / 描述命中 → 整组放行；否则看组里有没有条目命中。
        const byText = includesCI(g.label, q) || includesCI(meta.title, q) || includesCI(meta.description, q)
        const byItem = flatMatches.some((e) => e.group === g.key)
        if (byText) titleHits.add(g.key)
        if (byText || byItem) hits.add(g.key)
      }
    }
    return { groupHits: hits, groupTitleHits: titleHits }
  }, [query, flatMatches])

  const [activeIndex, setActiveIndex] = useState(0)
  // 查询词一变，键盘导航从头开始。
  useEffect(() => { setActiveIndex(0) }, [query])
  // 命中列表被查询截短后，把越界的下标夹回 0，避免 activeKey 悬空。
  useEffect(() => {
    if (flatMatches.length > 0 && activeIndex >= flatMatches.length) setActiveIndex(0)
  }, [flatMatches.length, activeIndex])

  const activeKey = flatMatches.length > 0 ? (flatMatches[activeIndex]?.key ?? null) : null

  /** 命中项的 DOM 登记表：Searchable / SearchableCell 在挂载时注册，卸载或隐藏时注销。 */
  const refs = useRef<Map<string, HTMLElement>>(new Map())
  const registerRef = useCallback((key: string, el: HTMLElement | null) => {
    if (el) refs.current.set(key, el)
    else refs.current.delete(key)
  }, [])

  const moveActive = useCallback((delta: 1 | -1) => {
    setActiveIndex((i) => {
      const len = flatMatches.length
      if (len === 0) return 0
      // (i + delta + len) % len：负数也能正确回绕。
      return (i + delta + len) % len
    })
  }, [flatMatches.length])

  const activate = useCallback(() => {
    const key = activeKey
    if (!key) return
    const el = refs.current.get(key)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    // 「聚焦该项」：优先把焦点交给格子里的第一个可交互控件（开关 / 输入 / 按钮 / 下拉）。
    const control = el.querySelector<HTMLElement>('input,button,select,textarea,a,[tabindex]')
    ;(control ?? el).focus({ preventScroll: true })
  }, [activeKey])

  const clear = useCallback(() => { setRaw(''); setQuery('') }, [])

  const onInputKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); activate() }
    else if (e.key === 'Escape') { e.preventDefault(); clear() }
  }, [moveActive, activate, clear])

  const noResults = normalize(query) !== '' && groupHits.size === 0

  const api = useMemo<SettingsSearchApi>(() => ({
    raw, setRaw, query, groupHits, groupTitleHits, activeKey,
    moveActive, activate, clear, onInputKeyDown, registerRef, noResults,
  }), [raw, query, groupHits, groupTitleHits, activeKey, moveActive, activate, clear, onInputKeyDown, registerRef, noResults])

  return api
}

/** 把搜索状态下发给整棵设置页子树（value 由 SettingsView 的 useSettingsSearchState() 提供）。 */
export function SettingsSearchProvider({ value, children }: { value: SettingsSearchApi; children: ReactNode }) {
  return <SettingsSearchContext.Provider value={value}>{children}</SettingsSearchContext.Provider>
}

/** 条目可见性：自身命中，或它所在分组仅靠「标题/描述」命中而整组放行。
 *  只有「自身命中」的条目才会出现在键盘导航里（active 恒来自 flatMatches）。 */
function useItemVisible(entry: SearchEntry): { visible: boolean; active: boolean } {
  const { query, activeKey, groupTitleHits } = useSettingsSearch()
  const hit = hitTest(entry, query)
  const visible = !query || hit || groupTitleHits.has(entry.group)
  return { visible, active: activeKey === entry.key }
}

type SearchableCellProps = {
  entry: SearchEntry
  /** 动态标题覆盖：给出时不参与高亮（entry.label 仍参与检索）。 */
  label?: ReactNode
  /** 动态提示覆盖：同上。 */
  hint?: ReactNode
} & Omit<ComponentProps<typeof Cell>, 'label' | 'hint'>

/** 设置项格子的可搜索包装（普通格子用它，替代原来的 <Cell>）：
 *  未命中直接不渲染（整格收起）；命中时 label/hint 做关键词高亮；
 *  宽格跨列由 wide 透给外层网格（动画关掉时包装层自己也要补 lg:col-span-2）。 */
export function SearchableCell(props: SearchableCellProps) {
  const { entry, label, hint, children, ...cellProps } = props
  const { query, registerRef } = useSettingsSearch()
  const { visible, active } = useItemVisible(entry)
  const ref = useRef<HTMLDivElement | null>(null)

  // 挂载 / 隐藏时登记或注销 DOM：键盘导航的滚动定位与聚焦都靠这份表。
  useEffect(() => {
    if (!visible) return
    registerRef(entry.key, ref.current)
    return () => registerRef(entry.key, null)
  }, [visible, entry.key, registerRef])

  // 被键盘导航选中时滚进可视区（block:'nearest'：尽量少动，别把整页顶来顶去）。
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  if (!visible) return null

  return (
    <div
      ref={ref}
      className={cn('min-w-0', cellProps.wide === true && 'lg:col-span-2', active && 'search-active rounded-lg ring-2 ring-primary/60')}
    >
      <Cell
        {...cellProps}
        label={label ?? <Highlight text={entry.label} query={query} />}
        hint={hint ?? (entry.hint ? <Highlight text={entry.hint} query={query} /> : undefined)}
      >
        {children}
      </Cell>
    </div>
  )
}

/** 非 Cell 内容的可搜索包装（模型页自定义卡片 / 数据面板 / 动态列表）：
 *  未命中直接不渲染；命中时可选高亮边框（active ring 由键盘导航触发）。 */
export function Searchable({ entry, wide, className, children }: {
  entry: SearchEntry
  wide?: boolean
  className?: string
  children: ReactNode
}) {
  const { registerRef } = useSettingsSearch()
  const { visible, active } = useItemVisible(entry)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!visible) return
    registerRef(entry.key, ref.current)
    return () => registerRef(entry.key, null)
  }, [visible, entry.key, registerRef])

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  if (!visible) return null

  return (
    <div
      ref={ref}
      className={cn(
        // [&>*]:flex-1：包在 Stagger 里时让里面的卡片撑满格子（与 Stagger 自己的行为一致）。
        'flex min-w-0 flex-col [&>*]:flex-1',
        wide && 'lg:col-span-2',
        active && 'search-active rounded-lg ring-2 ring-primary/60',
        className,
      )}
    >
      {children}
    </div>
  )
}

/** 带高亮标题/描述的 Section：Card 的 Section 把 title/description 声明成 string，
 *  但渲染端本来就是当 ReactNode 塞进 <h2>/<p>（nodeText 也是从 ReactNode 取文本）。
 *  这里只放宽到 ReactNode（转发时做一次收窄断言），运行时行为完全不变，
 *  让「分组标题/描述」也能参与关键词高亮。
 *
 *  mounted=false 时**整块不渲染**（不是 hidden）：设置页八个分组都写在同一棵 JSX 里，
 *  不看的那几个只带 hidden，但 React 照样会把它们全部渲染出来 —— 那是「进设置页卡一秒」的大头。
 *  视图用这个开关做分帧填充：先铺当前分组，其余的在空闲时补挂（见 SettingsView 的 mountedGroups）。
 *  注意它是「有没有挂」而不是「显不显示」：显不显示仍然由 className 里的 hidden 决定。 */
export function SearchSection(props: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
  /** 不传＝一定渲染（骨架与搜索态都用这个默认）；传 false 则这一块整个不挂载。 */
  mounted?: boolean
  children: ReactNode
}) {
  if (props.mounted === false) return null
  return (
    <Section
      className={props.className}
      actions={props.actions}
      title={props.title as string | undefined}
      description={props.description as string | undefined}
    >
      {props.children}
    </Section>
  )
}
