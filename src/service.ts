import type { DatabaseSync } from "node:sqlite";
import { PIECES, PIECE_LABEL, hasTimeline, isPiece } from "./pieces.ts";
import type { Piece } from "./pieces.ts";
import { blockingMessage, evaluateDelivery } from "./rules.ts";
import type { CurrentVersion, Evaluation, VersionStatus } from "./rules.ts";

type Row = Record<string, unknown>;

export class DomainError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const bad = (code: string, message: string) => new DomainError(400, code, message);
const notFound = (what: string) => new DomainError(404, "not_found", `${what} não encontrado`);

export class VideoReviewService {
  constructor(
    private readonly db: DatabaseSync,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------- campanha ----------

  createCampaign(input: { id?: unknown; name?: unknown; required_pieces?: unknown }) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw bad("invalid", "name é obrigatório");
    if (!Array.isArray(input.required_pieces) || input.required_pieces.length === 0) {
      throw bad("invalid", `required_pieces deve listar ao menos uma peça entre: ${PIECES.join(", ")}`);
    }
    if (!input.required_pieces.every(isPiece)) {
      throw bad("invalid", `required_pieces aceita só: ${PIECES.join(", ")}`);
    }
    const required = PIECES.filter((piece) => (input.required_pieces as string[]).includes(piece)); // sem repetição, ordem estável
    const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : `cmp_${crypto.randomUUID().slice(0, 8)}`;
    try {
      this.db
        .prepare("INSERT INTO campaigns (id, name, required_pieces, created_at) VALUES (?, ?, ?, ?)")
        .run(id, name, JSON.stringify(required), this.now());
    } catch {
      throw new DomainError(409, "conflict", "já existe uma campanha com esse id");
    }
    return this.getCampaign(id);
  }

  getCampaign(id: string) {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("campanha");
    return { id: String(row.id), name: String(row.name), required_pieces: JSON.parse(String(row.required_pieces)) as Piece[] };
  }

  // ---------- entrega ----------

