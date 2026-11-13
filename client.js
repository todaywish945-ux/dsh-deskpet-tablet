/**
 * 桌宠 · DSH 客户端半边（免构建手写 bundle）。
 *
 * 视频通话停在 dsh 界面右缘的一条**专属窄条**里：主框架（.frame）被 margin-right
 * 挤出一条与视频同宽的沟——空间是真让出来的，对话在剩余区域重排，**谁也不盖谁**；
 * 而视频本身是正常大小（360×500 的卡），嵌在窄条顶部，不再拉成通天长条
 * （0.2.1 槽位遮蔽 → 0.3.0 通天挖沟 → 0.3.1 悬浮 PiP 挡对话 → 0.4.0 定型：让位 + 正常大小）。
 *
 * 卡是 iframe → 桌宠主进程直出的 http://127.0.0.1:37820/panel（自带动画/字幕/语音
 * 与 WS 事件流）；大脑、TTS、会话都在桌宠进程里，这里只是一块「远程同屏」。
 * ✕ 收起时沟一并填回、布局复原，右下角小钮再开；找不到框架节点时退化为可拖悬浮。
 *
 * 手写而不用构建：整个插件零构建单文件分发；bundle 格式与 tsdown 产物一致：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
 * 可用 require 的只有平台种子模块（react / react-dom / …）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-deskpet-tablet',
  factory: function (require) {
    'use strict'
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /** 控制桥默认端口，与桌宠 / cordis.patch.yml 的 port 一致 */
    var DEFAULT_PORT = 37820
    /** 探活节奏：在线时慢一点，离线时勤一点，桌宠一启动就能挂上 */
    var PROBE_ONLINE_MS = 8000
    var PROBE_OFFLINE_MS = 3000
    var STORAGE_KEY = 'dsh-pet-dock/v2'
    /** 窄条宽 = 卡宽；卡正常大小（高度固定），不再拉通天 */
    var DEFAULT_W = 360
    var MIN_W = 300
    var MAX_W = 460
    var CARD_H = 500
    /** 卡在窄条里离顶栏的距离 */
    var TOP_OFFSET = 12
    /** 框架节点可能被 React 重挂（HMR/热更）：开着时低频重申 margin */
    var GUTTER_REASSERT_MS = 2500
    var MARGIN = 16

    /** 开合的模块级镜像：DSH 每次启动都自动展开（用户要求）；收起只在当次会话内生效，
     *  会话里点 ✕ 收起 → 小钮可再开，但下次启动 dsh 照样自动展开。宽度记忆仍在。 */
    var prefs0 = loadPrefs()
    var dockOpen = true
    var openListeners = new Set()

    function setDockOpen(value) {
      if (dockOpen === value) return
      dockOpen = value
      openListeners.forEach(function (fn) {
        try {
          fn(value)
        } catch (error) {
          /* 订阅者出错不影响别人 */
        }
      })
    }

    function bridgePort() {
      var raw = Number(window.__DSH_PET_PORT__)
      return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT
    }

    function bridgeBase() {
      return 'http://127.0.0.1:' + bridgePort()
    }

    function loadPrefs() {
      try {
        return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {}
      } catch (error) {
        return {}
      }
    }

    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
      } catch (error) {
        /* 隐私模式下 localStorage 会抛，忽略即可 */
      }
    }

    /** 主框架节点：浮层的父节点就是 .frame；用 display:grid 做一次 Sanity 校验 */
    function frameEl() {
      if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null
      var layer = document.querySelector('[data-shell-overlay]')
      var frame = layer && layer.parentElement
      if (!frame) return null
      try {
        if (getComputedStyle(frame).display !== 'grid') return null
      } catch (error) {
        return null
      }
      return frame
    }

    /** 挖沟/填沟：width>0 把框架挤窄，0 还原。找不到框架返回 null（退化悬浮） */
    function applyGutter(width) {
      var frame = frameEl()
      if (!frame) return false
      frame.style.marginRight = width > 0 ? width + 'px' : ''
      return true
    }

    function clampWidth(px) {
      return Math.min(MAX_W, Math.max(MIN_W, Math.round(px)))
    }

    /** 拖动开始就抓住指针：之后指针划过 iframe、甚至窗口外，pointer 事件都会重定向
     * 回触发元素并照常冒泡，父文档必收得到 pointerup —— 不捕获的话松手事件会被
     * 卡里的跨源 iframe 吞掉，监听器摘不掉，左键松了边框还跟着鼠标变 */
    function capturePointer(event) {
      try {
        if (event.target && event.target.setPointerCapture) {
          event.target.setPointerCapture(event.pointerId)
        }
      } catch (error) {
        /* 指针已失效等场景忽略；onMove 的 buttons 守卫兜底 */
      }
    }

    var styles = {
      card: {
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.10)',
        background: '#101418',
        boxShadow: '0 18px 48px rgba(0,0,0,0.55)',
        // 浮层默认 click-through，卡自己要把指针事件要回来
        pointerEvents: 'auto',
        zIndex: 40,
        color: '#e8eaf0',
        fontFamily: "'PingFang SC','Microsoft YaHei',system-ui,sans-serif"
      },
      cardDockedExtras: {
        // 停靠态：整体往左留 10px 空隙（不贴死屏幕边），四角全圆
        right: '10px',
        borderRadius: '14px'
      },
      cardFloatExtras: {
        borderRadius: '14px'
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        height: '32px',
        flex: '0 0 32px',
        padding: '0 6px 0 10px',
        background: 'rgba(255,255,255,0.04)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        userSelect: 'none'
      },
      dot: {
        width: '7px',
        height: '7px',
        flex: '0 0 7px',
        borderRadius: '50%',
        background: '#6a7280'
      },
      dotOn: {
        background: '#4cd07d',
        boxShadow: '0 0 6px rgba(76,208,125,0.8)'
      },
      title: {
        fontSize: '12px',
        fontWeight: 600,
        letterSpacing: '0.02em'
      },
      status: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: '11px',
        color: '#8b93a1',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      },
      iconBtn: {
        flex: '0 0 auto',
        width: '22px',
        height: '22px',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: '#9aa3b2',
        fontSize: '13px',
        lineHeight: '22px',
        cursor: 'pointer',
        padding: 0
      },
      body: {
        position: 'relative',
        flex: '1 1 auto',
        minHeight: 0,
        background: '#101418'
      },
      frame: {
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        background: '#101418'
      },
      hint: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '8px',
        padding: '0 22px',
        textAlign: 'center',
        fontSize: '12px',
        lineHeight: 1.7,
        color: '#8b93a1'
      },
      hintTitle: {
        fontSize: '13px',
        color: '#c9d0dc'
      },
      stuck: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '9px',
        padding: '0 20px',
        textAlign: 'center',
        fontSize: '12px',
        lineHeight: 1.7,
        color: '#8b93a1',
        background: 'rgba(16,20,24,0.96)'
      },
      url: {
        fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: '11px',
        color: '#9fb4d8',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '6px',
        padding: '3px 7px',
        userSelect: 'text'
      },
      action: {
        marginTop: '2px',
        border: 'none',
        borderRadius: '14px',
        background: '#3b6fe0',
        color: '#fff',
        fontSize: '12px',
        padding: '6px 14px',
        cursor: 'pointer'
      },
      grip: {
        position: 'absolute',
        left: '-4px',
        top: 0,
        bottom: 0,
        width: '8px',
        cursor: 'col-resize',
        zIndex: 2
      },
      pill: {
        position: 'fixed',
        right: MARGIN + 'px',
        bottom: MARGIN + 'px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        height: '30px',
        padding: '0 12px',
        borderRadius: '15px',
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'rgba(16,20,24,0.92)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
        color: '#dfe4ee',
        fontSize: '12px',
        cursor: 'pointer',
        pointerEvents: 'auto',
        zIndex: 40
      }
    }

    /** 控制桥探活 hook：返回桌宠是否在线；up 回调在「首次探活成功」那拍触发（挂 iframe 用） */
    function useBridgeOnline(onUp) {
      var state = React.useState(false)
      var online = state[0]
      var setOnline = state[1]
      var onUpRef = React.useRef(onUp)
      onUpRef.current = onUp
      React.useEffect(function () {
        var alive = true
        var timer = null

        function schedule(ms) {
          if (!alive) return
          timer = window.setTimeout(probe, ms)
        }

        function probe() {
          fetch(bridgeBase() + '/health', { cache: 'no-store' })
            .then(function (res) {
              return res.ok ? res.json() : null
            })
            .then(function (health) {
              if (!alive) return
              var up = !!(health && health.ok)
              setOnline(up)
              if (up && onUpRef.current) onUpRef.current()
              schedule(up ? PROBE_ONLINE_MS : PROBE_OFFLINE_MS)
            })
            .catch(function () {
              if (!alive) return
              setOnline(false)
              schedule(PROBE_OFFLINE_MS)
            })
        }

        probe()
        return function () {
          alive = false
          if (timer) window.clearTimeout(timer)
        }
      }, [])
      return online
    }

    /**
     * 视频卡：正常大小（高固定 360，宽可拖），停靠在右缘窄条顶部；
     * 窄条由框架 margin 挖出，空间真让位。找不到框架时退化为可拖悬浮。
     */
    function PetCard() {
      var prefs = loadPrefs()
      var widthState = React.useState(clampWidth(prefs.width || DEFAULT_W))
      var width = widthState[0]
      var setWidth = widthState[1]
      var openState = React.useState(dockOpen)
      var open = openState[0]
      var setOpen = openState[1]
      // 停靠（挖沟成功）还是退化悬浮；随重申周期自动修正
      var dockedState = React.useState(true)
      var docked = dockedState[0]
      var setDocked = dockedState[1]
      var posState = React.useState(
        prefs.pos && typeof prefs.pos.left === 'number'
          ? prefs.pos
          : { left: MARGIN * 2, top: 64 }
      )
      var pos = posState[0]
      var setPos = posState[1]
      // 一旦连上过就常驻 iframe：断线时面板自己的 WS 会重连，不必反复挂载
      var mountedState = React.useState(false)
      var mounted = mountedState[0]
      var setMounted = mountedState[1]
      var online = useBridgeOnline(function () {
        setMounted(true)
      })
      var nonceState = React.useState(0)
      var nonce = nonceState[0]
      var setNonce = nonceState[1]
      var loadedState = React.useState(false)
      var frameLoaded = loadedState[0]
      var setFrameLoaded = loadedState[1]
      var stuckState = React.useState(false)
      var frameStuck = stuckState[0]
      var setFrameStuck = stuckState[1]

      // 挖沟：随开合与宽度变化申明；开着时低频重申（React 重挂会丢内联样式）。
      // 卸载/收起时把沟填回去，布局完全复原。
      React.useEffect(function () {
        var timer = null
        function reassert() {
          var frame = frameEl()
          setDocked(!!frame)
          if (!frame) return
          frame.style.marginRight = open ? width + 'px' : ''
        }
        reassert()
        if (open) timer = window.setInterval(reassert, GUTTER_REASSERT_MS)
        return function () {
          if (timer) window.clearInterval(timer)
          if (open) applyGutter(0)
        }
      }, [open, width])

      // 兜底：iframe 6 秒还没 load，多半是宿主外壳用自定义协议、把跨站框架拦了
      React.useEffect(function () {
        if (!open || !mounted || frameLoaded) {
          setFrameStuck(false)
          return undefined
        }
        var timer = window.setTimeout(function () {
          setFrameStuck(true)
        }, 6000)
        return function () {
          window.clearTimeout(timer)
        }
      }, [open, mounted, nonce, frameLoaded])

      function persist(nextOpen, nextWidth, nextPos) {
        savePrefs({ open: nextOpen, width: nextWidth, pos: nextPos })
      }

      /** 左缘拖宽：拖动实时改宽度 + 沟，松手落盘 */
      function startResize(event) {
        if (event.button !== 0) return
        event.preventDefault()
        capturePointer(event)
        var startX = event.clientX
        var base = width
        var latest = width
        var done = false

        function cleanup() {
          if (done) return
          done = true
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }

        function onMove(moveEvent) {
          // 按钮已松开却还在收 move（捕获被抢等极端情况）：立刻收手，别让边框跟着空鼠标变
          if (moveEvent.buttons === 0) {
            cleanup()
            return
          }
          latest = clampWidth(base + (startX - moveEvent.clientX))
          setWidth(latest)
          if (docked) applyGutter(latest)
        }

        function onUp() {
          cleanup()
          // 落盘要给拖出来的最新宽度，闭包里的 width 是拖动开始那拍的旧值
          persist(open, latest, pos)
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      /** 退化悬浮时才可拖位置 */
      function startDrag(event) {
        if (docked || event.button !== 0) return
        capturePointer(event)
        var startX = event.clientX
        var startY = event.clientY
        var base = pos
        var moved = null
        var done = false

        function cleanup() {
          if (done) return
          done = true
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }

        function onMove(moveEvent) {
          if (moveEvent.buttons === 0) {
            cleanup()
            return
          }
          var vw = window.innerWidth || 1280
          var vh = window.innerHeight || 800
          moved = {
            left: Math.min(Math.max(MARGIN, Math.round(base.left + moveEvent.clientX - startX)), Math.max(MARGIN, vw - width - MARGIN)),
            top: Math.min(Math.max(MARGIN, Math.round(base.top + moveEvent.clientY - startY)), Math.max(MARGIN, vh - CARD_H - MARGIN))
          }
          setPos(moved)
        }

        function onUp() {
          cleanup()
          if (moved) persist(open, width, moved)
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      function stopPointer(event) {
        event.stopPropagation()
      }

      function reload() {
        setFrameLoaded(false)
        setFrameStuck(false)
        setNonce(nonce + 1)
        setMounted(false)
        // 立刻重挂：探活下一拍会把 mounted 再置回 true
        window.setTimeout(function () {
          setMounted(true)
        }, 60)
      }

      function collapse() {
        setOpen(false)
        setDockOpen(false)
        persist(false, width, pos)
      }

      function expand() {
        setOpen(true)
        setDockOpen(true)
        persist(true, width, pos)
      }

      if (!open) return null

      var cardStyle = docked
        ? Object.assign({}, styles.card, styles.cardDockedExtras, {
            // 占满窄条全高：面板页自己分「视频 + 下方对话区」两段
            top: '0px',
            width: width + 'px',
            height: '100%'
          })
        : Object.assign({}, styles.card, styles.cardFloatExtras, {
            left: pos.left + 'px',
            top: pos.top + 'px',
            width: width + 'px',
            height: CARD_H + 'px'
          })

      return h(
        'div',
        { style: cardStyle, 'data-dsh-pet-card': '1' },
        docked ? h('div', { style: styles.grip, onPointerDown: startResize, title: '拖动调宽度' }) : null,
        h(
          'div',
          {
            style: Object.assign({}, styles.header, docked ? null : { cursor: 'move' }),
            onPointerDown: startDrag,
            title: docked ? '桌宠视频通话' : '拖动移动位置'
          },
          h('span', { style: online ? Object.assign({}, styles.dot, styles.dotOn) : styles.dot }),
          h('span', { style: styles.title }, '桌宠'),
          h('span', { style: styles.status }, online ? '视频通话' : '桌宠未启动'),
          h(
            'button',
            { type: 'button', style: styles.iconBtn, title: '重载面板', onPointerDown: stopPointer, onClick: reload },
            '⟳'
          ),
          h(
            'button',
            { type: 'button', style: styles.iconBtn, title: '收起（右下角小钮可再开）', onPointerDown: stopPointer, onClick: collapse },
            '✕'
          )
        ),
        h(
          'div',
          { style: styles.body },
          mounted
            ? h('iframe', {
                key: nonce,
                src: bridgeBase() + '/panel',
                style: styles.frame,
                title: '桌宠 · 视频通话',
                allow: 'autoplay; microphone',
                onLoad: function () {
                  setFrameLoaded(true)
                }
              })
            : h(
                'div',
                { style: styles.hint },
                h('div', { style: styles.hintTitle }, '桌宠还没启动'),
                h('div', null, '启动桌宠后，', h('br'), '或在 dsh 里让她说一句话，这里自动接上')
              ),
          frameStuck && !frameLoaded
            ? h(
                'div',
                { style: styles.stuck },
                h('div', { style: styles.hintTitle }, '面板没能显示出来'),
                h('div', null, '宿主界面大概用自定义协议（dsh-app://）把跨站框架拦了。点「⟳ 重载」再试，或在新窗口打开：'),
                h('code', { style: styles.url }, bridgeBase() + '/panel'),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.action,
                    onClick: function () {
                      window.open(bridgeBase() + '/panel', '_blank', 'width=380,height=520')
                    }
                  },
                  '在新窗口打开'
                )
              )
            : null
        )
      )
    }

    /** 右下角小钮：卡收起时重新打开（开着时自动隐藏，不占地方） */
    function PetPill() {
      var state = React.useState(dockOpen)
      var open = state[0]
      var setOpen = state[1]
      React.useEffect(function () {
        openListeners.add(setOpen)
        return function () {
          openListeners.delete(setOpen)
        }
      }, [])
      if (open) return null
      return h(
        'button',
        {
          type: 'button',
          style: styles.pill,
          title: '打开桌宠的视频小窗',
          onClick: function () {
            var prefs = loadPrefs()
            savePrefs({ open: true, width: clampWidth(prefs.width || DEFAULT_W), pos: prefs.pos })
            setDockOpen(true)
            setOpen(true)
          }
        },
        h('span', { style: styles.dot }),
        '桌宠'
      )
    }

    /** apply 闭包里注入的会话服务（面板 → DS 的消息注入通道用） */
    var ctxSessions = null

    /** 面板 iframe → DS：把用户消息注入当前编码会话。
     *  通道（源码钉死）：sessions.current 拿当前会话 → sessions.scope(id) 拿作用域
     *  → scope.conversation.send(text) 入队一轮。回执经 event.source 原路带回。 */
    function forwardToDs(text, replyTo) {
      var ack = function (ok, error) {
        try {
          if (replyTo) replyTo.postMessage({ type: 'dsh-pet-to-ds-ack', ok: ok, error: error || undefined }, '*')
        } catch (e) {
          /* 面板可能已经关了 */
        }
      }
      try {
        var id = ctxSessions && ctxSessions.current
        if (!id) {
          ack(false, '当前没有活跃的编码会话')
          return
        }
        var scopeCtx = ctxSessions.scope(id)
        var conversation = scopeCtx && scopeCtx.conversation
        if (!conversation || typeof conversation.send !== 'function') {
          ack(false, '会话通道不可用（conversation 服务没解析到）')
          return
        }
        Promise.resolve(conversation.send(text))
          .then(function () {
            ack(true)
          })
          .catch(function (error) {
            ack(false, error?.message ?? String(error))
          })
      } catch (error) {
        ack(false, error?.message ?? String(error))
      }
    }

    /**
     * 客户端插件体：两个条目都进 shell.overlay（列表槽，加法式，不覆盖任何内置界面）。
     * 「不挡对话」靠挖沟让位（margin-right），视频卡本身是正常大小。
     */
    function apply(ctx) {
      // sessions 服务惰性获取：不用模块级 inject（那个会在服务未就绪时挂起整个模块），
      // 卡片永远先渲染，“发给DS”通道等 sessions 就绪后自动激活
      try {
        ctx.inject(['sessions'], function (scope) {
          ctxSessions = scope.sessions
        })
      } catch (error) {
        // 转发通道不可用只影响“发给DS”，其余功能照常
      }

      // 面板 iframe 的转发通道：面板页 postMessage('dsh-pet-to-ds') → 注入当前会话
      window.addEventListener('message', function (event) {
        var data = event.data
        if (!data || data.type !== 'dsh-pet-to-ds' || typeof data.text !== 'string') return
        forwardToDs(data.text.trim(), event.source)
      })

      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'pet-card', order: 90, label: '桌宠' }, PetCard)
      })
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: 'pet-pill', order: 91, label: '桌宠' }, PetPill)
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  }
})
