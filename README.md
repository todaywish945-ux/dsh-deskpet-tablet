# dsh-deskpet-tablet

把 **桌宠** 接入 DeepSeek Harness（dsh）的插件。

> **前提：这只是遥控器。** 本插件不包含桌宠本体——所有功能都通过本地桥（127.0.0.1:37820）
> 指挥同一台电脑上运行的[桌宠框架](https://github.com/todaywish945-ux/deskpet-tablet)。
> 没装框架时插件装了也没用：工具全部连接失败、面板卡停在「桌宠还没启动」。
> 正确顺序：**① 先用框架仓库的 AUTOSETUP.md 把桌宠跑起来 → ② 再装本插件 → ③ 重启 dsh**。

装上之后，桌宠还是那个悬浮在桌面上的平板桌宠（克隆音色 TTS、表情动画、
灵动岛），dsh 里的 agent 多了八只「手」（让她说话、做表情、接通/挂断通话、
替用户带话…），而且 **dsh 界面聊天框右边会多出一列视频通话**——她住在你
的工作界面里，边写代码边和她说话，不遮任何内容（见下文「视频通话列」）。

已在 Windows 11 + DeepSeek Harness 0.2.0-rc.2 实机验证：桥接接口实测通（真实 TTS 播报 + 面板页
WS 事件流 + 资产服务）、插件经真实 `@deepseek-ai/dsh-tools` 的 `defineTool`
校验加载、bundle patch 经真实 `@deepseek-ai/dsh-app-boot` 的 `loadProfile`
解析入栈、client 契约测试全绿。

## 工作原理

```
dsh (agent) ──工具调用──▶ dsh-deskpet-tablet ──HTTP──▶ 桌宠（Electron）
                              本插件                    127.0.0.1:37820 控制桥
  界面半边 client.js ──iframe──▶ GET /panel（WS /events 同屏字幕与语音）
```

- 桌宠本体主进程内开了一座只监听 `127.0.0.1` 的本地控制桥
  （桌宠仓库 `src/main/services/pluginBridge.ts`），本插件把桌宠拉起来
  （或连接已在运行的实例），注册工具打到这座桥上。
- POST 一律带 `x-pet-bridge: 1` 防伪头（浏览器跨域表单发不出这个头，挡掉
  CSRF）；配了 `PET_PLUGIN_TOKEN` 还会校验 `Authorization: Bearer`。
- 插件本体是零构建的纯 ESM 单文件（`index.js`），依赖宿主环境的
  `@deepseek-ai/dsh-tools`（`defineTool`），在 dsh 的 hoisted node_modules
  回退层里解析。
- 界面半边是另一个零构建手写 bundle（`client.js`）：格式与 dsh 自己的
  client bundle 一致（`window.__ModuleLoader__.load({ id, factory })`），
  只 `require('react')` 这类平台种子模块；把自己以低优先级注册进 `details`
  槽（右侧停靠列，见下文），另挂一个 `shell.overlay` 重开小钮。

## 安装（Windows，desktop profile）

**推荐：一条命令从 GitHub 安装**（前提：已按框架仓库的 AUTOSETUP.md 装好[桌宠框架](https://github.com/todaywish945-ux/deskpet-tablet)）：

```bash
dsh plugin --profile desktop add github:todaywish945-ux/dsh-deskpet-tablet
```

锁定版本：`add github:todaywish945-ux/dsh-deskpet-tablet#v0.5.1`。

<details><summary>本地开发安装（改源码即时生效，点开）</summary>

```bash
# 1) 装依赖（bare 目录路径 = pnpm link 语义，改插件源码即时生效）
cd ~/.dsh/profiles/desktop
pnpm add "<本插件目录>"

# 2) 把 bundle 写进装配清单（dsh plugin add 的 reconcile 步骤）
#    编辑 ~/.dsh/profiles/desktop/package.json，bundles 数组追加：
#      "dsh-deskpet-tablet"
```

有 `dsh` CLI 的话一条命令等价于上面两步：

```bash
dsh plugin --profile desktop add <本插件目录>
```

</details>

然后**重启 DeepSeek Harness 桌面端**即可。验证：随便让她一句
「让她打个招呼」，agent 应调用 `pet_say`，桌宠开口说
「我上线啦，随时找我聊天哦～」。

**启动联动**：`autoStart: true` + `devMode: true`（patch 默认）——dsh 启动
时插件自动从 `devDir` 以 dev 模式拉起桌宠（冷启动约 10~25 秒，连上后她会打
招呼；语音服务不用管，桌宠自己会拉 GSV）。桌宠已在跑则直接连接，不重复启动；
`keepAlive: true` 让 dsh 退出后桌宠继续常驻托盘。换打包版后把 `devMode` 改回
`false` 并配 `appPath` 指向安装的 exe 即可。

卸载：

```bash
cd ~/.dsh/profiles/desktop
pnpm remove dsh-deskpet-tablet
# 并从 package.json 的 dsh.profile.bundles 里删掉 "dsh-deskpet-tablet"
```

### 本地开发注意

pnpm 对裸目录路径用 **link** 语义，profile 里是软链；Node ESM 按 realpath
解析，所以 `@deepseek-ai/dsh-tools` 从插件所在目录的 node_modules 向上查找。
如遇 dsh-tools 解析失败，重建 junction：

```
<插件目录>\node_modules\@deepseek-ai\dsh-tools → C:\Users\<你>\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools
```

重新创建：`mklink /J <插件目录>\node_modules\@deepseek-ai\dsh-tools C:\Users\<你>\.dsh\profiles\node_modules\@deepseek-ai\dsh-tools`

## 配置

写在 `cordis.patch.yml` 的 `config` 段（整段覆盖式生效）：

| 键 | 默认 | 说明 |
|---|---|---|
| `autoStart` | `true` | 桌宠没在跑时自动拉起 |
| `greetOnStart` | `true` | 连上桌宠后让她打一声招呼 |
| `greetLine` | 「编码搭档上线啦…」 | 打招呼的台词 |
| `announceOnTurnEnd` | `false` | 每轮 agent 结束自动播报一句（每轮都响，较吵） |
| `turnEndLine` | 「这轮任务收尾啦…」 | 收尾播报的台词 |
| `port` | `37820` | 控制桥端口，与桌宠的 `PET_PLUGIN_PORT` 保持一致 |
| `token` | `''` | 控制桥 token；环境变量 `PET_PLUGIN_TOKEN` 优先 |
| `appPath` | `''` | 打包版桌宠 exe 的绝对路径（`autoStart` 用；不配则只有桌宠已在跑时可用） |
| `devMode` | `false` | 开发调试：从源码目录跑 `npm run dev` 代替 exe |
| `devDir` | `""`（空，自行填写） | 源码目录（`devMode` 用） |
| `keepAlive` | `true` | dsh 退出后桌宠继续常驻托盘 |

桌宠进程侧环境变量：`PET_PLUGIN_PORT`（设 `0` 关闭整座桥）、`PET_PLUGIN_TOKEN`。

## 注册的工具

| 工具 | 参数 | 行为 |
|---|---|---|
| `pet_say` | `text`（必填）、`emotion`（可选） | 她把这句话连字幕带克隆音色说出来；内容会写进她的会话上下文。用户正在和她视频通话时返回「被跳过」而不是报错 |
| `pet_emote` | `emotion`（必填） | 只做表情动画，不出声 |
| `pet_status` | — | 在线状态、语音引擎是否就绪、是否在通话中 |
| `pet_call_start` | `topic`（可选） | **接通视频通话**：新会话 + 平板切到通话界面，她围绕话题先开口；已接通时幂等返回 |
| `pet_chat` | `text`（必填） | **替用户和她说一句话**，等她用自己的大脑（智谱 GLM + 克隆音色）完整回复后返回回复文本 |
| `pet_call_end` | — | **挂断**：她的话音停掉，对话自动存入会话历史 |
| `pet_interrupt` | — | 立刻停下当前播报/对话 |
| `pet_report` | `summary`（必填）、`next`/`emotion`（可选） | 任务收尾的结构化汇报：她会按情绪念出来，语气亲切的鼓励 |

`emotion` 可选值（24 种，与桌宠一致）：
`neutral listen comfort encourage celebrate thanks affection shy moved playful
morning night welcome apology thinking curious sleepy sad agree care rest tired
patience reassure`

插件还注入了系统提示词指引（任务收尾用 pet_say/pet_report、通话链 pet_call_start → pet_chat → pet_call_end），并挂了**情绪反应引擎**：连续 ≥2 次工具失败、turn 级报错、"失败后终于成功"、连续工作 90 分钟——四种时刻她会主动开口（60 分钟冷却，一天 1~3 次，可用 emotionReact/workCare 关）。

### 视频通话链路（实测通过）

```
pet_call_start('刚改完的界面')
  → 平板切到通话界面，她围绕话题先开口（新会话）
  → 等 /health 的 busy 变 false（她说完开场白）
pet_chat('刚才改得怎么样？')
  → 以用户消息跑一轮，返回她的完整回复文本，字幕语音照常
pet_call_end()
  → 挂断，对话自动存入会话历史
```

通话由用户在平板上挂断也一样有效（渲染层会把视图状态上报给桥）。她正在
说话时 `/chat` 返回 409 busy，agent 等一轮结束再发即可。

## 界面里的视频卡（0.4.3）

视频通话停在 dsh 界面右缘的一条**专属窄条**里，卡本身是**正常大小**（360×500，
不拉通天）：

- **不挡对话的真实机制**：主框架（`.frame`）被 `margin-right` 挤出一条与卡同宽的
  沟——空间是真让出来的，对话在剩余区域由 dsh 自己的让位求解器重排；卡嵌在窄条
  顶部（`✕` 收起时沟一并填回，布局完全复原），窄条余下的部分留空，不叠任何内容
- 对比历史方案：0.2.1 槽位遮蔽（顶掉内置工具详情面板）→ 0.3.0 通天挖沟（视频
  被拉成长条）→ 0.3.1 悬浮 PiP（盖住对话）→ 0.4.0 定型：**挖沟让位 + 正常大小**
- 窄条左缘可拖宽（260–420px，记 localStorage）
- 找不到框架节点（上游重构）时自动退化为可拖悬浮，不白屏不挡死
- 卡是 iframe → `http://127.0.0.1:37820/panel`，由桌宠主进程直出：动画
  （透明视频/贴纸）、字幕气泡、输入框、停止按钮都在这一页里——和桌面上的平板
  是「同一场通话的两块屏」
- 面板用 WebSocket `/events` 收 `pet:*` 事件流（`tts-chunk` 是 base64 PCM），
  所以字幕跟着语音逐句出、情绪驱动动画，与桌面端完全同步
- **面板一接上，桌面平板自动静音**（控制桥通知渲染层把音量压到 0），免得双声道；
  面板断线后平板声音自动还回来
- 组件自己只做探活：每 3–8 秒 GET 一次 `/health`（已放行跨域），桌宠没启动
  时显示「桌宠还没启动」，启动后自动挂上面板
- 面板页的 `POST /chat`、`/interrupt` 自带 `x-pet-bridge: 1` 防伪头

改 `client.js` 不必重新构建：宿主开机时读它的 sha1 当 rev，重启 dsh 桌面端即生效。
包里的 `dsh.client`（platform/inject）与 `exports["./client"]` 是宿主发现它的唯一
依据，删掉其中任何一个界面半边就不再加载。

## 她的大脑

插件**不接管**她自己的对话：不打扰时你照样在平板上和她聊天（智谱 GLM +
百炼/GPT-SoVITS 克隆音色不变）。dsh 的 agent 只是通过工具「借她的嘴」
（`pet_say`）或「替用户带话」（`pet_chat`，回复仍出自她自己的人格与记忆），
`pet_say` 的插话会以隐藏消息写进她的会话，她下次聊天时知道「刚才替编程助手
说了什么」。

## 已知边界

- **远程来源不弹桌面平板**：经由本插件（agent 工具、面板页）触发的说话/表情/通话，
  桌面平板保持灵动岛胶囊态不弹出——她已经在你的 DSH 面板里现身了。桌面本地交互
  （平板打字、点托盘、摸头、主动关心）行为不变
- 她正在说话时（通话中或播报中），`pet_say` / `pet_chat` / `pet_call_start`
  会被拒（HTTP 409）——不打断进行中的话轮
- 桌宠未配置语音时照样能播：字幕 + 表情动画照常，只是没声音
- `agent/turn-stopping` 钩子依赖 dsh 的事件面（master 源码已确认存在；
  桌面端 0.2.0-rc.2 若无此事件，钩子挂载只打一条警告，其余功能不受影响）
- 对着仓库 master 源码写的插件，桌面端如果落后多个版本，个别字段名可能对不上——
  以 `dsh --dump-config` / 应用日志为准调 `cordis.patch.yml`
- 界面半边要在**重启 dsh 桌面端**后才会被扫到（宿主启动时把 `dsh.client` 声明
  缓存下来，热改 package.json 不会重扫）
- 通话卡里的浏览器要求一次点击才出声（自动播放策略）：面板上会浮一条
  「点击开启她的声音」，点一下就好
- 本地 GPT-SoVITS 是非流式接口，首句合成约 8 秒（显存被占时更久），面板与桌面
  平板的表现一致；想再快需要改成 `streaming_mode` 流式合成
