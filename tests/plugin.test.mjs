/**
 * Localhost — the suite.
 *
 * Two halves, tested two different ways because they fail in two different ways:
 *
 *   The **Host** half has no runtime dependencies, so the suite imports it for
 *   real and drives it through a fake context. The static server is exercised
 *   over a real socket; the spawned path goes through a fake `ctx.subprocess`,
 *   so the spawn spec — argv, cwd, PORT, termination — is asserted rather than
 *   inferred.
 *
 *   The **Client** half is evaluated as a script in `node:vm`, exactly as the
 *   page loads it, and its panel is rendered through a small hooks runtime. That
 *   keeps the artifact honest: if the bundle stops being a script-executable
 *   module-loader bundle, this fails.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

// The registry path is resolved at import time, so the sandbox home comes first.
const home = mkdtempSync(join(tmpdir(), 'dsh-localhost-'))
process.env.DSH_HOME = home

const host = await import('../index.js')
const CLIENT_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js'), 'utf8')

/** A response recorder that answers the assertions a route test needs. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      return this
    },
    end(chunk) {
      if (chunk !== undefined) this.body += chunk
      this.writableEnded = true
    },
  }
}

/** A request shaped like the IncomingMessage the routes see, with an optional JSON body. */
function fakeReq(url, { method = 'GET', body } = {}) {
  const listeners = new Map()
  const req = {
    url,
    method,
    on(event, listener) {
      listeners.set(event, listener)
      return req
    },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
    listeners.get('end')?.()
  })
  return req
}

/** A subprocess service that records what it was asked to start. */
function makeSubprocess() {
  const spawned = []
  return {
    spawned,
    spawn(spec) {
      const chunks = []
      const record = { spec, terminated: false, finish: null }
      spawned.push(record)
      record.emit = (text) => chunks.push(text)
      return {
        collected: {
          stdout: {
            readFrom(offset) {
              const text = chunks.join('')
              return { text: text.slice(offset), nextOffset: text.length, lossy: false }
            },
          },
        },
        done: new Promise((resolve) => {
          record.finish = resolve
        }),
        terminate() {
          record.terminated = true
          record.finish({ exitCode: 0, signal: null })
        },
        waitForExit: async () => true,
      }
    },
  }
}

/** Every harness is disposed after its test, so a failed assertion cannot leave a server open. */
const openHarnesses = []
afterEach(() => {
  while (openHarnesses.length > 0) openHarnesses.pop().dispose()
})

function makeCtx({ subprocess } = {}) {
  const routes = new Map()
  const cleanups = []
  const tools = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
      getOrigin: () => 'http://127.0.0.1:3080',
    },
    connection: { admit: () => ({ peer: 'loopback' }) },
    get(name) {
      if (name === 'subprocess') return subprocess
      if (name === 'tools') {
        return {
          register(definition) {
            tools.push(definition)
            return () => {}
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
  }
  let disposed = false
  const harness = {
    ctx,
    routes,
    tools,
    subprocess,
    call: async (name, options) => {
      const route = routes.get(`/api/localhost.${name}`)
      assert.ok(route, `route /api/localhost.${name} was not registered`)
      const res = fakeRes()
      await route.handler(fakeReq(`/api/localhost.${name}${options?.query ?? ''}`, options), res)
      return res
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const cleanup of cleanups) cleanup()
    },
  }
  openHarnesses.push(harness)
  return harness
}

const readJson = (res) => JSON.parse(res.body)
const create = (harness, body) => harness.call('create', { method: 'POST', body }).then(readJson)
const listIds = (harness) => harness.call('list').then((res) => readJson(res).services.map((service) => service.id))

describe('bundle: patch shape', () => {
  // A bare top-level row is a *patch* against an existing entry. For an id that
  // does not exist yet it inserts nothing: the profile records an override and
  // the plugin silently never mounts. That is exactly how 0.1.0 shipped.
  it('inserts the row instead of patching a row that does not exist', () => {
    const patch = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'cordis.patch.yml'), 'utf8')
    assert.match(patch, /^- insert:/m, "the bundle layer must use `insert:`")
    assert.match(patch, /^ {4}- id: localhost$/m, 'the row id is the one the client and the registry use')
    assert.match(patch, /^ {6}name: 'dsh-plugin-localhost'$/m, 'the row name is the package name')
    const rowCount = patch.split('\n').filter((line) => /^- id:/.test(line)).length
    assert.equal(rowCount, 0, 'a bare top-level row would be an override, not an insert')
  })

  it('keeps the package name the loader resolves equal to the row name', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'))
    assert.equal(pkg.name, 'dsh-plugin-localhost')
    assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
    assert.equal(pkg.dsh.client.platform, 'web', 'the browser half needs a platform to be served')
  })
})

