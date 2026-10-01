/** 首次启动引导 / 「隐私与使用说明」的**全部文案**（三步 + 免责声明）。
 *
 *  为什么文案单独一层：它是会被反复更新、而且与实现无关的东西。
 *  改这里就要动 GUIDE_CONTENT_VERSION —— 内容版本一变，已经同意过的用户会再被提示一次
 *  （只提示一次，见 components/onboarding/state.ts 的判定），这就是「说明变了要重新知情」。
 *
 *  事实来源（写之前是对着代码核过的，不是照着感觉写的）：
 *   · 数据目录 %APPDATA%\Coomi —— apps/coomi-rs/ui/src/web/mod.rs 里 home 的落地位置；
 *   · sessions / config / memory / projects / cache / skills / runtime-v2 / models / logs 等子目录
 *     与 memory/agent-memory.jsonl —— 同上，以及 life.rs / local_model.rs / market_v2.rs；
 *   · 更新检查只带版本号（User-Agent: Coomi/<版本>）—— apps/coomi-rs/services/src/update.rs；
 *   · 三档放行程度的措辞与 stores/agent.ts 的 PERMISSION_LABELS 保持一致（这里不 import，
 *     是因为引导要能独立成 chunk，不该为了三行字把 agent store 拖进来）。
 */

/** 内容版本：**改动本文件任何一句面向用户的文案就 +1**。 */
export const GUIDE_CONTENT_VERSION = 1

/** 数据目录（界面里要逐字看清的路径，统一在这里写一次）。 */
export const DATA_DIR_LABEL = '%APPDATA%\\Coomi'

/** 引导弹窗的标题与副标题。 */
export const GUIDE_TITLE = '使用前请阅读'
export const GUIDE_SUBTITLE = '三步看完：这是什么、数据与隐私、权限与风险。'

/** 强制勾选的那一句（同一份文案在首次启动与回看时都用它）。 */
export const CONSENT_LABEL = '我已阅读并同意'
export const CONSENT_HINT = '同意后才能进入；不需要登录、不绑定账号，随时可以在「设置 → 关于」再看一次。'

/** 回看模式下的顶部提示（首次启动不显示）。 */
export const REVIEW_HINT = '你已同意过这份说明；内容有更新时会在启动时再提示一次。'

export interface GuideItem {
  /** 条目主句（可以是一条路径，见 mono）。 */
  title: string
  /** 一句话说明。 */
  detail?: string
  /** 主句按等宽字体显示：路径、文件名、请求头这类要逐字看清的东西。 */
  mono?: boolean
}

export interface GuideGroup {
  heading: string
  /** 标题下的一句总述。 */
  lead?: string
  items?: GuideItem[]
  /** 语义色调：warn＝要多看一眼，ok＝「这条可以放心」。 */
  tone?: 'plain' | 'warn' | 'ok'
}

export interface GuideStep {
  id: string
  /** 步骤条上的短标签。 */
  tab: string
  /** 正文里的大标题。 */
  title: string
  /** 大标题下的一句总述。 */
  lead: string
  groups: GuideGroup[]
}

