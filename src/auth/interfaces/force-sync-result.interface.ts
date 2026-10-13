import { AuthSyncStatus } from '../../auth-sync/auth-sync.types';
import { ActiveCoursesSyncSummary } from '../../pai-sync/interfaces/course-sync-result.interface';

/** Resposta do POST /auth/sync: status dos operadores + resumo do download das turmas ativas. */
export interface ForceSyncResult extends AuthSyncStatus {
  /** null quando o Pai estava inalcançável e o download das turmas nem foi tentado. */
  coursesSync: ActiveCoursesSyncSummary | null;
}
