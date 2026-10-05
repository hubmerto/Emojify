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


  // ---------------------------------------------------------------- icons (24-grid line set)
  const ICONS = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="m21 16-5-5-8 8"/>',
    webcam: '<circle cx="12" cy="10" r="5"/><circle cx="12" cy="10" r="1.6"/><path d="M8 20h8M12 15v5"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    testcard: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 12h18M9 4v16M15 4v16"/>',
    play: '<path d="M7 5v14l11-7z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.5-5.8"/><path d="M4 4v5h5"/>',
    record: '<circle cx="12" cy="12" r="8"/><circle class="lab-rec-dot" cx="12" cy="12" r="4"/>',
    film: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/>',
    export: '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
    save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-6h8v6"/>',
    front: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
    reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
    fly: '<path d="M4 18c4 0 4-12 8-12s4 12 8 12"/><circle cx="4" cy="18" r="1.5"/><circle cx="20" cy="18" r="1.5"/>',
    audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="8.5" cy="8.5" r="1.2"/><circle cx="15.5" cy="8.5" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="8.5" cy="15.5" r="1.2"/><circle cx="15.5" cy="15.5" r="1.2"/>',
    build: '<path d="M4 20h16M6 20V9l6-5 6 5v11"/><path d="M10 20v-5h4v5"/>',
    gif: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M8 10v4M11 10h2.5v4H11zM16 14v-4h2"/>',
    deselect: '<path d="M6 6l12 12M18 6 6 18"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    sample: '<path d="M4 9h16v11H4zM4 9l2-5h12l2 5M8 4l2 5M14 4l2 5"/>',
    fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
    ratio: '<rect x="3" y="6" width="18" height="12" rx="1"/><path d="M8 6v12M16 6v12"/>',
    layers: '<path d="m12 4 8 4-8 4-8-4z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
    eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  };
  function icon(name) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || ICONS.grid;
    return svg;
  }

  // ---------------------------------------------------------------- tooltips
  let tipEl = null, tipTimer = null;
  function bindTip(btn, text, kbd) {
    if (!text) return;
    btn.setAttribute('aria-label', text);
    btn.addEventListener('pointerenter', () => {
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        if (!tipEl) { tipEl = el('div', 'lab-tool-tip'); doc.body.appendChild(tipEl); }
        tipEl.textContent = text;
        if (kbd) tipEl.appendChild(el('span', 'lab-kbd', kbd));
        const r = btn.getBoundingClientRect();
        tipEl.style.left = Math.max(6, Math.min(r.left, global.innerWidth - 240)) + 'px';
        tipEl.style.top = (r.bottom + 6) + 'px';
        tipEl.hidden = false;
      }, 450);
    });
    const hide = () => { clearTimeout(tipTimer); if (tipEl) tipEl.hidden = true; };
    btn.addEventListener('pointerleave', hide); btn.addEventListener('pointerdown', hide);
  }

  // click: '#id' delegates to another element (keeps the tool's own ids in one place)
  function wireClick(btn, it) {
    if (it.onClick) btn.addEventListener('click', it.onClick);
    if (it.click) btn.addEventListener('click', () => { const t = doc.querySelector(it.click); if (t) t.click(); });
    if (it.toggleOf) btn.addEventListener('click', () => { const t = doc.querySelector(it.toggleOf); if (t) t.click(); });
  }

  // ---------------------------------------------------------------- menu bar with dropdowns
  // menus: [{ title, items: [{ title, icon, kbd, onClick, click:'#id', id, disabled } | { sep:true } | { head:'text' }] }]
  function menubar(container, menus) {
    let openItem = null;
    const closeAll = () => { if (openItem) { openItem.dd.hidden = true; openItem.btn.classList.remove('open'); openItem = null; } };
    doc.addEventListener('pointerdown', (e) => { if (openItem && !e.target.closest('.lab-menu-item')) closeAll(); });
    doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    const built = [];
    (menus || []).forEach((m) => {
      const wrap = el('div', 'lab-menu-item');
      const btn = el('button', null, m.title); btn.type = 'button';
      if (m.id) btn.id = m.id;
      const dd = el('div', 'lab-dropdown'); dd.hidden = true;
      (m.items || []).forEach((it) => {
        if (it.sep) { dd.appendChild(el('hr')); return; }
        if (it.head) { dd.appendChild(el('div', 'lab-dd-head', it.head)); return; }
        const b = el('button'); b.type = 'button';
        if (it.icon) b.appendChild(icon(it.icon));
        b.appendChild(el('span', null, it.title));
        if (it.kbd) b.appendChild(el('span', 'lab-kbd', it.kbd));
        if (it.id) b.id = it.id;
        if (it.disabled) b.disabled = true;
        wireClick(b, it);
        b.addEventListener('click', closeAll);
        dd.appendChild(b);
      });
      const item = { btn, dd, menu: m };
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); if (openItem === item) { closeAll(); return; } closeAll(); dd.hidden = false; btn.classList.add('open'); openItem = item; });
      btn.addEventListener('pointerenter', () => { if (openItem && openItem !== item) { closeAll(); dd.hidden = false; btn.classList.add('open'); openItem = item; } });
      if (!m.items || !m.items.length) { wireClick(btn, m); }
      wrap.append(btn, dd); container.appendChild(wrap); built.push(item);
    });
    return built;
  }

  // ---------------------------------------------------------------- tool strip
  // groups: [[item, item], [item], ...] with item = { icon, title, text, tip, kbd, id, onClick, click:'#id',
  //   primary, rec, toggle } | { sep:true } | { spacer:true } | { label:'text' } | { el: node }
  const ICON_FAMILY = { folder:'amber', webcam:'amber', monitor:'amber', testcard:'amber', sample:'amber', camera:'amber', plus:'amber', image:'sky', save:'sky', download:'sky', gif:'sky', export:'sky',
    play:'green', pause:'green', restart:'green', bolt:'green', front:'cyan', reset:'cyan', fly:'cyan', fit:'cyan', eye:'cyan', ratio:'cyan',
    layers:'violet', grid:'violet', build:'violet', dice:'violet', text:'violet', audio:'pink', mic:'pink', undo:'red', deselect:'red', record:'red', film:'sky', link:'sky', menu:'sky' };
  function toolbar(container, groups) {
    container.textContent = '';
    const tools = {};
    const addItem = (it, into) => {
      if (it.sep) { into.appendChild(el('span', 'lab-tsep')); return; }
      if (it.spacer) { into.appendChild(el('span', 'lab-spacer')); return; }
      if (it.label) { into.appendChild(el('span', 'lab-tlabel', it.label)); return; }
      if (it.el) { into.appendChild(it.el); return; }
      const fam = it.c || (it.icon && ICON_FAMILY[it.icon]);
      const b = el('button', 'lab-tool' + (it.primary ? ' lab-primary' : '') + (it.rec ? ' lab-rec' : '') + (it.cls ? ' ' + it.cls : '') + (fam && !it.primary ? ' lab-c-' + fam : ''));
      b.type = 'button';
      if (it.icon) b.appendChild(icon(it.icon));
      if (it.text) b.appendChild(el('span', 'lab-tool-text', it.text));
      if (it.id) b.id = it.id;
      if (it.disabled) b.disabled = true;
      bindTip(b, it.tip || it.title, it.kbd);
      wireClick(b, it);
      if (it.toggle) b.addEventListener('click', () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (it.onToggle) it.onToggle(on, b); });
      if (it.key) tools[it.key] = b;
      into.appendChild(b);
    };
    (groups || []).forEach((g, gi) => {
      if (!Array.isArray(g)) { addItem(g, container); return; }
      const grp = el('div', 'lab-tgroup');
      g.forEach((it) => addItem(it, grp));
      container.appendChild(grp);
      const next = groups[gi + 1];
      if (next && Array.isArray(next)) container.appendChild(el('span', 'lab-tsep'));
    });
    return tools;
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
    menubar(menu, o.menus || o.menu || []);
    top.appendChild(menu);
    const tools = el('div', 'lab-tools');
    const toolRefs = toolbar(tools, o.tools || []);
    const tools2 = el('div', 'lab-tools2');
    if (o.tools2) Object.assign(toolRefs, toolbar(tools2, o.tools2)); else s.classList.add('lab-no-tools2');
    const rail = el('div', 'lab-rail');
    if (o.rail) Object.assign(toolRefs, toolbar(rail, o.rail)); else s.classList.add('lab-no-rail');
    top.appendChild(el('div', 'lab-spacer'));
    const tbar = el('div', 'lab-toolbar');
    top.appendChild(tbar);
    const view = el('main', 'lab-view');
    if (o.view) view.appendChild(o.view);
    const side = el('aside', 'lab-side');
    const sideHead = el('div', 'lab-side-head');
    if (o.sideHead !== false) side.appendChild(sideHead);
    const status = el('footer', 'lab-status');
    s.append(top, tools, tools2, rail, view, side, status);
    root.appendChild(s);
    const api = {
      shell: s, top, brand, menu, toolbar: tbar, tools, tools2, rail, tool: toolRefs, view, side, sideHead, status,
      setTools2(groups) { s.classList.remove('lab-no-tools2'); Object.assign(toolRefs, LabUI.toolbar(tools2, groups)); return toolRefs; },
      setRail(groups) { s.classList.remove('lab-no-rail'); Object.assign(toolRefs, LabUI.toolbar(rail, groups)); return toolRefs; },
      // document window chrome inside the viewport: title bar with lights, optional field bar, optional ruler
      doc(opts) {
        opts = opts || {};
        view.classList.add('lab-has-doc');
        let bar = view.querySelector('.lab-doc');
        if (!bar) {
          bar = el('div', 'lab-doc');
          const lights = el('span', 'lab-lights'); lights.append(el('i'), el('i'), el('i'));
          bar.append(lights, el('span', 'lab-doc-title'), el('span', 'lab-doc-right'));
          view.appendChild(bar);
        }
        if (opts.title != null) bar.querySelector('.lab-doc-title').textContent = opts.title;
        if (opts.right != null) bar.querySelector('.lab-doc-right').textContent = opts.right;
        let field = view.querySelector('.lab-docbar');
        if (opts.bar) {
          if (!field) { field = el('div', 'lab-docbar'); view.appendChild(field); view.classList.add('lab-has-docbar'); }
          field.textContent = '';
          toolbar(field, opts.bar);
        }
        let ruler = view.querySelector('.lab-ruler');
        if (opts.ruler !== false) {
          if (!ruler) { ruler = el('div', 'lab-ruler'); ruler.appendChild(el('canvas')); view.appendChild(ruler); }
          ruler.style.top = field ? '42px' : '20px';
          const draw = () => {
            const c = ruler.firstChild, r = ruler.getBoundingClientRect();
            const dpr = Math.min(2, global.devicePixelRatio || 1);
            c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
            const ctx = c.getContext('2d'); ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, r.width, r.height);
            if (opts.select) { ctx.fillStyle = 'rgba(47,95,209,.75)'; ctx.fillRect(opts.select[0], 0, Math.max(1, opts.select[1] - opts.select[0]), r.height); }
            ctx.strokeStyle = 'rgba(190,200,230,.55)'; ctx.fillStyle = '#d4dbf0'; ctx.font = '8px Monaco, Menlo, monospace';
            const unit = opts.unit || 50, origin = opts.origin || 0;
            for (let x = 0; x <= r.width; x += unit / 5) {
              const major = Math.round(x / unit) * unit === Math.round(x) || Math.abs((x % unit)) < 0.01;
              const h = major ? r.height : (Math.abs((x % (unit / 2))) < 0.01 ? r.height * .55 : r.height * .3);
              ctx.beginPath(); ctx.moveTo(x + .5, r.height); ctx.lineTo(x + .5, r.height - h); ctx.stroke();
              if (major && x > 0) ctx.fillText(String(Math.round(origin + x)), x + 2, 8);
            }
            if (opts.marker != null) { ctx.fillStyle = '#e8321f'; ctx.fillRect(opts.marker - 1, 0, 3, r.height); }
          };
          draw();
          if (!ruler._ro) { ruler._ro = new ResizeObserver(draw); ruler._ro.observe(ruler); }
          ruler._draw = draw;
        }
        return { bar, field, ruler, setTitle: (t) => { bar.querySelector('.lab-doc-title').textContent = t; }, setRight: (t) => { bar.querySelector('.lab-doc-right').textContent = t; } };
      },
      setTools(groups) { Object.assign(toolRefs, LabUI.toolbar(tools, groups)); return toolRefs; },
      setMenus(menus) { menu.textContent = ''; menubar(menu, menus); },
      // setStatus([{text, bold, dot:'ok'|'rec'|'warn', spacer}]) or a string
      setStatus(items) {
        status.textContent = '';
        if (typeof items === 'string') items = [{ text: items }];
        (items || []).forEach((it) => {
          if (it.spacer) { status.appendChild(el('span', 'lab-spacer')); return; }
          const span = el('span', it.cell ? 'lab-cell' : null);
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
        tbar.appendChild(b); return b;
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

  // change a tool/button label without losing its icon
  function setLabel(target, text) {
    const b = typeof target === 'string' ? doc.querySelector(target) : target;
    if (!b) return;
    const t = b.querySelector('.lab-tool-text');
    if (t) t.textContent = text; else if (b.querySelector('svg')) { let span = b.querySelector('span'); if (!span) { span = el('span', 'lab-tool-text'); b.appendChild(span); } span.textContent = text; } else b.textContent = text;
  }

  global.LabUI = { Pane, Folder, Binding, shell, dropTarget, fmt, el, enhance, icon, menubar, toolbar, bindTip, setLabel, ICONS };
})(window);
