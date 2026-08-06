/**
 * popup のエントリポイント。マウントのみを行う。
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
