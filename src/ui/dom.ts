/**
 * The smallest DOM helpers the UI needs.
 *
 * There is no framework here on purpose: a card game is animation-heavy and stateful
 * in ways a reconciler fights, and the whole table is under 200 nodes. What is left is
 * small enough to keep in one file.
 */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

/**
 * `el('div.tile', { 'aria-label': 'Serra Angel' }, child)` — the tag string carries
 * classes so markup reads like the CSS it pairs with.
 *
 * The element type is a caller-supplied generic rather than inferred from the tag,
 * because the tag arrives inside a string that also carries classes. Pass it when you
 * need the concrete interface: `el<HTMLButtonElement>('button.act')`.
 */
export function el<T extends HTMLElement = HTMLElement>(
  spec: string,
  attrsOrChild: Attrs | Child = {},
  ...rest: Child[]
): T {
  const isAttrs =
    attrsOrChild !== null &&
    typeof attrsOrChild === 'object' &&
    !(attrsOrChild instanceof Node);
  const attrs: Attrs = isAttrs ? (attrsOrChild as Attrs) : {};
  const children: Child[] = isAttrs ? rest : [attrsOrChild as Child, ...rest];

  const [tag = 'div', ...classes] = spec.split('.');
  const node = document.createElement(tag) as T;
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('data') || key.startsWith('aria') || key === 'role') {
      node.setAttribute(key.replace(/^data([A-Z])/, (_, c: string) => `data-${c.toLowerCase()}`), String(value));
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function on<K extends keyof HTMLElementEventMap>(
  node: Element,
  type: K,
  handler: (ev: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  node.addEventListener(type, handler as EventListener, opts);
  return () => node.removeEventListener(type, handler as EventListener, opts);
}

/** Waits for a CSS transition or animation on `node`, with a timeout so a dropped
 *  transitionend event can never wedge the animation queue. */
export function settled(node: Element, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      node.removeEventListener('transitionend', finish);
      node.removeEventListener('animationend', finish);
      resolve();
    };
    node.addEventListener('transitionend', finish, { once: true });
    node.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

export const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Forces a style flush so a class added immediately after a node is inserted still
 *  animates instead of being coalesced into the initial paint. */
export function reflow(node: Element): void {
  void (node as HTMLElement).offsetHeight;
}
