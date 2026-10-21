/**
 * Localhost — browser half.
 *
 * One main panel and one sidebar row, under the harness's own module-loader
 * wrapper (`window.__ModuleLoader__.load({ id, factory })`) so the package needs
 * no build step: this file IS the shipped client bundle.
 *
 *   `sidebar.panellist` — the nav row, `order: 7`, which seats it between
 *   Tailscale Remote Access (5) and Automation tasks (10): one row for what
 *   comes in from outside, one for what runs on this machine.
 *   `main`              — the panel body, keyed by the same id. It is the only
 *   legal home for the real controls: the nav row is wrapped in the sidebar's
 *   own <button>, so a nested button would be invalid markup.
 *
 * Everything the panel knows comes from the Host half over `/api/localhost.*`,
 * the same authenticated, fenced surface the rest of the UI uses. Nothing is
 * cached client-side, and the panel never claims more than the Host reported:
 * a service it cannot stop is not shown as running.
 *
 * @module dsh-plugin-localhost/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-localhost',
  factory(require) {
    const React = require('react')

    const h = React.createElement

    /**
     * The shared primitive table, when the loader provides it.
     *
     * `StateDot` is the dot the rest of the shell draws — the Tailscale row's
     * green dot is `StateDot({ state: 'done', size: 8 })`. Hand-rolling an 8px
     * circle got the size visibly wrong, so this asks for the real component and
     * falls back to a plain dot only if the table is unavailable.
     */
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }
    const StateDot = typeof primitives?.StateDot === 'function' ? primitives.StateDot : null
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Panel id: shared by the sidebar row and the `main` panel key. */
    const PANEL_ID = 'localhost'
    /** Locale namespace. */
    const NS = 'localhost'
    /** Loader row id, mirrored from cordis.patch.yml. */
    const ROW_ID = 'localhost'

    const API = {
      list: '/api/localhost.list',
      start: '/api/localhost.start',
      stop: '/api/localhost.stop',
      remove: '/api/localhost.remove',
      autostart: '/api/localhost.autostart',
      logs: '/api/localhost.logs',
      reveal: '/api/localhost.reveal',
    }

    const POLL_MS = 2500
    const NAV_POLL_MS = 10000
    const LOG_POLL_MS = 1200

    const zh = {
      'panel.title': 'Localhost',
      'panel.subtitle': '这台机器上跑着的服务和静态页',
      'panel.refresh': '刷新',
      'panel.empty.title': '还没有登记任何东西',
      'panel.empty.body': '让 agent 用 serve 注册一个目录或一条启动命令。',
      'panel.count': '{running} 个在跑 / 共 {total} 个',
      'panel.footer': '关掉 DSH，它们一起关；标了「自动启动」的会在下次启动时自己起来。',
      'kind.spawned': '命令',
      'kind.static': '静态',
      'status.running': '运行中',
      'status.starting': '启动中',
      'status.stopped': '已停止',
      'status.exited': '已退出',
      'action.open': '打开',
      'action.start': '启动',
      'action.stop': '停止',
      'action.remove': '移除',
      'action.removeConfirm': '确认移除',
      'action.removeHint': '从登记表里删掉，并停掉它',
      'action.autoStart': '自动启动',
      'action.autoStartHint': '下次启动 DSH 时自己起来',
      'action.logs': '日志',
      'detail.url': '打开地址',
      'detail.dir': '目录',
      'detail.cmd': '启动命令',
      'detail.session': '登记会话',
      'detail.revealDir': '用 Finder 打开',
      'detail.revealFile': '显示入口文件',
      'detail.gotoSession': '跳到会话',
      'detail.remoteUrl': '远端地址',
      'note.loopbackOnly': '只在本机可访问：这个端口没有 tailnet 映射。',
      'detail.logsEmpty': '还没有输出。',
      'detail.logsLossy': '输出过长，只保留了最近的片段。',
      'error.list': '读取失败：',
      'error.action': '操作失败：',
      'busy.start': '正在启动…',
      'busy.stop': '正在停止…',
      'busy.autoStart': '保存中…',
    }
    const en = {
      'panel.title': 'Localhost',
      'panel.subtitle': 'Servers and static pages running on this machine',
      'panel.refresh': 'Refresh',
      'panel.empty.title': 'Nothing registered yet',
      'panel.empty.body': 'Ask the agent to serve a directory or a start command.',
      'panel.count': '{running} running / {total} total',
      'panel.footer': 'They stop with DSH; the ones marked auto-start come back on launch.',
      'kind.spawned': 'command',
      'kind.static': 'static',
      'status.running': 'running',
      'status.starting': 'starting',
      'status.stopped': 'stopped',
      'status.exited': 'exited',
      'action.open': 'Open',
      'action.start': 'Start',
      'action.stop': 'Stop',
      'action.remove': 'Remove',
      'action.removeConfirm': 'Remove?',
      'action.removeHint': 'Delete the row and stop it',
      'action.autoStart': 'Auto-start',
      'action.autoStartHint': 'Start when DSH launches',
      'action.logs': 'Logs',
      'detail.url': 'Opens',
      'detail.dir': 'Directory',
      'detail.cmd': 'Command',
      'detail.session': 'Registered by',
      'detail.revealDir': 'Show in Finder',
      'detail.revealFile': 'Show entry file',
      'detail.gotoSession': 'Open session',
      'detail.remoteUrl': 'Over Tailscale',
      'note.loopbackOnly': 'Loopback only — nothing publishes this port on the tailnet.',
      'detail.logsEmpty': 'No output yet.',
      'detail.logsLossy': 'Output was long; only the recent tail is kept.',
      'error.list': 'Could not read: ',
      'error.action': 'Failed: ',
      'busy.start': 'Starting…',
      'busy.stop': 'Stopping…',
      'busy.autoStart': 'Saving…',
    }

    const CSS = `
.lh-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary)}
.lh-head{display:flex;align-items:baseline;gap:10px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l4)}
.lh-title{font-size:14px;font-weight:600}
.lh-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}
.lh-spacer{flex:1}
.lh-ghost{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:2px 6px;border-radius:6px}
.lh-ghost:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
.lh-grid{flex:1;min-height:0;overflow:auto;padding:12px 16px 20px;display:grid;gap:10px;align-content:start;grid-template-columns:repeat(auto-fill,minmax(296px,1fr))}
.lh-card{border:1px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 13px;display:flex;flex-direction:column;gap:9px;min-width:0;transition:background .12s,border-color .12s}
.lh-card:hover{background:var(--dsw-alias-bg-layer-2)}
.lh-card-head{display:flex;align-items:center;gap:8px;min-width:0}
.lh-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-idle-primary)}
.lh-dot.running{background:var(--dsw-alias-state-success-primary)}
.lh-dot.starting{background:var(--dsw-alias-state-warn-primary)}
.lh-dot.exited{background:var(--dsw-alias-state-error-primary)}
.lh-name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lh-kind{font-size:10.5px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l4);border-radius:5px;padding:0 5px;line-height:15px;flex:none}
.lh-meta{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.lh-port{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.lh-url{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:ltr}
.lh-actions{display:flex;gap:6px;align-items:center}
.lh-btn{border:1px solid var(--dsw-alias-border-l4);background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;padding:3px 9px;border-radius:6px;cursor:pointer}
.lh-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.lh-btn:disabled{opacity:.5;cursor:default}
.lh-auto.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.lh-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.lh-detail-foot{display:flex;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l4)}
.lh-detail{display:grid;gap:6px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l4)}
.lh-field{display:grid;grid-template-columns:74px 1fr;gap:8px;align-items:baseline;min-width:0}
.lh-label{color:var(--dsw-alias-label-tertiary);font-size:11px}
.lh-value{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;font-size:11.5px;min-width:0}
.lh-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.lh-link{border:0;background:none;padding:0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:11.5px;text-decoration:underline;text-underline-offset:2px}
.lh-log{margin-top:4px;max-height:150px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:7px 9px;white-space:pre-wrap;line-height:1.5}
.lh-logline{color:var(--dsw-alias-label-secondary)}
.lh-note{color:var(--dsw-alias-state-warn-label);font-size:11px}
.lh-err{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:0 20px 8px}
.lh-empty{padding:56px 24px;text-align:center;color:var(--dsw-alias-label-secondary);line-height:1.9}
.lh-empty b{display:block;color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:4px;font-size:13px}
.lh-navdot-slot{position:absolute;right:-4px;bottom:-3px;line-height:0;display:inline-flex}
.lh-navdot{display:block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.lh-foot{padding:10px 20px 14px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;border-top:1px solid var(--dsw-alias-border-l4)}
`

    /**
     * Is this page being viewed from another device?
     *
     * `127.0.0.1:8840` means the machine the reader is holding. Only a loopback
     * page can open the Host's ports directly; a phone over Tailscale has to use
     * the tailnet URL, which is why the registry carries `remoteUrl` too.
     */
    function isLoopbackClient() {
      try {
        const { protocol, hostname } = window.location
        // The desktop shell loads the UI from its own scheme; that page *is* the
        // host, so it counts as local no matter what the scheme calls itself.
        if (protocol === 'dsh:' || protocol === 'file:') return true
        return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
      } catch {
        return true
      }
    }

    /** The registry, as the panel and the nav dot both read it. */
    async function fetchServices() {
      const response = await fetch(API.list, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await response.json()
      return Array.isArray(body?.services) ? body.services : []
    }

    /** Render the panel body. */
    function Panel(props) {
      const { t } = props
      const [services, setServices] = useState([])
      const [error, setError] = useState(null)
      const [expanded, setExpanded] = useState(null)
      const [confirming, setConfirming] = useState(null)
      const [logs, setLogs] = useState([])
      const [lossy, setLossy] = useState(false)
      const [busy, setBusy] = useState(null)
      const alive = useRef(true)

      const refresh = useCallback(async () => {
        try {
          const next = await fetchServices()
          if (!alive.current) return
          setServices(next)
          setError(null)
        } catch (failure) {
          if (alive.current) setError(String(failure?.message ?? failure))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        refresh()
        const timer = setInterval(refresh, POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [refresh])

      useEffect(() => {
        if (!expanded) return undefined
        let cancelled = false
        const load = async () => {
          try {
            const response = await fetch(`${API.logs}?id=${encodeURIComponent(expanded)}`, {
              headers: { accept: 'application/json' },
            })
            if (!response.ok) return
            const body = await response.json()
            if (!cancelled) {
              setLogs(Array.isArray(body?.lines) ? body.lines : [])
              setLossy(Boolean(body?.lossy))
            }
          } catch {}
        }
        load()
        const timer = setInterval(load, LOG_POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [expanded])

      const act = useCallback(
        async (url, payload, label) => {
          setBusy({ id: payload.id, label })
          setConfirming(null)
          setError(null)
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            })
            if (!response.ok) {
              const body = await response.json().catch(() => ({}))
              throw new Error(body?.error || `HTTP ${response.status}`)
            }
            // A removed row cannot stay open: the panel's next read will not have it.
            if (url === API.remove) setExpanded(null)
            await refresh()
          } catch (failure) {
            setError(String(failure?.message ?? failure))
          } finally {
            setBusy(null)
          }
        },
        [refresh],
      )

      const reveal = useCallback(async (id, target) => {
        try {
          const response = await fetch(API.reveal, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, target }),
          })
          if (!response.ok) {
            const body = await response.json().catch(() => ({}))
            throw new Error(body?.error || `HTTP ${response.status}`)
          }
        } catch (failure) {
          setError(String(failure?.message ?? failure))
        }
      }, [])

      const remote = !isLoopbackClient()
      const running = services.filter((service) => service.status === 'running').length

      return h(
        'div',
        { className: 'lh-root' },
        h(
          'div',
          { className: 'lh-head' },
          h('span', { className: 'lh-title' }, t('panel.title')),
          h('span', { className: 'lh-sub' }, t('panel.subtitle')),
          h('span', { className: 'lh-spacer' }),
          h('span', { className: 'lh-sub' }, t('panel.count', { running, total: services.length })),
          h('button', { className: 'lh-ghost', onClick: refresh, type: 'button' }, t('panel.refresh')),
        ),
        error !== null ? h('div', { className: 'lh-err' }, `${t('error.list')}${error}`) : null,
        services.length === 0
          ? h(
              'div',
              { className: 'lh-empty' },
              h('b', null, t('panel.empty.title')),
              h('span', null, t('panel.empty.body')),
            )
          : h(
              'div',
              { className: 'lh-grid' },
              services.map((service) =>
                h(ServiceCard, {
                  key: service.id,
                  service,
                  t,
                  busy: busy?.id === service.id ? busy.label : null,
                  expanded: expanded === service.id,
                  logs: expanded === service.id ? logs : [],
                  lossy: expanded === service.id ? lossy : false,
                  onToggle: () => {
                    setExpanded(expanded === service.id ? null : service.id)
                    setConfirming(null)
                  },
                  onStart: () => act(API.start, { id: service.id }, t('busy.start')),
                  onStop: () => act(API.stop, { id: service.id }, t('busy.stop')),
                  onAutoStart: () =>
                    act(API.autostart, { id: service.id, autoStart: !service.autoStart }, t('busy.autoStart')),
                  confirming: confirming === service.id,
                  onRemove: () => {
                    // Two clicks: the first asks, the second does it. A row is
                    // cheap to re-register but expensive to lose by accident.
                    if (confirming !== service.id) return setConfirming(service.id)
                    return act(API.remove, { id: service.id }, t('busy.stop'))
                  },
                  onReveal: (target) => reveal(service.id, target),
                  remote,
                  onOpen: () => {
                    // On a remote page the Host's browser is the wrong place: open
                    // the tailnet URL here instead, and never fall back to the Host.
                    if (!remote) return reveal(service.id, 'url')
                    if (service.remoteUrl) {
                      try {
                        window.open(service.remoteUrl, '_blank', 'noopener')
                      } catch (failure) {
                        setError(String(failure?.message ?? failure))
                      }
                    }
                  },
                  onSession: props.openSession,
                }),
              ),
            ),
        h('div', { className: 'lh-foot' }, t('panel.footer')),
      )
    }

    /** The four states the dot can be in; anything else reads as stopped. */
    function statusOf(status) {
      return status === 'running' || status === 'starting' || status === 'exited' ? status : 'stopped'
    }

    /** One service as a tile: identity, where it lives, one action set. */
    function ServiceCard(props) {
      const { service, t, busy, expanded, logs, lossy, remote } = props
      const canOpen = statusOf(service.status) === 'running' && (!remote || Boolean(service.remoteUrl))
      const status =
        service.status === 'running' || service.status === 'starting' || service.status === 'exited'
          ? service.status
          : 'stopped'
      const started = status === 'running' || status === 'starting'

      return h(
        'div',
        { className: 'lh-card' },
        h(
          'div',
          { className: 'lh-card-head' },
          h('span', { className: `lh-dot ${status}` }),
          h('span', { className: 'lh-name', title: service.name }, service.name),
          h('span', { className: 'lh-spacer' }),
          h('span', { className: 'lh-kind' }, t(`kind.${service.kind}`)),
        ),
        h(
          'div',
          { className: 'lh-meta' },
          h('span', { className: 'lh-port' }, `:${service.port}`),
          h('span', null, busy ?? t(`status.${status}`)),
        ),
        h('div', { className: 'lh-url', title: service.url }, service.url),
        h(
          'div',
          { className: 'lh-actions' },
          canOpen
            ? h('button', { className: 'lh-btn', type: 'button', onClick: props.onOpen }, t('action.open'))
            : null,
          started
            ? h('button', { className: 'lh-btn', type: 'button', disabled: Boolean(busy), onClick: props.onStop }, t('action.stop'))
            : h('button', { className: 'lh-btn', type: 'button', disabled: Boolean(busy), onClick: props.onStart }, t('action.start')),
          // The dot says "on" without a tooltip, and the button is the only
          // control in this panel that changes how the next launch behaves.
          h(
            'button',
            {
              className: `lh-btn lh-auto${service.autoStart ? ' on' : ''}`,
              type: 'button',
              title: t('action.autoStartHint'),
              'aria-pressed': service.autoStart ? 'true' : 'false',
              disabled: Boolean(busy),
              onClick: props.onAutoStart,
            },
            `${service.autoStart ? '●' : '○'} ${t('action.autoStart')}`,
          ),
          h('span', { className: 'lh-spacer' }),
          h('button', { className: 'lh-btn', type: 'button', onClick: props.onToggle }, expanded ? '▲' : '▼'),
        ),
        service.error ? h('div', { className: 'lh-note' }, service.error) : null,
        remote && statusOf(service.status) === 'running' && !service.remoteUrl
          ? h('div', { className: 'lh-note' }, t('note.loopbackOnly'))
          : null,
        expanded ? h(Detail, { ...props, logs, lossy }) : null,
      )
    }

    /** Where it lives, who registered it, and what it printed. */
    function Detail(props) {
      const { service, t, logs, lossy } = props
      return h(
        'div',
        { className: 'lh-detail' },
        h(
          'div',
          { className: 'lh-field' },
          h('span', { className: 'lh-label' }, t('detail.dir')),
          h(
            'span',
            { className: 'lh-value lh-mono' },
            service.dir,
            ' ',
            h('button', { className: 'lh-link', type: 'button', onClick: () => props.onReveal('dir') }, t('detail.revealDir')),
          ),
        ),
        service.remoteUrl
          ? h(
              'div',
              { className: 'lh-field' },
              h('span', { className: 'lh-label' }, t('detail.remoteUrl')),
              h('span', { className: 'lh-value lh-mono' }, service.remoteUrl),
            )
          : null,
        service.kind === 'static'
          ? h(
              'div',
              { className: 'lh-field' },
              h('span', { className: 'lh-label' }, 'index'),
              h(
                'span',
                { className: 'lh-value lh-mono' },
                service.entry || 'index.html',
                ' ',
                h('button', { className: 'lh-link', type: 'button', onClick: () => props.onReveal('file') }, t('detail.revealFile')),
              ),
            )
          : h(
              'div',
              { className: 'lh-field' },
              h('span', { className: 'lh-label' }, t('detail.cmd')),
              h('span', { className: 'lh-value lh-mono' }, service.cmd),
            ),
        service.sessionId
          ? h(
              'div',
              { className: 'lh-field' },
              h('span', { className: 'lh-label' }, t('detail.session')),
              h(
                'span',
                { className: 'lh-value lh-mono' },
                service.sessionId.replace(/^session-/, '').slice(0, 8),
                ' ',
                h(
                  'button',
                  {
                    className: 'lh-link',
                    type: 'button',
                    onClick: () => props.onSession?.(service.sessionId),
                  },
                  t('detail.gotoSession'),
                ),
              ),
            )
          : null,
        h(
          'div',
          { className: 'lh-field' },
          h('span', { className: 'lh-label' }, t('action.logs')),
          h(
            'span',
            { className: 'lh-value' },
            h(
              'div',
              { className: 'lh-log' },
              logs.length === 0
                ? h('span', { className: 'lh-logline' }, t('detail.logsEmpty'))
                : logs.map((line, index) => h('div', { key: index, className: 'lh-logline' }, line)),
            ),
            lossy ? h('div', { className: 'lh-note' }, t('detail.logsLossy')) : null,
          ),
        ),
        h(
          'div',
          { className: 'lh-detail-foot' },
          h(
            'button',
            {
              className: `lh-btn${props.confirming ? ' lh-danger' : ''}`,
              type: 'button',
              title: t('action.removeHint'),
              disabled: Boolean(props.busy),
              onClick: props.onRemove,
            },
            props.confirming ? t('action.removeConfirm') : t('action.remove'),
          ),
        ),
      )
    }

    /**
     * The nav row: a stack of little panels, one of them lit, plus a dot while
     * anything is running. The row is mounted whether or not the panel is open,
     * so it polls on its own slower cadence rather than sharing the panel's.
     */
    function SidebarIcon(props) {
      const size = props?.size ?? 20
      const [running, setRunning] = useState(0)
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const services = await fetchServices()
            if (alive) setRunning(services.filter((service) => service.status === 'running').length)
          } catch {}
        }
        load()
        const timer = setInterval(load, NAV_POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        h(Icon, { size }),
        running > 0
          ? h(
              'span',
              { className: 'lh-navdot-slot', 'aria-label': String(running) },
              StateDot !== null
                ? h(StateDot, { state: 'done', size: 8 })
                : h('span', { className: 'lh-navdot' }),
            )
          : null,
      )
    }

    /** The panel glyph: a stack of panels, which is what the row lists. */
    function Icon(props) {
      const size = props.size
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }),
        h('rect', { x: 3, y: 14, width: 18, height: 6, rx: 2 }),
        h('circle', { cx: 7, cy: 7.5, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 7, cy: 17, r: 1, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M11 7.5h6M11 17h6' }),
      )
    }

    const inject = ['slots', 'locale', 'uiWorkspace']

    /**
     * Mount the panel and the nav row.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)
      const t = ctx.locale.bind(NS)

      // Declared in `inject`: the client context is a whitelisting proxy, so an
      // undeclared lookup returns undefined and the session jump silently did
      // nothing. (0.1.x read it through serviceOf and never noticed.)
      const openSession = (id) => {
        try {
          ctx.uiWorkspace?.openSession?.(id)
        } catch (failure) {
          console.warn(`localhost: could not open session ${id}: ${failure?.message ?? failure}`)
        }
      }

      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        if (document.querySelector(`style[data-plugin-css="${NS}"]`) !== null) return undefined
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', NS)
        style.textContent = CSS
        document.head?.appendChild(style)
        return () => style.remove()
      }, `${NS}: styles`)

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 7,
            locale: NS,
            label: () => t('panel.title'),
          },
          SidebarIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
          },
          function LocalhostPage() {
            return h(Panel, { t, openSession })
          },
        ),
      )
    }

    return { inject, apply }
  },
})
