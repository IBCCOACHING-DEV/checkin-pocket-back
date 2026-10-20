import { LabelContent, renderLabelCanvas } from './label-layout';

export type { LabelContent } from './label-layout';

/**
 * Renderiza a etiqueta de credenciamento como PNG usando canvas nativo, sem
 * abrir navegador — o gargalo original era o Puppeteer/Chromium sendo
 * lançado do zero a cada etiqueta (~1-2s por chamada). O layout
 * (apelido, cidade, QR do token, turma) está em label-layout.ts.
 */
export function renderLabelPng(content: LabelContent): Buffer {
  return renderLabelCanvas(content).toBuffer('image/png');
}
