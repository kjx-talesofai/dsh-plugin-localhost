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
 * nothing starts automatically — a restart shows everything stopped.
 *
 * @module dsh-plugin-localhost
 */

import { spawn as spawnOneShot } from 'node:child_process'
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

/** Hard dependencies: the routes and the admit fence. Everything else is optional. */
export const inject = ['webServer', 'connection']

/**
 * Mount the registry, the routes, and the agent-facing tool.
 *
 * @param ctx - host context carrying `webServer` and `connection`.
 */
export function apply(ctx) {
  /** @type {Array<object>} persisted definitions, in panel order */
  let entries = load()
  /** @type {Map<string, object>} runtime state, never persisted */
  const runtime = new Map()

  const subprocess = () => ctx.get('subprocess')
  const tools = () => ctx.get('tools')

  // ---------------------------------------------------------------- persistence

  function load() {
    try {
      const parsed = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
      if (!Array.isArray(parsed?.services)) return []
      return parsed.services.filter((entry) => entry && typeof entry.id === 'string' && typeof entry.dir === 'string')
    } catch {
      return []
    }
  }

  function save() {
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      const tmp = `${REGISTRY_PATH}.tmp`
      writeFileSync(tmp, `${JSON.stringify({ version: 1, services: entries }, null, 2)}\n`)
      renameSync(tmp, REGISTRY_PATH)
    } catch (error) {
      console.warn(`localhost: could not write the registry: ${error?.message ?? error}`)
    }
  }

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
      port: 0,
      sessionId: definition.sessionId ? String(definition.sessionId) : '',
      createdAt: Date.now(),
    }
    return entry
  }

  async function register(definition) {
    const entry = create(definition)
    entry.port = await allocate()
    entries = [...entries, entry]
    save()
    return entry
  }

  function view(entry) {
    const state = runtime.get(entry.id)
    return {
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      dir: entry.dir,
      cmd: entry.cmd,
      entry: entry.entry,
      port: entry.port,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      status: state?.status ?? 'stopped',
      url: `http://127.0.0.1:${entry.port}/`,
      pid: state?.pid ?? null,
      startedAt: state?.startedAt ?? null,
      exitCode: state?.exitCode ?? null,
      error: state?.error ?? null,
      logLossy: Boolean(state?.logLossy),
    }
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
    if (entry.kind === 'static') await serveStatic(entry, state)
    else await spawnEntry(entry, state)
    // A failure to bind must not leave the panel claiming a service it never reached.
    save()
    return view(entry)
  }

  async function stop(id) {
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new Error('no such service')
    const state = stateOf(id)
    state.status = 'stopped'
    state.error = null
    state.startedAt = null
    if (state.server) {
      await new Promise((done) => state.server.close(() => done(undefined)))
      state.server = null
    }
    if (state.handle) {
      const handle = state.handle
      state.handle = null
      try {
        handle.terminate()
        await handle.waitForExit()
      } catch {}
    }
    return view(entry)
  }

  async function remove(id) {
    await stop(id)
    entries = entries.filter((entry) => entry.id !== id)
    runtime.delete(id)
    save()
    return { removed: id }
  }

  // ---------------------------------------------------------------- the tick

  let ticking = null
  function tick() {
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
      sessionId: body.sessionId,
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
          description:
            'Register, start, stop and read the local servers and static pages an agent started. Use this INSTEAD of starting a dev server with bash: it assigns the port, records the directory and the session, and the panel can stop it. A server started with bash is invisible to the panel and survives the session.',
          // `ctx.tools.register` takes a finished ToolDefinition, so `parameters`
          // and `output.schema` are real JSON Schema — not the parameter-spec
          // dialect `defineTool()` accepts. A per-property `required: true` is the
          // spec dialect and `assertSupportedJsonSchema` rejects it, which is what
          // took the whole fiber down (and the routes with it) in 0.1.1.
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ['list', 'register', 'start', 'stop', 'logs'],
                description: 'What to do.',
              },
              id: { type: 'string', description: 'Service id (needed by start/stop/logs).' },
              name: { type: 'string', description: 'Short name shown in the panel (register).' },
              kind: {
                type: 'string',
                enum: ['spawned', 'static'],
                description: 'spawned = a command this Host starts and stops; static = a directory served as-is.',
              },
              dir: {
                type: 'string',
                description: 'Absolute directory: the working directory of the command, or the root of the static page.',
              },
              cmd: {
                type: 'string',
                description: 'Start command for a spawned service. Use $PORT (or $LOCALHOST_PORT) instead of a literal port — this tool assigns one.',
              },
              entry: {
                type: 'string',
                description: 'Static only: the page to open, relative to dir (default index.html).',
              },
              start: { type: 'boolean', description: 'register: also start it now (default true).' },
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
                      id: { type: 'string' },
                      name: { type: 'string' },
                      kind: { type: 'string' },
                      status: { type: 'string' },
                      port: { type: 'integer' },
                      url: { type: 'string' },
                      dir: { type: 'string' },
                      cmd: { type: 'string' },
                      sessionId: { type: 'string' },
                      error: { type: 'string' },
                      log: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'name', 'kind', 'status', 'port', 'url', 'dir'],
                  },
                },
              },
              required: ['services'],
            },
            render: (_args, value) => {
              const rows = (value?.services ?? []).map((service) => {
                const detail = service.kind === 'static' ? service.dir : service.cmd || ''
                return `${service.status === 'running' ? '●' : '○'} ${service.name}  ${service.url}  ${detail}`
              })
              return [{ type: 'text', text: rows.length > 0 ? rows.join('\n') : 'no services registered' }]
            },
          },
          async execute(args) {
            const action = String(args?.action || 'list')
            if (action === 'list') {
              return { services: entries.map((entry) => ({ ...view(entry) })) }
            }
            if (action === 'register') {
              const dir = await resolveDir(args, ctx)
              const entry = await register({
                name: args.name,
                kind: args.kind,
                dir,
                cmd: args.cmd,
                entry: args.entry,
                sessionId: sessionIdOf(args, ctx),
              })
              if (args.start !== false) await start(entry.id)
              return { services: [view(entry)] }
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

  /** Prefer the calling session's directory; a tool call without one must say where. */
  async function resolveDir(args, context) {
    if (args?.dir) return String(args.dir)
    const agent = context.__agent
    const sessions = ctx.get('sessions')
    const workingDirectory = ctx.get('workingDirectory')
    const session = agent && typeof sessions?.get === 'function' ? sessions.get(agent.id) : undefined
    const dir = session && workingDirectory ? workingDirectory.get(session) : undefined
    if (dir) return dir
    throw new Error('dir is required when the calling session has no directory')
  }

  function sessionIdOf(args, context) {
    return String(args?.sessionId || context.__agent?.id || '')
  }
}
