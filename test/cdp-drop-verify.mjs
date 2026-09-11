import { readFile } from 'node:fs/promises'

const endpoint = process.argv[2] ?? 'http://127.0.0.1:9224'
const pageUrl = process.argv[3] ?? 'http://127.0.0.1:3080'
const fixturePath = 'D:\\DSH基本工作区\\dsh-code-review\\test\\fixtures\\review-demo.txt'
const fixtureBase64 = (await readFile(fixturePath)).toString('base64')
const mode = process.argv[4]
const gesture = mode === '--paste-no-path' || mode === '--paste-copy' ? 'paste' : 'drop'
const expectCopy = mode === '--paste-copy' || mode === '--drop-copy'
const exposePath = !['--no-path', '--paste-no-path', '--paste-copy', '--drop-copy'].includes(mode)
const droppedPath = exposePath ? mode ?? fixturePath : ''
const fileName = expectCopy ? 'external.psd' : 'review-demo.txt'
const fileType = expectCopy ? 'application/octet-stream' : 'text/plain'
const fileBase64 = expectCopy ? Buffer.from('external-fixture').toString('base64') : fixtureBase64

const targets = await (await fetch(`${endpoint}/json/list`)).json()
const target = targets.find((entry) => entry.type === 'page')
if (!target) throw new Error('No CDP page target available')

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
const errors = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown') {
    errors.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text ?? 'Runtime exception')
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    errors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
  }
})

function call(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    throw new Error(detail)
  }
  return result.result.value
}

await call('Runtime.enable')
await call('Page.enable')
await call('Page.navigate', { url: pageUrl })
await new Promise((resolve) => setTimeout(resolve, 5000))
errors.length = 0

const before = await evaluate(`(() => ({
  styleLoaded: document.querySelector('style[data-plugin="dsh-file-drop-attachments"]') !== null,
  dockPresent: document.querySelector('.dsh-fdrop-native-rail') !== null,
  textareaPresent: document.querySelector('textarea') !== null,
  body: document.body.innerText.slice(0, 500)
}))()`)

const drop = await evaluate(`(() => {
  const bytes = Uint8Array.from(atob(${JSON.stringify(fileBase64)}), (char) => char.charCodeAt(0))
  const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(fileType)} })
  if (${JSON.stringify(exposePath)}) {
    try { Object.defineProperty(file, 'path', { value: ${JSON.stringify(droppedPath)} }) } catch {}
  }
  const transfer = new DataTransfer()
  transfer.items.add(file)
  if (${JSON.stringify(exposePath)}) transfer.setData('text/plain', ${JSON.stringify(droppedPath)})
  if (${JSON.stringify(gesture)} === 'paste') {
    const target = document.querySelector('textarea') ?? document
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }))
  } else {
    for (const type of ['dragenter', 'dragover', 'drop']) {
      document.dispatchEvent(new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }))
    }
  }
  return { gesture: ${JSON.stringify(gesture)}, files: transfer.files.length, types: [...transfer.types] }
})()`)
await new Promise((resolve) => setTimeout(resolve, 1800))

const after = await evaluate(`(() => ({
  cards: [...document.querySelectorAll('.dsh-fdrop-card')].map((node) => node.innerText.trim()),
  cardPaths: [...document.querySelectorAll('.dsh-fdrop-card')].map((node) => node.dataset.attachmentPath ?? ''),
  cardCopies: [...document.querySelectorAll('.dsh-fdrop-card')].map((node) => node.dataset.attachmentCopy ?? ''),
  rejectedAsImage: document.body.innerText.includes('仅支持 PNG、JPG、WebP、GIF 格式的图片'),
  draft: document.querySelector('textarea')?.value ?? '',
  body: document.body.innerText.slice(-800)
}))()`)

await evaluate(`(() => {
  for (const button of document.querySelectorAll('.dsh-fdrop-remove')) button.click()
})()`)

console.log(JSON.stringify({ before, drop, after, errors }, null, 2))
socket.close()

if (!before.styleLoaded) throw new Error('file-drop plugin styles are missing')
if (!before.dockPresent) throw new Error('file-drop input dock is not mounted')
if (after.cards.length === 0) throw new Error(`plain file ${gesture} did not create an attachment card`)
if (after.rejectedAsImage) throw new Error(`default image-only handler received the plain file ${gesture}`)
if (!exposePath && !expectCopy && after.cardPaths[0] !== fixturePath) {
  throw new Error(`workspace source was not selected: ${after.cardPaths[0] ?? '<missing>'}`)
}
if (!exposePath && !expectCopy && after.cardCopies[0] !== 'false') {
  throw new Error('workspace source was incorrectly marked as a copy')
}
if (expectCopy && after.cardCopies[0] !== 'true') throw new Error('external file was not marked as a copy')
if (expectCopy && !after.cardPaths[0]?.includes('file-drop-attachments')) {
  throw new Error(`external file was not stored in the attachment area: ${after.cardPaths[0] ?? '<missing>'}`)
}
if (errors.length > 0) throw new Error(`browser errors: ${errors.join('\n')}`)
