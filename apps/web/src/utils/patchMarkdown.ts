/** Accept only HTML produced by renderMarkdown's sanitizer, never raw model HTML.
 * Keep unchanged paragraphs, code nodes and the growing text node attached. This
 * also preserves selection and avoids repainting the whole tail on each token.
 */
export function patchMarkdown(root: HTMLElement, sanitizedHtml: string): void {
  const next = document.createElement('template')
  next.innerHTML = sanitizedHtml
  patchChildren(root, next.content)
}

function patchChildren(current: Node, next: Node): void {
  const incoming = Array.from(next.childNodes)
  incoming.forEach((replacement, index) => {
    const existing = current.childNodes[index]
    if (!existing) { current.appendChild(replacement.cloneNode(true)); return }
    if (existing.isEqualNode(replacement)) return
    if (existing.nodeType !== replacement.nodeType || existing.nodeName !== replacement.nodeName) {
      current.replaceChild(replacement.cloneNode(true), existing)
    } else if (existing instanceof Text && replacement instanceof Text) {
      if (replacement.data.startsWith(existing.data)) existing.appendData(replacement.data.slice(existing.length))
      else existing.data = replacement.data
    } else if (existing instanceof Element && replacement instanceof Element) {
      for (const attr of Array.from(existing.attributes)) {
        if (!replacement.hasAttribute(attr.name)) existing.removeAttribute(attr.name)
      }
      for (const attr of Array.from(replacement.attributes)) {
        if (existing.getAttribute(attr.name) !== attr.value) existing.setAttribute(attr.name, attr.value)
      }
      // The delegated copy handler owns this temporary feedback label.
      if (!existing.matches('button[data-copy-code]')) patchChildren(existing, replacement)
    } else {
      current.replaceChild(replacement.cloneNode(true), existing)
    }
  })
  while (current.childNodes.length > incoming.length) current.lastChild!.remove()
}
