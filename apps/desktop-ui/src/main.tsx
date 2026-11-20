import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AskOverlayStandalone } from './AskOverlayStandalone';
import { CursorOverlayStandalone } from './CursorOverlayStandalone';
import '@snaglet/ui/styles';
import '@desktop/styles';
import './index.css';

// The native cursor overlay window loads `/?cursorOverlay=1`. It must get the
// transparent, click-through page and never the full app.
const pageParams = new URLSearchParams(window.location.search);
const isCursorOverlay = pageParams.has('cursorOverlay');
// `/?askOverlay=1` is the native ask window: the same rule, its own page.
const isAskOverlay = pageParams.has('askOverlay');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCursorOverlay ? (
      <CursorOverlayStandalone />
    ) : isAskOverlay ? (
      <AskOverlayStandalone />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
