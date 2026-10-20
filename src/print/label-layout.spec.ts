import jsQR from 'jsqr';
import { LABEL_HEIGHT_DOTS, LABEL_WIDTH_DOTS, renderLabelCanvas } from './label-layout';
import { renderLabelPng } from './label-image';

function pixels(content: Parameters<typeof renderLabelCanvas>[0]) {
  const canvas = renderLabelCanvas(content);
  const { data } = canvas.getContext('2d').getImageData(0, 0, LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS);
  return data;
}

/** Quantidade de pixels escuros num retângulo da etiqueta. */
function darkPixelsIn(data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number): number {
  let dark = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (data[(y * LABEL_WIDTH_DOTS + x) * 4] < 128) dark++;
    }
  }
  return dark;
}

const BASE = {
  name: 'Ronaldo',
  nickname: 'Ronaldo',
  city: 'Goiânia - GO',
  course: 'DESPERTESEUPODERPREMIUM-TESTE - IMERS',
};

describe('etiqueta 29x90mm (label-layout)', () => {
  it('é desenhada na área imprimível exata da mídia (991x306 dots, 300dpi)', () => {
    expect(LABEL_WIDTH_DOTS).toBe(991);
    expect(LABEL_HEIGHT_DOTS).toBe(306);

    const png = renderLabelPng({ ...BASE, token: 'abc' });
    expect(png.subarray(1, 4).toString()).toBe('PNG');
  });

  it.each([
    ['token Pai (30 caracteres)', 'Xk3mP9qL2vR8tY5nB7cD4fG6hJ1sW0'],
    ['token UUID do cadastro manual (36 caracteres)', 'a1b2c3d4-e5f6-4789-abcd-0123456789ab'],
  ])('o QR Code decodifica exatamente o %s', (_label, token) => {
    const data = pixels({ ...BASE, token });

    const decoded = jsQR(data, LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS);

    expect(decoded?.data).toBe(token);
  });

  it('o QR fica no canto superior direito e sem token o canto fica em branco', () => {
    const corner = [LABEL_WIDTH_DOTS - 240, 0, LABEL_WIDTH_DOTS, 250] as const;

    const withQr = darkPixelsIn(pixels({ ...BASE, token: 'a1b2c3d4-e5f6-4789-abcd-0123456789ab' }), ...corner);
    const withoutQr = darkPixelsIn(pixels(BASE), ...corner);

    expect(withQr).toBeGreaterThan(5000);
    expect(withoutQr).toBe(0);
  });

  it('a cidade ocupa uma linha própria: sem ela a etiqueta tem menos tinta', () => {
    const textArea = [0, 0, 600, 250] as const;

    const withCity = darkPixelsIn(pixels(BASE), ...textArea);
    const withoutCity = darkPixelsIn(pixels({ ...BASE, city: undefined }), ...textArea);

    expect(withCity).toBeGreaterThan(withoutCity);
  });

  it('textos longos encolhem/cortam e nunca invadem o QR nem passam das margens', () => {
    const data = pixels({
      name: 'Maria Aparecida da Silva Nascimento Oliveira Albuquerque',
      nickname: 'MARIA APARECIDA DA SILVA NASCIMENTO OLIVEIRA',
      city: 'São José do Rio Preto Grande do Sul - SP',
      course: 'MASTERTRAINER12 - INTENSIVO DE FORMAÇÃO AVANÇADA EM COACHING COMPORTAMENTAL',
      token: 'a1b2c3d4-e5f6-4789-abcd-0123456789ab',
    });

    // Faixa de respiro (quiet zone) logo à esquerda do QR — que ocupa 232
    // dots encostado na margem direita de 14 — permanece em branco; e nada é
    // desenhado nas margens laterais.
    const qrLeft = LABEL_WIDTH_DOTS - 14 - 232;
    expect(darkPixelsIn(data, qrLeft - 28, 0, qrLeft, 244)).toBe(0);
    expect(darkPixelsIn(data, 0, 0, 8, LABEL_HEIGHT_DOTS)).toBe(0);
    expect(darkPixelsIn(data, LABEL_WIDTH_DOTS - 8, 0, LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS)).toBe(0);
    expect(jsQR(data, LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS)?.data).toBe('a1b2c3d4-e5f6-4789-abcd-0123456789ab');
  });

  it('renderiza em poucos milissegundos (não pesa no tempo de impressão)', () => {
    const token = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
    renderLabelCanvas({ ...BASE, token }); // aquece fontes/JIT

    const start = process.hrtime.bigint();
    for (let i = 0; i < 20; i++) renderLabelCanvas({ ...BASE, token });
    const avgMs = Number(process.hrtime.bigint() - start) / 1e6 / 20;

    // Folga enorme de propósito (CI lento): a medição real é ~10-30ms,
    // contra ~2s do SumatraPDF/driver.
    expect(avgMs).toBeLessThan(250);
  });
});