describe('host: registration', () => {
  it('mounts the tool and every route the panel uses', () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    assert.equal(harness.tools.length, 1, 'exactly one agent-facing tool')
    assert.equal(harness.tools[0].name, 'serve', 'the tool is named for the verb the agent says')
    for (const name of ['list', 'create', 'start', 'stop', 'remove', 'logs', 'reveal']) {
      assert.ok(harness.routes.has(`/api/localhost.${name}`), `missing route: ${name}`)
    }
    harness.dispose()
  })

  it('answers with the port range the panel shows', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const body = readJson(await harness.call('list'))
    assert.deepEqual(body.portRange, [8840, 8899])
    assert.ok(Array.isArray(body.services))
    harness.dispose()
  })

  it('rejects a directory that does not exist instead of registering a dead entry', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const res = await harness.call('create', {
      method: 'POST',
      body: { kind: 'static', dir: '/definitely/not/here', start: false },
    })
    assert.equal(res.statusCode, 400)
    assert.match(readJson(res).error, /does not exist/)
    harness.dispose()
  })

  it('refuses a spawned entry without a command', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const res = await harness.call('create', {
      method: 'POST',
      body: { kind: 'spawned', dir: home, start: false },
    })
    assert.equal(res.statusCode, 400)
    assert.match(readJson(res).error, /start command/)
    harness.dispose()
  })

  it('assigns a port in range and never reuses one', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const first = (await create(harness, { kind: 'spawned', dir: home, cmd: 'sleep 1', start: false })).service
    const second = (await create(harness, { kind: 'spawned', dir: home, cmd: 'sleep 1', start: false })).service
    assert.ok(first.port >= 8840 && first.port <= 8899)
    assert.notEqual(first.port, second.port, 'two services cannot share a port')
    harness.dispose()
  })

  it('refuses a method the route does not serve', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const res = await harness.call('list', { method: 'POST' })
    assert.equal(res.statusCode, 405)
    harness.dispose()
  })
})

describe('host: static', () => {
  it('serves a directory on 127.0.0.1 with an SPA fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-static-'))
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>hi</title><p>hello</p>')
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')

    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'static', dir: root, start: true })).service
    assert.equal(created.status, 'running')

    const page = await fetch(`http://127.0.0.1:${created.port}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /hello/)

    const asset = await fetch(`http://127.0.0.1:${created.port}/assets/app.js`)
    assert.equal(asset.headers.get('content-type'), 'text/javascript; charset=utf-8')

    // A browser navigation (Accept: text/html) falls back to the entry page; a
    // non-navigation fetch does not, which is what keeps the next assertion honest.
    const routed = await fetch(`http://127.0.0.1:${created.port}/some/deep/route`, { headers: { accept: 'text/html' } })
    assert.equal(routed.status, 200, 'an extensionless unknown path is the entry page')

    const escape = await fetch(`http://127.0.0.1:${created.port}/..%2f..%2f..%2fetc%2fhosts`)
    assert.equal(escape.status, 404, 'a path that climbs out of the root is refused')

    const stopped = readJson(await harness.call('stop', { method: 'POST', body: { id: created.id } })).service
    assert.equal(stopped.status, 'stopped')
    await assert.rejects(fetch(`http://127.0.0.1:${created.port}/`), 'the port is released on stop')
    harness.dispose()
  })
})

