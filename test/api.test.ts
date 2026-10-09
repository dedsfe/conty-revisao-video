import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";

let tick = 0;
function setup() {
  tick = 0;
  // relógio que anda 1 s a cada leitura: os horários saem distintos e previsíveis
  return createApp({ db: openDatabase(":memory:"), clock: () => new Date(Date.UTC(2026, 4, 10, 12, 0, tick++)) });
}
type App = ReturnType<typeof setup>;

async function call(app: App, path: string, body?: unknown, method = "POST") {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function campaign(app: App, required: string[]) {
  return (await call(app, "/campaigns", { name: "Verão", required_pieces: required })).body.id as string;
}
async function delivery(app: App, required: string[]) {
  const cmp = await campaign(app, required);
  return (await call(app, "/deliveries", { campaign_id: cmp, creator_id: "crt_ana" })).body.id as string;
}
const submit = (app: App, d: string, piece: string, extra: Record<string, unknown> = {}) =>
  call(app, `/deliveries/${d}/pieces/${piece}/versions`, { url: `fake://${piece}.mp4`, ...extra });
const approveVersion = (app: App, d: string, piece: string, n: number) =>
  call(app, `/deliveries/${d}/pieces/${piece}/versions/${n}/approve`);
const approveDelivery = (app: App, d: string) => call(app, `/deliveries/${d}/approve`);
const status = async (app: App, d: string) => (await call(app, `/deliveries/${d}`, undefined, "GET")).body;

beforeEach(() => {
  tick = 0;
});

describe("peças exigidas, dado da campanha", () => {
  it("aprovar com peça obrigatória pendente falha com erro claro e não aprova nada", async () => {
    const app = setup();
    const d = await delivery(app, ["script", "video"]);
    await submit(app, d, "video");
    await approveVersion(app, d, "video", 1);

    const res = await approveDelivery(app, d);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("pending_required_pieces");
    expect(res.body.message).toContain("roteiro (sem versão enviada)");
    expect(res.body.blocking).toEqual([{ piece: "script", reason: "no_version", version: null }]);
    expect((await status(app, d)).approved_at).toBeNull();
  });

  it("peça com versão enviada mas não aprovada também bloqueia, e o erro diz qual versão", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    const res = await approveDelivery(app, d);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain("vídeo (versão 1 ainda não aprovada)");
  });

  it("com todas as peças exigidas aprovadas a entrega é aprovada", async () => {
    const app = setup();
    const d = await delivery(app, ["script", "video"]);
    await submit(app, d, "script");
    await submit(app, d, "video");
    await approveVersion(app, d, "script", 1);
    expect((await status(app, d)).status).toBe("in_production");
    await approveVersion(app, d, "video", 1);
    expect((await status(app, d)).status).toBe("ready_for_approval");

    const res = await approveDelivery(app, d);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "approved", blocking: [] });
    expect(res.body.approved_at).not.toBeNull();
  });

  it("campanha só de vídeo não exige roteiro", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await approveVersion(app, d, "video", 1);
    const res = await approveDelivery(app, d);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    const script = res.body.pieces.find((p: any) => p.piece === "script");
    expect(script).toMatchObject({ required: false, current_version: null });
  });

  it("a lista de peças exigidas vem da campanha: duas campanhas, duas regras", async () => {
    const app = setup();
    const onlyVideo = await delivery(app, ["video"]);
    const videoAndCaption = await delivery(app, ["video", "caption"]);
    for (const d of [onlyVideo, videoAndCaption]) {
      await submit(app, d, "video");
      await approveVersion(app, d, "video", 1);
    }
    expect((await approveDelivery(app, onlyVideo)).status).toBe(200);
    expect((await approveDelivery(app, videoAndCaption)).status).toBe(409);
  });

  it("peça não exigida pendente não bloqueia", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await submit(app, d, "cover"); // a campanha não pediu capa
    await approveVersion(app, d, "video", 1);
    expect((await approveDelivery(app, d)).status).toBe(200);
  });
});

