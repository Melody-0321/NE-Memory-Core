# NE-Memory Core

Persistent memory system for AI agents. Runs as an MCP server — plug into Trae, Claude Desktop, Cursor, Windsurf, VS Code Copilot, OpenClaw, or any MCP-compatible client.

## 安装指南

### 第一步：前置要求

先确认你的 Node.js 版本 >= 22：

```bash
node -v
```

看到 `v22.x.x` 就没问题。

### 第二步：下载项目

```bash
git clone https://github.com/Melody-0321/NE-Memory-Core.git
cd NE-Memory-Core/mcp
npm install
```

### 第三步：创建本地配置文件

仓库里没有直接放 `config.json`，因为这个文件会存你的 API Key，不适合公开。你需要从模板复制一份出来：

```bash
cp config.example.json config.json
```

然后打开 `config.json`，把下面几项填上。

**不论你用哪个平台，这一步都要做** — 填 API Key。去 [platform.deepseek.com](https://platform.deepseek.com) 注册就能拿到：

```json
{
  "secondary_api": {
    "key": "sk-你的真实Key"
  }
}
```

**Trae 用户**还需要多填两项，否则无法回溯聊天记录：

```json
{
  "workspace_dir": "C:/Users/你的用户名/AppData/Roaming/Trae CN/User/workspaceStorage",
  "history": {
    "reader": "trae-sqlite",
    "path": "C:/Users/你的用户名/AppData/Roaming/Trae CN/User/workspaceStorage/那串长文件夹名/state.vscdb"
  }
}
```

> 没配 Key 也能用搜索功能，只是 `memory_extract`、`memory_synthesize`、`memory_consolidate` 这几个就没法工作了。
>
> 完整字段说明见下方 [Configuration](#configuration) 表格。

### 第四步：配置 MCP 客户端

选你用的平台，照着配就行。

**【Trae】**

打开 Trae 设置 → MCP → 添加服务器，填入：

```json
{
  "command": "node",
  "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
  "env": {
    "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
    "NE_MEMORY_HISTORY_PATH": "C:/Users/你的用户名/AppData/Roaming/Trae CN/User/workspaceStorage/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/state.vscdb",
    "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
  }
}
```

两个路径是什么意思：

- `NE_MEMORY_DATA_DIR` — 记忆数据放哪都行，建议直接放在项目目录里
- `NE_MEMORY_HISTORY_PATH` — Trae 会把你的聊天记录存在一个 SQLite 数据库里。打开 `C:\Users\你的用户名\AppData\Roaming\Trae CN\User\workspaceStorage\`，里面只有一个长串名字的文件夹，进去找到 `state.vscdb`，把完整路径拷过来。
- `NE_MEMORY_PROJECT_ROOT` — 你的项目根目录。配了这个之后，`memory_extract` 会自动把 vault state 同步到 IDE 的 Rule 文件里，让 AI 每轮对话都能看到当前状态。详见下方「State 自动注入」。

**【Claude Desktop】**

编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "ne-memory": {
      "command": "node",
      "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
        "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
      }
    }
  }
}
```

**【Cursor】**

Cursor 支持 MCP，配置方式有两种：

方式一 — 项目级配置文件 `.cursor/mcp.json`（推荐）：

```json
{
  "mcpServers": {
    "ne-memory": {
      "command": "node",
      "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
        "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
      }
    }
  }
}
```

方式二 — Cursor 全局设置 → MCP → Add new MCP server，填入同上配置。

> 配了 `NE_MEMORY_PROJECT_ROOT` 后，state 会自动写入 `.cursor/rules/ne-memory-state.mdc`（带 YAML frontmatter），Cursor 会自动加载。

**【Windsurf】**

Windsurf MCP 配置与 Cursor 类似。推荐在项目根目录创建 `.windsurf/mcp.json`：

```json
{
  "mcpServers": {
    "ne-memory": {
      "command": "node",
      "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
        "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
      }
    }
  }
}
```

也可以在 Windsurf 的 MCP settings UI 中添加。

> 配了 `NE_MEMORY_PROJECT_ROOT` 后，state 会自动写入 `.windsurf/rules/ne-memory-state.md`，Windsurf 会自动加载。旧版用户会写入 `.windsurfrules`（追加模式）。

**【GitHub Copilot（VS Code）】**

VS Code 的 Copilot Chat 支持 MCP。配置方式：

在项目根目录创建 `.vscode/mcp.json`：

```json
{
  "servers": {
    "ne-memory": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
        "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
      }
    }
  }
}
```

也可以在 VS Code 设置中搜索 `chat.mcp` 进行全局配置。

> 配了 `NE_MEMORY_PROJECT_ROOT` 后，state 会以追加模式写入 `.github/copilot-instructions.md`，不破坏已有内容。Copilot 会自动加载该文件作为系统指令。

> GitHub Copilot 的聊天记录以 JSON 格式存储在本地 `workspaceStorage/chatSessions/` 下，`memory_process_history` 可用（reader: `copilot-json`）。

**【Claude Code（终端版）】**

Claude Code 是命令行 AI agent 工具（终端里直接用 `claude` 命令的那个，不是桌面版 Claude Desktop）。在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "ne-memory": {
      "command": "node",
      "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
        "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
      }
    }
  }
}
```

也可以用 `claude mcp add` 命令添加。

> 配了 `NE_MEMORY_PROJECT_ROOT` 后，state 会自动写入 `.claude/rules/ne-memory-state.md`（v2.0.64+）。旧版会以标记区域追加到 `CLAUDE.md`。

**【ChatGPT 桌面版】**

ChatGPT 桌面版（从官网下载安装的那个）同样支持本地 stdio。打开配置文件：

- Windows：`%APPDATA%\OpenAI\ChatGPT\mcp_config.json`
- macOS：`~/Library/Application Support/OpenAI/ChatGPT/mcp_config.json`

写入以下内容（如果文件里已经有别的服务器，合并到 `mcpServers` 里面）：

```json
{
  "mcpServers": {
    "ne-memory": {
      "command": "node",
      "args": ["D:/你的路径/NE-Memory-Core/mcp/server.js"],
      "env": {
        "NE_MEMORY_DATA_DIR": "D:/你的路径/NE-Memory-Core/data",
        "NE_MEMORY_PROJECT_ROOT": "D:/你的项目根目录"
      }
    }
  }
}
```

保存后完全退出 ChatGPT（关窗口不算，要右键任务栏图标退出），再重新打开。

> ChatGPT 的聊天记录全部存在 OpenAI 服务器上，本机没有可读的历史数据库，因此 `memory_process_history` 无法使用。记忆提取 (`memory_extract`) 仍可正常工作，从当前对话中实时提取。

**【ChatGPT 网页版】**

ChatGPT 网页版只认远程 HTTPS 地址，不能直接用本地的 stdio 服务。你需要先把 NE-Memory Core 暴露成一个 HTTP 地址。最简单的做法是用 `mcp-remote` 搭一个本地桥：

```bash
npm install -g mcp-remote
npx mcp-remote node "D:/你的路径/NE-Memory-Core/mcp/server.js" --port 8787
```

然后登录 ChatGPT 网页版 → **Settings（设置）** → **Connectors** → **Advanced（高级）** → 打开 **Developer mode** → 回到 Connectors 页面，点击 **Add custom connector**，填入：

- **名称**：`NE-Memory`
- **MCP Server URL**：`http://localhost:8787/sse`

