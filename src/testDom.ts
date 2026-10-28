// The obsidian test doubles, defined once.
//
// test-preload.ts installs these for every test file. A test file that needs a
// richer double calls mock.module("obsidian") itself, and MUST spread
// obsidianDoubles rather than declaring fresh classes: mock.module is global,
// so a second set of classes would make instanceof fail in whichever file
// loaded the other set.
export class FakeNotice {
  static messages: string[] = [];
  constructor(text?: string) {
    if (text !== undefined) FakeNotice.messages.push(text);
  }
  hide(): void {}
}

export const obsidianDoubles = {
  Plugin: class Plugin {},
  Notice: FakeNotice,
  PluginSettingTab: class PluginSettingTab {
    // The real constructor keeps the app; the key row reads its keychain.
    app: unknown;
    constructor(app?: unknown) {
      this.app = app;
    }
    hide(): void {}
    refreshDomState(): void {}
    update(): void {}
  },
  // Chainable no-ops: the key row's render callback builds one, though no
  // test runs render — the settings tab is tested as definition data.
  SecretComponent: class SecretComponent {
    setValue() {
      return this;
    }
    onChange() {
      return this;
    }
  },
  // Here rather than re-mocked in cli.test.ts: a module already linked against
  // the preloaded mock cannot pick up exports added by a later mock.module.
  // Fakes store frontmatter as JSON, which is valid YAML, so finding the block
  // and JSON.parse is the whole of parsing.
  getFrontMatterInfo: (content: string) => {
    const m = /^---\n([\s\S]*?)\n---/.exec(content);
    return { exists: m !== null, frontmatter: m?.[1] ?? "" };
  },
  parseYaml: (yaml: string) => JSON.parse(yaml),
};
