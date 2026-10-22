import { buildOwnerSearchFilter } from './transfer-search-filter';

describe('buildOwnerSearchFilter', () => {
  it('CPF completo (com ou sem máscara) é igualdade no documento', () => {
    expect(buildOwnerSearchFilter('123.456.789-01')).toEqual([
      { document: '12345678901' },
      { document: '123.456.789-01' },
    ]);
    expect(buildOwnerSearchFilter('12345678901')).toEqual([
      { document: '12345678901' },
      { document: '12345678901' },
    ]);
  });

  it('CPF parcial é "contém" — acha o ingresso mesmo com o CPF cadastrado errado', () => {
    expect(buildOwnerSearchFilter('123.456')).toEqual([{ document: { contains: '123456' } }]);
  });

  it('nome com várias palavras exige todas, em qualquer ordem, e não busca e-mail', () => {
    expect(buildOwnerSearchFilter('  maria   silva ')).toEqual([
      { AND: [{ name: { contains: 'maria' } }, { name: { contains: 'silva' } }] },
    ]);
  });

  it('uma palavra busca no nome e no e-mail', () => {
    expect(buildOwnerSearchFilter('joao')).toEqual([
      { AND: [{ name: { contains: 'joao' } }] },
      { email: { contains: 'joao' } },
    ]);
  });

  it('e-mail completo é tratado como termo único (nome e e-mail)', () => {
    expect(buildOwnerSearchFilter('maria@x.com.br')).toEqual([
      { AND: [{ name: { contains: 'maria@x.com.br' } }] },
      { email: { contains: 'maria@x.com.br' } },
    ]);
  });
});