describe("uma versão substitui a anterior", () => {
  it("a versão nova vira a atual e a antiga fica guardada", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    expect((await submit(app, d, "video")).body.number).toBe(1);
    expect((await submit(app, d, "video")).body.number).toBe(2);
    const video = (await status(app, d)).pieces.find((p: any) => p.piece === "video");
    expect(video.current_version).toBe(2);
    expect(video.versions.map((x: any) => [x.number, x.is_current])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it("a aprovação vale só para a versão atual: versão antiga não se aprova", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await submit(app, d, "video");
    const res = await approveVersion(app, d, "video", 1);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("superseded_version");
    expect((await status(app, d)).status).toBe("in_production");
  });

  it("a aprovação da versão antiga não vale depois que chega uma nova", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await approveVersion(app, d, "video", 1);
    expect((await status(app, d)).status).toBe("ready_for_approval");
    await submit(app, d, "video");
    const after = await status(app, d);
    expect(after.status).toBe("in_production");
    expect(after.blocking).toEqual([{ piece: "video", reason: "current_version_pending", version: 2 }]);
  });

  it("alteração pedida bloqueia; só uma versão nova destrava; versão decidida não muda", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await call(app, `/deliveries/${d}/pieces/video/versions/1/request-changes`);
    expect((await approveDelivery(app, d)).body.message).toContain("alteração pedida");
    expect((await approveVersion(app, d, "video", 1)).body.error).toBe("already_decided");
    await submit(app, d, "video");
    await approveVersion(app, d, "video", 2);
    expect((await approveDelivery(app, d)).status).toBe(200);
  });
});

describe("entrega aprovada que recebe versão nova", () => {
  async function approvedDelivery(app: App) {
    const d = await delivery(app, ["script", "video"]);
    await submit(app, d, "script");
    await submit(app, d, "video");
    await approveVersion(app, d, "script", 1);
    await approveVersion(app, d, "video", 1);
    await approveDelivery(app, d);
    expect((await status(app, d)).status).toBe("approved");
    return d;
  }

  it("deixa de estar aprovada até a nova versão ser aprovada, e volta a aprovada quando for", async () => {
    const app = setup();
    const d = await approvedDelivery(app);

    await submit(app, d, "video"); // v2 do vídeo
    const revoked = await status(app, d);
    expect(revoked.status).toBe("in_production");
    expect(revoked.approval_revoked).toBe(true);
    expect(revoked.blocking).toEqual([{ piece: "video", reason: "current_version_pending", version: 2 }]);

    await approveVersion(app, d, "video", 2);
    const restored = await status(app, d);
    expect(restored.status).toBe("approved");
    expect(restored.approval_revoked).toBe(false);
  });

  it("o rastro registra cada mudança de status com a causa", async () => {
    const app = setup();
    const d = await approvedDelivery(app);
    await submit(app, d, "video");
    await approveVersion(app, d, "video", 2);
    const history = (await status(app, d)).history.map((h: any) => `${h.from_status ?? "-"}>${h.to_status} (${h.cause})`);
    expect(history).toEqual([
      "->in_production (delivery_created)",
      "in_production>ready_for_approval (version_approved:video:v1)",
      "ready_for_approval>approved (delivery_approved)",
      "approved>in_production (new_version:video:v2)",
      "in_production>approved (version_approved:video:v2)",
    ]);
  });

  it("versão nova de uma peça que a campanha não exige não desfaz a aprovação", async () => {
    const app = setup();
    const d = await approvedDelivery(app);
    await submit(app, d, "cover"); // capa não exigida
    expect((await status(app, d)).status).toBe("approved");
  });

  it("aprovar de novo a entrega já aprovada é idempotente", async () => {
    const app = setup();
    const d = await approvedDelivery(app);
    const first = (await status(app, d)).approved_at;
    const again = await approveDelivery(app, d);
    expect(again.status).toBe(200);
    expect(again.body.approved_at).toBe(first);
  });
});

