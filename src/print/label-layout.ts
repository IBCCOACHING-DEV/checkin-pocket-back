import { GlobalFonts, createCanvas } from '@napi-rs/canvas';
import * as qrcode from 'qrcode-generator';
import { join } from 'node:path';

export interface LabelContent {
  name: string;
  nickname: string;
  course?: string;
  /** Cidade do evento (ex.: "Goiânia - GO"). Sem ela, a linha é omitida. */
  city?: string;
  /** Conteúdo do QR Code (token do aluno). Sem ele, a etiqueta sai sem QR. */
  token?: string;
}

// Área imprimível da etiqueta Brother 29x90mm (DK-1201) a 300dpi: 83,9 x
// 25,9mm — as mesmas 991 linhas x 306 dots do protocolo raster da QL-810W
// (ver label-raster.ts). O layout é desenhado direto nesse tamanho, em
// paisagem, e serve tanto o caminho raster quanto o PNG do Sumatra/CUPS
// (que escala "fit" para o papel, ~1:1 por ter a mesma proporção).
export const LABEL_WIDTH_DOTS = 991;
export const LABEL_HEIGHT_DOTS = 306;

const FONT_FAMILY = 'Liberation Sans';

const MARGIN_X = 14;
const MARGIN_TOP = 12;
const MARGIN_BOTTOM = 10;
const LINE_HEIGHT_FACTOR = 1.15;

// QR no canto superior direito. O módulo é SEMPRE um número inteiro de dots
// (sem anti-aliasing/reamostragem borrando as bordas): token de 30-36
// caracteres em correção "M" dá 29x29 módulos -> 8 dots = 232 dots (~19,6mm).
const QR_MAX_DOTS = 236;
const QR_MIN_MODULE_DOTS = 4;
// Respiro entre o QR e o texto ao lado (4 módulos de "quiet zone").
const QR_TEXT_GAP = 32;

const NAME_FONT_SIZE = 88;
const NAME_MIN_FONT_SIZE = 44;
const SECONDARY_FONT_SIZE = 62; // cidade e, se diferente do apelido, nome completo
const SECONDARY_MIN_FONT_SIZE = 34;
const COURSE_FONT_SIZE = 38;
const COURSE_MIN_FONT_SIZE = 24;
// Linha da turma, ocupando a largura toda sob o QR.
const COURSE_BLOCK_HEIGHT = Math.ceil(COURSE_FONT_SIZE * LINE_HEIGHT_FACTOR);

/**
 * Registra a fonte embutida no projeto (Liberation Sans — SIL OFL,
 * metricamente compatível com Arial) em vez de depender de "Arial" estar
 * instalada e ser localizável pelo motor de fontes do canvas (Skia) no
 * sistema operacional. Sem isso, glyphs não encontrados saem como
 * retângulos ("tofu") na etiqueta impressa.
 *
 * __dirname aqui é `src/print` em dev (ts-node) e `dist/src/print` no
 * build — em ambos os casos `../../assets/fonts` chega na pasta
 * `assets/fonts` na raiz do projeto (ver nest-cli.json para a cópia desses
 * arquivos para `dist/assets/fonts` no build).
 */
function registerBundledFonts(): void {
  if (GlobalFonts.has(FONT_FAMILY)) {
    return;
  }

  const fontsDir = join(__dirname, '../../assets/fonts');
  GlobalFonts.registerFromPath(join(fontsDir, 'LiberationSans-Regular.ttf'), FONT_FAMILY);
  GlobalFonts.registerFromPath(join(fontsDir, 'LiberationSans-Bold.ttf'), FONT_FAMILY);
}

registerBundledFonts();

type Ctx = ReturnType<ReturnType<typeof createCanvas>['getContext']>;

/**
 * Reduz a fonte até o texto caber em `maxWidth`; se nem no mínimo couber,
 * corta com reticências. Devolve a fonte usada e o texto final.
 */
function fitText(
  ctx: Ctx,
  text: string,
  { startSize, minSize, maxWidth, bold }: { startSize: number; minSize: number; maxWidth: number; bold: boolean },
): { text: string; size: number } {
  const setFont = (size: number) => {
    ctx.font = `${bold ? 'bold ' : ''}${size}px "${FONT_FAMILY}"`;
  };

  let size = startSize;
  setFont(size);
  while (size > minSize && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    setFont(size);
  }

  let fitted = text;
  if (ctx.measureText(fitted).width > maxWidth) {
    while (fitted.length > 1 && ctx.measureText(`${fitted}…`).width > maxWidth) {
      fitted = fitted.slice(0, -1);
    }
    fitted = `${fitted.trimEnd()}…`;
  }

  return { text: fitted, size };
}

