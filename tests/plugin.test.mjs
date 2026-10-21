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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, get } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

// The registry path is resolved at import time, so the sandbox home comes first.
const home = mkdtempSync(join(tmpdir(), 'dsh-localhost-'))
process.env.DSH_HOME = home

// A fake `tailscale serve status --json`, so the refresh path runs for real
// (execFile included) instead of being mocked out of existence. Written before
// the import: the registry path and this fixture both live under the temp home.
const FAKE_TAILSCALE = join(home, 'fake-tailscale')
// Publishes whatever port the test names, so the mapping under test never depends
// on which port is free on this machine.
writeFileSync(
  FAKE_TAILSCALE,
  `#!/bin/sh
cat <<JSON
{"TCP":{"8443":{"HTTPS":true}},
 "Web":{"mac.example.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:\${FAKE_TS_PORT:-9999}"}}}}}
JSON
`,
  { mode: 0o755 },
)
process.env.TAILSCALE_BIN = FAKE_TAILSCALE

/**
 * The registry file the Host half owns. Several tests below edit it from the
 * outside, because "an editor changed the file" is a supported situation now —
 * it is the situation that produced 0.4.0.
 */
const REGISTRY = join(home, 'localhost', 'services.json')
const readRegistry = () => JSON.parse(readFileSync(REGISTRY, 'utf8'))
const writeRegistry = (services) => {
  mkdirSync(dirname(REGISTRY), { recursive: true })
  writeFileSync(REGISTRY, `${JSON.stringify({ version: 1, services }, null, 2)}\n`)
}
const snapshotRegistry = () => (existsSync(REGISTRY) ? readFileSync(REGISTRY, 'utf8') : null)
const restoreRegistry = (text) => {
  if (text === null) rmSync(REGISTRY, { force: true })
  else writeFileSync(REGISTRY, text)
}

/** Let whatever the mount started finish; the boot pass is deliberately async. */
const settle = () => new Promise((done) => setTimeout(done, 30))

/** One request on its own connection, so a pooled keep-alive socket cannot answer it. */
const connect = (port) =>
  new Promise((resolveConnect, rejectConnect) => {
    const request = get({ host: '127.0.0.1', port, path: '/', agent: false }, (response) => {
      response.resume()
      resolveConnect(response.statusCode)
    })
    request.on('error', rejectConnect)
    request.setTimeout(1000, () => request.destroy(new Error('no answer in 1s')))
  })

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
    // A different command is a different service; the same one would be an update.
    const second = (await create(harness, { kind: 'spawned', dir: home, cmd: 'sleep 2', start: false })).service
    assert.ok(first.port >= 8840 && first.port <= 8899)
    assert.notEqual(first.port, second.port, 'two services cannot share a port')
    harness.dispose()
  })

  it('re-registering the same service updates it instead of taking a second port', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const first = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', start: false })).service
    const again = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', path: '/app/index.html', start: false })).service
    assert.equal(again.id, first.id, 'the same command in the same directory is the same service')
    assert.equal(again.port, first.port, 'and it keeps its port')
    assert.equal(again.path, '/app/index.html', 'the new path is applied')
    const all = readJson(await harness.call('list')).services.filter((service) => service.dir === home && service.cmd === 'serve')
    assert.equal(all.length, 1, 'no duplicate row')
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

describe('host: tailnet mirror', () => {
  it('maps only loopback proxies, and reads 443 from a bare host key', () => {
    const map = host.parseServeMap({
      Web: {
        'mac.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } },
        'mac.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8840' } } },
        'mac.example.ts.net:9000': { Handlers: { '/': { Proxy: 'http://10.0.0.5:8841' } } },
        'mac.example.ts.net:9443': { Handlers: { '/': { Proxy: 'unix:/tmp/x.sock' } } },
      },
    })
    assert.deepEqual([...map.keys()].sort((a, b) => a - b), [8840, 9999], 'only loopback targets map back to a service')
    assert.equal(map.get(8840).origin, 'https://mac.example.ts.net:8443')
    assert.equal(map.get(9999).origin, 'https://mac.example.ts.net')
  })

  it('tolerates a missing or malformed config', () => {
    assert.equal(host.parseServeMap(null).size, 0)
    assert.equal(host.parseServeMap({}).size, 0)
    assert.equal(host.parseServeMap({ Web: { 'host:443': { Handlers: {} } } }).size, 0)
  })

  it('publishes remoteUrl for a service whose port is on the tailnet', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', path: '/index.html', start: false })).service
    process.env.FAKE_TS_PORT = String(created.port)
    const listed = readJson(await harness.call('list')).services.find((service) => service.id === created.id)
    assert.equal(listed.remoteUrl, 'https://mac.example.ts.net:8443/index.html')
    harness.dispose()
  })

  it('leaves remoteUrl empty when nothing publishes the port', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'other', start: false })).service
    process.env.FAKE_TS_PORT = '9999' // the CLI publishes a different port
    const listed = readJson(await harness.call('list')).services.find((service) => service.id === created.id)
    assert.equal(listed.remoteUrl, '')
    harness.dispose()
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
    assert.equal(readRegistry().services.some((service) => service.id === created.id), false, 'the file no longer has it')
    harness.dispose()
  })

  it('stops what the entry owned when it is removed', async () => {
    const subprocess = makeSubprocess()
    const harness = makeCtx({ subprocess })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'serve', start: true })).service
    await harness.call('remove', { method: 'POST', body: { id: created.id } })
    assert.equal(subprocess.spawned[0].terminated, true, 'removing a running service terminates it')
  })

  it('removes through the tool, and says so in its own render', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const tool = harness.tools[0]
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'tool-removed', start: false })).service
    const value = await tool.execute({ action: 'remove', id: created.id }, {})
    assert.deepEqual(value.services, [])
    const blocks = tool.output.render({ action: 'remove', id: created.id }, value)
    assert.equal(blocks[0].text, `removed ${created.id}`, 'an empty list after a remove names the removal, not an empty registry')
  })
})

