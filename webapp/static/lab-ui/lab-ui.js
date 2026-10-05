/* ============================================================================
   lab-ui — shared interface kit for the hubmerto tools (script, no deps)

   window.LabUI = {
     shell(opts)        builds the app frame: top bar, side column, viewport, status strip
     Pane               Tweakpane-compatible subset: addFolder / addBinding / addButton /
                        addBlade({view:'list'}) / addButtons / addStatus / addProgress /
                        addPresets / addNote / addSeparator / refresh / on('change')
     fmt(value, step)   number formatting shared by every slider
   }

   Binding options: { label, min, max, step, options, view, readonly, format, unit,
                      hidden, disabled, onChange }
     view: 'slider' (number, default) | 'list' | 'checkbox' | 'color' | 'text' |
           'textarea' | 'graph' (readonly monitor)
   Every control returns an object with .on(event, fn), .refresh(), .hidden, .disabled,
   .label, .element, and for bindings .value (get/set, writes through to the object).
   ============================================================================ */
(function (global) {
  'use strict';

  const doc = global.document;
  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function decimals(step) {
    if (!isFinite(step) || step <= 0) return 2;
    const s = String(step);
    if (s.includes('e-')) return +s.split('e-')[1];
    const i = s.indexOf('.');
    return i < 0 ? 0 : s.length - i - 1;
  }
  function fmt(v, step, unit) {
    if (typeof v !== 'number' || !isFinite(v)) return String(v);
    const d = step != null ? decimals(step) : (Number.isInteger(v) ? 0 : 2);
    return v.toFixed(d) + (unit || '');
  }

  // ---------------------------------------------------------------- emitter
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    off(ev, fn) { const a = this._h[ev]; if (a) this._h[ev] = a.filter((f) => f !== fn); return this; }
    emit(ev, payload) { (this._h[ev] || []).forEach((f) => f(payload)); }
  }

  // ---------------------------------------------------------------- base control
  class Control extends Emitter {
    constructor(parent, element) {
      super();
      this.parent = parent;
      this.element = element;
      this._hidden = false;
      this._disabled = false;
    }
    get hidden() { return this._hidden; }
    set hidden(v) { this._hidden = !!v; this.element.hidden = this._hidden; }
    get disabled() { return this._disabled; }
    set disabled(v) { this._disabled = !!v; this.element.classList.toggle('lab-disabled', this._disabled); }
    dispose() { this.element.remove(); if (this.parent) this.parent._children = this.parent._children.filter((c) => c !== this); }
    refresh() {}
  }

  // ---------------------------------------------------------------- binding
  class Binding extends Control {
    constructor(parent, obj, key, o) {
      const row = el('div', 'lab-row');
      super(parent, row);
      this.obj = obj; this.key = key; this.opts = o = o || {};
      this._label = el('label', null, o.label != null ? o.label : key);
      row.appendChild(this._label);
      const v = obj[key];
      let view = o.view;
      if (!view) {
        if (o.options) view = 'list';
        else if (typeof v === 'boolean') view = 'checkbox';
        else if (typeof v === 'number') view = 'slider';
        else if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) view = 'color';
        else view = 'text';
      }
      this.view = view;
      const build = Binding.views[view] || Binding.views.text;
      build.call(this, row, o);
      if (o.hidden) this.hidden = true;
      if (o.disabled) this.disabled = true;
      if (o.onChange) this.on('change', (ev) => o.onChange(ev.value, ev));
    }
    get label() { return this._label.textContent; }
    set label(t) { this._label.textContent = t; }
    get value() { return this.obj[this.key]; }
    set value(v) { this.obj[this.key] = v; this.refresh(); }
    _commit(v, last) {
      this.obj[this.key] = v;
      this.refresh();
      this.emit('change', { value: v, last: last !== false, target: this });
    }
  }
  Binding.views = {};

  // number slider (Blender-style): drag to scrub, click to type, arrows to nudge
  Binding.views.slider = function (row, o) {
    const min = o.min, max = o.max;
    const hasRange = typeof min === 'number' && typeof max === 'number' && max > min;
    const step = o.step != null ? o.step : (hasRange ? (max - min) / 100 : 1);
    const isInt = decimals(step) === 0;
    const w = el('div', 'lab-widget lab-num' + (isInt ? ' lab-int' : ''));
    const fill = el('div', 'lab-fill');
    const val = el('div', 'lab-val');
    const input = el('input'); input.type = 'text'; input.spellcheck = false;
    w.append(fill, val, input); row.appendChild(w);
    w.tabIndex = 0;
    const read = () => {
      let v = +this.obj[this.key]; if (!isFinite(v)) v = 0;
      return v;
    };
    const snap = (v) => {
      if (hasRange) v = clamp(v, min, max);
      if (step > 0 && isFinite(step)) v = Math.round(v / step) * step;
      return +v.toFixed(Math.min(10, decimals(step) + 2));
    };
    const paint = () => {
      const v = read();
      val.textContent = '';
      val.appendChild(el('span', null, (o.format ? o.format(v) : fmt(v, step, o.unit))));
      fill.style.width = hasRange ? (((v - min) / (max - min)) * 100).toFixed(2) + '%' : '0%';
    };
    this.refresh = paint;
    paint();
    if (o.readonly) { w.classList.add('lab-disabled'); return; }

    // drag
    let drag = null;
    w.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || w.classList.contains('editing')) return;
      drag = { x: e.clientX, v: read(), moved: false };
      w.setPointerCapture(e.pointerId);
    });
    w.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (!drag.moved && Math.abs(dx) < 3) return;
      drag.moved = true;
      const width = Math.max(60, w.clientWidth);
      const span = hasRange ? (max - min) : Math.max(Math.abs(drag.v), 1) * 2;
      const fine = e.shiftKey ? 0.1 : 1;
      const v = snap(drag.v + (dx / width) * span * fine);
      if (v !== read()) this._commit(v, false);
    });
    const endDrag = (e) => {
      if (!drag) return;
      const moved = drag.moved; drag = null;
      try { w.releasePointerCapture(e.pointerId); } catch (_) {}
      if (moved) this._commit(read(), true);
      else beginEdit();
    };
    w.addEventListener('pointerup', endDrag);
    w.addEventListener('pointercancel', () => { drag = null; });
    // wheel nudges (only while hovered and focused, to not fight scroll)
    w.addEventListener('wheel', (e) => {
      if (doc.activeElement !== w) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      this._commit(snap(read() + dir * step * (e.shiftKey ? 10 : 1)), true);
    }, { passive: false });
    w.addEventListener('keydown', (e) => {
      if (w.classList.contains('editing')) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); this._commit(snap(read() - step * (e.shiftKey ? 10 : 1)), true); }
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); this._commit(snap(read() + step * (e.shiftKey ? 10 : 1)), true); }
      if (e.key === 'Enter') beginEdit();
    });
    const beginEdit = () => {
      w.classList.add('editing');
      input.value = String(read());
      input.focus(); input.select();
    };
    const endEdit = (apply) => {
      if (!w.classList.contains('editing')) return;
      w.classList.remove('editing');
      if (apply) {
        let txt = input.value.trim().replace(',', '.');
        let v = NaN;
        try { if (/^[-+*/().\d\s%]+$/.test(txt)) v = Function('"use strict";return (' + txt.replace(/%/g, '/100') + ')')(); } catch (_) {}
        if (isFinite(v)) this._commit(snap(+v), true);
      }
      w.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
      if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => endEdit(true));
  };

  Binding.views.list = function (row, o) {
    const w = el('div', 'lab-widget lab-select');
    const s = el('select');
    const opts = normalizeOptions(o.options);
    opts.forEach(({ text, value }) => { const op = el('option', null, text); op.value = String(value); s.appendChild(op); });
    w.appendChild(s); row.appendChild(w);
    const typed = (str) => {
      const hit = opts.find((x) => String(x.value) === str);
      return hit ? hit.value : str;
    };
    this.refresh = () => { s.value = String(this.obj[this.key]); };
    this.refresh();
    s.addEventListener('change', () => this._commit(typed(s.value), true));
    this.setOptions = (next) => {
      s.textContent = '';
      opts.length = 0; normalizeOptions(next).forEach((x) => opts.push(x));
      opts.forEach(({ text, value }) => { const op = el('option', null, text); op.value = String(value); s.appendChild(op); });
      this.refresh();
    };
    if (o.readonly) s.disabled = true;
  };

  Binding.views.checkbox = function (row, o) {
    row.classList.add('lab-check-row');
    const lab = el('label', 'lab-check');
    const i = el('input'); i.type = 'checkbox';
    const box = el('span', 'lab-box');
    lab.append(i, box); row.appendChild(lab);
    this.refresh = () => { i.checked = !!this.obj[this.key]; };
    this.refresh();
    i.addEventListener('change', () => this._commit(i.checked, true));
    row.querySelector('label').addEventListener('click', () => { if (!o.readonly) { i.checked = !i.checked; this._commit(i.checked, true); } });
    if (o.readonly) i.disabled = true;
  };

  Binding.views.color = function (row, o) {
    const w = el('div', 'lab-widget lab-color');
    const i = el('input'); i.type = 'color';
    const hex = el('span', 'lab-hex');
    w.append(i, hex); row.appendChild(w);
    this.refresh = () => { const v = String(this.obj[this.key] || '#000000'); i.value = v.length === 7 ? v : '#000000'; hex.textContent = v.toUpperCase(); };
    this.refresh();
    i.addEventListener('input', () => this._commit(i.value, false));
    i.addEventListener('change', () => this._commit(i.value, true));
    if (o.readonly) i.disabled = true;
  };

  Binding.views.text = function (row, o) {
    const w = el('div', 'lab-widget lab-text');
    const i = el('input'); i.type = 'text'; i.spellcheck = false;
    if (o.placeholder) i.placeholder = o.placeholder;
    w.appendChild(i); row.appendChild(w);
    this.refresh = () => { if (doc.activeElement !== i) i.value = this.obj[this.key] == null ? '' : String(this.obj[this.key]); };
    this.refresh();
    i.addEventListener('input', () => this._commit(i.value, false));
    i.addEventListener('change', () => this._commit(i.value, true));
    i.addEventListener('keydown', (e) => e.stopPropagation());
    if (o.readonly) i.readOnly = true;
  };

  Binding.views.textarea = function (row, o) {
    row.classList.add('lab-full');
    const w = el('div', 'lab-widget lab-text lab-multi');
    const i = el('textarea'); i.rows = o.rows || 2; i.spellcheck = false;
    if (o.placeholder) i.placeholder = o.placeholder;
    w.appendChild(i); row.appendChild(w);
    this._label.hidden = !o.label;
    if (o.label) row.classList.remove('lab-full');
    this.refresh = () => { if (doc.activeElement !== i) i.value = this.obj[this.key] == null ? '' : String(this.obj[this.key]); };
    this.refresh();
    i.addEventListener('input', () => this._commit(i.value, false));
    i.addEventListener('change', () => this._commit(i.value, true));
    i.addEventListener('keydown', (e) => e.stopPropagation());
  };

  // readonly monitor: samples obj[key] on an interval and draws a line
  Binding.views.graph = function (row, o) {
    const w = el('div', 'lab-widget lab-graph');
    const c = el('canvas'); w.appendChild(c); row.appendChild(w);
    const min = o.min != null ? o.min : 0, max = o.max != null ? o.max : 1;
    const n = o.samples || 64, hist = new Float32Array(n); let head = 0;
    const ctx = c.getContext('2d');
    const draw = () => {
      const r = w.getBoundingClientRect();
      const dpr = Math.min(2, global.devicePixelRatio || 1);
      if (c.width !== Math.round(r.width * dpr) || c.height !== Math.round(r.height * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
      const W = c.width, H = c.height;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = getComputedStyle(w).getPropertyValue('--lab-bg-3') || '#2e2e2e'; ctx.fillRect(0, 0, W, H);
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = hist[(head + i) % n];
        const x = (i / (n - 1)) * W, y = H - ((clamp(v, min, max) - min) / (max - min)) * (H - 2) - 1;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.lineWidth = dpr; ctx.strokeStyle = '#4f7cc4'; ctx.stroke();
    };
    const tick = () => {
      const v = +this.obj[this.key]; hist[head] = isFinite(v) ? v : 0; head = (head + 1) % n;
      if (!this.element.hidden && w.isConnected) draw();
    };
    this._timer = setInterval(tick, o.interval || 60);
    this.refresh = draw;
    const disp = this.dispose.bind(this);
    this.dispose = () => { clearInterval(this._timer); disp(); };
  };

  function normalizeOptions(options) {
    if (!options) return [];
    if (Array.isArray(options)) {
      return options.map((x) => Array.isArray(x) ? { value: x[0], text: x[1] } : (typeof x === 'object' ? x : { value: x, text: String(x) }));
    }
    return Object.keys(options).map((k) => ({ text: k, value: options[k] }));
  }

  // ---------------------------------------------------------------- simple controls
  class ButtonControl extends Control {
    constructor(parent, o) {
      const row = el('div', 'lab-row lab-full');
      super(parent, row);
      const b = el('button', 'lab-btn' + (o.accent ? ' lab-accent' : '') + (o.danger ? ' lab-danger' : '') + (o.rec ? ' lab-rec' : '') + (o.tall ? ' lab-tall' : ''), o.title);
      if (o.id) b.id = o.id;
      b.type = 'button';
      row.appendChild(b);
      this.button = b;
      b.addEventListener('click', (e) => this.emit('click', { native: e, target: this }));
      if (o.onClick) this.on('click', o.onClick);
    }
    get title() { return this.button.textContent; }
    set title(t) { this.button.textContent = t; }
    get on_() { return this.button.classList.contains('on'); }
    set active(v) { this.button.classList.toggle('on', !!v); this.button.setAttribute('aria-pressed', v ? 'true' : 'false'); }
    get active() { return this.button.classList.contains('on'); }
    set disabled(v) { this._disabled = !!v; this.button.disabled = !!v; }
    get disabled() { return this._disabled; }
  }

  class ButtonsControl extends Control {
    constructor(parent, items, o) {
      o = o || {};
      const row = el('div', 'lab-row' + (o.label ? '' : ' lab-full'));
      super(parent, row);
      if (o.label) row.appendChild(el('label', null, o.label));
      const box = el('div', 'lab-btns' + (o.cols ? ' lab-grid-' + o.cols : '') + (o.nowrap ? ' lab-nowrap' : ''));
      row.appendChild(box);
      this.buttons = {};
      items.forEach((it) => {
        if (typeof it === 'string') it = { title: it };
        const b = el('button', 'lab-btn' + (it.accent ? ' lab-accent' : '') + (it.danger ? ' lab-danger' : '') + (it.rec ? ' lab-rec' : '') + (it.icon ? ' lab-icon' : ''), it.title);
        b.type = 'button';
        if (it.id) b.id = it.id;
        if (it.key) this.buttons[it.key] = b;
        if (it.title_) b.title = it.title_;
        if (it.flex) b.style.flex = it.flex;
        b.addEventListener('click', (e) => { if (it.onClick) it.onClick(e, b); this.emit('click', { key: it.key, button: b, native: e }); });
        box.appendChild(b);
      });
      this.box = box;
    }
  }

  class PresetsControl extends Control {
    constructor(parent, names, o) {
      o = o || {};
      const row = el('div', 'lab-row lab-full');
      super(parent, row);
      const grid = el('div', 'lab-presets' + (o.cols ? ' lab-cols-' + o.cols : ''));
      row.appendChild(grid);
      this.grid = grid; this.buttons = {};
      names.forEach((name) => {
        const b = el('button', 'lab-btn', o.format ? o.format(name) : name); b.type = 'button';
        b.addEventListener('click', () => { this.select(name); this.emit('select', { name, target: this }); if (o.onSelect) o.onSelect(name); });
        this.buttons[name] = b; grid.appendChild(b);
      });
      if (o.value) this.select(o.value);
    }
    select(name) { Object.keys(this.buttons).forEach((k) => this.buttons[k].classList.toggle('on', k === name)); this.current = name; }
    clear() { this.select(null); }
  }

  class StatusControl extends Control {
    constructor(parent, text, o) {
      o = o || {};
      const n = el('div', 'lab-status-line');
      if (o.id) n.id = o.id;
      super(parent, n);
      this.set(text || '', o.kind);
    }
    set(text, kind) {
      this.element.textContent = text == null ? '' : text;
      this.element.className = 'lab-status-line' + (kind ? ' ' + kind : '');
      this.element.hidden = !text && !!this.opts_hideEmpty;
    }
  }

  class ProgressControl extends Control {
    constructor(parent, o) {
      o = o || {};
      const n = el('div', 'lab-progress'); const bar = el('i'); n.appendChild(bar);
      if (o.id) bar.id = o.id;
      super(parent, n);
      this.bar = bar;
    }
    set(p) { this.bar.style.width = (clamp(+p || 0, 0, 1) * 100).toFixed(1) + '%'; }
  }

  class NoteControl extends Control {
    constructor(parent, html, o) {
      const n = el('div', 'lab-note'); n.innerHTML = html; super(parent, n);
    }
  }
  class SeparatorControl extends Control {
    constructor(parent) { super(parent, el('div', 'lab-sep')); }
  }
  class SubheadControl extends Control {
    constructor(parent, text) { super(parent, el('div', 'lab-sub', text)); }
  }
  class RawControl extends Control {
    constructor(parent, node) { super(parent, node); }
  }

  // ---------------------------------------------------------------- folder / pane
  class Folder extends Emitter {
    constructor(parent, o) {
      super();
      o = o || {};
      this.parent = parent;
      this._children = [];
      this.element = el('section', 'lab-panel' + (o.expanded === false ? ' collapsed' : ''));
      if (o.id) this.element.id = o.id;
      const head = el('div', 'lab-panel-head');
      head.append(el('span', 'lab-chev'), el('span', 'lab-title', o.title || ''));
      const right = el('span', 'lab-head-right'); head.appendChild(right);
      this.head = head; this.headRight = right;
      this.body = el('div', 'lab-panel-body');
      this.element.append(head, this.body);
      head.addEventListener('click', (e) => { if (e.target.closest('.lab-head-right')) return; this.expanded = !this.expanded; });
      this._badge = null;
    }
    get expanded() { return !this.element.classList.contains('collapsed'); }
    set expanded(v) { this.element.classList.toggle('collapsed', !v); this.emit('fold', { expanded: !!v }); }
    get title() { return this.head.querySelector('.lab-title').textContent; }
    set title(t) { this.head.querySelector('.lab-title').textContent = t; }
    get hidden() { return this.element.hidden; }
    set hidden(v) { this.element.hidden = !!v; }
    badge(text) {
      if (!this._badge) { this._badge = el('span', 'lab-badge'); this.headRight.appendChild(this._badge); }
      this._badge.textContent = text == null ? '' : text; this._badge.hidden = text == null || text === '';
      return this;
    }
    _add(ctrl) { this._children.push(ctrl); this.body.appendChild(ctrl.element); return ctrl; }
    addBinding(obj, key, o) { const b = this._add(new Binding(this, obj, key, o)); b.on('change', (ev) => this._bubble(ev)); return b; }
    addButton(o) { return this._add(new ButtonControl(this, o || {})); }
    addButtons(items, o) { return this._add(new ButtonsControl(this, items, o)); }
    addBlade(o) {
      o = o || {};
      if (o.view === 'list') {
        const holder = { v: o.value };
        const b = this.addBinding(holder, 'v', { label: o.label, options: o.options, view: 'list' });
        return b;
      }
      if (o.view === 'separator') return this.addSeparator();
      if (o.view === 'text') { const holder = { v: o.value }; return this.addBinding(holder, 'v', { label: o.label, view: 'text' }); }
      return this.addNote(o.text || '');
    }
    addPresets(names, o) { return this._add(new PresetsControl(this, names, o)); }
    addStatus(text, o) { return this._add(new StatusControl(this, text, o)); }
    addProgress(o) { return this._add(new ProgressControl(this, o)); }
    addNote(html) { return this._add(new NoteControl(this, html)); }
    addSeparator() { return this._add(new SeparatorControl(this)); }
    addSubhead(text) { return this._add(new SubheadControl(this, text)); }
    addElement(node) { return this._add(new RawControl(this, node)); }
    addFolder(o) { const f = new Folder(this, o); this._children.push(f); this.body.appendChild(f.element); f.on('change', (ev) => this._bubble(ev)); return f; }
    _bubble(ev) { this.emit('change', ev); }
    refresh() { this._children.forEach((c) => c.refresh && c.refresh()); }
    dispose() { this.element.remove(); }
    get children() { return this._children.slice(); }
  }

  class Pane extends Folder {
    constructor(o) {
      o = o || {};
      super(null, { title: o.title });
      // a pane is a bare container, not a collapsible section
      this.element = el('div', 'lab-pane');
      this.body = this.element;
      const container = o.container ? (typeof o.container === 'string' ? doc.querySelector(o.container) : o.container) : null;
      if (container) container.appendChild(this.element);
    }
    get expanded() { return true; }
    set expanded(v) {}
  }

  // ---------------------------------------------------------------- shell
  // shell({ root, title, subtitle, side:'right'|'left', wide, view:HTMLElement|null, menu:[{title,onClick}] })
  // Returns { shell, top, toolbar, side, sideHead, view, status, setStatus(items) }
  function shell(o) {
    o = o || {};
    const root = o.root ? (typeof o.root === 'string' ? doc.querySelector(o.root) : o.root) : doc.body;
    doc.documentElement.classList.add('lab-root');
    root.classList.add('lab');
    const s = el('div', 'lab-shell' + (o.side === 'left' ? ' lab-side-left' : '') + (o.wide ? ' lab-side-wide' : ''));
    const top = el('header', 'lab-top');
    const brand = el('div', 'lab-brand');
    brand.append(el('span', 'lab-mark'), el('b', null, o.title || ''));
    if (o.subtitle) brand.appendChild(el('span', null, o.subtitle));
    top.appendChild(brand);
    const menu = el('nav', 'lab-menu');
    (o.menu || []).forEach((m) => { const b = el('button', null, m.title); b.type = 'button'; if (m.onClick) b.addEventListener('click', m.onClick); if (m.id) b.id = m.id; menu.appendChild(b); });
    top.appendChild(menu);
    top.appendChild(el('div', 'lab-spacer'));
    const toolbar = el('div', 'lab-toolbar');
    top.appendChild(toolbar);
    const view = el('main', 'lab-view');
    if (o.view) view.appendChild(o.view);
    const side = el('aside', 'lab-side');
    const sideHead = el('div', 'lab-side-head');
    if (o.sideHead !== false) side.appendChild(sideHead);
    const status = el('footer', 'lab-status');
    s.append(top, view, side, status);
    root.appendChild(s);
    const api = {
      shell: s, top, brand, menu, toolbar, view, side, sideHead, status,
      // setStatus([{text, bold, dot:'ok'|'rec'|'warn', spacer}]) or a string
      setStatus(items) {
        status.textContent = '';
        if (typeof items === 'string') items = [{ text: items }];
        (items || []).forEach((it) => {
          if (it.spacer) { status.appendChild(el('span', 'lab-spacer')); return; }
          const span = el('span');
          if (it.dot) span.appendChild(el('i', 'lab-dot ' + it.dot));
          if (it.bold) { span.appendChild(el('b', null, it.bold)); if (it.text) span.appendChild(doc.createTextNode(' ' + it.text)); }
          else span.appendChild(doc.createTextNode(it.text || ''));
          if (it.id) span.id = it.id;
          status.appendChild(span);
        });
      },
      hud(text) {
        let h = view.querySelector('.lab-hud');
        if (!h) { h = el('div', 'lab-hud'); view.appendChild(h); }
        if (text != null) h.innerHTML = text;
        return h;
      },
      hint(text) {
        let h = view.querySelector('.lab-hint');
        if (!h) { h = el('div', 'lab-hint'); view.appendChild(h); }
        if (text != null) h.innerHTML = text;
        return h;
      },
      drop(text) {
        let d = view.querySelector('.lab-drop');
        if (!d) { d = el('div', 'lab-drop'); view.appendChild(d); }
        if (text != null) d.textContent = text;
        return d;
      },
      toolbarButton(o2) {
        const b = el('button', 'lab-btn' + (o2.accent ? ' lab-accent' : '') + (o2.danger ? ' lab-danger' : '') + (o2.rec ? ' lab-rec' : ''), o2.title);
        b.type = 'button'; if (o2.id) b.id = o2.id; if (o2.onClick) b.addEventListener('click', o2.onClick);
        toolbar.appendChild(b); return b;
      },
    };
    return api;
  }

  // file drop helper: wires drag states on the viewport and returns files to the callback
  function dropTarget(target, onFiles, dropEl) {
    let depth = 0;
    const on = (v) => { target.classList.toggle('lab-dragging', v); if (dropEl) dropEl.classList.toggle('on', v); };
    doc.addEventListener('dragenter', (e) => { if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return; depth++; on(true); });
    doc.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) on(false); });
    doc.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
    doc.addEventListener('drop', (e) => { depth = 0; on(false); if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); onFiles([...e.dataTransfer.files], e); });
  }

  // static markup: wire collapsible .lab-panel sections written by hand
  function enhance(root) {
    (root || doc).querySelectorAll('.lab-panel-head').forEach((h) => {
      if (h._labWired) return; h._labWired = true;
      if (!h.querySelector('.lab-chev')) h.insertBefore(el('span', 'lab-chev'), h.firstChild);
      h.addEventListener('click', (e) => { if (e.target.closest('.lab-head-right')) return; h.parentElement.classList.toggle('collapsed'); });
    });
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => enhance()); else enhance();

  global.LabUI = { Pane, Folder, Binding, shell, dropTarget, fmt, el, enhance };
})(window);
