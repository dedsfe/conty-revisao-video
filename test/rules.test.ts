import { describe, expect, it } from "vitest";
import { blockingMessage, evaluateDelivery } from "../src/rules.ts";
import type { CurrentVersion } from "../src/rules.ts";
import type { Piece } from "../src/pieces.ts";

const v = (number: number, status: CurrentVersion["status"]): CurrentVersion => ({ number, status });
const APPROVED_AT = "2026-05-10T12:00:00.000Z";

describe("regra da entrega (pura)", () => {
  it("sem nenhuma versão, toda peça exigida bloqueia com 'sem versão'", () => {
    const result = evaluateDelivery({ required: ["script", "video"], current: {}, approved_at: null });
    expect(result.status).toBe("in_production");
    expect(result.blocking).toEqual([
      { piece: "script", reason: "no_version", version: null },
      { piece: "video", reason: "no_version", version: null },
    ]);
  });

  it("peça exigida com versão atual pendente ou com alteração pedida bloqueia, e diz qual versão", () => {
    const result = evaluateDelivery({
      required: ["video", "cover"],
      current: { video: v(2, "pending"), cover: v(1, "changes_requested") },
      approved_at: null,
    });
    expect(result.blocking).toEqual([
      { piece: "video", reason: "current_version_pending", version: 2 },
      { piece: "cover", reason: "current_version_changes_requested", version: 1 },
    ]);
  });

  it("campanha só de vídeo não exige roteiro, capa nem legenda", () => {
    const result = evaluateDelivery({ required: ["video"], current: { video: v(1, "approved") }, approved_at: null });
    expect(result).toEqual({ status: "ready_for_approval", blocking: [], approval_revoked: false });
  });

  it("peça que a campanha não pediu não bloqueia, mesmo pendente ou com alteração pedida", () => {
    const result = evaluateDelivery({
      required: ["video"],
      current: { video: v(1, "approved"), script: v(1, "pending"), cover: v(3, "changes_requested") },
      approved_at: null,
    });
    expect(result.blocking).toEqual([]);
    expect(result.status).toBe("ready_for_approval");
  });

  it("tudo aprovado e entrega aprovada pela marca: approved", () => {
    const result = evaluateDelivery({
      required: ["script", "video"],
      current: { script: v(1, "approved"), video: v(2, "approved") },
      approved_at: APPROVED_AT,
    });
    expect(result).toEqual({ status: "approved", blocking: [], approval_revoked: false });
  });

  it("entrega que já foi aprovada e ganha versão pendente numa peça exigida deixa de estar aprovada", () => {
    const result = evaluateDelivery({
      required: ["script", "video"],
      current: { script: v(1, "approved"), video: v(2, "pending") },
      approved_at: APPROVED_AT,
    });
    expect(result.status).toBe("in_production");
    expect(result.approval_revoked).toBe(true);
    expect(result.blocking).toEqual([{ piece: "video", reason: "current_version_pending", version: 2 }]);
  });

  it("a ordem em que as peças exigidas são listadas não muda o resultado do bloqueio", () => {
    const current: Partial<Record<Piece, CurrentVersion>> = { script: v(1, "approved") };
    const a = evaluateDelivery({ required: ["script", "video", "cover"], current, approved_at: null });
    const b = evaluateDelivery({ required: ["cover", "video", "script"], current, approved_at: null });
    expect(new Set(a.blocking.map((x) => x.piece))).toEqual(new Set(b.blocking.map((x) => x.piece)));
  });

  it("a mensagem de erro nomeia cada peça e o motivo, em português", () => {
    const message = blockingMessage([
      { piece: "video", reason: "no_version", version: null },
      { piece: "caption", reason: "current_version_pending", version: 2 },
    ]);
    expect(message).toContain("vídeo (sem versão enviada)");
    expect(message).toContain("legenda (versão 2 ainda não aprovada)");
  });
});
