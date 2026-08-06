/**
 * 閲覧 UI（DevTools パネル）のエントリポイント。マウントのみを行う。
 *
 * このページは DevTools ウィンドウ内のパネルとして開かれるが、拡張機能のオリジンで
 * 動くため、保存層（IndexedDB）を DevTools ページと同じように直接開ける。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const container = document.getElementById('root');
if (container === null) throw new Error('[EverLog] #root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
