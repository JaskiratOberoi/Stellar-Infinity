import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { PrintReport } from './pages/PrintReport';
import { PrintSmartReport } from './pages/PrintSmartReport';
import { PrintInvoice } from './pages/PrintInvoice';
import { PrintPaymentReceipt } from './pages/PrintPaymentReceipt';
import './styles.css';

/**
 * The print bundle.
 *
 * This is the whole application for a /print/* URL: a router and the four
 * printable documents, and nothing else. No AuthProvider, no nav, no page
 * registry — the print pages are self-contained (they authenticate their own
 * data fetch with the forwarded cookie or the URL token) and were the only
 * thing the render service and the preview iframe ever needed.
 *
 * The main app (main.tsx / App.tsx) still owns these same routes for its own
 * navigation; this entry exists so the iframe and headless Chromium do not have
 * to boot that whole app to draw one page. Keep the route table here in step
 * with the /print/* routes in App.tsx.
 *
 * styles.css is imported for the invoice, smart report and receipt, whose
 * classes live there; PrintReport pulls in report.css itself. CSS is loaded
 * once and cached — the win being bought here is JavaScript, not stylesheet.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/print/report/:sid" element={<PrintReport />} />
        <Route path="/print/report/:sid/smart" element={<PrintSmartReport />} />
        <Route path="/print/invoice/:billId" element={<PrintInvoice />} />
        <Route path="/print/payment-receipt/:orderRef" element={<PrintPaymentReceipt />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