> 这是本地回路地址，只能你自己用。如果需要从外网访问或者分享给其他人，需要把服务部署到有公网 IP 的服务器上，并用 HTTPS + OAuth 保护。另外 ChatGPT 网页版的 Developer mode 目前需要 Plus / Pro / Team / Enterprise 订阅。
>
> 和桌面版一样，网页版也无法回溯历史记录（数据在 OpenAI 云端），只能实时提取当前对话中的记忆。

### 第五步：验证

重启你的 AI 客户端，在对话里输入：

> 检查记忆系统状态。

如果 AI 回复了 vault 统计数据（比如 STM / LTM 数量），就说明跑起来了。

---

## 工具列表

| 层级 | 工具 | 功能 |
|------|------|------|
| **状态** | `memory_status` | 查看 vault 版本、STM/LTM 数量 |
| **搜索** | `memory_search` | 零 LLM 关键词搜索（BM25），跨所有记忆 |
| | `memory_search_tiered` | 多级懒加载搜索：当前对话 → 同项目 → 跨项目 |
| **访问** | `memory_access` | 直接引用查找：`stm_12`、`input_5`、`characters.Seraphina` |
| **综合** | `memory_synthesize` | BM25 → 去重 → LLM 综合回答，附来源引用 |
| **提取** | `memory_extract` | 从对话提取 STM，支持后台模式 |
| **整合** | `memory_consolidate` | 将 STM 合并为 LTM 摘要 |
| **状态** | `memory_get_state` / `memory_update_state` | 持久化故事/游戏状态 |
| **回滚** | `memory_rollback` | 按消息 ID 移除记忆 |
| **历史** | `memory_process_history` | 从平台对话日志回填记忆 |
| **配置** | `memory_get_config` / `memory_update_config` | 运行时动态调整参数 |
| **项目** | `memory_list_projects` | 发现可用的 Trae workspace |
| **游标** | `memory_get_cursor_status` / `memory_reset_cursor` | 管理历史回填游标 |