  createDelivery(input: { campaign_id?: unknown; creator_id?: unknown }) {
    if (typeof input.campaign_id !== "string" || typeof input.creator_id !== "string" || !input.creator_id.trim()) {
      throw bad("invalid", "campaign_id e creator_id são obrigatórios");
    }
    this.getCampaign(input.campaign_id);
    const id = `dlv_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    this.db
      .prepare("INSERT INTO deliveries (id, campaign_id, creator_id, status, created_at) VALUES (?, ?, ?, 'in_production', ?)")
      .run(id, input.campaign_id, input.creator_id.trim(), this.now());
    this.log(id, null, "in_production", "delivery_created");
    return this.getDelivery(id);
  }

  private deliveryRow(id: string): Row {
    const row = this.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw notFound("entrega");
    return row;
  }

  private currentVersions(deliveryId: string): Partial<Record<Piece, CurrentVersion>> {
    const rows = this.db
      .prepare(
        `SELECT piece, number, status FROM piece_versions v
          WHERE delivery_id = ? AND number = (SELECT MAX(number) FROM piece_versions WHERE delivery_id = v.delivery_id AND piece = v.piece)`,
      )
      .all(deliveryId) as Array<{ piece: Piece; number: number; status: VersionStatus }>;
    return Object.fromEntries(rows.map((row) => [row.piece, { number: row.number, status: row.status }]));
  }

  private evaluate(delivery: Row): Evaluation {
    const campaign = this.getCampaign(String(delivery.campaign_id));
    return evaluateDelivery({
      required: campaign.required_pieces,
      current: this.currentVersions(String(delivery.id)),
      approved_at: (delivery.approved_at as string | null) ?? null,
    });
  }

  private log(deliveryId: string, from: string | null, to: string, cause: string): void {
    this.db
      .prepare("INSERT INTO delivery_log (delivery_id, at, from_status, to_status, cause) VALUES (?, ?, ?, ?, ?)")
      .run(deliveryId, this.now(), from, to, cause);
  }

  // Reavalia depois de qualquer mudança e registra a transição de status com a causa.
  private settle(deliveryId: string, cause: string): void {
    const delivery = this.deliveryRow(deliveryId);
    const next = this.evaluate(delivery).status;
    if (next !== delivery.status) {
      this.db.prepare("UPDATE deliveries SET status = ? WHERE id = ?").run(next, deliveryId);
      this.log(deliveryId, String(delivery.status), next, cause);
    }
  }

  getDelivery(id: string) {
    const delivery = this.deliveryRow(id);
    const campaign = this.getCampaign(String(delivery.campaign_id));
    const evaluation = this.evaluate(delivery);
    const versions = this.db
      .prepare("SELECT piece, number, url, duration_seconds, status, submitted_at, decided_at FROM piece_versions WHERE delivery_id = ? ORDER BY piece, number")
      .all(id) as Row[];
    const counts = this.db
      .prepare("SELECT piece, version_number, COUNT(*) AS n FROM comments WHERE delivery_id = ? GROUP BY piece, version_number")
      .all(id) as Array<{ piece: string; version_number: number; n: number }>;

    const pieces = PIECES.map((piece) => {
      const own = versions.filter((version) => version.piece === piece);
      const current = own.length > 0 ? Math.max(...own.map((version) => Number(version.number))) : null;
      return {
        piece,
        required: campaign.required_pieces.includes(piece),
        current_version: current,
        versions: own.map((version) => ({
          number: Number(version.number),
          url: String(version.url),
          duration_seconds: (version.duration_seconds as number | null) ?? null,
          status: String(version.status),
          is_current: Number(version.number) === current,
          submitted_at: String(version.submitted_at),
          decided_at: (version.decided_at as string | null) ?? null,
          comments: counts.find((c) => c.piece === piece && c.version_number === Number(version.number))?.n ?? 0,
        })),
      };
    });

    const history = this.db
      .prepare("SELECT at, from_status, to_status, cause FROM delivery_log WHERE delivery_id = ? ORDER BY id")
      .all(id);
    return {
      id: String(delivery.id),
      campaign: { id: campaign.id, name: campaign.name, required_pieces: campaign.required_pieces },
      creator_id: String(delivery.creator_id),
      status: evaluation.status,
      approved_at: (delivery.approved_at as string | null) ?? null,
      approval_revoked: evaluation.approval_revoked,
      blocking: evaluation.blocking,
      pieces,
      history,
    };
  }

  // A marca aprova a ENTREGA. Só passa se toda peça exigida tem a versão atual aprovada.
  approveDelivery(id: string) {
    return this.tx(() => {
      const delivery = this.deliveryRow(id);
      const evaluation = this.evaluate(delivery);
      if (evaluation.blocking.length > 0) {
        throw new DomainError(409, "pending_required_pieces", blockingMessage(evaluation.blocking), { blocking: evaluation.blocking });
      }
      if (delivery.approved_at === null) {
        this.db.prepare("UPDATE deliveries SET approved_at = ? WHERE id = ?").run(this.now(), id);
        this.settle(id, "delivery_approved");
      }
      return this.getDelivery(id);
    });
  }

  // ---------- versões ----------

  private pieceOf(value: string): Piece {
    if (!isPiece(value)) throw bad("invalid", `peça desconhecida; use: ${PIECES.join(", ")}`);
    return value;
  }

  submitVersion(deliveryId: string, pieceName: string, input: { url?: unknown; duration_seconds?: unknown }) {
    const piece = this.pieceOf(pieceName);
    if (typeof input.url !== "string" || input.url.length > 2048) throw bad("invalid", "url é obrigatória");
    try {
      new URL(input.url);
    } catch {
      throw bad("invalid", "url inválida (pode ser um endereço falso, como fake://video-v1.mp4)");
    }
    let duration: number | null = null;
    if (input.duration_seconds !== undefined) {
      if (typeof input.duration_seconds !== "number" || !Number.isFinite(input.duration_seconds) || input.duration_seconds <= 0) {
        throw bad("invalid", "duration_seconds deve ser um número maior que zero");
      }
      if (!hasTimeline(piece)) throw bad("invalid", `${PIECE_LABEL[piece]} não tem duração`);
      duration = input.duration_seconds;
    }
    return this.tx(() => {
      this.deliveryRow(deliveryId);
      const last = this.db
        .prepare("SELECT MAX(number) AS n FROM piece_versions WHERE delivery_id = ? AND piece = ?")
        .get(deliveryId, piece) as { n: number | null };
      const number = (last.n ?? 0) + 1;
      this.db
        .prepare(
          "INSERT INTO piece_versions (delivery_id, piece, number, url, duration_seconds, status, submitted_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(deliveryId, piece, number, input.url as string, duration, this.now());
      this.settle(deliveryId, `new_version:${piece}:v${number}`);
      return { piece, number, status: "pending" as const, delivery: this.getDelivery(deliveryId) };
    });
  }

  private versionRow(deliveryId: string, piece: Piece, number: number): Row {
    this.deliveryRow(deliveryId);
    const row = this.db
      .prepare("SELECT * FROM piece_versions WHERE delivery_id = ? AND piece = ? AND number = ?")
      .get(deliveryId, piece, number) as Row | undefined;
    if (!row) throw notFound("versão");
    return row;
  }

  // Decisão da marca sobre a versão ATUAL. Versão antiga não se aprova: a aprovação vale para a atual.
  decideVersion(deliveryId: string, pieceName: string, number: number, decision: "approved" | "changes_requested") {
    const piece = this.pieceOf(pieceName);
    return this.tx(() => {
      const version = this.versionRow(deliveryId, piece, number);
      const current = this.currentVersions(deliveryId)[piece]!;
      if (current.number !== number) {
        throw new DomainError(
          409,
          "superseded_version",
          `a versão ${number} de ${PIECE_LABEL[piece]} foi substituída pela ${current.number}; a decisão vale só para a versão atual`,
        );
      }
      if (version.status !== "pending") {
        throw new DomainError(409, "already_decided", `a versão ${number} já foi decidida (${version.status}); envie uma nova versão para mudar`);
      }
      this.db
        .prepare("UPDATE piece_versions SET status = ?, decided_at = ? WHERE delivery_id = ? AND piece = ? AND number = ?")
        .run(decision, this.now(), deliveryId, piece, number);
      this.settle(deliveryId, `version_${decision}:${piece}:v${number}`);
      return this.getDelivery(deliveryId);
    });
  }

  // ---------- comentários ----------

  addComment(
    deliveryId: string,
    pieceName: string,
    number: number,
    input: { author?: unknown; text?: unknown; at_second?: unknown },
  ) {
    const piece = this.pieceOf(pieceName);
    const author = typeof input.author === "string" ? input.author.trim() : "";
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!author || author.length > 64) throw bad("invalid", "author é obrigatório (até 64 caracteres)");
    if (!text || text.length > 4000) throw bad("invalid", "text é obrigatório (até 4000 caracteres)");

    let atSecond: number | null = null;
    if (hasTimeline(piece)) {
      if (typeof input.at_second !== "number" || !Number.isFinite(input.at_second) || input.at_second < 0) {
        throw bad("invalid", "at_second é obrigatório no vídeo: o segundo, a partir de 0, a que o comentário se refere");
      }
      atSecond = input.at_second;
    } else if (input.at_second !== undefined && input.at_second !== null) {
      throw bad("invalid", `${PIECE_LABEL[piece]} não tem linha do tempo: comente sem at_second`);
    }

    const version = this.versionRow(deliveryId, piece, number);
    const duration = version.duration_seconds as number | null;
    if (atSecond !== null && duration !== null && atSecond > duration) {
      throw bad("invalid", `at_second ${atSecond} passa da duração da versão (${duration} s)`);
    }

    const id = `cmt_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
    this.db
      .prepare(
        "INSERT INTO comments (id, delivery_id, piece, version_number, at_second, author, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, deliveryId, piece, number, atSecond, author, text, this.now());
    return { id, piece, version: number, at_second: atSecond, author, text };
  }

  // A versão com os comentários feitos NELA, e só eles.
  getVersion(deliveryId: string, pieceName: string, number: number) {
    const piece = this.pieceOf(pieceName);
    const version = this.versionRow(deliveryId, piece, number);
    const current = this.currentVersions(deliveryId)[piece]!;
    const comments = this.db
      .prepare(
        `SELECT id, at_second, author, text, created_at FROM comments
          WHERE delivery_id = ? AND piece = ? AND version_number = ?
          ORDER BY at_second IS NULL, at_second, created_at, id`,
      )
      .all(deliveryId, piece, number);
    return {
      piece,
      number,
      url: String(version.url),
      duration_seconds: (version.duration_seconds as number | null) ?? null,
      status: String(version.status),
      is_current: current.number === number,
      submitted_at: String(version.submitted_at),
      decided_at: (version.decided_at as string | null) ?? null,
      comments,
    };
  }
}
