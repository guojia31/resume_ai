/* PDF text extraction — browser-side using pdfjs-dist */

import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = workerSrc;

export async function parsePdfToText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const loadingTask = getDocument({ data: buf });
  const pdf = await loadingTask.promise;

  const pageTexts: string[] = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items
      .map((it: any) => (typeof it?.str === "string" ? it.str : ""))
      .filter(Boolean);

    // Heuristic spacing: pdfjs returns fragments; join with spaces to reduce word glue.
    pageTexts.push(strings.join(" "));
  }

  return pageTexts
    .join("\n\n")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}