describe("comentário preso a um segundo", () => {
  it("fica na versão em que foi feito, ordenado pelo segundo, e a versão nova começa sem comentários", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video", { duration_seconds: 30 });
    await call(app, `/deliveries/${d}/pieces/video/versions/1/comments`, { author: "marca", text: "Corta aqui", at_second: 12.5 });
    await call(app, `/deliveries/${d}/pieces/video/versions/1/comments`, { author: "marca", text: "Abertura fraca", at_second: 0 });

    await submit(app, d, "video", { duration_seconds: 28 });
    await call(app, `/deliveries/${d}/pieces/video/versions/2/comments`, { author: "marca", text: "Melhorou", at_second: 3 });

    const v1 = (await call(app, `/deliveries/${d}/pieces/video/versions/1`, undefined, "GET")).body;
    const v2 = (await call(app, `/deliveries/${d}/pieces/video/versions/2`, undefined, "GET")).body;
    expect(v1.comments.map((c: any) => [c.at_second, c.text])).toEqual([
      [0, "Abertura fraca"],
      [12.5, "Corta aqui"],
    ]);
    expect(v2.comments.map((c: any) => [c.at_second, c.text])).toEqual([[3, "Melhorou"]]);
    expect(v1).toMatchObject({ is_current: false });
    expect(v2).toMatchObject({ is_current: true });
  });

  it("o comentário não migra sozinho: a versão nova nasce sem nenhum", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await call(app, `/deliveries/${d}/pieces/video/versions/1/comments`, { author: "marca", text: "Ajustar", at_second: 5 });
    await submit(app, d, "video");
    expect((await call(app, `/deliveries/${d}/pieces/video/versions/2`, undefined, "GET")).body.comments).toEqual([]);
    const summary = (await status(app, d)).pieces.find((p: any) => p.piece === "video");
    expect(summary.versions.map((v: any) => v.comments)).toEqual([1, 0]);
  });

  it("no vídeo o segundo é obrigatório, não pode ser negativo e não pode passar da duração", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video", { duration_seconds: 20 });
    const url = `/deliveries/${d}/pieces/video/versions/1/comments`;
    expect((await call(app, url, { author: "marca", text: "sem segundo" })).status).toBe(400);
    expect((await call(app, url, { author: "marca", text: "x", at_second: -1 })).status).toBe(400);
    expect((await call(app, url, { author: "marca", text: "x", at_second: "5" })).status).toBe(400);
    expect((await call(app, url, { author: "marca", text: "x", at_second: 20.1 })).status).toBe(400);
    expect((await call(app, url, { author: "marca", text: "no limite", at_second: 20 })).status).toBe(201);
  });

  it("peça sem linha do tempo (capa, legenda, roteiro) comenta sem segundo, e recusa um", async () => {
    const app = setup();
    const d = await delivery(app, ["script"]);
    await submit(app, d, "script");
    const url = `/deliveries/${d}/pieces/script/versions/1/comments`;
    expect((await call(app, url, { author: "marca", text: "Trocar o gancho" })).status).toBe(201);
    expect((await call(app, url, { author: "marca", text: "x", at_second: 3 })).status).toBe(400);
  });

  it("comentário numa versão antiga continua nela, e comentar versão inexistente é 404", async () => {
    const app = setup();
    const d = await delivery(app, ["video"]);
    await submit(app, d, "video");
    await submit(app, d, "video");
    await call(app, `/deliveries/${d}/pieces/video/versions/1/comments`, { author: "marca", text: "tardio", at_second: 1 });
    expect((await call(app, `/deliveries/${d}/pieces/video/versions/1`, undefined, "GET")).body.comments).toHaveLength(1);
    expect((await call(app, `/deliveries/${d}/pieces/video/versions/9/comments`, { author: "m", text: "x", at_second: 1 })).status).toBe(404);
  });
});

describe("entrada inválida", () => {
  it("campanha: precisa de ao menos uma peça, só as quatro conhecidas, sem repetição", async () => {
    const app = setup();
    expect((await call(app, "/campaigns", { name: "x", required_pieces: [] })).status).toBe(400);
    expect((await call(app, "/campaigns", { name: "x", required_pieces: ["audio"] })).status).toBe(400);
    expect((await call(app, "/campaigns", { name: "x" })).status).toBe(400);
    expect((await call(app, "/campaigns", { required_pieces: ["video"] })).status).toBe(400);
    const dup = await call(app, "/campaigns", { name: "x", required_pieces: ["video", "video", "script"] });
    expect(dup.body.required_pieces).toEqual(["script", "video"]);
  });

  it("entrega de campanha inexistente, peça desconhecida, url inválida, duração inválida", async () => {
    const app = setup();
    expect((await call(app, "/deliveries", { campaign_id: "nao_existe", creator_id: "c" })).status).toBe(404);
    const d = await delivery(app, ["video"]);
    expect((await call(app, `/deliveries/${d}/pieces/audio/versions`, { url: "fake://a.mp3" })).status).toBe(400);
    expect((await submit(app, d, "video", { url: "não é url" })).status).toBe(400);
    expect((await submit(app, d, "video", { duration_seconds: 0 })).status).toBe(400);
    expect((await submit(app, d, "cover", { duration_seconds: 10 })).status).toBe(400);
    expect((await call(app, "/deliveries/nao_existe/approve")).status).toBe(404);
  });
});
