/**
 * Service Host — host half.
 *
 * The panel can only be honest about a process it owns. So this half owns two
 * things and refuses to pretend about a third:
 *
 *   1. **Static** entries — a directory served by this process on 127.0.0.1.
 *      No child process, no log file, and it cannot outlive the app.
 *   2. **Spawned** entries — a command started through `ctx.subprocess`, which
 *      terminates every still-running managed process when the service disposes.
 *      That is the whole reason the spawn goes through the seam instead of
 *      `node:child_process`: a detached child is exactly the leak that leaves
 *      four daemons alive for eleven days (see `docs/plan.md`).
 *   3. **External** processes are *not* managed. A server an agent started with
 *      bash is not owned here, so it is not listed here. M1 has no "adopt" path
 *      for it, and saying "running" about a process we cannot kill would be a lie.
 *
 * The registry is data, not a preference: it lives in
 * `~/.dsh/localhost/services.json`, not in the plugin's Config. Definitions
 * survive a restart; runtime state (pid, log tail, exit code) never does, and
 * a restart shows everything stopped unless the entry opted into `autoStart`.
 *
 * The file is the truth and memory is its cache. An edit made on disk — a row
 * deleted with an editor, a port fixed by hand — is mirrored on the next read.
 * Before 0.4.0 memory won: a row deleted on disk stayed in the panel, and the
 * next `save()` wrote it back, so the only way out was restarting the app. The
 * real reason that happened is in `docs/plan.md` §17: there was no supported
 * way to delete a row, so an agent deleted it in the file instead.
 *
 * @module dsh-plugin-localhost
 */

import { execFile, spawn as spawnOneShot } from 'node:child_process'
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'

/** Route prefix. Derived from the package name, so a renamed Loader row cannot orphan it. */
const ROUTE = '/api/localhost'

/** Assigned ports live in one range, so a service never lands on a number someone typed. */
const PORT_MIN = 8840
const PORT_MAX = 8899

/** Registry location. `DSH_HOME` is honored when the harness sets it. */
const STATE_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'localhost')
const REGISTRY_PATH = join(STATE_DIR, 'services.json')

/** How much of a running service's output is kept for the panel and the tool. */
const LOG_LINES = 400

/** Poll cadence for readiness and for the log tail. */
const TICK_MS = 700

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
}

/**
 * Parse `tailscale serve status --json` into local port → public URL.
 *
 * The shape is `{ Web: { "<host>:<port>": { Handlers: { "<prefix>": { Proxy: "http://127.0.0.1:<local>" } } } } }`,
 * with the port omitted for 443. Only loopback proxies map back to a service we
 * could be hosting; anything else is somebody else's mapping and is ignored.
 *
 * @param status - parsed JSON, or null when the CLI failed.
 * @returns a Map from local port to `{ origin, prefix }`.
 */
export function parseServeMap(status) {
  const map = new Map()
  const web = status?.Web
  if (!web || typeof web !== 'object') return map
  for (const [key, entry] of Object.entries(web)) {
    const handlers = entry?.Handlers
    if (!handlers || typeof handlers !== 'object') continue
    const match = /^(.*?)(?::(\d+))?$/.exec(key)
    if (!match) continue
    const host = match[1]
    const port = match[2] === undefined ? 443 : Number(match[2])
    const origin = `https://${host}${port === 443 ? '' : `:${port}`}`
    for (const [prefix, handler] of Object.entries(handlers)) {
      const proxy = handler?.Proxy
      if (typeof proxy !== 'string') continue
      const local = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(proxy)
      if (!local) continue
      map.set(Number(local[1]), {
        origin,
        prefix: prefix.endsWith('/') ? prefix.slice(0, -1) : prefix,
      })
    }
  }
  return map
}

/** Hard dependencies: the routes and the admit fence. Everything else is optional. */
export const inject = ['webServer', 'connection']

/**
 * Mount the registry, the routes, and the agent-facing tool.
 *
 * @param ctx - host context carrying `webServer` and `connection`.
 */
