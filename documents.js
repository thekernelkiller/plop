import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.4.0/dist/purify.es.mjs";

const PDF_ROOT = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/build/";
const DOCX_SCRIPT = "https://cdn.jsdelivr.net/npm/mammoth@1.11.0/mammoth.browser.min.js";
let pdfModule;
let docxModule;

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function loadDocx() {
  docxModule ||= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = DOCX_SCRIPT;
    script.crossOrigin = "anonymous";
    script.onload = () => resolve(window.mammoth);
    script.onerror = () => {
      script.remove();
      reject(new Error("The DOCX viewer could not load."));
    };
    document.head.append(script);
  }).catch((error) => {
    docxModule = null;
    throw error;
  });
  return docxModule;
}

export async function previewDocument(file, container, signal) {
  const bytes = await file.blob.arrayBuffer();
  if (signal.aborted) return;
  if (file.format === "docx") {
    const mammoth = await loadDocx();
    if (signal.aborted) return;
    const result = await mammoth.convertToHtml({ arrayBuffer: bytes }, { externalFileAccess: false });
    if (signal.aborted) return;
    const documentContent = DOMPurify.sanitize(result.value, {
      RETURN_DOM_FRAGMENT: true,
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["form", "input", "style", "video", "audio"],
      FORBID_ATTR: ["style", "srcset"]
    });
    for (const image of documentContent.querySelectorAll("img")) {
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(image.getAttribute("src") || "")) image.remove();
    }
    for (const link of documentContent.querySelectorAll("a[href]")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    container.replaceChildren(documentContent);
    if (!container.textContent.trim() && !container.querySelector("img")) container.textContent = "This document is empty.";
    return;
  }

  pdfModule ||= import(PDF_ROOT + "pdf.min.mjs").catch((error) => {
    pdfModule = null;
    throw error;
  });
  const pdfjs = await pdfModule;
  if (signal.aborted) return;
  pdfjs.GlobalWorkerOptions.workerSrc = PDF_ROOT + "pdf.worker.min.mjs";
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
  signal.addEventListener("abort", () => task.destroy().catch(() => {}), { once: true });
  const pdf = await task.promise;
  if (signal.aborted) return;

  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  const previous = document.createElement("button");
  const next = document.createElement("button");
  previous.type = next.type = "button";
  previous.className = next.className = "btn btn-secondary";
  previous.textContent = "Previous";
  next.textContent = "Next";
  toolbar.append(previous, status, next);
  const canvas = document.createElement("canvas");
  canvas.className = "pdf-page";
  container.replaceChildren(toolbar, canvas);

  let current = 1;
  async function renderPage(number) {
    previous.disabled = next.disabled = true;
    status.textContent = `Page ${number} of ${pdf.numPages}`;
    try {
      const page = await pdf.getPage(number);
      if (signal.aborted) return;
      const native = page.getViewport({ scale: 1 });
      const scale = Math.min(1.8, 1500 / Math.max(native.width, native.height));
      const viewport = page.getViewport({ scale });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      current = number;
      canvas.setAttribute("aria-label", `PDF page ${number}`);
    } catch {
      if (!signal.aborted) status.textContent = "Could not display this page.";
    } finally {
      previous.disabled = current <= 1;
      next.disabled = current >= pdf.numPages;
    }
  }
  previous.addEventListener("click", () => renderPage(current - 1));
  next.addEventListener("click", () => renderPage(current + 1));
  await renderPage(1);
}