describe('host: the registry file is the truth', () => {
  it('drops a row deleted on disk, and does not put it back on the next write', async () => {
    // This is the whole reason 0.4.0 exists: an agent deleted its row with an
    // editor, the panel kept showing it, and the next save wrote the ghost back.
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const doomed = (await create(harness, { kind: 'spawned', dir: home, cmd: 'doomed', start: false })).service
    const kept = (await create(harness, { kind: 'spawned', dir: home, cmd: 'kept', start: false })).service

    writeRegistry(readRegistry().services.filter((service) => service.id !== doomed.id))
    assert.equal((await listIds(harness)).includes(doomed.id), false, 'the panel follows the file')

    await create(harness, { kind: 'spawned', dir: home, cmd: 'another', start: false })
    const file = readRegistry().services.map((service) => service.id)
    assert.equal(file.includes(doomed.id), false, 'a later write does not resurrect the deleted row')
    assert.ok(file.includes(kept.id), 'the other rows are untouched')
  })

  it('stops the server of a row deleted on disk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-vanish-'))
    writeFileSync(join(root, 'index.html'), '<!doctype html><p>here</p>')
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'static', dir: root, start: true })).service
    assert.equal((await fetch(`http://127.0.0.1:${created.port}/`)).status, 200)

    writeRegistry(readRegistry().services.filter((service) => service.id !== created.id))
    assert.equal((await listIds(harness)).includes(created.id), false)
    await settle()
    // A fresh connection, not `fetch`: the pool would hand back the keep-alive
    // socket from the request above and hide whether the listener is still there.
    await assert.rejects(connect(created.port), 'the port goes with the row')
  })

  it('picks up a row written from outside, as stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-outside-'))
    writeFileSync(join(root, 'index.html'), '<!doctype html><p>outside</p>')
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const services = [...readRegistry().services, { id: 'svc-outside', name: 'outside', kind: 'static', dir: root, cmd: '', entry: '', path: '', port: 8899, sessionId: '', createdAt: Date.now() }]
    writeRegistry(services)

    const listed = readJson(await harness.call('list')).services.find((service) => service.id === 'svc-outside')
    assert.ok(listed, 'a row registered by hand is visible')
    assert.equal(listed.status, 'stopped', 'and it does not claim to run')
    assert.equal(listed.url, 'http://127.0.0.1:8899/')
  })

  it('keeps what it has when the file is half-written', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'survives', start: false })).service
    const before = readRegistry().services
    writeFileSync(REGISTRY, '{ "version": 1, "services": [')
    assert.equal((await listIds(harness)).includes(created.id), true, 'a broken read does not drop the rows')
    writeRegistry(before.filter((service) => service.id !== created.id))
  })
})