---

## Architecture

```
┌──────────────────────────────────────────────┐
│                 MCP Client                    │
│     (Trae / OpenClaw / Claude Desktop)        │
└──────────────────┬───────────────────────────┘
                   │ stdio (JSON-RPC)
┌──────────────────▼───────────────────────────┐
│              mcp/server.js                    │
│           (StdioServerTransport)              │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│              mcp/tools.js                     │
│         (16 tool definitions via Zod)         │
└──────┬────────────────────────────────┬──────┘
       │                                │
┌──────▼──────┐                 ┌──────▼──────┐
│   core/     │                 │  adapters/  │
│  (index.js) │                 │             │
│             │                 │  history/   │
│ ・store.js  │                 │  ├─ trae-sqlite        (Trae CN)│
│ ・access.js │                 │  ├─ cursor-jsonl       (Cursor agent-transcripts)│
│ ・retrieval │                 │  ├─ claude-code-jsonl  (Claude Code sessions)│
│ ・schema    │                 │  ├─ copilot-json       (GitHub Copilot Chat)│
│             │                 │  ├─ openclaw-jsonl     (OpenClaw 新版 sessions)│
│             │                 │  ├─ openclaw-md        (OpenClaw 旧版 markdown)│
│             │                 │  └─ generic-json       (通用 JSON 文件)│
│ ・engine/   │                 │             │
│   extract   │                 │ ・llm-api.js│
│   consolidate│                │ ・storage-fs│
└──────▲──────┘                └─────────────┘
       │
┌──────┴──────┐
│   data/     │
│  *.json     │
│ (vaults)    │
└─────────────┘
```

### Layers

- **Layer 0** — Zero LLM. `search` (BM25) + `access` (direct ref lookup). Instant, no API cost.
- **Layer 1** — LLM-assisted. `synthesize` (BM25 → dedup → LLM) + `extract` (dialog → STM).
- **Layer 2** — LTM consolidation. `consolidate` merges related STM into compressed summaries.

### Key design decisions

- **Storage-agnostic**: swap `storage-fs.js` for IndexedDB, KV store, etc.
- **LLM-agnostic**: swap `llm-api.js` for any OpenAI-compatible or local model.
- **History-agnostic**: platform-specific readers (`trae-sqlite`, `openclaw-md`, `generic-json`) plug in via config.
- **No external databases**: vaults are flat JSON files. No Postgres, no Redis, no Vector DB.
- **Background extraction**: `memory_extract(background: true)` runs LLM calls asynchronously.

---

## Configuration

`config.json` 里可以配的完整字段：