/** Desenha o QR Code (módulos inteiros) e devolve o lado ocupado, em dots. */
function drawQr(ctx: Ctx, token: string, right: number, top: number): number {
  const qr = qrcode(0, 'M');
  qr.addData(token);
  qr.make();

  const modules = qr.getModuleCount();
  const moduleDots = Math.floor(QR_MAX_DOTS / modules);
  if (moduleDots < QR_MIN_MODULE_DOTS) {
    // Token absurdamente longo: um QR menor que isso não seria legível.
    return 0;
  }

  const size = modules * moduleDots;
  const left = right - size;

  ctx.fillStyle = '#000000';
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(left + col * moduleDots, top + row * moduleDots, moduleDots, moduleDots);
      }
    }
  }

  return size;
}

/**
 * Renderiza a etiqueta de credenciamento (paisagem, LABEL_WIDTH_DOTS x
 * LABEL_HEIGHT_DOTS): apelido em negrito + cidade do evento à esquerda, QR
 * Code com o token do aluno à direita e a turma na base, ocupando a largura
 * toda. Tudo em preto — a impressora térmica é monocromática, e cinzas
 * virariam retícula (ou sumiriam no limiar do caminho raster).
 */
export function renderLabelCanvas({ name, nickname, course, city, token }: LabelContent) {
  const canvas = createCanvas(LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS);
  ctx.textBaseline = 'top';

  const qrSize = token ? drawQr(ctx, token, LABEL_WIDTH_DOTS - MARGIN_X, MARGIN_TOP) : 0;
  const textMaxWidth =
    LABEL_WIDTH_DOTS - 2 * MARGIN_X - (qrSize > 0 ? qrSize + QR_TEXT_GAP : 0);

  ctx.fillStyle = '#000000';

  // Bloco principal (apelido, nome se diferente, cidade), centralizado na
  // vertical entre o topo e a linha da turma.
  const lines: Array<{ text: string; size: number; bold: boolean }> = [];
  const headline = fitText(ctx, nickname || name, {
    startSize: NAME_FONT_SIZE,
    minSize: NAME_MIN_FONT_SIZE,
    maxWidth: textMaxWidth,
    bold: true,
  });
  lines.push({ ...headline, bold: true });

  if (name && nickname && name !== nickname) {
    const full = fitText(ctx, name, {
      startSize: SECONDARY_FONT_SIZE,
      minSize: SECONDARY_MIN_FONT_SIZE,
      maxWidth: textMaxWidth,
      bold: false,
    });
    lines.push({ ...full, bold: false });
  }

  if (city) {
    const cityLine = fitText(ctx, city, {
      startSize: SECONDARY_FONT_SIZE,
      minSize: SECONDARY_MIN_FONT_SIZE,
      maxWidth: textMaxWidth,
      bold: false,
    });
    lines.push({ ...cityLine, bold: false });
  }

  const courseTop = LABEL_HEIGHT_DOTS - MARGIN_BOTTOM - COURSE_BLOCK_HEIGHT;
  const blockAreaTop = MARGIN_TOP;
  const blockAreaBottom = course ? courseTop : LABEL_HEIGHT_DOTS - MARGIN_BOTTOM;
  const blockHeight = lines.reduce((sum, line) => sum + line.size * LINE_HEIGHT_FACTOR, 0);
  let y = blockAreaTop + Math.max(0, (blockAreaBottom - blockAreaTop - blockHeight) / 2);

  for (const line of lines) {
    ctx.font = `${line.bold ? 'bold ' : ''}${line.size}px "${FONT_FAMILY}"`;
    ctx.fillText(line.text, MARGIN_X, Math.round(y));
    y += line.size * LINE_HEIGHT_FACTOR;
  }

  if (course) {
    const courseLine = fitText(ctx, course, {
      startSize: COURSE_FONT_SIZE,
      minSize: COURSE_MIN_FONT_SIZE,
      maxWidth: LABEL_WIDTH_DOTS - 2 * MARGIN_X,
      bold: false,
    });
    ctx.font = `${courseLine.size}px "${FONT_FAMILY}"`;
    ctx.fillText(courseLine.text, MARGIN_X, courseTop);
  }

  return canvas;
}