describe('host: autoStart', () => {
  it('starts exactly the entries marked autoStart, after the composition is up', async () => {
    const snapshot = snapshotRegistry()
    try {
      const first = makeCtx({ subprocess: makeSubprocess() })
      host.apply(first.ctx)
      const marked = (await create(first, { kind: 'spawned', name: 'marked', dir: home, cmd: 'wanted', start: false, autoStart: true })).service
      await create(first, { kind: 'spawned', name: 'plain', dir: home, cmd: 'unwanted', start: false })
      first.dispose()

      const subprocess = makeSubprocess()
      const second = makeCtx({ subprocess })
      host.apply(second.ctx)
      await settle()
      assert.deepEqual(subprocess.spawned.map((record) => record.spec.argv[2]), ['wanted'], 'only the marked row starts')
      const listed = readJson(await second.call('list')).services.find((service) => service.id === marked.id)
      assert.equal(listed.status, 'starting', 'the row says what it is doing instead of looking stopped')
      second.dispose()
    } finally {
      restoreRegistry(snapshot)
    }
  })

  it('leaves a failure on the row instead of throwing it at the composition', async () => {
    const snapshot = snapshotRegistry()
    const root = mkdtempSync(join(tmpdir(), 'dsh-gone-'))
    try {
      const first = makeCtx({ subprocess: makeSubprocess() })
      host.apply(first.ctx)
      const created = (await create(first, { kind: 'static', name: 'gone', dir: root, start: false, autoStart: true })).service
      first.dispose()
      rmSync(root, { recursive: true, force: true })

      const second = makeCtx({ subprocess: makeSubprocess() })
      assert.doesNotThrow(() => host.apply(second.ctx), 'a service that cannot start is not a boot failure')
      await settle()
      const listed = readJson(await second.call('list')).services.find((service) => service.id === created.id)
      assert.equal(listed.status, 'exited')
      assert.match(listed.error, /does not exist/, 'the row names the reason')
      second.dispose()
    } finally {
      restoreRegistry(snapshot)
    }
  })

  it('waits for the subprocess seam instead of claiming a start it cannot make', async () => {
    const snapshot = snapshotRegistry()
    try {
      const first = makeCtx({ subprocess: makeSubprocess() })
      host.apply(first.ctx)
      const created = (await create(first, { kind: 'spawned', name: 'seamless', dir: home, cmd: 'needs-seam', start: false, autoStart: true })).service
      first.dispose()

      // A composition without `subprocess`: the pass must not run, and must not fail.
      const second = makeCtx({})
      assert.doesNotThrow(() => host.apply(second.ctx))
      await settle()
      const listed = readJson(await second.call('list')).services.find((service) => service.id === created.id)
      assert.equal(listed.status, 'stopped', 'nothing claims to run without a seam')
      second.dispose()
    } finally {
      restoreRegistry(snapshot)
    }
  })

  it('turns the opt-in on and off through the route, and the file remembers', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const created = (await create(harness, { kind: 'spawned', dir: home, cmd: 'toggle', start: false })).service
    assert.equal(created.autoStart, false, 'the default is off')

    const on = readJson(await harness.call('autostart', { method: 'POST', body: { id: created.id, autoStart: true } })).service
    assert.equal(on.autoStart, true)
    assert.equal(readRegistry().services.find((service) => service.id === created.id).autoStart, true)

    const off = readJson(await harness.call('autostart', { method: 'POST', body: { id: created.id, autoStart: false } })).service
    assert.equal(off.autoStart, false)
    await harness.call('remove', { method: 'POST', body: { id: created.id } })
  })

  it('keeps the opt-in when a re-register does not mention it', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const first = (await create(harness, { kind: 'spawned', dir: home, cmd: 'optin', start: false, autoStart: true })).service
    const again = (await create(harness, { kind: 'spawned', dir: home, cmd: 'optin', start: false, path: '/x' })).service
    assert.equal(again.id, first.id)
    assert.equal(again.autoStart, true, 'an update that says nothing about the opt-in does not clear it')
    await harness.call('remove', { method: 'POST', body: { id: first.id } })
  })
})