| Key | 默认值 | 说明 |
|-----|--------|------|
| `data_dir` | `./data` | 记忆数据存哪里 |
| `workspace_dir` | — | Trae/Cursor 的 workspaceStorage 路径（只有 trae-sqlite 模式需要） |
| `stmBatch` | `10` | 每次从聊天记录里提取多少条 |
| `stmMaxUnconsolidated` | `30` | 攒了多少条未整理记忆后自动触发整合 |
| `stmWordsThreshold` | `500` | 短于这个字数的消息直接跳过不处理 |
| `enableStateSchema` | `false` | 是否启用状态格式校验 |
| `retrievalEnabled` | `true` | 是否开启记忆搜索 |
| `memoryEnabled` | `true` | 是否开启记忆功能 |
| `history.reader` | — | 聊天记录来源：`trae-sqlite`、`cursor-jsonl`、`claude-code-jsonl`、`copilot-json`、`openclaw-jsonl`、`openclaw-md`、`generic-json` |
| `history.path` | — | 聊天记录文件的路径 |
| `secondary_api.key` | — | **必填。** API Key，去 DeepSeek 申请一个就行 |
| `secondary_api.url` | `https://api.deepseek.com/v1/chat/completions` | API 地址，用别的模型就改这里 |
| `secondary_api.model` | `deepseek-v4-flash` | 用的模型名字 |

> 没配 `secondary_api.key` 的话，`memory_extract`、`memory_synthesize`、`memory_consolidate` 会报 401。搜索和查记忆不受影响。

环境变量可以覆盖配置文件里的值：

| 环境变量 | 对应字段 |
|----------|----------|
| `NE_MEMORY_DATA_DIR` | 记忆数据目录 |
| `NE_MEMORY_HISTORY_PATH` | 聊天记录路径 |
| `NE_MEMORY_WORKSPACE` | workspace 扫描目录 |
| `NE_MEMORY_PROJECT_ROOT` | 项目根目录（State 自动注入用） |

---

## State 自动注入

配了 `NE_MEMORY_PROJECT_ROOT` 之后，每次 `memory_extract` 提取新记忆时，NE-Memory 会自动把 vault state（场景、参与者、任务等）同步到 IDE 的 Rule 文件中。**下一轮对话开始时，AI 无需调用任何工具就能直接看到当前状态。**

### 支持的平台

按自动检测优先级排列：

| 优先级 | 平台 | 写入路径 | 说明 |
|--------|------|----------|------|
| 1 | **Trae** | `.trae/rules/ne-memory-state.md` | 项目根目录下自动创建 |
| 2 | **Cursor** | `.cursor/rules/ne-memory-state.mdc` | 自动附带 YAML frontmatter |
| 3 | **Claude Code** | `.claude/rules/ne-memory-state.md` | v2.0.64+ 模块化路径 |
| 4 | **GitHub Copilot** | `.github/copilot-instructions.md` | 追加模式，不破坏已有内容 |
| 5 | **Windsurf** | `.windsurf/rules/ne-memory-state.md` | 新版目录式 |
| 6 | **Windsurf (旧版)** | `.windsurfrules` | 追加模式 |
| 7 | **Claude Code (旧版)** | `CLAUDE.md` | 标记区域追加 |
| — | 通用 fallback | `ne-memory-state.md` | 以上都检测不到时使用 |

### 写入的内容示例

```markdown
<!-- 此文件由 NE-Memory MCP 自动生成，每轮对话后更新 -->
<!-- 请勿手动编辑 -->

## NE-Memory 状态快照

- **Scene**: 森林
- **Time**: Day 3

### Active Participants
- **Alice**: fighter, combat, task: guard_duty
- **Bob**: mage, magic

### Active Medium Tasks
- **mission_X**: [active] 调查古代遗迹 (进行中)
```

### 禁用

如果你不想自动注入，在 `config.json` 里关掉：

```json
{
  "state_injection": {
    "enabled": false
  }
}
```

或者直接不配 `NE_MEMORY_PROJECT_ROOT` 环境变量。

### 手动指定路径

如果自动检测不准确，可以显式指定目标文件：

```json
{
  "state_injection": {
    "enabled": true,
    "path": ".cursor/rules/my-memory.mdc"
  }
}
```

---

## OpenClaw 插件

OpenClaw 不和 IDE 共享 Rule 文件机制，需要用独立插件来实现 State 注入。

