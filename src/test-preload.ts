import { mock } from "bun:test";

mock.module("obsidian", () => ({
  Plugin: class Plugin {},
  Notice: class Notice {
    hide() {}
  },
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
  Modal: class Modal {
    app: unknown;
    contentEl = {
      empty() {},
      createEl() {
        return {};
      },
      createDiv() {
        return {};
      },
    };
    constructor(app: unknown) {
      this.app = app;
    }
    open() {}
    close() {}
    onOpen() {}
    onClose() {}
  },
  TFolder: class TFolder {},
  TFile: class TFile {},
}));
