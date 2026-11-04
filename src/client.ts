// This file must remain a classic script: DSH loads it via __ModuleLoader__.
type AttachmentPath = { path: string; copied: boolean }
type DraftAttachment = AttachmentPath & { id: number; name: string }
type AttachmentUpdate = readonly DraftAttachment[] | ((current: readonly DraftAttachment[]) => readonly DraftAttachment[])
type PathEntry = { name: string; hint: string }
type OpenPath = (path: string) => unknown
type InputActions = { setDraft(draft: string): void; submit(): void }
interface DockProps {
  sessionId: string
  input: { draft: string; phase: string }
  inputActions: InputActions
  openPath: OpenPath
  useSessions<T>(select: (snapshot: { byId: Record<string, { cwd?: string }> }) => T): T
}
interface DesktopFileBridge { getPathForFile(file: File): string }
interface Window {
  __DSH_DESKTOP_FILE_PATH__?: DesktopFileBridge
  __DSH_DESKTOP__?: DesktopFileBridge
  __ModuleLoader__: { load(definition: { id: string; factory(require: {
    (name: 'react'): typeof import('react')
    (name: 'react-dom'): typeof import('react-dom')
  }): unknown }): void }
}
interface ClientContext {
  slots?: {
    inject(name: string, register: () => unknown): void
    register(definition: { name: string; id: string; order: number; label: string; inject(sessionId: string): { openPath: OpenPath; sessionId: string } }, component: import('react').ComponentType<DockProps>): unknown
  }
  get(name: 'remote'): { session?: { openWorkspacePath?: (input: { path: string }) => Promise<{ ok?: boolean; error?: { message?: string } } | undefined> } } | undefined
  get(name: 'workspaces'): { openPath?: OpenPath } | undefined
  effect(effect: () => (() => void), label: string): void
}