### 安装

```bash
# 从 NE-Memory 项目目录复制插件到 OpenClaw extensions
cp -r ne-memory-core/extensions/openclaw-plugin ~/.openclaw/extensions/ne-memory-state
cd ~/.openclaw/extensions/ne-memory-state
npm install
```

### 配置

在 `~/.openclaw/openclaw.json` 中加入：

```json5
{
  plugins: {
    entries: {
      "ne-memory-state": {
        enabled: true,
        config: {
          dataDir: "~/.ne-memory/data",  // vault JSON 文件路径
          chatId: "ne-memory-dev",        // chat session ID
          maxChars: 3000                  // 每轮最大注入字符数（0 = 不限）
        }
      }
    }
  }
}
```

### 工作原理

插件注册了 `before_agent_start` hook，在每次 LLM 调用前直接从磁盘读取 vault JSON 文件，将 State 格式化为紧凑 markdown 注入 system prompt。不经过 MCP 协议，无额外网络开销。

### 注入示例

```markdown
<!-- NE-Memory state snapshot — auto-generated -->
**Scene**: 森林
**Time**: Day 3
**Active**: Alice (fighter, combat, task: guard_duty) | Bob (mage, magic)
**Active tasks**:
- mission_X [active] — 调查古代遗迹
```

---

## 聊天历史回溯

`memory_process_history` 可以从你过往的聊天记录中提取记忆，而不是只靠当前对话。但这个功能能不能用，完全取决于你的 AI 平台**是否把聊天记录存在本地磁盘**。

### 各平台能力对比

| 平台 | 本地历史 | 存储格式 | `memory_process_history` | Reader | 说明 |
|------|:---:|------|:---:|------|------|
| **Trae** | ✅ | SQLite (`state.vscdb`) | ✅ 可用 | `trae-sqlite` | 已有专用 reader，开箱即用 |
| **Cursor** | ✅ | JSONL | ✅ 可用 | `cursor-jsonl` | 读取 `~/.cursor/projects/` 下的 agent-transcripts |
| **Claude Code** | ✅ | JSONL | ✅ 可用 | `claude-code-jsonl` | 读取 `~/.claude/projects/` 下的 session 记录 |
| **GitHub Copilot** | ✅ | JSON (嵌套结构) | ✅ 可用 | `copilot-json` | 读取 workspaceStorage 下的 `chatSessions/*.json` |
| **OpenClaw** | ✅ | JSONL (新版) / MD (旧版) | ✅ 可用 | `openclaw-jsonl` / `openclaw-md` | 新版 sessions JSONL 和旧版日 log MD 均支持 |
| **Claude Desktop** | ❌ | — | ❌ 不可用 | — | 纯 MCP 客户端，不存聊天记录 |
| **Windsurf** | ❌ | Protobuf 二进制 (`.pb`) | ❌ 不可用 | — | 二进制格式不可解析，无公开 schema |
| **ChatGPT Desktop** | ❌ | — | ❌ 不可用 | — | 聊天记录全在 OpenAI 云端服务器 |
| **ChatGPT Web** | ❌ | — | ❌ 不可用 | — | 同上，网页版也不存本地 |

> **图例**: ✅ = 已有 reader，开箱即用 | ❌ = 平台限制，无法支持

### 已支持的平台

#### Trae

Trae 把聊天输入历史存在 SQLite 数据库里。路径：

```
# Windows
C:\Users\<用户名>\AppData\Roaming\Trae CN\User\workspaceStorage\<一长串UUID>\state.vscdb

# macOS
~/Library/Application Support/Trae CN/User/workspaceStorage/<UUID>/state.vscdb
```

配置方式（`config.json`）：

```json
{
  "history": {
    "reader": "trae-sqlite",
    "path": "C:/Users/你的用户名/AppData/Roaming/Trae CN/User/workspaceStorage/xxxxxxxxxxxx/state.vscdb"
  }
}
```

或者用环境变量 `NE_MEMORY_HISTORY_PATH` 指定路径。

配置好后，在对话里让 AI 执行：