describe('host: spawned', () => {
  it('spawns through the subprocess seam with PORT in the environment', async () => {
    const subprocess = makeSubprocess()
    const harness = makeCtx({ subprocess })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', name: 'dev', dir: home, cmd: 'pnpm dev --port $PORT', start: true })).service

    const spec = subprocess.spawned[0].spec
    assert.equal(spec.argv.length, 3, 'a shell runs the registered command line')
    assert.equal(spec.argv[2], 'pnpm dev --port $PORT')
    assert.equal(spec.cwd, home)
    assert.equal(spec.env.PORT, String(created.port))
    assert.equal(spec.env.LOCALHOST_PORT, String(created.port))
    assert.equal(spec.stdio.stdin, 'ignore')
    assert.ok(spec.stdio.stdout.maxBytes > 0, 'output is collected, not inherited')
    harness.dispose()
  })

  it('reads the log tail for the tool', async () => {
    const subprocess = makeSubprocess()
    const harness = makeCtx({ subprocess })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', start: true })).service

    subprocess.spawned[0].emit('ready on 8840\nwatching for changes\n')
    const result = await harness.tools[0].execute({ action: 'logs', id: created.id }, {})
    assert.deepEqual(result.services[0].log, ['ready on 8840', 'watching for changes'])
    harness.dispose()
  })

  it('stops by terminating the managed process', async () => {
    const subprocess = makeSubprocess()
    const harness = makeCtx({ subprocess })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', start: true })).service
    const stopped = readJson(await harness.call('stop', { method: 'POST', body: { id: created.id } })).service
    assert.equal(stopped.status, 'stopped')
    assert.equal(subprocess.spawned[0].terminated, true)
    harness.dispose()
  })

  it('refuses to start when someone else owns the assigned port', async () => {
    const subprocess = makeSubprocess()
    const harness = makeCtx({ subprocess })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', start: false })).service

    const blocker = createServer((_req, res) => res.end('other'))
    await new Promise((done) => blocker.listen(created.port, '127.0.0.1', done))
    try {
      const res = await harness.call('start', { method: 'POST', body: { id: created.id } })
      assert.equal(res.statusCode, 400)
      assert.match(readJson(res).error, /taken/)
      assert.equal(subprocess.spawned.length, 0, 'nothing is spawned onto a port we do not own')
    } finally {
      await new Promise((done) => blocker.close(done))
      harness.dispose()
    }
  })
})

describe('host: registry', () => {
  it('persists definitions and reloads them as stopped', async () => {
    const first = makeCtx({ subprocess: makeSubprocess() })
    host.apply(first.ctx)
    const created = (await create(first, { kind: 'spawned', name: 'persisted', dir: home, cmd: 'sleep 1', start: false })).service
    first.dispose()

    const second = makeCtx({ subprocess: makeSubprocess() })
    host.apply(second.ctx)
    const reloaded = readJson(await second.call('list')).services.find((service) => service.id === created.id)
    assert.ok(reloaded, 'the definition survived')
    assert.equal(reloaded.status, 'stopped', 'runtime state never survives')
    assert.equal(reloaded.port, created.port)
    assert.equal(reloaded.name, 'persisted')
    second.dispose()
  })

  it('removes an entry and its definition', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'sleep 1', start: false })).service
    await harness.call('remove', { method: 'POST', body: { id: created.id } })
    assert.equal((await listIds(harness)).includes(created.id), false)
    harness.dispose()
  })
})

describe('host: tool', () => {
  it('registers through the tool and returns the assigned port', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const result = await harness.tools[0].execute({ action: 'register', kind: 'static', dir: home, name: 'page', start: false }, {})
    assert.equal(result.services.length, 1)
    assert.equal(result.services[0].name, 'page')
    assert.match(result.services[0].url, /^http:\/\/127\.0\.0\.1:88\d\d\/$/)
    harness.dispose()
  })

  it('lists and stops by id', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const tool = harness.tools[0]
    const registered = await tool.execute({ action: 'register', kind: 'spawned', dir: home, cmd: 'serve' }, {})
    const id = registered.services[0].id
    const listed = await tool.execute({ action: 'list' }, {})
    assert.equal(listed.services.some((service) => service.id === id), true)
    const stopped = await tool.execute({ action: 'stop', id }, {})
    assert.equal(stopped.services[0].status, 'stopped')
    harness.dispose()
  })

  it('renders one line per service', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const tool = harness.tools[0]
    await tool.execute({ action: 'register', kind: 'spawned', dir: home, cmd: 'serve', name: 'dev' }, {})
    const value = await tool.execute({ action: 'list' }, {})
    const blocks = tool.output.render({}, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /dev/)
    assert.match(blocks[0].text, /127\.0\.0\.1:88/)
    harness.dispose()
  })
})

describe('host: tool definition', () => {
  // `ctx.tools.register` takes a finished ToolDefinition: `parameters` and
  // `output.schema` are real JSON Schema. The parameter-*spec* dialect (a boolean
  // `required` inside a property) belongs to `defineTool()`, and 0.1.1 passed it
  // straight to the registry — `assertSupportedJsonSchema` threw, the fiber rolled
  // back, and the routes went with it. That is the 404 the panel showed.
  const SUPPORTED = new Set(['type', 'properties', 'required', 'items', 'enum', 'description', 'additionalProperties', 'oneOf', 'title', 'default', 'examples', 'const'])

  function walk(node, path, fail) {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      if (!SUPPORTED.has(key)) fail(`${path}.${key} is not a supported keyword`)
      if (key === 'required' && !Array.isArray(value)) fail(`${path}.required must be an array, not ${typeof value}`)
    }
    const properties = node.properties ?? {}
    for (const [name, child] of Object.entries(properties)) walk(child, `${path}.properties.${name}`, fail)
    if (node.items) walk(node.items, `${path}.items`, fail)
  }

  it('declares JSON Schema, not the parameter-spec dialect', () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const tool = harness.tools[0]
    const failures = []
    assert.equal(tool.parameters.type, 'object')
    assert.deepEqual(tool.parameters.required, ['action'], 'the object-level required list names action')
    walk(tool.parameters, 'parameters', (message) => failures.push(message))
    walk(tool.output.schema, 'output', (message) => failures.push(message))
    assert.deepEqual(failures, [])
    harness.dispose()
  })
})

