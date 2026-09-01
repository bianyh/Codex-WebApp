import { useEffect } from "react";
import { Cpu, Moon, Palette, Settings, Sun, X } from "lucide-react";
import type { ModelOption, ThemeMode } from "./types";

export function SettingsDialog({
  theme,
  models,
  defaultModel,
  onThemeChange,
  onDefaultModelChange,
  onClose,
}: {
  theme: ThemeMode;
  models: ModelOption[];
  defaultModel: string;
  onThemeChange: (theme: ThemeMode) => void;
  onDefaultModelChange: (model: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const selected = models.find((model) => model.model === defaultModel);
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="设置">
      <section className="settings-dialog">
        <header>
          <div>
            <span className="eyebrow">SETTINGS</span>
            <h2><Settings size={18} />设置</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭设置">
            <X size={19} />
          </button>
        </header>
        <div className="settings-body">
          <section className="settings-section">
            <div className="settings-section-title">
              <Palette size={16} />
              <div><strong>外观</strong><span>页面主题</span></div>
            </div>
            <div className="theme-segment" role="group" aria-label="页面主题">
              <button className={theme === "light" ? "active" : ""} onClick={() => onThemeChange("light")}>
                <Sun size={16} />浅色
              </button>
              <button className={theme === "dark" ? "active" : ""} onClick={() => onThemeChange("dark")}>
                <Moon size={16} />深色
              </button>
            </div>
          </section>
          <section className="settings-section">
            <div className="settings-section-title">
              <Cpu size={16} />
              <div><strong>默认模型</strong><span>新对话与未单独选择模型的对话</span></div>
            </div>
            <label className="settings-select-label">
              <select value={defaultModel} onChange={(event) => onDefaultModelChange(event.target.value)}>
                <option value="">Codex 默认模型</option>
                {models.map((model) => (
                  <option key={model.id} value={model.model}>{model.displayName}</option>
                ))}
              </select>
              {selected?.description && <span>{selected.description}</span>}
            </label>
          </section>
        </div>
        <footer><button className="primary-button" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}
