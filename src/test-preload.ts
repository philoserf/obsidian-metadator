import { mock } from "bun:test";

mock.module("obsidian", () => ({
  Plugin: class Plugin {},
  Notice: class Notice {},
  PluginSettingTab: class PluginSettingTab {},
  Setting: class Setting {},
}));
