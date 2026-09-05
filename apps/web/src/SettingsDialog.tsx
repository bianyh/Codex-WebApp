import { useEffect, useState } from "react";
import { Cpu, Moon, Palette, Plus, Settings, Sun, Trash2, X } from "lucide-react";
import type { ModelOption, ThemeMode } from "./types";

export function SettingsDialog({
  theme,
  models,
  defaultModel,
  onThemeChange,
  onDefaultModelChange,
  onAddCustomModel,
  onDeleteCustomModel,
  onClose,
}: {
  theme: ThemeMode;
  models: ModelOption[];
  defaultModel: string;
  onThemeChange: (theme: ThemeMode) => void;
  onDefaultModelChange: (model: string) => void;
  onAddCustomModel: (model: string, displayName?: string) => Promise<void>;
  onDeleteCustomModel: (model: string) => Promise<void>;
  onClose: () => void;
}) {
  const [customModel, setCustomModel] = useState("");
  const [customDisplayName, setCustomDisplayName] = useState("");
  const [modelBusy, setModelBusy] = useState("");
  const [modelError, setModelError] = useState("");
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const selected = models.find((model) => model.model === defaultModel);
  const addCustomModel = async () => {
    const model = customModel.trim();
    if (!model || modelBusy) return;
    setModelBusy("add");
    setModelError("");
    try {
      await onAddCustomModel(model, customDisplayName.trim() || undefined);
      setCustomModel("");
      setCustomDisplayName("");
    } catch (reason) {
      setModelError(reason instanceof Error ? reason.message : "无法添加模型");
    } finally {
      setModelBusy("");
    }
  };
  const deleteCustomModel = async (model: string) => {
    if (modelBusy) return;
    setModelBusy(model);
    setModelError("");
    try {
      await onDeleteCustomModel(model);
    } catch (reason) {
      setModelError(reason instanceof Error ? reason.message : "无法删除模型");
    } finally {
      setModelBusy("");
    }
  };
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
          <section className="settings-section settings-section-stack">
            <div className="settings-section-title">
              <Cpu size={16} />
              <div><strong>自定义模型</strong><span>添加 Codex 模型提供商支持的模型名</span></div>
            </div>
            <div className="custom-model-editor">
              <div className="custom-model-fields">
                <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addCustomModel(); }} placeholder="模型名，例如 provider/model" aria-label="自定义模型名" />
                <input value={customDisplayName} onChange={(event) => setCustomDisplayName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void addCustomModel(); }} placeholder="显示名称（可选）" aria-label="模型显示名称" />
                <button className="secondary-button custom-model-add" disabled={!customModel.trim() || Boolean(modelBusy)} onClick={() => void addCustomModel()} aria-label="添加自定义模型" title="添加自定义模型">
                  <Plus size={15} />添加
                </button>
              </div>
              {models.some((model) => model.isCustom) && (
                <div className="custom-model-list">
                  {models.filter((model) => model.isCustom).map((model) => (
                    <div className="custom-model-row" key={model.id}>
                      <span><strong>{model.displayName}</strong><small>{model.model}</small></span>
                      <button disabled={Boolean(modelBusy)} onClick={() => void deleteCustomModel(model.model)} aria-label={`删除 ${model.displayName}`} title="删除自定义模型">
                        {modelBusy === model.model ? <Cpu className="spin" size={14} /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {modelError && <div className="file-error">{modelError}</div>}
            </div>
          </section>
        </div>
        <footer><button className="primary-button" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}