describe('host: open path', () => {
  it('opens the registered path instead of guessing the root', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const registered = await harness.tools[0].execute(
      { action: 'register', kind: 'spawned', dir: home, cmd: 'serve', path: '/the-way-back/index.html', start: false },
      {},
    )
    const service = registered.services[0]
    assert.equal(service.path, '/the-way-back/index.html')
    assert.equal(service.url, `http://127.0.0.1:${service.port}/the-way-back/index.html`)
    harness.dispose()
  })

  it('refuses a path that could climb out of the service', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const res = await harness.call('create', {
      method: 'POST',
      body: { kind: 'spawned', dir: home, cmd: 'serve', path: '/../etc/passwd', start: false },
    })
    assert.equal(res.statusCode, 400)
    assert.match(readJson(res).error, /must not contain/)
    harness.dispose()
  })

  it('records the calling session from the tool context', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const registered = await harness.tools[0].execute(
      { action: 'register', kind: 'spawned', dir: home, cmd: 'serve', start: false },
      { agent: { id: 'session-abc' } },
    )
    assert.equal(registered.services[0].sessionId, 'session-abc')
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

describe('host: tool budget', () => {
  // This tool sits in every agent's list on every request, so its size is a
  // budget, not an accident: 0.1.x shipped 1668 chars and 0.2.0 trims to under
  // 1000. Raising this number is a decision, not a side effect of editing prose.
  // 0.4.0 spends 73 more characters: `remove` in the enum and the `autoStart`
  // flag are the two things the panel does that the agent could not do at all,
  // and paying for them here is cheaper than the hand-edited registry that
  // `docs/plan.md` §17 describes.
  const BUDGET_CHARS = 1100

  it('keeps the model-facing payload inside the budget', async () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const tool = harness.tools[0]
    const payload = JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })
    assert.ok(
      payload.length <= BUDGET_CHARS,
      `serve is ${payload.length} chars (~${Math.round(payload.length / 4)} tokens); the budget is ${BUDGET_CHARS}`,
    )
    harness.dispose()
  })

  it('exposes exactly the parameters it uses, and no prose in the enums', () => {
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const parameters = harness.tools[0].parameters
    assert.deepEqual(Object.keys(parameters.properties).sort(), ['action', 'autoStart', 'cmd', 'dir', 'id', 'kind', 'name', 'path', 'start'])
    assert.equal(parameters.properties.kind.description, undefined, 'the enum already says spawned | static')
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

  it('declares every field it returns, so `serve list` cannot fail on its own output', async () => {
    // 0.1.2 returned `entry`, `pid`, `startedAt`, … while the schema declared a
    // subset, and `additionalProperties: false` rejected the tool's own result.
    const harness = makeCtx({ subprocess: makeSubprocess() })
    host.apply(harness.ctx)
    const tool = harness.tools[0]
    const declared = Object.keys(tool.output.schema.properties.services.items.properties)
    await tool.execute({ action: 'register', kind: 'spawned', dir: home, cmd: 'serve', start: false }, {})
    const view = (await tool.execute({ action: 'list' }, {})).services[0]
    assert.ok(view, 'the registry has one service')
    for (const key of Object.keys(view)) {
      assert.ok(declared.includes(key), `view() returns "${key}", which the schema does not declare`)
    }
    assert.equal(view.log, undefined, 'logs come from the logs action, not the list')
    harness.dispose()
  })

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
function loadClient(options = {}) {
  const hooks = createHooks()
  const opened = []
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
      // The desktop shell serves the UI from its own scheme; a phone sees https.
      location: options.location ?? { protocol: 'dsh:', hostname: 'host' },
      open: (...args) => opened.push(args),
    },
    fetch: (...args) => globalThis.fetch(...args),
    setInterval: () => 0,
    clearInterval: () => {},
    console,
  })
  runInContext(CLIENT_SOURCE, context, { filename: 'client.js' })
  return { loaded, hooks, React, opened }
}

