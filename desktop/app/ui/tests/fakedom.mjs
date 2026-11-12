// tests/fakedom.mjs: a small DOM for node:test (no jsdom: nothing is installed). Enough for the frame and the lx- components: elements with attributes,
// dataset, classList, style custom properties, text nodes, querySelector(All) / closest / matches over simple selectors (tag, #id, .class, [attr],
// [attr=value], :not(simple), comma lists, the descendant combinator), events with capture + bubble, focus / blur with focusin / focusout, click().
// install() sets globalThis.document / Node / window and returns the document. Not a browser: layout is all zeros.

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

class FEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true, cancelable: true, key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, relatedTarget: null }, init);
    this.type = type;
    this.defaultPrevented = false;
    this._stop = false;
    this._path = [];
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation() {
    this._stop = true;
  }
  stopImmediatePropagation() {
    this._stop = true;
  }
  composedPath() {
    return this._path.slice();
  }
}

class FNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
    this._listeners = new Map();
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== "" && v !== null && v !== undefined) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }
  _adopt(n) {
    if (typeof n === "string" || typeof n === "number") return this.ownerDocument.createTextNode(String(n));
    if (n.parentNode) n.parentNode.removeChild(n);
    return n;
  }
  appendChild(n) {
    n = this._adopt(n);
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  removeChild(n) {
    const i = this.childNodes.indexOf(n);
    if (i >= 0) this.childNodes.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  insertBefore(n, ref) {
    n = this._adopt(n);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n);
    else this.childNodes.splice(i, 0, n);
    return n;
  }
  append(...nodes) {
    for (const n of nodes.flat()) if (n !== null && n !== undefined) this.appendChild(n);
  }
  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes.flat()) if (n !== null && n !== undefined) this.insertBefore(n, first);
  }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  before(...nodes) {
    const p = this.parentNode;
    for (const n of nodes) p.insertBefore(n, this);
  }
  after(...nodes) {
    const p = this.parentNode;
    const i = p.childNodes.indexOf(this);
    const ref = p.childNodes[i + 1] || null;
    for (const n of nodes) p.insertBefore(n, ref);
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  addEventListener(type, fn, opts) {
    const capture = opts === true || !!(opts && opts.capture);
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push({ fn, capture });
  }
  removeEventListener(type, fn, opts) {
    const capture = opts === true || !!(opts && opts.capture);
    const l = this._listeners.get(type) || [];
    const i = l.findIndex((x) => x.fn === fn && x.capture === capture);
    if (i >= 0) l.splice(i, 1);
  }
  dispatchEvent(ev) {
    const path = [];
    for (let n = this; n; n = n.parentNode) path.push(n);
    if (path[path.length - 1] === this.ownerDocument && this.ownerDocument.defaultView) path.push(this.ownerDocument.defaultView);
    ev.target = this;
    ev._path = path;
    const run = (node, capture) => {
      for (const l of [...(node._listeners.get(ev.type) || [])]) {
        if (node !== this && l.capture !== capture) continue;
        ev.currentTarget = node;
        l.fn.call(node, ev);
      }
    };
    for (let i = path.length - 1; i > 0 && !ev._stop; i--) run(path[i], true);
    if (!ev._stop) run(this, null);
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) run(path[i], false);
    return !ev.defaultPrevented;
  }
}

class FText extends FNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
  set textContent(v) {
    this.data = String(v);
  }
}

