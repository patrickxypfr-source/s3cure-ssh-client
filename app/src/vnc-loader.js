// Lädt noVNC (MPL-2.0, npm-Paket @novnc/novnc) als ES-Modul direkt aus node_modules – nichts aus dem Netz.
// src/vnc.js wartet auf das Ereignis „novnc-ready“ bzw. window.NoVncRFB.
import RFB from '../node_modules/@novnc/novnc/core/rfb.js';

window.NoVncRFB = RFB;
window.dispatchEvent(new Event('novnc-ready'));