/** Flatten a tree into text, so an assertion reads like the screen. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map(textOf).join('')
}

/** Count nodes carrying a class, so a layout assertion can see the grid it got. */
function countClass(node, className) {
  if (!node || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((total, child) => total + countClass(child, className), 0)
  if (typeof node.type === 'function') return countClass(node.type(node.props), className)
  const own = String(node.props?.className ?? '').split(' ').includes(className) ? 1 : 0
  return own + (node.children ?? []).reduce((total, child) => total + countClass(child, className), 0)
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
async function mountPanel(services, onFetch, options = {}) {
  const { loaded, hooks, opened } = loadClient(options)
  const registered = []
  const openedSessions = []
  const ctx = {
    uiWorkspace: { openSession: (id) => openedSessions.push(id) },
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

  return { tree, render, registered, opened, openedSessions }
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
    assert.equal(Array.from(loaded.exports.inject).join(','), 'slots,locale,uiWorkspace')
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

/** Mount the nav-row icon on its own, with a fetch stub behind it. */
async function mountIcon(services) {
  const { loaded, hooks } = loadClient()
  const registered = []
  const ctx = {
    locale: makeLocale(),
    effect: (fn) => fn(),
    slots: {
      inject: (_name, run) => run(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
  loaded.exports.apply(ctx)
  const nav = registered.find((entry) => entry.options.name === 'sidebar.panellist')
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ services }) })

  hooks.reset()
  hooks.clearEffects()
  nav.component({ size: 20, active: false })
  for (const effect of hooks.effects()) effect()
  await new Promise((done) => setTimeout(done, 0))

  hooks.reset()
  return nav.component({ size: 20, active: false })
}

describe('client: nav row', () => {
  const savedFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = savedFetch
  })

  it('shows a dot while something is running', async () => {
    const tree = await mountIcon([
      { id: 'a', name: 'radio', kind: 'spawned', dir: '/tmp/a', cmd: 'serve', port: 8840, status: 'running', url: 'http://127.0.0.1:8840/', sessionId: '' },
    ])
    assert.equal(countClass(tree, 'lh-navdot-slot'), 1)
  })

  it('shows nothing when every service is stopped', async () => {
    const tree = await mountIcon([
      { id: 'a', name: 'radio', kind: 'spawned', dir: '/tmp/a', cmd: 'serve', port: 8840, status: 'stopped', url: 'http://127.0.0.1:8840/', sessionId: '' },
    ])
    assert.equal(countClass(tree, 'lh-navdot-slot'), 0)
  })

  it('does not put the dot up when the registry is empty', async () => {
    const tree = await mountIcon([])
    assert.equal(countClass(tree, 'lh-navdot-slot'), 0)
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

  it('on a remote page opens the tailnet URL here, not the Host browser', async () => {
    const calls = []
    const { tree, opened } = await mountPanel(
      [
        {
          id: 'svc-7',
          name: 'radio',
          kind: 'spawned',
          dir: '/tmp/r',
          cmd: 'serve',
          port: 8840,
          status: 'running',
          url: 'http://127.0.0.1:8840/the-way-back/index.html',
          remoteUrl: 'https://mac.example.ts.net:8443/the-way-back/index.html',
          sessionId: '',
        },
      ],
      (url) => calls.push(url),
      { location: { protocol: 'https:', hostname: 'mac.example.ts.net' } },
    )
    const open = findButton(tree, '打开')
    assert.ok(open, 'a published service still offers Open')
    open.props.onClick()
    assert.equal(opened.length, 1, 'window.open is what runs')
    assert.equal(opened[0][0], 'https://mac.example.ts.net:8443/the-way-back/index.html')
    assert.equal(opened[0][1], '_blank')
    assert.equal(
      calls.some((url) => String(url).includes('/api/localhost.reveal')),
      false,
      'the Host browser is never asked from a remote page',
    )
  })

  it('on a remote page hides Open when the port is loopback only, and says so', async () => {
    const { tree } = await mountPanel(
      [
        {
          id: 'svc-8',
          name: 'local-only',
          kind: 'spawned',
          dir: '/tmp/l',
          cmd: 'serve',
          port: 8850,
          status: 'running',
          url: 'http://127.0.0.1:8850/',
          remoteUrl: '',
          sessionId: '',
        },
      ],
      undefined,
      { location: { protocol: 'https:', hostname: 'mac.example.ts.net' } },
    )
    assert.equal(findButton(tree, '打开'), null, 'no button that would silently do nothing')
    assert.match(textOf(tree), /只在本机可访问/)
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

  it('lays services out as tiles, not as one low-density row each', async () => {
    const { tree } = await mountPanel([
      { id: 'a', name: 'alpha', kind: 'static', dir: '/tmp/a', port: 8841, status: 'stopped', url: 'http://127.0.0.1:8841/', sessionId: '' },
      { id: 'b', name: 'beta', kind: 'spawned', dir: '/tmp/b', cmd: 'serve', port: 8842, status: 'running', url: 'http://127.0.0.1:8842/', sessionId: '' },
    ])
    assert.equal(countClass(tree, 'lh-grid'), 1, 'the list is a grid')
    assert.equal(countClass(tree, 'lh-card'), 2, 'one tile per service')
  })

  it('jumps to the registering session when asked', async () => {
    const { tree, render, openedSessions } = await mountPanel([
      {
        id: 'svc-6',
        name: 'page',
        kind: 'static',
        dir: '/tmp/site',
        port: 8847,
        status: 'stopped',
        url: 'http://127.0.0.1:8847/',
        sessionId: 'session-abcdef12-3456',
      },
    ])
    findButton(tree, '▼').props.onClick()
    const link = findButton(render(), '跳到会话')
    assert.ok(link, 'the expanded tile offers the session jump')
    link.props.onClick()
    assert.deepEqual(openedSessions, ['session-abcdef12-3456'], 'the jump reaches uiWorkspace with the session id')
  })

  it('shows the auto-start opt-in as pressed when the row has it', async () => {
    const { tree } = await mountPanel([
      { id: 'svc-a', name: 'dev', kind: 'spawned', dir: '/tmp/a', cmd: 'serve', port: 8848, status: 'running', url: 'http://127.0.0.1:8848/', autoStart: true, sessionId: '' },
    ])
    const pill = findButton(tree, '● 自动启动')
    assert.ok(pill, 'a marked service says so on the tile')
    assert.equal(pill.props['aria-pressed'], 'true')
  })

  it('posts the flipped opt-in when the auto-start pill is pressed', async () => {
    const calls = []
    const { tree } = await mountPanel(
      [{ id: 'svc-b', name: 'dev', kind: 'spawned', dir: '/tmp/b', cmd: 'serve', port: 8849, status: 'stopped', url: 'http://127.0.0.1:8849/', autoStart: false, sessionId: '' }],
      (url, init) => calls.push({ url, init }),
    )
    const pill = findButton(tree, '○ 自动启动')
    assert.ok(pill, 'an unmarked service offers the switch')
    await pill.props.onClick()
    const call = calls.find((entry) => entry.url === '/api/localhost.autostart')
    assert.ok(call, 'the switch posts to /api/localhost.autostart')
    assert.deepEqual(JSON.parse(call.init.body), { id: 'svc-b', autoStart: true })
  })

  it('asks once before removing, and removes on the second click', async () => {
    const calls = []
    const { tree, render } = await mountPanel(
      [{ id: 'svc-c', name: 'bye', kind: 'spawned', dir: '/tmp/c', cmd: 'serve', port: 8850, status: 'stopped', url: 'http://127.0.0.1:8850/', autoStart: false, sessionId: '' }],
      (url, init) => calls.push({ url, init }),
    )
    findButton(tree, '▼').props.onClick()
    const ask = findButton(render(), '移除')
    assert.ok(ask, 'the expanded tile offers Remove')
    await ask.props.onClick()
    assert.equal(
      calls.some((entry) => entry.url === '/api/localhost.remove'),
      false,
      'the first click only asks',
    )
    const confirm = findButton(render(), '确认移除')
    assert.ok(confirm, 'the same place now asks for confirmation')
    await confirm.props.onClick()
    const call = calls.find((entry) => entry.url === '/api/localhost.remove')
    assert.ok(call, 'the second click removes')
    assert.equal(JSON.parse(call.init.body).id, 'svc-c')
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
