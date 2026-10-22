/** Só dígitos e pontuação de CPF/CNPJ: a busca é por documento. */
const DOCUMENT_TERM = /^[\d.\-/\s]+$/;

/** CPF completo tem 11 dígitos; abaixo disso a busca é parcial. */
const FULL_DOCUMENT_DIGITS = 11;

/**
 * Monta o `OR` da busca de ingresso na tela de transferência a partir de UM
 * campo livre — o operador não precisa dizer se digitou CPF, nome ou e-mail:
 *
 *  - só números/pontuação → CPF. Com 11+ dígitos é igualdade (com e sem
 *    máscara); com menos, "contém" — o cliente costuma errar o CPF no
 *    cadastro, então um pedaço (ex.: os 6 primeiros dígitos) ainda acha o ingresso;
 *  - qualquer outra coisa → nome (todas as palavras, em qualquer ordem) e,
 *    se não houver espaço, também e-mail.
 *
 * O MySQL do Pai compara sem diferenciar maiúsculas/acentos (collation padrão).
 */
export function buildOwnerSearchFilter(rawTerm: string) {
  const term = rawTerm.trim();

  if (DOCUMENT_TERM.test(term)) {
    const digits = term.replace(/\D/g, '');
    return digits.length >= FULL_DOCUMENT_DIGITS
      ? [{ document: digits }, { document: term }]
      : [{ document: { contains: digits } }];
  }

  const words = term.split(/\s+/).filter(Boolean);
  const filters: Array<Record<string, unknown>> = [
    { AND: words.map((word) => ({ name: { contains: word } })) },
  ];
  if (words.length === 1) {
    filters.push({ email: { contains: term } });
  }
  return filters;
}