window.__ModuleLoader__.load({
  id: 'dsh-file-drop-attachments-persisted',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')

    const RESOLVE_ROUTE = '/api/file-drop-attachments/resolve'
    const UPLOAD_ROUTE = '/api/file-drop-attachments/upload'
    const DESKTOP_FILE_PATH_BRIDGE_KEY = '__DSH_DESKTOP_FILE_PATH__'
    const MAX_UPLOAD_BYTES = 64 * 1024 * 1024
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
    const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
    }
    const ATTACHMENT_SENTINEL = '\u200b'
    const ATTACHMENT_LINE_PREFIX = '[附件] '
    const ATTACHMENT_COPY_LINE_PREFIX = '[附件副本] '
    const EMPTY_ATTACHMENTS: readonly DraftAttachment[] = Object.freeze([])
    const CODE_EXTENSIONS = new Set([
      'c', 'cc', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'json',
      'jsx', 'kt', 'lua', 'md', 'php', 'py', 'rb', 'rs', 'sh', 'sql', 'swift', 'toml',
      'ts', 'tsx', 'vue', 'xml', 'yaml', 'yml',
    ])
    const ARCHIVE_EXTENSIONS = new Set(['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip'])
    const TABLE_EXTENSIONS = new Set(['csv', 'ods', 'xls', 'xlsx'])
    const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'pages', 'rtf', 'txt'])

    function isAbsolutePath(path: unknown): path is string {
      if (typeof path !== 'string' || path === '') return false
      return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')
    }

    /*
     * 0.1.0 bound the composer to a <textarea>; 0.1.2 binds a contenteditable
     * editor. Both live inside the input scroll region, and both must be
     * recognised or Enter silently stops injecting attachment lines. Sibling
     * editors — the queue-item editor rendered in the input dock — sit outside
     * that region and keep their own Enter handling.
     */
    function isComposerInput(target: EventTarget | null | undefined) {
      const element = target as HTMLElement | null | undefined
      if (element === null || element === undefined || typeof element.closest !== 'function') return false
      if (element.tagName !== 'TEXTAREA' && element.isContentEditable !== true) return false
      return element.closest('[data-input-scroll]') !== null
    }

    const SEND_LABELS = new Set(['发送消息', 'Send message', '发送', 'Send'])
    const STOP_LABELS = new Set(['停止生成', 'Stop generating', '停止', 'Stop'])

    /*
     * Identify the send affordance without pinning one build's markup: the shipped
     * label first, then the primary-action class (hashed as `<hash>_primary`, so
     * only the suffix is stable) for label-less builds.
     */
    function isSendButton(button: Element) {
      const label = (button.getAttribute('aria-label') ?? '').trim()
      if (STOP_LABELS.has(label)) return false
      if (SEND_LABELS.has(label)) return true
      if (label !== '') return false
      const className = typeof button.className === 'string' ? button.className : ''
      return /(?:^|\s)[A-Za-z_][\w-]*_primary(?:\s|$)/.test(className)
    }

    function createDraftAttachmentStore() {
      const bySession = new Map<string | undefined, readonly DraftAttachment[]>()
      return {
        get(sessionId: string | undefined) {
          return bySession.get(sessionId) || EMPTY_ATTACHMENTS
        },
        set(sessionId: string | undefined, attachments: readonly DraftAttachment[]) {
          if (attachments.length === 0) bySession.delete(sessionId)
          else bySession.set(sessionId, attachments)
          return attachments
        },
        update(sessionId: string | undefined, update: AttachmentUpdate) {
          const current = bySession.get(sessionId) || EMPTY_ATTACHMENTS
          const next = typeof update === 'function' ? update(current) : update
          if (next.length === 0) bySession.delete(sessionId)
          else bySession.set(sessionId, next)
          return next
        },
        clear(sessionId: string | undefined) {
          bySession.delete(sessionId)
        },
      }
    }

    const draftAttachmentStore = createDraftAttachmentStore()

    function basename(path: string) {
      const normalized = String(path).replace(/\\/g, '/')
      const at = normalized.lastIndexOf('/')
      return at < 0 ? normalized : normalized.slice(at + 1)
    }

    function extensionOf(name: string) {
      const at = name.lastIndexOf('.')
      return at <= 0 || at === name.length - 1 ? '' : name.slice(at + 1).toLowerCase()
    }

    function typeLabel(name: string) {
      const extension = extensionOf(name)
      return extension === '' ? 'FILE' : extension.toUpperCase()
    }

    function iconKind(name: string) {
      const extension = extensionOf(name)
      if (extension === 'pdf') return 'pdf'
      if (CODE_EXTENSIONS.has(extension)) return 'code'
      if (ARCHIVE_EXTENSIONS.has(extension)) return 'archive'
      if (TABLE_EXTENSIONS.has(extension)) return 'table'
      if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
      return 'file'
    }

    function fileUriToPath(uri: unknown) {
      if (typeof uri !== 'string' || !uri.startsWith('file://')) return ''
      let path = uri.startsWith('file:///') ? uri.slice(8) : `//${uri.slice(7)}`
      try {
        path = decodeURIComponent(path)
      } catch {
        // Keep the encoded URI path when decoding fails.
      }
      return path
    }

    function transferPathHints(transfer: DataTransfer) {
      const hints = []
      const uriList = transfer.getData('text/uri-list')
      for (const line of uriList.split(/\r?\n/)) {
        if (line === '' || line.startsWith('#')) continue
        const path = fileUriToPath(line.trim())
        if (path !== '') hints.push(path)
      }

      const plain = transfer.getData('text/plain')
      for (const line of plain.split(/\r?\n/)) {
        const path = line.trim().replace(/^"|"$/g, '')
        if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) {
          if (!hints.includes(path)) hints.push(path)
        }
      }
      return hints
    }

    function desktopFilePathBridge() {
      const modern = window[DESKTOP_FILE_PATH_BRIDGE_KEY]
      if (modern !== null && typeof modern === 'object' && typeof modern.getPathForFile === 'function') {
        return modern
      }
      const legacy = window.__DSH_DESKTOP__
      if (legacy !== null && typeof legacy === 'object' && typeof legacy.getPathForFile === 'function') {
        return legacy
      }
      return null
    }

    function hintForFile(file: File & { path?: string }, index: number, hints: string[]) {
      const desktop = desktopFilePathBridge()
      if (desktop !== null) {
        try {
          const path = desktop.getPathForFile(file)
          if (isAbsolutePath(path)) return path
        } catch {
          // Files constructed in JavaScript have no native path; continue with browser hints.
        }
      }
      if (typeof file.path === 'string' && file.path !== '') return file.path
      if (typeof file.webkitRelativePath === 'string' && file.webkitRelativePath !== '') {
        return file.webkitRelativePath
      }
      const named = hints.find((path) => basename(path) === file.name)
      return named || hints[index] || ''
    }

    function imageMimeOf(file: File) {
      if (IMAGE_TYPES.has(file.type)) return file.type
      return IMAGE_MIME_BY_EXTENSION[extensionOf(file.name)] || ''
    }

    function isSupportedImage(file: File) {
      return imageMimeOf(file) !== ''
    }

    function transferFiles(transfer: DataTransfer) {
      const files = Array.from(transfer.files || [])
      if (files.length > 0) return files
      return Array.from(transfer.items || [])
        .filter((item) => item.kind === 'file' && typeof item.getAsFile === 'function')
        .map((item) => item.getAsFile())
        .filter((file) => file !== null)
    }

    function requiresCustomDropHandling(transfer: DataTransfer) {
      const files = transferFiles(transfer)
      if (files.length > 0) return files.some((file) => !IMAGE_TYPES.has(file.type))
      const items = Array.from(transfer.items || []).filter((item) => item.kind === 'file')
      if (items.length === 0) return false
      return items.some((item) => !IMAGE_TYPES.has(item.type))
    }

    function normalizedImageFile(doc: Document, file: File) {
      const mime = imageMimeOf(file)
      if (mime === '' || file.type === mime) return file
      const view = doc.defaultView
      if (view === null || typeof view.File !== 'function') return file
      return new view.File([file], file.name, {
        type: mime,
        lastModified: file.lastModified,
      })
    }

    function replayImages(doc: Document, files: File[]) {
      if (files.length === 0) return
      const view = doc.defaultView
      if (view === null || typeof view.DataTransfer !== 'function' || typeof view.DragEvent !== 'function') {
        return
      }
      try {
        const transfer = new view.DataTransfer()
        for (const file of files) transfer.items.add(normalizedImageFile(doc, file))
        doc.dispatchEvent(new view.DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }))
      } catch (error) {
        console.error('[dsh-file-drop-attachments] image replay failed', error)
      }
    }

    async function resolveDroppedPaths(cwd: string | undefined, entries: PathEntry[]): Promise<string[]> {
      const response = await fetch(RESOLVE_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd, entries }),
      })
      if (!response.ok) throw new Error(`path resolver returned ${response.status}`)
      const result = await response.json()
      if (!Array.isArray(result.paths)) return entries.map(() => '')
      return entries.map((entry, index) => {
        const path = result.paths[index]
        return isAbsolutePath(path) ? path : ''
      })
    }

    async function uploadDroppedFile(sessionId: string, cwd: string | undefined, file: File): Promise<AttachmentPath> {
      if (file.size > MAX_UPLOAD_BYTES) throw new Error(`${file.name} exceeds 64 MiB limit`)
      const query = new URLSearchParams({ sessionId, name: file.name, cwd: cwd ?? '' })
      const response = await fetch(`${UPLOAD_ROUTE}?${query}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-dsh-file-drop': '1',
        },
        body: file,
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? `upload returned ${response.status}`)
      return {
        path: isAbsolutePath(result.path) ? result.path : '',
        copied: result.copied === true,
      }
    }

    async function resolveOrUploadDroppedFiles(sessionId: string, cwd: string | undefined, files: File[], entries: PathEntry[]) {
      let paths
      try {
        paths = await resolveDroppedPaths(cwd, entries)
      } catch (error) {
        console.error('[dsh-file-drop-attachments] path resolution failed', error)
        paths = entries.map(() => '')
      }
      const resolved = paths.map((path) => ({ path, copied: false }))
      for (let index = 0; index < files.length; index += 1) {
        if (resolved[index].path !== '') continue
        try {
          resolved[index] = await uploadDroppedFile(sessionId, cwd, files[index])
        } catch (error) {
          console.error(`[dsh-file-drop-attachments] upload failed for ${files[index].name}`, error)
        }
      }
      return resolved
    }

    function stripSentinel(draft: string) {
      return draft.split(ATTACHMENT_SENTINEL).join('')
    }

    function attachmentFromLine(line: string) {
      const copied = line.startsWith(ATTACHMENT_COPY_LINE_PREFIX)
      const prefix = copied ? ATTACHMENT_COPY_LINE_PREFIX : ATTACHMENT_LINE_PREFIX
      if (!line.startsWith(prefix)) return null
      let path = line.slice(prefix.length).trim()
      if (path.startsWith('`') && path.endsWith('`')) {
        path = path.slice(1, -1).replace(/\\`/g, '`')
      }
      return isAbsolutePath(path) ? { path, copied } : null
    }

    function splitAttachmentText(value: string) {
      const attachments = []
      const text = []
      for (const line of stripSentinel(value).split(/\r?\n/)) {
        const attachment = attachmentFromLine(line)
        if (attachment === null) text.push(line)
        else attachments.push(attachment)
      }
      while (text.length > 0 && text[text.length - 1] === '') text.pop()
      return {
        text: text.join('\n'),
        paths: attachments.map((item) => item.path),
        attachments,
      }
    }

    function appendAttachmentPaths(draft: string, attachments: readonly AttachmentPath[]) {
      const clean = stripSentinel(draft)
      const lines = attachments
        .filter((item) => isAbsolutePath(item.path))
        .map((item) => {
          const prefix = item.copied ? ATTACHMENT_COPY_LINE_PREFIX : ATTACHMENT_LINE_PREFIX
          return `${prefix}\`${item.path.replace(/`/g, '\\`')}\``
        })
      const separator = clean === '' || clean.endsWith('\n') ? '' : '\n'
      return clean + separator + lines.join('\n')
    }

    function FileTypeIcon(props: { kind: string }) {
      const kind = props.kind
      if (kind === 'pdf') {
        return React.createElement('svg', {
          viewBox: '0 0 24 24',
          width: 24,
          height: 24,
          'aria-hidden': true,
        },
        React.createElement('path', { d: 'M5 2h10l4 4v16H5z', fill: '#ef4444' }),
        React.createElement('path', { d: 'M15 2v5h4', fill: '#fecaca' }),
        React.createElement('text', {
          x: 12,
          y: 16.3,
          textAnchor: 'middle',
          fill: '#fff',
          fontSize: 5.2,
          fontWeight: 700,
          fontFamily: 'Arial, sans-serif',
        }, 'PDF'))
      }

      const children = [
        React.createElement('path', { key: 'page', d: 'M6 2.75h8.5L19 7.25v14H6z' }),
        React.createElement('path', { key: 'fold', d: 'M14.5 2.75v4.5H19' }),
      ]
      if (kind === 'code') {
        children.push(React.createElement('path', { key: 'left', d: 'm10 10-2 2 2 2' }))
        children.push(React.createElement('path', { key: 'right', d: 'm14 10 2 2-2 2' }))
      } else if (kind === 'archive') {
        children.push(React.createElement('path', {
          key: 'zip',
          d: 'M11 7.5h2m-2 2h2m-2 2h2m-2 2h2m-2 2h2',
        }))
        children.push(React.createElement('rect', {
          key: 'box',
          x: 10,
          y: 17.5,
          width: 4,
          height: 2,
          rx: 0.5,
        }))
      } else if (kind === 'table') {
        children.push(React.createElement('rect', {
          key: 'grid',
          x: 8.5,
          y: 10,
          width: 8,
          height: 7,
          rx: 0.5,
        }))
        children.push(React.createElement('path', {
          key: 'grid-lines',
          d: 'M8.5 13.5h8M12.5 10v7',
        }))
      } else if (kind === 'document') {
        children.push(React.createElement('path', {
          key: 'lines',
          d: 'M9 10h6m-6 3h6m-6 3h4',
        }))
      } else {
        children.push(React.createElement('path', { key: 'line', d: 'M9 13h6' }))
      }

      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: 24,
        height: 24,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, ...children)
    }

    function CloseIcon() {
      return React.createElement('svg', {
        viewBox: '0 0 16 16',
        width: 12,
        height: 12,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        'aria-hidden': true,
      }, React.createElement('path', { d: 'm4.5 4.5 7 7m0-7-7 7' }))
    }

    function domFileIcon(doc: Document, kind: string) {
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '24')
      svg.setAttribute('height', '24')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.8')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      const page = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      page.setAttribute('d', 'M6 2.75h8.5L19 7.25v14H6z')
      svg.append(page)
      const fold = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      fold.setAttribute('d', 'M14.5 2.75v4.5H19')
      svg.append(fold)
      const detail = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      detail.setAttribute('d', kind === 'code' ? 'm10 10-2 2 2 2m4-4 2 2-2 2' : 'M9 13h6')
      svg.append(detail)
      return svg
    }

    function createSentAttachmentCard(doc: Document, path: string, openPath: OpenPath, copied = false) {
      const name = basename(path)
      const kind = iconKind(name)
      const card = doc.createElement('button')
      card.type = 'button'
      card.className = 'dsh-fdrop-card dsh-fdrop-sent-card'
      card.dataset.attachmentPath = path
      card.dataset.attachmentCopy = copied ? 'true' : 'false'
      card.title = copied ? `${path}（浏览器上传副本）` : path
      card.setAttribute('aria-label', `打开附件 ${name}${copied ? '（副本）' : ''}`)
      card.addEventListener('click', () => {
        Promise.resolve(openPath(path)).catch((error) => {
          console.error('[dsh-file-drop-attachments] open failed', error)
        })
      })

      const icon = doc.createElement('span')
      icon.className = `dsh-fdrop-icon dsh-fdrop-icon-${kind}`
      icon.append(domFileIcon(doc, kind))
      const copy = doc.createElement('span')
      copy.className = 'dsh-fdrop-copy'
      const filename = doc.createElement('span')
      filename.className = 'dsh-fdrop-name'
      filename.textContent = name
      const extension = doc.createElement('span')
      extension.className = 'dsh-fdrop-extension'
      extension.textContent = copied ? `${typeLabel(name)} · 副本` : typeLabel(name)
      copy.append(filename, extension)
      card.append(icon, copy)
      return card
    }

    function hasAttachmentText(element: Element) {
      const text = element.textContent
      return Boolean(text && (
        text.includes(ATTACHMENT_LINE_PREFIX) || text.includes(ATTACHMENT_COPY_LINE_PREFIX)
      ))
    }

    function deepestAttachmentBubble(stack: Element) {
      const marked = stack.querySelector('.dsh-fdrop-source-bubble')
      if (marked !== null) return marked
      const candidates = Array.from(stack.querySelectorAll('div')).filter(hasAttachmentText)
      return candidates.length === 0 ? undefined : candidates[candidates.length - 1]
    }

    /*
     * Sent-message anchors differ per DSH generation: 0.1.0 renders
     * [data-time-hover-root] rows, 0.1.2 renders [data-chat-flow-kind] flow
     * items with a hashed *_userStack / *_bubble pair.
     */
    function sentAttachmentRows(doc: Document) {
      const rows = []
      for (const row of doc.querySelectorAll('[data-time-hover-root]')) {
        const stack = row.firstElementChild
        if (stack === null) continue
        const bubble = Array.from(stack.children).find((child) => {
          return child.classList.contains('dsh-fdrop-source-bubble') || hasAttachmentText(child)
        })
        if (bubble === undefined) continue
        rows.push({ row, stack, bubble })
      }
      for (const row of doc.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]')) {
        const stack = row.querySelector('[class*="_userStack"]') ?? row.firstElementChild
        if (stack === null) continue
        const bubble = deepestAttachmentBubble(stack)
        if (bubble === undefined) continue
        rows.push({ row, stack, bubble })
      }
      return rows
    }

    function decorateSentAttachments(doc: Document, openPath: OpenPath) {
      for (const { row, stack, bubble } of sentAttachmentRows(doc)) {
        const parsed = splitAttachmentText(bubble.textContent || '')
        const signature = JSON.stringify([parsed.text, parsed.attachments])
        const existing = row.querySelector<HTMLElement>('.dsh-fdrop-sent-rail')
        if (existing !== null && existing.dataset.signature === signature) continue

        if (existing !== null) existing.remove()
        for (const text of row.querySelectorAll('.dsh-fdrop-sent-text')) text.remove()
        bubble.classList.remove('dsh-fdrop-source-bubble')
        bubble.removeAttribute('aria-hidden')
        if (parsed.paths.length === 0) continue

        const rail = doc.createElement('div')
        rail.className = 'dsh-fdrop-native-rail dsh-fdrop-sent-rail'
        rail.dataset.signature = signature
        for (const attachment of parsed.attachments) {
          rail.append(createSentAttachmentCard(doc, attachment.path, openPath, attachment.copied))
        }
        stack.insertBefore(rail, bubble)

        if (parsed.text !== '') {
          const text = bubble.cloneNode(false) as Element
          text.classList.add('dsh-fdrop-sent-text')
          text.textContent = parsed.text
          stack.insertBefore(text, bubble)
        }
        bubble.classList.add('dsh-fdrop-source-bubble')
        bubble.setAttribute('aria-hidden', 'true')
      }
    }

    function observeSentAttachments(doc: Document, openPath: OpenPath) {
      let active = true
      let scheduled = false
      const scan = () => {
        scheduled = false
        if (!active) return
        decorateSentAttachments(doc, openPath)
      }
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(scan)
      }
      scan()
      const observer = new MutationObserver(schedule)
      observer.observe(doc.body, { childList: true, characterData: true, subtree: true })
      return () => {
        active = false
        observer.disconnect()
        for (const element of doc.querySelectorAll('.dsh-fdrop-sent-rail, .dsh-fdrop-sent-text')) {
          element.remove()
        }
        for (const bubble of doc.querySelectorAll('.dsh-fdrop-source-bubble')) {
          bubble.classList.remove('dsh-fdrop-source-bubble')
          bubble.removeAttribute('aria-hidden')
        }
      }
    }

    /*
     * Composition gate for plugin-owned draft writes.
     *
     * `inputActions.setDraft` is not a text edit: the host clears the Lexical
     * draft, rebuilds it paragraph by paragraph, and parks the caret at the end.
     * Run while an IME composition is in flight, that rebuild commits the
     * pre-edit text and leaves it selected, so the next keystroke replaces the
     * first character the user typed. Writes therefore wait for composition to
     * end, which keeps the plugin's sentinel bookkeeping intact and still leaves
     * the IME alone.
     *
     * The same window governs submit-time writes: a Draft rewrite that races the
     * commit events of a composition would apply to a stale draft and drop the
     * characters the user just committed.
     */
    const COMPOSITION_SETTLE_MS = 20

    function createCompositionGate(doc: Document) {
      let composing = false
      let composedUntil = 0
      const waiting = new Map<string, () => void>()
      const timers = new Set<ReturnType<typeof setTimeout>>()
      const later = (delay: number, run: () => void) => {
        const id = setTimeout(() => {
          timers.delete(id)
          run()
        }, delay)
        timers.add(id)
      }
      const flush = () => {
        // A composition that began while this flush was queued keeps its writes
        // parked; that composition's own end schedules the next flush.
        if (composing) return
        const pending = Array.from(waiting.values())
        waiting.clear()
        for (const write of pending) write()
      }
      const onCompositionStart = () => {
        composing = true
        composedUntil = 0
      }
      const onCompositionEnd = () => {
        composing = false
        composedUntil = Date.now() + COMPOSITION_SETTLE_MS
        if (waiting.size === 0) return
        // The commit's own beforeinput/input events — and the React state update
        // they carry — can still be in flight inside this handler, so the flush
        // runs a task later and every write computes against the settled draft.
        later(0, flush)
      }
      doc.addEventListener('compositionstart', onCompositionStart, true)
      doc.addEventListener('compositionend', onCompositionEnd, true)
      return {
        isComposing: () => composing,
        /** False while a just-committed composition may still be landing. */
        isSettled: () => !composing && Date.now() >= composedUntil,
        whenIdle(key: string, write: () => void) {
          if (composing) {
            waiting.set(key, write)
            return
          }
          write()
        },
        /**
         * Run one write against a settled draft: immediately when nothing is
         * pending, otherwise parked — and re-checked at fire time, so a
         * composition that opens in the meantime is never written into.
         */
        whenSettled(key: string, write: () => void) {
          if (this.isSettled()) {
            write()
            return
          }
          if (composing) {
            waiting.set(key, write)
            return
          }
          later(Math.max(0, composedUntil - Date.now()), () => {
            if (composing) {
              waiting.set(key, write)
              return
            }
            write()
          })
        },
        dispose() {
          for (const id of timers) clearTimeout(id)
          timers.clear()
          doc.removeEventListener('compositionstart', onCompositionStart, true)
          doc.removeEventListener('compositionend', onCompositionEnd, true)
          waiting.clear()
        },
      }
    }

    function FileAttachmentDock(props: DockProps) {
      const [node, setNode] = React.useState<HTMLDivElement | null>(null)
      const [portalTarget, setPortalTarget] = React.useState<HTMLDivElement | null>(null)
      const [, setAttachmentRevision] = React.useState(0)
      const attachments = draftAttachmentStore.get(props.sessionId)
      const live = React.useState<{ active: boolean; sessionId: string | undefined; cwd: string | undefined; draft: string; phase: string; actions: InputActions | undefined; gate: ReturnType<typeof createCompositionGate> | undefined; attachments: readonly DraftAttachment[]; refreshAttachments: (() => void) | undefined; nextId: number }>(() => ({
        active: false,
        sessionId: undefined,
        cwd: undefined,
        draft: '',
        phase: 'plain',
        actions: undefined,
        gate: undefined,
        attachments: EMPTY_ATTACHMENTS,
        refreshAttachments: undefined,
        nextId: 1,
      }))[0]
      const cwd = props.useSessions((snapshot) => {
        const session = snapshot.byId[props.sessionId]
        return session && typeof session.cwd === 'string' ? session.cwd : undefined
      })
      const refreshAttachments = () => setAttachmentRevision((current) => current + 1)
      const setAttachments = (update: AttachmentUpdate) => {
        const next = draftAttachmentStore.update(props.sessionId, update)
        refreshAttachments()
        return next
      }
      const openAttachment = (path: string) => {
        if (!isAbsolutePath(path) || typeof props.openPath !== 'function') return
        Promise.resolve(props.openPath(path)).catch((error) => {
          console.error('[dsh-file-drop-attachments] open failed', error)
        })
      }

      live.sessionId = props.sessionId
      live.cwd = cwd
      live.draft = props.input.draft
      live.phase = props.input.phase
      live.actions = props.inputActions
      live.attachments = attachments
      live.refreshAttachments = refreshAttachments

      /* Fold the pending attachment lines into the draft and retire the cards. */
      const writeAttachmentLines = () => {
        live.actions!.setDraft(appendAttachmentPaths(live.draft, live.attachments))
        draftAttachmentStore.clear(live.sessionId)
        live.refreshAttachments!()
      }

      /*
       * Send with the attachment lines injected. This write belongs to the submit
       * gesture, so it does not queue behind plugin bookkeeping — but it must not
       * run *inside* a composition either: Enter while composing belongs to the
       * candidate window, and rewriting the draft there is exactly what broke IME
       * input. A commit that has just landed is allowed to settle first, so the
       * rewrite applies to the committed text rather than a stale snapshot.
       */
      const submitAttachments = () => {
        if (live.attachments.length === 0 || live.actions === undefined || live.phase !== 'plain') {
          return false
        }
        if (live.gate !== undefined && live.gate.isComposing()) return false
        const sessionId = live.sessionId
        const run = () => {
          if (live.sessionId !== sessionId || live.actions === undefined || live.phase !== 'plain') return
          if (live.attachments.length === 0) return
          writeAttachmentLines()
          live.actions.submit()
        }
        if (live.gate === undefined) run()
        else live.gate.whenSettled('submit-attachments', run)
        return true
      }

      /*
       * The Cmd/Ctrl-accelerated chord resolves its own submit mode inside the
       * composer, so the plugin only folds the lines into the draft and lets the
       * composer's own keymap perform the send. That requires a settled draft:
       * a deferred write would land after the composer already read the draft.
       */
      const injectAttachmentLines = () => {
        if (live.attachments.length === 0 || live.actions === undefined || live.phase !== 'plain') {
          return false
        }
        if (live.gate !== undefined && !live.gate.isSettled()) return false
        writeAttachmentLines()
        return true
      }

      /*
       * The single door for plugin-owned draft writes. `compute` receives the
       * live draft and returns the next one, or undefined when nothing is due —
       * it is re-evaluated right before the write, never against a snapshot, so
       * a deferred write cannot resurrect stale text or reposition the caret
       * after the user has typed past it.
       */
      const writeDraft = (key: string, compute: (draft: string) => string | undefined) => {
        const run = () => {
          if (live.actions === undefined || live.phase !== 'plain') return
          const next = compute(live.draft)
          if (next === undefined || next === live.draft) return
          live.actions!.setDraft(next)
        }
        if (live.gate === undefined) {
          run()
          return
        }
        live.gate.whenIdle(key, run)
      }

      React.useLayoutEffect(() => {
        if (node === null || node.ownerDocument === null) return
        const gate = createCompositionGate(node.ownerDocument)
        live.gate = gate
        return () => {
          if (live.gate === gate) live.gate = undefined
          gate.dispose()
        }
      }, [node, live])

      React.useEffect(() => {
        if (props.input.phase !== 'plain' || props.inputActions === undefined) return
        const parsed = splitAttachmentText(props.input.draft)
        if (parsed.paths.length > 0) {
          const known = new Set(attachments.map((item) => item.path))
          const recovered = parsed.attachments
            .filter((item) => !known.has(item.path))
            .map((item) => ({
              id: live.nextId++,
              name: basename(item.path),
              path: item.path,
              copied: item.copied,
            }))
          if (recovered.length > 0) {
            draftAttachmentStore.set(props.sessionId, attachments.concat(recovered))
            refreshAttachments()
          }
          const restored = parsed.text + ATTACHMENT_SENTINEL
          if (restored !== props.input.draft) {
            writeDraft('restore-sentinel', (draft) => {
              const current = splitAttachmentText(draft)
              return current.paths.length === 0 ? undefined : current.text + ATTACHMENT_SENTINEL
            })
          }
          return
        }
        if (attachments.length > 0) {
          // The sentinel only exists to keep an otherwise empty draft non-empty,
          // which is what keeps the send affordance live. Once the draft holds
          // visible text the host already sees it as non-empty, so writing here
          // would only rebuild the draft under the user's caret — the exact
          // write that used to eat the first character of an IME composition.
          writeDraft('add-sentinel', (draft) => {
            if (draft.includes(ATTACHMENT_SENTINEL) || stripSentinel(draft) !== '') return undefined
            return draft + ATTACHMENT_SENTINEL
          })
          return
        }
        if (props.input.draft.includes(ATTACHMENT_SENTINEL)) {
          writeDraft('drop-sentinel', (draft) => {
            if (!draft.includes(ATTACHMENT_SENTINEL)) return undefined
            return stripSentinel(draft)
          })
        }
      }, [props.sessionId, props.input.draft, props.input.phase, props.inputActions, attachments])

      React.useEffect(() => {
        if (node === null || node.ownerDocument === null) return
        const seat = node.closest('[data-composer-seat]')
        if (seat === null) return

        const target = node.ownerDocument.createElement('div')
        target.className = 'dsh-fdrop-native-rail-host'
        target.hidden = true
        const mount = () => {
          const card = seat.querySelector('[data-composer-card]')
          const inputScroll = card === null ? null : card.querySelector('[data-input-scroll]')
          if (card !== null && inputScroll !== null && target.parentElement !== card) {
            card.insertBefore(target, inputScroll)
          }
        }
        mount()
        const observer = new MutationObserver(mount)
        observer.observe(seat, { childList: true, subtree: true })
        setPortalTarget(target)
        return () => {
          observer.disconnect()
          target.remove()
          setPortalTarget((current) => current === target ? null : current)
        }
      }, [node, props.sessionId])

      React.useEffect(() => {
        if (portalTarget === null) return
        portalTarget.hidden = attachments.length === 0
      }, [portalTarget, attachments.length])

      React.useEffect(() => {
        if (node === null || node.ownerDocument === null) return
        const doc = node.ownerDocument
        live.active = true

        const handleTransfer = (transfer: DataTransfer, source: string) => {
          const files = transferFiles(transfer)
          const nonImages = files.filter((file) => !isSupportedImage(file))
          const images = files.filter((file) => isSupportedImage(file))
          const hints = transferPathHints(transfer)
          const entries = nonImages.map((file, index) => ({
            name: file.name,
            hint: hintForFile(file, index, hints),
          }))

          replayImages(doc, images)
          if (entries.length === 0 || live.phase !== 'plain' || live.actions === undefined) return

          const target = {
            sessionId: live.sessionId,
            cwd: live.cwd,
            draft: live.draft,
            actions: live.actions,
          }
          resolveOrUploadDroppedFiles(target.sessionId!, target.cwd, nonImages, entries).then((resolved) => {
            const added = resolved.map((item, index) => ({
              id: live.nextId++,
              name: entries[index] ? entries[index].name : basename(item.path),
              path: item.path,
              copied: item.copied,
            })).filter((item) => isAbsolutePath(item.path))
            if (added.length === 0) {
              console.warn(`[dsh-file-drop-attachments] ${source} contained no usable file`)
              return
            }
            draftAttachmentStore.update(target.sessionId, (current) => current.concat(added))
            if (live.active && live.sessionId === target.sessionId) live.refreshAttachments!()
            const currentDraft = live.active && live.sessionId === target.sessionId
              ? live.draft
              : target.draft
            /*
             * Re-read the draft at write time: a gated write can land after the
             * user typed (or committed an IME composition) into the composer, and
             * reusing the snapshot taken here would overwrite that text.
             */
            const writeSentinel = () => {
              const draft = live.sessionId === target.sessionId ? live.draft : currentDraft
              if (draft.includes(ATTACHMENT_SENTINEL)) return
              target.actions.setDraft(draft + ATTACHMENT_SENTINEL)
            }
            // Only the session the composer is showing can be mid-composition.
            if (live.gate === undefined || live.sessionId !== target.sessionId) writeSentinel()
            else live.gate.whenIdle('add-sentinel', writeSentinel)
          }).catch((error) => {
            console.error(`[dsh-file-drop-attachments] ${source} processing failed`, error)
          })
        }

        const interceptDrag = (event: DragEvent) => {
          const transfer = event.dataTransfer
          if (transfer === null || !requiresCustomDropHandling(transfer)) return
          event.preventDefault()
          event.stopImmediatePropagation()
          transfer.dropEffect = 'copy'
        }

        const onDrop = (event: DragEvent) => {
          const transfer = event.dataTransfer
          if (transfer === null || !requiresCustomDropHandling(transfer)) return
          event.preventDefault()
          event.stopImmediatePropagation()
          handleTransfer(transfer, 'drop')
        }

        const onPaste = (event: ClipboardEvent) => {
          const transfer = event.clipboardData
          if (transfer === null || !requiresCustomDropHandling(transfer)) return
          event.preventDefault()
          event.stopImmediatePropagation()
          handleTransfer(transfer, 'paste')
        }

        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'Enter' || event.shiftKey || event.repeat) return
          if (event.isComposing || event.keyCode === 229) return
          if (!isComposerInput(event.target)) return
          if (event.ctrlKey || event.metaKey) {
            // Accelerated send: the composer owns the submit mode, so only fold the
            // lines in and let its own keymap send.
            injectAttachmentLines()
            return
          }
          // Only claim the key when the plugin actually owns this send; a declined
          // submit leaves Enter to the composer and to the IME.
          if (submitAttachments() === false) return
          event.preventDefault()
          event.stopImmediatePropagation()
        }

        const onClick = (event: MouseEvent) => {
          const target = event.target as Element | null
          if (!target || typeof target.closest !== 'function') return
          const button = target.closest('button')
          if (button === null || button.disabled) return
          if (button.closest('[data-composer-card]') === null) return
          if (!isSendButton(button)) return
          if (submitAttachments() === false) return
          event.preventDefault()
          event.stopImmediatePropagation()
        }

        doc.addEventListener('dragenter', interceptDrag, true)
        doc.addEventListener('dragover', interceptDrag, true)
        doc.addEventListener('drop', onDrop, true)
        doc.addEventListener('paste', onPaste, true)
        doc.addEventListener('keydown', onKeyDown, true)
        doc.addEventListener('click', onClick, true)
        return () => {
          live.active = false
          doc.removeEventListener('dragenter', interceptDrag, true)
          doc.removeEventListener('dragover', interceptDrag, true)
          doc.removeEventListener('drop', onDrop, true)
          doc.removeEventListener('paste', onPaste, true)
          doc.removeEventListener('keydown', onKeyDown, true)
          doc.removeEventListener('click', onClick, true)
        }
      }, [node, live])

      const removeAttachment = (id: number) => {
        const next = attachments.filter((item) => item.id !== id)
        setAttachments(next)
        if (next.length === 0 && live.actions !== undefined) {
          live.actions!.setDraft(stripSentinel(live.draft))
        }
      }

      const rail = React.createElement('div', {
        className: 'dsh-fdrop-native-rail',
      }, ...attachments.map((item) => {
        const kind = iconKind(item.name)
        return React.createElement('div', {
          key: item.id,
          className: 'dsh-fdrop-card',
          'data-attachment-path': item.path,
          'data-attachment-copy': item.copied ? 'true' : 'false',
          title: item.copied ? `${item.path}（浏览器上传副本）` : item.path,
          role: 'button',
          tabIndex: 0,
          onClick: () => openAttachment(item.path),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            openAttachment(item.path)
          },
        },
        React.createElement('span', {
          className: `dsh-fdrop-icon dsh-fdrop-icon-${kind}`,
        }, React.createElement(FileTypeIcon, { kind })),
        React.createElement('span', { className: 'dsh-fdrop-copy' },
          React.createElement('span', { className: 'dsh-fdrop-name' }, item.name),
          React.createElement('span', { className: 'dsh-fdrop-extension' }, item.copied ? `${typeLabel(item.name)} · 副本` : typeLabel(item.name))),
        React.createElement('button', {
          type: 'button',
          className: 'dsh-fdrop-remove',
          title: `移除 ${item.name}`,
          'aria-label': `移除附件 ${item.name}`,
          onClick: (event) => {
            event.stopPropagation()
            removeAttachment(item.id)
          },
        }, React.createElement(CloseIcon)))
      }))

      return React.createElement(React.Fragment, null,
        React.createElement('span', {
          ref: setNode,
          className: 'dsh-fdrop-anchor',
          'aria-hidden': true,
        }),
        portalTarget === null ? null : ReactDOM.createPortal(rail, portalTarget))
    }

    const CSS = `
      .dsh-fdrop-anchor {
        position: fixed;
        width: 0;
        height: 0;
        overflow: hidden;
        pointer-events: none;
      }
      .dsh-fdrop-native-rail-host {
        box-sizing: border-box;
        min-width: 0;
        padding: 0 16px;
      }
      .dsh-fdrop-native-rail-host[hidden] {
        display: none;
      }
      .dsh-fdrop-native-rail {
        box-sizing: border-box;
        width: 100%;
        min-width: 0;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      .dsh-fdrop-card {
        box-sizing: border-box;
        position: relative;
        width: 208px;
        max-width: 100%;
        min-width: 0;
        height: 56px;
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 7px 28px 7px 8px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-specific-input-major);
        box-shadow: 0 1px 2px rgba(0, 0, 0, .14);
        cursor: pointer;
      }
      .dsh-fdrop-card:hover {
        border-color: var(--dsw-alias-border-l1, var(--dsw-alias-border-l2));
        background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-specific-input-major));
      }
      .dsh-fdrop-card:focus-visible {
        outline: 2px solid var(--dsw-alias-focus-primary, currentColor);
        outline-offset: 1px;
      }
      .dsh-fdrop-sent-rail {
        justify-content: flex-end;
      }
      .dsh-fdrop-sent-card {
        padding-right: 8px;
        font: inherit;
        text-align: left;
      }
      .dsh-fdrop-source-bubble {
        display: none !important;
      }
      .dsh-fdrop-icon {
        box-sizing: border-box;
        width: 34px;
        height: 40px;
        flex: 0 0 34px;
        display: inline-grid;
        place-items: center;
        border-radius: 7px;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-module-platform);
      }
      .dsh-fdrop-icon-pdf { color: #ef4444; background: rgba(239, 68, 68, .1); }
      .dsh-fdrop-icon-code { color: var(--dsw-alias-label-primary); }
      .dsh-fdrop-icon-archive { color: #d6a84b; }
      .dsh-fdrop-icon-table { color: #40a76b; }
      .dsh-fdrop-copy {
        min-width: 0;
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 1px;
      }
      .dsh-fdrop-name {
        min-width: 0;
        overflow: hidden;
        color: var(--dsw-alias-label-primary);
        font-size: 14px;
        font-weight: 600;
        line-height: 18px;
        letter-spacing: 0;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-fdrop-extension {
        overflow: hidden;
        color: var(--dsw-alias-label-tertiary);
        font-size: 11px;
        font-weight: 500;
        line-height: 15px;
        letter-spacing: 0;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dsh-fdrop-remove {
        box-sizing: border-box;
        position: absolute;
        top: 5px;
        right: 5px;
        width: 18px;
        height: 18px;
        display: inline-grid;
        place-items: center;
        padding: 0;
        border: 0;
        border-radius: 50%;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-module-platform);
        cursor: pointer;
      }
      .dsh-fdrop-remove:hover {
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-interactive-bg-hover);
      }
      .dsh-fdrop-remove:focus-visible {
        outline: 2px solid var(--dsw-alias-focus-primary, currentColor);
        outline-offset: 1px;
      }
      @media (max-width: 520px) {
        .dsh-fdrop-card { width: 100%; }
      }
    `

    const plugin = {
      name: 'dsh-file-drop-attachments',
      inject: ['slots'],
      apply(ctx: ClientContext) {
        const slots = ctx.slots
        if (slots === undefined) return
        const openPath = (path: string) => {
          const remote = ctx.get('remote')
          const opener = remote?.session?.openWorkspacePath
          if (typeof opener === 'function') {
            return Promise.resolve(opener.call(remote!.session, { path })).then((result) => {
              if (result !== undefined && result !== null && result.ok === false) {
                throw new Error(result.error?.message ?? 'path open failed')
              }
              return result
            })
          }
          const workspaces = ctx.get('workspaces')
          if (workspaces !== undefined && typeof workspaces.openPath === 'function') {
            return workspaces.openPath(path)
          }
          return Promise.reject(new Error('workspace path opener unavailable'))
        }
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-file-drop-attachments'
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'file-drop-attachments: styles')
        ctx.effect(() => observeSentAttachments(document, openPath), 'file-drop-attachments: sent cards')
        slots.inject('conversation.input.dock', () => slots.register({
          name: 'conversation.input.dock',
          id: 'file-drop-attachments',
          order: 30,
          label: '文件附件',
          // `sessionId` is already a standard prop of session-scoped slots in both
          // generations; passing it here spreads the same value and keeps the entry
          // working if a runtime ever stops providing it.
          inject: (sessionId) => ({ openPath, sessionId }),
        }, FileAttachmentDock))
      },
    }

    return {
      default: plugin,
      __test: {
        appendAttachmentPaths,
        createCompositionGate,
        createDraftAttachmentStore,
        hintForFile,
        isAbsolutePath,
        isComposerInput,
        isSendButton,
        requiresCustomDropHandling,
        resolveOrUploadDroppedFiles,
        splitAttachmentText,
        uploadDroppedFile,
      },
    }
  },
})