// ---------------------------------------------------------------------------
// client half

/** Minimal hooks runtime; component order is the only contract it needs. */
function createHooks() {
  const slots = []
  let index = 0
  let effects = []
  return {
    effects: () => effects,
    clearEffects: () => {
      effects = []
    },
    reset: () => {
      index = 0
    },
    useState(initial) {
      const slot = slots[index] ?? (slots[index] = { value: initial })
      index++
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
        },
      ]
    },
    useRef(initial) {
      const slot = slots[index] ?? (slots[index] = { current: initial })
      index++
      return slot
    },
    useMemo(fn) {
      index++
      return fn()
    },
    useCallback(fn) {
      index++
      return fn
    },
    useEffect(fn) {
      index++
      effects.push(fn)
    },
  }
}

/** Load the bundle the way the page does: a script defining one module. */
function loadClient() {
  const hooks = createHooks()
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (...args) => hooks.useState(...args),
    useRef: (...args) => hooks.useRef(...args),
    useMemo: (...args) => hooks.useMemo(...args),
    useCallback: (...args) => hooks.useCallback(...args),
    useEffect: (...args) => hooks.useEffect(...args),
  }
  let loaded = null
  const context = createContext({
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          loaded = { id, exports: factory(() => React) }
        },
      },
    },
    fetch: (...args) => globalThis.fetch(...args),
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  })
  runInContext(CLIENT_SOURCE, context, { filename: 'client.js' })
  return { loaded, hooks, React }
}

/** Flatten a tree into text, so an assertion reads like the screen. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join('')
}

/** Find the first button whose label matches, so a click test clicks the real control. */
function findButton(node, label) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
    return null
  }
  if (typeof node.type === 'function') return findButton(node.type(node.props), label)
  if (node.type === 'button' && textOf(node).trim() === label) return node
  for (const child of node.children ?? []) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

