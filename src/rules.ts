import { PIECE_LABEL } from "./pieces.ts";
import type { Piece } from "./pieces.ts";

// A regra da entrega, pura: sem banco, sem relógio, sem HTTP.
//
//  - Só conta a VERSÃO ATUAL de cada peça (a de maior número). Aprovação de versão antiga não vale.
//  - Só conta peça EXIGIDA pela campanha. Peça que ela não pediu nunca bloqueia nem desfaz aprovação.
//  - Status da entrega:
//      approved             a entrega foi aprovada pela marca E toda peça exigida tem a versão atual aprovada
//      ready_for_approval   toda peça exigida está aprovada, mas a marca ainda não aprovou a entrega
//      in_production        falta alguma peça exigida aprovada
//  - Se a entrega já tinha sido aprovada e uma peça exigida ganha versão nova, ela volta a in_production
//    (`approval_revoked: true`) e só fica approved de novo quando a versão nova for aprovada.

export type VersionStatus = "pending" | "approved" | "changes_requested";

export type CurrentVersion = { number: number; status: VersionStatus };

export type BlockingReason = "no_version" | "current_version_pending" | "current_version_changes_requested";

export type Blocking = { piece: Piece; reason: BlockingReason; version: number | null };

export type DeliveryStatus = "in_production" | "ready_for_approval" | "approved";

export type Evaluation = {
  status: DeliveryStatus;
  blocking: Blocking[];
  approval_revoked: boolean;
};

export function evaluateDelivery(input: {
  required: readonly Piece[];
  current: Partial<Record<Piece, CurrentVersion>>;
  approved_at: string | null;
}): Evaluation {
  const blocking: Blocking[] = [];
  for (const piece of input.required) {
    const current = input.current[piece];
    if (!current) blocking.push({ piece, reason: "no_version", version: null });
    else if (current.status === "pending") blocking.push({ piece, reason: "current_version_pending", version: current.number });
    else if (current.status === "changes_requested") {
      blocking.push({ piece, reason: "current_version_changes_requested", version: current.number });
    }
  }
  if (blocking.length > 0) {
    return { status: "in_production", blocking, approval_revoked: input.approved_at !== null };
  }
  return {
    status: input.approved_at !== null ? "approved" : "ready_for_approval",
    blocking: [],
    approval_revoked: false,
  };
}

const REASON_TEXT: Record<BlockingReason, (version: number | null) => string> = {
  no_version: () => "sem versão enviada",
  current_version_pending: (v) => `versão ${v} ainda não aprovada`,
  current_version_changes_requested: (v) => `versão ${v} com alteração pedida`,
};

// Mensagem clara para quem tentou aprovar cedo demais.
export function blockingMessage(blocking: Blocking[]): string {
  const parts = blocking.map((item) => `${PIECE_LABEL[item.piece]} (${REASON_TEXT[item.reason](item.version)})`);
  return `não dá para aprovar a entrega: faltam peças exigidas aprovadas: ${parts.join(", ")}`;
}
