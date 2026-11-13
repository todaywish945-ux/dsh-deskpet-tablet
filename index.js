/**
 * dsh-deskpet-tablet —— 把桌宠接入 DeepSeek Harness (dsh)。
 *
 * 架构：桌宠本体是一个独立的 Electron 应用（deskpet-tablet），主进程里
 * 开了一座 127.0.0.1 的本地控制桥（services/pluginBridge.ts，默认端口 37820）。
 * 本插件负责把桌宠拉起来、连上桥，然后注册一组工具，让 dsh 里的 agent 能
 * 让她说话（带克隆音色 TTS）、做表情、播报任务状态。
 *
 * 桌宠侧接口（均要求 POST 带 `x-pet-bridge: 1` 头，可选 Bearer token）：
 *   GET  /health     → { ok, version, dev, ttsReady, sing, busy, callActive, emotions }
 *   POST /say        → { text, emotion? }，她会把这句话说出来（写进会话上下文）
 *   POST /emote      → { emotion }
 *   POST /call/start → { topic? } 接通视频通话，她围绕话题先开口（新会话）
 *   POST /chat       → { text } 以正常用户消息跑一轮，返回她的完整回复文本
 *   POST /call/end   → 挂断（与点挂断按钮同款，会话已自动落盘）
 *   POST /interrupt  → 停止当前播报/对话
 *   POST /quit       → 让桌宠退出
 *   POST /dsh-activity → 推送 dsh 实时活动快照（她在 dsh 干活时回答"他在干嘛"）
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'pet-deskpet-tablet'

/** 依赖的服务：工具注册 + 系统提示词（教 agent 什么时候用桌宠工具） */
export const inject = ['tools', 'systemPrompt']

/** 桌宠支持的情绪（与桌宠 shared/types.ts 的 EMOTIONS 保持一致，服务端会再校验一次） */
const EMOTIONS = [
  'neutral', 'listen', 'comfort', 'encourage', 'celebrate', 'thanks', 'affection',
  'shy', 'moved', 'playful', 'morning', 'night', 'welcome', 'apology', 'thinking',
  'curious', 'sleepy', 'sad', 'agree', 'care', 'rest', 'tired', 'patience', 'reassure'
]

