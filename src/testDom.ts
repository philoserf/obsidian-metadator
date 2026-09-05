// Minimal stand-in for the slice of Obsidian's DOM helpers the bulk modals use.
//
// The "obsidian" module is types-only, so tests get their Modal from a
// mock.module; its contentEl needs createEl/createDiv/empty and elements that
// tolerate .style, .textContent, .disabled and .checked assignment. Real DOM
// (happy-dom) would work too, but this is ~40 lines and keeps the modal tests
// dependency-free.

export interface FakeElOptions {
  text?: string;
  cls?: string;
  attr?: Record<string, string>;
}

export class FakeEl {
  tag: string;
  textContent = "";
  cls = "";
  attr: Record<string, string> = {};
  style: Record<string, string> = {};
  disabled = false;
  checked = false;
  children: FakeEl[] = [];
  private listeners = new Map<string, Array<() => void>>();

  constructor(tag = "div", options: FakeElOptions = {}) {
    this.tag = tag;
    this.textContent = options.text ?? "";
    this.cls = options.cls ?? "";
    this.attr = options.attr ?? {};
  }

  createEl(tag: string, options: FakeElOptions = {}): FakeEl {
    const el = new FakeEl(tag, options);
    this.children.push(el);
    return el;
  }

  createDiv(options: FakeElOptions = {}): FakeEl {
    return this.createEl("div", options);
  }

  empty(): void {
    this.children = [];
  }

  addEventListener(event: string, handler: () => void): void {
    const existing = this.listeners.get(event);
    if (existing) existing.push(handler);
    else this.listeners.set(event, [handler]);
  }

  // Test-side trigger; the modals never dispatch events themselves.
  dispatch(event: string): void {
    for (const handler of this.listeners.get(event) ?? []) handler();
  }

  // Depth-first search over the subtree, so tests can find a button by its
  // label instead of by index into a container.
  find(predicate: (el: FakeEl) => boolean): FakeEl | undefined {
    for (const child of this.children) {
      if (predicate(child)) return child;
      const found = child.find(predicate);
      if (found) return found;
    }
    return undefined;
  }

  findByText(text: string): FakeEl | undefined {
    return this.find((el) => el.textContent === text);
  }

  allText(): string[] {
    return this.children.flatMap((c) => [c.textContent, ...c.allText()]);
  }
}

// Base class the test-side mock.module("obsidian") returns as Modal. Unlike the
// preload stub, open()/close() chain into onOpen()/onClose() — the progress
// modal's finishing-flag state machine is exactly that chain.
export class FakeModal {
  app: unknown;
  contentEl = new FakeEl();
  isOpen = false;

  constructor(app: unknown) {
    this.app = app;
  }

  open(): void {
    this.isOpen = true;
    (this as unknown as { onOpen?: () => void }).onOpen?.();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    (this as unknown as { onClose?: () => void }).onClose?.();
  }
}

// The obsidian test doubles, defined once.
//
// test-preload.ts installs these for every test file. A test file that needs a
// richer Modal calls mock.module("obsidian") itself, and MUST spread
// obsidianDoubles rather than declaring fresh TFile/TFolder classes: mock.module
// is global, so a second set of classes would make instanceof fail in whichever
// file loaded the other set. That is a two-way break — it took out
// collectCandidates' tests when these mocks first landed.
export class FakeNotice {
  static messages: string[] = [];
  constructor(text?: string) {
    if (text !== undefined) FakeNotice.messages.push(text);
  }
  hide(): void {}
}

export class FakeTFile {}
export class FakeTFolder {}

export const obsidianDoubles = {
  Plugin: class Plugin {},
  Notice: FakeNotice,
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
  Modal: FakeModal,
  TFolder: FakeTFolder,
  TFile: FakeTFile,
};
