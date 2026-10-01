import {
  AppWindow, Boxes, Brain, Bug, Chrome, Cloud, Code, Database, FileText, Files, GitBranch,
  Globe, HardDrive, LineChart, MessageSquare, Package, Search, Sparkles, Table, Terminal, Video,
} from 'lucide-react'

/// 目录 id → 图标：让每张卡都有可辨认的视觉标识（没有映射就退回“首字母色块”）。
const ICONS: Record<string, React.ReactNode> = {
  filesystem: <Files size={20} />,
  memory: <Brain size={20} />,
  'sequential-thinking': <Brain size={20} />,
  everything: <Sparkles size={20} />,
  time: <Globe size={20} />,
  fetch: <Globe size={20} />,
  shell: <Terminal size={20} />,
  'desktop-commander': <HardDrive size={20} />,
  git: <GitBranch size={20} />,
  github: <GitBranch size={20} />,
  gitlab: <GitBranch size={20} />,
  gitee: <GitBranch size={20} />,
  serena: <Code size={20} />,
  context7: <FileText size={20} />,
  deepwiki: <FileText size={20} />,
  playwright: <Chrome size={20} />,
  puppeteer: <Chrome size={20} />,
  browsermcp: <AppWindow size={20} />,
  figma: <AppWindow size={20} />,
  sentry: <Bug size={20} />,
  postgres: <Database size={20} />,
  sqlite: <Database size={20} />,
  mysql: <Database size={20} />,
  mongodb: <Database size={20} />,
  redis: <Database size={20} />,
  clickhouse: <Database size={20} />,
  elasticsearch: <Search size={20} />,
  'brave-search': <Search size={20} />,
  tavily: <Search size={20} />,
  exa: <Search size={20} />,
  firecrawl: <Search size={20} />,
  duckduckgo: <Search size={20} />,
  markitdown: <FileText size={20} />,
  notion: <FileText size={20} />,
  slack: <MessageSquare size={20} />,
  linear: <MessageSquare size={20} />,
  atlassian: <MessageSquare size={20} />,
  excel: <Table size={20} />,
  'office-word': <FileText size={20} />,
  feishu: <MessageSquare size={20} />,
  aws: <Cloud size={20} />,
  cloudflare: <Cloud size={20} />,
  docker: <Boxes size={20} />,
  kubernetes: <Boxes size={20} />,
  grafana: <LineChart size={20} />,
  chroma: <Brain size={20} />,
  qdrant: <Brain size={20} />,
  openmemory: <Brain size={20} />,
  duckdb: <Table size={20} />,
  'pandas-mcp': <Table size={20} />,
  amap: <Globe size={20} />,
  youtube: <Video size={20} />,
  ffmpeg: <Video size={20} />,
}

const CATEGORIES: Record<string, string> = {
  filesystem: '文件与系统', memory: 'AI 与向量', 'sequential-thinking': 'AI 与向量', everything: '开发工具',
  time: '文件与系统', fetch: '搜索与抓取', shell: '文件与系统', 'desktop-commander': '文件与系统',
  git: 'Git 与代码托管', github: 'Git 与代码托管', gitlab: 'Git 与代码托管', gitee: 'Git 与代码托管',
  serena: '开发工具', context7: '开发工具', deepwiki: '开发工具', figma: '开发工具',
  playwright: '浏览器自动化', puppeteer: '浏览器自动化', browsermcp: '浏览器自动化',
  sentry: '运维监控', grafana: '运维监控',
  postgres: '数据库', sqlite: '数据库', mysql: '数据库', mongodb: '数据库', redis: '数据库', clickhouse: '数据库',
  elasticsearch: '数据与分析', 'brave-search': '搜索与抓取', tavily: '搜索与抓取', exa: '搜索与抓取',
  firecrawl: '搜索与抓取', duckduckgo: '搜索与抓取', markitdown: '办公文档',
  notion: '办公文档', excel: '办公文档', 'office-word': '办公文档',
  slack: '通讯协作', linear: '通讯协作', atlassian: '通讯协作', feishu: '通讯协作',
  aws: '云服务', cloudflare: '云服务', docker: '云服务', kubernetes: '云服务',
  chroma: 'AI 与向量', qdrant: 'AI 与向量', openmemory: 'AI 与向量',
  duckdb: '数据与分析', 'pandas-mcp': '数据与分析', amap: '数据与分析', youtube: '数据与分析', ffmpeg: '数据与分析',
}

export function catalogIcon(id: string): React.ReactNode {
  return ICONS[id] ?? <Package size={20} />
}

export function catalogCategory(id: string): string {
  return CATEGORIES[id] ?? '其它'
}

export const CATALOG_CATEGORIES = [
  '全部', '文件与系统', '开发工具', 'Git 与代码托管', '数据库', '搜索与抓取',
  '浏览器自动化', '办公文档', '通讯协作', '云服务', '运维监控', 'AI 与向量', '数据与分析', '其它',
]