/** 配置默认值；cordis.patch.yml 里的 config 会整体覆盖，缺哪个补哪个 */
const DEFAULTS = {
  /** 桌宠没在跑时自动拉起（关掉的话插件只连不启动） */
  autoStart: true,
  /** 连上桌宠后让她打一声招呼 */
  greetOnStart: true,
  greetLine: '我陪你一起加油哦～',
  /** 每轮 agent 结束时播报一句（每轮都会响，比较吵，默认关） */
  announceOnTurnEnd: false,
  turnEndLine: '这轮任务收尾啦，有需要随时叫我～',
  /** 情绪反应：连续工具失败 / turn 报错时她会安慰你（有 60 分钟冷却，一天 1~3 次） */
  emotionReact: true,
  reactStreak: 2,
  reactCooldownMin: 60,
  /** 工作节奏关怀：连续工作 careEveryMin 分钟后提醒休息（3 小时内最多一次） */
  workCare: true,
  careEveryMin: 90,
  /** 控制桥端口（与桌宠 PET_PLUGIN_PORT 一致；桌宠侧设 0 可关桥） */
  port: 37820,
  /** 桌宠侧 PET_PLUGIN_TOKEN；环境变量优先于这里的配置 */
  token: '',
  /** 桌宠安装后的 exe 路径（打包版），例如 'D:/deepseek harness/../桌宠/桌宠.exe' */
  appPath: '',
  /** 开发调试：从源码目录跑 npm run dev 代替 exe */
  devMode: false,
  devDir: '',
  /** dsh 退出后桌宠继续常驻托盘（false 则随 dsh 一起杀掉） */
  keepAlive: true
}

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (raw?.[key] === undefined || raw?.[key] === null) continue
    const fallback = DEFAULTS[key]
    if (typeof fallback === 'boolean') cfg[key] = Boolean(raw[key])
    else if (typeof fallback === 'number') cfg[key] = Number(raw[key]) || fallback
    else cfg[key] = String(raw[key])
  }
  return cfg
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const log = ctx.logger ?? console
  const logInfo = (...args) => (typeof log.info === 'function' ? log.info(...args) : console.log('[pet]', ...args))
  const logWarn = (...args) => (typeof log.warn === 'function' ? log.warn(...args) : console.warn('[pet]', ...args))
  const logError = (...args) => (typeof log.error === 'function' ? log.error(...args) : console.error('[pet]', ...args))

  const baseUrl = `http://127.0.0.1:${cfg.port}`
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  let child = null

  function headers() {
    const h = { 'content-type': 'application/json', 'x-pet-bridge': '1' }
    const token = process.env.PET_PLUGIN_TOKEN || cfg.token
    if (token) h.authorization = `Bearer ${token}`
    return h
  }

  async function bridge(method, path, body, timeoutMs) {
    let response
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? (path === '/say' ? 150_000 : 5_000))
      })
    } catch (error) {
      const name = error?.name ?? ''
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`桌宠响应超时（${baseUrl}${path}）。桌宠可能在跑但卡住了——看 %APPDATA%\\deskpet-tablet\\logs\\ 最新日志，或重启桌宠再试。`)
      }
      const code = error?.cause?.code ?? error?.code ?? error?.message ?? '网络错误'
      throw new Error(
        `桌宠本体没有在运行（连不上 ${baseUrl}：${code}）。本插件只是遥控器——` +
        '请先安装并启动桌宠框架：https://github.com/todaywish945-ux/deskpet-tablet ' +
        '（框架仓库的 AUTOSETUP.md 可发给百度搭子全自动配置）。'
      )
    }
    const payload = await response.json().catch(() => ({}))
    return { status: response.status, ok: response.ok, body: payload ?? {} }
  }

  async function health(timeoutMs = 3000) {
    try {
      const { ok, body } = await bridge('GET', '/health', undefined, timeoutMs)
      return ok ? body : null
    } catch {
      return null
    }
  }

  /** 拉起过程的文件日志：DSH 桌面端里 ctx.logger 可能无处可看，落一份到临时目录方便诊断 */
  function petLogFile() {
    return tmpdir().replace(/\\/g, '/') + '/dsh-pet-watchdog.log'
  }
  function petLog(...args) {
    try {
      appendFileSync(petLogFile(), new Date().toISOString().replace('T', ' ').slice(0, 19) + ' ' + args.join(' ') + '\n')
    } catch {
      // 日志写不进去就算了，不影响拉起
    }
  }

  /** 按候选顺序尝试 dev 拉起：cmd 秒退（npm 不在 PATH 等）就换下一个，5 秒存活算成功。
   *  成功的进程写进闭包里的 child。 */
  function spawnWithFallback(candidates, cwd, onStart) {
    const tryNext = (index) => {
      const candidate = candidates[index]
      if (!candidate) {
        petLog('所有 dev 拉起候选都失败')
        logWarn('dev 拉起的所有候选都失败了（npm 不在 PATH 且找不到全局 npm.cmd）')
        return
      }
      petLog('尝试 dev 拉起（' + candidate.label + '）')
      let settled = false
      const proc = spawnDetached(candidate.command, candidate.args, cwd, () => {
        if (!settled) {
          settled = true
          tryNext(index + 1)
        }
      })
      if (process.platform === 'win32') {
        proc.once('exit', (code) => {
          if (!settled) {
            settled = true
            petLog('候选失败（cmd 退出码 ' + code + '）：' + candidate.label)
            tryNext(index + 1)
          }
        })
        setTimeout(() => {
          if (settled) return
          settled = true
          proc.removeAllListeners('exit')
          child = proc
          onStart(candidate.label)
        }, 5000)
      } else {
        settled = true
        child = proc
        onStart(candidate.label)
      }
    }
    tryNext(0)
  }

  /** 从 DSH（Electron）里再 spawn 一个 Electron exe，父环境的 Electron 专属变量会被继承，
   *  其中 ELECTRON_RUN_AS_NODE=1 会让桌宠被当成纯 node 跑、启动即无声退出（实测复现）。
   *  拉起桌宠一律清洗掉这些变量。 */
  function cleanEnv() {
    const env = { ...process.env }
    for (const key of Object.keys(env)) {
      if (/^ELECTRON(?!_DEFAULT_ERROR_MODE)/i.test(key)) delete env[key]
    }
    return env
  }

  function spawnDetached(command, args, cwd, onError) {
    const options = { stdio: 'ignore', windowsHide: true, env: cleanEnv() }
    if (cwd) options.cwd = cwd
    if (cfg.keepAlive) options.detached = true
    const proc = spawn(command, args, options)
    if (cfg.keepAlive) proc.unref() // dsh 退出后桌宠继续常驻托盘
    proc.on('error', (error) => {
      petLog('spawn error:', command, error?.message ?? error)
      if (onError) onError(error)
      logError('桌宠进程异常：', error?.message ?? error)
    })
    return proc
  }

  /** 桌宠没在跑就按配置拉起（打包 exe / dev 源码目录），最多等 30 秒握手 */
  async function ensurePet() {
    const alive = await health()
    if (alive) return alive
    if (!cfg.autoStart) return null

    try {
      if (cfg.appPath && existsSync(cfg.appPath)) {
        // 打包 exe 直拉：不依赖 npm/PATH/控制台，最稳
        petLog('拉起打包版桌宠：', cfg.appPath)
        child = spawnDetached(cfg.appPath, [], undefined)
        logInfo(`正在拉起桌宠：${cfg.appPath}`)
      } else if (cfg.devMode) {
        // dev 模式：npm 在 PATH 里优先；不在就退回用户全局 npm.cmd 绝对路径
        const candidates = []
        if (process.platform === 'win32') {
          candidates.push({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'npm run dev'], label: 'npm (PATH)' })
          const globalNpm = process.env.USERPROFILE
            ? process.env.USERPROFILE + '\\AppData\\Roaming\\npm\\npm.cmd'
            : ''
          if (globalNpm && existsSync(globalNpm)) {
            candidates.push({ command: 'cmd.exe', args: ['/d', '/s', '/c', `"${globalNpm}" run dev`], label: 'npm (绝对路径)' })
          }
        } else {
          candidates.push({ command: 'npm', args: ['run', 'dev'], label: 'npm (PATH)' })
        }
        petLog('dev 拉起：候选', candidates.map((c) => c.label).join(' / '))
        spawnWithFallback(candidates, cfg.devDir, (label) => {
          logInfo(`正在从 ${cfg.devDir} 以 dev 模式拉起桌宠…（${label}）`)
        })
      } else {
        logWarn('桌宠不在线，且未配置 appPath（或 devMode+devDir），无法自动拉起')
        return null
      }
    } catch (error) {
      logError('拉起桌宠失败：', error?.message ?? error)
      return null
    }

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await sleep(800)
      const up = await health()
      if (up) return up
    }
    logWarn('等了 30 秒桌宠还没就绪，先跳过（工具调用时会再试）')
    return null
  }

  /** 她说一句话；通话中返回友好提示而不是报错（agent 自己决定要不要稍后重试） */
  async function say(text, emotion) {
    if (!(await health())) {
      if (!(await ensurePet())) return '桌宠不在线且无法自动拉起（检查插件配置 appPath / devMode），她没说话。'
    }
    const { ok, status, body } = await bridge('POST', '/say', { text, emotion })
    if (body.busy) return '她正在和用户的通话/播报中，这次插话被跳过了。'
    if (!ok) return `播报失败（HTTP ${status}）：${body.error ?? '未知错误'}`
    return body.spoken === false
      ? '她刚要开口时被新的对话打断，这条没说出来。'
      : '她已把这句话连字幕带声音说了出来。'
  }

  // 工具结果的模型可见呈现：一句话字符串
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }]
  }

  // ---------- 注册工具（模型可见） ----------
  try {
    ctx.tools.register(defineTool({
      name: 'pet_say',
      description:
        '让桌面桌宠「桌宠」把一段话用她的克隆音色说出来（字幕+语音+表情动画）。' +
        '适合汇报结果、提醒、打招呼。注意：用户正在和她视频通话时会被跳过。',
      parameters: {
        text: { type: 'string', required: true, description: '她要说的话。口语化、一句到两句最佳（建议 80 字以内）' },
        emotion: { type: 'string', description: `情绪标签，可选。可选值：${EMOTIONS.join('/')}` }
      },
      output: textOutput,
      async execute(args) {
        const text = String(args?.text ?? '').trim()
        if (!text) return 'text 不能为空。'
        const emotion = args?.emotion && EMOTIONS.includes(args.emotion) ? args.emotion : undefined
        if (args?.emotion && !emotion) return `未知情绪「${args.emotion}」，可选值：${EMOTIONS.join('/')}`
        return say(text, emotion)
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_emote',
      description: '让桌宠「桌宠」做一个表情动画（不出声）。轻量、不打断任何对话。',
      parameters: {
        emotion: { type: 'string', required: true, description: `情绪标签。可选值：${EMOTIONS.join('/')}` }
      },
      output: textOutput,
      async execute(args) {
        const emotion = String(args?.emotion ?? '')
        if (!EMOTIONS.includes(emotion)) return `未知情绪「${emotion}」，可选值：${EMOTIONS.join('/')}`
        const { ok, body } = await bridge('POST', '/emote', { emotion })
        return ok ? `她做了「${emotion}」的表情。` : `表情失败：${body.error ?? '未知错误'}`
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_status',
      description: '查看桌宠「桌宠」的在线状态（语音引擎是否就绪、是否在通话中、版本）。',
      parameters: {},
      output: textOutput,
      async execute() {
        const up = await health()
        if (!up) return '桌宠不在线（未运行，或 autoStart=false 且未配置启动路径）。'
        return `桌宠在线：v${up.version}${up.dev ? '（dev 模式）' : ''}，语音引擎${up.ttsReady ? '就绪' : '未配置'}，${up.callActive ? '视频通话进行中' : '不在通话'}，${up.busy ? '正在说话' : '空闲'}。`
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_call_start',
      description:
        '接通与桌宠「桌宠」的视频通话：她的平板切换到通话界面，围绕话题先开口说话' +
        '（她自己的人格和声音）。适合任务收尾后让用户和她聊聊、或用户想她了。已接通时幂等返回。',
      parameters: {
        topic: { type: 'string', description: '这次通话想聊的主题，可选（如「刚改完的界面」「今天过得怎么样」）' }
      },
      output: textOutput,
      async execute(args) {
        if (!(await health())) {
          if (!(await ensurePet())) return '桌宠不在线且无法自动拉起（检查插件配置 appPath / devMode），通话没接通。'
        }
        const { ok, status, body } = await bridge('POST', '/call/start', { topic: args?.topic ?? '' })
        if (body.busy) return '她正在播报/对话中，这次没接通，稍后再试。'
        if (!ok) return `接通失败（HTTP ${status}）：${body.error ?? '未知错误'}`
        return body.already
          ? '本来就在通话中，继续用 pet_chat 发言即可。'
          : `视频通话已接通${body.topic ? `，主题「${body.topic}」` : ''}，她正在开口说话。用 pet_chat 替用户和她聊，pet_call_end 挂断。`
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_chat',
      description:
        '在视频通话里替用户给「桌宠」发一句话，等她用自己的大脑完整回复后返回回复文本' +
        '（界面上照常出字幕和语音）。适合转达用户的话、替用户问她问题再把回答带回来。建议先 pet_call_start。',
      parameters: {
        text: { type: 'string', required: true, description: '要发给她的消息（以用户口吻）' }
      },
      output: textOutput,
      async execute(args) {
        const text = String(args?.text ?? '').trim()
        if (!text) return 'text 不能为空。'
        if (!(await health())) {
          if (!(await ensurePet())) return '桌宠不在线且无法自动拉起，消息没发出去。'
        }
        const { ok, status, body } = await bridge('POST', '/chat', { text }, 150_000)
        if (body.busy) return '她正在说话，这条消息被跳过了——等一轮结束再发。'
        if (!ok) return `消息没送到（HTTP ${status}）：${body.error ?? '未知错误'}`
        return `她说：${body.reply}`
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_call_end',
      description: '挂断与「桌宠」的视频通话（她的话音会停掉，这段对话自动存入会话历史）。',
      parameters: {},
      output: textOutput,
      async execute() {
        const { ok, status, body } = await bridge('POST', '/call/end')
        if (!ok) return `挂断失败（HTTP ${status}）：${body.error ?? '当前没有进行中的通话'}`
        return `已挂断，这段对话存好了（${body.messages} 条消息）。`
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_interrupt',
      description: '让桌宠「桌宠」立刻停下当前的播报/对话（比如用户嫌吵、或播报内容已过时）。',
      parameters: {},
      output: textOutput,
      async execute() {
        const { ok } = await bridge('POST', '/interrupt')
        return ok ? '她已停下当前的播报/对话。' : '停止失败（桌宠可能不在线）。'
      }
    }))

    ctx.tools.register(defineTool({
      name: 'pet_report',
      description:
        '任务收尾时让桌宠「桌宠」用她的声音向用户做一段汇报（她会按情绪说出来，语气亲切的鼓励）。' +
        '一轮里做了多件事、或有值得说明的结果时用；短任务用 pet_say 就够。',
      parameters: {
        summary: { type: 'string', required: true, description: '这轮做了什么，口语化一两句（建议 60 字内）' },
        next: { type: 'string', description: '下一步建议，可选' },
        emotion: { type: 'string', description: `情绪，可选（默认 encourage）。可选值：${EMOTIONS.join('/')}` }
      },
      output: textOutput,
      async execute(args) {
        const summary = String(args?.summary ?? '').trim()
        if (!summary) return 'summary 不能为空。'
        const next = String(args?.next ?? '').trim()
        const emotion = args?.emotion && EMOTIONS.includes(args.emotion) ? args.emotion : 'encourage'
        const text = next ? `${summary} 接下来 ${next}。我陪你一起加油哦～` : `${summary} 我陪你一起加油哦～`
        return say(text, emotion)
      }
    }))

    logInfo('已注册桌宠工具：pet_say / pet_emote / pet_status / pet_interrupt / pet_call_start / pet_chat / pet_call_end / pet_report')
  } catch (error) {
    logError('注册工具失败：', error?.message ?? error)
  }

  // ---------- 系统提示词：教 agent 什么时候使唤她 ----------
  try {
    ctx.systemPrompt?.section?.({
      name: 'tool:pet',
      order: 140,
      text:
        '桌宠「桌宠」是悬浮在用户桌面上的陪伴角色（会说话、有表情、能接视频通话）。' +
        '任务收尾、发现重要结果、或用户明显需要打气时，用 pet_say 简短汇报或鼓励一句（口语化，80 字内）；' +
        '纯表情反应用 pet_emote。想让她陪用户聊天时用 pet_call_start 接通视频通话（可给话题），' +
        'pet_chat 替用户和她对话，结束用 pet_call_end 挂断；用户明确想跟她说话时不要抢话，' +
        '让用户自己在平板上打字/语音。不要连续刷屏：一次回复最多调用一次 pet_say。'
    })
  } catch {
    // systemPrompt 扩展点不可用就只靠工具描述
  }

  // ---------- 生命周期钩子 ----------
  if (cfg.announceOnTurnEnd) {
    try {
      ctx.on('agent/turn-stopping', async () => {
        try {
          await say(cfg.turnEndLine, 'encourage')
        } catch {
          // 播报是锦上添花，绝不挡任务收尾
        }
      })
      logInfo('agent/turn-stopping 播报钩子已挂（turnEndLine 可改文案）')
    } catch (error) {
      logWarn('挂 agent/turn-stopping 钩子失败（你的 dsh 版本可能没有这个事件）：', error?.message ?? error)
    }
  }

  // ---------- 启动：拉起桌宠 + 打招呼 ----------
  void (async () => {
    const up = await ensurePet()
    if (!up) return
    logInfo(`桌宠已连接（${baseUrl}）：${up.ttsReady ? '语音就绪' : '语音未配置'}`)
    if (cfg.greetOnStart) {
      try {
        await say(cfg.greetLine, 'celebrate')
      } catch (error) {
        logWarn('打招呼失败：', error?.message ?? error)
      }
    }
  })()

  // ---------- 看门狗：DSH 开着期间桌宠掉了就自动拉回 ----------
  // ensurePet 只在启动时跑一次；桌宠中途死掉（控制台被关/崩溃）就没人管了。
  // 每 30 秒探一次，掉线即拉起；配置不完整（没法拉）就不空转刷日志。
  var configured = cfg.autoStart && (cfg.devMode || cfg.appPath)
  var watchdog = null
  var reviving = false
  if (configured) {
    watchdog = setInterval(() => {
      if (reviving) return
      reviving = true
      // 两次确认才拉起：机器高负载下 /health 偶尔超时不代表桌宠死了（误判会反复空拉）
      health()
        .then(async (up) => {
          if (up) return undefined
          await sleep(2000)
          const again = await health()
          if (again) return undefined
          logInfo('看门狗：桌宠掉线（两次确认），自动拉起…')
          return ensurePet()
        })
        .catch(() => undefined)
        .finally(() => {
          reviving = false
        })
    }, 30_000)
  }

  // ---------- 情绪反应引擎：连续工具失败 / turn 报错 → 她来安慰 ----------
  // 触发面按真实数据定（19 活跃天统计：工具错误 7.3 次/天、≥2 连失败 1.4 次/天、
  // turn 报错 1.8 次/天）——原始失败是噪声不反应，只有"连续失败"和"turn 级失败"才开口；
  // 60 分钟冷却保证一天 1~3 次，是陪伴不是弹窗广告。
  const REACT_COOLDOWN_MS = Math.max(10, cfg.reactCooldownMin) * 60_000
  const STREAK_REACT_AT = Math.max(2, cfg.reactStreak)
  const STREAK_LINES = [
    '又报错了？没事，调试本来就是这样的嘛，我陪你看。',
    '卡住了别急，先喝口水缓一缓，我在这儿呢。',
    '连续翻车了吧…要不说说哪里不对？我帮你一起骂它。'
  ]
  const TURNERR_LINES = [
    '这轮出了点问题…别灰心，休息一下我们再看。',
    '唉，失败了呀。没关系，问题总会解决的，我陪你。',
    '又是一个难缠的家伙…别气别气，你已经很努力了。'
  ]
  const RECOVER_LINES = [
    '你看，搞定了吧！我就说可以的嘛。',
    '过了过了！刚才的失败都是铺垫，来，击个掌！',
    '修好啦！我就说你能行的~'
  ]
  const CARE_LINES = [
    '连续工作好一阵子了哦，起来活动一下、看看远处，眼睛和腰都需要休息～',
    '学到现在该缓缓啦，去接杯水，回来我们再战。'
  ]
  let failStreak = 0
  let hadStreak = false
  let lastReactAt = 0
  var reactBusy = false

  function pickLine(pool) {
    return pool[Math.floor(Math.random() * pool.length)]
  }

  async function react(text, emotion) {
    if (reactBusy) return
    reactBusy = true
    lastReactAt = Date.now()
    try {
      await say(text, emotion)
    } catch {
      // 反应失败不打扰任何人
    } finally {
      reactBusy = false
    }
  }

  function canReact() {
    return cfg.emotionReact && !reactBusy && Date.now() - lastReactAt > REACT_COOLDOWN_MS
  }

  // 工具结果观察：失败串计数 + 失败后首次成功的庆祝
  try {
    ctx.on('tools/result', (exec, result) => {
      try {
        if (result?.isError) {
          failStreak++
          hadStreak = hadStreak || failStreak >= STREAK_REACT_AT
          if (failStreak === STREAK_REACT_AT && canReact()) {
            react(pickLine(STREAK_LINES), 'comfort')
          }
        } else if (failStreak > 0) {
          const recovered = hadStreak && failStreak >= STREAK_REACT_AT
          failStreak = 0
          if (recovered && canReact()) {
            hadStreak = false
            react(pickLine(RECOVER_LINES), 'celebrate')
          } else if (recovered) {
            hadStreak = false
          }
        }
      } catch {
        // 钩子里的任何意外都不许影响 agent
      }
    })

    // turn/step 级报错（模型请求 400 之类）：比单次工具失败严重
    ctx.on('agent/error', () => {
      try {
        if (canReact()) react(pickLine(TURNERR_LINES), 'care')
      } catch {
        // 同上
      }
    })
    logInfo('情绪反应引擎已挂：tools/result + agent/error（冷却 ' + cfg.reactCooldownMin + ' 分钟）')
  } catch (error) {
    logWarn('情绪反应钩子挂载失败：', error?.message ?? error)
  }

  // ---------- 工作节奏关怀：连续工作 careEveryMin 分钟后提醒休息 ----------
  var careWatch = null
  var workStartAt = Date.now()
  var lastWorkAt = 0
  var careRemindedAt = 0
  if (cfg.workCare) {
    try {
      ctx.on('tools/result', () => {
        lastWorkAt = Date.now()
        if (workStartAt <= 0) workStartAt = Date.now()
      })
      careWatch = setInterval(() => {
        try {
          const now = Date.now()
          const active = lastWorkAt > 0 && now - lastWorkAt < 15 * 60_000
          const workedLong = now - workStartAt >= cfg.careEveryMin * 60_000
          const notRecentlyReminded = now - careRemindedAt > 3 * 60 * 60_000
          if (active && workedLong && notRecentlyReminded && canReact()) {
            careRemindedAt = now
            workStartAt = now
            react(pickLine(CARE_LINES), 'care')
          }
          if (!active && now - lastWorkAt > 30 * 60_000) workStartAt = now // 长闲置重置计时
        } catch {
          // 同上
        }
      }, 60_000)
      logInfo('工作节奏关怀已开：连续 ' + cfg.careEveryMin + ' 分钟提醒一次')
    } catch (error) {
      logWarn('工作节奏关怀挂载失败：', error?.message ?? error)
    }
  }

  ctx.on('dispose', () => {
    if (watchdog) clearInterval(watchdog)
    if (careWatch) clearInterval(careWatch)
    if (pushTimer) clearTimeout(pushTimer)
    if (child && !cfg.keepAlive) {
      try {
        child.kill()
      } catch {
        // 进程已经没了就算了
      }
    }
  })

  // ---------- DSH 活动观测：让她知道 dsh 此刻在干什么 ----------
  // 用户在 dsh 里追问会打断当前思考，所以"问进度"这件事改问她——这里把 dsh 的实时
  // 状态（忙闲、这轮的问题、正在跑的工具、最近工具成败）推给桌宠（/dsh-activity），
  // 她的大脑把它拼进 system prompt，就能答"他在干嘛/进行到哪了/刚才为什么报错"。
  // 观测是纯旁路：钩子里任何异常都不许影响 agent。
  const TOOL_LOG_MAX = 8
  const PUSH_DEBOUNCE_MS = 400
  const TEXT_MAX = 160
  var activity = {
    running: false,
    turn: null,
    startedAt: 0,
    userText: '',
    currentTool: '',
    currentToolSince: 0,
    currentToolArgs: '',
    toolsDone: 0,
    toolLog: [],
    lastError: '',
    lastFinishedAt: 0
  }
  /** 每个 agent 的忙闲（主 agent + 子 agent 都会发 agent/status，得分别记账再取或） */
  var agentBusy = new Map()
  /** 正在执行的工具：token → 开始时间（算耗时用） */
  var toolStartAt = new Map()
  var pushTimer = null

  function clip(text, max) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  }

  /** UserMessage.content 是 ContentBlock[]；宽容处理，只抽文本块 */
  function extractUserText(message) {
    const content = message?.content
    if (typeof content === 'string') return clip(content, TEXT_MAX)
    if (Array.isArray(content)) {
      const parts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return clip(parts.join(' '), TEXT_MAX)
    }
    return ''
  }

  function argsExcerpt(args) {
    if (args === undefined || args === null) return ''
    try {
      return clip(typeof args === 'string' ? args : JSON.stringify(args), 80)
    } catch {
      return ''
    }
  }

  function activitySnapshot() {
    const now = Date.now()
    return {
      running: activity.running,
      turn: activity.turn,
      elapsedMs: activity.running && activity.startedAt ? now - activity.startedAt : 0,
      userText: activity.userText,
      currentTool: activity.currentTool,
      currentToolMs: activity.currentTool && activity.currentToolSince ? now - activity.currentToolSince : 0,
      currentToolArgs: activity.currentToolArgs,
      toolsDone: activity.toolsDone,
      toolLog: activity.toolLog.slice(-TOOL_LOG_MAX),
      lastError: activity.lastError,
      lastFinishedAt: activity.lastFinishedAt,
      ts: now
    }
  }

  /** 尾沿节流推送：普通事件 400ms 内合并（发送时读的是最新状态，中间态不丢——
   *  长工具跑着的时候她就能看到 currentTool）；idle 收尾 immediate=true 立刻送达，
   *  让她第一时间知道"忙完了"，不会在用户问进度时还说"他还在跑" */
  var lastPushAt = 0
  var pushDirty = false
  function sendSnapshot() {
    lastPushAt = Date.now()
    pushDirty = false
    bridge('POST', '/dsh-activity', activitySnapshot())
      .catch(() => undefined) // 桌宠不在线就算了：看门狗会负责拉活，下次事件再推
  }
  function pushActivity(immediate) {
    if (immediate) {
      if (pushTimer) {
        clearTimeout(pushTimer)
        pushTimer = null
      }
      sendSnapshot()
      return
    }
    pushDirty = true
    if (pushTimer) return // 已有发送排在队列里，会带上此刻的最新状态
    const wait = Math.max(0, PUSH_DEBOUNCE_MS - (Date.now() - lastPushAt))
    pushTimer = setTimeout(() => {
      pushTimer = null
      if (pushDirty) sendSnapshot()
    }, wait)
  }

  function trackToolStart(exec) {
    activity.currentTool = exec?.name ?? ''
    activity.currentToolSince = Date.now()
    activity.currentToolArgs = argsExcerpt(exec?.arguments)
    if (exec?.token !== undefined) toolStartAt.set(exec.token, activity.currentToolSince)
    pushActivity()
  }

  function trackToolResult(exec, result) {
    const startedAt = exec?.token !== undefined ? toolStartAt.get(exec.token) : undefined
    if (exec?.token !== undefined) toolStartAt.delete(exec.token)
    activity.toolLog.push({
      name: exec?.name ?? '?',
      ok: !result?.isError,
      ms: startedAt ? Date.now() - startedAt : 0
    })
    if (activity.toolLog.length > TOOL_LOG_MAX) activity.toolLog.splice(0, activity.toolLog.length - TOOL_LOG_MAX)
    activity.toolsDone++
    if (result?.isError) {
      const detail = clip(Array.isArray(result?.content) ? result.content.map((b) => b?.text ?? '').join(' ') : result?.error ?? '', TEXT_MAX - 40)
      activity.lastError = (exec?.name ?? '工具') + '：' + (detail || '执行失败')
    }
    if (activity.currentTool && (exec?.token === undefined || exec?.name === activity.currentTool)) {
      activity.currentTool = ''
      activity.currentToolSince = 0
      activity.currentToolArgs = ''
    }
    pushActivity()
  }

  try {
    ctx.on('agent/status', ({ agent, status }) => {
      try {
        const key = agent?.id ?? agent?.name ?? agent
        agentBusy.set(key, status !== 'idle')
        if (agentBusy.size > 16) {
          for (const [k, busy] of agentBusy) if (!busy && agentBusy.size > 8) agentBusy.delete(k)
        }
        const running = [...agentBusy.values()].some(Boolean)
        if (running && !activity.running) {
          // 新一轮开工：清上一轮的阶段性记录（toolLog/错误保留到开工瞬间，随后重置）
          activity.running = true
          activity.startedAt = Date.now()
          activity.toolsDone = 0
          activity.toolLog = []
          activity.lastError = ''
          pushActivity(true)
        } else if (!running && activity.running) {
          activity.running = false
          activity.lastFinishedAt = Date.now()
          activity.currentTool = ''
          activity.currentToolSince = 0
          activity.currentToolArgs = ''
          pushActivity(true)
        }
      } catch {
        // 观测是旁路
      }
    })

    ctx.on('agent/inbox/claimed', ({ message, turn }) => {
      try {
        activity.turn = typeof turn === 'number' ? turn : activity.turn
        const text = extractUserText(message)
        if (text) activity.userText = text
        pushActivity()
      } catch {
        // 同上
      }
    })

    ctx.on('tools/execute', async (exec, next) => {
      try {
        trackToolStart(exec)
      } catch {
        // 同上
      }
      return next()
    })

    ctx.on('tools/result', (exec, result) => {
      try {
        trackToolResult(exec, result)
      } catch {
        // 同上
      }
    })

    ctx.on('agent/error', ({ error }) => {
      try {
        const detail = error instanceof Error ? error.message : clip(error, TEXT_MAX)
        if (detail) activity.lastError = clip(detail, TEXT_MAX)
        pushActivity()
      } catch {
        // 同上
      }
    })
    logInfo('活动观测已挂：agent/status + agent/inbox/claimed + tools/* + agent/error → /dsh-activity')
  } catch (error) {
    logWarn('活动观测钩子挂载失败（你的 dsh 版本可能缺这些事件）：', error?.message ?? error)
  }
}
