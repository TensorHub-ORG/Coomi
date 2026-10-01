import { writeFileSync } from 'node:fs'
const P = (key, label, secret = true) => ({ key, label, secret })
const E = (id, name, description, category, source, command, args, required = [], env = {}) => ({
  id, name, description, category, source, transport: 'stdio', command, args, env, required_parameters: required,
})
const entries = [
  // ── 文件与系统 ──
  E('filesystem','Filesystem','在一个明确允许的目录下读写文件。','文件与系统','official','npx',['-y','@modelcontextprotocol/server-filesystem','{{allowed_path}}'],[P('allowed_path','允许访问的目录',false)]),
  E('memory','Memory','本地知识图谱：存实体与关系，跨会话记忆。','文件与系统','official','npx',['-y','@modelcontextprotocol/server-memory']),
  E('sequential-thinking','Sequential Thinking','把复杂问题拆成可回溯的思考步骤。','文件与系统','official','npx',['-y','@modelcontextprotocol/server-sequential-thinking']),
  E('everything','Everything','官方演示服务器：用来验证 MCP 通道是否正常。','文件与系统','official','npx',['-y','@modelcontextprotocol/server-everything']),
  E('time','Time','时区换算与当前时间（官方 Python 参考实现）。','文件与系统','official','uvx',['mcp-server-time']),
  E('fetch','Fetch','抓取网页并转成 Markdown，适合读文档。','搜索与抓取','official','uvx',['mcp-server-fetch']),
  E('git','Git','读取仓库状态、历史、分支与 diff。','开发工具','official','uvx',['mcp-server-git','--repository','{{repository}}'],[P('repository','仓库路径',false)]),
  E('shell','Shell','在受控目录内执行 shell 命令（危险，默认关闭）。','文件与系统','community','npx',['-y','mcp-shell-server']),
  E('desktop-commander','Desktop Commander','文件管理 + 终端执行的一体化服务器。','文件与系统','community','npx',['-y','@wonderwhy-er/desktop-commander']),
  // ── 开发工具 ──
  E('github','GitHub','仓库、Issue、PR、Actions 操作。','Git 与代码托管','official','npx',['-y','@modelcontextprotocol/server-github'],[P('token','GitHub Token')],{GITHUB_PERSONAL_ACCESS_TOKEN:'{{token}}'}),
  E('gitlab','GitLab','GitLab 项目、Issue、MR 管理。','Git 与代码托管','official','npx',['-y','@modelcontextprotocol/server-gitlab'],[P('token','GitLab Token')],{GITLAB_PERSONAL_ACCESS_TOKEN:'{{token}}'}),
  E('gitee','Gitee','码云仓库与 Issue 操作。','Git 与代码托管','community','npx',['-y','mcp-server-gitee'],[P('token','Gitee Token')]),
  E('serena','Serena','基于 LSP 的语义代码检索与重构助手。','开发工具','community','uvx',['--from','git+https://github.com/oraios/serena','serena','start-mcp-server']),
  E('context7','Context7','拉取库的最新文档，减少 API 幻觉。','开发工具','community','npx',['-y','@upstash/context7-mcp']),
  E('deepwiki','DeepWiki','按仓库生成/查询项目维基。','开发工具','community','npx',['-y','mcp-remote','https://mcp.deepwiki.com/sse']),
  E('playwright','Playwright','浏览器自动化：打开页面、点击、截图。','浏览器自动化','official','npx',['-y','@playwright/mcp@latest']),
  E('puppeteer','Puppeteer','无头浏览器抓取与操作。','浏览器自动化','official','npx',['-y','@modelcontextprotocol/server-puppeteer']),
  E('browsermcp','Browser MCP','连接你正在用的浏览器（需装扩展）。','浏览器自动化','community','npx',['-y','@browsermcp/mcp@latest']),
  E('figma','Figma','读取 Figma 设计文件与组件信息。','开发工具','community','npx',['-y','figma-developer-mcp','--stdio'],[P('token','Figma Token')],{FIGMA_API_KEY:'{{token}}'}),
  E('sentry','Sentry','查询错误与性能问题。','运维监控','official','npx',['-y','@sentry/mcp-server'],[P('token','Sentry Token')],{SENTRY_ACCESS_TOKEN:'{{token}}'}),
  // ── 数据库 ──
  E('postgres','PostgreSQL','只读查询 Postgres（连接串里带只读账号）。','数据库','official','npx',['-y','@modelcontextprotocol/server-postgres','{{connection_string}}'],[P('connection_string','连接串',false)]),
  E('sqlite','SQLite','查询本地 SQLite 数据库文件。','数据库','official','uvx',['mcp-server-sqlite','--db-path','{{db_path}}'],[P('db_path','数据库文件路径',false)]),
  E('mysql','MySQL','MySQL 查询与表结构浏览。','数据库','community','npx',['-y','@benborla29/mcp-server-mysql'],[P('connection_string','连接串',false)]),
  E('mongodb','MongoDB','集合查询与聚合。','数据库','community','npx',['-y','mongodb-mcp-server','--connectionString','{{uri}}'],[P('uri','MongoDB URI',false)]),
  E('redis','Redis','Redis 键值浏览与命令执行。','数据库','community','uvx',['mcp-server-redis','--url','{{url}}'],[P('url','Redis URL',false)]),
  E('clickhouse','ClickHouse','ClickHouse 只读查询。','数据库','community','uvx',['mcp-clickhouse'],[P('host','Host',false),P('user','User',false),P('password','Password')]),
  E('elasticsearch','Elasticsearch','索引与查询 ES 集群。','数据与分析','community','npx',['-y','@elastic/mcp-server-elasticsearch'],[P('url','ES URL',false),P('api_key','API Key')]),
  // ── 搜索与抓取 ──
  E('brave-search','Brave Search','Brave 网页与本地搜索。','搜索与抓取','official','npx',['-y','@modelcontextprotocol/server-brave-search'],[P('api_key','Brave API Key')],{BRAVE_API_KEY:'{{api_key}}'}),
  E('tavily','Tavily','面向 AI 的搜索与内容抽取。','搜索与抓取','community','npx',['-y','tavily-mcp'],[P('api_key','Tavily API Key')],{TAVILY_API_KEY:'{{api_key}}'}),
  E('exa','Exa','语义搜索（按意思找资料）。','搜索与抓取','community','npx',['-y','exa-mcp-server'],[P('api_key','Exa API Key')],{EXA_API_KEY:'{{api_key}}'}),
  E('firecrawl','Firecrawl','整站抓取与结构化抽取。','搜索与抓取','community','npx',['-y','firecrawl-mcp'],[P('api_key','Firecrawl API Key')],{FIRECRAWL_API_KEY:'{{api_key}}'}),
  E('duckduckgo','DuckDuckGo','免密钥的网页搜索。','搜索与抓取','community','uvx',['duckduckgo-mcp-server']),
  E('markitdown','MarkItDown','把 PDF/Office/图片转成 Markdown。','办公文档','community','uvx',['markitdown-mcp']),
  // ── 办公与协作 ──
  E('notion','Notion','读写 Notion 页面与数据库。','办公文档','official','npx',['-y','@notionhq/notion-mcp-server'],[P('token','Notion Token')],{NOTION_TOKEN:'{{token}}'}),
  E('slack','Slack','频道消息读取与发送。','通讯协作','official','npx',['-y','@modelcontextprotocol/server-slack'],[P('token','Slack Bot Token')],{SLACK_BOT_TOKEN:'{{token}}'}),
  E('linear','Linear','Issue 与项目进度管理。','通讯协作','community','npx',['-y','mcp-remote','https://mcp.linear.app/sse']),
  E('atlassian','Jira / Confluence','Atlassian 云端 Jira 与 Confluence。','通讯协作','community','npx',['-y','mcp-remote','https://mcp.atlassian.com/v1/sse']),
  E('excel','Excel','读写 Excel 工作簿。','办公文档','community','uvx',['excel-mcp-server','stdio']),
  E('office-word','Word','读写 Word 文档。','办公文档','community','uvx',['office-word-mcp-server']),
  E('feishu','飞书','飞书文档与消息（社区实现）。','通讯协作','community','npx',['-y','@larksuiteoapi/lark-mcp','mcp','-a','{{app_id}}','-s','{{app_secret}}'],[P('app_id','App ID',false),P('app_secret','App Secret')]),
  // ── 云与运维 ──
  E('aws','AWS','查询 AWS 资源与成本。','云服务','community','uvx',['mcp-server-aws'],[P('access_key','Access Key',false),P('secret_key','Secret Key')]),
  E('cloudflare','Cloudflare','Workers/日志观测。','云服务','official','npx',['-y','mcp-remote','https://observability.mcp.cloudflare.com/sse']),
  E('docker','Docker','容器与镜像管理。','云服务','community','uvx',['docker-mcp']),
  E('kubernetes','Kubernetes','集群资源查看与操作。','云服务','community','npx',['-y','mcp-server-kubernetes']),
  E('grafana','Grafana','面板与告警查询。','运维监控','community','npx',['-y','mcp-grafana'],[P('url','Grafana URL',false),P('token','API Token')]),
  // ── AI 与向量 ──
  E('chroma','Chroma','本地向量库检索。','AI 与向量','community','uvx',['chroma-mcp','--client-type','persistent']),
  E('qdrant','Qdrant','向量检索服务。','AI 与向量','community','npx',['-y','@qdrant/mcp-server-qdrant'],[P('url','Qdrant URL',false),P('api_key','API Key')]),
  E('openmemory','OpenMemory','本地长期记忆层（社区实现）。','AI 与向量','community','npx',['-y','openmemory-js']),
  // ── 数据与分析 ──
  E('duckdb','DuckDB','本地分析型数据库查询。','数据与分析','community','uvx',['mcp-server-duckdb','--db-path','{{db_path}}'],[P('db_path','DuckDB 文件',false)]),
  E('pandas-mcp','Pandas','对 CSV/表格做统计分析。','数据与分析','community','uvx',['mcp-pandas']),
  E('amap','高德地图','地理编码、路径规划。','数据与分析','community','npx',['-y','@amap/amap-maps-mcp-server'],[P('api_key','高德 Key')],{AMAP_MAPS_API_KEY:'{{api_key}}'}),
  E('youtube','YouTube','视频字幕与信息抓取。','数据与分析','community','uvx',['youtube-transcript-mcp']),
  E('ffmpeg','FFmpeg','音视频转码与抽帧。','数据与分析','community','uvx',['ffmpeg-mcp']),
]
import { readFileSync } from 'node:fs'
const target = 'G:/DSH/coomi-full-project/apps/coomi-rs/catalogs/mcp.json'
const previous = JSON.parse(readFileSync(target, 'utf8'))
const ids = new Set(entries.map((e) => e.id))
// 保留原有条目里不在新清单中的（避免丢用户可能已装的）
for (const old of previous.entries) if (!ids.has(old.id)) entries.push(old)
writeFileSync(target, JSON.stringify({ version: 2, entries }, null, 2) + '\n')
console.log('entries: ' + entries.length)