export function apply(ctx) {
  /** @type {Array<object>} persisted definitions, in panel order */
  let entries = []
  /** @type {Map<string, object>} runtime state, never persisted */
  const runtime = new Map()
  /** Identity of the registry file `entries` mirrors, so an external edit is not missed. */
  let stamp = ''

  const subprocess = () => ctx.get('subprocess')
  const tools = () => ctx.get('tools')

  // ---------------------------------------------------------------- persistence

  function stampOf() {
    try {
      const info = statSync(REGISTRY_PATH)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'missing'
    }
  }

  /** The file's rows, `[]` when there is no file, `null` when it cannot be read. */
  function readFileRegistry() {
    let text
    try {
      text = readFileSync(REGISTRY_PATH, 'utf8')
    } catch (error) {
      // No file yet is an empty registry. Anything else (permissions, a
      // directory in the way) is a read we must not turn into "no services".
      return error?.code === 'ENOENT' ? [] : null
    }
    try {
      const parsed = JSON.parse(text)
      if (!Array.isArray(parsed?.services)) return null
      return parsed.services.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.dir === 'string')
    } catch {
      // Half-written by an editor, or not a registry at all: keep what we have
      // and try again on the next read rather than dropping every row.
      return null
    }
  }

  /**
   * Mirror the file into memory.
   *
   * A row that left the file stops the thing it owned, exactly like `remove`,
   * and a row whose port or command changed while it was running is stopped so
   * the panel cannot report a port that is no longer the one being served.
   */
  function sync() {
    const now = stampOf()
    if (now === stamp) return
    const next = readFileRegistry()
    if (next === null) return
    stamp = now
    const kept = new Map(next.map((entry) => [entry.id, entry]))
    for (const previous of entries) {
      const current = kept.get(previous.id)
      if (!current) {
        // Stop first: shutdown reads the runtime state this row still has.
        shutdown(previous).finally(() => runtime.delete(previous.id)).catch(() => {})
        continue
      }
      const sameShape =
        current.kind === previous.kind &&
        current.dir === previous.dir &&
        current.cmd === previous.cmd &&
        current.port === previous.port
      if (!sameShape) shutdown(previous).catch(() => {})
    }
    entries = next
  }

  function save() {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const tmp = `${REGISTRY_PATH}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, services: entries }, null, 2)}\n`)
      renameSync(tmp, REGISTRY_PATH)
      stamp = stampOf()
    } catch (error) {
      console.warn(`localhost: could not write the registry: ${error?.message ?? error}`)
    }
  }

  entries = readFileRegistry() ?? []
  stamp = stampOf()

  // ---------------------------------------------------------------- ports

  /** A port is usable when nothing else holds it right now. */
  function probe(port) {
    return new Promise((resolveProbe) => {
      const server = createServer()
      server.once('error', () => resolveProbe(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolveProbe(true)))
    })
  }

  async function allocate(exclude = []) {
    const taken = new Set([...entries.map((entry) => entry.port), ...exclude])
    for (let port = PORT_MIN; port <= PORT_MAX; port++) {
      if (taken.has(port)) continue
      if (await probe(port)) return port
    }
    throw new Error(`no free port in ${PORT_MIN}-${PORT_MAX}`)
  }

  // ---------------------------------------------------------------- lifecycle

  function create(definition) {
    const kind = definition.kind === 'static' ? 'static' : 'spawned'
    const dir = resolve(definition.dir)
    if (!existsSync(dir)) throw new Error(`directory does not exist: ${dir}`)
    if (kind === 'spawned' && !definition.cmd) throw new Error('a spawned service needs a start command')
    const entry = {
      id: `svc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: String(definition.name || basename(dir) || 'service').slice(0, 60),
      kind,
      dir,
      cmd: kind === 'spawned' ? String(definition.cmd) : '',
      entry: kind === 'static' ? String(definition.entry || '') : '',
      // What "Open" should hit. A spawned app rarely serves `/`; the registrar
      // knows the real page, and guessing the root is how Open lands on a 404.
      path: normalizePath(definition.path),
      port: 0,
      sessionId: definition.sessionId ? String(definition.sessionId) : '',
      // Stored as a boolean; `register` still knows whether the caller mentioned
      // the field, which is what decides whether an update clears it.
      autoStart: definition.autoStart === true,
      createdAt: Date.now(),
    }
    return entry
  }

  async function register(definition) {
    const entry = create(definition)
    // Re-registering the same thing updates it instead of taking a second port.
    // An agent that forgot `path` has no other way back: stop/remove/re-register
    // would kill a service that is working.
    const already = entries.find(
      (candidate) =>
        candidate.kind === entry.kind &&
        candidate.dir === entry.dir &&
        (entry.kind === 'static' || candidate.cmd === entry.cmd),
    )
    if (already) {
      const merged = {
        ...already,
        name: entry.name || already.name,
        path: entry.path || already.path,
        entry: entry.entry || already.entry,
        sessionId: entry.sessionId || already.sessionId,
        // Omitting the field leaves the opt-in alone; passing it sets it.
        autoStart: definition.autoStart === undefined ? already.autoStart === true : entry.autoStart,
      }
      entries = entries.map((candidate) => (candidate.id === already.id ? merged : candidate))
      save()
      return merged
    }
    entry.port = await allocate()
    entries = [...entries, entry]
    save()
    return entry
  }

  /**
   * The tailnet mirror. Only this half can run a command, and the phone's browser
   * cannot see this machine's `tailscale serve` config at all — so the Host reads
   * it, at most once per REFRESH_MS, and only when a list is asked for.
   */
  const REFRESH_MS = 5000
  let serveMap = new Map()
  let serveMapAt = 0
  let serveRefresh = null

  /** Refresh the port → URL mirror; a concurrent caller shares the in-flight run. */
  async function refreshServeMap() {
    if (Date.now() - serveMapAt < REFRESH_MS) return
    if (serveRefresh !== null) {
      await serveRefresh
      return
    }
    serveRefresh = new Promise((done) => {
      execFile(
        process.env.TAILSCALE_BIN || 'tailscale',
        ['serve', 'status', '--json'],
        { timeout: 2000 },
        (error, stdout) => {
          serveMapAt = Date.now()
          // Absent, stopped, or not logged in: "not published" is the truth, and
          // it must never break the panel.
          serveMap = new Map()
          if (!error) {
            try {
              serveMap = parseServeMap(JSON.parse(stdout))
            } catch {}
          }
          done(undefined)
        },
      )
    })
    const running = serveRefresh
    serveRefresh = null
    await running
  }

  /** The URL a phone can reach this service at, or '' when nothing publishes it. */
  function remoteUrlOf(entry) {
    const published = serveMap.get(entry.port)
    if (!published) return ''
    return `${published.origin}${published.prefix}${entry.path || ''}`
  }

  /**
   * The one field list both `view()` and the tool's output schema use. They
   * drifted in 0.1.2 — `entry` and the runtime fields were returned but not
   * declared, and `additionalProperties: false` turned every `serve list` into a
   * tool error — so the list is now data, and a test compares the two.
   */
  const FIELD_TYPES = {
    id: 'string',
    name: 'string',
    kind: 'string',
    status: 'string',
    port: 'integer',
    url: 'string',
    remoteUrl: 'string',
    path: 'string',
    dir: 'string',
    cmd: 'string',
    entry: 'string',
    sessionId: 'string',
    pid: 'integer',
    startedAt: 'integer',
    exitCode: 'integer',
    error: 'string',
    logLossy: 'boolean',
    autoStart: 'boolean',
    createdAt: 'integer',
  }

  /** Field notes for the model-facing schema; absent is fine. */
  const SERVICE_FIELD_NOTES = {
    id: 'Service id, for start/stop/logs.',
    name: 'Panel label.',
    kind: 'spawned | static.',
    status: 'running | starting | stopped | exited.',
    port: 'Assigned port on 127.0.0.1.',
    url: 'What Open loads on this machine (port + path).',
    remoteUrl: 'The same page over Tailscale, when this port is published there.',
    path: 'URL path Open appends to the port; empty means the root.',
    dir: 'Working directory (spawned) or document root (static).',
    cmd: 'The registered start command; empty for static.',
    entry: 'Static only: the page index.html resolves to.',
    sessionId: 'The session that registered it.',
    pid: 'Process id while running (the Host itself for static).',
    startedAt: 'Epoch ms of the current run.',
    exitCode: 'Last exit code, when the process exited.',
    error: 'Why it is not running, when there is a reason.',
    logLossy: 'True when old output was dropped from the kept tail.',
    autoStart: 'Starts with DSH when true; set it on register.',
    createdAt: 'Epoch ms of registration.',
  }

  /** A URL path, or '' for the root. Absolute, and never able to climb out. */
  function normalizePath(value) {
    const text = String(value ?? '').trim()
    if (text === '' || text === '/') return ''
    if (!text.startsWith('/')) throw new Error('path must start with /')
    if (text.includes('..')) throw new Error('path must not contain ..')
    return text
  }

  function view(entry) {
    const state = runtime.get(entry.id)
    const raw = {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      dir: entry.dir,
      cmd: entry.cmd,
      entry: entry.entry,
      path: entry.path || '',
      port: entry.port,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      status: state?.status ?? 'stopped',
      url: `http://127.0.0.1:${entry.port}${entry.path || '/'}`,
      remoteUrl: remoteUrlOf(entry),
      pid: state?.pid ?? null,
      startedAt: state?.startedAt ?? null,
      exitCode: state?.exitCode ?? null,
      error: state?.error ?? null,
      logLossy: Boolean(state?.logLossy),
      autoStart: entry.autoStart === true,
    }
    // A null cannot satisfy `type: integer`, so absent facts are absent keys.
    const view = {}
    for (const [key, value] of Object.entries(raw)) {
      if (value === null || value === undefined) continue
      view[key] = value
    }
    return view
  }

  function stateOf(id) {
    let state = runtime.get(id)
    if (!state) {
      state = { status: 'stopped', pid: null, startedAt: null, exitCode: null, error: null, log: [], offset: 0, logLossy: false, handle: null, server: null, ready: false }
      runtime.set(id, state)
    }
    return state
  }

  /** Pull whatever the collectors buffered since the last read. */
  function drain(state) {
    const handle = state?.handle
    if (!handle?.collected) return
    for (const stream of ['stdout', 'stderr']) {
      const reader = handle.collected[stream]
      if (!reader) continue
      try {
        const read = reader.readFrom(state.offset)
        if (read?.text) {
          pushLines(state, read.text)
          state.offset = read.nextOffset
          if (read.lossy) state.logLossy = true
        }
      } catch {}
    }
  }

  function pushLines(state, text) {
    if (!text) return
    for (const line of text.split('\n')) {
      if (line === '') continue
      state.log.push(line.length > 400 ? `${line.slice(0, 400)}…` : line)
    }
    if (state.log.length > LOG_LINES) state.log.splice(0, state.log.length - LOG_LINES)
  }

  // ---------------------------------------------------------------- static

  function serveStatic(entry, state) {
    return new Promise((resolveServer, rejectServer) => {
      const root = entry.dir
      const server = createServer((req, res) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          let pathname = decodeURIComponent(url.pathname)
          let target = resolve(root, `.${normalize(pathname)}`)
          // A path that escaped the root is a 404, not a directory listing of /.
          if (target !== root && !target.startsWith(root + sep)) return notFound(res)
          let info = statOrNull(target)
          if (!info) {
            // SPA routing is a *navigation* behaviour: only a request that accepts
            // HTML and names no file falls back to the entry page. Without the
            // Accept check, a missing `/etc/hosts` would read as a route and be
            // answered with index.html instead of 404.
            const navigates = String(req.headers?.accept || '').includes('text/html')
            if (navigates && extname(pathname) === '') {
              target = resolve(root, entry.entry || 'index.html')
              info = statOrNull(target)
            }
            if (!info) return notFound(res)
          }
          if (info.isDirectory()) {
            const index = resolve(target, entry.entry || 'index.html')
            const indexInfo = statOrNull(index)
            if (!indexInfo) return notFound(res)
            target = index
            info = indexInfo
          }
          res.writeHead(200, {
            'content-type': CONTENT_TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
            'content-length': String(info.size),
            'cache-control': 'no-store',
          })
          createReadStream(target).pipe(res)
        } catch {
          notFound(res)
        }
      })
      server.once('error', (error) => {
        state.status = 'exited'
        state.error = error?.code === 'EADDRINUSE' ? `port ${entry.port} is taken` : String(error?.message ?? error)
        rejectServer(error)
      })
      server.listen(entry.port, '127.0.0.1', () => {
        state.server = server
        state.status = 'running'
        state.pid = process.pid
        state.startedAt = Date.now()
        resolveServer()
      })
    })
  }

  function statOrNull(path) {
    try {
      return statSync(path)
    } catch {
      return null
    }
  }

  function notFound(res) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }

  // ---------------------------------------------------------------- spawned

  async function spawnEntry(entry, state) {
    const seam = subprocess()
    if (!seam) throw new Error('the subprocess service is not available in this composition')
    if (!(await probe(entry.port))) throw new Error(`port ${entry.port} is taken`)
    const shell = process.env.SHELL || '/bin/sh'
    const handle = seam.spawn({
      argv: [shell, '-lc', entry.cmd],
      cwd: entry.dir,
      env: { ...process.env, PORT: String(entry.port), LOCALHOST_PORT: String(entry.port), LOCALHOST_NAME: entry.name },
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 1 << 20, spill: { maxBytes: 8 << 20 } },
        stderr: { maxBytes: 1 << 20, spill: { maxBytes: 8 << 20 } },
      },
      graceMs: 3000,
    })
    state.handle = handle
    state.status = 'starting'
    state.startedAt = Date.now()
    state.offset = 0
    state.log = []
    state.logLossy = false
    state.exitCode = null
    state.error = null
    handle.done.then((outcome) => {
      if (state.status === 'stopped') return
      state.status = 'exited'
      state.exitCode = outcome?.exitCode ?? null
      if (state.exitCode !== null && state.exitCode !== 0) state.error = `exited with code ${state.exitCode}`
      state.handle = null
    }).catch(() => {
      state.status = 'exited'
      state.error = 'the process could not be started'
    })
    return entry
  }

  async function start(id) {
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('no such service')
    const state = stateOf(id)
    if (state.status === 'running' || state.status === 'starting') return view(entry)
    try {
      // Unregistering a directory is how a static page disappears; binding its
      // port anyway would answer 404 for a page that reads as registered.
      if (entry.kind === 'static' && !existsSync(entry.dir)) throw new Error(`directory does not exist: ${entry.dir}`)
      if (entry.kind === 'static') await serveStatic(entry, state)
      else await spawnEntry(entry, state)
    } catch (error) {
      // A failed start is a row that says why, not one that silently reads
      // "stopped" again — autoStart in particular has nobody to tell.
      state.status = 'exited'
      state.error = String(error?.message ?? error)
      throw error
    }
    // A failure to bind must not leave the panel claiming a service it never reached.
    save()
    return view(entry)
  }

  /** Release what an entry owns. Never touches `entries` or the file. */
  async function shutdown(entry) {
    const state = runtime.get(entry.id)
    if (!state) return
    state.status = 'stopped'
    state.error = null
    state.startedAt = null
    if (state.server) {
      const server = state.server
      state.server = null
      const closed = new Promise((done) => server.close(() => done(undefined)))
      // A keep-alive socket that is already open would answer one more request
      // after the row reads "stopped"; dropping the idle ones makes the word true.
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
      await closed
    }
    if (state.handle) {
      const handle = state.handle
      state.handle = null
      try {
        handle.terminate()
        await handle.waitForExit()
      } catch {}
    }
  }

  async function stop(id) {
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('no such service')
    await shutdown(entry)
    return view(entry)
  }

  async function remove(id) {
    const entry = entries.find((candidate) => candidate.id === id)
    // Removing twice is the same wish; saying "no such service" for the second
    // click of a confirm button is a worse answer than being done already.
    if (!entry) return { removed: id }
    await shutdown(entry)
    entries = entries.filter((candidate) => candidate.id !== id)
    runtime.delete(id)
    save()
    return { removed: id }
  }

  /** The opt-in behind `autoStart`, editable while the service is running. */
  function setAutoStart(id, on) {
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('no such service')
    entry.autoStart = on === true
    save()
    return view(entry)
  }

  // ---------------------------------------------------------------- the tick

  /**
   * Start the entries the user marked `autoStart`.
   *
   * Runs after the composition is up, not inside `apply`: this plugin does not
   * inject the subprocess service (static entries never need it), so the seam
   * may mount after us. The tick that already reads readiness is the natural
   * place to notice it, and the pass runs exactly once either way.
   *
   * A failure stays on the row — port taken, directory gone, command missing —
   * and is never thrown: a server that did not start must not take the
   * composition down with it.
   */
  let booted = false
  async function boot() {
    if (booted) return
    const wanted = entries.filter((entry) => entry.autoStart)
    if (wanted.length === 0) {
      booted = true
      return
    }
    if (wanted.some((entry) => entry.kind === 'spawned') && !subprocess()) return
    booted = true
    for (const entry of wanted) {
      try {
        await start(entry.id)
      } catch {}
    }
  }

  let ticking = null
  function tick() {
    void boot()
    for (const entry of entries) {
      const state = runtime.get(entry.id)
      if (!state) continue
      drain(state)
      if (state.status === 'starting' && entry.port) {
        // Readiness is the port accepting, not the spawn returning.
        probe(entry.port).then((free) => {
          if (!free && state.status === 'starting') state.status = 'running'
        }).catch(() => {})
      }
    }
  }

  ctx.effect(() => {
    ticking = setInterval(tick, TICK_MS)
    if (typeof ticking.unref === 'function') ticking.unref()
    return () => clearInterval(ticking)
  }, 'localhost: readiness and log tail')

  ctx.effect(() => () => {
    // Disposal runs on every composition boundary: stop what we started, and
    // let ctx.subprocess do the same for anything still reaped late.
    for (const entry of entries) {
      const state = runtime.get(entry.id)
      if (!state) continue
      try {
        state.server?.close()
      } catch {}
      try {
        state.handle?.terminate()
      } catch {}
    }
  }, 'localhost: stop on teardown')

  // ---------------------------------------------------------------- routes

  function admitted(req) {
    const connection = ctx.get('connection') ?? ctx.connection
    if (typeof connection?.admit === 'function') {
      let admission
      try {
        admission = connection.admit(req)
      } catch {
        return 503
      }
      if (admission !== null && typeof admission === 'object' && typeof admission.then === 'function') return 503
      if (admission === undefined || admission === null || typeof admission !== 'object') return 503
      if (!('rejection' in admission)) return null
      return typeof admission.rejection === 'number' ? admission.rejection : 403
    }
    return 503
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(body)),
    })
    res.end(body)
  }

  function reject(res, status) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'unavailable')
  }

  function readBody(req) {
    return new Promise((resolveBody, rejectBody) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          rejectBody(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolveBody({})
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          rejectBody(new Error('invalid json'))
        }
      })
      req.on('error', rejectBody)
    })
  }

  function route(name, handler, method) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path: `${ROUTE}.${name}`,
          handler: async (req, res) => {
            const rejection = admitted(req)
            if (rejection !== null) return reject(res, rejection)
            // The file may have changed under us (an editor, another process);
            // every route reads the registry as it is now, not as it was at
            // mount time.
            sync()
            if (method && req.method !== method) return sendJson(res, 405, { error: 'method-not-allowed' })
            try {
              await handler(req, res)
            } catch (error) {
              sendJson(res, 400, { error: String(error?.message ?? error) })
            }
          },
        }),
      `localhost: ${name} route`,
    )
  }

  route('list', async (req, res) => {
    await refreshServeMap()
    sendJson(res, 200, { services: entries.map(view), portRange: [PORT_MIN, PORT_MAX] })
  }, 'GET')

  route('create', async (req, res) => {
    const body = await readBody(req)
    const entry = await register({
      name: body.name,
      kind: body.kind,
      dir: body.dir,
      cmd: body.cmd,
      entry: body.entry,
      path: body.path,
      sessionId: body.sessionId,
      autoStart: body.autoStart,
    })
    if (body.start) await start(entry.id)
    sendJson(res, 200, { service: view(entry) })
  }, 'POST')

  route('start', async (req, res) => {
    const body = await readBody(req)
    sendJson(res, 200, { service: await start(String(body.id)) })
  }, 'POST')

  route('stop', async (req, res) => {
    const body = await readBody(req)
    sendJson(res, 200, { service: await stop(String(body.id)) })
  }, 'POST')

  route('remove', async (req, res) => {
    const body = await readBody(req)
    sendJson(res, 200, await remove(String(body.id)))
  }, 'POST')

  route('autostart', async (req, res) => {
    const body = await readBody(req)
    sendJson(res, 200, { service: setAutoStart(String(body.id), body.autoStart === true) })
  }, 'POST')

  route('logs', async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const id = String(url.searchParams.get('id') || '')
    const state = runtime.get(id)
    drain(state)
    sendJson(res, 200, {
      lines: state?.log ?? [],
      lossy: Boolean(state?.logLossy),
      status: state?.status ?? 'stopped',
    })
  }, 'GET')

  route('reveal', async (req, res) => {
    const body = await readBody(req)
    const entry = entries.find((candidate) => candidate.id === String(body.id))
    if (!entry) throw new Error('no such service')
    const target = String(body.target || 'dir')
    const path = target === 'file' ? resolve(entry.dir, entry.entry || 'index.html') : entry.dir
    if (target !== 'url' && !existsSync(path)) throw new Error(`not found: ${path}`)
    await open(target === 'url' ? view(entry).url : path, target === 'file' ? ['-R'] : [])
    sendJson(res, 200, { opened: target === 'url' ? view(entry).url : path })
  }, 'POST')

  ctx.effect(() => () => {
    for (const entry of entries) {
      const state = runtime.get(entry.id)
      try {
        state?.server?.close()
      } catch {}
    }
  }, 'localhost: close static servers')

  /** One-shot OS handoff; not a managed process, so it stays out of the registry. */
  function open(target, flags = []) {
    return new Promise((done, fail) => {
      const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
      const child = spawnOneShot(command, [...flags, target], { stdio: 'ignore', detached: true })
      child.once('error', (error) => fail(new Error(`could not open: ${error.message}`)))
      child.once('spawn', () => {
        child.unref()
        done(undefined)
      })
    })
  }

  // ---------------------------------------------------------------- the tool

  const tool = tools()
  if (tool) {
    ctx.effect(
      () =>
        tool.register({
          name: 'serve',
          // The model-facing payload is a budget, not prose: this tool sits in
          // every agent's list on every request, so it says what it does, what
          // the port rules are, and stops. docs/plan.md §12 records the numbers.
          description:
            'Register, start, stop, remove or read a local server or static page instead of using bash. Ports are assigned here (use $PORT in cmd) and services stop with DSH. Open loads url, the port plus path.',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ['list', 'register', 'start', 'stop', 'remove', 'logs'],
              },
              id: { type: 'string', description: 'Service id, for start/stop/remove/logs.' },
              dir: { type: 'string', description: 'Absolute directory: served, or the command cwd.' },
              cmd: { type: 'string', description: 'Start command for a spawned service; use $PORT.' },
              path: { type: 'string', description: 'URL path Open loads, e.g. /app/index.html.' },
              name: { type: 'string', description: 'Panel label; defaults to the directory name.' },
              kind: { type: 'string', enum: ['spawned', 'static'] },
              start: { type: 'boolean', description: 'register: start it now (default true).' },
              autoStart: { type: 'boolean', description: 'register: start it when DSH launches (default false).' },
            },
            required: ['action'],
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                services: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      ...Object.fromEntries(
                        Object.entries(FIELD_TYPES).map(([name, type]) => [
                          name,
                          { type, description: SERVICE_FIELD_NOTES[name] },
                        ]),
                      ),
                      log: { type: 'array', items: { type: 'string' }, description: 'Recent output (logs action only).' },
                    },
                    required: ['id', 'name', 'kind', 'status', 'port', 'url', 'dir'],
                  },
                },
              },
              required: ['services'],
            },
            render: (args, value) => {
              const rows = (value?.services ?? []).map((service) => {
                const detail = service.kind === 'static' ? service.dir : service.cmd || ''
                return `${service.status === 'running' ? '●' : '○'} ${service.name}  ${service.url}  ${detail}`
              })
              if (rows.length > 0) return [{ type: 'text', text: rows.join('\n') }]
              // An empty list means two different things, and the agent has to be
              // able to tell which one it just did.
              return [{ type: 'text', text: args?.action === 'remove' ? `removed ${args.id}` : 'no services registered' }]
            },
          },
          async execute(args, exec) {
            sync()
            const action = String(args?.action || 'list')
            if (action === 'list') {
              await refreshServeMap()
              return { services: entries.map((entry) => ({ ...view(entry) })) }
            }
            if (action === 'register') {
              const dir = await resolveDir(args, exec)
              const entry = await register({
                name: args.name,
                kind: args.kind,
                dir,
                cmd: args.cmd,
                entry: args.entry,
                path: args.path,
                sessionId: sessionIdOf(args, exec),
                autoStart: args.autoStart,
              })
              if (args.start !== false) await start(entry.id)
              return { services: [view(entry)] }
            }
            if (action === 'remove') {
              await remove(String(args.id))
              return { services: [] }
            }
            if (action === 'start') {
              await start(String(args.id))
              return { services: [view(entries.find((entry) => entry.id === String(args.id)))] }
            }
            if (action === 'stop') {
              await stop(String(args.id))
              return { services: [view(entries.find((entry) => entry.id === String(args.id)))] }
            }
            if (action === 'logs') {
              const state = runtime.get(String(args.id))
              drain(state)
              return { services: [{ ...view(entries.find((entry) => entry.id === String(args.id)) ?? {}), log: state?.log ?? [] }] }
            }
            throw new Error(`unknown action: ${action}`)
          },
        }),
      'localhost: serve tool',
    )
  }

  // The registry was read at the top of `apply`; the entries that asked for it
  // start now. If the subprocess seam is not mounted yet, the tick retries.
  void boot()

  /** Prefer the calling session's directory; a tool call without one must say where. */
  async function resolveDir(args, exec) {
    if (args?.dir) return String(args.dir)
    const sessionId = exec?.agent?.id
    const sessions = ctx.get('sessions')
    const workingDirectory = ctx.get('workingDirectory')
    const session = sessionId && typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
    const dir = session && workingDirectory ? workingDirectory.get(session) : undefined
    if (dir) return dir
    throw new Error('dir is required when the calling session has no directory')
  }

  /** ToolRunContext carries the calling agent; the registry records who asked. */
  function sessionIdOf(args, exec) {
    return String(args?.sessionId || exec?.agent?.id || '')
  }
}