```
请用 memory_process_history 回填我在 Trae 中的聊天历史。
```

> Trae 的 `workspaceStorage` 里只有一个长串 UUID 文件夹，进去就是 `state.vscdb`。每次重装 Trae 会换一个新 UUID，需要重新确认路径。

#### OpenClaw（旧版 Markdown 格式）

OpenClaw 旧版会将每日对话输出到 `memory/YYYY-MM-DD.md` 文件中。已有 `openclaw-md` reader：

```json
{
  "history": {
    "reader": "openclaw-md",
    "path": "/home/user/.openclaw/workspace/memory"
  }
}
```

> `openclaw-md` 读的是每天汇总的 **markdown 文件**，包含 User / Assistant 对话。新版 OpenClaw 用户请使用下方的 `openclaw-jsonl`（见「OpenClaw 新版 JSONL」小节）。

### Cursor

Cursor 的 agent 对话脚本以 JSONL 格式存储在 `.cursor/projects/` 下：

```
# Windows
%USERPROFILE%\.cursor\projects\<project>\agent-transcripts\<chat-id>\

# macOS / Linux
~/.cursor/projects/<project>/agent-transcripts/<chat-id>/
```

配置方式：

```json
{
  "history": {
    "reader": "cursor-jsonl",
    "path": "C:/Users/你的用户名/.cursor/projects/"
  }
}
```

`path` 可以指向 `projects/` 根目录（自动扫描所有项目）、某个项目目录、或单个 `.jsonl` 文件。

### Claude Code

Claude Code 的会话以 JSONL 存在 `~/.claude/projects/` 下：

```
~/.claude/projects/<项目路径编码>/<session-id>.jsonl
```

配置方式：

```json
{
  "history": {
    "reader": "claude-code-jsonl",
    "path": "~/.claude/projects/"
  }
}
```

`~` 会自动展开为用户主目录。`path` 可以指向 `projects/` 根目录、某个项目子目录、或单个 `.jsonl` 文件。

### GitHub Copilot（VS Code 内）

VS Code 的 Copilot Chat 把每个会话存为独立 JSON 文件：

```
# Windows
%APPDATA%\Code\User\workspaceStorage\<32位hash>\chatSessions\<uuid>.json
```

配置方式：

```json
{
  "history": {
    "reader": "copilot-json",
    "path": "C:/Users/你的用户名/AppData/Roaming/Code/User/workspaceStorage/"
  }
}
```

`path` 指向 `workspaceStorage/` 根目录即可，reader 会自动扫描所有 `chatSessions/` 子目录。也可以直接指向某个具体的 `.json` 文件。

### OpenClaw（新版 JSONL Sessions）

新版 OpenClaw 会话存储为 JSONL：

```
~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
```

配置方式：

```json
{
  "history": {
    "reader": "openclaw-jsonl",
    "path": "~/.openclaw/agents/main/sessions/"
  }
}
```

> `openclaw-jsonl` 和 `openclaw-md` 的区别：前者读新版独立 session JSONL 文件，后者读旧版每日汇总 markdown。根据你的 OpenClaw 版本选用对应的 reader。

### 无法回溯的平台

以下平台因架构或存储格式限制，目前无法回溯聊天历史。下文说明**官方需要开放什么**才有可能支持。

#### Windsurf

Cascade 聊天记录存储为 **protobuf 二进制文件**（`.pb`），路径为 `~/.codeium/windsurf/cascade/`。Protobuf 需要 `.proto` schema 定义才能解码，而 Codeium 没有公开。

**要实现回溯，Codeium 需开放以下任一能力：**

| 方案 | 难度 | 改动方 | 说明 |
|------|:---:|------|------|
| 公开 `.proto` schema | 低 | Codeium | 只需在文档中发布 Cascade protobuf 的消息定义文件，社区即可自行解码 |
| 内置 JSON/JSONL 导出 | 中 | Codeium | 在 Cascade 面板加一个「导出对话」按钮，输出为 markdown 或 JSON |
| 对话历史 API | 高 | Codeium | 新增 REST API 端点，允许程序化拉取指定 session 的完整对话内容 |

