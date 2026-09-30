// Topologia RabbitMQ do Checkin Pocket.
//
// Exchange topic `ibc.checkin.events`: toda instância do Checkin Pocket
// publica aqui quando realiza um check-in local (via Outbox worker). Cada
// instância também declara sua PRÓPRIA fila (uma por agente) ligada a esta
// exchange, para que todas as instâncias recebam uma cópia de todo evento
// publicado por qualquer computador da rede (fan-out via topic exchange).
export const CHECKIN_EVENTS_EXCHANGE = 'ibc.checkin.events';
export const CHECKIN_EVENTS_EXCHANGE_DLX = 'ibc.checkin.events.dlx';

export const CHECKIN_PERFORMED_ROUTING_KEY = 'checkin.performed';
export const CHECKIN_PERFORMED_BINDING_PATTERN = 'checkin.#';
export const CHECKIN_PERFORMED_DEAD_ROUTING_KEY = 'checkin.performed.dead';

// Transferência de ingresso: esta estação publica `transfer.requested` (via
// Outbox, mesmo padrão do check-in) e o Checkin Pai — único consumidor
// desta routing key, fila própria `transfer.sync.pai` — executa a
// transferência no Coliseum de forma assíncrona. O resultado volta como
// `transfer.completed`, que TODAS as estações recebem (fan-out) para
// atualizar sua réplica local do Student (nome, documento e, possivelmente,
// um NOVO token — o Pai regenera o token do voucher quando a titularidade
// muda, ver Student#handle_ownership_change no Checkin Pai).
export const TRANSFER_REQUESTED_ROUTING_KEY = 'transfer.requested';
export const TRANSFER_COMPLETED_ROUTING_KEY = 'transfer.completed';
export const TRANSFER_COMPLETED_DEAD_ROUTING_KEY = 'transfer.completed.dead';

// Dead-letter exchange/queue para print_jobs que esgotaram as tentativas
// locais de impressão (tolerância a falhas do fluxo de impressão).
export const PRINT_JOBS_DLX_EXCHANGE = 'ibc.print.dlx';
export const PRINT_JOB_FAILED_ROUTING_KEY = 'print.failed';
export const PRINT_JOBS_DLQ_QUEUE = 'ibc.print.dead-letters';

export function checkinSyncQueueName(agentKey: string): string {
  return `checkin.sync.${agentKey}`;
}

export function checkinSyncDeadLetterQueueName(agentKey: string): string {
  return `${checkinSyncQueueName(agentKey)}.dlq`;
}

// Fila DEDICADA por estação para `transfer.completed` — separada da fila
// de check-in porque cada consumer só deve receber o tipo de evento que
// sabe processar (uma fila com bindings para routing keys distintas
// dividiria as mensagens round-robin entre os dois handlers).
export function transferSyncQueueName(agentKey: string): string {
  return `transfer.sync.${agentKey}`;
}

export function transferSyncDeadLetterQueueName(agentKey: string): string {
  return `${transferSyncQueueName(agentKey)}.dlq`;
}
