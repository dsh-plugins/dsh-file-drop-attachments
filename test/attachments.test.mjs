import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'

import attachmentPlugin, {
  findMatchingWorkspaceFile,
  imageCachePath,
  pruneHistoricalImages,
  resolvePaths,
  storeUploadedFile,
} from '../lib/index.js'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let clientDefinition
const testWindow = {
  __ModuleLoader__: {
    load(definition) {
      clientDefinition = definition
    },
  },
}
vm.runInNewContext(clientSource, { console, setTimeout, clearTimeout, window: testWindow })
const clientModule = clientDefinition.factory(() => ({}))
const client = clientModule.__test

test('replaces historical image refs with cache paths while preserving the unresolved image suffix', () => {
  const oldUserRef = { attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png' }
  const oldToolRef = { attachmentId: `sha256:${'b'.repeat(64)}`, mediaType: 'image/jpeg' }
  const currentRef = { attachmentId: `sha256:${'c'.repeat(64)}`, mediaType: 'image/webp' }
  const oldUserImage = { type: 'image', attachment: oldUserRef }
  const oldToolImage = { type: 'image', attachment: oldToolRef }
  const currentImage = { type: 'image', attachment: currentRef }
  const payload = {
    provider: 'codex-lq',
    messages: [
      { role: 'user', content: [oldUserImage, { type: 'text', text: 'old' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'handled' }] },
      {
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: 'old-call',
          content: [oldToolImage],
        }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'continued' }] },
      { role: 'user', content: [currentImage, { type: 'text', text: 'new' }] },
    ],
  }

  const result = pruneHistoricalImages(payload)

  assert.equal(result.removedCount, 2)
  assert.notEqual(result.options, payload)
  assert.deepEqual(result.options.messages[0].content, [
    { type: 'text', text: `[图片缓存] \`${imageCachePath(oldUserRef)}\`` },
    { type: 'text', text: 'old' },
  ])
  assert.deepEqual(result.options.messages[2].content[0].content, [
    { type: 'text', text: `[图片缓存] \`${imageCachePath(oldToolRef)}\`` },
  ])
  assert.deepEqual(result.options.messages[4].content[0], currentImage)
  assert.equal(payload.messages[0].content[0], oldUserImage)
  assert.equal(payload.messages[2].content[0].content[0], oldToolImage)
})

