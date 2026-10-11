import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (this.state.failed) {
      return (
        <main className="login-page">
          <section className="login-panel" role="alert">
            <h1>页面显示遇到问题</h1>
            <p>服务器上的对话不会因此停止。请重新加载页面恢复连接。</p>
            <button className="primary-button" onClick={() => location.reload()}>重新加载</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