export const GUIDE_STEPS: GuideStep[] = [
  {
    id: 'what',
    tab: '这是什么',
    title: '一个本地优先的智能体桌面端',
    lead: '界面、引擎和你的数据都在同一台机器上；模型由你自己接入，会话与文件不经过我们的服务器。',
    groups: [
      {
        heading: '三句话说明白',
        items: [
          { title: '本地优先', detail: '引擎进程就在本机运行；关掉窗口、断网都还能打开自己的会话与设置。' },
          { title: '数据在你自己机器上', detail: '会话、记忆、配置与密钥都写在 ' + DATA_DIR_LABEL + ' 里，下一步把每一样东西列清楚。' },
          { title: '模型由你的 Provider 提供', detail: '你填哪一家的地址与密钥，请求就直接发往那一家 —— 中间没有我们的服务器。' },
        ],
      },
      {
        heading: '不需要账号',
        lead: '应用不注册、不登录，也没有云端工作区：看完这份说明、勾选同意就能直接开始。',
        tone: 'ok',
      },
    ],
  },
  {
    id: 'data',
    tab: '数据与隐私',
    title: '什么存在本地、什么会离开本机',
    lead: '下面三块分别是：本地存了什么、什么情况下会联网、以及我们不做的事。',
    groups: [
      {
        heading: '本地数据一览（数据目录：' + DATA_DIR_LABEL + '）',
        lead: '每一项都是普通文件，用资源管理器就能打开、备份或删除。',
        items: [
          { title: 'sessions\\', detail: '会话记录：每条对话的消息、工具调用与中断恢复信息', mono: true },
          { title: 'memory\\agent-memory.jsonl', detail: '长期记忆：每轮问答落一行，可以随时清空', mono: true },
          { title: 'config\\', detail: '设置与凭据：settings.json、providers.json（含 API Key）、mcp_servers.json', mono: true },
          { title: 'skills\\', detail: '已安装的技能，以及它们带来的工具与脚本', mono: true },
          { title: 'runtime-v2\\', detail: '随包分发的运行时（Node / Python 等），用来跑工具与技能', mono: true },
          { title: 'models\\', detail: '你自己下载的本地模型与目录索引', mono: true },
          { title: 'cache\\ · logs\\ · metrics.jsonl', detail: '缓存、运行日志与本机诊断计数（不上传）', mono: true },
          { title: 'projects\\ · workflows\\ · collab\\ · group-chat\\', detail: '项目、工作流、协作任务与群聊的房间数据', mono: true },
          { title: 'crash_rust.log', detail: '崩溃日志：只写在本机，用来排查问题', mono: true },
          { title: '会话工作区', detail: '默认在 %USERPROFILE%\\Coomi（用户目录下的可见文件夹），可在「设置 → 工作区」改到别处', mono: true },
        ],
      },
      {
        heading: '会联网的场景（只有这四种）',
        items: [
          { title: '调用你配置的模型 API', detail: '你的提问、上下文与被选中的文件内容会发给你在「设置 → 模型与厂商」里填的那家服务商' },
          { title: '按你启用的镜像源下载', detail: '下载模型、技能与运行时；走哪个镜像源由「设置 → 引擎与诊断 → 下载与镜像」决定' },
          { title: '你主动触发的联网工具', detail: '网页抓取、HTTP 请求、联网搜索等，只在工具被调用时发生（工具条会用紫色标出来）' },
          { title: '检查更新', detail: '只带版本号（User-Agent: Coomi/版本）请求发布接口，用来判断有没有新版本；不发送文件、会话或任何标识' },
        ],
      },
      {
        heading: '不会做的事',
        tone: 'ok',
        items: [
          { title: '不上传你的文件', detail: '文件读写都发生在本地；只有你或 AI 明确把哪个文件作为上下文发给模型时，那段内容才会到模型服务商那里' },
          { title: '不上传会话与记忆', detail: '会话记录与 agent-memory.jsonl 都只写本地磁盘' },
          { title: '不做后台遥测', detail: '除了上面那条「检查更新」，没有会自动发出的上报；也没有设备指纹或行为统计' },
          { title: '不转卖你的密钥', detail: 'API Key 只存在本地配置里，也只发给你自己填的那家服务商' },
        ],
      },
      {
        heading: '记忆随时可以清空',
        lead: '长期记忆就是 memory\\agent-memory.jsonl 这一个明文文件：可以在「设置 → AI 能力」里关掉「长期记忆 / 记忆写入 / 自动注入」，也可以直接删掉这个文件 —— 删了就没了，我们这边没有副本。',
      },
      {
        heading: '需要你自己把握的一点',
        tone: 'warn',
        lead: '「调用模型」和「下载资源」是仅有的两件会把内容带出本机的事：发出去的内容会到达你填的服务商那里。如果手上有不能外发的资料，请先选好模型与开关，再让它读那些文件。',
      },
    ],
  },
  {
    id: 'rights',
    tab: '权限与风险',
    title: '它能在你的机器上做什么',
    lead: 'AI 不是聊天玩具：它会执行命令、读写文件、访问网络。放行程度决定它什么时候必须停下来先问你。',
    groups: [
      {
        heading: '它能做的事',
        items: [
          { title: '命令执行', detail: '在当前会话的工作目录里跑命令行：装依赖、跑测试、调用本机工具等' },
          { title: '文件读写', detail: '读取、新建、修改、删除文件；工具条按「读 / 写 / 改 / 搜索 / 抓取」分色，一眼看出这一轮到底干了什么' },
          { title: '网络访问', detail: '抓网页、发请求、下载依赖 —— 边界与上一页「会联网的场景」是同一条' },
        ],
      },
      {
        heading: '三档放行程度（设置 → 通用 → 任务放行程度）',
        items: [
          { title: '每次询问', detail: '危险操作一律先问我。默认档，建议第一次用就从这里开始' },
          { title: '自动放行', detail: '只读与写入自动通过，删除类操作仍然询问' },
          { title: '完全放行', detail: '不再打断，包含删除类操作 —— 只在你完全信任当前任务时使用' },
        ],
      },
      {
        heading: '风险提示',
        tone: 'warn',
        items: [
          { title: 'AI 会出错', detail: '可能误解指令、改错文件、删错内容，或者把过时的信息当成事实' },
          { title: '重要操作请复核', detail: '删除、覆盖、发布、上线、付款这类动作，放行前自己看一眼；不确定就先切回「每次询问」' },
          { title: '会产生费用', detail: '模型 API 按你服务商的价目计费；长任务、大上下文与频繁工具调用都可能明显增加开销' },
          { title: '边界自己守', detail: '不要用它处理你无权处理的代码、数据或凭据；合规与授权由使用者负责' },
        ],
      },
    ],
  },
]

/** 免责声明：单独一块，两步之外的兜底措辞。 */
export const DISCLAIMER: GuideGroup = {
  heading: '免责声明',
  tone: 'warn',
  items: [
    { title: '按「现状」提供', detail: '本软件处于 Beta 阶段，可能存在缺陷、不稳定或行为变化，不承诺适用于任何特定用途' },
    { title: '输出仅供参考', detail: 'AI 生成的内容不构成法律、医疗、财务或其他专业建议，请自行判断并核对' },
    { title: '操作后果自负', detail: '你在本机放行的操作及其后果由你承担；因使用本软件导致的数据丢失、服务中断、第三方费用或合规问题，开发者不承担赔偿责任' },
    { title: '请在授权范围内使用', detail: '遵守你所在地的法律法规与所在组织的使用规范' },
  ],
}