/** Mount the panel the sidebar would mount, with a fetch stub behind it. */
async function mountPanel(services, onFetch) {
  const { loaded, hooks } = loadClient()
  const registered = []
  const ctx = {
    locale: makeLocale(),
    effect: (fn) => fn(),
    get: () => undefined,
    slots: {
      inject: (_name, run) => run(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  loaded.exports.apply(ctx)

  const main = registered.find((entry) => entry.options.name === 'main')
  const element = main.component({})
  const Panel = element.type

  globalThis.fetch = async (url, init) => {
    onFetch?.(url, init)
    return { ok: true, status: 200, json: async () => ({ services, portRange: [8840, 8899] }) }
  }

  // First render, then the effects the panel queued (its list fetch).
  hooks.reset()
  hooks.clearEffects()
  Panel(element.props)
  for (const effect of hooks.effects()) effect()
  await new Promise((done) => setTimeout(done, 0))

  // Second render reads the state that fetch landed in.
  hooks.reset()
  const tree = Panel(element.props)

  /** Re-render after a click, running only the effects this pass queued. */
  const render = () => {
    hooks.reset()
    hooks.clearEffects()
    const next = Panel(element.props)
    for (const effect of hooks.effects()) effect()
    return next
  }

  return { tree, render, registered }
}

/** The dictionary the bundle registers, so a rendered label reads as the user sees it. */
function makeLocale() {
  const dicts = new Map()
  return {
    register: (ns, byLanguage) => {
      dicts.set(ns, byLanguage.zh)
      return () => {}
    },
    bind: (ns) => (key, params) => {
      let out = dicts.get(ns)?.[key] ?? key
      for (const [name, value] of Object.entries(params ?? {})) {
        out = out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
      }
      return out
    },
  }
}

describe('client: styles', () => {
  // The cream theme derives `label-dimmed` as 12.5% ink on the canvas — roughly
  // 1.2:1. It is a placeholder/hairline token, not text. 0.1.1 used it for the
  // subtitle, footer and empty state, which read as invisible.
  it('never paints readable text with the placeholder token', () => {
    const css = CLIENT_SOURCE.slice(CLIENT_SOURCE.indexOf('const CSS ='))
    assert.equal(/label-dimmed/.test(css), false, 'use label-tertiary / label-secondary for text instead')
    assert.match(css, /label-tertiary/, 'secondary metadata uses the readable tertiary token')
    assert.match(css, /label-secondary/, 'body copy uses the secondary text token')
  })
})

describe('client: bundle', () => {
  it('loads as a script and exports apply with its inject list', () => {
    const { loaded } = loadClient()
    assert.equal(loaded.id, 'dsh-plugin-localhost')
    assert.equal(typeof loaded.exports.apply, 'function')
    assert.equal(Array.from(loaded.exports.inject).join(','), 'slots,locale')
  })

  it('seats the nav row between Tailscale and Automation tasks', () => {
    const { loaded } = loadClient()
    const registered = []
    const ctx = {
      locale: makeLocale(),
      effect: (fn) => fn(),
      get: () => undefined,
      slots: { inject: (_name, run) => run(), register: (options) => registered.push(options) },
    }
    loaded.exports.apply(ctx)
    const nav = registered.find((options) => options.name === 'sidebar.panellist')
    const main = registered.find((options) => options.name === 'main')
    assert.ok(nav && main)
    assert.equal(nav.id, 'localhost')
    assert.equal(nav.order, 7, 'between Tailscale Remote Access (5) and Automation tasks (10)')
    assert.equal(main.key, 'localhost', 'the panel key matches the nav id')
  })
})

describe('client: panel', () => {
  const savedFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = savedFetch
  })

  it('renders the empty state naming the verb the agent should use', async () => {
    const { tree } = await mountPanel([])
    const text = textOf(tree)
    assert.match(text, /还没有登记任何东西/)
    assert.match(text, /serve/, 'the empty state teaches the tool name')
  })

  it('renders a row with its port, kind and status', async () => {
    const { tree } = await mountPanel([
      { id: 'svc-1', name: 'preview', kind: 'static', dir: '/tmp/x', entry: 'index.html', port: 8842, status: 'stopped', url: 'http://127.0.0.1:8842/', sessionId: '' },
    ])
    const text = textOf(tree)
    assert.match(text, /preview/)
    assert.match(text, /:8842/)
    assert.match(text, /静态/)
    assert.match(text, /已停止/)
    assert.match(text, /0 个在跑 \/ 共 1 个/, 'the count line reads like the screen')
  })

  it('posts to the start route when Start is pressed', async () => {
    const calls = []
    const { tree } = await mountPanel(
      [{ id: 'svc-2', name: 'dev', kind: 'spawned', dir: '/tmp/x', cmd: 'serve', port: 8843, status: 'stopped', url: 'http://127.0.0.1:8843/', sessionId: '' }],
      (url, init) => calls.push({ url, init }),
    )
    const start = findButton(tree, '启动')
    assert.ok(start, 'the stopped row offers Start')
    await start.props.onClick()
    assert.ok(
      calls.some((call) => call.url === '/api/localhost.start' && JSON.parse(call.init.body).id === 'svc-2'),
      'Start posts the service id to /api/localhost.start',
    )
  })

  it('offers Open only for a running service', async () => {
    const stopped = await mountPanel([
      { id: 'svc-3', name: 'down', kind: 'static', dir: '/tmp/x', port: 8844, status: 'stopped', url: 'http://127.0.0.1:8844/', sessionId: '' },
    ])
    assert.equal(findButton(stopped.tree, '打开'), null)

    const running = await mountPanel([
      { id: 'svc-4', name: 'up', kind: 'static', dir: '/tmp/x', port: 8845, status: 'running', url: 'http://127.0.0.1:8845/', sessionId: '' },
    ])
    assert.ok(findButton(running.tree, '打开'), 'a running service can be opened')
  })

  it('expands a row into the directory, the entry file and the registering session', async () => {
    const { tree, render } = await mountPanel([
      {
        id: 'svc-5',
        name: 'page',
        kind: 'static',
        dir: '/tmp/site',
        entry: 'index.html',
        port: 8846,
        status: 'stopped',
        url: 'http://127.0.0.1:8846/',
        sessionId: 'session-abcdef12-3456',
      },
    ])
    const toggle = findButton(tree, '▼')
    assert.ok(toggle, 'the row can be expanded')
    toggle.props.onClick()
    const text = textOf(render())
    assert.match(text, /\/tmp\/site/, 'the directory is shown')
    assert.match(text, /index\.html/, 'the entry file is shown')
    assert.match(text, /abcdef12/, 'the registering session is shown, shortened')
  })
})
