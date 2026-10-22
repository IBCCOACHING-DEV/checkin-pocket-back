import jsQR from 'jsqr';
import { LABEL_HEIGHT_DOTS, LABEL_SAFE_AREA, LABEL_WIDTH_DOTS, renderLabelCanvas } from './label-layout';
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

  it('o QR fica no canto superior direito da área segura e sem token o canto fica em branco', () => {
    const corner = [LABEL_SAFE_AREA.right - 210, 0, LABEL_SAFE_AREA.right, 235] as const;

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

  describe('área segura (a impressora corta o que passa dela — QR cortado numa etiqueta real)', () => {
    const TOKEN = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
    const samples: Array<[string, Parameters<typeof renderLabelCanvas>[0]]> = [
      ['exemplo da foto', { ...BASE, name: 'Fabio', nickname: 'Fabio', course: 'DESPERTESEUPODERPREMIUM-TESTE - IMERSAO', token: TOKEN }],
      [
        'textos longos',
        {
          name: 'Maria Aparecida da Silva Nascimento Oliveira Albuquerque',
          nickname: 'MARIA APARECIDA DA SILVA NASCIMENTO OLIVEIRA',
          city: 'SÃO JOSÉ DO RIO PRETO GRANDE DO SUL/SP',
          course: 'MASTERTRAINER12 - INTENSIVO DE FORMAÇÃO AVANÇADA EM COACHING COMPORTAMENTAL',
          token: TOKEN,
        },
      ],
      ['apelido diferente do nome (3 linhas)', { ...BASE, name: 'Ronaldo Nazário', nickname: 'Ronaldo', token: TOKEN }],
      ['sem token e sem cidade', { name: 'Ana', nickname: 'Ana', course: 'TURMA' }],
    ];

    function darkPixelsOutsideSafeArea(data: Uint8ClampedArray): number {
      let outside = 0;
      for (let y = 0; y < LABEL_HEIGHT_DOTS; y++) {
        for (let x = 0; x < LABEL_WIDTH_DOTS; x++) {
          if (data[(y * LABEL_WIDTH_DOTS + x) * 4] >= 128) continue;
          // ~2-6 dots de tolerância para o contorno dos glifos (cedilha, til).
          if (x > LABEL_SAFE_AREA.right || x < LABEL_SAFE_AREA.left - 6 || y > LABEL_SAFE_AREA.bottom + 2 || y < LABEL_SAFE_AREA.top - 2) {
            outside++;
          }
        }
      }
      return outside;
    }

    it.each(samples)('nada é desenhado fora da área segura: %s', (_label, content) => {
      expect(darkPixelsOutsideSafeArea(pixels(content))).toBe(0);
    });

    it('o limite direito deixa folga sobre o corte medido na etiqueta real (~x=924)', () => {
      expect(LABEL_SAFE_AREA.right).toBeLessThanOrEqual(880);
    });

    it('QR e texto não se sobrepõem: faixa de respiro à esquerda do QR em branco, mesmo com textos longos', () => {
      const data = pixels(samples[1][1]);
      const qrLeft = LABEL_SAFE_AREA.right - 203; // 29 módulos x 7 dots
      expect(darkPixelsIn(data, qrLeft - 28, LABEL_SAFE_AREA.top, qrLeft, LABEL_SAFE_AREA.top + 200)).toBe(0);
      expect(jsQR(data, LABEL_WIDTH_DOTS, LABEL_HEIGHT_DOTS)?.data).toBe(TOKEN);
    });
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
