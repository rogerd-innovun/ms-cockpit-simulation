import { STAGES, STATUS_META, stageIndexOf, toneClass } from '../lib/status';
import type { POStatus } from '../lib/types';

/**
 * Where this record sits. The sequence is real — the server enforces every
 * transition — so a ruled track encodes something true rather than decorating.
 */
export function LifecycleRail({ status }: { status: POStatus }) {
  const meta = STATUS_META[status];
  const at = stageIndexOf(status);
  const cancelled = status === 'CANCELLED';

  return (
    <div className="rail" role="group" aria-label={`Lifecycle position: ${meta.label}`}>
      {STAGES.map((stage, i) => {
        const state = cancelled ? 'off' : i < at ? 'done' : i === at ? 'at' : 'off';
        return (
          <div
            key={stage.key}
            className={`rail-step ${state} ${state === 'at' ? toneClass(meta.tone) : ''}`}
          >
            <span className="rail-tick" aria-hidden="true" />
            <span className="rail-label">{state === 'at' ? meta.label : stage.label}</span>
          </div>
        );
      })}
      {cancelled && (
        <div className="rail-step at t-idle">
          <span className="rail-tick" aria-hidden="true" />
          <span className="rail-label">Cancelled</span>
        </div>
      )}
    </div>
  );
}