> Windsurf 已有 Enterprise API（`server.codeium.com/api/v1/`），但仅限 Analytics 和用量管理，不含对话内容。用户社区对此有持续呼声（见 [Windsurf Feature Requests](https://windsurf.canny.io/feature-requests/p/export-chat)）。

#### Claude Desktop

Claude Desktop 是一个纯 MCP 客户端，所有聊天记录由 Anthropic 云端管理。本地磁盘没有可读的会话数据。Anthropic 提供手动数据导出，但流程笨重：设置页申请 → 等邮件（最长 24h）→ 下载 `conversations.json` zip 包。

**要实现回溯，Anthropic 需开放以下任一能力：**

| 方案 | 难度 | 改动方 | 说明 |
|------|:---:|------|------|
| 本地 session 存储 | 中 | Anthropic | 像 Claude Code 一样，在本地 `~/.claude/` 下保存 JSONL 会话副本 |
| 对话历史 API | 高 | Anthropic | 新增 API 端点，允许用户通过 API Key 拉取 Claude.ai / Desktop 的历史对话 |
| 实时导出 API | 中 | Anthropic | 把当前的手动导出（24h 延迟）升级为即时 API 调用 |

> Claude Code（终端版）**已经**在 `~/.claude/projects/` 下本地存储 JSONL 会话记录 — 这说明技术上是可行的，只是 Claude Desktop 没有采用同样的策略。

#### ChatGPT Desktop / Web

ChatGPT 的所有聊天记录存储在 OpenAI 的云端服务器上。桌面版和网页版都没有本地缓存，也没有面向消费者账号的对话历史 API。

**要实现回溯，OpenAI 需开放以下任一能力：**

| 方案 | 难度 | 改动方 | 说明 |
|------|:---:|------|------|
| ChatGPT Data API | 高 | OpenAI | 新增消费者账号的对话历史 REST API（不是面向开发者的 Chat Completions API） |
| 本地缓存机制 | 中 | OpenAI | 像 VS Code Copilot 一样把 `chatSessions/*.json` 写入本地磁盘 |
| Responses API 开放 | 中 | OpenAI | 把当前仅限开发者 API 的 `previous_response_id` 状态链路开放给 ChatGPT 客户端调用 |

> OpenAI 的 Chat Completions API 和 Responses API 是**面向开发者的付费接口**，与 ChatGPT 消费者产品分属不同体系。ChatGPT 用户无法通过 API Key 访问自己在网页/桌面端的对话历史。数据导出需通过设置页手动申请。

> 记忆提取 (`memory_extract`) 仍然可以在当前对话中实时工作，不受以上限制影响。

---

## 常见问题

**Q: 提示 `config.json not found`？**

A: 第三步没做，或者 `config.json` 没有放在 `mcp/` 目录里。检查一下。

**Q: `memory_extract` 报 401？**

A: API Key 没配或者过期了，去 `config.json` 里检查 `secondary_api.key`。

**Q: `memory_process_history` 读到 0 条消息？**

A: `NE_MEMORY_HISTORY_PATH` 填的路径不对。Trae 那个 `workspaceStorage` 下的文件夹名每次安装都不一样，需要自己去确认一下。

**Q: 能不能不重启就改参数？**

A: 可以。用 `memory_update_config`，能在运行时直接改 `stmBatch` 和 `stmMaxUnconsolidated`，改完即时生效。

**Q: ChatGPT 网页版连不上？**

A: 网页版不走 stdio，必须先启动 `mcp-remote` 桥。确认 `npx mcp-remote ...` 那个终端窗口还开着，再去 ChatGPT 里 Add custom connector。另外检查你是不是 Plus / Pro 订阅 — 免费版没有 Developer mode。

**Q: 为什么 ChatGPT 不能回溯历史聊天记录？**

A: ChatGPT 的聊天记录存在 OpenAI 的服务器上，不在你的电脑里，所以 `memory_process_history` 拿不到数据。Trae 能用是因为它的记录存本地 SQLite。记忆提取 (`memory_extract`) 不受影响 — 它从当前对话中实时工作。

---

## License

MIT