// ---- selectors ----
function parseCompound(s) {
  const parts = { tag: null, id: null, classes: [], attrs: [], nots: [] };
  let rest = s.trim();
  const take = (re) => {
    const m = re.exec(rest);
    if (!m) return null;
    rest = rest.slice(m[0].length);
    return m;
  };
  let m = take(/^[a-zA-Z][a-zA-Z0-9-]*|^\*/);
  if (m && m[0] !== "*") parts.tag = m[0].toUpperCase();
  while (rest.length) {
    if ((m = take(/^#([\w-]+)/))) parts.id = m[1];
    else if ((m = take(/^\.([\w-]+)/))) parts.classes.push(m[1]);
    else if ((m = take(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/))) parts.attrs.push([m[1], m[2] ?? m[3] ?? m[4] ?? null]);
    else if ((m = take(/^:not\(([^()]*)\)/))) parts.nots.push(parseCompound(m[1]));
    else throw new Error(`fakedom: unsupported selector part "${rest}" in "${s}"`);
  }
  return parts;
}
function matchCompound(el, p) {
  if (el.nodeType !== 1) return false;
  if (p.tag && el.tagName.toUpperCase() !== p.tag) return false;
  if (p.id && el.getAttribute("id") !== p.id) return false;
  for (const c of p.classes) if (!el.classList.contains(c)) return false;
  for (const [a, v] of p.attrs) {
    if (!el.hasAttribute(a)) return false;
    if (v !== null && el.getAttribute(a) !== v) return false;
  }
  for (const n of p.nots) if (matchCompound(el, n)) return false;
  return true;
}
function parseSelector(sel) {
  return sel.split(",").map((alt) => alt.trim().split(/\s+/).map(parseCompound));
}
function matchChain(el, chain) {
  if (!matchCompound(el, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let a = el.parentNode; a && i >= 0; a = a.parentNode) if (a.nodeType === 1 && matchCompound(a, chain[i])) i--;
  return i < 0;
}
const matches = (el, sel) => parseSelector(sel).some((ch) => matchChain(el, ch));

class FElement extends FNode {
  constructor(doc, tag, ns = null) {
    super(doc);
    this.nodeType = 1;
    this.tagName = ns ? tag : String(tag).toUpperCase();
    this.namespaceURI = ns;
    this._attrs = new Map();
    this._props = { value: "", checked: false, disabled: false };
    const el = this;
    this.dataset = new Proxy(
      {},
      {
        get: (_, k) => (typeof k === "string" ? el.getAttribute("data-" + kebab(k)) ?? undefined : undefined),
        set: (_, k, v) => (el.setAttribute("data-" + kebab(k), String(v)), true),
        deleteProperty: (_, k) => (el.removeAttribute("data-" + kebab(k)), true),
        has: (_, k) => el.hasAttribute("data-" + kebab(k)),
        ownKeys: () => [...el._attrs.keys()].filter((a) => a.startsWith("data-")).map((a) => camel(a.slice(5))),
        getOwnPropertyDescriptor: (_, k) => (el.hasAttribute("data-" + kebab(k)) ? { enumerable: true, configurable: true, value: el.getAttribute("data-" + kebab(k)) } : undefined),
      },
    );
    const vars = new Map();
    this.style = { setProperty: (k, v) => vars.set(k, String(v)), getPropertyValue: (k) => vars.get(k) ?? "", removeProperty: (k) => vars.delete(k) };
    this.classList = {
      _get: () => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean),
      _set: (list) => el.setAttribute("class", list.join(" ")),
      add: (...cs) => el.classList._set([...new Set([...el.classList._get(), ...cs.filter(Boolean)])]),
      remove: (...cs) => el.classList._set(el.classList._get().filter((c) => !cs.includes(c))),
      contains: (c) => el.classList._get().includes(c),
      toggle: (c, on) => {
        const v = on === undefined ? !el.classList.contains(c) : !!on;
        if (v) el.classList.add(c);
        else el.classList.remove(c);
        return v;
      },
    };
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  getAttribute(k) {
    return this._attrs.has(k) ? this._attrs.get(k) : null;
  }
  setAttribute(k, v) {
    this._attrs.set(k, String(v));
  }
  removeAttribute(k) {
    this._attrs.delete(k);
  }
  hasAttribute(k) {
    return this._attrs.has(k);
  }
  getAttributeNames() {
    return [...this._attrs.keys()];
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  set id(v) {
    this.setAttribute("id", v);
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  set className(v) {
    this.setAttribute("class", v);
  }
  get hidden() {
    return this.hasAttribute("hidden");
  }
  set hidden(v) {
    if (v) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }
  get inert() {
    return this.hasAttribute("inert");
  }
  set inert(v) {
    if (v) this.setAttribute("inert", "");
    else this.removeAttribute("inert");
  }
  get disabled() {
    return this.hasAttribute("disabled");
  }
  set disabled(v) {
    if (v) this.setAttribute("disabled", "");
    else this.removeAttribute("disabled");
  }
  get tabIndex() {
    const t = this.getAttribute("tabindex");
    return t === null ? (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(this.tagName) ? 0 : -1) : Number(t);
  }
  set tabIndex(v) {
    this.setAttribute("tabindex", String(v));
  }
  get value() {
    return this._props.value;
  }
  set value(v) {
    this._props.value = String(v ?? "");
  }
  get checked() {
    return this._props.checked;
  }
  set checked(v) {
    this._props.checked = !!v;
  }
  get placeholder() {
    return this.getAttribute("placeholder") || "";
  }
  set placeholder(v) {
    this.setAttribute("placeholder", v);
  }
  matches(sel) {
    return matches(this, sel);
  }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n;
    return null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
  scrollIntoView() {}
  get scrollTop() {
    return 0;
  }
  set scrollTop(_) {}
  focus() {
    const doc = this.ownerDocument;
    if (this.disabled || doc.activeElement === this) return;
    const prev = doc.activeElement;
    doc.activeElement = this;
    if (prev && prev !== doc.body) prev.dispatchEvent(new FEvent("focusout", { relatedTarget: this }));
    this.dispatchEvent(new FEvent("focus", { bubbles: false }));
    this.dispatchEvent(new FEvent("focusin", { relatedTarget: prev && prev !== doc.body ? prev : null }));
  }
  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc.activeElement = doc.body;
    this.dispatchEvent(new FEvent("focusout", { relatedTarget: null }));
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent(new FEvent("click"));
  }
}

class FDocument extends FNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = new FElement(this, "html");
    this.body = new FElement(this, "body");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
    const view = new FNode(this);
    Object.assign(view, { innerWidth: 1280, innerHeight: 800, document: this });
    this.defaultView = view;
  }
  createElement(tag) {
    return new FElement(this, tag);
  }
  createElementNS(ns, tag) {
    return new FElement(this, tag, ns);
  }
  createTextNode(t) {
    return new FText(this, String(t));
  }
  getElementById(id) {
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelector(sel) {
    return this.documentElement.matches(sel) ? this.documentElement : this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel) {
    return this.documentElement.querySelectorAll(sel);
  }
}

/** A fresh document installed as the global one (document, Node, window). */
export function install() {
  const doc = new FDocument();
  globalThis.document = doc;
  globalThis.Node = FNode;
  globalThis.window = doc.defaultView;
  return doc;
}

/** Fire a key on `el` (keydown, bubbling). Returns the event. */
export function key(el, k, mods = {}) {
  const ev = new FEvent("keydown", { key: k, ...mods });
  el.dispatchEvent(ev);
  return ev;
}

export function fire(el, type, init = {}) {
  const ev = new FEvent(type, init);
  el.dispatchEvent(ev);
  return ev;
}

/** Text of an element with its whitespace collapsed. */
export const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

export { FEvent };