test('returns the original request when no historical images exist', () => {
  const payload = {
    messages: [
      { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'current' } }] },
    ],
  }
  const result = pruneHistoricalImages(payload)
  assert.equal(result.options, payload)
  assert.equal(result.removedCount, 0)
})
test('plugin wraps registered adapters and restores them on dispose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-image-cache-test-'))
  const imageStoreRoot = join(root, 'attachments', 'v1')
  const hash = 'd'.repeat(64)
  const source = join(imageStoreRoot, 'objects', hash.slice(0, 2), hash)
  await mkdir(dirname(source), { recursive: true })
  await writeFile(source, Buffer.from('image-cache'))

  let observed
  const originalStream = function stream(options) {
    observed = options
    return (async function* () {})()
  }
  const adapter = { stream: originalStream }
  const llm = { adapters: new Map([['codex-lq', { adapter }]]) }
  const cleanups = []
  const ctx = {
    llm,
    attachments: { root: imageStoreRoot },
    on(event, listener) {
      assert.equal(event, 'llm/adapters-updated')
      this.listener = listener
      return () => { this.listener = undefined }
    },
    effect(factory) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
    webServer: {
      register() {
        return () => {}
      },
    },
  }

  try {
    attachmentPlugin.apply(ctx)
    const ref = { attachmentId: `sha256:${hash}`, mediaType: 'image/png' }
    const stream = adapter.stream({
      messages: [
        { role: 'user', content: [{ type: 'image', attachment: ref }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        { role: 'user', content: [{ type: 'text', text: 'current' }] },
      ],
    })
    await stream.next()

    assert.notEqual(adapter.stream, originalStream)
    assert.deepEqual(observed.messages[0].content, [{
      type: 'text',
      text: '[图片缓存] `' + imageCachePath(ref, imageStoreRoot) + '`',
    }])
    for (const cleanup of cleanups.reverse()) cleanup()
    assert.equal(adapter.stream, originalStream)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test('server only returns validated absolute attachment paths', async () => {
  const fs = {
    async resolve(candidate, options) {
      return { targetKey: join(options.cwd, candidate) }
    },
    async stat(target) {
      return target.targetKey.endsWith('report.txt') ? { type: 'file' } : undefined
    },
    processPath(target) {
      return target.targetKey
    },
  }

  assert.deepEqual(await resolvePaths(fs, {
    cwd: resolve('workspace'),
    entries: [{ name: 'report.txt', hint: '' }],
  }), [resolve('workspace', 'report.txt')])
  assert.deepEqual(await resolvePaths(fs, {
    cwd: resolve('workspace'),
    entries: [{ name: 'missing.txt', hint: '' }],
  }), [''])
})

test('server rejects a relative process path even when stat succeeds', async () => {
  const fs = {
    async resolve() {
      return { targetKey: 'report.txt' }
    },
    async stat() {
      return { type: 'file' }
    },
    processPath() {
      return 'report.txt'
    },
  }

  assert.deepEqual(await resolvePaths(fs, {
    cwd: undefined,
    entries: [{ name: 'report.txt', hint: '' }],
  }), [''])
})

test('uploaded fallback stores bytes under a sanitized session and file name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-drop-test-'))
  try {
    const path = await storeUploadedFile(root, 'session:one', '..\\CON?.txt', Buffer.from('payload'))
    assert.equal(dirname(path), join(root, 'session_one'))
    assert.doesNotMatch(basename(path), /[?\\/]/)
    assert.equal(await readFile(path, 'utf8'), 'payload')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace matching returns only one exact source file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-match-test-'))
  try {
    const firstDirectory = join(root, 'src')
    const secondDirectory = join(root, 'assets')
    await mkdir(firstDirectory)
    await mkdir(secondDirectory)
    const first = join(firstDirectory, 'sample.psd')
    await writeFile(first, 'same-content')
    assert.equal(await findMatchingWorkspaceFile(root, 'sample.psd', Buffer.from('same-content')), first)

    await writeFile(join(secondDirectory, 'sample.psd'), 'same-content')
    assert.equal(await findMatchingWorkspaceFile(root, 'sample.psd', Buffer.from('same-content')), '')
    assert.equal(await findMatchingWorkspaceFile(root, 'sample.psd', Buffer.from('other-content')), '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('desktop file path bridge wins over browser-only hints', () => {
  const file = { name: 'outside.psd', path: '', webkitRelativePath: '' }
  testWindow.__DSH_DESKTOP__ = {
    getPathForFile(received) {
      assert.equal(received, file)
      return 'C:\\Art\\outside.psd'
    },
  }
  try {
    assert.equal(client.hintForFile(file, 0, []), 'C:\\Art\\outside.psd')
  } finally {
    delete testWindow.__DSH_DESKTOP__
  }
})

test('v2.0.1 desktop file path bridge wins over browser-only hints', () => {
  const file = { name: 'outside.psd', path: '', webkitRelativePath: '' }
  testWindow.__DSH_DESKTOP_FILE_PATH__ = {
    getPathForFile(received) {
      assert.equal(received, file)
      return 'C:\\Art\\outside.psd'
    },
  }
  try {
    assert.equal(client.hintForFile(file, 0, []), 'C:\\Art\\outside.psd')
  } finally {
    delete testWindow.__DSH_DESKTOP_FILE_PATH__
  }
})

test('draft attachment store keeps each session isolated across switches', () => {
  const store = client.createDraftAttachmentStore()
  const first = [{ id: 1, name: 'a.txt', path: 'D:\\a.txt' }]
  const second = [{ id: 2, name: 'b.txt', path: 'D:\\b.txt' }]

  store.set('session-a', first)
  store.set('session-b', second)

  assert.equal(JSON.stringify(store.get('session-a')), JSON.stringify(first))
  assert.equal(JSON.stringify(store.get('session-b')), JSON.stringify(second))
  store.clear('session-a')
  assert.equal(store.get('session-a').length, 0)
  assert.equal(store.get('session-b').length, 1)
})

test('attachment markers round-trip while user text stays separate', () => {
  const attachments = [
    { path: 'D:\\workspace\\report.txt', copied: false },
    { path: 'C:\\Users\\Example\\notes.md', copied: true },
  ]
  const serialized = client.appendAttachmentPaths('review these', attachments)
  const parsed = client.splitAttachmentText(serialized)

  assert.equal(parsed.text, 'review these')
  assert.match(serialized, /\[附件副本\]/)
  assert.equal(JSON.stringify(parsed.paths), JSON.stringify(attachments.map((item) => item.path)))
  assert.equal(parsed.attachments[0].copied, false)
  assert.equal(parsed.attachments[1].copied, true)
  assert.equal(client.isAbsolutePath(parsed.paths[0]), true)
  assert.equal(client.isAbsolutePath('report.txt'), false)
})

test('legacy backtick attachment lines are still projected as cards', () => {
  const parsed = client.splitAttachmentText('hello\n[附件] `D:\\workspace\\old.txt`')
  assert.equal(parsed.text, 'hello')
  assert.equal(JSON.stringify(parsed.paths), JSON.stringify(['D:\\workspace\\old.txt']))
})

function fakeClientDocument() {
  const handlers = new Map()
  return {
    addEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).concat(handler))
    },
    removeEventListener(type, handler) {
      handlers.set(type, (handlers.get(type) ?? []).filter((entry) => entry !== handler))
    },
    fire(type) {
      for (const handler of handlers.get(type) ?? []) handler()
    },
  }
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

test('draft writes wait for the IME composition to end', async () => {
  const doc = fakeClientDocument()
  const gate = client.createCompositionGate(doc)
  const written = []

  gate.whenIdle('add-sentinel', () => written.push('idle'))
  assert.deepEqual(written, ['idle'], 'an idle composer is written through immediately')

  doc.fire('compositionstart')
  gate.whenIdle('add-sentinel', () => written.push('composing'))
  assert.deepEqual(written, ['idle'], 'nothing may rewrite the draft mid-composition')

  doc.fire('compositionend')
  assert.deepEqual(written, ['idle'], 'the flush waits for the commit to settle')
  await nextTask()
  assert.deepEqual(written, ['idle', 'composing'])
  gate.dispose()
})

test('a composition that starts again keeps the parked write back', async () => {
  const doc = fakeClientDocument()
  const gate = client.createCompositionGate(doc)
  const written = []

  doc.fire('compositionstart')
  gate.whenIdle('add-sentinel', () => written.push('first'))
  doc.fire('compositionend')
  doc.fire('compositionstart')
  await nextTask()
  assert.deepEqual(written, [], 'the queued flush yields to the new composition')

  doc.fire('compositionend')
  await nextTask()
  assert.deepEqual(written, ['first'])
  gate.dispose()
})

test('one parked write per key, and disposal drops it', async () => {
  const doc = fakeClientDocument()
  const gate = client.createCompositionGate(doc)
  const written = []

  doc.fire('compositionstart')
  gate.whenIdle('add-sentinel', () => written.push('stale'))
  gate.whenIdle('add-sentinel', () => written.push('fresh'))
  gate.whenIdle('drop-sentinel', () => written.push('drop'))
  doc.fire('compositionend')
  await nextTask()
  assert.deepEqual(written, ['fresh', 'drop'], 'the newest request per key wins')

  doc.fire('compositionstart')
  gate.whenIdle('add-sentinel', () => written.push('disposed'))
  gate.dispose()
  doc.fire('compositionend')
  await nextTask()
  assert.deepEqual(written, ['fresh', 'drop'])
})

test('both composer generations are recognised as the composer input', () => {
  const inScroll = (overrides) => ({
    closest: (selector) => (selector === '[data-input-scroll]' ? {} : null),
    ...overrides,
  })
  // 0.1.0 composer textarea and 0.1.2 contenteditable editor.
  assert.equal(client.isComposerInput(inScroll({ tagName: 'TEXTAREA' })), true)
  assert.equal(client.isComposerInput(inScroll({ tagName: 'DIV', isContentEditable: true })), true)
  // The queue-item editor in the input dock keeps its own Enter handling.
  assert.equal(client.isComposerInput({ tagName: 'TEXTAREA', closest: () => null }), false)
  assert.equal(client.isComposerInput(inScroll({ tagName: 'DIV', isContentEditable: false })), false)
  assert.equal(client.isComposerInput(null), false)
})

test('the send affordance is recognised by label and by primary-action class', () => {
  const button = (label, className = '') => ({ getAttribute: () => label, className })
  assert.equal(client.isSendButton(button('发送消息')), true)
  assert.equal(client.isSendButton(button('Send message')), true)
  assert.equal(client.isSendButton(button('发送')), true)
  assert.equal(client.isSendButton(button('停止生成')), false)
  assert.equal(client.isSendButton(button('Stop generating')), false)
  assert.equal(client.isSendButton(button('打开命令菜单')), false)
  assert.equal(client.isSendButton(button(null, 'InputBar_x1y2z_primary')), true)
  assert.equal(client.isSendButton(button(null, 'InputBar_x1y2z_add')), false)
})

test('a submit-time write waits out a just-committed composition', async () => {
  const doc = fakeClientDocument()
  const gate = client.createCompositionGate(doc)
  const written = []

  gate.whenSettled('submit-attachments', () => written.push('settled'))
  assert.deepEqual(written, ['settled'], 'a settled composer is written through immediately')

  doc.fire('compositionstart')
  gate.whenSettled('submit-attachments', () => written.push('during'))
  assert.deepEqual(written, ['settled'], 'a submit inside a composition never rewrites the draft')

  doc.fire('compositionend')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(written, ['settled', 'during'], 'the parked submit lands once the commit settles')
  gate.dispose()
})

test('a parked submit yields to a composition that opens before it fires', async () => {
  const doc = fakeClientDocument()
  const gate = client.createCompositionGate(doc)
  const written = []

  doc.fire('compositionstart')
  gate.whenSettled('submit-attachments', () => written.push('submit'))
  doc.fire('compositionend')
  doc.fire('compositionstart')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(written, [], 'a new composition keeps the submit parked')

  doc.fire('compositionend')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(written, ['submit'])
  gate.dispose()
})

test('compiled browser entry remains a classic ModuleLoader script', () => {
  assert.equal(clientDefinition.id, 'dsh-file-drop-attachments-persisted')
  assert.equal(clientModule.default.name, 'dsh-file-drop-attachments')
  assert.equal(typeof clientModule.default.apply, 'function')
  // vm.Script rejects ES module syntax, which DSH's classic loader cannot use.
  assert.doesNotThrow(() => new vm.Script(clientSource))
})

test('package entrypoints continue to resolve the prebuilt runtime files', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.main, 'lib/index.js')
  assert.equal(packageJson.exports['.'], './lib/index.js')
  assert.equal(packageJson.exports['./client'], './lib/client.js')
  assert.equal(packageJson.dsh.bundle.patch, './cordis.patch.yml')
})
